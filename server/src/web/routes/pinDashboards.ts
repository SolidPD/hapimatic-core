// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import {
  defineCapability,
  PinDashboardsNodeResultSchema,
  type PinDashboardNodeStatus,
  type PinDashboardsNodeResult,
  type PinDashboardsResponse,
} from "@hapi/protocol";

import { cataloged } from "../../capabilities/cataloged";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { ErrorLogger } from "../../logging/errorLogger";
import {
  engineDashboardDeps,
  listLocalDashboards,
  localSessionResolver,
  mergeDashboards,
} from "../../sync/pinDashboards";
import type { SyncEngine } from "../../sync/syncEngine";
import type { WebAppEnv } from "../middleware/auth";
import { pinsGate } from "../middleware/pinsGate";
import { withPinErrors } from "./pinRouteHelpers";

/**
 * `GET /api/pins/dashboards` (issue #6454, epic #6446): every Project Manager
 * dashboard in the caller's namespace, across the federation, with the server's
 * facts for each session its lanes name.
 *
 * ## 🔴 Auth comes from the MOUNT POSITION
 *
 * Mounted below the global JWT gate in `buildWebApp.ts`, beside the pin routes,
 * so `namespace` is the caller's. The Pins gate is a route argument after
 * `cataloged(...)`, so a closed instance answers 404 and omits the route.
 *
 * ## Federation
 *
 * With a `NodeRegistry`, every reachable peer's receiver is asked in parallel
 * (`/api/federation/pins/dashboards`, the caller's namespace forwarded). A peer
 * without the route (an older binary, or its Pins gate closed) is `unsupported`,
 * a normal rollout state; any other failure, or a body that does not parse, is
 * `failed` and makes the answer `partial`. A peer's dashboards and facts carry
 * the hub's id and label for that node, which is what the web's node badge and
 * same-node check key on.
 *
 * A lane session on a third node is filled from the hub's polled view of its
 * peers (`getAllRemoteSessions`), the same bulk-read tier
 * `GET /api/federation/all-sessions` serves to any JWT caller (server/CLAUDE.md
 * "Bulk-read paths are intentionally permissive").
 */
export type PinDashboardsRoutesOptions = {
  pinsEnabled: boolean;
  getNodeRegistry?: () => NodeRegistry | null;
  localNode: () => { nodeId: string; nodeLabel: string };
  errorLogger?: ErrorLogger | null;
};

function stampNode(
  result: PinDashboardsNodeResult,
  node: { nodeId: string; nodeLabel: string }
): PinDashboardsNodeResult {
  return {
    dashboards: result.dashboards.map(dashboard => ({
      ...dashboard,
      nodeId: node.nodeId,
      nodeLabel: node.nodeLabel,
    })),
    sessions: Object.fromEntries(
      Object.entries(result.sessions).map(([id, facts]) => [
        id,
        { ...facts, nodeId: node.nodeId, nodeLabel: node.nodeLabel },
      ])
    ),
  };
}

export function createPinDashboardsRoutes(
  getSyncEngine: () => SyncEngine | null,
  options: PinDashboardsRoutesOptions
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const gate = pinsGate(options.pinsEnabled);
  const errorLogger = options.errorLogger ?? null;

  app.get(
    "/pins/dashboards",
    cataloged(
      defineCapability({
        id: "session-introspection.list-pin-dashboards",
        domain: "session-introspection",
        surface: "rest",
        description:
          "List every Project Manager dashboard pin in the caller's namespace across federated nodes, with each lane session's name, model, account, node, status, open pins, stage, and cost.",
        whenToUse:
          "When rendering the Project Managers section of the Pins tab.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/pins/dashboards",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    gate,
    c =>
      withPinErrors(c, errorLogger, "pin-dashboards", async () => {
        const engine = getSyncEngine();
        if (!engine) {
          return c.json({ error: "Not connected" }, 503);
        }
        const namespace = c.get("namespace");
        const localNode = options.localNode();
        const deps = engineDashboardDeps(engine, localNode);
        const results: PinDashboardsNodeResult[] = [
          listLocalDashboards(deps, namespace),
        ];
        const nodes: PinDashboardNodeStatus[] = [];
        let partial = false;

        const registry = options.getNodeRegistry?.() ?? null;
        const peers = registry ? registry.getNodeSummaries() : [];
        const reachable = peers.filter(node => node.status !== "offline");
        for (const node of peers) {
          if (node.status === "offline") {
            nodes.push({
              nodeId: node.nodeId,
              nodeLabel: node.nodeLabel,
              status: "offline",
            });
          }
        }
        const settled = registry
          ? await Promise.allSettled(
              reachable.map(node =>
                registry.listPinDashboardsOnNode(node.nodeId, namespace)
              )
            )
          : [];
        settled.forEach((outcome, index) => {
          const node = reachable[index];
          if (!node) return;
          const label = { nodeId: node.nodeId, nodeLabel: node.nodeLabel };
          if (outcome.status === "rejected") {
            partial = true;
            nodes.push({
              ...label,
              status: "failed",
              error:
                outcome.reason instanceof Error
                  ? outcome.reason.message
                  : "Request failed",
            });
            return;
          }
          const read = outcome.value;
          if (read.kind === "unsupported" || read.kind === "offline") {
            nodes.push({ ...label, status: read.kind });
            return;
          }
          if (read.kind === "unreachable") {
            partial = true;
            nodes.push({ ...label, status: "failed", error: read.message });
            return;
          }
          const parsed = PinDashboardsNodeResultSchema.safeParse(read.body);
          if (!parsed.success) {
            partial = true;
            nodes.push({
              ...label,
              status: "failed",
              error: "The node's dashboards did not parse",
            });
            return;
          }
          results.push(stampNode(parsed.data, label));
          nodes.push({ ...label, status: "answered" });
        });

        const merged = mergeDashboards({
          results,
          local: localSessionResolver(deps, namespace),
          // Copied only when some ref is still unresolved.
          remoteSessions:
            registry &&
            results.some(result =>
              result.dashboards.some(d => d.unresolved.length > 0)
            )
              ? registry.getAllRemoteSessions()
              : [],
          partial,
        });
        const body: PinDashboardsResponse = { ...merged, nodes, partial };
        return c.json(body);
      })
  );

  return app;
}
