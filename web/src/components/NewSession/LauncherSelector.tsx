// SPDX-License-Identifier: AGPL-3.0-only
import { FormField } from "./FormField";
import { UiSelect } from "./controls";
import type { ClaudeRemoteLauncherKind } from "@hapi/protocol/launcherResolver";

/**
 * Issue #1660: per-session launcher selector for the create-session page.
 *
 * Chooses which Claude launcher (SDK / Tmux / PTY) the about-to-spawn session
 * uses. Defaults to the resolved global default (read by the consumer from
 * `GET /api/launcher/status`). The override applies to ONE session only — the
 * daemon injects the choice as `HAPI_CLAUDE_LAUNCHER` at spawn, so the existing
 * `env > settings > default` resolver picks it up; the next session reverts to
 * the global default unless overridden again.
 *
 * Billing note (issue #2271, F20): all launchers currently draw from the Claude
 * subscription. The 2026-06-15 Agent SDK per-token billing change was paused/reversed
 * by Anthropic before it took effect, so there is no SDK-vs-subscription billing
 * distinction today. Surfaced via both the FormField tooltip and the always-visible
 * helper line.
 */
const LAUNCHER_OPTIONS: { value: ClaudeRemoteLauncherKind; label: string }[] = [
  { value: "sdk", label: "SDK" },
  { value: "tmux", label: "Tmux" },
  { value: "pty", label: "PTY" },
];

export function LauncherSelector(props: {
  launcher: ClaudeRemoteLauncherKind;
  isDisabled: boolean;
  onChange: (value: ClaudeRemoteLauncherKind) => void;
  /**
   * Issue #4568: why the launcher is locked (e.g. "Required for API billing" —
   * an API-key session runs on the SDK launcher only). Rendered under the select.
   */
  note?: string;
}) {
  return (
    <FormField
      label="Launcher"
      tooltip="How the Claude process is started — SDK (network API stream), Tmux (inside a tmux session), or PTY (attached terminal). Overrides the global default for this one session only. A subscription account's sessions draw from your Claude subscription on every launcher; a session billed to an API key runs on SDK only."
      bookmarkId="launcher"
    >
      <UiSelect
        value={props.launcher}
        onChange={e =>
          props.onChange(e.target.value as ClaudeRemoteLauncherKind)
        }
        disabled={props.isDisabled}
      >
        {LAUNCHER_OPTIONS.map(opt => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </UiSelect>
      {props.note ? (
        <p
          data-testid="launcher-lock-note"
          className="mt-0.5 text-[length:var(--text-caption-xs)] leading-tight text-[var(--app-hint)]"
        >
          {props.note}
        </p>
      ) : null}
    </FormField>
  );
}
