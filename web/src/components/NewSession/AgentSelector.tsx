// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentType } from "./types";
import { FormField } from "./FormField";
import { UiSelect } from "./controls";

const ALL_AGENTS: { value: AgentType; label: string }[] = [
  { value: "claude", label: "Claude Code CLI" },
  { value: "codex", label: "OpenAI Codex CLI" },
  { value: "gemini", label: "Gemini CLI" },
  { value: "opencode", label: "OpenCode CLI" },
];

export function AgentSelector(props: {
  agent: AgentType;
  isDisabled: boolean;
  onAgentChange: (value: AgentType) => void;
  /** If provided, agents not in this list are shown but disabled (grayed out). */
  availableAgents?: AgentType[];
}) {
  return (
    <FormField
      label="CLI Harness"
      tooltip="The coding-agent CLI this session runs — Claude Code, OpenAI Codex, Gemini, or OpenCode. This choice determines which provider, accounts, launchers, and models apply in the fields below. Harnesses the selected node doesn't have installed are grayed out."
      bookmarkId="cliHarness"
    >
      <UiSelect
        value={props.agent}
        onChange={e => props.onAgentChange(e.target.value as AgentType)}
        disabled={props.isDisabled}
      >
        {ALL_AGENTS.map(a => {
          const isAvailable =
            !props.availableAgents || props.availableAgents.includes(a.value);
          return (
            <option key={a.value} value={a.value} disabled={!isAvailable}>
              {a.label}
              {!isAvailable ? " (unavailable)" : ""}
            </option>
          );
        })}
      </UiSelect>
      {/* #3121's capability disclosure no longer lives in this column — #3314
          (epic #3285 round 11) moved it to a full-width "Capabilities"
          subheading under the CLI Harness + Launcher row (NewSession/index.tsx). */}
    </FormField>
  );
}
