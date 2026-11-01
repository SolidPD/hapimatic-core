// SPDX-License-Identifier: AGPL-3.0-only
/**
 * AccountNodeRow — the node row of an expanded account card (issue #4466, R6 +
 * R7 under ruling E-1 A). One `NodeBadge` pill per node holding the account,
 * with a caption stacked beneath it:
 *
 * - **Re-login needed** (#4461's `needsRelogin` on a node whose health read
 *   is `ok`): a red ring; desktop hover reads "Re-login required on <node> · tap
 *   to log in there", and a tap calls `requestRelogin` — the page's
 *   `ReloginDeepLink` then opens the "+ Add" modal on that node.
 * - **Default** (this account is the node's default — `set`, or `expired` when
 *   the default is the unrefreshable record): a mint ring (red wins when it also
 *   needs a re-login) and a "default" caption.
 * - **Any other online node**: a "set default" caption-link opening the per-node
 *   confirm and #3973's toast (`useAccountActions(api, { nodeId, nodeLabel })`).
 *   Gated by `canSetDefault` (the Anthropic card passes `status === "ok"`, the
 *   gate the old Row-2 chip had) and `disableSetActive`.
 * - **Unresolved label** (a `machines` label with no known node): a plain label,
 *   because `NodeBadge` renders nothing without a node id.
 *
 * Every column carries `data-state` (`default` | `default-relogin` | `relogin`
 * | `plain`), the deterministic state the replaced chip (#3973) exposed.
 */
import { useState } from "react";
import type { NodeAccountHealth, ProviderId } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { NodeBadge } from "@/components/NodeBadge";
import { useNodeActiveAccount } from "@/hooks/queries/useNodeActiveAccount";
import { useAccountActions } from "@/hooks/mutations/useAccountActions";
import { requestRelogin } from "@/lib/reloginLink";

export type AccountNodeItem = {
  /** Absent ⇒ a `machines` label that resolves to no known node (plain label). */
  nodeId?: string;
  nodeLabel: string;
  /** The peer's URL (`remoteNodes`), for the casing rule; absent for the UI host. */
  nodeUrl?: string;
  nodeStatus?: "online" | "degraded" | "offline";
  /** #4461: this node's record for the account needs a re-login. */
  needsRelogin: boolean;
  /** The node serving this UI (its label is passed through as received). */
  isUiHost?: boolean;
};

/** A resolved node: its id and its label. */
export type NodeRef = { nodeId: string; nodeLabel: string };

/** What the page knows about a node beyond its id: its URL, its connectivity,
 *  and whether it serves this UI. */
export type NodeFacts = Pick<
  AccountNodeItem,
  "nodeUrl" | "nodeStatus" | "isUiHost"
>;

/**
 * The node row's items for one account (#4466 R6): every node whose account
 * health read is `ok` and lists the account (with its `needsRelogin`, which
 * only an Anthropic record carries), then any node the usage row's `machines`
 * names that the read did not cover — while it loads, or for a node it could
 * not read. An `ok` read with no rejected entries lists every record on its
 * node (every provider), so a node it read without this account does not hold
 * it, even when a stale `machines` label still names it. A label that resolves
 * to no known node
 * stays as a plain item.
 * `fallbackNode` is the implicit local node of a non-federated install, whose
 * usage rows carry no `machines` (D2).
 */
export function buildAccountNodeItems(input: {
  provider: ProviderId;
  accountUuid: string;
  machines: string[];
  resolveLabel: (label: string) => NodeRef | undefined;
  fallbackNode?: NodeRef;
  healthNodes: NodeAccountHealth[];
  describe: (nodeId: string) => NodeFacts;
}): AccountNodeItem[] {
  const items: AccountNodeItem[] = [];
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  // Nodes A read in full: authoritative for whether they hold the account. A
  // read that dropped malformed entries (`rejectedEntries`) proves only what it
  // lists, so a `machines` label may still name its node.
  const readIds = new Set<string>();
  for (const row of input.healthNodes) {
    if (row.status !== "ok") continue;
    if (!row.rejectedEntries) readIds.add(row.nodeId);
    const entry = row.accounts.find(
      e => e.provider === input.provider && e.accountUuid === input.accountUuid
    );
    if (!entry || seenIds.has(row.nodeId)) continue;
    seenIds.add(row.nodeId);
    seenLabels.add(row.nodeLabel);
    const facts = input.describe(row.nodeId);
    items.push({
      nodeId: row.nodeId,
      nodeLabel: row.nodeLabel,
      ...facts,
      isUiHost: row.isLocal || facts.isUiHost === true,
      needsRelogin: input.provider === "anthropic" && entry.needsRelogin,
    });
  }
  const labels =
    input.machines.length > 0
      ? input.machines
      : input.fallbackNode
        ? [input.fallbackNode.nodeLabel]
        : [];
  for (const label of labels) {
    const node =
      input.resolveLabel(label) ??
      (input.machines.length === 0 ? input.fallbackNode : undefined);
    if (node) {
      if (seenIds.has(node.nodeId) || readIds.has(node.nodeId)) continue;
      seenIds.add(node.nodeId);
      seenLabels.add(node.nodeLabel);
      items.push({
        nodeId: node.nodeId,
        nodeLabel: node.nodeLabel,
        ...input.describe(node.nodeId),
        needsRelogin: false,
      });
    } else if (!seenLabels.has(label)) {
      seenLabels.add(label);
      items.push({ nodeLabel: label, needsRelogin: false });
    }
  }
  return items;
}

export type AccountNodeRowProps = {
  items: AccountNodeItem[];
  accountUuid: string;
  /** Names the account in the set-default confirm. */
  accountLabel: string;
  provider: ProviderId;
  api: ApiClient | null;
  disableSetActive?: boolean;
  /** Whether a "set default" caption may render (default true). */
  canSetDefault?: boolean;
};

function NodeColumn(props: {
  item: AccountNodeItem & { nodeId: string };
  accountUuid: string;
  accountLabel: string;
  provider: ProviderId;
  api: ApiClient | null;
  disableSetActive: boolean;
  canSetDefault: boolean;
}) {
  const { item, accountUuid, accountLabel, provider, api } = props;
  const scopedProvider = provider === "anthropic" ? undefined : provider;
  const { account: active, status } = useNodeActiveAccount(
    api,
    item.nodeId,
    scopedProvider ? { provider: scopedProvider } : undefined
  );
  const { selectAccount, isPending } = useAccountActions(api, {
    nodeId: item.nodeId,
    nodeLabel: item.nodeLabel,
  });
  const [confirmOpen, setConfirmOpen] = useState(false);

  // The hook reports "expired" for an unrefreshable default; it is still THE
  // default, and R7 shows "default" in exactly that case.
  const isDefault =
    active?.accountUuid === accountUuid &&
    (status === "set" || status === "expired");
  const relogin = item.needsRelogin;
  const state = isDefault
    ? relogin
      ? "default-relogin"
      : "default"
    : relogin
      ? "relogin"
      : "plain";
  const offline = item.nodeStatus === "offline";
  const showSetDefault =
    !isDefault &&
    !offline &&
    api != null &&
    props.canSetDefault &&
    !props.disableSetActive;

  return (
    <div
      data-testid={`account-node-${item.nodeId}`}
      data-state={state}
      className="flex flex-col items-center gap-0.5"
    >
      <NodeBadge
        nodeId={item.nodeId}
        nodeLabel={item.nodeLabel}
        nodeUrl={item.nodeUrl}
        nodeStatus={item.nodeStatus}
        labelAsReceived={item.isUiHost === true}
        ring={relogin ? "alert" : isDefault ? "default" : undefined}
        title={
          relogin
            ? `Re-login required on ${item.nodeLabel} · tap to log in there`
            : undefined
        }
        onActivate={
          relogin
            ? () =>
                requestRelogin({
                  provider: "anthropic",
                  nodeId: item.nodeId,
                  accountUuid,
                })
            : undefined
        }
      />
      {isDefault ? (
        <span
          data-testid="account-node-default"
          className="text-[length:var(--text-caption-xs)] leading-none text-[var(--app-accent)]"
        >
          default
        </span>
      ) : showSetDefault ? (
        <>
          <Button
            type="button"
            variant="ghostStatic"
            size="bare"
            data-testid="account-node-set-default"
            onClick={e => {
              e.stopPropagation();
              setConfirmOpen(true);
            }}
            title="Set as Default Acct on Node"
            className="text-[length:var(--text-caption-xs)] font-normal leading-none text-[var(--app-link)] hover:text-[var(--app-link)] hover:opacity-80"
          >
            set default
          </Button>
          <ConfirmDialog
            isOpen={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            title="Set active account?"
            description={`Make ${accountLabel} the active account for ${item.nodeLabel}. New sessions on this node will use it — your running sessions are not affected.`}
            confirmLabel="Set active"
            confirmingLabel="Setting…"
            onConfirm={async () => {
              if (scopedProvider) {
                await selectAccount(accountUuid, { provider: scopedProvider });
              } else {
                await selectAccount(accountUuid);
              }
            }}
            isPending={isPending}
          />
        </>
      ) : null}
    </div>
  );
}

export function AccountNodeRow(props: AccountNodeRowProps) {
  const {
    items,
    accountUuid,
    accountLabel,
    provider,
    api,
    disableSetActive = false,
    canSetDefault = true,
  } = props;
  if (items.length === 0) return null;
  return (
    <div
      data-testid="account-node-row"
      className="flex flex-wrap items-start gap-x-1.5 gap-y-1"
    >
      {items.map((item, i) =>
        item.nodeId ? (
          <NodeColumn
            key={item.nodeId}
            item={{ ...item, nodeId: item.nodeId }}
            accountUuid={accountUuid}
            accountLabel={accountLabel}
            provider={provider}
            api={api}
            disableSetActive={disableSetActive}
            canSetDefault={canSetDefault}
          />
        ) : (
          <div
            key={`unresolved:${item.nodeLabel}:${i}`}
            data-testid="account-node-unresolved"
            data-state="plain"
            className="flex flex-col items-center text-[length:var(--text-caption)] leading-tight text-[var(--app-hint)]"
          >
            {item.nodeLabel}
          </div>
        )
      )}
    </div>
  );
}
