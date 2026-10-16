// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Fan-out behind the bulk session routes (#3815, epic #4406): Stop turn
 * (`POST /api/sessions/bulk-abort`), Disconnect (`/bulk-archive`) and the
 * per-session `results` of `/bulk-delete`. The routes themselves (capability
 * blocks, body validation) live in `sessions.ts`; this module turns a list of
 * ids into ONE `BulkSessionResult` (shared/src/bulkSessionResult.ts), one item
 * per id in request order. A failure on one session never aborts the batch.
 *
 * Deliberately NOT a copy of bulk-delete's old partition: every LOCAL id is
 * namespace-checked before anything runs (`engine.abortSession` /
 * `engine.archiveSession` take no namespace), an id another namespace owns is
 * `forbidden` and never looked up remotely, and an id no node knows is
 * `not_found` rather than silently "local". Remote ids go per SESSION through
 * the registry's timeout-carrying helpers, calling only peer receivers every
 * node already serves (mixed-version fleets).
 */
import type {
  BulkSessionResult,
  BulkSessionResultItem,
} from "@hapi/protocol/bulkSessionResult";
import type { SessionSummary } from "@hapi/protocol";
import type { Session, SyncEngine } from "../../sync/syncEngine";
import type {
  NodeRegistry,
  RemoteSessionActionError,
} from "../../federation/nodeRegistry";

export type BulkSessionAction = "abort" | "archive";

/**
 * Per-session answer deadline. A local RPC may take 30 s (rpcGateway) and a
 * local archive chains several; without a deadline one hung daemon holds the
 * whole response past the client's timeout (and Bun's `idleTimeout`, ≥ 30 s),
 * so actions that DID run would be reported as failed. A session that misses
 * the deadline is reported as unknown — its action may still complete.
 */
export const BULK_SESSION_DEADLINE_MS = 25_000;

type Target =
  | { kind: "done"; result: BulkSessionResultItem }
  | { kind: "local"; id: string; session: Session }
  | { kind: "remote"; id: string; nodeId: string; session: SessionSummary };

/** Unique ids, first occurrence wins — a repeated id must not be stopped twice. */
export function dedupeIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve one id under the caller's namespace. Local sessions are judged on
 * their own record (403 → forbidden, inactive → skipped when `requireActive`);
 * anything else is looked up on the federation REGARDLESS of node status, so
 * an offline owner reads `node_offline`, not `not_found`.
 */
function resolveTarget(
  id: string,
  engine: SyncEngine,
  namespace: string,
  registry: NodeRegistry | null,
  requireActive: boolean
): Target {
  const session = engine.getSession(id);
  if (session) {
    if (session.namespace !== namespace) {
      return { kind: "done", result: { id, ok: false, code: "forbidden" } };
    }
    if (requireActive && !session.active) {
      return {
        kind: "done",
        result: { id, ok: false, skipped: true, code: "session_inactive" },
      };
    }
    return { kind: "local", id, session };
  }
  const located = registry?.locateSession(id) ?? null;
  if (!located) {
    return { kind: "done", result: { id, ok: false, code: "not_found" } };
  }
  if (located.status === "offline") {
    return { kind: "done", result: { id, ok: false, code: "node_offline" } };
  }
  return {
    kind: "remote",
    id,
    nodeId: located.nodeId,
    session: located.session,
  };
}

/** Map a peer failure for an action that needs an ACTIVE session. */
function remoteFailure(
  id: string,
  err: RemoteSessionActionError,
  conflictCode: "session_inactive" | "session_active"
): BulkSessionResultItem {
  if (err.offline) return { id, ok: false, code: "node_offline" };
  if (err.status === 409) {
    return { id, ok: false, skipped: true, code: conflictCode };
  }
  if (err.status === 404) return { id, ok: false, code: "not_found" };
  return { id, ok: false, error: err.message };
}

/** Stop the running turn of one local session; never throws. */
async function abortLocal(
  target: Extract<Target, { kind: "local" }>,
  engine: SyncEngine,
  namespace: string
): Promise<BulkSessionResultItem> {
  const { id, session } = target;
  // #3815-7: under the tmux / pty launchers the abort RPC is an Escape
  // keypress with no idle guard — a second Escape on an idle TUI can open its
  // history-rewind affordance. Only a session that is mid-turn is interrupted.
  if (!session.thinking) {
    return { id, ok: false, skipped: true, code: "session_idle" };
  }
  // Ruling D2: count BEFORE the abort — when `thinking` falls the queue-drain
  // observer dispatches the next queued prompt, so this is the number that
  // will still run. A failed read omits the field; it never fails the result.
  let queued: number | undefined;
  try {
    queued = engine.listQueuedMessages(id, namespace).length;
  } catch {
    queued = undefined;
  }
  try {
    await engine.abortSession(id);
  } catch (err) {
    return { id, ok: false, error: errorMessage(err) };
  }
  return queued === undefined ? { id, ok: true } : { id, ok: true, queued };
}

/** Stop the running turn of one remote session; never throws. */
async function abortRemote(
  target: Extract<Target, { kind: "remote" }>,
  registry: NodeRegistry,
  namespace: string
): Promise<BulkSessionResultItem> {
  const { id, nodeId, session } = target;
  // Same idle guard as local, decided from the hub's cached summary (the hub
  // cannot see the peer's live state without a round trip).
  if (!session.active) {
    return { id, ok: false, skipped: true, code: "session_inactive" };
  }
  if (!session.thinking) {
    return { id, ok: false, skipped: true, code: "session_idle" };
  }
  // Ruling D2, as for a local session: count BEFORE the abort, because the
  // drain that follows a stopped turn removes the next prompt from the queue.
  const queued = await registry.getQueuedCountOnNode(nodeId, id, namespace);
  const result = await registry.abortOnNode(nodeId, id, namespace);
  if (!("ok" in result)) {
    return remoteFailure(id, result, "session_inactive");
  }
  return queued === null ? { id, ok: true } : { id, ok: true, queued };
}

/** Disconnect one local session; never throws. */
async function archiveLocal(
  target: Extract<Target, { kind: "local" }>,
  engine: SyncEngine
): Promise<BulkSessionResultItem> {
  try {
    // Same options as the single-session route (`POST /sessions/:id/archive`):
    // a terminal archive that reaps window B and preserves window A for
    // reconnect (#1603, #2683).
    await engine.archiveSession(target.id, {
      reapRemoteWindow: true,
      preserveForReconnect: true,
    });
    return { id: target.id, ok: true };
  } catch (err) {
    return { id: target.id, ok: false, error: errorMessage(err) };
  }
}

/**
 * Disconnect one remote session; never throws. The peer decides whether the
 * session is still active (409 → skipped). NOTE: the peer archive receiver
 * answers `{ ok: true }` even when its kill RPC failed, so a remote `ok`
 * cannot prove the process died — local and remote semantics differ.
 */
async function archiveRemote(
  target: Extract<Target, { kind: "remote" }>,
  registry: NodeRegistry,
  namespace: string
): Promise<BulkSessionResultItem> {
  const result = await registry.archiveOnNode(
    target.nodeId,
    target.id,
    namespace
  );
  if (!("ok" in result)) {
    return remoteFailure(target.id, result, "session_inactive");
  }
  return { id: target.id, ok: true };
}

/** Settle `work` or, after `ms`, an "outcome unknown" failure for `id`. */
async function withDeadline(
  id: string,
  work: Promise<BulkSessionResultItem>,
  ms: number
): Promise<BulkSessionResultItem> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<BulkSessionResultItem>(resolve => {
    timer = setTimeout(
      () =>
        resolve({
          id,
          ok: false,
          error: `No answer within ${Math.round(ms / 1000)} s; the action may still complete`,
        }),
      ms
    );
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run Stop turn or Disconnect over `ids` and collect one result per unique id,
 * in request order. Every per-session promise is settled; a rejection becomes
 * `{ id, ok: false, error }`, and a session that misses `deadlineMs` is
 * reported without holding the response open.
 */
export async function runBulkSessionAction(params: {
  action: BulkSessionAction;
  ids: readonly string[];
  engine: SyncEngine;
  namespace: string;
  registry: NodeRegistry | null;
  deadlineMs?: number;
}): Promise<BulkSessionResult> {
  const { action, engine, namespace, registry } = params;
  const deadlineMs = params.deadlineMs ?? BULK_SESSION_DEADLINE_MS;
  const ids = dedupeIds(params.ids);
  // Abort needs an active local session; archive does too (the single route's
  // `requireActive: true`).
  const targets = ids.map(id =>
    resolveTarget(id, engine, namespace, registry, true)
  );

  const settled = await Promise.allSettled(
    targets.map(async (target): Promise<BulkSessionResultItem> => {
      if (target.kind === "done") return target.result;
      if (target.kind === "local") {
        return withDeadline(
          target.id,
          action === "abort"
            ? abortLocal(target, engine, namespace)
            : archiveLocal(target, engine),
          deadlineMs
        );
      }
      // A remote target only exists when `registry` resolved it.
      const reg = registry as NodeRegistry;
      return withDeadline(
        target.id,
        action === "abort"
          ? abortRemote(target, reg, namespace)
          : archiveRemote(target, reg, namespace),
        deadlineMs
      );
    })
  );

  return settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : { id: ids[i] as string, ok: false, error: errorMessage(s.reason) }
  );
}

/**
 * #3815 Task 1b: per-session delete. Local ids are namespace-checked BEFORE
 * `engine.deleteSessions` (which gathers tmux + worktree cleanup for every id
 * it is handed — a foreign id must never reach it). Remote ids are deleted one
 * SESSION at a time through `registry.deleteOnNode` (the peer's
 * `DELETE /api/federation/sessions/:id`) so each gets its own outcome, with ONE
 * coalesced re-poll per touched node. Throws only if the local delete throws.
 */
export async function runBulkDelete(params: {
  ids: readonly string[];
  engine: SyncEngine;
  namespace: string;
  registry: NodeRegistry | null;
}): Promise<BulkSessionResult> {
  const { engine, namespace, registry } = params;
  const ids = dedupeIds(params.ids);
  const byId = new Map<string, BulkSessionResultItem>();
  const localIds: string[] = [];
  const remote: { id: string; nodeId: string }[] = [];

  for (const id of ids) {
    const target = resolveTarget(id, engine, namespace, registry, false);
    if (target.kind === "done") {
      byId.set(id, target.result);
    } else if (target.kind === "local") {
      // A still-connected session is refused HERE, with the cache's own rule
      // (#1443: an orphaned one — its CWD is gone — may be deleted while
      // active). Handing it to `engine.deleteSessions` would only have it
      // skipped AFTER that call gathered and fired its tmux + worktree cleanup
      // (sessionDeletion.ts; the in-call fix is #4000's E15).
      if (target.session.active && !engine.isSessionOrphaned(id)) {
        byId.set(id, { id, ok: false, skipped: true, code: "session_active" });
      } else {
        localIds.push(id);
      }
    } else {
      remote.push({ id, nodeId: target.nodeId });
    }
  }

  if (localIds.length > 0) {
    const local = await engine.deleteSessions(localIds, namespace);
    for (const id of local.deleted) byId.set(id, { id, ok: true });
    for (const id of local.skipped) {
      // Every id here passed the namespace and active checks, so a skip is a
      // session that reconnected in between.
      byId.set(id, { id, ok: false, skipped: true, code: "session_active" });
    }
  }

  if (registry && remote.length > 0) {
    const settled = await Promise.allSettled(
      remote.map(({ id, nodeId }) =>
        registry.deleteOnNode(nodeId, id, namespace, { deferPoll: true })
      )
    );
    const touched = new Set<string>();
    settled.forEach((s, i) => {
      const { id, nodeId } = remote[i] as { id: string; nodeId: string };
      touched.add(nodeId);
      if (s.status === "rejected") {
        byId.set(id, { id, ok: false, error: errorMessage(s.reason) });
      } else if ("ok" in s.value) {
        byId.set(id, { id, ok: true });
      } else {
        byId.set(id, remoteFailure(id, s.value, "session_active"));
      }
    });
    for (const nodeId of touched) {
      void registry.pollNodeById(nodeId).catch(err => {
        console.warn(
          `[Federation] Background poll failed after bulk-delete on ${nodeId}:`,
          err
        );
      });
    }
  }

  // An id the engine neither deleted nor skipped (it vanished mid-request) is
  // reported, never dropped.
  return ids.map(
    id =>
      byId.get(id) ?? {
        id,
        ok: false,
        error: "Session was not processed",
      }
  );
}
