// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

/**
 * The ONE canonical risk-tier vocabulary for the whole repo (issue #3741, Task 0).
 *
 * A capability's risk classification gating the generic-invoke path (epic #2416):
 * `readonly` methods are the only tier the generic `POST` invoke path launches
 * with; `mutating`/`destructive` keep bespoke routes until explicitly promoted by
 * allowlist.
 *
 * 🔒 SINGLE DECLARATION (ER 2026-09-16 D9). This is the sole `RiskTier`
 * declaration repo-wide. `shared/src/graph/ir.ts`, `cli/src/api/rpc/types.ts`, and
 * `shared/src/capabilityCatalog/` all IMPORT (or alias-re-export) from here — a
 * second *declaration* reaching `shared/src/index.ts` via `export *` is a hard
 * TS2308 ambiguous re-export. Alias re-exports of THIS declaration are safe. The
 * server's inline `z.enum` at `server/src/socket/handlers/cli/rpcHandlers.ts` is
 * intentionally NOT folded in here — that is a separate follow-up, out of #3741.
 */
export const RISK_TIERS = ["readonly", "mutating", "destructive"] as const;
export const RiskTierSchema = z.enum(RISK_TIERS);
export type RiskTier = z.infer<typeof RiskTierSchema>;
