// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Dollars metered on one vault key (#6789): the SQL and the two computations
 * {@link TurnStore.sumApiKeyCost} and {@link TurnStore.apiKeySpendReader}
 * delegate to, moved out of `turnStore.ts` to keep it under the 1,500-line cap.
 */
import type { Database } from "bun:sqlite";
import { TURN_MIRROR_API_KEY_EXPR, tableHasColumns } from "./schema";

/**
 * #6789 (Task 6, remedy 1): a key's metered turns in [@from, @to), as ONE
 * statement of two disjoint branches: the key's own id, and its federation
 * binding refs (`<id>@<homeNodeId>`, the range [@lo, @hi)). The former single
 * `(api_key_id = @id OR range) AND started_at_ms …` predicate lost the
 * `idx_turns_api_key_started` index on a key-dense ledger once planner
 * statistics existed (the planner took `idx_turns_started` and scanned every
 * turn in the window); the unary `+` keeps the range branch on the key index.
 * The branches never overlap (an id never contains "@"), so the sum is
 * unchanged, and `UNION ALL` reads one snapshot.
 */
/** A key's mirrored turns from other nodes (#4614) in [@from, @to): its own
 *  id and its federation binding refs, through `idx_turn_mirror_api_key`. */
export const API_KEY_MIRROR_SPEND_SQL = `SELECT COALESCE(SUM(json_extract(row_json, '$.cost_total')), 0) AS c
    FROM turn_mirror
   WHERE ${TURN_MIRROR_API_KEY_EXPR} IS NOT NULL
     AND (${TURN_MIRROR_API_KEY_EXPR} = @id
       OR (${TURN_MIRROR_API_KEY_EXPR} >= @lo AND ${TURN_MIRROR_API_KEY_EXPR} < @hi))
     AND started_at_ms >= @from AND started_at_ms < @to`;

export const API_KEY_TURNS_SPEND_SQL = `SELECT COALESCE(SUM(c), 0) AS c FROM (
    SELECT cost_total AS c FROM turns
     WHERE api_key_id = @id AND started_at_ms >= @from AND started_at_ms < @to
    UNION ALL
    SELECT cost_total AS c FROM turns
     WHERE api_key_id >= @lo AND api_key_id < @hi
       AND +started_at_ms >= @from AND +started_at_ms < @to
  )`;

/**
 * Dollars metered on one vault key for work that started in [fromMs, toMs):
 * its turns plus its background agents. Matches the key's own id and a
 * federation binding ref to it (`<id>@<homeNodeId>`; the range bound keeps the
 * index usable). Counts this node's turns and background agents, and the
 * other nodes' turns mirrored here (#4614). 0 when the binding columns are
 * missing (the caller checks them) or the window is empty.
 */
export function sumApiKeyCostIn(
  db: Database,
  apiKeyId: string,
  fromMs: number,
  toMs: number
): number {
  if (!(toMs > fromMs)) return 0;
  const params = {
    id: apiKeyId,
    lo: `${apiKeyId}@`,
    hi: `${apiKeyId}A`,
    from: fromMs,
    to: toMs,
  };
  const keyMatch =
    "(api_key_id = @id OR (api_key_id >= @lo AND api_key_id < @hi))";
  const sum = (table: "background_agent_usage"): number => {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(cost_total), 0) AS c FROM ${table}
          WHERE ${keyMatch} AND started_at_ms >= @from AND started_at_ms < @to`
      )
      .get(params) as { c: number } | null;
    return row?.c ?? 0;
  };
  const turns = db.prepare(API_KEY_TURNS_SPEND_SQL).get(params) as {
    c: number;
  } | null;
  let total = turns?.c ?? 0;
  if (tableHasColumns(db, "background_agent_usage", ["api_key_id"])) {
    total += sum("background_agent_usage");
  }
  // A key shared with the federation (#5127) is also spent by sessions on
  // other nodes; their finalized turns arrive as mirror rows (#4614).
  if (tableHasColumns(db, "turn_mirror", ["row_json"])) {
    const row = db.prepare(API_KEY_MIRROR_SPEND_SQL).get(params) as {
      c: number;
    } | null;
    total += row?.c ?? 0;
  }
  return total;
}

/**
 * #6789 (Task 6, rung 2): a spend reader for ONE list of keys, answering
 * exactly what {@link sumApiKeyCostIn} answers. `background_agent_usage` has no
 * index on `api_key_id`, so every `sumApiKeyCost` call scans it; this reader
 * loads its key-bound rows from `sinceMs` on ONCE (on its first call), buckets
 * them by key — a federation ref `<id>@<homeNodeId>` counted under `<id>` —
 * and sums each window from prefix sums. Turns and mirror rows stay one
 * indexed query per call. A call whose window starts before the loaded rows
 * reloads from that start, so the answer stays exact. Short-lived: built per
 * list and dropped with it, so it never serves a stale figure for long.
 */
export function createApiKeySpendReader(
  db: Database,
  sinceMs: number
): (apiKeyId: string, fromMs: number, toMs: number) => number {
  const hasBackground = tableHasColumns(db, "background_agent_usage", [
    "api_key_id",
  ]);
  const hasMirror = tableHasColumns(db, "turn_mirror", ["row_json"]);
  const turnsStmt = db.prepare(API_KEY_TURNS_SPEND_SQL);
  const mirrorStmt = hasMirror ? db.prepare(API_KEY_MIRROR_SPEND_SQL) : null;
  let loadedFrom = Number.POSITIVE_INFINITY;
  let buckets = new Map<string, { at: number[]; prefix: number[] }>();
  const load = (from: number): void => {
    const rows = db
      .prepare(
        `SELECT api_key_id AS k, started_at_ms AS at, cost_total AS c
           FROM background_agent_usage
          WHERE api_key_id IS NOT NULL AND started_at_ms >= ?
          ORDER BY started_at_ms`
      )
      .all(from) as Array<{ k: string; at: number; c: number | null }>;
    const next = new Map<string, { at: number[]; prefix: number[] }>();
    for (const row of rows) {
      const at = row.k.indexOf("@");
      const base = at === -1 ? row.k : row.k.slice(0, at);
      let bucket = next.get(base);
      if (!bucket) {
        bucket = { at: [], prefix: [0] };
        next.set(base, bucket);
      }
      bucket.at.push(row.at);
      bucket.prefix.push(
        bucket.prefix[bucket.prefix.length - 1]! + (row.c ?? 0)
      );
    }
    buckets = next;
    loadedFrom = from;
  };
  /** First index whose start is >= ms. */
  const lowerBound = (at: number[], ms: number): number => {
    let lo = 0;
    let hi = at.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (at[mid]! < ms) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return (apiKeyId, fromMs, toMs) => {
    if (!(toMs > fromMs)) return 0;
    const params = {
      id: apiKeyId,
      lo: `${apiKeyId}@`,
      hi: `${apiKeyId}A`,
      from: fromMs,
      to: toMs,
    };
    let total = (turnsStmt.get(params) as { c: number } | null)?.c ?? 0;
    if (hasBackground) {
      if (apiKeyId.includes("@")) {
        // Not a vault id: bucketing by the part before "@" would not match
        // the SQL key match, so ask the table directly.
        total +=
          (
            db
              .prepare(
                `SELECT COALESCE(SUM(cost_total), 0) AS c FROM background_agent_usage
                  WHERE (api_key_id = @id OR (api_key_id >= @lo AND api_key_id < @hi))
                    AND started_at_ms >= @from AND started_at_ms < @to`
              )
              .get(params) as { c: number } | null
          )?.c ?? 0;
      } else {
        if (fromMs < loadedFrom) load(Math.min(fromMs, sinceMs));
        const bucket = buckets.get(apiKeyId);
        if (bucket) {
          const a = lowerBound(bucket.at, fromMs);
          const b = lowerBound(bucket.at, toMs);
          total += bucket.prefix[b]! - bucket.prefix[a]!;
        }
      }
    }
    if (mirrorStmt) {
      total += (mirrorStmt.get(params) as { c: number } | null)?.c ?? 0;
    }
    return total;
  };
}
