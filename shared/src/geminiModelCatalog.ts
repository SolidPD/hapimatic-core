// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Gemini native model catalog (issue #3348, epic #3345 model-axis parity).
 *
 * A CURATED STATIC catalog of the Google models the Create-Session gemini picker
 * offers. This is deliberately UNLIKE {@link ./modelCatalog.ts} (the Claude
 * catalog), which is live-fetch + cache + fallback: the gemini catalog is static
 * by design — Hapimatic delivers no gemini credential (`authBinding: "inherited"`,
 * see `harnessManifests/gemini.ts`), so there is no authenticated context to run a
 * live Google Models API call at render time. We reuse modelCatalog.ts's zod-schema
 * discipline (browser-safe, zod-only), NOT its fetch machinery.
 *
 * ⚠️ MAINTENANCE — these ids are an EXTERNAL contract that drifts. The list was
 * verified against the Google AI for Developers changelog + deprecations page on
 * the date in {@link GEMINI_CATALOG_VERIFIED_AGAINST}. When Google ships a new
 * Gemini generation (or a listed model shuts down), update this file. The 2.5 tier
 * is flagged `deprecating` — Google shuts `gemini-2.5-pro` / `gemini-2.5-flash`
 * down on 2026-10-16 (Gemini Developer API) — do NOT center the catalog on them.
 *
 * CONVEYANCE (ruling D3(a)): the selected id reaches the spawned gemini child via
 * the `GEMINI_MODEL` env var (the daemon's `extraEnv`), NOT an argv `--model`
 * append — the Hapimatic gemini wrapper (`geminiCommand.ts`) parses only
 * `--started-by`/`--yolo` and silently drops unknown argv. Gemini's documented
 * precedence is `--model` flag > `GEMINI_MODEL` env > settings.
 */
import { z } from "zod";

/**
 * A single Gemini model as surfaced to the picker. `id` is the raw value written
 * to `GEMINI_MODEL` / passed to `gemini --model`; `deprecating` flags a tier
 * Google has scheduled for shutdown so the picker can visually mark it.
 */
export const GeminiModelInfoSchema = z.object({
  /** Raw model id, e.g. "gemini-3.1-pro-preview" — the GEMINI_MODEL value. */
  id: z.string().min(1),
  /** Human-friendly name, e.g. "Gemini 3.1 Pro". */
  displayName: z.string().min(1),
  /** Coarse tier for grouping/labeling. */
  tier: z.enum(["pro", "flash"]),
  /** True when Google has scheduled this model for shutdown (2.5 tier, Oct 2026). */
  deprecating: z.boolean().optional(),
});
export type GeminiModelInfo = z.infer<typeof GeminiModelInfoSchema>;

/**
 * The `verifiedAgainst` stamp for this catalog (the manifest-convention version
 * marker). Records the verification date + source AND the external `GEMINI_MODEL`
 * precedence contract, so a gemini-cli precedence change is detectable at review.
 */
export const GEMINI_CATALOG_VERIFIED_AGAINST =
  "gemini model ids verified 2026-09-20 (Google AI for Developers changelog + deprecations page); " +
  "conveyance contract: gemini CLI precedence `--model` flag > `GEMINI_MODEL` env > settings (web-sourced 2026-08)";

/**
 * The empty-string sentinel = "Auto" (the gemini CLI's own default model
 * selection). Auto is a first-class picker option (the DEFAULT), rendered from
 * {@link GEMINI_AUTO_LABEL}; it is NOT a catalog array entry because it maps to
 * "omit GEMINI_MODEL", not a concrete id. Mirrors the Claude picker's `"" = Default`.
 */
export const GEMINI_AUTO_MODEL_ID = "";
/** Display label for the Auto (omit-GEMINI_MODEL) option. */
export const GEMINI_AUTO_LABEL = "Auto (Gemini default)";

/**
 * Curated static catalog. Gemini 3.x is primary; the 2.5 tier is included but
 * flagged `deprecating` (shutdown 2026-10-16). Ordered newest-first per tier.
 */
export const GEMINI_MODEL_CATALOG: GeminiModelInfo[] = [
  {
    id: "gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro",
    tier: "pro",
  },
  {
    id: "gemini-3.8-flash",
    displayName: "Gemini 3.8 Flash",
    tier: "flash",
  },
  {
    id: "gemini-3.7-flash",
    displayName: "Gemini 3.7 Flash",
    tier: "flash",
  },
  {
    id: "gemini-3.6-flash",
    displayName: "Gemini 3.6 Flash",
    tier: "flash",
  },
  {
    id: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    tier: "pro",
    deprecating: true,
  },
  {
    id: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    tier: "flash",
    deprecating: true,
  },
];

/** The set of catalog ids (for spawn-schema membership checks). */
export const GEMINI_MODEL_IDS: readonly string[] = GEMINI_MODEL_CATALOG.map(
  m => m.id
);

/** True when `id` is a known gemini catalog id (empty string = Auto is NOT a member). */
export function isKnownGeminiModelId(id: string): boolean {
  return GEMINI_MODEL_IDS.includes(id);
}
