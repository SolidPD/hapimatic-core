// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";

import type { WebAppEnv } from "../middleware/auth";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { ErrorLogger } from "../../logging/errorLogger";
import type { AuditReport } from "../../capabilities/audit";
import type {
  ServerAuditResult,
  ServerAuditObservation,
} from "../../capabilities/auditCollector";

/**
 * Issue #3744 (Sub-Issue D / R5) — the runtime self-audit read route.
 *
 * `GET /api/capabilities/audit` (JWT — mounted AFTER the `/api/*` auth middleware in
 * `buildWebApp`, so mount POSITION is the auth) serves THIS node's audit report:
 * every drift between the committed Tier-0 index and the live runtime surface, by
 * domain and surface. `?format=summary` (default) returns the coverage counts +
 * drift TALLIES (compact, diffable); `?format=full` returns the whole report PLUS
 * the raw `observed` block the `hapi capabilities audit` verb needs to MERGE its
 * `mcp`+`cli` half and re-run the SAME engine (Task 7).
 *
 * The server observes ONLY `rest`+`rpc` (R1: `server/` cannot import `cli/`/`web/`),
 * so the body always declares `surfacesObserved: ["rest","rpc"]` and renders
 * `mcp`/`cli`/`ui` as `n/a`. A consumer needing four surfaces calls the CLI verb.
 *
 * FEDERATION (R5): `?nodeId=<remote>` proxies to the peer's federation receiver
 * (`GET /api/federation/capabilities/audit`) following the NODE-keyed precedent in
 * `about.ts:49-70` (`isRemoteNode` local short-circuit, `federation_not_enabled`
 * 503, `federation_proxy_error` 502) — NOT `routes/capabilities.ts` (session-keyed,
 * 404-on-miss). A mandatory `AbortSignal` timeout keeps a hung peer from hanging the
 * audit forever. A peer that 404s the receiver (an OLDER binary) yields the hub's
 * OWN report stamped `{ fallback: true, peerVersion }` — `peerVersion` read from the
 * registry's `FederationNodeInfo.version` (`null` when the peer was never polled),
 * never a second fetch and never `undefined`.
 */

/** Peer-proxy AbortSignal budget — a hung peer must not hang the audit (R5). */
const PEER_TIMEOUT_MS = 5000;

/** The full-format body: the report + the raw observation for the CLI merge. */
export interface AuditFullBody {
  report: AuditReport;
  observed: ServerAuditObservation;
}

/** The summary-format body: coverage + drift tallies (no full drift arrays). */
export interface AuditSummaryBody {
  surfacesObserved: AuditReport["surfacesObserved"];
  coverage: AuditReport["coverage"];
  rpcObserved: AuditReport["rpcObserved"];
  driftCounts: {
    forwardDrift: number;
    reverseDrift: number;
    schemaErrors: number;
    notMountedHere: number;
  };
  provenance: AuditReport["provenance"];
}

function summarize(report: AuditReport): AuditSummaryBody {
  return {
    surfacesObserved: report.surfacesObserved,
    coverage: report.coverage,
    rpcObserved: report.rpcObserved,
    driftCounts: {
      forwardDrift: report.forwardDrift.length,
      reverseDrift: report.reverseDrift.length,
      schemaErrors: report.schemaErrors.length,
      notMountedHere: report.notMountedHere.length,
    },
    provenance: report.provenance,
  };
}

/** Render a result per `?format`, tagging `nodeId` when this was a proxied read. */
function formatAudit(
  result: ServerAuditResult,
  format: "summary" | "full",
  nodeId: string | undefined
): (AuditSummaryBody | AuditFullBody) & { nodeId?: string } {
  const base: AuditSummaryBody | AuditFullBody =
    format === "full"
      ? { report: result.report, observed: result.observed }
      : summarize(result.report);
  return nodeId ? { nodeId, ...base } : base;
}

export function createCapabilityAuditRoutes(options: {
  getAudit: () => ServerAuditResult | null;
  getNodeRegistry?: () => NodeRegistry | null;
  getLocalNodeId?: () => string | null;
  federationApiToken?: string | null;
  errorLogger?: ErrorLogger | null;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // Non-federated instances (localNodeId === null) treat every request as local.
  const isRemoteNode = (nodeId: string): boolean => {
    const localNodeId = options.getLocalNodeId?.() ?? null;
    return localNodeId !== null && nodeId !== localNodeId;
  };

  app.get(
    "/capabilities/audit",
    cataloged(
      defineCapability({
        id: "mcp.capabilities-audit",
        domain: "mcp",
        surface: "rest",
        description:
          "Return the capability-coverage audit (forward/reverse/binding drift) for this node.",
        whenToUse:
          "When the coverage meter or an operator checks catalog completeness.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/capabilities/audit",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const format = c.req.query("format") === "full" ? "full" : "summary";
      const nodeId = c.req.query("nodeId") || undefined;

      if (nodeId && isRemoteNode(nodeId)) {
        const registry = options.getNodeRegistry?.() ?? null;
        if (!registry) {
          return c.json(
            {
              ok: false,
              error: "Federation not enabled",
              code: "federation_not_enabled",
            },
            503
          );
        }
        const node = registry.getNodeStates().find(s => s.config.id === nodeId);
        if (!node) {
          return c.json({ ok: false, error: "unknown_node", nodeId }, 404);
        }

        const headers: Record<string, string> = {};
        if (options.federationApiToken) {
          headers["Authorization"] = `Bearer ${options.federationApiToken}`;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PEER_TIMEOUT_MS);
        try {
          const resp = await fetch(
            `${node.config.url}/api/federation/capabilities/audit`,
            { headers, signal: controller.signal }
          );
          if (resp.ok) {
            const peer = (await resp.json()) as ServerAuditResult;
            return c.json(formatAudit(peer, format, nodeId));
          }
          if (resp.status === 404) {
            // Older peer with no receiver → the hub's own report, stamped.
            const local = options.getAudit();
            if (!local) {
              return c.json(
                { ok: false, error: "Not connected", code: "not_connected" },
                503
              );
            }
            const peerVersion = node.info?.version ?? null;
            return c.json({
              ...formatAudit(local, format, nodeId),
              fallback: true,
              peerVersion,
            });
          }
          return c.json(
            {
              ok: false,
              error: "peer_error",
              code: "federation_proxy_error",
              nodeId,
              status: resp.status,
            },
            502
          );
        } catch (err) {
          options.errorLogger?.error("capability-audit: peer proxy failed", {
            category: "capability-audit",
            context: {
              nodeId,
              error: err instanceof Error ? err.message : String(err),
            },
          });
          return c.json(
            {
              ok: false,
              error: "peer_unreachable",
              code: "federation_proxy_error",
              nodeId,
            },
            502
          );
        } finally {
          clearTimeout(timer);
        }
      }

      const local = options.getAudit();
      if (!local) {
        return c.json(
          { ok: false, error: "Not connected", code: "not_connected" },
          503
        );
      }
      return c.json(formatAudit(local, format, undefined));
    }
  );

  return app;
}
