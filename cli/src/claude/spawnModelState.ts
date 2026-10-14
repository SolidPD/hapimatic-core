// SPDX-License-Identifier: AGPL-3.0-only
import {
  deriveModelModeFromRaw,
  isModelModeAllowedForFlavor,
  resolveRawModelForMode,
} from "@hapi/protocol";
import { ModelModeSchema } from "@hapi/protocol/schemas";
import type { ModelMode } from "@hapi/protocol/modes";
import type { SessionModelMode } from "@/api/types";

/**
 * Issue #3616: the spawn-time model inputs consumed by `resolveSpawnModelState`.
 * Mirror `runClaude`'s three model-related StartOptions fields. `model` is a
 * dead input today (never set by the sole caller `commands/claude.ts`) but is
 * kept in the shape so the helper is a faithful extraction of the seeding logic.
 */
export interface SpawnModelInputs {
  model?: string;
  rawModel?: string;
  modelMode?: string;
}

/**
 * Issue #3616: the resolved spawn model state. `currentModel` is the single
 * already-resolved carrier every launcher reads (the sdk per-message capture,
 * and `Session.model` via loop() → syncSessionModes → resolveSpawnClaudeArgs).
 * The `spawn*Pin` fields are the BARE-id inputs to the durable metadata stamp
 * and MUST NOT carry the entitled pin — the stamp records the user's pick, never
 * the entitled default.
 */
export interface SpawnModelState {
  currentModel: string | undefined;
  currentModelMode: SessionModelMode;
  spawnRawModelPin: string | undefined;
  currentRawModel: string | undefined;
  spawnModelModePin: ModelMode | undefined;
}

/**
 * Issue #3616: pure, synchronous seeding of a Claude session's spawn model
 * state — extracted from `runClaude` (Shape B) so the #1506 entitled-pin guard
 * is unit-testable in isolation (`runClaude` is one ~1000-line function that
 * awaits session bootstrap / server startup before the guard, with no test
 * seam). Resolves three precedence layers:
 *
 *   1. `model` (dead input, kept for shape) → `rawModel` (--hapi-raw-model, a
 *      concrete id) → `modelMode` (--hapi-model-mode, a bare alias). The first
 *      one present sets `currentModel`; each layer's guard is `!currentModel`.
 *   2. The #1506 entitled pin: Max-bound accounts get the `opus[1m]` alias (→
 *      current Opus WITH the 1M-context beta) when no explicit model was picked.
 *
 * The `spawn*Pin` fields capture ONLY the user's explicit pick for the durable
 * stamp; the entitled pin is NEVER written into them.
 *
 * `entitledModel` is `resolveEntitledModelForBoundAccount()`'s result, resolved
 * by the caller and passed in so this helper stays pure/synchronous. It is
 * `null` for a non-Max / host-credential session.
 */
export function resolveSpawnModelState(
  inputs: SpawnModelInputs,
  entitledModel: string | null
): SpawnModelState {
  let currentModel = inputs.model;

  // Issue #2456: a specific pinned raw Claude model id (--hapi-raw-model) takes
  // precedence over --hapi-model-mode. It is already a resolved id, so it needs
  // no mode→model mapping and it short-circuits the modelMode block below (which
  // only fires when currentModel is still unset). Captured for the durable stamp.
  let spawnRawModelPin: string | undefined;
  if (!currentModel && inputs.rawModel) {
    currentModel = inputs.rawModel;
    spawnRawModelPin = inputs.rawModel;
  }
  // Issue #2456: the current specific raw-model pin (mutated later in runClaude
  // by set-session-config's "More models" branch), seeded from the spawn pin.
  const currentRawModel: string | undefined = spawnRawModelPin;

  // Issue #1633/#2434: an explicit spawn-time model mode (--hapi-model-mode)
  // seeds the model state when no raw model was provided. Invalid values are
  // ignored — the session then follows the normal default-mode resolution
  // (#1506 entitled pin). The VALIDATED pin is captured for the durable stamp
  // ("default" is a valid pin value here but is never stored — see the stamp).
  let spawnModelModePin: ModelMode | undefined;
  if (!currentModel && inputs.modelMode) {
    const parsedSpawnMode = ModelModeSchema.safeParse(inputs.modelMode);
    if (
      parsedSpawnMode.success &&
      isModelModeAllowedForFlavor(parsedSpawnMode.data, "claude")
    ) {
      currentModel = resolveRawModelForMode(parsedSpawnMode.data);
      spawnModelModePin = parsedSpawnMode.data;
    }
  }

  // Issue #1633: raw-value → display-mode derivation lives in the shared helper
  // (see its doc comment for the fable/#1506 clobber rationale).
  let currentModelMode: SessionModelMode = deriveModelModeFromRaw(currentModel);

  // Issue #1506 / #3616 (the fix): when the session is bound to a Max-entitled
  // account, pin the entitled model (the `opus[1m]` alias → current Opus WITH
  // the 1M-context beta) via `currentModel`. `currentModelMode` stays a valid
  // enum for display only. Fail-safe: null on any miss.
  //
  // The guard keys on explicit-model ABSENCE (`!currentModel`), NOT on the
  // derived display mode. `currentModel` is the single already-resolved carrier:
  // it is set iff an explicit selection was supplied (a concrete rawModel pin, a
  // bare-alias --hapi-model-mode, or a resolved fable[1m]); a true default (no
  // pin, --hapi-model-mode default, or an invalid mode) leaves it unset, so the
  // entitled pin still applies there (no #1506/#1608 regression). This matches
  // the sibling `!currentModel` idiom guarding the rawModel/modelMode seeding
  // above. (#3616 bug: keying on `currentModelMode === "default"` misfired —
  // deriveModelModeFromRaw maps EVERY concrete id to "default", so a concrete
  // pick like "claude-fable-5-1" was clobbered with opus[1m].)
  if (!currentModel) {
    if (entitledModel) {
      currentModel = entitledModel;
      currentModelMode = "opus"; // display only — ModelMode cannot carry [1m]
    }
  }

  return {
    currentModel,
    currentModelMode,
    spawnRawModelPin,
    currentRawModel,
    spawnModelModePin,
  };
}
