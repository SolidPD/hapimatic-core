// SPDX-License-Identifier: AGPL-3.0-only
import { AddAccountInstructions } from "@/components/AddAccountInstructions";
import { Button } from "@/components/ui/button";

type AccountSelectorEmptyStateProps = {
  /** Whether the "Log in on the host" fallback help panel is showing (modal-owned state). */
  showHelp: boolean;
  onShowHelp: () => void;
  onHideHelp: () => void;
  /** Launch the in-app web OAuth login wizard (issue #1263). */
  onAddAccount?: () => void;
};

/**
 * Empty-list state and the "Log in on the host" fallback help panel for the
 * AccountSelectorModal (epic #1446, Sub-Issue H; in-app login added by #1263).
 *
 * The PRIMARY path is now the in-app OAuth wizard (`onAddAccount`). The host
 * `claude /login` flow is retained as a fallback help panel for environments
 * where the in-app flow can't be used.
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
        <p className="font-medium">Log in on the host (fallback)</p>
        <AddAccountInstructions />
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
        Or log in on the host instead
      </Button>
    </div>
  );
}
