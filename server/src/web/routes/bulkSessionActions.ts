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
import {
  listFederationForNamespace,
  listForNamespace,
} from "../../sync/pendingSpawns";
import {
  REMOTE_DELETE_CONCURRENCY,
  type NodeRegistry,
  type RemoteSessionActionError,
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

/**
 * #6681: no DELETE goes to a node once this much of a bulk-delete request has
 * passed: 25 s answer − the 10 s request timeout − a 6 s confirmation budget,
 * so a DELETE sent at the cutoff can still time out and be confirmed in time.
 */
export const REMOTE_DELETE_SEND_CUTOFF_MS = 9_000;
/** #6681: how much of the deadline is kept back to build the answer. */
const DELETE_ANSWER_MARGIN_MS = 250;

/** #6681: a remote id that was never sent; safe to send again. */
function notSentItem(id: string, label: string): BulkSessionResultItem {
  return {
    id,
    ok: false,
    retry: true,
    error: `Not sent: ${label} busy; this session was not deleted`,
  };
}

/**
 * #6681: a remote id that was sent and whose outcome is still unknown. "timed
 * out" stays in the text because older web builds label a failure by it.
 * R1-2 (B2, B3): when the peer answered with its own error text, the text
 * carries it, so a delete never confirmed keeps its reason. R2-4: that form
 * keeps "(timed out)" too, for the same older web builds.
 */
function pendingItem(
  id: string,
  label: string,
  peerText?: string
): BulkSessionResultItem {
  return {
    id,
    ok: false,
    pending: true,
    error:
      peerText === undefined
        ? `Still deleting on ${label}: no answer within 10 s (timed out); it may still complete`
        : `Still deleting on ${label}: the node answered "${peerText}"; not confirmed in time (timed out); it may still complete`,
  };
}

export type BulkTarget =
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
export function resolveTarget(
  id: string,
  engine: SyncEngine,
  namespace: string,
  registry: NodeRegistry | null,
  requireActive: boolean
): BulkTarget {
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

/**
 * #6681 A1: while the hub has not yet polled every static peer since it
 * started (`isAwaitingInitialPoll`, bounded by HUB_RESTART_GRACE_MS), an id
 * no node can place may be a live peer session the empty cache cannot see.
 * Mirrors the single-session routes (`remoteSessionAvailability`, which turns
 * that 404 into a 503 `node_offline`): such an id is `node_offline`, never
 * `not_found`, so no caller counts it as deleted or gone.
 */
function unplacedDuringInitialPoll(
  result: BulkSessionResultItem,
  registry: NodeRegistry | null
): BulkSessionResultItem {
  return result.code === "not_found" &&
    registry?.isAwaitingInitialPoll?.() === true
    ? { id: result.id, ok: false, code: "node_offline" }
    : result;
}

/**
 * #6681 A2, R2-1: a relaunch evicts its session from the hub's cache while it
 * keeps running on its node, until a poll of that node that starts after the
 * eviction puts it back. Until then an id the hub cannot place is not known to
 * be gone: `retry` (nothing was sent), or `node_offline` while its node reads
 * offline; never `not_found`, which callers count as gone.
 */
function relaunchedNotGone(
  result: BulkSessionResultItem,
  registry: NodeRegistry | null
): BulkSessionResultItem {
  if (result.code !== "not_found") return result;
  const answer = registry?.relaunchAnswer?.(result.id);
  if (answer === "node_offline") {
    return { id: result.id, ok: false, code: "node_offline" };
  }
  return answer === "retry"
    ? {
        id: result.id,
        ok: false,
        retry: true,
        error: "Not sent: being relaunched; this session was not changed",
      }
    : result;
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
  target: Extract<BulkTarget, { kind: "local" }>,
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
  target: Extract<BulkTarget, { kind: "remote" }>,
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
  target: Extract<BulkTarget, { kind: "local" }>,
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
  target: Extract<BulkTarget, { kind: "remote" }>,
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

/** Settle `work` or, after `ms`, `late` (#6646: Keep all uses it with its own outcome). */
export async function settleWithin<T>(
  work: Promise<T>,
  ms: number,
  late: T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lateAnswer = new Promise<T>(resolve => {
    timer = setTimeout(() => resolve(late), ms);
  });
  try {
    return await Promise.race([work, lateAnswer]);
  } finally {
    clearTimeout(timer);
  }
}

/** Settle `work` or, after `ms`, an "outcome unknown" failure for `id`. */
function withDeadline(
  id: string,
  work: Promise<BulkSessionResultItem>,
  ms: number
): Promise<BulkSessionResultItem> {
  return settleWithin(work, ms, {
    id,
    ok: false,
    error: `No answer within ${Math.round(ms / 1000)} s; the action may still complete`,
  });
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
      if (target.kind === "done") {
        return unplacedDuringInitialPoll(
          relaunchedNotGone(target.result, registry),
          registry
        );
      }
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
 * `DELETE /api/federation/sessions/:id`) so each gets its own outcome.
 *
 * #6681: the local and remote phases run together and are both settled; a
 * local throw fails the local ids only. The remote phase answers within
 * BULK_SESSION_DEADLINE_MS whatever the peers do: per node at most
 * REMOTE_DELETE_CONCURRENCY DELETEs (the registry's shared slots), none sent
 * after REMOTE_DELETE_SEND_CUTOFF_MS or after that node's first unknown or
 * offline answer (those ids come back `retry`), and every unknown outcome is
 * confirmed on its node by positive evidence (`gone` is deleted, anything
 * else `pending`). One coalesced re-poll per touched node with no unknown id.
 */
export async function runBulkDelete(params: {
  ids: readonly string[];
  engine: SyncEngine;
  namespace: string;
  registry: NodeRegistry | null;
}): Promise<BulkSessionResult> {
  const { engine, namespace, registry } = params;
  const started = performance.now();
  const ids = dedupeIds(params.ids);
  const byId = new Map<string, BulkSessionResultItem>();
  const localIds: string[] = [];
  const remoteByNode = new Map<string, { label: string; ids: string[] }>();
  // #6681 (R9): an id no node knows may be a spawn placeholder of this
  // namespace, local (`hapi-…`) or federation (a UUID). Read once, lazily.
  let placeholders: Map<string, string | undefined> | null = null;
  const placeholderState = (id: string): string | undefined => {
    placeholders ??= new Map(
      [
        ...listForNamespace(namespace),
        ...listFederationForNamespace(namespace),
      ].map(s => [s.id, s.lifecycleState])
    );
    return placeholders.get(id);
  };

  for (const id of ids) {
    const target = resolveTarget(id, engine, namespace, registry, false);
    if (target.kind === "done") {
      // A placeholder still spawning is skipped; a failed one stays not_found
      // (it is dismissable), as does any other unknown id.
      const spawning =
        target.result.code === "not_found" &&
        placeholderState(id) === "spawning";
      byId.set(
        id,
        spawning
          ? { id, ok: false, skipped: true, code: "session_spawning" }
          : unplacedDuringInitialPoll(
              relaunchedNotGone(target.result, registry),
              registry
            )
      );
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
      const group = remoteByNode.get(target.nodeId) ?? {
        label: target.session.nodeLabel ?? target.nodeId,
        ids: [],
      };
      group.ids.push(id);
      remoteByNode.set(target.nodeId, group);
    }
  }

  const localPhase = async (): Promise<void> => {
    if (localIds.length === 0) return;
    // #6210: answer once the records are gone; the tmux + worktree cleanup
    // RPCs finish in the background instead of holding this response.
    const local = await engine.deleteSessions(localIds, namespace, {
      detachCleanup: true,
    });
    for (const id of local.deleted) byId.set(id, { id, ok: true });
    for (const id of local.skipped) {
      // Every id here passed the namespace and active checks, so a skip is a
      // session that reconnected in between.
      byId.set(id, { id, ok: false, skipped: true, code: "session_active" });
    }
  };

  // Ids handed to `deleteOnNode`: at the deadline one without an answer was
  // sent (a call still waiting for a slot gives up at the send cutoff).
  const dispatched = new Set<string>();
  const remote = new Map<string, BulkSessionResultItem>();
  // F2: a 5xx the peer answered with its own text, by id (ids are unique).
  const peerText = new Map<string, string>();
  const remotePhase = async (): Promise<void> => {
    if (!registry || remoteByNode.size === 0) return;
    const deadline = started + BULK_SESSION_DEADLINE_MS;
    const sendBy = started + REMOTE_DELETE_SEND_CUTOFF_MS;
    const caller = Symbol("bulk-delete");
    const quietNodes: string[] = [];
    await Promise.all(
      Array.from(remoteByNode, async ([nodeId, { label, ids: nodeIds }]) => {
        let tripped = false;
        const queue = [...nodeIds];
        const unknown = new Map<string, number>();
        const worker = async (): Promise<void> => {
          for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
            if (tripped || performance.now() > sendBy) {
              remote.set(id, notSentItem(id, label));
              continue;
            }
            dispatched.add(id);
            const r = await registry.deleteOnNode(nodeId, id, namespace, {
              deferPoll: true,
              sendBy,
              shouldSend: () => !tripped,
              caller,
            });
            if ("ok" in r) {
              remote.set(id, { id, ok: true });
            } else if (r.notSent) {
              // Never reached the peer: a refused connection trips the node too.
              tripped = true;
              remote.set(id, notSentItem(id, label));
            } else if (r.unknown) {
              tripped = true;
              unknown.set(id, r.sentAt ?? performance.now());
              if (r.peerAnswered) peerText.set(id, r.message);
            } else if (r.offline) {
              tripped = true;
              remote.set(id, { id, ok: false, code: "node_offline" });
            } else {
              remote.set(id, remoteFailure(id, r, "session_active"));
            }
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.min(REMOTE_DELETE_CONCURRENCY, queue.length) },
            worker
          )
        );
        if (unknown.size === 0) {
          quietNodes.push(nodeId);
          return;
        }
        const confirmed = await registry.confirmDeletedOnNode(
          nodeId,
          [...unknown.keys()],
          {
            sentAt: unknown,
            timeoutMs: Math.max(
              0,
              deadline - DELETE_ANSWER_MARGIN_MS - performance.now()
            ),
          }
        );
        for (const id of unknown.keys()) {
          const outcome = confirmed.get(id);
          const text = peerText.get(id);
          if (outcome === "gone") {
            remote.set(id, { id, ok: true });
          } else if (outcome === "present" && text !== undefined) {
            // F2: the peer answered the delete with an error and still has
            // the session, so the delete failed: report the peer's text and
            // free the slot now instead of holding it for the 60 s hold.
            registry.releaseOwedDeleteSlot(nodeId, id);
            remote.set(id, { id, ok: false, error: text });
          } else {
            remote.set(id, pendingItem(id, label, text));
          }
        }
      })
    );
    for (const nodeId of quietNodes) {
      void registry.pollNodeById(nodeId).catch(err => {
        console.warn(
          `[Federation] Background poll failed after bulk-delete on ${nodeId}:`,
          err
        );
      });
    }
  };

  const remoteBudget = Math.max(
    0,
    started +
      BULK_SESSION_DEADLINE_MS -
      DELETE_ANSWER_MARGIN_MS -
      performance.now()
  );
  const [localOutcome, remoteOutcome] = await Promise.allSettled([
    localPhase(),
    settleWithin(remotePhase(), remoteBudget, undefined),
  ]);
  if (localOutcome.status === "rejected") {
    // The whole error (its stack too) goes to the log; each local id carries
    // its message.
    console.warn("[bulk-delete] local phase failed:", localOutcome.reason);
    for (const id of localIds) {
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          ok: false,
          error: errorMessage(localOutcome.reason),
        });
      }
    }
  }
  // Every remote id has an answer, even at the deadline or after a throw:
  // one sent is pending (it may still complete), one never sent is retry.
  for (const [, { label, ids: nodeIds }] of remoteByNode) {
    for (const id of nodeIds) {
      const item = remote.get(id);
      if (item) byId.set(id, item);
      else if (registry === null) {
        byId.set(id, { id, ok: false, code: "node_offline" });
      } else {
        byId.set(
          id,
          dispatched.has(id)
            ? pendingItem(id, label, peerText.get(id))
            : notSentItem(id, label)
        );
      }
    }
  }
  if (remoteOutcome.status === "rejected") {
    console.warn("[bulk-delete] remote phase failed:", remoteOutcome.reason);
  }

  // A local id the engine neither deleted nor skipped (it vanished
  // mid-request) is reported, never dropped.
  return ids.map(
    id =>
      byId.get(id) ?? {
        id,
        ok: false,
        error: "Session was not processed",
      }
  );
}

/** Most per-session samples one bulk-failure log entry carries. */
export const BULK_FAILURE_SAMPLE_LIMIT = 20;

export type BulkFailureSummary = {
  failed: number;
  byReason: Record<string, number>;
  samples: Array<{ id: string; code?: string; error?: string }>;
};

/**
 * #6210: one summary of the sessions a bulk action did NOT act on, for a single
 * `error_logs` entry per request — per-session refusals were never logged, so
 * the reasons a bulk delete left sessions behind had no record. The reason key
 * is the result `code`, else `error: ` plus the first 80 characters of the
 * message. Results whose `code` is in `ignoreCodes` (an expected, harmless
 * outcome for that action) are not counted. Returns null when nothing is left.
 */
export function summarizeBulkFailures(
  results: BulkSessionResult,
  ignoreCodes: readonly string[] = []
): BulkFailureSummary | null {
  const byReason: Record<string, number> = {};
  const samples: BulkFailureSummary["samples"] = [];
  let failed = 0;
  for (const r of results) {
    if (r.ok || (r.code !== undefined && ignoreCodes.includes(r.code))) {
      continue;
    }
    failed += 1;
    // #6681: a sent delete of unknown outcome and a never-sent one are their
    // own reasons, so the error log tells them from real failures.
    const reason =
      r.pending === true
        ? "pending"
        : r.retry === true
          ? "not_sent"
          : (r.code ?? `error: ${(r.error ?? "unknown").slice(0, 80)}`);
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    if (samples.length < BULK_FAILURE_SAMPLE_LIMIT) {
      samples.push({
        id: r.id,
        ...(r.code ? { code: r.code } : {}),
        ...(r.error ? { error: r.error } : {}),
      });
    }
  }
  return failed === 0 ? null : { failed, byReason, samples };
}
