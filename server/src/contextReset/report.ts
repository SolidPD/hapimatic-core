// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The context-reset outcome report (issue #6559, Task 12; R15, R17).
 *
 * Reads the `context_reset` turn events of a window and reports, per seam
 * (`fromStage>toStage`), the terminal outcomes in time order and the current run
 * of consecutive `delivered_reset`; and, over all seams, the share of armed
 * requests that ended `delivered_reset`, with the reason of every other
 * outcome. Ruling Q8a reports these outcomes across lanes; ruling Q10's
 * activation step (reflect-to-close joins wave 1 only after each research seam
 * has three `delivered_reset` in a row) is `checkStreak`.
 *
 * Always read-only, because the CLI (`server/scripts/context-reset-report-v1.ts`)
 * runs against a live node's database.
 */

import type { Database } from "bun:sqlite";

export const CONTEXT_RESET_REPORT_VERSION = "context-reset-report-v1";

/** The terminal outcomes a request can end in. */
export const TERMINAL_OUTCOMES = [
  "delivered_reset",
  "delivered_no_reset",
  "unconfirmed",
  "dropped",
  "expired",
] as const;
const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_OUTCOMES);

/** One `context_reset` event, as the service writes its payload. */
export interface ContextResetEventRow {
  tsMs: number;
  armId: string;
  outcome: string;
  reason: string | null;
  fromStage: string | null;
  toStage: string | null;
}

export interface SeamReport {
  /** `fromStage>toStage`. */
  seam: string;
  /** Terminal outcomes, oldest first. */
  outcomes: {
    tsMs: number;
    armId: string;
    outcome: string;
    reason: string | null;
  }[];
  /** Consecutive `delivered_reset` at the newest end. */
  currentStreak: number;
}

export interface ContextResetReport {
  version: string;
  fromMs: number;
  toMs: number;
  seams: SeamReport[];
  overall: {
    armed: number;
    deliveredReset: number;
    /** `deliveredReset / armed`, or null with nothing armed. */
    resetShare: number | null;
    /** Every other terminal outcome, counted by outcome and reason. */
    others: { outcome: string; reason: string | null; count: number }[];
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Parse one stored event; null for a payload that is not a context-reset event. */
export function parseEventRow(
  tsMs: number,
  payload: string | null
): ContextResetEventRow | null {
  if (payload === null) return null;
  let p: unknown;
  try {
    p = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!p || typeof p !== "object") return null;
  const rec = p as Record<string, unknown>;
  const armId = str(rec.armId);
  const outcome = str(rec.outcome);
  if (!armId || !outcome) return null;
  return {
    tsMs,
    armId,
    outcome,
    reason: str(rec.reason),
    fromStage: str(rec.fromStage),
    toStage: str(rec.toStage),
  };
}

/** The `context_reset` events of `[fromMs, toMs)`, oldest first. Read-only. */
export function readContextResetEvents(
  db: Database,
  fromMs: number,
  toMs: number
): ContextResetEventRow[] {
  const rows = db
    .prepare(
      `SELECT ts_ms, payload FROM turn_events
        WHERE kind = 'context_reset' AND ts_ms >= ? AND ts_ms < ?
        ORDER BY ts_ms ASC, id ASC`
    )
    .all(fromMs, toMs) as { ts_ms: number; payload: string | null }[];
  const out: ContextResetEventRow[] = [];
  for (const r of rows) {
    const ev = parseEventRow(r.ts_ms, r.payload);
    if (ev) out.push(ev);
  }
  return out;
}

/** The seam of an event, or null: a request with no `fromStage` belongs to no named seam. */
export function seamOf(
  ev: Pick<ContextResetEventRow, "fromStage" | "toStage">
): string | null {
  if (!ev.fromStage) return null;
  return `${ev.fromStage}>${ev.toStage ?? ""}`;
}

/** Build the report from events, in any order. */
export function buildReport(
  events: readonly ContextResetEventRow[],
  window: { fromMs: number; toMs: number }
): ContextResetReport {
  const sorted = [...events].sort((a, b) => a.tsMs - b.tsMs);
  const bySeam = new Map<string, SeamReport>();
  let armed = 0;
  let deliveredReset = 0;
  const others = new Map<
    string,
    { outcome: string; reason: string | null; count: number }
  >();
  for (const ev of sorted) {
    if (ev.outcome === "armed") {
      armed += 1;
      continue;
    }
    if (!TERMINAL.has(ev.outcome)) continue;
    if (ev.outcome === "delivered_reset") {
      deliveredReset += 1;
    } else {
      const key = `${ev.outcome}\u0000${ev.reason ?? ""}`;
      const prev = others.get(key);
      if (prev) prev.count += 1;
      else
        others.set(key, { outcome: ev.outcome, reason: ev.reason, count: 1 });
    }
    const seam = seamOf(ev);
    if (seam === null) continue;
    let rep = bySeam.get(seam);
    if (!rep) {
      rep = { seam, outcomes: [], currentStreak: 0 };
      bySeam.set(seam, rep);
    }
    rep.outcomes.push({
      tsMs: ev.tsMs,
      armId: ev.armId,
      outcome: ev.outcome,
      reason: ev.reason,
    });
  }
  for (const rep of bySeam.values()) {
    let streak = 0;
    for (let i = rep.outcomes.length - 1; i >= 0; i -= 1) {
      if (rep.outcomes[i].outcome !== "delivered_reset") break;
      streak += 1;
    }
    rep.currentStreak = streak;
  }
  return {
    version: CONTEXT_RESET_REPORT_VERSION,
    fromMs: window.fromMs,
    toMs: window.toMs,
    seams: [...bySeam.values()].sort((a, b) => a.seam.localeCompare(b.seam)),
    overall: {
      armed,
      deliveredReset,
      resetShare: armed > 0 ? deliveredReset / armed : null,
      others: [...others.values()].sort((a, b) => b.count - a.count),
    },
  };
}

export interface StreakResult {
  ok: boolean;
  seams: { seam: string; latest: string[]; ok: boolean }[];
}

/**
 * Ruling Q10's activation check: for each named seam, the latest `n` terminal
 * outcomes are all `delivered_reset`. Fewer than `n`, or an `unconfirmed`, a
 * delivery without a reset or a drop among them, fails that seam.
 */
export function checkStreak(
  report: ContextResetReport,
  seams: readonly string[],
  n: number
): StreakResult {
  const results = seams.map(seam => {
    const rep = report.seams.find(s => s.seam === seam);
    const latest = (rep?.outcomes ?? []).slice(-n).map(o => o.outcome);
    const ok =
      latest.length === n && latest.every(o => o === "delivered_reset");
    return { seam, latest, ok };
  });
  return { ok: results.length > 0 && results.every(r => r.ok), seams: results };
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The report as Markdown. */
export function renderMarkdown(report: ContextResetReport): string {
  const lines: string[] = [];
  lines.push(`# Context-reset outcomes (${report.version})`);
  lines.push("");
  lines.push(`Window: ${iso(report.fromMs)} to ${iso(report.toMs)}`);
  lines.push("");
  const o = report.overall;
  lines.push(
    `Armed requests: ${o.armed}; ended delivered_reset: ${o.deliveredReset} (${pct(o.resetShare)}).`
  );
  if (o.others.length > 0) {
    lines.push("");
    lines.push("| Other outcome | Reason | Count |");
    lines.push("|---|---|---|");
    for (const row of o.others) {
      lines.push(`| ${row.outcome} | ${row.reason ?? "—"} | ${row.count} |`);
    }
  }
  for (const s of report.seams) {
    lines.push("");
    lines.push(
      `## ${s.seam} (current run of delivered_reset: ${s.currentStreak})`
    );
    lines.push("");
    lines.push("| When | Arm | Outcome | Reason |");
    lines.push("|---|---|---|---|");
    for (const row of s.outcomes) {
      lines.push(
        `| ${iso(row.tsMs)} | ${row.armId} | ${row.outcome} | ${row.reason ?? "—"} |`
      );
    }
  }
  return lines.join("\n");
}
