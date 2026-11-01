// SPDX-License-Identifier: AGPL-3.0-only
import { useId } from "react";
import { PickerModal } from "./PickerModal";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/StatusDot";
import { GitHubAccountAvatar } from "@/components/GitHubAccountAvatar";
import type { GitHubAccount } from "@/hooks/queries/useGitHubRepos";
import {
  GITHUB_STATUS_PRESENTATION,
  GITHUB_STATUS_UNCHECKED_NOTE,
  groupGitHubAccountsByLinker,
  isGitHubStatusUnchecked,
} from "@/lib/githubConnections";

/**
 * Issue #2019 — GitHub account selection modal for the Create form.
 *
 * Selection-only sibling of `GitHubRepoSelectorModal`. The "account" is the host's
 * `gh` / `GH_TOKEN` identity, or on a cloud VM a GitHub account its users linked on
 * hapimatic.com (#4793). Those linked rows read like Settings → Connectors (D-4793-8,
 * Matt's pick G1): grouped under the email that linked them (ruling R6: a shared instance
 * lists every user's links), each with its avatar, @login, the Default mark and a coloured
 * status, an expired or revoked link dimmed. "No GitHub account" comes first and, on a
 * broker host, "Connect another account" last. The list is short, so there is no search
 * box. Emits `onSelect(login | null)` and closes immediately; performs NO network mutation.
 *
 * Built on the shared `PickerModal` shell so it matches the directory browser
 * and the repo picker (portaled, 80% visual-viewport height, internal scroll).
 */

/** The status line under a linked (broker) account; null for a host `gh` identity. */
export function accountStatusText(account: GitHubAccount): string | null {
  if (!account.status) return null;
  const status = GITHUB_STATUS_PRESENTATION[account.status];
  return status.action === "relink"
    ? `${status.label} · re-link in Settings`
    : status.label;
}

const TONE_TEXT = {
  ok: "text-[var(--status-ok)]",
  warn: "text-[var(--status-warn)]",
  hot: "text-[var(--status-hot)]",
} as const;

/** The radio mark at the start of every row, filled on the selected one. */
function RadioMark(props: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border-2 ${
        props.checked ? "border-[var(--app-link)]" : "border-[var(--app-hint)]"
      }`}
    >
      {props.checked && (
        <span className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
      )}
    </span>
  );
}

const ROW =
  "flex h-auto w-full items-center justify-start gap-3 rounded-md border px-3 py-2.5 text-left font-normal transition-colors hover:bg-[var(--app-hover)]";
const rowState = (checked: boolean) =>
  checked
    ? "border-[var(--app-link)] bg-[var(--app-link)]/10"
    : "border-[var(--app-border)]";

export function GitHubAccountSelectorModal(props: {
  isOpen: boolean;
  onClose: () => void;
  accounts: GitHubAccount[];
  /** Selected account login, or null when none chosen. */
  selectedAccount: string | null;
  isLoading?: boolean;
  /** Fired with the chosen account login (or null for "no clone"); modal then closes. */
  onSelect: (login: string | null) => void;
  /**
   * Whether this host can clone a repository. A broker-backed cloud VM cannot yet (#4793,
   * D-4793-3), so its "No GitHub account" row must not talk about cloning. Defaults to true.
   */
  canClone?: boolean;
  /**
   * #4793: where "Connect another account" goes — Settings → Connectors on a broker-backed
   * host, where linking happens. Absent (a `gh` host): no such row.
   */
  connectHref?: string;
}) {
  const {
    isOpen,
    onClose,
    accounts,
    selectedAccount,
    isLoading,
    onSelect,
    canClone = true,
    connectHref,
  } = props;
  // #6085: ids for the "could not check" notes the rows point at (aria-describedby).
  const noteIdPrefix = useId();

  const handleSelect = (login: string | null) => {
    onSelect(login);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <PickerModal
      title="Choose a GitHub account"
      description={
        canClone
          ? "The account whose repositories you can clone into this session."
          : "The GitHub account this session uses."
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
        {/* "No GitHub account" — clears the clone (no account → no repo picker) */}
        <Button
          type="button"
          variant="ghost"
          aria-pressed={selectedAccount === null}
          onClick={() => handleSelect(null)}
          className={`${ROW} ${rowState(selectedAccount === null)}`}
        >
          <RadioMark checked={selectedAccount === null} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium text-[var(--app-fg)]">
              No GitHub account
            </span>
            <span className="truncate text-[length:var(--text-caption)] text-[var(--app-hint)]">
              {canClone
                ? "Start without cloning a repository"
                : "Start without a GitHub account"}
            </span>
          </span>
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
          groupGitHubAccountsByLinker(accounts).map((group, groupIndex) => (
            <div
              key={group.email ?? ""}
              role="group"
              aria-label={group.email ?? "GitHub accounts"}
              className="flex flex-col gap-1"
            >
              {group.email && (
                <div className="px-1 pb-0.5 pt-2 text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
                  {group.email}
                </div>
              )}
              {group.accounts.map((account, accountIndex) => {
                const checked = selectedAccount === account.login;
                const statusText = accountStatusText(account);
                const tone = account.status
                  ? GITHUB_STATUS_PRESENTATION[account.status].tone
                  : null;
                const uncheckedNoteId = isGitHubStatusUnchecked(account)
                  ? `${noteIdPrefix}-unchecked-${groupIndex}-${accountIndex}`
                  : undefined;
                return (
                  <Button
                    key={`${account.email ?? ""}/${account.login}`}
                    type="button"
                    variant="ghost"
                    aria-pressed={checked}
                    aria-describedby={uncheckedNoteId}
                    onClick={() => handleSelect(account.login)}
                    className={`${ROW} ${rowState(checked)}`}
                  >
                    <RadioMark checked={checked} />
                    <GitHubAccountAvatar
                      login={account.login}
                      size={32}
                      className={tone === "hot" ? "opacity-60" : undefined}
                    />
                    <span
                      className={`flex min-w-0 flex-1 flex-col ${tone === "hot" ? "opacity-75" : ""}`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium text-[var(--app-fg)]">
                          @{account.login}
                        </span>
                        {account.name && (
                          <span className="truncate text-[length:var(--text-caption)] text-[var(--app-hint)]">
                            {account.name}
                          </span>
                        )}
                        {account.isDefault && (
                          <Badge variant="success">Default</Badge>
                        )}
                      </span>
                      {statusText && tone && (
                        <span
                          className={`flex items-center gap-1.5 truncate text-[length:var(--text-caption)] ${TONE_TEXT[tone]}`}
                        >
                          {/* Decorative: the text beside it carries the status, so the dot is not announced too. */}
                          <span aria-hidden="true" className="inline-flex">
                            <StatusDot status={tone} label={statusText} />
                          </span>
                          {statusText}
                        </span>
                      )}
                      {/* #6085: its own line, wrapping (the row button is nowrap), so the "reopen"
                          half is never truncated on a phone. It is the row's DESCRIPTION, not part
                          of its name: aria-hidden keeps it out of the name computed from content,
                          and the button's aria-describedby still reads it (a directly referenced
                          node counts even when hidden). */}
                      {uncheckedNoteId && (
                        <span
                          id={uncheckedNoteId}
                          aria-hidden="true"
                          className="whitespace-normal text-[length:var(--text-caption)] text-[var(--status-warn)]"
                        >
                          {GITHUB_STATUS_UNCHECKED_NOTE}
                        </span>
                      )}
                    </span>
                  </Button>
                );
              })}
            </div>
          ))
        )}

        {connectHref && !isLoading && (
          // Linking happens on hapimatic.com, reached from Settings → Connectors (R9 return).
          <a
            href={connectHref}
            className="mt-1 flex items-center gap-3 rounded-md border border-[var(--app-border)] px-3 py-2.5 text-sm font-semibold text-[var(--app-link)] no-underline"
          >
            <span
              aria-hidden="true"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-[var(--app-link)]/60"
            >
              <Plus className="h-4 w-4" />
            </span>
            Connect another account
          </a>
        )}
      </div>
    </PickerModal>
  );
}
