// SPDX-License-Identifier: AGPL-3.0-only
import { FormField } from "./FormField";
import { UiSelect } from "./controls";
import {
  getSpawnPermissionModeOptionsForFlavor,
  getPermissionModeOptionsForFlavor,
  getPermissionModeLabel,
} from "@hapi/protocol/modes";
import type { PermissionMode } from "@hapi/protocol/modes";
import type { AgentType } from "./types";

/**
 * Issue #1951 (A4) — Permission-Mode picker, replacing the binary YOLO toggle.
 * Rendered in BOTH the Create-Session form (spawn plane) and the Session
 * Configuration modal (live plane).
 *
 * "Honest pickers only" (operator ruling 2026-08-27 / issue #3350): a picker
 * offers ONLY choices with verified-different behavior; when a flavor has a
 * single effective level it renders one grayed-out, non-interactive "default"
 * — never a dropdown implying a choice that does not exist.
 *
 *  - `plane="spawn"` (default, Create form): options come from
 *    `getSpawnPermissionModeOptionsForFlavor` — claude: default/accept/YOLO/plan;
 *    codex: default/read-only/safe-YOLO/YOLO; gemini: a VERIFIED default/YOLO pair
 *    (`--yolo` produces an observable ACP `session/request_permission` difference,
 *    #3350 Task 1); opencode: default/YOLO from its real all-ask vs all-allow
 *    spawn posture. No unverified synthetic pair remains.
 *  - `plane="live"` (Session Config modal): options come from
 *    `getPermissionModeOptionsForFlavor` — the IN-SESSION-switchable set. Gemini
 *    and opencode expose NO in-session modes (posture fixed at spawn), so this
 *    renders one grayed-out "default": selecting a live mode for them would throw
 *    client-side / 400 server-side (`useSessionActions` flavor gate) — the live
 *    incoherence #3350 Task 5 closes.
 *
 * The selected mode is collapsed to the spawn `yolo` boolean by
 * `formState.effective.yolo` (via the single canonical `isYoloEquivalentMode`).
 */
export function PermissionModeSelector(props: {
  permissionMode: PermissionMode;
  flavor: AgentType;
  isDisabled: boolean;
  onChange: (value: PermissionMode) => void;
  /** Narrow-column host (the Session Configuration modal): keep "Permission
   *  Mode" on one line with the info icon pinned right (FormField `nowrapLabel`). */
  compactLabel?: boolean;
  /** Issue #3350: which permission plane this picker governs. "spawn" (default,
   *  Create form) offers the spawn postures; "live" (Session Config modal) offers
   *  only in-session-switchable modes — gemini/opencode have none → grayed default. */
  plane?: "spawn" | "live";
}) {
  const options =
    props.plane === "live"
      ? getPermissionModeOptionsForFlavor(props.flavor)
      : getSpawnPermissionModeOptionsForFlavor(props.flavor);

  // Honest single-value rendering (#3350 R2 / Task 4): a flavor with ≤1 effective
  // level (e.g. gemini/opencode on the live plane — no in-session switching)
  // renders one grayed-out, non-interactive default, NOT a disabled dropdown.
  if (options.length <= 1) {
    const shown: PermissionMode =
      options.length === 1 ? options[0].mode : props.permissionMode;
    return (
      <FormField
        label="Permission Mode"
        tooltip="This session's permission posture is fixed at spawn — this flavor exposes no in-session permission switching."
        bookmarkId="permissionMode"
        nowrapLabel={props.compactLabel}
      >
        <div
          data-testid="permission-mode-fixed"
          role="note"
          aria-disabled="true"
          title="Fixed at spawn — this flavor has no in-session permission switching."
          className="flex h-9 w-full cursor-not-allowed items-center rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 text-sm text-[var(--app-hint)] opacity-60"
        >
          {getPermissionModeLabel(shown)}
        </div>
      </FormField>
    );
  }

  return (
    <FormField
      label="Permission Mode"
      tooltip="The session's starting permission posture. YOLO bypasses approval prompts and sandboxing (--dangerously-skip-permissions). Claude and Codex can switch modes in-session; Gemini and OpenCode fix the posture at spawn."
      bookmarkId="permissionMode"
      nowrapLabel={props.compactLabel}
    >
      <UiSelect
        value={props.permissionMode}
        onChange={e => props.onChange(e.target.value as PermissionMode)}
        disabled={props.isDisabled}
      >
        {options.map(opt => (
          <option key={opt.mode} value={opt.mode}>
            {getPermissionModeLabel(opt.mode)}
          </option>
        ))}
      </UiSelect>
    </FormField>
  );
}
