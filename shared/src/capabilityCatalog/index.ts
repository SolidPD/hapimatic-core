// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `@hapi/protocol` capability-catalog barrel (issue #3741, Task 4 / R1).
 *
 * 🔒 APPEND-ONLY (coordination constraint CF-2). Sub-Issue C (#3743) is the next
 * writer: it emits `index.generated.ts` into this directory and appends a fourth
 * `export *` line below (that generated file is lint- and `max-lines`-exempt via
 * the `.generated.` ignore glob in `eslint.config.mjs:16`). Do NOT reorder or
 * remove the existing exports — downstream sub-issues import specific symbols and
 * a reorder is a needless churn diff. Mirrors the discipline documented at
 * `shared/src/graph/index.ts:4-7`.
 *
 * This barrel must NEVER re-export the canonical risk-tier vocabulary: `types.ts`
 * IMPORTS it (from `../riskTier`) without re-exporting, and a SECOND star-export
 * of that name reaching `shared/src/index.ts` (on top of `./graph` + `./riskTier`)
 * is a hard TS2308 ambiguous re-export (ER 2026-09-16 D9). `export *` (not
 * `export type *`) because `schema.ts` and `domains.ts` carry runtime exports
 * (`catalogEntrySchema`, `defineCapability`, `DOMAIN_SLUGS`, `DOMAINS`).
 */
export * from "./types";
export * from "./domains";
export * from "./schema";
export * from "./index.generated"; // Sub-Issue C (#3743): committed Tier-0 index.
export * from "./renderTier0"; // Sub-Issue H (#3748): Tier-0 renderer + eligibility.
export * from "./tier0.generated"; // Sub-Issue H (#3748): committed Tier-0 snapshot.
export * from "./availability"; // Sub-Issue I (#3749): session-aware evaluator.
export * from "./infraExclusion"; // Sub-Issue F.1 (#3746): audit infra-exclusion class.
export * from "./promoted"; // Sub-Issue K (#3751): mutating-tier promotion allowlist.
export * from "./renderSelfKnowledge"; // #3873: the pure self-knowledge renderer, reachable at runtime for the boot self-heal writer (no ./capabilityCatalog subpath export exists — server imports only via the @hapi/protocol barrel).
export * from "./selfKnowledge.preamble.generated"; // #3873: embedded preamble const the boot self-heal writer renders with (the .md preamble never ships to the VM).
