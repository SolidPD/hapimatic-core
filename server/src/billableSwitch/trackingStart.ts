// SPDX-License-Identifier: AGPL-3.0-only
import {
  BILLABLE_SWITCH_START_KINDS,
  resolveTrackingStart,
  sourceFromCarriedCopy,
  trackingProjectOf,
  type BillableSwitchKeyKind,
  type BillableSwitchMode,
  type BillableSwitchStartContext,
  type ProjectKeyMetadata,
  type SpawnTrackingAnswer,
  type TrackingLostCause,
  type TrackingOrigin,
  type TrackingRecordDraft,
} from "@hapi/protocol";
import {
  trackingStartLostNotification,
  type ProducerNotification,
} from "../notifications/producerNotifications";
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
// notice of a lost start (kind `tracking-not-applied`, #6778 PR-C moved item 3)
// is raised once, when the start is lost: at registration, or at the sweep for
// an expired entry.

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
  "unreadable",
  "queue-failed",
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

/**
 * Why a queued start context cannot be read (moved item 7; review finding L2).
 * The error-log row names the defect, never the context, which may hold a rate.
 */
type ContextDefect = "not-json" | "not-an-object" | "no-kind" | "unknown-kind";

const DEFECT_WORDS: Record<ContextDefect, string> = {
  "not-json": "not JSON",
  "not-an-object": "not an object",
  "no-kind": "no start kind",
  "unknown-kind": "an unknown start kind",
};

type ParsedContext =
  | { context: BillableSwitchStartContext; defect: null }
  | { context: null; defect: ContextDefect };

/** An unreadable entry is a lost start of cause `unreadable`: its settings cannot be known. */
function parseContext(json: string): ParsedContext {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { context: null, defect: "not-json" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { context: null, defect: "not-an-object" };
  }
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== "string") return { context: null, defect: "no-kind" };
  // Group B item 7 (finding 725aec0c): a kind this build does not know is
  // never written as a start_kind, which every puller would reject.
  if (!(BILLABLE_SWITCH_START_KINDS as readonly string[]).includes(kind)) {
    return { context: null, defect: "unknown-kind" };
  }
  return { context: value as BillableSwitchStartContext, defect: null };
}

/**
 * #6778 PR-C (Task 15b; ruling PRC-R5): whether an `inherit` start waits under
 * "To confirm" (section 5 row 6b). Only a person's branch or resume in the app
 * and the successor hand-off say they do not (row 6a: the parent's confirm
 * state); every other `inherit` waits, a start that carries no claim included,
 * so a start site nobody chose never bills a copy unseen. The three same-tag
 * respawns (`respawnBase.ts`, `sessionLifecycleOps.ts` and the reconnect in
 * `sessionRespawn.ts`) send no claim on purpose: their row exists, so nothing
 * is applied, and a new row there would wait or start untracked, the safe side.
 */
export function inheritStartWaits(
  context: BillableSwitchStartContext | null
): boolean {
  const claim = context?.inheritClaim;
  return claim !== "person" && claim !== "successor";
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
 * The parent a start copies: an `inherit` start's `fromSessionId`, an agent's
 * claimed parent (`inheritedFrom`, set by the entry node only when a copy would
 * be made, #6778 Task 15). Any other start copies nothing.
 */
function copiedParentId(
  context: BillableSwitchStartContext | null
): string | undefined {
  if (context?.kind === "inherit") return context.fromSessionId;
  if (context?.kind === "agent") return context.inheritedFrom?.sessionId;
  return undefined;
}

/**
 * The record a copy is made from (4.2, the one rule): the parent's own record
 * when its session is on this node, read now, at registration; an agent's copy
 * carried from the entry node only when the parent is on another node.
 */
function copySource(
  deps: TrackingStartDeps,
  context: BillableSwitchStartContext | null,
  parentId: string | undefined,
  namespace: string | null
): TrackingRecordDraft | null {
  if (!parentId) return null;
  if (deps.store.billableSwitch.getSwitch(parentId) !== null) {
    return parentRecord(deps.store, parentId, namespace);
  }
  if (context?.kind === "agent" && context.inheritedCopy) {
    return sourceFromCarriedCopy(context.inheritedCopy);
  }
  return null;
}

/**
 * True when a queued start carries settings: validated values to apply, or a
 * parent whose record an `inherit` or an agent's start copies. A start without
 * settings loses nothing when its entry expires or a foreign registration
 * meets it.
 */
export function startHasSettings(
  store: Store,
  context: BillableSwitchStartContext,
  namespace: string | null
): boolean {
  if (context.tracking !== undefined) return true;
  if (context.kind === "agent" && context.inheritedCopy !== undefined) {
    return true;
  }
  const parentId = copiedParentId(context);
  if (parentId) return parentRecord(store, parentId, namespace) !== null;
  return false;
}

/**
 * RF-2 (#6778 PR-C): a start that inherits from the session that already holds
 * its tag (a reconnect, a relaunch, an account restart). The row exists, so the
 * registration finds it and applies nothing: such a start carries nothing that
 * can be lost, whether or not that session has a start row (one created while
 * the gate was off has none, so `registeredUnder` does not see it). Judged on
 * the tag column alone, which the registration looks the session up by.
 */
function inheritsFromOwnTag(
  store: Store,
  tag: string,
  context: BillableSwitchStartContext
): boolean {
  return (
    context.kind === "inherit" &&
    context.fromSessionId !== undefined &&
    store.sessions.getSession(context.fromSessionId)?.tag === tag
  );
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
  cause: TrackingLostCause,
  when: "registration" | "sweep" = "registration",
  defect: ContextDefect | null = null
): void {
  const why =
    defect === null
      ? cause
      : `${cause}: the queued context is ${DEFECT_WORDS[defect]}`;
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
      // Moved item 8 (review finding L3): at the sweep no session has
      // registered under the tag, so no history row exists yet.
      message:
        when === "sweep"
          ? `The tracking settings queued for session ${tag} were lost (${why}) before any session registered under it: a session that registers under it later starts untracked, with a start-lost row (${lostStartsSinceStart} lost since this server started).`
          : `The tracking settings of session ${tag} were lost (${why}): it starts untracked, and a start-lost row records it (${lostStartsSinceStart} lost since this server started).`,
      context: JSON.stringify({
        tag,
        lostCause: cause,
        ...(defect === null ? {} : { contextDefect: defect }),
        lostSinceStart: lostStartsSinceStart,
      }),
    });
  } catch (logError) {
    // Never silent (review finding 78c033d3): the cause and the tag only.
    console.error(
      `[BillableTracking] The error log could not record the lost start of session ${tag} (${cause}):`,
      logError instanceof Error ? logError.message : String(logError)
    );
  }
}

/**
 * Moved item 8 (review finding L3): the tags whose queued start was spent (a
 * reattach, or a coded refusal that proves no child exists) but whose entry
 * could not be deleted. A registration reads such an entry as absent and the
 * sweep deletes it instead of marking it lost, so a late registration never
 * writes a false start-lost row. Held in this process: after a restart the
 * entry reads as it is stored (the residual named in PR-C).
 */
const spentTags = new Set<string>();

/**
 * A durable "already registered" (the Project Manager's point 2 on moved item
 * 8, 2026-11-21): a session of this tag, in the entry's namespace (any when the
 * entry names none), that already has its start row. Its queued start was
 * spent, so an entry left behind (a delete that failed before a restart) is
 * deleted and never recorded as lost. A session being created has no start
 * row yet, so a first registration is never read as registered.
 */
function registeredUnder(
  store: Store,
  tag: string,
  namespace: string | null
): boolean {
  const row = store
    .getRawDb()
    .prepare(
      `SELECT 1 FROM sessions s
         JOIN billable_switch_events e ON e.session_id = s.id AND e.kind = 'start'
        WHERE s.tag = ? AND (? IS NULL OR s.namespace = ?) LIMIT 1`
    )
    .get(tag, namespace, namespace);
  return row != null;
}

/**
 * A new start was queued under the tag (a respawn under the same tag): its
 * entry is live, so the tag is no longer held as spent.
 */
export function noteQueuedPendingStart(tag: string): void {
  spentTags.delete(tag);
  noticedTags.delete(tag);
  unqueuedTags.delete(tag);
}

/**
 * Moved item 6 (#6778 PR-C; review finding M1, its second half): the tags whose
 * start carried settings, could not be queued, and whose lost marker could not
 * be written either. Held in this process, so a registration under such a tag
 * is still row 12 (`queue-failed`); after a restart only the notice and the
 * error-log row remain (the residual).
 */
const unqueuedTags = new Set<string>();

/**
 * Moved item 6: the queue write of a start threw (the caller has logged it).
 * A start that carried settings is lost now: a lost marker of cause
 * `queue-failed`, holding the start's kind and namespace only, is written in
 * one transaction, or, when that fails too, the tag is held in this process.
 * Its notice is raised once. A start that carried none, and a respawn under the
 * session's own tag (RF-2), lose nothing and register as they would have. Never
 * throws.
 */
export function recordUnqueuedStart(
  store: Store,
  tag: string,
  context: BillableSwitchStartContext,
  now: number
): void {
  const namespace = context.namespace ?? null;
  let carried: boolean;
  try {
    carried =
      startHasSettings(store, context, namespace) &&
      !inheritsFromOwnTag(store, tag, context);
  } catch {
    // The store cannot be read: judge by the carried values alone.
    carried =
      context.tracking !== undefined || context.inheritedCopy !== undefined;
  }
  // A new start under the tag: what was held or noticed for an older one goes.
  unqueuedTags.delete(tag);
  noticedTags.delete(tag);
  if (!carried) return;
  try {
    store.getRawDb().transaction(() => {
      store.billableTracking.putPendingStart({
        tag,
        namespace,
        kind: context.kind,
        contextJson: JSON.stringify({
          kind: context.kind,
          ...(namespace === null ? {} : { namespace }),
        }),
        entryNodeId: context.entryNodeId ?? null,
        queuedAt: now,
      });
      store.billableTracking.markPendingStartLost(tag, "queue-failed", now);
    })();
  } catch (error) {
    if (unqueuedTags.size >= 10_000) unqueuedTags.clear();
    unqueuedTags.add(tag);
    console.error(
      `[BillableTracking] The lost start of session ${tag} (queue-failed) could not be recorded either; this server holds it until the session registers:`,
      error instanceof Error ? error.message : String(error)
    );
  }
  noticeLostStartIfOwned(
    store,
    tag,
    "queue-failed",
    "queue",
    namespace,
    context
  );
}

/**
 * Ruling FND-6 (#6778 PR-C, review finding S6): where the notice of a start
 * lost at the sweep or at queue-failed goes: its own namespace, else, for an
 * `inherit` start (queued with none by the branch, the successor and the
 * transcript resume), its parent session's, as `parentRecord` reads it. Only
 * the notice: the queued entry, the registration guard and `registeredUnder`
 * keep the namespace they had. Null when neither can be read. Never throws.
 */
function lostNoticeNamespace(
  store: Store,
  namespace: string | null,
  context: BillableSwitchStartContext | null
): string | null {
  if (namespace !== null) return namespace;
  const parentId = copiedParentId(context);
  if (context?.kind !== "inherit" || !parentId) return null;
  try {
    return store.sessions.getSession(parentId)?.namespace ?? null;
  } catch {
    return null;
  }
}

/**
 * FND-6: the notice of a start lost before any registration, in the namespace
 * `lostNoticeNamespace` finds; with none, one console line instead (no row
 * could be scoped to anyone; the lost start's error-log row stays).
 */
function noticeLostStartIfOwned(
  store: Store,
  tag: string,
  cause: TrackingLostCause,
  when: "sweep" | "queue",
  namespace: string | null,
  context: BillableSwitchStartContext | null
): void {
  const owner = lostNoticeNamespace(store, namespace, context);
  if (owner === null) {
    console.error(
      `[BillableTracking] The lost start of session ${tag} (${cause}) has no namespace to notify: no notice was raised; its error-log row records it.`
    );
    return;
  }
  noticeLostStart(store, tag, cause, when, owner);
}

/**
 * Moved item 3 (#6778 PR-C): where a lost start's notice goes
 * (`SyncEngine.notifyUser`, handed over as the service's `notify`). Null until
 * a service with one is built, so a test or a bare store raises none.
 */
type TrackingNoticeSink = (notice: ProducerNotification) => void;
let noticeSink: TrackingNoticeSink | null = null;

/** Set by `BillableSwitchService` (one per process); null raises no notice. */
export function setTrackingNoticeSink(sink: TrackingNoticeSink | null): void {
  noticeSink = sink;
}

/** The tags whose lost start was noticed in this process, so it is raised once. */
const noticedTags = new Set<string>();

function sessionOfTag(
  store: Store,
  tag: string,
  namespace: string
): string | null {
  const row = store
    .getRawDb()
    .prepare("SELECT id FROM sessions WHERE tag = ? AND namespace = ? LIMIT 1")
    .get(tag, namespace) as { id: string } | null;
  return row?.id ?? null;
}

/**
 * Raise the notice of a start just marked lost, after the registration's
 * transaction: it waits for a microtask and is raised only when the entry is
 * still marked lost then, so a mark that rolled back with a failed insert
 * raises nothing and the failed path's own mark raises the one notice. It goes
 * to the namespace that queued the settings; at registration it names the new
 * session when that session is in the same namespace. Never throws.
 */
function noticeLostStart(
  store: Store,
  tag: string,
  cause: TrackingLostCause,
  when: "registration" | "sweep" | "queue",
  namespace: string | null
): void {
  const sink = noticeSink;
  if (!sink) return;
  queueMicrotask(() => {
    try {
      if (noticedTags.has(tag)) return;
      if (!unqueuedTags.has(tag)) {
        const entry = store.billableTracking.getPendingStart(tag);
        if (!entry || entry.lostAt === null) return;
      }
      if (noticedTags.size >= 10_000) noticedTags.clear();
      noticedTags.add(tag);
      const sessionId =
        when === "registration" && namespace !== null
          ? sessionOfTag(store, tag, namespace)
          : null;
      sink(
        trackingStartLostNotification({
          tag,
          lostCause: cause,
          sessionId,
          when,
          namespace,
        })
      );
    } catch (error) {
      console.error(
        `[BillableTracking] The notice of the lost start of session ${tag} (${cause}) could not be raised:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  });
}

/** Delete a spent entry; on success the tag is no longer held as spent. Never throws. */
function retrySpentDelete(store: Store, tag: string): void {
  try {
    store.billableTracking.deletePendingStart(tag);
    spentTags.delete(tag);
  } catch {
    // Already logged once, when the spend first failed; the sweep tries again.
  }
}

/**
 * Delete the queued start of a session whose start was spent (`reattach`) or
 * refused (`refused`). A failed delete is never silent: it is logged once, with
 * one error-log row naming the tag, and the tag is held as spent (above).
 * Never throws: a billing feature never stops a registration or a spawn.
 */
export function deleteSpentPendingStart(
  store: Store,
  tag: string,
  why: "reattach" | "refused"
): void {
  // Moved item 6: a spent start (a reattach, a coded refusal) is never lost.
  unqueuedTags.delete(tag);
  try {
    store.billableTracking.deletePendingStart(tag);
    spentTags.delete(tag);
    return;
  } catch (error) {
    if (spentTags.has(tag)) return;
    if (spentTags.size >= 10_000) spentTags.clear();
    spentTags.add(tag);
    const reason = error instanceof Error ? error.message : String(error);
    const message = `The queued start of session ${tag} was spent (${why}) but its entry could not be deleted: it is not a lost start, and the next sweep deletes it.`;
    console.error(`[BillableTracking] ${message}`, reason);
    try {
      store.errorLogs.createEntry({
        severity: "error",
        category: TRACKING_START_ERROR_CATEGORY,
        source: "server",
        message,
        context: JSON.stringify({ tag, spent: why, reason }),
      });
    } catch (second) {
      console.error(
        "[BillableTracking] The error log could not record it either:",
        second instanceof Error ? second.message : second
      );
    }
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
  // Moved item 6: a start that could not be queued, nor marked lost, is row 12.
  if (unqueuedTags.has(tag)) {
    return {
      context: null,
      lost: "queue-failed",
      settle: () => unqueuedTags.delete(tag),
    };
  }
  // Moved item 8: a spent entry whose delete failed is no queued start.
  if (spentTags.has(tag)) {
    return {
      context: null,
      lost: null,
      settle: () => retrySpentDelete(deps.store, tag),
    };
  }
  const entry = pending.getPendingStart(tag);
  if (!entry) return { context: null, lost: null, settle: null };
  const parsed = parseContext(entry.contextJson);
  const context = parsed.context;
  const owner = entry.namespace ?? context?.namespace ?? null;
  if (registeredUnder(deps.store, tag, owner)) {
    // Point 2 on moved item 8: spent by the session already registered.
    return {
      context: null,
      lost: null,
      settle: () => pending.deletePendingStart(tag),
    };
  }
  if (entry.lostAt !== null) {
    return { context, lost: asLostCause(entry.lostReason), settle: null };
  }
  const markLost =
    (cause: TrackingLostCause, defect: ContextDefect | null = null) =>
    () => {
      pending.markPendingStartLost(tag, cause, now);
      logLostStart(deps.store, tag, cause, "registration", defect);
      noticeLostStart(
        deps.store,
        tag,
        cause,
        "registration",
        owner ?? namespace
      );
    };
  // Moved item 7: an unreadable context is its own cause, logged once here
  // with its defect, never `hook-failed` (no hook failed).
  if (context === null) {
    return {
      context: null,
      lost: "unreadable",
      settle: markLost("unreadable", parsed.defect),
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
  const project = trackingProjectOf(metadata);
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

  // Review finding A4 (425e04d1): a start that carried no settings lost
  // nothing, so a failure in the hook or the insert registers it as a normal
  // registration would (untracked, its own reason, its entry spent or left as
  // the normal rules say), never with a start-lost row. A context that does
  // not parse still counts as lost here.
  const carried = (): boolean => {
    const f = findPendingStart(deps, input.tag, input.namespace, now);
    if (f.lost !== null) return true;
    return (
      f.context !== null &&
      startHasSettings(deps.store, f.context, input.namespace)
    );
  };
  if (input.failed && carried()) {
    // Review finding M6: the cause is the entry's own, by the rules of a normal
    // registration (an expired or foreign start stays `expired` or
    // `namespace`), and it is logged here: when the insert failed, the first
    // attempt's mark and its error-log row rolled back with it. A start that
    // failed in the hook is `hook-failed`, and the hook failure's own error-log
    // row records it (no second row).
    const found = findPendingStart(deps, input.tag, input.namespace, now);
    const cause: TrackingLostCause = found.lost ?? "hook-failed";
    const entry = deps.store.billableTracking.getPendingStart(input.tag);
    const parsed = entry ? parseContext(entry.contextJson) : null;
    if (entry && entry.lostAt === null) {
      deps.store.billableTracking.markPendingStartLost(input.tag, cause, now);
      noticeLostStart(
        deps.store,
        input.tag,
        cause,
        "registration",
        entry.namespace ?? parsed?.context?.namespace ?? input.namespace
      );
      if (cause !== "hook-failed") {
        logLostStart(
          deps.store,
          input.tag,
          cause,
          "registration",
          parsed?.defect ?? null
        );
      }
    }
    return lostStart(deps, parsed?.context ?? null, meta, cause, now);
  }

  const found = findPendingStart(deps, input.tag, input.namespace, now);
  const context = found.context;
  const kind = context?.kind ?? "unattended";
  const project = trackingProjectOf(meta);

  // The one rule of 4.2: the parent's record is read here, at registration,
  // when the parent is on this node; that read wins over any change made since
  // the request. An agent's parent is the entry node's claim (`inheritedFrom`,
  // recorded only after its caller check, #6778 Task 15).
  const parentId = copiedParentId(context);
  const source =
    found.lost === null
      ? copySource(deps, context, parentId, input.namespace)
      : null;

  const result = resolveTrackingStart({
    mode,
    kind,
    choice: context?.choice,
    tracking: context?.tracking,
    source,
    inheritWaits: inheritStartWaits(context),
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
    // C9 (review A1): every copied parent is a claim; `headerBound` records
    // whether the entry node's caller check ran.
    if (kind === "agent" && context?.inheritedFrom) {
      label.parentSessionId = context.inheritedFrom.sessionId;
      label.parentClaimed = true;
      label.headerBound = context.inheritedFrom.headerBound;
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
 * carried none, or a respawn under the session's own tag (RF-2), is dropped; a
 * lost entry older than seven days is removed.
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
        if (spentTags.has(entry.tag)) {
          // Moved item 8: spent, never lost; delete it now.
          retrySpentDelete(store, entry.tag);
          touched += 1;
          continue;
        }
        const parsed = parseContext(entry.contextJson);
        const context = parsed.context;
        const namespace = entry.namespace ?? context?.namespace ?? null;
        if (
          registeredUnder(store, entry.tag, namespace) ||
          (context !== null &&
            (inheritsFromOwnTag(store, entry.tag, context) ||
              !startHasSettings(store, context, namespace)))
        ) {
          pending.deletePendingStart(entry.tag);
        } else {
          // Moved item 7: an unreadable entry keeps its own cause.
          const cause = context === null ? "unreadable" : "expired";
          pending.markPendingStartLost(entry.tag, cause, now);
          logLostStart(store, entry.tag, cause, "sweep", parsed.defect);
          noticeLostStartIfOwned(
            store,
            entry.tag,
            cause,
            "sweep",
            namespace,
            context
          );
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

/**
 * Issue #6778 (4.2 row 6; C3 = a; Task 15): the parent's history row for an
 * agent's copy that did not reach the child on another node: the target cannot
 * take a tracked start (`tracking-unsupported`), or it accepted the spawn and
 * did not apply the carried copy (`not-applied`). One `tracking` row, reason
 * `copy-not-sent`, both snapshots the parent's unchanged record, written by the
 * hub only after the peer accepted the spawn, so a refused spawn leaves no row;
 * no child tag (the peer mints it). It stores no timer, so it adds no time to
 * the earlier-time figure. The row moves the parent's token, so an open
 * settings form reloads once (review S13). Returns false when the parent has no
 * record any more (nothing is written).
 */
export function recordCopyNotSent(
  store: Store,
  input: {
    namespace: string;
    parentSessionId: string;
    targetNodeId: string;
    reason: "tracking-unsupported" | "not-applied";
    actor: {
      kind: "session" | "client";
      sessionId?: string;
      userAgent?: string;
    };
    via: "tool" | "direct";
    entryNodeId: string | null;
    now: number;
  }
): boolean {
  const kept = store.billableTracking.get(
    input.parentSessionId,
    input.namespace
  );
  if (kept === null) return false;
  const result = store.billableTracking.write({
    namespace: input.namespace,
    sessionId: input.parentSessionId,
    next: prior => prior,
    always: true,
    kind: "tracking",
    reasonFor: () => "copy-not-sent",
    origin: "inheritance",
    event: {
      projectKey: kept.record.projectKey,
      keyKind: kept.record.projectKind,
      actorKind: input.actor.kind,
      actorSessionId: input.actor.sessionId ?? null,
      actorUserAgent: input.actor.userAgent ?? null,
      via: input.via,
      entryNodeId: input.entryNodeId,
      timerMs: null,
      unloggedMs: null,
      loggedKnown: false,
      label: { targetNodeId: input.targetNodeId, reason: input.reason },
      at: input.now,
    },
    now: input.now,
  });
  return result.ok;
}

/**
 * #6778 PRC-R9 (FND-5): what the owning node observed of a start that carried
 * settings or a copy once its spawn succeeded. The session registers before
 * the daemon reports it, so its record is written by then or it never will be.
 * Called only while this node's gate is `on`; the cause only, never a value.
 */
export function observedTrackingStart(
  store: Pick<Store, "billableTracking"> | null,
  sessionId: string,
  namespace: string | undefined
): SpawnTrackingAnswer {
  let failure = "no store or namespace";
  if (store !== null && namespace) {
    try {
      return store.billableTracking.get(sessionId, namespace) === null
        ? { applied: false, cause: "no-record" }
        : { applied: true };
    } catch (err) {
      failure = err instanceof Error ? err.name : "unknown error";
    }
  }
  console.error(
    `[BillableTracking] the record of session ${sessionId} could not be read for its spawn answer (${failure}).`
  );
  return { applied: false, cause: "record-unreadable" };
}
