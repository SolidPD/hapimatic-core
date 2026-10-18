// SPDX-License-Identifier: AGPL-3.0-only
import type { SyncEngine } from "../sync/syncEngine";
import type { PaymentMethodTarget } from "../sync/accountRestart";
import type { NodeRegistry } from "../federation/nodeRegistry";
import { resolveLocalNodeIdentity } from "../config/nodeLabel";
import {
  federationReadSignal,
  isFetchTransportError,
  readProxyJson,
} from "../federation/proxyFetchSignal";
import type { ErrorLogger } from "../logging/errorLogger";
import type {
  McpBatchSnapshot,
  McpToggleResponse,
  SetModelResponse,
  SetPermissionModeResponse,
  SessionTokenStatsResponse,
  SessionView,
  SessionWorkflowStateResponse,
  UiCollapseState,
} from "@hapi/protocol/types";
import type {
  AgentTranscriptQuery,
  ApplySessionConfig,
  AuthBinding,
  CeilingGuardConfigPatch,
  ClaudeAccountInfo,
  RelaunchRequest,
} from "@hapi/protocol/schemas";
import type { QueuedMessageEnqueueResult, StoredQueuedMessage } from "../store";
import {
  agentTranscriptPage,
  type AgentTranscriptPageResult,
} from "../sync/transcript/agentTranscriptPage";
import { getKnownSecretLiterals } from "./knownSecretLiterals";
import {
  localOrProxyMutation,
  EMOJI_MUTATION,
  LINKED_ISSUE_MUTATION,
  PARENT_MUTATION,
  NEEDS_REVIEW_OVERRIDE_MUTATION,
  AUTO_RECOVER_MUTATION,
  UI_COLLAPSE_STATE_MUTATION,
  NOTES_MUTATION,
  VIEW_MUTATION,
  PROMPT_DRAFT_MUTATION,
  RENAME_MUTATION,
  CEILING_OVERRIDE_MUTATION,
} from "../web/routes/sessionMutationHandlers";
import type {
  SessionMutationResult,
  ProxyResult,
  MutationContext,
} from "../web/routes/sessionMutationHandlers";

// Issue #2082: the field-mutation types + generic now live in the shared
// `sessionMutationHandlers` module. Re-exported here so the many existing
// importers of `SessionMutationResult` from this module keep working.
export type { SessionMutationResult };

export type QueueEnqueueServiceResult =
  | {
      type: "success";
      result: "inserted" | "deduplicated";
      row: StoredQueuedMessage;
    }
  | { type: "not-found" }
  | { type: "error"; message: string; status: number };

export type QueueListServiceResult =
  | { type: "success"; messages: StoredQueuedMessage[] }
  | { type: "not-found" }
  | { type: "error"; message: string; status: number };

export type QueueUpdateServiceResult =
  | { type: "success"; row: StoredQueuedMessage }
  | { type: "not-found" }
  | { type: "error"; message: string; status: number };

export type QueueClearServiceResult =
  | { type: "success"; count: number }
  | { type: "not-found" }
  | { type: "error"; message: string; status: number };

export type QueueDrainServiceResult =
  | { type: "success"; sent: boolean; remaining: number }
  | { type: "not-found" }
  | { type: "error"; message: string; status: number };

/**
 * Result of SessionService.switchAccount (issue #1456, Sub-Issue J). Mirrors
 * the discriminated shape used by rename/notes; the route maps it to HTTP.
 */
export type SwitchAccountServiceResult =
  // `staged` (issue #3633): true when the session was DISCONNECTED and the
  // account was staged for the next reconnect rather than switched live.
  | { type: "success"; accountEmail: string; staged?: boolean }
  | { type: "not-found" }
  | {
      type: "error";
      message: string;
      status: number;
      code: string;
      // Issue #4461 (R6): set ONLY for `account_unrefreshable` — the node whose
      // store refused (hub-canonical for a peer-owned session) and the target.
      nodeId?: string;
      nodeLabel?: string;
      accountUuid?: string;
    };

/**
 * Issue #4823: result of SessionService.switchPaymentMethod — the account variants
 * of {@link SwitchAccountServiceResult} plus a key success, which names the key
 * by its display label only (never key material).
 */
export type SwitchPaymentMethodServiceResult =
  | SwitchAccountServiceResult
  | { type: "success"; apiKeyLabel: string; staged?: boolean };

/** Map a SyncEngine.switchAccount error code to an HTTP status (issue #1456). */
function switchAccountCodeToStatus(code: string | undefined): number {
  switch (code) {
    // Issue #4823: `api_key_not_found` — the key id is not an Anthropic entry in
    // the owning node's vault.
    case "session_not_found":
    case "account_not_found":
    case "api_key_not_found":
      return 404;
    // Issue #4823: a key target the session cannot take — a non-SDK (or
    // unrecorded) launcher, local mode, a non-Claude agent, or a session owned by
    // another node (keys are node-local). Refused BEFORE any kill: a conflict with
    // the session's state, not a server fault.
    case "api_key_launcher_unsupported":
    case "api_key_local_mode_unsupported":
    case "api_key_agent_unsupported":
    case "api_key_remote_unsupported":
      return 409;
    // Issue #2299: `at_capacity` (pre-kill pre-check failed — instance at capacity
    // and this session's own slot is not creditable) joins the 409 group. Distinct
    // from the generic switch_failed_* codes: the session was NOT killed, so 409
    // (capacity conflict, retryable) rather than 500. #2300 maps it client-side.
    // `stage_failed` (issue #3633): a staged-write failure on a disconnected
    // session is a conflict, not a 5xx — triageable and distinct from a crash.
    case "not_active":
    case "account_unrefreshable":
    case "no_change":
    case "at_capacity":
    case "switch_failed_rolled_back":
    case "switch_failed_rollback_failed":
    case "stage_failed":
      return 409;
    default:
      return 500;
  }
}

/**
 * Result of SessionService.relaunch (issue #2149). Mirrors
 * SwitchAccountServiceResult; the route maps it to HTTP.
 */
export type RelaunchServiceResult =
  | { type: "success" }
  | { type: "not-found" }
  | { type: "error"; message: string; status: number; code: string };

/** Map a SessionRelaunch error code to an HTTP status (issue #2149). */
function relaunchCodeToStatus(code: string | undefined): number {
  switch (code) {
    case "not_found":
      return 404;
    // Issue #4568 (SF-3): the same 400 the spawn route returns for a key session.
    case "api_key_launcher_unsupported":
      return 400;
    case "not_active":
    case "not_claude":
    case "missing_metadata":
    case "relaunch_failed_rolled_back":
      return 409;
    case "relaunch_and_rollback_failed":
      return 502;
    default:
      return 500;
  }
}

/**
 * Serialize a validated AgentTranscriptQuery into a URL query string (issue
 * #4387). Forwards EVERY defined key rather than naming `limit`/`before` one by
 * one, so #4388's `after=<seq>:<byteOffset>` live-tail and #4386's `full=1`
 * cut-entry read cross the federation proxy unchanged. (`null`-valued keys are
 * never produced by AgentTranscriptQuerySchema; the guard is defensive.)
 */
function serializeAgentTranscriptQuery(query: AgentTranscriptQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }
  return params.toString();
}

/**
 * SessionService — client-API mutation facade.
 *
 * AUDIENCE: routes that handle requests from the LOCAL CLIENT (web UI / mobile app).
 *           These routes may target a session owned by any peer in the federation,
 *           so SessionService transparently proxies to the owning peer when the
 *           session isn't local, and updates the local NodeRegistry cache after
 *           a successful local mutation so all clients see fresh data within ~10s.
 *
 * NOT FOR: routes under server/src/web/routes/federation/. Those are the
 *          peer-incoming RPC surface — the proxy has already happened on the
 *          calling peer's side, so the request is always local. Federation routes
 *          call engine.* directly by design. See server/CLAUDE.md.
 */
export class SessionService {
  private readonly engine: SyncEngine;
  private readonly registry: NodeRegistry | null;
  private readonly apiToken: string | null;
  private readonly localNode: () => { nodeId: string; nodeLabel: string };
  private readonly errorLogger: ErrorLogger | null;

  constructor(
    engine: SyncEngine,
    registry: NodeRegistry | null,
    apiToken: string | null,
    // Issue #4461 (R6): THIS node's identity for an account_unrefreshable stamp.
    // Optional: absent ⇒ the non-federated identity (`LOCAL_NODE_ID`).
    localNode?: () => { nodeId: string; nodeLabel: string },
    // Issue #5408: logs a failed peer proxy. Optional: absent ⇒ console only.
    errorLogger?: ErrorLogger | null
  ) {
    this.engine = engine;
    this.registry = registry;
    this.apiToken = apiToken;
    this.localNode = localNode ?? (() => resolveLocalNodeIdentity(null));
    this.errorLogger = errorLogger ?? null;
  }

  /**
   * Issue #4461 (R6): the identity of the node whose store refused an
   * `account_unrefreshable` switch, or `{}` for every other code so its body
   * stays byte-identical. A peer-owned session's node comes from the hub's
   * registry (never the peer's body — the proxy forwards only error/code).
   */
  private refusalStamp(
    code: string | undefined,
    accountUuid: string | undefined,
    // `null` = this node; otherwise the peer that owns the session.
    nodeId: string | null
  ): { nodeId?: string; nodeLabel?: string; accountUuid?: string } {
    if (code !== "account_unrefreshable") return {};
    const identity =
      nodeId === null
        ? this.localNode()
        : (this.registry?.getNodeIdentity(nodeId) ?? {
            nodeId,
            nodeLabel: nodeId,
          });
    return accountUuid ? { ...identity, accountUuid } : identity;
  }

  private async proxyToNode(
    sessionId: string,
    pathSuffix: string,
    method: string,
    namespace: string,
    body?: unknown
  ): Promise<ProxyResult> {
    if (!this.registry) {
      return { type: "not-found" };
    }

    const node = this.registry.findNodeForSession(sessionId);
    if (!node) {
      return { type: "not-found" };
    }
    return this.proxyToResolvedNode(
      node,
      sessionId,
      pathSuffix,
      method,
      namespace,
      body
    );
  }

  /**
   * The send half of {@link proxyToNode}, for a node already resolved. Issue
   * #4461: `switchPaymentMethod` resolves the node ONCE and keeps it, so an
   * `account_unrefreshable` refusal is stamped with the node that answered — a
   * second lookup after the call could miss a node that just went offline.
   */
  private async proxyToResolvedNode(
    node: { nodeId: string; url: string },
    sessionId: string,
    pathSuffix: string,
    method: string,
    namespace: string,
    body?: unknown
  ): Promise<ProxyResult> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // Issue #1097: forward the caller's JWT namespace so the receiver can
      // re-assert namespace ownership (federation token authenticates the
      // peer node, not the user).
      "X-Hapi-Caller-Namespace": namespace,
    };
    if (this.apiToken) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }

    try {
      const url = `${node.url}/api/federation/sessions/${encodeURIComponent(sessionId)}${pathSuffix}`;
      const resp = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        // #5375: bound READ-ONLY proxies only. A timed-out mutation may already
        // have been applied on the peer (duplicate risk) — tracked in #3627.
        signal: method === "GET" ? federationReadSignal() : undefined,
      });

      // #5375/#5408: readProxyJson returns null for an empty body, and a bare
      // null made the `.error` read below throw and masked the peer's real
      // status as a transport failure. `?? {}` restores the intended
      // empty-object fallback.
      // readProxyJson rethrows a body read cut off by the GET timeout or a
      // connection reset mid-body, and an unparseable OK body (#5408), so each
      // reaches the catch below instead of reading as an empty success.
      if (resp.ok) {
        const data = (await readProxyJson(resp)) ?? {};
        return {
          type: "success",
          data: data as Record<string, unknown>,
        };
      }

      const errBody = (await readProxyJson(resp)) ?? {};
      const message =
        (errBody as { error?: string }).error ??
        `Remote node returned ${resp.status}`;
      // Issue #2300 (Task 8, R4): thread the peer's error `code` (e.g.
      // "at_capacity" / "account_unrefreshable") so a federated (peer-owned)
      // session's coded failure reaches the hub client instead of collapsing to
      // "transport_failed" at the switchAccount stamp below. Absent on a genuine
      // transport fault (the catch below leaves code undefined).
      const code = (errBody as { code?: string }).code;
      return {
        type: "error",
        message,
        status: resp.status,
        ...(typeof code === "string" ? { code } : {}),
      };
    } catch (error) {
      // Both branches leave `code` undefined: switchPaymentMethod maps that to
      // "transport_failed" and refusalStamp stamps only account_unrefreshable
      // (#4461 / #2300).
      if (isFetchTransportError(error)) {
        this.logProxyFailure("warn", error, node, method, pathSuffix, 502);
        return {
          type: "error",
          message: "Remote node unreachable",
          status: 502,
        };
      }
      // #5404/#5408: not a transport failure (a malformed node URL, an
      // unparseable OK body, a bug) — never dressed up as an unreachable node.
      this.logProxyFailure("error", error, node, method, pathSuffix, 500);
      return {
        type: "error",
        message: "Federation proxy failed",
        status: 500,
      };
    }
  }

  /**
   * Issue #5408: log a failed peer proxy in the same category / stack /
   * context shape as the routes' proxyTransportFailure (no user agent; the
   * path is templated so the session id is never logged, and no body is).
   */
  private logProxyFailure(
    severity: "warn" | "error",
    error: unknown,
    node: { nodeId: string },
    method: string,
    pathSuffix: string,
    statusCode: number
  ): void {
    const detail = error instanceof Error ? error.message : String(error);
    const message =
      severity === "warn"
        ? `federation proxy: peer unreachable (${detail})`
        : `federation proxy: request failed (${detail})`;
    if (!this.errorLogger) {
      const log = severity === "warn" ? console.warn : console.error;
      log("[federation]", message, { nodeId: node.nodeId });
      return;
    }
    const rawCode = (error as { code?: unknown } | null)?.code;
    const code =
      typeof rawCode === "string"
        ? rawCode
        : ((error as { name?: unknown } | null)?.name ?? null);
    this.errorLogger[severity](message, {
      category: "federation",
      stack: error instanceof Error ? error.stack : null,
      requestMethod: method,
      requestPath: `/api/federation/sessions/:id${pathSuffix}`,
      statusCode,
      context: { nodeId: node.nodeId, code },
    });
  }

  private isLocalSession(sessionId: string): boolean {
    return this.engine.getSession(sessionId) !== undefined;
  }

  /**
   * Issue #2082: build the injected context for the shared field-mutation
   * generic. `proxyToNode` stays private to this class (it is also used by
   * mcpToggle / switchAccount / setMcpDesired / the token-stats + queue
   * methods); binding it keeps ONE proxy implementation with the #1097
   * caller-namespace header.
   */
  private mutationContext(): MutationContext {
    return {
      engine: this.engine,
      registry: this.registry,
      proxy: this.proxyToNode.bind(this),
    };
  }

  /**
   * Toggle an MCP server on the session. Issue #1077. Delivers an
   * mcp_toggle SDK control_request via the active Claude Query in remote
   * mode; local-mode sessions receive a 501-shaped rejection.
   */
  async mcpToggle(
    sessionId: string,
    serverName: string,
    enabled: boolean,
    namespace: string
  ): Promise<McpToggleResponse> {
    if (this.isLocalSession(sessionId)) {
      try {
        return await this.engine.mcpToggle(sessionId, serverName, enabled);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: "transport_failed",
        };
      }
    }

    const result = await this.proxyToNode(
      sessionId,
      "/mcp-toggle",
      "POST",
      namespace,
      { serverName, enabled }
    );
    if (result.type === "success") {
      // The owning node's response already matches the McpToggleResponse
      // shape — forward it verbatim so callers see the original method/code.
      return result.data as unknown as McpToggleResponse;
    }
    if (result.type === "not-found") {
      return {
        ok: false,
        error: "Session not found",
        code: "session_not_found",
      };
    }
    return { ok: false, error: result.message, code: "transport_failed" };
  }

  /**
   * Set the session model family/mode (issue #2256). Mirrors mcpToggle: local
   * sessions go through engine.setModel; federated sessions proxy to the owning
   * node's POST /federation/sessions/:id/set-model. There is no local-mode 501
   * branch — the runClaude "set-model" handler exists on every launcher class
   * and degrades to method:"config" when no live query is present.
   */
  async setModel(
    sessionId: string,
    modelMode: string,
    namespace: string
  ): Promise<SetModelResponse> {
    if (this.isLocalSession(sessionId)) {
      try {
        return await this.engine.setModel(sessionId, modelMode);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: "transport_failed",
        };
      }
    }

    const result = await this.proxyToNode(
      sessionId,
      "/set-model",
      "POST",
      namespace,
      { modelMode }
    );
    if (result.type === "success") {
      // The owning node's response already matches the SetModelResponse shape —
      // forward it verbatim so callers see the original method/applied/code.
      return result.data as unknown as SetModelResponse;
    }
    if (result.type === "not-found") {
      return {
        ok: false,
        error: "Session not found",
        code: "session_not_found",
      };
    }
    return { ok: false, error: result.message, code: "transport_failed" };
  }

  /**
   * Set the session permission mode (issue #2346). Mirrors mcpToggle: local
   * sessions go through engine.setPermissionMode; federated sessions proxy to the
   * owning node's POST /federation/sessions/:id/set-permission-mode. Unlike
   * set-model this KEEPS the 501 local_mode_not_supported branch — the handler is
   * launcher-registered per-flavor, so a non-sdk / local-mode session rejects
   * rather than degrading to a durable pin.
   */
  async setPermissionMode(
    sessionId: string,
    mode: string,
    namespace: string
  ): Promise<SetPermissionModeResponse> {
    if (this.isLocalSession(sessionId)) {
      try {
        return await this.engine.setPermissionMode(sessionId, mode);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: "transport_failed",
        };
      }
    }

    const result = await this.proxyToNode(
      sessionId,
      "/set-permission-mode",
      "POST",
      namespace,
      { mode }
    );
    if (result.type === "success") {
      // The owning node's response already matches SetPermissionModeResponse —
      // forward it verbatim so callers see the original method/code.
      return result.data as unknown as SetPermissionModeResponse;
    }
    if (result.type === "not-found") {
      return {
        ok: false,
        error: "Session not found",
        code: "session_not_found",
      };
    }
    // Preserve a federated local-mode rejection so it still maps to 501 (the
    // #2300 code-threading; mcp-toggle predates it and collapses this edge to
    // transport_failed — set-permission-mode does better).
    if (result.code === "local_mode_not_supported") {
      return {
        ok: false,
        error: result.message,
        code: "local_mode_not_supported",
      };
    }
    return { ok: false, error: result.message, code: "transport_failed" };
  }

  /**
   * Switch the Anthropic account bound to a session (issue #1456, Sub-Issue J).
   * Local sessions go through engine.switchAccount; federated sessions proxy to
   * the owning node's POST /federation/sessions/:id/account (mirrors mcpToggle).
   */
  async switchAccount(
    sessionId: string,
    accountUuid: string,
    namespace: string,
    // Issue #2299 (Task 4): the client request's abort signal, threaded to the
    // engine so a client disconnect cancels the bounded pre-kill wait. Only the
    // LOCAL path forwards it; a proxied federated switch re-derives its own signal
    // from the owning node's incoming request.
    signal?: AbortSignal
  ): Promise<SwitchAccountServiceResult> {
    // Issue #4823: the account-only entry point, kept for every existing caller.
    const result = await this.switchPaymentMethod(
      sessionId,
      { kind: "account", accountUuid },
      namespace,
      signal
    );
    if (result.type === "success" && !("accountEmail" in result)) {
      // Unreachable: an account target only ever produces an account success.
      return {
        type: "error",
        message: "Unexpected switch result",
        status: 500,
        code: "unknown",
      };
    }
    return result;
  }

  /**
   * Issue #4823: switch (or stage) a session's payment method — a subscription
   * account or a node-vault Anthropic API key. Local → the engine's one
   * validation / persistence / rollback body. Remote → an ACCOUNT target is
   * proxied to the owning node exactly as before; a KEY target is refused here
   * with `api_key_remote_unsupported` before any proxy, because a node's vault is
   * node-local and unsynced (#1996) — a key id can never cross the federation.
   */
  async switchPaymentMethod(
    sessionId: string,
    target: PaymentMethodTarget,
    namespace: string,
    signal?: AbortSignal
  ): Promise<SwitchPaymentMethodServiceResult> {
    if (this.isLocalSession(sessionId)) {
      const result = await this.engine.switchPaymentMethod(
        sessionId,
        target,
        signal
      );
      if (result.type === "success") {
        // issue #3633: thread `staged` so the route can answer
        // { restartRequired: false, staged: true } for a disconnected session.
        const staged = "staged" in result ? result.staged : undefined;
        return result.paymentMethod === "account"
          ? { type: "success", accountEmail: result.accountEmail, staged }
          : { type: "success", apiKeyLabel: result.apiKeyLabel, staged };
      }
      return {
        type: "error",
        message: result.message,
        status: switchAccountCodeToStatus(result.code),
        code: result.code ?? "unknown",
        ...this.refusalStamp(
          result.code,
          target.kind === "account" ? target.accountUuid : undefined,
          null
        ),
      };
    }

    if (target.kind === "api-key") {
      // A session this node does not own: refuse a key target before any proxy.
      // An unknown session stays a 404 (no existence leak beyond the account path).
      if (!this.registry?.findNodeForSession(sessionId)) {
        return { type: "not-found" };
      }
      return {
        type: "error",
        message:
          "API keys are node-local — switch to an API key from the node that owns this session",
        status: switchAccountCodeToStatus("api_key_remote_unsupported"),
        code: "api_key_remote_unsupported",
      };
    }

    // Issue #4461 (R6): resolve the owning node once and keep it for the stamp.
    const node = this.registry?.findNodeForSession(sessionId) ?? null;
    if (!node) {
      return { type: "not-found" };
    }
    const result = await this.proxyToResolvedNode(
      node,
      sessionId,
      "/account",
      "POST",
      namespace,
      { accountUuid: target.accountUuid }
    );
    if (result.type === "success") {
      // Issue #1517 (R6): the owning node persisted the switch locally; update
      // the HUB's NodeRegistry cache for this peer-owned session so all clients
      // see the new account immediately (not ~10s later at the next poll).
      // Issue #4823: thread the receiver's `authBinding` so a key→account switch
      // of a peer-owned key session stops naming the key in the hub cache.
      const data = result.data as {
        accountEmail?: string;
        accountUuid?: string;
        claudeAccount?: ClaudeAccountInfo;
        authBinding?: AuthBinding;
      };
      if (data.accountUuid && data.claudeAccount) {
        this.registry?.updateCachedSessionAccount(
          sessionId,
          data.accountUuid,
          data.claudeAccount,
          data.authBinding
        );
      }
      return { type: "success", accountEmail: data.accountEmail ?? "" };
    }
    if (result.type === "not-found") {
      return { type: "not-found" };
    }
    return {
      type: "error",
      message: result.message,
      status: result.status,
      // Issue #2300 (Task 8): prefer the peer's threaded code (e.g.
      // "at_capacity") so a federated switch failure surfaces its real reason;
      // fall back to "transport_failed" for a genuine transport fault
      // (proxyToNode's catch leaves result.code undefined).
      code: result.code ?? "transport_failed",
      ...this.refusalStamp(result.code, target.accountUuid, node.nodeId),
    };
  }

  /**
   * Issue #2149: relaunch a session with new spawn-frozen params (launcher /
   * safeMode). Local → engine.relaunchSession. Remote → proxy to the owning node,
   * then EVICT the hub's cached session so the next poll fetches fresh state — a
   * relaunch mutates several fields at once, so evict + repoll beats adding N new
   * cache-updater methods (server/CLAUDE.md "Federation Development Rules", R6).
   */
  async relaunch(
    sessionId: string,
    overrides: RelaunchRequest,
    namespace: string
  ): Promise<RelaunchServiceResult> {
    if (this.isLocalSession(sessionId)) {
      const result = await this.engine.relaunchSession(sessionId, overrides);
      if (result.type === "success") return { type: "success" };
      return {
        type: "error",
        message: result.message,
        status: relaunchCodeToStatus(result.code),
        code: result.code ?? "unknown",
      };
    }

    const result = await this.proxyToNode(
      sessionId,
      "/relaunch",
      "POST",
      namespace,
      overrides
    );
    if (result.type === "success") {
      this.registry?.evictSessionFromCache(sessionId);
      return { type: "success" };
    }
    if (result.type === "not-found") return { type: "not-found" };
    return {
      type: "error",
      message: result.message,
      status: result.status,
      code: "transport_failed",
    };
  }

  /**
   * Issue #3083: apply a §4.2 live-plane config change (permission-mode / model /
   * effort / raw-model) to a session that may be owned by a remote federation node.
   * Local → engine.applySessionConfig (which itself routes an ACTIVE session to the
   * config RPC and a DISCONNECTED session to stageSessionConfig — round-11, #3285).
   * Remote → proxy to the owning node, then update the hub's cached SessionSummary
   * IN PLACE (ruling A-D4; never evict — the Edit-session-params modal applies fields
   * as sequential awaited calls and an evicted entry 404s the next one until the poll).
   */
  async applySessionConfig(
    sessionId: string,
    config: ApplySessionConfig,
    namespace: string
  ): Promise<SessionMutationResult> {
    if (this.isLocalSession(sessionId)) {
      try {
        // Issue #3769 (Task 1d): thread the live-apply method to the route.
        const { method } = await this.engine.applySessionConfig(
          sessionId,
          config
        );
        return { type: "success", method };
      } catch (err) {
        return {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
          status: 409,
        };
      }
    }

    const result = await this.proxyToNode(
      sessionId,
      "/apply-config",
      "POST",
      namespace,
      config
    );
    if (result.type === "success") {
      // Ruling A-D4: update the hub cache in place after a successful proxy, never
      // evict — keeps the session resolvable for the modal's next sequential call.
      this.registry?.updateCachedSessionConfig(sessionId, config);
      // Issue #3769 (Task 1d): forward the owning node's live-apply method
      // additively (an old peer omits it → "config").
      const method: "sdk" | "config" =
        (result.data as { method?: "sdk" | "config" } | undefined)?.method ===
        "sdk"
          ? "sdk"
          : "config";
      return { type: "success", method };
    }
    if (result.type === "not-found") return { type: "not-found" };
    return {
      type: "error",
      message: result.message,
      status: result.status,
    };
  }

  /**
   * Server-side MCP batch coordinator entry point (issue #989 follow-up).
   * For local sessions, delegate to the engine. For federated sessions,
   * proxy to the owning node — the worker loop runs there, and progress
   * events are forwarded over the federation event bridge.
   */
  async setMcpDesired(
    sessionId: string,
    desired: Record<string, boolean>,
    namespace: string
  ): Promise<
    | { type: "success"; snapshot: McpBatchSnapshot }
    | { type: "not-found" }
    | { type: "error"; message: string; status: number }
  > {
    if (this.isLocalSession(sessionId)) {
      const snapshot = this.engine.setMcpDesired(sessionId, desired);
      return { type: "success", snapshot };
    }

    const result = await this.proxyToNode(
      sessionId,
      "/mcp-set-desired",
      "POST",
      namespace,
      { desired }
    );
    if (result.type === "success") {
      return {
        type: "success",
        snapshot: (result.data as { snapshot: McpBatchSnapshot }).snapshot,
      };
    }
    return result;
  }

  async getMcpBatchState(
    sessionId: string,
    namespace: string
  ): Promise<
    | { type: "success"; snapshot: McpBatchSnapshot | null }
    | { type: "not-found" }
    | { type: "error"; message: string; status: number }
  > {
    if (this.isLocalSession(sessionId)) {
      return {
        type: "success",
        snapshot: this.engine.getMcpBatchState(sessionId),
      };
    }

    const result = await this.proxyToNode(
      sessionId,
      "/mcp-batch-state",
      "GET",
      namespace
    );
    if (result.type === "success") {
      const data = result.data as { snapshot: McpBatchSnapshot | null };
      return { type: "success", snapshot: data.snapshot ?? null };
    }
    return result;
  }

  /**
   * Session token stats (issue #1671, epic #1662 Sub I). Local sessions read the
   * authoritative `v_session_totals` + per-turn breakdown directly; federated
   * sessions proxy the GET to the owning node (mirrors getMcpBatchState). The
   * web client falls back to its own aggregate (R7) when this returns
   * not-found / error.
   */
  async getSessionTokenStats(
    sessionId: string,
    namespace: string
  ): Promise<
    | { type: "success"; data: SessionTokenStatsResponse }
    | { type: "not-found" }
    | { type: "error"; message: string; status: number }
  > {
    if (this.isLocalSession(sessionId)) {
      return {
        type: "success",
        data: this.engine.getSessionTokenStats(sessionId),
      };
    }

    const result = await this.proxyToNode(
      sessionId,
      "/token-stats",
      "GET",
      namespace
    );
    if (result.type === "success") {
      return {
        type: "success",
        data: result.data as unknown as SessionTokenStatsResponse,
      };
    }
    return result;
  }

  /**
   * Session workflow-state (issue #1672, epic #1662 Sub J). Local sessions read
   * the `v_workflow_state` badge + per-turn label events directly; federated
   * sessions proxy the GET to the owning node (mirrors getSessionTokenStats). The
   * web client renders nothing (R7) when this returns not-found / error.
   */
  async getSessionWorkflowState(
    sessionId: string,
    namespace: string
  ): Promise<
    | { type: "success"; data: SessionWorkflowStateResponse }
    | { type: "not-found" }
    | { type: "error"; message: string; status: number }
  > {
    if (this.isLocalSession(sessionId)) {
      return {
        type: "success",
        data: this.engine.getSessionWorkflowState(sessionId),
      };
    }

    const result = await this.proxyToNode(
      sessionId,
      "/workflow-state",
      "GET",
      namespace
    );
    if (result.type === "success") {
      return {
        type: "success",
        data: result.data as unknown as SessionWorkflowStateResponse,
      };
    }
    return result;
  }

  /**
   * Background-agent peek page (issue #4387, R3). Local sessions read #4386's
   * on-disk pager directly (the owning node redacts before anything crosses);
   * federated sessions proxy the GET to the owning node's receiver (mirrors
   * getSessionTokenStats). The WHOLE validated query is forwarded unchanged —
   * `limit`, `before`, `after`, `full` — so #4388's `after` live-tail and
   * #4386's `full=1&limit=1&after=<seq-1>:0` cut-entry read cross the hub
   * untouched; `AgentPeek` (R5) renders an unavailable sentinel on a 404 /
   * not-supported from an older peer.
   */
  async getAgentTranscriptPage(
    sessionId: string,
    agentId: string,
    query: AgentTranscriptQuery,
    namespace: string
  ): Promise<
    | { type: "success"; data: AgentTranscriptPageResult }
    | { type: "not-found" }
    | { type: "error"; message: string; status: number }
  > {
    if (this.isLocalSession(sessionId)) {
      const paths = this.engine.getAgentTranscriptPaths(sessionId);
      if (!paths) {
        return { type: "not-found" };
      }
      const result = await agentTranscriptPage({
        subagentsDir: paths.subagentsDir,
        ccSessionId: paths.ccSessionId,
        agentId,
        query: {
          limit: query.limit,
          before: query.before,
          after: query.after,
          full: query.full === "1",
        },
        literals: getKnownSecretLiterals({ ownToken: null }),
      });
      if (!result.ok) {
        return { type: "error", message: result.error, status: result.status };
      }
      return { type: "success", data: result.page };
    }

    const qs = serializeAgentTranscriptQuery(query);
    const result = await this.proxyToNode(
      sessionId,
      `/background-agents/${encodeURIComponent(agentId)}/transcript${qs ? `?${qs}` : ""}`,
      "GET",
      namespace
    );
    if (result.type === "success") {
      return {
        type: "success",
        data: result.data as unknown as AgentTranscriptPageResult,
      };
    }
    return result;
  }

  async updateEmoji(
    sessionId: string,
    emoji: string | null,
    namespace: string
  ): Promise<SessionMutationResult> {
    return localOrProxyMutation(
      this.mutationContext(),
      EMOJI_MUTATION,
      sessionId,
      emoji,
      namespace
    );
  }

  async updateLinkedIssue(
    sessionId: string,
    linkedIssue: {
      number: number;
      title: string;
      repo: string;
      state?: "open" | "closed";
    } | null,
    namespace: string
  ): Promise<SessionMutationResult> {
    // Issue #1584 duplicate-active-link 409 pre-check is encoded in the
    // descriptor's preHook (LINKED_ISSUE_MUTATION) — see sessionMutationHandlers.
    return localOrProxyMutation(
      this.mutationContext(),
      LINKED_ISSUE_MUTATION,
      sessionId,
      linkedIssue,
      namespace
    );
  }

  /**
   * Issue #2862 (Fix 1): retroactively stamp a session's managed-peer parent
   * link (federation-aware), mirroring {@link updateLinkedIssue}. `parentSessionId`
   * is resolved uuid-then-tag by the CALLER (the hub route, layer 1) before this
   * runs, so the RESOLVED uuid is forwarded to the owning peer (expert-review
   * 2862-5: applyLocal on the peer cannot resolve a parent it may not know).
   */
  async updateParent(
    sessionId: string,
    parent: { parentSessionId: string; parentRelationship: "spawn" },
    namespace: string
  ): Promise<SessionMutationResult> {
    return localOrProxyMutation(
      this.mutationContext(),
      PARENT_MUTATION,
      sessionId,
      parent,
      namespace
    );
  }

  async updateNeedsReviewOverride(
    sessionId: string,
    override: "read" | "unread" | null,
    namespace: string
  ): Promise<SessionMutationResult> {
    return localOrProxyMutation(
      this.mutationContext(),
      NEEDS_REVIEW_OVERRIDE_MUTATION,
      sessionId,
      override,
      namespace
    );
  }

  async updateAutoRecoverFromApiError(
    sessionId: string,
    autoRecover: boolean | null,
    namespace: string
  ): Promise<SessionMutationResult> {
    return localOrProxyMutation(
      this.mutationContext(),
      AUTO_RECOVER_MUTATION,
      sessionId,
      autoRecover,
      namespace
    );
  }

  /**
   * Issue #1905: set or clear a session's per-session runaway-guard ceiling
   * override (federation-aware), mirroring {@link updateAutoRecoverFromApiError}.
   * Local sessions mutate via the engine; a federated session proxies to the
   * owning node's `PUT /federation/sessions/:id/ceiling-override` receiver.
   */
  async updateCeilingOverride(
    sessionId: string,
    value: CeilingGuardConfigPatch | null,
    namespace: string
  ): Promise<SessionMutationResult> {
    return localOrProxyMutation(
      this.mutationContext(),
      CEILING_OVERRIDE_MUTATION,
      sessionId,
      value,
      namespace
    );
  }

  async updateUiCollapseState(
    sessionId: string,
    uiCollapseState: UiCollapseState | null,
    namespace: string
  ): Promise<SessionMutationResult> {
    return localOrProxyMutation(
      this.mutationContext(),
      UI_COLLAPSE_STATE_MUTATION,
      sessionId,
      uiCollapseState,
      namespace
    );
  }

  async updateNotes(
    sessionId: string,
    notes: string | null,
    namespace: string
  ): Promise<SessionMutationResult> {
    return localOrProxyMutation(
      this.mutationContext(),
      NOTES_MUTATION,
      sessionId,
      notes,
      namespace
    );
  }

  async updateView(
    sessionId: string,
    view: SessionView | null,
    namespace: string
  ): Promise<SessionMutationResult> {
    return localOrProxyMutation(
      this.mutationContext(),
      VIEW_MUTATION,
      sessionId,
      view,
      namespace
    );
  }

  async updatePromptDraft(
    sessionId: string,
    promptDraft: string | null,
    namespace: string
  ): Promise<SessionMutationResult> {
    return localOrProxyMutation(
      this.mutationContext(),
      PROMPT_DRAFT_MUTATION,
      sessionId,
      promptDraft,
      namespace
    );
  }

  async rename(
    sessionId: string,
    name: string,
    options: { skipTmuxSync?: boolean } | undefined,
    namespace: string
  ): Promise<SessionMutationResult> {
    return localOrProxyMutation(
      this.mutationContext(),
      RENAME_MUTATION,
      sessionId,
      { name, options },
      namespace
    );
  }

  // ── Issue #1325: server-backed message queue ──────────────────────
  // Queue mutations DO NOT update NodeRegistry cache. Per directive Task 13,
  // queue contents are not cached at the hub; clients refetch via SSE-driven
  // `queue-changed` events. SessionService's role here is the standard
  // local-vs-proxy fallback only.

  async enqueueMessage(
    sessionId: string,
    namespace: string,
    body: string,
    clientGeneratedId?: string | null
  ): Promise<QueueEnqueueServiceResult> {
    if (this.isLocalSession(sessionId)) {
      const enqueued: QueuedMessageEnqueueResult =
        this.engine.enqueueQueuedMessage({
          sessionId,
          namespace,
          body,
          clientGeneratedId,
        });
      return {
        type: "success",
        result: enqueued.result,
        row: enqueued.row,
      };
    }

    const result = await this.proxyToNode(
      sessionId,
      "/queue/enqueue",
      "POST",
      namespace,
      { body, clientGeneratedId }
    );
    if (result.type === "success") {
      const data = result.data as {
        result: "inserted" | "deduplicated";
        row: StoredQueuedMessage;
      };
      return { type: "success", result: data.result, row: data.row };
    }
    return result;
  }

  async listQueuedMessages(
    sessionId: string,
    namespace: string
  ): Promise<QueueListServiceResult> {
    if (this.isLocalSession(sessionId)) {
      const messages = this.engine.listQueuedMessages(sessionId, namespace);
      return { type: "success", messages };
    }

    const result = await this.proxyToNode(
      sessionId,
      "/queue",
      "GET",
      namespace
    );
    if (result.type === "success") {
      const data = result.data as { messages: StoredQueuedMessage[] };
      return { type: "success", messages: data.messages ?? [] };
    }
    return result;
  }

  async updateQueuedMessageAt(
    sessionId: string,
    namespace: string,
    position: number,
    body: string
  ): Promise<QueueUpdateServiceResult> {
    if (this.isLocalSession(sessionId)) {
      const row = this.engine.updateQueuedMessageAt(
        sessionId,
        namespace,
        position,
        body
      );
      if (!row) {
        return { type: "not-found" };
      }
      return { type: "success", row };
    }

    const result = await this.proxyToNode(
      sessionId,
      `/queue/${encodeURIComponent(String(position))}`,
      "PATCH",
      namespace,
      { body }
    );
    if (result.type === "success") {
      const data = result.data as { row: StoredQueuedMessage };
      return { type: "success", row: data.row };
    }
    return result;
  }

  async removeQueuedMessageAt(
    sessionId: string,
    namespace: string,
    position: number
  ): Promise<SessionMutationResult> {
    if (this.isLocalSession(sessionId)) {
      const removed = this.engine.removeQueuedMessageAt(
        sessionId,
        namespace,
        position
      );
      return removed ? { type: "success" } : { type: "not-found" };
    }

    const result = await this.proxyToNode(
      sessionId,
      `/queue/${encodeURIComponent(String(position))}`,
      "DELETE",
      namespace
    );
    return result.type === "success" ? { type: "success" } : result;
  }

  async clearQueuedMessages(
    sessionId: string,
    namespace: string
  ): Promise<QueueClearServiceResult> {
    if (this.isLocalSession(sessionId)) {
      const count = this.engine.clearQueuedMessages(sessionId, namespace);
      return { type: "success", count };
    }

    const result = await this.proxyToNode(
      sessionId,
      "/queue",
      "DELETE",
      namespace
    );
    if (result.type === "success") {
      const data = result.data as { count: number };
      return { type: "success", count: data.count ?? 0 };
    }
    return result;
  }

  /**
   * Issue #1325 / Task 17 — manual drain of the head message.
   *
   * Server-atomic equivalent of the old "Send Queue" client path:
   * pops the head and dispatches it. Same idempotency guarantees as the
   * observer-driven drain (localId = row.id).
   */
  async drainQueueHead(
    sessionId: string,
    namespace: string
  ): Promise<QueueDrainServiceResult> {
    if (this.isLocalSession(sessionId)) {
      const result = await this.engine.drainQueueHead(sessionId, namespace);
      return {
        type: "success",
        sent: result.sent,
        remaining: result.remaining,
      };
    }

    const result = await this.proxyToNode(
      sessionId,
      "/queue/drain",
      "POST",
      namespace
    );
    if (result.type === "success") {
      const data = result.data as { sent: boolean; remaining: number };
      return {
        type: "success",
        sent: data.sent ?? false,
        remaining: data.remaining ?? 0,
      };
    }
    return result;
  }
}
