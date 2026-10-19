// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { LOCAL_NODE_ID } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { AddToProviderModal } from "@/components/AccountUsage/AddToProviderModal";
import { useRefreshAccountUsage } from "@/hooks/queries/useAccountUsage";
import type { ReloginSearch } from "@/lib/reloginLink";

/**
 * The re-login deep link (issue #4461, R9; D-A1 = A; made node-aware by #4462,
 * D-B1 = A; re-pointed to the "+ Add" modal by #4464).
 * `?relogin=anthropic&node=<id>` opens the Anthropic "+ Add" modal with that node
 * preselected, so the login is stored THERE.
 *
 * "UI host" is `LOCAL_NODE_ID` or the `localNode.nodeId` that
 * `GET /api/federation/nodes` reports. While that read is pending nothing opens
 * (a hub's own id would otherwise read as another node). The UI host opens the
 * modal on its default selection; any other node is passed as `initialNodeId`.
 *
 * #4464: the modal, not this handler, decides whether the node can take a login,
 * from the settled per-node account-health read. It covers every case #4462
 * Task 7 listed: pending (a loading row), an `ok` node with node-targeted login
 * (enabled), an offline, unreachable or unsupported node (preselected with its
 * disabled reason), and an id the read does not carry (the default selection
 * plus a line naming the unknown id) — so the inline explanation that used to
 * render here is gone.
 *
 * Once acted on, the parameters are removed with a history replace (the open
 * modal lives in component state), so a repeated request for the same node opens
 * it again.
 */
export function ReloginDeepLink({
  api,
  localNode,
  localNodeSettled,
}: {
  api: ApiClient | null;
  localNode: { nodeId: string; nodeLabel: string } | null;
  localNodeSettled: boolean;
}) {
  const search = useSearch({ strict: false }) as ReloginSearch;
  const navigate = useNavigate();
  const refreshUsage = useRefreshAccountUsage(api);
  const [target, setTarget] = useState<{
    nodeId: string;
    isUiHost: boolean;
  } | null>(null);

  const requestedNode =
    search.relogin === "anthropic" ? search.node : undefined;
  useEffect(() => {
    if (!requestedNode || !localNodeSettled) return;
    setTarget({
      nodeId: requestedNode,
      isUiHost:
        requestedNode === LOCAL_NODE_ID || requestedNode === localNode?.nodeId,
    });
    void navigate({
      to: "/settings/account-usage",
      search: {},
      replace: true,
    });
  }, [requestedNode, localNodeSettled, localNode, navigate]);

  if (!target) return null;
  return (
    <AddToProviderModal
      isOpen
      onClose={() => setTarget(null)}
      api={api}
      provider="anthropic"
      initialNodeId={target.isUiHost ? undefined : target.nodeId}
      onAdded={() => {
        void refreshUsage();
      }}
    />
  );
}
