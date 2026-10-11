// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Harness provenance — the frozen cross-repo field contract (issue #3130, epic
 * #3117 Sub-Issue P). The drift-detection backbone: names the harness + version,
 * the model, and the exact SHA-pinned canonical blobs a projection was built from.
 *
 * 🔴 CROSS-REPO CONTRACT — the field NAMES here (`runtime.harness.{id,version}`,
 * `model`, `canonical_blob_shas`) are asserted SERVER-SIDE by the rp1-home HAL
 * gate kit (companion epic). A rename here is a cross-repo break; treat the names
 * as FROZEN once agreed (directive OR2). This is the SINGLE source both the
 * hapimatic-private projection AND the rp1-home gate kit reference.
 *
 * Every field is `.optional()` (R4 back-compat): a record WITHOUT the provenance
 * fields must still parse everywhere — legacy records predating #3130, and the
 * projection record before the provenance stage runs. All object schemas take
 * `.passthrough()` per the shared convention ("Always add `.passthrough()` when
 * defining schemas for data that comes from external sources", shared/CLAUDE.md):
 * these records round-trip through GitHub artifacts and are asserted by an
 * EXTERNAL repo's gate kit, so a newer emitter adding a field must never break an
 * older parser (R4's spirit).
 *
 * Kept zod-only (NO node/cli imports) so it is importable by every package — cli,
 * server, AND the browser web bundle — mirroring `harnessManifest.ts`.
 */
import { z } from "zod";

/**
 * The runtime that produced the projection: the harness id (`claude` / `codex` /
 * `gemini` / `opencode`, or any manifest id) plus its version. `version` is the
 * actual installed version when a `<cli> --version` probe succeeds; when the
 * probe is unavailable the emitter records the manifest's verified-against RANGE
 * with an explicit `range:` prefix so a consumer never mistakes a range for an
 * exact version. Optional so a record can omit runtime entirely (R4).
 */
export const harnessRuntimeSchema = z
  .object({
    harness: z
      .object({
        id: z.string(),
        version: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * The provenance tuple carried by a projection manifest (and, downstream, by
 * handoff/land-artifact records — R2, which lands in the rp1-home companion epic
 * per directive KD4). Every field optional (R4). `canonical_blob_shas` is the
 * mechanical drift signal: diffing a session's SHAs against canonical HEAD
 * identifies a stale projection (R5 — see `isProjectionStale`).
 */
export const harnessProvenanceSchema = z
  .object({
    runtime: harnessRuntimeSchema.optional(),
    model: z.string().optional(),
    canonical_blob_shas: z.array(z.string()).optional(),
  })
  .passthrough();

export type HarnessRuntime = z.infer<typeof harnessRuntimeSchema>;
export type HarnessProvenance = z.infer<typeof harnessProvenanceSchema>;
