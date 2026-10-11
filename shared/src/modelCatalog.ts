// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Claude model catalog (issue #2456).
 *
 * The "More models" full catalog and the create-page model dropdown are driven
 * by Anthropic's LIVE Models API (`GET /v1/models`) — see
 * `server/src/services/claudeModelCatalog.ts`. New models Anthropic ships appear
 * automatically; there is no hand-maintained model list to update.
 *
 * This module holds the SHARED surface both server and web depend on:
 *  - `ClaudeModelInfo` — the normalized per-model shape the web consumes.
 *  - `FALLBACK_CLAUDE_MODELS` — the graceful-degradation catalog used ONLY when
 *    the live fetch fails and no cached catalog exists, so the picker is never
 *    empty (Fallback Preservation Rule). Its ids + per-model effort support were
 *    captured from the LIVE `/v1/models` response (2026-07-30), NOT guessed.
 *  - `ClaudeModelsResponseSchema` — the `/api/claude/models` response contract.
 */
import { z } from "zod";
import { EFFORT_LEVELS, type EffortLevel } from "./effort";

/**
 * A single Claude model as surfaced to the pickers. `effortLevels` is the
 * subset of {@link EFFORT_LEVELS} the model actually supports (server-derived
 * from the API's `capabilities.effort` tree), empty when the model supports no
 * reasoning effort at all (e.g. Haiku 4.5) — the per-model source of truth for
 * gating the Effort submenu, replacing the earlier static family heuristic.
 */
export const ClaudeModelInfoSchema = z.object({
  /** Raw model id, e.g. "claude-opus-4-6". */
  id: z.string(),
  /** Human-friendly name, e.g. "Claude Opus 4.6" (from the API `display_name`). */
  displayName: z.string(),
  /** Supported reasoning-effort levels (canonical order); [] = effort unsupported. */
  effortLevels: z.array(z.enum(EFFORT_LEVELS)),
  /** Context window (input tokens), when the API reports it. */
  maxInputTokens: z.number().optional(),
});
export type ClaudeModelInfo = z.infer<typeof ClaudeModelInfoSchema>;

/** `GET /api/claude/models` response. `source` flags where the list came from
 *  so the client (and tests) can tell a live catalog from the offline fallback. */
export const ClaudeModelsResponseSchema = z.object({
  models: z.array(ClaudeModelInfoSchema),
  source: z.enum(["live", "cache", "fallback"]),
});
export type ClaudeModelsResponse = z.infer<typeof ClaudeModelsResponseSchema>;

/** Every reasoning-capable current model that permits `xhigh`/`max`. */
const FULL_EFFORT: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
/** Reasoning-capable current models without `xhigh` (Opus 4.6 / Sonnet 4.6). */
const NO_XHIGH_EFFORT: EffortLevel[] = ["low", "medium", "high", "max"];

/**
 * Graceful-degradation catalog — a sensible set of CURRENT models used only
 * when the live API is unreachable AND no cached catalog exists. Values were
 * read from the live `/v1/models` response (2026-07-30), so ids, display names,
 * and per-model effort support are accurate, not fabricated. The live API is
 * always preferred; this exists purely so the flyout is never empty/broken.
 */
export const FALLBACK_CLAUDE_MODELS: ClaudeModelInfo[] = [
  {
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    effortLevels: FULL_EFFORT,
  },
  {
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    effortLevels: FULL_EFFORT,
  },
  {
    id: "claude-fable-5",
    displayName: "Claude Fable 5",
    effortLevels: FULL_EFFORT,
  },
  {
    id: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    effortLevels: FULL_EFFORT,
  },
  {
    id: "claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    effortLevels: FULL_EFFORT,
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    effortLevels: NO_XHIGH_EFFORT,
  },
  {
    id: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    effortLevels: NO_XHIGH_EFFORT,
  },
  { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", effortLevels: [] },
];

/**
 * The Claude model families the newest-per-family partition groups by. Anything
 * else (an unknown/unparseable id) is treated as its own singleton "family" so
 * it still appears exactly once — never dropped, never duplicated (F4/S3).
 */
export type ClaudeModelFamily = "opus" | "sonnet" | "fable" | "haiku";
const KNOWN_FAMILIES: readonly ClaudeModelFamily[] = [
  "opus",
  "sonnet",
  "fable",
  "haiku",
];

/**
 * Parse a Claude model id (`claude-<family>-<major>[-<minor>][-<YYYYMMDD>]`)
 * into its family + a sortable release key. Unparseable ids → family `null`,
 * `ver -1` (sort last). Issue #2506 Task 6 — the single id-shape heuristic
 * behind {@link releaseKey} and {@link partitionModelsByFamily}, so a new
 * Anthropic model needs no code change (S1/R6).
 */
function parseModelId(id: string): {
  family: ClaudeModelFamily | null;
  ver: number;
  date: number;
} {
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-(\d{8,}))?$/i);
  if (!m) return { family: null, ver: -1, date: 0 };
  const rawFamily = m[1].toLowerCase();
  const family = (KNOWN_FAMILIES as readonly string[]).includes(rawFamily)
    ? (rawFamily as ClaudeModelFamily)
    : null;
  const major = Number(m[2]);
  const minor = m[3] ? Number(m[3]) : 0;
  const date = m[4] ? Number(m[4]) : 0;
  return { family, ver: major * 1000 + minor, date };
}

/**
 * Sortable release key for a model id: newer major.minor first, and a dated
 * snapshot before an older one within the same version. Unparseable ids sort
 * last (`ver -1`) but keep their relative order (stable). Moved here from
 * `web/.../ModelSelectorModal.tsx` (issue #2506 Task 6) so the modal's flat sort
 * and the newest-per-family partition share ONE recency heuristic.
 */
export function releaseKey(id: string): { ver: number; date: number } {
  const { ver, date } = parseModelId(id);
  return { ver, date };
}

/** Sort a catalog newest-first (stable for equal keys / unparseable ids). */
export function sortByReleaseDesc(
  models: ClaudeModelInfo[]
): ClaudeModelInfo[] {
  return models
    .map((m, i) => ({ m, i, k: releaseKey(m.id) }))
    .sort((a, b) => b.k.ver - a.k.ver || b.k.date - a.k.date || a.i - b.i)
    .map(x => x.m);
}

/**
 * The catalog's default model — the newest Opus (Hapimatic's flagship default,
 * mirroring the entitled `opus` default at spawn), else the newest model overall
 * when no Opus is present. Used to NAME the create-page Model default without a
 * static list (issue #2506 F3). Returns `undefined` only for an empty catalog.
 */
export function getDefaultCatalogModel(
  models: ClaudeModelInfo[]
): ClaudeModelInfo | undefined {
  const sorted = sortByReleaseDesc(models);
  return sorted.find(m => parseModelId(m.id).family === "opus") ?? sorted[0];
}
