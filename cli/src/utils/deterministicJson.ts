// SPDX-License-Identifier: MIT AND AGPL-3.0-only
/**
 * Deterministic JSON utilities — re-export from `@hapi/protocol`.
 *
 * The canonical implementation was promoted to `shared/src/deterministicJson.ts`
 * (issue #2886, coordination constraint CF-7) so the graph compiler in
 * `shared/src/graph/compile/` — which sits BELOW `cli` in the package layering —
 * can reuse the SAME `deterministicStringify` / `hashObject` primitive for both
 * deterministic compilation (R1) and the STRICT_RESUME launch hash (R2).
 *
 * This module is a byte-for-byte re-export so every existing cli call-site keeps
 * resolving `deterministicStringify`, `hashObject`, `deepEqual`, `objectKey`, and
 * `DeterministicJsonOptions` unchanged — and, critically, keeps producing
 * byte-identical hashes (the move relocated the code without altering it; a
 * golden-hash regression test guards this in `shared`).
 */
export * from "@hapi/protocol/deterministicJson";
