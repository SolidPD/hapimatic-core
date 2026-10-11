// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SessionModelInfo — the harness line in SessionExpandedDetails' right column,
 * beneath the Session Action Cluster and the Session ID row (issue #1050;
 * #3288 S3; collapsed to ONE line by #4479).
 *
 * Issue #4479: ONE display-only line — `[terminal] Harness Launcher`:
 * - Harness = `getCliDisplayName` (e.g. "Claude Code", "Codex").
 * - Launcher = `getLauncherDisplayLabel` (e.g. "SDK" / "PTY" / "Tmux"),
 *   appended after a single space ONLY when `launcherKind` resolves ("Claude
 *   Code SDK"). The line is cramped, so the ` | ` separator it used to carry
 *   was dropped to reclaim its two characters. Only the Claude runner stamps
 *   `metadata.launcherKind`, so a non-Claude harness renders its name alone.
 *   Both containers (SessionHeader and SessionList) pass `launcherKind`, so
 *   the list card shows the same line.
 * - The line is deliberately NOT width-pinned: clipping the launcher label
 *   would hide information, so a long combination may widen the right column
 *   by a few px instead.
 *
 * History: #2882 had a combined `CLI | launcher` line + account email; #3288
 * split it into two rows and moved the account email to the Row-1 badge (the
 * transient in-details account-switch spinner went with it — #3574); #4479
 * re-combines the two rows behind the terminal icon.
 *
 * Variant props (R6): 0.
 */
import { TerminalIcon } from "@/components/icons";
import {
  getCliDisplayName,
  getLauncherDisplayLabel,
  type SessionLike,
} from "@/lib/sessionHelpers";

type SessionModelInfoProps = {
  session: SessionLike;
  /** `session.metadata.launcherKind` — appended as ` <label>` when it
   *  resolves (#4479). Absent for non-Claude harnesses. */
  launcherKind?: string;
};

export function SessionModelInfo({
  session,
  launcherKind,
}: SessionModelInfoProps) {
  const launcherLabel = getLauncherDisplayLabel(launcherKind);
  return (
    // The text is LEFT-justified to the Chain Icon's left edge: the right
    // column (SessionExpandedDetails) is one `items-start` block, and the Chain
    // Icon is the cluster's first `size="icon"` button (--icon-btn-size = 32px)
    // holding a 20px glyph, so the glyph's left edge sits (32 − 20) / 2 = 6px
    // inside the column — `pl-1.5` seats the icon on that exact edge. The
    // 11px icon + `gap-1` match the Session ID row above so both rows share one
    // icon column and one text column (#4479).
    <div
      data-testid="session-harness-line"
      className="flex items-center gap-1 pl-1.5 text-[9px] leading-tight text-[var(--app-hint)] whitespace-nowrap" /* design-tokens-allow: 9px sub-caption metadata size; no exact type-scale token (ladder floor is 10px) - L2 exception (#3404) */
    >
      <TerminalIcon className="size-2.75 shrink-0" />
      {/* One inline text run so the separating space is real text
          ("Claude Code SDK" for screen readers + textContent), not flex gap. */}
      <span>
        <span data-testid="session-cli-indicator">
          {getCliDisplayName(session)}
        </span>
        {launcherLabel ? (
          <>
            {" "}
            <span data-testid="session-launcher-indicator">
              {launcherLabel}
            </span>
          </>
        ) : null}
      </span>
    </div>
  );
}
