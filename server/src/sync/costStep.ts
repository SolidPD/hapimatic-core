// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import { computeTurnCost } from "../store/turns/cost";

import type { FinalizeStep } from "./turnLifecycle";

/**
 * Sub E live cost snapshot — the `costStep` finalize seam wired LIVE (issue #1667
 * declared the seam; issue #3353 / S-4 plugs it in).
 *
 * `createCostStep(db)` returns a {@link FinalizeStep} that prices the finalizing
 * turn against the rate card in effect at its `started_at_ms`, using the token /
 * model / provider columns the EARLIER steps produced — `parseStep` for a claude
 * turn (transcript-derived), `cliUsageStep` for a non-claude turn (issue #3352,
 * from the CLI usage block). Those columns live in the finalize ACCUMULATOR, not
 * in `ctx.event`, which is why this step consumes the `accumulated` argument
 * (issue #3353 widened `FinalizeStep` for exactly this). It returns the six cost
 * columns as finalize enrichment, so `turns.cost_total` is written LIVE at
 * finalize instead of only by the offline `backfill-costs` script — the fact S-4
 * corrected ("#1671 was tokens-live / costs-offline").
 *
 * Ordering (wired in `server/src/index.ts`): AFTER `parseStep`/`cliUsageStep`, so
 * the columns it prices are already in the accumulator. It mirrors `backfillCosts`
 * (`store/turns/backfill.ts`) — the SAME `computeTurnCost` call, keyed on the
 * turn's provider/model/started-at/token-counts — so a live-priced turn and a
 * backfilled turn agree by construction. It NEVER touches the offline backfill,
 * which remains the repair path for historical NULLs (Fallback Preservation Rule).
 *
 * Fail-open: a throw is caught by the seam's per-step try/catch
 * (`runFinalizeSteps`) and degrades to no enrichment (the cost columns stay NULL —
 * R4/R5). No-op cases return `{}` (leaving costs NULL, and NOT invoking
 * `computeTurnCost`, so no spurious "no rate card" warning is logged): a turn with
 * no resolved model, or whose open row cannot be read for its `started_at_ms`.
 */
export function createCostStep(db: Database): FinalizeStep {
  const startedAtStmt = db.prepare(
    `SELECT started_at_ms AS startedAtMs FROM turns
      WHERE hapi_session_id = @sid AND seq = @seq LIMIT 1`
  );

  return (ctx, accumulated) => {
    const acc = accumulated ?? {};
    const modelId = acc.modelId ?? null;
    // No model attributed to this turn (parse failure, or a tool-only turn with
    // no model) → nothing to price. Skip WITHOUT calling computeTurnCost so it
    // emits no spurious unknown-model warning; the columns stay NULL → UI "—".
    if (modelId == null) return {};

    const row = startedAtStmt.get({ sid: ctx.hapiSessionId, seq: ctx.seq }) as
      | { startedAtMs: number }
      | undefined
      | null;
    if (!row || typeof row.startedAtMs !== "number") return {};

    const costs = computeTurnCost(db, {
      // The turn's TRUE provider from the accumulator (#3352 writes it for
      // non-claude; `parseStep` sets "anthropic" for claude). A NULL provider
      // defaults to anthropic inside computeTurnCost.
      provider: acc.modelProvider ?? undefined,
      modelId,
      startedAtMs: row.startedAtMs,
      tokIn: acc.tokIn,
      tokOut: acc.tokOut,
      tokCacheRead: acc.tokCacheRead,
      tokCacheWrite: acc.tokCacheWrite,
    });

    return {
      costIn: costs.costIn,
      costOut: costs.costOut,
      costCacheRead: costs.costCacheRead,
      costCacheWrite: costs.costCacheWrite,
      costTotal: costs.costTotal,
      rateCardId: costs.rateCardId,
    };
  };
}
