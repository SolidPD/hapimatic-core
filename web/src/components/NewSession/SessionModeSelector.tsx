// SPDX-License-Identifier: AGPL-3.0-only
import type { SessionMode } from "./types";
import { FormField } from "./FormField";
import { UiSelect } from "./controls";

/**
 * Session Mode select (Standard vs Scheduled). Extracted verbatim from
 * `index.tsx` (Create-page defaults round) to keep the container under the
 * 1,500-line `max-lines` guardrail; the FormField wrapper adds the info hint +
 * bookmark.
 */
export function SessionModeSelector(props: {
  sessionMode: SessionMode;
  isRemoteTarget: boolean;
  isDisabled: boolean;
  onChange: (value: SessionMode) => void;
}) {
  return (
    <div className="px-3 py-1">
      <FormField
        label="Session Mode"
        tooltip="Standard spawns an interactive session immediately. Scheduled instead creates a recurring automated task — the settings below configure when and how it fires. Scheduled mode runs on the local node only."
        bookmarkId="sessionMode"
      >
        <UiSelect
          value={props.sessionMode}
          onChange={e => props.onChange(e.target.value as SessionMode)}
          disabled={props.isDisabled}
        >
          <option value="standard">Standard</option>
          <option value="scheduled" disabled={props.isRemoteTarget}>
            Scheduled{props.isRemoteTarget ? " (local only)" : ""}
          </option>
        </UiSelect>
      </FormField>
    </div>
  );
}
