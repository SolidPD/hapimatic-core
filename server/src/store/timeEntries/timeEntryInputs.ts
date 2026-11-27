// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6204 (plan 3.3, 7; Task 5): what `TimeEntryStore`'s writers and
 * readers take and answer. Types only. Every date in them comes from the
 * caller (the Project Manager's ruling A): `dates.ts` (Task 9) makes them.
 */
import type {
  TimeEntry,
  TimeEntryCutSource,
  TimeEntryDecisionResult,
  TimeEntryExcludePreview,
  TimeEntryExclusionVia,
  TimeEntryRemovedVia,
  TimeEntrySource,
  TrackingBillingStatus,
  TrackingRecord,
} from "@hapi/protocol";
import type { IntervalRow, NewCoverage } from "../../timeEntries/amount";
import type { ControlChoice } from "./exclusionSpans";
import type { FiguresBlock } from "./timeEntryFigures";
import type { TrackedPeriod } from "../../timeEntries/periods";
import type { MeasuredTurn, TimeEntryActor } from "./timeEntryRows";

/**
 * One session's measured time at a cut, as PR-2's readers (`measured.ts`)
 * build it. `logMeasured`, `figuresFor` and `previewExclude` all take it
 * (ruling R6), so the three answer the same figure.
 */
export type MeasuredSession = {
  namespace: string;
  sessionId: string;
  originNodeId: string;
  periods: readonly TrackedPeriod[];
  /** The rows of D (4.2); a row that closed after the cut waits. */
  intervals: readonly IntervalRow[];
  cutMs: number;
  counter: {
    epoch: number;
    launcherKind: string | null;
    /** The readings the counter time lies between (`read_from_at`, `read_to_at`). */
    readFromAt: number | null;
    readToAt: number | null;
    /** D at the session's baseline moment: 0 off an `on` node (4.2, item 5). */
    dAtBaselineMs: number;
  };
  sessionName: string | null;
  repoKey: string | null;
  turns: readonly MeasuredTurn[];
};

export type LogMeasuredInput = MeasuredSession & {
  /** This node: a write needs a baseline row of the origin naming it (5.1). */
  ownerNodeId: string;
  source: Extract<TimeEntrySource, "midnight" | "log-now">;
  /** The dating of 5.2, decided by the run (the caller). */
  night: string | null;
  workDate: string;
  late: boolean;
  zone: string;
  actor?: TimeEntryActor;
  now: number;
};

export type LogMeasuredResult =
  | {
      blocked: null;
      entries: TimeEntry[];
      newMs: number;
      carryOutMs: number;
    }
  | { blocked: "no_baseline"; entries: []; newMs: 0; carryOutMs: number };

/** Who decided, how, and the date a change to Billable releases on (7.1). */
export type DecisionInput = {
  namespace: string;
  entryIds: readonly string[];
  /** Each entry's `lastEventId`, the token. */
  expect: Readonly<Record<string, number>>;
  status?: TrackingBillingStatus;
  project?: { kind: string; key: string; name: string };
  /** #6782 defines it; `undefined` leaves it as it is. */
  external?: unknown;
  /** From `dates.ts` (Task 9): the store computes no date (ruling A). */
  releaseDate: string;
  zone: string;
  note: string;
  actor: TimeEntryActor;
  via: string;
  now: number;
};

export type HoldResult =
  | "applied"
  | "lapsed"
  | "unchanged"
  | "voided"
  | "not_found";

export type HoldReleaseInput = {
  namespace: string;
  sessionId: string;
  entryIds: readonly string[];
  outcome: "kept" | "reversed";
  /** The history row of the Keep or the Reverse: its id, actor and time. */
  source: { eventId: number; actor: TimeEntryActor; at: number };
  /** The day the record applies it (OC-7), from `dates.ts`. */
  releaseDate: string;
  zone: string;
  now: number;
};

export type HoldLapseInput = {
  namespace: string;
  sessionId: string;
  entryIds: readonly string[];
  now: number;
};

export type CompleteInput = {
  namespace: string;
  entryId: string;
  expect: number;
  /** Validated by the caller under the Create page's rules (7.5). */
  category: {
    source: string;
    id: string;
    name: string;
    defaultRateMinor: number | null;
    defaultCurrency: string | null;
  };
  rateMinor: number;
  currency: string;
  rateNote: string | null;
  actor: TimeEntryActor;
  via: string;
  now: number;
};

export type WriteAnswer = {
  result: TimeEntryDecisionResult | "refused";
  /** A closed word: never a rate, a value or a note. */
  reason?: string;
  voidId?: string;
  relogId?: string;
  exclusionId?: string;
  exclusionIds?: string[];
};

export type CorrectBase = {
  namespace: string;
  minutes: number;
  note: string;
  /** Today, from `dates.ts`: a correction is never back-dated (7.3). */
  workDate: string;
  zone: string;
  actor: TimeEntryActor;
  via: string;
  now: number;
};
export type CorrectEntryInput = CorrectBase & {
  entryId: string;
  /** The entry's `lastEventId`; for taking a void back, the void's. */
  expect: number;
};
export type CorrectSwitchStepInput = CorrectBase & {
  exclusionId: string;
  /** The session's record now: the relog's settings (4.2, Q3). */
  record: TrackingRecord;
  sessionName: string | null;
  repoKey: string | null;
};
export type CorrectInput = CorrectEntryInput | CorrectSwitchStepInput;

/** R13's figures at the input's cut (`asOf`). */
export type FiguresInput = MeasuredSession & {
  ownerNodeId: string;
  /** The service's state, required for every session: no default (ruling D). */
  block: FiguresBlock;
  /** The closed timer the periods were built from, on the timer scale. */
  timerMs: number | null;
  /** The lowered cut of a tracking-off row that is the session's last row. */
  untrackedFromMs: number | null;
};

/** A clock control or an agent's word, at the preview's moment `upTo` (7.6). */
export type ExcludeRequest = MeasuredSession & {
  ownerNodeId: string;
  upTo: number;
  choice: ControlChoice;
};
export type ExcludePreview = TimeEntryExcludePreview & {
  spans: NewCoverage[];
};
export type ExcludeInput = ExcludeRequest & {
  previewToken: string;
  /** The `timelog_adjustments` row the clock control wrote (Undo, N3). */
  adjustmentId: string | null;
  /** An agent's exclusion: the person's words, quoted (D-7). */
  words: string | null;
  actor: TimeEntryActor;
  via: Extract<TimeEntryExclusionVia, "clock" | "cli">;
  now: number;
};
export type SystemExcludeInput = {
  namespace: string;
  sessionId: string;
  originNodeId: string;
  control: "switch-step" | "restore";
  spans: readonly NewCoverage[];
  upTo: number;
  epoch: number;
  /** A restore's operator note citing CAP-RULE (5.6); null for a switch step. */
  words: string | null;
  now: number;
};

/** A release names an exclusion, a clock adjustment (Undo) or a range (Enable). */
export type ReleaseRequest = {
  namespace: string;
  sessionId: string;
  target:
    | { exclusionId: string }
    | { adjustmentId: string }
    | { range: { fromMs: number; toMs: number } };
};
export type ReleasePreview = {
  amountMs: number;
  amountMinutes: number;
  exclusionIds: string[];
  previewToken: string;
  /** `control`: the record's own exclusion (7.6); nothing is offered. */
  refused: "control" | null;
};
export type ReleaseInput = ReleaseRequest & {
  previewToken: string;
  /** The adjustment the Enable or the Undo itself wrote. */
  releasedAdjustmentId: string | null;
  actor: TimeEntryActor;
  via: string;
  now: number;
};

/** One reading of the session timer (5.4): its value and its two time bounds. */
export type TimerReadingInput = {
  ms: number;
  pollAt: number;
  tickAt: number;
  thinking: boolean;
  thinkingSince: number | null;
};

export type TimerMarkInput = {
  namespace: string;
  sessionId: string;
  originNodeId: string;
  /** The newest midnight: a pending reading before it yields to one after it. */
  cutMs: number;
  reading?: TimerReadingInput;
  /** Decided by the caller (the drained-copy rule is `measured.ts`'s). */
  confirm?:
    | { kind: "pending"; pendingTickAt: number; mode: string }
    | { kind: "local"; mode: string };
  /** The removal mark (3.4), or its clearing for a provisional registry exit. */
  removed?:
    | {
        ms: number | null;
        at: number;
        mode: string | null;
        via: TimeEntryRemovedVia;
      }
    | "clear";
  /** N-17's first fallen reading, held while the second is awaited, or its clearing (4.2; the caller decides, Task 9). */
  fall?: { ms: number; pollAt: number } | "clear";
  /** The last confirmed reading in shadow, as confirmed_mode leaves shadow (4.2, Q3; the caller decides, Task 9). */
  lastShadow?: { ms: number; at: number };
};

export type CutsInput = {
  namespace: string;
  sessionId: string;
  cuts: readonly { eventId: number; epoch: number; cutMs: number }[];
  source: TimeEntryCutSource;
  now: number;
};

export type EpochInput = {
  namespace: string;
  sessionId: string;
  originNodeId: string;
  /** The epoch the fall was seen in; nothing opens when the mark moved on. */
  fromEpoch: number;
  /** The fallen reading R, where the new epoch's counter starts. */
  startMs: number;
  /** R's poll time: the epoch's start (`start_at`), for its bounds only. */
  at: number;
  /** What opened it (4.2): a fallen timer, or a resync of the history copy. */
  source: TimeEntryEpochSource;
  /** When the epoch was opened (`opened_at`). */
  now: number;
};

export type TimeEntryEpochSource = "timer-fall" | "history-resync";

export type CopyStateInput = {
  namespace: string;
  originNodeId: string;
  historyDrainedAt?: number;
  intervalsDrainedAt?: number;
  originMode: string | null;
  originIncarnation: string | null;
  turnMirrorOff: boolean;
  /** A restore of this origin seen and not acknowledged (5.6 step 1): set, null releases, omitted keeps (the caller decides, Task 22). */
  restorePendingAt?: number | null;
  now: number;
};

export type BaselineInput =
  | {
      kind: "first";
      namespace: string;
      originNodeId: string;
      ownerNodeId: string;
      at: number;
      sessions: readonly {
        sessionId: string;
        baselineMs: number;
        tracked: boolean;
      }[];
      run: { night: string; cutMs: number; zone: string };
    }
  | {
      kind: "handover";
      namespace: string;
      originNodeId: string;
      ownerNodeId: string;
      at: number;
    }
  | {
      kind: "late";
      namespace: string;
      originNodeId: string;
      sessionId: string;
      baselineMs: number;
      /** As the session's record stood at its node's log_from (5.1). */
      tracked: boolean;
      at: number;
    };

export type RunOpenInput = {
  namespace: string;
  night: string;
  cutMs: number;
  zone: string;
  now: number;
};

export type RunCloseInput = {
  namespace: string;
  id: number;
  state: "done" | "blocked";
  sessions: number;
  entries: number;
  minutes: number;
  /** Ids, counts and reasons only: never a rate, a value or a note (C7). */
  detail: unknown;
  now: number;
};
