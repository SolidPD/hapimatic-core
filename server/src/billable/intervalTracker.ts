// SPDX-License-Identifier: AGPL-3.0-only
import type { Session } from "@hapi/protocol/types";
import type { ErrorLogger } from "../logging/errorLogger";
import type {
  CloseIntervalInput,
  OpenIntervalRow,
} from "../store/billable/intervalStore";
import { newUuidV7 } from "../store/turns/ids";
import type { BillableMode } from "./mode";
import {
  type BillableEndCause,
  type BillableStartCause,
  endCauseFor,
  isBillable,
} from "./predicate";

/**
 * The billable-interval tracker (issue #6586): a state machine over the hub's own
 * observations of each session (keepAlives, store writes, attaches, ends) that
 * opens and closes thinking intervals through the write service.
 *
 * Per-session state lives in the tracker's OWN map, never on the `Session` record,
 * and no `Session` reference is kept (`refreshSession` replaces the record on
 * every store write). Every time is the hub clock, passed in by the session cache;
 * the tracker never calls `Date.now()` and never compares a CLI time with it.
 *
 * The waiting rule (R5): a pending request (an `agentState.requests` key) pauses
 * billing unless the tracker has marked it as a leftover, at one of two moments:
 * (1) a keepAlive that reports no turn marks every request still pending; (2) a
 * process attach (`noteProcessStart`) marks every request the session holds. An
 * expiry and a session end add no mark, because the hub cannot tell a dead
 * process from one it cannot reach, and a CLI that was only quiet is still
 * waiting on the same request (fixture P4: 38,000 ms where a mark at the hub's end
 * would bill 3,638,000 ms; fixture P8: 54,000 ms where a mark at the CLI's own end
 * would bill 602,000 ms). A new tracker starts with empty sets, so after a hub
 * restart every pending request is live until a mark applies.
 *
 * The rule assumes one live process per session (ruling TP-1): the tracker counts
 * each attach that finds a thinking session whose last heartbeat is under 4,000 ms
 * old, and acts on nothing it counts.
 *
 * Modes: `on` drives (closes recompute the stored timer); `shadow` records beside
 * today's timer (the session cache ignores the return values); `off` is inert.
 * Every public method is exception-safe and returns what `off` returns on a throw,
 * because a throw on a socket listener exits the server.
 */

const CATEGORY = "billable-intervals";
const ROLLOVER_MS = 86_400_000;
const TOUCH_EVERY_MS = 13_000;
/** Two heartbeat periods of 2,000 ms (`cli/src/agent/sessionBase.ts`). */
const LIVE_ATTACH_MS = 4_000;

/** The session fields the tracker reads; it copies them and keeps no reference. */
export type TrackedSession = Pick<
  Session,
  | "id"
  | "namespace"
  | "thinking"
  | "blockedOnTuiPrompt"
  | "agentState"
  | "rateLimited"
  | "metadata"
  | "linkedIssue"
> & { thinkingStartedAt?: number | null };

/** The write-service methods the tracker calls (structural, for a recording fake). */
export interface TrackerWriteService {
  enqueueOpen(row: OpenIntervalRow, options: { recomputeTimer: boolean }): void;
  enqueueClose(input: CloseIntervalInput): void;
  enqueueTouch(id: string, ms: number): void;
  flush(): void;
}

export type TrackerLogger = Pick<ErrorLogger, "error" | "warn">;

export interface StretchSnapshot {
  stretchStartedAtMs: number;
  endedAtMs: number;
  intervalsMs: number;
  waitMs: number;
  gapMs: number;
  /** The stretch was ended by a process attach, so the old clock's runs on. */
  endedByAttach: boolean;
}

export interface StretchMeasurements {
  intervalsMs: number;
  waitMs: number;
  trimMs: number;
}

interface Entry {
  observedThinking: boolean;
  stretchStartedAtMs: number;
  staleRequestIds: Set<string>;
  lastRequestIds: string[];
  openId: string | null;
  startedAtMs: number | null;
  startCause: BillableStartCause | null;
  openRow: OpenIntervalRow | null;
  lastObservedAtMs: number;
  lastTouchPersistedAtMs: number;
  nextStartCause: BillableStartCause;
  expiredWhileThinking: boolean;
  namespace: string;
  stretchIntervalsMs: number;
  stretchWaitMs: number;
  stretchGapMs: number;
  waitSinceMs: number | null;
  lastStretch: StretchSnapshot | null;
}

const ZERO: StretchMeasurements = { intervalsMs: 0, waitMs: 0, trimMs: 0 };

function requestIds(session: TrackedSession): string[] {
  const requests = session.agentState?.requests;
  return requests ? Object.keys(requests) : [];
}

export class BillableIntervalTracker {
  private readonly entries = new Map<string, Entry>();
  /** Ids marked at an attach for a session that has no entry yet. */
  private readonly pendingStale = new Map<string, Set<string>>();
  private liveAttaches = 0;
  private readonly newId: () => string;

  constructor(
    private readonly writeService: TrackerWriteService,
    readonly nodeId: string,
    readonly mode: BillableMode,
    private readonly errorLogger: TrackerLogger | null | undefined,
    options?: { newId?: () => string }
  ) {
    this.newId = options?.newId ?? newUuidV7;
  }

  /**
   * Observe a session: `"alive"` after every keepAlive, `"refresh"` from every
   * `refreshSession`. Returns the durations this call closed and whether it opened
   * or closed an interval.
   */
  observe(
    session: TrackedSession,
    nowMs: number,
    source: "alive" | "refresh"
  ): { closedMs: number; changed: boolean } {
    const none = { closedMs: 0, changed: false };
    if (this.mode === "off") return none;
    try {
      let entry = this.entries.get(session.id);
      // A store write is not a heartbeat: a refresh creates no entry.
      if (entry === undefined && source === "refresh") return none;
      let created = false;
      if (entry === undefined) {
        entry = this.newEntry(session, nowMs);
        this.entries.set(session.id, entry);
        created = true;
      }
      if (source === "alive") {
        entry.lastObservedAtMs = nowMs;
        entry.namespace = session.namespace;
      }

      // Stale requests: track the current ids; mark 1 on a no-turn keepAlive.
      const current = requestIds(session);
      entry.lastRequestIds = current;
      const currentSet = new Set(current);
      for (const id of entry.staleRequestIds) {
        if (!currentSet.has(id)) entry.staleRequestIds.delete(id);
      }
      if (source === "alive" && !session.thinking) {
        for (const id of entry.lastRequestIds) entry.staleRequestIds.add(id);
      }

      const wasThinking = entry.observedThinking;
      const stretchBegins =
        source === "alive" && !wasThinking && session.thinking;
      const stretchEnds =
        source === "alive" && wasThinking && !session.thinking;
      let continued = false;
      if (stretchBegins) {
        continued = this.beginStretch(entry, session, nowMs, created);
      }
      if (source === "alive") {
        entry.observedThinking = session.thinking;
        entry.expiredWhileThinking = false;
      }

      const billable = isBillable({
        thinking: entry.observedThinking,
        blockedOnTuiPrompt: session.blockedOnTuiPrompt,
        agentState: session.agentState,
        staleRequestIds: entry.staleRequestIds,
      });
      if (stretchBegins && !billable) {
        // A stretch whose first evaluation is not billable is a wait from its
        // start; a continued stretch already counted the time before the attach.
        entry.waitSinceMs = continued ? nowMs : entry.stretchStartedAtMs;
      }

      let closedMs = 0;
      let changed = false;
      if (entry.openId !== null && !billable) {
        // (a) the open interval stopped being billable.
        const cause = endCauseFor({
          thinking: entry.observedThinking,
          rateLimited: session.rateLimited,
        });
        const closed = this.closeOpen(session.id, entry, nowMs, cause);
        closedMs += closed.durationMs;
        changed = true;
        if (cause === "waiting_on_person") entry.waitSinceMs = closed.endMs;
      } else if (
        entry.openId !== null &&
        source === "alive" &&
        entry.startedAtMs !== null &&
        nowMs - entry.startedAtMs >= ROLLOVER_MS
      ) {
        // (b) no row exceeds 24 h: roll over within the same stretch.
        const closed = this.closeOpen(session.id, entry, nowMs, "rollover");
        closedMs += closed.durationMs;
        this.openInterval(entry, session, nowMs, "rollover");
        changed = true;
      } else if (
        entry.openId !== null &&
        source === "alive" &&
        nowMs - entry.lastTouchPersistedAtMs >= TOUCH_EVERY_MS
      ) {
        // (c) persist the last heartbeat at least every 15 s (every 14 s at 2 s).
        this.writeService.enqueueTouch(entry.openId, entry.lastObservedAtMs);
        entry.lastTouchPersistedAtMs = nowMs;
      } else if (entry.openId === null && billable) {
        // (d) billable again: open, ending any running wait.
        if (entry.waitSinceMs !== null) {
          entry.stretchWaitMs += Math.max(0, nowMs - entry.waitSinceMs);
          entry.waitSinceMs = null;
        }
        this.openInterval(entry, session, nowMs, entry.nextStartCause);
        entry.nextStartCause = "resumed_after_person";
        changed = true;
      }

      if (stretchEnds) this.endStretch(entry, nowMs, false);
      return { closedMs, changed };
    } catch (error) {
      this.safeLog("observe failed", session?.id ?? null, error);
      return none;
    }
  }

  /**
   * A CLI process attached to the session (`SessionCache.getOrCreateSession`).
   * Marks every request the session holds (mark 2), closes what the previous
   * process left open at its last heartbeat (`superseded`), and ends a running
   * stretch. `nowMs` is read only by the live-attach count.
   */
  noteProcessStart(
    session: TrackedSession,
    nowMs: number
  ): { durationMs: number } | null {
    if (this.mode === "off") return null;
    try {
      const ids = requestIds(session);
      const entry = this.entries.get(session.id);
      if (entry === undefined) {
        // The mark must also hold for the first process after a hub restart.
        const pending = this.pendingStale.get(session.id) ?? new Set<string>();
        for (const id of ids) pending.add(id);
        this.pendingStale.set(session.id, pending);
        return null;
      }

      const ageMs = nowMs - entry.lastObservedAtMs;
      if (entry.observedThinking && ageMs < LIVE_ATTACH_MS) {
        // Ruling TP-1: count, and change nothing because of the count.
        this.liveAttaches++;
        this.safeWarn(
          "process attached to a thinking session with a recent heartbeat (two processes?)",
          session.id,
          { heartbeatAgeMs: ageMs }
        );
      }

      for (const id of ids) entry.staleRequestIds.add(id);
      let result: { durationMs: number } | null = null;
      let closedEndMs: number | null = null;
      if (entry.openId !== null) {
        const closed = this.closeOpen(
          session.id,
          entry,
          entry.lastObservedAtMs,
          "superseded"
        );
        result = { durationMs: closed.durationMs };
        closedEndMs = closed.endMs;
      }
      if (entry.observedThinking) {
        this.endStretch(
          entry,
          this.latestEnd(entry, entry.lastObservedAtMs, closedEndMs),
          true
        );
      }
      entry.observedThinking = false;
      entry.expiredWhileThinking = false;
      return result;
    } catch (error) {
      this.safeLog("noteProcessStart failed", session?.id ?? null, error);
      return null;
    }
  }

  /** The heartbeat was lost: close at the last heartbeat, never at sweep time. */
  closeOnExpiry(sessionId: string): { durationMs: number } | null {
    if (this.mode === "off") return null;
    try {
      const entry = this.entries.get(sessionId);
      if (entry === undefined) return null;
      const result = this.closeAndEnd(
        sessionId,
        entry,
        entry.lastObservedAtMs,
        "expired"
      );
      entry.expiredWhileThinking = entry.observedThinking;
      entry.observedThinking = false;
      return result;
    } catch (error) {
      this.safeLog("closeOnExpiry failed", sessionId, error);
      return null;
    }
  }

  /**
   * A session end: the CLI's own event is a recorded activity (closes at `nowMs`);
   * a hub-originated end follows a quiet CLI (closes at the last heartbeat).
   */
  closeOnSessionEnd(
    sessionId: string,
    nowMs: number,
    options: { hubOriginated: boolean }
  ): { durationMs: number } | null {
    if (this.mode === "off") return null;
    try {
      const entry = this.entries.get(sessionId);
      if (entry === undefined) return null;
      const result = this.closeAndEnd(
        sessionId,
        entry,
        options.hubOriginated ? entry.lastObservedAtMs : nowMs,
        "session_end"
      );
      entry.observedThinking = false;
      entry.expiredWhileThinking = false;
      return result;
    } catch (error) {
      this.safeLog("closeOnSessionEnd failed", sessionId, error);
      return null;
    }
  }

  /** The session was removed: close at the last heartbeat and forget it. */
  closeOnRemoval(sessionId: string): { durationMs: number } | null {
    if (this.mode === "off") return null;
    try {
      const entry = this.entries.get(sessionId);
      let result: { durationMs: number } | null = null;
      if (entry !== undefined && entry.openId !== null) {
        const closed = this.closeOpen(
          sessionId,
          entry,
          entry.lastObservedAtMs,
          "session_deleted"
        );
        result = { durationMs: closed.durationMs };
      }
      this.entries.delete(sessionId);
      this.pendingStale.delete(sessionId);
      return result;
    } catch (error) {
      this.safeLog("closeOnRemoval failed", sessionId, error);
      return null;
    }
  }

  /** Graceful shutdown: close every open interval at its last heartbeat, then flush. */
  shutdown(): void {
    if (this.mode === "off") return;
    try {
      for (const [sessionId, entry] of this.entries) {
        if (entry.openId !== null) {
          this.closeOpen(
            sessionId,
            entry,
            entry.lastObservedAtMs,
            "hub_shutdown"
          );
        }
      }
    } catch (error) {
      this.safeLog("shutdown close failed", null, error);
    }
    try {
      this.writeService.flush();
    } catch (error) {
      this.safeLog("shutdown flush failed", null, error);
    }
  }

  /** The start of the open interval, for `thinkingStartedAt` in `on`. */
  openStartMs(sessionId: string): number | null {
    try {
      const entry = this.entries.get(sessionId);
      return entry?.openId != null ? entry.startedAtMs : null;
    } catch {
      return null;
    }
  }

  /**
   * "Thinking since" for the stall watchdog (#6471): the stretch start while the
   * session is observed thinking. Not a billing input.
   */
  thinkingSinceMs(sessionId: string): number | null {
    try {
      const entry = this.entries.get(sessionId);
      return entry?.observedThinking ? entry.stretchStartedAtMs : null;
    } catch {
      return null;
    }
  }

  /**
   * The tracker's three measurements of the stretch the old clock just closed
   * (`shadow`). `trimMs` is the time between the tracker's end and the old clock's,
   * plus the gap an attach left inside the stretch. Three zeros when nothing
   * matches, so the daily check lists the whole old-clock figure.
   */
  stretchMeasurements(
    sessionId: string,
    query: { stretchStartedAtMs: number; legacyEndedAtMs: number }
  ): StretchMeasurements {
    if (this.mode !== "shadow") return ZERO;
    try {
      const last = this.entries.get(sessionId)?.lastStretch;
      if (!last || last.stretchStartedAtMs !== query.stretchStartedAtMs) {
        return ZERO;
      }
      return {
        intervalsMs: last.intervalsMs,
        waitMs: last.waitMs,
        trimMs:
          Math.max(0, query.legacyEndedAtMs - last.endedAtMs) + last.gapMs,
      };
    } catch {
      return ZERO;
    }
  }

  /** Attaches since this tracker was built that found a live heartbeat (ruling TP-1). */
  liveAttachCount(): number {
    return this.liveAttaches;
  }

  // ───────────── internals ─────────────

  private newEntry(session: TrackedSession, nowMs: number): Entry {
    const pending = this.pendingStale.get(session.id);
    this.pendingStale.delete(session.id);
    return {
      observedThinking: false,
      stretchStartedAtMs: nowMs,
      staleRequestIds: new Set(pending ?? []),
      lastRequestIds: [],
      openId: null,
      startedAtMs: null,
      startCause: null,
      openRow: null,
      lastObservedAtMs: nowMs,
      lastTouchPersistedAtMs: nowMs,
      nextStartCause: "thinking_started",
      expiredWhileThinking: false,
      namespace: session.namespace,
      stretchIntervalsMs: 0,
      stretchWaitMs: 0,
      stretchGapMs: 0,
      waitSinceMs: null,
      lastStretch: null,
    };
  }

  /** Start a stretch; returns true when it continues the stretch an attach ended. */
  private beginStretch(
    entry: Entry,
    session: TrackedSession,
    nowMs: number,
    created: boolean
  ): boolean {
    entry.stretchStartedAtMs =
      this.mode === "shadow" ? (session.thinkingStartedAt ?? nowMs) : nowMs;
    entry.nextStartCause =
      created || entry.expiredWhileThinking
        ? "reconnected"
        : "thinking_started";
    const last = entry.lastStretch;
    if (
      this.mode === "shadow" &&
      last !== null &&
      last.endedByAttach &&
      last.stretchStartedAtMs === entry.stretchStartedAtMs
    ) {
      // The old clock's stretch ran on across the attach: carry its measurements
      // and count the time from the attach's end to now as gap.
      entry.stretchIntervalsMs = last.intervalsMs;
      entry.stretchWaitMs = last.waitMs;
      entry.stretchGapMs = last.gapMs + Math.max(0, nowMs - last.endedAtMs);
      entry.waitSinceMs = null;
      return true;
    }
    entry.stretchIntervalsMs = 0;
    entry.stretchWaitMs = 0;
    entry.stretchGapMs = 0;
    entry.waitSinceMs = null;
    return false;
  }

  /** The latest of a method's end, the end its close stored, and a running wait. */
  private latestEnd(
    entry: Entry,
    methodEndMs: number,
    closedEndMs: number | null
  ): number {
    let end = methodEndMs;
    if (closedEndMs !== null && closedEndMs > end) end = closedEndMs;
    if (entry.waitSinceMs !== null && entry.waitSinceMs > end)
      end = entry.waitSinceMs;
    return end;
  }

  private endStretch(entry: Entry, endMs: number, byAttach: boolean): void {
    if (entry.waitSinceMs !== null) {
      entry.stretchWaitMs += Math.max(0, endMs - entry.waitSinceMs);
      entry.waitSinceMs = null;
    }
    entry.lastStretch = {
      stretchStartedAtMs: entry.stretchStartedAtMs,
      endedAtMs: endMs,
      intervalsMs: entry.stretchIntervalsMs,
      waitMs: entry.stretchWaitMs,
      gapMs: entry.stretchGapMs,
      endedByAttach: byAttach,
    };
  }

  /** Close the open interval (if any) at `wantedEndMs`, and end a running stretch. */
  private closeAndEnd(
    sessionId: string,
    entry: Entry,
    wantedEndMs: number,
    cause: BillableEndCause
  ): { durationMs: number } | null {
    let result: { durationMs: number } | null = null;
    let closedEndMs: number | null = null;
    if (entry.openId !== null) {
      const closed = this.closeOpen(sessionId, entry, wantedEndMs, cause);
      result = { durationMs: closed.durationMs };
      closedEndMs = closed.endMs;
    }
    if (entry.observedThinking) {
      this.endStretch(
        entry,
        this.latestEnd(entry, wantedEndMs, closedEndMs),
        false
      );
    }
    return result;
  }

  private openInterval(
    entry: Entry,
    session: TrackedSession,
    nowMs: number,
    startCause: BillableStartCause
  ): void {
    const linked = session.linkedIssue;
    const row: OpenIntervalRow = {
      id: this.newId(),
      hapi_session_id: session.id,
      namespace: session.namespace,
      node_id: this.nodeId,
      launcher_kind: session.metadata?.launcherKind ?? "unknown",
      recorded_mode: this.mode,
      stretch_started_at_ms: entry.stretchStartedAtMs,
      started_at_ms: nowMs,
      last_seen_at_ms: nowMs,
      start_cause: startCause,
      session_name: session.metadata?.name ?? null,
      linked_issue: linked ? `${linked.repo}#${linked.number}` : null,
      cwd: session.metadata?.path ?? null,
    };
    entry.openId = row.id;
    entry.startedAtMs = nowMs;
    entry.startCause = startCause;
    entry.openRow = row;
    entry.lastTouchPersistedAtMs = nowMs;
    this.writeService.enqueueOpen(row, { recomputeTimer: this.mode === "on" });
  }

  private closeOpen(
    sessionId: string,
    entry: Entry,
    wantedEndMs: number,
    cause: BillableEndCause
  ): { durationMs: number; endMs: number } {
    const startedAtMs = entry.startedAtMs ?? wantedEndMs;
    const endMs = Math.max(wantedEndMs, startedAtMs);
    const durationMs = endMs - startedAtMs;
    const openRow = entry.openRow;
    entry.openId = null;
    entry.startedAtMs = null;
    entry.startCause = null;
    entry.openRow = null;
    entry.stretchIntervalsMs += durationMs;
    if (openRow !== null) {
      this.writeService.enqueueClose({
        ...openRow,
        sessionId,
        endedAtMs: endMs,
        endCause: cause,
        recomputeTimer: this.mode === "on",
      });
    }
    return { durationMs, endMs };
  }

  private safeLog(
    message: string,
    sessionId: string | null,
    error: unknown
  ): void {
    try {
      this.errorLogger?.error(`billable tracker: ${message}`, {
        category: CATEGORY,
        sessionId,
        persist: false,
        context: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } catch {
      // The tracker must never throw.
    }
  }

  private safeWarn(
    message: string,
    sessionId: string,
    context: Record<string, unknown>
  ): void {
    try {
      this.errorLogger?.warn(`billable tracker: ${message}`, {
        category: CATEGORY,
        sessionId,
        context: { sessionId, ...context },
      });
    } catch {
      // The tracker must never throw.
    }
  }
}
