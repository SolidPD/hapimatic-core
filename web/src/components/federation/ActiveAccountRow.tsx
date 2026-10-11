// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from "react";
import type { ApiClient } from "@/api/client";
import { useNodeActiveAccount } from "@/hooks/queries/useNodeActiveAccount";
import { AccountSelectorModal } from "@/components/AccountSelectorModal";
import { Button } from "@/components/ui/button";

type ActiveAccountRowProps = {
  api: ApiClient | null;
  nodeId: string;
};

/**
 * Per-node Active Account row (issue #1037, R9). Surfaces the Anthropic OAuth
 * account bound to the node (`useNodeActiveAccount` → epic #1446 read path) and
 * a "Switch" button that opens the real per-node `AccountSelectorModal`
 * (`scope="per-node"`) — #1037 is the first mount of that branch. Renders per
 * status (`set`/`expired`/`not-set`/`loading`/`error`) and never crashes the
 * card on a missing/null account. The Switch button + modal calls stop
 * propagation so they do not trigger the enclosing card's navigate (R7).
 */
export function ActiveAccountRow({ api, nodeId }: ActiveAccountRowProps) {
  const { account, status } = useNodeActiveAccount(api, nodeId);
  const [switchOpen, setSwitchOpen] = useState(false);

  let display: ReactNode;
  switch (status) {
    case "loading":
      display = (
        <span
          data-testid="account-skeleton"
          className="h-3 w-28 animate-pulse rounded bg-[var(--app-secondary-bg)]"
        />
      );
      break;
    case "set":
      display = (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[length:var(--text-body)] text-[var(--app-fg)]">
            {account?.emailAddress}
          </span>
          <span className="truncate text-[length:var(--text-caption)] text-[var(--app-hint)]">
            {account?.organizationName}
          </span>
        </span>
      );
      break;
    case "expired":
      display = (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[length:var(--text-body)] text-[var(--app-fg)]">
            {account?.emailAddress}
          </span>
          <span
            className={
              /* design-tokens-allow: amber encodes the "expired" account state (a behavior-coupled state signal, not a decorative section accent) — R4; no --status-warn token exists yet (#3393) */ "text-[length:var(--text-caption)] text-[#f59e0b]"
            }
          >
            Token expired — re-login required
          </span>
        </span>
      );
      break;
    case "not-set":
      display = (
        <span className="text-[length:var(--text-body)] text-[var(--app-hint)]">
          Node default
        </span>
      );
      break;
    case "error":
    default:
      display = (
        <span className="text-[length:var(--text-body)] text-[var(--app-hint)]">
          Unavailable
        </span>
      );
      break;
  }

  return (
    <div
      data-testid="active-account-row"
      className="flex items-center justify-between gap-2 border-t border-[var(--app-border)] pt-2"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[length:var(--text-caption)] uppercase tracking-wide text-[var(--app-hint)]">
          Account
        </span>
        {display}
      </div>
      <Button
        type="button"
        variant="secondary"
        data-testid="account-switch-button"
        onClick={e => {
          e.stopPropagation();
          setSwitchOpen(true);
        }}
        className="h-auto flex-shrink-0 rounded-md px-2.5 py-1 text-[length:var(--text-body-dense)] text-[var(--app-link)] hover:opacity-80"
      >
        Switch
      </Button>
      <AccountSelectorModal
        isOpen={switchOpen}
        onClose={() => setSwitchOpen(false)}
        api={api}
        scope="per-node"
        nodeId={nodeId}
        currentAccountEmail={account?.emailAddress}
      />
    </div>
  );
}
