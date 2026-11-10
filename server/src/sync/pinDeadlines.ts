// SPDX-License-Identifier: AGPL-3.0-only
import {
  isAutoPickEligible,
  type JobFailureEvent,
  type JobRegistry,
  PIN_DEADLINE_LATE_GRACE_MS,
  PIN_DEADLINE_LATE_NOTICE_MS,
  SupervisedLoop,
} from "@hapi/protocol";

import { resolvePinsEnabled } from "../config/pinsConfig";
import type { DueDeadlineCursor } from "../store/pinStore";
import { firePinDeadline, type PinSubmissionEngine } from "./pinSubmission";
import type { SyncEngine } from "./syncEngine";

/**
 * The automatic-pick loop (issue #6452, epic #6446): when an open pin's deadline
 * passes with no answer, fire its named option once (`firePinDeadline`). One
 * `SupervisedLoop` per node, reading only this node's `session_pins` rows, which
 * are always the node's own sessions (a pin is written on the owning node).
 *
 * Cadence: it wakes at the soonest future deadline or backoff, clamped to 1–30 s,
 * and runs immediately on start, so a pick that fell due during a restart is
 * handled on the first tick: fired, or, when over an hour late (ruling D2),
 * rescheduled 15 minutes out. A pin that cannot fire now (inactive session, a
 * refusal, a busy store) waits in memory, a flat minute for an inactive session
 * and a jittered backoff otherwise, so it neither pins the loop at its floor nor
 * stops a later due pin from firing: each tick reads every due row, in pages.
 * A failed attempt never writes to the row: every pin write sends an event that
 * makes open Pins pages refetch.
 */

export const PIN_DEADLINE_JOB = "pin-deadlines";
export const PIN_DEADLINE_INTERVAL_MS = 30_000;
export const PIN_DEADLINE_MIN_DELAY_MS = 1_000;
/** An inactive session's due pick is checked again this often. */
export const PIN_DEADLINE_INACTIVE_RETRY_MS = 60_000;
/**
 * Due rows read per page. Each tick reads every page: a pick that waits in
 * memory (an inactive session) stays due and oldest-first, so a single capped
 * read would let enough of them hide every later pick from the loop.
 */
export const PIN_DEADLINE_PAGE_SIZE = 500;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 300_000;

export type PinDeadlineEngine = PinSubmissionEngine &
  Pick<SyncEngine, "getSession">;

type Backoff = { until: number; attempts: number };

/** What the loop keeps between ticks. In memory: a restart starts clean. */
export type PinDeadlineState = {
  backoff: Map<string, Backoff>;
  /** Pins written before #6452 are armed once, on the first tick. */
  armed: boolean;
};

export function createPinDeadlineState(): PinDeadlineState {
  return { backoff: new Map(), armed: false };
}

export type PinDeadlineDeps = {
  engine: PinDeadlineEngine;
  state: PinDeadlineState;
  now?: () => number;
  /** The zone for the message's time strings: the Time Log zone, else the host's. */
  getTimeZone: () => Promise<string>;
  log?: (message: string, context?: Record<string, unknown>) => void;
  random?: () => number;
  /** Rows per due-deadline page; tests pass a small one. */
  pageSize?: number;
};

export type PinDeadlineTickResult = {
  fired: number;
  waiting: number;
  rescheduled: number;
  cleared: number;
};

/** Every due deadline, read page by page from a keyset cursor until a short page. */
function* dueDeadlines(
  pins: PinDeadlineEngine["pins"],
  now: number,
  pageSize: number
): Generator<{ sessionId: string; key: string; at: number }> {
  let after: DueDeadlineCursor | undefined;
  for (;;) {
    const page = pins.listDueDeadlines(now, pageSize, after);
    yield* page;
    const last = page.at(-1);
    if (page.length < pageSize || !last) return;
    after = { at: last.at, key: last.key, sessionId: last.sessionId };
  }
}

function backoffKey(sessionId: string, key: string, id: string | null): string {
  return `${sessionId}\u0000${key}\u0000${id ?? ""}`;
}

/** One pass over the due deadlines. Never throws for one pin's failure. */
export async function runPinDeadlineTick(
  deps: PinDeadlineDeps
): Promise<PinDeadlineTickResult> {
  const { engine, state } = deps;
  const clock = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const log = deps.log ?? (() => {});
  const result: PinDeadlineTickResult = {
    fired: 0,
    waiting: 0,
    rescheduled: 0,
    cleared: 0,
  };

  const now = clock();
  if (!state.armed) {
    const armed = engine.pins.armMissingDeadlines(now);
    state.armed = true;
    if (armed > 0)
      log("[pins] armed automatic picks written before #6452", { armed });
  }

  const wait = (key: string, until: number, attempts: number) =>
    state.backoff.set(key, { until, attempts });
  const retry = (key: string) => {
    const attempts = (state.backoff.get(key)?.attempts ?? 0) + 1;
    const delay = Math.min(
      BACKOFF_MAX_MS,
      BACKOFF_BASE_MS * 2 ** (attempts - 1)
    );
    wait(key, clock() + delay * (0.8 + random() * 0.4), attempts);
  };

  const seen = new Set<string>();
  let zone: string | null = null;
  const pageSize = Math.max(1, deps.pageSize ?? PIN_DEADLINE_PAGE_SIZE);
  for (const due of dueDeadlines(engine.pins, now, pageSize)) {
    const row = engine.pins.getDeadlineRow(due.sessionId, due.key);
    if (!row) continue;
    const key = backoffKey(due.sessionId, due.key, row.deadline.id);
    seen.add(key);
    const held = state.backoff.get(key);
    if (held && held.until > now) {
      result.waiting++;
      continue;
    }
    const session = engine.getSession(due.sessionId);
    if (!session) continue;
    const ref = { id: session.id, namespace: session.namespace };
    try {
      // Defense in depth: no route writes an ineligible pick, so this is a
      // stored row from somewhere else. Stop it rather than act on it.
      if (!isAutoPickEligible(row.content)) {
        engine.pins.clearDeadline(ref, due.key);
        result.cleared++;
        log("[pins] stopped an automatic pick that fails the rule", {
          sessionId: due.sessionId,
          key: due.key,
        });
        continue;
      }
      if (row.deadline.revision !== row.revision) {
        engine.pins.refreshForeignDeadline(ref, due.key, now);
        result.rescheduled++;
        continue;
      }
      if (session.active !== true) {
        // Wait without writing; the late check runs once the session is back.
        wait(key, now + PIN_DEADLINE_INACTIVE_RETRY_MS, 0);
        result.waiting++;
        continue;
      }
      if (now - due.at > PIN_DEADLINE_LATE_GRACE_MS) {
        // Ruling D2: a pick long overdue (an outage, a session just resumed,
        // Pins switched off) gets a visible fresh deadline instead of firing at once.
        engine.pins.reschedule(ref, due.key, now + PIN_DEADLINE_LATE_NOTICE_MS);
        result.rescheduled++;
        log("[pins] rescheduled a late automatic pick", {
          sessionId: due.sessionId,
          key: due.key,
          lateMs: now - due.at,
        });
        continue;
      }
      zone ??= await deps.getTimeZone();
      const outcome = await firePinDeadline(engine, session, due.key, {
        now: clock(),
        timeZone: zone,
      });
      if (outcome.fired) {
        state.backoff.delete(key);
        result.fired++;
        continue;
      }
      switch (outcome.reason) {
        case "missing":
        case "not_due":
          state.backoff.delete(key);
          break;
        case "ineligible":
          engine.pins.clearDeadline(ref, due.key);
          result.cleared++;
          break;
        case "foreign_revision":
          engine.pins.refreshForeignDeadline(ref, due.key, now);
          result.rescheduled++;
          break;
        case "inactive":
          wait(key, now + PIN_DEADLINE_INACTIVE_RETRY_MS, 0);
          result.waiting++;
          break;
        case "claimed":
        case "changed":
        case "denied":
          retry(key);
          result.waiting++;
          break;
      }
    } catch (error) {
      retry(key);
      result.waiting++;
      log("[pins] automatic pick failed; will retry", {
        sessionId: due.sessionId,
        key: due.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // Forget pins that are no longer due (answered, moved, re-armed).
  for (const key of state.backoff.keys()) {
    if (!seen.has(key)) state.backoff.delete(key);
  }
  return result;
}

/** The delay before the next tick: the soonest future deadline or backoff, clamped. */
export function nextPinDeadlineDelay(
  engine: Pick<PinDeadlineEngine, "pins">,
  state: PinDeadlineState,
  now: number
): number {
  let soonest =
    engine.pins.nextFutureDeadlineAt(now) ?? Number.POSITIVE_INFINITY;
  for (const { until } of state.backoff.values()) {
    soonest = Math.min(soonest, until);
  }
  if (!Number.isFinite(soonest)) return PIN_DEADLINE_INTERVAL_MS;
  return Math.max(
    PIN_DEADLINE_MIN_DELAY_MS,
    Math.min(PIN_DEADLINE_INTERVAL_MS, soonest - now)
  );
}

/** The supervised loop. The caller starts and stops it. Off while Pins is off. */
export function createPinDeadlineLoop(
  deps: Omit<PinDeadlineDeps, "state"> & {
    node: string;
    registry?: JobRegistry;
    enabled?: boolean;
    onEvent?: (event: JobFailureEvent) => void;
    state?: PinDeadlineState;
  }
): SupervisedLoop {
  const state = deps.state ?? createPinDeadlineState();
  const clock = deps.now ?? Date.now;
  return new SupervisedLoop({
    name: PIN_DEADLINE_JOB,
    node: deps.node,
    intervalMs: PIN_DEADLINE_INTERVAL_MS,
    getIntervalMs: () => nextPinDeadlineDelay(deps.engine, state, clock()),
    immediate: true,
    enabled: deps.enabled ?? resolvePinsEnabled(),
    registry: deps.registry,
    onEvent: deps.onEvent,
    tick: async () => {
      await runPinDeadlineTick({ ...deps, state });
    },
  });
}
