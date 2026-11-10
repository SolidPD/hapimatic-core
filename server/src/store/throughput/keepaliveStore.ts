// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import type { CacheKeepaliveOutcome } from "@hapi/protocol";

/**
 * The prompt-cache keep-alive ledger (issue #6169, R6): how many keep-alives this
 * node sent, refused or failed per UTC day, with the tokens each one is
 * estimated to have billed. Written by the keep-alive service, read by the A1
 * summary. Node-local (keep-alives are never mirrored) and outside the rollup
 * tables, so a rollup rebuild leaves it untouched and a write here never bumps
 * `rollup.generation`. Pruned by `ThroughputRollupStore.pruneBefore`.
 */

export interface KeepaliveLedgerEntry {
  ns: string;
  origin: string;
  /** UTC `YYYY-MM-DD`. */
  day: string;
  outcome: CacheKeepaliveOutcome;
  /** Why it was refused or failed (a CLI refusal code, or a server code); "" when sent. */
  code: string;
  /** The session's resolved model, or null when it reported none. */
  model: string | null;
  /** Cache-read tokens the side question is estimated to have read. */
  crTokens: number;
  inTokens: number;
  outTokens: number;
}

export interface KeepaliveLedgerSum {
  outcome: CacheKeepaliveOutcome;
  code: string;
  model: string | null;
  n: number;
  crTokens: number;
  inTokens: number;
  outTokens: number;
}

function int(v: number): number {
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

export class ThroughputKeepaliveStore {
  constructor(private readonly db: Database) {}

  /** Add one keep-alive attempt to its day's row (an additive upsert). */
  record(entry: KeepaliveLedgerEntry): void {
    this.db
      .prepare(
        `INSERT INTO throughput_keepalive_daily (
           ns, origin, day, outcome, code, model, n, cr_tokens, in_tokens, out_tokens
         ) VALUES (@ns, @origin, @day, @outcome, @code, @model, 1, @cr, @in, @out)
         ON CONFLICT (ns, origin, day, outcome, code, model) DO UPDATE SET
           n = n + 1,
           cr_tokens = cr_tokens + excluded.cr_tokens,
           in_tokens = in_tokens + excluded.in_tokens,
           out_tokens = out_tokens + excluded.out_tokens`
      )
      .run({
        ns: entry.ns,
        origin: entry.origin,
        day: entry.day,
        outcome: entry.outcome,
        code: entry.code,
        model: entry.model ?? "",
        cr: int(entry.crTokens),
        in: int(entry.inTokens),
        out: int(entry.outTokens),
      });
  }

  /**
   * Sums for days `fromDay..toDay` (inclusive) by outcome, code and model, in one
   * namespace (`null`: every namespace, for the offline report).
   */
  sum(
    fromDay: string,
    toDay: string,
    namespace: string | null
  ): KeepaliveLedgerSum[] {
    const rows = this.db
      .prepare(
        `SELECT outcome, code, model, SUM(n) AS n, SUM(cr_tokens) AS cr,
                SUM(in_tokens) AS tin, SUM(out_tokens) AS tout
           FROM throughput_keepalive_daily
          WHERE day >= $from AND day <= $to AND ($ns IS NULL OR ns = $ns)
          GROUP BY outcome, code, model
          ORDER BY outcome, code, model`
      )
      .all({ from: fromDay, to: toDay, ns: namespace }) as Array<
      Record<string, unknown>
    >;
    return rows.map(r => ({
      outcome: String(r.outcome) as CacheKeepaliveOutcome,
      code: String(r.code),
      model: r.model === "" ? null : String(r.model),
      n: Number(r.n),
      crTokens: Number(r.cr),
      inTokens: Number(r.tin),
      outTokens: Number(r.tout),
    }));
  }
}
