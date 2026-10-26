// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- Grandfathered god-file (Epic 0, #2077); decomposition verdict tracked in claudedocs/architecture-hotspot-review.md. */
import type {
  AboutInfo,
  AccountUsage,
  FederationNodeConfig,
  FederationNodeInfo,
  FederationNodeState,
  FederationNodeStatus,
  FederationPollResult,
  FederationSpawnBody,
  ModelMode,
  NodeAccountHealth,
  NodeAccountHealthReason,
  NodePmSpawnRoster,
  NodeTurnAggregates,
  TurnFeedDigest,
  TurnFeedPage,
  PermissionMode,
  PmSpawnRosterRecord,
  PmSpawnRosterUpsert,
  SessionSummary,
  SessionView,
  StoredNotification,
  UiCollapseState,
} from "@hapi/protocol";
import type { SyncEvent } from "@hapi/protocol/types";
import type { GitBranchListing } from "@hapi/protocol/gitBranches";
import {
  ANTHROPIC_LOGIN_CAPABILITY,
  FederationApiKeyRefusalSchema,
  FederationApiKeyResolvedSchema,
  FederationApiKeySecretSchema,
  FederationSharedApiKeysSchema,
  SHARED_API_KEYS_CAPABILITY,
  type FederationApiKeyRequest,
  type FederationApiKeySpawnBody,
  type FederationApiKeyResolved,
  type FederationSharedApiKeys,
  parseNodeAccountHealthPerEntry,
  SupervisedLoop,
  displayNodeLabel,
  LIVE_SESSION_FRESHNESS_WINDOW_MS,
  projectBackgroundAgentsSummary,
} from "@hapi/protocol";
import type {
  AuthBinding,
  CeilingGuardConfigPatch,
  ClaudeAccountInfo,
  DaemonCapSource,
} from "@hapi/protocol/schemas";
import type { SSEManager } from "../sse/sseManager";
import type { PeerStore } from "../store/peerStore";
import type { CachedRemoteSessions, NodeRegistryOptions } from "./types";
import { createHomeUrlGuard } from "./secretTransport";
import type { FileClaimSync } from "./fileClaimSync";
import type { FileClaimSyncSnapshot } from "@hapi/protocol";
import type { RedactedAccount } from "../services/accountService";
// Issue #1537: type-only import (erased at build — no runtime coupling, does NOT
// pull the systemd reconciler into the federation module graph). The wrappers
// below proxy to #1536's already-shipped /api/federation/system-jobs/* receivers.
import type {
  ListJobsResult,
  MutateResult,
  SystemJobMutateBody,
  LoopCronMutateBody,
  LoopCronDispatchResult,
} from "../systemJobs/service";
// Issue #3807: type-only import (erased at build — no runtime coupling; the
// driver imports only node builtins, so no cycle). The wrappers below proxy to
// the /api/federation/openai-login/* receivers on the owning node.
import type {
  ApiKeyLoginResult,
  DeviceAuthResult,
  DeviceAuthStatusResult,
} from "../services/codexLoginService";
import { readPeerJsonObject } from "./proxyFetchSignal";

const FETCH_TIMEOUT_MS = 10_000;
/** #5127: fetch error codes (Bun and Node) that mean the peer is unreachable. */
const UNREACHABLE_CODES = new Set([
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
]);
/** Per-peer timeout for the notification fan-out (issue #4913): the badge polls. */
const NOTIFICATION_PROXY_TIMEOUT_MS = 3_000;

/** A failed notification proxy call; `status` is the peer's HTTP status, absent on a transport fault, timeout or offline node. */
export type NotificationProxyError = {
  type: "error";
  message: string;
  status?: number;
};

/**
 * Outcome of a proxied notification read / dismiss (issue #4913): the updated
 * row, `notFound` (the peer answered 404 — not in the caller's namespace
 * there), or an error for any other failure (offline, timeout, non-2xx).
 */
export type NotificationIdActionResult =
  | { notification: StoredNotification }
  | { notFound: true }
  | { type: "error"; message: string };

/**
 * #3815: failure of a per-session action proxied to a peer. `status` is the
 * peer's HTTP status (absent on a transport fault or timeout); `offline` marks
 * a node the registry already knows is down (no request was sent).
 */
export type RemoteSessionActionError = {
  type: "error";
  message: string;
  status?: number;
  offline?: true;
};

/**
 * #5739: one classified peer read, shared by `getAccountHealthOnNode` and
 * `getProviderAuthStateOnNode` so the two readers never classify the same peer
 * reply differently. `ok` carries the peer's parsed 2xx body as untrusted data
 * for the caller to validate. `message` on `unreachable` is for the hub's log
 * only and never carries the peer's response body: an HTTP failure is named by
 * its status, a throw by the runtime's error text.
 */
export type PeerReadOutcome =
  | { kind: "ok"; body: unknown }
  | { kind: "offline" }
  | { kind: "unsupported" }
  | {
      kind: "unreachable";
      reason: NodeAccountHealthReason;
      message: string;
    };

/**
 * #5487: read a non-OK peer reply's error body. An empty or unparseable body
 * reads as {}, so the caller keeps "Node returned <status>". A body cut off
 * mid-read is a transport failure: warn, then rethrow into the caller's catch,
 * which answers the same no-status result as an unreachable peer.
 */
async function readPeerErrorBody(
  res: Response,
  context: string
): Promise<Record<string, unknown>> {
  try {
    return await readPeerJsonObject(res);
  } catch (error) {
    console.warn(
      `[Federation] ${context}: peer reply cut off mid-body (HTTP ${res.status}):`,
      error instanceof Error ? error.message : error
    );
    throw error;
  }
}

/** Longer timeout for spawn/reconnect: daemon must spawn CLI + wait for Socket.IO. */
const SPAWN_TIMEOUT_MS = 30_000;

/**
 * #4462: how long the hub waits for a peer's Anthropic login `complete`. The peer
 * may need up to 25 s (token exchange 15 s + profile 10 s,
 * `anthropicOauthLoginClient.ts`), and a hub that gave up first would report a
 * failure for a login the peer then stored, after consuming the single-use token.
 * Below Bun's 50 s idle limit and the web client's 45 s wait.
 */
export const ANTHROPIC_LOGIN_COMPLETE_TIMEOUT_MS = 35_000;

/**
 * #4462: the outcome of one proxied Anthropic login call. `answer` carries the
 * peer's raw 2xx JSON — the hub route parses it with the whitelist schemas. The
 * error kinds let the route tell "nothing was sent" (`offline`) from "the peer
 * may have acted" (`timeout`, `transport`) and from a peer that answered non-2xx
 * (`http`).
 */
/**
 * #5127: the outcome of one shared-API-key call to a key's home node. Every
 * failure is a fixed shape with no peer response text: `unknown_node` (this
 * registry does not track that node), `offline`, `unsupported` (no
 * `api-keys:shared` capability, or an older binary answering 404), `transport`
 * (the home is reached at a non-tailnet URL), `refused` (the home's own refusal
 * code and message), or `error`.
 */
export type ApiKeyCallOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "unknown_node" }
  | { kind: "offline" }
  | { kind: "unsupported" }
  | { kind: "transport" }
  | { kind: "refused"; code: string; message: string }
  | { kind: "error"; message: string };

export type AnthropicLoginProxyResult =
  | { type: "answer"; body: unknown }
  | {
      type: "error";
      kind: "offline" | "timeout" | "transport" | "http";
      status?: number;
      message: string;
    };

/**
 * #4462: everything the hub's login routes gate on, read from ONE `nodeStates`
 * entry so identity, liveness and capability cannot disagree when a poll lands
 * between separate reads. `polled` is false until the first `/federation/info`.
 */
export type NodeLoginGate = {
  nodeId: string;
  nodeLabel: string;
  online: boolean;
  polled: boolean;
  supportsAnthropicLogin: boolean;
};
const OFFLINE_THRESHOLD = 3;

/** Maximum number of active peers in the mesh. New announcements are rejected at capacity. */
export const MAX_PEERS = 50;

/**
 * Number of consecutive poll failures before a dynamic peer is evicted.
 * ~27.5 minutes from the first failure under the shipped ladder (#3457): two
 * base ~15s intervals + the POLL_BACKOFF_DELAYS ladder (60+120+240+300s) + three
 * 5-min extended steps (300s each) to the 10th failure = 1650s. Dynamic peers
 * only — static nodes (from config) are never evicted regardless of failures.
 */
export const EVICTION_THRESHOLD = 10;

/** Backoff delays for SSE event bridge reconnection (ms): 1s → 30s cap */
const EVENT_BRIDGE_BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000];

/**
 * Inactivity ceiling for one event-bridge stream (ms). The remote
 * `/api/federation/events` route writes a `: heartbeat` comment every 30 s
 * (`web/routes/federation/events.ts`), so a connect or a read that makes no
 * progress for three heartbeat periods is a dead stream — a NAT / proxy idle
 * drop, a half-open TCP, or a fetch that is never answered. None of those
 * reject on their own (fetch has no read timeout), so without a watchdog the
 * bridge would sit "connected" while the hub's browsers see nothing for that
 * node's sessions. Overridable per registry via `eventBridgeIdleTimeoutMs`.
 */
export const EVENT_BRIDGE_IDLE_TIMEOUT_MS = 90_000;

/**
 * Upper bound on the hub-restart grace window (ms), measured from registry
 * construction (#5407). While a static peer has never polled successfully,
 * `isAwaitingInitialPoll()` holds the window open so the peer's sessions read
 * as unavailable rather than not found. A peer that refuses connections is
 * polled at about 0 s, 15 s and 30 s, then (offline) after 60 s and 120 s of
 * backoff — about 90 s and 210 s; a peer whose fetches hang adds up to
 * FETCH_TIMEOUT_MS per poll. A peer that comes back announces itself and
 * skips the backoff (`notePeerAnnouncement`), so it polls successfully within
 * seconds.
 * Three minutes covers a normal peer restart; past it a permanently dead peer
 * stops holding the window, and a genuinely unknown session id is held back
 * from a 404 at most this long.
 */
export const HUB_RESTART_GRACE_MS = 180_000;

/**
 * Backoff delays for poll failures (ms), indexed by (consecutiveFailures - OFFLINE_THRESHOLD).
 * Starts after a node crosses the offline threshold: 60s → 120s → 240s → 300s cap.
 */
export const POLL_BACKOFF_DELAYS = [60_000, 120_000, 240_000, 300_000];

/**
 * Extended backoff for sustained failures beyond POLL_BACKOFF_DELAYS.
 * Kicks in after POLL_BACKOFF_DELAYS is exhausted and holds at 5m (#3457): the
 * DELAYS ladder already climbs to a 300s cap, so the extended step just keeps it
 * there. A silently-recovered node (e.g. a Tailscale blip with no peer restart)
 * is re-detected within one 5-min step instead of up to half an hour, while a
 * genuinely dead node is still polled far less often than the ~15s base
 * interval. #3456's force-poll and an incoming peer announcement
 * (notePeerAnnouncement) bypass this backoff entirely.
 */
export const POLL_BACKOFF_EXTENDED = [300_000];

/**
 * Calculate the backoff delay for a node based on consecutive failures.
 * Returns 0 if the node hasn't crossed the offline threshold yet.
 * Uses POLL_BACKOFF_DELAYS for initial backoff, then POLL_BACKOFF_EXTENDED
 * for sustained failures (caps at 5 minutes).
 */
export function getPollBackoffDelay(consecutiveFailures: number): number {
  if (consecutiveFailures < OFFLINE_THRESHOLD) return 0;
  const index = consecutiveFailures - OFFLINE_THRESHOLD;
  if (index < POLL_BACKOFF_DELAYS.length) {
    return POLL_BACKOFF_DELAYS[index] ?? 300_000;
  }
  const extIndex = index - POLL_BACKOFF_DELAYS.length;
  return (
    POLL_BACKOFF_EXTENDED[
      Math.min(extIndex, POLL_BACKOFF_EXTENDED.length - 1)
    ] ?? 300_000
  );
}

/**
 * Check whether a session is "interesting" to a given node — i.e. the session
 * originated from that node, or has no originator (backward compat).
 * Mirrors the filter expression in getAllRemoteSessions().
 */
export function isSessionInteresting(
  session: { metadata?: Record<string, unknown> | null },
  ownNodeId: string
): boolean {
  const meta = session.metadata as Record<string, unknown> | null;
  const origin = meta?.originatingNodeId ?? meta?.originatingHubId;
  return !origin || origin === ownNodeId;
}

/**
 * Issue #2761 (Fix B): is a session's `activeAt` heartbeat still "fresh" (within
 * `LIVE_SESSION_FRESHNESS_WINDOW_MS` of `now`)? Mirrors the R4 conservatism of the
 * daemon guard `isSessionLiveForGuard` (`cli/src/daemon/sessionLiveness.ts`): a
 * missing/non-finite `activeAt` (a mixed-version peer that omits the field over the
 * `.passthrough()` federation wire) is treated as FRESH — "absence of evidence is
 * never evidence of death" — so the offline `active:false` projection never fires on
 * it. Only a finite, genuinely-stale `activeAt` returns false. Shares the window
 * constant with the guard so the two cannot drift (#2761 R4).
 */
function isActiveAtFresh(activeAt: number | undefined, now: number): boolean {
  if (!Number.isFinite(activeAt)) return true;
  return now - (activeAt as number) <= LIVE_SESSION_FRESHNESS_WINDOW_MS;
}

/**
 * Determine whether an SSE bridge event should be forwarded to local clients.
 *
 * - Non-session events (no sessionId) → always forward
 * - Session in interestingSessions Set → forward (O(1) fast path)
 * - Session NOT in Set → check sessionCache for definitive ownership:
 *   - Not in cache (cache miss / pre-poll) → forward (safe default)
 *   - In cache with different originatingNodeId → drop
 */
export function shouldForwardBridgeEvent(
  event: SyncEvent,
  interestingSessions: Set<string>,
  sessionCache: Map<string, { sessions: SessionSummary[] }>,
  ownNodeId: string
): boolean {
  // Non-session events: always forward
  const sessionId = "sessionId" in event ? event.sessionId : undefined;
  if (!sessionId) return true;

  // Fast path: session is known-interesting
  if (interestingSessions.has(sessionId)) return true;

  // Slow path: check cache for definitive ownership
  for (const cached of sessionCache.values()) {
    const session = cached.sessions.find(s => s.id === sessionId);
    if (session) {
      return isSessionInteresting(session, ownNodeId);
    }
  }

  // Cache miss: session not yet polled — forward to avoid dropping
  // real-time events for newly-spawned sessions
  return true;
}

/**
 * True when a 401 body is exactly the JWT middleware's `{"error":"Invalid token"}`
 * — a peer answering for a federation route it does not have (issue #4461; the
 * #4073 K13 rule). Any other 401 body is a real auth failure.
 */
function isInvalidTokenBody(text: string): boolean {
  try {
    const body = JSON.parse(text) as unknown;
    return (
      typeof body === "object" &&
      body !== null &&
      Object.keys(body).length === 1 &&
      (body as { error?: unknown }).error === "Invalid token"
    );
  } catch {
    return false;
  }
}

/**
 * NodeRegistry polls remote federation nodes and caches their session lists.
 * Runs on hub and peer roles (any node with `role !== "node"`).
 */
export class NodeRegistry {
  private readonly config: NodeRegistryOptions["config"];
  private readonly apiToken: string | null;
  private readonly getLocalSessionCount: () => number;
  private readonly peerStore: PeerStore | null;
  private readonly evictionThreshold: number;
  /** #1969: the federation claim-sync replica (peer claim registers). */
  private readonly fileClaimSync: FileClaimSync | null;

  private nodeStates = new Map<string, FederationNodeState>();
  private sessionCache = new Map<string, CachedRemoteSessions>();
  private readonly loop: SupervisedLoop;

  /** SSE event bridge: one persistent connection per remote node. */
  private eventBridgeSseManager: SSEManager | null = null;
  private eventBridgeAbortControllers = new Map<string, AbortController>();
  private eventBridgeReconnectAttempts = new Map<string, number>();
  /** Inactivity ceiling per bridge stream (see EVENT_BRIDGE_IDLE_TIMEOUT_MS). */
  private readonly eventBridgeIdleTimeoutMs: number;

  /** Per-node poll backoff: skip polling a node until this timestamp. */
  private pollBackoffUntil = new Map<string, number>();

  /**
   * #3457 (R4): last time an incoming peer announcement triggered an immediate
   * poll of a node, keyed by nodeId. Rate-limits announcement-driven polls to at
   * most one per `pollIntervalMs`, so a flapping peer that re-announces on every
   * failed poll cannot drive the hub into a poll storm.
   */
  private lastAnnouncementPoll = new Map<string, number>();

  /**
   * #3456: coalesce a periodic sweep and a forced sweep onto ONE in-flight poll
   * pass. Without this guard a `SupervisedLoop` tick that lands during a forced
   * sweep (or vice-versa) would run `pollNode` a second time per node — each
   * concurrent failure double-counts `consecutiveFailures` and re-sets backoff.
   */
  private sweepInFlight: Promise<void> | null = null;

  /**
   * #3456: coalesce concurrent forced polls (R3). A second `forcePoll()` while
   * one is in flight receives the in-flight result instead of starting an
   * overlapping sweep.
   */
  private forcePollInFlight: Promise<FederationPollResult> | null = null;

  /** IDs of static nodes (from config) — these are never evicted. */
  private readonly staticNodeIds: Set<string>;

  /** When this registry was built (≈ hub start); anchors HUB_RESTART_GRACE_MS. */
  private readonly constructedAt = Date.now();

  /** Pending reconnect timers — tracked so eviction can cancel them. */
  private eventBridgeReconnectTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  /**
   * Set of sessionIds this node considers "interesting" — sessions where
   * originatingNodeId matches our own nodeId, or sessions without an
   * originator (backward compat). Rebuilt on each poll cycle for O(1)
   * lookup in the SSE event bridge filter.
   */
  private interestingSessions = new Set<string>();

  /** Event bridge stats: counters reset each poll cycle for observability. */
  private bridgeStats = { forwarded: 0, filtered: 0 };

  /** Rate-limited SSE bridge JSON parse error tracking. */
  private bridgeParseErrorCount = 0;
  private bridgeParseErrorLastLogTime = 0;

  /** Remote nodes to poll (own nodeId filtered out to prevent self-poll). */
  private remoteNodes: FederationNodeConfig[];

  /** #5127: may a home node's URL be sent a shared-API-key request? */
  private readonly homeUrlGuard: (url: string) => Promise<boolean>;

  constructor(options: NodeRegistryOptions) {
    this.homeUrlGuard = options.homeUrlGuard ?? createHomeUrlGuard();
    this.config = options.config;
    this.apiToken = options.apiToken;
    this.getLocalSessionCount = options.getLocalSessionCount;
    this.peerStore = options.peerStore ?? null;
    this.evictionThreshold = options.evictionThreshold ?? EVICTION_THRESHOLD;
    this.fileClaimSync = options.fileClaimSync ?? null;
    this.eventBridgeIdleTimeoutMs =
      options.eventBridgeIdleTimeoutMs ?? EVENT_BRIDGE_IDLE_TIMEOUT_MS;

    // Filter out self from the static nodes list to prevent self-polling.
    // In P2P mode a peer's config may include itself in the nodes array.
    // System-wide node-label casing (epic #3285 round 11): every STATIC peer's
    // configured label is normalized by its URL here, where it enters the
    // registry (cloud ⇔ .hapimatic.com → lower case; local → UPPER CASE).
    this.remoteNodes = this.config.nodes
      .filter(n => n.id !== this.config.nodeId)
      .map(n => ({ ...n, label: displayNodeLabel(n.label, { url: n.url }) }));

    // Track static node IDs — these are never evicted regardless of failures
    this.staticNodeIds = new Set(this.remoteNodes.map(n => n.id));

    // Initialize node states for each static remote node
    for (const node of this.remoteNodes) {
      this.nodeStates.set(node.id, {
        config: node,
        status: "offline",
        info: null,
        lastSuccessfulPoll: null,
        lastError: null,
        consecutiveFailures: 0,
      });
    }

    // #1963: the remote-node poll is a supervised loop (finally-reschedule +
    // stall watchdog + job-registry registration); pollAllNodes is the work.
    this.loop = new SupervisedLoop({
      name: "node-registry-poll",
      node: this.config.nodeId,
      intervalMs: this.config.pollIntervalMs,
      immediate: true,
      registry: options.jobRegistry ?? undefined,
      tick: () => this.pollAllNodes(),
    });
  }

  /** Start polling all remote nodes. */
  start(): void {
    if (this.loop.getStatus() !== "stopped") return;

    console.log(
      `[Federation] Starting NodeRegistry — polling ${this.remoteNodes.length} remote node(s) every ${this.config.pollIntervalMs}ms`
    );

    // Best-effort connectivity check: warn about unreachable nodes at startup
    void Promise.allSettled(
      this.remoteNodes.map(async node => {
        try {
          const headers: Record<string, string> = {};
          if (this.apiToken) {
            headers["Authorization"] = `Bearer ${this.apiToken}`;
          }
          await fetch(`${node.url}/api/health`, {
            headers,
            signal: AbortSignal.timeout(5000),
          });
        } catch {
          console.warn(
            `[Federation] ⚠️  Node ${node.label} (${node.id}) at ${node.url} is unreachable at startup — check federation config`
          );
        }
      })
    );

    // #1963: the supervised loop runs the first poll immediately
    // (immediate:true) then reschedules at pollIntervalMs with a stall
    // watchdog + registry row.
    this.loop.start();
  }

  /** Stop polling and event bridges. */
  stop(): void {
    this.loop.stop();

    // Tear down all event bridge connections
    for (const [nodeId, controller] of this.eventBridgeAbortControllers) {
      controller.abort();
    }
    this.eventBridgeAbortControllers.clear();
    this.eventBridgeReconnectAttempts.clear();
    this.pollBackoffUntil.clear();

    // Cancel pending reconnect timers
    for (const timer of this.eventBridgeReconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.eventBridgeReconnectTimers.clear();

    this.eventBridgeSseManager = null;

    console.log("[Federation] NodeRegistry stopped");
  }

  /**
   * In-memory teardown shared by both eviction paths (#2531). Removes the peer
   * from all 5 in-memory structures (remoteNodes, nodeStates, eventBridge*,
   * sessionCache, pollBackoff) and drops its claim replica. Does NOT touch
   * PeerStore — the caller decides `markOffline` (auto path, re-joinable) vs
   * `tombstone` (explicit path, mesh-wide death certificate).
   */
  private teardownPeerInMemory(nodeId: string): void {
    // #1969 (R6): drop this peer's claim replica — an evicted peer's claims must
    // not linger in the cross-node view. Idempotent (a no-op if the offline
    // transition already dropped it).
    this.fileClaimSync?.dropNode(nodeId);

    // 1. Remove from remoteNodes array
    this.remoteNodes = this.remoteNodes.filter(n => n.id !== nodeId);

    // 2. Remove from nodeStates
    this.nodeStates.delete(nodeId);

    // 3. Tear down SSE event bridge connection
    const controller = this.eventBridgeAbortControllers.get(nodeId);
    if (controller) {
      controller.abort();
      this.eventBridgeAbortControllers.delete(nodeId);
    }
    this.eventBridgeReconnectAttempts.delete(nodeId);

    // Cancel any pending reconnect timer to prevent zombie reconnects
    const timer = this.eventBridgeReconnectTimers.get(nodeId);
    if (timer) {
      clearTimeout(timer);
      this.eventBridgeReconnectTimers.delete(nodeId);
    }

    // 4. Remove from session cache
    this.sessionCache.delete(nodeId);

    // 5. Remove from poll backoff
    this.pollBackoffUntil.delete(nodeId);
  }

  /**
   * Evict a dynamic peer from the registry — AUTO path (poll-failure threshold).
   * Tears down in-memory state and marks the peer OFFLINE in PeerStore (NO
   * tombstone). Auto-eviction infers unreachability, not death, so a
   * live-but-partitioned node MUST be able to re-join via gossip once it is
   * reachable again — the R4 never-evict-a-healthy-node invariant (#2531).
   * Static nodes are never evicted.
   */
  private evictPeer(nodeId: string): void {
    // Never evict static nodes
    if (this.staticNodeIds.has(nodeId)) return;

    const state = this.nodeStates.get(nodeId);
    const label = state?.config.label ?? nodeId;

    this.teardownPeerInMemory(nodeId);

    // Mark offline in PeerStore so it can re-join later via re-announcement.
    // Deliberately NOT a tombstone: gossip must never infer death (#2531).
    this.peerStore?.markOffline(nodeId);

    console.warn(
      `[Federation] Evicted dynamic peer ${label} (${nodeId}) — ` +
        `${state?.consecutiveFailures ?? "?"} consecutive failures`
    );
  }

  /**
   * Explicitly evict a peer mesh-wide (#2531) — the EXPLICIT path, called by the
   * DELETE route (and, via that route, by deprovision.sh). Writes a tombstone
   * (death certificate) so gossip cannot resurrect the peer, hard-removes the
   * PeerStore row, and tears down all in-memory state. Static config nodes are
   * refused (they resurrect from config on restart, so a tombstone would be
   * futile). Returns what was removed so the route can reflect store + in-memory
   * removal (AC: "response reflects both").
   */
  evictNode(nodeId: string): {
    inMemoryRemoved: boolean;
    storeUpdated: boolean;
    isStatic: boolean;
  } {
    if (this.staticNodeIds.has(nodeId)) {
      return { inMemoryRemoved: false, storeUpdated: false, isStatic: true };
    }
    const inMemoryRemoved = this.nodeStates.has(nodeId);
    this.teardownPeerInMemory(nodeId);
    // Explicit path: write a death certificate + remove the live row. This is
    // what makes a single eviction propagate mesh-wide (R1/R2).
    this.peerStore?.tombstone(nodeId);
    console.warn(
      `[Federation] Explicitly evicted peer ${nodeId} — tombstone written (propagates mesh-wide)`
    );
    return {
      inMemoryRemoved,
      storeUpdated: this.peerStore !== null,
      isStatic: false,
    };
  }

  /** Get the count of tracked remote nodes (for MAX_PEERS enforcement). */
  getTrackedNodeCount(): number {
    return this.remoteNodes.length;
  }

  /**
   * Start the SSE event bridge: maintains one persistent SSE connection
   * per remote node and re-broadcasts received events through the hub's
   * SSEManager so that all web clients receive real-time updates for
   * remote sessions.
   */
  startEventBridge(sseManager: SSEManager): void {
    this.eventBridgeSseManager = sseManager;
    for (const node of this.remoteNodes) {
      this.connectNodeEventBridge(node);
    }
    console.log(
      `[Federation] Event bridge started for ${this.remoteNodes.length} node(s)`
    );
  }

  /**
   * Establish a persistent SSE connection to a remote node's
   * /api/federation/events endpoint. Received events are re-broadcast
   * through the hub's local SSEManager.
   */
  private connectNodeEventBridge(nodeConfig: FederationNodeConfig): void {
    // Abort any existing connection for this node
    const existing = this.eventBridgeAbortControllers.get(nodeConfig.id);
    if (existing) {
      existing.abort();
    }

    const controller = new AbortController();
    this.eventBridgeAbortControllers.set(nodeConfig.id, controller);

    void this.runEventBridge(nodeConfig, controller.signal);
  }

  private async runEventBridge(
    nodeConfig: FederationNodeConfig,
    signal: AbortSignal
  ): Promise<void> {
    const url = `${nodeConfig.url}/api/federation/events`;
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
    };
    if (this.apiToken) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }

    // Inactivity watchdog (see EVENT_BRIDGE_IDLE_TIMEOUT_MS). `attempt` is this
    // run's own controller: the parent `signal` (a newer connect, eviction,
    // stop) aborts it too, while the watchdog aborts ONLY it, so a tripped
    // watchdog is distinguishable from a supersede and leads to a reconnect.
    const attempt = new AbortController();
    const onParentAbort = () => attempt.abort();
    signal.addEventListener("abort", onParentAbort, { once: true });
    if (signal.aborted) attempt.abort();
    let idleTripped = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    // The watchdog only needs cancel(); the loop reads from the typed reader.
    let reader: { cancel(): Promise<void> } | null = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        idleTripped = true;
        attempt.abort();
        // A pending body read does not reliably reject when the fetch signal
        // aborts; cancelling the reader resolves it with `done`.
        void reader?.cancel().catch(() => {});
      }, this.eventBridgeIdleTimeoutMs);
    };
    const disarmIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const idleMessage = `[Federation] Event bridge: no data from ${nodeConfig.id} for ${this.eventBridgeIdleTimeoutMs}ms, reconnecting`;

    try {
      armIdle();
      const resp = await fetch(url, { headers, signal: attempt.signal });

      if (signal.aborted) return;

      if (!resp.ok || !resp.body) {
        disarmIdle();
        console.warn(
          `[Federation] Event bridge: ${nodeConfig.id} returned ${resp.status}`
        );
        this.scheduleEventBridgeReconnect(nodeConfig, signal);
        return;
      }

      // Reset reconnect attempts on successful connection
      this.eventBridgeReconnectAttempts.set(nodeConfig.id, 0);
      console.log(
        `[Federation] Event bridge connected to ${nodeConfig.id} (${nodeConfig.label})`
      );

      const bodyReader = resp.body.getReader();
      reader = bodyReader;
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await bodyReader.read();
        if (done || signal.aborted) break;
        armIdle();

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE frames
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ") && this.eventBridgeSseManager) {
            try {
              const event = JSON.parse(line.slice(6)) as SyncEvent;
              if (this.shouldForwardEvent(event)) {
                // Issue #4461 (R7): name the node whose store refused. The hub's
                // own id and label for this peer win over anything the peer
                // reported (hub-canonical identity), so the browser's toast and
                // the 409 for the same refusal name the same node.
                this.eventBridgeSseManager.broadcast(
                  event.type === "account-unrefreshable"
                    ? {
                        ...event,
                        nodeId: nodeConfig.id,
                        nodeLabel: nodeConfig.label,
                      }
                    : event
                );
                this.bridgeStats.forwarded++;
                // [perf] issue #2147 (interaction, bridge-hop): stamp when a
                // remote message-received event is rebroadcast to hub clients —
                // the receive half of TTFT. Join with the messages.ts send-hop
                // stamp for the hub-side TTFT total. Live bridge, not poll-gated.
                if (event.type === "message-received") {
                  const sid = "sessionId" in event ? event.sessionId : "";
                  console.log(
                    `[perf][interact] series=bridge-hop node=${nodeConfig.id} key=${sid} ts=${Date.now()}`
                  );
                }
                // Update session cache from bridged event data so that
                // web client refetches see fresh thinking/active state
                // instead of waiting for the next 10s poll.
                this.updateCacheFromBridgedEvent(nodeConfig.id, event);
                // #1969 (R4/R6): merge a bridged file-claim delta into the
                // peer's replica (the fast path). Guarded by channel-nodeId
                // match + offline-skip in the helper.
                if (event.type === "file-claim-delta") {
                  this.mergeBridgedClaimDelta(nodeConfig.id, event.snapshot);
                }
              } else {
                this.bridgeStats.filtered++;
              }
            } catch {
              this.bridgeParseErrorCount++;
              const now = Date.now();
              if (now - this.bridgeParseErrorLastLogTime >= 60_000) {
                console.warn(
                  `[Federation] Event bridge: ${this.bridgeParseErrorCount} malformed JSON event(s) from ${nodeConfig.id} in the last minute`
                );
                this.bridgeParseErrorCount = 0;
                this.bridgeParseErrorLastLogTime = now;
              }
            }
          }
        }
      }

      disarmIdle();
      if (signal.aborted) return;

      // Stream ended (or the watchdog cancelled it) — reconnect
      if (idleTripped) {
        console.warn(idleMessage);
      } else {
        console.log(
          `[Federation] Event bridge: stream ended for ${nodeConfig.id}, reconnecting`
        );
      }
      this.scheduleEventBridgeReconnect(nodeConfig, signal);
    } catch (err) {
      disarmIdle();
      if (signal.aborted) return;
      if (idleTripped) {
        // The watchdog aborted a connect that was never answered, or a read
        // that rejected on abort — either way the stream is dead, not superseded.
        console.warn(idleMessage);
        this.scheduleEventBridgeReconnect(nodeConfig, signal);
        return;
      }
      if (err instanceof Error && err.name === "AbortError") return;

      console.warn(
        `[Federation] Event bridge error for ${nodeConfig.id}:`,
        err instanceof Error ? err.message : err
      );
      this.scheduleEventBridgeReconnect(nodeConfig, signal);
    } finally {
      disarmIdle();
      signal.removeEventListener("abort", onParentAbort);
    }
  }

  /**
   * Schedule the next bridge connect for `nodeConfig`, or suspend while the
   * node is offline. `ownSignal` is the calling run's signal: only the run that
   * still owns the node's live controller may act, so a superseded run's late
   * call never touches the newer bridge.
   */
  private scheduleEventBridgeReconnect(
    nodeConfig: FederationNodeConfig,
    ownSignal: AbortSignal
  ): void {
    const current = this.eventBridgeAbortControllers.get(nodeConfig.id);
    if (current && current.signal !== ownSignal) return;

    // Suspend event bridge reconnection for nodes past the offline threshold.
    // The bridge will be restarted by pollNode() when the node recovers.
    const state = this.nodeStates.get(nodeConfig.id);
    if (state && state.consecutiveFailures >= OFFLINE_THRESHOLD) {
      // The run that called us has ended, so release its controller entry.
      // pollNode()'s recovery restart is gated on
      // `!eventBridgeAbortControllers.has(id)`; leaving the dead run's entry in
      // place kept that gate shut, so a node that went offline while its
      // bridge was failing (a peer restarting during a deploy, #5217) never got its
      // bridge back until this process restarted — the hub then showed no
      // live updates for that node's sessions.
      this.eventBridgeAbortControllers.delete(nodeConfig.id);
      console.log(
        `[Federation] Event bridge suspended for ${nodeConfig.id} (node offline) — restarts on the next successful poll`
      );
      return;
    }

    // One pending reconnect per node: a second schedule (e.g. the watchdog and
    // a read error in the same run) must not double-connect.
    if (this.eventBridgeReconnectTimers.has(nodeConfig.id)) return;

    const attempts = this.eventBridgeReconnectAttempts.get(nodeConfig.id) ?? 0;
    this.eventBridgeReconnectAttempts.set(nodeConfig.id, attempts + 1);

    const delay =
      EVENT_BRIDGE_BACKOFF[
        Math.min(attempts, EVENT_BRIDGE_BACKOFF.length - 1)
      ] ?? 30000;

    const timer = setTimeout(() => {
      this.eventBridgeReconnectTimers.delete(nodeConfig.id);
      // Only reconnect if the bridge is active AND the node is still tracked.
      // Without the nodeStates guard, evicted peers would zombie-reconnect.
      if (this.eventBridgeSseManager && this.nodeStates.has(nodeConfig.id)) {
        this.connectNodeEventBridge(nodeConfig);
      }
    }, delay);
    this.eventBridgeReconnectTimers.set(nodeConfig.id, timer);
  }

  /** Get the current state of all tracked nodes. */
  getNodeStates(): FederationNodeState[] {
    return Array.from(this.nodeStates.values());
  }

  /** True when `nodeId` is a tracked federation node (online or offline).
   *  Lets callers (e.g. the spawn-roster WRITE route, issue #2018) distinguish an
   *  UNKNOWN nodeId from a KNOWN-but-offline one — `proxyToNode` collapses both into
   *  the same "Node is offline" error, so membership must be decided before proxying. */
  hasNode(nodeId: string): boolean {
    return this.nodeStates.has(nodeId);
  }

  /** Get all remote sessions merged from all nodes, with federation metadata.
   *  Dual-node visibility: shows sessions spawned by this node (originatingNodeId match)
   *  plus sessions without an originator (backward compat with pre-P2P sessions).
   */
  getAllRemoteSessions(): SessionSummary[] {
    const ownNodeId = this.config.nodeId;
    const now = Date.now();
    const all: SessionSummary[] = [];
    for (const cached of this.sessionCache.values()) {
      const state = this.nodeStates.get(cached.nodeId);
      const nodeStatus = state?.status ?? "offline";
      const nodeUrl = state?.config.url;
      const enriched = cached.sessions
        .filter(s => isSessionInteresting(s, ownNodeId))
        .map(s => ({
          ...s,
          nodeStatus,
          nodeUrl,
          // Issue #2761 (Fix B): dual-corroborated read-path projection. Show an
          // offline node's frozen-zombie session as `active:false` to consumers of
          // /api/federation/all-sessions — but ONLY when the node is offline AND the
          // session's `activeAt` heartbeat is stale beyond the freshness window.
          //
          // WHY dual-corroboration, never offline-alone: the daemon idle-refresh
          // P-REVOKE guard consumes THIS SAME endpoint (run.ts → webClient.ts →
          // getAllRemoteSessions), and `isSessionLiveForGuard` short-circuits on
          // `!active` BEFORE its own freshness check. An unconditional offline
          // projection would therefore launder node-offline into a standalone
          // not-live trigger, violating the landed #1852 R24 invariant and reopening
          // a 45-120s false-rotation window on connectivity blips (a node flips
          // offline in ~30-45s, i.e. BEFORE `activeAt` staleness at 120s). Requiring
          // BOTH conditions still kills the 20h frozen-zombie UI case this fix
          // targets (20h ≫ 120s). `nodeStatus` is the 3-valued node state, so
          // "online"/"degraded", offline-but-fresh, and offline-with-missing-
          // `activeAt` (R4 conservatism) all fall through to `s.active`.
          //
          // Read-path only (R2): this is a fresh spread, so the cached
          // `SessionSummary` in `sessionCache` is never mutated — `markSessionInactive`'s
          // targeted mutations and the next successful poll's write are left intact.
          active:
            nodeStatus === "offline" && !isActiveAtFresh(s.activeAt, now)
              ? false
              : s.active,
        }));
      all.push(...enriched);
    }
    return all;
  }

  /**
   * Find which remote node hosts a given session.
   * Returns the node config (with URL) or null if not found / offline.
   */
  findNodeForSession(
    sessionId: string
  ): { nodeId: string; url: string } | null {
    for (const cached of this.sessionCache.values()) {
      const match = cached.sessions.find(s => s.id === sessionId);
      if (match) {
        const state = this.nodeStates.get(cached.nodeId);
        if (state && state.status !== "offline") {
          return { nodeId: cached.nodeId, url: state.config.url };
        }
        return null; // Node exists but is offline
      }
    }
    return null;
  }

  /**
   * #3815: find the node that owns a remote session REGARDLESS of its status.
   * `findNodeForSession` returns null for an offline owner — the same as for an
   * unknown id — while `getAllRemoteSessions` keeps listing that node's
   * sessions; a bulk action must tell "node_offline" from "not_found". Also
   * returns the hub's cached summary (the remote Stop turn reads `thinking`).
   */
  locateSession(sessionId: string): {
    nodeId: string;
    status: "online" | "degraded" | "offline";
    session: SessionSummary;
  } | null {
    for (const cached of this.sessionCache.values()) {
      const match = cached.sessions.find(s => s.id === sessionId);
      if (match) {
        const state = this.nodeStates.get(cached.nodeId);
        return {
          nodeId: cached.nodeId,
          status: state?.status ?? "offline",
          session: match,
        };
      }
    }
    return null;
  }

  /**
   * True until every static peer has completed one SUCCESSFUL poll since this
   * hub started, or until `HUB_RESTART_GRACE_MS` has passed. Until a peer polls
   * successfully the session cache holds nothing for it, so its live sessions
   * read as unknown — the hub-restart case of #5375. A failed first poll does
   * not close the window (#5407): a peer that is down at hub start would
   * otherwise answer plain 404s and the web client would drop the saved route.
   */
  isAwaitingInitialPoll(): boolean {
    if (Date.now() - this.constructedAt >= HUB_RESTART_GRACE_MS) return false;
    for (const nodeId of this.staticNodeIds) {
      const state = this.nodeStates.get(nodeId);
      if (state && state.lastSuccessfulPoll === null) return true;
    }
    return false;
  }

  /** Remove a session from the local cache (e.g. after confirmed deletion). */
  evictSessionFromCache(sessionId: string): void {
    for (const cached of this.sessionCache.values()) {
      const idx = cached.sessions.findIndex(s => s.id === sessionId);
      if (idx !== -1) {
        cached.sessions.splice(idx, 1);
        return;
      }
    }
  }

  /** Mark a cached session as inactive (e.g. after confirmed archive). */
  markSessionInactive(sessionId: string): void {
    for (const cached of this.sessionCache.values()) {
      const session = cached.sessions.find(s => s.id === sessionId);
      if (session) {
        session.active = false;
        return;
      }
    }
  }

  /** Mark a cached session as active (e.g. after confirmed reconnect). */
  markSessionActive(sessionId: string): void {
    for (const cached of this.sessionCache.values()) {
      const session = cached.sessions.find(s => s.id === sessionId);
      if (session) {
        session.active = true;
        return;
      }
    }
  }

  /** Update a cached session's name (e.g. after confirmed rename via federation proxy).
   *  No-ops if metadata is null (cannot construct valid metadata without `path`). */
  updateCachedSessionName(sessionId: string, name: string): void {
    for (const cached of this.sessionCache.values()) {
      const session = cached.sessions.find(s => s.id === sessionId);
      if (session?.metadata) {
        session.metadata.name = name;
        return;
      }
    }
  }

  /** Update a cached session's emoji after a successful federation proxy mutation. */
  updateCachedSessionEmoji(sessionId: string, emoji: string | null): void {
    for (const cached of this.sessionCache.values()) {
      const session = cached.sessions.find(s => s.id === sessionId);
      if (session) {
        session.emoji = emoji ?? undefined;
        return;
      }
    }
  }

  /** Update a cached session's needsReviewOverride after a successful federation proxy mutation. */
  updateCachedSessionNeedsReviewOverride(
    sessionId: string,
    override: "read" | "unread" | null
  ): void {
    for (const cached of this.sessionCache.values()) {
      const session = cached.sessions.find(s => s.id === sessionId);
      if (session) {
        session.needsReviewOverride = override;
        return;
      }
    }
  }

  /** Update a cached session's autoRecoverFromApiError after a successful federation proxy mutation. */
  updateCachedSessionAutoRecoverFromApiError(
    sessionId: string,
    autoRecover: boolean | null
  ): void {
    for (const cached of this.sessionCache.values()) {
      const session = cached.sessions.find(s => s.id === sessionId);
      if (session) {
        session.autoRecoverFromApiError = autoRecover;
        return;
      }
    }
  }

  /** Update a cached session's linkedIssue after a successful federation proxy mutation. */
  updateCachedSessionLinkedIssue(
    sessionId: string,
    linkedIssue: {
      number: number;
      title: string;
      repo: string;
      state?: "open" | "closed";
    } | null
  ): void {
    for (const cached of this.sessionCache.values()) {
      const session = cached.sessions.find(s => s.id === sessionId);
      if (session) {
        session.linkedIssue = linkedIssue;
        return;
      }
    }
  }

  /**
   * Issue #2862 (Fix 1): update a cached session's managed-peer parent link after
   * a successful federation proxy of `PUT /sessions/:id/parent`, mirroring
   * {@link updateCachedSessionLinkedIssue}. The forwarded `parentSessionId` is
   * already resolved to a canonical uuid at the hub route (layer 1) before the
   * proxy, so this write is applied verbatim.
   */
  updateCachedSessionParentRelationship(
    sessionId: string,
    parentSessionId: string,
    parentRelationship: "branch" | "spawn"
  ): void {
    for (const cached of this.sessionCache.values()) {
      const session = cached.sessions.find(s => s.id === sessionId);
      if (session) {
        session.parentSessionId = parentSessionId;
        session.parentRelationship = parentRelationship;
        return;
      }
    }
  }

  /** Update a cached session's notes after a successful federation proxy mutation. */
  updateCachedSessionNotes(sessionId: string, notes: string | null): void {
    for (const cached of this.sessionCache.values()) {
      const session = cached.sessions.find(s => s.id === sessionId);
      if (session?.metadata) {
        session.metadata.notes = notes ?? undefined;
        return;
      }
    }
  }

  /**
   * Issue #1905: update a cached session's per-session ceiling override after a
   * successful federation proxy of `PUT /sessions/:id/ceiling-override`,
   * mirroring {@link updateCachedSessionNotes}. `null` clears the override.
   */
  updateCachedSessionCeilingOverride(
    sessionId: string,
    ceilingOverride: CeilingGuardConfigPatch | null
  ): void {
    for (const cached of this.sessionCache.values()) {
      const session = cached.sessions.find(s => s.id === sessionId);
      if (session?.metadata) {
        session.metadata.ceilingOverride = ceilingOverride ?? undefined;
        return;
      }
    }
  }

  /** Update a cached session's persisted view after a successful federation proxy
   *  mutation (issue #3286). The cached remote is a SessionSummary, so the view
   *  lives under `metadata` (the notes cache-shape asymmetry). */
  updateCachedSessionView(sessionId: string, view: SessionView | null): void {
    for (const cached of this.sessionCache.values()) {
      const session = cached.sessions.find(s => s.id === sessionId);
      if (session?.metadata) {
        session.metadata.persistedView = view ?? undefined;
        return;
      }
    }
  }

  /** Update a cached session's bound account after a successful federation proxy
   *  account switch (issue #1517). No-ops if metadata is null (cannot construct
   *  valid metadata without `path`). Mirrors updateCachedSessionName/Notes. */
  updateCachedSessionAccount(
    sessionId: string,
    accountUuid: string,
    claudeAccount: ClaudeAccountInfo,
    // Issue #4823: the owning node's new auth binding (a peer older than #4823
    // returns none — leave the cached binding alone then).
    authBinding?: AuthBinding
  ): void {
    for (const cached of this.sessionCache.values()) {
      const session = cached.sessions.find(s => s.id === sessionId);
      if (session?.metadata) {
        session.metadata.accountUuid = accountUuid;
        session.metadata.claudeAccount = claudeAccount;
        if (authBinding) {
          session.metadata.authBinding = authBinding;
        }
        // Issue #4823: an account now binds the session — drop the API-key id the
        // peer last reported (the summary projects `apiKeyId` only, never the
        // mask), so no hub surface keeps naming the key until the next poll; the
        // owning node's record already dropped it.
        delete session.metadata.apiKeyId;
        return;
      }
    }
  }

  /**
   * Update a cached session's live-control fields after a successful federation
   * proxy mutation (#3083). Guards on `if (session)` — NOT `if (session?.metadata)`
   * — because `permissionMode` / `modelMode` are TOP-LEVEL `SessionSummary` fields
   * (`shared/src/sessionSummary.ts:117`, `:115`) while `metadata` is nullable, so a
   * metadata-guarded copy would silently no-op for a cached summary with
   * `metadata: null`. `effort` / `rawModel` are not summary fields — they refresh at
   * the next poll. In place, never evict (ruling A-D4; docs/internal/architecture/federation.md).
   */
  updateCachedSessionConfig(
    sessionId: string,
    config: { permissionMode?: PermissionMode; modelMode?: ModelMode }
  ): void {
    for (const cached of this.sessionCache.values()) {
      const session = cached.sessions.find(s => s.id === sessionId);
      if (session) {
        if (config.permissionMode !== undefined) {
          session.permissionMode = config.permissionMode;
        }
        if (config.modelMode !== undefined) {
          session.modelMode = config.modelMode;
        }
        return;
      }
    }
  }

  /** Update a cached session's promptDraft after a successful federation proxy mutation. */
  updateCachedSessionPromptDraft(
    sessionId: string,
    promptDraft: string | null
  ): void {
    for (const cached of this.sessionCache.values()) {
      const session = cached.sessions.find(s => s.id === sessionId);
      if (session?.metadata) {
        session.metadata.promptDraft = promptDraft ?? undefined;
        return;
      }
    }
  }

  /** Update a cached session's uiCollapseState after a successful federation proxy mutation. */
  updateCachedSessionUiCollapseState(
    sessionId: string,
    uiCollapseState: UiCollapseState | null
  ): void {
    for (const cached of this.sessionCache.values()) {
      const session = cached.sessions.find(s => s.id === sessionId);
      if (session) {
        session.uiCollapseState = uiCollapseState;
        return;
      }
    }
  }

  /** Mark a node as draining — existing sessions continue, no new sessions routed. */
  drainNode(nodeId: string): void {
    if (this.peerStore) {
      this.peerStore.markDraining(nodeId);
    }
    const state = this.nodeStates.get(nodeId);
    if (state) {
      state.status = "degraded";
    }
  }

  /**
   * Update cached session data from a bridged SSE event.
   * When the event bridge receives a session-updated event with session data,
   * update the cached SessionSummary's real-time display fields (e.g. thinking,
   * active, activeAt, updatedAt, rateLimited, blockedOnTuiPrompt) so that web
   * client refetches see fresh state without waiting for the next poll cycle.
   */
  /**
   * #1969 (R4/R6): merge a bridged `file-claim-delta` snapshot into the peer's
   * `FileClaimSync` replica. Two guards before the merge:
   *   1. The snapshot's `nodeId` MUST match the bridge channel's own node id —
   *      a buggy/hostile peer must not clobber another node's register.
   *   2. Skip while the peer is marked offline — the poll may be failing while
   *      the SSE bridge is still alive; the offline transition already dropped
   *      this peer's replica, and re-merging here would re-introduce flapping
   *      cross-node visibility. It re-propagates cleanly once the poll recovers.
   * `mergeSnapshot` re-validates the payload (the bridge receive is a raw
   * `JSON.parse ... as SyncEvent` cast — no upstream Zod).
   */
  private mergeBridgedClaimDelta(
    channelNodeId: string,
    snapshot: FileClaimSyncSnapshot
  ): void {
    if (!this.fileClaimSync) return;
    if (snapshot.nodeId !== channelNodeId) return;
    const state = this.nodeStates.get(channelNodeId);
    if (state && state.status === "offline") return;
    this.fileClaimSync.mergeSnapshot(snapshot);
  }

  private updateCacheFromBridgedEvent(nodeId: string, event: SyncEvent): void {
    if (event.type !== "session-updated" || !("sessionId" in event)) return;
    const data = (event as { data?: Record<string, unknown> }).data;
    if (!data) return;

    const cached = this.sessionCache.get(nodeId);
    if (!cached) return;

    const session = cached.sessions.find(s => s.id === event.sessionId);
    if (!session) return;

    // Update real-time display fields from the bridged session data
    if (typeof data.thinking === "boolean") session.thinking = data.thinking;
    if (typeof data.active === "boolean") session.active = data.active;
    if (typeof data.activeAt === "number") session.activeAt = data.activeAt;
    if (typeof data.updatedAt === "number") session.updatedAt = data.updatedAt;
    if (typeof data.thinkingStartedAt === "number")
      session.thinkingStartedAt = data.thinkingStartedAt;
    if (typeof data.serverAccumulatedMs === "number")
      session.serverAccumulatedMs = data.serverAccumulatedMs;
    // Issue #1647: carry the rate-limited delta through the federation real-time
    // bridge so a federated session's "rate-limited — resets {time}" chip updates
    // within an SSE cycle instead of waiting for the next 10s poll. The bridged
    // value is an object or explicit null; `in` guard distinguishes "absent"
    // (older peer — leave as-is) from a genuine null clear.
    if ("rateLimited" in data) {
      session.rateLimited =
        (data.rateLimited as {
          resetText: string;
          resetAt: number | null;
          since: number;
        } | null) ?? null;
    }
    // Issue #1700 (mirrors #1647 rateLimited): carry the blocked-on-TUI-prompt
    // delta through the federation real-time bridge so a federated session's
    // "blocked on terminal prompt" banner (#1653) surfaces within an SSE cycle
    // instead of waiting for the next 10s poll. The `in` guard distinguishes
    // "absent" — an older peer OR the field-whitelisted reactivate() emit, both
    // of which must leave the cached value as-is — from a genuine null clear.
    if ("blockedOnTuiPrompt" in data) {
      session.blockedOnTuiPrompt =
        (data.blockedOnTuiPrompt as {
          message: string;
          since: number;
        } | null) ?? null;
    }
    // Issue #2026 (mirrors #1647 rateLimited / #1700 blockedOnTuiPrompt): carry
    // the needs-review-override delta from a content-gated clear on the owning
    // node through the federation real-time bridge, so a federated session's
    // status dot updates within an SSE cycle instead of waiting up to 10s for
    // the next poll. This is the `session-updated`-bridge analog of the
    // per-mutation `updateCachedSessionNeedsReviewOverride` (used by the web
    // mark-read proxy path). The `in` guard distinguishes "absent" (an emit that
    // does not touch the override — e.g. the field-whitelisted reactivate() emit,
    // leave as-is) from a genuine value ("read"/"unread"/null).
    if ("needsReviewOverride" in data) {
      session.needsReviewOverride =
        (data.needsReviewOverride as "read" | "unread" | null) ?? null;
    }
    // Issue #4387 (mirrors #1647 rateLimited / #1700 blockedOnTuiPrompt / #2026
    // needsReviewOverride): carry the background-agents delta through the
    // federation real-time bridge so a federated session's agents badge updates
    // within an SSE cycle instead of waiting for the next 10s poll. The bridged
    // value is the RAW Session snapshot or an explicit null; project it through
    // the ONE shared projector (`projectBackgroundAgentsSummary`, #4383) — never
    // a local copy — so a later summary-level key (#4388) rides the bridge path
    // too. The caller owns the null rule (the projector takes the non-null
    // snapshot). The `in` guard distinguishes "absent" (an older peer, or a
    // field-whitelisted emit such as reactivate() — leave as-is) from a genuine
    // null clear (#4383 emits an EXPLICIT null on the T1/handleSessionEnd clear,
    // so the absent/clear distinction survives JSON.stringify).
    if ("backgroundAgents" in data) {
      session.backgroundAgents =
        data.backgroundAgents == null
          ? null
          : projectBackgroundAgentsSummary(
              data.backgroundAgents as Parameters<
                typeof projectBackgroundAgentsSummary
              >[0]
            );
    }
  }

  /** Spawn a session on a remote node via its federation API.
   *
   * The node-side endpoint is fire-and-forget: it validates the request
   * and machine availability, kicks off the spawn in the background, and
   * returns immediately with `{ type: "accepted" }`.  We translate that
   * to `{ type: "success", sessionId: "" }` for the client — the empty
   * sessionId signals "navigate to list, not detail."
   */
  async spawnOnNode(
    nodeId: string,
    body: FederationSpawnBody
  ): Promise<
    { type: "success"; sessionId: string } | { type: "error"; message: string }
  > {
    const state = this.nodeStates.get(nodeId);
    if (!state || state.status === "offline") {
      return { type: "error", message: "Node is offline" };
    }

    const url = `${state.config.url}/api/federation/spawn`;
    try {
      // [perf] issue #2147 stage (a): hub dispatch → remote {accepted}. This is
      // just the fire-and-forget accept RTT, NOT the raw spawn cost (which runs
      // in the background on the node). Additive log; grep `[perf][spawn]`.
      const perfDispatchT0 = Date.now();
      // Default timeout is fine — node responds immediately (fire-and-forget).
      const res = await this.fetchWithAuth(url, "POST", body);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return {
          type: "error",
          message: `Node returned ${res.status}: ${text}`,
        };
      }
      console.log(
        `[perf][spawn] stage=hub-dispatch-accept node=${nodeId} dir=${body.directory} ms=${Date.now() - perfDispatchT0}`
      );

      // Fire-and-forget re-poll to pick up the new session in the cache.
      // [perf] #2147: tag the trigger so the hub-visibility stamp attributes
      // this poll to the spawn accept (not a periodic/sibling poll).
      void this.pollNode(state.config, "spawn-accept").catch(err => {
        console.warn(
          `[Federation] Background poll failed after spawn on ${state.config.id}:`,
          err
        );
      });

      // Node returns { type: "accepted" } — translate to success with empty
      // sessionId so the client knows to navigate to the session list.
      return { type: "success", sessionId: "" };
    } catch (err) {
      return {
        type: "error",
        message: err instanceof Error ? err.message : "Spawn request failed",
      };
    }
  }

  /**
   * #5127 (D21): spawn a session bound to an API key stored on another node,
   * through the target's `/federation/spawn-api-key`. The target confirms the
   * key with its home before it accepts, so its refusal arrives here at once
   * and keeps its code and status. A target without the capability, or one
   * that answers 404 (an older binary), gets the needs-updating refusal; the
   * plain `/federation/spawn` is never tried, because it would drop the key and
   * bill the target's own default. A refusal's message is the target's own
   * fixed text; any other answer becomes a fixed message.
   */
  async spawnApiKeyOnNode(
    nodeId: string,
    body: FederationApiKeySpawnBody
  ): Promise<
    | { type: "success"; sessionId: string }
    | { type: "error"; message: string; code?: string; status?: number }
  > {
    const state = this.nodeStates.get(nodeId);
    if (!state || state.status === "offline") {
      return { type: "error", message: "Node is offline" };
    }
    const needsUpdating = {
      type: "error" as const,
      code: "api_key_remote_unsupported",
      message: `${displayNodeLabel(state.config.label, { url: state.config.url }) || state.config.id} needs updating before a session there can use an API key from another node`,
      status: 400,
    };
    if (!this.nodeSupports(nodeId, SHARED_API_KEYS_CAPABILITY)) {
      return needsUpdating;
    }
    let res: Response;
    try {
      // The target asks the key's home before it answers, with the federation
      // timeout, so this call allows for that round trip on top of its own.
      res = await this.fetchWithAuth(
        `${state.config.url}/api/federation/spawn-api-key`,
        "POST",
        body,
        SPAWN_TIMEOUT_MS,
        undefined,
        "error"
      );
    } catch (err) {
      return {
        type: "error",
        message: err instanceof Error ? err.message : "Spawn request failed",
      };
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    // An older target has no such path (404 with no refusal body): it needs
    // updating. A 404 that IS a refusal (api_key_not_found, …) passes through.
    const isRefusal =
      json !== null &&
      typeof json === "object" &&
      (json as { type?: unknown }).type === "error" &&
      typeof (json as { code?: unknown }).code === "string";
    if (res.status === 404 && !isRefusal) return needsUpdating;
    if (!res.ok) {
      const answer = json as {
        type?: unknown;
        message?: unknown;
        code?: unknown;
      } | null;
      if (
        answer &&
        answer.type === "error" &&
        typeof answer.message === "string" &&
        answer.message.length <= 400
      ) {
        return {
          type: "error",
          message: answer.message,
          ...(typeof answer.code === "string" && answer.code.length <= 64
            ? { code: answer.code }
            : {}),
          status: res.status,
        };
      }
      return { type: "error", message: `Node returned ${res.status}` };
    }
    void this.pollNode(state.config, "spawn-accept").catch(err => {
      console.warn(
        `[Federation] Background poll failed after spawn on ${state.config.id}:`,
        err
      );
    });
    return { type: "success", sessionId: "" };
  }

  /** Reconnect a session on a remote node via its federation API.
   *
   * The node-side endpoint is fire-and-forget: it validates the session,
   * kicks off reconnect in the background, and returns immediately.
   * We then rapid-poll to discover when the session becomes genuinely active.
   *
   * `namespace` is the JWT caller's namespace. It is forwarded as
   * `X-Hapi-Caller-Namespace` and the receiver re-asserts it (#1097, #5411).
   */
  async reconnectOnNode(
    nodeId: string,
    sessionId: string,
    namespace: string
  ): Promise<
    | { type: "success"; newSessionId: string }
    | { type: "error"; message: string; code?: string }
  > {
    const state = this.nodeStates.get(nodeId);
    if (!state || state.status === "offline") {
      return { type: "error", message: "Node is offline" };
    }

    const url = `${state.config.url}/api/federation/sessions/${encodeURIComponent(sessionId)}/reconnect`;
    try {
      // Default timeout is fine — node responds immediately (fire-and-forget).
      const res = await this.fetchWithAuth(url, "POST", {}, undefined, {
        "X-Hapi-Caller-Namespace": namespace,
      });
      if (!res.ok) {
        const body = await readPeerErrorBody(
          res,
          `reconnect on ${state.config.id}`
        );
        return {
          type: "error",
          message:
            (body as Record<string, string>).error ??
            `Node returned ${res.status}`,
          // #1778: surface the terminal error code (e.g. "cwd_missing") across
          // the federation boundary so the client route + UI can branch on it.
          code: (body as Record<string, string>).code,
        };
      }
      const result = (await res.json()) as {
        ok: true;
        newSessionId: string;
      };
      // Rapid-poll this node to pick up the real active state once the CLI
      // process connects. Polls every 2s for up to 60s, stopping early once
      // the session is genuinely active from the node's data.
      void this.rapidPollUntilActive(state.config, sessionId).catch(err => {
        console.warn(
          `[Federation] Rapid poll failed after reconnect on ${state.config.id}:`,
          err
        );
      });
      return { type: "success", newSessionId: result.newSessionId };
    } catch (err) {
      return {
        type: "error",
        message:
          err instanceof Error ? err.message : "Reconnect request failed",
      };
    }
  }

  /** Branch a session on a remote node via its federation API.
   *
   * `namespace` is the JWT caller's namespace. It is forwarded as
   * `X-Hapi-Caller-Namespace` and the receiver re-asserts it (#1097, #5411).
   */
  async branchOnNode(
    nodeId: string,
    sessionId: string,
    namespace: string,
    branchLabel?: string
  ): Promise<
    | { type: "success"; newSessionId: string }
    | { type: "error"; message: string }
  > {
    const state = this.nodeStates.get(nodeId);
    if (!state || state.status === "offline") {
      return { type: "error", message: "Node is offline" };
    }

    const url = `${state.config.url}/api/federation/sessions/${encodeURIComponent(sessionId)}/branch`;
    try {
      const res = await this.fetchWithAuth(
        url,
        "POST",
        { branchLabel },
        undefined,
        { "X-Hapi-Caller-Namespace": namespace }
      );
      if (!res.ok) {
        const body = await readPeerErrorBody(
          res,
          `branch on ${state.config.id}`
        );
        return {
          type: "error",
          message:
            (body as Record<string, string>).error ??
            `Node returned ${res.status}`,
        };
      }
      const result = (await res.json()) as {
        ok: true;
        newSessionId: string;
      };
      // Rapid-poll to pick up the new branched session once CLI connects
      void this.rapidPollUntilActive(state.config, result.newSessionId).catch(
        err => {
          console.warn(
            `[Federation] Rapid poll failed after branch on ${state.config.id}:`,
            err
          );
        }
      );
      return { type: "success", newSessionId: result.newSessionId };
    } catch (err) {
      return {
        type: "error",
        message: err instanceof Error ? err.message : "Branch request failed",
      };
    }
  }

  /** Force re-poll a specific node (e.g. after spawning a session). */
  async pollNodeById(nodeId: string, trigger = "force"): Promise<void> {
    const node = this.remoteNodes.find(n => n.id === nodeId);
    if (node) await this.pollNode(node, trigger);
  }

  /**
   * #3457 (Fix 2): react to an incoming peer announcement by scheduling an
   * immediate poll of the announcing node when it is currently offline/backed
   * off — turning "restart the peer" into a real recovery (seconds, not up to
   * the backoff cap) and closing the STATIC-node gap that `refreshDynamicPeers()`
   * misses (the SL7 trigger case). Wired from the `POST /federation/announce`
   * route handler (`peerDiscovery.ts`), where the announcing node's id is `selfId`.
   *
   * Fire-and-forget: the poll is not awaited (the announce response must not
   * block on it). Static nodes are INCLUDED by design — they are exactly the
   * gap. The immediate poll runs regardless of `pollBackoffUntil` because
   * `pollNodeById` → `pollNode` never gates on the backoff map (the only gate is
   * the periodic sweep filter in `sweepOnce()`); we deliberately do NOT delete
   * the backoff entry first, so the periodic tick keeps skipping this node while
   * the announcement-poll is in flight instead of double-polling it (the poll's
   * own success path clears the entry, its failure path rewrites it).
   *
   * Edge: a peer reachable TO the hub but not FROM it (asymmetric Tailscale)
   * turns each announcement into one failed poll, so a DYNAMIC peer reaches the
   * eviction threshold somewhat faster than by the periodic ladder alone —
   * bounded by the R4 rate-limit and `announceIntervalMs`; acceptable.
   */
  notePeerAnnouncement(nodeId: string): void {
    // Re-track an evicted DYNAMIC peer first: eviction removed it from
    // nodeStates, so hasNode() would be false until the next periodic sweep. The
    // route handler runs after handleIncomingAnnouncement upserted it into
    // PeerStore, so refreshing here re-adds it immediately. No-op without a
    // peerStore and for already-tracked (including static) nodes.
    this.refreshDynamicPeers();

    // Unknown id — a hub nodes[].id ↔ peer nodeId mismatch (e.g. "sl7" vs "SL7")
    // silently disables Fix 2 for that node; surface it for the operator check.
    if (!this.hasNode(nodeId)) {
      console.debug(
        `[Federation] notePeerAnnouncement: ignoring announcement from untracked node "${nodeId}"`
      );
      return;
    }

    // R4 rate-limit: at most one announcement-triggered poll per node per base
    // poll interval, so a flapping peer cannot drive a poll storm.
    const last = this.lastAnnouncementPoll.get(nodeId) ?? 0;
    if (Date.now() - last < this.config.pollIntervalMs) return;

    // An online node is already covered by the periodic loop — nothing to recover.
    const state = this.nodeStates.get(nodeId);
    if (state?.status === "online") return;

    // Poll now (R3). Record the timestamp BEFORE starting so a burst of
    // announcements coalesces onto this one poll. Fire-and-forget; pollNode
    // never throws, so the .catch is belt-and-suspenders.
    this.lastAnnouncementPoll.set(nodeId, Date.now());
    void this.pollNodeById(nodeId).catch(() => {});
  }

  /**
   * #3456: force an immediate federation poll of ALL nodes, bypassing per-node
   * backoff, and return a diff of what changed.
   *
   * Clears `pollBackoffUntil` (so the sweep's backoff filter skips nobody), then
   * drives one sweep and diffs the node statuses before vs. after:
   *   - `newlyOnline`: was not `online` before the sweep, is `online` after
   *   - `stillOffline`: still `offline` after, with its `lastError`
   *
   * R3 (coalescing): a second `forcePoll()` while one is in flight receives the
   * same in-flight result. R7 (no-regression): a still-unreachable node takes
   * the normal `pollNode` failure path and re-enters backoff via
   * `getPollBackoffDelay` exactly as a scheduled poll would — this method never
   * touches the failure/backoff computation.
   */
  async forcePoll(): Promise<FederationPollResult> {
    if (this.forcePollInFlight) return this.forcePollInFlight;
    this.forcePollInFlight = (async () => {
      // If a periodic sweep is already running, let it finish — but do NOT reuse
      // its result: it filtered out backed-off nodes, the exact thing a forced
      // poll must include. `sweepInFlight` holds the `.finally()` promise, so it
      // is already null when this await resumes; the sweep below runs fresh.
      if (this.sweepInFlight) await this.sweepInFlight;

      // Snapshot statuses BEFORE the sweep (the R2 diff basis).
      const before = new Map(
        this.getNodeStates().map(s => [s.config.id, s.status])
      );

      // Bypass backoff: clear the map so `sweepOnce()`'s filter skips nobody.
      this.pollBackoffUntil.clear();

      // One sweep through the guarded entry point.
      await this.pollAllNodes();

      // Snapshot AFTER + build the diff.
      const newlyOnline: FederationPollResult["newlyOnline"] = [];
      const stillOffline: FederationPollResult["stillOffline"] = [];
      for (const state of this.getNodeStates()) {
        const id = state.config.id;
        const wasOnline = before.get(id) === "online";
        if (!wasOnline && state.status === "online") {
          newlyOnline.push({ id, label: state.config.label });
        } else if (state.status === "offline") {
          stillOffline.push({
            id,
            label: state.config.label,
            lastError: state.lastError,
          });
        }
      }
      return { newlyOnline, stillOffline, polledAt: Date.now() };
    })().finally(() => {
      this.forcePollInFlight = null;
    });
    return this.forcePollInFlight;
  }

  /** Proxy list-directory request to a remote node. */
  async listDirectoryOnNode(
    nodeId: string,
    path: string
  ): Promise<
    { type: "success"; entries: unknown[] } | { type: "error"; message: string }
  > {
    return this.proxyToNode(nodeId, "/api/federation/list-directory", { path });
  }

  /** Proxy create-directory request to a remote node (issue #3498). */
  async createDirectoryOnNode(
    nodeId: string,
    path: string,
    recursive: boolean
  ): Promise<
    { type: "success"; entry: unknown } | { type: "error"; message: string }
  > {
    return this.proxyToNode(nodeId, "/api/federation/create-directory", {
      path,
      recursive,
    });
  }

  /** Proxy paths-exists check to a remote node. */
  async checkPathsExistOnNode(
    nodeId: string,
    paths: string[]
  ): Promise<
    | { type: "success"; exists: Record<string, boolean> }
    | { type: "error"; message: string }
  > {
    return this.proxyToNode(nodeId, "/api/federation/paths/exists", { paths });
  }

  /**
   * Proxy git repo identity detection to a remote node. `directoryIsGitRepo`
   * is the peer's rev-parse git-ness (#3558); OPTIONAL because the response is
   * a raw cast and a stale peer omits it — callers must treat absent as unknown.
   */
  async resolveRepoIdentityOnNode(
    nodeId: string,
    directory: string
  ): Promise<
    | {
        type: "success";
        repo: { name: string; url?: string } | null;
        directoryIsGitRepo?: boolean;
      }
    | { type: "error"; message: string }
  > {
    return this.proxyToNode(nodeId, "/api/federation/repo-identity", {
      directory,
    });
  }

  /**
   * Proxy the Create-page branch listing to a remote node (hapimatic-private#4481).
   * The peer runs git against ITS filesystem and returns a GitBranchListing.
   * A stale peer without the endpoint surfaces as `type: "error"` and the web
   * falls back to today's Git Type + Branch Name controls.
   */
  async listGitBranchesOnNode(
    nodeId: string,
    directory: string
  ): Promise<
    | { type: "success"; listing: GitBranchListing }
    | { type: "error"; message: string }
  > {
    return this.proxyToNode(nodeId, "/api/federation/git-branches", {
      directory,
    });
  }

  /**
   * Proxy host-`gh` GitHub-account resolution to a remote node (Issue #1953,
   * A6). The account selector for a remote spawn target shows THAT node's host
   * `gh` identity. NEVER carries a token across the federation boundary (R11).
   */
  async listGitHubAccountsOnNode(nodeId: string): Promise<
    | {
        type: "success";
        accounts: Array<{ login: string; name: string | null }>;
      }
    | { type: "error"; message: string }
  > {
    return this.proxyToNode(nodeId, "/api/federation/github-accounts", {});
  }

  /**
   * Proxy host-`gh` repo listing to a remote node (Issue #1953, A6). Lists the
   * repos accessible to `account` on the spawn-target node. NEVER carries a
   * token across the federation boundary (R11).
   */
  async listGitHubReposOnNode(
    nodeId: string,
    account: string
  ): Promise<
    | {
        type: "success";
        repos: Array<{
          nameWithOwner: string;
          name: string;
          description: string | null;
          isPrivate: boolean;
          pushedAt: string | null;
        }>;
      }
    | { type: "error"; message: string }
  > {
    return this.proxyToNode(nodeId, "/api/federation/github-repos", {
      account,
    });
  }

  /** Proxy recent-paths retrieval from a remote node. */
  async getRecentPathsOnNode(
    nodeId: string,
    namespace: string
  ): Promise<
    { type: "success"; paths: string[] } | { type: "error"; message: string }
  > {
    return this.proxyToNode(nodeId, "/api/federation/recent-paths", {
      namespace,
    });
  }

  /** Proxy add-recent-path to a remote node. */
  async addRecentPathOnNode(
    nodeId: string,
    namespace: string,
    path: string
  ): Promise<{ type: "success" } | { type: "error"; message: string }> {
    return this.proxyToNode(nodeId, "/api/federation/recent-paths/add", {
      namespace,
      path,
    });
  }

  /** Proxy remove-recent-path to a remote node. */
  async removeRecentPathOnNode(
    nodeId: string,
    namespace: string,
    path: string
  ): Promise<
    { type: "success"; removed: boolean } | { type: "error"; message: string }
  > {
    return this.proxyToNode(nodeId, "/api/federation/recent-paths/remove", {
      namespace,
      path,
    });
  }

  /** This node's own federation id (issue #3784: lets the chain-fingerprint
   *  aggregator mark which entry is self so the daemon excludes it). */
  getLocalNodeId(): string {
    return this.config.nodeId;
  }

  /**
   * Issue #3784: proxy an account's isolated chain-fingerprint read to a remote
   * node. Returns the node's sha256-hex fingerprint (or null when it owns no
   * isolated dir for the account). NEVER carries a raw refresh token across the
   * federation boundary — only its fingerprint.
   */
  async getAccountChainFingerprintOnNode(
    nodeId: string,
    accountUuid: string
  ): Promise<
    | { type: "success"; fingerprint: string | null }
    | { type: "error"; message: string }
  > {
    return this.proxyToNode(nodeId, "/api/federation/chain-fingerprint", {
      accountUuid,
    });
  }

  /**
   * Proxy set-active-account to a remote node (Sub-Issue F, #1452). #3982: like
   * `removeAccountOnNode` (below), this does NOT use `proxyToNode`, which collapses
   * every non-2xx into a code-less error — the receiver's structured 400
   * `provider_mismatch` / 404 `account_not_found` must reach the hub route
   * (routes/nodes.ts) so it answers the right status instead of 502.
   */
  async setActiveAccountOnNode(
    nodeId: string,
    accountUuid: string,
    // #3808 Task 4b: optional provider — set the remote node's PER-PROVIDER
    // default (absent ⇒ the Anthropic pointer). Only the uuid + provider cross
    // the boundary — never a token (R7).
    provider?: string
  ): Promise<
    { type: "success" } | { type: "error"; message: string; code?: string }
  > {
    const state = this.nodeStates.get(nodeId);
    if (!state || state.status === "offline") {
      return { type: "error", message: "Node is offline" };
    }
    const url = `${state.config.url}/api/federation/active-account`;
    try {
      const res = await this.fetchWithAuth(url, "POST", {
        accountUuid,
        ...(provider ? { provider } : {}),
      });
      if (!res.ok) {
        const body = await readPeerErrorBody(
          res,
          `active-account on ${state.config.id}`
        );
        return {
          type: "error",
          message:
            (body as Record<string, string>).error ??
            `Node returned ${res.status}`,
          code: (body as Record<string, string>).code,
        };
      }
      return { type: "success" };
    } catch (err) {
      return {
        type: "error",
        message: err instanceof Error ? err.message : "Request failed",
      };
    }
  }

  /**
   * Proxy account-credential REMOVAL to a remote node (issue #2054). Unlike the
   * active-account setters, this does NOT use `proxyToNode`: that helper collapses
   * every non-2xx receiver response into a generic `{ type:"error", message:"Node
   * returned <status>: <text>" }` and only JSON-parses 2xx bodies, stranding the
   * receiver's structured 409 `last_account` / 404 `account_not_found` codes.
   * Instead it copies the shipped structured-error idiom from `reconnectOnNode`
   * (#1778): parse the non-2xx body and surface its `code` across the federation
   * boundary so the hub route (routes/nodes.ts) can map it to the right HTTP
   * status. Only `accountUuid` crosses the boundary — never a token (R7).
   * Decision D2 pinned to structured-body propagation [expert-review 2026-07-02, D5].
   */
  async removeAccountOnNode(
    nodeId: string,
    accountUuid: string
  ): Promise<
    { type: "success" } | { type: "error"; message: string; code?: string }
  > {
    const state = this.nodeStates.get(nodeId);
    if (!state || state.status === "offline") {
      return { type: "error", message: "Node is offline" };
    }
    const url = `${state.config.url}/api/federation/remove-account`;
    try {
      const res = await this.fetchWithAuth(url, "POST", { accountUuid });
      if (!res.ok) {
        const body = await readPeerErrorBody(
          res,
          `remove-account on ${state.config.id}`
        );
        return {
          type: "error",
          message:
            (body as Record<string, string>).error ??
            `Node returned ${res.status}`,
          code: (body as Record<string, string>).code,
        };
      }
      return { type: "success" };
    } catch (err) {
      return {
        type: "error",
        message: err instanceof Error ? err.message : "Request failed",
      };
    }
  }

  /** Proxy get-active-account from a remote node (Sub-Issue F, #1452). #3808
   *  Task 4b: an optional provider reads the remote node's PER-PROVIDER default. */
  async getActiveAccountOnNode(
    nodeId: string,
    provider?: string
  ): Promise<
    | { type: "success"; account: RedactedAccount | null }
    | { type: "error"; message: string }
  > {
    return this.proxyToNode(
      nodeId,
      "/api/federation/active-account/current",
      provider ? { provider } : {}
    );
  }

  /**
   * Proxy a remote node's About payload — host identity + harness enumeration —
   * for the client `/api/about?nodeId=` route (issue #1984, Epic #1981 B3).
   * POST-only (`proxyToNode`) → the Task 6 receiver returns the
   * `{ type: "success", about }` envelope; models `getActiveAccountOnNode`.
   * Only the nodeId crosses the boundary; the owning node gathers its OWN About.
   */
  async getAboutForNode(
    nodeId: string
  ): Promise<
    { type: "success"; about: AboutInfo } | { type: "error"; message: string }
  > {
    return this.proxyToNode(nodeId, "/api/federation/about", {});
  }

  /**
   * Proxy set-max-concurrency to a remote node, then refresh that node's cached
   * info so the meter / Preferences reflect the new cap promptly (issue #1805,
   * R11) — mirrors the active-account proxy pattern (#1452). Only the numeric
   * cap crosses the federation boundary; the owning node resolves + clamps it
   * against ITS own settings.
   */
  async setMaxConcurrencyOnNode(
    nodeId: string,
    // #4417: `null` CLEARS the remote node's explicit cap (back to automatic). An older
    // peer rejects the null body with 400, so the clear fails visibly (nothing written).
    value: number | null
  ): Promise<{ type: "success" } | { type: "error"; message: string }> {
    const result = await this.proxyToNode<{ type: "success" }>(
      nodeId,
      "/api/federation/max-concurrency",
      { value }
    );
    if (result.type === "success") {
      // Fire-and-forget cache refresh (R11) — don't block the set on the poll.
      void this.pollNodeById(nodeId);
    }
    return result;
  }

  /** Proxy a remote node's per-account usage list (epic #1855, Sub-Issue C / #1858). */
  async getUsageOnNode(
    nodeId: string
  ): Promise<{ usage: AccountUsage[] } | { type: "error"; message: string }> {
    return this.proxyToNode(nodeId, "/api/federation/accounts/usage", {});
  }

  /**
   * Read a peer's provider auth state: Codex (OpenAI) logins + Gemini (Google)
   * derived state (issue #3806, epic #3345). Only DERIVED fields cross the wire,
   * never a token or key. [ER 2026-09-19: 3806-5]
   *
   * Classified by `readPeerRoute`, the reader `getAccountHealthOnNode` uses, so
   * a peer without the route reads `unsupported` and a 2xx that is not JSON
   * reads `malformed` here too (#5739). It used to go through the generic
   * `proxyToNode`, which returns a peer's 2xx body unchanged, so the aggregator
   * could not tell a peer's `{type, message}` body from the registry's own error.
   * An `ok` body is untrusted: the aggregator validates it as a row.
   */
  async getProviderAuthStateOnNode(nodeId: string): Promise<PeerReadOutcome> {
    return this.readPeerRoute(
      nodeId,
      "/api/federation/provider-auth-state",
      "Provider-auth-state"
    );
  }

  /**
   * Read a peer's per-node account health (issue #4461, epic #4460 A).
   *
   * Deliberately NOT `proxyToNode`, which collapses every failure into one error
   * string: the aggregator must tell an old peer from a broken one. Mirrors the
   * structured idiom of `removeAccountOnNode`:
   *   - registry already marks the node offline (or it is unknown) → `offline`,
   *     with no fetch;
   *   - HTTP 404, or HTTP 401 whose body is exactly `{"error":"Invalid token"}` →
   *     `unsupported`. A peer without the route never answers 404: the request
   *     falls through to its JWT middleware, which answers 401 "Invalid token"
   *     (`web/middleware/auth.ts`). A real federation-token mismatch is answered
   *     by the receiver itself with `{"error":"Unauthorized"}` and stays
   *     `unreachable`. Same rule as #4073's K13 (`needs_update`);
   *   - any other non-2xx, a throw, or the 10 s fetch timeout → `unreachable`,
   *     with a whitelisted `reason` for the row and a free-text `message` for the
   *     hub's log only (issue #5420);
   *   - 2xx → the row re-parsed one account entry at a time with the whitelist
   *     schemas (hub-side ingress parse, R4; `parseNodeAccountHealthPerEntry`), so
   *     one entry this build cannot read is dropped and counted, not the whole
   *     row. A body that is not JSON or not a row is `unreachable`/`malformed`.
   *
   * Every rule but the row parse lives in `readPeerRoute`, which
   * `getProviderAuthStateOnNode` shares (#5739).
   */
  async getAccountHealthOnNode(nodeId: string): Promise<
    | { kind: "ok"; row: NodeAccountHealth }
    | { kind: "offline" }
    | { kind: "unsupported" }
    | {
        kind: "unreachable";
        reason: NodeAccountHealthReason;
        message: string;
      }
  > {
    const outcome = await this.readPeerRoute(
      nodeId,
      "/api/federation/account-health",
      "Account-health"
    );
    if (outcome.kind !== "ok") return outcome;
    const row = parseNodeAccountHealthPerEntry(outcome.body);
    if (!row) {
      return {
        kind: "unreachable",
        reason: "malformed",
        message: "Malformed account-health row",
      };
    }
    return { kind: "ok", row };
  }

  /**
   * The hub's canonical identity for a tracked node, whatever its status (issue
   * #4461). `null` ONLY for an unknown id — #4462's `node_not_found` versus
   * `node_offline` gates depend on that distinction. Used to stamp the
   * `account_unrefreshable` 409 for a peer-owned session.
   */
  getNodeIdentity(
    nodeId: string
  ): { nodeId: string; nodeLabel: string } | null {
    const state = this.nodeStates.get(nodeId);
    if (!state) return null;
    return { nodeId: state.config.id, nodeLabel: state.config.label };
  }

  /**
   * Proxy a Codex (OpenAI) in-app login START to the owning node's #3807
   * receiver. POST-only (`proxyToNode`). The per-account codex dir lives on the
   * TARGET node (R4), so the login must run there. Only the login token + state
   * (+ device link/one-time code) cross back — never a key. The API key travels
   * in the (fed-token-authenticated) request body to the target node's driver
   * stdin. Unreachable → `{ type: "error" }` (the hub route maps it to 502).
   */
  async startOpenAiLoginOnNode(
    nodeId: string,
    body: { kind: "api-key" | "device-auth"; label?: string; key?: string }
  ): Promise<
    ApiKeyLoginResult | DeviceAuthResult | { type: "error"; message: string }
  > {
    return this.proxyToNode(nodeId, "/api/federation/openai-login/start", body);
  }

  /** Proxy a Codex device-auth login STATUS poll to the owning node (#3807). */
  async openAiLoginStatusOnNode(
    nodeId: string,
    loginToken: string
  ): Promise<DeviceAuthStatusResult | { type: "error"; message: string }> {
    return this.proxyToNode(nodeId, "/api/federation/openai-login/status", {
      loginToken,
    });
  }

  /** Proxy a Codex device-auth login CANCEL to the owning node (#3807). */
  async cancelOpenAiLoginOnNode(
    nodeId: string,
    loginToken: string
  ): Promise<{ cancelled: boolean } | { type: "error"; message: string }> {
    return this.proxyToNode(nodeId, "/api/federation/openai-login/cancel", {
      loginToken,
    });
  }

  /**
   * #5127: the state of the node that calls itself `nodeId` — its self-reported
   * `info.nodeId` from the last poll — falling back to the configured id. A key's
   * qualified ref names the home by its own node id, and this registry's name
   * for a peer can differ (`accountHealth.ts` keys nodes the same way).
   */
  private findNodeStateByIdentity(nodeId: string) {
    // Two peers claiming one identity: trust neither (security review F4) —
    // a peer could otherwise take another node's key calls.
    const claimed = [...this.nodeStates.values()].filter(
      state => state.info?.nodeId === nodeId
    );
    if (claimed.length > 1) return undefined;
    if (claimed.length === 1) return claimed[0];
    return this.nodeStates.get(nodeId);
  }

  /** #5127: true when `nodeId` names a node this registry tracks. */
  knowsNode(nodeId: string): boolean {
    return this.findNodeStateByIdentity(nodeId) !== undefined;
  }

  /** #5127: this registry's label for the node `nodeId`, or null when unknown. */
  nodeLabelForIdentity(nodeId: string): string | null {
    return this.findNodeStateByIdentity(nodeId)?.config.label ?? null;
  }

  /**
   * #5127: list the shared Anthropic keys of the node that calls itself
   * `homeNodeId` (redacted; no secret crosses).
   */
  async listSharedApiKeysOnNode(
    homeNodeId: string
  ): Promise<ApiKeyCallOutcome<FederationSharedApiKeys>> {
    // The Create-page picker waits for every peer's list, so a peer the last
    // poll saw online but that has since wedged gets the short notification
    // budget, not the full federation timeout (perf review M1).
    const outcome = await this.apiKeyCall(
      homeNodeId,
      "/api/federation/api-keys/shared",
      { requestingNodeId: this.config.nodeId },
      FederationSharedApiKeysSchema,
      NOTIFICATION_PROXY_TIMEOUT_MS
    );
    // The list must be the asked node's own (security review F4): the keys'
    // refs name their home by this id.
    if (outcome.kind === "ok") {
      const state = this.findNodeStateByIdentity(homeNodeId);
      const expected = state?.info?.nodeId ?? state?.config.id;
      if (outcome.value.homeNodeId !== expected) {
        return {
          kind: "error",
          message: "The node answered for a different node id",
        };
      }
    }
    return outcome;
  }

  /** #5127: confirm one shared key on its home node (identity only). */
  async resolveApiKeyOnNode(
    homeNodeId: string,
    body: Omit<FederationApiKeyRequest, "requestingNodeId" | "homeNodeId">
  ): Promise<ApiKeyCallOutcome<FederationApiKeyResolved>> {
    return this.apiKeyCall(
      homeNodeId,
      "/api/federation/api-keys/resolve",
      { ...body, homeNodeId, requestingNodeId: this.config.nodeId },
      FederationApiKeyResolvedSchema
    );
  }

  /**
   * #5127: fetch one shared key's secret from its home node. The caller holds
   * the returned key in memory only; it is never logged or written.
   */
  async fetchApiKeySecretOnNode(
    homeNodeId: string,
    body: Omit<FederationApiKeyRequest, "requestingNodeId" | "homeNodeId">
  ): Promise<ApiKeyCallOutcome<{ apiKey: string }>> {
    const outcome = await this.apiKeyCall(
      homeNodeId,
      "/api/federation/api-keys/secret",
      { ...body, homeNodeId, requestingNodeId: this.config.nodeId },
      FederationApiKeySecretSchema
    );
    return outcome.kind === "ok"
      ? { kind: "ok", value: { apiKey: outcome.value.apiKey } }
      : outcome;
  }

  /**
   * #5127: one structured shared-API-key call. Never `proxyToNode`, which
   * folds a peer's response text into its error message: here a response is
   * read only through the schema the caller names, an unexpected answer becomes
   * a fixed message, and no response text, request body or key reaches an error
   * or a log. The home is found by its self-reported node id; a node without the
   * capability, offline, or reached at a non-tailnet URL is refused before any
   * request is sent. Redirects fail rather than follow.
   */
  private async apiKeyCall<T>(
    homeNodeId: string,
    endpoint: string,
    body: unknown,
    schema: {
      safeParse(v: unknown): { success: true; data: T } | { success: false };
    },
    timeoutMs: number = FETCH_TIMEOUT_MS
  ): Promise<ApiKeyCallOutcome<T>> {
    const state = this.findNodeStateByIdentity(homeNodeId);
    if (!state) return { kind: "unknown_node" };
    if (state.status === "offline") return { kind: "offline" };
    if (!this.nodeSupports(state.config.id, SHARED_API_KEYS_CAPABILITY)) {
      return { kind: "unsupported" };
    }
    if (!(await this.homeUrlGuard(state.config.url))) {
      return { kind: "transport" };
    }
    let res: Response;
    try {
      res = await this.fetchWithAuth(
        `${state.config.url}${endpoint}`,
        "POST",
        body,
        timeoutMs,
        { "X-Hapi-Requesting-Node": this.config.nodeId },
        "error"
      );
    } catch (err) {
      // A timeout or a refused / unreachable connection means the home is
      // down, even before a poll has marked it offline. Anything else (a
      // refused redirect, a TLS failure) is an error with a fixed message.
      const name = err instanceof Error ? err.name : "";
      const code = (err as { code?: unknown } | null)?.code;
      return name === "TimeoutError" ||
        name === "AbortError" ||
        (typeof code === "string" && UNREACHABLE_CODES.has(code))
        ? { kind: "offline" }
        : { kind: "error", message: "The request to the home node failed" };
    }
    if (res.status === 404) return { kind: "unsupported" };
    if (res.status === 401) {
      return {
        kind: "error",
        message: "The home node refused this node's federation token",
      };
    }
    if (!res.ok) {
      return { kind: "error", message: `The home node answered ${res.status}` };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return {
        kind: "error",
        message: "The home node sent an unreadable answer",
      };
    }
    const refusal = FederationApiKeyRefusalSchema.safeParse(json);
    if (refusal.success) {
      return {
        kind: "refused",
        code: refusal.data.code,
        message: refusal.data.message,
      };
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) return { kind: "ok", value: parsed.data };
    return {
      kind: "error",
      message: "The home node sent an unexpected answer",
    };
  }

  /** True when the node's last polled `/federation/info` advertises `capability`. */
  nodeSupports(nodeId: string, capability: string): boolean {
    return (
      this.nodeStates.get(nodeId)?.info?.capabilities?.includes(capability) ??
      false
    );
  }

  /** #4462: the gate inputs for a node-targeted login; `null` for an unknown id. */
  getNodeLoginGate(nodeId: string): NodeLoginGate | null {
    const state = this.nodeStates.get(nodeId);
    if (!state) return null;
    return {
      nodeId: state.config.id,
      nodeLabel: state.config.label,
      online: state.status !== "offline",
      polled: state.info !== null,
      supportsAnthropicLogin:
        state.info?.capabilities?.includes(ANTHROPIC_LOGIN_CAPABILITY) ?? false,
    };
  }

  /**
   * #4462: run an Anthropic PKCE login START on the node that will store the
   * account (`/api/federation/anthropic-login/start`). PKCE generation is local
   * and fast, so the default per-peer timeout applies. Structured (not
   * `proxyToNode`) so the receiver's refusal `code` survives.
   */
  async startAnthropicLoginOnNode(
    nodeId: string
  ): Promise<AnthropicLoginProxyResult> {
    return this.anthropicLoginCall(
      nodeId,
      "/api/federation/anthropic-login/start",
      {},
      FETCH_TIMEOUT_MS
    );
  }

  /**
   * #4462: forward an Anthropic login COMPLETE to the node that ran `start` (its
   * PKCE pending map is per process). Waits {@link ANTHROPIC_LOGIN_COMPLETE_TIMEOUT_MS}
   * because the peer's token exchange can take 25 s; a timeout is reported as
   * `kind: "timeout"`, never as a failed login.
   */
  async completeAnthropicLoginOnNode(
    nodeId: string,
    body: { loginToken: string; code: string; state?: string },
    timeoutMs: number = ANTHROPIC_LOGIN_COMPLETE_TIMEOUT_MS
  ): Promise<AnthropicLoginProxyResult> {
    return this.anthropicLoginCall(
      nodeId,
      "/api/federation/anthropic-login/complete",
      body,
      timeoutMs
    );
  }

  private async anthropicLoginCall(
    nodeId: string,
    endpoint: string,
    body: unknown,
    timeoutMs: number
  ): Promise<AnthropicLoginProxyResult> {
    const state = this.nodeStates.get(nodeId);
    if (!state || state.status === "offline") {
      return { type: "error", kind: "offline", message: "Node is offline" };
    }
    try {
      const res = await this.fetchWithAuth(
        `${state.config.url}${endpoint}`,
        "POST",
        body,
        timeoutMs
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return {
          type: "error",
          kind: "http",
          status: res.status,
          message: `Node returned ${res.status}: ${text}`.slice(0, 500),
        };
      }
      return { type: "answer", body: await res.json() };
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      return {
        type: "error",
        kind:
          name === "TimeoutError" || name === "AbortError"
            ? "timeout"
            : "transport",
        message: err instanceof Error ? err.message : "Request failed",
      };
    }
  }

  /** Proxy node-global turn/session aggregates from a remote node (issue #1674, Sub L). */
  async getTurnAggregatesOnNode(
    nodeId: string,
    opts?: { fromMs?: number; toMs?: number; limit?: number }
  ): Promise<NodeTurnAggregates | { type: "error"; message: string }> {
    return this.proxyToNode(nodeId, "/api/federation/turn-aggregates", {
      fromMs: opts?.fromMs,
      toMs: opts?.toMs,
      limit: opts?.limit,
    });
  }

  /** Proxy a turn-ledger mirror feed page from a remote origin (issue #4614). POST-only. */
  async getTurnFeedOnNode(
    nodeId: string,
    opts: { cursor?: number; adjCursor?: number; limit?: number }
  ): Promise<TurnFeedPage | { type: "error"; message: string }> {
    return this.proxyToNode(nodeId, "/api/federation/turn-feed", {
      cursor: opts.cursor,
      adjCursor: opts.adjCursor,
      limit: opts.limit,
    });
  }

  /** Proxy a remote origin's turn-feed drift digest (issue #4614). POST-only. */
  async getTurnFeedDigestOnNode(
    nodeId: string
  ): Promise<TurnFeedDigest | { type: "error"; message: string }> {
    return this.proxyToNode(nodeId, "/api/federation/turn-feed/digest", {});
  }

  /**
   * Proxy a PM spawn-roster query to a remote node's #1936 receiver. POST-only —
   * the receiver returns this node's `NodePmSpawnRoster` for the queried PM. The
   * hub aggregator (`/api/federation/session-metadata/spawn-roster`) fans these in.
   * Offline / unreachable nodes resolve to the `{ type: "error" }` shape via
   * `proxyToNode` (graceful degradation). Models `getTurnAggregatesOnNode`.
   */
  async getSpawnRosterOnNode(
    nodeId: string,
    opts: { pmSessionId: string; status?: string }
  ): Promise<NodePmSpawnRoster | { type: "error"; message: string }> {
    return this.proxyToNode<NodePmSpawnRoster>(
      nodeId,
      "/api/federation/spawn-roster-query",
      { pmSessionId: opts.pmSessionId, status: opts.status }
    );
  }

  /**
   * Proxy a PM spawn-roster UPSERT to a remote node's #2010 receiver (Option B —
   * federation-aware WRITE). POST-only — the receiver writes the row to THAT
   * node's local roster and returns `{ record }`. Used by the spawn-roster POST
   * route when the spawn's nodeId is a remote node, so a cross-node spawn's row
   * lands on the spawned session's OWN node (where its finalize pmReconcileStep
   * reconciles it node-locally, surfaced to the hub via the federation aggregate).
   * Offline / unreachable nodes resolve to the `{ type: "error" }` shape via
   * `proxyToNode` (graceful degradation). Models `getSpawnRosterOnNode`.
   */
  async upsertSpawnRosterOnNode(
    nodeId: string,
    body: PmSpawnRosterUpsert
  ): Promise<
    { record: PmSpawnRosterRecord } | { type: "error"; message: string }
  > {
    return this.proxyToNode<{ record: PmSpawnRosterRecord }>(
      nodeId,
      "/api/federation/spawn-roster-upsert",
      body
    );
  }

  /**
   * Proxy a system-jobs LIST to a remote node's #1536 receiver (issue #1537,
   * epic #1534 ruling D1). POST-only — the receiver returns this node's
   * `ListJobsResult` verbatim. Offline / unreachable nodes resolve to the
   * `{ type: "error" }` shape via `proxyToNode` (graceful degradation, R2).
   */
  async listSystemJobsOnNode(
    nodeId: string
  ): Promise<ListJobsResult | { type: "error"; message: string }> {
    return this.proxyToNode<ListJobsResult>(
      nodeId,
      "/api/federation/system-jobs/list",
      {}
    );
  }

  /**
   * Proxy ONE system-jobs MUTATE verb to a remote node's #1536 receiver
   * (issue #1537). POST-only; the receiver re-validates the strict body and
   * returns its `MutateResult` verbatim. A service-level failure surfaces as the
   * `ok: false` branch of the union; a transport failure as `{ type: "error" }`.
   */
  async mutateSystemJobOnNode(
    nodeId: string,
    body: SystemJobMutateBody
  ): Promise<MutateResult | { type: "error"; message: string }> {
    return this.proxyToNode<MutateResult>(
      nodeId,
      "/api/federation/system-jobs/mutate",
      body
    );
  }

  /**
   * Proxy ONE loop-cron mutation to a remote node's #2453 receiver (Task 6).
   * POST-only; the receiver runs `loop-cron.sh` locally on the owning node and
   * returns its `LoopCronDispatchResult` verbatim (the receiver responds 200 even
   * for a service-level `ok:false` so the structured code + status survive the
   * federation boundary). A transport failure surfaces as `{ type: "error" }`.
   * There is deliberately NO summary proxy — the header badge is own-instance-only
   * by definition (R8), so a cross-node summary has no consumer.
   */
  async loopCronMutateOnNode(
    nodeId: string,
    body: LoopCronMutateBody
  ): Promise<LoopCronDispatchResult | { type: "error"; message: string }> {
    return this.proxyToNode<LoopCronDispatchResult>(
      nodeId,
      "/api/federation/system-jobs/loop-cron/mutate",
      body
    );
  }

  // ── Notifications (issue #4913) ─────────────────────────────────────────
  // Hub → peer proxies for the /api/notifications fan-out. Each forwards the
  // caller's namespace (the receivers fail closed without it, #1097) and uses a
  // short timeout because the gear badge polls the unread count.

  async listNotificationsOnNode(
    nodeId: string,
    namespace: string,
    body: { unreadOnly: boolean; limit: number; offset: number }
  ): Promise<{ notifications: StoredNotification[] } | NotificationProxyError> {
    return this.proxyToNodeAsCaller(
      nodeId,
      "/api/federation/notifications/list",
      body,
      namespace
    );
  }

  async countUnreadNotificationsOnNode(
    nodeId: string,
    namespace: string
  ): Promise<{ count: number } | NotificationProxyError> {
    return this.proxyToNodeAsCaller(
      nodeId,
      "/api/federation/notifications/unread-count",
      {},
      namespace
    );
  }

  async markNotificationReadOnNode(
    nodeId: string,
    namespace: string,
    id: string
  ): Promise<NotificationIdActionResult> {
    return this.notificationIdActionOnNode(nodeId, namespace, "read", id);
  }

  async dismissNotificationOnNode(
    nodeId: string,
    namespace: string,
    id: string
  ): Promise<NotificationIdActionResult> {
    return this.notificationIdActionOnNode(nodeId, namespace, "dismiss", id);
  }

  async dismissAllNotificationsOnNode(
    nodeId: string,
    namespace: string
  ): Promise<{ dismissed: number } | NotificationProxyError> {
    return this.proxyToNodeAsCaller(
      nodeId,
      "/api/federation/notifications/dismiss-all",
      {},
      namespace
    );
  }

  private async notificationIdActionOnNode(
    nodeId: string,
    namespace: string,
    verb: "read" | "dismiss",
    id: string
  ): Promise<NotificationIdActionResult> {
    const result = await this.proxyToNodeAsCaller<{
      notification: StoredNotification;
    }>(nodeId, `/api/federation/notifications/${verb}`, { id }, namespace);
    if ("notification" in result) return { notification: result.notification };
    // The receiver answers 404 only when the row is not in the caller's
    // namespace there; every other failure (timeout, 5xx, an older peer's 401)
    // stays an error so the hub never reports a missed write as "not found".
    if (result.status === 404) return { notFound: true };
    return { type: "error", message: result.message };
  }

  /**
   * POST `{}` to a peer's federation read route and classify the outcome (#5739,
   * extracted from #4461/#5420's `getAccountHealthOnNode`):
   *   - the registry already marks the node offline, or it is unknown →
   *     `offline`, with no fetch;
   *   - HTTP 404, or HTTP 401 whose body is exactly `{"error":"Invalid token"}`
   *     (the JWT middleware answering for a route the peer does not have) →
   *     `unsupported`;
   *   - any other non-2xx → `unreachable`, reason `auth` (401/403), `http_5xx` or
   *     `http_4xx`, message `Node returned <status>` with no body text;
   *   - a throw → `timeout` (`TimeoutError`) or `network`, with its error text;
   *   - a 2xx that is not JSON → `malformed`;
   *   - any other 2xx → `ok` with the parsed body, for the caller to validate.
   * `label` names the read in the malformed message.
   */
  private async readPeerRoute(
    nodeId: string,
    endpoint: string,
    label: string
  ): Promise<PeerReadOutcome> {
    const state = this.nodeStates.get(nodeId);
    if (!state || state.status === "offline") {
      return { kind: "offline" };
    }
    const url = `${state.config.url}${endpoint}`;
    let res: Response;
    try {
      res = await this.fetchWithAuth(url, "POST", {});
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      return {
        kind: "unreachable",
        reason: timedOut ? "timeout" : "network",
        message: err instanceof Error ? err.message : "Request failed",
      };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (
        res.status === 404 ||
        (res.status === 401 && isInvalidTokenBody(text))
      ) {
        return { kind: "unsupported" };
      }
      return {
        kind: "unreachable",
        reason:
          res.status === 401 || res.status === 403
            ? "auth"
            : res.status >= 500
              ? "http_5xx"
              : "http_4xx",
        message: `Node returned ${res.status}`,
      };
    }
    try {
      return { kind: "ok", body: await res.json() };
    } catch (err) {
      return {
        kind: "unreachable",
        reason: "malformed",
        message: `${label} body is not JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * `proxyToNode` with the caller's namespace forwarded as
   * `X-Hapi-Caller-Namespace` and a short timeout. Any non-2xx — including an
   * older peer without the route (401 "Invalid token", the #4461 K13 shape) —
   * resolves to the `{ type: "error" }` shape, carrying the HTTP `status`, so a
   * fan-out degrades instead of failing and a caller can tell 404 from the rest.
   */
  private async proxyToNodeAsCaller<T>(
    nodeId: string,
    endpoint: string,
    body: unknown,
    namespace: string
  ): Promise<T | NotificationProxyError> {
    const state = this.nodeStates.get(nodeId);
    if (!state || state.status === "offline") {
      return { type: "error", message: "Node is offline" };
    }
    try {
      const res = await this.fetchWithAuth(
        `${state.config.url}${endpoint}`,
        "POST",
        body,
        NOTIFICATION_PROXY_TIMEOUT_MS,
        { "X-Hapi-Caller-Namespace": namespace }
      );
      if (!res.ok) {
        return {
          type: "error",
          message: `Node returned ${res.status}`,
          status: res.status,
        };
      }
      return (await res.json()) as T;
    } catch (err) {
      return {
        type: "error",
        message: err instanceof Error ? err.message : "Request failed",
      };
    }
  }

  /** Generic proxy helper: POST JSON to a node's federation endpoint. */
  private async proxyToNode<T>(
    nodeId: string,
    endpoint: string,
    body: unknown
  ): Promise<T | { type: "error"; message: string }> {
    const state = this.nodeStates.get(nodeId);
    if (!state || state.status === "offline") {
      return { type: "error", message: "Node is offline" };
    }

    const url = `${state.config.url}${endpoint}`;
    try {
      const res = await this.fetchWithAuth(url, "POST", body);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return {
          type: "error",
          message: `Node returned ${res.status}: ${text}`,
        };
      }
      return (await res.json()) as T;
    } catch (err) {
      return {
        type: "error",
        message: err instanceof Error ? err.message : "Request failed",
      };
    }
  }

  /** Get node status summaries for the web client. */
  getNodeSummaries(): Array<{
    nodeId: string;
    nodeLabel: string;
    status: FederationNodeStatus;
    url: string;
    sessionCount: number;
    platform?: string;
    capabilities?: string[];
    // Issue #2533: node's advertised home dir — seeds the Create page's
    // Directory field for a remote target. Undefined for stale peers.
    homeDir?: string;
    // #1805: per-machine spawn capacity forwarded from the polled
    // /federation/info. Undefined when the peer runs stale code (pre-#1805) or
    // its daemon capacity is unknown — the web meter degrades to "—".
    effectiveCount?: number;
    maxConcurrent?: number;
    // #4417: the warn-at count + which resolver layer set the peer's cap.
    // Optional — a pre-#4417 peer omits them → the hub shows no warn threshold
    // and reports the source as "remote" (fail-open).
    recommendedConcurrent?: number;
    capSource?: DaemonCapSource;
  }> {
    return Array.from(this.nodeStates.values()).map(s => ({
      nodeId: s.config.id,
      nodeLabel: s.config.label,
      status: s.status,
      url: s.config.url,
      sessionCount: s.info?.sessionCount ?? 0,
      platform: s.info?.platform,
      capabilities: s.info?.capabilities,
      homeDir: s.info?.homeDir,
      effectiveCount: s.info?.effectiveCount,
      maxConcurrent: s.info?.maxConcurrent,
      recommendedConcurrent: s.info?.recommendedConcurrent,
      capSource: s.info?.capSource,
    }));
  }

  /**
   * Rapidly poll a node until a specific session shows as active.
   * Used after reconnect to quickly discover when the CLI process connects.
   * Polls every 2s for up to 60s, stopping early once the session is active.
   * The longer window (60s) accommodates slower nodes like Raspberry Pis
   * where CLI spawn can take 30+ seconds.
   */
  private async rapidPollUntilActive(
    nodeConfig: FederationNodeConfig,
    sessionId: string
  ): Promise<void> {
    const RAPID_POLL_INTERVAL = 2000;
    const RAPID_POLL_MAX_DURATION = 60_000;
    const start = Date.now();

    while (Date.now() - start < RAPID_POLL_MAX_DURATION) {
      await new Promise(r => setTimeout(r, RAPID_POLL_INTERVAL));
      await this.pollNode(nodeConfig);

      // Check if the session is now genuinely active from the polled data
      const cached = this.sessionCache.get(nodeConfig.id);
      const session = cached?.sessions.find(s => s.id === sessionId);
      if (session?.active) {
        return; // Session is active — stop rapid polling
      }
    }
  }

  /**
   * Merge dynamically discovered peers from PeerStore into the remote nodes
   * list and node states map. New peers get added; existing peers are unchanged.
   */
  private refreshDynamicPeers(): void {
    if (!this.peerStore) return;

    const dynamicPeers = this.peerStore.getOnline();
    for (const peer of dynamicPeers) {
      if (peer.id === this.config.nodeId) continue; // Skip self
      if (this.nodeStates.has(peer.id)) continue; // Already tracked

      // Enforce MAX_PEERS capacity
      if (this.remoteNodes.length >= MAX_PEERS) {
        console.warn(
          `[Federation] MAX_PEERS (${MAX_PEERS}) reached — skipping dynamic peer ${peer.label} (${peer.id})`
        );
        break;
      }

      const nodeConfig: FederationNodeConfig = {
        id: peer.id,
        url: peer.url,
        // Casing rule (epic #3285 round 11) at the DYNAMIC-peer entry point too.
        label: displayNodeLabel(peer.label, { url: peer.url }),
      };
      this.remoteNodes.push(nodeConfig);
      this.nodeStates.set(peer.id, {
        config: nodeConfig,
        status: "offline",
        info: null,
        lastSuccessfulPoll: null,
        lastError: null,
        consecutiveFailures: 0,
      });

      // Connect event bridge for the new peer
      if (this.eventBridgeSseManager) {
        this.connectNodeEventBridge(nodeConfig);
      }
    }
  }

  /**
   * Rebuild the `interestingSessions` Set from the current session cache.
   * Delegates to the exported `isSessionInteresting()` pure function.
   */
  private rebuildInterestingSessions(): void {
    const ownNodeId = this.config.nodeId;
    const next = new Set<string>();
    for (const cached of this.sessionCache.values()) {
      for (const s of cached.sessions) {
        if (isSessionInteresting(s, ownNodeId)) {
          next.add(s.id);
        }
      }
    }

    // Log stats from the previous cycle before resetting
    if (this.bridgeStats.forwarded > 0 || this.bridgeStats.filtered > 0) {
      console.log(
        `[Federation] Event bridge stats: ${this.bridgeStats.forwarded} forwarded, ${this.bridgeStats.filtered} filtered (${next.size} interesting sessions)`
      );
    }
    this.bridgeStats = { forwarded: 0, filtered: 0 };

    this.interestingSessions = next;
  }

  /**
   * Determine whether an SSE event from a remote node should be forwarded.
   * Delegates to the exported `shouldForwardBridgeEvent()` pure function.
   */
  private shouldForwardEvent(event: SyncEvent): boolean {
    return shouldForwardBridgeEvent(
      event,
      this.interestingSessions,
      this.sessionCache,
      this.config.nodeId
    );
  }

  /**
   * Poll all configured nodes concurrently, skipping those in backoff.
   *
   * #3456: this is the GUARDED entry point — it coalesces overlapping sweeps
   * (the periodic `SupervisedLoop` tick and a forced sweep) onto one in-flight
   * pass. A tick that lands mid-forced-sweep reuses the in-flight promise
   * instead of running a second `pollNode` per node (which would double-count
   * `consecutiveFailures` and re-set backoff). The actual work is `sweepOnce()`.
   */
  private async pollAllNodes(): Promise<void> {
    if (this.sweepInFlight) return this.sweepInFlight;
    this.sweepInFlight = this.sweepOnce().finally(() => {
      this.sweepInFlight = null;
    });
    return this.sweepInFlight;
  }

  /**
   * One federation poll sweep: refresh dynamic peers, poll every node not in
   * backoff, then rebuild the interesting-sessions set. Callers go through the
   * guarded `pollAllNodes()`; `forcePoll()` (#3456) clears the backoff map first
   * so this sweep skips nobody.
   */
  private async sweepOnce(): Promise<void> {
    // Merge any newly discovered peers before polling
    this.refreshDynamicPeers();

    const now = Date.now();
    const polls = this.remoteNodes
      .filter(node => {
        const until = this.pollBackoffUntil.get(node.id);
        return !until || now >= until;
      })
      .map(node => this.pollNode(node));
    await Promise.allSettled(polls);

    // Rebuild the interesting sessions Set after all polls complete
    this.rebuildInterestingSessions();
  }

  /** Poll a single remote node for info and sessions.
   *  [perf] issue #2147: `trigger` attributes which poll first discovered a new
   *  session (periodic|spawn-accept|spawn-status|force|rapid) so the
   *  hub-visibility stamp is not misattributed to Quick Win #1 when a sibling
   *  poll (#3456 forcePoll / #3457 announcement) coincidentally discovers it. */
  private async pollNode(
    nodeConfig: FederationNodeConfig,
    trigger = "periodic"
  ): Promise<void> {
    const state = this.nodeStates.get(nodeConfig.id);
    if (!state) return;

    try {
      // Fetch node info, sessions, and (R4) the claim snapshot concurrently.
      // fetchNodeClaims never throws (returns null on any failure) so a peer
      // without the #1969 route — or a transient claims error — never fails the
      // whole poll: sessions poll normally (R7, augment-not-replace).
      const [info, sessionsResponse, claimsResponse] = await Promise.all([
        this.fetchNodeInfo(nodeConfig),
        this.fetchNodeSessions(nodeConfig),
        this.fetchNodeClaims(nodeConfig),
      ]);

      // Mark sessions with federation origin
      const sessions: SessionSummary[] = (
        sessionsResponse.sessions as SessionSummary[]
      ).map(s => ({
        ...s,
        nodeId: nodeConfig.id,
        nodeLabel: nodeConfig.label,
      }));

      // Update state — success
      state.info = info;
      state.status = "online";
      state.lastSuccessfulPoll = Date.now();
      state.lastError = null;

      // Reset backoff on success
      if (
        state.consecutiveFailures > 0 ||
        this.pollBackoffUntil.has(nodeConfig.id)
      ) {
        if (this.pollBackoffUntil.has(nodeConfig.id)) {
          console.log(
            `[Federation] Poll backoff reset for ${nodeConfig.id} — node is responding again`
          );
        }
        this.pollBackoffUntil.delete(nodeConfig.id);
      }
      state.consecutiveFailures = 0;

      // Restart event bridge if it was suspended during offline period.
      // The bridge stops reconnecting when consecutiveFailures >= OFFLINE_THRESHOLD
      // (see scheduleEventBridgeReconnect, which releases the suspended run's
      // controller entry precisely so this gate can open), so we restart it
      // here on recovery.
      if (
        this.eventBridgeSseManager &&
        !this.eventBridgeAbortControllers.has(nodeConfig.id)
      ) {
        this.connectNodeEventBridge(nodeConfig);
      }

      // [perf] issue #2147 stage (f): capture the prior session-id set BEFORE the
      // cache overwrite so a newly-discovered session can be logged — this is the
      // hub-visibility moment (join with the spawnOnNode dispatch stamp for the lag).
      const perfPrevIds = new Set(
        (this.sessionCache.get(nodeConfig.id)?.sessions ?? []).map(s => s.id)
      );

      // Update session cache
      this.sessionCache.set(nodeConfig.id, {
        nodeId: nodeConfig.id,
        nodeLabel: nodeConfig.label,
        sessions,
        fetchedAt: Date.now(),
      });

      // [perf] issue #2147 stage (f): log any session id newly appearing for this
      // node — the moment the hub first sees a spawned session, tagged with the
      // poll `trigger` that discovered it. (Quick Win #1 adds a `session-added`
      // SSE nudge inside this same new-id block — see Task 4.)
      for (const s of sessions) {
        if (!perfPrevIds.has(s.id)) {
          console.log(
            `[perf][spawn] stage=hub-visibility node=${nodeConfig.id} key=${s.id} trigger=${trigger} active=${s.active ?? false}`
          );
          // [#2147 Quick Win #1] Broadcast a session-added nudge for each newly
          // discovered remote session. pollNode replaces sessionCache wholesale
          // and otherwise broadcasts NOTHING, and the remote's own bridged
          // session-added arrives BEFORE the hub has cached the session
          // (cache-miss → forwarded), so the client's federated-sessions refetch
          // on that event misses. Emitting here — for EVERY poll trigger, not
          // just spawn-status — is what carries the hub's discovery to the
          // browser within one SSE cycle instead of waiting for an incidental
          // event or the 30s client backstop. Mirrors the local analogue in
          // web/routes/machines.ts. This AUGMENTS the periodic poll; it does not
          // change when the hub itself discovers the session (Fallback Preservation).
          this.eventBridgeSseManager?.broadcast({
            type: "session-added",
            sessionId: s.id,
          });
        }
      }

      // #1969 (R4): anti-entropy — reconcile any claim delta dropped during a
      // bridge disconnect. Only on the poll SUCCESS path (augments, never
      // replaces, the session fetch). null = peer lacks the route / transient
      // error → skip; mergeSnapshot re-validates + applies the monotonic guard.
      if (claimsResponse) {
        this.fileClaimSync?.mergeSnapshot(claimsResponse);
      }
    } catch (err) {
      // Update state — failure
      state.consecutiveFailures += 1;
      state.lastError =
        err instanceof Error ? err.message : "Unknown fetch error";

      if (
        state.consecutiveFailures >= this.evictionThreshold &&
        !this.staticNodeIds.has(nodeConfig.id)
      ) {
        // Dynamic peer exceeded eviction threshold — remove from mesh
        this.evictPeer(nodeConfig.id);
      } else if (state.consecutiveFailures >= OFFLINE_THRESHOLD) {
        // #1969 (R6): EDGE-TRIGGERED drop — this branch re-runs on EVERY failed
        // poll once failures >= OFFLINE_THRESHOLD, so drop the peer's replica
        // ONLY on the transition INTO offline (guard on the prior status). A
        // fresh snapshot re-populates it when the peer recovers (poll or bridge).
        if (state.status !== "offline") {
          this.fileClaimSync?.dropNode(nodeConfig.id);
        }
        state.status = "offline";

        // Apply exponential backoff once past the offline threshold
        const delay = getPollBackoffDelay(state.consecutiveFailures);
        this.pollBackoffUntil.set(nodeConfig.id, Date.now() + delay);

        console.warn(
          `[Federation] Poll failed for ${nodeConfig.id} (${state.consecutiveFailures} failures), backing off ${Math.round(delay / 1000)}s: ${state.lastError}`
        );
      } else {
        state.status = "degraded";
        console.warn(
          `[Federation] Poll failed for ${nodeConfig.id} (${state.consecutiveFailures} failures): ${state.lastError}`
        );
      }
    }
  }

  /** Fetch /api/federation/info from a remote node. */
  private async fetchNodeInfo(
    nodeConfig: FederationNodeConfig
  ): Promise<FederationNodeInfo> {
    const url = `${nodeConfig.url}/api/federation/info`;
    const res = await this.fetchWithAuth(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    const body = (await res.json()) as { node: FederationNodeInfo };
    return body.node;
  }

  /** Fetch /api/federation/sessions from a remote node. */
  private async fetchNodeSessions(
    nodeConfig: FederationNodeConfig
  ): Promise<{ sessions: unknown[] }> {
    const url = `${nodeConfig.url}/api/federation/sessions`;
    const res = await this.fetchWithAuth(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    return (await res.json()) as { sessions: unknown[] };
  }

  /**
   * #1969 (R4): fetch a peer's live-claim snapshot for anti-entropy. Returns
   * null on ANY failure (an old peer without the route → 404/503, a network
   * error, or a malformed body) so a claims failure never fails the whole poll
   * (R4/R7 — augments, never replaces, the session fetch). The caller merges the
   * result iff non-null; `mergeSnapshot` re-validates the body.
   */
  private async fetchNodeClaims(
    nodeConfig: FederationNodeConfig
  ): Promise<FileClaimSyncSnapshot | null> {
    try {
      const url = `${nodeConfig.url}/api/federation/claims`;
      const res = await this.fetchWithAuth(url);
      if (!res.ok) return null;
      return (await res.json()) as FileClaimSyncSnapshot;
    } catch {
      return null;
    }
  }

  /**
   * Delete a session on a remote node via its federation API.
   *
   * #3815: the error result carries the peer's HTTP `status` (a 409 means the
   * session is still active) and `offline` when the node is down, so a bulk
   * caller can attribute each outcome. `deferPoll` skips the per-call re-poll
   * so a bulk caller can coalesce to ONE `pollNodeById` per touched node.
   *
   * #5240: the caller's namespace is forwarded; the receiver answers 404 for
   * a session another namespace owns (#1097).
   */
  async deleteOnNode(
    nodeId: string,
    sessionId: string,
    namespace: string,
    options?: { deferPoll?: boolean }
  ): Promise<{ ok: true } | RemoteSessionActionError> {
    const state = this.nodeStates.get(nodeId);
    if (!state || state.status === "offline") {
      return { type: "error", message: "Node is offline", offline: true };
    }

    const url = `${state.config.url}/api/federation/sessions/${encodeURIComponent(sessionId)}`;
    try {
      const res = await this.fetchWithAuth(
        url,
        "DELETE",
        undefined,
        undefined,
        {
          "X-Hapi-Caller-Namespace": namespace,
        }
      );
      if (!res.ok) {
        const body = await readPeerErrorBody(
          res,
          `delete on ${state.config.id}`
        );
        return {
          type: "error",
          message:
            (body as Record<string, string>).error ??
            `Node returned ${res.status}`,
          status: res.status,
        };
      }
      // Immediately remove from cache so client queries reflect the deletion
      this.evictSessionFromCache(sessionId);
      if (options?.deferPoll) {
        return { ok: true };
      }
      // Fire-and-forget re-poll — don't block the response
      void this.pollNode(state.config).catch(err => {
        console.warn(
          `[Federation] Background poll failed after delete on ${state.config.id}:`,
          err
        );
      });
      return { ok: true };
    } catch (err) {
      return {
        type: "error",
        message: err instanceof Error ? err.message : "Delete request failed",
      };
    }
  }

  /**
   * #3815: stop the running turn of one session on its owning node through the
   * EXISTING peer receiver `POST /api/federation/sessions/:id/abort`. Unlike the
   * single-session route's bare-`fetch` fallback this carries the registry's
   * timeout, so one half-dead node cannot hold a bulk fan-out open.
   */
  async abortOnNode(
    nodeId: string,
    sessionId: string,
    namespace: string
  ): Promise<{ ok: true } | RemoteSessionActionError> {
    return this.postSessionActionOnNode(nodeId, sessionId, "abort", namespace);
  }

  /**
   * #3815: disconnect (archive) one session on its owning node through the
   * EXISTING peer receiver `POST /api/federation/sessions/:id/archive`, marking
   * the cached copy inactive on success (as the single-session route does).
   * NOTE: the receiver answers `{ ok: true }` even when its kill RPC failed, so
   * an `ok` here cannot prove the process died.
   */
  async archiveOnNode(
    nodeId: string,
    sessionId: string,
    namespace: string
  ): Promise<{ ok: true } | RemoteSessionActionError> {
    const result = await this.postSessionActionOnNode(
      nodeId,
      sessionId,
      "archive",
      namespace
    );
    if ("ok" in result) {
      this.markSessionInactive(sessionId);
    }
    return result;
  }

  /**
   * #3815 (ruling D2): how many prompts are still queued on a remote session,
   * via the EXISTING `GET /api/federation/sessions/:id/queue`. That receiver
   * re-asserts the caller's namespace, so the header is forwarded. Returns
   * null when the count cannot be read — never throws.
   */
  async getQueuedCountOnNode(
    nodeId: string,
    sessionId: string,
    namespace: string
  ): Promise<number | null> {
    const state = this.nodeStates.get(nodeId);
    if (!state || state.status === "offline") return null;
    const url = `${state.config.url}/api/federation/sessions/${encodeURIComponent(sessionId)}/queue`;
    try {
      const res = await this.fetchWithAuth(url, "GET", undefined, undefined, {
        "X-Hapi-Caller-Namespace": namespace,
      });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as {
        messages?: unknown;
      } | null;
      return Array.isArray(body?.messages) ? body.messages.length : null;
    } catch {
      return null;
    }
  }

  private async postSessionActionOnNode(
    nodeId: string,
    sessionId: string,
    action: "abort" | "archive",
    namespace: string
  ): Promise<{ ok: true } | RemoteSessionActionError> {
    const state = this.nodeStates.get(nodeId);
    if (!state || state.status === "offline") {
      return { type: "error", message: "Node is offline", offline: true };
    }
    const url = `${state.config.url}/api/federation/sessions/${encodeURIComponent(sessionId)}/${action}`;
    try {
      // The receivers re-assert this namespace and answer 404 for a session
      // another namespace owns (#1097, #5240).
      const res = await this.fetchWithAuth(url, "POST", {}, undefined, {
        "X-Hapi-Caller-Namespace": namespace,
      });
      if (!res.ok) {
        const body = await readPeerErrorBody(
          res,
          `${action} on ${state.config.id}`
        );
        return {
          type: "error",
          message:
            (body as Record<string, string>).error ??
            `Node returned ${res.status}`,
          status: res.status,
        };
      }
      return { ok: true };
    } catch (err) {
      return {
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : `Remote ${action} request failed`,
      };
    }
  }

  /** Fetch with optional bearer token auth and timeout. */
  private async fetchWithAuth(
    url: string,
    method: "GET" | "POST" | "DELETE" = "GET",
    body?: unknown,
    timeoutMs: number = FETCH_TIMEOUT_MS,
    extraHeaders?: Record<string, string>,
    redirect?: "follow" | "error" | "manual"
  ): Promise<Response> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.apiToken) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    return await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      // #5127: only the shared-API-key calls pass `redirect` ("error"); every
      // other caller keeps fetch's default.
      ...(redirect !== undefined ? { redirect } : {}),
    });
  }
}
