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
 * omitted, and that choice was NOT introspectable from Hapimatic before the
 * #6166 read-back (`get_settings`, SDK launcher only): a session with no
 * recorded pin (a session from before #5879) ran with no `--effort` flag
 * (`cli/src/claude/sdk/types.ts:227` — "Omitted → no --effort flag"), and
 * Anthropic's `/v1/models` exposes no default-effort field. So this is Hapimatic's ASSERTED
 * default, for DISPLAY ONLY — it never adds an `--effort` send site and never
 * changes the wire. Its sole purpose is to let the UI show a concrete effort
 * (F2 — "never blank") instead of an empty field when none was chosen.
 *
 * ⚠️ Display-only assertion, NOT the binary's verified default (empirically
 * hardcoding that was ruled out as brittle — directive D3). If Claude Code's
 * default reasoning budget is known to differ, change THIS one line; re-verify
 * on a Claude Code upgrade (same maintenance class as EFFORT_LEVELS / OR-4).
 *
 * Issue #5879: since the daemon now sends `--effort` on every fresh claude spawn
 * ({@link SPAWN_DEFAULT_EFFORT_LEVEL}), and since #6166 on every resume that
 * names no effort too, a session without a recorded pin is a legacy session that
 * has not respawned since, or (#6028) one on a model that takes no effort. The
 * premise above is now measured (#6166, Claude Code 2.1.302 `get_settings`): a
 * no-flag Opus 5.5 session runs `medium` and a no-flag Fable 5.1 session `high`,
 * so "high" is not what every legacy session ran. The value stays "high" (#5879
 * D10, display-only), and on an SDK session the live `appliedEffort` field (the
 * read-back) supersedes it once measured.
 */
export const DEFAULT_EFFORT_LEVEL: EffortLevel = "high";

/**
 * Hapimatic's spawn default (issue #5879, Matt's 2026-10-27 rule: "xhigh unless
 * the user explicitly chooses another level"). The daemon sends it as `--effort`
 * on a fresh claude spawn that names no effort, unless a node override applies —
 * see {@link resolveSpawnEffort}. Unlike {@link DEFAULT_EFFORT_LEVEL} this is a
 * value that is actually sent, so the session records it in `metadata.effort`.
 */
export const SPAWN_DEFAULT_EFFORT_LEVEL: EffortLevel = "xhigh";

/** Where {@link resolveSpawnEffort} found the level it returned. */
export type SpawnEffortSource = "body" | "env" | "settings" | "default";

/** The result of {@link resolveSpawnEffort}. */
export interface ResolvedSpawnEffort {
  level: EffortLevel;
  source: SpawnEffortSource;
  /** Each non-empty, out-of-catalog value that was skipped, in tier order. */
  rejected: Array<{
    source: Exclude<SpawnEffortSource, "default">;
    value: string;
  }>;
}

/**
 * True when `value` is one of {@link EFFORT_LEVELS}. Issue #6070: the guard for
 * a value that crossed a process or node boundary without a schema parse (a
 * peer's `/federation/info` `defaultEffort`, a session's `nodeDefaultEffort`).
 */
export function isEffortLevel(value: unknown): value is EffortLevel {
  return (
    typeof value === "string" &&
    (EFFORT_LEVELS as readonly string[]).includes(value)
  );
}

function asEffortLevel(value: unknown): EffortLevel | null {
  return isEffortLevel(value) ? value : null;
}

/**
 * Resolve the effort a fresh claude spawn launches with (issue #5879). Priority:
 * an explicit spawn-body `effort` > env `HAPI_DEFAULT_EFFORT` > `settings.json`
 * `defaultEffort` > {@link SPAWN_DEFAULT_EFFORT_LEVEL}. Env beats settings, the
 * same order as the launcher resolver (`launcherResolver.ts`). An invalid value
 * at any tier is recorded in `rejected` and falls through to the next tier, so a
 * typo never blocks a spawn. This is the one precedence chain: a per-harness
 * default store (#4227) adds its tier here rather than a second mechanism.
 */
export function resolveSpawnEffort(input: {
  explicit?: unknown;
  env?: unknown;
  settings?: unknown;
}): ResolvedSpawnEffort {
  const rejected: ResolvedSpawnEffort["rejected"] = [];
  const tiers: Array<[Exclude<SpawnEffortSource, "default">, unknown]> = [
    ["body", input.explicit],
    ["env", input.env],
    ["settings", input.settings],
  ];
  for (const [source, raw] of tiers) {
    if (raw === undefined || raw === null || raw === "") continue;
    const level = asEffortLevel(raw);
    if (level) return { level, source, rejected };
    rejected.push({ source, value: String(raw) });
  }
  return { level: SPAWN_DEFAULT_EFFORT_LEVEL, source: "default", rejected };
}

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
export type ModelFamily = "opus" | "sonnet" | "fable" | "haiku";
type EffortFamily = ModelFamily;

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
 * The Claude model family named by a model-mode or a raw model id (e.g.
 * `"claude-opus-5-5"` → `"opus"`), or `null` for `"default"`/unknown input.
 * Issue #5879: the spawn headroom check uses it to find the model-scoped weekly
 * window (`limits[].kind === "weekly_scoped"`) that applies to a spawn.
 */
export function resolveModelFamily(
  rawModelOrMode: string | undefined | null
): ModelFamily | null {
  return resolveEffortFamily(rawModelOrMode);
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

/**
 * Fit an effort level to the levels a model supports (issue #6028). The daemon
 * clamps its spawn default with it and the New Session label uses it to name
 * that default, so the two agree whenever they read the same catalog.
 *
 * - `supported === undefined` → support is unknown: `level` unchanged.
 * - `supported` empty → the model takes no effort: `null` (send no `--effort`).
 * - `level` supported → `level`.
 * - otherwise the highest supported level ranked below `level`, else the lowest
 *   supported level. The binary maps an unsupported `xhigh`/`max` to `high`, so
 *   for the `xhigh` default this matches what the binary would run. Only when no
 *   supported level ranks below `level` does it return a higher one (the lowest).
 *
 * Feed it the live catalog's per-model `effortLevels`, never the static family
 * map above — that map disagrees with the catalog (e.g. Sonnet 4.6 lacks `xhigh`).
 */
export function clampEffortToModel(
  level: EffortLevel,
  supported: readonly EffortLevel[] | undefined
): EffortLevel | null {
  if (supported === undefined) return level;
  if (supported.length === 0) return null;
  if (supported.includes(level)) return level;
  const rank = EFFORT_LEVELS.indexOf(level);
  let below: EffortLevel | null = null;
  let lowest: EffortLevel | null = null;
  for (const candidate of EFFORT_LEVELS) {
    if (!supported.includes(candidate)) continue;
    lowest ??= candidate;
    if (EFFORT_LEVELS.indexOf(candidate) < rank) below = candidate;
  }
  return below ?? lowest;
}

/**
 * Re-fit a defaulted effort to a newly selected model (issue #6070). A session
 * whose effort came from the node default records that pre-fit level in
 * `metadata.nodeDefaultEffort`; on a model switch the effort becomes the node
 * default fitted to the new model, by the same {@link clampEffortToModel} the
 * daemon uses at spawn.
 *
 * - `nodeDefault` not a known level (absent ⇒ the effort was an explicit pick or
 *   the session predates #6070) → `undefined`: leave the effort alone.
 * - otherwise → `clampEffortToModel(nodeDefault, supported)`: a level, or `null`
 *   when the new model takes no effort (send no `--effort`).
 */
export function refitNodeDefaultEffort(
  nodeDefault: unknown,
  supported: readonly EffortLevel[] | undefined
): EffortLevel | null | undefined {
  if (!isEffortLevel(nodeDefault)) return undefined;
  return clampEffortToModel(nodeDefault, supported);
}
