// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Codex native (ChatGPT-token) model catalog + reasoning-effort vocabulary
 * (issue #3348, epic #3345 model-axis parity).
 *
 * The CHATGPT-AUTH codex path (NOT the OpenRouter gateway path — that stays the
 * `openrouter` catalog). When a codex session authenticates with a ChatGPT
 * subscription (no OpenRouter key), the selected model + reasoning effort are
 * baked into `CODEX_HOME/config.toml` at spawn (`model = "..."` /
 * `model_reasoning_effort = "..."`) on BOTH spawn paths (direct + tmux).
 *
 * A CURATED STATIC catalog by design (like {@link ./geminiModelCatalog.ts}, unlike
 * the live Claude catalog). The values below were read from the INSTALLED codex
 * binary's own model cache — `~/.codex/models_cache.json`, codex-cli 0.147.0,
 * fetched 2026-09-21 — the authoritative source, NOT guessed.
 *
 * ⚠️ VERSION DRIFT (the directive's #3216-class caveat, CONFIRMED): the codex
 * reasoning-effort set is VERSION-DEPENDENT. The web-sourced 2026-08 note claimed
 * `minimal|low|medium|high|xhigh` with a `minimal → low` coercion; the installed
 * 0.147.0 binary's cache instead reports `low|medium|high|xhigh|max` (+ `ultra`
 * for the top models) and NO `minimal`. This file follows the INSTALLED BINARY
 * (the directive's own instruction: "verify the exact accepted set against the
 * installed codex binary"). Re-verify against `~/.codex/models_cache.json` on a
 * codex upgrade and update {@link CODEX_CATALOG_VERIFIED_AGAINST}.
 */
import { z } from "zod";

/**
 * Codex reasoning-effort levels — the UNION across the visible models below
 * (`gpt-5.6-sol`/`terra` support up to `ultra`; `luna` up to `max`; `gpt-5.5`
 * up to `xhigh`). This is codex's OWN vocabulary and is intentionally distinct
 * from the Claude `EffortLevel` set (`shared/src/effort.ts`): codex adds `ultra`
 * and (in this binary) has no `minimal`. The per-model narrowing lives in the
 * catalog entries' `effortLevels`; this superset is the schema-validation set.
 */
export const CODEX_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

/** Zod enum over {@link CODEX_REASONING_EFFORTS} — the single wire + manifest source. */
export const CodexReasoningEffortSchema = z.enum(CODEX_REASONING_EFFORTS);

/**
 * A single ChatGPT-auth codex model as surfaced to the picker. `effortLevels` is
 * the subset of {@link CODEX_REASONING_EFFORTS} this model supports (per-model,
 * from the binary's cache) — mirrors the Claude catalog's per-model `effortLevels`,
 * so the picker disables an unsupported level for the selected model.
 */
export const CodexModelInfoSchema = z.object({
  /** Raw model id / config.toml `model` value, e.g. "gpt-5.6-sol". */
  id: z.string().min(1),
  /** Human-friendly name, e.g. "GPT-5.6 Sol". */
  displayName: z.string().min(1),
  /** Reasoning-effort levels this model supports (canonical order); [] = none. */
  effortLevels: z.array(CodexReasoningEffortSchema),
});
export type CodexModelInfo = z.infer<typeof CodexModelInfoSchema>;

/** The `verifiedAgainst` version stamp (source + binary version + date). */
export const CODEX_CATALOG_VERIFIED_AGAINST =
  "codex ChatGPT-auth models + effort set read from ~/.codex/models_cache.json, codex-cli 0.147.0, fetched 2026-09-21";

/** Empty string = "Default" (codex's own default model — omit the config bake). */
export const CODEX_DEFAULT_MODEL_ID = "";
/** Display label for the Default (omit-bake) option. */
export const CODEX_DEFAULT_LABEL = "Default (ChatGPT)";

/**
 * Curated static catalog — the VISIBLE (`visibility: "list"`) ChatGPT-auth models
 * from the installed binary's cache. Hidden models (`gpt-reserve`,
 * `codex-auto-review`) are intentionally omitted. Ordered newest/most-capable first.
 */
export const CODEX_MODEL_CATALOG: CodexModelInfo[] = [
  {
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    id: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    id: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    effortLevels: ["low", "medium", "high", "xhigh"],
  },
];

/** Title-case labels for the effort dropdown. */
export const CODEX_REASONING_EFFORT_LABELS: Record<
  CodexReasoningEffort,
  string
> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

/** The set of catalog ids (for spawn-schema membership checks). */
export const CODEX_MODEL_IDS: readonly string[] = CODEX_MODEL_CATALOG.map(
  m => m.id
);

/** True when `id` is a known codex catalog id (empty string = Default is NOT a member). */
export function isKnownCodexModelId(id: string): boolean {
  return CODEX_MODEL_IDS.includes(id);
}
