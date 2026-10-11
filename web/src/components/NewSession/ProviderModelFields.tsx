// SPDX-License-Identifier: AGPL-3.0-only
import { ModelSelector } from "./ModelSelector";
import { ModelEffortRow } from "./ModelEffortRow";
import { GeminiModelSelector } from "./GeminiModelSelector";
import { CodexModelFields } from "./CodexModelFields";
import { NativeProviderModelFields } from "./NativeProviderModelFields";
import { FormField } from "./FormField";
import type { FormState } from "./formState";
import type { EffortLevel } from "@hapi/protocol";
import type { RedactedApiKey } from "@hapi/protocol/schemas";
import type { ApiClient } from "@/api/client";
import type { AgentType } from "./types";

/** Provider resolved from the selected harness (read-only chip). */
export const PROVIDER_BY_AGENT: Record<string, string> = {
  claude: "Anthropic",
  codex: "OpenAI",
  gemini: "Google",
  opencode: "Multiple",
};

/**
 * The Create-Session form's "which model" slot: the read-only Provider chip
 * (#1733) plus the FLAVOR-CONDITIONAL model picker (#2434).
 *
 * Extracted from `index.tsx` by #2434 for two reasons: it puts the
 * flavor-conditional swap — the heart of "the model list depends on the CLI
 * tool selected" — in ONE readable place, and `index.tsx` was at the 1500-line
 * `max-lines` cap, so any addition there had to be paid for.
 *
 * Exactly one picker renders for any given agent, and that mutual exclusion is
 * enforced upstream in `deriveFormState`, not here:
 *  - `fields.model` (OpenRouter gateway axis, free-form `provider/model`) is
 *    visible only for codex/opencode on a `gateway:openrouter`-capable target.
 *  - `fields.modelMode` (Claude axis, default|sonnet|opus|fable) is visible
 *    only for claude.
 *
 * Keeping the visibility predicates in the field-state engine means the live
 * command preview, the spawn payload, and this render all read the SAME
 * derivation — they cannot disagree about which axis is in play.
 */
export function ProviderModelFields(props: {
  fields: FormState["fields"];
  agent: AgentType;
  selectedModel: string;
  onSelectedModelChange: (value: string) => void;
  /** Issue #2456: live catalog + effort dropdowns need the API client. */
  api: ApiClient | null;
  rawModel: string;
  effort: EffortLevel | "";
  onRawModelChange: (value: string) => void;
  onEffortChange: (value: EffortLevel | "") => void;
  /** Issue #3348: gemini native model ("" = Auto) + its setter. */
  geminiModel: string;
  onGeminiModelChange: (value: string) => void;
  /** Issue #3348: codex ChatGPT-token model ("" = Default) + its setter. */
  codexModel: string;
  onCodexModelChange: (value: string) => void;
  /** Issue #3348: codex reasoning effort ("" = default) + its setter. */
  codexEffort: string;
  onCodexEffortChange: (value: string) => void;
  /** Issue #3349: opencode native provider (vault provider string) + its setter. */
  opencodeProvider: string;
  onOpencodeProviderChange: (value: string) => void;
  /** Issue #3349: opencode native model id + its setter. */
  opencodeModel: string;
  onOpencodeModelChange: (value: string) => void;
  /** Issue #3349: redacted vault entries feeding the opencode native provider
   *  selector (provider names/labels only — never the secret). */
  vaultKeys: RedactedApiKey[];
}) {
  return (
    <>
      {/* Provider — read-only, auto-inherited from the harness (per #1733).
          Presentation matches the auto-detected Repo field: label-line hint,
          dashed border, dimmed text, and NO bookmark (auto-inherited fields
          are ineligible for saved defaults — on-page inheritance wins). If a
          selectable provider state ever exists, that state must drop the hint
          and the dashed/dimmed treatment. #3349: hidden when the opencode NATIVE
          picker is active — that picker has its OWN Provider selector, so the
          "Multiple" read-only chip too would double the "Provider" label. */}
      {!props.fields.opencodeNativeModel.visible && (
        <FormField
          label="Provider"
          hint="auto-detected from harness"
          tooltip="The AI company whose models this session uses. Set automatically by the CLI harness — Claude Code uses Anthropic, Codex uses OpenAI, Gemini uses Google — so there's nothing to choose here."
        >
          <div className="flex h-9 items-center rounded-md border border-dashed border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-2.5 text-sm text-[var(--app-hint)]">
            {PROVIDER_BY_AGENT[props.agent] ?? "—"}
          </div>
        </FormField>
      )}
      {props.fields.model.visible && (
        <ModelSelector
          model={props.selectedModel}
          isDisabled={props.fields.model.disabled}
          onModelChange={props.onSelectedModelChange}
          agent={props.agent}
        />
      )}
      {props.fields.rawModel.visible && (
        <ModelEffortRow
          api={props.api}
          rawModel={props.rawModel}
          effort={props.effort}
          isDisabled={props.fields.rawModel.disabled}
          onRawModelChange={props.onRawModelChange}
          onEffortChange={props.onEffortChange}
        />
      )}
      {/* #3348: gemini native-catalog picker — the gemini-native catalog binds. */}
      {props.fields.geminiModel.visible && (
        <GeminiModelSelector
          model={props.geminiModel}
          isDisabled={props.fields.geminiModel.disabled}
          onModelChange={props.onGeminiModelChange}
        />
      )}
      {/* #3348: codex ChatGPT-token model + effort — the codex-native catalog
          binds (OpenRouter picker wins when the node has gateway auth). */}
      {props.fields.codexModel.visible && (
        <CodexModelFields
          model={props.codexModel}
          effort={props.codexEffort}
          isDisabled={props.fields.codexModel.disabled}
          effortVisible={props.fields.codexEffort.visible}
          onModelChange={props.onCodexModelChange}
          onEffortChange={props.onCodexEffortChange}
        />
      )}
      {/* #3349: opencode native provider/model picker — the opencode-native
          catalog binds (only when the OpenRouter picker is NOT active). Its own
          Provider selector replaces the read-only chip above. */}
      {props.fields.opencodeNativeModel.visible && (
        <NativeProviderModelFields
          vaultKeys={props.vaultKeys}
          provider={props.opencodeProvider}
          model={props.opencodeModel}
          isDisabled={props.fields.opencodeNativeModel.disabled}
          onProviderChange={props.onOpencodeProviderChange}
          onModelChange={props.onOpencodeModelChange}
        />
      )}
    </>
  );
}
