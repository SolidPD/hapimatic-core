// SPDX-License-Identifier: AGPL-3.0-only
import { ExternalLink } from "lucide-react";
import type { AgentType } from "./types";
import { FormField } from "./FormField";
import { OpenRouterModelCombobox } from "./OpenRouterModelCombobox";

/**
 * Issue #1733/#1975 — OpenRouter model picker for a Codex or OpenCode session on
 * a `gateway:openrouter`-capable target.
 *
 * Backed by OpenRouter's **full live catalog** (hundreds of models) via the
 * searchable {@link OpenRouterModelCombobox} (favorites pinned on top, free-text
 * fallback) — replacing #1733's hardcoded 6-model curated list (#1975). A link
 * beside the label opens OpenRouter's catalog page in a new tab for discovery.
 *
 * For Codex an empty selection means "use ChatGPT auth"; for OpenCode (which is
 * OpenRouter-mandatory) the placeholder prompts for a model and an empty
 * selection fail-fasts at spawn.
 */
export function ModelSelector(props: {
  model: string;
  isDisabled: boolean;
  onModelChange: (value: string) => void;
  /** Issue #1975: the agent flavor, to choose the empty/placeholder text. */
  agent?: AgentType;
}) {
  const placeholder =
    props.agent === "opencode"
      ? "Select a model…"
      : "Default (Codex / ChatGPT)";
  return (
    <FormField
      tooltip="The model this session runs through the OpenRouter gateway. For Codex, leaving it empty uses your ChatGPT login instead; OpenCode requires a selection."
      bookmarkId="openrouterModel"
      label={
        <span className="flex items-center gap-1.5">
          OpenRouter model
          <a
            href="https://openrouter.ai/models"
            target="_blank"
            rel="noreferrer"
            title="Browse OpenRouter's full model catalog (opens in a new tab)"
            data-testid="openrouter-catalog-link"
            className="inline-flex items-center text-[var(--app-link)] hover:opacity-80"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </span>
      }
    >
      <OpenRouterModelCombobox
        value={props.model}
        onChange={props.onModelChange}
        disabled={props.isDisabled}
        placeholder={placeholder}
      />
    </FormField>
  );
}
