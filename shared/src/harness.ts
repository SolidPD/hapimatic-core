// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

/**
 * Harness self-update descriptor + detection-state contract (issue #1770,
 * epic #1769 "Claude Code self-update from the admin drawer").
 *
 * This is the SINGLE SOURCE OF TRUTH for the harness-update registry's type
 * surface. Sub A OWNS these types; the downstream sub-issues import them and
 * define NO parallel registry types of their own:
 *   - #1771 (changelog display)   — imports HarnessDetectionState; the cached
 *                                    changelog is served server-side via
 *                                    HarnessStore.getChangelogText, NOT this wire type.
 *   - #1772 (analysis artifacts)  — additive row table keyed like the state row.
 *   - #1774 (apply update/rollback) — reads install_flavors command templates.
 *   - #1775 (settings / manual trigger) — reads the poll config + detection state.
 *
 * Kept zod-only (NO node/server/web imports) so `@hapi/protocol` remains
 * importable by every package — cli, server, AND the browser web bundle. The
 * code-defined registry ARRAY with the real privileged commands lives in the
 * server package (`server/src/harness/registry.ts`), never here (web imports
 * `@hapi/protocol`, so a real command in shared would ship to the browser).
 *
 * ── Disambiguation: three "harness" id spaces coexist in @hapi/protocol ──
 *   - THIS file's `HarnessDescriptor` — a self-UPDATE unit (id `"claude-code"`),
 *     carrying detect / npm-latest / changelog / install-flavor command templates.
 *   - `harnessManifest.ts` `HarnessManifest` (HAL, epic #3117) — a CAPABILITY
 *     manifest keyed by AGENT FLAVOR (`claude|codex|gemini|opencode`), describing
 *     what a CLI can do across skills/hooks/mcp/... axes. Different id space.
 *   - `aboutInfo.ts` `HarnessInfo` (#1984) — an agent-flavor AVAILABILITY probe
 *     (`flavor`, `available`, `version`) for the About page.
 *   The `"claude-code"` DESCRIPTOR id here maps to the `"claude"` agent FLAVOR
 *   used by the other two. Detection here differs from
 *   `server/src/metrics/aboutInfo.ts` `detectHarnessVersion()` (regex extraction,
 *   non-PATH binary resolution via KD-5, and persistence of the result).
 *
 * `.passthrough()` on the descriptor/state schemas accepts forward-compatible
 * additions from later sub-issues without breaking older consumers (mirrors
 * `systemJobs.ts`). The command fields are NOT control-char-refined: they are
 * out-of-band, code-defined data (never user input) — same rationale as the
 * `SystemJobSchema.command` comment.
 */

// ─── Descriptor sub-schemas ──────────────────────────────────

/** How to read the INSTALLED version of a harness (a code-defined command +
 *  the regex that extracts the version from its stdout). Privileged — redacted
 *  from the web. */
export const HarnessDetectSchema = z.object({
  cmd: z.string().min(1),
  version_regex: z.string().min(1),
});

/** Where the LATEST installable version comes from. `type` discriminates the
 *  fetch strategy so a future `github_release` harness is purely additive. */
export const HarnessLatestSourceSchema = z.object({
  type: z.enum(["npm", "github_release"]),
  ref: z.string().min(1),
});

/** The narrative changelog source (fetched + cached during the poll; #1771
 *  renders it). `type` is a free-form hint (e.g. `"github_markdown"`). */
export const HarnessChangelogSchema = z.object({
  type: z.string().min(1),
  url: z.string().url(),
});

/** The install flavor of a harness on a given host. `npm` = a global npm
 *  package; `native` = the vendor's own installer layout
 *  (`~/.local/share/claude/versions/<v>`). #1774 detects the active flavor at
 *  execution time and picks the matching command templates. */
export const InstallFlavorSchema = z.enum(["npm", "native"]);
export type InstallFlavor = z.infer<typeof InstallFlavorSchema>;

/** The update + rollback command TEMPLATES for one install flavor. `{version}`
 *  / `{prior_version}` are substituted by #1774 at execution time. Privileged —
 *  redacted from the web. */
export const HarnessFlavorCommandsSchema = z.object({
  update: z.object({ cmd: z.string().min(1) }),
  rollback: z.object({ cmd: z.string().min(1) }),
});

/** Per-flavor command templates. Both flavors are required so #1774 always has
 *  a template for whichever flavor it detects on the host. */
export const HarnessInstallFlavorsSchema = z.object({
  npm: HarnessFlavorCommandsSchema,
  native: HarnessFlavorCommandsSchema,
});

// ─── Full descriptor (server-side; carries privileged commands) ───

export const HarnessDescriptorSchema = z
  .object({
    id: z.string().min(1),
    display_name: z.string().min(1),
    is_session_backend: z.boolean(),
    detect: HarnessDetectSchema,
    latest_source: HarnessLatestSourceSchema,
    changelog: HarnessChangelogSchema,
    install_flavors: HarnessInstallFlavorsSchema,
    coupling_watch_areas: z.array(z.string()),
    analysis_repos: z.array(z.string()),
  })
  .passthrough();

export type HarnessDescriptor = z.infer<typeof HarnessDescriptorSchema>;

// ─── Redacted descriptor (web-facing; CANNOT carry commands) ───

/**
 * The web-safe projection of a descriptor. A whitelist that STRUCTURALLY omits
 * `detect` and `install_flavors` (the privileged command templates) — the
 * redacted TYPE cannot even represent them, so a command can never leak through
 * `GET /api/harness/status`. Built field-by-field by
 * `toRedactedHarnessDescriptor` (server) — never a spread (mirrors
 * `RedactedAccount` / `toRedactedAccount`).
 */
export const RedactedHarnessDescriptorSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().min(1),
  is_session_backend: z.boolean(),
  latest_source: HarnessLatestSourceSchema,
  changelog: HarnessChangelogSchema,
  coupling_watch_areas: z.array(z.string()),
  analysis_repos: z.array(z.string()),
});

export type RedactedHarnessDescriptor = z.infer<
  typeof RedactedHarnessDescriptorSchema
>;

// ─── Detection state (persisted per (node, harness); web-facing) ───

/**
 * The persisted + web-facing detection state for one (node, harness). This is
 * the wire shape returned by `GET /api/harness/status`. It DELIBERATELY has NO
 * `changelog_text` field: the ~126 KB changelog is persisted alongside this row
 * but read back ONLY server-side via `HarnessStore.getChangelogText` (KD-7),
 * which is how #1771 serves it without bloating every status payload.
 */
export const HarnessDetectionStateSchema = z
  .object({
    node_id: z.string(),
    harness_id: z.string(),
    installed_version: z.string().nullable(),
    latest_version: z.string().nullable(),
    prior_version: z.string().nullable(),
    update_available: z.boolean(),
    last_checked_at: z.number().nullable(),
    last_error: z.string().nullable(),
    last_error_at: z.number().nullable(),
  })
  .passthrough();

export type HarnessDetectionState = z.infer<typeof HarnessDetectionStateSchema>;

// ─── Registry ────────────────────────────────────────────────

export const HarnessRegistrySchema = z.array(HarnessDescriptorSchema);
export type HarnessRegistry = z.infer<typeof HarnessRegistrySchema>;

/**
 * Result of validating an unknown input against the harness-registry schema.
 *
 * NOTE: named `HarnessRegistryValidationResult` — NOT `ValidateRegistryResult`
 * — because `systemJobs.ts` already barrel-exports a `ValidateRegistryResult`
 * from `@hapi/protocol`, and `shared/src/index.ts` re-exports both via
 * `export *` (a same-name export would be a duplicate-export error).
 */
export type HarnessRegistryValidationResult =
  | { ok: true; registry: HarnessRegistry }
  | { ok: false; error: string };

/**
 * Validate an unknown input against the harness-registry schema. Returns
 * `{ok:true, registry}` on success or `{ok:false, error}` with the Zod message
 * on failure. Never throws — the registry module (`server/src/harness/registry.ts`)
 * calls this at module load and throws on `!ok` itself (fail-fast on a bad
 * committed descriptor).
 */
export function validateHarnessRegistry(
  input: unknown
): HarnessRegistryValidationResult {
  const result = HarnessRegistrySchema.safeParse(input);
  if (!result.success) return { ok: false, error: result.error.message };
  return { ok: true, registry: result.data };
}
