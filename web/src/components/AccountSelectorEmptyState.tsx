// SPDX-License-Identifier: AGPL-3.0-only
import { AddAccountInstructions } from "@/components/AddAccountInstructions";
import { Button } from "@/components/ui/button";

type AccountSelectorEmptyStateProps = {
  /** Whether the "Other ways to add an account" help panel is showing (modal-owned state). */
  showHelp: boolean;
  onShowHelp: () => void;
  onHideHelp: () => void;
  /** Launch the in-app web OAuth login wizard (issue #1263). */
  onAddAccount?: () => void;
};

/**
 * Empty-list state and the "Other ways to add an account" help panel for the
 * AccountSelectorModal (epic #1446, Sub-Issue H; in-app login added by #1263).
 *
 * The PRIMARY path is the in-app OAuth wizard (`onAddAccount`). The help panel
 * points to Settings → Provider Accounts (#6837 R1): since #6800 a sign-in made
 * from the user's own shell is not read by Hapimatic, so there is no host-login
 * fallback any more.
 */
export function AccountSelectorEmptyState({
  showHelp,
  onShowHelp,
  onHideHelp,
  onAddAccount,
}: AccountSelectorEmptyStateProps) {
  if (showHelp) {
    return (
      <div className="flex flex-col gap-3 p-4 text-sm text-[var(--app-fg)]">
        <p className="font-medium">Other ways to add an account</p>
        <AddAccountInstructions anthropicContext="account-selector" />
        <Button
          type="button"
          variant="secondary"
          onClick={onHideHelp}
          className="self-start"
        >
          Back
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 p-6 text-center">
      <p className="text-sm text-[var(--app-hint)]">
        No accounts stored. Add one to get started.
      </p>
      {onAddAccount && (
        <Button type="button" onClick={onAddAccount}>
          Add account
        </Button>
      )}
      <Button
        type="button"
        variant="ghostStatic"
        onClick={onShowHelp}
        className="h-auto p-0 text-xs font-normal text-[var(--app-hint)] underline hover:text-[var(--app-hint)]"
      >
        Other ways to add an account
      </Button>
    </div>
  );
}
