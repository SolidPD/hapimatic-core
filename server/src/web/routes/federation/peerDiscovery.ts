// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import type { WebAppEnv } from "../../middleware/auth";
import { cataloged } from "../../../capabilities/cataloged";
import type { FederationDeps } from "./shared";
import { checkFederationToken, startTime } from "./shared";
import { defineCapability, PeerAnnouncementSchema } from "@hapi/protocol";
import { isValidPeerUrl } from "../../../utils/urlValidator";
import { VERSION } from "../../../version.generated";
import { detectCapabilities } from "../../../federation/capabilityDetector";

export function createPeerDiscoveryRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // ─── Peer discovery endpoint: POST /federation/announce ─────────
  // Receives an announcement from another peer, stores it, and returns
  // the full known peer list for peer exchange.
  app.post(
    "/federation/announce",
    cataloged(
      defineCapability({
        id: "federation.peer-announce",
        domain: "federation",
        surface: "rest",
        description:
          "Receive another peer's mesh announcement, record it, and return the known-peer list plus eviction tombstones for peer exchange.",
        whenToUse:
          "When a peer node advertises itself to join or refresh its place in the federation mesh.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/announce",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        telemetry: "off",
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const announcer = deps.getPeerAnnouncer();
      if (!announcer) {
        return c.json({ error: "Peer discovery not enabled" }, 404);
      }

      const body = await c.req.json().catch(() => null);
      const parsed = PeerAnnouncementSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid announcement payload" }, 400);
      }

      const urlCheck = isValidPeerUrl(parsed.data.selfUrl);
      if (!urlCheck.valid) {
        console.warn(
          `[Federation] Rejected peer announcement from ${parsed.data.selfId}: ${urlCheck.reason}`
        );
        return c.json({ error: `Invalid selfUrl: ${urlCheck.reason}` }, 400);
      }

      const peers = announcer.handleIncomingAnnouncement(parsed.data);

      // #3457 (Fix 2): tell the hub's NodeRegistry that this peer just announced,
      // so a backed-off/offline node — static config nodes included — is re-polled
      // immediately instead of waiting out its poll backoff (up to the 5-min cap).
      // Fire-and-forget: `notePeerAnnouncement` is synchronous and starts an
      // un-awaited poll, so it never blocks the announce response. `getNodeRegistry`
      // is a required FederationDeps member; the `?.` guards the nullable registry
      // (federation disabled / test stubs).
      deps.getNodeRegistry()?.notePeerAnnouncement(parsed.data.selfId);

      return c.json({
        peers: peers.map(p => ({
          id: p.id,
          url: p.url,
          label: p.label,
          capabilities: p.capabilities,
          lastSeen: p.lastSeen,
        })),
        // #2531: propagate death certificates so an explicit eviction removes a
        // dead node mesh-wide within ~1-2 announce cycles. Optional on the wire
        // (schema `.default([])`) — a pre-fix peer omits it and still validates.
        tombstones: announcer.getTombstones(),
      });
    }
  );

  // ─── Peer discovery endpoint: GET /federation/health ───────────
  // Returns peer identity, status, and known peer count.
  app.get(
    "/federation/health",
    cataloged(
      defineCapability({
        id: "federation.peer-health",
        domain: "federation",
        surface: "rest",
        description:
          "Return this node's federation identity, role, version, online-or-degraded status, known-peer count, and uptime.",
        whenToUse:
          "When the hub polls a peer node's liveness and health for the federation status view.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/health",
        },
        auth: "federation-token",
        riskTier: "readonly",
        availability: { scope: "operator" },
        telemetry: "off",
      })
    ),
    c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const config = deps.federationConfig;
      if (!config) {
        return c.json({ error: "Federation not enabled" }, 503);
      }

      const engine = deps.getSyncEngine();
      const degraded = !engine || engine.getOnlineMachines().length === 0;

      return c.json({
        selfId: config.nodeId,
        selfLabel: config.nodeLabel,
        version: VERSION,
        role: config.role,
        status: degraded ? "degraded" : "ok",
        knownPeerCount: deps.getPeerAnnouncer()
          ? deps.getPeerAnnouncer()!.getPeerCount()
          : 0,
        uptime: Date.now() - startTime,
      });
    }
  );

  // ─── Peer discovery endpoint: GET /federation/peers ────────────
  // Returns the list of known peers (for debugging and UI display).
  app.get(
    "/federation/peers",
    cataloged(
      defineCapability({
        id: "federation.peer-list",
        domain: "federation",
        surface: "rest",
        description:
          "Return this node's list of known federation peers, for debugging and UI display of the mesh.",
        whenToUse:
          "When inspecting which peers a given node currently knows about.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/peers",
        },
        auth: "federation-token",
        riskTier: "readonly",
        availability: { scope: "operator" },
      })
    ),
    c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const announcer = deps.getPeerAnnouncer();
      if (!announcer) {
        return c.json({ peers: [] });
      }

      return c.json({ peers: announcer.getKnownPeers() });
    }
  );

  return app;
}
