// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-entry mutating-tier promotion allowlist (issue #3751, epic #3740 Sub-Issue K
 * / R4 — TRUST-CRITICAL, expert-review gated).
 *
 * The generic REST invoker (`server/src/web/routes/capabilityCall.ts`) launches a
 * catalog entry iff its trusted `riskTier` is invocable: `readonly` always,
 * `destructive` NEVER, and `mutating` ONLY when its `id` is in this allowlist.
 * The list is the SINGLE intended widening of the invoke surface beyond `readonly`.
 *
 * 🔒 A CODE CONSTANT, NEVER AN ENV/CONFIG KNOB (#2419 KD-5 — mirrors the landed
 * comment at `server/src/web/routes/capabilityPolicy.ts:26-29`). Adding an id here
 * is a REVIEWED edit: it is consulted ONLY after the fail-closed tier check, ONLY
 * for `mutating`, and is IGNORED for `destructive`. `capabilityPolicy.ts`'s
 * `isEntryInvocable` is the sole reader.
 *
 * 🌱 SEEDED EMPTY (R4 / ER 2026-09-16 3751-17). The scheduler CRUD ids are added in
 * a FOLLOW-UP PR: their `scheduler.*` rest entries are produced by #3746 (K only
 * `coordinates_with` it), so seeding them now would either resolve to nothing
 * (until F's scheduler PR lands) or couple K's merge to F's tier decisions. An
 * empty seed keeps the guard sound (it runs over real data + synthetic bad ids in
 * `promoted.test.ts`) and decouples K from F.
 *
 * Bundle note (ER 2026-09-16 3751-21): this module is re-exported through the
 * `capabilityCatalog` barrel → `shared/src/index.ts` (the `"."` export), so it
 * ships in the pre-auth web bundle. That is required for `server/`'s
 * `isEntryInvocable` to import it across the package boundary (there is no
 * `./capabilityCatalog` subpath in `shared/package.json`). The EMPTY seed
 * discloses nothing. When the follow-up PR promotes ids, reconsider homing the
 * constant under `server/` if #3752's web panel does not consume it — a non-empty
 * list would otherwise publish "which mutating capabilities an agent may invoke on
 * this build" to the browser.
 */

/**
 * The explicit ids whose `mutating` tier is invocable through the generic REST
 * invoker. Every id MUST resolve in the built index to a `surface: "rest"`,
 * `riskTier: "mutating"`, `trusted !== false`, user-scope entry — enforced by the
 * guard in `promoted.test.ts`, not by review alone.
 */
export const PROMOTED_ENTRY_IDS: readonly string[] = [];
