// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  isAutoPickEligible,
  PIN_LIST_DEFAULT_LIMIT,
  PIN_MAX_ANSWERS,
  PIN_MAX_OPEN_PER_SESSION,
  PIN_MAX_PER_SESSION,
  PIN_RESERVED_KEY_PREFIXES,
  type Pin,
  type PinAnchor,
  type PinAnswer,
  type PinAnswerBy,
  type PinContent,
  type PinDeadlineBy,
  type PinStatus,
  PIN_ANSWER_NOTE_MAX_CHARS,
  PIN_ANSWERS_MAX_BYTES,
  settlingAnswer,
} from "@hapi/protocol";
import {
  deadlineOffForQuestion,
  isDeadlineReportPending,
  NO_DEADLINE,
  operatorDeadline,
  reconcileDeadline,
  reconcileForeignEdit,
  type DeadlineState,
  type DeadlineTransition,
} from "./pinDeadlineRules";

/** Raw `session_pins` row as stored (epoch-ms timestamps, JSON text columns). */
type PinRow = {
  session_id: string;
  key: string;
  status: PinStatus;
  revision: number;
  starred: number;
  seen_at: number | null;
  seen_revision: number | null;
  posted_seq: number | null;
  anchor_json: string | null;
  content_json: string;
  answers_json: string;
  created_at: number;
  updated_at: number;
  // #6452: automatic picks. Nullable; absent on a row read before the migration ran.
  deadline_at?: number | null;
  deadline_by?: PinDeadlineBy | null;
  deadline_revision?: number | null;
  deadline_id?: string | null;
  deadline_changed_at?: number | null;
  deadline_reported_at?: number | null;
  // #6453, added by `migrateAddColumn` (store/index.ts); null until a Save.
  saved_to: string | null;
  saved_revision: number | null;
  saved_at: number | null;
  save_reported_at: number | null;
};

/** A pin's deadline as the scheduler reads it, with the content it must re-check (#6452). */
export type PinDeadlineRow = {
  /** The deadline; its own `revision` is the one it was last reconciled against. */
  deadline: DeadlineState;
  sessionId: string;
  key: string;
  status: PinStatus;
  /** The pin's current revision. */
  revision: number;
  content: PinContent;
};

/** Where one page of `listDueDeadlines` ended: its last row, in the page's own order. */
export type DueDeadlineCursor = { at: number; key: string; sessionId: string };

/** Why an operator's deadline change was refused (#6452). */
export type PinDeadlineRefusal = "not_open" | "no_pick";

export type PinDeadlineOutcome =
  | { pin: Pin; changed: boolean }
  | { refused: PinDeadlineRefusal };

/** The SQL assignments for a deadline state; bind them with `deadlineParams`. */
const DEADLINE_ASSIGN =
  "deadline_at = ?, deadline_by = ?, deadline_revision = ?, deadline_id = ?, deadline_changed_at = ?";

function deadlineParams(
  state: DeadlineState
): [number | null, string | null, number | null, string | null, number | null] {
  return [state.at, state.by, state.revision, state.id, state.changedAt];
}

function deadlineOf(row: PinRow): DeadlineState {
  return {
    at: row.deadline_at ?? null,
    by: row.deadline_by ?? null,
    revision: row.deadline_revision ?? null,
    id: row.deadline_id ?? null,
    changedAt: row.deadline_changed_at ?? null,
  };
}

const newDeadlineId = (): string => randomUUID();

export type PinUpsertOptions = {
  /** Re-ask a closed pin, which otherwise refuses changed content. */
  reopen?: boolean;
  /** `pin_update`: an absent key is an error rather than a create. */
  mustExist?: boolean;
  /** Set on creation only: jump-to-chat means where the pin was first raised. */
  postedSeq?: number | null;
  anchor?: PinAnchor | null;
  now?: number;
};

export type PinUpsertOutcome =
  | { pin: Pin; change: "created" | "updated" | null }
  /** Changed content on an answered or dismissed pin, with no `reopen`. */
  | { closed: Pin }
  | { missing: true }
  | { capped: "open" | "total" };

export type PinAnswerInput = {
  /** The revision answered. Omitted means the current one. */
  revision?: number;
  option?: string;
  text?: string;
  note?: string;
  by: PinAnswerBy;
  /** Where it was made: `pins`, `chat`, `deadline`, or `inbox`. */
  via: string;
  /** False for a question-first entry, which leaves the pin open. */
  resolves?: boolean;
  /**
   * The option's label as the operator saw it (#6450), kept when the option is
   * gone from the current revision, so a moot answer still says what was chosen.
   */
  label?: string;
  /** Steps progress the operator reported (#6450), read back by later Submits. */
  steps?: { done: number; total: number };
  /** The submission this answer came in (#6450), so a retry records it once. */
  submission?: string;
  /**
   * The session the answer was delivered to, when relayed to the stopped
   * session's Project Manager (#6454).
   */
  deliveredTo?: string;
  now?: number;
};

export type PinAnswerOutcome =
  | { pin: Pin; moot: boolean }
  | { unknownOption: string };

/** One answer of a batch: the pin's key plus its answer. */
export type PinBatchAnswer = PinAnswerInput & { key: string };

export type PinBatchOutcome = {
  key: string;
  /** Null for an absent key; `duplicate` when this submission was already recorded. */
  result: PinAnswerOutcome | { duplicate: Pin } | null;
};

export type PinListOptions = { status?: PinStatus; limit?: number };

/** A pin with an unreported Save, and the save's time, for the compare-and-set (#6453). */
export type PendingSave = { pin: Pin; savedAt: number };

/**
 * Trim a history toward its caps, oldest first, but never drop the answer that
 * settled the pin or the newest, because 20 moot resolves would otherwise erase
 * the operator's real answer. Those two alone can exceed 8 KiB, so the byte cap
 * bounds everything else. A history outside the caps made a 500-pin list 80 MB.
 *
 * Nor an entry of `submission` (#6450): a Submit's questions, note and answer for
 * one pin are recorded whole, so its own later entries never evict its earlier
 * ones. Older history goes first; the next submission may trim this one.
 */
function trimAnswers(answers: PinAnswer[], submission?: string): PinAnswer[] {
  const settling = settlingAnswer(answers);
  const newest = answers[answers.length - 1];
  const kept = [...answers];
  const fits = (): boolean =>
    kept.length <= PIN_MAX_ANSWERS &&
    Buffer.byteLength(JSON.stringify(kept)) <= PIN_ANSWERS_MAX_BYTES;
  const protectedEntry = (a: PinAnswer): boolean =>
    a === settling ||
    a === newest ||
    (submission !== undefined && a.submission === submission);
  while (!fits()) {
    const drop = kept.findIndex(a => !protectedEntry(a));
    if (drop === -1) break;
    kept.splice(drop, 1);
  }
  return kept;
}

/** Statuses that refuse changed content unless the caller asks to re-open. */
const STICKY_STATUSES: ReadonlySet<PinStatus> = new Set([
  "answered",
  "auto-answered",
  "dismissed",
]);

/** The key after every key starting `prefix`: its last character, plus one. */
function prefixEnd(prefix: string): string {
  return (
    prefix.slice(0, -1) +
    String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
  );
}

/**
 * Every server-owned key prefix (#6455) as a key range, built from
 * `PIN_RESERVED_KEY_PREFIXES` so a new prefix is covered here too. A range on
 * the case-sensitive `key` column is exact: `prompt:` sorts before `prompt;`,
 * where SQLite's `LIKE` ignores ASCII case and would also match an agent's
 * `Prompt:x`.
 */
const RESERVED_KEY_RANGES = `(${PIN_RESERVED_KEY_PREFIXES.map(
  prefix => `(key >= '${prefix}' AND key < '${prefixEnd(prefix)}')`
).join(" OR ")})`;

/** A live pin's identity, without its JSON columns (#6454). */
export type PinLiveRef = {
  sessionId: string;
  key: string;
  revision: number;
  updatedAt: number;
};

/** A pin a turn check reads, without its JSON columns (#6455). */
export type PinTurnCandidate = {
  key: string;
  status: PinStatus;
  createdAt: number;
  updatedAt: number;
};

/** A dashboard is never answered, so it is `live` and never counts as open. */
function activeStatusFor(content: PinContent): PinStatus {
  return content.kind === "dashboard" ? "live" : "open";
}

function isActive(status: PinStatus): boolean {
  return status === "open" || status === "live";
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A Save the agent has not yet been told about (#6453). */
function isSaveReportPending(
  row: Pick<PinRow, "saved_at" | "save_reported_at">
): boolean {
  const savedAt = row.saved_at ?? null;
  if (savedAt === null) return false;
  const reportedAt = row.save_reported_at ?? null;
  return reportedAt === null || reportedAt < savedAt;
}

/**
 * A note as stored: within the read schema's cap. Cleaning can lengthen a note
 * that arrived at the cap (an approval token becomes a longer placeholder), and
 * one oversized note would make every read of the session's pins fail (#6450).
 * Never splits a surrogate pair.
 */
function clampNote(note: string): string {
  if (note.length <= PIN_ANSWER_NOTE_MAX_CHARS) return note;
  let end = PIN_ANSWER_NOTE_MAX_CHARS;
  const last = note.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return note.slice(0, end);
}

/**
 * SQLite-backed persistence for session pins (issue #6447, epic #6446). The class
 * shape follows `bookmarkStore.ts`, and the rest deliberately does not: bookmarks
 * are node-local and FK-less, and their rows outlive the session. A pin is always
 * written on the node that owns its session (the routes proxy there), so the row
 * lives beside its session row, and `ON DELETE CASCADE` removes it through every
 * delete path. The table is created by `runMigrations` in `store/index.ts`.
 *
 * Server-owned fields are columns, and the agent-authored content is one canonical
 * JSON column. A later sub-issue adds content fields with no migration, and
 * "content changed" stays one string comparison, so a new field cannot silently
 * stop revision bumps. Emits no events: `sync/pinService.ts` does that.
 */
export class PinStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  private rowToPin(row: PinRow): Pin {
    const content = JSON.parse(row.content_json) as PinContent;
    // #6452: a running pick only, so every reader (the timeline, the agent's
    // pin_get) sees null for a pin that cannot fire: closed, no eligible pick
    // (removed, which suspends it), or turned off.
    const running =
      row.status === "open" &&
      row.deadline_at !== null &&
      row.deadline_at !== undefined &&
      row.deadline_by !== "off" &&
      isAutoPickEligible(content);
    return {
      ...content,
      sessionId: row.session_id,
      sourceSessionId: row.session_id,
      revision: row.revision,
      status: row.status,
      starred: row.starred === 1,
      seenAt: row.seen_at === null ? null : iso(row.seen_at),
      seenRevision: row.seen_revision,
      postedSeq: row.posted_seq,
      anchor: row.anchor_json
        ? (JSON.parse(row.anchor_json) as PinAnchor)
        : null,
      answers: JSON.parse(row.answers_json) as PinAnswer[],
      savedTo: row.saved_to ?? null,
      savedRevision: row.saved_revision ?? null,
      saveReportPending: isSaveReportPending(row),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      deadlineAt: running ? iso(row.deadline_at as number) : null,
      deadlineBy: row.deadline_by ?? null,
      // Pending only while there is something to report (a running time, or
      // off), the same rule the Submit's report reads: a pick the agent has
      // since removed has nothing to say, so it must not hold a Submit open.
      deadlineReportPending:
        (running || row.deadline_by === "off") &&
        isDeadlineReportPending(
          row.deadline_changed_at ?? null,
          row.deadline_reported_at ?? null
        ),
    };
  }

  private getRow(sessionId: string, key: string): PinRow | null {
    return this.db
      .prepare("SELECT * FROM session_pins WHERE session_id = ? AND key = ?")
      .get(sessionId, key) as PinRow | null;
  }

  /**
   * A session's pins, active ones first, then oldest first. Bounded, because a
   * client may refetch the list: `hasMore` says more exist past the limit.
   */
  list(
    sessionId: string,
    options: PinListOptions = {}
  ): { pins: Pin[]; hasMore: boolean } {
    const limit = options.limit ?? PIN_LIST_DEFAULT_LIMIT;
    const statusClause = options.status ? "AND status = ?" : "";
    const params: (string | number)[] = options.status
      ? [sessionId, options.status, limit + 1]
      : [sessionId, limit + 1];
    // Sort the keys, then read the rows, so the sorter never carries the JSON columns.
    const keys = this.db
      .prepare(
        `SELECT key FROM session_pins WHERE session_id = ? ${statusClause}
         ORDER BY CASE WHEN status IN ('open', 'live') THEN 0 ELSE 1 END,
                  created_at ASC, key ASC
         LIMIT ?`
      )
      .all(...params) as { key: string }[];
    const pins: Pin[] = [];
    for (const { key } of keys.slice(0, limit)) {
      const row = this.getRow(sessionId, key);
      if (row) pins.push(this.rowToPin(row));
    }
    return { pins, hasMore: keys.length > limit };
  }

  get(sessionId: string, key: string): Pin | null {
    const row = this.getRow(sessionId, key);
    return row ? this.rowToPin(row) : null;
  }

  /**
   * Post or re-post a pin by key. A no-op never takes the write lock, because a
   * looping agent re-posts every tick. Everything
   * else re-decides inside `.immediate()`, because the first read is only an
   * optimization and a deferred read-then-write returns SQLITE_BUSY without
   * waiting (#3631).
   *
   * | Prior status                       | Same content      | Changed content                 |
   * |------------------------------------|-------------------|---------------------------------|
   * | open, live                         | no-op             | revision +1                     |
   * | answered, auto-answered, dismissed | no-op             | refused; `reopen` re-opens, +1  |
   * | withdrawn                          | re-opens, same rev | re-opens, revision +1          |
   *
   * A closed pin refuses changed content because agents regenerate their text
   * after a compaction, and a tick carrying a timestamp would otherwise re-ask the
   * operator forever. A withdrawn pin re-opens because only the agent withdraws, so
   * a re-post is a deliberate re-raise.
   */
  upsert(
    sessionId: string,
    content: PinContent,
    options: PinUpsertOptions = {}
  ): PinUpsertOutcome {
    const canonical = canonicalJson(content);
    const early = this.settleWithoutWrite(
      this.getRow(sessionId, content.key),
      canonical,
      options
    );
    if (early) return early;

    const run = this.db.transaction((): PinUpsertOutcome => {
      const row = this.getRow(sessionId, content.key);
      const settled = this.settleWithoutWrite(row, canonical, options);
      if (settled) return settled;
      const now = options.now ?? Date.now();
      return row
        ? this.applyUpdate(row, content, canonical, now)
        : this.applyCreate(sessionId, content, canonical, options, now);
    });
    return run.immediate();
  }

  /** The outcomes that write nothing, or null when a write is due. */
  private settleWithoutWrite(
    row: PinRow | null,
    canonical: string,
    options: PinUpsertOptions
  ): PinUpsertOutcome | null {
    if (!row) return options.mustExist ? { missing: true } : null;
    const same = row.content_json === canonical;
    // `reopen` only re-asks with changed content, so a loop that keeps passing it
    // cannot re-ask a question the operator already answered.
    if (same && (STICKY_STATUSES.has(row.status) || isActive(row.status))) {
      return { pin: this.rowToPin(row), change: null };
    }
    if (STICKY_STATUSES.has(row.status) && !options.reopen) {
      return { closed: this.rowToPin(row) };
    }
    return null;
  }

  private applyCreate(
    sessionId: string,
    content: PinContent,
    canonical: string,
    options: PinUpsertOptions,
    now: number
  ): PinUpsertOutcome {
    const status = activeStatusFor(content);
    if (
      status === "open" &&
      this.countOpen(sessionId) >= PIN_MAX_OPEN_PER_SESSION
    ) {
      return { capped: "open" };
    }
    if (!this.makeRoomFor(sessionId)) return { capped: "total" };
    // #6452: the deadline is computed once, here, from the duration.
    const deadline = reconcileDeadline({
      prev: NO_DEADLINE,
      prevContent: null,
      next: content,
      transition: "create",
      revision: 1,
      now,
      newId: newDeadlineId,
    });
    this.db
      .prepare(
        `INSERT INTO session_pins
           (session_id, key, status, revision, posted_seq, anchor_json,
            content_json, created_at, updated_at,
            deadline_at, deadline_by, deadline_revision, deadline_id, deadline_changed_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sessionId,
        content.key,
        status,
        options.postedSeq ?? null,
        options.anchor ? JSON.stringify(options.anchor) : null,
        canonical,
        now,
        now,
        ...deadlineParams(deadline)
      );
    return {
      pin: this.rowToPin(this.getRow(sessionId, content.key) as PinRow),
      change: "created",
    };
  }

  private applyUpdate(
    row: PinRow,
    content: PinContent,
    canonical: string,
    now: number
  ): PinUpsertOutcome {
    const status = activeStatusFor(content);
    // Any route into `open` counts, or a dashboard re-posted as a decision escapes it.
    if (
      status === "open" &&
      row.status !== "open" &&
      this.countOpen(row.session_id) >= PIN_MAX_OPEN_PER_SESSION
    ) {
      return { capped: "open" };
    }
    const revision =
      row.content_json === canonical ? row.revision : row.revision + 1;
    // A re-raised question is new again, even at an unchanged revision.
    const seen = isActive(row.status)
      ? ""
      : "seen_at = NULL, seen_revision = NULL, ";
    // #6452: which transition this write is decides how the deadline moves.
    const transition: DeadlineTransition =
      row.status === "withdrawn"
        ? "reraise-withdrawn"
        : STICKY_STATUSES.has(row.status)
          ? "reopen-settled"
          : "update";
    const deadline = reconcileDeadline({
      prev: deadlineOf(row),
      prevContent: JSON.parse(row.content_json) as PinContent,
      next: content,
      transition,
      revision,
      now,
      newId: newDeadlineId,
    });
    this.db
      .prepare(
        `UPDATE session_pins
         SET ${seen}status = ?, revision = ?, content_json = ?, updated_at = ?,
             ${DEADLINE_ASSIGN}
         WHERE session_id = ? AND key = ?`
      )
      .run(
        status,
        revision,
        canonical,
        now,
        ...deadlineParams(deadline),
        row.session_id,
        row.key
      );
    return {
      pin: this.rowToPin(this.getRow(row.session_id, row.key) as PinRow),
      change: "updated",
    };
  }

  /**
   * At the total cap, evict the oldest closed, unstarred pin, because a new key
   * per tick must not stop a long-lived session from pinning. False when every pin
   * is still active or starred.
   */
  private makeRoomFor(sessionId: string): boolean {
    const { n } = this.db
      .prepare("SELECT COUNT(*) AS n FROM session_pins WHERE session_id = ?")
      .get(sessionId) as { n: number };
    if (n < PIN_MAX_PER_SESSION) return true;
    // #6455: a closed pin the server raised (a mirrored prompt, a detected ask) goes
    // first, so a permission-heavy session never evicts the operator's answers.
    const reserved = this.db
      .prepare(
        `DELETE FROM session_pins WHERE rowid = (
           SELECT rowid FROM session_pins
           WHERE session_id = ? AND status NOT IN ('open', 'live') AND starred = 0
             AND ${RESERVED_KEY_RANGES}
           ORDER BY updated_at ASC, key ASC LIMIT 1
         )`
      )
      .run(sessionId);
    if (reserved.changes > 0) return true;
    const evicted = this.db
      .prepare(
        `DELETE FROM session_pins WHERE rowid = (
           SELECT rowid FROM session_pins
           WHERE session_id = ? AND status NOT IN ('open', 'live') AND starred = 0
           ORDER BY updated_at ASC, key ASC LIMIT 1
         )`
      )
      .run(sessionId);
    return evicted.changes > 0;
  }

  /** The agent takes its question back. Null for an absent key; no-op once closed. */
  withdraw(
    sessionId: string,
    key: string,
    now: number = Date.now()
  ): { pin: Pin; changed: boolean } | null {
    return this.closeActive(sessionId, key, "withdrawn", now);
  }

  /** The operator clears a pin. Null for an absent key; no-op once closed. */
  dismiss(
    sessionId: string,
    key: string,
    now: number = Date.now()
  ): { pin: Pin; changed: boolean } | null {
    return this.closeActive(sessionId, key, "dismissed", now);
  }

  private closeActive(
    sessionId: string,
    key: string,
    status: PinStatus,
    now: number
  ): { pin: Pin; changed: boolean } | null {
    // Read first, so a no-op never waits on the write lock on the JS thread.
    const row = this.getRow(sessionId, key);
    if (!row) return null;
    if (!isActive(row.status))
      return { pin: this.rowToPin(row), changed: false };
    // #6452: a closed pin's deadline can never fire; `deadline_by` stays, because
    // an operator's "off" survives a withdraw and re-post.
    const result = this.db
      .prepare(
        `UPDATE session_pins SET status = ?, updated_at = ?, deadline_at = NULL
         WHERE session_id = ? AND key = ? AND status IN ('open', 'live')`
      )
      .run(status, now, sessionId, key);
    return {
      pin: this.rowToPin(this.getRow(sessionId, key) as PinRow),
      changed: result.changes > 0,
    };
  }

  /**
   * Record an answer. Every answer stays in the history and names the revision it
   * answered. One made against any revision but the current one, or on a closed
   * pin, is `moot` and
   * changes no status, so an answer can never settle a question it did not see. A
   * `resolves: false` entry (a question asked first) also leaves the status alone,
   * and a dashboard stays `live`, because it is never answered. Null for an absent
   * key.
   */
  answer(
    sessionId: string,
    key: string,
    input: PinAnswerInput
  ): PinAnswerOutcome | null {
    const run = this.db.transaction((): PinAnswerOutcome | null =>
      this.answerRow(sessionId, key, input)
    );
    return run.immediate();
  }

  /**
   * Record a submission's answers in ONE transaction (#6450), in order, so the
   * operator's Submit is all-or-nothing in the store. A pin that already holds an
   * answer from this `submission` records nothing (a retry after a lost response),
   * decided before any write so a pin's several entries in one batch (questions
   * then a choice) are not mistaken for a repeat.
   */
  answerBatch(
    sessionId: string,
    submission: string,
    items: readonly PinBatchAnswer[]
  ): PinBatchOutcome[] {
    const run = this.db.transaction((): PinBatchOutcome[] => {
      const recorded = new Set<string>();
      for (const key of new Set(items.map(item => item.key))) {
        const row = this.getRow(sessionId, key);
        const answers = row
          ? (JSON.parse(row.answers_json) as PinAnswer[])
          : [];
        if (answers.some(a => a.submission === submission)) recorded.add(key);
      }
      return items.map(item => {
        if (recorded.has(item.key)) {
          const row = this.getRow(sessionId, item.key);
          return {
            key: item.key,
            result: row ? { duplicate: this.rowToPin(row) } : null,
          };
        }
        return {
          key: item.key,
          result: this.answerRow(sessionId, item.key, { ...item, submission }),
        };
      });
    });
    return run.immediate();
  }

  /** `answer` without its transaction; the caller holds one. */
  private answerRow(
    sessionId: string,
    key: string,
    input: PinAnswerInput
  ): PinAnswerOutcome | null {
    const row = this.getRow(sessionId, key);
    if (!row) return null;

    const now = input.now ?? Date.now();
    const revision = input.revision ?? row.revision;
    const resolves = input.resolves !== false;
    const moot = !isActive(row.status) || revision !== row.revision;

    // Only a live question can refuse an option: a moot answer names a revision
    // that may have offered one the current revision removed.
    const content = JSON.parse(row.content_json) as PinContent;
    const option =
      input.option === undefined
        ? undefined
        : content.options?.find(o => o.id === input.option);
    if (input.option !== undefined && !option && !moot) {
      return { unknownOption: input.option };
    }
    // The current revision's label wins for a live answer; the operator's
    // snapshot names an option a later revision dropped.
    const label =
      option && !moot
        ? option.label
        : (input.label ?? (option ? option.label : undefined));

    const entry: PinAnswer = {
      revision,
      at: iso(now),
      by: input.by,
      via: input.via,
      ...(input.option !== undefined ? { option: input.option } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.note !== undefined ? { note: clampNote(input.note) } : {}),
      ...(input.steps ? { steps: input.steps } : {}),
      ...(input.submission !== undefined
        ? { submission: input.submission }
        : {}),
      ...(input.deliveredTo !== undefined
        ? { deliveredTo: input.deliveredTo }
        : {}),
      resolves,
      moot,
    };
    const answers = [...(JSON.parse(row.answers_json) as PinAnswer[]), entry];
    const settles = resolves && !moot && row.status === "open";
    const status: PinStatus = !settles
      ? row.status
      : input.by === "auto"
        ? "auto-answered"
        : "answered";
    // #6452: a settled pin's deadline is cleared in the same statement, so it can
    // never fire after the answer.
    this.db
      .prepare(
        `UPDATE session_pins
         SET status = ?, answers_json = ?, updated_at = ?,
             deadline_at = CASE WHEN ? THEN NULL ELSE deadline_at END
         WHERE session_id = ? AND key = ?`
      )
      .run(
        status,
        JSON.stringify(trimAnswers(answers, input.submission)),
        settles ? now : row.updated_at,
        settles ? 1 : 0,
        sessionId,
        key
      );
    return {
      pin: this.rowToPin(this.getRow(sessionId, key) as PinRow),
      moot,
    };
  }

  /** Star or unstar. Leaves `updated_at` alone, because #6451 sorts by it. */
  setStarred(
    sessionId: string,
    key: string,
    starred: boolean
  ): { pin: Pin; changed: boolean } | null {
    const row = this.getRow(sessionId, key);
    if (!row) return null;
    const value = starred ? 1 : 0;
    if (row.starred === value) {
      return { pin: this.rowToPin(row), changed: false };
    }
    const result = this.db
      .prepare(
        "UPDATE session_pins SET starred = ? WHERE session_id = ? AND key = ? AND starred != ?"
      )
      .run(value, sessionId, key, value);
    return {
      pin: this.rowToPin(this.getRow(sessionId, key) as PinRow),
      changed: result.changes > 0,
    };
  }

  /**
   * Record "Save to session folder" (#6453): where the files went, the revision
   * saved, and a new unreported save. Leaves `updated_at` and `revision` alone,
   * like the star, and is never a no-op, because each Save is new news for the
   * agent.
   */
  setSaved(
    sessionId: string,
    key: string,
    save: { savedTo: string; revision: number; now?: number }
  ): { pin: Pin; changed: boolean } | null {
    const result = this.db
      .prepare(
        `UPDATE session_pins SET saved_to = ?, saved_revision = ?, saved_at = ?
         WHERE session_id = ? AND key = ?`
      )
      .run(save.savedTo, save.revision, save.now ?? Date.now(), sessionId, key);
    if (result.changes === 0) return null;
    return {
      pin: this.rowToPin(this.getRow(sessionId, key) as PinRow),
      changed: true,
    };
  }

  /**
   * The agent has been told about these saves (#6453). Compare-and-set on the
   * `saved_at` the message reported, so a Save that lands while a Submit is being
   * sent stays pending and rides the next one. Silent; one transaction.
   */
  markSavesReported(sessionId: string, saves: readonly PendingSave[]): void {
    if (saves.length === 0) return;
    const update = this.db.prepare(
      `UPDATE session_pins SET save_reported_at = saved_at
       WHERE session_id = ? AND key = ? AND saved_at = ?`
    );
    this.db.transaction(() => {
      for (const { pin, savedAt } of saves) {
        update.run(sessionId, pin.key, savedAt);
      }
    })();
  }

  /** The session's pins whose last Save the agent has not yet heard about (#6453). */
  listPendingSaves(sessionId: string): PendingSave[] {
    const keys = this.db
      .prepare(
        `SELECT key FROM session_pins
         WHERE session_id = ? AND saved_at IS NOT NULL
           AND (save_reported_at IS NULL OR save_reported_at < saved_at)
         ORDER BY key ASC`
      )
      .all(sessionId) as { key: string }[];
    const saves: PendingSave[] = [];
    for (const { key } of keys) {
      const row = this.getRow(sessionId, key);
      if (row && row.saved_at !== null && isSaveReportPending(row)) {
        saves.push({ pin: this.rowToPin(row), savedAt: row.saved_at });
      }
    }
    return saves;
  }

  /**
   * Mark the current revision seen, so "new or changed" is exactly
   * `seenRevision === null || seenRevision < revision`. Leaves `updated_at` alone.
   */
  markSeen(
    sessionId: string,
    key: string,
    now: number = Date.now()
  ): { pin: Pin; changed: boolean } | null {
    // Read first, because this fires whenever the user opens a pin.
    const row = this.getRow(sessionId, key);
    if (!row) return null;
    if (row.seen_revision === row.revision) {
      return { pin: this.rowToPin(row), changed: false };
    }
    const result = this.db
      .prepare(
        `UPDATE session_pins SET seen_at = ?, seen_revision = revision
         WHERE session_id = ? AND key = ?
           AND (seen_revision IS NULL OR seen_revision != revision)`
      )
      .run(now, sessionId, key);
    return {
      pin: this.rowToPin(this.getRow(sessionId, key) as PinRow),
      changed: result.changes > 0,
    };
  }

  // ── Automatic picks (#6452) ───────────────────────────────────────────────

  /** A pin's deadline with its status, revision and content, or null for an absent key. */
  getDeadlineRow(sessionId: string, key: string): PinDeadlineRow | null {
    const row = this.getRow(sessionId, key);
    if (!row) return null;
    return {
      deadline: deadlineOf(row),
      sessionId: row.session_id,
      key: row.key,
      status: row.status,
      revision: row.revision,
      content: JSON.parse(row.content_json) as PinContent,
    };
  }

  /**
   * The operator moves the pick to an instant, turns a stopped pick back on (a
   * move), or turns it off. Refused unless the pin is open and carries an
   * eligible pick. Leaves `updated_at` and the revision alone: it is not a
   * content change. The caller validates the instant's range.
   */
  setDeadline(
    sessionId: string,
    key: string,
    request: { at: number } | { off: true },
    now: number = Date.now()
  ): PinDeadlineOutcome | null {
    const run = this.db.transaction((): PinDeadlineOutcome | null => {
      const row = this.getRow(sessionId, key);
      if (!row) return null;
      if (row.status !== "open") return { refused: "not_open" };
      const content = JSON.parse(row.content_json) as PinContent;
      if (!isAutoPickEligible(content)) return { refused: "no_pick" };
      const prev = deadlineOf(row);
      const next = operatorDeadline(
        prev,
        request,
        row.revision,
        now,
        newDeadlineId
      );
      if (prev.at === next.at && prev.by === next.by) {
        return { pin: this.rowToPin(row), changed: false };
      }
      this.writeDeadline(row, next);
      return {
        pin: this.rowToPin(this.getRow(sessionId, key) as PinRow),
        changed: true,
      };
    });
    return run.immediate();
  }

  /**
   * One page of the due deadlines on this node, soonest first, strictly after
   * `after` when given, so a caller can read them all in pages. Literal 'open'
   * keeps the partial index.
   */
  listDueDeadlines(
    now: number,
    limit = 500,
    after?: DueDeadlineCursor
  ): Array<{ sessionId: string; key: string; at: number }> {
    const rows = (
      after
        ? this.db
            .prepare(
              `SELECT session_id, key, deadline_at FROM session_pins
               WHERE status = 'open' AND deadline_at IS NOT NULL AND deadline_at <= ?
                 AND (deadline_at, key, session_id) > (?, ?, ?)
               ORDER BY deadline_at ASC, key ASC, session_id ASC LIMIT ?`
            )
            .all(now, after.at, after.key, after.sessionId, limit)
        : this.db
            .prepare(
              `SELECT session_id, key, deadline_at FROM session_pins
               WHERE status = 'open' AND deadline_at IS NOT NULL AND deadline_at <= ?
               ORDER BY deadline_at ASC, key ASC, session_id ASC LIMIT ?`
            )
            .all(now, limit)
    ) as Array<{
      session_id: string;
      key: string;
      deadline_at: number;
    }>;
    return rows.map(row => ({
      sessionId: row.session_id,
      key: row.key,
      at: row.deadline_at,
    }));
  }

  /** The soonest deadline still in the future, for the loop's next wake. */
  nextFutureDeadlineAt(now: number): number | null {
    const row = this.db
      .prepare(
        `SELECT MIN(deadline_at) AS at FROM session_pins
         WHERE status = 'open' AND deadline_at IS NOT NULL AND deadline_at > ?`
      )
      .get(now) as { at: number | null } | null;
    return row?.at ?? null;
  }

  /**
   * Arm the open pins that carry a pick but were never armed: those written by a
   * build without #6452. From now, never from `created_at`, which would fire a
   * long-open pin at once. Returns how many it armed.
   */
  armMissingDeadlines(now: number = Date.now()): number {
    const rows = this.db
      .prepare(
        `SELECT * FROM session_pins
         WHERE status = 'open' AND deadline_by IS NULL AND deadline_at IS NULL
           AND content_json LIKE '%"ifUnanswered"%'`
      )
      .all() as PinRow[];
    let armed = 0;
    for (const row of rows) {
      const content = JSON.parse(row.content_json) as PinContent;
      const next = reconcileDeadline({
        prev: NO_DEADLINE,
        prevContent: null,
        next: content,
        transition: "create",
        revision: row.revision,
        now,
        newId: newDeadlineId,
      });
      if (next.at === null) continue;
      this.writeDeadline(row, next);
      armed++;
    }
    return armed;
  }

  /**
   * Record the automatic answer: `by: "auto"`, `via: "deadline"`. Settling it
   * clears the deadline in the same statement. Callers run this inside the send
   * transaction, where `.immediate()` nests as a savepoint.
   */
  recordAutomaticPick(
    sessionId: string,
    key: string,
    input: { option: string; revision: number; submission: string; now: number }
  ): PinAnswerOutcome | null {
    const run = this.db.transaction((): PinAnswerOutcome | null =>
      this.answerRow(sessionId, key, {
        by: "auto",
        via: "deadline",
        option: input.option,
        revision: input.revision,
        submission: input.submission,
        now: input.now,
      })
    );
    return run.immediate();
  }

  /** Move a running deadline (a late pick, ruling D2). Keeps who set it; new id. */
  rescheduleDeadline(
    sessionId: string,
    key: string,
    at: number
  ): { pin: Pin; changed: boolean } | null {
    const row = this.getRow(sessionId, key);
    if (!row) return null;
    this.writeDeadline(row, { ...deadlineOf(row), at, id: newDeadlineId() });
    return {
      pin: this.rowToPin(this.getRow(sessionId, key) as PinRow),
      changed: true,
    };
  }

  /** Re-reconcile a pin whose revision moved outside these rules, without firing. */
  refreshForeignDeadline(
    sessionId: string,
    key: string,
    now: number = Date.now()
  ): { pin: Pin; changed: boolean } | null {
    const row = this.getRow(sessionId, key);
    if (!row) return null;
    const content = JSON.parse(row.content_json) as PinContent;
    this.writeDeadline(
      row,
      reconcileForeignEdit(
        deadlineOf(row),
        content,
        row.revision,
        now,
        newDeadlineId
      )
    );
    return {
      pin: this.rowToPin(this.getRow(sessionId, key) as PinRow),
      changed: true,
    };
  }

  /** Stop a deadline whose stored content fails the rule (defense in depth). */
  clearDeadline(sessionId: string, key: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE session_pins SET deadline_at = NULL WHERE session_id = ? AND key = ? AND deadline_at IS NOT NULL"
      )
      .run(sessionId, key);
    return result.changes > 0;
  }

  /**
   * An operator's question or note on a pin with a running pick turns it off
   * (ruling D3). Null for an absent key; `changed: false` when nothing was running.
   */
  setDeadlineOffForQuestion(
    sessionId: string,
    key: string,
    now: number = Date.now()
  ): { pin: Pin; changed: boolean } | null {
    const row = this.getRow(sessionId, key);
    if (!row) return null;
    const prev = deadlineOf(row);
    if (row.status !== "open" || prev.at === null || prev.by === "off") {
      return { pin: this.rowToPin(row), changed: false };
    }
    this.writeDeadline(row, deadlineOffForQuestion(prev, now));
    return {
      pin: this.rowToPin(this.getRow(sessionId, key) as PinRow),
      changed: true,
    };
  }

  /** Open pins whose operator change a Submit has not yet told the agent (ruling D5). */
  listDeadlineReportPending(sessionId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT key FROM session_pins
         WHERE session_id = ? AND status = 'open' AND deadline_changed_at IS NOT NULL
           AND (deadline_reported_at IS NULL OR deadline_reported_at < deadline_changed_at)
         ORDER BY created_at ASC, key ASC`
      )
      .all(sessionId) as Array<{ key: string }>;
    return rows.map(row => row.key);
  }

  /**
   * A Submit told the agent about these pins' changes. Each names the change it
   * reported (`changedAt`), and only that change is marked: one the operator made
   * while the Submit was sending stays pending for the next.
   */
  markDeadlinesReported(
    sessionId: string,
    reports: ReadonlyArray<{ key: string; changedAt: number }>
  ): void {
    const stmt = this.db.prepare(
      `UPDATE session_pins SET deadline_reported_at = ?
       WHERE session_id = ? AND key = ? AND deadline_changed_at = ?`
    );
    for (const { key, changedAt } of reports) {
      stmt.run(changedAt, sessionId, key, changedAt);
    }
  }

  private writeDeadline(row: PinRow, state: DeadlineState): void {
    this.db
      .prepare(
        `UPDATE session_pins SET ${DEADLINE_ASSIGN} WHERE session_id = ? AND key = ?`
      )
      .run(...deadlineParams(state), row.session_id, row.key);
  }

  countOpen(sessionId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM session_pins WHERE session_id = ? AND status = 'open'"
      )
      .get(sessionId) as { n: number };
    return row.n;
  }

  /**
   * Open counts for every session, one covering-index scan. Always group here and
   * look up by session id in the caller, with no `JOIN sessions`: this form has one
   * stable plan, while the join's cost depended on the planner (about 3 ms in one
   * run and 797 ms in another, on the same data).
   */
  countOpenBySession(): Map<string, number> {
    const rows = this.db
      .prepare(
        "SELECT session_id, COUNT(*) AS n FROM session_pins WHERE status = 'open' GROUP BY session_id"
      )
      .all() as Array<{ session_id: string; n: number }>;
    return new Map(rows.map(row => [row.session_id, row.n]));
  }

  /**
   * Open pins the agent owns (#6454): the count the archive response carries, so
   * the server's mirrored `prompt:` and `detected:` pins do not inflate it. (The
   * Disconnect confirm counts every open pin, mirrored ones included.) Reads no
   * JSON.
   */
  countOpenAgentPins(sessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM session_pins
         WHERE session_id = ? AND status = 'open' AND NOT ${RESERVED_KEY_RANGES}`
      )
      .get(sessionId) as { n: number };
    return row.n;
  }

  /**
   * Every live pin, newest first, without its JSON (#6454). Only a dashboard is
   * ever `live` (`activeStatusFor`), so this lists the Project Manager
   * dashboards; the caller filters by namespace before it reads any content.
   * Served by `idx_session_pins_live`.
   */
  listLiveRefs(): PinLiveRef[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, key, revision, updated_at FROM session_pins
         WHERE status = 'live' ORDER BY updated_at DESC`
      )
      .all() as Array<
      Pick<PinRow, "session_id" | "key" | "revision" | "updated_at">
    >;
    return rows.map(row => ({
      sessionId: row.session_id,
      key: row.key,
      revision: row.revision,
      updatedAt: row.updated_at,
    }));
  }

  /** Keys starting `prefix`, optionally in one status (#6455). Reads no JSON. */
  listKeysByPrefix(
    sessionId: string,
    prefix: string,
    status?: PinStatus
  ): string[] {
    const statusClause = status ? "AND status = ?" : "";
    const params: string[] = [sessionId, prefix, prefixEnd(prefix)];
    if (status) params.push(status);
    const rows = this.db
      .prepare(
        `SELECT key FROM session_pins
         WHERE session_id = ? AND key >= ? AND key < ? ${statusClause}
         ORDER BY created_at ASC, key ASC`
      )
      .all(...params) as Array<{ key: string }>;
    return rows.map(row => row.key);
  }

  /**
   * What a turn check reads (#6455): every open pin the agent owns, with its
   * timestamps, so the caller can tell one created or revised this turn from an
   * older one. Open, so a dashboard (always `live`) is never a match; never a
   * server-owned key. Reads no JSON.
   */
  listTurnCandidates(sessionId: string): PinTurnCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT key, status, created_at, updated_at FROM session_pins
         WHERE session_id = ? AND status = 'open' AND NOT ${RESERVED_KEY_RANGES}`
      )
      .all(sessionId) as Array<
      Pick<PinRow, "key" | "status" | "created_at" | "updated_at">
    >;
    return rows.map(row => ({
      key: row.key,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Delete closed, unstarred pins whose key starts `prefix`, keeping the newest
   * `keep` (#6455: a permission-heavy session's mirrored prompts). Returns what it
   * removed, so the service can tell clients each row is gone.
   */
  trimClosedByPrefix(
    sessionId: string,
    prefix: string,
    keep: number
  ): Array<{ key: string; status: PinStatus; revision: number }> {
    const run = this.db.transaction(() => {
      const doomed = this.db
        .prepare(
          `SELECT key, status, revision FROM session_pins
           WHERE session_id = ? AND key >= ? AND key < ?
             AND status NOT IN ('open', 'live') AND starred = 0
           ORDER BY updated_at DESC, key DESC LIMIT -1 OFFSET ?`
        )
        .all(sessionId, prefix, prefixEnd(prefix), keep) as Array<{
        key: string;
        status: PinStatus;
        revision: number;
      }>;
      const remove = this.db.prepare(
        "DELETE FROM session_pins WHERE session_id = ? AND key = ?"
      );
      for (const row of doomed) remove.run(sessionId, row.key);
      return doomed;
    });
    return run.immediate();
  }
}
