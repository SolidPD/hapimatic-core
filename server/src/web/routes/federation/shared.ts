// SPDX-License-Identifier: AGPL-3.0-only
import type { FederationConfig } from "@hapi/protocol";
import type { SyncEngine } from "../../../sync/syncEngine";
import type { SSEManager } from "../../../sse/sseManager";
import type { NodeRegistry } from "../../../federation/nodeRegistry";
import type { HealthAggregator } from "../../../federation/healthAggregator";
import type { PeerAnnouncer } from "../../../federation/peerAnnouncer";
import type { ErrorLogger } from "../../../logging/errorLogger";
import type { AccountService } from "../../../services/accountService";
import type { UsageService } from "../../../accounts/usageService";
import type { ProviderUsageService } from "../../../accounts/providerUsageService";
import type { ProviderAuthFacts } from "../../../services/providerAuthState";
import type { CodexLoginService } from "../../../services/codexLoginService";
import type { LeaseStore } from "../../../store/leaseStore";
import type { SystemJobsService } from "../../../systemJobs/service";
import type { OutputStyleSyncService } from "../../../services/outputStyleSyncService";
import type { SettingsSyncService } from "../../../services/settingsSyncService";
import type { LiveCatalog } from "../../../capabilities/catalogCollector";
import type { ServerAuditResult } from "../../../capabilities/auditCollector";
import type { AvailabilityContext } from "@hapi/protocol";
import type {
  Caller,
  SessionLike,
} from "../../../capabilities/availabilityContext";
import { constantTimeEquals } from "../../../utils/crypto";

export type FederationDeps = {
  getSyncEngine: () => SyncEngine | null;
  getSseManager: () => SSEManager | null;
  getNodeRegistry: () => NodeRegistry | null;
  getHealthAggregator: () => HealthAggregator | null;
  getPeerAnnouncer: () => PeerAnnouncer | null;
  getAccountService: () => AccountService | null;
  // Issue #1644: the hub's authoritative rotation-lease ledger. Optional because
  // only the real server.ts construction wires it; federation test stubs omit it.
  getLeaseStore?: () => LeaseStore | null;
  // Issue #1536: per-node system-jobs engine (list + mutate). Optional because
  // only the real server.ts construction wires it; federation test stubs omit it.
  getSystemJobsService?: () => SystemJobsService | null;
  // Epic #1855, Sub-Issue C (#1858): local per-account usage source for the
  // /federation/accounts/usage aggregator + peer receiver. Optional because
  // federation test stubs omit it (mirrors getLeaseStore / getSystemJobsService).
  getUsageService?: () => UsageService | null;
  // Issue #3809 (epic #3345, D5 = C): the LOCAL-node non-Anthropic provider usage
  // source for the /federation/accounts/usage aggregator (local providerUsage[])
  // + peer receiver. Optional (federation test stubs omit it, mirrors
  // getUsageService).
  getProviderUsageService?: () => ProviderUsageService | null;
  // Issue #3806 (epic #3345): the LOCAL-node provider auth-state reader (Codex +
  // Gemini derived state) for the /federation/provider-auth-state GET aggregator
  // + POST receiver. Optional because federation test stubs omit it (mirrors
  // getUsageService). [ER 2026-09-19: 3806-5]
  getProviderAuthState?: () => Promise<ProviderAuthFacts>;
  // Issue #3807 (epic #3345, K9 chain): the LOCAL-node Codex login driver, for
  // the peer-incoming /federation/openai-login/{start,status,cancel} receivers
  // so node-side codex auth executes on the OWNING node (R4). Optional because
  // federation test stubs omit it (mirrors getProviderAuthState). [ER 2026-09-19: 3807-4]
  getCodexLoginService?: () => CodexLoginService | null;
  // Issue #2627 (Sub-Issue E): the custom output-style store + federation
  // replicator, for the peer-incoming /federation/output-style-sync receiver +
  // /federation/output-style-digest reconcile endpoint. Optional because
  // federation test stubs omit it (mirrors getLeaseStore / getUsageService).
  getOutputStyleSyncService?: () => OutputStyleSyncService | null;
  // Issue #2624 (Sub-Issue B): the federation-global settings store + replicator,
  // for the peer-incoming /federation/settings-sync receiver + /federation/settings-digest
  // reconcile endpoint. Optional because federation test stubs omit it (mirrors
  // getOutputStyleSyncService).
  getSettingsSyncService?: () => SettingsSyncService | null;
  // Issue #3743 (Sub-Issue C): this node's live capability catalog, for the
  // peer-incoming /federation/capabilities/catalog receiver (serves the OWNING
  // binary's catalog). Optional because federation test stubs omit it (mirrors
  // getSettingsSyncService).
  getCapabilityCatalog?: () => LiveCatalog | null;
  // Issue #3744 (Sub-Issue D): this node's runtime self-audit result, for the
  // peer-incoming /federation/capabilities/audit receiver (serves the OWNING
  // binary's audit). Optional because federation test stubs omit it (mirrors
  // getCapabilityCatalog).
  getCapabilityAudit?: () => ServerAuditResult | null;
  // Issue #3749 (Sub-Issue I): builds a session's AvailabilityContext so the
  // peer-incoming /federation/capabilities/catalog receiver annotates + HARD-
  // FILTERS with the OWNING binary's context (never relays a raw catalog across
  // the wire). Optional because federation test stubs omit it (mirrors
  // getCapabilityCatalog).
  getAvailabilityContext?: (args: {
    session?: SessionLike;
    caller: Caller;
    nodeVersion?: string;
  }) => AvailabilityContext;
  federationConfig: FederationConfig | null;
  apiToken: string | null;
  jwtSecret: Uint8Array;
  errorLogger?: ErrorLogger | null;
};

export const startTime = Date.now();

export function checkFederationToken(
  deps: FederationDeps,
  authHeader: string | undefined
): boolean {
  // Fail-closed: a missing apiToken used to allow all requests (effectively
  // dev-mode). That's a latent auth bypass — a config typo that drops the
  // token silently opened every federation endpoint. With federation enabled,
  // a missing token is a fatal configuration error; reject all requests.
  if (!deps.apiToken) return false;
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice("Bearer ".length);
  return constantTimeEquals(token, deps.apiToken);
}

export async function notifyOriginatingHub(params: {
  originatingNodeId?: string;
  nodeId: string;
  directory: string;
  spawnCorrelationId?: string;
  success: boolean;
  error?: string;
  sessionId?: string;
  deps: FederationDeps;
}): Promise<void> {
  if (!params.originatingNodeId) return;

  const announcer = params.deps.getPeerAnnouncer?.();
  let hubUrl: string | undefined;

  if (announcer) {
    const peers = announcer.getKnownPeers();
    const hub = peers?.find(
      (p: { id: string }) => p.id === params.originatingNodeId
    );
    hubUrl = hub?.url;
  }

  if (!hubUrl && params.deps.federationConfig?.nodes) {
    const node = params.deps.federationConfig.nodes.find(
      n => n.id === params.originatingNodeId
    );
    hubUrl = node?.url;
  }

  if (!hubUrl) {
    console.warn(
      `[Federation] Cannot notify hub ${params.originatingNodeId}: URL not found`
    );
    return;
  }

  try {
    const body = {
      nodeId: params.nodeId,
      directory: params.directory,
      spawnCorrelationId: params.spawnCorrelationId,
      success: params.success,
      error: params.error,
      sessionId: params.sessionId,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (params.deps.apiToken) {
      headers["Authorization"] = `Bearer ${params.deps.apiToken}`;
    }

    await fetch(`${hubUrl}/api/federation/spawn-status`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn(
      `[Federation] Failed to notify hub ${params.originatingNodeId} about spawn status:`,
      err
    );
  }
}
