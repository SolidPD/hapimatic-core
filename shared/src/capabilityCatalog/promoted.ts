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
 * 🌱 SEEDED EMPTY by #3751 (R4 / ER 2026-09-16 3751-17); FIRST PROMOTIONS by #3842
 * (operator ruling 4403 T2, 2026-09-30, authorization path (i)): the eight
 * `mutating` entries the injected hapi MCP's typed session / worktree / schedule
 * tools wrap (they also wrap the readonly `session-introspection.list`). Each id
 * is a reviewed edit with its own comment below.
 *
 * ⚠️ WHAT A PROMOTION WIDENS (#3842 Key Decision 1): the promotion is per ENTRY,
 * not per tool, so it opens RAW `hapi_call` to every agent as well — for example
 * `{POST, /api/sessions/<peer>/messages}`. The ruling accepts this. The refusals the
 * ruling demands therefore live in the ROUTES, where raw `hapi_call` cannot step
 * around them (`server/src/web/routes/agentEscalation.ts`): a session cannot answer
 * its own permission request (R6), and a session that is not in a bypass mode
 * cannot spawn a `yolo` peer, write a schedule, or answer any permission request
 * (R8, ruling NEW-3842-1 = b). #5616 (ruling CK1) adds the same caller's send
 * and archive floors: it cannot message a session that counts as bypass, and can
 * archive only itself or a session it spawned. Every id below must have a floor
 * disposition in `server/src/web/routes/agentEscalation.coverage.test.ts`, which
 * fails when one is added without it (#5616 D8).
 *
 * Bundle note (ER 2026-09-16 3751-21): this module is re-exported through the
 * `capabilityCatalog` barrel → `shared/src/index.ts` (the `"."` export), which
 * `server/`'s `isEntryInvocable` needs to import it across the package boundary
 * (there is no `./capabilityCatalog` subpath in `shared/package.json`).
 *
 * Home reconsidered when the list became non-empty (#3842 decision D2 = A): it
 * STAYS in `@hapi/protocol`. `web/src` imports neither this list nor the catalog
 * index, and `@hapi/protocol` is `sideEffects: false`, so the web bundle does not
 * ship it today (verified: the built `web/dist` carries no catalog entry ids). If
 * #3752's web panel ever imports it, reconsider homing it under `server/`.
 */

/**
 * The explicit ids whose `mutating` tier is invocable through the generic REST
 * invoker. Every id MUST resolve in the built index to a `surface: "rest"`,
 * `riskTier: "mutating"`, `trusted !== false`, user-scope entry — enforced by the
 * guard in `promoted.test.ts`, not by review alone.
 */
export const PROMOTED_ENTRY_IDS: readonly string[] = [
  "machine-daemon.machine-spawn", // [RULING 2026-09-30: 4403 T2] #3842 spawn_session
  "messaging.send-message", // [RULING 2026-09-30: 4403 T2] #3842 send_message
  "messaging.list-messages", // [RULING 2026-09-30: 4403 T2] #3842 read_session_messages
  "session-lifecycle.archive", // [RULING 2026-09-30: 4403 T2] #3842 archive_session
  "scheduler.create", // [RULING 2026-09-30: 4403 T2] #3842 create_schedule
  "scheduler.update", // [RULING 2026-09-30: 4403 T2] #3842 update_schedule
  "model-permission.approve-permission", // [RULING 2026-09-30: 4403 T2] #3842 respond_to_permission
  "model-permission.deny-permission", // [RULING 2026-09-30: 4403 T2] #3842 respond_to_permission
];
