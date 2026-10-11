// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Reasoning-effort levels (issue #2456).
 *
 * The `claude` binary (verified against `claude 2.1.220`) accepts an
 * `--effort <level>` argument controlling the reasoning-effort budget for a
 * session. Valid levels come straight from the binary's own validation
 * warning: `low, medium, high, xhigh, max` (5 levels — the ~v1.0.x source
 * mirror's 4-level list has drifted; re-verify against `claude --effort` on a
 * Claude Code upgrade — OR-4).
 *
 * Effort is threaded through every spawn hop exactly like the `modelMode`
 * field (the #1262 trap — an un-enumerated hop silently drops it), reaching
 * the binary as an argv flag from all three launchers (sdk/pty/tmux).
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * Title-case labels for the effort dropdown. `xhigh` renders as "Extra High"
 * (Claude Desktop's own surface abbreviates this to "Extra"); the underlying
 * wire value stays `xhigh`.
 */
export const EFFORT_LEVEL_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/**
 * The effort level Hapimatic DISPLAYS as the default when a session carries no
 * explicit effort pin (issue #2506, ruling D4 / sub-fork D1a — DISPLAY-ONLY).
 *
 * The `claude` binary chooses its own reasoning-effort budget when `--effort` is
 * omitted, and that choice is NOT introspectable from Hapimatic: the CLI sends
 * no flag on a default session (`cli/src/claude/sdk/types.ts:227` — "Omitted →
 * no --effort flag"; the spawn stays byte-identical), and Anthropic's
 * `/v1/models` exposes no default-effort field. So this is Hapimatic's ASSERTED
 * default, for DISPLAY ONLY — it never adds an `--effort` send site and never
 * changes the wire. Its sole purpose is to let the UI show a concrete effort
 * (F2 — "never blank") instead of an empty field when none was chosen.
 *
 * ⚠️ Display-only assertion, NOT the binary's verified default (empirically
 * hardcoding that was ruled out as brittle — directive D3). If Claude Code's
 * default reasoning budget is known to differ, change THIS one line; re-verify
 * on a Claude Code upgrade (same maintenance class as EFFORT_LEVELS / OR-4).
 */
export const DEFAULT_EFFORT_LEVEL: EffortLevel = "high";

/**
 * The full display label for the asserted default effort (e.g. "High").
 * Compact-labelled surfaces (the composer chip) keep their own short map and
 * read {@link DEFAULT_EFFORT_LEVEL} directly.
 */
export function getDefaultEffortLabel(): string {
  return EFFORT_LEVEL_LABELS[DEFAULT_EFFORT_LEVEL];
}

/**
 * The Claude model families that participate in effort gating. Derived from a
 * mode name (opus/sonnet/fable/haiku), a raw model id (claude-opus-4-6), or an
 * alias — anything else (incl. "default") resolves to `null`, treated as the
 * permissive full-catalog case below.
 */
type EffortFamily = "opus" | "sonnet" | "fable" | "haiku";

/**
 * Model→effort-support map (OR-2). The binary's `modelSupportsEffort()` is NOT
 * runtime-introspectable from Hapimatic, so this static map is the pragmatic
 * MVP. `max` is the most restricted level — offered only for the flagship
 * reasoning tiers (opus/fable). All reasoning-capable families support
 * low/medium/high/xhigh.
 *
 * Safety of a stale map: the binary WARNS-AND-DEFAULTS on an unsupported or
 * unknown level, so a narrow (stale) Hapimatic subset is safe — the worst case
 * is a level disabled in the UI that the binary would have accepted. Keep this
 * map narrow and re-sync on a Claude Code upgrade.
 */
const MAX_EFFORT_FAMILIES: readonly EffortFamily[] = ["opus", "fable"];

/**
 * Resolve an effort family from a mode name, alias, or raw Claude model id.
 * Returns `null` for "default"/unknown inputs (permissive full-catalog case).
 */
function resolveEffortFamily(
  rawModelOrMode: string | undefined | null
): EffortFamily | null {
  if (!rawModelOrMode) return null;
  const v = rawModelOrMode.toLowerCase();
  if (v === "default") return null;
  if (v.includes("opus")) return "opus";
  if (v.includes("sonnet")) return "sonnet";
  if (v.includes("fable")) return "fable";
  if (v.includes("haiku")) return "haiku";
  return null;
}

/**
 * The effort levels a given model/mode should offer in the UI. For an unknown
 * or "default" input this returns the full catalog (permissive — the binary
 * ignores an unsupported level, and a default-mode session usually resolves to
 * Opus, which permits `max`).
 */
export function getEffortLevelsForModel(
  rawModelOrMode: string | undefined | null
): readonly EffortLevel[] {
  const family = resolveEffortFamily(rawModelOrMode);
  if (!family) return EFFORT_LEVELS;
  if (MAX_EFFORT_FAMILIES.includes(family)) return EFFORT_LEVELS;
  return EFFORT_LEVELS.filter(level => level !== "max");
}

/**
 * True when `level` is offered for the given model/mode (R2). Backs the
 * model-dependent enable/disable of the effort control.
 */
export function modelSupportsEffort(
  rawModelOrMode: string | undefined | null,
  level: EffortLevel
): boolean {
  return getEffortLevelsForModel(rawModelOrMode).includes(level);
}
