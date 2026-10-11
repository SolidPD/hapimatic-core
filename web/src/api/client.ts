// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- Grandfathered god-file (Epic 0, #2077); decomposition verdict tracked in claudedocs/architecture-hotspot-review.md. */
import type {
  ExistingBranch,
  GitBranchListing,
} from "@hapi/protocol/gitBranches";
import { errorReporter } from "@/lib/error-reporter";
import type {
  AddApiKeyRequest,
  AutoRecoverPreference,
  AutoSelectOptimalAccountPreference,
  AutoSwitchOnRateLimitPreference,
  ChatSectionsPreference,
  DefaultOutputStylePreference,
  FederationSettingPatch,
  FederationSettingsView,
  OpenRouterFavorites,
  OpenRouterModel,
  CreateSessionDefaults,
  CreateSessionPreferences,
  RedactedApiKey,
  RelaunchRequest,
  AgentTranscriptPage,
  SearchFilterPreferences,
  TranscriptFilterOptions,
  TranscriptListQuery,
  TranscriptListResponse,
  TranscriptMessagesResponse,
  TranscriptResumeResponse,
  DaemonCapSource,
} from "@hapi/protocol/schemas";
import type { QueuedMessage, SessionView } from "@hapi/protocol/types";
import type { ClaudeRemoteLauncherKind } from "@hapi/protocol/launcherResolver";
import type {
  AboutInfo,
  FeedbackRequest,
  FeedbackResponse,
  ClaudeModelsResponse,
  EffortLevel,
  FederationHealthAggregate,
  FederationNodeHealthDetail,
  FederationAlertsResponse,
  FederationHealthNodesResponse,
  FederationPollResult,
  FederationTurnAggregate,
  SessionMetadataFilterOptions,
  SessionMetadataQuery,
  SessionTokenStatsResponse,
  SessionWorkflowStateResponse,
  FileClaimHistoryResponse,
  FileClaimListResponse,
  WatermarkState,
  NotesContent,
  BookmarkListResponse,
  BookmarkUpsertRequest,
  BookmarkUpsertResponse,
} from "@hapi/protocol";
import { serializeNotes } from "@hapi/protocol";
import type {
  CapabilityCatalogResponse,
  CapabilityAuditResponse,
} from "@/types/capabilities";
import type { AccountMonogram, GateDenialOutcome } from "@hapi/protocol";
import type {
  AccountsResponse,
  AccountUsageHistoryResponse,
  AccountUsageResponse,
  ProviderAuthStateResponse,
  SessionMetadataTurnsResponse,
  AccountLoginStartResponse,
  AccountLoginCompleteResponse,
  OpenAiLoginStartResponse,
  OpenAiLoginStatusResponse,
  AuthResponse,
  CreateScheduledTaskRequest,
  DecryptedMessage,
  DirectoryEntry,
  ErrorLogFiltersParam,
  ErrorLogListResponse,
  ErrorLogStatsResponse,
  ExecutionHistoryResponse,
  ExecutionResponse,
  FeedbackListResponse,
  FederationAllSessionsResponse,
  FederationNodesResponse,
  FileMutationResponse,
  FileReadResponse,
  FileSearchResponse,
  FileWriteResponse,
  SessionDirectoryResponse,
  GitCommandResponse,
  HeartbeatConfig,
  HeartbeatConfigResponse,
  HeartbeatHistoryResponse,
  HeartbeatInstructionsResponse,
  HeartbeatStatus,
  ListDirectoryResponse,
  CreateDirectoryResponse,
  MachinePathsExistsResponse,
  MachinesResponse,
  McpBatchStateResponse,
  McpSetDesiredResponse,
  McpStatusResponse,
  McpToggleResponse,
  MessagesResponse,
  ModelMode,
  NodeActiveAccountResponse,
  PermissionMode,
  PushSubscriptionPayload,
  PushUnsubscribePayload,
  PushVapidPublicKeyResponse,
  ScheduleResponse,
  SchedulesResponse,
  SlashCommandsResponse,
  SpawnResponse,
  SessionResponse,
  SessionsResponse,
  SetSessionAccountResponse,
  SetSessionPaymentMethodRequest,
  TimeLogDailySummary,
  TimeLogFilters,
  TimeLogListResponse,
  TimeLogProjectGroupedSummary,
  TimeLogProjectsResponse,
  TimeLogWeeklySummary,
  TimelogAdjustmentRequest,
  TimelogAdjustmentResponse,
  TimelogAdjustmentsResponse,
  DerivedTimeLogResponse,
  TimelogCutoverStatus,
  TelemetryAnomaly,
  TelemetryDurationStats,
  TelemetryFilesResponse,
  TelemetryOutcomeRate,
  TelemetryPeriodComparison,
  TelemetrySessionAggregate,
  TelemetrySummary,
  TelemetryTimeseries,
  TelemetryTokenEstimate,
  UpdateScheduledTaskRequest,
} from "@/types/api";
import type {
  PorterRecipientResponse,
  InstalledConfigResponse,
  PorterContentResponse,
  ImportPlanSummary,
  ImportResult,
  PorterImportPlanOptions,
  SecretOverlay,
  PorterTokenResponse,
  PorterTokenStatus,
} from "@/types/porter";
import type { PorterStatusResponse } from "@hapi/protocol/porter";
import type {
  VoiceModelId,
  VoiceSettingsUpdate,
  VoiceStatusResponse,
  VoiceTranscribeResponse,
} from "@hapi/protocol/voice";
import type {
  BackupIdentityStatus,
  BackupIdentityRevealResponse,
} from "@/types/backupIdentity";
import type {
  SystemJobsAllResponse,
  SystemJobMutateResult,
  SessionLoopSummaryResponse,
  SessionLoopSummaryAllResponse,
  LoopCronMutationResult,
  LoopCronRunResult,
  LoopCronRescheduleResult,
  LoopCronUpdateActionResult,
} from "@/types/systemJobs";
import type {
  HarnessStatusResponse,
  HarnessAnalysisResponse,
  TriggerAnalysisResponse,
  HarnessApplyResponse,
  ChangelogSpan,
  HarnessPollConfigResponse,
  HarnessCheckResponse,
} from "@/types/harnessUpdates";

type ApiClientOptions = {
  baseUrl?: string;
  getToken?: () => string | null;
  onUnauthorized?: () => Promise<string | null>;
};

type ErrorPayload = {
  error?: unknown;
  // Issue #2300 (Task 6): the server's typed error classifier. parseErrorCode
  // prefers this over `error` so ApiError.code carries the code LITERAL.
  code?: unknown;
};

/**
 * Per-call error-reporting policy for `ApiClient.request` (issue #2362).
 *
 * The transport boundary reports EVERY non-2xx response to the error reporter
 * before throwing. That is right by default, but wrong for an endpoint whose
 * non-2xx status is a *designed steady state* rather than a fault: a caller
 * that catches and handles such a response cannot un-send the report, because
 * the report was already emitted one layer below it.
 *
 * `expectedStatuses` lets a caller declare that intent at the call site. It is
 * deliberately opt-in and status-scoped — a method must name both the endpoint
 * (by opting in at all) and the exact status — so the blast radius is exactly
 * the calls that ask for it, and no genuine failure is masked elsewhere.
 */
type RequestReportOptions = {
  /** Statuses that are designed responses for this endpoint — not reported. */
  expectedStatuses?: readonly number[];
};

/**
 * Issue #2362: the four `/api/federation/health/*` + `/api/federation/alerts`
 * routes return 503 from exactly ONE guard — `if (!agg)` in
 * `server/src/web/routes/federation/health.ts` — and the HealthAggregator is
 * constructed only inside `if (federationConfig) { if (role !== "node") … }`
 * (`server/src/index.ts`). So 503 on these routes means "standalone or spoke",
 * both designed configurations; there is no fault path that produces it.
 * Suppressing the report therefore loses no genuine diagnostic signal.
 *
 * 404 is deliberately NOT listed: on `/federation/health/:nodeId` it means the
 * caller asked about a node that is not registered, which is a real caller
 * error and is not emitted at poll volume (`useNodeHealth` sets `retry: false`
 * and stops polling once it sees 503).
 */
const FEDERATION_HEALTH_REPORT_OPTS: RequestReportOptions = {
  expectedStatuses: [503],
};

function parseErrorCode(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as ErrorPayload;
    // Issue #2300 (Task 6): prefer the body's typed `code` classifier so
    // ApiError.code carries the code LITERAL (e.g. "at_capacity", "cwd_missing",
    // "last_account") for `err.code === "..."` comparisons — resurrecting the
    // shipped-but-wire-dead #1778 cwd_missing + #2131 last_account mappings.
    // Fall back to `error` for routes whose `error` field IS the code literal
    // (Convention-A, e.g. auth's `{error:"not_bound"}`), preserving those.
    if (typeof parsed.code === "string") return parsed.code;
    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

export class ApiError extends Error {
  status: number;
  code?: string;
  body?: string;

  constructor(message: string, status: number, code?: string, body?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * Context-watermark admin status (#2587). GET /api/watermark's server-authoritative
 * shape: the enable flag, the effective watermark percent + eligible roles (the R1
 * status block), and every per-session {@link WatermarkState}. `WatermarkState` is
 * reused from `@hapi/protocol` rather than redeclared so the wire shape stays single-
 * sourced; only this small wrapper is local (per #2587 directive — no new cross-package
 * schema for the enable feature).
 */
export interface WatermarkStatus {
  enabled: boolean;
  watermarkPercent: number;
  roles: string[];
  states: WatermarkState[];
}

/**
 * A message hook DENY, surfaced from `POST /sessions/:id/messages` (#3124). The
 * server returns HTTP 200 `{ok:false, denied}` — the denial is data, not an error.
 */
export interface SendMessageDenial {
  hookId: string;
  reason: string;
  // #3579: the copy-template params the hook attached (e.g. {issueNumber}).
  params?: Record<string, string | number>;
  // #3579: the server-resolved, ready-to-render outcome (the web never
  // re-resolves — resolution is server-side, Key Decision). Present on every
  // denial the current server emits; both peers deploy in lockstep (federation
  // deploy-all invariant), so a denial always carries it.
  outcome: GateDenialOutcome;
}

/**
 * The parsed result of a message send (#3333, ruling 3333-1). `ok:false` carries a
 * `denied` reason so a caller (e.g. an approval-card tap) can distinguish a
 * server-side denial from a success — previously the body was discarded and a
 * denial looked identical to a delivered send.
 */
export interface SendMessageResult {
  ok: boolean;
  denied?: SendMessageDenial;
}

/**
 * #3172: what a schedule delete does with the sessions the schedule spawned.
 * Structural mirror of the server `ScheduleChildDisposition`
 * (`server/src/extensions/scheduler/scheduler/schedulerService.ts`).
 */
export type ScheduleChildDisposition = "cascade" | "orphan";

/**
 * #3559 (R6): the approval-gate state read surface response. Structural mirror of
 * the server `ApprovalStateResult` (`server/src/services/approvalTokens.ts`).
 * `state` drives the server-driven approval card; `none` = "no gate artifact"
 * (the card holds its last meaningful state instead of snapping to Pending).
 */
export interface ApprovalStateResponse {
  state:
    | "pending"
    | "consumed"
    | "used"
    | "invalidated"
    | "awaiting-overlap-decision"
    | "none";
  nonce?: string;
  action?: string;
  scope?: string;
  approved_by?: string;
  origin?: string;
  /** Present on `consumed` — the grant mint instant (ISO). */
  minted_at?: string;
  /** Present on `used` — the acceptance-ledger consumption instant (ISO). */
  consumed_at?: string;
  /** Present on `invalidated` / `awaiting-overlap-decision` — the drift/overlap reason. */
  reason?: string;
}

/**
 * PUT /api/watermark/config result (#2587). Returns the EFFECTIVE config after the
 * write — the UI reconciles to these values, never the request. `enabled` may differ
 * from a requested value when the `HAPI_CONTEXT_WATERMARK_ENABLED` kill-switch forces
 * it (`forcedByEnv` is then true).
 */
export interface WatermarkConfigUpdateResult {
  enabled: boolean;
  watermarkPercent: number;
  roles: string[];
  forcedByEnv: boolean;
}

/**
 * Issue #2626 (D): one entry in the output-style catalog (`GET /api/output-styles`).
 * Structural mirror of the server shape (`server/src/web/routes/outputStyles.ts`).
 */
export interface OutputStyleInfo {
  /** The style name — the value threaded through the spawn wire as `outputStyle`. */
  name: string;
  /** One-line description shown beside the option in the dropdown. */
  description: string;
  /** True for the three compiled-in built-ins; false for `~/.claude/output-styles/*.md`. */
  builtin: boolean;
  /** Custom styles only: the full `.md` content (the "view definition" modal). */
  content?: string;
  /** #2627 (E): true for uploaded customs — the manager renders a delete
   * affordance. Absent/false for the three built-ins. */
  deletable?: boolean;
}
export interface OutputStyleCatalog {
  styles: OutputStyleInfo[];
}

export class ApiClient {
  private token: string;
  private readonly baseUrl: string | null;
  private readonly getToken: (() => string | null) | null;
  private readonly onUnauthorized: (() => Promise<string | null>) | null;

  constructor(token: string, options?: ApiClientOptions) {
    this.token = token;
    this.baseUrl = options?.baseUrl ?? null;
    this.getToken = options?.getToken ?? null;
    this.onUnauthorized = options?.onUnauthorized ?? null;
  }

  private buildUrl(path: string): string {
    if (!this.baseUrl) {
      return path;
    }
    try {
      return new URL(path, this.baseUrl).toString();
    } catch {
      return path;
    }
  }

  private static readonly DEFAULT_TIMEOUT_MS = 30_000;

  // Spawning a session can take far longer than a normal request: a cold
  // Claude session on a Pi 5 (large CLAUDE.md + MCP servers + plugins +
  // SessionStart hooks) may take >60s to boot and phone home. The server-RPC
  // ack (75s, rpcGateway.ts) sits below this, and the daemon webhook wait (60s,
  // run.ts) below that — so this outermost layer must be the largest to avoid
  // pre-empting a slow-but-valid spawn. Only the spawn calls opt into it.
  private static readonly SPAWN_TIMEOUT_MS = 90_000;

  private async request<T>(
    path: string,
    init?: RequestInit,
    attempt: number = 0,
    overrideToken?: string | null,
    timeoutMs: number = ApiClient.DEFAULT_TIMEOUT_MS,
    opts?: RequestReportOptions
  ): Promise<T> {
    const headers = new Headers(init?.headers);
    const liveToken = this.getToken ? this.getToken() : null;
    const authToken =
      overrideToken !== undefined
        ? (overrideToken ?? liveToken ?? this.token)
        : (liveToken ?? this.token);
    if (authToken) {
      headers.set("authorization", `Bearer ${authToken}`);
    }
    if (init?.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;

    let res: Response;
    try {
      res = await fetch(this.buildUrl(path), {
        ...init,
        headers,
        signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new Error("Request timed out. Please try again.");
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error("Request was cancelled.");
      }
      throw err;
    }

    if (res.status === 401) {
      if (attempt === 0 && this.onUnauthorized) {
        const refreshed = await this.onUnauthorized();
        if (refreshed) {
          this.token = refreshed;
          // Issue #2362: `opts` MUST be forwarded here. Without it, a request
          // that opted out of error-reporting for a designed status silently
          // regains reporting the moment a token refresh happens mid-flight.
          return await this.request<T>(
            path,
            init,
            attempt + 1,
            refreshed,
            timeoutMs,
            opts
          );
        }
      }
      throw new Error("Session expired. Please sign in again.");
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const url = new URL(res.url);
      // Issue #2362: a caller may declare that a given non-2xx status is a
      // DESIGNED response for its endpoint rather than a fault. Reporting it
      // would be a category error — and on a standalone node the federation
      // health endpoints emit 503 on every poll, which saturated both the
      // client's 10/60s report budget and the server's identical limit,
      // starving genuine errors of reporting capacity.
      //
      // Only the REPORT is suppressed; the ApiError below is still thrown
      // unchanged, so caller-side taxonomies (useNodeHealth's 404/503 split,
      // useHealthStatus's disabled/outage split) keep working.
      const isExpectedStatus =
        opts?.expectedStatuses?.includes(res.status) ?? false;
      if (!isExpectedStatus) {
        errorReporter.report({
          message: `HTTP ${res.status} ${res.statusText}: ${body}`.slice(
            0,
            2000
          ),
          category: "api-error",
          severity: "warn",
          requestPath: url.pathname,
          requestMethod: init?.method ?? "GET",
          statusCode: res.status,
        });
      }
      // Issue #1720: throw ApiError (extends Error) so structured callers can
      // read .status/.code/.body, while the .message text stays byte-for-byte
      // identical — `toggleMcpServer`/`setMcpDesired`/`AccountSelectorModal`
      // regex-parse the body out of .message and MUST keep working (R3).
      throw new ApiError(
        `HTTP ${res.status} ${res.statusText}: ${body}`,
        res.status,
        parseErrorCode(body),
        body || undefined
      );
    }

    // Issue #1225: signal "transport works again" so any persisted error
    // reports drain on the back of a successful unrelated request. This
    // covers the navigator.onLine blind spot — a healthy network with an
    // expired-then-refreshed JWT won't fire 'online' but will produce 2xx.
    errorReporter.maybeReplay();

    return (await res.json()) as T;
  }

  /**
   * Generic authenticated request for EXTENSION-OWNED routes (issue #1284).
   *
   * Every method on this class is a core endpoint, and `request` is private —
   * so before this escape hatch existed, an extension contributing brand-new
   * server routes had exactly two options, both bad:
   *
   *   1. Add `getNotes`/`createNote`/… to `ApiClient` — which makes CORE aware
   *      of the extension, inverting the ownership boundary the extension
   *      system exists to establish.
   *   2. Call `fetch` directly — re-implementing auth-header injection, the
   *      401-refresh-and-retry, the timeout, `ApiError` shaping, and the
   *      error-reporter hooks, and drifting from them on every future change.
   *
   * This method is the third option: ONE generic, extension-agnostic seam that
   * delegates to the same private `request`, so extensions inherit all of that
   * behavior for free and core never learns any extension's route names.
   *
   * `path` must be the full server path (e.g. `/api/session-notes/abc`).
   * Callers own their own response typing — the server contract for an
   * extension route is owned by that extension, not by this class.
   */
  async extensionRequest<T>(path: string, init?: RequestInit): Promise<T> {
    return await this.request<T>(path, init);
  }

  async authenticate(
    auth: { initData: string } | { accessToken: string }
  ): Promise<AuthResponse> {
    const res = await fetch(this.buildUrl("/api/auth"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(auth),
      signal: AbortSignal.timeout(ApiClient.DEFAULT_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const code = parseErrorCode(body);
      const detail = body ? `: ${body}` : "";
      throw new ApiError(
        `Auth failed: HTTP ${res.status} ${res.statusText}${detail}`,
        res.status,
        code,
        body || undefined
      );
    }

    return (await res.json()) as AuthResponse;
  }

  async bind(auth: {
    initData: string;
    accessToken: string;
  }): Promise<AuthResponse> {
    const res = await fetch(this.buildUrl("/api/bind"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(auth),
      signal: AbortSignal.timeout(ApiClient.DEFAULT_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const code = parseErrorCode(body);
      const detail = body ? `: ${body}` : "";
      throw new ApiError(
        `Bind failed: HTTP ${res.status} ${res.statusText}${detail}`,
        res.status,
        code,
        body || undefined
      );
    }

    return (await res.json()) as AuthResponse;
  }

  async getSessions(): Promise<SessionsResponse> {
    return await this.request<SessionsResponse>("/api/sessions");
  }

  async getPushVapidPublicKey(): Promise<PushVapidPublicKeyResponse> {
    return await this.request<PushVapidPublicKeyResponse>(
      "/api/push/vapid-public-key"
    );
  }

  async subscribePushNotifications(
    payload: PushSubscriptionPayload
  ): Promise<void> {
    await this.request("/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async unsubscribePushNotifications(
    payload: PushUnsubscribePayload
  ): Promise<void> {
    await this.request("/api/push/subscribe", {
      method: "DELETE",
      body: JSON.stringify(payload),
    });
  }

  async getSession(sessionId: string): Promise<SessionResponse> {
    return await this.request<SessionResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}`
    );
  }

  async getMessages(
    sessionId: string,
    options: { beforeSeq?: number | null; limit?: number }
  ): Promise<MessagesResponse> {
    const params = new URLSearchParams();
    if (options.beforeSeq !== undefined && options.beforeSeq !== null) {
      params.set("beforeSeq", `${options.beforeSeq}`);
    }
    if (options.limit !== undefined && options.limit !== null) {
      params.set("limit", `${options.limit}`);
    }

    const qs = params.toString();
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ""}`;
    return await this.request<MessagesResponse>(url);
  }

  async getMessagesAfter(
    sessionId: string,
    afterSeq: number,
    limit: number = 200
  ): Promise<{ messages: DecryptedMessage[] }> {
    const params = new URLSearchParams();
    params.set("afterSeq", `${afterSeq}`);
    params.set("limit", `${limit}`);
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages?${params.toString()}`;
    return await this.request<{ messages: DecryptedMessage[] }>(url);
  }

  /**
   * #3559 (R6): read an issue's approval-gate state. `challengeId` is the ISSUE
   * NUMBER (issue-scoped gates); `nonce` (the card's `spec.token`) lets the server
   * report `used` from the acceptance ledger after the gate completes. The routes
   * 400 on a non-integer challengeId — `useApprovalState` only enables the query
   * for an integer id, so this method is never called with one.
   */
  async getApprovalState(
    sessionId: string,
    challengeId: string,
    nonce?: string
  ): Promise<ApprovalStateResponse> {
    const params = new URLSearchParams();
    if (nonce) params.set("nonce", nonce);
    const qs = params.toString();
    return await this.request<ApprovalStateResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/approval-state/${encodeURIComponent(
        challengeId
      )}${qs ? `?${qs}` : ""}`
    );
  }

  async getGitStatus(sessionId: string): Promise<GitCommandResponse> {
    return await this.request<GitCommandResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/git-status`
    );
  }

  async getGitRemoteUrl(sessionId: string): Promise<GitCommandResponse> {
    return await this.request<GitCommandResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/git-remote-url`
    );
  }

  async getGitDiffNumstat(
    sessionId: string,
    staged: boolean
  ): Promise<GitCommandResponse> {
    const params = new URLSearchParams();
    params.set("staged", staged ? "true" : "false");
    return await this.request<GitCommandResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/git-diff-numstat?${params.toString()}`
    );
  }

  async getGitDiffFile(
    sessionId: string,
    path: string,
    staged?: boolean
  ): Promise<GitCommandResponse> {
    const params = new URLSearchParams();
    params.set("path", path);
    if (staged !== undefined) {
      params.set("staged", staged ? "true" : "false");
    }
    return await this.request<GitCommandResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/git-diff-file?${params.toString()}`
    );
  }

  async searchSessionFiles(
    sessionId: string,
    query: string,
    limit?: number
  ): Promise<FileSearchResponse> {
    const params = new URLSearchParams();
    if (query) {
      params.set("query", query);
    }
    if (limit !== undefined) {
      params.set("limit", `${limit}`);
    }
    const qs = params.toString();
    return await this.request<FileSearchResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/files${qs ? `?${qs}` : ""}`
    );
  }

  async readSessionFile(
    sessionId: string,
    path: string
  ): Promise<FileReadResponse> {
    const params = new URLSearchParams();
    params.set("path", path);
    return await this.request<FileReadResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/file?${params.toString()}`
    );
  }

  // issue #2518: write a text file back to the session working directory.
  // A 409 conflict (stale expectedHash) is a DESIGNED optimistic-concurrency
  // outcome, not a transport fault: unwrap the ApiError body into the structured
  // response so callers branch on `.conflict` instead of catching, and mark 409
  // as an expected status so it does not spam the error reporter (#2362).
  async writeSessionFile(
    sessionId: string,
    path: string,
    content: string,
    expectedHash?: string | null
  ): Promise<FileWriteResponse> {
    try {
      return await this.request<FileWriteResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/file`,
        {
          method: "PUT",
          body: JSON.stringify({
            path,
            content,
            expectedHash: expectedHash ?? null,
          }),
        },
        0,
        undefined,
        undefined,
        { expectedStatuses: [409] }
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body) {
        try {
          return JSON.parse(err.body) as FileWriteResponse;
        } catch {
          return {
            success: false,
            conflict: true,
            error: "File changed on disk since it was opened.",
          };
        }
      }
      throw err;
    }
  }

  // issue #2518: session-scoped directory listing (name/type/size/mtime) rooted
  // at the session working directory. Path errors (400/403) throw ApiError.
  async listSessionDirectory(
    sessionId: string,
    path: string
  ): Promise<SessionDirectoryResponse> {
    const params = new URLSearchParams();
    params.set("path", path);
    return await this.request<SessionDirectoryResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/directory?${params.toString()}`
    );
  }

  // issue #2715: create a folder in the session working directory. Path errors
  // (400/403 — containment, root) throw ApiError; an RPC-level failure (e.g.
  // already exists, restricted path) resolves with { success: false, error }.
  async createSessionDirectory(
    sessionId: string,
    path: string
  ): Promise<FileMutationResponse> {
    return await this.request<FileMutationResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/directory`,
      {
        method: "POST",
        body: JSON.stringify({ path }),
      }
    );
  }

  // issue #2715: rename a file/folder within the session working directory. The
  // server route + CLI handler guard BOTH legs (containment, root, deny-list).
  async renameSessionPath(
    sessionId: string,
    path: string,
    newPath: string
  ): Promise<FileMutationResponse> {
    return await this.request<FileMutationResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/rename`,
      {
        method: "POST",
        body: JSON.stringify({ path, newPath }),
      }
    );
  }

  // issue #2715: delete a file/folder. `recursive` is set by the UI ONLY after
  // an explicit, entry-count-bearing confirmation (sweep finding 2715-5); the
  // default omits it and the CLI handler refuses a non-empty directory.
  async deleteSessionPath(
    sessionId: string,
    path: string,
    recursive?: boolean
  ): Promise<FileMutationResponse> {
    return await this.request<FileMutationResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/delete`,
      {
        method: "POST",
        body: JSON.stringify({ path, recursive: recursive ?? false }),
      }
    );
  }

  async sendMessage(
    sessionId: string,
    text: string,
    localId?: string | null
  ): Promise<SendMessageResult> {
    const result = await this.request<SendMessageResult>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ text, localId: localId ?? undefined }),
      }
    );
    // #3333 (3333-1): a hook-denied send answers HTTP 200 `{ok:false, denied}`.
    // Surface it instead of discarding the body, so an approval tap can never
    // present a denial as success. Tolerate a legacy / unexpectedly-shaped body
    // defensively (default to {ok:true}) — never throw on the shape.
    if (
      result &&
      typeof result === "object" &&
      typeof result.ok === "boolean"
    ) {
      return { ok: result.ok, denied: result.denied };
    }
    return { ok: true };
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  async archiveSession(sessionId: string): Promise<void> {
    await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/archive`,
      {
        method: "POST",
        body: JSON.stringify({}),
      }
    );
  }

  async reconnectSession(sessionId: string): Promise<{ newSessionId: string }> {
    const response = await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/reconnect`,
      {
        method: "POST",
        body: JSON.stringify({}),
      }
    );
    return response as { newSessionId: string };
  }

  async branchSession(
    sessionId: string,
    branchLabel?: string
  ): Promise<{ newSessionId: string }> {
    const response = await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/branch`,
      {
        method: "POST",
        body: JSON.stringify({ branchLabel }),
      }
    );
    return response as { newSessionId: string };
  }

  async switchSession(sessionId: string): Promise<void> {
    await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/switch`,
      {
        method: "POST",
        body: JSON.stringify({}),
      }
    );
  }

  async setPermissionMode(
    sessionId: string,
    mode: PermissionMode
  ): Promise<void> {
    await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/permission-mode`,
      {
        method: "POST",
        body: JSON.stringify({ mode }),
      }
    );
  }

  async setModelMode(sessionId: string, model: ModelMode): Promise<void> {
    // Issue #3769 (R6, ruling D6): one diagnostic line per Apply at the single
    // client choke point (NOT useSessionActions.ts — kept out of #3704's footprint).
    console.debug(
      `[client #3769] setModelMode session=${sessionId} model=${model}`
    );
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/model`, {
      method: "POST",
      body: JSON.stringify({ model }),
    });
  }

  /** Issue #2456: set the session's reasoning-effort level in-session. */
  async setSessionEffort(
    sessionId: string,
    effort: EffortLevel
  ): Promise<void> {
    // Issue #3769 (R6, ruling D6): one diagnostic line per Apply (see setModelMode).
    console.debug(
      `[client #3769] setSessionEffort session=${sessionId} effort=${effort}`
    );
    await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/effort`,
      { method: "POST", body: JSON.stringify({ effort }) }
    );
  }

  /** Issue #2456: pin a specific raw Claude model id in-session ("More models"). */
  async setSessionRawModel(sessionId: string, rawModel: string): Promise<void> {
    // Issue #3769 (R6, ruling D6): one diagnostic line per Apply (see setModelMode).
    console.debug(
      `[client #3769] setSessionRawModel session=${sessionId} rawModel=${rawModel}`
    );
    await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/raw-model`,
      { method: "POST", body: JSON.stringify({ rawModel }) }
    );
  }

  /**
   * Issue #2149: relaunch a session with new spawn-frozen params (launcher /
   * safeMode) via a teardown + `--resume` respawn through the single
   * `spawnSession` choke point. The live-plane params (model / permission mode /
   * MCP / effort / rawModel) apply in place via their own routes, NOT this one.
   * Federation-proxied server-side: a remote session's relaunch forwards to the
   * owning node and refreshes the hub cache.
   */
  async relaunchSession(
    sessionId: string,
    overrides: RelaunchRequest
  ): Promise<void> {
    await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/relaunch`,
      { method: "POST", body: JSON.stringify(overrides) }
    );
  }

  async approvePermission(
    sessionId: string,
    requestId: string,
    modeOrOptions?:
      | "default"
      | "acceptEdits"
      | "bypassPermissions"
      | "plan"
      | {
          mode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
          allowTools?: string[];
          decision?: "approved" | "approved_for_session" | "denied" | "abort";
          answers?: Record<string, string[]>;
        }
  ): Promise<void> {
    const body =
      typeof modeOrOptions === "string" || modeOrOptions === undefined
        ? { mode: modeOrOptions }
        : modeOrOptions;
    await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/approve`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );
  }

  async denyPermission(
    sessionId: string,
    requestId: string,
    options?: {
      decision?: "approved" | "approved_for_session" | "denied" | "abort";
    }
  ): Promise<void> {
    await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/deny`,
      {
        method: "POST",
        body: JSON.stringify(options ?? {}),
      }
    );
  }

  async getMachines(): Promise<MachinesResponse> {
    return await this.request<MachinesResponse>("/api/machines");
  }

  // ── Account management (epic #1446 — multi-account OAuth switcher) ──────────
  // E (#1451) ships GET/DELETE /api/accounts. The session/node selection
  // endpoints below are owned by J (#1456) and F (#1452) respectively and 404
  // until those sub-issues ship; the UI is built against the pinned contract.
  async getAccounts(): Promise<AccountsResponse> {
    return await this.request<AccountsResponse>("/api/accounts");
  }

  // Per-account usage history (epic #1855, Sub I — #1864). Returns per-window
  // snapshot series + a projected-exhaustion estimate for the sparkline.
  async getAccountUsageHistory(
    accountUuid: string
  ): Promise<AccountUsageHistoryResponse> {
    return await this.request<AccountUsageHistoryResponse>(
      `/api/accounts/usage/history?uuid=${encodeURIComponent(accountUuid)}`
    );
  }

  // Federation-wide per-account usage (epic #1855, Sub C / #1858, wired by Sub J
  // / #1865). The aggregator fetches THIS node's usage locally + fans out to
  // every peer node, dedups by accountUuid, and UNIONS each account's `machines`
  // node-label list — which is what lets a single account appear on >1 node so
  // the inline per-node switch (#1865) can disambiguate. On a standalone node
  // (no peers) it degrades to local-only. Same `{ usage: AccountUsage[] }` shape
  // as the local route, so the hook + tests stay endpoint-agnostic.
  async getAccountUsage(opts?: {
    force?: boolean;
  }): Promise<AccountUsageResponse> {
    // #1909: `?force=1` makes the aggregator do a real upstream refresh of the
    // local node (manual refresh button); the default read serves the cache.
    const query = opts?.force ? "?force=1" : "";
    return await this.request<AccountUsageResponse>(
      `/api/federation/accounts/usage${query}`
    );
  }

  // Federation-wide non-Anthropic provider auth state (issue #3806, epic #3345).
  // The aggregator serves THIS node's Codex/Gemini state + fans out to every peer,
  // one row per node — DERIVED fields only, never a token/key. Same envelope shape
  // as the local /api/accounts/provider-auth-state route, so the hook stays
  // endpoint-agnostic. On a standalone node it degrades to a single local row.
  async getProviderAuthState(): Promise<ProviderAuthStateResponse> {
    return await this.request<ProviderAuthStateResponse>(
      "/api/federation/provider-auth-state"
    );
  }

  // Issue #1675 (Sub M): admin session-metadata query surface.

  /** Node-local per-turn query (all six filters incl. event-kind). */
  async getSessionMetadataTurns(
    filters: SessionMetadataQuery
  ): Promise<SessionMetadataTurnsResponse> {
    const params = new URLSearchParams();
    if (filters.sessionId) params.set("sessionId", filters.sessionId);
    if (filters.fromMs !== undefined) params.set("from", `${filters.fromMs}`);
    if (filters.toMs !== undefined) params.set("to", `${filters.toMs}`);
    if (filters.repo) params.set("repo", filters.repo);
    if (filters.modelId) params.set("model", filters.modelId);
    if (filters.accountId) params.set("account", filters.accountId);
    if (filters.eventKind) params.set("eventKind", filters.eventKind);
    if (filters.limit !== undefined) params.set("limit", `${filters.limit}`);
    if (filters.offset !== undefined) params.set("offset", `${filters.offset}`);
    const qs = params.toString();
    return await this.request<SessionMetadataTurnsResponse>(
      `/api/session-metadata/turns${qs ? `?${qs}` : ""}`
    );
  }

  // Issue #3839: transcript browser (namespace-scoped archive of every
  // Claude transcript on the node).

  /** List + full-text search the transcript archive. */
  async getTranscripts(
    query: Partial<TranscriptListQuery>
  ): Promise<TranscriptListResponse> {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.fromMs !== undefined) params.set("from", `${query.fromMs}`);
    if (query.toMs !== undefined) params.set("to", `${query.toMs}`);
    if (query.harness) params.set("harness", query.harness);
    if (query.account) params.set("account", query.account);
    if (query.repo) params.set("repo", query.repo);
    if (query.linkedIssue !== undefined) {
      params.set("linkedIssue", `${query.linkedIssue}`);
    }
    if (query.sort) params.set("sort", query.sort);
    if (query.limit !== undefined) params.set("limit", `${query.limit}`);
    if (query.offset !== undefined) params.set("offset", `${query.offset}`);
    const qs = params.toString();
    return await this.request<TranscriptListResponse>(
      `/api/transcripts${qs ? `?${qs}` : ""}`
    );
  }

  async getTranscriptFilterOptions(): Promise<TranscriptFilterOptions> {
    return await this.request<TranscriptFilterOptions>(
      "/api/transcripts/filter-options"
    );
  }

  /**
   * One PAGE of a transcript as renderer-ready (scrubbed) messages (#4053).
   * `cursor` is the previous page's `nextCursor`; `full` (with `limit: 1`)
   * returns one entry with its tool results untruncated.
   */
  async getTranscriptMessages(
    ccSessionId: string,
    page: { cursor?: string; limit?: number; full?: boolean } = {}
  ): Promise<TranscriptMessagesResponse> {
    const params = new URLSearchParams();
    if (page.cursor) params.set("cursor", page.cursor);
    if (page.limit !== undefined) params.set("limit", String(page.limit));
    if (page.full) params.set("full", "1");
    const qs = params.toString();
    return await this.request<TranscriptMessagesResponse>(
      `/api/transcripts/${encodeURIComponent(ccSessionId)}/messages${qs ? `?${qs}` : ""}`
    );
  }

  /** One background agent's sub-transcript page, newest-first (#4386). */
  async getAgentTranscriptPage(
    sessionId: string,
    agentId: string,
    page: {
      limit?: number;
      before?: string;
      after?: string;
      full?: boolean;
    } = {}
  ): Promise<AgentTranscriptPage> {
    const params = new URLSearchParams();
    if (page.limit !== undefined) params.set("limit", String(page.limit));
    if (page.before) params.set("before", page.before);
    if (page.after) params.set("after", page.after);
    if (page.full) params.set("full", "1");
    const qs = params.toString();
    return await this.request<AgentTranscriptPage>(
      `/api/sessions/${encodeURIComponent(sessionId)}/background-agents/${encodeURIComponent(agentId)}/transcript${qs ? `?${qs}` : ""}`
    );
  }

  /** Resume a transcript; `directory` is the D28 picker's choice. */
  async resumeTranscript(
    ccSessionId: string,
    directory?: string
  ): Promise<TranscriptResumeResponse> {
    return await this.request<TranscriptResumeResponse>(
      `/api/transcripts/${encodeURIComponent(ccSessionId)}/resume`,
      {
        method: "POST",
        body: JSON.stringify(directory ? { directory } : {}),
      }
    );
  }

  /** Distinct filter-dropdown values (node-local). */
  async getSessionMetadataFilterOptions(): Promise<SessionMetadataFilterOptions> {
    return await this.request<SessionMetadataFilterOptions>(
      "/api/session-metadata/filter-options"
    );
  }

  /** Cross-node session-totals aggregate (Sub L's federation read path). */
  async getFederationTurnAggregate(opts?: {
    fromMs?: number;
    toMs?: number;
    limit?: number;
  }): Promise<FederationTurnAggregate> {
    const params = new URLSearchParams();
    if (opts?.fromMs !== undefined) params.set("from", `${opts.fromMs}`);
    if (opts?.toMs !== undefined) params.set("to", `${opts.toMs}`);
    if (opts?.limit !== undefined) params.set("limit", `${opts.limit}`);
    const qs = params.toString();
    return await this.request<FederationTurnAggregate>(
      `/api/federation/telemetry/aggregate${qs ? `?${qs}` : ""}`
    );
  }

  async deleteAccount(accountUuid: string): Promise<void> {
    await this.request(`/api/accounts/${encodeURIComponent(accountUuid)}`, {
      method: "DELETE",
    });
  }

  /**
   * Remove an account's stored credentials from a SPECIFIC node (issue #2054).
   * Federation-aware: the server proxies to the owning node when `nodeId` is not
   * local (only `accountUuid` crosses the boundary — never a token). A non-2xx
   * response rejects with an `ApiError` whose `.code` carries the server code
   * (e.g. `last_account`), so the multi-node mutation can branch per node.
   */
  async removeAccountOnNode(
    nodeId: string,
    accountUuid: string
  ): Promise<void> {
    await this.request(
      `/api/nodes/${encodeURIComponent(nodeId)}/accounts/${encodeURIComponent(
        accountUuid
      )}`,
      { method: "DELETE" }
    );
  }

  async setAccountNickname(
    accountUuid: string,
    nickname: string
  ): Promise<void> {
    await this.request(
      `/api/accounts/${encodeURIComponent(accountUuid)}/nickname`,
      { method: "PATCH", body: JSON.stringify({ nickname }) }
    );
  }

  /**
   * Set (or clear, with an empty `{}`) an account's monogram override — the
   * chip's displayed letter + color (issue #3621). PATCHes the sidecar-backed
   * `/api/accounts/:uuid/monogram`; the body is the monogram object itself
   * (`{ letter?, color? }`).
   */
  async setAccountMonogram(
    accountUuid: string,
    monogram: AccountMonogram
  ): Promise<void> {
    await this.request(
      `/api/accounts/${encodeURIComponent(accountUuid)}/monogram`,
      { method: "PATCH", body: JSON.stringify(monogram) }
    );
  }

  async setSessionAccount(
    sessionId: string,
    accountUuid: string
  ): Promise<SetSessionAccountResponse> {
    return await this.setSessionPaymentMethod(sessionId, { accountUuid });
  }

  /**
   * Issue #4823: switch (or, for a disconnected session, stage) a session's
   * payment method — a subscription account or a node-vault Anthropic API key
   * (by vault id; the key itself never leaves the node). Same route as the
   * account switch; the server restarts the session with `--resume`.
   */
  async setSessionPaymentMethod(
    sessionId: string,
    target: SetSessionPaymentMethodRequest
  ): Promise<SetSessionAccountResponse> {
    return await this.request<SetSessionAccountResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/account`,
      { method: "POST", body: JSON.stringify(target) }
    );
  }

  // #3808 Task 4b: an optional `provider` reads/sets the PER-PROVIDER node
  // default (absent ⇒ the Anthropic pointer).
  async getNodeActiveAccount(
    nodeId: string,
    provider?: string
  ): Promise<NodeActiveAccountResponse> {
    const query = provider ? `?provider=${encodeURIComponent(provider)}` : "";
    return await this.request<NodeActiveAccountResponse>(
      `/api/nodes/${encodeURIComponent(nodeId)}/active-account${query}`
    );
  }

  async setNodeActiveAccount(
    nodeId: string,
    accountUuid: string,
    provider?: string
  ): Promise<{ ok: boolean }> {
    return await this.request<{ ok: boolean }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/active-account`,
      {
        method: "POST",
        body: JSON.stringify({
          accountUuid,
          ...(provider ? { provider } : {}),
        }),
      }
    );
  }

  /**
   * #3456: force an immediate federation poll of all nodes, bypassing per-node
   * backoff, and return the status diff (newly-online / still-offline). Backs
   * the Create-page "Refresh federation" button.
   */
  async pollFederation(): Promise<FederationPollResult> {
    return await this.request<FederationPollResult>("/api/nodes/poll", {
      method: "POST",
    });
  }

  // ── Session capacity / max-concurrency (issue #1805) ──

  /** Local machine's spawn capacity. `{null, …}` when the daemon is down.
   *  #4417 adds `recommendedConcurrent` (warn-at count) + `capSource` (which resolver
   *  layer set the cap); both null when unknown/older daemon. */
  async getDaemonCapacity(): Promise<{
    effectiveCount: number | null;
    maxConcurrent: number | null;
    recommendedConcurrent: number | null;
    capSource: DaemonCapSource | null;
  }> {
    return await this.request<{
      effectiveCount: number | null;
      maxConcurrent: number | null;
      recommendedConcurrent: number | null;
      capSource: DaemonCapSource | null;
    }>("/api/daemon/capacity");
  }

  /**
   * About-page host info + harness enumeration (issue #1983 B2 ← #1984 B3).
   * Authed `this.request` (NOT a raw fetch) because `/api/about` mounts AFTER
   * the JWT gate (B3 KD-2). `?nodeId=` proxies to a federated peer; omit it for
   * the local node.
   */
  /** Submit user feedback (issue #2664, epic #2663). POST /api/feedback. */
  async submitFeedback(payload: FeedbackRequest): Promise<FeedbackResponse> {
    return await this.request<FeedbackResponse>("/api/feedback", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async getAbout(nodeId?: string): Promise<AboutInfo> {
    const url = nodeId
      ? `/api/about?nodeId=${encodeURIComponent(nodeId)}`
      : "/api/about";
    return await this.request<AboutInfo>(url);
  }

  /** A node's current cap: persisted `value`, daemon-enforced `effective`, its
   *  `recommended` warn-at count, and the resolver `source`. #4417 widens `source`
   *  with the daemon's `tier`/`derived` layers (`DaemonCapSource`) plus the server's
   *  own `remote`/`unknown`, and adds `recommended`. */
  async getNodeMaxConcurrency(nodeId: string): Promise<{
    value: number | null;
    effective: number | null;
    recommended: number | null;
    source: DaemonCapSource | "unknown" | "remote";
  }> {
    return await this.request<{
      value: number | null;
      effective: number | null;
      recommended: number | null;
      source: DaemonCapSource | "unknown" | "remote";
    }>(`/api/nodes/${encodeURIComponent(nodeId)}/max-concurrency`);
  }

  /** Set a node's cap (validated floor/ceiling server-side), or clear it to
   *  automatic with `value: null` (#4417). */
  async setNodeMaxConcurrency(
    nodeId: string,
    value: number | null
  ): Promise<{ ok: boolean; value: number | null }> {
    return await this.request<{ ok: boolean; value: number | null }>(
      `/api/nodes/${encodeURIComponent(nodeId)}/max-concurrency`,
      { method: "POST", body: JSON.stringify({ value }) }
    );
  }

  // Web-initiated OAuth login (issue #1263). Two-step PKCE: start → user
  // authenticates in a browser and copies the code → complete.
  async startAccountLogin(): Promise<AccountLoginStartResponse> {
    return await this.request<AccountLoginStartResponse>(
      "/api/accounts/login/start",
      { method: "POST", body: JSON.stringify({}) }
    );
  }

  // Issue #1720: non-2xx responses (400 expired_state/csrf, 502 upstream
  // failure, 500) make request<T>() throw ApiError before returning, so this
  // only ever resolves with the success member. Narrowing to it lets the
  // calling hook destructure `account` without a (runtime-dead) `!ok` guard.
  async completeAccountLogin(
    loginToken: string,
    code: string
  ): Promise<Extract<AccountLoginCompleteResponse, { ok: true }>> {
    return await this.request<
      Extract<AccountLoginCompleteResponse, { ok: true }>
    >("/api/accounts/login/complete", {
      method: "POST",
      body: JSON.stringify({ loginToken, code }),
    });
  }

  // Codex (OpenAI) in-app login (issue #3807, epic #3345). `start` runs the
  // API-key path synchronously or begins the device-auth flow; `status`/`cancel`
  // poll/abort the device-auth child. `nodeId` targets a federation node (the
  // LOCAL_NODE_ID sentinel = this node). The raw key is sent once in the start
  // body and never echoed back; no response ever carries a key/token.
  async startOpenAiLogin(body: {
    nodeId: string;
    kind: "api-key" | "device-auth";
    label?: string;
    key?: string;
  }): Promise<OpenAiLoginStartResponse> {
    return await this.request<OpenAiLoginStartResponse>(
      "/api/accounts/openai/login/start",
      { method: "POST", body: JSON.stringify(body) }
    );
  }

  async openAiLoginStatus(
    nodeId: string,
    loginToken: string
  ): Promise<OpenAiLoginStatusResponse> {
    return await this.request<OpenAiLoginStatusResponse>(
      "/api/accounts/openai/login/status",
      { method: "POST", body: JSON.stringify({ nodeId, loginToken }) }
    );
  }

  async cancelOpenAiLogin(
    nodeId: string,
    loginToken: string
  ): Promise<{ cancelled: boolean }> {
    return await this.request<{ cancelled: boolean }>(
      "/api/accounts/openai/login/cancel",
      { method: "POST", body: JSON.stringify({ nodeId, loginToken }) }
    );
  }

  async checkMachinePathsExists(
    machineId: string,
    paths: string[]
  ): Promise<MachinePathsExistsResponse> {
    return await this.request<MachinePathsExistsResponse>(
      `/api/machines/${encodeURIComponent(machineId)}/paths/exists`,
      {
        method: "POST",
        body: JSON.stringify({ paths }),
      }
    );
  }

  async listMachineDirectory(
    machineId: string,
    path: string
  ): Promise<DirectoryEntry[]> {
    const response = await this.request<ListDirectoryResponse>(
      `/api/machines/${encodeURIComponent(machineId)}/list-directory`,
      {
        method: "POST",
        body: JSON.stringify({ path }),
      }
    );
    return response.entries;
  }

  // issue #3498: create a directory on a machine. `recursive:false` for the
  // inline "New folder" row (an existing folder → 409 EEXIST, surfaced inline);
  // `recursive:true` for the typed-path "Create & select" (mkdir -p). request<T>
  // throws ApiError on 403/409/400, which the DirectoryBrowser humanizes.
  async createMachineDirectory(
    machineId: string,
    path: string,
    recursive: boolean
  ): Promise<DirectoryEntry> {
    const response = await this.request<CreateDirectoryResponse>(
      `/api/machines/${encodeURIComponent(machineId)}/create-directory`,
      {
        method: "POST",
        body: JSON.stringify({ path, recursive }),
      }
    );
    return response.entry;
  }

  async getRecentPaths(machineId: string): Promise<string[]> {
    const response = await this.request<{ paths: string[] }>(
      `/api/machines/${encodeURIComponent(machineId)}/recent-paths`
    );
    return response.paths;
  }

  async addRecentPath(machineId: string, path: string): Promise<void> {
    await this.request(
      `/api/machines/${encodeURIComponent(machineId)}/recent-paths`,
      {
        method: "POST",
        body: JSON.stringify({ path }),
      }
    );
  }

  async removeRecentPath(machineId: string, path: string): Promise<void> {
    await this.request(
      `/api/machines/${encodeURIComponent(machineId)}/recent-paths`,
      {
        method: "DELETE",
        body: JSON.stringify({ path }),
      }
    );
  }

  async spawnSession(
    machineId: string,
    directory: string,
    agent?: "claude" | "codex" | "gemini" | "opencode",
    yolo?: boolean,
    sessionType?: "simple" | "worktree",
    worktreeName?: string,
    name?: string,
    // Issue #1262: opt-in to spawn-time port claim. Default-undefined =
    // server's default-false. The web UI's session-create flow passes
    // `true` explicitly so user-initiated worktree spawns still get a port.
    claimPort?: boolean,
    // Issue #1455: bind the new session to a selected account. Omitted →
    // host/node-default credential (preserves prior single-account behavior).
    accountUuid?: string,
    // Issue #1633: launch with Claude Code's --safe-mode (CLAUDE.md, skills,
    // hooks, MCP customizations disabled) — for Fable testing. Spawn-only.
    safeMode?: boolean,
    // Issue #1660: per-session launcher override (sdk | tmux | pty). Omitted by
    // the caller when the selection equals the resolved global default.
    launcher?: ClaudeRemoteLauncherKind,
    // Issue #1733: OpenRouter model id ("provider/model") for a Codex session.
    model?: string,
    // Issue #3349 (D4(a)): native-vs-OpenRouter routing discriminator for an
    // opencode spawn. "native" → `model` above is a native `provider/model`.
    modelRouting?: "native" | "openrouter",
    // Issue #1953 (A6): clone-on-spawn repo ("owner/repo"). Forwarded daemon-ward
    // so the daemon clones it into the working dir before launch.
    cloneRepo?: string,
    // Issue #2434: Claude model-mode pin ("sonnet"|"opus"|"fable"|"default") so
    // the session starts on the intended model atomically. DISTINCT from
    // `model` above (the #1733 OpenRouter gateway axis).
    modelMode?: ModelMode,
    // Issue #2456: reasoning-effort level + specific pinned raw Claude model id.
    effort?: EffortLevel,
    rawModel?: string,
    // Issue #2626 (D): per-session output style name ("default" | "Explanatory"
    // | "Learning" or a custom style). Forwarded to the spawn route as
    // `outputStyle`; the daemon threads it to the child as --hapi-output-style.
    outputStyle?: string,
    // Issue #3348: bundled non-claude native model selection (gemini id → env,
    // codex id + effort → config.toml bake). Interpreted by AGENT at the daemon.
    nativeModelSelection?: { modelId?: string; reasoningEffort?: string },
    // Issue #3515: opt in to the early-ack optimistic-spawn path. When true the
    // server mints the id, registers a `spawning` placeholder, and answers
    // `{type:"accepted", sessionId}` before the daemon spawn RPC resolves — so
    // the web can navigate to a live placeholder screen immediately. Omitted =
    // the legacy synchronous `{success|error}` path (byte-identical to pre-#3515).
    earlyReturn?: boolean,
    // hapimatic-private#4481: open the worktree on this EXISTING branch.
    // Omitted for every other spawn (byte-identical payload).
    existingBranch?: ExistingBranch,
    // Issue #4568: bill the session to the node-vault Anthropic API key with this
    // id (never the key). LOCAL spawns only — `spawnOnNode` has no such field,
    // because a node's keys never cross the federation. Omitted otherwise.
    apiKeyId?: string
  ): Promise<SpawnResponse> {
    return await this.request<SpawnResponse>(
      `/api/machines/${encodeURIComponent(machineId)}/spawn`,
      {
        method: "POST",
        body: JSON.stringify({
          directory,
          agent,
          yolo,
          claimPort,
          sessionType,
          worktreeName,
          name,
          accountUuid,
          apiKeyId,
          safeMode,
          launcher,
          model,
          modelRouting,
          cloneRepo,
          modelMode,
          effort,
          rawModel,
          outputStyle,
          nativeModelSelection,
          earlyReturn,
          existingBranch,
        }),
      },
      0,
      undefined,
      ApiClient.SPAWN_TIMEOUT_MS
    );
  }

  // TODO(#978): Migrate to /api/sessions/federation/nodes when route consolidation is complete
  async spawnOnNode(
    nodeId: string,
    directory: string,
    agent?: "claude" | "codex" | "gemini" | "opencode",
    yolo?: boolean,
    sessionType?: "simple" | "worktree",
    worktreeName?: string,
    name?: string,
    emoji?: string,
    spawnCorrelationId?: string,
    // Issue #1262: opt-in to spawn-time port claim on the federated node.
    claimPort?: boolean,
    // Issue #1455: forwarded for forward-compat; the federation receiver
    // threads it once #1486 ships. Harmless (ignored) on older nodes.
    accountUuid?: string,
    // Issue #1633: --safe-mode launch on the federated node. Harmless
    // (schema-dropped) on older nodes.
    safeMode?: boolean,
    // Issue #1660: per-session launcher override on the federated node. Harmless
    // (schema-dropped) on older nodes.
    launcher?: ClaudeRemoteLauncherKind,
    // Issue #1733: OpenRouter model id for a Codex session on the federated
    // node. Harmless (schema-dropped) on older nodes.
    model?: string,
    // Issue #3349 (D4(a)): native-vs-OpenRouter routing discriminator on the
    // federated node. Harmless (schema-dropped) on older nodes.
    modelRouting?: "native" | "openrouter",
    // Issue #1953 (A6): clone-on-spawn repo on the federated node. Harmless
    // (schema-dropped) on older nodes.
    cloneRepo?: string,
    // Issue #2434: Claude model-mode pin on the federated node. Harmless
    // (schema-dropped) on older nodes.
    modelMode?: ModelMode,
    // Issue #2456: reasoning-effort + specific raw-model pin on the federated
    // node. Harmless (schema-dropped) on older nodes.
    effort?: EffortLevel,
    rawModel?: string,
    // Issue #2626 (D): per-session output style on the federated node. Harmless
    // (schema-dropped) on older nodes.
    outputStyle?: string,
    // Issue #3348: bundled non-claude native model selection on the federated
    // node (gemini id / codex id + effort). Harmless (schema-dropped) on older nodes.
    nativeModelSelection?: { modelId?: string; reasoningEffort?: string },
    // hapimatic-private#4481: existing-branch worktree on the federated node.
    // Only sent after that node answered the branch listing (same release).
    existingBranch?: ExistingBranch
  ): Promise<SpawnResponse> {
    return await this.request<SpawnResponse>(
      `/api/federation/nodes/${encodeURIComponent(nodeId)}/spawn`,
      {
        method: "POST",
        body: JSON.stringify({
          directory,
          agent,
          yolo,
          claimPort,
          sessionType,
          worktreeName,
          name,
          emoji,
          spawnCorrelationId,
          accountUuid,
          safeMode,
          launcher,
          model,
          modelRouting,
          cloneRepo,
          modelMode,
          effort,
          rawModel,
          outputStyle,
          nativeModelSelection,
          existingBranch,
        }),
      },
      0,
      undefined,
      ApiClient.SPAWN_TIMEOUT_MS
    );
  }

  // TODO(#978): Migrate to /api/sessions/federation/nodes when route consolidation is complete
  async listNodeDirectory(
    nodeId: string,
    path: string
  ): Promise<DirectoryEntry[]> {
    const response = await this.request<{
      type: "success";
      entries: DirectoryEntry[];
    }>(`/api/federation/nodes/${encodeURIComponent(nodeId)}/list-directory`, {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    return response.entries;
  }

  // TODO(#978): Migrate to /api/sessions/federation/nodes when route consolidation is complete
  // issue #3498: create a directory on a remote federation node.
  async createNodeDirectory(
    nodeId: string,
    path: string,
    recursive: boolean
  ): Promise<DirectoryEntry> {
    const response = await this.request<{
      type: "success";
      entry: DirectoryEntry;
    }>(`/api/federation/nodes/${encodeURIComponent(nodeId)}/create-directory`, {
      method: "POST",
      body: JSON.stringify({ path, recursive }),
    });
    return response.entry;
  }

  // TODO(#978): Migrate to /api/sessions/federation/nodes when route consolidation is complete
  async checkNodePathsExists(
    nodeId: string,
    paths: string[]
  ): Promise<MachinePathsExistsResponse> {
    return await this.request<MachinePathsExistsResponse>(
      `/api/federation/nodes/${encodeURIComponent(nodeId)}/paths/exists`,
      {
        method: "POST",
        body: JSON.stringify({ paths }),
      }
    );
  }

  // TODO(#978): Migrate to /api/sessions/federation/nodes when route consolidation is complete
  async getNodeRecentPaths(nodeId: string): Promise<string[]> {
    const response = await this.request<{ type: "success"; paths: string[] }>(
      `/api/federation/nodes/${encodeURIComponent(nodeId)}/recent-paths`,
      { method: "POST" }
    );
    return response.paths;
  }

  // TODO(#978): Migrate to /api/sessions/federation/nodes when route consolidation is complete
  async addNodeRecentPath(nodeId: string, path: string): Promise<void> {
    await this.request(
      `/api/federation/nodes/${encodeURIComponent(nodeId)}/recent-paths/add`,
      {
        method: "POST",
        body: JSON.stringify({ path }),
      }
    );
  }

  // TODO(#978): Migrate to /api/sessions/federation/nodes when route consolidation is complete
  async removeNodeRecentPath(nodeId: string, path: string): Promise<void> {
    await this.request(
      `/api/federation/nodes/${encodeURIComponent(nodeId)}/recent-paths/remove`,
      {
        method: "POST",
        body: JSON.stringify({ path }),
      }
    );
  }

  async getSlashCommands(sessionId: string): Promise<SlashCommandsResponse> {
    return await this.request<SlashCommandsResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/slash-commands`
    );
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  async updateSessionNotes(
    sessionId: string,
    notes: NotesContent | string | null
  ): Promise<void> {
    // Issue #1075: a NotesContent object is serialized to the JSON envelope wire
    // string; a legacy plain string / null passes through unchanged (preserves
    // the pre-#1075 code path). The server treats the value as opaque.
    const serialized =
      notes !== null && typeof notes === "object"
        ? serializeNotes(notes)
        : notes;
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/notes`, {
      method: "PUT",
      body: JSON.stringify({ notes: serialized }),
    });
  }

  async updateSessionView(
    sessionId: string,
    view: SessionView | null
  ): Promise<void> {
    // Issue #3286 (View Picker): persist the selected view. The server
    // enum-validates via SessionViewSchema; a plain string rides the wire.
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/view`, {
      method: "PUT",
      body: JSON.stringify({ view }),
    });
  }

  /**
   * Delete uploaded attachment files from a session's UserFileUploads directory
   * (issue #1075). Idempotent — absent files are a no-op success. `filenames`
   * are the server-assigned stored filenames (an attachment's `storedName`).
   * Best-effort: used by the notes trashcan; a failure never blocks clearing.
   */
  async removeUploadedFiles(
    sessionId: string,
    filenames: string[]
  ): Promise<void> {
    if (filenames.length === 0) return;
    await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/uploads/delete`,
      {
        method: "POST",
        body: JSON.stringify({ filenames }),
      }
    );
  }

  async updateSessionPromptDraft(
    sessionId: string,
    promptDraft: string | null
  ): Promise<void> {
    await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/prompt-draft`,
      {
        method: "PUT",
        body: JSON.stringify({ promptDraft }),
      }
    );
  }

  async updateSessionEmoji(
    sessionId: string,
    emoji: string | null
  ): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/emoji`, {
      method: "PUT",
      body: JSON.stringify({ emoji }),
    });
  }

  // ── Issue #3115: server-side chat bookmarks (node-local, session-scoped) ────
  async getBookmarks(sessionId: string): Promise<BookmarkListResponse> {
    return await this.request<BookmarkListResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/bookmarks`
    );
  }

  async putBookmark(
    sessionId: string,
    bookmark: BookmarkUpsertRequest
  ): Promise<BookmarkUpsertResponse> {
    return await this.request<BookmarkUpsertResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/bookmarks`,
      {
        method: "PUT",
        body: JSON.stringify(bookmark),
      }
    );
  }

  async deleteBookmark(sessionId: string, bookmarkId: string): Promise<void> {
    await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/bookmarks/${encodeURIComponent(bookmarkId)}`,
      { method: "DELETE" }
    );
  }

  async clearBookmarks(sessionId: string): Promise<void> {
    await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/bookmarks`,
      { method: "DELETE" }
    );
  }

  // ── Issue #1325: server-backed message queue ────────────────────
  async getQueue(sessionId: string): Promise<{ messages: QueuedMessage[] }> {
    return await this.request<{ messages: QueuedMessage[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/queue`
    );
  }

  async enqueueQueuedMessage(
    sessionId: string,
    body: string,
    clientGeneratedId?: string | null
  ): Promise<{
    ok: true;
    result: "inserted" | "deduplicated";
    row: QueuedMessage;
  }> {
    return await this.request<{
      ok: true;
      result: "inserted" | "deduplicated";
      row: QueuedMessage;
    }>(`/api/sessions/${encodeURIComponent(sessionId)}/queue/enqueue`, {
      method: "POST",
      body: JSON.stringify({ body, clientGeneratedId }),
    });
  }

  async updateQueuedMessage(
    sessionId: string,
    position: number,
    body: string
  ): Promise<{ ok: true; row: QueuedMessage }> {
    return await this.request<{ ok: true; row: QueuedMessage }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/queue/${position}`,
      { method: "PATCH", body: JSON.stringify({ body }) }
    );
  }

  async removeQueuedMessage(
    sessionId: string,
    position: number
  ): Promise<{ ok: true; removed: true }> {
    return await this.request<{ ok: true; removed: true }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/queue/${position}`,
      { method: "DELETE" }
    );
  }

  async clearQueue(sessionId: string): Promise<{ ok: true; count: number }> {
    return await this.request<{ ok: true; count: number }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/queue`,
      { method: "DELETE" }
    );
  }

  async drainQueueHead(
    sessionId: string
  ): Promise<{ ok: true; sent: boolean; remaining: number }> {
    return await this.request<{
      ok: true;
      sent: boolean;
      remaining: number;
    }>(`/api/sessions/${encodeURIComponent(sessionId)}/queue/drain`, {
      method: "POST",
    });
  }

  async updateSessionLinkedIssue(
    sessionId: string,
    linkedIssue: {
      number: number;
      title: string;
      repo: string;
      state?: "open" | "closed";
    } | null
  ): Promise<void> {
    await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/linked-issue`,
      {
        method: "PUT",
        body: JSON.stringify(linkedIssue),
      }
    );
  }

  async updateSessionNeedsReviewOverride(
    sessionId: string,
    override: "read" | "unread" | null
  ): Promise<void> {
    await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/needs-review-override`,
      {
        method: "PUT",
        body: JSON.stringify(override),
      }
    );
  }

  async updateSessionAutoRecoverFromApiError(
    sessionId: string,
    autoRecover: boolean | null
  ): Promise<void> {
    await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/auto-recover`,
      {
        method: "PUT",
        body: JSON.stringify(autoRecover),
      }
    );
  }

  async updateSessionUiCollapseState(
    sessionId: string,
    uiCollapseState: {
      promptCollapsed?: boolean;
      notesCollapsed?: boolean;
      tokenUsageCollapsed?: boolean;
      detailsCollapsed?: boolean;
      backgroundAgentsCollapsed?: boolean;
    } | null
  ): Promise<void> {
    await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/ui-collapse-state`,
      {
        method: "PUT",
        body: JSON.stringify(uiCollapseState),
      }
    );
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
  }

  async bulkDeleteSessions(
    ids: string[]
  ): Promise<{ deleted: string[]; skipped: string[] }> {
    return await this.request<{ deleted: string[]; skipped: string[] }>(
      "/api/sessions/bulk-delete",
      {
        method: "POST",
        body: JSON.stringify({ ids }),
      }
    );
  }

  async getGitHubIssue(
    owner: string,
    repo: string,
    number: number
  ): Promise<{
    success: boolean;
    issue?: {
      number: number;
      title: string;
      state: "open" | "closed";
      labels: Array<{ name: string; color: string }>;
      body: string;
    };
    error?: string;
  }> {
    return await this.request(
      `/api/github/issues/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`
    );
  }

  /**
   * List open GitHub issues for the repo detected from a directory's git remote.
   */
  async listRepoIssues(
    directory: string,
    nodeId?: string | null
  ): Promise<{
    success: boolean;
    repo: string | null;
    issues: Array<{
      number: number;
      title: string;
      labels: string[];
      state: "open" | "closed";
    }>;
    /** Issue #2270 (F25): true git-ness of `directory` (tri-state; undefined = unknown). */
    directoryIsGitRepo?: boolean;
    error?: string;
  }> {
    let url = `/api/github/repo-issues?dir=${encodeURIComponent(directory)}`;
    if (nodeId) {
      url += `&nodeId=${encodeURIComponent(nodeId)}`;
    }
    return await this.request(url);
  }

  /**
   * hapimatic-private#4481: the Create-page Branch control listing for a
   * directory on the local server's node, or on `nodeId` (proxied to the peer).
   * `success:false` = lookup unavailable (the page falls back to today's UI).
   */
  async listGitBranches(
    directory: string,
    nodeId?: string | null
  ): Promise<
    | { success: true; listing: GitBranchListing }
    | { success: false; error: string }
  > {
    let url = `/api/git/branches?dir=${encodeURIComponent(directory)}`;
    if (nodeId) url += `&nodeId=${encodeURIComponent(nodeId)}`;
    return await this.request(url);
  }

  /**
   * List open GitHub issues by owner/repo name (no directory resolution needed).
   */
  async listRepoIssuesByName(repoName: string): Promise<{
    success: boolean;
    repo: string | null;
    issues: Array<{
      number: number;
      title: string;
      labels: string[];
      state: "open" | "closed";
    }>;
    error?: string;
  }> {
    return await this.request(
      `/api/github/repo-issues?repo=${encodeURIComponent(repoName)}`
    );
  }

  /**
   * Issue #1953 (A6): list the host `gh` CLI identity(ies) for the
   * GitHub-account selector. Federation-aware via optional nodeId. The response
   * NEVER carries a gh token.
   */
  async getGitHubAccounts(nodeId?: string | null): Promise<{
    success: boolean;
    accounts: Array<{ login: string; name: string | null }>;
    error?: string;
    /** #2327: machine-readable failure cause when `success` is false. */
    reason?: string;
    /** #2327: which transport served a successful result ("gh" | "rest"). */
    source?: string;
  }> {
    let url = `/api/github/accounts`;
    if (nodeId) {
      url += `?nodeId=${encodeURIComponent(nodeId)}`;
    }
    return await this.request(url);
  }

  /**
   * Issue #1953 (A6): list repositories accessible to a host `gh` account.
   * Federation-aware via optional nodeId. Graceful empty result on failure.
   */
  async getGitHubRepos(
    account: string,
    nodeId?: string | null
  ): Promise<{
    success: boolean;
    account: string | null;
    repos: Array<{
      nameWithOwner: string;
      name: string;
      description: string | null;
      isPrivate: boolean;
      pushedAt: string | null;
    }>;
    error?: string;
    /** #2327: machine-readable failure cause when `success` is false. */
    reason?: string;
    /** #2327: which transport served a successful result ("gh" | "rest"). */
    source?: string;
  }> {
    let url = `/api/github/repos?account=${encodeURIComponent(account)}`;
    if (nodeId) {
      url += `&nodeId=${encodeURIComponent(nodeId)}`;
    }
    return await this.request(url);
  }

  /**
   * Get system health metrics from the host machine
   */
  async getSystemHealth(): Promise<{
    cpu: { usagePercent: number; temperatureF: number | null };
    memory: { total: number; used: number; usagePercent: number };
    swap: { total: number; used: number; usagePercent: number };
    disk: {
      total: number;
      used: number;
      usagePercent: number;
      mountPoint: string;
    };
    hostname: string;
    timestamp: number;
    uptime: number;
  }> {
    return await this.request("/api/system-health");
  }

  /**
   * Get the federation-wide aggregate health (worst-case severity across all
   * nodes/dimensions). Issue #1445; consumed by useSystemHealthDisplayTarget
   * (#1040) and the Federation Health Dashboard (#1037). On standalone/spoke
   * deployments with no HealthAggregator this endpoint returns 503 — callers
   * MUST tolerate the rejection (the icon falls back to local health).
   *
   * Issue #2362: that 503 is also suppressed at the error-report boundary (see
   * FEDERATION_HEALTH_REPORT_OPTS) — it is a designed response, not a fault.
   */
  async getFederationHealthAggregate(): Promise<FederationHealthAggregate> {
    return await this.request(
      "/api/federation/health/aggregate",
      undefined,
      0,
      undefined,
      ApiClient.DEFAULT_TIMEOUT_MS,
      FEDERATION_HEALTH_REPORT_OPTS
    );
  }

  /**
   * Get a single federation node's health detail (metrics + time-series).
   * Issue #1445.
   *
   * Issue #2362: a 503 here (health disabled) is suppressed at the error-report
   * boundary. A 404 (unknown node) is NOT — that is a genuine caller error.
   */
  async getFederationNodeHealth(
    nodeId: string
  ): Promise<FederationNodeHealthDetail> {
    return await this.request(
      "/api/federation/health/" + encodeURIComponent(nodeId),
      undefined,
      0,
      undefined,
      ApiClient.DEFAULT_TIMEOUT_MS,
      FEDERATION_HEALTH_REPORT_OPTS
    );
  }

  /**
   * Batch per-node health for the Federation Health Dashboard's Tier-2 cards
   * (issue #1632; consumed by #1037). One request → one entry per node, offline
   * nodes preserved (NO aggregation collapse). Returns 503 on standalone/spoke
   * deployments with no HealthAggregator — callers MUST tolerate the rejection.
   *
   * Issue #2362: that 503 is also suppressed at the error-report boundary (see
   * FEDERATION_HEALTH_REPORT_OPTS) — it is a designed response, not a fault.
   */
  async getFederationHealthNodes(): Promise<FederationHealthNodesResponse> {
    return await this.request(
      "/api/federation/health/nodes",
      undefined,
      0,
      undefined,
      ApiClient.DEFAULT_TIMEOUT_MS,
      FEDERATION_HEALTH_REPORT_OPTS
    );
  }

  /**
   * Get the federation alerts feed (issue #1445; consumed by #1037's Tier-1
   * incidents feed). Newest-first; cursor-based pagination via the returned
   * `nextCursor`. Returns 503 on standalone/spoke deployments — callers MUST
   * tolerate the rejection.
   *
   * Issue #2362: that 503 is also suppressed at the error-report boundary (see
   * FEDERATION_HEALTH_REPORT_OPTS) — it is a designed response, not a fault.
   */
  async getFederationAlerts(opts?: {
    cursor?: string;
    limit?: number;
    nodeId?: string;
  }): Promise<FederationAlertsResponse> {
    const params = new URLSearchParams();
    if (opts?.cursor) params.set("cursor", opts.cursor);
    if (opts?.limit !== undefined) params.set("limit", `${opts.limit}`);
    if (opts?.nodeId) params.set("nodeId", opts.nodeId);
    const qs = params.toString();
    return await this.request(
      `/api/federation/alerts${qs ? `?${qs}` : ""}`,
      undefined,
      0,
      undefined,
      ApiClient.DEFAULT_TIMEOUT_MS,
      FEDERATION_HEALTH_REPORT_OPTS
    );
  }

  // ---------------------------------------------------------------------------
  // Voice input (issue #4707) — `builtin.voice-input` server extension.
  // A 404 from /voice/status means the extension is disabled (mic hidden), so it
  // is an expected status, not a fault to report.
  // ---------------------------------------------------------------------------

  async getVoiceStatus(): Promise<VoiceStatusResponse> {
    return await this.request<VoiceStatusResponse>(
      "/api/voice/status",
      undefined,
      0,
      undefined,
      ApiClient.DEFAULT_TIMEOUT_MS,
      { expectedStatuses: [404] }
    );
  }

  async warmVoice(): Promise<void> {
    await this.request<{ ok: true }>(
      "/api/voice/warm",
      { method: "POST", body: "{}" },
      0,
      undefined,
      ApiClient.DEFAULT_TIMEOUT_MS,
      { expectedStatuses: [404] }
    );
  }

  /** Transcribe a 16 kHz mono PCM16 WAV. Long recordings can take ~40 s on a Pi 5. */
  async transcribeVoice(wav: Blob): Promise<VoiceTranscribeResponse> {
    return await this.request<VoiceTranscribeResponse>(
      "/api/voice/transcribe",
      {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: wav,
      },
      0,
      undefined,
      180_000,
      { expectedStatuses: [400, 413, 429, 503] }
    );
  }

  async installVoiceEngine(model?: VoiceModelId): Promise<void> {
    await this.request<{ ok: true }>("/api/voice/engine/install", {
      method: "POST",
      body: JSON.stringify(model ? { model } : {}),
    });
  }

  async removeVoiceEngine(): Promise<void> {
    await this.request<{ ok: true }>("/api/voice/engine", {
      method: "DELETE",
    });
  }

  async updateVoiceSettings(
    update: VoiceSettingsUpdate
  ): Promise<VoiceStatusResponse> {
    return await this.request<VoiceStatusResponse>("/api/voice/settings", {
      method: "PUT",
      body: JSON.stringify(update),
    });
  }

  /**
   * Upload a file to the session's UserFileUploads directory
   */
  async uploadFile(
    sessionId: string,
    file: File
  ): Promise<{
    success: boolean;
    file?: {
      name: string;
      storedName: string;
      path: string;
      size: number;
      type: string;
    };
    error?: string;
  }> {
    const formData = new FormData();
    formData.append("file", file);

    const liveToken = this.getToken ? this.getToken() : null;
    const authToken = liveToken ?? this.token;

    const res = await fetch(
      this.buildUrl(`/api/sessions/${encodeURIComponent(sessionId)}/upload`),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${authToken}`,
          // Note: Don't set Content-Type for FormData - browser sets it with boundary
        },
        body: formData,
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      try {
        const parsed = JSON.parse(body);
        return {
          success: false,
          error: parsed.error || `Upload failed: HTTP ${res.status}`,
        };
      } catch {
        // Provide user-friendly messages for common HTTP status codes
        if (res.status === 413) {
          return {
            success: false,
            error: "File too large for server. Try a smaller file.",
          };
        }
        if (res.status === 401 || res.status === 403) {
          return { success: false, error: "Not authorized to upload files" };
        }
        if (res.status === 404) {
          return { success: false, error: "Session not found" };
        }
        return { success: false, error: `Upload failed: HTTP ${res.status}` };
      }
    }

    return await res.json();
  }

  /**
   * Build a URL for serving an uploaded file, with JWT token as query param.
   * Used for <img src> tags which can't set Authorization headers.
   */
  getUploadFileUrl(sessionId: string, filename: string): string {
    const liveToken = this.getToken ? this.getToken() : null;
    const authToken = liveToken ?? this.token;
    const path = `/api/sessions/${encodeURIComponent(sessionId)}/upload/${encodeURIComponent(filename)}`;
    const url = this.buildUrl(path);
    return `${url}?token=${encodeURIComponent(authToken)}`;
  }

  // ==================== Time Log API ====================

  /**
   * Get time log entries with optional filters
   */
  async getTimeLogs(filters?: TimeLogFilters): Promise<TimeLogListResponse> {
    const params = new URLSearchParams();
    if (filters?.startDate) {
      params.set("startDate", filters.startDate);
    }
    if (filters?.endDate) {
      params.set("endDate", filters.endDate);
    }
    if (filters?.sessionId) {
      params.set("sessionId", filters.sessionId);
    }
    if (filters?.projectDirectory) {
      params.set("projectDirectory", filters.projectDirectory);
    }
    if (filters?.limit !== undefined) {
      params.set("limit", `${filters.limit}`);
    }

    const qs = params.toString();
    return await this.request<TimeLogListResponse>(
      `/api/timelogs${qs ? `?${qs}` : ""}`
    );
  }

  /**
   * Get daily summary for a specific date
   * @param date - ISO date (YYYY-MM-DD), defaults to today in Eastern Time
   */
  async getTimeLogDailySummary(date?: string): Promise<TimeLogDailySummary> {
    const params = new URLSearchParams();
    if (date) {
      params.set("date", date);
    }
    const qs = params.toString();
    return await this.request<TimeLogDailySummary>(
      `/api/timelogs/summary/daily${qs ? `?${qs}` : ""}`
    );
  }

  /**
   * Get weekly summary starting from a specific date
   * @param startDate - Start of week in ISO format (YYYY-MM-DD)
   */
  async getTimeLogWeeklySummary(
    startDate: string
  ): Promise<TimeLogWeeklySummary> {
    const params = new URLSearchParams();
    params.set("startDate", startDate);
    return await this.request<TimeLogWeeklySummary>(
      `/api/timelogs/summary/weekly?${params.toString()}`
    );
  }

  /**
   * Get list of distinct project directories in time logs
   */
  async getTimeLogProjects(): Promise<TimeLogProjectsResponse> {
    return await this.request<TimeLogProjectsResponse>(
      "/api/timelogs/projects"
    );
  }

  /**
   * Get project-grouped summary for a date range
   */
  async getTimeLogProjectGrouped(
    startDate: string,
    endDate: string
  ): Promise<TimeLogProjectGroupedSummary> {
    const params = new URLSearchParams();
    params.set("startDate", startDate);
    params.set("endDate", endDate);
    return await this.request<TimeLogProjectGroupedSummary>(
      `/api/timelogs/summary/project-grouped?${params.toString()}`
    );
  }

  // ── Issue #1670 (Sub H1, PR-2): six-control ledger + derived read + gate ──

  /** Append one of the six clock controls to the manual ledger (R3/R4). */
  async postTimelogAdjustment(
    req: TimelogAdjustmentRequest
  ): Promise<TimelogAdjustmentResponse> {
    return await this.request<TimelogAdjustmentResponse>(
      "/api/timelogs/adjustments",
      { method: "POST", body: JSON.stringify(req) }
    );
  }

  /** Read the namespace's adjustment ledger back (Undo target selection). */
  async getTimelogAdjustments(
    startMs?: number,
    endMs?: number
  ): Promise<TimelogAdjustmentsResponse> {
    const params = new URLSearchParams();
    if (startMs !== undefined) params.set("startMs", `${startMs}`);
    if (endMs !== undefined) params.set("endMs", `${endMs}`);
    const qs = params.toString();
    return await this.request<TimelogAdjustmentsResponse>(
      `/api/timelogs/adjustments${qs ? `?${qs}` : ""}`
    );
  }

  /** TS-derived daily buckets for a date range (the gated read path). */
  async getDerivedTimeLog(
    startDate?: string,
    endDate?: string
  ): Promise<DerivedTimeLogResponse> {
    const params = new URLSearchParams();
    if (startDate) params.set("startDate", startDate);
    if (endDate) params.set("endDate", endDate);
    const qs = params.toString();
    return await this.request<DerivedTimeLogResponse>(
      `/api/timelogs/derived${qs ? `?${qs}` : ""}`
    );
  }

  /** Is the time-log derived read-path cutover gate open? */
  async getTimelogCutoverStatus(): Promise<TimelogCutoverStatus> {
    return await this.request<TimelogCutoverStatus>(
      "/api/timelogs/cutover-status"
    );
  }

  // ==================== Schedules API ====================

  async getSchedules(): Promise<SchedulesResponse> {
    return await this.request<SchedulesResponse>("/api/schedules");
  }

  async getSchedule(id: string): Promise<ScheduleResponse> {
    return await this.request<ScheduleResponse>(
      `/api/schedules/${encodeURIComponent(id)}`
    );
  }

  async createSchedule(
    input: CreateScheduledTaskRequest
  ): Promise<ScheduleResponse> {
    return await this.request<ScheduleResponse>("/api/schedules", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updateSchedule(
    id: string,
    input: UpdateScheduledTaskRequest
  ): Promise<ScheduleResponse> {
    return await this.request<ScheduleResponse>(
      `/api/schedules/${encodeURIComponent(id)}`,
      {
        method: "PUT",
        body: JSON.stringify(input),
      }
    );
  }

  /**
   * #3172: `children` decides what happens to the sessions the schedule spawned
   * — "orphan" (server default) keeps them as top-level sessions, "cascade"
   * archives and deletes them.
   */
  async deleteSchedule(
    id: string,
    children?: ScheduleChildDisposition
  ): Promise<void> {
    const query = children ? `?children=${children}` : "";
    await this.request(`/api/schedules/${encodeURIComponent(id)}${query}`, {
      method: "DELETE",
    });
  }

  async toggleSchedule(id: string): Promise<ScheduleResponse> {
    return await this.request<ScheduleResponse>(
      `/api/schedules/${encodeURIComponent(id)}/toggle`,
      { method: "POST" }
    );
  }

  async runScheduleNow(
    id: string
  ): Promise<ExecutionResponse & { error?: string }> {
    return await this.request(`/api/schedules/${encodeURIComponent(id)}/run`, {
      method: "POST",
    });
  }

  async getScheduleHistory(
    id: string,
    limit?: number,
    offset?: number
  ): Promise<ExecutionHistoryResponse> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", `${limit}`);
    if (offset !== undefined) params.set("offset", `${offset}`);
    const qs = params.toString();
    return await this.request<ExecutionHistoryResponse>(
      `/api/schedules/${encodeURIComponent(id)}/history${qs ? `?${qs}` : ""}`
    );
  }

  // ==================== Harness self-update API ====================
  // Epic #1769 Sub-Issue D (#1773) — the admin harness-update panel. All four
  // routes are JWT-gated under /api/harness (server: harness.ts /
  // harnessChangelog.ts / harnessAnalysis.ts). request<T>() throws ApiError on
  // non-2xx; the query hooks catch ApiError.status 404/503 and resolve an
  // "unavailable" sentinel so a boot-window miss never spams the Error Log (R8).

  /** GET /api/harness/status (#1770) — this node's harness detection state:
   *  the redacted descriptor + persisted state for every registry entry. */
  async getHarnessStatus(): Promise<HarnessStatusResponse> {
    return await this.request<HarnessStatusResponse>("/api/harness/status");
  }

  /** GET /api/harness/:harnessId/changelog (#1771) — the parsed verbatim
   *  changelog span for the installed→latest range. No range param: the server
   *  computes the span from #1770's detection state. */
  async getHarnessChangelog(harnessId: string): Promise<ChangelogSpan> {
    return await this.request<ChangelogSpan>(
      `/api/harness/${encodeURIComponent(harnessId)}/changelog`
    );
  }

  /** GET /api/harness/:harnessId/analysis?range=<from>..<to> (#1772) — the
   *  discriminated analysis-status envelope. `range` is `"<from>..<to>"`. */
  async getHarnessAnalysis(
    harnessId: string,
    range: string
  ): Promise<HarnessAnalysisResponse> {
    return await this.request<HarnessAnalysisResponse>(
      `/api/harness/${encodeURIComponent(harnessId)}/analysis?range=${encodeURIComponent(range)}`
    );
  }

  /** POST /api/harness/:harnessId/analyze (#1772) — trigger the impact analysis
   *  for this harness's PENDING update (the server builds the installed→latest
   *  span from detection state, so no range is sent). A duplicate in-flight
   *  trigger returns the existing session_id under status "analyzing". */
  async triggerHarnessAnalysis(
    harnessId: string
  ): Promise<TriggerAnalysisResponse> {
    return await this.request<TriggerAnalysisResponse>(
      `/api/harness/${encodeURIComponent(harnessId)}/analyze`,
      { method: "POST" }
    );
  }

  /** POST /api/harness/:harnessId/update (#1774) — apply the pending update to
   *  `version` (which MUST equal the detected latest; the server rejects a
   *  mismatch with 409 version_mismatch). PRIVILEGED: the command is resolved
   *  server-side from the code-defined registry and NEVER returned (R11). On
   *  non-2xx, request() throws ApiError carrying the server's { code } (e.g.
   *  update_in_flight / version_mismatch / exec_failed / not_supported_remote). */
  async updateHarness(
    harnessId: string,
    version: string
  ): Promise<HarnessApplyResponse> {
    return await this.request<HarnessApplyResponse>(
      `/api/harness/${encodeURIComponent(harnessId)}/update`,
      { method: "POST", body: JSON.stringify({ version }) }
    );
  }

  /** POST /api/harness/:harnessId/rollback (#1774) — roll back to the captured
   *  prior version (EXCLUSIVELY the server-held prior_version, never a
   *  client-supplied version). 409 no_prior_version when none was captured. */
  async rollbackHarness(harnessId: string): Promise<HarnessApplyResponse> {
    return await this.request<HarnessApplyResponse>(
      `/api/harness/${encodeURIComponent(harnessId)}/rollback`,
      { method: "POST", body: JSON.stringify({}) }
    );
  }

  // ==================== System Jobs API ====================
  // Bound to the #1537 node-scoped surface (epic #1534 ruling D1). The flat
  // /api/system-jobs/* client routes from #1536 are SUPERSEDED. request<T>()
  // throws ApiError on non-2xx (the mutate routes return a mapped non-2xx +
  // {ok:false,error,code} on failure); callers surface err.message.

  /**
   * Capability catalog (#3752, R5). NO `?sessionId=` — the server's scope filter is
   * unconditional + session-independent (#3749), so a Settings page (which has no
   * session) still gets a hard-filtered, `user`-scoped catalog. READ-ONLY.
   */
  async getCapabilityCatalog(): Promise<CapabilityCatalogResponse> {
    return await this.request<CapabilityCatalogResponse>(
      "/api/capabilities/catalog"
    );
  }

  /**
   * Capability audit (#3752, R5). `?format=full` — the drift ARRAYS
   * (forward/reverse/schemaErrors) live in the full shape; `summary` carries only
   * counts. READ-ONLY.
   */
  async getCapabilityAudit(): Promise<CapabilityAuditResponse> {
    return await this.request<CapabilityAuditResponse>(
      "/api/capabilities/audit?format=full"
    );
  }

  async getSystemJobsAll(): Promise<SystemJobsAllResponse> {
    return await this.request<SystemJobsAllResponse>("/api/system-jobs/all");
  }

  async enableSystemJob(
    nodeId: string,
    name: string
  ): Promise<SystemJobMutateResult> {
    return await this.request<SystemJobMutateResult>(
      `/api/nodes/${encodeURIComponent(nodeId)}/system-jobs/${encodeURIComponent(name)}/enable`,
      { method: "POST" }
    );
  }

  async disableSystemJob(
    nodeId: string,
    name: string
  ): Promise<SystemJobMutateResult> {
    return await this.request<SystemJobMutateResult>(
      `/api/nodes/${encodeURIComponent(nodeId)}/system-jobs/${encodeURIComponent(name)}/disable`,
      { method: "POST" }
    );
  }

  async deleteSystemJob(
    nodeId: string,
    name: string
  ): Promise<SystemJobMutateResult> {
    return await this.request<SystemJobMutateResult>(
      `/api/nodes/${encodeURIComponent(nodeId)}/system-jobs/${encodeURIComponent(name)}`,
      { method: "DELETE" }
    );
  }

  async rescheduleSystemJob(
    nodeId: string,
    name: string,
    schedule: string
  ): Promise<SystemJobMutateResult> {
    return await this.request<SystemJobMutateResult>(
      `/api/nodes/${encodeURIComponent(nodeId)}/system-jobs/${encodeURIComponent(name)}/reschedule`,
      { method: "POST", body: JSON.stringify({ schedule }) }
    );
  }

  async renameSystemJob(
    nodeId: string,
    name: string,
    newName: string
  ): Promise<SystemJobMutateResult> {
    return await this.request<SystemJobMutateResult>(
      `/api/nodes/${encodeURIComponent(nodeId)}/system-jobs/${encodeURIComponent(name)}/rename`,
      { method: "POST", body: JSON.stringify({ newName }) }
    );
  }

  async editSystemJobDescription(
    nodeId: string,
    name: string,
    description: string
  ): Promise<SystemJobMutateResult> {
    return await this.request<SystemJobMutateResult>(
      `/api/nodes/${encodeURIComponent(nodeId)}/system-jobs/${encodeURIComponent(name)}/description`,
      { method: "POST", body: JSON.stringify({ description }) }
    );
  }

  // ── loop-cron (issue #2453) ──────────────────────────────────────────
  // Node-scoped per the #1537 convention. Loop-cron routes are keyed on the
  // arm-time `<id>` (not a systemd unit name); `run` returns a tick verdict.
  // Mutations return 200 { ok, action, result } on success; request<T>() throws
  // on the mapped non-2xx failure, which the useLoopCronActions hook surfaces.

  /** The header badge's own-instance summary for a node. Pass LOCAL_NODE_ID for this node. */
  async getSessionLoopSummaries(
    nodeId: string
  ): Promise<SessionLoopSummaryResponse> {
    return await this.request<SessionLoopSummaryResponse>(
      `/api/nodes/${encodeURIComponent(nodeId)}/system-jobs/session-loop-summary`
    );
  }

  /** The cross-node aggregate session-loop summary (own-instance loops only). */
  async getSessionLoopSummariesAll(): Promise<SessionLoopSummaryAllResponse> {
    return await this.request<SessionLoopSummaryAllResponse>(
      "/api/system-jobs/session-loop-summary/all"
    );
  }

  async loopCronPause(
    nodeId: string,
    id: string
  ): Promise<LoopCronMutationResult> {
    return await this.request<LoopCronMutationResult>(
      `/api/nodes/${encodeURIComponent(nodeId)}/system-jobs/loop-cron/${encodeURIComponent(id)}/pause`,
      { method: "POST" }
    );
  }

  async loopCronResume(
    nodeId: string,
    id: string
  ): Promise<LoopCronMutationResult> {
    return await this.request<LoopCronMutationResult>(
      `/api/nodes/${encodeURIComponent(nodeId)}/system-jobs/loop-cron/${encodeURIComponent(id)}/resume`,
      { method: "POST" }
    );
  }

  /** Delete = purge (D1): removes the crontab line AND the state dir. */
  async loopCronDelete(
    nodeId: string,
    id: string
  ): Promise<LoopCronMutationResult> {
    return await this.request<LoopCronMutationResult>(
      `/api/nodes/${encodeURIComponent(nodeId)}/system-jobs/loop-cron/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
  }

  /** Run a real tick now; returns the verdict (R4). */
  async loopCronRunNow(nodeId: string, id: string): Promise<LoopCronRunResult> {
    return await this.request<LoopCronRunResult>(
      `/api/nodes/${encodeURIComponent(nodeId)}/system-jobs/loop-cron/${encodeURIComponent(id)}/run`,
      { method: "POST" }
    );
  }

  async loopCronReschedule(
    nodeId: string,
    id: string,
    interval: string
  ): Promise<LoopCronRescheduleResult> {
    return await this.request<LoopCronRescheduleResult>(
      `/api/nodes/${encodeURIComponent(nodeId)}/system-jobs/loop-cron/${encodeURIComponent(id)}/reschedule`,
      { method: "POST", body: JSON.stringify({ interval }) }
    );
  }

  /** Edit a loop-cron's action/prompt text (#3293). */
  async loopCronUpdateAction(
    nodeId: string,
    id: string,
    actionText: string
  ): Promise<LoopCronUpdateActionResult> {
    return await this.request<LoopCronUpdateActionResult>(
      `/api/nodes/${encodeURIComponent(nodeId)}/system-jobs/loop-cron/${encodeURIComponent(id)}/action`,
      { method: "POST", body: JSON.stringify({ actionText }) }
    );
  }

  // ==================== Heartbeat API ====================

  async getHeartbeatConfig(): Promise<HeartbeatConfigResponse> {
    return await this.request<HeartbeatConfigResponse>("/api/heartbeat/config");
  }

  async updateHeartbeatConfig(
    updates: Partial<HeartbeatConfig>
  ): Promise<HeartbeatConfigResponse> {
    return await this.request<HeartbeatConfigResponse>(
      "/api/heartbeat/config",
      {
        method: "PUT",
        body: JSON.stringify(updates),
      }
    );
  }

  async deleteHeartbeatConfig(): Promise<{ success: boolean }> {
    return await this.request<{ success: boolean }>("/api/heartbeat/config", {
      method: "DELETE",
    });
  }

  async getHeartbeatStatus(): Promise<HeartbeatStatus> {
    return await this.request<HeartbeatStatus>("/api/heartbeat/status");
  }

  async getHeartbeatHistory(): Promise<HeartbeatHistoryResponse> {
    return await this.request<HeartbeatHistoryResponse>(
      "/api/heartbeat/history"
    );
  }

  async getHeartbeatInstructions(): Promise<HeartbeatInstructionsResponse> {
    return await this.request<HeartbeatInstructionsResponse>(
      "/api/heartbeat/instructions"
    );
  }

  async triggerHeartbeat(): Promise<{ success: boolean; sessionId?: string }> {
    return await this.request<{ success: boolean; sessionId?: string }>(
      "/api/heartbeat/trigger",
      { method: "POST" }
    );
  }

  async updateHeartbeatInstructions(
    content: string
  ): Promise<{ success: boolean }> {
    return await this.request<{ success: boolean }>(
      "/api/heartbeat/instructions",
      {
        method: "PUT",
        body: JSON.stringify({ content }),
      }
    );
  }

  // ==================== Harness self-update (#1775, epic #1769) ====================

  /** Read the current poll cadence (R5). */
  async getHarnessPollConfig(): Promise<HarnessPollConfigResponse> {
    return await this.request<HarnessPollConfigResponse>(
      "/api/harness/poll-config"
    );
  }

  /** Persist a new poll cadence (R3). The server clamps to the 1h minimum and
   *  applies the change on the next poll cycle (no restart). */
  async setHarnessPollConfig(
    pollIntervalMs: number
  ): Promise<HarnessPollConfigResponse> {
    return await this.request<HarnessPollConfigResponse>(
      "/api/harness/poll-config",
      {
        method: "PUT",
        body: JSON.stringify({ pollIntervalMs }),
      }
    );
  }

  /** Trigger an immediate harness detection ("Check now", R4) — reuses #1770's
   *  endpoint (KD-4) and returns the refreshed status plus the `coalesced` flag
   *  (true when the check joined an in-flight detection rather than running a
   *  fresh one). */
  async triggerHarnessCheck(): Promise<HarnessCheckResponse> {
    return await this.request<HarnessCheckResponse>("/api/harness/check", {
      method: "POST",
    });
  }

  // ==================== Federation API ====================

  // TODO(#978): Migrate to /api/sessions/federation/nodes when route consolidation is complete
  async getFederationNodes(): Promise<FederationNodesResponse> {
    return await this.request<FederationNodesResponse>("/api/federation/nodes");
  }

  // TODO(#978): Migrate to /api/sessions/federation/nodes when route consolidation is complete
  async getFederationAllSessions(): Promise<FederationAllSessionsResponse> {
    return await this.request<FederationAllSessionsResponse>(
      "/api/federation/all-sessions"
    );
  }

  /**
   * File Conflict Monitor (#1971): live file-claims for one repo, JWT-gated.
   * Pass ONLY `repo` — the route silently ignores `sessionId` when `repo` is
   * truthy (fileClaims.ts), and per-repo fan-out is the intended query shape.
   */
  async getFileClaims(repo: string): Promise<FileClaimListResponse> {
    const params = new URLSearchParams({ repo });
    return await this.request<FileClaimListResponse>(
      `/api/file-claims?${params.toString()}`
    );
  }

  /**
   * File Conflict Monitor follow-up (#2815): historical overlapping-window
   * conflict pairs, JWT-gated. The server REJECTS out-of-range values with
   * 400 (`days` 1-90, `limit` 1-500 — validation, not clamping); omit params
   * for the defaults (7 days / 100 pairs). Local-node history only —
   * replicas carry live claims, not released history.
   */
  async getFileClaimHistory(opts?: {
    days?: number;
    limit?: number;
    repo?: string;
  }): Promise<FileClaimHistoryResponse> {
    const params = new URLSearchParams();
    if (opts?.days !== undefined) params.set("days", String(opts.days));
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.repo) params.set("repo", opts.repo);
    const qs = params.toString();
    return await this.request<FileClaimHistoryResponse>(
      `/api/file-claims/history${qs ? `?${qs}` : ""}`
    );
  }

  // ==================== Error Logs API ====================

  async getErrorLogs(
    filters?: ErrorLogFiltersParam
  ): Promise<ErrorLogListResponse> {
    const params = new URLSearchParams();
    if (filters?.severity) params.set("severity", filters.severity);
    if (filters?.category) params.set("category", filters.category);
    if (filters?.source) params.set("source", filters.source);
    if (filters?.sessionId) params.set("sessionId", filters.sessionId);
    if (filters?.startTime !== undefined)
      params.set("startTime", `${filters.startTime}`);
    if (filters?.endTime !== undefined)
      params.set("endTime", `${filters.endTime}`);
    if (filters?.limit !== undefined) params.set("limit", `${filters.limit}`);
    if (filters?.offset !== undefined)
      params.set("offset", `${filters.offset}`);
    const qs = params.toString();
    return await this.request<ErrorLogListResponse>(
      `/api/error-logs${qs ? `?${qs}` : ""}`
    );
  }

  async getErrorLogStats(): Promise<ErrorLogStatsResponse> {
    return await this.request<ErrorLogStatsResponse>("/api/error-logs/stats");
  }

  /**
   * Admin Feedback viewer list (issue #2666, epic #2663 Sub C). `GET
   * /api/feedback` mounts behind the JWT gate, so this MUST go through the authed
   * `request` (JWT-bearing) — a raw `fetch` would 401 permanently (the same
   * mount-position caveat as `getAbout`/`getErrorLogs`). Returns persisted
   * feedback rows newest-first plus the pagination `total`.
   */
  async getFeedbackList(opts?: {
    limit?: number;
    offset?: number;
  }): Promise<FeedbackListResponse> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", `${opts.limit}`);
    if (opts?.offset !== undefined) params.set("offset", `${opts.offset}`);
    const qs = params.toString();
    return await this.request<FeedbackListResponse>(
      `/api/feedback${qs ? `?${qs}` : ""}`
    );
  }

  /**
   * Server-authoritative session token totals (`v_session_totals`) + per-turn
   * breakdown (issue #1671, epic #1662 Sub I). `request<T>()` throws on non-2xx;
   * callers (the `useSessionTokenStats` hook) treat any failure as "endpoint
   * unavailable" and fall back to the client-side aggregate (R7).
   */
  async getSessionTokenStats(
    sessionId: string
  ): Promise<SessionTokenStatsResponse> {
    return await this.request<SessionTokenStatsResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/token-stats`
    );
  }

  /**
   * Server-authoritative session workflow-state — the `v_workflow_state` badge for
   * the linked issue + per-turn label events (issue #1672, epic #1662 Sub J).
   * `request<T>()` throws on non-2xx; the `useSessionWorkflowState` hook treats any
   * failure as "endpoint unavailable" and renders nothing (R7).
   */
  async getSessionWorkflowState(
    sessionId: string
  ): Promise<SessionWorkflowStateResponse> {
    return await this.request<SessionWorkflowStateResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/workflow-state`
    );
  }

  async deleteErrorLog(id: string): Promise<void> {
    await this.request(`/api/error-logs/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  // ── Search/Filter preferences ────────────────────────────────────────

  async getSearchFilterPreferences(): Promise<SearchFilterPreferences> {
    return await this.request<SearchFilterPreferences>(
      "/api/preferences/search-filter"
    );
  }

  async setSearchFilterPreferences(
    prefs: SearchFilterPreferences
  ): Promise<SearchFilterPreferences> {
    return await this.request<SearchFilterPreferences>(
      "/api/preferences/search-filter",
      { method: "PUT", body: JSON.stringify(prefs) }
    );
  }

  // ── Auto-recover preference (epic #1231 sub-issue E) ─────────────────

  async getAutoRecoverPreference(): Promise<AutoRecoverPreference> {
    return await this.request<AutoRecoverPreference>(
      "/api/preferences/auto-recover"
    );
  }

  async setAutoRecoverPreference(
    pref: AutoRecoverPreference
  ): Promise<AutoRecoverPreference> {
    return await this.request<AutoRecoverPreference>(
      "/api/preferences/auto-recover",
      { method: "PUT", body: JSON.stringify(pref) }
    );
  }

  // ── Auto-switch account on rate limit preference (#3618) ─────────────

  async getAutoSwitchOnRateLimitPreference(): Promise<AutoSwitchOnRateLimitPreference> {
    return await this.request<AutoSwitchOnRateLimitPreference>(
      "/api/preferences/auto-switch-on-rate-limit"
    );
  }

  async setAutoSwitchOnRateLimitPreference(
    pref: AutoSwitchOnRateLimitPreference
  ): Promise<AutoSwitchOnRateLimitPreference> {
    return await this.request<AutoSwitchOnRateLimitPreference>(
      "/api/preferences/auto-switch-on-rate-limit",
      { method: "PUT", body: JSON.stringify(pref) }
    );
  }

  // ── Auto-select optimal account preference (#3611) ─────────────

  async getAutoSelectOptimalAccountPreference(): Promise<AutoSelectOptimalAccountPreference> {
    return await this.request<AutoSelectOptimalAccountPreference>(
      "/api/preferences/auto-select-optimal-account"
    );
  }

  async setAutoSelectOptimalAccountPreference(
    pref: AutoSelectOptimalAccountPreference
  ): Promise<AutoSelectOptimalAccountPreference> {
    return await this.request<AutoSelectOptimalAccountPreference>(
      "/api/preferences/auto-select-optimal-account",
      { method: "PUT", body: JSON.stringify(pref) }
    );
  }

  // ── Chat sections matrix (#2988, epic #2987 Sub-Issue S1) ──────────────

  async getChatSectionPrefs(): Promise<ChatSectionsPreference> {
    return await this.request<ChatSectionsPreference>(
      "/api/preferences/chat-sections"
    );
  }

  async setChatSectionPrefs(
    prefs: ChatSectionsPreference
  ): Promise<ChatSectionsPreference> {
    return await this.request<ChatSectionsPreference>(
      "/api/preferences/chat-sections",
      { method: "PUT", body: JSON.stringify(prefs) }
    );
  }

  async getDefaultOutputStyle(): Promise<DefaultOutputStylePreference> {
    return await this.request<DefaultOutputStylePreference>(
      "/api/preferences/default-output-style"
    );
  }

  async setDefaultOutputStyle(
    pref: DefaultOutputStylePreference
  ): Promise<DefaultOutputStylePreference> {
    return await this.request<DefaultOutputStylePreference>(
      "/api/preferences/default-output-style",
      { method: "PUT", body: JSON.stringify(pref) }
    );
  }

  // ── Federation-global settings 🌐 (#2624, epic #2622 B) ────────────────

  /** Per-key effective value + 🌐 inherit state + provenance — the view the
   *  Preferences 🌐 toggles hydrate from. */
  async getFederationSettings(): Promise<FederationSettingsView> {
    return await this.request<FederationSettingsView>(
      "/api/preferences/federation-settings"
    );
  }

  /** Patch one registered setting: `{inherit}` flips 🌐 (the ONLY path that
   *  does), `{value}` writes global-or-override per the current flag. Responds
   *  with the fresh view (re-adopted values included). */
  async putFederationSetting(
    key: string,
    patch: FederationSettingPatch
  ): Promise<FederationSettingsView> {
    return await this.request<FederationSettingsView>(
      `/api/preferences/federation-settings/${encodeURIComponent(key)}`,
      { method: "PUT", body: JSON.stringify(patch) }
    );
  }

  /** Issue #2626 (D): the output-style catalog (built-in styles + hub-local
   *  customs) for the Create-page selector. The server route is a thin catalog
   *  read (built-ins always present; a missing customs dir yields just built-ins). */
  async getOutputStyles(): Promise<OutputStyleCatalog> {
    return await this.request<OutputStyleCatalog>("/api/output-styles");
  }

  /**
   * #2627 (E, Task 2): upload a custom output-style `.md`. Raw `fetch` (NOT
   * `request`) because a FormData body must let the browser set the
   * `multipart/form-data` boundary — `request` would force
   * `content-type: application/json` and strip it (same reasoning as
   * {@link uploadFile}). Returns a discriminated result so the manager can
   * surface the server's `{ error, details }` inline.
   */
  async uploadOutputStyle(
    file: File
  ): Promise<
    | { success: true; name: string; description: string }
    | { success: false; error: string; details?: string }
  > {
    const formData = new FormData();
    formData.append("file", file);
    const liveToken = this.getToken ? this.getToken() : null;
    const authToken = liveToken ?? this.token;
    const res = await fetch(this.buildUrl("/api/output-styles/upload"), {
      method: "POST",
      headers: { authorization: `Bearer ${authToken}` },
      body: formData,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      try {
        const parsed = JSON.parse(body) as { error?: string; details?: string };
        return {
          success: false,
          error: parsed.error ?? `Upload failed: HTTP ${res.status}`,
          details: parsed.details,
        };
      } catch {
        return { success: false, error: `Upload failed: HTTP ${res.status}` };
      }
    }
    const parsed = (await res.json()) as {
      name: string;
      description?: string;
    };
    return {
      success: true,
      name: parsed.name,
      description: parsed.description ?? "",
    };
  }

  /**
   * #2627 (E, Task 5): delete a custom output-style. The server unlinks it,
   * propagates a tombstone to peers, and degrades the default preference +
   * scrubs persisted sessions if it was selected.
   */
  async deleteOutputStyle(
    name: string
  ): Promise<{ defaultReset: boolean; sessionsScrubbed: number }> {
    return await this.request<{
      ok: boolean;
      name: string;
      defaultReset: boolean;
      sessionsScrubbed: number;
    }>(`/api/output-styles/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  // ── Context-watermark admin (#2587) ───────────────────────────────────

  /** GET the server-authoritative watermark status (enable + config + states). */
  async getWatermarkState(): Promise<WatermarkStatus> {
    return await this.request<WatermarkStatus>("/api/watermark");
  }

  /** Enable/disable the feature; server persists to settings.json + reloads the
   *  running service. Returns the effective config (env-kill-switch-aware). */
  async setWatermarkEnabled(body: {
    enabled: boolean;
  }): Promise<WatermarkConfigUpdateResult> {
    return await this.request<WatermarkConfigUpdateResult>(
      "/api/watermark/config",
      { method: "PUT", body: JSON.stringify(body) }
    );
  }

  /** Set the watermark percent (0 < pct ≤ 100); server persists + reloads the
   *  running service so the next poll arms at the new threshold. */
  async setWatermarkPercent(body: {
    watermarkPercent: number;
  }): Promise<WatermarkConfigUpdateResult> {
    return await this.request<WatermarkConfigUpdateResult>(
      "/api/watermark/config",
      { method: "PUT", body: JSON.stringify(body) }
    );
  }

  /** Manual override: disarm one session (persisted suppression + hysteresis). */
  async disarmWatermark(sessionId: string): Promise<{ state: WatermarkState }> {
    return await this.request<{ state: WatermarkState }>(
      `/api/watermark/${encodeURIComponent(sessionId)}/disarm`,
      { method: "POST" }
    );
  }

  // ── Create-Session page UI preferences (server-persisted) ─────────────

  async getCreateSessionPreferences(): Promise<CreateSessionPreferences> {
    return await this.request<CreateSessionPreferences>(
      "/api/preferences/create-session"
    );
  }

  async setCreateSessionPreferences(
    prefs: CreateSessionPreferences
  ): Promise<CreateSessionPreferences> {
    return await this.request<CreateSessionPreferences>(
      "/api/preferences/create-session",
      { method: "PUT", body: JSON.stringify(prefs) }
    );
  }

  /** Bookmarked per-field Create-Session defaults (sibling settings key). */
  async getCreateSessionDefaults(): Promise<CreateSessionDefaults> {
    return await this.request<CreateSessionDefaults>(
      "/api/preferences/create-defaults"
    );
  }

  async setCreateSessionDefaults(
    prefs: CreateSessionDefaults
  ): Promise<CreateSessionDefaults> {
    return await this.request<CreateSessionDefaults>(
      "/api/preferences/create-defaults",
      { method: "PUT", body: JSON.stringify(prefs) }
    );
  }

  // ── OpenRouter catalog + favorites (#1975) ────────────────────

  /** The trimmed, server-cached OpenRouter model catalog (hundreds of models). */
  async listOpenRouterModels(): Promise<OpenRouterModel[]> {
    return await this.request<OpenRouterModel[]>("/api/openrouter/models");
  }

  /** Issue #2456: the LIVE Claude model catalog (from Anthropic's /v1/models,
   *  server-cached with graceful fallback). Backs the "More models" pickers. */
  async listClaudeModels(): Promise<ClaudeModelsResponse> {
    return await this.request<ClaudeModelsResponse>("/api/claude/models");
  }

  /** The node's favorited OpenRouter model ids (pinned to the top of the picker). */
  async getOpenRouterFavorites(): Promise<OpenRouterFavorites> {
    return await this.request<OpenRouterFavorites>(
      "/api/preferences/openrouter-favorites"
    );
  }

  async setOpenRouterFavorites(
    favorites: OpenRouterFavorites
  ): Promise<OpenRouterFavorites> {
    return await this.request<OpenRouterFavorites>(
      "/api/preferences/openrouter-favorites",
      { method: "PUT", body: JSON.stringify(favorites) }
    );
  }

  // ── API Keys (issue #1955, epic #1954 — secrets vault) ────────────────
  // Data layer for the admin API Keys page. Responses are RedactedApiKey
  // (masked) only — the raw secret is sent to the server exactly once (addApiKey)
  // and never returned thereafter.

  async listApiKeys(): Promise<RedactedApiKey[]> {
    return await this.request<RedactedApiKey[]>("/api/api-keys");
  }

  async addApiKey(input: AddApiKeyRequest): Promise<RedactedApiKey> {
    return await this.request<RedactedApiKey>("/api/api-keys", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async removeApiKey(id: string): Promise<RedactedApiKey[]> {
    return await this.request<RedactedApiKey[]>(
      `/api/api-keys/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
  }

  // POST /api/api-keys/:id/validate — probe the stored key and update its status
  // (B3 #1956). Returns the redacted view with the refreshed status — never the key.
  async validateApiKey(id: string): Promise<RedactedApiKey> {
    return await this.request<RedactedApiKey>(
      `/api/api-keys/${encodeURIComponent(id)}/validate`,
      { method: "POST" }
    );
  }

  // ── MCP server status ────────────────────────────────────────────────

  async getMcpStatus(projectDir?: string): Promise<McpStatusResponse> {
    const params = projectDir
      ? `?projectDir=${encodeURIComponent(projectDir)}`
      : "";
    return await this.request<McpStatusResponse>(`/api/mcp-status${params}`);
  }

  async refreshMcpStatus(projectDir?: string): Promise<McpStatusResponse> {
    const params = projectDir
      ? `?projectDir=${encodeURIComponent(projectDir)}`
      : "";
    return await this.request<McpStatusResponse>(
      `/api/mcp-status/refresh${params}`,
      { method: "POST", signal: AbortSignal.timeout(90_000) }
    );
  }

  /**
   * Toggle an MCP server on a remote-mode session (issue #989, backend from #1077).
   * Returns the structured McpToggleResponse for both success (`ok: true`) and
   * server-side failure (`ok: false` with a `code` such as `"local_mode_not_supported"`,
   * `"server_not_found"`, `"transport_failed"`, etc.).
   *
   * `request<T>()` throws on non-2xx, so we catch and recover the structured body
   * from the error message — non-2xx responses for this endpoint always carry the
   * McpToggleResponse failure shape.
   */
  async toggleMcpServer(
    sessionId: string,
    serverName: string,
    enabled: boolean
  ): Promise<McpToggleResponse> {
    try {
      return await this.request<McpToggleResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/mcp-toggle`,
        {
          method: "POST",
          body: JSON.stringify({ serverName, enabled }),
        }
      );
    } catch (err) {
      if (err instanceof Error) {
        const match = err.message.match(/^HTTP \d+ [^:]+: (.*)$/s);
        if (match) {
          try {
            const parsed: unknown = JSON.parse(match[1]);
            if (
              parsed &&
              typeof parsed === "object" &&
              "ok" in parsed &&
              typeof (parsed as { ok: unknown }).ok === "boolean"
            ) {
              return parsed as McpToggleResponse;
            }
          } catch {
            // Fall through to re-throw if body wasn't structured
          }
        }
      }
      throw err;
    }
  }

  /**
   * Configuration Porter data surfaces (issue #2344, epic #2339 Sub E) for the
   * Admin → Configuration page. All routes mount under `/api` AFTER the global
   * JWT gate — the mount position IS the auth mechanism — so every call below
   * carries the Bearer header (via `request`, or the explicit header on the
   * multipart raw-fetch path).
   */
  async getPorterRecipient(): Promise<PorterRecipientResponse> {
    return await this.request<PorterRecipientResponse>("/api/porter/recipient");
  }

  /**
   * Configuration Porter exposure probe (issue #4533). `GET /api/porter/status`
   * answers 200 `{ exposed: true }` only when Porter is exposed; a withheld
   * instance (the default) answers 404 `porter_withheld`, a DESIGNED steady
   * state — so 404 is an expected status and is never reported (#2362).
   */
  async getPorterStatus(): Promise<PorterStatusResponse> {
    return await this.request<PorterStatusResponse>(
      "/api/porter/status",
      undefined,
      0,
      undefined,
      undefined,
      { expectedStatuses: [404] }
    );
  }

  async getPorterInstalled(): Promise<InstalledConfigResponse> {
    return await this.request<InstalledConfigResponse>("/api/porter/installed");
  }

  /**
   * Read one installed config file's text + its absolute host path (issue #3116).
   * `expectedStatuses: [403, 404]` — a not-found MCP row (a CLI-reported server
   * absent from `~/.claude.json`) 404s, and a denylisted / OAuth-store target
   * (including a symlink pointing to one) returns a bare `403 forbidden`; a safe
   * operator symlink is followed and returns its content (200, #3145). Both 403 and
   * 404 are DESIGNED responses the pane renders as friendly states, not faults to
   * spam the error reporter with (#2362).
   */
  async getPorterContent(
    dimension: string,
    name: string
  ): Promise<PorterContentResponse> {
    const params = new URLSearchParams({ dimension, name });
    return await this.request<PorterContentResponse>(
      `/api/porter/content?${params.toString()}`,
      undefined,
      0,
      undefined,
      undefined,
      { expectedStatuses: [403, 404] }
    );
  }

  /**
   * POST the archive to the plan endpoint (multipart). Raw `fetch` — NOT
   * `request` — because `request` force-sets `content-type: application/json`
   * when a body is present, which strips the `multipart/form-data` boundary the
   * browser must set for a FormData body (identical reasoning to `uploadFile`).
   * On a non-2xx the server returns `{ error, kind }`; surface `error` as the
   * thrown message so the import panel can render it.
   */
  async planPorterImport(
    file: File,
    opts?: PorterImportPlanOptions
  ): Promise<ImportPlanSummary> {
    const formData = new FormData();
    formData.append("file", file);
    // #3299: append the per-request isolated destination only when set — no field
    // ⇒ byte-identical request to the pre-#3299 default (live ~/.claude).
    if (opts?.isolatedDest) formData.append("isolatedDest", opts.isolatedDest);
    const liveToken = this.getToken ? this.getToken() : null;
    const authToken = liveToken ?? this.token;
    const res = await fetch(this.buildUrl("/api/porter/import/plan"), {
      method: "POST",
      headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
      body: formData,
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let message = `Import plan failed: HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(body) as { error?: string };
        if (parsed?.error) message = parsed.error;
      } catch {
        // non-JSON body — keep the generic message
      }
      throw new Error(message);
    }
    return (await res.json()) as ImportPlanSummary;
  }

  /**
   * Commit a previously-planned import (JSON body → `request` is fine here).
   * `overwrite` carries the dest paths / MCP server names the user chose to
   * REPLACE; everything else defaults to skip (non-destructive, directive R4).
   * #3247: `excluded` carries the keys the operator DESELECTED in the pre-import
   * selection screen (file/hook destPaths, MCP names); default [] = write all.
   */
  async commitPorterImport(
    stagingHandle: string,
    overwrite: string[],
    excluded: string[] = [],
    secretOverlay?: SecretOverlay,
    acknowledgeMissingHooks?: string[],
    keepModes?: string[],
    acknowledgeSymlinkedSettings?: string
  ): Promise<ImportResult> {
    // #3546: an undefined `secretOverlay` is dropped by JSON.stringify, so the
    // no-overlay commit body is byte-identical to the pre-#3546 request.
    // #3590 (K4/D9): `acknowledgeMissingHooks` names the registry-missing hooks
    // the operator accepted — undefined is likewise dropped (byte-identical).
    // #4129: `keepModes` names the File-modes rows whose current mode is kept.
    // #4277: `acknowledgeSymlinkedSettings` is the link target a previous 409
    // echoed, sent back unchanged — undefined is dropped (byte-identical).
    // Every 409 on this route goes unreported (#2362): today those are registry
    // drift (#3590) and a symlinked settings.json (#4146), designed,
    // re-submittable refusals that the server already logs. A new 409 on this
    // route must also be one. The ApiError and its `.body` still reach the
    // caller.
    return await this.request<ImportResult>(
      "/api/porter/import/commit",
      {
        method: "POST",
        body: JSON.stringify({
          stagingHandle,
          overwrite,
          excluded,
          secretOverlay,
          acknowledgeMissingHooks,
          keepModes,
          acknowledgeSymlinkedSettings,
        }),
      },
      0,
      undefined,
      undefined,
      { expectedStatuses: [409] }
    );
  }

  /**
   * #3446 (Sub A): mint a porter one-liner token → `POST /api/porter/token`.
   * JWT-gated (mount position); the response carries the copyable `fetchUrl` /
   * `uploadUrl`. No body — `request` handles a bodyless POST.
   */
  async mintPorterToken(): Promise<PorterTokenResponse> {
    return await this.request<PorterTokenResponse>("/api/porter/token", {
      method: "POST",
    });
  }

  /**
   * #3446 (Sub A): poll a token's status → `GET /api/porter/token/:token/status`.
   * The plan summary flows to the browser HERE (not over the curl channel), so a
   * `received` status carries `plan`. The SSE `porter-token-received` event is
   * the wake-up; this poll is the fallback. base64url tokens are URL-safe, but
   * encode defensively.
   */
  async getPorterTokenStatus(token: string): Promise<PorterTokenStatus> {
    return await this.request<PorterTokenStatus>(
      `/api/porter/token/${encodeURIComponent(token)}/status`
    );
  }

  /**
   * Per-VM backup age identity surfaces (issue #2507, epic #2493) for the
   * Admin → Backup Key page. All three routes mount under `/api` AFTER the
   * global JWT gate — the mount position IS the auth mechanism.
   */
  async getBackupIdentityStatus(): Promise<BackupIdentityStatus> {
    return await this.request<BackupIdentityStatus>(
      "/api/backup/identity/status"
    );
  }

  /**
   * Reveal the secret identity ONCE (while pending). A 404 (`none`) and a 410
   * (`gone` — already acknowledged) are DESIGNED responses here, not faults, so
   * they are declared as expected statuses to suppress error-reporting noise;
   * the thrown {@link ApiError} still carries `.status` for the caller to branch on.
   */
  async revealBackupIdentity(): Promise<BackupIdentityRevealResponse> {
    return await this.request<BackupIdentityRevealResponse>(
      "/api/backup/identity/reveal",
      { method: "POST" },
      0,
      undefined,
      undefined,
      { expectedStatuses: [404, 410] }
    );
  }

  /** Acknowledge the reveal → the VM shreds the identity + records the marker. */
  async acknowledgeBackupIdentity(): Promise<{ ok: boolean }> {
    return await this.request<{ ok: boolean }>(
      "/api/backup/identity/acknowledge",
      { method: "POST" }
    );
  }

  /**
   * Submit a partial desired-state for the session's MCP servers
   * (issue #989 follow-up). The server-side worker reconciles desired vs
   * current and toggles only the names that differ. The web client just
   * fires once and listens for `mcp-batch-progress` SSE events to render
   * progress — no client-side iteration loop, so iOS PWA tab suspension
   * no longer pauses the batch.
   */
  async setMcpDesired(
    sessionId: string,
    desired: Record<string, boolean>
  ): Promise<McpSetDesiredResponse> {
    try {
      return await this.request<McpSetDesiredResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/mcp-set-desired`,
        {
          method: "POST",
          body: JSON.stringify({ desired }),
        }
      );
    } catch (err) {
      if (err instanceof Error) {
        const match = err.message.match(/^HTTP \d+ [^:]+: (.*)$/s);
        if (match) {
          try {
            const parsed: unknown = JSON.parse(match[1]);
            if (
              parsed &&
              typeof parsed === "object" &&
              "ok" in parsed &&
              typeof (parsed as { ok: unknown }).ok === "boolean"
            ) {
              return parsed as McpSetDesiredResponse;
            }
          } catch {
            // Fall through
          }
        }
      }
      throw err;
    }
  }

  /**
   * Read the current MCP batch snapshot for a session. Useful when the
   * client connects mid-batch (e.g. after refresh or app cold-start).
   */
  async getMcpBatchState(sessionId: string): Promise<McpBatchStateResponse> {
    return await this.request<McpBatchStateResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/mcp-batch-state`
    );
  }

  // ── Telemetry ────────────────────────────────────────────────────────

  async getTelemetrySummary(filters?: {
    fileType?: string;
    startTime?: number;
    endTime?: number;
  }): Promise<TelemetrySummary> {
    const params = new URLSearchParams();
    if (filters?.fileType) params.set("fileType", filters.fileType);
    if (filters?.startTime) params.set("startTime", String(filters.startTime));
    if (filters?.endTime) params.set("endTime", String(filters.endTime));
    const qs = params.toString();
    return await this.request<TelemetrySummary>(
      `/api/telemetry/summary${qs ? `?${qs}` : ""}`
    );
  }

  async getTelemetryTimeseries(params: {
    filePath?: string;
    interval: string;
    startTime?: number;
    endTime?: number;
  }): Promise<TelemetryTimeseries> {
    const qs = new URLSearchParams();
    qs.set("interval", params.interval);
    if (params.filePath) qs.set("filePath", params.filePath);
    if (params.startTime) qs.set("startTime", String(params.startTime));
    if (params.endTime) qs.set("endTime", String(params.endTime));
    return await this.request<TelemetryTimeseries>(
      `/api/telemetry/timeseries?${qs.toString()}`
    );
  }

  async getTelemetryFiles(filters?: {
    fileType?: string;
  }): Promise<TelemetryFilesResponse> {
    const qs = filters?.fileType ? `?fileType=${filters.fileType}` : "";
    return await this.request<TelemetryFilesResponse>(
      `/api/telemetry/files${qs}`
    );
  }

  async getTelemetryDurationStats(filters?: {
    fileType?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<{ stats: TelemetryDurationStats[] }> {
    const params = new URLSearchParams();
    if (filters?.fileType) params.set("fileType", filters.fileType);
    if (filters?.startDate) params.set("startDate", filters.startDate);
    if (filters?.endDate) params.set("endDate", filters.endDate);
    const qs = params.toString();
    return await this.request(
      `/api/telemetry/duration-stats${qs ? `?${qs}` : ""}`
    );
  }

  async getTelemetryOutcomeRates(filters?: {
    fileType?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<{ rates: TelemetryOutcomeRate[] }> {
    const params = new URLSearchParams();
    if (filters?.fileType) params.set("fileType", filters.fileType);
    if (filters?.startDate) params.set("startDate", filters.startDate);
    if (filters?.endDate) params.set("endDate", filters.endDate);
    const qs = params.toString();
    return await this.request(
      `/api/telemetry/outcome-rates${qs ? `?${qs}` : ""}`
    );
  }

  async getTelemetryAnomalies(options?: {
    window?: number;
    threshold?: number;
  }): Promise<{ anomalies: TelemetryAnomaly[] }> {
    const params = new URLSearchParams();
    if (options?.window) params.set("window", String(options.window));
    if (options?.threshold) params.set("threshold", String(options.threshold));
    const qs = params.toString();
    return await this.request(`/api/telemetry/anomalies${qs ? `?${qs}` : ""}`);
  }

  async getTelemetryComparison(periods: {
    period1Start: number;
    period1End: number;
    period2Start: number;
    period2End: number;
  }): Promise<{ comparison: TelemetryPeriodComparison[] }> {
    const params = new URLSearchParams();
    params.set("period1Start", String(periods.period1Start));
    params.set("period1End", String(periods.period1End));
    params.set("period2Start", String(periods.period2Start));
    params.set("period2End", String(periods.period2End));
    return await this.request(`/api/telemetry/comparison?${params.toString()}`);
  }

  async getTelemetryTokenEstimates(filters?: {
    fileType?: string;
    startTime?: number;
  }): Promise<{ estimates: TelemetryTokenEstimate[] }> {
    const params = new URLSearchParams();
    if (filters?.fileType) params.set("fileType", filters.fileType);
    if (filters?.startTime) params.set("startTime", String(filters.startTime));
    const qs = params.toString();
    return await this.request(
      `/api/telemetry/token-estimates${qs ? `?${qs}` : ""}`
    );
  }

  async getTelemetrySessionAggregates(filters?: {
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): Promise<{ sessions: TelemetrySessionAggregate[] }> {
    const params = new URLSearchParams();
    if (filters?.startTime) params.set("startTime", String(filters.startTime));
    if (filters?.endTime) params.set("endTime", String(filters.endTime));
    if (filters?.limit) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return await this.request(
      `/api/telemetry/session-aggregates${qs ? `?${qs}` : ""}`
    );
  }
}
