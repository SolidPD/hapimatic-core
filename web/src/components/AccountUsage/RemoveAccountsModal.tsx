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

/** A session bound to the account being removed. */
export type BoundSession = { id: string; label: string };

/**
 * The account a card's "Remove Account" opens (#4466 R8). The page builds it
 * from its already-loaded data — the resolved `nodes` (with the D2
 * non-federated single-local-node fallback) and the bound sessions — so the
 * modal needs no queries of its own.
 */
export type AccountRemovalRow = {
  accountUuid: string;
  /** account.email ?? displayLabel (an OpenAI account: its label). */
  email: string;
  /** colloquial nickname; "" when none. */
  nickname: string;
  /** Every node the account is registered on (removal targets). */
  nodes: { nodeId: string; nodeLabel: string }[];
  /** Sessions bound to this account. */
  boundSessions: BoundSession[];
};

type RemoveAccountsModalProps = {
  /** The account to remove; `null` keeps the modal closed. */
  account: AccountRemovalRow | null;
  onClose: () => void;
  /**
   * Performs the removal for the chosen nodes. The page passes a
   * fire-and-forget handler (resolves immediately; partial failures surface via
   * toast), so the modal closes on confirm. A handler that REJECTS instead
   * keeps the modal open and surfaces the error.
   */
  onConfirm: (
    removals: { accountUuid: string; nodeIds: string[] }[]
  ) => Promise<void> | void;
  isPending: boolean;
};

/**
 * Single-account removal (issue #4466 R8, E-3 A), opened by a card's "Remove
 * Account". It replaced the #2131 bulk modal and keeps its two phases in one
 * Radix `Dialog`:
 *   1. scope   → "Everywhere" (every node holding the account) by default, with
 *                a "Choose nodes…" expander for a partial removal.
 *   2. confirm → "Remove <account> from N nodes?", the host-safe reassurance
 *                and the bound-session list; Cancel returns to the scope step.
 *
 * The copy is provider-neutral (#3982), so an OpenAI account uses it as is. The
 * page hides "Remove Account" on a provider's last account; per-node
 * last-account cases are still the server's 409 plus the caller's toast.
 */
export function RemoveAccountsModal(props: RemoveAccountsModalProps) {
  const { account, onClose, onConfirm, isPending } = props;
  const isOpen = account != null;

  const [phase, setPhase] = useState<"scope" | "confirm">("scope");
  const [chosenNodes, setChosenNodes] = useState<Set<string>>(() => new Set());
  const [scopeOpen, setScopeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed "Everywhere" each time the modal opens on an account. Seeded on open
  // ONLY — a mid-open prop change must not clobber the user's choice.
  const accountUuid = account?.accountUuid;
  useEffect(() => {
    if (!account) return;
    setPhase("scope");
    setChosenNodes(new Set(account.nodes.map(n => n.nodeId)));
    setScopeOpen(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountUuid]);

  const toggleNode = (nodeId: string) => {
    setChosenNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const nodeIds = useMemo(
    () =>
      (account?.nodes ?? [])
        .map(n => n.nodeId)
        .filter(id => chosenNodes.has(id)),
    [account, chosenNodes]
  );
  const canRemove = nodeIds.length > 0;

  const handleConfirm = async () => {
    if (!account) return;
    setError(null);
    try {
      await onConfirm([{ accountUuid: account.accountUuid, nodeIds }]);
      // Fire-and-forget handlers resolve immediately → close the modal; partial
      // failures surface via the caller's toast.
      onClose();
    } catch (err) {
      // A rejecting handler keeps the modal open with the error.
      setError(
        err instanceof Error
          ? err.message
          : "Failed to remove the account. Please try again."
      );
    }
  };

  const total = account?.nodes.length ?? 0;
  const scopeSummary =
    total === 0
      ? "No nodes"
      : nodeIds.length === 0
        ? "No nodes selected"
        : nodeIds.length === total
          ? "Everywhere"
          : `${nodeIds.length} of ${total} nodes`;
  const mNodes = nodeIds.length === 1 ? "1 node" : `${nodeIds.length} nodes`;
  const bound = account?.boundSessions ?? [];
  const boundLead =
    bound.length === 1
      ? "1 session is currently bound to this account:"
      : `${bound.length} sessions are currently bound to this account:`;
  const name = account?.email ?? "";

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {phase === "scope" ? "Remove account" : "Remove account?"}
          </DialogTitle>
          <DialogDescription className="mt-2">
            {phase === "scope"
              ? `Remove ${name} from every node it is on, or choose the nodes.`
              : `Remove ${name} from ${mNodes}? The provider login on the host machine is NOT affected — you can log back in to restore the account in Hapimatic at any time.`}
          </DialogDescription>
        </DialogHeader>

        {phase === "scope" && account ? (
          <div
            className="mt-2 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2"
            data-testid="remove-account-scope"
          >
            <span className="block truncate text-[length:var(--text-body)] font-medium text-[var(--app-fg)]">
              {account.email}
            </span>
            {account.nickname !== "" && (
              <span className="block truncate text-[length:var(--text-caption)] text-[var(--app-hint)]">
                {account.nickname}
              </span>
            )}
            {total === 0 && (
              <p
                data-testid="remove-account-no-nodes"
                className="mt-2 text-[length:var(--text-caption)] text-[var(--app-hint)]"
              >
                None of the nodes holding this account can be reached from this
                page, so there is nothing to remove here.
              </p>
            )}
            {total > 0 && (
              <div className="mt-2">
                <Button
                  type="button"
                  variant="ghostStatic"
                  onClick={() => setScopeOpen(o => !o)}
                  aria-expanded={scopeOpen}
                  data-testid="remove-account-scope-toggle"
                  className="h-auto p-0 text-[length:var(--text-caption)] font-normal text-[var(--app-link)] hover:text-[var(--app-link)] hover:opacity-80"
                >
                  {scopeOpen ? "Hide nodes" : "Choose nodes…"} ({scopeSummary})
                </Button>
                {scopeOpen && (
                  <ScrollArea className="mt-1.5 max-h-[40vh]">
                    <ul className="space-y-1">
                      {account.nodes.map(node => (
                        <li key={node.nodeId}>
                          <label className="flex cursor-pointer items-center gap-2 text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
                            <input
                              type="checkbox"
                              checked={chosenNodes.has(node.nodeId)}
                              onChange={() => toggleNode(node.nodeId)}
                              className="h-4 w-4 shrink-0 accent-[var(--app-accent)]"
                              data-testid={`remove-account-node-checkbox-${node.nodeId}`}
                            />
                            <span className="truncate">{node.nodeLabel}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </ScrollArea>
                )}
              </div>
            )}
          </div>
        ) : bound.length > 0 ? (
          <div className="mt-3 rounded-md bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-hint)]">
            <p>{boundLead}</p>
            <ScrollArea className="mt-2 max-h-32">
              <ul className="list-disc space-y-0.5 pl-5">
                {bound.map(session => (
                  <li key={session.id} className="truncate">
                    {session.label}
                  </li>
                ))}
              </ul>
            </ScrollArea>
            <p className="mt-2">
              {
                "Removing this account will leave those sessions on the node's default account."
              }
            </p>
          </div>
        ) : null}

        {error ? (
          <div className="mt-3 rounded-md bg-red-900/20 p-3 text-sm text-red-400">
            {error}
          </div>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          {phase === "scope" ? (
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
                onClick={() => {
                  setError(null);
                  setPhase("confirm");
                }}
                disabled={!canRemove}
                data-testid="remove-account-continue"
              >
                Remove
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setPhase("scope")}
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
                data-testid="remove-account-confirm"
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
