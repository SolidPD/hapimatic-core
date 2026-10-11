// SPDX-License-Identifier: AGPL-3.0-only
import { FormField } from "./FormField";
import { UiSelect } from "./controls";
import {
  GEMINI_MODEL_CATALOG,
  GEMINI_AUTO_LABEL,
} from "@hapi/protocol/geminiModelCatalog";

/**
 * Issue #3348 — the Create-Session gemini native-model picker.
 *
 * A curated STATIC catalog (Gemini 3.x primary; the 2.5 tier flagged deprecating)
 * — deliberately unlike the live Claude catalog (gemini has `authBinding:
 * "inherited"`, so there is no authenticated context for a live Models API call).
 * The selected id is conveyed to the spawned gemini via `GEMINI_MODEL` env
 * (ruling D3(a)); "Auto" (`""`) omits it so the gemini CLI picks its own default.
 *
 * Rendered by {@link ProviderModelFields} ONLY when `fields.geminiModel.visible`
 * — i.e. when the flavor's `modelSelection` axis binds the `gemini-native` catalog
 * (deriveFormState, NOT a `flavor === "gemini"` check here).
 */
export function GeminiModelSelector(props: {
  model: string;
  isDisabled: boolean;
  onModelChange: (value: string) => void;
}) {
  return (
    <FormField
      label="Model"
      tooltip="The Google model this Gemini session starts on. 'Auto' lets the Gemini CLI pick its own default. Delivered via GEMINI_MODEL at spawn."
    >
      <UiSelect
        value={props.model}
        onChange={e => props.onModelChange(e.target.value)}
        disabled={props.isDisabled}
        data-testid="gemini-model-select"
      >
        <option value="">{GEMINI_AUTO_LABEL}</option>
        {GEMINI_MODEL_CATALOG.map(m => (
          <option key={m.id} value={m.id}>
            {m.displayName}
            {m.deprecating ? " (deprecating Oct 2026)" : ""}
          </option>
        ))}
      </UiSelect>
    </FormField>
  );
}
