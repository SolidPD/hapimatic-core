// SPDX-License-Identifier: AGPL-3.0-only
import { FormField } from "./FormField";
import { UiSelect, UiInput } from "./controls";
import type { RedactedApiKey } from "@hapi/protocol/schemas";

/**
 * Issue #3349 — the Create-Session opencode NATIVE provider/model picker.
 *
 * OpenCode is no longer OpenRouter-mandatory (#1975): it can spawn against a
 * NATIVE provider keyed from the #1955 apiKeys vault. This picker is a native
 * provider SELECTOR (fed from the node's redacted vault entries — provider names
 * / labels ONLY, NEVER the secret; the `RedactedApiKey` boundary structurally
 * cannot carry the key) plus a free-form model-id input. The two selections are
 * combined into the `provider/model` the daemon parses, and `modelRouting:
 * "native"` is set on the spawn payload (deriveFormState). `ModelSelector` /
 * `OpenRouterModelCombobox` are OpenRouter-specific and stay untouched.
 *
 * Rendered by {@link ProviderModelFields} ONLY when `fields.opencodeNativeModel
 * .visible` — i.e. when the flavor's `modelSelection` axis binds the
 * `opencode-native` catalog and the OpenRouter picker is NOT active
 * (deriveFormState dual-source exclusion, NOT a `flavor === "opencode"` check).
 *
 * The OpenRouter gateway entry is filtered out here — that provider is reached
 * through the OpenRouter picker/path, not the native one. The selected provider
 * string is used VERBATIM as the OpenCode provider id (`provider.<id>` +
 * `<id>/<model>`), so pick a provider OpenCode recognizes natively (e.g.
 * anthropic / openai / google, per models.dev); an unrecognized id fails loud at
 * spawn rather than silently.
 */
export function NativeProviderModelFields(props: {
  /** Redacted vault entries (from `useApiKeys`); the OpenRouter entry is excluded here. */
  vaultKeys: RedactedApiKey[];
  provider: string;
  model: string;
  isDisabled: boolean;
  onProviderChange: (value: string) => void;
  onModelChange: (value: string) => void;
}) {
  const nativeKeys = props.vaultKeys.filter(k => k.provider !== "openrouter");
  const hasKeys = nativeKeys.length > 0;
  return (
    <>
      <FormField
        label="Provider"
        hint={hasKeys ? undefined : "no keys — add one under Provider API Keys"}
        tooltip="The native provider this OpenCode session authenticates against, using a per-provider key from your API Keys vault. Pick a provider OpenCode supports natively (e.g. Anthropic, OpenAI, Google). The key never leaves the node."
      >
        <UiSelect
          value={props.provider}
          onChange={e => props.onProviderChange(e.target.value)}
          disabled={props.isDisabled || !hasKeys}
          data-testid="opencode-native-provider-select"
        >
          <option value="">Select a provider…</option>
          {nativeKeys.map(k => (
            <option key={k.id} value={k.provider}>
              {k.label?.trim() ? `${k.label} (${k.provider})` : k.provider}
            </option>
          ))}
        </UiSelect>
      </FormField>
      <FormField
        label="Model"
        tooltip="The provider's model id this session starts on (e.g. claude-sonnet-4-5). Combined with the provider as provider/model and delivered to OpenCode at spawn."
      >
        <UiInput
          value={props.model}
          onChange={e => props.onModelChange(e.target.value)}
          disabled={props.isDisabled || !props.provider}
          placeholder="e.g. claude-sonnet-4-5"
          data-testid="opencode-native-model-input"
        />
      </FormField>
    </>
  );
}
