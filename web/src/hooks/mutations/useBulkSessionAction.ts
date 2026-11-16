// SPDX-License-Identifier: AGPL-3.0-only
import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import {
  BULK_DELETE_BUDGET_MS,
  BULK_SESSION_MAX_IDS,
  type BulkSessionResult,
  type BulkSessionResultItem,
} from "@hapi/protocol/bulkSessionResult";
import { queryKeys } from "@/lib/query-keys";
import {
  clearActionPending,
  markActionPending,
} from "@/lib/session-action-pending";
import {
  dropSessionDetailCaches,
  restoreSessionRowsById,
  type SessionListSnapshots,
} from "@/lib/sessionListOptimistic";
import {
  bulkFailureLabel,
  notConfirmedLabel,
  summarizeBulkDelete,
  type BulkToastType,
} from "@/lib/bulkSessionToast";

/**
 * Bulk Stop turn / Disconnect / Delete over a selection (#3815, epic #4406).
 * Each action is ONE server-side fan-out route (`/api/sessions/bulk-abort`,
 * `/bulk-archive`, `/bulk-delete`) that runs every session on its owning
 * federation node and answers one result per session.
 */
export type BulkSessionActionKind = "abort" | "archive" | "delete";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function postChunk(
  api: ApiClient,
  action: BulkSessionActionKind,
  ids: string[]
): Promise<BulkSessionResult> {
  if (action === "abort") return (await api.bulkAbortSessions(ids)).results;
  if (action === "archive") return (await api.bulkArchiveSessions(ids)).results;
  return (await api.bulkDeleteSessions(ids)).results;
}

/**
 * Run `action` over `ids` in chunks of the server's 100-id cap ("filter to
 * everything, select all" easily exceeds it) and merge the per-chunk results
 * in request order. A chunk whose request fails as a whole yields one
 * `{ id, ok: false, error }` per id of that chunk; later chunks still run.
 * `beforeChunk` (#6210) runs right before each chunk's request.
 */
export async function executeBulkSessionAction(
  api: ApiClient,
  action: BulkSessionActionKind,
  ids: readonly string[],
  options?: { beforeChunk?: (chunk: readonly string[]) => void }
): Promise<BulkSessionResult> {
  const results: BulkSessionResult = [];
  for (let i = 0; i < ids.length; i += BULK_SESSION_MAX_IDS) {
    const chunk = ids.slice(i, i + BULK_SESSION_MAX_IDS);
    options?.beforeChunk?.(chunk);
    try {
      results.push(...(await postChunk(api, action, chunk)));
    } catch (err) {
      const error = errorMessage(err);
      results.push(...chunk.map(id => ({ id, ok: false, error })));
    }
  }
  return results;
}

/** The toast call a background bulk delete reports through. */
export type BulkDeleteToast = (
  message: string,
  options: { type: BulkToastType | "info"; key?: string; duration?: number }
) => void;

/**
 * #6681 R1-4: how long the progress note stays up without a refresh. The loop
 * refreshes it before each request (the client's 45 s chunk timeout bounds a
 * request), after each round and at each wait read (a 30 s read at most).
 */
export const BULK_DELETE_PROGRESS_NOTE_MS = 60_000;
let progressNotes = 0;

/**
 * #6681 R1-4 (the operator's "with progress"): ONE progress note per run. Each
 * refresh replaces it in place (its own key); `end` takes it down.
 */
export function bulkDeleteProgressNote(
  show: BulkDeleteToast,
  clear: (key: string) => void
): { onProgress: (done: number, total: number) => void; end: () => void } {
  const key = `bulk-delete-progress-${(progressNotes += 1)}`;
  return {
    onProgress: (done, total) =>
      show(`Deleting… ${done} of ${total}`, {
        type: "info",
        key,
        duration: BULK_DELETE_PROGRESS_NOTE_MS,
      }),
    end: () => clear(key),
  };
}

/**
 * #6681 (D3 = 1, the operator's 131a): BULK_DELETE_BUDGET_MS (shared with the
 * CLI) is how long one bulk delete keeps sending rounds and waiting on its
 * nodes, from its first request. No round and no wait starts after it; a wait
 * running at it ends there.
 */
export { BULK_DELETE_BUDGET_MS };
/**
 * #6681: the hub's REMOTE_DELETE_OWED_SLOT_MS. A pending delete holds one of
 * its node's two slots at most this long after the request that sent it.
 */
export const BULK_DELETE_SLOT_HOLD_MS = 60_000;
/**
 * #6681 R2-2, D1: how long past a pending id's hold the hub may still learn
 * its delete landed: its send cutoff (9 s, REMOTE_DELETE_SEND_CUTOFF_MS), the
 * DELETE's own timeout (10 s: the hub owes the slot from when the DELETE gave
 * up, not from its send), its last re-read (10 s) and the re-read interval
 * (5 s). "Not confirmed" is ruled only after it, and the loop's reads go on
 * until then.
 */
export const BULK_DELETE_CONFIRM_TAIL_MS = 34_000;
/**
 * #6681: the hub's REMOTE_DELETE_CONFIRM_INTERVAL_MS. A node waiting for a
 * free slot is re-read this often, from the hub's cache only.
 */
export const BULK_DELETE_WAIT_READ_MS = 5_000;

/** The clock the rounds read and wait on (injected by tests). */
export type BulkDeleteClock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const realClock: BulkDeleteClock = {
  now: () => performance.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

/** A remote id's owning node, from the list snapshot; a local id has none. */
export type BulkDeleteNode = { nodeId: string; nodeLabel?: string };

/** The node of each id in the snapshot's federation list (#6681 Task 7). */
export function snapshotNodeOf(
  snapshot: SessionListSnapshots
): (id: string) => BulkDeleteNode | undefined {
  const byId = new Map<string, BulkDeleteNode>();
  for (const s of snapshot.prevFederation?.sessions ?? []) {
    if (s.nodeId) byId.set(s.id, { nodeId: s.nodeId, nodeLabel: s.nodeLabel });
  }
  return id => byId.get(id);
}

export type BulkDeleteRoundsOutcome = {
  /** Deleted, gone (`not_found`), or a pending id a read decided deleted. */
  deleted: string[];
  /** Definite failures, unknowns a read kept, and ids never sent. */
  failures: Array<{ id: string; label: string }>;
  /** Pending ids not yet confirmed: never failures (D1 = 1). */
  stillDeleting: Array<{ id: string; node?: string }>;
};

type NodeRound = {
  label?: string;
  /** Ids to send in this node's next round (the last round's `retry` ids). */
  queue: string[];
  /** Undecided pending ids → when the request that sent them started. */
  pending: Map<string, number>;
  /** When the next round may start (a wait ends earlier on a slot signal). */
  readyAt: number;
  /** True while waiting: a freed slot (pending id gone) ends the wait. */
  waiting: boolean;
  /** Stopped early: a failed-outright or refusal-cap round, none unproven. */
  stopped: boolean;
  /** R1-3: refusal-only rounds in a row (reset by progress or pending). */
  refusals: number;
};

/** R1-3: a node whose rounds are refusals only stops after this many. */
export const BULK_DELETE_REFUSAL_ROUNDS = 3;

/** What one round gave a node (#6681 Task 7's rule reads it). */
type RoundTally = {
  progress: number;
  pending: number;
  retry: number;
  outright: number;
  /** R1-3: refused for one session (coded, not node_offline; or kept). */
  refused: number;
  /**
   * X1: sent again with no read proving them: a recheck not proven (a
   * resend's not_found, one for an id only ever answered `retry` included,
   * or a node_offline for an id in mayBeDeleted), a code-less answer no read
   * decided, or a `retry` for an id in mayBeDeleted (F-1). The node waits.
   */
  unproven: number;
};

/** The direct read of both lists (R8): never the query cache. */
type DirectRead = {
  local: Set<string> | null;
  remote: Set<string> | null;
  /**
   * R2-2, S2: nodes the federation read shows online (not degraded): the
   * only nodes whose absence from the read proves a delete (R7). A
   * restarted hub reads a peer degraded with an empty cache until a poll
   * succeeds.
   */
  onlineNodes: Set<string>;
};

async function readListsDirect(
  api: ApiClient,
  wantLocal: boolean
): Promise<DirectRead> {
  const [local, federation] = await Promise.allSettled([
    wantLocal
      ? (async () => api.getSessions())()
      : Promise.reject(new Error("not read")),
    (async () => api.getFederationAllSessions())(),
  ]);
  // A read whose body is not a session list is a failed read, never "empty".
  const listed = (
    r: PromiseSettledResult<{ sessions?: unknown } | undefined>
  ): Set<string> | null =>
    r.status === "fulfilled" && Array.isArray(r.value?.sessions)
      ? new Set((r.value.sessions as Array<{ id: string }>).map(s => s.id))
      : null;
  const remote = listed(federation);
  const nodes =
    federation.status === "fulfilled" && Array.isArray(federation.value?.nodes)
      ? federation.value.nodes
      : [];
  return {
    local: listed(local),
    remote,
    onlineNodes: new Set(
      remote === null
        ? []
        : nodes.filter(n => n.status === "online").map(n => n.nodeId)
    ),
  };
}

/** "Still deleting on <label>: …" → the label, when no snapshot node has one. */
function pendingNodeLabel(item: BulkSessionResultItem): string | undefined {
  return (item.error ?? "").match(/^Still deleting on (.+?): /)?.[1];
}

/**
 * R1-2: the peer's own text on a pending item ("… the node answered "<text>";
 * …"). E3: the s flag keeps a text with a line break.
 */
function pendingPeerText(item: BulkSessionResultItem): string | undefined {
  return (item.error ?? "").match(
    /: the node answered "(.*)"; not confirmed in time \(timed out\); it may still complete$/s
  )?.[1];
}

/**
 * #6681 Task 7 (R6-R8, R13): the ONE round loop every web bulk delete uses
 * (Select mode, "Delete all (N)", "Delete disconnected"). It never rejects for
 * a peer's answer; an `api` failure of a whole chunk makes that chunk's ids
 * code-less, and the closing direct read decides them.
 *
 * Rounds are scheduled per node (the snapshot names each id's node; a local
 * id has none and is only in the first round). After each round the lists are
 * read directly, and a pending id read as deleted counts as its node's `ok`.
 * A node's `retry` ids are sent again when its round:
 * - gave an `ok` or `not_found` (progress): at once;
 * - gave none but left an id `pending`: after a freed slot, i.e. one of its
 *   pending ids read as deleted, or BULK_DELETE_SLOT_HOLD_MS since the
 *   earliest request that sent one still pending (D3-1 = 2);
 * - sent nothing, every id `retry` (busy): at a freed slot or after one wait
 *   read, whichever is first (C4).
 * A node stops early ONLY after a round with no `ok`, `not_found` or `pending`
 * in which an id failed outright (its `retry` ids do not change that; C4) or
 * the refusal cap (BULK_DELETE_REFUSAL_ROUNDS) is reached, AND in which no id
 * is left unproven (X1: an id requeued because no read proved it keeps its
 * node going). The cap counts rounds with a refusal and no progress or
 * pending id; progress or a pending id resets the count, and a round with
 * neither and no refusal leaves it as it is. A waiting node is re-read every
 * BULK_DELETE_WAIT_READ_MS from the hub's cache, and nothing is sent to it
 * meanwhile. With nothing left to send, the reads go on until each pending id
 * is decided or its hold and BULK_DELETE_CONFIRM_TAIL_MS have passed, from its
 * own request's start (R2-2). Nothing starts after BULK_DELETE_BUDGET_MS.
 *
 * Then the decision, from one direct read (R7, R8): a pending id absent while
 * its node is present and online is deleted (S2); one its online node still
 * lists past its hold and the hub's tail is not confirmed (R1-2, R2-2); any
 * other (read failed, node missing, offline or degraded, or still inside its
 * tail) is still being deleted.
 * A LOCAL code-less unknown keeps #6210's rule at that read (listed or
 * unreadable: failed; absent: deleted). A remote code-less id, a resend's
 * not_found, and a node_offline for an id an earlier request may have deleted
 * (F1, S4) are decided by the round-end read: absent while its node is online,
 * deleted; a code-less id still listed, failed; otherwise it is unproven and
 * sent again (its node does not stop in that round; a later `retry` for it
 * leaves it unproven too, F-1), and one the loop ends with fails (after a
 * not_found, a node_offline or such a `retry`, as not confirmed on its node,
 * N1). Ids never sent fail with their `retry` text (D3-2 = A).
 *
 * `mark` re-marks every undecided id delete-pending before each chunk and at
 * each wait read (the marks' 90 s TTL is shorter than the budget), and clears
 * the pending and unknown ids' marks right before the decision read.
 */
export async function runBulkDeleteRounds(params: {
  api: ApiClient;
  ids: readonly string[];
  nodeOf: (id: string) => BulkDeleteNode | undefined;
  mark?: boolean;
  onProgress?: (deleted: number, total: number) => void;
  clock?: BulkDeleteClock;
}): Promise<BulkDeleteRoundsOutcome> {
  const { api, nodeOf, onProgress } = params;
  const clock = params.clock ?? realClock;
  const ids = Array.from(new Set(params.ids));
  const budgetEnd = clock.now() + BULK_DELETE_BUDGET_MS;
  const deleted = new Set<string>();
  const failures = new Map<string, string>();
  const lastItem = new Map<string, BulkSessionResultItem>();
  const unknown = new Set<string>();
  /** Ids already in a request: a later answer for one is a resend's. */
  const sentBefore = new Set<string>();
  /**
   * N1: ids whose last answer was a resend's not_found that no read proved
   * gone. They were sent, so "not sent" would be false: if the loop ends with
   * one, its reason is that the delete was not confirmed on its node.
   */
  const unconfirmed = new Set<string>();
  /**
   * S4: remote ids an earlier request may have deleted (its answer had no
   * code, or was a resend's not_found no read proved). A restarted hub
   * answers node_offline before its first poll of a node, so a resend's
   * node_offline for one is rechecked like its not_found. An id only ever
   * answered `retry` was never sent: its node_offline stays a failure.
   */
  const mayBeDeleted = new Set<string>();
  const nodeKey = (id: string): string => nodeOf(id)?.nodeId ?? "";
  const nodes = new Map<string, NodeRound>();
  for (const id of ids) {
    const key = nodeKey(id);
    const node = nodes.get(key) ?? {
      label: nodeOf(id)?.nodeLabel,
      queue: [],
      pending: new Map<string, number>(),
      readyAt: clock.now(),
      waiting: false,
      stopped: false,
      refusals: 0,
    };
    node.queue.push(id);
    nodes.set(key, node);
  }
  // Local ids (no node) go first, in the first round.
  const order = [...nodes.keys()].sort((a, b) =>
    a === "" ? -1 : b === "" ? 1 : 0
  );

  const undecided = (): string[] =>
    ids.filter(id => !deleted.has(id) && !failures.has(id));
  const remark = (): void => {
    if (!params.mark) return;
    for (const id of undecided()) markActionPending(id, "delete");
  };
  const holdOpen = (node: NodeRound, now: number): boolean =>
    [...node.pending.values()].some(t => now < t + BULK_DELETE_SLOT_HOLD_MS);
  // R2-2: a pending id may still be confirmed until its hold and the hub's tail.
  const decisionOpen = (node: NodeRound, now: number): boolean =>
    [...node.pending.values()].some(
      t => now < t + BULK_DELETE_SLOT_HOLD_MS + BULK_DELETE_CONFIRM_TAIL_MS
    );
  /** R2-2: when each id's own request started (its chunk's, not its round's). */
  const requestStart = new Map<string, number>();
  // The first time one of the node's still-held pending ids frees its slot.
  const holdEnds = (node: NodeRound, now: number): number => {
    const open = [...node.pending.values()].filter(
      t => now < t + BULK_DELETE_SLOT_HOLD_MS
    );
    return open.length === 0
      ? now
      : Math.min(...open) + BULK_DELETE_SLOT_HOLD_MS;
  };

  /** R7's positive test: a successful read without the id, its node online. */
  const provenGone = (read: DirectRead | null, id: string): boolean => {
    const key = nodeKey(id);
    return (
      key !== "" &&
      read !== null &&
      read.remote !== null &&
      !read.remote.has(id) &&
      read.onlineNodes.has(key)
    );
  };

  /** Read the federation list; pending ids proven gone are deleted. */
  const decidePending = async (
    given?: DirectRead | null
  ): Promise<Set<string>> => {
    const freed = new Set<string>();
    if (![...nodes.values()].some(n => n.pending.size > 0)) return freed;
    const read = given ?? (await readListsDirect(api, false));
    if (!read.remote) return freed;
    for (const [key, node] of nodes) {
      for (const id of node.pending.keys()) {
        if (key !== "" && !read.remote.has(id) && read.onlineNodes.has(key)) {
          node.pending.delete(id);
          deleted.add(id);
          freed.add(key);
        }
      }
    }
    return freed;
  };

  let reported = -1;
  // R1-4: `force` refreshes the note even when the count is unchanged.
  const progress = (force = false): void => {
    if (!onProgress || undecided().length === 0) return;
    if (!force && deleted.size === reported) return;
    reported = deleted.size;
    onProgress(deleted.size, ids.length);
  };

  for (;;) {
    const now = clock.now();
    if (now >= budgetEnd) break;
    const due = order.filter(key => {
      const n = nodes.get(key) as NodeRound;
      return !n.stopped && n.queue.length > 0 && n.readyAt <= now;
    });

    if (due.length > 0) {
      const roundStart = now;
      const sent = due.flatMap(key => (nodes.get(key) as NodeRound).queue);
      for (const key of due) (nodes.get(key) as NodeRound).queue = [];
      const results = await executeBulkSessionAction(api, "delete", sent, {
        beforeChunk: chunk => {
          remark();
          progress(true);
          for (const id of chunk) requestStart.set(id, clock.now());
        },
      });
      const byId = new Map(results.map(r => [r.id, r]));
      const tally = new Map<string, RoundTally>(
        due.map(key => [
          key,
          {
            progress: 0,
            pending: 0,
            retry: 0,
            outright: 0,
            refused: 0,
            unproven: 0,
          },
        ])
      );
      // F1 (board-26 PM): ids the round-end read must prove gone before they
      // count as deleted: a not_found on a RESEND (the hub's not_found is a
      // cache miss, and a restarted hub has no cache), a node_offline for an
      // id an earlier request may have deleted (S4), and a remote id with no
      // code.
      const recheck: string[] = [];
      const codeless: string[] = [];
      for (const id of sent) {
        const key = nodeKey(id);
        const node = nodes.get(key) as NodeRound;
        const t = tally.get(key) as RoundTally;
        const r = byId.get(id) ?? { id, ok: false, error: "No answer" };
        const resend = sentBefore.has(id);
        if (
          key !== "" &&
          ((r.code === "not_found" && resend) ||
            (r.code === "node_offline" && mayBeDeleted.has(id)))
        ) {
          recheck.push(id);
          continue;
        }
        unconfirmed.delete(id);
        lastItem.set(id, r);
        if (r.ok || r.code === "not_found") {
          deleted.add(id);
          t.progress += 1;
        } else if (r.pending === true) {
          node.pending.set(id, requestStart.get(id) ?? roundStart);
          t.pending += 1;
        } else if (r.retry === true) {
          node.queue.push(id);
          t.retry += 1;
          // F-1: a `retry` says nothing of an earlier request that may have
          // deleted it: it stays unproven, and not confirmed if the loop ends.
          if (key !== "" && mayBeDeleted.has(id)) {
            t.unproven += 1;
            unconfirmed.add(id);
          }
        } else if (!r.code && key !== "") {
          codeless.push(id);
        } else {
          // A definite failure, or a local code-less unknown the closing
          // read decides: either way this send did not show the node working.
          if (r.code) failures.set(id, bulkFailureLabel(r, "delete"));
          else unknown.add(id);
          // R1-3: a refusal for one session says nothing about its node.
          if (!r.code || r.code === "node_offline") t.outright += 1;
          else t.refused += 1;
        }
      }
      for (const id of sent) sentBefore.add(id);
      progress(true);
      const needRead =
        recheck.length > 0 ||
        codeless.length > 0 ||
        [...nodes.values()].some(n => n.pending.size > 0);
      const read = needRead ? await readListsDirect(api, false) : null;
      for (const id of recheck) {
        const t = tally.get(nodeKey(id)) as RoundTally;
        if (provenGone(read, id)) {
          deleted.add(id);
          t.progress += 1;
        } else {
          // Not proven: it stays in the loop and is sent again.
          (nodes.get(nodeKey(id)) as NodeRound).queue.push(id);
          unconfirmed.add(id);
          mayBeDeleted.add(id);
          t.retry += 1;
          t.unproven += 1;
        }
      }
      for (const id of codeless) {
        const t = tally.get(nodeKey(id)) as RoundTally;
        const r = lastItem.get(id) as BulkSessionResultItem;
        if (provenGone(read, id)) {
          deleted.add(id);
          t.progress += 1;
        } else if (read?.remote?.has(id)) {
          // Still listed: #6210's rule, a failure; the peer kept that one.
          failures.set(id, bulkFailureLabel(r, "delete"));
          t.refused += 1;
        } else {
          // Unreadable, or absent while its node is not shown present: it
          // stays in the loop and is sent again.
          (nodes.get(nodeKey(id)) as NodeRound).queue.push(id);
          mayBeDeleted.add(id);
          t.retry += 1;
          t.unproven += 1;
        }
      }
      // The round-end read: a pending id read as deleted is that node's ok.
      for (const key of await decidePending(read)) {
        const t = tally.get(key);
        if (t) t.progress += 1;
        else {
          const n = nodes.get(key) as NodeRound;
          if (n.waiting) n.readyAt = clock.now();
        }
      }
      const after = clock.now();
      for (const key of due) {
        const node = nodes.get(key) as NodeRound;
        const t = tally.get(key) as RoundTally;
        node.waiting = false;
        if (t.progress > 0 || t.pending > 0) node.refusals = 0;
        else if (t.refused > 0) node.refusals += 1;
        if (t.progress > 0) {
          node.readyAt = after;
        } else if (t.pending > 0) {
          node.waiting = true;
          node.readyAt = holdEnds(node, after);
        } else if (
          // X1: never while an id is left unproven: it is sent again.
          (t.outright > 0 || node.refusals >= BULK_DELETE_REFUSAL_ROUNDS) &&
          t.unproven === 0
        ) {
          node.stopped = true;
        } else if (t.retry > 0) {
          node.waiting = true;
          node.readyAt = Math.min(
            after + BULK_DELETE_WAIT_READ_MS,
            holdOpen(node, after) ? holdEnds(node, after) : Infinity
          );
        }
      }
      progress(true);
      continue;
    }

    // Nothing is due: wait for a node that still has ids to send, or for
    // pending ids still holding a slot, to be decided.
    const live = [...nodes.values()].filter(
      n => !n.stopped && (n.queue.length > 0 || decisionOpen(n, now))
    );
    if (live.length === 0) break;
    const nextRound = Math.min(
      ...live.filter(n => n.queue.length > 0).map(n => n.readyAt)
    );
    await clock.sleep(
      Math.max(
        0,
        Math.min(BULK_DELETE_WAIT_READ_MS, nextRound - now, budgetEnd - now)
      )
    );
    remark();
    for (const key of await decidePending()) {
      const n = nodes.get(key) as NodeRound;
      if (n.waiting) n.readyAt = clock.now();
    }
    progress(true);
  }

  // The loop ended: ids never sent fail with their `retry` text; one sent
  // and answered not_found that no read proved gone, as not confirmed (N1).
  for (const [key, node] of nodes) {
    for (const id of node.queue) {
      failures.set(
        id,
        unconfirmed.has(id)
          ? notConfirmedLabel(node.label ?? key)
          : bulkFailureLabel(
              lastItem.get(id) ?? { id, ok: false, retry: true },
              "delete"
            )
      );
    }
  }
  const pendingIds = [...nodes].flatMap(([key, n]) =>
    [...n.pending].map(([id, sentAt]) => ({ id, key, sentAt }))
  );
  const stillDeleting: BulkDeleteRoundsOutcome["stillDeleting"] = [];
  if (pendingIds.length > 0 || unknown.size > 0) {
    if (params.mark) {
      for (const { id } of pendingIds) clearActionPending(id, "delete");
      for (const id of unknown) clearActionPending(id, "delete");
    }
    const read = await readListsDirect(
      api,
      [...unknown].some(id => nodeKey(id) === "")
    );
    const listed = (id: string): boolean =>
      (read.local?.has(id) ?? false) || (read.remote?.has(id) ?? false);
    for (const { id, key, sentAt } of pendingIds) {
      const gone =
        key !== "" &&
        read.remote !== null &&
        !listed(id) &&
        read.onlineNodes.has(key);
      const item = lastItem.get(id);
      const node =
        nodeOf(id)?.nodeLabel ?? (item ? pendingNodeLabel(item) : undefined);
      if (gone) {
        deleted.add(id);
      } else if (
        // R1-2 (B1), R2-2: not gone while its node reads online, so the read
        // lists it; past its hold and the hub's tail the hub no longer watches
        // it: not confirmed, never "still being deleted".
        read.onlineNodes.has(key) &&
        clock.now() >=
          sentAt + BULK_DELETE_SLOT_HOLD_MS + BULK_DELETE_CONFIRM_TAIL_MS
      ) {
        failures.set(
          id,
          notConfirmedLabel(node ?? key, item && pendingPeerText(item))
        );
      } else {
        stillDeleting.push({ id, node });
      }
    }
    for (const id of unknown) {
      const readable = nodeKey(id) === "" ? read.local : read.remote;
      if (readable === null || listed(id)) {
        failures.set(
          id,
          bulkFailureLabel(
            lastItem.get(id) ?? { id, ok: false, error: "No answer" },
            "delete"
          )
        );
      } else {
        deleted.add(id);
      }
    }
  }

  return {
    deleted: ids.filter(id => deleted.has(id)),
    failures: ids
      .filter(id => failures.has(id))
      .map(id => ({ id, label: failures.get(id) as string })),
    stillDeleting,
  };
}

function refreshSessionLists(
  queryClient: QueryClient,
  refetchType: "active" | "all"
): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: queryKeys.sessions,
      refetchType,
    }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.federationAllSessions,
      refetchType,
    }),
  ]);
}

/**
 * #6210: the Select-mode bulk delete, after its rows were already removed
 * (`removeSessionRows`). It runs on raw `api.*` calls and the app-level query
 * client, so it finishes after the chip row unmounts. It never rejects.
 *
 * 1. Disconnect the connected selection. Only a session that was already
 *    disconnected, or whose disconnect answered `ok` / `session_inactive`, is
 *    sent to delete (#3815-17). A disconnect `not_found` is already gone.
 * 2. Delete, in #6681's per-node rounds (`runBulkDeleteRounds`) within
 *    BULK_DELETE_BUDGET_MS, with a progress toast while they run. `ok` and
 *    `not_found` count as deleted; a coded result is a definite failure; a
 *    `pending` id is decided from a direct read of the lists (never the query
 *    cache, R8); an id never sent fails as "not sent (<node> busy)".
 * 3. Settle:
 *    - Failures and sessions still being deleted get their rows back by id,
 *      and their marks cleared (D1 = 1: a still-deleting row leaves the list
 *      once its node confirms).
 *    - Ids deleted keep their delete-pending marks until the store's TTL, so
 *      stale hub data cannot show them again; a pending id the closing read
 *      decided deleted is not re-marked (its mark was cleared for that read).
 *    - Both lists are invalidated for display, fire-and-forget.
 * 4. One toast: "Deleted N sessions", "… · M still being deleted on <node>",
 *    or "N sessions could not be deleted: <reasons>".
 */
export async function runBulkDeleteInBackground(params: {
  api: ApiClient;
  queryClient: QueryClient;
  showToast: BulkDeleteToast;
  /** R1-4: takes the run's progress note down. */
  clearToast: (key: string) => void;
  connectedIds: readonly string[];
  disconnectedIds: readonly string[];
  snapshot: SessionListSnapshots;
  clock?: BulkDeleteClock;
}): Promise<void> {
  const {
    api,
    queryClient,
    showToast,
    clearToast,
    connectedIds,
    disconnectedIds,
    snapshot,
  } = params;
  const allIds = [...disconnectedIds, ...connectedIds];
  const remark = (): void => {
    for (const id of allIds) markActionPending(id, "delete");
  };

  try {
    const deleted: string[] = [];
    const failures: Array<{ id: string; label: string }> = [];
    let stillDeleting: BulkDeleteRoundsOutcome["stillDeleting"] = [];
    const deletable: string[] = [...disconnectedIds];

    if (connectedIds.length > 0) {
      const archived = await executeBulkSessionAction(
        api,
        "archive",
        connectedIds,
        { beforeChunk: remark }
      );
      const byId = new Map(archived.map(r => [r.id, r]));
      for (const id of connectedIds) {
        const r = byId.get(id);
        if (!r) {
          failures.push({ id, label: "disconnect failed: no answer" });
        } else if (r.ok || r.code === "session_inactive") {
          deletable.push(id);
        } else if (r.code === "not_found") {
          deleted.push(id);
        } else {
          failures.push({ id, label: bulkFailureLabel(r, "disconnect") });
        }
      }
    }

    if (deletable.length > 0) {
      const note = bulkDeleteProgressNote(showToast, clearToast);
      try {
        const run = await runBulkDeleteRounds({
          api,
          ids: deletable,
          nodeOf: snapshotNodeOf(snapshot),
          mark: true,
          onProgress: note.onProgress,
          clock: params.clock,
        });
        deleted.push(...run.deleted);
        failures.push(...run.failures);
        stillDeleting = run.stillDeleting;
      } finally {
        note.end();
      }
    }

    dropSessionDetailCaches(queryClient, deleted);
    const back = [...failures.map(f => f.id), ...stillDeleting.map(s => s.id)];
    for (const id of back) clearActionPending(id, "delete");
    restoreSessionRowsById(queryClient, snapshot, back);
    // Optimistic state augments the refetch; it never replaces it.
    void refreshSessionLists(queryClient, "active");

    const { message, type } = summarizeBulkDelete(
      deleted.length,
      failures,
      stillDeleting
    );
    showToast(message, { type });
  } catch (err) {
    console.warn(
      "[useBulkSessionAction] Bulk delete failed:",
      err instanceof Error ? err.message : err
    );
    for (const id of allIds) clearActionPending(id, "delete");
    restoreSessionRowsById(queryClient, snapshot, allIds);
    void refreshSessionLists(queryClient, "active");
    showToast("Failed to delete sessions", { type: "error" });
  }
}

export function useBulkSessionAction(api: ApiClient | null): {
  runBulkAction: (
    action: BulkSessionActionKind,
    ids: readonly string[]
  ) => Promise<BulkSessionResult>;
  isPending: boolean;
} {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (input: {
      action: BulkSessionActionKind;
      ids: readonly string[];
    }): Promise<BulkSessionResult> => {
      if (!api) {
        throw new Error("API unavailable");
      }
      return executeBulkSessionAction(api, input.action, input.ids);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.federationAllSessions,
      });
    },
  });

  return {
    runBulkAction: (action, ids) => mutation.mutateAsync({ action, ids }),
    isPending: mutation.isPending,
  };
}
