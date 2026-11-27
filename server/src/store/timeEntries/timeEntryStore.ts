// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6204 (plan sections 3.3 and 7): `TimeEntryStore`, the one writer of
 * the eleven time-entry tables.
 *
 * Every write is one `IMMEDIATE` transaction. `logMeasured` re-reads the
 * session's coverage, its carry and its baseline inside the transaction and
 * calls the pure planner (section 4), so a Log now during a run, a second run
 * of one night, a crash between two sessions and a second connection on the
 * same file all reduce to a transaction that finds nothing new (5.5). A
 * unique-key refusal rolls the whole session back.
 *
 * Every statement names its table literally, so the one-writer walk
 * (`server/src/timeEntries/entryWriters.test.ts`) sees each write; column
 * lists come from the schema's one definition, so they cannot drift from it.
 * The only `DELETE` is a released exclusion's own coverage (N3 = RE1).
 *
 * No log line, error text or run row of this file carries a rate, a value or a
 * note (C7 = a): a refusal names a field and a reason from a closed list.
 *
 * The store computes no date (the Project Manager's ruling A on Task 5): every
 * date it writes (a work date, a night, `billable_since`, an event's date)
 * comes from the caller as a value, and the store checks only its shape.
 * `server/src/timeEntries/dates.ts` (Task 9) is the one place that turns a
 * moment and a zone into a date.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  TIME_ENTRY_MINUTES_MAX,
  TIME_ENTRY_NOTE_MAX,
  TIME_ENTRY_REQUEST_CONTROLS,
  TIME_ENTRY_WORDS_MAX,
  timeBillingStatus,
  TRACKING_BILLING_STATUSES,
  type TimeEntryDecisionResult,
  type TrackingBillingStatus,
  type TimeEntry,
  type TimeEntryDetail,
  type TimeEntryFigures,
  type TimeEntryFilter,
  type TimeEntryListPage,
  type TimeEntrySyncState,
} from "@hapi/protocol";
import {
  planSession,
  subtractSpans,
  type NewCoverage,
  type CoverageSpan,
  type Plan,
  type PlannedEntry,
} from "../../timeEntries/amount";
import { selectExcludedSpans, spansMs } from "./exclusionSpans";
import { checkFiguresBlock, figuresOf } from "./timeEntryFigures";
import { TimeEntryMarks } from "./timeEntryMarks";
import {
  readCoveredSpans,
  readEntryDetail,
  readEntryList,
  readFigureRows,
  readLastCarry,
  readSessionEntries,
} from "./timeEntryReads";
import {
  actorColumns,
  ENTRY_COLS,
  entryFromRow,
  EVENT_COLS,
  jsonOrNull,
  negatedValue,
  projectJson,
  snapshotColumns,
  SYNC_COLS,
  TimeEntryDomainError,
  turnsOverlapping,
  valueOf,
  type Bind,
  type EntryRow,
  type EventRow,
  type SyncRow,
  type TimeEntryActor,
} from "./timeEntryRows";

export {
  entryFromRow,
  negatedValue,
  TimeEntryDomainError,
  TURN_IDS_MAX,
  valueOf,
} from "./timeEntryRows";
export type { EntryRow, MeasuredTurn, TimeEntryActor } from "./timeEntryRows";
import type {
  BaselineInput,
  CompleteInput,
  CopyStateInput,
  CutsInput,
  EpochInput,
  RunCloseInput,
  RunOpenInput,
  TimerMarkInput,
  CorrectEntryInput,
  CorrectInput,
  CorrectSwitchStepInput,
  DecisionInput,
  ExcludeInput,
  ExcludePreview,
  ExcludeRequest,
  FiguresInput,
  HoldLapseInput,
  HoldReleaseInput,
  HoldResult,
  LogMeasuredInput,
  LogMeasuredResult,
  MeasuredSession,
  ReleaseInput,
  ReleasePreview,
  ReleaseRequest,
  SystemExcludeInput,
  WriteAnswer,
} from "./timeEntryInputs";
export type {
  CompleteInput,
  CorrectEntryInput,
  CorrectInput,
  CorrectSwitchStepInput,
  DecisionInput,
  HoldLapseInput,
  HoldReleaseInput,
  HoldResult,
  LogMeasuredInput,
  LogMeasuredResult,
  MeasuredSession,
  WriteAnswer,
} from "./timeEntryInputs";

// ---------------------------------------------------------------------------
// Constants

const MS_PER_MINUTE = 60_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isStatus = (v: string): v is TrackingBillingStatus =>
  (TRACKING_BILLING_STATUSES as readonly string[]).includes(v);

function checkDate(field: string, value: string): void {
  if (!DATE_RE.test(value))
    throw new TimeEntryDomainError(field, "is not a date");
}

/** A preview's token: a digest of what it found, so a moved amount is seen. */
const tokenOf = (parts: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 40);

function checkText(field: string, value: string, max: number): void {
  if (value.trim() === "" || value.length > max) {
    throw new TimeEntryDomainError(field, "is empty or too long");
  }
}

// ---------------------------------------------------------------------------
// The store

export class TimeEntryStore {
  private readonly marks: TimeEntryMarks;

  constructor(private readonly db: Database) {
    this.marks = new TimeEntryMarks(db);
  }

  // -- readers (in timeEntryReads.ts) -------------------------------------

  /** Every coverage span of the session, entries' and exclusions' alike. */
  coveredSpans(namespace: string, sessionId: string): CoverageSpan[] {
    return readCoveredSpans(this.db, namespace, sessionId);
  }

  /** The carry of the newest `time` entry, checked against coverage (3.3). */
  lastCarry(namespace: string, sessionId: string): number {
    return readLastCarry(this.db, namespace, sessionId);
  }

  get(namespace: string, id: string): TimeEntryDetail | null {
    return readEntryDetail(this.db, namespace, id);
  }

  listForSession(namespace: string, sessionId: string): TimeEntry[] {
    return readSessionEntries(this.db, namespace, sessionId);
  }

  list(namespace: string, filter: TimeEntryFilter): TimeEntryListPage {
    return readEntryList(this.db, namespace, filter);
  }

  // -- logMeasured ---------------------------------------------------------

  /**
   * Logs the session's closed time up to the cut (R5, R6, R7): the planner's
   * entries, their coverage, their `made` event and their sync row, in one
   * transaction. Nothing is written for an origin with no baseline row
   * naming this node, or for a session the planner blocks (5.1; B-1).
   */
  logMeasured(input: LogMeasuredInput): LogMeasuredResult {
    if (!DATE_RE.test(input.workDate)) {
      throw new TimeEntryDomainError("workDate", "is not a date");
    }
    if (input.night !== null && !DATE_RE.test(input.night)) {
      throw new TimeEntryDomainError("night", "is not a date");
    }
    return this.db
      .transaction(() => {
        const plan = this.planInside(input, input.ownerNodeId);
        if (plan.blocked !== null) {
          return {
            blocked: "no_baseline" as const,
            entries: [] as [],
            newMs: 0 as const,
            carryOutMs: plan.carryOutMs,
          };
        }
        const written = plan.entries.map(planned =>
          this.writeTimeEntry(input, planned)
        );
        // The carry and the coverage still agree after the write (3.3).
        this.lastCarry(input.namespace, input.sessionId);
        return {
          blocked: null,
          entries: written,
          newMs: plan.newMs,
          carryOutMs: plan.carryOutMs,
        };
      })
      .immediate();
  }

  /**
   * The planner's answer for the session, from what this database holds:
   * the origin's baseline row naming `ownerNodeId` (and not released by it),
   * the session's baseline reading, its historical minutes, its coverage and
   * its carry. Writes nothing.
   */
  private planInside(input: MeasuredSession, ownerNodeId: string): Plan {
    const { namespace, sessionId } = input;
    const carryInMs = this.lastCarry(namespace, sessionId);
    const base = this.db
      .prepare(
        `SELECT log_from FROM time_entry_baselines
          WHERE namespace = ? AND origin_node_id = ? AND owner_node_id = ?
            AND kind IN ('first', 'handover')
            AND NOT EXISTS (
              SELECT 1 FROM time_entry_baselines r
               WHERE r.namespace = time_entry_baselines.namespace
                 AND r.origin_node_id = time_entry_baselines.origin_node_id
                 AND r.kind = 'released' AND r.owner_node_id = ?)
          ORDER BY CASE kind WHEN 'handover' THEN 0 ELSE 1 END LIMIT 1`
      )
      .get(namespace, input.originNodeId, ownerNodeId, ownerNodeId) as {
      log_from: number;
    } | null;
    const mark = this.db
      .prepare(
        `SELECT baseline_ms, baseline_tracked FROM time_entry_timer_marks
          WHERE namespace = ? AND session_id = ?`
      )
      .get(namespace, sessionId) as {
      baseline_ms: number | null;
      baseline_tracked: number | null;
    } | null;
    const historical = this.db
      .prepare(
        `SELECT COALESCE(SUM(minutes), 0) AS minutes FROM time_entries
          WHERE namespace = ? AND session_id = ? AND kind = 'historical'
            AND settles_baseline = 0`
      )
      .get(namespace, sessionId) as { minutes: number };
    const baselineMs = mark?.baseline_ms ?? null;
    return planSession({
      periods: input.periods,
      intervals: input.intervals,
      cutMs: input.cutMs,
      counter: { launcherKind: input.counter.launcherKind },
      covered: this.coveredSpans(namespace, sessionId),
      carryInMs,
      baseline:
        base === null
          ? null
          : {
              logFromMs: base.log_from,
              baselineCounterMs:
                baselineMs === null
                  ? null
                  : Math.max(0, baselineMs - input.counter.dAtBaselineMs),
              // No reading recorded: cut at log_from, the side that never bills twice.
              tracked: mark?.baseline_tracked !== 0,
              historicalMinutes: historical.minutes,
            },
    });
  }

  private writeTimeEntry(
    input: LogMeasuredInput,
    planned: PlannedEntry
  ): TimeEntry {
    const { namespace, sessionId } = input;
    const { period } = planned;
    const record = period.record;
    const next = this.db
      .prepare(
        `SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM time_entries
          WHERE namespace = ? AND session_id = ? AND kind = 'time'`
      )
      .get(namespace, sessionId) as { n: number };
    const id = `te:${sessionId}:${next.n}`;
    const counterPart = planned.coverage.some(c => c.lane === "counter");
    const turnsFrom = planned.firstMs ?? period.from;
    const turnsTo =
      planned.lastMs ?? Math.min(period.to ?? input.cutMs, input.cutMs);
    const status = period.status;
    const billableSince = status === "billable" ? input.workDate : null;
    const row: EntryRow = {
      ...snapshotColumns(record),
      id,
      namespace,
      session_id: sessionId,
      ordinal: next.n,
      origin_node_id: input.originNodeId,
      kind: "time",
      refers_to: null,
      source: input.source,
      night: input.night,
      work_date: input.workDate,
      zone: input.zone,
      late: input.late ? 1 : 0,
      minutes: planned.minutes,
      basis: planned.basis,
      basis_ms_json: jsonOrNull(planned.basisMs),
      read_from_at: counterPart ? input.counter.readFromAt : null,
      read_to_at: counterPart ? input.counter.readToAt : null,
      epoch: period.epoch,
      measured_ms: planned.measuredMs,
      carry_in_ms: planned.carryInMs,
      carry_out_ms: planned.carryOutMs,
      period_event_id: period.eventId,
      period_begin_event_id: period.beginEventId,
      period_from: period.from,
      period_to: period.to,
      first_ms: planned.firstMs,
      last_ms: planned.lastMs,
      launcher_ms_json: jsonOrNull(planned.launcherMs),
      turns_json: JSON.stringify(
        turnsOverlapping(input.turns, turnsFrom, turnsTo)
      ),
      repo_key: input.repoKey,
      status_made: status,
      held: period.held ? 1 : 0,
      held_status: period.held ? period.heldStatus : null,
      ...this.valueColumns(
        planned.minutes,
        record.rateMinor,
        record.currency,
        record.complete
      ),
      settles_baseline: 0,
      session_name: input.sessionName,
      logged_at: input.now,
      status,
      billable_since: billableSince,
      voided_by: null,
      last_event_id: 0,
    };
    this.insertEntry(row);
    for (const span of planned.coverage) {
      this.insertCoverage(namespace, sessionId, span, id);
    }
    const eventId = this.insertEvent({
      namespace,
      entry_id: id,
      kind: "made",
      status_before: null,
      status_after: status,
      project_before_json: null,
      project_after_json: projectJson(row),
      billable_since_before: null,
      billable_since_after: billableSince,
      effective_date: input.workDate,
      zone: input.zone,
      ...actorColumns(input.actor ?? { kind: "system" }),
      via: input.source,
      note: null,
      source_event_id: null,
      at: input.now,
    });
    this.setLastEvent(namespace, id, eventId);
    this.insertSync(
      namespace,
      id,
      record.sync === null ? "not-requested" : "waiting",
      false,
      input.now
    );
    return entryFromRow({ ...row, last_event_id: eventId });
  }

  // -- decisions and holds (7.1, 7.2) --------------------------------------

  /**
   * #6782's one write (7.1): a status, a project or an external target for
   * each entry, one `decision` event per changed entry and the projection, in
   * one transaction. Minutes, rates, value, work date and snapshot never
   * change. A frozen pair answers `voided`; a moved token `stale`. A change to
   * Billable stamps the caller's `releaseDate` (D-3; ruling A).
   */
  applyDecision(input: DecisionInput): Record<string, TimeEntryDecisionResult> {
    if (input.status !== undefined && !isStatus(input.status)) {
      throw new TimeEntryDomainError("status", "is not a billing status");
    }
    checkDate("releaseDate", input.releaseDate);
    checkText("zone", input.zone, 64);
    checkText("note", input.note, TIME_ENTRY_NOTE_MAX);
    return this.db
      .transaction(() => {
        const out: Record<string, TimeEntryDecisionResult> = {};
        for (const id of input.entryIds) {
          const row = this.entryRow(input.namespace, id);
          if (row === null) out[id] = "not_found";
          else if (row.kind === "void" || row.voided_by !== null) {
            out[id] = "voided";
          } else if (input.expect[id] !== row.last_event_id) out[id] = "stale";
          else out[id] = this.decide(row, input);
        }
        return out;
      })
      .immediate();
  }

  private decide(row: EntryRow, input: DecisionInput): TimeEntryDecisionResult {
    const status = input.status ?? row.status;
    const project = input.project ?? {
      kind: row.current_project_kind,
      key: row.current_project_key,
      name: row.current_project_name,
    };
    const external =
      input.external === undefined
        ? row.current_external_json
        : jsonOrNull(input.external);
    const after = {
      current_project_kind: project.kind,
      current_project_key: project.key,
      current_project_name: project.name,
      current_external_json: external,
    };
    if (status === row.status && projectJson(after) === projectJson(row)) {
      return "unchanged";
    }
    const since =
      status === row.status
        ? row.billable_since
        : status === "billable"
          ? input.releaseDate
          : null;
    const eventId = this.insertEvent({
      namespace: row.namespace,
      entry_id: row.id,
      kind: "decision",
      status_before: row.status,
      status_after: status,
      project_before_json: projectJson(row),
      project_after_json: projectJson(after),
      billable_since_before: row.billable_since,
      billable_since_after: since,
      effective_date: status === row.status ? null : input.releaseDate,
      zone: input.zone,
      ...actorColumns(input.actor),
      via: input.via,
      note: input.note,
      source_event_id: null,
      at: input.now,
    });
    this.db
      .prepare(
        `UPDATE time_entries
            SET status = ?, billable_since = ?, current_project_kind = ?,
                current_project_key = ?, current_project_name = ?,
                current_external_json = ?, last_event_id = ?
          WHERE namespace = ? AND id = ?`
      )
      .run(
        status,
        since,
        project.kind,
        project.key,
        project.name,
        external,
        eventId,
        row.namespace,
        row.id
      );
    this.moveSync(row.namespace, row.id, ["synced"], input.now);
    return "applied";
  }

  /**
   * A held stretch's end (7.2; D-5): a Keep gives each held entry its own
   * copied status, a Reverse makes it Non-billable, with the source row's
   * actor and time. An entry whose status a person decided keeps it and
   * lapses. Idempotent: an entry with a hold event is never taken again.
   */
  releaseHold(input: HoldReleaseInput): Record<string, HoldResult> {
    checkDate("releaseDate", input.releaseDate);
    checkText("zone", input.zone, 64);
    return this.db
      .transaction(() => {
        const out: Record<string, HoldResult> = {};
        for (const id of input.entryIds) {
          const row = this.holdable(input.namespace, input.sessionId, id, out);
          if (row === null) continue;
          if (this.personDecidedStatus(row)) {
            this.writeLapse(row, input.now);
            out[id] = "lapsed";
            continue;
          }
          const status: TrackingBillingStatus =
            input.outcome === "kept"
              ? ((row.held_status as TrackingBillingStatus | null) ?? "pending")
              : "non-billable";
          const since =
            status === row.status
              ? row.billable_since
              : status === "billable"
                ? input.releaseDate
                : null;
          const eventId = this.insertEvent({
            namespace: row.namespace,
            entry_id: row.id,
            kind: input.outcome === "kept" ? "hold-kept" : "hold-reversed",
            status_before: row.status,
            status_after: status,
            project_before_json: null,
            project_after_json: null,
            billable_since_before: row.billable_since,
            billable_since_after: since,
            effective_date: status === "billable" ? input.releaseDate : null,
            zone: input.zone,
            ...actorColumns(input.source.actor),
            via: "engine",
            note: null,
            source_event_id: input.source.eventId,
            at: input.source.at,
          });
          this.db
            .prepare(
              `UPDATE time_entries SET status = ?, billable_since = ?, last_event_id = ?
                WHERE namespace = ? AND id = ?`
            )
            .run(status, since, eventId, row.namespace, row.id);
          if (status !== row.status) {
            this.moveSync(row.namespace, row.id, ["synced"], input.now);
          }
          out[id] = "applied";
        }
        return out;
      })
      .immediate();
  }

  /**
   * A hold that ended over an untracked stretch (7.2): the entries stay
   * Pending and get `hold-lapsed`, so no tick reads them again.
   */
  lapseHold(input: HoldLapseInput): Record<string, HoldResult> {
    return this.db
      .transaction(() => {
        const out: Record<string, HoldResult> = {};
        for (const id of input.entryIds) {
          const row = this.holdable(input.namespace, input.sessionId, id, out);
          if (row === null) continue;
          this.writeLapse(row, input.now);
          out[id] = "lapsed";
        }
        return out;
      })
      .immediate();
  }

  /** A held entry no hold event has taken, else its answer in `out`. */
  private holdable(
    namespace: string,
    sessionId: string,
    id: string,
    out: Record<string, HoldResult>
  ): EntryRow | null {
    const row = this.entryRow(namespace, id);
    if (row === null || row.session_id !== sessionId) out[id] = "not_found";
    else if (row.kind === "void" || row.voided_by !== null) out[id] = "voided";
    else if (row.held !== 1 || this.hasHoldEvent(row)) out[id] = "unchanged";
    else return row;
    return null;
  }

  private hasHoldEvent(row: EntryRow): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM time_entry_events WHERE namespace = ? AND entry_id = ?
             AND kind IN ('hold-kept', 'hold-reversed', 'hold-lapsed') LIMIT 1`
        )
        .get(row.namespace, row.id) !== null
    );
  }

  /** A person's decision that changed the status (a project-only one does not count, item 27). */
  private personDecidedStatus(row: EntryRow): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM time_entry_events WHERE namespace = ? AND entry_id = ?
             AND kind = 'decision' AND status_before IS NOT status_after LIMIT 1`
        )
        .get(row.namespace, row.id) !== null
    );
  }

  private writeLapse(row: EntryRow, now: number): void {
    const eventId = this.insertEvent({
      namespace: row.namespace,
      entry_id: row.id,
      kind: "hold-lapsed",
      status_before: row.status,
      status_after: row.status,
      project_before_json: null,
      project_after_json: null,
      billable_since_before: row.billable_since,
      billable_since_after: row.billable_since,
      effective_date: null,
      zone: null,
      ...actorColumns({ kind: "system" }),
      via: "engine",
      note: null,
      source_event_id: null,
      at: now,
    });
    this.setLastEvent(row.namespace, row.id, eventId);
  }

  // -- completion (7.5) ----------------------------------------------------

  /**
   * An entry made with no rate is given its category and rate once, by a
   * person (OC-6): one `completed` event, the snapshot columns and the value.
   * Twice reduces to one event; a void, a frozen pair, an entry that had a
   * rate and an agent are refused.
   */
  completeEntry(input: CompleteInput): WriteAnswer {
    if (input.actor.kind === "session") {
      return { result: "refused", reason: "agent_time_entries_refused" };
    }
    checkText("category.source", input.category.source, 64);
    checkText("category.id", input.category.id, 200);
    checkText("category.name", input.category.name, 200);
    return this.db
      .transaction((): WriteAnswer => {
        const row = this.entryRow(input.namespace, input.entryId);
        if (row === null) return { result: "not_found" };
        if (row.kind === "void" || row.voided_by !== null) {
          return { result: "voided" };
        }
        if (row.kind !== "time" && row.kind !== "relog") {
          return { result: "refused", reason: "kind" };
        }
        if (row.last_event_id !== input.expect) return { result: "stale" };
        if (row.complete === 1 || row.rate_minor !== null) {
          return this.hasEvent(row, "completed")
            ? { result: "unchanged" }
            : { result: "refused", reason: "has_rate" };
        }
        const { value, reason } = valueOf(
          row.minutes,
          input.rateMinor,
          input.currency
        );
        if (reason !== null || value === null) {
          return { result: "refused", reason: reason ?? "rate" };
        }
        const eventId = this.insertEvent({
          namespace: row.namespace,
          entry_id: row.id,
          kind: "completed",
          status_before: row.status,
          status_after: row.status,
          project_before_json: null,
          project_after_json: null,
          billable_since_before: row.billable_since,
          billable_since_after: row.billable_since,
          effective_date: null,
          zone: null,
          ...actorColumns(input.actor),
          via: input.via,
          note: null,
          source_event_id: null,
          at: input.now,
        });
        this.db
          .prepare(
            `UPDATE time_entries
                SET category_source = ?, category_id = ?, category_name = ?,
                    default_rate_minor = ?, default_currency = ?, rate_minor = ?,
                    currency = ?, rate_note = ?, complete = 1, value_minor = ?,
                    value_reason = NULL, last_event_id = ?
              WHERE namespace = ? AND id = ?`
          )
          .run(
            input.category.source,
            input.category.id,
            input.category.name,
            input.category.defaultRateMinor,
            input.category.defaultCurrency,
            input.rateMinor,
            input.currency,
            input.rateNote,
            value,
            eventId,
            row.namespace,
            row.id
          );
        this.moveSync(row.namespace, row.id, ["synced"], input.now);
        return { result: "applied" };
      })
      .immediate();
  }

  // -- corrections (7.3) ---------------------------------------------------

  /**
   * R11: a void (`tv:<entry>`) and, for 1 to 1,440 minutes, a relog
   * (`tr:<entry>`), in one transaction; no entry's minutes change. The
   * original keeps its coverage and is marked `voided_by`; a voided original
   * with no relog takes one back with its void's token (item 29). Addressed to
   * a `switch-step` exclusion, it writes one relog under the session's record
   * now (4.2, Q3). Both carry the caller's `workDate` (ruling A).
   */
  correct(input: CorrectInput): WriteAnswer {
    if (input.actor.kind === "session") {
      return { result: "refused", reason: "agent_time_entries_refused" };
    }
    if (
      !Number.isSafeInteger(input.minutes) ||
      input.minutes < 0 ||
      input.minutes > TIME_ENTRY_MINUTES_MAX
    ) {
      throw new TimeEntryDomainError("minutes", "are not 0 to 1440");
    }
    checkDate("workDate", input.workDate);
    checkText("zone", input.zone, 64);
    checkText("note", input.note, TIME_ENTRY_NOTE_MAX);
    return this.db
      .transaction((): WriteAnswer => {
        if ("exclusionId" in input) return this.relogSwitchStep(input);
        const row = this.entryRow(input.namespace, input.entryId);
        if (row === null) return { result: "not_found" };
        if (row.kind === "void") return { result: "refused", reason: "void" };
        const voidId = `tv:${row.id}`;
        const relogId = `tr:${row.id}`;
        if (row.voided_by !== null) {
          // Taking a void back: a relog with the void's token (item 29).
          if (row.kind === "relog" || row.voided_by !== voidId) {
            return { result: "refused", reason: "voided" };
          }
          const theVoid = this.entryRow(row.namespace, voidId);
          if (theVoid === null || theVoid.last_event_id !== input.expect) {
            return { result: "stale" };
          }
          if (this.entryRow(row.namespace, relogId) !== null) {
            return { result: "refused", reason: "relog_exists" };
          }
          if (input.minutes === 0)
            return { result: "refused", reason: "minutes" };
          this.insertDerived(row, relogId, "relog", input.minutes, input);
          return { result: "applied", relogId };
        }
        if (row.last_event_id !== input.expect) return { result: "stale" };
        this.insertDerived(row, voidId, "void", -row.minutes, input);
        const eventId = this.insertEvent({
          namespace: row.namespace,
          entry_id: row.id,
          kind: "voided",
          status_before: row.status,
          status_after: row.status,
          project_before_json: null,
          project_after_json: null,
          billable_since_before: row.billable_since,
          billable_since_after: row.billable_since,
          effective_date: input.workDate,
          zone: input.zone,
          ...actorColumns(input.actor),
          via: input.via,
          note: input.note,
          source_event_id: null,
          at: input.now,
        });
        this.db
          .prepare(
            `UPDATE time_entries SET voided_by = ?, last_event_id = ?
              WHERE namespace = ? AND id = ?`
          )
          .run(voidId, eventId, row.namespace, row.id);
        this.moveSync(row.namespace, row.id, ["synced", "waiting"], input.now);
        if (input.minutes > 0) {
          this.insertDerived(row, relogId, "relog", input.minutes, input);
          return { result: "applied", voidId, relogId };
        }
        return { result: "applied", voidId };
      })
      .immediate();
  }

  /** A relog of a switch step (4.2, Q3): at most its whole minutes, under the record now. */
  private relogSwitchStep(input: CorrectSwitchStepInput): WriteAnswer {
    const x = this.db
      .prepare(
        `SELECT session_id, origin_node_id, control, measured_ms, epoch, released_at
           FROM time_entry_exclusions WHERE namespace = ? AND id = ?`
      )
      .get(input.namespace, input.exclusionId) as {
      session_id: string;
      origin_node_id: string;
      control: string;
      measured_ms: number;
      epoch: number;
      released_at: number | null;
    } | null;
    if (x === null) return { result: "not_found" };
    if (x.control !== "switch-step" || x.released_at !== null) {
      return { result: "refused", reason: "control" };
    }
    const relogId = `tr:${input.exclusionId}`;
    if (this.entryRow(input.namespace, relogId) !== null) {
      return { result: "refused", reason: "relog_exists" };
    }
    if (
      input.minutes < 1 ||
      input.minutes > Math.floor(x.measured_ms / MS_PER_MINUTE)
    ) {
      return { result: "refused", reason: "minutes" };
    }
    const status = timeBillingStatus(input.record);
    if (status === null) return { result: "refused", reason: "untracked" };
    const snapshot = snapshotColumns(input.record);
    const row: EntryRow = {
      ...snapshot,
      id: relogId,
      namespace: input.namespace,
      session_id: x.session_id,
      ordinal: null,
      origin_node_id: x.origin_node_id,
      kind: "relog",
      refers_to: input.exclusionId,
      source: "correction",
      night: null,
      work_date: input.workDate,
      zone: input.zone,
      late: 0,
      minutes: input.minutes,
      basis: "timer",
      basis_ms_json: null,
      read_from_at: null,
      read_to_at: null,
      epoch: x.epoch,
      measured_ms: 0,
      carry_in_ms: 0,
      carry_out_ms: 0,
      period_event_id: null,
      period_begin_event_id: null,
      period_from: null,
      period_to: null,
      first_ms: null,
      last_ms: null,
      launcher_ms_json: null,
      turns_json: null,
      repo_key: input.repoKey,
      status_made: status,
      held: 0,
      held_status: null,
      settles_baseline: 0,
      session_name: input.sessionName,
      logged_at: input.now,
      status,
      billable_since: status === "billable" ? input.workDate : null,
      voided_by: null,
      last_event_id: 0,
      ...this.valueColumns(
        input.minutes,
        input.record.rateMinor,
        input.record.currency,
        input.record.complete
      ),
    };
    this.insertMade(
      row,
      input,
      input.record.sync === null ? "not-requested" : "waiting"
    );
    return { result: "applied", relogId };
  }

  /** A void or a relog of `orig`: today's date, its snapshot, its current status and project. */
  private insertDerived(
    orig: EntryRow,
    id: string,
    kind: "void" | "relog",
    minutes: number,
    input: CorrectEntryInput
  ): void {
    const values =
      kind === "void"
        ? {
            value_minor: negatedValue(orig.value_minor),
            value_reason: orig.value_reason,
            complete: orig.complete,
          }
        : this.valueColumns(
            minutes,
            orig.rate_minor,
            orig.currency,
            orig.complete === 1
          );
    const row: EntryRow = {
      ...orig,
      ...values,
      id,
      ordinal: null,
      kind,
      refers_to: orig.id,
      source: "correction",
      night: null,
      work_date: input.workDate,
      zone: input.zone,
      late: 0,
      minutes,
      measured_ms: 0,
      carry_in_ms: 0,
      carry_out_ms: 0,
      project_kind: orig.current_project_kind,
      project_key: orig.current_project_key,
      project_name: orig.current_project_name,
      external_json: orig.current_external_json,
      status_made: orig.status,
      held: 0,
      held_status: null,
      settles_baseline: 0,
      logged_at: input.now,
      billable_since: orig.status === "billable" ? input.workDate : null,
      voided_by: null,
      last_event_id: 0,
    };
    const state: TimeEntrySyncState =
      kind === "void" || orig.current_external_json === null
        ? "not-requested"
        : "waiting";
    this.insertMade(row, input, state, kind === "void");
  }

  /** Inserts the row, its `made` event and its sync row; sets its token. */
  private insertMade(
    row: EntryRow,
    input: { actor: TimeEntryActor; via: string; note: string; now: number },
    state: TimeEntrySyncState,
    neverSent = false
  ): void {
    this.insertEntry(row);
    const eventId = this.insertEvent({
      namespace: row.namespace,
      entry_id: row.id,
      kind: "made",
      status_before: null,
      status_after: row.status,
      project_before_json: null,
      project_after_json: projectJson(row),
      billable_since_before: null,
      billable_since_after: row.billable_since,
      effective_date: row.work_date,
      zone: row.zone,
      ...actorColumns(input.actor),
      via: input.via,
      note: input.note,
      source_event_id: null,
      at: input.now,
    });
    this.setLastEvent(row.namespace, row.id, eventId);
    this.insertSync(row.namespace, row.id, state, neverSent, input.now);
  }

  private valueColumns(
    minutes: number,
    rateMinor: number | null,
    currency: string | null,
    complete: boolean
  ): Pick<EntryRow, "value_minor" | "value_reason" | "complete"> {
    const { value, reason } = valueOf(minutes, rateMinor, currency);
    return {
      value_minor: value,
      value_reason: reason,
      complete: complete && reason === null && value !== null ? 1 : 0,
    };
  }

  private hasEvent(row: EntryRow, kind: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM time_entry_events WHERE namespace = ? AND entry_id = ? AND kind = ? LIMIT 1`
        )
        .get(row.namespace, row.id, kind) !== null
    );
  }

  private entryRow(namespace: string, id: string): EntryRow | null {
    return this.db
      .prepare(`SELECT * FROM time_entries WHERE namespace = ? AND id = ?`)
      .get(namespace, id) as EntryRow | null;
  }

  /** Moves the entry's sync row to `change-pending` when it is in one of `from`. */
  private moveSync(
    namespace: string,
    entryId: string,
    from: readonly TimeEntrySyncState[],
    now: number
  ): void {
    this.db
      .prepare(
        `UPDATE time_entry_sync SET state = 'change-pending', updated_at = ?
          WHERE namespace = ? AND entry_id = ?
            AND state IN (${from.map(() => "?").join(", ")})`
      )
      .run(now, namespace, entryId, ...from);
  }

  // -- figures (8.3; R13) --------------------------------------------------

  /**
   * The session's figures from one read: the planner's dry run at the cut,
   * the carry, the unsynced minutes, the exclusions and the baseline mark.
   * `no_baseline` is the store's; the service passes the rest in `block`, a
   * required input checked before anything is read.
   */
  figuresFor(input: FiguresInput): TimeEntryFigures {
    const block = checkFiguresBlock(input.block);
    return this.db.transaction(() => {
      const { namespace, sessionId } = input;
      const plan = this.planInside(input, input.ownerNodeId);
      const rows = readFigureRows(this.db, namespace, sessionId);
      return figuresOf({
        sessionId,
        asOf: input.cutMs,
        block,
        plan,
        carryInMs: this.lastCarry(namespace, sessionId),
        tracked: input.periods.at(-1)?.to === null,
        unsyncedMinutes: rows.unsyncedMinutes,
        excludedMs: rows.excludedMs,
        markFallen: rows.markFallen,
        timerMs: input.timerMs,
        counterTopMs: input.periods.reduce(
          (top, p) => Math.max(top, p.counterTo),
          0
        ),
        untrackedFromMs: input.untrackedFromMs,
        baseline: {
          baselineMs: rows.mark?.baseline_ms ?? null,
          tracked:
            rows.mark === null || rows.mark.baseline_tracked === null
              ? null
              : rows.mark.baseline_tracked === 1,
          settled: rows.mark?.baseline_settled === 1,
          historicalMinutes: rows.historicalMinutes,
        },
      });
    })();
  }

  // -- exclusions (7.6; Q1 = RM2; D-7; R17) ---------------------------------

  /**
   * The amount a clock control or an agent's word would remove, the spans and
   * the token the confirmed request carries. Writes nothing.
   */
  previewExclude(request: ExcludeRequest): ExcludePreview {
    return this.db.transaction(() => this.exclusionPreview(request))();
  }

  private exclusionPreview(request: ExcludeRequest): ExcludePreview {
    const plan = this.planInside(
      { ...request, cutMs: request.upTo },
      request.ownerNodeId
    );
    const spans =
      plan.blocked === null
        ? selectExcludedSpans(plan.newCoverage, request.choice)
        : [];
    const amountMs = spansMs(spans);
    return {
      amountMs,
      amountMinutes: Math.floor(amountMs / MS_PER_MINUTE),
      upTo: request.upTo,
      previewToken: tokenOf([
        "exclude",
        request.namespace,
        request.sessionId,
        request.choice,
        request.upTo,
        spans,
      ]),
      session: { id: request.sessionId, name: request.sessionName },
      spans,
    };
  }

  /**
   * Writes the previewed exclusion: one row and its coverage, no minutes and
   * no value. A token whose preview moved answers `preview_stale` and writes
   * nothing; nothing left to cover writes nothing. Only ever lowers.
   */
  exclude(input: ExcludeInput): WriteAnswer {
    const control = input.choice.control;
    const agent = control === "agent";
    if (agent !== (input.actor.kind === "session")) {
      throw new TimeEntryDomainError("actor", "does not match the control");
    }
    if (input.via !== (agent ? "cli" : "clock")) {
      throw new TimeEntryDomainError("via", "does not match the control");
    }
    if (agent) checkText("words", input.words ?? "", TIME_ENTRY_WORDS_MAX);
    else if (input.words !== null) {
      throw new TimeEntryDomainError("words", "are an agent's only");
    }
    return this.db
      .transaction((): WriteAnswer => {
        const preview = this.exclusionPreview(input);
        if (preview.previewToken !== input.previewToken) {
          return { result: "stale", reason: "preview_stale" };
        }
        if (preview.spans.length === 0) return { result: "unchanged" };
        const range =
          input.choice.control === "clock-disable" ? input.choice.range : null;
        const exclusionId = this.writeExclusion({
          namespace: input.namespace,
          sessionId: input.sessionId,
          originNodeId: input.originNodeId,
          control,
          adjustmentId: agent ? null : input.adjustmentId,
          range,
          upTo: input.upTo,
          epoch: input.counter.epoch,
          words: input.words,
          actor: input.actor,
          via: input.via,
          now: input.now,
          spans: preview.spans,
        });
        return { result: "applied", exclusionId };
      })
      .immediate();
  }

  /**
   * The engine's exclusions: a switch step (4.2, Q3 = ST1) and a restore's
   * rows (5.6, the operator's note in `words`). Only the part no entry or
   * exclusion covers yet is written.
   */
  excludeSystem(input: SystemExcludeInput): WriteAnswer {
    return this.db
      .transaction((): WriteAnswer => {
        const covered = this.coveredSpans(input.namespace, input.sessionId);
        const spans = input.spans.flatMap(s =>
          subtractSpans(
            { from: s.fromMs, to: s.toMs },
            covered
              .filter(c => c.lane === s.lane && c.key === s.key)
              .map(c => ({ from: c.fromMs, to: c.toMs }))
          ).map(f => ({ ...s, fromMs: f.from, toMs: f.to }))
        );
        if (spans.length === 0) return { result: "unchanged" };
        const exclusionId = this.writeExclusion({
          ...input,
          adjustmentId: null,
          range: null,
          actor: { kind: "system" },
          via: "engine",
          spans,
        });
        return { result: "applied", exclusionId };
      })
      .immediate();
  }

  /** What a release (Undo, Enable, or by id) would return to billing. Writes nothing. */
  previewRelease(request: ReleaseRequest): ReleasePreview {
    return this.db.transaction(() => this.releasePreview(request))();
  }

  private releasePreview(request: ReleaseRequest): ReleasePreview {
    const { namespace, sessionId, target } = request;
    let where = "id = ?";
    let binds: Bind[] = [];
    if ("exclusionId" in target) binds = [target.exclusionId];
    else if ("adjustmentId" in target) {
      where = "adjustment_id = ?";
      binds = [target.adjustmentId];
    } else {
      where = "control = 'clock-disable' AND range_from < ? AND range_to > ?";
      binds = [target.range.toMs, target.range.fromMs];
    }
    const rows = this.db
      .prepare(
        `SELECT id, measured_ms, control FROM time_entry_exclusions
          WHERE namespace = ? AND session_id = ? AND released_at IS NULL
            AND ${where} ORDER BY id`
      )
      .all(namespace, sessionId, ...binds) as {
      id: string;
      measured_ms: number;
      control: string;
    }[];
    // 7.6: a release reaches a person's clock control or the agent's removal,
    // never the record's own (a switch step, corrected by its relog; a restore).
    const refused = rows.some(
      r =>
        !(TIME_ENTRY_REQUEST_CONTROLS as readonly string[]).includes(r.control)
    )
      ? ("control" as const)
      : null;
    const offered = refused === null ? rows : [];
    const amountMs = offered.reduce((sum, r) => sum + r.measured_ms, 0);
    const ids = offered.map(r => r.id);
    return {
      refused,
      amountMs,
      amountMinutes: Math.floor(amountMs / MS_PER_MINUTE),
      exclusionIds: ids,
      previewToken: tokenOf([
        "release",
        namespace,
        sessionId,
        target,
        ids,
        amountMs,
      ]),
    };
  }

  /**
   * N3 = RE1: returns the previewed exclusions to billing, recorded on their
   * rows, and deletes their own coverage (the one `DELETE` of this writer), so
   * the next run logs that time, dated then. An agent can release nothing.
   */
  releaseExclusion(input: ReleaseInput): WriteAnswer {
    if (input.actor.kind === "session") {
      return { result: "refused", reason: "agent_time_entries_refused" };
    }
    return this.db
      .transaction((): WriteAnswer => {
        const preview = this.releasePreview(input);
        if (preview.refused !== null) {
          return { result: "refused", reason: preview.refused };
        }
        if (preview.previewToken !== input.previewToken) {
          return { result: "stale", reason: "preview_stale" };
        }
        if (preview.exclusionIds.length === 0) return { result: "unchanged" };
        for (const id of preview.exclusionIds) {
          this.db
            .prepare(
              `UPDATE time_entry_exclusions
                  SET released_at = ?, released_by_kind = ?, released_via = ?,
                      released_adjustment_id = ?
                WHERE namespace = ? AND id = ? AND released_at IS NULL`
            )
            .run(
              input.now,
              input.actor.kind,
              input.via,
              input.releasedAdjustmentId,
              input.namespace,
              id
            );
          this.db
            .prepare(
              `DELETE FROM time_entry_coverage WHERE namespace = ? AND session_id = ? AND owner_id = ?`
            )
            .run(input.namespace, input.sessionId, id);
        }
        return { result: "applied", exclusionIds: preview.exclusionIds };
      })
      .immediate();
  }

  private writeExclusion(x: {
    namespace: string;
    sessionId: string;
    originNodeId: string;
    control: string;
    adjustmentId: string | null;
    range: { fromMs: number; toMs: number } | null;
    upTo: number;
    epoch: number;
    words: string | null;
    actor: TimeEntryActor;
    via: string;
    now: number;
    spans: readonly NewCoverage[];
  }): string {
    const next = this.db
      .prepare(
        `SELECT COUNT(*) + 1 AS n FROM time_entry_exclusions
          WHERE namespace = ? AND session_id = ?`
      )
      .get(x.namespace, x.sessionId) as { n: number };
    const id = `tx:${x.namespace}:${x.sessionId}:${next.n}`;
    const actor = actorColumns(x.actor);
    this.db
      .prepare(
        `INSERT INTO time_entry_exclusions
           (id, namespace, session_id, origin_node_id, control, adjustment_id,
            range_from, range_to, up_to_ms, measured_ms, epoch, actor_kind,
            actor_session_id, actor_user_agent, via, words, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        x.namespace,
        x.sessionId,
        x.originNodeId,
        x.control,
        x.adjustmentId,
        x.range?.fromMs ?? null,
        x.range?.toMs ?? null,
        x.upTo,
        spansMs(x.spans),
        x.epoch,
        actor.actor_kind,
        actor.actor_session_id,
        actor.actor_user_agent,
        x.via,
        x.words,
        x.now
      );
    for (const span of x.spans) {
      this.insertCoverage(x.namespace, x.sessionId, span, id);
    }
    return id;
  }

  // -- marks, cuts, epochs, copy state, baselines, runs (timeEntryMarks.ts) --
  // The store opens each transaction; the marks class opens none.

  putTimerMark(input: TimerMarkInput): { confirmed: boolean } {
    return this.db
      .transaction(() => this.marks.putTimerMark(input))
      .immediate();
  }

  lowerCut(input: CutsInput): number {
    return this.db.transaction(() => this.marks.lowerCut(input)).immediate();
  }

  openEpoch(input: EpochInput): "opened" | "unchanged" {
    return this.db.transaction(() => this.marks.openEpoch(input)).immediate();
  }

  putCopyState(input: CopyStateInput): void {
    this.db.transaction(() => this.marks.putCopyState(input)).immediate();
  }

  putBaseline(input: BaselineInput): "applied" | "exists" | "refused" {
    return this.db.transaction(() => this.marks.putBaseline(input)).immediate();
  }

  releaseOwner(input: {
    namespace: string;
    ownerNodeId: string;
    at: number;
  }): string[] {
    return this.db
      .transaction(() => this.marks.releaseOwner(input))
      .immediate();
  }

  openRun(input: RunOpenInput): { id: number; state: string } {
    return this.db.transaction(() => this.marks.openRun(input)).immediate();
  }

  closeRun(input: RunCloseInput): boolean {
    return this.db.transaction(() => this.marks.closeRun(input)).immediate();
  }

  // -- row writers (private; each names its table) --------------------------

  private insertEntry(row: EntryRow): void {
    this.db
      .prepare(
        `INSERT INTO time_entries (${ENTRY_COLS.names}) VALUES (${ENTRY_COLS.params})`
      )
      .run(row);
  }

  private insertCoverage(
    namespace: string,
    sessionId: string,
    span: { lane: string; key: string; fromMs: number; toMs: number },
    ownerId: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO time_entry_coverage
           (namespace, session_id, lane, key, from_ms, to_ms, owner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        namespace,
        sessionId,
        span.lane,
        span.key,
        span.fromMs,
        span.toMs,
        ownerId
      );
  }

  private insertEvent(event: Omit<EventRow, "id">): number {
    const result = this.db
      .prepare(
        `INSERT INTO time_entry_events (${EVENT_COLS.names}) VALUES (${EVENT_COLS.params})`
      )
      .run(event);
    return Number(result.lastInsertRowid);
  }

  private setLastEvent(namespace: string, id: string, eventId: number): void {
    this.db
      .prepare(
        `UPDATE time_entries SET last_event_id = ? WHERE namespace = ? AND id = ?`
      )
      .run(eventId, namespace, id);
  }

  private insertSync(
    namespace: string,
    entryId: string,
    state: TimeEntrySyncState,
    neverSent: boolean,
    now: number
  ): void {
    const row: SyncRow = {
      entry_id: entryId,
      namespace,
      state,
      provider: null,
      connection_id: null,
      external_task_id: null,
      external_entry_id: null,
      task_link: null,
      entry_link: null,
      error_code: null,
      never_sent: neverSent ? 1 : 0,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO time_entry_sync (${SYNC_COLS.names}) VALUES (${SYNC_COLS.params})`
      )
      .run(row);
  }
}
