// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Timelog + midnight-reset delegate (issue #2080 — extracted from syncEngine.ts).
 *
 * Timezone-aware midnight day-boundary tick. Refs #1119, #1120, #895, #414.
 * Self-contained domain logic: disk I/O via `loadTimeLogConfig`, DB access via
 * `store.midnightResetState`, session enumeration via `SessionCache`, and
 * per-session `timer-reset` SSE events via `EventPublisher`.
 *
 * The periodic timers (startup catch-up, 60s midnight-reset check) remain owned
 * by `SyncEngine` (it holds the interval handles and clears them in `stop()`);
 * their callbacks delegate into this service.
 *
 * Issue #1892 (Sub H2): the legacy 5-min `timelog_entries` flush
 * (`flushTimelogEntries`, `timelogBaselines`) and the `timer_data` reset were
 * removed with the legacy client-timer write path. The lifetime-timer change
 * then removed the `server_accumulated_ms` zero-out and the #895 rebase too
 * (see performMidnightReset): this service now only emits the `timer-reset`
 * day-boundary signal.
 */

import { loadTimeLogConfig } from "../config/timeLogConfig";
import { configuration } from "../configuration";
import type { Store } from "../store";
import type { ErrorLogger } from "../logging/errorLogger";
import type { SessionCache } from "./sessionCache";
import type { EventPublisher } from "./eventPublisher";

/**
 * Compute YYYY-MM-DD for `dateStr + days` IN the given IANA timezone.
 *
 * DST-correct: Date math via epoch milliseconds is wrong across DST
 * spring-forward and fall-back boundaries. This helper anchors at
 * local-noon UTC (always inside the day in any IANA zone), advances
 * by whole-day milliseconds, then reformats in the target zone.
 *
 * Used by:
 *   - getWeeklySummary end-of-week computation (R8)
 *   - deleteEntriesOlderThan cutoff computation (R10)
 *   - catchUpMissedResets per-day iteration (R5)
 *
 * Issue #2080: moved out of `SyncEngine` (was the `static addDaysInTimezone`);
 * `store/timeLog.ts` keeps its own DST-correct mirror of this helper.
 */
export function addDaysInTimezone(
  dateStr: string,
  days: number,
  timezone: string
): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) {
    throw new Error(`addDaysInTimezone: invalid YYYY-MM-DD: ${dateStr}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const noonUtc = Date.UTC(year, month - 1, day, 12, 0, 0);
  const target = new Date(noonUtc + days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(target);
}

export interface TimelogResetServiceDeps {
  store: Store;
  sessionCache: SessionCache;
  eventPublisher: EventPublisher;
  errorLogger?: ErrorLogger | null;
  /**
   * #4613: override the effective-zone source (default: `loadTimeLogConfig`,
   * which is federation-first). Injected in tests so the zone is deterministic
   * and disk-I/O-free — the re-anchor logic (KD2) compares this against the
   * stored `midnight_reset_state.timezone`, so a test must control it exactly.
   */
  resolveTimezone?: (namespace: string) => Promise<string>;
}

export class TimelogResetService {
  private readonly store: Store;
  private readonly sessionCache: SessionCache;
  private readonly eventPublisher: EventPublisher;
  private readonly errorLogger?: ErrorLogger | null;
  private readonly resolveTimezoneOverride?: (
    namespace: string
  ) => Promise<string>;

  /**
   * Issue #1119: Short-lived cache of the resolved namespace timezone.
   * Loaded from settings.json via loadTimeLogConfig — re-read at most every
   * 60s so a settings.json edit takes effect within one tick window without
   * paying disk I/O on every checkMidnightReset call.
   *
   * Per-namespace timezone differentiation is plumbed but currently returns
   * the server-wide value for every namespace (see getTimezoneForNamespace).
   */
  private tzCache: { value: string | null; loadedAt: number } = {
    value: null,
    loadedAt: 0,
  };
  private static readonly TZ_CACHE_TTL_MS = 60_000;

  constructor(deps: TimelogResetServiceDeps) {
    this.store = deps.store;
    this.sessionCache = deps.sessionCache;
    this.eventPublisher = deps.eventPublisher;
    this.errorLogger = deps.errorLogger ?? null;
    this.resolveTimezoneOverride = deps.resolveTimezone;
  }

  /**
   * Get the current date as YYYY-MM-DD in the given IANA timezone.
   * Uses en-CA locale which natively produces ISO date format.
   *
   * Issue #1119: generalises the previous hardcoded America/New_York helper.
   */
  private getDateInTimezone(timezone: string): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  /** Active namespaces from in-memory session cache (de-duplicated). */
  private getActiveNamespaces(): string[] {
    const seen = new Set<string>();
    for (const s of this.sessionCache.getSessions()) {
      if (s.namespace) seen.add(s.namespace);
    }
    return Array.from(seen);
  }

  /**
   * Resolve the IANA timezone for a namespace.
   *
   * Currently returns the server-wide config value for every namespace.
   * Per-namespace differentiation is plumbed (settings.json key
   * `timeLogPreferences.timezone`) but not yet exposed per-namespace —
   * if a future deployment needs two namespaces with different zones,
   * extend `loadTimeLogConfig` to accept a namespace parameter.
   *
   * Cached for ~60s to avoid disk I/O on every 60s tick.
   */
  private async getTimezoneForNamespace(namespace: string): Promise<string> {
    const now = Date.now();
    if (
      this.tzCache.value &&
      now - this.tzCache.loadedAt < TimelogResetService.TZ_CACHE_TTL_MS
    ) {
      return this.tzCache.value;
    }
    // #4613: the source is federation-first via loadTimeLogConfig (so the reset
    // adopts the federation zone automatically), or an injected override in tests.
    const tz = this.resolveTimezoneOverride
      ? await this.resolveTimezoneOverride(namespace)
      : (await loadTimeLogConfig(configuration.dataDir)).timezone;
    this.tzCache = { value: tz, loadedAt: now };
    return tz;
  }

  /**
   * Called every 60s. For each active namespace, compares its current
   * local date (in its timezone) to the last-reset date stored in the
   * `midnight_reset_state` table. Fires `performMidnightReset` for each
   * namespace that crossed midnight.
   *
   * Issue #1119: replaces the single-global `lastResetDate` field with
   * per-namespace persisted state.
   */
  async checkMidnightReset(): Promise<void> {
    for (const namespace of this.getActiveNamespaces()) {
      try {
        const timezone = await this.getTimezoneForNamespace(namespace);
        const currentDate = this.getDateInTimezone(timezone);
        const state = this.store.midnightResetState.get(namespace);

        if (!state) {
          // First sighting — initialize without firing a reset.
          this.store.midnightResetState.upsert(
            namespace,
            timezone,
            currentDate,
            Date.now()
          );
          continue;
        }

        // #4613 (KD2): a zone change (e.g. the federation `timeLogTimezone` was
        // set or changed, so getTimezoneForNamespace now returns a different zone)
        // is a RE-ANCHOR, not a missed midnight. Adopt the new zone and set
        // lastResetDate to today-in-the-new-zone WITHOUT firing; normal same-zone
        // ticking then resumes and the next real midnight in the new zone fires
        // exactly once (no double/early fire). This ALSO fixes the pre-#4613
        // adoption lag: the stored `timezone` used to be rewritten ONLY inside the
        // fire branch below, so a same-calendar-day zone change never took effect
        // on the derived read path until a date actually rolled.
        if (state.timezone !== timezone) {
          this.errorLogger?.info(
            `Time-log zone changed for namespace ${namespace}: ` +
              `${state.timezone} → ${timezone}; re-anchoring to ${currentDate} without firing`,
            { category: "sync" }
          );
          this.store.midnightResetState.upsert(
            namespace,
            timezone,
            currentDate,
            Date.now()
          );
          continue;
        }

        if (currentDate === state.lastResetDate) continue;
        if (currentDate < state.lastResetDate) {
          // Clock skew guard (preserved from the pre-#1119 code).
          continue;
        }

        const dateToReset = state.lastResetDate;
        // Persist the new date BEFORE firing the tick so that a crash
        // mid-tick doesn't cause the namespace to be ticked again on
        // restart. The tick itself is idempotent (re-emitting the SSE
        // signal is harmless) but avoiding duplicate emission to clients
        // is preferable.
        this.store.midnightResetState.upsert(
          namespace,
          timezone,
          currentDate,
          Date.now()
        );

        // Fire-and-forget — performMidnightReset is async but the interval
        // callback is sync. Errors are caught inside per-session.
        void this.performMidnightReset(namespace, dateToReset);
      } catch (err) {
        this.errorLogger?.error(
          `Midnight reset tick failed for namespace ${namespace}`,
          {
            category: "sync",
            context: {
              error: err instanceof Error ? err.message : String(err),
            },
          }
        );
      }
    }
  }

  /**
   * Catch-up: on startup, for each namespace persisted in
   * `midnight_reset_state`, fire one `performMidnightReset` per missed
   * date in chronological order. DST-correct iteration via
   * `addDaysInTimezone`.
   *
   * If the server was off across multiple midnights, each missed date
   * gets its own SSE-emit cycle so clients refresh their daily-scoped
   * time-log views once per missed boundary.
   *
   * Issue #1119 R5.
   */
  async catchUpMissedResets(): Promise<void> {
    try {
      const states = this.store.midnightResetState.getAll();
      for (const state of states) {
        try {
          // #4613 (KD2): if the effective zone changed since this row was written
          // (e.g. the federation `timeLogTimezone` was set/changed while the server
          // was down), RE-ANCHOR to today-in-the-new-zone WITHOUT replaying a
          // phantom gap — a missed-midnight catch-up only makes sense WITHIN a
          // stable zone. Mirrors checkMidnightReset's re-anchor so the switch-over
          // fires exactly once regardless of whether it crosses a restart.
          const effectiveZone = await this.getTimezoneForNamespace(
            state.namespace
          );
          if (effectiveZone !== state.timezone) {
            const todayInEffective = this.getDateInTimezone(effectiveZone);
            this.errorLogger?.info(
              `Catch-up: time-log zone changed for namespace ${state.namespace}: ` +
                `${state.timezone} → ${effectiveZone}; re-anchoring to ` +
                `${todayInEffective} without replay`,
              { category: "sync" }
            );
            this.store.midnightResetState.upsert(
              state.namespace,
              effectiveZone,
              todayInEffective,
              Date.now()
            );
            continue;
          }

          const timezone = state.timezone;
          const today = this.getDateInTimezone(timezone);
          if (today <= state.lastResetDate) continue;

          // Iterate by string-comparison from lastResetDate forward,
          // advancing one day at a time IN the namespace's timezone.
          // Cap at 30 missed days as a defensive bound.
          const MAX_CATCHUP_DAYS = 30;
          let cursor = state.lastResetDate;
          let count = 0;
          while (cursor < today && count < MAX_CATCHUP_DAYS) {
            const dateToReset = cursor;
            const next = addDaysInTimezone(cursor, 1, timezone);

            this.errorLogger?.info(
              `Catch-up midnight reset for namespace ${state.namespace}: ` +
                `closing ${dateToReset}, advancing to ${next}`,
              { category: "sync" }
            );

            // Persist BEFORE firing so a crash mid-iteration resumes
            // correctly on next boot.
            this.store.midnightResetState.upsert(
              state.namespace,
              timezone,
              next,
              Date.now()
            );

            await this.performMidnightReset(state.namespace, dateToReset);

            cursor = next;
            count++;
          }

          if (count >= MAX_CATCHUP_DAYS && cursor < today) {
            this.errorLogger?.warn(
              `Catch-up reset capped at ${MAX_CATCHUP_DAYS} days for ` +
                `namespace ${state.namespace}; advancing state to today ` +
                `without firing further resets`,
              { category: "sync" }
            );
            this.store.midnightResetState.upsert(
              state.namespace,
              timezone,
              today,
              Date.now()
            );
          }
        } catch (err) {
          this.errorLogger?.error(
            `Catch-up reset failed for namespace ${state.namespace}`,
            {
              category: "sync",
              context: {
                error: err instanceof Error ? err.message : String(err),
              },
            }
          );
        }
      }
    } catch (err) {
      this.errorLogger?.error(`Catch-up reset top-level error`, {
        category: "sync",
        context: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  /**
   * Midnight day-boundary tick for a single namespace: emit the per-session
   * `timer-reset` SSE signal so connected clients refresh their daily-scoped
   * time-log views (modal / charts / CSV) at 0:00.
   *
   * `server_accumulated_ms` is intentionally NOT touched — it is a LIFETIME
   * counter (total thinking time across the session's whole life), and the
   * session-list / project / cumulative timers display it as such.
   *
   * History of the (now-removed) daily zero-out:
   *   - #1119 added it as the load-bearing fix for the legacy client timer:
   *     the client's `Math.max(localMs, serverMs)` re-logged the still-
   *     monotonic server value every midnight, so the server value had to
   *     reset daily.
   *   - #1892 (Sub H2) deleted that client timer and its Math.max write
   *     path; daily attribution moved wholly to the turns-derived ledger.
   *     The zero-out's only remaining effect was making the displayed
   *     timers read as daily counters.
   *   - The lifetime-timer change removed the zero-out and the #895
   *     `thinkingStartedAt` rebase that only existed to survive it — an
   *     in-flight thinking segment simply continues across midnight when
   *     the base is never zeroed.
   */
  private async performMidnightReset(
    namespace: string,
    resetDate: string
  ): Promise<void> {
    this.errorLogger?.info(
      `Performing midnight day-boundary tick: namespace=${namespace}, date=${resetDate}`,
      { category: "sync" }
    );

    // Issue #1120: one resetEpoch is stamped on every emitted event so
    // clients can correlate all of a namespace's signals to one boundary.
    const resetEpoch = Date.now();

    let signalCount = 0;
    const sessionsInNs = this.sessionCache.getSessionsByNamespace(namespace);

    for (const session of sessionsInNs) {
      try {
        // Emit the per-session timer-reset SSE event. Carries sessionId
        // from SessionChangedSchema so the federation event bridge's
        // interestingSessions filter applies cleanly. Clients use it to
        // refresh daily-scoped time-log views only — the session-list
        // timers read the untouched lifetime serverAccumulatedMs.
        this.eventPublisher.emit({
          type: "timer-reset",
          sessionId: session.id,
          namespace,
          data: {
            resetEpoch,
            resetDate,
            namespace,
          },
        });
        signalCount++;
      } catch (err) {
        this.errorLogger?.error(
          `Midnight tick failed for session ${session.id}`,
          {
            category: "sync",
            sessionId: session.id,
            context: {
              error: err instanceof Error ? err.message : String(err),
            },
          }
        );
      }
    }

    this.errorLogger?.info(
      `Midnight day-boundary tick complete: namespace=${namespace}, date=${resetDate}, ` +
        `${signalCount} signal(s) emitted`,
      { category: "sync" }
    );
  }
}
