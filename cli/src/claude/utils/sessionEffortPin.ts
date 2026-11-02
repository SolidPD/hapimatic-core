// SPDX-License-Identifier: AGPL-3.0-only
/**
 * How a session's effort changes on an in-session config change (issue #6070).
 *
 * A session whose effort was DEFAULTED at spawn records the node's pre-fit default
 * in `metadata.nodeDefaultEffort`. On a model switch that names no effort, the
 * effort is re-fitted to the new model (`refitNodeDefaultEffort`, the same clamp
 * the daemon applies at spawn). A request that names an effort is an explicit pick:
 * it sets the effort and clears the marker, so later switches leave it alone.
 *
 * The decision lives in the CLI — not the server — because the CLI holds the
 * marker in memory and an explicit pick clears it synchronously; the server's
 * cached metadata lags the CLI's asynchronous write, so a server-side decision
 * could overwrite an explicit pick made just before a model switch. The server
 * still supplies the new model's levels from its live catalog
 * (`modelEffortLevels`), because the CLI only has the static fallback.
 */
import {
  FALLBACK_CLAUDE_MODELS,
  isEffortLevel,
  refitNodeDefaultEffort,
  resolveModelEffortLevels,
  type EffortLevel,
} from "@hapi/protocol";
import type { Metadata } from "@/api/types";

/** What a config change does to the session's effort. */
export type EffortDecision =
  /** The request named an effort: set it (`undefined` = clear) and drop the marker. */
  | { kind: "explicit"; effort: EffortLevel | undefined }
  /** A model switch re-fits the defaulted effort (`null` = the model takes none). */
  | { kind: "refit"; effort: EffortLevel | null }
  /** The effort is unchanged. */
  | { kind: "none" };

/** A wire `modelEffortLevels`: an array of known levels, else `undefined`. */
export function parseModelEffortLevels(
  raw: unknown
): EffortLevel[] | undefined {
  return Array.isArray(raw) && raw.every(isEffortLevel)
    ? (raw as EffortLevel[])
    : undefined;
}

/**
 * Decide the effort outcome of one config change.
 *
 * - `effort` present (any value, incl. `null`) → explicit; an invalid value clears.
 * - else a model change on a session that follows the node default → refit, using
 *   the server-supplied levels when valid, else the static-catalog lookup the
 *   daemon also falls back to (`fitSpawnEffortToModel`).
 * - else → none.
 */
export function decideEffortOnConfigChange(input: {
  effort: unknown;
  modelChanged: boolean;
  nodeDefault: EffortLevel | undefined;
  modelEffortLevels: unknown;
  pin: { rawModel?: string; modelMode?: string };
}): EffortDecision {
  if (input.effort !== undefined) {
    return {
      kind: "explicit",
      effort: isEffortLevel(input.effort) ? input.effort : undefined,
    };
  }
  if (!input.modelChanged || !input.nodeDefault) return { kind: "none" };
  const levels =
    parseModelEffortLevels(input.modelEffortLevels) ??
    resolveModelEffortLevels(FALLBACK_CLAUDE_MODELS, "fallback", input.pin);
  const refit = refitNodeDefaultEffort(input.nodeDefault, levels);
  return refit === undefined
    ? { kind: "none" }
    : { kind: "refit", effort: refit };
}

/**
 * Apply an effort outcome to a metadata blob (pure; the caller passes it to
 * `session.updateMetadata`). Sets `effort` or deletes it when there is none, and
 * on an explicit pick deletes `nodeDefaultEffort`.
 */
export function applyEffortToMetadata(
  metadata: Metadata,
  decision: Exclude<EffortDecision, { kind: "none" }>
): Metadata {
  const next = { ...metadata };
  if (decision.effort) {
    next.effort = decision.effort;
  } else {
    delete next.effort;
  }
  if (decision.kind === "explicit") delete next.nodeDefaultEffort;
  return next;
}
