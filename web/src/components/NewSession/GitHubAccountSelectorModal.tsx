// SPDX-License-Identifier: AGPL-3.0-only
import { PickerModal } from "./PickerModal";
import { Button } from "@/components/ui/button";
import type { GitHubAccount } from "@/hooks/queries/useGitHubRepos";

/**
 * Issue #2019 — GitHub host-account selection modal for the Create form.
 *
 * Selection-only sibling of `GitHubRepoSelectorModal`. The "account" is the host
 * `gh` CLI identity (NOT an OAuth account). The list is usually short (often a
 * single identity), so there is no search box. Emits `onSelect(login | null)`
 * and closes immediately; performs NO network mutation.
 *
 * Built on the shared `PickerModal` shell so it matches the directory browser
 * and the repo picker (portaled, 80% visual-viewport height, internal scroll).
 */
export function GitHubAccountSelectorModal(props: {
  isOpen: boolean;
  onClose: () => void;
  accounts: GitHubAccount[];
  /** Selected account login, or null when none chosen. */
  selectedAccount: string | null;
  isLoading?: boolean;
  /** Fired with the chosen account login (or null for "no clone"); modal then closes. */
  onSelect: (login: string | null) => void;
}) {
  const { isOpen, onClose, accounts, selectedAccount, isLoading, onSelect } =
    props;

  const handleSelect = (login: string | null) => {
    onSelect(login);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <PickerModal
      title="Select GitHub Account"
      description={
        <>
          Choose the host <code>gh</code> identity to clone a repository with.
        </>
      }
      onClose={onClose}
      footer={
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          className="h-auto rounded-md px-4 py-2 text-sm font-normal text-[var(--app-fg)] transition-colors hover:bg-[var(--app-hover)]"
        >
          Cancel
        </Button>
      }
    >
      <div className="flex flex-col gap-1 p-2">
        {/* "None" — clears the clone (no account → no repo picker) */}
        <Button
          type="button"
          variant="ghost"
          onClick={() => handleSelect(null)}
          className={`flex h-auto w-full items-center justify-start rounded-md border px-3 py-2 text-left text-sm font-normal transition-colors hover:bg-[var(--app-hover)] ${
            selectedAccount === null
              ? "border-[var(--app-link)] bg-[var(--app-link)]/10"
              : "border-[var(--app-border)]"
          }`}
        >
          <span className="text-[var(--app-hint)]">None (no clone)</span>
        </Button>

        {isLoading ? (
          <div className="p-4 text-center text-sm text-[var(--app-hint)]">
            Loading accounts…
          </div>
        ) : accounts.length === 0 ? (
          <div className="p-4 text-center text-sm text-[var(--app-hint)]">
            No GitHub account connected
          </div>
        ) : (
          accounts.map(account => (
            <Button
              key={account.login}
              type="button"
              variant="ghost"
              onClick={() => handleSelect(account.login)}
              className={`flex h-auto w-full items-center justify-start rounded-md border px-3 py-2 text-left font-normal transition-colors hover:bg-[var(--app-hover)] ${
                selectedAccount === account.login
                  ? "border-[var(--app-link)] bg-[var(--app-link)]/10"
                  : "border-[var(--app-border)]"
              }`}
            >
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--app-fg)]">
                {account.name
                  ? `${account.login} — ${account.name}`
                  : account.login}
              </span>
            </Button>
          ))
        )}
      </div>
    </PickerModal>
  );
}
