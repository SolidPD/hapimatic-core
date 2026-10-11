// SPDX-License-Identifier: AGPL-3.0-only
import { FormField } from "./FormField";
import { UiSelect } from "./controls";
import {
  CODEX_MODEL_CATALOG,
  CODEX_DEFAULT_LABEL,
  CODEX_REASONING_EFFORTS,
  CODEX_REASONING_EFFORT_LABELS,
} from "@hapi/protocol/codexModelCatalog";

/**
 * Issue #3348 — the Create-Session codex ChatGPT-token model + reasoning-effort
 * row. The NON-OpenRouter codex path: the selected model + effort are baked into
 * `CODEX_HOME/config.toml` at spawn (`model` / `model_reasoning_effort`) on BOTH
 * spawn paths (direct + tmux). A curated STATIC catalog read from the installed
 * codex binary's own model cache (see `codexModelCatalog.ts`).
 *
 * Rendered by {@link ProviderModelFields} ONLY when `fields.codexModel.visible`
 * — i.e. the `codex-native` catalog binds (codex on a node WITHOUT OpenRouter
 * gateway auth; the gateway picker wins when auth is present — dual-source mutual
 * exclusion in deriveFormState). Mirrors {@link ModelEffortRow}: effort levels the
 * SELECTED model doesn't support render disabled.
 */
export function CodexModelFields(props: {
  model: string;
  effort: string;
  isDisabled: boolean;
  effortVisible: boolean;
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;
}) {
  const selected = CODEX_MODEL_CATALOG.find(m => m.id === props.model);
  return (
    <div className="flex gap-2">
      <div className="min-w-0 flex-[2]">
        <FormField
          label="Model"
          tooltip="The model this Codex (ChatGPT-login) session starts on. Baked into the session's Codex config at spawn; changing it recreates the session."
        >
          <UiSelect
            value={props.model}
            onChange={e => props.onModelChange(e.target.value)}
            disabled={props.isDisabled}
            data-testid="codex-model-select"
          >
            <option value="">{CODEX_DEFAULT_LABEL}</option>
            {CODEX_MODEL_CATALOG.map(m => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </UiSelect>
        </FormField>
      </div>
      {props.effortVisible && (
        <div className="min-w-0 flex-1">
          <FormField
            label="Effort"
            tooltip="Reasoning-effort budget (Codex model_reasoning_effort). Levels the selected model doesn't support are disabled."
          >
            <UiSelect
              value={props.effort}
              onChange={e => props.onEffortChange(e.target.value)}
              disabled={props.isDisabled}
              data-testid="codex-effort-select"
            >
              <option value="">Default</option>
              {CODEX_REASONING_EFFORTS.map(level => {
                // Permissive when no specific model is chosen; otherwise gate by
                // the selected model's supported levels (mirrors ModelEffortRow).
                const supported =
                  !selected || selected.effortLevels.includes(level);
                return (
                  <option key={level} value={level} disabled={!supported}>
                    {CODEX_REASONING_EFFORT_LABELS[level]}
                  </option>
                );
              })}
            </UiSelect>
          </FormField>
        </div>
      )}
    </div>
  );
}
