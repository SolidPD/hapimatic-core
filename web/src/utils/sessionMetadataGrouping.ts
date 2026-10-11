// SPDX-License-Identifier: AGPL-3.0-only
import type { SessionMetadataTurn, SessionTokenTotals } from "@hapi/protocol";
import type { StatusDotVariant } from "@/components/ui/StatusDot";

/**
 * sessionMetadataGrouping — pure grouping / rollup / status helpers for the SM03
 * Session Metadata page (#1982).
 *
 * The node-local telemetry endpoint returns a FLAT `SessionMetadataTurn[]`; SM03
 * renders sessions grouped, each collapsed to a per-session rollup that expands to
 * full metadata + a nested per-turn list. This module derives that rollup
 * client-side, mirroring the null-aggregation semantics of the server's
 * `v_session_totals` view (`SessionTokenTotals`, `shared/src/schemas.ts`) so a
 * client-derived rollup and the server rollup agree: summing over all-NULL numeric
 * columns yields NULL, not 0 (R7 — the UI renders `—`, never a misleading `0`).
 *
 * `SessionGroupSummary` is the single shape BOTH scopes produce: the This-node path
 * derives it from a session's turns (`groupTurnsBySession`); the All-nodes path
 * adapts it from a server `SessionTokenTotals` row (`sessionTotalsToGroup`) — so one
 * collapsed-row + KVGrid renderer serves both scopes.
 */

/** Per-session rollup — the collapsed-summary + expanded-KVGrid data. */
export interface SessionGroupSummary {
  hapiSessionId: string;
  nodeId: string | null;
  turnCount: number;
  firstStartedAtMs: number | null;
  lastEndedAtMs: number | null;
  totalDurationMs: number | null;
  totalTokIn: number | null;
  totalTokOut: number | null;
  totalCost: number | null;
  lastRepo: string | null;
  lastModelId: string | null;
  lastAccountId: string | null;
  lastLinkedIssue: string | null;
}

/**
 * A session group: its rollup summary + the turns that produced it. The `turns`
 * array is EMPTY in All-nodes scope — cross-node telemetry carries no per-turn data
 * (R6), so the nested per-turn list is unavailable there.
 */
export interface SessionGroup {
  summary: SessionGroupSummary;
  turns: SessionMetadataTurn[];
}

/**
 * Null-safe sum: add only the non-null values. Returns `null` when EVERY value is
 * null (matching the server view — SUM over all-NULL is NULL, not 0) so the UI can
 * render `—` rather than a misleading `0` (R7).
 */
function sumNullable(values: Array<number | null>): number | null {
  let sum = 0;
  let seen = false;
  for (const v of values) {
    if (v != null) {
      sum += v;
      seen = true;
    }
  }
  return seen ? sum : null;
}

/** Max of the non-null values, or `null` when all are null. */
function maxNullable(values: Array<number | null>): number | null {
  let max: number | null = null;
  for (const v of values) {
    if (v != null && (max === null || v > max)) max = v;
  }
  return max;
}

/**
 * Group a flat list of node-local turns by `hapiSessionId`, deriving a per-session
 * rollup. Groups preserve first-seen order — the node-local endpoint returns turns
 * newest-started-first, so groups come out newest-activity-first (OR-2 default sort).
 * Each group's `turns` are sorted by `seq` ascending for stable display.
 *
 * Boundary caveat (D7): the caller fetches at most `limit` turns; a session whose
 * turns straddle the fetch-window edge yields window-scoped rollups (its `turnCount`
 * / `totalCost` / `firstStartedAtMs` reflect only the fetched turns). That is a
 * property of the INPUT, not this function — it faithfully rolls up whatever it is
 * handed. The page labels collapsed counts as window-scoped accordingly.
 */
export function groupTurnsBySession(
  turns: SessionMetadataTurn[]
): SessionGroup[] {
  const order: string[] = [];
  const byId = new Map<string, SessionMetadataTurn[]>();
  for (const turn of turns) {
    const bucket = byId.get(turn.hapiSessionId);
    if (bucket) {
      bucket.push(turn);
    } else {
      byId.set(turn.hapiSessionId, [turn]);
      order.push(turn.hapiSessionId);
    }
  }

  return order.map(hapiSessionId => {
    const sessionTurns = byId
      .get(hapiSessionId)!
      .slice()
      .sort((a, b) => a.seq - b.seq);
    // "last" descriptive fields come from the newest-seq turn in the group.
    const newest = sessionTurns.reduce((a, b) => (b.seq > a.seq ? b : a));
    const summary: SessionGroupSummary = {
      hapiSessionId,
      nodeId: newest.nodeId,
      turnCount: sessionTurns.length,
      // startedAtMs is non-null on every turn; the group is non-empty, so this is
      // always a concrete number.
      firstStartedAtMs: Math.min(...sessionTurns.map(t => t.startedAtMs)),
      lastEndedAtMs: maxNullable(sessionTurns.map(t => t.endedAtMs)),
      totalDurationMs: sumNullable(sessionTurns.map(t => t.durationMs)),
      totalTokIn: sumNullable(sessionTurns.map(t => t.tokIn)),
      totalTokOut: sumNullable(sessionTurns.map(t => t.tokOut)),
      totalCost: sumNullable(sessionTurns.map(t => t.costTotal)),
      lastRepo: newest.repo,
      lastModelId: newest.modelId,
      lastAccountId: newest.accountId,
      lastLinkedIssue: newest.linkedIssue,
    };
    return { summary, turns: sessionTurns };
  });
}

/**
 * Adapt a cross-node `SessionTokenTotals` rollup into a `SessionGroup` with an empty
 * `turns` array (R6). Lets the All-nodes scope reuse the same collapsed-row + KVGrid
 * renderer as This-node.
 */
export function sessionTotalsToGroup(t: SessionTokenTotals): SessionGroup {
  return {
    summary: {
      hapiSessionId: t.hapiSessionId,
      nodeId: t.nodeId,
      turnCount: t.turnCount,
      firstStartedAtMs: t.firstStartedAtMs,
      lastEndedAtMs: t.lastEndedAtMs,
      totalDurationMs: t.totalDurationMs,
      totalTokIn: t.totalTokIn,
      totalTokOut: t.totalTokOut,
      totalCost: t.totalCost,
      lastRepo: t.lastRepo,
      lastModelId: t.lastModelId,
      lastAccountId: t.lastAccountId,
      lastLinkedIssue: t.lastLinkedIssue,
    },
    turns: [],
  };
}

/**
 * Map a turn's `status` (the `TurnStatus` vocabulary
 * `open | completed | interrupted | errored | orphaned`, `SessionMetadataTurn.status`
 * is a plain string) to a `StatusDot` variant (D8, aligned with B2 #1983's K2 health
 * map so StatusDot semantics stay consistent across Epic B):
 *   - `open`        → ok  (active — the caller adds `animate-pulse`)
 *   - `completed`   → ok
 *   - `interrupted` → warn
 *   - `errored`     → hot
 *   - `orphaned`    → hot
 * Any unknown/absent status → `null` (the caller renders NO dot, per StatusDot's
 * published convention).
 */
export function turnStatusToDot(status: string): StatusDotVariant | null {
  switch (status) {
    case "open":
    case "completed":
      return "ok";
    case "interrupted":
      return "warn";
    case "errored":
    case "orphaned":
      return "hot";
    default:
      return null;
  }
}

/** Severity rank for picking the "worst" dot in a group (hot > warn > ok). */
const DOT_SEVERITY: Record<StatusDotVariant, number> = {
  ok: 0,
  warn: 1,
  hot: 2,
};

/**
 * The session-level dot for a group's collapsed row: the WORST turn status across
 * the group (hot > warn > ok), or `null` when no turn carries a known status (the
 * caller renders no dot). All-nodes groups have empty `turns`, so this returns
 * `null` there (R6 — no per-turn status cross-node).
 */
export function sessionDotStatus(
  turns: SessionMetadataTurn[]
): StatusDotVariant | null {
  let worst: StatusDotVariant | null = null;
  for (const turn of turns) {
    const dot = turnStatusToDot(turn.status);
    if (
      dot != null &&
      (worst === null || DOT_SEVERITY[dot] > DOT_SEVERITY[worst])
    ) {
      worst = dot;
    }
  }
  return worst;
}

/** Whether any turn in the group is still `open` (drives the active/pulse treatment). */
export function isSessionActive(turns: SessionMetadataTurn[]): boolean {
  return turns.some(t => t.status === "open");
}
