// SPDX-License-Identifier: AGPL-3.0-only
import { FormField } from "./FormField";
import { BareButton } from "@/components/ui/BareButton";
import type { NewBranchFeedback } from "./branchSelection";
import { trimChars, trimTrailingChars } from "@hapi/protocol";

/**
 * Branch-friendly name derived from a linked issue: `issue-<N>-<kebab-title>`,
 * lowercased, non-alphanumerics collapsed to hyphens, trimmed to ≤40 title chars.
 * (Moved here from `index.tsx` alongside the field it feeds.)
 */
export function toBranchName(num: number, title: string): string {
  const slug = trimTrailingChars(
    trimChars(title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), "-").slice(
      0,
      40
    ),
    "-"
  );
  return slug ? `issue-${num}-${slug}` : `issue-${num}`;
}

/**
 * Branch Name input for Worktree sessions. Extracted verbatim from `index.tsx`
 * (Create-page defaults round) to keep the container under the 1,500-line
 * `max-lines` guardrail; the FormField wrapper adds the info hint + bookmark.
 */
export function BranchNameField(props: {
  value: string;
  isDisabled: boolean;
  onChange: (value: string) => void;
  /**
   * hapimatic-private#4481: ref-name error (blocks Create), the slug the daemon
   * will actually create, and a collision with an existing branch.
   */
  feedback?: NewBranchFeedback;
  /** Switch to the colliding existing branch (or Basic for the current one). */
  onUseExisting?: () => void;
}) {
  const fb = props.feedback;
  return (
    <div className="px-3 py-1">
      <FormField
        label="Branch Name"
        tooltip="The git branch the session's worktree is created on. Auto-filled from the linked issue. Optional — left empty, a branch name is generated from the session id."
        bookmarkId="branchName"
      >
        <div className="relative">
          <input
            autoCapitalize="none"
            type="text"
            placeholder="Branch name (optional)"
            value={props.value}
            onChange={e => props.onChange(e.target.value)}
            disabled={props.isDisabled}
            className="h-9 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 pr-8 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
          />
          <BareButton
            type="button"
            onClick={() => props.value && props.onChange("")}
            disabled={props.isDisabled}
            className={`absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--app-hint)] transition-colors focus-visible:ring-0 ${
              props.value
                ? "hover:text-[var(--app-fg)] hover:bg-[var(--app-hover)] disabled:opacity-100"
                : "opacity-30 disabled:opacity-30 pointer-events-none disabled:pointer-events-none"
            }`}
            title="Clear"
            aria-label="Clear branch name"
          >
            <svg
              className="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </BareButton>
        </div>
        {fb?.error ? (
          <p
            role="alert"
            className="mt-1 text-[length:var(--text-caption-xs)] text-destructive"
            data-testid="branch-name-error"
          >
            {fb.error}
          </p>
        ) : null}
        {!fb?.error && fb?.slugHint ? (
          <p
            className="mt-1 text-[length:var(--text-caption-xs)] text-[var(--app-hint)]"
            data-testid="branch-name-slug"
          >
            Will be created as <code>{fb.slugHint}</code>.
          </p>
        ) : null}
        {!fb?.error && (fb?.collision || fb?.collidesWithCurrent) ? (
          <p
            className="mt-1 text-[length:var(--text-caption-xs)] text-[var(--app-hint)]"
            data-testid="branch-name-collision"
          >
            {fb.collidesWithCurrent
              ? "That's the current branch — Basic runs on it in place."
              : fb.collision?.remote
                ? "origin has a branch with this name — a new branch would be a separate local branch that doesn't track it."
                : "A branch with this name already exists — a suffixed name would be used."}{" "}
            {!fb.collidesWithCurrent && fb.collisionBlockedReason
              ? fb.collisionBlockedReason
              : null}
            {props.onUseExisting &&
            (fb.collidesWithCurrent || !fb.collisionBlockedReason) ? (
              <BareButton
                type="button"
                onClick={props.onUseExisting}
                disabled={props.isDisabled}
                className="text-[var(--app-link)] underline"
                data-testid="branch-name-use-existing"
              >
                {fb.collidesWithCurrent ? "Use Basic" : "Use existing branch"}
              </BareButton>
            ) : null}
          </p>
        ) : null}
      </FormField>
    </div>
  );
}
