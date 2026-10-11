// SPDX-License-Identifier: AGPL-3.0-only
import type { SessionType } from "./types";
import { FormField } from "./FormField";
import { UiSelect } from "./controls";

/** Kept ≤ ~90 chars so each fits TWO lines beside the label at the iPhone 16
 *  width (the inline-description column fits ~49 chars/line at 393px). */
export const sessionTypeDescriptions: Record<SessionType, string> = {
  simple: "Uses the current branch. Best for quick tasks and one-off sessions.",
  worktree:
    "Creates a git worktree with an isolated branch. Best for parallel work on the same repo.",
};

/**
 * hapimatic-private#4481: the inline description, naming the branch when the
 * Branch control knows it (e.g. "Runs in app on its current branch (ms-dev).").
 * Falls back to the static copy while the listing is loading/unavailable.
 */
export function describeSessionType(
  type: SessionType,
  context?: { dirLabel?: string | null; currentBranch?: string | null }
): string {
  if (type === "simple" && context?.dirLabel && context.currentBranch) {
    return `Runs in ${context.dirLabel} on its current branch (${context.currentBranch}).`;
  }
  return sessionTypeDescriptions[type];
}

export function SessionTypeSelector(props: {
  sessionType: SessionType;
  isDisabled: boolean;
  onSessionTypeChange: (value: SessionType) => void;
  /**
   * Issue #2270 (F25): explanatory hint shown below the control when the selected
   * directory is not a git repository. The `worktree` option stays SELECTABLE
   * (per-option affordance, NOT a hard disable) — an explicit user choice is
   * honored and the daemon backstop catches a doomed worktree-on-non-git spawn;
   * this only explains why `Basic` is the default.
   */
  worktreeHint?: string;
  /**
   * Issue #3558: hard-disable the `worktree` option — set while a clone-on-spawn
   * repo is selected (a first-time clone always runs as Basic). The reason is
   * shown on the `worktreeHint` line, since a native `<option>` cannot carry a
   * hover tooltip.
   */
  worktreeDisabled?: boolean;
  /** #4481: overrides the static inline description (names the branch). */
  description?: string;
}) {
  return (
    <FormField
      label="Git Type"
      tooltip="How the session's git workspace is set up. Worktree creates a separate working copy on its own isolated branch, so several sessions can work on the same repo in parallel without stepping on each other. Basic runs directly in the directory on its current branch."
      bookmarkId="gitType"
      inlineDescription={
        props.description ?? sessionTypeDescriptions[props.sessionType]
      }
    >
      <UiSelect
        value={props.sessionType}
        onChange={e => props.onSessionTypeChange(e.target.value as SessionType)}
        disabled={props.isDisabled}
      >
        <option value="simple">Basic</option>
        <option value="worktree" disabled={props.worktreeDisabled}>
          Worktree
        </option>
      </UiSelect>
      {props.worktreeHint ? (
        <p className="mt-1 text-[length:var(--text-caption-xs)] text-[var(--app-hint)] italic">
          {props.worktreeHint}
        </p>
      ) : null}
    </FormField>
  );
}
