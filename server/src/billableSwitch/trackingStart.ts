// SPDX-License-Identifier: AGPL-3.0-only
import {
  projectBaseKey,
  projectKeyKind,
  resolveTrackingStart,
  type BillableSwitchKeyKind,
  type BillableSwitchMode,
  type BillableSwitchStartContext,
  type ProjectKeyMetadata,
  type TrackingLostCause,
  type TrackingOrigin,
  type TrackingRecordDraft,
} from "@hapi/protocol";
import type { Store } from "../store";
import type { BillableSwitchInitial } from "../store/sessions";

// A new session's tracking record at registration (issue #6778 PR-B, Task 7;
// the plan's section 5 and 4.2 rows 10 to 13). The pure table is
// `resolveTrackingStart` (`@hapi/protocol`); this module feeds it what only the
// owning node knows (the queued start, the parent's record, the session's own
// project) and returns the writer's input for the row INSERT.
//
// The start context waits in the durable table `billable_tracking_pending_starts`
// (ruling 6), not in memory, so a restart between the spawn and the
// registration keeps it. A start that carried settings and could not be applied
// (its entry expired, a registration came from another namespace, or the start
// failed in the hook) is a LOST start: the session registers untracked with a
// `start` row of reason `start-lost` whose label holds the cause only, never a
// requested value (review X1), and one error-log row. The entry stays, marked
// lost, for seven days, so a late registration still finds its cause. The inbox
// notice of a lost start is PR-C's, with its notification kind (the Project
// Manager's ruling of 2026-11-20).

/** How long a queued start waits for its registration (the same 30 minutes as the parent queue). */
export const TRACKING_PENDING_START_MAX_AGE_MS = 30 * 60 * 1000;

/** How long a lost start's entry is kept, so a late registration still finds its cause. */
export const TRACKING_LOST_START_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** The error-log category of a start that failed or was lost (the hook failure's, since #6646). */
export const TRACKING_START_ERROR_CATEGORY = "billable-switch-start";

const LOST_CAUSES: readonly TrackingLostCause[] = [
  "expired",
  "namespace",
  "hook-failed",
];

export type TrackingStartDeps = {
  store: Store;
  getMode: () => BillableSwitchMode;
  getLocalNodeId: () => string;
  now: () => number;
};

/** A registration about to insert its row (the start hook's input). */
export type TrackingRegistration = {
  tag: string;
  metadata: unknown;
  namespace: string;
  /**
   * Set on the hook's second call, after its first call or the insert threw:
   * decide only the lost start (row 12, `hook-failed`).
   */
  failed?: true;
};

/** The origin of a start's history row (7.4), by its kind. */
export function startOrigin(kind: string): TrackingOrigin {
  if (kind === "person") return "create-page";
  if (kind === "agent" || kind === "inherit") return "inheritance";
  if (kind === "schedule") return "schedule";
  return "api";
}

function parseContext(json: string): BillableSwitchStartContext | null {
  try {
    const value: unknown = JSON.parse(json);
    if (
      value !== null &&
      typeof value === "object" &&
      typeof (value as { kind?: unknown }).kind === "string"
    ) {
      return value as BillableSwitchStartContext;
    }
  } catch {
    // An unreadable entry is a lost start (its settings cannot be known).
  }
  return null;
}

function asLostCause(reason: string | null): TrackingLostCause {
  return LOST_CAUSES.find(c => c === reason) ?? "expired";
}

/**
 * The parent's record, read at registration: an `inherit` copies only from a
 * parent whose session row exists (review C12), so a deleted parent gives an
 * untracked start even though its record is kept (R11).
 */
function parentRecord(
  store: Store,
  parentId: string,
  namespace: string | null
): TrackingRecordDraft | null {
  if (store.billableSwitch.getSwitch(parentId) === null) return null;
  const ns = namespace ?? store.sessions.getSession(parentId)?.namespace;
  if (!ns) return null;
  return store.billableTracking.get(parentId, ns)?.record ?? null;
}

/**
 * True when a queued start carries settings: validated values to apply, or a
 * parent whose record an `inherit` copies. In PR-B an agent's parent is never
 * copied (the interim rule in `resolveTrackingStartForInsert`), so an agent
 * start carries none. A start without settings loses nothing when its entry
 * expires or a foreign registration meets it.
 */
export function startHasSettings(
  store: Store,
  context: BillableSwitchStartContext,
  namespace: string | null
): boolean {
  if (context.tracking !== undefined) return true;
  if (context.kind === "inherit" && context.fromSessionId) {
    return parentRecord(store, context.fromSessionId, namespace) !== null;
  }
  return false;
}

/**
 * Lost starts since this process started. The Project Manager's ruling of
 * 2026-11-20 replaces the plan's "logged with the boot line's counts" (4.2 row
 * 10), where the count is 0 by construction: each lost start's own error-log
 * row carries the running number, as a hook failure's row does.
 */
let lostStartsSinceStart = 0;
/**
 * The tags already counted, so a lost start whose first row was rolled back
 * with a failed insert is counted once (review finding M6). Cleared when it
 * grows past 10,000 tags; a lost start is rare.
 */
const countedLostTags = new Set<string>();

function logLostStart(
  store: Store,
  tag: string,
  cause: TrackingLostCause
): void {
  if (!countedLostTags.has(tag)) {
    if (countedLostTags.size >= 10_000) countedLostTags.clear();
    countedLostTags.add(tag);
    lostStartsSinceStart += 1;
  }
  try {
    store.errorLogs.createEntry({
      severity: "error",
      category: TRACKING_START_ERROR_CATEGORY,
      source: "server",
      message: `The tracking settings of session ${tag} were lost (${cause}): it starts untracked, and a start-lost row records it (${lostStartsSinceStart} lost since this server started).`,
      context: JSON.stringify({
        tag,
        lostCause: cause,
        lostSinceStart: lostStartsSinceStart,
      }),
    });
  } catch {
    // Best-effort: the start-lost row records the loss either way.
  }
}

type PendingFind = {
  context: BillableSwitchStartContext | null;
  lost: TrackingLostCause | null;
  /** The entry's change, run last so that a throw before it leaves the entry as it was. */
  settle: (() => void) | null;
};

/**
 * What the registration finds in the durable table, inside the registration
 * transaction. A live, fresh entry of this namespace is applied and deleted. An
 * entry already marked lost gives row 12 with its cause and is kept. A stale or
 * foreign entry that carried settings is marked lost now (row 12, one
 * error-log row); one that carried none behaves as before #6778: a stale one is
 * dropped, a foreign one is left for its own namespace, and the start has no
 * context.
 */
function findPendingStart(
  deps: TrackingStartDeps,
  tag: string,
  namespace: string,
  now: number
): PendingFind {
  const pending = deps.store.billableTracking;
  const entry = pending.getPendingStart(tag);
  if (!entry) return { context: null, lost: null, settle: null };
  const context = parseContext(entry.contextJson);
  if (entry.lostAt !== null) {
    return { context, lost: asLostCause(entry.lostReason), settle: null };
  }
  const markLost = (cause: TrackingLostCause) => () => {
    pending.markPendingStartLost(tag, cause, now);
    logLostStart(deps.store, tag, cause);
  };
  if (context === null) {
    return {
      context: null,
      lost: "hook-failed",
      settle: markLost("hook-failed"),
    };
  }
  const entryNamespace = entry.namespace ?? context.namespace ?? null;
  const foreign = entryNamespace !== null && entryNamespace !== namespace;
  const stale = now - entry.queuedAt > TRACKING_PENDING_START_MAX_AGE_MS;
  if (foreign || stale) {
    const cause: TrackingLostCause = foreign ? "namespace" : "expired";
    if (!startHasSettings(deps.store, context, entryNamespace ?? namespace)) {
      return {
        context: null,
        lost: null,
        settle: foreign ? null : () => pending.deletePendingStart(tag),
      };
    }
    return { context, lost: cause, settle: markLost(cause) };
  }
  return { context, lost: null, settle: () => pending.deletePendingStart(tag) };
}

function projectOf(metadata: ProjectKeyMetadata): {
  kind: BillableSwitchKeyKind;
  key: string;
  name: string;
} {
  const key = projectBaseKey(metadata);
  // Ruling D-2: a folder that is not a repository is the project, shown as its path.
  return { kind: projectKeyKind(metadata), key, name: key };
}

function eventFor(
  deps: TrackingStartDeps,
  context: BillableSwitchStartContext | null,
  kind: string,
  projectKey: string,
  keyKind: BillableSwitchKeyKind,
  label: Record<string, unknown>,
  now: number
): BillableSwitchInitial["event"] {
  return {
    actorKind: context?.actor?.kind ?? "system",
    actorSessionId: context?.actor?.sessionId ?? null,
    actorUserAgent: context?.actor?.userAgent ?? null,
    via: context?.actor ? (context.via ?? "direct") : "internal",
    entryNodeId: context?.entryNodeId ?? deps.getLocalNodeId(),
    projectKey,
    keyKind,
    startKind: kind as BillableSwitchInitial["event"]["startKind"],
    timerMs: 0,
    unloggedMs: 0,
    loggedKnown: false,
    label,
    at: now,
  };
}

/** Row 12: untracked, a `start-lost` row whose label holds the cause only (review X1). */
function lostStart(
  deps: TrackingStartDeps,
  context: BillableSwitchStartContext | null,
  metadata: ProjectKeyMetadata,
  cause: TrackingLostCause,
  now: number
): BillableSwitchInitial {
  const kind = context?.kind ?? "unattended";
  const project = projectOf(metadata);
  return {
    record: null,
    reason: "start-lost",
    origin: startOrigin(kind),
    event: eventFor(
      deps,
      context,
      kind,
      project.key,
      project.kind,
      { lostCause: cause },
      now
    ),
  };
}

/**
 * The start value of a session row about to be inserted (the start hook). Null
 * when the gate is not `on` (row 1: nothing stored, no row). Otherwise the
 * queued start is read from the durable table and settled inside this
 * registration's transaction, and the pure table decides the row.
 */
export function resolveTrackingStartForInsert(
  deps: TrackingStartDeps,
  input: TrackingRegistration
): BillableSwitchInitial | null {
  const mode = deps.getMode();
  if (mode !== "on") return null;
  const now = deps.now();
  const meta = (input.metadata ?? {}) as ProjectKeyMetadata & {
    name?: unknown;
    path?: unknown;
    startedBy?: unknown;
  };

  if (input.failed) {
    // Review finding M6: the cause is the entry's own, by the rules of a normal
    // registration (an expired or foreign start stays `expired` or
    // `namespace`), and it is logged here: when the insert failed, the first
    // attempt's mark and its error-log row rolled back with it. A start that
    // failed in the hook is `hook-failed`, and the hook failure's own error-log
    // row records it (no second row).
    const found = findPendingStart(deps, input.tag, input.namespace, now);
    const cause: TrackingLostCause = found.lost ?? "hook-failed";
    const entry = deps.store.billableTracking.getPendingStart(input.tag);
    if (entry && entry.lostAt === null) {
      deps.store.billableTracking.markPendingStartLost(input.tag, cause, now);
      if (cause !== "hook-failed") logLostStart(deps.store, input.tag, cause);
    }
    const context = entry ? parseContext(entry.contextJson) : null;
    return lostStart(deps, context, meta, cause, now);
  }

  const found = findPendingStart(deps, input.tag, input.namespace, now);
  const context = found.context;
  const kind = context?.kind ?? "unattended";
  const project = projectOf(meta);

  // PR-B interim, until PR-C's Task 15 (the caller check, and the carried copy
  // of a parent on another node): an agent start copies no parent, on this node
  // or across nodes, so it starts untracked (section 5 row 5). Only `inherit`
  // reads a parent here.
  const parentId = kind === "inherit" ? context?.fromSessionId : undefined;
  const source =
    found.lost === null && parentId
      ? parentRecord(deps.store, parentId, input.namespace)
      : null;

  const result = resolveTrackingStart({
    mode,
    kind,
    choice: context?.choice,
    tracking: context?.tracking,
    source,
    // PR-B interim, until PR-C's Task 15b (the route's person claim, ruling 5):
    // the start cannot tell a person's branch in the app, or a successor, from
    // any other `inherit`, so every `inherit` copy waits under "To confirm"
    // (row 6b), which never bills a copy unseen.
    inheritWaits: true,
    lost: found.lost,
    project,
    createdAt: now,
  });
  if (result.reason === null) return null;

  let label: Record<string, unknown>;
  if (result.reason === "start-lost") {
    label = { lostCause: result.lostCause };
  } else {
    label = {
      name: typeof meta.name === "string" ? meta.name : null,
      projectKey: project.key,
      path: typeof meta.path === "string" ? meta.path : null,
    };
    if (!context) {
      label.context = "none";
      label.startedBy =
        typeof meta.startedBy === "string" ? meta.startedBy : null;
    }
    if (kind === "inherit" && context?.fromSessionId) {
      label.parentSessionId = context.fromSessionId;
    }
    if (kind === "schedule" && context?.scheduleId) {
      label.scheduleId = context.scheduleId;
    }
  }
  const initial: BillableSwitchInitial = {
    record: result.record,
    reason: result.reason,
    origin: startOrigin(kind),
    event: eventFor(deps, context, kind, project.key, project.kind, label, now),
  };
  found.settle?.();
  return initial;
}

/**
 * The sweep of the durable table (on the service's timer and whenever the
 * spawn queues are touched): an expired live entry that carried settings is
 * marked lost (row 12 for its late registration, one error-log row); one that
 * carried none is dropped; a lost entry older than seven days is removed.
 * Returns how many live entries it marked or dropped. Never throws: a sweep
 * runs from a timer, and a billing feature must never stop the server.
 */
export function sweepExpiredPendingStarts(store: Store, now: number): number {
  let touched = 0;
  try {
    const pending = store.billableTracking;
    const expired = pending.listExpiredPendingStarts(
      now - TRACKING_PENDING_START_MAX_AGE_MS
    );
    for (const entry of expired) {
      // Review finding L1: one entry that throws no longer stops the others
      // or the prune below.
      try {
        const context = parseContext(entry.contextJson);
        const namespace = entry.namespace ?? context?.namespace ?? null;
        if (context !== null && !startHasSettings(store, context, namespace)) {
          pending.deletePendingStart(entry.tag);
        } else {
          pending.markPendingStartLost(entry.tag, "expired", now);
          logLostStart(store, entry.tag, "expired");
        }
        touched += 1;
      } catch (error) {
        console.error(
          `[BillableTracking] The pending-start sweep could not settle the entry of ${entry.tag}; it is tried again on the next sweep:`,
          error instanceof Error ? error.message : error
        );
      }
    }
    pending.pruneLostPendingStarts(now - TRACKING_LOST_START_KEEP_MS);
  } catch (error) {
    console.error(
      "[BillableTracking] The pending-start sweep failed; it runs again on the next sweep:",
      error instanceof Error ? error.message : error
    );
  }
  return touched;
}
