// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { LOCAL_NODE_ID } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { AddAccountWizard } from "@/components/AddAccountWizard";
import { BareButton } from "@/components/ui/BareButton";
import { useAccountHealth } from "@/hooks/queries/useAccountHealth";
import { useRefreshAccountUsage } from "@/hooks/queries/useAccountUsage";
import { queryKeys } from "@/lib/query-keys";
import type { ReloginSearch } from "@/lib/reloginLink";

/**
 * The re-login deep link (issue #4461, R9; D-A1 = A; made node-aware by #4462,
 * D-B1 = A). `?relogin=anthropic&node=<id>` opens the Anthropic add flow for
 * that node, storing the login THERE, or says by name why it cannot.
 *
 * "UI host" is `LOCAL_NODE_ID` or the `localNode.nodeId` that
 * `GET /api/federation/nodes` reports. While that read is pending nothing renders
 * (a hub's own id would otherwise read as another node). The UI host's flow opens
 * at once, without waiting for the health read: that read fans out to every peer
 * and the commonest re-login is on the node whose UI is open.
 *
 * Any other node is looked up in the per-node account-health read (#4461):
 * pending → nothing; `ok` with `loginSupported.anthropic` → the wizard targeting
 * that node ("Stored on <node>"); offline or unreachable → "log in there when it
 * is back"; any other node → it needs the current release; a node missing from
 * the read → "Unknown node"; a failed read → "Could not check" with a retry, so
 * the page never stays blank.
 *
 * Once acted on, the parameters are removed with a history replace (the open
 * flow or the explanation lives in component state), so a repeated request for
 * the same node opens it again.
 */
export function ReloginDeepLink({
  api,
  localNode,
  localNodeSettled,
  resolveNodeLabel,
}: {
  api: ApiClient | null;
  localNode: { nodeId: string; nodeLabel: string } | null;
  localNodeSettled: boolean;
  resolveNodeLabel: (nodeId: string) => string;
}) {
  const search = useSearch({ strict: false }) as ReloginSearch;
  const navigate = useNavigate();
  const refreshUsage = useRefreshAccountUsage(api);
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<{
    nodeId: string;
    nodeLabel: string;
    isUiHost: boolean;
  } | null>(null);
  const health = useAccountHealth(api, Boolean(target && !target.isUiHost));

  const requestedNode =
    search.relogin === "anthropic" ? search.node : undefined;
  useEffect(() => {
    if (!requestedNode || !localNodeSettled) return;
    setTarget({
      nodeId: requestedNode,
      nodeLabel: resolveNodeLabel(requestedNode),
      isUiHost:
        requestedNode === LOCAL_NODE_ID || requestedNode === localNode?.nodeId,
    });
    void navigate({
      to: "/settings/account-usage",
      search: {},
      replace: true,
    });
  }, [requestedNode, localNodeSettled, localNode, resolveNodeLabel, navigate]);

  if (!target) return null;
  const close = () => setTarget(null);
  const onAdded = () => {
    void refreshUsage();
    void queryClient.invalidateQueries({ queryKey: queryKeys.accountHealth });
  };
  if (target.isUiHost) {
    return (
      <AddAccountWizard isOpen onClose={close} api={api} onAdded={onAdded} />
    );
  }

  const entry = health.nodes.find(n => n.nodeId === target.nodeId);
  if (!entry) {
    if (health.error && !health.hasData) {
      return (
        <ReloginNotice onDismiss={close} onRetry={health.refetch}>
          {`Could not check ${target.nodeId}`}
        </ReloginNotice>
      );
    }
    if (!health.hasData) return null;
    return (
      <ReloginNotice
        onDismiss={close}
      >{`Unknown node: ${target.nodeId}`}</ReloginNotice>
    );
  }
  const label = entry.nodeLabel || target.nodeLabel;
  if (entry.status === "ok" && entry.loginSupported?.anthropic === true) {
    return (
      <AddAccountWizard
        isOpen
        onClose={close}
        api={api}
        onAdded={onAdded}
        nodeId={entry.nodeId}
        nodeLabel={label}
      />
    );
  }
  if (entry.status === "offline" || entry.status === "unreachable") {
    return (
      <ReloginNotice onDismiss={close}>
        {`${label} is offline — log in there when it is back`}
      </ReloginNotice>
    );
  }
  return (
    <ReloginNotice onDismiss={close}>
      {`${label} runs a Hapimatic build without node-targeted login; deploy the current release to it`}
    </ReloginNotice>
  );
}

/** #4462: the inline explanation the re-login deep link shows instead of the wizard. */
function ReloginNotice({
  children,
  onDismiss,
  onRetry,
}: {
  children: string;
  onDismiss: () => void;
  onRetry?: () => void;
}) {
  return (
    <div
      className="mb-3 flex items-start gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 text-[length:var(--text-body)] text-[var(--toast-warning)]"
      role="alert"
      data-testid="relogin-other-node"
    >
      <span className="min-w-0 flex-1">{children}</span>
      {onRetry ? (
        <BareButton
          type="button"
          onClick={onRetry}
          className="shrink-0 text-[var(--app-link)] underline"
        >
          Retry
        </BareButton>
      ) : null}
      <BareButton
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 text-[var(--app-hint)]"
      >
        ×
      </BareButton>
    </div>
  );
}
