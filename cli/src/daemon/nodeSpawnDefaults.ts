// SPDX-License-Identifier: AGPL-3.0-only
/**
 * This daemon's spawn-time effort default (issues #5879, #6028).
 *
 * `resolveNodeSpawnEffort` is the ONE place the daemon reads the env and
 * settings tiers (`HAPI_DEFAULT_EFFORT` on this daemon's unit >
 * `settings.json` `defaultEffort` > `xhigh`). The spawn path and the
 * `/spawn-defaults` control endpoint both call it, so the default the New
 * Session page names and the default a spawn sends cannot diverge.
 *
 * `fitSpawnEffortToModel` fits that default to the pinned model: the server
 * stamps the model's supported levels from its live catalog
 * (`modelEffortLevels`); without them the daemon falls back to an exact-id
 * lookup in the static catalog. An explicit body effort is never changed.
 */
import {
  EFFORT_LEVELS,
  FALLBACK_CLAUDE_MODELS,
  clampEffortToModel,
  resolveModelEffortLevels,
  resolveSpawnEffort,
  type EffortLevel,
  type ResolvedSpawnEffort,
} from "@hapi/protocol";
import { readSettings } from "@/persistence";

/** Resolve the effort a fresh claude spawn launches with, before the model fit. */
export async function resolveNodeSpawnEffort(
  explicit?: unknown
): Promise<ResolvedSpawnEffort> {
  const settings = (await readSettings().catch(() => ({}))) as {
    defaultEffort?: unknown;
  };
  return resolveSpawnEffort({
    explicit,
    env: process.env.HAPI_DEFAULT_EFFORT,
    settings: settings.defaultEffort,
  });
}

/**
 * The wire `modelEffortLevels`, validated: an array whose every entry is a known
 * effort level. Anything else (absent, not an array, an unknown entry) is
 * `undefined`, so a malformed value falls back instead of clamping wrongly.
 */
export function parseModelEffortLevels(
  raw: unknown
): EffortLevel[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const known = EFFORT_LEVELS as readonly string[];
  return raw.every(v => typeof v === "string" && known.includes(v))
    ? (raw as EffortLevel[])
    : undefined;
}

/** The result of {@link fitSpawnEffortToModel}. */
export interface FittedSpawnEffort {
  /** The level to send and record; `null` = the model takes no effort. */
  level: EffortLevel | null;
  /** The resolved default when the fit changed it, else `null`. */
  clampedFrom: EffortLevel | null;
  /** Where the model's levels came from (`unknown` = no clamp applied). */
  levelsSource: "server" | "static" | "unknown";
}

/**
 * Fit a resolved spawn effort to the pinned model (issue #6028). A body effort
 * (`resolved.source === "body"`) passes through untouched — the #5879 rule is
 * "xhigh unless the user explicitly chooses another level".
 */
export function fitSpawnEffortToModel(
  resolved: ResolvedSpawnEffort,
  model: {
    modelEffortLevels: unknown;
    rawModel?: string;
    modelMode?: string;
  }
): FittedSpawnEffort {
  if (resolved.source === "body") {
    return {
      level: resolved.level,
      clampedFrom: null,
      levelsSource: "unknown",
    };
  }
  const fromServer = parseModelEffortLevels(model.modelEffortLevels);
  const levels =
    fromServer ??
    resolveModelEffortLevels(FALLBACK_CLAUDE_MODELS, "fallback", {
      rawModel: model.rawModel,
      modelMode: model.modelMode,
    });
  const level = clampEffortToModel(resolved.level, levels);
  return {
    level,
    clampedFrom: level === resolved.level ? null : resolved.level,
    levelsSource: fromServer ? "server" : levels ? "static" : "unknown",
  };
}
