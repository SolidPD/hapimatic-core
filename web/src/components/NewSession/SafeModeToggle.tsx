// SPDX-License-Identifier: AGPL-3.0-only
import { FormField } from "./FormField";
import { UiToggle } from "./controls";

/**
 * Issue #1633: spawn-time Safe Mode toggle. Launches the session's claude
 * child with `--safe-mode`, which disables CLAUDE.md, skills, plugins, hooks,
 * and MCP customizations — a minimal-preamble environment for testing the
 * Fable model without content-sensitivity triggers from the scaffolding.
 * Default OFF; spawn-only (not live-switchable).
 */
export function SafeModeToggle(props: {
  safeMode: boolean;
  isDisabled: boolean;
  onToggle: (value: boolean) => void;
}) {
  return (
    <FormField
      label="Safe Mode"
      tooltip="Launches with CLAUDE.md, skills, hooks & MCP disabled (claude --safe-mode) — a minimal environment for Fable model testing."
      bookmarkId="safeMode"
    >
      <UiToggle
        checked={props.safeMode}
        onChange={props.onToggle}
        disabled={props.isDisabled}
      />
    </FormField>
  );
}
