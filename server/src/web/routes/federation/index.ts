// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import type { WebAppEnv } from "../../middleware/auth";
import type { FederationDeps } from "./shared";
import { createInfrastructureRoutes } from "./infrastructure";
import { createSessionMutationRoutes } from "./sessionMutations";
import { createSessionLifecycleRoutes } from "./sessionLifecycle";
import { createSessionDataRoutes } from "./sessionData";
import { createPeerDiscoveryRoutes } from "./peerDiscovery";
import { createFederationEventRoutes } from "./events";
import { createFederationClaimSyncRoutes } from "./claimSync";
import { createOutputStyleSyncRoutes } from "./outputStyleSync";
import { createSettingsSyncReceiverRoutes } from "./settingsSync";
import { createWebClientRoutes } from "./webClient";
import { createQueueMutationRoutes } from "./queueMutations";
import { createFederationAccountRoutes } from "./accounts";
import { createFederationCapacityRoutes } from "./capacity";
import { createFederationUsageRoutes } from "./usage";
import { createFederationAccountLeaseRoutes } from "./accountLease";
import { createChainFingerprintRoutes } from "./chainFingerprint";
import { createSystemJobsReceiverRoutes } from "./systemJobs";
import { createFederationHealthRoutes } from "./health";
import { createFederationTelemetryRoutes } from "./telemetry";
import { createFederationTurnFeedRoutes } from "./turnFeed";
import { createFederationSpawnRosterRoutes } from "./spawnRoster";
import { createFederationCapabilitiesRoutes } from "./capabilities";

export type { FederationDeps } from "./shared";

export function createFederationRoutes(deps: FederationDeps): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  app.route("/", createInfrastructureRoutes(deps));
  app.route("/", createSessionMutationRoutes(deps));
  app.route("/", createSessionLifecycleRoutes(deps));
  app.route("/", createSessionDataRoutes(deps));
  app.route("/", createPeerDiscoveryRoutes(deps));
  app.route("/", createFederationEventRoutes(deps));
  // Issue #1969 (File Conflict Monitor Sub D): federation-wide claim sync
  // anti-entropy backstop — GET /federation/claims serves this node's snapshot.
  app.route("/", createFederationClaimSyncRoutes(deps));
  // Issue #2627 (Sub-Issue E): custom output-style cross-node distribution —
  // POST /federation/output-style-sync receiver + GET /federation/output-style-digest
  // reconcile backstop (both fed-token authed, node-global).
  app.route("/", createOutputStyleSyncRoutes(deps));
  // Issue #2624 (Sub-Issue B): federation-global settings — POST /federation/settings-sync
  // receiver + GET /federation/settings-digest reconcile backstop (both fed-token
  // authed, node-global).
  app.route("/", createSettingsSyncReceiverRoutes(deps));
  app.route("/", createWebClientRoutes(deps));
  // Issue #1325: server-backed message queue federation receivers.
  app.route("/", createQueueMutationRoutes(deps));
  // Issue #1452 (Sub-Issue F): node-to-node active-account receivers.
  app.route("/", createFederationAccountRoutes(deps));
  // Issue #1805 (R11): node-to-node set-max-concurrency receiver.
  app.route("/", createFederationCapacityRoutes(deps));
  // Epic #1855 (Sub-Issue C #1858): federation usage aggregator (JWT GET) +
  // peer-incoming usage receiver (fed-token POST).
  app.route("/", createFederationUsageRoutes(deps));
  // Issue #1644: node-to-node rotation-lease receivers (hub-authoritative).
  app.route("/", createFederationAccountLeaseRoutes(deps));
  // Issue #3784: cross-node chain-fingerprint probe (per-node receiver +
  // aggregator) — proves refresh-token chain independence before a mixed-bound
  // idle rotation.
  app.route("/", createChainFingerprintRoutes(deps));
  // Issue #1536: system-jobs peer receivers (per-node list + mutate).
  app.route("/", createSystemJobsReceiverRoutes(deps));
  // Issue #1445: federation-aware per-node health metrics + alerts (JWT) and
  // the peer-facing /federation/node-metrics endpoint lives in infrastructure.
  app.route("/", createFederationHealthRoutes(deps));
  // Issue #1674 (Sub L): federation turn/session aggregate read path —
  // hub aggregator (JWT GET) + peer-incoming receiver (fed-token POST).
  app.route("/", createFederationTelemetryRoutes(deps));
  // Issue #4614: turn-ledger mirror feed (fed-token receivers) + status (JWT).
  app.route("/", createFederationTurnFeedRoutes(deps));
  // Issue #1936 (producer for rp1-home#1054): PM spawn-roster federation read path —
  // hub aggregator (JWT GET) + peer-incoming query receiver (fed-token POST).
  app.route("/", createFederationSpawnRosterRoutes(deps));
  // Issue #3743 (Sub-Issue C): peer-incoming live capability catalog —
  // GET /federation/capabilities/catalog (fed-token authed, serves the owning
  // binary's catalog for the hub's ?nodeId= proxy).
  app.route("/", createFederationCapabilitiesRoutes(deps));
  return app;
}
