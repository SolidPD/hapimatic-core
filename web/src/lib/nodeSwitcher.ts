// SPDX-License-Identifier: AGPL-3.0-only
import { normalizeNodeWebUrl } from "@hapi/protocol";
import type { FederationNodeStatus } from "@hapi/protocol";
import type { FederationNodeState, FederationNodesResponse } from "@/types/api";

/**
 * Node switcher rows (issue #6123): the title-bar chip's menu of every node,
 * built from `GET /api/federation/nodes` — the read the chip already makes.
 * That read names the UI host in `localNode` and lists only the OTHER nodes in
 * `nodes[]`, so the host is prepended here and marked current.
 */

/** A node status word's text colour — the Node Health modal's status and the
 *  switcher rows read this one map. */
export const NODE_STATUS_TEXT_CLASS: Record<FederationNodeStatus, string> = {
  online: "text-[var(--app-badge-success-text)]",
  degraded: "text-[var(--app-badge-warning-text)]",
  offline: "text-[var(--app-badge-error-text)]",
};

/** One menu row. `href` is null for the current node and for any node the
 *  menu must not offer (offline, or with no valid web address). */
export type NodeSwitchRow = {
  nodeId: string;
  nodeLabel: string;
  /** The stored federation url, for `NodeBadge` label casing only. */
  nodeUrl?: string;
  status: FederationNodeStatus;
  current: boolean;
  href: string | null;
  /** The destination host shown on the row (null when there is no href). */
  host: string | null;
};

/**
 * The address the UI opens for a node, the same rule everywhere (R10): the
 * node's own advertised `info.webUrl` when it is a valid web address, else its
 * stored federation `config.url`, else null. Peer info is cast, never parsed,
 * so both values go through `normalizeNodeWebUrl`.
 */
export function resolveNodeHref(state: FederationNodeState): string | null {
  return (
    normalizeNodeWebUrl(state.info?.webUrl) ??
    normalizeNodeWebUrl(state.config.url)
  );
}

function hostOf(href: string | null): string | null {
  if (!href) return null;
  try {
    return new URL(href).host;
  } catch {
    return null;
  }
}

/**
 * The menu rows: the UI host first (current), then every other node sorted by
 * label in plain code-unit order (locale-free, so every client agrees; upper-case
 * local labels sort before lower-case cloud ones), each without an href when it
 * is offline. Empty without a `localNode`.
 */
export function buildNodeSwitchRows(
  data: FederationNodesResponse | undefined
): NodeSwitchRow[] {
  const localNode = data?.localNode;
  if (!localNode) return [];
  const rows: NodeSwitchRow[] = [
    {
      nodeId: localNode.nodeId,
      nodeLabel: localNode.nodeLabel,
      status: "online",
      current: true,
      href: null,
      host: null,
    },
  ];
  const peers = (data.nodes ?? [])
    // Defense in depth: the registry already drops the entry whose id is this
    // node's config id (the same id as localNode.nodeId), so the host is never
    // listed twice; a self entry under a different id would still be listed.
    .filter(state => state.config.id !== localNode.nodeId)
    .sort((a, b) =>
      a.config.label < b.config.label
        ? -1
        : a.config.label > b.config.label
          ? 1
          : 0
    );
  for (const state of peers) {
    const href = state.status === "offline" ? null : resolveNodeHref(state);
    rows.push({
      nodeId: state.config.id,
      nodeLabel: state.config.label,
      nodeUrl: state.config.url,
      status: state.status,
      current: false,
      href,
      host: hostOf(href),
    });
  }
  return rows;
}

/** True when the nodes read lists at least one node besides the UI host,
 *  including offline or address-less ones (D4 = A: otherwise the chip keeps
 *  today's tap-to-Node-Health behavior). */
export function hasOtherNodes(rows: readonly NodeSwitchRow[]): boolean {
  return rows.length > 1;
}
