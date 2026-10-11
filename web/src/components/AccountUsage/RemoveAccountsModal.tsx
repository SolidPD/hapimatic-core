// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/Spinner";

/** A session whose captured account email matches an account being removed. */
export type BoundSession = { id: string; label: string };

/**
 * One selectable account row in the bulk-removal modal. The page
 * (`account-usage.tsx`) builds these from its already-loaded `useAccountUsage`
 * data — the resolved `nodes` (with the D2 non-federated single-local-node
 * fallback) and the email-matched `boundSessions` — so the modal needs no
 * queries of its own.
 */
export type AccountRemovalRow = {
  accountUuid: string;
  /** account.email ?? displayLabel */
  email: string;
  /** colloquial nickname; "" when none. */
  nickname: string;
  /** Every node the account is registered on (removal targets). */
  nodes: { nodeId: string; nodeLabel: string }[];
  /** Sessions bound to this account by email match. */
  boundSessions: BoundSession[];
};

type RemoveAccountsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  /** Every stored account across the federation. */
  accounts: AccountRemovalRow[];
  /** The currently-viewed (local) node — drives optimistic card removal. */
  currentNodeId: string | null;
  /**
   * Performs the removal for the selected (account → nodes) pairs. The page
   * passes a fire-and-forget handler (resolves immediately; partial failures
   * surface via toast), so the modal closes on confirm. A handler that REJECTS
   * instead keeps the modal open and surfaces the error (parity with the #2054
   * single-account dialog's rejection behavior).
   */
  onConfirm: (
    removals: { accountUuid: string; nodeIds: string[] }[]
  ) => Promise<void> | void;
  isPending: boolean;
};

/**
 * Bulk account-removal modal (issue #2131) — replaces the per-card red ✕ that
 * epic #2130 stripped from `AccountUsageCard`.
 *
 * Two phases in one Radix `Dialog`:
 *   1. select  → one compact row per account (checkbox + email + nickname + node
 *                chips). Each checked account defaults to removal scope
 *                "Everywhere" (all its nodes) with a "Choose nodes…" expander
 *                exposing per-node checkboxes for partial removal.
 *   2. confirm → summary "N account(s) from M node(s)", the host-safe reassurance,
 *                and the aggregated bound-session list; Cancel returns to select.
 *
 * Composes the per-node-checkbox pattern and bound-session warning that were
 * ported from the retired `RemoveAccountConfirmDialog` (#2054), which the card no
 * longer renders. The last-account-anywhere proactive block lives in the page (it
 * hides the "Remove Accounts" button below 2 accounts), so this modal is only
 * ever opened with a removable set; per-node last-account cases are still handled
 * by the server 409 + the caller's partial-success toast.
 */
export function RemoveAccountsModal(props: RemoveAccountsModalProps) {
  const { isOpen, onClose, accounts, currentNodeId, onConfirm, isPending } =
    props;

  const [phase, setPhase] = useState<"select" | "confirm">("select");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [chosenNodes, setChosenNodes] = useState<Map<string, Set<string>>>(
    () => new Map()
  );
  const [expandedScope, setExpandedScope] = useState<Set<string>>(
    () => new Set()
  );
  const [error, setError] = useState<string | null>(null);

  const accountByUuid = useMemo(() => {
    const m = new Map<string, AccountRemovalRow>();
    for (const a of accounts) m.set(a.accountUuid, a);
    return m;
  }, [accounts]);

  // Seed a clean slate each time the modal opens. Seeded on open ONLY — a
  // mid-open prop change must not clobber the user's in-progress selection.
  useEffect(() => {
    if (!isOpen) return;
    setPhase("select");
    setSelected(new Set());
    setChosenNodes(new Map());
    setExpandedScope(new Set());
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const toggleAccount = (row: AccountRemovalRow) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(row.accountUuid)) {
        next.delete(row.accountUuid);
      } else {
        next.add(row.accountUuid);
        // Default scope "Everywhere" — all the account's nodes checked.
        setChosenNodes(cn => {
          const m = new Map(cn);
          m.set(row.accountUuid, new Set(row.nodes.map(n => n.nodeId)));
          return m;
        });
      }
      return next;
    });
  };

  const toggleScope = (uuid: string) => {
    setExpandedScope(prev => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });
  };

  const toggleNode = (uuid: string, nodeId: string) => {
    setChosenNodes(prev => {
      const m = new Map(prev);
      const set = new Set(m.get(uuid) ?? []);
      if (set.has(nodeId)) set.delete(nodeId);
      else set.add(nodeId);
      m.set(uuid, set);
      return m;
    });
  };

  // The concrete (account → nodes) removals from the current selection.
  const removals = useMemo(
    () =>
      Array.from(selected).map(uuid => ({
        accountUuid: uuid,
        nodeIds: Array.from(chosenNodes.get(uuid) ?? []),
      })),
    [selected, chosenNodes]
  );

  // Remove is enabled only when ≥1 account is selected AND every selected
  // account keeps ≥1 chosen node (an account scoped to zero nodes is a no-op).
  const canRemove =
    removals.length > 0 && removals.every(r => r.nodeIds.length > 0);

  const accountCount = removals.length;
  const nodeCount = useMemo(() => {
    const nodes = new Set<string>();
    for (const r of removals) for (const id of r.nodeIds) nodes.add(id);
    return nodes.size;
  }, [removals]);

  // Aggregated bound sessions across the selected accounts, deduped by id.
  const aggregatedBoundSessions = useMemo(() => {
    const byId = new Map<string, BoundSession>();
    for (const uuid of selected) {
      const row = accountByUuid.get(uuid);
      if (!row) continue;
      for (const s of row.boundSessions) {
        if (!byId.has(s.id)) byId.set(s.id, s);
      }
    }
    return Array.from(byId.values());
  }, [selected, accountByUuid]);

  const handleRemoveClick = () => {
    setError(null);
    setPhase("confirm");
  };

  const handleConfirm = async () => {
    setError(null);
    try {
      await onConfirm(removals);
      // Fire-and-forget handlers resolve immediately → close the modal; partial
      // failures surface via the caller's toast.
      onClose();
    } catch (err) {
      // A rejecting handler keeps the modal open with the error (parity with the
      // #2054 single-account dialog).
      const message =
        err instanceof Error
          ? err.message
          : "Failed to remove the accounts. Please try again.";
      setError(message);
    }
  };

  const scopeSummary = (uuid: string) => {
    const row = accountByUuid.get(uuid);
    const total = row?.nodes.length ?? 0;
    const chosen = chosenNodes.get(uuid)?.size ?? 0;
    if (total === 0) return "No nodes";
    if (chosen === 0) return "No nodes selected";
    if (chosen === total) return "Everywhere";
    return `${chosen} of ${total} nodes`;
  };

  const nAccounts =
    accountCount === 1 ? "1 account" : `${accountCount} accounts`;
  const mNodes = nodeCount === 1 ? "1 node" : `${nodeCount} nodes`;
  const boundCount = aggregatedBoundSessions.length;
  const boundLead =
    boundCount === 1
      ? "1 session is currently bound to a selected account:"
      : `${boundCount} sessions are currently bound to selected accounts:`;

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {phase === "select" ? "Remove accounts" : "Remove accounts?"}
          </DialogTitle>
          <DialogDescription className="mt-2">
            {phase === "select"
              ? "Select the accounts to remove. Each defaults to removing everywhere — expand “Choose nodes…” to remove from only some nodes."
              : `Remove ${nAccounts} from ${mNodes}? Your Claude Code login on the host machine is NOT affected — you can log back in to restore an account in Hapimatic at any time.`}
          </DialogDescription>
        </DialogHeader>

        {phase === "select" ? (
          <ScrollArea className="mt-2 max-h-[52vh]">
            <ul className="flex flex-col gap-1.5 pr-2">
              {accounts.map(row => {
                const isChecked = selected.has(row.accountUuid);
                const isExpanded = expandedScope.has(row.accountUuid);
                return (
                  <li
                    key={row.accountUuid}
                    className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2"
                  >
                    <label className="flex cursor-pointer items-start gap-2.5">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleAccount(row)}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--app-accent)]"
                        data-testid={`remove-accounts-select-${row.accountUuid}`}
                      />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-[length:var(--text-body)] font-medium text-[var(--app-fg)]">
                          {row.email}
                        </span>
                        {row.nickname !== "" && (
                          <span className="truncate text-[length:var(--text-caption)] text-[var(--app-hint)]">
                            {row.nickname}
                          </span>
                        )}
                        {row.nodes.length > 0 && (
                          <span className="flex flex-wrap items-center gap-1 text-[length:var(--text-caption)] text-[var(--app-hint)]">
                            {row.nodes.map((n, i) => (
                              <span key={n.nodeId} className="shrink-0">
                                {i > 0 ? "· " : ""}
                                {n.nodeLabel}
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
                    </label>

                    {isChecked && row.nodes.length > 0 && (
                      <div className="mt-2 pl-6">
                        <Button
                          type="button"
                          variant="ghostStatic"
                          onClick={() => toggleScope(row.accountUuid)}
                          aria-expanded={isExpanded}
                          data-testid={`remove-accounts-scope-toggle-${row.accountUuid}`}
                          className="h-auto p-0 text-[length:var(--text-caption)] font-normal text-[var(--app-link)] hover:text-[var(--app-link)] hover:opacity-80"
                        >
                          {isExpanded ? "Hide nodes" : "Choose nodes…"} (
                          {scopeSummary(row.accountUuid)})
                        </Button>
                        {isExpanded && (
                          <ul className="mt-1.5 space-y-1">
                            {row.nodes.map(node => (
                              <li key={node.nodeId}>
                                <label className="flex cursor-pointer items-center gap-2 text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
                                  <input
                                    type="checkbox"
                                    checked={
                                      chosenNodes
                                        .get(row.accountUuid)
                                        ?.has(node.nodeId) ?? false
                                    }
                                    onChange={() =>
                                      toggleNode(row.accountUuid, node.nodeId)
                                    }
                                    className="h-4 w-4 shrink-0 accent-[var(--app-accent)]"
                                    data-testid={`remove-account-node-checkbox-${row.accountUuid}-${node.nodeId}`}
                                  />
                                  <span className="truncate">
                                    {node.nodeLabel}
                                  </span>
                                </label>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        ) : (
          <>
            {boundCount > 0 ? (
              <div className="mt-3 rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
                <p>{boundLead}</p>
                <ScrollArea className="mt-2 max-h-32">
                  <ul className="list-disc space-y-0.5 pl-5">
                    {aggregatedBoundSessions.map(session => (
                      <li key={session.id} className="truncate">
                        {session.label}
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
                <p className="mt-2">
                  {
                    "Removing these accounts will leave those sessions on the node's default account."
                  }
                </p>
              </div>
            ) : null}
          </>
        )}

        {error ? (
          <div className="mt-3 rounded-md bg-red-900/20 p-3 text-sm text-red-400">
            {error}
          </div>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          {phase === "select" ? (
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={onClose}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="text-red-500"
                onClick={handleRemoveClick}
                disabled={!canRemove}
                data-testid="remove-accounts-continue"
              >
                Remove
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setPhase("select")}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="secondary"
                className={
                  isPending
                    ? "disabled:opacity-100 text-red-500"
                    : "text-red-500"
                }
                onClick={handleConfirm}
                disabled={isPending || !canRemove}
                data-testid="remove-accounts-confirm"
              >
                {isPending ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Spinner size="sm" label={null} className="!text-inherit" />
                    Removing…
                  </span>
                ) : (
                  "Remove"
                )}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
