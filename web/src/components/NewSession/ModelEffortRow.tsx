// SPDX-License-Identifier: AGPL-3.0-only
import { FormField } from "./FormField";
import { UiSelect } from "./controls";
import {
  EFFORT_LEVELS,
  EFFORT_LEVEL_LABELS,
  SPAWN_DEFAULT_EFFORT_LEVEL,
  clampEffortToModel,
  getDefaultCatalogModel,
  type EffortLevel,
} from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { useClaudeModels } from "@/hooks/queries/useClaudeModels";

/**
 * Issue #2456 — the Create-Session Claude Model + Effort split row. Replaces
 * #2434's family-only ModelModeSelector (now removed) for a Claude agent (R7).
 *
 * - **Model** (wider, left): the LIVE full catalog (`useClaudeModels` →
 *   Anthropic `/v1/models`, server-cached with fallback) plus a "Default" option.
 *   A specific selection threads as `rawModel` (the raw `--model` axis); "Default"
 *   leaves the session on its default-mode resolution. New Anthropic models
 *   appear automatically — no static list to maintain.
 * - **Effort** (narrow, right): the reasoning-effort levels the SELECTED model
 *   supports (gated by the catalog's per-model `effortLevels`); unsupported
 *   levels render disabled. "Default" sends no `--effort` pin, so the node's
 *   spawn default applies (`xhigh` unless the node sets one — issue #5879), fitted
 *   to the selected model by the daemon; the option's label names that level
 *   (issue #6028).
 *
 * Both are definitive at launch (threaded into the spawn payload) — see
 * `formState`/`spawnCommand`.
 */
export function ModelEffortRow(props: {
  api: ApiClient | null;
  /** Selected raw model id, `""` = Default. */
  rawModel: string;
  /** Selected effort level, `""` = Default. */
  effort: EffortLevel | "";
  /** Issue #6028: the target node's resolved spawn default (env
   *  `HAPI_DEFAULT_EFFORT` > settings `defaultEffort` > xhigh), from the daemon.
   *  Undefined = unknown (an older daemon or peer) → the shared default. */
  nodeDefaultEffort?: EffortLevel;
  isDisabled: boolean;
  onRawModelChange: (id: string) => void;
  onEffortChange: (level: EffortLevel | "") => void;
}) {
  const { models } = useClaudeModels(props.api);
  const selected = models.find(m => m.id === props.rawModel);

  // Issue #2506 F3 — NAME the actual defaults instead of a bare "Default" option.
  // DISPLAY-ONLY: the option's value stays "" so the spawn is byte-identical ("" =
  // "no explicit pin, let the default resolve"); only the LABEL changes. Model
  // default = the catalog's newest Opus (the entitled default a Max account
  // resolves to); effort default = Hapimatic's asserted default effort, gated to
  // the selected model's real support so a no-effort model (Haiku) shows "None".
  // Issue #5879: the default a fresh spawn gets is the daemon's spawn default
  // (`xhigh`), not the in-session display default, and the label says so.
  // Issue #6028: that default is the TARGET node's (env / settings / xhigh), and
  // the daemon fits it to the selected model with the same shared function, so
  // the label names the level the session records (both read a model catalog). The
  // Default model is not clamped — the binary picks that model, as the daemon does.
  const defaultModel = getDefaultCatalogModel(models);
  const defaultModelLabel = defaultModel?.displayName ?? "Default";
  const nodeDefault = props.nodeDefaultEffort ?? SPAWN_DEFAULT_EFFORT_LEVEL;
  const defaultEffortLabel = (() => {
    const named = (level: EffortLevel) =>
      `${EFFORT_LEVEL_LABELS[level]} (default)`;
    if (!selected) return named(nodeDefault);
    const fitted = clampEffortToModel(nodeDefault, selected.effortLevels);
    return fitted === null ? "None" : named(fitted);
  })();

  return (
    <div className="flex gap-2">
      <div className="min-w-0 flex-[2]">
        <FormField
          label="Model"
          tooltip="The model the session starts on — the full live Anthropic catalog. This is a starting point, not a lock; you can switch models in-session afterwards."
          bookmarkId="model"
        >
          <UiSelect
            value={props.rawModel}
            onChange={e => props.onRawModelChange(e.target.value)}
            disabled={props.isDisabled}
            data-testid="model-catalog-select"
          >
            <option value="">{defaultModelLabel}</option>
            {models.map(model => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
          </UiSelect>
        </FormField>
      </div>
      <div className="min-w-0 flex-1">
        <FormField
          label="Effort"
          tooltip="Reasoning-effort budget for the session. Levels the selected model doesn't support are disabled."
          bookmarkId="effort"
        >
          <UiSelect
            value={props.effort}
            onChange={e =>
              props.onEffortChange(e.target.value as EffortLevel | "")
            }
            disabled={props.isDisabled}
            data-testid="effort-select"
          >
            <option value="">{defaultEffortLabel}</option>
            {EFFORT_LEVELS.map(level => {
              // Permissive when no specific model is chosen (Default resolves to
              // a full-effort tier); otherwise gate by the model's capabilities.
              const supported =
                !selected || selected.effortLevels.includes(level);
              return (
                <option key={level} value={level} disabled={!supported}>
                  {EFFORT_LEVEL_LABELS[level]}
                </option>
              );
            })}
          </UiSelect>
        </FormField>
      </div>
    </div>
  );
}
