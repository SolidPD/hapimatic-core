// SPDX-License-Identifier: AGPL-3.0-only
import { hostname } from "node:os";
import {
  displayNodeLabel,
  isCloudNodeUrl,
  LOCAL_NODE_ID,
  LOCAL_NODE_LABEL,
  type FederationConfig,
} from "@hapi/protocol";

/**
 * Node-label casing for THIS node (epic #3285 round 11, 2026-09-07):
 * local machines UPPER CASE, cloud VMs lower case — `displayNodeLabel` with the
 * server-side knowledge of whether the host is a cloud VM.
 *
 * A federated cloud VM is recognizable by its `selfUrl` (provision.sh seeds
 * `https://<subdomain>.hapimatic.com`). A STANDALONE cloud VM (federation
 * disabled — every freshly-provisioned customer VM) has no URL to classify by,
 * but every gateway-managed VM runs with `HAPI_GOOGLE_HANDOFF_AUD` in its
 * service env (provision.sh Phase 7; read by `configuration.ts` as
 * `handoffAudience`), and no local machine does — so its presence is the
 * cloud signal for the standalone case.
 */
export function isCloudHostEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.HAPI_GOOGLE_HANDOFF_AUD?.trim());
}

export function localNodeDisplayLabel(
  label: string,
  selfUrl?: string | null,
  env: NodeJS.ProcessEnv = process.env
): string {
  return displayNodeLabel(label, {
    cloud: isCloudNodeUrl(selfUrl) || isCloudHostEnv(env),
  });
}

/**
 * THIS node's identity as every surface reports it (issue #4461): the federation
 * config's id and label when federation is configured, otherwise the `LOCAL_NODE_ID`
 * sentinel and the cased hostname. One copy, shared by `GET /federation/nodes`
 * (`localNode`), the account-health aggregate's local row, the
 * `account_unrefreshable` 409 stamp and the `GET /api/events` egress stamp, so the
 * web always compares like with like.
 */
export function resolveLocalNodeIdentity(config: FederationConfig | null): {
  nodeId: string;
  nodeLabel: string;
} {
  return {
    nodeId: config?.nodeId ?? LOCAL_NODE_ID,
    // `||` not `??` — os.hostname() returns "" (not null) when the host name is
    // unavailable, and `??` would let that empty string through (federation.md
    // "#2395 carve-outs"). The hostname fallback follows the casing rule above.
    nodeLabel:
      config?.nodeLabel ??
      localNodeDisplayLabel(hostname() || LOCAL_NODE_LABEL),
  };
}

/**
 * Add a node's identity to an `account-unrefreshable` SSE event that carries none
 * (issue #4461, R7). Every other event, and an event already stamped (a peer's
 * event the hub's bridge stamped with the peer's node), is returned unchanged —
 * the same object — so the egress stamp in `GET /api/events` only fills in this
 * node's own events and the browser never has to guess which node refused.
 */
export function stampAccountUnrefreshable<T extends { type: string }>(
  event: T,
  node: { nodeId: string; nodeLabel: string }
): T {
  if (event.type !== "account-unrefreshable") return event;
  if ((event as { nodeId?: unknown }).nodeId) return event;
  return { ...event, nodeId: node.nodeId, nodeLabel: node.nodeLabel };
}
