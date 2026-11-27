#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * pin-detector-eval-v1 (issue #6456, PR-2; R15): measure the shared ask rules
 * (`classifyDecisionSignals`, `DECISION_SIGNAL_RULES_VERSION`) over a corpus of
 * final assistant messages, a labelled sample of it, and a node's own database.
 * It reads rules version 4 (`@hapi/protocol/pinDecisionSignalsV4`), which ships
 * inert by board-26's ruling M3: the live classifier stays on rules 3, and this
 * script and PR-3's shadow detector are v4's only readers.
 *
 * The transcripts hold private material, so this script prints aggregates only:
 * counts per verdict and signal, the labelled table, and with `--db` the live
 * Detected pins and the turn table. It never prints a message's text, and it
 * refuses a path a git work tree could carry (below). The corpus, the labels
 * and any extract stay outside the repository; only this script and its
 * aggregate numbers are committed.
 *
 * Inputs:
 * - `--corpus` JSONL: one JSON object a line with a string `text` (other fields
 *   are ignored, so the #6527 corpus and an `--extract` file both read).
 * - `--labels` JSON: `{ SET: { CLASS: [position, …] } }`. A position counts in
 *   the sample list `SET` of `--sample` (`{ SET: [corpus index, …] }`); a class
 *   whose entries are pin IDs (`pin-…`) is read against `--db`'s Detected pins.
 *   Keys that start with `_` are notes, and a set with neither is reported as
 *   unresolved.
 * - `--db`: a node's `hapi.db`, opened read-only. `--since` (ISO or epoch ms,
 *   never seconds) bounds the pins and turns read.
 * - `--extract FOLDER` (with `--db`): write each ended turn's final assistant message
 *   to `FOLDER/corpus-v1.jsonl` (`{ n, at, text }`), the folder mode 700 and the
 *   file 600, so the RP1 half of the corpus run can be made on RP1.
 *
 * Paths: the corpus, labels, sample and extract folder must lie outside every
 * git work tree. The database is only read, so it may lie inside one only where
 * that work tree ignores it (RP1's `~/.hapimatic-private/hapi.db` sits in its
 * home repository, ignored); a database a repository could commit is refused.
 * When `git` cannot be run, every path is refused.
 */
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { findPinIds, isReservedPinKey, scanPinFences } from "@hapi/protocol";
import {
  answerKeyBlocks,
  classifyDecisionSignals,
  DECISION_SIGNAL_RULES_VERSION,
  isCoverableAnswerCode,
  type DecisionSignals,
  type DecisionVerdict,
} from "@hapi/protocol/pinDecisionSignalsV4";
import {
  extractUserFacingAssistantTexts,
  isStopHookFeedbackRecord,
} from "../src/sync/needsReviewContent";
import type { TurnStatus } from "../src/store/turns/types";
import { namesPinKey } from "../src/sync/pinTurnCheck";

export const PIN_DETECTOR_EVAL_VERSION = "pin-detector-eval-v1";

const HELP = `${PIN_DETECTOR_EVAL_VERSION}: the Pins ask rules over a corpus, its labels and a node's database (aggregates only)

Usage: bun run server/scripts/pin-detector-eval-v1.ts [options]

  --corpus FILE     JSONL of final assistant messages, each with a string "text"
  --labels FILE     JSON labels: { SET: { CLASS: [position or pin ID, ...] } }
  --sample FILE     JSON sample lists: { SET: [corpus index, ...] }
  --db FILE         a node's hapi.db, opened read-only
  --since ISO|ms    with --db: read pins and turns from this time (an ISO time,
                    or epoch milliseconds: 11 digits or more)
  --extract FOLDER  with --db: write each ended turn's final assistant message to
                    FOLDER/corpus-v1.jsonl (folder 700, file 600)
  --help            this text

Every path but --db must lie outside any git work tree; --db may lie in one only
where it is ignored. Nothing prints a message's text.
`;

export type EvalArgs = {
  corpus: string | null;
  labels: string | null;
  sample: string | null;
  db: string | null;
  since: number | null;
  extract: string | null;
  help: boolean;
};

/** A refusal or a usage error: exit code 2, with this message. */
export class EvalRefusal extends Error {}

export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  const args: EvalArgs = {
    corpus: null,
    labels: null,
    sample: null,
    db: null,
    since: null,
    extract: null,
    help: false,
  };
  const valued = new Set([
    "--corpus",
    "--labels",
    "--sample",
    "--db",
    "--since",
    "--extract",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === "--help" || raw === "-h") {
      args.help = true;
      continue;
    }
    const eq = raw.indexOf("=");
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    if (!valued.has(flag)) throw new EvalRefusal(`unknown option ${flag}`);
    const value = eq > 0 ? raw.slice(eq + 1) : argv[++i];
    if (value === undefined || value === "") {
      throw new EvalRefusal(`${flag} needs a value`);
    }
    switch (flag) {
      case "--corpus":
        args.corpus = value;
        break;
      case "--labels":
        args.labels = value;
        break;
      case "--sample":
        args.sample = value;
        break;
      case "--db":
        args.db = value;
        break;
      case "--extract":
        args.extract = value;
        break;
      case "--since":
        args.since = sinceMs(value);
        break;
    }
  }
  if (args.extract && !args.db) {
    throw new EvalRefusal("--extract reads a database: give --db");
  }
  if (args.labels && !args.sample && !args.db) {
    throw new EvalRefusal("--labels needs --sample (positions) or --db (pins)");
  }
  return args;
}

/** The fewest digits an epoch in milliseconds has from 1973 on; fewer read as seconds. */
const SINCE_MS_MIN_DIGITS = 11;

/**
 * `--since` as epoch ms: an ISO time, or all digits as milliseconds. Refused: a
 * value that is no time, all digits shorter than `SINCE_MS_MIN_DIGITS` (an epoch
 * in seconds, which would read as January 1970), and a time past the range a
 * `Date` holds, which the report could not print.
 */
function sinceMs(value: string): number {
  const digits = /^\d+$/.test(value);
  if (digits && value.length < SINCE_MS_MIN_DIGITS) {
    throw new EvalRefusal(
      `--since ${value} reads as seconds: give epoch milliseconds or an ISO time`
    );
  }
  const ms = digits ? Number(value) : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new EvalRefusal(`--since is not a time: ${value}`);
  }
  if (Number.isNaN(new Date(ms).getTime())) {
    throw new EvalRefusal(`--since ${value} is past the range of a date`);
  }
  return ms;
}

// ── Paths ──────────────────────────────────────────────────────────────────

/** The nearest existing folder at or above `path`, real-pathed. */
function existingDir(path: string): string {
  let at = resolve(path);
  while (!existsSync(at)) {
    const up = dirname(at);
    if (up === at) return at;
    at = up;
  }
  const real = realpathSync(at);
  return statSync(real).isDirectory() ? real : dirname(real);
}

function git(
  dir: string,
  args: string[]
): { code: number; out: string; err: string } {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(["git", "-C", dir, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw new EvalRefusal(
      "git cannot be run here, so no path can be checked: refused"
    );
  }
  const text = (bytes: Uint8Array | undefined) =>
    new TextDecoder().decode(bytes ?? new Uint8Array()).trim();
  return {
    code: result.exitCode ?? 1,
    out: text(result.stdout),
    err: text(result.stderr),
  };
}

/** The nearest `.git` entry (a folder or a worktree's file) at or above `dir`. */
function dotGitAbove(dir: string): string | null {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(resolve(at, ".git"))) return resolve(at, ".git");
    if (dirname(at) === at) return null;
  }
}

/**
 * The git work tree holding `path` (an existing ancestor is asked), or null when
 * it lies in none. Fail-closed: git's own "not a git repository" with no `.git`
 * above the path is the only "none"; any other failure (a repository git will
 * not open, such as one it calls of dubious ownership, or a broken `.git`) is a
 * refusal, because the path may lie in a repository after all.
 */
export function workTreeOf(path: string): string | null {
  const dir = existingDir(path);
  const probe = git(dir, ["rev-parse", "--show-toplevel"]);
  if (probe.code === 0 && probe.out !== "") return probe.out;
  const unreadable = dotGitAbove(dir);
  if (/not a git repository/i.test(probe.err) && !unreadable) return null;
  throw new EvalRefusal(
    `git cannot tell whether ${path} lies in a work tree${unreadable ? ` (${unreadable} is there but git will not read it)` : ""}: refused`
  );
}

/**
 * Refuse a path a git work tree could carry: every input and the extract folder
 * must lie outside every work tree; the database (read only) may lie in one
 * only where that work tree ignores it.
 */
export function refuseTrackedPath(
  flag: string,
  path: string,
  options: { allowIgnored?: boolean } = {}
): void {
  const tree = workTreeOf(path);
  if (!tree) return;
  if (options.allowIgnored) {
    const real = existsSync(path) ? realpathSync(path) : resolve(path);
    const ignored = git(tree, ["check-ignore", "-q", "--", real]);
    if (ignored.code === 0) return;
  }
  throw new EvalRefusal(
    `${flag} ${path} lies inside the git work tree ${tree}: the private material stays out of every repository (use a folder such as /var/tmp/<name>)`
  );
}

// ── The corpus and its labels ──────────────────────────────────────────────

export type Tally = { decision: number; ambiguous: number; none: number };

function emptyTally(): Tally {
  return { decision: 0, ambiguous: 0, none: 0 };
}

export type CorpusReport = {
  messages: number;
  unreadable: number;
  verdicts: Tally;
  /** Per verdict, how many messages carry each signal. */
  signals: Record<"decision" | "ambiguous", Record<string, number>>;
  /** The verdict of each corpus message, by index, for the labels; null for an unreadable line. */
  byIndex: Array<DecisionVerdict | null>;
};

/** Read a JSONL corpus: one `text` per line; unreadable lines are counted. */
export function readCorpus(path: string): {
  texts: Array<string | null>;
  unreadable: number;
} {
  const texts: Array<string | null> = [];
  let unreadable = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as { text?: unknown };
      if (typeof row.text === "string") {
        texts.push(row.text);
        continue;
      }
    } catch {
      // counted below
    }
    texts.push(null);
    unreadable++;
  }
  return { texts, unreadable };
}

export function classifyCorpus(
  texts: ReadonlyArray<string | null>
): CorpusReport {
  const report: CorpusReport = {
    messages: 0,
    unreadable: 0,
    verdicts: emptyTally(),
    signals: { decision: {}, ambiguous: {} },
    byIndex: [],
  };
  for (const text of texts) {
    if (text === null) {
      report.unreadable++;
      report.byIndex.push(null);
      continue;
    }
    report.messages++;
    const result = classifyDecisionSignals(text);
    report.verdicts[result.verdict]++;
    report.byIndex.push(result.verdict);
    if (result.verdict !== "none") {
      const bucket = report.signals[result.verdict];
      for (const signal of result.signals) {
        bucket[signal] = (bucket[signal] ?? 0) + 1;
      }
    }
  }
  return report;
}

/** A class named an ask: operator_ask, pm_ask, pm_directed, unmanaged_real… */
const ASK_CLASS = /(?:^|_)(?:ask|directed|real)$/;

export type LabelRow = {
  set: string;
  label: string;
  total: number;
  missing: number;
  tally: Tally;
  ask: boolean;
};

export type LabelReport = {
  rows: LabelRow[];
  /** Sets with no sample list and no pin IDs. */
  unresolved: string[];
  /**
   * Classes whose value is not a list, named with its JSON type, so a class a
   * labels file records another way (a count, a note) is never dropped unseen.
   */
  unread: Array<{ set: string; label: string; type: string }>;
  /**
   * Per set with a sample list: its positions that no class lists, classified,
   * so a class left implicit ("the rest are operator asks") still shows.
   */
  unlisted: Array<{ set: string; total: number; tally: Tally }>;
};

type LabelFile = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The labelled table: each class's entries resolved through the sample list of
 * its set (corpus positions) or, for pin IDs, through `pinVerdicts`.
 */
export function labelTable(
  labels: LabelFile,
  sample: Record<string, unknown> | null,
  byIndex: ReadonlyArray<DecisionVerdict | null> | null,
  pinVerdicts: ReadonlyMap<string, DecisionVerdict> | null
): LabelReport {
  const report: LabelReport = {
    rows: [],
    unresolved: [],
    unread: [],
    unlisted: [],
  };
  for (const [set, classes] of Object.entries(labels)) {
    if (set.startsWith("_") || !isObject(classes)) continue;
    const list = sample?.[set];
    const positions = Array.isArray(list) ? list : null;
    const listed = new Set<number>();
    let resolved = false;
    for (const [label, entries] of Object.entries(classes)) {
      if (!Array.isArray(entries)) {
        const type = entries === null ? "null" : typeof entries;
        report.unread.push({ set, label, type });
        continue;
      }
      const row: LabelRow = {
        set,
        label,
        total: entries.length,
        missing: 0,
        tally: emptyTally(),
        ask: ASK_CLASS.test(label),
      };
      for (const entry of entries) {
        let verdict: DecisionVerdict | null | undefined;
        if (typeof entry === "string" && entry.startsWith("pin-")) {
          verdict = pinVerdicts?.get(entry);
        } else if (typeof entry === "number" && positions && byIndex) {
          listed.add(entry);
          const index = positions[entry];
          verdict = typeof index === "number" ? byIndex[index] : undefined;
        }
        if (verdict) {
          row.tally[verdict]++;
          resolved = true;
        } else {
          row.missing++;
        }
      }
      report.rows.push(row);
    }
    if (positions && byIndex) {
      const rest = { set, total: 0, tally: emptyTally() };
      positions.forEach((index, at) => {
        if (listed.has(at)) return;
        const verdict = typeof index === "number" ? byIndex[index] : null;
        if (!verdict) return;
        rest.total++;
        rest.tally[verdict]++;
      });
      if (rest.total > 0) {
        report.unlisted.push(rest);
        resolved = true;
      }
    }
    if (!resolved) report.unresolved.push(set);
  }
  return report;
}

// ── The database ───────────────────────────────────────────────────────────

/** The user-facing assistant text of a parsed message, joined; "" for none. */
function assistantText(parsed: unknown): string {
  return extractUserFacingAssistantTexts(parsed)
    .map(text => text.text)
    .join("\n");
}

/** The user-facing assistant text of a stored message, joined; "" for none. */
function storedText(content: string | null): string {
  if (content === null) return "";
  try {
    return assistantText(JSON.parse(content));
  } catch {
    return "";
  }
}

export type LivePinReport = {
  pins: number;
  unreadable: number;
  stamped: Tally;
  unstamped: Tally;
  verdicts: Map<string, DecisionVerdict>;
};

/** Every Detected pin since `since`, its message classified under these rules. */
export function livePins(db: Database, since: number): LivePinReport {
  const report: LivePinReport = {
    pins: 0,
    unreadable: 0,
    stamped: emptyTally(),
    unstamped: emptyTally(),
    verdicts: new Map(),
  };
  const pins = db
    .query(
      `SELECT p.key AS key, p.pin_id AS pinId, s.parent_relationship AS rel,
              s.parent_session_id AS parent
       FROM session_pins p JOIN sessions s ON s.id = p.session_id
       WHERE p.key LIKE 'detected:%' AND p.created_at >= ?`
    )
    .all(since) as Array<{
    key: string;
    pinId: string | null;
    rel: string | null;
    parent: string | null;
  }>;
  const message = db.query("SELECT content FROM messages WHERE id = ?");
  for (const pin of pins) {
    report.pins++;
    const row = message.get(pin.key.slice("detected:".length)) as {
      content: string;
    } | null;
    const text = storedText(row?.content ?? null);
    if (text.trim() === "") {
      report.unreadable++;
      continue;
    }
    const verdict = classifyDecisionSignals(text).verdict;
    const stamped = pin.rel === "spawn" && !!pin.parent;
    (stamped ? report.stamped : report.unstamped)[verdict]++;
    if (pin.pinId) report.verdicts.set(pin.pinId, verdict);
  }
  return report;
}

export type TurnGroup = {
  turns: number;
  withText: number;
  strong: number;
  strongPinnedInTurn: number;
  strongDetected: number;
  strongNamingOpenPin: number;
  strongLeft: number;
  weak: number;
  weakNoPin: number;
  /** Turns still open: counted, with no final read. */
  open: number;
  abnormal: number;
  abnormalWithText: number;
  abnormalStrong: number;
  abnormalWeak: number;
};

export type TurnReport = {
  stamped: TurnGroup;
  unstamped: TurnGroup;
  /** Sessions with a turn in the window, by harness (`metadata.flavor`). */
  harnesses: Record<string, number>;
};

function emptyGroup(): TurnGroup {
  return {
    turns: 0,
    withText: 0,
    strong: 0,
    strongPinnedInTurn: 0,
    strongDetected: 0,
    strongNamingOpenPin: 0,
    strongLeft: 0,
    weak: 0,
    weakNoPin: 0,
    open: 0,
    abnormal: 0,
    abnormalWithText: 0,
    abnormalStrong: 0,
    abnormalWeak: 0,
  };
}

/** The read bound past a turn's end: a final message lands just after Stop. */
const TURN_END_SLACK_MS = 8000;
/** The read bound before a turn's start (clock skew between the two writers). */
const TURN_START_SLACK_MS = 2000;
/** A pin created or revised this long before the turn started counts in it. */
const PIN_TURN_SLACK_MS = 10_000;
/** A stored message is read only up to this size. */
const MESSAGE_MAX_BYTES = 64 * 1024;

type FinalMessage = { id: string; at: number; text: string };

/**
 * Each turn since `since`, with its final message: the last stored row with
 * user-facing assistant text between the turn's start and the next turn's start
 * (at most `TURN_END_SLACK_MS` past its own end). `visit` sees every turn. A
 * session's last turn while it is `open` (still running, or not yet swept after
 * a crash) has no final: its newest text so far is not its last, and the live
 * check has not judged it. An `open` row with a later turn after it has ended
 * (its finalize write was lost), so its final is read and `stillOpen` is false.
 */
function eachTurn(
  db: Database,
  since: number,
  visit: (turn: {
    session: {
      id: string;
      stamped: boolean;
      flavor: string;
      namespace: string;
    };
    status: TurnStatus;
    /** The session's last turn, still `open`: counted with no final read. */
    stillOpen: boolean;
    start: number;
    end: number;
    final: FinalMessage | null;
  }) => void
): void {
  const sessions = db
    .query(
      `SELECT id, parent_session_id AS parent, parent_relationship AS rel,
              metadata, namespace FROM sessions`
    )
    .all() as Array<{
    id: string;
    parent: string | null;
    rel: string | null;
    metadata: string | null;
    namespace: string;
  }>;
  const turnsOf = db.query(
    `SELECT status, started_at_ms AS start, ended_at_ms AS ended FROM turns
     WHERE hapi_session_id = ? AND started_at_ms >= ? ORDER BY started_at_ms`
  );
  const rowsOf = db.query(
    `SELECT id, created_at AS at,
            CASE WHEN length(content) <= ? THEN content END AS content
     FROM messages WHERE session_id = ? AND created_at >= ? ORDER BY seq`
  );
  for (const row of sessions) {
    const turns = turnsOf.all(row.id, since) as Array<{
      status: TurnStatus;
      start: number;
      ended: number | null;
    }>;
    if (turns.length === 0) continue;
    let flavor = "unknown";
    try {
      const meta = JSON.parse(row.metadata ?? "null") as {
        flavor?: unknown;
      } | null;
      if (typeof meta?.flavor === "string" && meta.flavor !== "") {
        flavor = meta.flavor;
      }
    } catch {
      // unknown
    }
    const session = {
      id: row.id,
      stamped: row.rel === "spawn" && !!row.parent,
      flavor,
      namespace: row.namespace,
    };
    const rows = (
      rowsOf.all(
        MESSAGE_MAX_BYTES,
        row.id,
        turns[0]!.start - TURN_START_SLACK_MS
      ) as Array<{ id: string; at: number; content: string | null }>
    ).map(message => {
      let parsed: unknown = null;
      try {
        parsed = message.content === null ? null : JSON.parse(message.content);
      } catch {
        parsed = null;
      }
      return { id: message.id, at: message.at, parsed };
    });
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]!;
      const next = turns[i + 1]?.start ?? Number.POSITIVE_INFINITY;
      const end = Math.min(next, (turn.ended ?? next) + TURN_END_SLACK_MS);
      let final: FinalMessage | null = null;
      const stillOpen = turn.status === "open" && i === turns.length - 1;
      // A turn still open has no final yet: none of its rows is read as one.
      for (const message of stillOpen ? [] : rows) {
        if (message.at < turn.start - TURN_START_SLACK_MS || message.at >= end)
          continue;
        if (message.parsed === null || isStopHookFeedbackRecord(message.parsed))
          continue;
        const text = assistantText(message.parsed);
        if (text.trim() !== "") {
          final = { id: message.id, at: message.at, text };
        }
      }
      visit({
        session,
        status: turn.status,
        stillOpen,
        start: turn.start,
        end,
        final,
      });
    }
  }
}

type PinRow = {
  key: string;
  pinId: string | null;
  status: string;
  /** The content's `kind`; null when the stored content is not valid JSON. */
  kind: string | null;
  created: number;
  updated: number;
};

/** SQL for a pin's `kind` from its stored content, null when it is not valid JSON. */
function pinKindSql(column: string): string {
  return `CASE WHEN json_valid(${column}) THEN json_extract(${column}, '$.kind') END`;
}

/**
 * A pin open at `at`: made by then (with the turn slack) and not closed before it.
 * A dashboard is never open, as the live check reads only `status = 'open'`
 * (pinStore listTurnCandidates, listOpenPinRefs) and a dashboard is `live` while
 * active; once withdrawn or dismissed it keeps its kind, not its status. The store
 * keeps a pin's last update only, so a pin closed after `at` reads open then.
 */
function openAt(
  pin: Pick<PinRow, "status" | "kind" | "created" | "updated">,
  at: number
): boolean {
  return (
    pin.status !== "live" &&
    pin.kind !== "dashboard" &&
    pin.created <= at + PIN_TURN_SLACK_MS &&
    (pin.status === "open" || pin.updated > at)
  );
}

/**
 * Whether a message's asks each name a pin open at `at`, read the way the live
 * turn check reads them (pinTurnCheck.ts, "A matching pin"): by key or pin ID an
 * open pin of the session, its reserved Detected and prompt pins included, or by
 * pin ID an open pin of any session in the same namespace (`openByPinId`). An ask
 * cut from `askTexts` was never checked, so a message with `askTextsCut` is not
 * covered, and a message with no ask is not either. An answer key is also covered
 * when every code of its own fence is an option ID of an open agent pin of the
 * session (#6456 R3, the live check's `coveredByCodes`), read from `text`.
 */
function namesOpenPin(
  signals: DecisionSignals,
  text: string,
  pins: readonly PinRow[],
  at: number,
  openByPinId: (pinId: string) => boolean,
  optionIdsOf: (key: string) => readonly string[]
): boolean {
  if (signals.verdict === "decision" && signals.askTextsCut) return false;
  const asks =
    signals.verdict === "decision" ? signals.askTexts : [signals.matchText];
  if (asks.length === 0) return false;
  const open = pins.filter(pin => openAt(pin, at));
  const keyed = signals.verdict === "decision" ? answerKeyBlocks(text) : [];
  let optionIds: Set<string> | null = null;
  const openOptionIds = (): Set<string> => {
    if (optionIds) return optionIds;
    optionIds = new Set();
    for (const pin of open) {
      if (isReservedPinKey(pin.key)) continue;
      for (const id of optionIdsOf(pin.key)) optionIds.add(id);
    }
    return optionIds;
  };
  const coveredByCodes = (ask: string): boolean => {
    // Two keys with one ask text are covered only when both blocks are.
    const blocks = keyed.filter(block => block.askText === ask);
    if (blocks.length === 0) return false;
    return blocks.every(
      block =>
        block.codes !== null &&
        block.codes.length > 0 &&
        block.codes.every(
          code => isCoverableAnswerCode(code) && openOptionIds().has(code)
        )
    );
  };
  return asks.every(
    ask =>
      open.some(
        pin =>
          namesPinKey(ask, pin.key) ||
          (!!pin.pinId && namesPinKey(ask, pin.pinId))
      ) ||
      findPinIds(ask).some(openByPinId) ||
      coveredByCodes(ask)
  );
}

/** A pin's option IDs from its stored content; none when the JSON is unreadable. */
function pinOptionIds(content: string | undefined): string[] {
  if (!content) return [];
  try {
    const parsed: unknown = JSON.parse(content);
    const options =
      parsed && typeof parsed === "object"
        ? (parsed as { options?: unknown }).options
        : undefined;
    if (!Array.isArray(options)) return [];
    return options.flatMap(option =>
      option &&
      typeof option === "object" &&
      typeof (option as { id?: unknown }).id === "string"
        ? [(option as { id: string }).id]
        : []
    );
  } catch {
    return [];
  }
}

/** The turn table: what a turn-end detector would have seen, per turn. */
export function turnTable(db: Database, since: number): TurnReport {
  const report: TurnReport = {
    stamped: emptyGroup(),
    unstamped: emptyGroup(),
    harnesses: {},
  };
  const pinsOf = db.query(
    `SELECT key, pin_id AS pinId, status, ${pinKindSql("content_json")} AS kind,
            created_at AS created, updated_at AS updated
     FROM session_pins WHERE session_id = ?`
  );
  // By pin ID across the namespace, as the live check's openPinInNamespace reads it.
  const pinsById = db.query(
    `SELECT p.status, ${pinKindSql("p.content_json")} AS kind,
            p.created_at AS created, p.updated_at AS updated
     FROM session_pins p JOIN sessions s ON s.id = p.session_id
     WHERE p.pin_id = ? AND s.namespace = ?`
  );
  // A pin's content, read only for an answer key's codes (R3).
  const contentOf = db.query(
    `SELECT content_json AS content FROM session_pins
     WHERE session_id = ? AND key = ?`
  );
  const seen = new Set<string>();
  const pinCache = new Map<string, PinRow[]>();
  eachTurn(db, since, ({ session, status, stillOpen, start, end, final }) => {
    if (!seen.has(session.id)) {
      seen.add(session.id);
      report.harnesses[session.flavor] =
        (report.harnesses[session.flavor] ?? 0) + 1;
    }
    const group = session.stamped ? report.stamped : report.unstamped;
    group.turns++;
    if (stillOpen) group.open++;
    const abnormal =
      status === "interrupted" ||
      status === "orphaned" ||
      status === "errored" ||
      (status === "open" && !stillOpen);
    if (abnormal) group.abnormal++;
    if (!final) return;
    group.withText++;
    if (abnormal) group.abnormalWithText++;
    const signals = classifyDecisionSignals(final.text);
    if (signals.verdict === "none") return;
    if (abnormal) {
      if (signals.verdict === "decision") group.abnormalStrong++;
      else group.abnormalWeak++;
    }
    let pins = pinCache.get(session.id);
    if (!pins) {
      pins = pinsOf.all(session.id) as PinRow[];
      pinCache.set(session.id, pins);
    }
    // Made or revised this turn and still open at its end, as the live check
    // reads it (listTurnCandidates: open agent pins only), so a dashboard or a
    // pin the turn's opening Submit answered never counts.
    const agentPinInTurn = pins.some(
      pin =>
        !isReservedPinKey(pin.key) &&
        openAt(pin, end) &&
        ((pin.created >= start - PIN_TURN_SLACK_MS && pin.created <= end) ||
          (pin.updated >= start - PIN_TURN_SLACK_MS && pin.updated <= end))
    );
    const fenced =
      scanPinFences(final.text, { maxBlocks: 1 }).blocks.length > 0;
    const pinned = agentPinInTurn || fenced;
    if (signals.verdict === "ambiguous") {
      group.weak++;
      if (!pinned) group.weakNoPin++;
      return;
    }
    group.strong++;
    if (pinned) {
      group.strongPinnedInTurn++;
    } else if (pins.some(pin => pin.key === `detected:${final.id}`)) {
      group.strongDetected++;
    } else if (
      namesOpenPin(
        signals,
        final.text,
        pins,
        final.at,
        pinId =>
          (
            pinsById.all(pinId, session.namespace) as Array<
              Pick<PinRow, "status" | "kind" | "created" | "updated">
            >
          ).some(row => openAt(row, final.at)),
        key =>
          pinOptionIds(
            (contentOf.get(session.id, key) as { content: string } | null)
              ?.content
          )
      )
    ) {
      group.strongNamingOpenPin++;
    } else {
      group.strongLeft++;
    }
  });
  return report;
}

/** Write each ended turn's final message to `folder/corpus-v1.jsonl`; the count. */
export function extractCorpus(
  db: Database,
  since: number,
  folder: string
): number {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  const lines: string[] = [];
  eachTurn(db, since, ({ final }) => {
    if (!final) return;
    lines.push(
      JSON.stringify({
        n: lines.length,
        at: new Date(final.at).toISOString(),
        text: final.text,
      })
    );
  });
  const file = resolve(folder, "corpus-v1.jsonl");
  writeFileSync(file, lines.length > 0 ? `${lines.join("\n")}\n` : "", {
    mode: 0o600,
  });
  chmodSync(file, 0o600);
  return lines.length;
}

/** The database, opened read-only: a write through it throws. */
export function openReadOnly(path: string): Database {
  return new Database(path, { readonly: true });
}

// ── The report ─────────────────────────────────────────────────────────────

function tallyText(tally: Tally): string {
  return `decision ${tally.decision}, ambiguous ${tally.ambiguous}, none ${tally.none}`;
}

function signalText(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  return entries.length > 0
    ? entries.map(([signal, n]) => `${signal} ${n}`).join(", ")
    : "none";
}

function groupLines(name: string, group: TurnGroup): string[] {
  return [
    `  ${name}: ${group.turns} turns, ${group.withText} with a final message`,
    `    strong finals ${group.strong}: pinned in the turn ${group.strongPinnedInTurn}, a Detected pin ${group.strongDetected}, naming an open pin ${group.strongNamingOpenPin}, left unpinned ${group.strongLeft}`,
    `    weak finals ${group.weak}, with no pin ${group.weakNoPin}`,
    `    open turns, read with no final ${group.open}`,
    `    abnormal ends (interrupted, orphaned, errored, or left open before a later turn) ${group.abnormal}: with a final message ${group.abnormalWithText}, strong ${group.abnormalStrong}, weak ${group.abnormalWeak}`,
  ];
}

function labelLines(report: LabelReport): string[] {
  const lines = ["labelled:"];
  const asks = new Map<string, { asks: number; none: number }>();
  for (const row of report.rows) {
    lines.push(
      `  ${row.set} ${row.label}: ${row.total} (${tallyText(row.tally)}${row.missing > 0 ? `, unresolved ${row.missing}` : ""})`
    );
    if (row.ask) {
      const sum = asks.get(row.set) ?? { asks: 0, none: 0 };
      sum.asks += row.total - row.missing;
      sum.none += row.tally.none;
      asks.set(row.set, sum);
    }
  }
  for (const [set, sum] of asks) {
    lines.push(`  ${set} asks that read none: ${sum.none} of ${sum.asks}`);
  }
  for (const rest of report.unlisted) {
    lines.push(
      `  ${rest.set} positions no class lists: ${rest.total} (${tallyText(rest.tally)})`
    );
  }
  for (const item of report.unread) {
    lines.push(
      `  ${item.set} ${item.label}: not a list (a ${item.type}), so not counted`
    );
  }
  for (const set of report.unresolved) {
    lines.push(`  ${set}: unresolved (no sample list, and no pin ID read)`);
  }
  return lines;
}

function readJson(path: string, flag: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new EvalRefusal(`${flag} ${path} is not readable JSON`);
  }
  if (!isObject(parsed)) throw new EvalRefusal(`${flag} must hold an object`);
  return parsed;
}

/** Run the evaluation; returns the report's lines. Throws `EvalRefusal`. */
export function runEval(args: EvalArgs): string[] {
  if (!args.corpus && !args.db) {
    throw new EvalRefusal("give --corpus, --db, or both (see --help)");
  }
  for (const [flag, path] of [
    ["--corpus", args.corpus],
    ["--labels", args.labels],
    ["--sample", args.sample],
    ["--extract", args.extract],
  ] as const) {
    if (path) refuseTrackedPath(flag, path);
  }
  if (args.db) refuseTrackedPath("--db", args.db, { allowIgnored: true });
  for (const [flag, path] of [
    ["--corpus", args.corpus],
    ["--labels", args.labels],
    ["--sample", args.sample],
    ["--db", args.db],
  ] as const) {
    if (path && !existsSync(path)) {
      throw new EvalRefusal(`${flag} ${path} does not exist`);
    }
  }
  const lines = [
    `${PIN_DETECTOR_EVAL_VERSION} (rules version ${DECISION_SIGNAL_RULES_VERSION})`,
  ];
  let corpus: CorpusReport | null = null;
  if (args.corpus) {
    const read = readCorpus(args.corpus);
    corpus = classifyCorpus(read.texts);
    lines.push(
      `corpus: ${corpus.messages} messages${corpus.unreadable > 0 ? `, ${corpus.unreadable} unreadable lines` : ""}`,
      `  ${tallyText(corpus.verdicts)}`,
      `  decision signals: ${signalText(corpus.signals.decision)}`,
      `  ambiguous signals: ${signalText(corpus.signals.ambiguous)}`
    );
  }
  let db: Database | null = null;
  try {
    let live: LivePinReport | null = null;
    const since = args.since ?? 0;
    if (args.db) {
      db = openReadOnly(args.db);
      if (args.extract) {
        const written = extractCorpus(db, since, args.extract);
        lines.push(
          `extract: ${written} final messages written (file mode 600)`
        );
      }
      live = livePins(db, since);
      lines.push(
        `live Detected pins${args.since !== null ? ` since ${new Date(since).toISOString()}` : ""}: ${live.pins}${live.unreadable > 0 ? ` (${live.unreadable} with no readable message)` : ""}`,
        `  unstamped sessions: ${tallyText(live.unstamped)}`,
        `  stamped (managed) sessions: ${tallyText(live.stamped)}`
      );
      const turns = turnTable(db, since);
      lines.push(
        `turns${args.since !== null ? ` since ${new Date(since).toISOString()}` : ""}:`,
        ...groupLines("unstamped sessions", turns.unstamped),
        ...groupLines("stamped (managed) sessions", turns.stamped),
        `  sessions by harness: ${signalText(turns.harnesses)}`
      );
    }
    if (args.labels) {
      const labels = readJson(args.labels, "--labels");
      const sample = args.sample ? readJson(args.sample, "--sample") : null;
      lines.push(
        ...labelLines(
          labelTable(
            labels,
            sample,
            corpus?.byIndex ?? null,
            live?.verdicts ?? null
          )
        )
      );
    }
  } finally {
    db?.close();
  }
  return lines;
}

if (import.meta.main) {
  try {
    const args = parseEvalArgs(Bun.argv.slice(2));
    if (args.help) {
      process.stdout.write(HELP);
      process.exit(0);
    }
    process.stdout.write(`${runEval(args).join("\n")}\n`);
  } catch (error) {
    if (error instanceof EvalRefusal) {
      process.stderr.write(`${PIN_DETECTOR_EVAL_VERSION}: ${error.message}\n`);
      process.exit(2);
    }
    process.stderr.write(
      `${PIN_DETECTOR_EVAL_VERSION}: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  }
}
