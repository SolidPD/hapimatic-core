// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import { ChangelogVersionEntrySchema } from "./harnessChangelog";

/**
 * Self-update impact-analysis contract (issue #1772, Sub C of epic #1769
 * "Claude Code self-update from the admin drawer").
 *
 * This is the SINGLE SOURCE OF TRUTH for the on-demand impact analysis:
 *   - `ImpactArtifact`  — the color-coded analysis a peer Claude session
 *                         produces and POSTs back (server persists it keyed by
 *                         `(node_id, harness_id, versionRangeKey)`).
 *   - `UpdateSpan`      — the one-way, pure VALUE object that seeds the peer.
 *                         Built from #1770's `HarnessDescriptor`
 *                         (`coupling_watch_areas`, `analysis_repos`) + #1771's
 *                         parsed `ChangelogSpan` (`versions[]`). #1772 is a pure
 *                         CONSUMER of that data — the data-flow is one-way, so
 *                         this module never imports #1770/#1771 I/O.
 *
 * ── Wire convention (locked epic contract) ──
 * Fields are snake_case on the wire and timestamps are epoch-ms numbers — the
 * artifact reaches the browser (#1773's panel) RAW, with NO camelizing mapper on
 * either side. `.passthrough()` mirrors the `harness.ts` / `harnessChangelog.ts`
 * family so a later sub-issue can add forward-compatible fields without breaking
 * an older consumer. Kept PURE (zod only, no node/server/web imports) so
 * `@hapi/protocol` stays importable by cli, server, AND the browser bundle —
 * same rationale as `systemJobs.ts`.
 *
 * ── Evidence-for-non-gray is a SCHEMA invariant, not a convention ──
 * The issue's acceptance criterion "every non-gray verdict carries an evidence
 * reference" is ENFORCED by `ImpactItemSchema.superRefine` (R3): an artifact with
 * a green/orange/red item and an empty `evidence[]` FAILS validation, so the
 * `/cli/impact-artifact` submit endpoint rejects it with a 400 (validate-on-write,
 * R2). A red/green with no `file:line`/issue ref is noise — the schema refuses it.
 */

// ─── Verdict + impacted-issue sub-schemas ────────────────────

/** The four verdict colors a changelog bullet is classified into (R8).
 *  `gray` = no Hapimatic impact (and the ONLY color exempt from the
 *  evidence requirement). */
export const VerdictColorSchema = z.enum(["green", "orange", "gray", "red"]);
export type VerdictColor = z.infer<typeof VerdictColorSchema>;

/** A repo-qualified, directional reference to a Hapimatic issue the change
 *  touches (R9). `direction` records whether the change helps/hurts/neither.
 *  `repo` is `owner/name` so rp1-home slots in later via `analysis_repos`. */
export const ImpactedIssueSchema = z
  .object({
    repo: z.string().min(1),
    number: z.number().int().positive(),
    direction: z.enum(["positive", "negative", "neutral"]),
    note: z.string(),
  })
  .passthrough();
export type ImpactedIssue = z.infer<typeof ImpactedIssueSchema>;

// ─── Per-item schema (one changelog bullet → one verdict) ────

/**
 * One classified changelog bullet. `version` attributes the bullet to the
 * changelog version it came from (why `UpdateSpan.changelog_versions` carries
 * per-version entries, not a flat list). The `superRefine` enforces R3:
 * a non-gray verdict MUST carry at least one `evidence` reference.
 */
export const ImpactItemSchema = z
  .object({
    version: z.string(),
    bullet: z.string(),
    category: z.string(),
    color: VerdictColorSchema,
    rationale: z.string(),
    /** `file:line` or `#issue` references. REQUIRED (non-empty) for any
     *  non-gray verdict — see the superRefine below. */
    evidence: z.array(z.string()),
    impacted_issues: z.array(ImpactedIssueSchema),
  })
  .passthrough()
  .superRefine((item, ctx) => {
    if (item.color !== "gray" && item.evidence.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message: `a non-gray verdict (color="${item.color}") requires at least one evidence reference (file:line or #issue)`,
      });
    }
  });
export type ImpactItem = z.infer<typeof ImpactItemSchema>;

// ─── Headline roll-up ────────────────────────────────────────

/**
 * The at-a-glance summary of the whole span. `watch_areas_hit` reflects which
 * of the harness's `coupling_watch_areas` a bullet matched (R8).
 * `resolves_or_helps_issues` / `risks_issues` are repo-qualified roll-ups
 * (ImpactedIssueSchema — the bucket name implies the direction, but the shape is
 * reused for consistency + forward-compat).
 */
export const HeadlineSchema = z
  .object({
    overall_color: VerdictColorSchema,
    summary: z.string(),
    must_investigate: z.array(z.string()),
    resolves_or_helps_issues: z.array(ImpactedIssueSchema),
    risks_issues: z.array(ImpactedIssueSchema),
    watch_areas_hit: z.array(z.string()),
  })
  .passthrough();
export type Headline = z.infer<typeof HeadlineSchema>;

// ─── The full artifact (peer → server → store → browser) ─────

/**
 * The complete impact artifact. This IS the wire shape end-to-end: snake_case
 * fields + epoch-ms `analyzed_at` reach #1773's panel raw. `node_id` is
 * server-STAMPED on submit (never trusted from the peer body, R4).
 * `contract_version` lets a schema/seed drift be detected across versions.
 */
export const ImpactArtifactSchema = z
  .object({
    items: z.array(ImpactItemSchema),
    headline: HeadlineSchema,
    from_version: z.string().min(1),
    to_version: z.string().min(1),
    node_id: z.string(),
    harness_id: z.string().min(1),
    repos_checked: z.array(z.string()),
    analyzed_at: z.number(),
    prior_version_for_rollback: z.string().nullable(),
    contract_version: z.number(),
  })
  .passthrough();
export type ImpactArtifact = z.infer<typeof ImpactArtifactSchema>;

// ─── The seed value object (server → peer) ───────────────────

/**
 * The pure VALUE that seeds an analysis. Built by the server from #1770's
 * descriptor + detection state and #1771's parsed changelog — #1772 consumes it
 * one-way and never reaches back into #1770/#1771's I/O. `changelog_versions`
 * reuses #1771's `ChangelogVersionEntry` (`{version, bullets[]}`) so the peer
 * attributes each item's `version` without guessing (imported, NOT duplicated —
 * #1771 is the single owner of that shape).
 */
export const UpdateSpanSchema = z
  .object({
    harness_id: z.string().min(1),
    from_version: z.string().min(1),
    to_version: z.string().min(1),
    changelog_versions: z.array(ChangelogVersionEntrySchema),
    coupling_watch_areas: z.array(z.string()),
    analysis_repos: z.array(z.string()),
    contract_version: z.number(),
  })
  .passthrough();
export type UpdateSpan = z.infer<typeof UpdateSpanSchema>;

// ─── Canonical key + validator ───────────────────────────────

/**
 * The current impact-contract version. Bumped when the artifact shape or the
 * seed-prompt semantics change incompatibly, so a persisted artifact's
 * `contract_version` reveals stale seed/schema drift (OR2).
 */
export const IMPACT_CONTRACT_VERSION = 1;

/**
 * The ONE canonical key for a version-range (R10). The writer (store upsert) and
 * every reader (status lookup) MUST derive the key through this function so a
 * lookup cannot mis-hit due to whitespace or a different join. Inputs are
 * trimmed and joined with a `→` separator (unambiguous — a semver string never
 * contains it). If semver normalization is ever wanted, add it HERE only.
 */
export function versionRangeKey(from: string, to: string): string {
  return `${from.trim()}→${to.trim()}`;
}

/**
 * Result of validating an unknown input against the impact-artifact schema.
 * Named `ValidateImpactArtifactResult` (not the generic `Validate…Result`) to
 * avoid a duplicate-export collision with `systemJobs.ts`'s
 * `ValidateRegistryResult` under `shared/src/index.ts`'s `export *`.
 */
export type ValidateImpactArtifactResult =
  | { ok: true; artifact: ImpactArtifact }
  | { ok: false; error: string };

/**
 * Validate an unknown input against the impact-artifact schema. Returns
 * `{ok:true, artifact}` on success or `{ok:false, error}` with the Zod message
 * (including the evidence-for-non-gray refinement failure) on invalid input.
 * Never throws — the submit endpoint (`/cli/impact-artifact`) calls this and
 * maps `!ok` to HTTP 400; the store calls it again before INSERT (defense in
 * depth). Mirrors `validateSystemJobsRegistry`.
 */
export function validateImpactArtifact(
  input: unknown
): ValidateImpactArtifactResult {
  const result = ImpactArtifactSchema.safeParse(input);
  if (!result.success) return { ok: false, error: result.error.message };
  return { ok: true, artifact: result.data };
}
