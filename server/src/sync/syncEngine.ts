// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- Grandfathered god-file (Epic 0, #2077); decomposition verdict tracked in claudedocs/architecture-hotspot-review.md. */
/**
 * Sync Engine for HAPI Telegram Bot (Direct Connect)
 *
 * In the direct-connect architecture:
 * - hapi-server is the server (Socket.IO + REST)
 * - hapi CLI connects directly to the server (no relay)
 * - No E2E encryption; data is stored as JSON in SQLite
 *
 * NOTE (#2080): decomposed into focused delegates under server/src/sync/
 * (timelogReset, mcpConfigStore, sessionRespawn, accountRestart,
 * sessionDeletion, sessionLifecycleOps). This class remains the facade +
 * barrel: all public methods and type re-exports are preserved.
 */

import type {
  DecryptedMessage,
  BackgroundAgentsSnapshot,
  McpBatchSnapshot,
  McpStatusUpdate,
  McpToggleResponse,
  SetModelResponse,
  SetPermissionModeResponse,
  ModelMode,
  PermissionMode,
  Session,
  SessionRole,
  SyncEvent,
} from "@hapi/protocol/types";
import type {
  SessionMetadataFilterOptions,
  SessionMetadataQuery,
  SessionMetadataTurn,
  PmSpawnReconciliationStatus,
  PmSpawnRosterRecord,
  PmSpawnRosterUpsert,
  SessionTokenStatsResponse,
  SessionTokenTotals,
  SessionWorkflowBadge,
  SessionWorkflowStateResponse,
  StoredAccount,
  SessionView,
  UiCollapseState,
} from "@hapi/protocol";
import {
  JOB_KIND_IN_PROCESS_LOOP,
  isEnvTokenAccount,
  generateSessionId,
  type JobRegistry,
} from "@hapi/protocol";
import type {
  AuthBinding,
  BackgroundAgentEntry,
  ClaudeAccountInfo,
  CeilingGuardConfig,
  CeilingGuardConfigPatch,
} from "@hapi/protocol/schemas";
import type { PushService } from "../push/pushService";
import { getCeilingGuardDefaults } from "../config/ceilingGuardConfig";
import type { TurnLifecycle } from "./turnLifecycle";
import type { ClaudeRemoteLauncherKind } from "@hapi/protocol/launcherResolver";
import type { EffortLevel } from "@hapi/protocol/effort";
import { McpBatchCoordinator } from "./mcpBatchCoordinator";
import type { Server } from "socket.io";
import type {
  QueuedMessageEnqueueResult,
  Store,
  StoredQueuedMessage,
} from "../store";
import type { RpcRegistry } from "../socket/rpcRegistry";
import type { CapabilityMeta } from "../socket/handlers/cli/rpcHandlers";
import type { SSEManager } from "../sse/sseManager";
import { EventPublisher, type SyncEventListener } from "./eventPublisher";
import { MachineCache, type Machine } from "./machineCache";
import { MessageService, type SendMessageResult } from "./messageService";
import { isNewUserFacingAssistantContent } from "./needsReviewContent";
import type { MessageOrigin, SentFrom } from "./sentFrom";
import {
  APPROVAL_TOKEN_HOOK_ID,
  registerApprovalTokenGate,
} from "./approvalTokenHook";
import {
  checkOrphanGrant as runOrphanGrantCheck,
  OrphanGrantStore,
} from "./orphanGrantStep";
import { loadApprovalTokensConfig } from "../config/approvalTokensConfig";
import { loadApprovalHygieneConfig } from "../config/approvalHygieneConfig";
import { TimelogResetService } from "./timelogReset";
import { McpConfigStore } from "./mcpConfigStore";
import { SessionRespawn } from "./sessionRespawn";
import {
  AccountRestart,
  type PaymentMethodTarget,
  type PaymentMethodSwitchResult,
  type PaymentMethodStageResult,
} from "./accountRestart";
import { configuration } from "../configuration";
import { readRedactedApiKeyById } from "../web/routes/apiKeys";
import { SessionDeletion } from "./sessionDeletion";
import { SessionLifecycleOps } from "./sessionLifecycleOps";
import {
  SessionRelaunch,
  type RelaunchOverrides,
  type RelaunchResult,
} from "./sessionRelaunch";
import type { LoopCronLifecycleCoupler } from "./loopCronLifecycle";
import { RespawnMarks } from "./respawnMarks";
import {
  RpcGateway,
  type DirectoryEntry,
  type ListDirectoryResponse,
  type RpcCommandResponse,
  type RpcMutationResponse,
  type RpcPathExistsResponse,
  type RpcReadFileResponse,
  type RpcWriteFileResponse,
  type RecoverWorktreeRpcResult,
} from "./rpcGateway";
import { notifySessionEnded as notifyTranscriptSessionEnded } from "../services/transcriptIndexer";
import { resolveTranscriptPaths } from "./transcript/transcriptPath";
import {
  classifyAgentLaunch,
  readAgentMeta,
} from "./transcript/transcriptParser";
import {
  NO_TURN_BINDING,
  readAgentFileUsage,
  readTurnBinding,
  seedExcludedBackgroundAgents,
  type ExcludedBackgroundAgent,
} from "./backgroundAgentSeed";
import type { TurnBillingBinding } from "../store/turns/types";
import { isValidAgentId } from "./agentId";
import { SessionCache } from "./sessionCache";
import {
  filterClaimsToLiveSessions,
  liveSessionIdSet,
  reapOrphanedClaims,
} from "../store/fileClaimLifecycle";
import type { FileClaimSyncSnapshot } from "@hapi/protocol";
import type {
  TurnFeedDigest,
  TurnFeedPage,
  TurnMirrorOriginStatus,
} from "@hapi/protocol";
import type { ErrorLogger } from "../logging/errorLogger";
import type { Notifier } from "../notifications/notifier";
import {
  buildEscalationPayload,
  SESSION_FATAL_ESCALATION_CATEGORY,
  type SessionFatalReason,
} from "../notifications/sessionFatalEscalation";

export type { Session, SyncEvent } from "@hapi/protocol/types";

/** #2700: derived from the shared `schedule-changed` union member — never hand-copied. */
export type ScheduleChangeKind = Extract<
  SyncEvent,
  { type: "schedule-changed" }
>["changeKind"];
export type { Machine } from "./machineCache";
export type { SyncEventListener } from "./eventPublisher";
export type {
  ListDirectoryResponse,
  RpcCommandResponse,
  RpcMutationResponse,
  RpcPathExistsResponse,
  RpcReadFileResponse,
  RpcWriteFileResponse,
} from "./rpcGateway";

/** Options for spawning a new session via the daemon. */
export interface SpawnSessionOptions {
  machineId: string;
  directory: string;
  agent?: "claude" | "codex" | "gemini" | "opencode";
  yolo?: boolean;
  /** Issue #1262: opt-in to spawn-time port claim from the 3010-3019 pool.
   *  Default-false. When omitted/false the worktree is created with
   *  `claimed_port: null` and the port is claimed later (typically at
   *  deploy-time via `scripts/hapi-worktree.sh claim`). */
  claimPort?: boolean;
  /** Issue #1555: when false, the daemon returns spawn success once the child
   *  process has STARTED (waitForAnyChild) rather than waiting for the full
   *  "I'm alive" webhook. switchAccount() passes false so a cold MCP load no
   *  longer exceeds the synchronous wait and triggers a spurious rollback — the
   *  MCP load finishes asynchronously. Default true = legacy full-boot gate. */
  awaitWebhook?: boolean;
  sessionType?: "simple" | "worktree";
  worktreeName?: string;
  /** hapimatic-private#4481: open the worktree on this existing branch. */
  existingBranch?: { name: string; remote: boolean };
  resumeSessionId?: string;
  hapiSessionId?: string;
  name?: string;
  forkSession?: boolean;
  parentSessionId?: string;
  /** #2479: relationship to the parent — "branch" (forked) or "spawn" (managed peer) */
  parentRelationship?: "branch" | "spawn";
  originatingNodeId?: string;
  /** Multi-account (epic #1446, Sub-Issue J): bind the spawned process to this
   *  account by setting HAPI_ACCOUNT_UUID in its env (mirrors originatingNodeId).
   *  Absent → host-credential fallback. D's launcher injection reads the env
   *  var (cli/src/claude/accountTokenInjection.ts) to resolve the token. */
  accountUuid?: string;
  /** Issue #4568: bill this Claude session to the node-vault Anthropic API key
   *  with this id (NEVER key material). Mutually exclusive with `accountUuid`
   *  (`spawnSession` refuses both). The daemon resolves the key by id, binds no
   *  account / instance token, forces the SDK launcher, and delivers
   *  HAPI_API_KEY_ID to the wrapper. Every respawn re-threads it from
   *  `session.metadata.apiKeyId` (`buildRespawnBase`). */
  apiKeyId?: string;
  /** Issue #4568: the key's masked form recorded at the FIRST spawn
   *  (`session.metadata.apiKeyMasked`), carried on a respawn so the daemon refuses
   *  a vault entry whose key changed under the same id. Absent on a fresh spawn —
   *  the daemon then records the vault entry's current mask. */
  apiKeyMasked?: string;
  scheduleId?: string;
  /** Absolute path to vanilla Claude CLI on this node (issue #933) */
  claudePath?: string;
  /** Issue #1633: launch the claude child with --safe-mode (CLAUDE.md, skills,
   *  hooks, MCP customizations disabled). Threaded daemon-ward as the
   *  `hapi claude --safe-mode` flag; Hapimatic's own injections (hapi MCP,
   *  hook settings, allowedTools, append-system-prompt) are suppressed by the
   *  launchers when the flag is present. */
  safeMode?: boolean;
  /** Issue #1660: per-session launcher override (sdk | tmux | pty). Threaded
   *  daemon-ward as a HAPI_CLAUDE_LAUNCHER env injection (the HAPI_ACCOUNT_UUID
   *  channel) so the existing env > settings > default resolver applies it
   *  per-session — no resolver change. On respawn, re-sourced from
   *  session.metadata.launcherKind (the resolved kind frozen at spawn by
   *  runClaude, #1613), mirroring how safeMode is re-read. */
  launcher?: ClaudeRemoteLauncherKind;
  /** Issue #1633: explicit model mode for the spawned session. Threaded
   *  daemon-ward as `--hapi-model-mode <mode>` so a model-switch respawn
   *  preserves the user's explicit selection (the launcher then appends the
   *  raw `--model` value via resolveSpawnClaudeArgs). */
  modelMode?: ModelMode;
  /** Issue #2456: reasoning-effort level. Forwarded daemon-ward as
   *  `--hapi-effort <level>` (#1262 enumeration — guarded by
   *  syncEngine.spawnEffort.test.ts). */
  effort?: EffortLevel;
  /** Issue #2456: a specific pinned raw Claude model id ("More models").
   *  Forwarded daemon-ward as `--hapi-raw-model <id>`; takes precedence over
   *  modelMode. (#1262 enumeration — guarded by syncEngine.spawnEffort.test.ts). */
  rawModel?: string;
  /** Issue #1733: free-form gateway model id ("provider/model") for an
   *  OpenRouter-routed Codex session, forwarded daemon-ward as --hapi-model.
   *  Distinct from modelMode (the Claude axis). (#1262 field enumeration.) */
  model?: string;
  /** Issue #3349 (D4(a)): native-vs-OpenRouter routing discriminator for an
   *  opencode spawn. `"native"` → the `model` above is a native `provider/model`
   *  (daemon resolves the provider's #1955 vault key); `"openrouter"`/absent →
   *  the OpenRouter gateway path. Forwarded daemon-ward field-by-field (#1262 —
   *  an un-forwarded field silently strips at the wire and a native opencode
   *  spawn misroutes to OpenRouter). Inline union mirrors modelMode's loose CLI
   *  typing (validated upstream by machines.ts / federation.ts ModelRoutingSchema). */
  modelRouting?: "native" | "openrouter";
  /** Issue #1953 (A6): clone-on-spawn repo ("owner/repo"). Forwarded daemon-ward;
   *  the daemon clones it into the working dir before launch (#1262 enumeration —
   *  guarded by syncEngine.spawnClone.test.ts). */
  cloneRepo?: string;
  /** Issue #2155: role-scoped `@`-include profile. Forwarded daemon-ward as
   *  --hapi-session-role so runClaude merges the role's claudeMdExcludes into
   *  the hook-settings file. On respawn, re-sourced from
   *  session.metadata.sessionRole (mirrors how safeMode/launcherKind are
   *  re-read) so the role survives model/account-switch restarts (OR-4).
   *  (#1262 enumeration — guarded by syncEngine.spawnRole.test.ts.) */
  sessionRole?: SessionRole;
  /** Issue #2626: per-session output style name (built-in: default |
   *  Explanatory | Learning, or a custom style). Forwarded daemon-ward as
   *  --hapi-output-style so runClaude injects it into the generated --settings
   *  file (the single choke point every launcher delivers). On respawn,
   *  re-sourced from session.metadata.outputStyle (mirrors sessionRole) so the
   *  style survives model/account-switch restarts. (#1262 enumeration —
   *  guarded by syncEngine.spawnOutputStyle.test.ts.) */
  outputStyle?: string;
  /** Issue #3348: bundled non-claude native model selection. `modelId` is the
   *  gemini model id (→ GEMINI_MODEL env) OR the codex ChatGPT-token model id
   *  (→ config.toml bake); `reasoningEffort` is codex's config.toml
   *  `model_reasoning_effort`. Interpreted by AGENT at the daemon. Forwarded
   *  daemon-ward field-by-field (#1262). Also stamped onto `metadata.nativeModel`
   *  post-success for in-session display (no CLI writer competes — no race). */
  nativeModelSelection?: {
    modelId?: string;
    reasoningEffort?: string;
  };
  /** Issue #1661: reconnect kill-vs-reattach intent for the REUSED tmux-window
   *  spawn path. Default true preserves switch/token-refresh/model-restart
   *  semantics (intentional process replacement). reconnectSession passes false
   *  ONLY when the daemon-authoritative isSessionAlive RPC was uncertain (null),
   *  so the daemon re-checks liveness before killing and re-attaches a live
   *  wrapper instead of SIGTERM-killing an in-flight turn. Threaded field-by-field
   *  through the spawn RPC (the #1262 trap). */
  killLivePane?: boolean;
  /** Issue #3611: the resolved `autoSelectOptimalAccount` opt-in. Callers leave
   *  this unset — `spawnSession` stamps it from the server preference mirror (via
   *  the `setAutoSelectOptimalAccountReader`-injected reader) so EVERY spawn caller
   *  (create route, scheduler taskExecutor, controlServer) inherits the pick with
   *  no per-caller edit. Forwarded to the daemon on the spawn RPC (the #1262 trap);
   *  undefined/false ⇒ the daemon runs NO optimal-pick (#3023 unchanged, R3). */
  autoSelectOptimalAccount?: boolean;
}

/**
 * Minimal structural seam for target-account validation (issue #1456,
 * Sub-Issue J). Satisfied by `AccountService`
 * (server/src/services/accountService.ts); mockable in tests. Injected via
 * `setAccountService` post-construction because AccountService is built after
 * SyncEngine (web/server.ts).
 */
export interface AccountValidator {
  getRaw(accountUuid: string): StoredAccount | null;
  /** The node's default ("active") account (#3839: resume binds it). Optional
   *  so test doubles that only validate need not implement it. */
  getActiveAccount?(): { accountUuid: string } | null;
}

/**
 * Issue #1509 (G1) — downgrade-detection predicate. Server mirror of
 * `isModelDowngraded()` in `web/src/lib/sessionHelpers.ts` — keep the two in sync.
 *
 * The reliable signal is a TWO-SOURCE mismatch: Hapimatic's own recorded
 * entitlement (`claudeAccount.subscriptionType === "max"`) vs. the model Claude
 * actually resolved. We trust Hapimatic's record — NOT Claude's own
 * subscriptionType, which the #1446 OAuth-token-injection path hardcodes to null,
 * causing Max sessions to silently fall back to Sonnet/200k (the root cause; see
 * #1506). A deliberate Sonnet selection (`modelMode === "sonnet"`) is NOT a
 * downgrade — the issue targets *silent* downgrades.
 */
export function isSessionModelDowngraded(session: {
  modelMode?: ModelMode;
  resolvedModel?: string;
  rawModel?: string;
  contextWindowTokens?: number;
  metadata?: { claudeAccount?: { subscriptionType?: string } } | null;
}): boolean {
  if (session.metadata?.claudeAccount?.subscriptionType !== "max") return false;
  if (session.modelMode === "sonnet") return false;
  // Explicit Fable selection is likewise intentional (issue #1633) — mirror of
  // web/src/lib/sessionHelpers.ts `isModelDowngraded`. Keep the two in sync.
  if (session.modelMode === "fable") return false;
  const resolved = session.resolvedModel?.toLowerCase() ?? "";
  // #2882 iter AD — a PINNED model (rawModel) is a deliberate choice; evaluate it
  // only once the running model has SETTLED onto the pin (mirror of the web
  // predicate). Prevents a first-turn false-positive while a pre-turn model switch
  // is still in flight. Keep in sync with web/src/lib/sessionHelpers.ts.
  const raw = session.rawModel?.toLowerCase() ?? "";
  if (raw) {
    if (
      raw.includes("sonnet") ||
      raw.includes("fable") ||
      raw.includes("haiku")
    ) {
      return false;
    }
    const settled =
      resolved !== "" && (resolved.startsWith(raw) || raw.startsWith(resolved));
    if (!settled) return false;
  }
  const isSonnetFamily = resolved.includes("sonnet");
  const ctx = session.contextWindowTokens;
  const isBelowEntitlementWindow = ctx != null && ctx <= 200_000;
  return isSonnetFamily || isBelowEntitlementWindow;
}

/**
 * Issue #1509 (G2) — halt-and-report notice injected ONCE into a downgraded
 * session on its first detected turn. Delivered as a user-role message via
 * MessageService (no system-role injection path exists). Contains no close-keyword
 * issue references.
 */
const MODEL_DOWNGRADE_NOTICE = [
  "⚠️ SYSTEM NOTICE — MODEL DOWNGRADE DETECTED (issue #1509)",
  "",
  "This session is bound to a Max-entitled account but resolved to a",
  "BELOW-ENTITLEMENT model (e.g. Sonnet / 200k instead of Opus / 1M). This is a",
  "known infrastructure bug in the account-token-injection path (#1446 -> #1506),",
  "NOT something you can diagnose or fix from inside this session.",
  "",
  "STOP any in-progress orchestration or high-stakes work NOW. Do NOT theorize",
  "about the cause or attempt infrastructure changes. Instead:",
  "1. Tell the user this session is running a downgraded model and its output may",
  "   be unreliable.",
  "2. Recommend respawning the session (the #1506 fix pins the entitled model at",
  "   spawn).",
  "",
  "Await the user's instruction before continuing.",
].join("\n");

/**
 * Issue #1883 (R12) — minimum interval between G3 escalations for the same
 * (session, reason), persisted in error_logs so it SURVIVES a server restart.
 * The in-memory `downgradeNotified` guard (R5) resets on restart, so a
 * crash-looping server would otherwise re-page on every boot; this cooldown is
 * the pager-spam guard.
 */
const SESSION_FATAL_ESCALATION_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

export class SyncEngine {
  private readonly store: Store;
  private readonly eventPublisher: EventPublisher;
  private readonly sessionCache: SessionCache;
  private readonly machineCache: MachineCache;
  private readonly messageService: MessageService;
  /** #3563: in-memory USER-APPROVAL mint records for orphaned-grant detection. */
  private readonly orphanGrantStore = new OrphanGrantStore();
  private readonly rpcGateway: RpcGateway;
  private inactivityTimer: NodeJS.Timeout | null = null;
  private midnightResetTimer: NodeJS.Timeout | null = null;
  // #1968: periodic orphan-file-claim reaper (60s). See reapOrphanedFileClaims().
  private fileClaimReaperTimer: NodeJS.Timeout | null = null;
  private mcpStatusByProject = new Map<string, McpStatusUpdate>();
  /**
   * Issue #2080: timelog + midnight-reset delegate. Owns the tzCache, the
   * per-session timelog baselines, and the reset/flush logic. SyncEngine keeps
   * the three interval handles (see the constructor) and delegates their
   * callbacks here.
   */
  private readonly timelogReset: TimelogResetService;
  private readonly mcpConfigStore: McpConfigStore;
  private readonly sessionRespawn: SessionRespawn;
  private readonly accountRestart: AccountRestart;
  private readonly sessionDeletion: SessionDeletion;
  private readonly sessionLifecycleOps: SessionLifecycleOps;
  private readonly sessionRelaunch: SessionRelaunch;
  private readonly mcpBatchCoordinator: McpBatchCoordinator;

  /**
   * Issue #1456 (Sub-Issue J): target-account validator for switchAccount().
   * Injected post-construction via setAccountService() — AccountService is
   * built after SyncEngine in web/server.ts. Null until wired; switchAccount
   * fail-closes when absent.
   */
  private accountService: AccountValidator | null = null;

  /**
   * Issue #2453 (Task 7): loop-cron ↔ session lifecycle coupler. Injected
   * post-construction via setLoopCronCoupler() — the SystemJobsService it wraps
   * is built in web/server.ts, after SyncEngine. Null → no loop-cron coupling
   * (the hooks below no-op).
   */
  private loopCronCoupler: LoopCronLifecycleCoupler | null = null;

  /**
   * Issue #3478: pre-kill marks set by respawn archives, so the dying CLI's own
   * unflagged `session-end` is treated as part of the respawn in
   * `handleSessionEnd` (consumed once, 60 s TTL — see respawnMarks.ts).
   */
  private readonly respawnMarks = new RespawnMarks();

  /**
   * Issue #1664 (epic #1662, Sub B): turn-lifecycle orchestrator, used here for
   * the orphan sweep (R5). Injected post-construction via setTurnLifecycle() —
   * TurnLifecycle is built after SyncEngine in index.ts (it needs the resolved
   * federation nodeId + Sub A's fail-open write service). Null until wired; the
   * sweep no-ops when absent (Fallback Preservation Rule).
   */
  private turnLifecycle: TurnLifecycle | null = null;

  // Issue #2080: per-session timelog baselines moved to TimelogResetService.

  /**
   * Issue #1509 (G1/G2): per-session de-dupe so the model-downgrade error_logs
   * entry AND the halt-and-report notice each fire exactly ONCE per session.
   * In-memory (resets on server restart — a still-downgraded session re-surfaces
   * once after a restart, which is acceptable). The ErrorLogger per-category
   * rate-limit (#1141) is a backstop.
   */
  private readonly downgradeNotified = new Set<string>();

  /**
   * Issue #1883 (G3) — the out-of-band escalation surface. Injected via
   * `setNotifier` post-construction (no construction-order dependency, keeps the
   * constructor + all call sites untouched). Null → G3 no-ops silently and the
   * session-fatal path degrades to G1 (error_logs) + G2 (in-session notice)
   * (Fallback Preservation Rule).
   */
  private notifier: Notifier | null = null;

  /**
   * Issue #3611 — the server-side `autoSelectOptimalAccount` preference reader,
   * injected via `setAutoSelectOptimalAccountReader` post-construction from
   * `index.ts` (no construction-order dependency; keeps the constructor + every
   * `new SyncEngine` call site untouched — the #3618 precedent). `spawnSession`
   * stamps the resolved boolean onto `opts` so every spawn caller inherits the
   * pick. Null / a throwing reader ⇒ the daemon runs NO optimal-pick (fail-closed).
   */
  private readAutoSelectOptimalAccount: (() => Promise<boolean>) | null = null;

  /**
   * Issue #1883 (Phase 2, R9) — per-session auto-abort dedupe. Marked BEFORE the
   * abort RPC so a throw cannot re-abort. Pruned on delete alongside
   * `downgradeNotified` (facade delegators).
   */
  private readonly abortedSessions = new Set<string>();

  /**
   * Issue #1883 (Phase 2, R7) — the settings.json auto-abort flag (DEFAULT OFF).
   * Set via `setSessionFatalConfig`. Auto-abort ALSO requires the env switch
   * `HAPI_SESSION_FATAL_ABORT_ENABLED=1` — a dual gate whose fail-safe is "no
   * abort".
   */
  private sessionFatalAutoAbortEnabled = false;

  /**
   * Issue #1905: per-session de-dupe for the runaway-guard ceiling breach — the
   * G1 log, the out-of-band notice, AND the hard-stop each fire exactly ONCE per
   * session (R4). In-memory (resets on server restart — a resurrected runaway
   * re-trips on its next finalize, which is self-healing). Pruned on session
   * delete alongside `downgradeNotified` (see the SessionDeletion wiring).
   */
  private readonly ceilingBreached = new Set<string>();

  /**
   * Issue #1905: the effective ceiling-guard config, cached in memory because the
   * turn-finalize check is SYNCHRONOUS while the config loader is async (1905-3).
   * Seeded to the generous defaults; set at startup and refreshed on every
   * `PUT /preferences/ceiling-guard` via {@link setCeilingGuardConfig}. Read with
   * zero disk I/O on the hot path.
   */
  private ceilingGuardConfig: CeilingGuardConfig = getCeilingGuardDefaults();

  /**
   * Issue #1905: the G2 in-app surfacing dep for a ceiling breach — a web push to
   * the session's namespace (the StallWatchdog precedent). Injected
   * post-construction via {@link setCeilingGuardDeps} to keep the ctor signature
   * stable. The G3 out-of-band operator page routes through the shared #1883
   * `Notifier` ({@link setNotifier}), not a second notify-pm surface.
   */
  private ceilingGuardPushService: Pick<PushService, "sendToNamespace"> | null =
    null;

  // #1963: register-only job-registry wiring (no watchdog — ratified scope).
  private readonly jobRegistry: JobRegistry | null;
  private readonly jobNode: string;

  /**
   * #1969 (File Conflict Monitor Sub D): monotonic version stamped onto every
   * `file-claim-delta` snapshot this node publishes. Peers merge per-node LWW on
   * it (accept iff strictly newer). Bumped via `Math.max(Date.now(), v + 1)` —
   * wall-clock-max is LOAD-BEARING (H1): a plain 0-based counter resets on
   * restart, and because static federation nodes are never evicted, peers'
   * monotonic guard would then reject ALL of this node's post-restart snapshots
   * on BOTH sync channels indefinitely. Wall-clock-max stays strictly increasing
   * within a boot AND across restarts, so a restarted node's snapshots are always
   * accepted. Starts at 0; the first `buildFileClaimSnapshot()` lifts it to
   * `Date.now()`.
   */
  private fileClaimVersion = 0;

  constructor(
    store: Store,
    io: Server,
    rpcRegistry: RpcRegistry,
    sseManager: SSEManager,
    private readonly errorLogger?: ErrorLogger | null,
    jobOpts?: { node?: string; jobRegistry?: JobRegistry | null }
  ) {
    this.store = store;
    this.jobRegistry = jobOpts?.jobRegistry ?? null;
    this.jobNode = jobOpts?.node ?? "standalone";
    this.eventPublisher = new EventPublisher(sseManager, event =>
      this.resolveNamespace(event)
    );
    this.sessionCache = new SessionCache(store, this.eventPublisher, {
      // Escalate to process cleanup when a session has been inactive
      // for >5 minutes. Archives the session, which triggers killSession
      // RPC and process tree cleanup. (Issue #849)
      onForceKill: (sessionId: string) => {
        // Issue #1661: liveness-aware force-kill. A loaded / long-silent-turn
        // tmux-launcher session can sit at active=false past the 5-min watchdog
        // while its Claude is genuinely alive (the same false-inactive trip-wire
        // that drives the reconnect-kill). Archiving here would SIGTERM-kill the
        // in-flight turn. So before the terminal archive, ask the daemon whether
        // the wrapper+pane are actually alive; if so, SKIP the kill and refresh
        // activeAt (reactivate) so it is not re-escalated next tick. A genuinely-
        // dead or uncertain session still archives (existing behavior — Fallback
        // Preservation Rule). This complements Task 2's reconnect re-attach gate:
        // together they close BOTH kill paths the false-inactive flag can trigger.
        void (async () => {
          try {
            const session = this.sessionCache.getSession(sessionId);
            const machineId = session?.metadata?.machineId;
            const tag = this.sessionCache.getSessionTag(sessionId);
            if (machineId && tag) {
              const alive = await this.rpcGateway.isSessionAlive(
                machineId,
                tag
              );
              if (alive === true) {
                this.errorLogger?.warn(
                  `Force-kill watchdog: session ${sessionId} flagged inactive >5min but the daemon reports it ALIVE — skipping archive, refreshing activeAt (issue #1661)`,
                  { category: "sync", sessionId }
                );
                this.sessionCache.reactivate(sessionId);
                // #3478: like the reconnect re-attach path, a session found
                // alive gets back any loops the coupler paused for it
                // (ledger-driven; a no-op when none were). reactivate() is not
                // a heartbeat, so the rising-edge resume never sees it.
                void this.loopCronCoupler?.onReconnect(sessionId);
                return;
              }
            }
          } catch (error) {
            // Never let a liveness-probe fault block the watchdog — fall through
            // to the terminal archive (Fallback Preservation Rule).
            this.errorLogger?.warn(
              `Force-kill watchdog: isSessionAlive probe for ${sessionId} threw (${error instanceof Error ? error.message : String(error)}) — proceeding with archive (issue #1661)`,
              { category: "sync", sessionId }
            );
          }
          // #1603: watchdog force-kill is a TERMINAL archive (no respawn
          // follows) — reap the launcher's hapimatic-remote window so window B's
          // claude does not orphan when the session is never deleted.
          void this.archiveSession(sessionId, { reapRemoteWindow: true });
        })();
      },
    });
    this.machineCache = new MachineCache(store, this.eventPublisher);
    this.messageService = new MessageService(store, io, this.eventPublisher, {
      // #3124: resolve a session's metadata for the message-hook stage
      // (`flavor` → harness manifest; `hookCoverage` → R5 dedup records).
      getSessionMetadata: sid =>
        this.sessionCache.getSession(sid)?.metadata ?? undefined,
      log: (message, context) => this.errorLogger?.info(message, context),
    });
    // #3331 (Task 9): register the USER-APPROVAL token-verify gate on the
    // #3124 message-hook stage. This is the FIRST production registration of a
    // message hook — nothing registered before. The gate resolves each session's
    // repo path via the SAME getSessionMetadata closure the MessageService uses.
    // Registration is idempotent by hook id; it takes effect only when
    // HAPI_MESSAGE_HOOKS is enabled on the instance (default OFF), so with the
    // flag off delivery is byte-identical to pre-#3331.
    registerApprovalTokenGate({
      getSessionMetadata: sid =>
        this.sessionCache.getSession(sid)?.metadata ?? undefined,
      config: loadApprovalTokensConfig(),
      hygieneTtlDays: loadApprovalHygieneConfig().hygieneTtlDays,
      log: (message, context) => this.errorLogger?.info(message, context),
      // #3563 (R1): record each fresh mint keyed on the gated session id so a later
      // terminal signal can detect an orphaned grant and post a proactive notice.
      recordMint: (sid, rec) => this.orphanGrantStore.record(sid, rec),
    });
    this.rpcGateway = new RpcGateway(io, rpcRegistry, errorLogger);
    // Issue #2080: MCP config disk-store delegate (~/.claude.json disabled
    // servers). Referenced lazily by the batch-coordinator closures below.
    this.mcpConfigStore = new McpConfigStore({
      sessionCache: this.sessionCache,
      getMcpStatus: projectDir => this.getMcpStatus(projectDir),
    });
    this.mcpBatchCoordinator = new McpBatchCoordinator({
      getCurrentState: sessionId =>
        this.mcpConfigStore.computeCurrentMcpStateForSession(sessionId),
      toggle: async (sid, name, enabled) => {
        // Primary path: RPC to the session's daemon-side launcher, which
        // updates both the SDK in-memory MCP state and ~/.claude.json.
        //
        // Note: rpcGateway.mcpToggle THROWS (rather than returning a shaped
        // response) when the RPC handler isn't registered or the socket
        // disconnects — see rpcCall in rpcGateway.ts. We catch and inspect
        // the error message so the fallback below can fire on those exact
        // shapes; other errors are mapped to `transport_failed` to keep
        // the McpToggleResponse contract.
        let result: McpToggleResponse;
        try {
          result = await this.rpcGateway.mcpToggle(sid, name, enabled);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = {
            ok: false,
            error: message,
            code: "transport_failed",
          };
        }
        if (result.ok) return result;
        // Fallback: when the RPC handler isn't registered or its socket
        // disconnected (daemon offline, session restored without an
        // attached launcher), write the durable layer (~/.claude.json)
        // directly from the server. Claude re-reads this on every spawn
        // so the toggle takes effect on the next user message — same end
        // state as the launcher's no-active-query branch in
        // applyDisabledServerToggle. Without this fallback, every toggle
        // attempt against a session whose launcher hasn't (re)connected
        // silently fails with `transport_failed` even though the durable
        // write would have succeeded.
        if (
          result.code === "transport_failed" &&
          /RPC (handler not registered|socket disconnected)/i.test(result.error)
        ) {
          const session = this.sessionCache.getSession(sid);
          const projectDir = session?.metadata?.path;
          if (projectDir) {
            const fallback = this.mcpConfigStore.writeDisabledServersToConfig(
              projectDir,
              name,
              enabled
            );
            if (fallback.ok) {
              return { ok: true, method: "config" };
            }
            return fallback;
          }
        }
        return result;
      },
      publish: snapshot => {
        this.eventPublisher.emit({
          type: "mcp-batch-progress" as const,
          sessionId: snapshot.sessionId,
          data: snapshot,
        });
      },
    });
    // Issue #2080: timelog + midnight-reset delegate. Constructed after the
    // store/session/event collaborators it needs; SyncEngine still owns the
    // three interval handles below and delegates their callbacks here.
    this.timelogReset = new TimelogResetService({
      store,
      sessionCache: this.sessionCache,
      eventPublisher: this.eventPublisher,
      errorLogger,
    });
    // Issue #2080: session-respawn delegate (reconnect + branch). spawnSession
    // stays the facade choke point (routed via callback so the #1698 gate and
    // any test spy on rpcGateway.spawnSession still apply); turnLifecycle is
    // read lazily since it is injected post-construction.
    this.sessionRespawn = new SessionRespawn({
      sessionCache: this.sessionCache,
      rpcGateway: this.rpcGateway,
      eventPublisher: this.eventPublisher,
      errorLogger,
      getTurnLifecycle: () => this.turnLifecycle,
      spawnSession: opts => this.spawnSession(opts),
      // #2453 (Task 7): auto-resume this session's ledgered loops on reconnect.
      getLoopCronCoupler: () => this.loopCronCoupler,
    });
    // Issue #2080: account-keyed restart delegate (switchAccount +
    // tokenRefreshRestart). archiveSession + spawnSession stay facade methods
    // (routed via lazy callbacks so test spies on engine.archiveSession /
    // rpcGateway.spawnSession still apply); accountService is read lazily since
    // it is injected post-construction.
    this.accountRestart = new AccountRestart({
      sessionCache: this.sessionCache,
      rpcGateway: this.rpcGateway,
      eventPublisher: this.eventPublisher,
      errorLogger,
      getAccountService: () => this.accountService,
      archiveSession: (sid, opts) => this.archiveSession(sid, opts),
      spawnSession: opts => this.spawnSession(opts),
      // Issue #2002: close the mid-turn session's open telemetry turn around the
      // hard kill (killSession emits no turn:finalize). Lazy getter — turnLifecycle
      // is assigned post-construction (mirrors SessionRespawn above).
      getTurnLifecycle: () => this.turnLifecycle,
      // Issue #4823: the payment-method switch checks a key target against this
      // node's vault BEFORE killing the session (redacted record only). Read
      // lazily on each call from the configuration singleton — the same settings
      // file the /api/api-keys routes mount with (buildWebApp.ts). The singleton
      // throws when read before createConfiguration(); that reads as "no such
      // key" (fail closed — the switch is refused, nothing is killed), logged.
      getApiKeyById: async id => {
        try {
          return await readRedactedApiKeyById(configuration.settingsFile, id);
        } catch (error) {
          errorLogger?.error(
            `API-key lookup for a session switch failed: ${error instanceof Error ? error.message : String(error)}`,
            { category: "sync" }
          );
          return null;
        }
      },
    });
    // Issue #2080: session-deletion delegate (single + bulk). All
    // collaborators are the same facade objects (test spies on
    // engine.rpcGateway.cleanupTmuxSession / mcpBatchCoordinator.clear apply).
    this.sessionDeletion = new SessionDeletion({
      sessionCache: this.sessionCache,
      rpcGateway: this.rpcGateway,
      store,
      mcpBatchCoordinator: this.mcpBatchCoordinator,
      errorLogger,
      // #2453 (Task 7): purge this session's bound loops on delete (D1).
      getLoopCronCoupler: () => this.loopCronCoupler,
      // #1905 (1905-4): prune the in-memory ceiling-breach dedupe Set on delete
      // — and, an in-path fix, the sibling `downgradeNotified` Set, which leaked
      // one entry per session (it was never pruned anywhere). Best-effort.
      onSessionDeleted: sid => {
        this.ceilingBreached.delete(sid);
        this.downgradeNotified.delete(sid);
      },
    });
    // Issue #2080: session lifecycle-ops delegate (archive / config-apply /
    // model-mode restart). handleSessionEnd + spawnSession stay facade methods
    // (routed via lazy callbacks); archiveSession remains a public facade
    // delegator because many external sites call it.
    this.sessionLifecycleOps = new SessionLifecycleOps({
      sessionCache: this.sessionCache,
      rpcGateway: this.rpcGateway,
      errorLogger,
      handleSessionEnd: payload => this.handleSessionEnd(payload),
      spawnSession: opts => this.spawnSession(opts),
      markRespawning: sid => this.respawnMarks.mark(sid),
    });
    // Issue #2149: session-relaunch delegate (launcher / safeMode teardown +
    // respawn). archiveSession + spawnSession stay facade callbacks (test spies on
    // engine.archiveSession / rpcGateway.spawnSession still apply); turnLifecycle
    // is read lazily since it is injected post-construction (mirrors AccountRestart).
    this.sessionRelaunch = new SessionRelaunch({
      sessionCache: this.sessionCache,
      rpcGateway: this.rpcGateway,
      errorLogger,
      archiveSession: (sid, opts) => this.archiveSession(sid, opts),
      spawnSession: opts => this.spawnSession(opts),
      getTurnLifecycle: () => this.turnLifecycle,
    });
    this.reloadAll();
    this.inactivityTimer = setInterval(() => {
      this.jobRegistry?.update("sync-inactivity-expiry", {
        lastTickAt: Date.now(),
      });
      this.expireInactive();
    }, 5_000);

    // Issue #1119: Fire any catch-up resets for midnight boundaries crossed
    // while the server was offline. Runs once on startup, asynchronously —
    // the timer below begins ticking immediately and will pick up any
    // namespaces the catch-up missed (e.g. namespaces seen for the first
    // time after startup).
    void this.timelogReset.catchUpMissedResets();

    // Midnight reset: check every 60s if any active namespace's local
    // date has changed (replaces the single-global lastResetDate from
    // before #1119). Per-namespace state is persisted in midnight_reset_state.
    this.midnightResetTimer = setInterval(() => {
      this.jobRegistry?.update("sync-midnight-reset", {
        lastTickAt: Date.now(),
      });
      void this.timelogReset.checkMidnightReset();
    }, 60_000);

    // #1968 (R5): periodic orphan-claim reaper. Releases file claims owned by
    // sessions no longer live (crashed sessions that never fired
    // handleSessionEnd). 60s bounded interval.
    this.fileClaimReaperTimer = setInterval(() => {
      this.jobRegistry?.update("sync-file-claim-reaper", {
        lastTickAt: Date.now(),
      });
      this.reapOrphanedFileClaims();
    }, 60_000);

    // #1963: register-only — these 3 SyncEngine timers are visible in the
    // runtime job registry (Sub-D #1964) but, per ratified scope, carry NO
    // boot-start watchdog (core-orchestrator timers, not self-healing
    // pollers). lastTickAt is updated in each callback above.
    for (const [name, intervalMs] of [
      ["sync-inactivity-expiry", 5_000],
      ["sync-midnight-reset", 60_000],
      ["sync-file-claim-reaper", 60_000],
    ] as const) {
      this.jobRegistry?.register({
        name,
        node: this.jobNode,
        kind: JOB_KIND_IN_PROCESS_LOOP,
        intervalMs,
        lastTickAt: null,
        status: "ok",
        lastError: null,
      });
    }
  }

  stop(): void {
    if (this.inactivityTimer) {
      clearInterval(this.inactivityTimer);
      this.inactivityTimer = null;
    }
    if (this.midnightResetTimer) {
      clearInterval(this.midnightResetTimer);
      this.midnightResetTimer = null;
    }
    if (this.fileClaimReaperTimer) {
      clearInterval(this.fileClaimReaperTimer);
      this.fileClaimReaperTimer = null;
    }
    for (const name of [
      "sync-inactivity-expiry",
      "sync-midnight-reset",
      "sync-timelog-flush",
      "sync-file-claim-reaper",
    ]) {
      this.jobRegistry?.update(name, { status: "stopped" });
    }
  }

  subscribe(listener: SyncEventListener): () => void {
    return this.eventPublisher.subscribe(listener);
  }

  private resolveNamespace(event: SyncEvent): string | undefined {
    if (event.namespace) {
      return event.namespace;
    }
    if ("sessionId" in event) {
      return this.sessionCache.getSession(event.sessionId)?.namespace;
    }
    if ("machineId" in event) {
      return this.machineCache.getMachine(event.machineId)?.namespace;
    }
    return undefined;
  }

  getSessions(): Session[] {
    return this.sessionCache.getSessions();
  }

  getSessionsByNamespace(namespace: string): Session[] {
    return this.sessionCache.getSessionsByNamespace(namespace);
  }

  getMessageCountForSession(sessionId: string): number {
    return this.sessionCache.getMessageCountForSession(sessionId);
  }

  getMessageCountsByNamespace(namespace: string): Map<string, number> {
    return this.sessionCache.getMessageCountsByNamespace(namespace);
  }

  getChildBranchCounts(namespace: string): Map<string, number> {
    return this.sessionCache.getChildBranchCounts(namespace);
  }

  getChildBranchCountForSession(parentSessionId: string): number {
    return this.sessionCache.getChildBranchCount(parentSessionId);
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessionCache.getSession(sessionId);
  }

  /**
   * Resolve a local session's Claude sub-agent transcript directory (issue
   * #4386). Reads `cc_session_id` + `transcript_path` from the session's latest
   * turn row (both set at turn open), falling back to
   * `metadata.claudeSessionId` for the id only. Returns `null` when no stored
   * `transcriptPath` exists — the agent-peek route then answers 404
   * `transcript not yet available`, because the `workingDirectory`
   * reconstruction is account-blind under #1573 and the server does not know
   * the account's config dir. #4385/#4387 import this by name.
   */
  getAgentTranscriptPaths(
    sessionId: string
  ): { subagentsDir: string; ccSessionId: string } | null {
    const turn = this.store.turns.getLatestTurnForSession(sessionId);
    const transcriptPath = turn?.transcriptPath ?? undefined;
    const ccSessionId =
      turn?.ccSessionId ??
      this.sessionCache.getSession(sessionId)?.metadata?.claudeSessionId ??
      undefined;
    if (!ccSessionId || !transcriptPath) return null;
    const { subagentsDir } = resolveTranscriptPaths({
      ccSessionId,
      transcriptPath,
    });
    return { subagentsDir, ccSessionId };
  }

  /**
   * Enumerate a session's live RPC capabilities (issue #2418 read path).
   * Delegates to the RpcGateway, which resolves the session's `/cli` socket via
   * room membership and reads the RpcRegistry. Returns `{ name, meta? }[]`
   * (possibly empty) for a live socket, or `null` when the session has no live
   * `/cli` socket. The route layer maps `null` → 404 and performs the
   * session-existence / namespace guard (this method is registry-only).
   */
  getSessionCapabilities(
    sessionId: string
  ): { name: string; meta?: CapabilityMeta }[] | null {
    return this.rpcGateway.getSessionCapabilities(sessionId);
  }

  /**
   * Read the registered CapabilityMeta for a session+method (issue #2419 invoke
   * gate). Delegates to the RpcGateway, which derives the wire key shared with
   * dispatch ([1B-16]). `null` (name-only / registry miss) is treated as NOT
   * invocable by the fail-closed gate.
   */
  getCapabilityMeta(sessionId: string, method: string): CapabilityMeta | null {
    return this.rpcGateway.getCapabilityMeta(sessionId, method);
  }

  /**
   * Dispatch a capability over the session RPC path (issue #2419, R1). Policy
   * enforcement is the route's responsibility (`capabilityPolicy`); this MUST
   * only be reached after the fail-closed gate has passed.
   */
  async invokeCapability(
    sessionId: string,
    method: string,
    params: unknown
  ): Promise<unknown> {
    return await this.rpcGateway.invokeCapability(sessionId, method, params);
  }

  getSessionByNamespace(
    sessionId: string,
    namespace: string
  ): Session | undefined {
    return this.sessionCache.getSessionByNamespace(sessionId, namespace);
  }

  /**
   * Look up a session by its tag (e.g., "hapi-1234567890-abc123") within a namespace.
   * Used by CLI routes where the caller may pass a tag instead of UUID.
   */
  getSessionByTagAndNamespace(
    tag: string,
    namespace: string
  ): Session | undefined {
    return this.sessionCache.getSessionByTagAndNamespace(tag, namespace);
  }

  getActiveSessions(): Session[] {
    return this.sessionCache.getActiveSessions();
  }

  /**
   * Issue #2627 (Sub-Issue E, R5): scrub a deleted custom output-style name from
   * every persisted session so a respawn never carries a now-missing style.
   * Returns the number of sessions scrubbed. Delegates to the cache (all state
   * changes go through the SyncEngine surface).
   */
  clearOutputStyleFromSessions(styleName: string): number {
    return this.sessionCache.clearOutputStyleFromSessions(styleName);
  }

  /**
   * #1969 (File Conflict Monitor Sub D): build THIS node's live-claim snapshot
   * for federation sync. Bumps the monotonic (wall-clock-max) version, then
   * returns `{ nodeId, version, claims }` where `claims` = this node's live store
   * claims filtered to LIVE sessions (the same #1968 filter the `GET /file-claims`
   * route applies — so a crashed session's claims are never published to peers).
   *
   * The SINGLE snapshot builder used by BOTH consumers: `emitFileClaimDelta()`
   * (the SSE-bridge fast path) AND the `GET /api/federation/claims` anti-entropy
   * route. Stamping the version at build time keeps the poll response and the
   * emitted delta self-consistent even if a future mutation site forgets an emit.
   */
  buildFileClaimSnapshot(): FileClaimSyncSnapshot {
    this.fileClaimVersion = Math.max(Date.now(), this.fileClaimVersion + 1);
    const claims = filterClaimsToLiveSessions(
      this.store.fileClaims.getLiveClaims(),
      liveSessionIdSet(this.getActiveSessions())
    );
    return { nodeId: this.jobNode, version: this.fileClaimVersion, claims };
  }

  /**
   * #1969 (R1): publish this node's live-claim snapshot as a `file-claim-delta`
   * `SyncEvent`. The federation SSE event bridge forwards it to every peer
   * (non-session events are forwarded unconditionally), where each peer merges it
   * into its `FileClaimSync` replica. Called from BOTH release sites below
   * (`handleSessionEnd`, the orphan reaper) and from the #1967 route + session-
   * deletion callbacks (fail-soft: a null engine at startup simply skips it — the
   * 15 s anti-entropy poll is the backstop, so a dropped emit self-heals).
   */
  emitFileClaimDelta(): void {
    this.eventPublisher.emit({
      type: "file-claim-delta" as const,
      snapshot: this.buildFileClaimSnapshot(),
    });
  }

  /**
   * #3018: publish a host-global, payload-free `chat-sections-changed` invalidation
   * through the EventPublisher. `emit()` notifies `SyncEngine.subscribe()` listeners
   * (including `/api/federation/events`) BEFORE the local SSE broadcast, so this is
   * the MANDATORY path for a GLOBAL chat-sections write: it reaches both federation
   * peers and local browsers. A node-local (`inherit:false`) override must NOT use
   * this method — the route calls `SSEManager.broadcast()` directly so the override
   * refreshes only that node's browsers and never enters federation.
   */
  emitChatSectionsChanged(): void {
    this.eventPublisher.emit({
      type: "chat-sections-changed" as const,
    });
  }

  /**
   * #2700: publish a namespace-scoped `schedule-changed` invalidation for a
   * scheduled task's lifecycle (create / delete / execute). The scheduler
   * extension holds only this SyncEngine, so this is its sole emit seam; routing
   * through the EventPublisher reaches federation subscribers before the local
   * SSE broadcast. `namespace` is REQUIRED here: the event has no
   * sessionId/machineId, so `resolveNamespace` cannot derive one and
   * `SSEManager.shouldSend()` would drop a namespace-less event for every browser.
   */
  emitScheduleChanged(args: {
    namespace: string;
    scheduleId: string;
    changeKind: ScheduleChangeKind;
  }): void {
    this.eventPublisher.emit({
      type: "schedule-changed" as const,
      namespace: args.namespace,
      scheduleId: args.scheduleId,
      changeKind: args.changeKind,
    });
  }

  getMachines(): Machine[] {
    return this.machineCache.getMachines();
  }

  getMachinesByNamespace(namespace: string): Machine[] {
    return this.machineCache.getMachinesByNamespace(namespace);
  }

  getMachine(machineId: string): Machine | undefined {
    return this.machineCache.getMachine(machineId);
  }

  getMachineByNamespace(
    machineId: string,
    namespace: string
  ): Machine | undefined {
    return this.machineCache.getMachineByNamespace(machineId, namespace);
  }

  getOnlineMachines(): Machine[] {
    return this.machineCache.getOnlineMachines();
  }

  getOnlineMachinesByNamespace(namespace: string): Machine[] {
    return this.machineCache.getOnlineMachinesByNamespace(namespace);
  }

  getMcpStatus(projectDir?: string): McpStatusUpdate | null {
    if (projectDir) {
      return (
        this.mcpStatusByProject.get(projectDir) ??
        this.mcpStatusByProject.get("__global__") ??
        null
      );
    }
    return this.mcpStatusByProject.get("__global__") ?? null;
  }

  updateMcpStatus(status: McpStatusUpdate): void {
    const key = status.projectDir ?? "__global__";
    this.mcpStatusByProject.set(key, status);
    this.eventPublisher.emit({
      type: "mcp-status-updated" as const,
      data: status,
    });
    // Round 11 (epic #3285): a reconnected session's MCP state is now known —
    // apply anything saved for it while it was disconnected.
    this.replayStagedMcpDesired(status.projectDir);
  }

  getMessagesPage(
    sessionId: string,
    options: { limit: number; beforeSeq: number | null }
  ): {
    messages: DecryptedMessage[];
    page: {
      limit: number;
      beforeSeq: number | null;
      nextBeforeSeq: number | null;
      hasMore: boolean;
    };
  } {
    return this.messageService.getMessagesPage(sessionId, options);
  }

  getMessagesAfter(
    sessionId: string,
    options: { afterSeq: number; limit: number }
  ): DecryptedMessage[] {
    return this.messageService.getMessagesAfter(sessionId, options);
  }

  /**
   * Highest message `seq` for a session (0 when none). Thin passthrough to the
   * store — sibling of `getMessagesAfter`. Added for #1234 so AutoRecoveryService
   * can capture the R3 seq watermark at exhausted-event time without needing a
   * direct `store` dependency in its constructor.
   */
  getMaxSeq(sessionId: string): number {
    return this.store.messages.getMaxSeq(sessionId);
  }

  handleRealtimeEvent(event: SyncEvent): void {
    if (event.type === "session-updated" && event.sessionId) {
      this.sessionCache.refreshSession(event.sessionId);
      return;
    }

    if (event.type === "machine-updated" && event.machineId) {
      this.machineCache.refreshMachine(event.machineId);
      return;
    }

    if (event.type === "message-received" && event.sessionId) {
      if (!this.sessionCache.getSession(event.sessionId)) {
        this.sessionCache.refreshSession(event.sessionId);
      }
      // #2026: clear a stale manual "read" override ONLY when genuinely new
      // user-facing assistant content arrives — NOT on thinking edges. This is
      // the central choke point every CLI-persisted message flows through
      // (bound at index.ts onWebappEvent → handleRealtimeEvent).
      if (isNewUserFacingAssistantContent(event.message?.content)) {
        this.sessionCache.clearNeedsReviewOverrideOnNewContent(event.sessionId);
      }
    }

    this.eventPublisher.emit(event);
  }

  handleSessionAlive(payload: {
    sid: string;
    time: number;
    thinking?: boolean;
    mode?: "local" | "remote";
    permissionMode?: PermissionMode;
    modelMode?: ModelMode;
    effort?: string;
    // Composer-chip pin integrity: pinned raw model id; `null` = pin cleared.
    rawModel?: string | null;
    resolvedModel?: string;
    contextWindowTokens?: number;
    contextUsedTokens?: number;
    contextPercentage?: number;
    // Issue #1653: blocked-on-TUI-prompt state riding the keepAlive runtime.
    blockedOnTuiPrompt?: { message: string; since: number } | null;
    // Issue #1647: rate-limited (429 session-limit) state riding the runtime.
    rateLimited?: {
      resetText: string;
      resetAt: number | null;
      since: number;
    } | null;
    // Issue #4383: background-agents snapshot forwarded whole to the cache (K11).
    backgroundAgents?: BackgroundAgentsSnapshot | null;
  }): void {
    const aliveResult = this.sessionCache.handleSessionAlive(payload);
    // #3478: the session came back active, by any driver (reconnect, a daemon
    // reconnect-respawn, RecoveryService, a revival through an account switch).
    // Resume ONLY the loops the coupler paused for it — ledger-driven, so a
    // no-op when nothing was auto-paused. Fire-and-forget. A respawn mark still
    // standing now is stale (the respawned process is alive, so the kill's own
    // end has come and gone, or the old CLI was already gone): drop it, so the
    // new process's genuine death pauses as usual.
    if (aliveResult.activatedRisingEdge) {
      this.respawnMarks.consume(payload.sid);
      void this.loopCronCoupler?.onReconnect(payload.sid);
    }
    this.checkModelDowngrade(payload.sid);
    // #3563: on the `rateLimited` rising edge (a genuinely new session-limit 429),
    // check for a grant minted in the aborting turn and post a proactive notice.
    if (aliveResult.rateLimitedRisingEdge) this.checkOrphanGrant(payload.sid);
    // #4385: record each just-completed background agent's full usage. The read
    // is SYNCHRONOUS (readTranscript), so it is deferred out of this socket
    // callback and bounded to the agents that changed on this tick — never a
    // per-tick scan of every agent.
    const completed = aliveResult.completedBackgroundAgents;
    if (completed.length > 0) {
      setImmediate(() => {
        this.recordBackgroundAgentUsage(payload.sid, completed);
      });
    }
  }

  /**
   * Issue #4385 (epic #4382 Sub C, Task 3): record each completed background
   * agent's FULL usage in `background_agent_usage`, on the node that owns the
   * session (the CLI connects to its own node's hub, so the agent file is local).
   *
   * The recorder records exactly the agents the finalize rollup excludes (T10):
   * a meta `requestShape === "background"` records; an absent field falls back to
   * the launching `Agent` tool_use in the main transcript (Task 1's flag and
   * `async_launched` arms); anything else is a sync agent, already counted in its
   * spawning turn, and is skipped. The row is a full-file recompute that REPLACES
   * the previous one, so a resumed agent that notifies twice is counted once.
   * `description` / `agentType` come from the SCRUBBED cache entry (T11), never
   * the raw meta. The agent is priced with its OWN model at its first assistant
   * timestamp. Fail-open: any throw is logged and never reaches the caller.
   */
  recordBackgroundAgentUsage(
    sessionId: string,
    agents: readonly BackgroundAgentEntry[]
  ): void {
    try {
      const session = this.getSession(sessionId);
      if (!session) return;
      const paths = this.getAgentTranscriptPaths(sessionId);
      if (!paths) {
        // No turn row with a transcript path yet. The `workingDirectory`
        // reconstruction is never used: it resolves to host ~/.claude on an
        // account-isolated session (#1573) and would silently record nothing.
        console.debug(
          `[bg-agent-usage #4385] ${sessionId}: no transcript path yet — skipped ${agents.length} agent(s)`
        );
        return;
      }
      const latestTurn = this.store.turns.getLatestTurnForSession(sessionId);
      const mainPath = latestTurn?.transcriptPath ?? null;
      // #4824: the binding comes from the turn LEDGER, never `session.metadata`.
      // On a switch (#4823) `archiveSession` → `handleSessionEnd` defers this
      // write with `setImmediate`, and the switch persists the NEW binding to
      // the session record before that callback runs — the latest ledger row is
      // still the last pre-switch turn. The upsert keeps a binding the agent was
      // already recorded under (normally the finalize seed's).
      const binding: TurnBillingBinding = latestTurn
        ? {
            authBindingKind: latestTurn.authBindingKind,
            apiKeyId: latestTurn.apiKeyId,
          }
        : NO_TURN_BINDING;
      for (const agent of agents) {
        // #4385 fix round 1: isolate each agent — one that throws (a rate card,
        // a DB write) must not drop the rest of the batch.
        try {
          this.recordOneBackgroundAgent(
            session.id,
            session.namespace ?? null,
            agent,
            paths.subagentsDir,
            mainPath,
            binding
          );
        } catch (error) {
          this.errorLogger?.warn("background agent usage record failed", {
            category: "turns-lifecycle",
            sessionId,
            context: {
              agentId: agent.id,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    } catch (error) {
      this.errorLogger?.warn("background agent usage record failed", {
        category: "turns-lifecycle",
        sessionId,
        context: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private recordOneBackgroundAgent(
    hapiSessionId: string,
    namespace: string | null,
    agent: BackgroundAgentEntry,
    subagentsDir: string,
    mainPath: string | null,
    binding: TurnBillingBinding
  ): void {
    // #4657: the id is CLI-supplied and becomes a file name below — check it
    // with the same bounded rule the seed path and the peek route use.
    if (!isValidAgentId(agent.id)) {
      this.errorLogger?.warn("background agent id rejected", {
        category: "turns-lifecycle",
        sessionId: hapiSessionId,
        context: { agentId: String(agent.id).slice(0, 80) },
      });
      return;
    }
    const meta = readAgentMeta(subagentsDir, agent.id);
    const toolUseId = agent.toolUseId ?? meta?.toolUseId ?? null;
    let background = meta?.requestShape === "background";
    if (!background && meta?.requestShape === undefined) {
      background =
        toolUseId !== null &&
        mainPath !== null &&
        classifyAgentLaunch(mainPath, toolUseId) === "background";
    }
    if (!background) {
      console.debug(
        `[bg-agent-usage #4385] ${hapiSessionId}: agent ${agent.id} is not a background launch — counted in its spawning turn, not recorded`
      );
      return;
    }
    const usage = readAgentFileUsage(
      this.store.getRawDb(),
      subagentsDir,
      agent.id,
      agent.startedAt
    );
    if (!usage) {
      // Task 1 already excluded this agent from the rollup, so a silent skip
      // would lose its usage entirely — always warn (T10). A missing or
      // unreadable file writes nothing: the stored row, if any, stays.
      this.errorLogger?.warn("background agent file missing or unreadable", {
        category: "turns-lifecycle",
        sessionId: hapiSessionId,
        context: { agentId: agent.id, subagentsDir },
      });
      console.warn(
        `[bg-agent-usage #4385] ${hapiSessionId}: agent ${agent.id} has no readable file in ${subagentsDir} — row left as is`
      );
      return;
    }
    this.store.backgroundAgentUsage.upsert({
      hapiSessionId,
      agentId: agent.id,
      toolUseId,
      agentType: agent.agentType || null,
      description: agent.description || null,
      ...usage,
      endedAtMs: agent.endedAt ?? Date.now(),
      status: agent.status,
      nodeId: this.jobNode,
      namespace,
      authBindingKind: binding.authBindingKind,
      apiKeyId: binding.apiKeyId,
    });
  }

  /**
   * Issue #4385 fix round 1: the finalize seed. Writes a row from the agent file
   * as it is now for each background launch the parse excluded and that has no
   * row yet (`backgroundAgentSeed.ts`), so an agent whose completion the hub
   * never sees is still counted — with what the pre-#4385 rollup counted.
   * Fail-open: any throw is logged and never reaches the finalize.
   *
   * #4824: `seq` is the finalizing turn — the one that launched `agents` — and
   * the rows take ITS recorded binding. Without it (a direct caller), the
   * session's latest turn stands in.
   */
  seedBackgroundAgentUsage(
    hapiSessionId: string,
    transcriptPath: string | undefined,
    ccSessionId: string | undefined,
    agents: ExcludedBackgroundAgent[],
    seq?: number
  ): void {
    try {
      if (!transcriptPath || !ccSessionId) {
        this.errorLogger?.warn("background agent seed: no transcript path", {
          category: "turns-lifecycle",
          sessionId: hapiSessionId,
          context: { agents: agents.map(a => a.agentId) },
        });
        return;
      }
      const { subagentsDir } = resolveTranscriptPaths({
        ccSessionId,
        transcriptPath,
      });
      const db = this.store.getRawDb();
      const latestSeq =
        seq ?? this.store.turns.getLatestTurnForSession(hapiSessionId)?.seq;
      seedExcludedBackgroundAgents({
        db,
        store: this.store.backgroundAgentUsage,
        hapiSessionId,
        namespace: this.getSession(hapiSessionId)?.namespace ?? null,
        nodeId: this.jobNode,
        subagentsDir,
        agents,
        binding:
          latestSeq === undefined
            ? NO_TURN_BINDING
            : readTurnBinding(db, hapiSessionId, latestSeq),
        onMissing: agentId =>
          this.errorLogger?.warn(
            "background agent file missing or unreadable at finalize",
            {
              category: "turns-lifecycle",
              sessionId: hapiSessionId,
              context: { agentId, subagentsDir },
            }
          ),
        onError: (agentId, error) =>
          this.errorLogger?.warn("background agent seed failed", {
            category: "turns-lifecycle",
            sessionId: hapiSessionId,
            context: {
              agentId,
              error: error instanceof Error ? error.message : String(error),
            },
          }),
      });
    } catch (error) {
      this.errorLogger?.warn("background agent seed failed", {
        category: "turns-lifecycle",
        sessionId: hapiSessionId,
        context: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /** The running background agents in a session's last snapshot (#4385). */
  private runningBackgroundAgents(sessionId: string): BackgroundAgentEntry[] {
    return (
      this.sessionCache.getSession(sessionId)?.backgroundAgents?.agents ?? []
    ).filter(a => a.status === "running");
  }

  /**
   * Issue #4385 fix round 1: a session that ends (or expires) while agents run
   * drops its snapshot with no completion tick. Record those agents from their
   * files as they are now; a later completion write still REPLACES the row.
   */
  private recordAgentsOfEndedSession(
    sessionId: string,
    agents: BackgroundAgentEntry[]
  ): void {
    if (agents.length === 0) return;
    if (this.sessionCache.getSession(sessionId)?.backgroundAgents) return;
    setImmediate(() => {
      this.recordBackgroundAgentUsage(sessionId, agents);
    });
  }

  /**
   * #4936: persist the durable in-thread STOP notice for an API spend cap / a
   * user-set spend limit (written by `SpendLimitNoticeObserver`). A
   * `role:"agent"` event record — never enqueued to Claude.
   */
  persistSpendLimitNotice(
    sessionId: string,
    opts: Parameters<MessageService["persistSpendLimitNotice"]>[1]
  ): void {
    this.messageService.persistSpendLimitNotice(sessionId, opts);
  }

  /**
   * #3563: THE single session-keyed orphaned-grant check, called from every
   * terminal signal (the `rateLimited` rising edge above, the `api-error`
   * observer, `orphanTrackedTurnsForSession`, session close, and the
   * `orphanGrantStep` FinalizeStep on abort). For each recorded mint it re-checks
   * the grant file BY NONCE and, on a live match, persists a `grant-orphaned`
   * NOTICE through #3579's `persistGateNotice` surface — then DROPS the record
   * (the dedup invariant that makes the overlapping triggers post exactly once).
   * Synchronous + fail-open. Posts NO agent-directed message and never
   * mints/consumes a grant (R5) — the notice is a `role:"agent"` event record,
   * NOT a `role:"user"` message `apiSession` would enqueue.
   */
  checkOrphanGrant(sessionId: string): void {
    runOrphanGrantCheck(sessionId, {
      readMintRecords: sid => this.orphanGrantStore.read(sid),
      dropRecord: (sid, nonce) => this.orphanGrantStore.dropByNonce(sid, nonce),
      persistNotice: (sid, params) =>
        this.messageService.persistGateNotice(sid, {
          hookId: APPROVAL_TOKEN_HOOK_ID,
          code: "grant-orphaned",
          params,
        }),
      log: (message, context) => this.errorLogger?.info(message, context),
    });
  }

  /**
   * #3563 (R3 bind-first): on a CLEAN turn end, drop any mint record the finalized
   * turn opened AT OR AFTER (a token queued into a PRE-EXISTING turn is kept — the
   * token-bearing turn has not opened yet). Called by the `orphanGrantStep`
   * FinalizeStep with the finalized turn's resolved `started_at_ms`.
   */
  dropOrphanRecordsForCleanTurn(
    sessionId: string,
    startedAtMs: number | null
  ): void {
    if (startedAtMs != null)
      this.orphanGrantStore.dropOpenedAtOrAfter(sessionId, startedAtMs);
  }

  /** #3563: cheap probe for the FinalizeStep's common-case early-out. */
  hasOrphanRecords(sessionId: string): boolean {
    return this.orphanGrantStore.has(sessionId);
  }

  /** #3563: drop all mint records for a removed session (store hygiene). */
  forgetOrphanRecords(sessionId: string): void {
    this.orphanGrantStore.dropSession(sessionId);
  }

  /**
   * Issue #1509 (G1 + G2): detect a session silently running a downgraded /
   * below-entitlement model and, ONCE per session, (G1) record the anomaly in
   * error_logs and (G2) inject a halt-and-report notice the session sees on its
   * next turn. Fired from handleSessionAlive because resolvedModel /
   * contextWindowTokens are unknown until the first assistant turn.
   *
   * Detection + surfacing only: remediation (pinning the entitled model at
   * spawn) is owned by #1506.
   */
  private checkModelDowngrade(sessionId: string): void {
    if (this.downgradeNotified.has(sessionId)) return;
    const session = this.sessionCache.getSession(sessionId);
    if (!session || !isSessionModelDowngraded(session)) return;

    // Mark BEFORE side effects so a throw below cannot cause a re-notify loop.
    this.downgradeNotified.add(sessionId);

    const account = session.metadata?.claudeAccount;
    // G1 — record the anomaly once in error_logs (category "model-downgrade").
    this.errorLogger?.warn(
      `Model downgrade: session ${sessionId} bound to ${account?.planLabel ?? "a Max account"} resolved to ${session.resolvedModel ?? "an unknown model"} (contextWindowTokens=${session.contextWindowTokens ?? "n/a"}) — below entitlement. See issue #1509 / #1506.`,
      {
        category: "model-downgrade",
        sessionId,
        context: {
          resolvedModel: session.resolvedModel ?? null,
          contextWindowTokens: session.contextWindowTokens ?? null,
          modelMode: session.modelMode ?? null,
          subscriptionType: account?.subscriptionType ?? null,
          planLabel: account?.planLabel ?? null,
        },
      }
    );

    // G2 — inject a halt-and-report notice (delivered on the session's next turn).
    // #3124: stamp a programmatic origin so this server-injected notice bypasses
    // UserPromptSubmit-class message hooks (was defaulting to "webapp").
    void this.messageService
      .sendMessage(sessionId, {
        text: MODEL_DOWNGRADE_NOTICE,
        sentFrom: "system-notice",
      })
      .catch((err: unknown) => {
        this.errorLogger?.warn(
          `Failed to inject downgrade notice into session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          { category: "model-downgrade", sessionId }
        );
      });

    // G3 — out-of-band escalation (issue #1883). Fires under the same
    // `downgradeNotified` dedupe (marked above), so exactly once per session per
    // process; R12's restart-survivable cooldown guards re-escalation across
    // restarts. Additive — G1 + G2 above are unchanged (R3, Fallback Preservation).
    this.escalateSessionFatalCondition(sessionId, "model-downgrade");
    // Phase 2 (issue #1883) — config-gated auto-abort, DEFAULT OFF (R7). No-op
    // unless BOTH the env switch and the settings flag are on.
    this.maybeAutoAbortOnSessionFatal(sessionId, "model-downgrade");
  }

  /**
   * Issue #1883 (G3, R1/R5/R6/R10) — escalate a session-fatal condition to the
   * user OUT-OF-BAND, independent of the impaired session's own message relay.
   * No-ops silently when no notifier is wired (G1+G2 already cover — Fallback
   * Preservation Rule). Never throws into the sync loop (R4 fail-open).
   */
  private escalateSessionFatalCondition(
    sessionId: string,
    reason: SessionFatalReason
  ): void {
    if (!this.notifier) return; // G3 not wired → G1+G2 cover.
    const session = this.sessionCache.getSession(sessionId);
    if (!session) return;
    // R12 — suppress if we escalated this (session, reason) within the cooldown
    // window (persisted in error_logs, survives restart).
    if (this.sessionFatalEscalationOnCooldown(sessionId, reason)) return;

    const { subject, body } = buildEscalationPayload(session, reason);
    void this.notifier
      .notify(subject, body)
      .then(result => {
        // R12 anchor + audit: persist regardless of delivery so a repeated
        // failure on a crash loop still cools down (pager-spam guard).
        this.recordSessionFatalEscalation(sessionId, reason, result.delivered);
        if (!result.delivered) {
          // R4 — all notify-pm tiers failed / script absent → error_logs, continue.
          this.errorLogger?.warn(
            `G3 session-fatal escalation not delivered for session ${sessionId} (${reason}) — notify-pm reported no delivered tier.`,
            {
              category: SESSION_FATAL_ESCALATION_CATEGORY,
              sessionId,
              context: { reason, delivered: false },
            }
          );
        }
      })
      .catch((err: unknown) => {
        // R4 — a notify failure must NEVER throw into the sync loop.
        this.errorLogger?.warn(
          `G3 session-fatal escalation threw for session ${sessionId} (${reason}): ${err instanceof Error ? err.message : String(err)}`,
          {
            category: SESSION_FATAL_ESCALATION_CATEGORY,
            sessionId,
            context: { reason, delivered: false },
          }
        );
      });
  }

  /**
   * Issue #1883 (R12) — has this (session, reason) been escalated within the
   * cooldown window? Reads the persisted anchors from error_logs, so it survives
   * a server restart. Fail-open toward escalating: a store hiccup must never
   * swallow a session-fatal (returns false → escalate).
   */
  private sessionFatalEscalationOnCooldown(
    sessionId: string,
    reason: SessionFatalReason
  ): boolean {
    try {
      const since = Date.now() - SESSION_FATAL_ESCALATION_COOLDOWN_MS;
      const rows = this.store.errorLogs.getEntries({
        category: SESSION_FATAL_ESCALATION_CATEGORY,
        sessionId,
        startTime: since,
        limit: 10,
      });
      return rows.some(row => {
        if (!row.context) return false;
        try {
          return (
            (JSON.parse(row.context) as { reason?: string }).reason === reason
          );
        } catch {
          return false;
        }
      });
    } catch {
      return false; // fail-open: never block an escalation on a store error.
    }
  }

  /**
   * Issue #1883 (R12) — persist the cooldown anchor + audit row. Best-effort;
   * runs in the notify `.then()` (off the synchronous socket path). Never throws.
   */
  private recordSessionFatalEscalation(
    sessionId: string,
    reason: SessionFatalReason,
    delivered: boolean
  ): void {
    try {
      this.store.errorLogs.createEntry({
        severity: "info",
        category: SESSION_FATAL_ESCALATION_CATEGORY,
        source: "server",
        message: `G3 session-fatal escalation for session ${sessionId} (${reason}) — delivered=${delivered}.`,
        sessionId,
        context: JSON.stringify({ reason, delivered, event: "escalation" }),
      });
    } catch {
      // Best-effort cooldown anchor + audit; never throw into the sync loop.
    }
  }

  /**
   * Issue #1883 (Phase 2, R7/R8/R9) — config-gated auto-abort with four
   * structural guards; fail-safe is NO abort. DEFAULT OFF: the Phase-1 escalation
   * notifies the user, who decides whether to pause/abort.
   */
  private maybeAutoAbortOnSessionFatal(
    sessionId: string,
    reason: SessionFatalReason
  ): void {
    // Guard 1 — dual gate, default OFF. The env switch is `=== "1"` (NOT `!== "0"`),
    // inverted to default-OFF; the settings flag must ALSO be on (R7/R8).
    if (process.env.HAPI_SESSION_FATAL_ABORT_ENABLED !== "1") return;
    if (!this.sessionFatalAutoAbortEnabled) return;
    // Guard 4 (dedupe, cheap check) — already aborted? skip. The mark itself
    // happens BELOW, right before the abort RPC.
    if (this.abortedSessions.has(sessionId)) return;
    // Guard 2 (same-session binding) — only the exact sessionId the detector
    // fired; never iterate sessions. Guard 3 (abort-time predicate re-check,
    // load-bearing) — a session that recovered between detection and abort is
    // NOT aborted. Only "model-downgrade" is wired; the predicate is the exported
    // pure `isSessionModelDowngraded`.
    const session = this.sessionCache.getSession(sessionId);
    if (
      reason === "model-downgrade" &&
      (!session || !isSessionModelDowngraded(session))
    ) {
      return;
    }
    // Mark BEFORE the abort RPC (mirror checkModelDowngrade's "mark before side
    // effects" order) so a throw cannot re-abort.
    this.abortedSessions.add(sessionId);
    // `abortSession` is a turn-interrupt (rpcGateway "abort" RPC), NOT a kill —
    // "stop the burning turn". It throws when no socket is registered, hence the
    // mandatory `.catch()` (fail-open; R9 tolerates a throwing abort RPC).
    void this.abortSession(sessionId).catch((err: unknown) => {
      this.errorLogger?.warn(
        `Phase 2 auto-abort failed for session ${sessionId} (${reason}): ${err instanceof Error ? err.message : String(err)}`,
        {
          category: SESSION_FATAL_ESCALATION_CATEGORY,
          sessionId,
          context: { reason, phase: "auto-abort" },
        }
      );
    });
  }

  /** Issue #1905: refresh the in-memory ceiling-guard config (startup + each
   *  `PUT /preferences/ceiling-guard`). Read synchronously by the turn-finalize
   *  check, so it must never require disk I/O on the hot path. */
  setCeilingGuardConfig(config: CeilingGuardConfig): void {
    this.ceilingGuardConfig = config;
  }

  /** Issue #1905: inject the G2 in-app surfacing dep (the web push service) for a
   *  ceiling breach. Called once post-construction (built alongside the engine in
   *  index.ts). An absent key leaves the current dep unchanged. The G3 out-of-band
   *  notice uses the shared #1883 `Notifier` ({@link setNotifier}). */
  setCeilingGuardDeps(deps: {
    pushService?: Pick<PushService, "sendToNamespace"> | null;
  }): void {
    if (deps.pushService !== undefined) {
      this.ceilingGuardPushService = deps.pushService;
    }
  }

  /**
   * Issue #1905: the runaway-session ceiling guard — the direct sibling of
   * {@link checkModelDowngrade}. Fired at the turn-finalize seam via the
   * `ceilingGuardStep` FinalizeStep (PUBLIC because the step invokes it from
   * outside the class). Meters cumulative facts from the existing #1662
   * `v_session_totals` view (no new telemetry, R8), compares to the effective
   * ceilings (a per-session override takes precedence over the global config,
   * R7), and on breach — ONCE per session (R4) — records the anomaly (G1),
   * surfaces an out-of-band notice (G2, Path B), and hard-stops the session (G3).
   *
   * FULLY FAIL-OPEN (R9): the whole body is wrapped so a config/query/escalation/
   * kill fault can NEVER block, stall, or crash a session (the step wraps it too,
   * belt-and-braces). Lag semantics (K4 / 1905-9): the check runs before
   * `enqueueFinalizeTurn`, so uncached tokens reflect turns through N−1 (matching
   * the AC's "hard-stopped at the NEXT turn boundary"); `turn_count` has NO lag
   * (its row is inserted at turn:open).
   */
  checkSessionCeilings(sessionId: string): void {
    try {
      if (this.ceilingBreached.has(sessionId)) return; // R4 dedupe

      const config = this.ceilingGuardConfig;
      if (!config.enabled) return;

      const totals = this.store.turns.getSessionTotals(sessionId);
      if (!totals) return; // no turns yet → nothing to meter

      const session = this.sessionCache.getSession(sessionId);
      // R7: a per-session override takes precedence over the global config,
      // merged field-by-field (an omitted override field falls back to global;
      // `!== undefined` so an explicit `null` disables that dimension).
      const override = session?.metadata?.ceilingOverride;
      const ceilTok =
        override?.uncachedTokenCeiling !== undefined
          ? override.uncachedTokenCeiling
          : config.uncachedTokenCeiling;
      const ceilIter =
        override?.iterationCeiling !== undefined
          ? override.iterationCeiling
          : config.iterationCeiling;
      const ceilCost =
        override?.costUsdCeiling !== undefined
          ? override.costUsdCeiling
          : config.costUsdCeiling;
      const hardStop =
        override?.hardStop !== undefined ? override.hardStop : config.hardStop;

      // R1: uncached = non-cache input + output ONLY. Cache reads/writes are NOT
      // spend-equivalent and are DELIBERATELY excluded (the R5 no-false-positive
      // property). R2: iterations = turn_count. R8: read-only, no new telemetry.
      const uncached = (totals.totalTokIn ?? 0) + (totals.totalTokOut ?? 0);
      const iterations = totals.turnCount;
      const cost = totals.totalCost;

      const tokenBreach = ceilTok != null && uncached >= ceilTok;
      const iterBreach = ceilIter != null && iterations >= ceilIter;
      // OR-5: a null `total_cost` (subscription/PTY billing, or no rate card) is
      // never a breach — never a false positive from missing cost data.
      const costBreach = ceilCost != null && cost != null && cost >= ceilCost;

      if (!tokenBreach && !iterBreach && !costBreach) return;

      // Mark BEFORE side effects (mirror `downgradeNotified`) so a throwing side
      // effect below cannot cause a re-notify / re-archive loop (R4).
      this.ceilingBreached.add(sessionId);

      const dimension = tokenBreach
        ? "tokens"
        : iterBreach
          ? "iterations"
          : "cost";
      const value = tokenBreach ? uncached : iterBreach ? iterations : cost;
      const ceiling = tokenBreach ? ceilTok : iterBreach ? ceilIter : ceilCost;

      // G1 — record the anomaly once in error_logs (category "ceiling-breach").
      this.errorLogger?.warn(
        `Ceiling guard: session ${sessionId} crossed its ${dimension} ceiling ` +
          `(${value}/${ceiling}) — hard-stopping (issue #1905).`,
        {
          category: "ceiling-breach",
          sessionId,
          context: {
            dimension,
            uncached,
            iterations,
            cost,
            ceilTok,
            ceilIter,
            ceilCost,
            hardStop,
          },
        }
      );

      // G2 — out-of-band surfacing (Path B; #1883 not yet landed). Independent of
      // the impaired session (R3). TODO(#1883): re-wire to
      // escalateSessionFatalCondition (a `reason` discriminator) when it lands.
      this.surfaceCeilingBreach(
        session ?? null,
        sessionId,
        dimension,
        value,
        ceiling
      );

      // G3 — terminal hard-stop (K3, 1905-1): reap window B so the tmux-launcher
      // `claude` in `hapimatic-remote` stops burning tokens. `preserveForReconnect`
      // is DELIBERATELY OMITTED so a ceiling-stopped session is NOT resurrectable
      // via the zombie-reconnect path (X-4) — this mirrors the watchdog terminal
      // force-kill (syncEngine ~:441), NOT the manual UI archive (which passes
      // both flags). Fail-open `.catch()` (archiveSession async-throws on no-socket).
      if (hardStop) {
        void this.archiveSession(sessionId, { reapRemoteWindow: true }).catch(
          err =>
            this.errorLogger?.warn(
              `Ceiling guard: archiveSession failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
              { category: "ceiling-breach", sessionId }
            )
        );
      }
    } catch (err) {
      // R9 fail-open: a guard fault must never disturb the session path.
      this.errorLogger?.warn(
        `Ceiling guard check failed for ${sessionId} (degraded): ${err instanceof Error ? err.message : String(err)}`,
        { category: "ceiling-breach", sessionId }
      );
    }
  }

  /**
   * Issue #1905: surface a ceiling breach — G2 a web push to the session's
   * namespace (the StallWatchdog precedent) PLUS G3 an out-of-band operator page
   * through the shared #1883 `Notifier` (the notify-pm cascade). Both fail-open.
   */
  private surfaceCeilingBreach(
    session: Session | null,
    sessionId: string,
    dimension: string,
    value: number | null,
    ceiling: number | null
  ): void {
    const name = session?.metadata?.name ?? sessionId.slice(0, 8);
    const ns = session?.namespace ?? "default";
    const emoji = session?.emoji ? `${session.emoji} ` : "";
    const body =
      `${name} crossed its ${dimension} ceiling (${value}/${ceiling}) and was ` +
      `hard-stopped by the runaway guard.`;

    void this.ceilingGuardPushService
      ?.sendToNamespace(ns, {
        title: `${emoji}Runaway guard: session hard-stopped`,
        body,
        tag: `ceiling-${sessionId}`,
        data: {
          type: "ceiling-breach",
          sessionId,
          url: `/sessions/${sessionId}`,
        },
      })
      .catch(err =>
        this.errorLogger?.warn(
          `Ceiling guard: push surfacing failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          { category: "ceiling-breach", sessionId }
        )
      );

    // G3 — the out-of-band operator page routes through the shared #1883
    // `Notifier` (setNotifier), so the ceiling guard adds NO second notify-pm
    // surface. The Notifier is fail-open (never rejects — R4) and no-ops when
    // unset (G1+G2 still cover); the `.catch` is belt-and-braces.
    void this.notifier
      ?.notify("Runaway guard: session hard-stopped", body)
      .catch(err =>
        this.errorLogger?.warn(
          `Ceiling guard: notifier escalation failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          { category: "ceiling-breach", sessionId }
        )
      );
  }

  handleSessionEnd(payload: {
    sid: string;
    time: number;
    archived?: boolean;
    /**
     * Issue #2453 (Task 7): true when this end is the respawn archive's own end
     * (switchAccount / tokenRefreshRestart / config or model-mode restart /
     * relaunchSession / heartbeat rotation). Terminal ends (default, incl. an
     * unexpected death that reaches here WITHOUT archiveSession) auto-pause the
     * session's loops; respawns must not.
     *
     * #3478: a respawn produces a SECOND end — the dying CLI's own
     * `session-end`, which carries no flag and usually arrives first. The
     * respawn archive marks the session before its kill, and the first
     * unflagged, non-archive end consumes that mark and is treated as part of
     * the respawn (the respawned process's first heartbeat drops a mark no end
     * consumed). A respawn that never comes back — and heartbeat rotation, whose
     * old id never returns — is paused by the 30 s CLI-disconnect grace archive;
     * any loop paused anyway (a driver that sets no mark) is resumed by the
     * inactive→active edge in `handleSessionAlive`.
     */
    respawn?: boolean;
  }): void {
    // #3478: resolve the respawn decision once, for every consumer below. An
    // archive end never consumes a mark — only the dying CLI's own end does.
    const respawn =
      payload.respawn === true ||
      (!payload.archived && this.respawnMarks.consume(payload.sid));
    const endingAgents = this.runningBackgroundAgents(payload.sid);
    this.sessionCache.handleSessionEnd(payload);
    this.recordAgentsOfEndedSession(payload.sid, endingAgents);
    // #1968 (R2): auto-release this session's file claims. Covers end + archive
    // (archiveSession funnels through handleSessionEnd). Idempotent.
    // #2088: best-effort — a DB error releasing advisory claims must never break
    // core session teardown. The 60s reaper is the backstop.
    let releasedClaims = 0;
    try {
      releasedClaims = this.store.fileClaims.releaseClaimsBySession(
        payload.sid
      );
    } catch (err) {
      this.errorLogger?.warn(
        `Failed to release file claims on session end for ${payload.sid}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { category: "sync", sessionId: payload.sid }
      );
    }
    // #1969 (R1): ONLY when this end actually released claims does the live
    // snapshot change → publish a delta so peers converge (release-wins). The
    // common no-claims session end changes nothing, so it emits nothing (avoids
    // a needless snapshot on every teardown). Best-effort (#2088) — an emit
    // failure must never break session teardown; the 15 s poll is the backstop.
    if (releasedClaims > 0) {
      try {
        this.emitFileClaimDelta();
      } catch (err) {
        this.errorLogger?.warn(
          `Failed to emit file-claim delta on session end for ${payload.sid}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { category: "sync", sessionId: payload.sid }
        );
      }
    }
    // #2453 (Task 7): auto-pause this session's bound loops on a TERMINAL end.
    // Fire-and-forget best-effort — the coupler absorbs its own failures and a
    // slow loop-cron.sh pause must never block session teardown.
    void this.loopCronCoupler?.onSessionEnd(payload.sid, respawn);
    // #3839: re-index this session's transcript for the transcript browser.
    // Fire-and-forget; a no-op until the indexer has started.
    notifyTranscriptSessionEnded(
      this.getSession(payload.sid)?.metadata?.claudeSessionId
    );
  }

  /**
   * Issue #3839: the node's default ("active") account, or null when unset or
   * the account service is not wired. A transcript resumed as a NEW session
   * binds this account explicitly — resume spawns are exempt from the daemon's
   * un-pinned account resolution (#3023), so without it they would silently
   * fall through to the host credential. Mirrors the create-session form,
   * which pre-selects the node default.
   */
  getNodeActiveAccountUuid(): string | null {
    return this.accountService?.getActiveAccount?.()?.accountUuid ?? null;
  }

  /**
   * Issue #3839 (D28): restore a soft-deleted worktree on `machineId` to its
   * original recorded path (the `recover-worktree` machine RPC). Thin facade —
   * the route layer holds a SyncEngine, not the private RpcGateway.
   */
  recoverWorktree(
    machineId: string,
    originalPath: string
  ): Promise<RecoverWorktreeRpcResult> {
    return this.rpcGateway.recoverWorktree(machineId, originalPath);
  }

  /**
   * #1443: expose orphan state so route-layer delete gates can bypass the
   * active-check. Routes hold a SyncEngine (not a SessionCache) and the
   * orphan flag lives only in SessionCache.orphanedSessions (not on the wire
   * Session object), so a thin delegator is the minimal exposure.
   */
  isSessionOrphaned(sessionId: string): boolean {
    return this.sessionCache.isOrphaned(sessionId);
  }

  handleMachineAlive(payload: { machineId: string; time: number }): void {
    this.machineCache.handleMachineAlive(payload);
  }

  private expireInactive(): void {
    const running = new Map<string, BackgroundAgentEntry[]>();
    for (const session of this.sessionCache.getSessions()) {
      const agents = this.runningBackgroundAgents(session.id);
      if (agents.length > 0) running.set(session.id, agents);
    }
    this.sessionCache.expireInactive();
    for (const [sessionId, agents] of running) {
      this.recordAgentsOfEndedSession(sessionId, agents);
    }
    this.machineCache.expireInactive();
  }

  /**
   * #1968 (R5): release file claims owned by sessions no longer live. The
   * live-set uses BOTH id and tag because a claim's sessionId is client-supplied
   * and may be either. Crashed sessions are flipped inactive by expireInactive
   * (5s tick) → excluded from getActiveSessions() → their claims reaped here.
   */
  private reapOrphanedFileClaims(): void {
    // #2088: a transient bun:sqlite throw here (SQLITE_BUSY / I/O) would
    // otherwise propagate uncaught out of the 60s reaper setInterval — the
    // server process installs no uncaughtException handler, so it would crash
    // with no error_logs trail. Catch, log, and surface via the job registry
    // so a transient DB error leaves the interval (and the server) alive; stale
    // claims in an advisory monitor are cosmetic. Mirrors the try/catch-and-log
    // pattern of the sibling SyncEngine timers (e.g. checkMidnightReset).
    try {
      const released = reapOrphanedClaims(
        this.store.fileClaims,
        liveSessionIdSet(this.getActiveSessions())
      );
      // #1969 (R1/R6): the reaper released a crashed session's orphan claims →
      // the live snapshot changed, so publish a delta to drop the phantom on
      // peers. Gated on `released > 0` so a no-op 60 s tick emits nothing (the
      // anti-entropy poll already re-reconciles idle state).
      if (released > 0) this.emitFileClaimDelta();
    } catch (err) {
      this.errorLogger?.error(`Orphan file-claim reaper tick failed`, {
        category: "sync",
        context: { error: err instanceof Error ? err.message : String(err) },
      });
      this.jobRegistry?.update("sync-file-claim-reaper", {
        status: "stalled",
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private reloadAll(): void {
    this.sessionCache.reloadAll();
    // Force all machines inactive on startup — they become active only
    // when a fresh machine-alive heartbeat arrives from the daemon.
    this.machineCache.reloadAll(true);
  }

  getOrCreateSession(
    tag: string,
    metadata: unknown,
    agentState: unknown,
    namespace: string
  ): Session {
    return this.sessionCache.getOrCreateSession(
      tag,
      metadata,
      agentState,
      namespace
    );
  }

  getOrCreateMachine(
    id: string,
    metadata: unknown,
    daemonState: unknown,
    namespace: string
  ): Machine {
    return this.machineCache.getOrCreateMachine(
      id,
      metadata,
      daemonState,
      namespace
    );
  }

  async sendMessage(
    sessionId: string,
    payload: {
      text: string;
      localId?: string | null;
      // Programmatic-sender signal (#1234) using the canonical sentFrom
      // taxonomy (#2205, `./sentFrom`) so the AutoRecoveryService R3 predicate
      // can distinguish ALL programmatic senders (auto-recovery / watchdog /
      // heartbeat) from real user input.
      sentFrom?: SentFrom;
      // #3331: origin-class provenance (R2, ruling D6(a)) — passed straight
      // through to MessageService.sendMessage, which stamps it into
      // content.meta.origin and forwards it to the message-hook stage.
      origin?: MessageOrigin;
    }
  ): Promise<SendMessageResult> {
    // #3124: forward the delivery result (a gate-class message hook can deny —
    // typed result, never a throw). Void-style callers ignore the return; the
    // web route + queue-drain paths inspect `delivered` to surface/handle a deny.
    return this.messageService.sendMessage(sessionId, payload);
  }

  // ── Issue #1325: server-backed message queue ──────────────────────
  // Queue methods live directly on SyncEngine (not SessionCache) because
  // the queue is a peer collection to sessions — it has its own store
  // and doesn't touch in-memory Session objects. Each mutator emits a
  // `queue-changed` SyncEvent so all connected clients refetch.

  enqueueQueuedMessage(args: {
    sessionId: string;
    namespace: string;
    body: string;
    clientGeneratedId?: string | null;
    // Issue #3235: distinguishes a genuine user enqueue (default) from the
    // #1362 send-failure re-enqueue. QueueDrainObserver level-triggers a drain
    // ONLY on reason "enqueue" — a "requeue" MUST NOT re-drain, else a failing
    // send would spin (drain → fail → requeue → drain → …).
    reason?: "enqueue" | "requeue";
  }): QueuedMessageEnqueueResult {
    const result = this.store.queuedMessages.enqueue(args);
    this.eventPublisher.emit({
      type: "queue-changed",
      sessionId: args.sessionId,
      namespace: args.namespace,
      reason: args.reason ?? "enqueue",
    });
    return result;
  }

  listQueuedMessages(
    sessionId: string,
    namespace: string
  ): StoredQueuedMessage[] {
    return this.store.queuedMessages.list(sessionId, namespace);
  }

  updateQueuedMessageAt(
    sessionId: string,
    namespace: string,
    position: number,
    body: string
  ): StoredQueuedMessage | null {
    const row = this.store.queuedMessages.updateAt(
      sessionId,
      namespace,
      position,
      body
    );
    if (row) {
      this.eventPublisher.emit({
        type: "queue-changed",
        sessionId,
        namespace,
        reason: "edit", // Issue #3235: an edit MUST NOT trigger a drain.
      });
    }
    return row;
  }

  removeQueuedMessageAt(
    sessionId: string,
    namespace: string,
    position: number
  ): boolean {
    const removed = this.store.queuedMessages.removeAt(
      sessionId,
      namespace,
      position
    );
    if (removed) {
      this.eventPublisher.emit({
        type: "queue-changed",
        sessionId,
        namespace,
        reason: "remove", // Issue #3235: a removal MUST NOT trigger a drain.
      });
    }
    return removed;
  }

  clearQueuedMessages(sessionId: string, namespace: string): number {
    const count = this.store.queuedMessages.clear(sessionId, namespace);
    if (count > 0) {
      this.eventPublisher.emit({
        type: "queue-changed",
        sessionId,
        namespace,
        reason: "remove", // Issue #3235: a bulk clear is a removal — no drain.
      });
    }
    return count;
  }

  /**
   * Drain primitive used by QueueDrainObserver (Task 7). Atomically removes
   * the head of the queue and returns it. Namespace is not needed — popHead
   * is keyed by session only (the observer doesn't have a namespace context;
   * the row carries its own namespace for downstream namespace-aware writes).
   *
   * Emits `queue-changed` after a successful pop so clients see the queue
   * shrink even though the dispatch happens server-side.
   */
  popHeadQueuedMessage(sessionId: string): StoredQueuedMessage | null {
    const row = this.store.queuedMessages.popHead(sessionId);
    if (row) {
      this.eventPublisher.emit({
        type: "queue-changed",
        sessionId,
        namespace: row.namespace,
        // Issue #3235: the pop-echo MUST NOT re-drain. The observer's own
        // drainOnce pops the head, and level-triggering on that echo would
        // double-dispatch; reason "pop" (≠ "enqueue") suppresses it.
        reason: "pop",
      });
    }
    return row;
  }

  /**
   * Manual drain primitive (Task 17 — Send Queue button).
   *
   * Atomically pops the head of the queue and dispatches it via
   * `messageService.sendMessage` with `localId = row.id` for idempotency
   * (R3 — MessageStore dedups on `(session_id, local_id)`). Matches the
   * QueueDrainObserver's drainOnce path exactly, just user-initiated
   * rather than transition-driven.
   *
   * Returns `{sent: boolean, remaining: number}` — `sent=false` when the
   * queue was empty at pop time.
   */
  async drainQueueHead(
    sessionId: string,
    namespace: string
  ): Promise<{ sent: boolean; remaining: number }> {
    const row = this.popHeadQueuedMessage(sessionId);
    if (!row) {
      return { sent: false, remaining: 0 };
    }
    try {
      // #3331 (Task 12b): a queued send carries NO origin (the route-side origin
      // derivation is bypassed), so a queued USER-APPROVAL token is denied
      // `provenance-rejected` by the token gate and DROPPED below — never a
      // silent grant with an empty identity; the user re-approves live. Both
      // drain sites (here + queueDrainObserver.drainOnce) behave identically.
      const result = await this.sendMessage(sessionId, {
        text: row.body,
        localId: row.id,
        sentFrom: "webapp",
      });
      // #3124: a gate-class message hook DENIED this queued message. A denial is
      // NOT a send failure — the row was already popped, so DROP it (do NOT
      // re-enqueue: re-enqueue → drain → deny would loop forever) and do NOT
      // throw (a throw hits the #1362 catch below and re-enqueues). The user-
      // visible prompt-blocked toast already fired from MessageService.
      if (result.delivered === false) {
        const remaining = this.store.queuedMessages.list(
          sessionId,
          namespace
        ).length;
        return { sent: false, remaining };
      }
    } catch (err) {
      // Issue #1362: preserve the message body on send failure. popHead
      // already DELETEd the original row, so re-enqueue with the original
      // clientGeneratedId is safe (the partial unique-index slot was
      // freed) and preserves end-to-end client idempotency.
      try {
        this.enqueueQueuedMessage({
          sessionId,
          namespace: row.namespace,
          body: row.body,
          clientGeneratedId: row.clientGeneratedId,
          reason: "requeue", // Issue #3235: a re-enqueue MUST NOT re-drain.
        });
        const origMsg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Send failed — message preserved at end of queue: ${origMsg}`
        );
      } catch (reEnqErr) {
        // Distinguish the inner Error we just constructed (preservation
        // succeeded) from a genuine enqueue failure (data lost).
        if (
          reEnqErr instanceof Error &&
          reEnqErr.message.startsWith(
            "Send failed — message preserved at end of queue:"
          )
        ) {
          throw reEnqErr;
        }
        const origMsg = err instanceof Error ? err.message : String(err);
        const reEnqMsg =
          reEnqErr instanceof Error ? reEnqErr.message : String(reEnqErr);
        throw new Error(
          `Send failed AND re-enqueue failed (data lost) — original: ${origMsg}; re-enqueue: ${reEnqMsg}`
        );
      }
    }
    // Compute remaining after the pop. popHead already emitted a
    // queue-changed event, so clients will refetch — this count is
    // returned for the immediate caller's UX (e.g. toast message).
    const remaining = this.store.queuedMessages.list(
      sessionId,
      namespace
    ).length;
    return { sent: true, remaining };
  }

  async approvePermission(
    sessionId: string,
    requestId: string,
    mode?: PermissionMode,
    allowTools?: string[],
    decision?: "approved" | "approved_for_session" | "denied" | "abort",
    answers?: Record<string, string[]>
  ): Promise<void> {
    await this.rpcGateway.approvePermission(
      sessionId,
      requestId,
      mode,
      allowTools,
      decision,
      answers
    );
  }

  async denyPermission(
    sessionId: string,
    requestId: string,
    decision?: "approved" | "approved_for_session" | "denied" | "abort"
  ): Promise<void> {
    await this.rpcGateway.denyPermission(sessionId, requestId, decision);
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.rpcGateway.abortSession(sessionId);
  }

  /**
   * Archive a session: clean kill (disconnect the Claude process, keep the
   * tmux window for reconnect). Issue #2080: delegated to SessionLifecycleOps.
   */
  async archiveSession(
    sessionId: string,
    opts?: {
      reapRemoteWindow?: boolean;
      isRespawn?: boolean;
      /** #2683: deliberate archive-for-reconnect of a LIVE session — tag window A. */
      preserveForReconnect?: boolean;
    }
  ): Promise<void> {
    return this.sessionLifecycleOps.archiveSession(sessionId, opts);
  }

  async switchSession(
    sessionId: string,
    to: "remote" | "local"
  ): Promise<void> {
    await this.rpcGateway.switchSession(sessionId, to);
  }

  async mcpToggle(
    sessionId: string,
    serverName: string,
    enabled: boolean
  ): Promise<McpToggleResponse> {
    return await this.rpcGateway.mcpToggle(sessionId, serverName, enabled);
  }

  // Issue #2256: delegate set-model to the rpcGateway (mirrors mcpToggle). The
  // gateway RPCs the landed #2421 runClaude "set-model" handler with {modelMode}.
  async setModel(
    sessionId: string,
    modelMode: string
  ): Promise<SetModelResponse> {
    return await this.rpcGateway.setModel(sessionId, modelMode);
  }

  // Issue #2346: delegate set-permission-mode to the rpcGateway (mirrors mcpToggle).
  async setPermissionMode(
    sessionId: string,
    mode: string
  ): Promise<SetPermissionModeResponse> {
    return await this.rpcGateway.setPermissionMode(sessionId, mode);
  }

  /**
   * Read the per-project `disabledMcpServers` list from ~/.claude.json
   * (exact-match on `projects[projectDir]`, #1180). Thin delegator to
   * McpConfigStore, retained on the facade for the #1180 contract test and
   * any private-method consumer. Behavior lives in `mcpConfigStore.ts`
   * (issue #2080).
   */
  private readDisabledServersFromConfig(projectDir: string): string[] {
    return this.mcpConfigStore.readDisabledServersFromConfig(projectDir);
  }

  /**
   * Server-side batch entry point (issue #989 follow-up). Replaces the
   * client-side for-loop which paused when iOS suspended the PWA tab.
   * Merges `partialDesired` into the per-session desired state and
   * (re)starts the worker if there is now work to do.
   */
  setMcpDesired(
    sessionId: string,
    partialDesired: Record<string, boolean>
  ): McpBatchSnapshot {
    // Round 11 (epic #3285, 2026-09-07): a DISCONNECTED session STAGES the
    // desired map on metadata.stagedMcpDesired instead of handing it to the
    // coordinator (whose worker needs a live CLI and a known MCP state).
    // updateMcpStatus replays the stage the moment the reconnected session's
    // MCP state is reported. The returned snapshot is an idle one — nothing is
    // pending until the session is back.
    const session = this.sessionCache.getSession(sessionId);
    if (session && !session.active) {
      const merged = {
        ...(session.metadata?.stagedMcpDesired ?? {}),
        ...partialDesired,
      };
      void this.sessionCache.updateSessionMetadataFields(sessionId, m => ({
        ...m,
        stagedMcpDesired: { ...(m.stagedMcpDesired ?? {}), ...partialDesired },
      }));
      return {
        sessionId,
        desired: merged,
        done: {},
        pending: [],
        processing: null,
        total: 0,
        remaining: 0,
        startedAt: Date.now(),
        isActive: false,
      };
    }
    return this.mcpBatchCoordinator.setDesired(sessionId, partialDesired);
  }

  /**
   * Round 11 (epic #3285): replay MCP changes SAVED while a session was
   * disconnected. Fired from updateMcpStatus — the first point after a
   * reconnect where the coordinator can compute desired-vs-current for the
   * session's project (its worker skips names whose current state is
   * unknown, so an earlier kick would silently do nothing). Consumes the
   * stage first; a clobbered clear (the CLI's own metadata stamps rebuild the
   * blob from its cached copy) only re-applies an idempotent desired map on a
   * later reconnect — the coordinator toggles nothing that already matches.
   */
  private replayStagedMcpDesired(projectDir: string | undefined): void {
    for (const session of this.sessionCache.getActiveSessions()) {
      const staged = session.metadata?.stagedMcpDesired;
      if (!staged || Object.keys(staged).length === 0) continue;
      if (projectDir !== undefined && session.metadata?.path !== projectDir) {
        continue;
      }
      void this.sessionCache.updateSessionMetadataFields(session.id, m => {
        const next = { ...m };
        delete next.stagedMcpDesired;
        return next;
      });
      try {
        this.mcpBatchCoordinator.setDesired(session.id, staged);
      } catch (err) {
        this.errorLogger?.warn(
          `Failed to replay the staged MCP configuration for session ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
          { category: "sync", sessionId: session.id }
        );
      }
    }
  }

  /** Returns the current batch snapshot for a session, or null if no batch ever started. */
  getMcpBatchState(sessionId: string): McpBatchSnapshot | null {
    return this.mcpBatchCoordinator.getSnapshot(sessionId);
  }

  /**
   * Session token stats — issue #1671 (epic #1662, Sub I). Returns the
   * server-authoritative `v_session_totals` aggregate plus the per-turn token
   * breakdown for the session, keyed by the session's TAG (== hapi_session_id,
   * the operational key the turn write service uses). Read-only SELECT over a
   * view; never on the prompt/reply path. An unknown session, or one with no
   * tag/turns yet, yields `{ totals: null, turns: [] }`.
   */
  getSessionTokenStats(sessionId: string): SessionTokenStatsResponse {
    const session = this.getSession(sessionId);
    if (!session) {
      return { totals: null, turns: [] };
    }
    // The turn write service keys turns by `event.sid` — the session's canonical
    // `id` (turnLifecycle.openTurn → hapiSessionId: event.sid), NOT its `tag`.
    // (Verified live: a finalized turn's hapi_session_id == session.id.)
    const key = session.id;
    // #4385: the background-agent breakout comes from the SAME rows the view
    // folds into `totals`, so the "+Y from N" figure and the total never
    // disagree. Absent (not null) when the session has none — an older client
    // and the federation proxy see the pre-#4385 shape unchanged.
    // Fail-open: the block is optional, so a read error degrades to its absence
    // rather than failing the whole token-stats response.
    let backgroundAgentUsage: ReturnType<
      typeof this.store.backgroundAgentUsage.getSessionBreakdown
    > = null;
    try {
      backgroundAgentUsage =
        this.store.backgroundAgentUsage.getSessionBreakdown(key);
    } catch {
      backgroundAgentUsage = null;
    }
    return {
      totals: this.store.turns.getSessionTotals(key),
      turns: this.store.turns.getTurnBreakdown(key),
      ...(backgroundAgentUsage ? { backgroundAgentUsage } : {}),
    };
  }

  /**
   * Session workflow-state — issue #1672 (epic #1662, Sub J). Returns the net
   * checkpoint badge for the session's linked issue (from `v_workflow_state`)
   * plus the per-turn resolved label events for the per-turn chip. Keyed by the
   * session's canonical `id` (same key as token-stats — the turn write service's
   * `hapi_session_id`). Best-effort / fail-open (R7): an unknown session, one
   * with no linked issue, or any read error yields `{ badge: null, turns: [] }`.
   */
  getSessionWorkflowState(sessionId: string): SessionWorkflowStateResponse {
    try {
      const session = this.getSession(sessionId);
      if (!session) {
        return { badge: null, turns: [] };
      }
      const key = session.id;
      const issueNumber = session.linkedIssue?.number ?? null;
      return {
        badge:
          issueNumber !== null
            ? this.store.turns.getWorkflowBadge(key, issueNumber)
            : null,
        turns: this.store.turns.getTurnWorkflowBreakdown(key),
      };
    } catch {
      return { badge: null, turns: [] };
    }
  }

  /**
   * Issue #1804: badge-only slice of getSessionWorkflowState — the resolved
   * `v_workflow_state` badge for a session's linked issue, WITHOUT the per-turn
   * breakdown (the session-summary projection needs only the badge, so we skip
   * the extra getTurnWorkflowBreakdown read). Consumed by the `/api/sessions`
   * list projection AND the federation all-sessions projection so the Row-1
   * state badge (#1804 A2) rides the SessionSummary through the existing list /
   * SSE / federation flow. Returns null when the session has no linked issue or
   * no workflow-state row yet. Read-only; fail-soft to null.
   */
  getSessionWorkflowBadge(sessionId: string): SessionWorkflowBadge | null {
    try {
      const session = this.getSession(sessionId);
      if (!session) return null;
      const issueNumber = session.linkedIssue?.number ?? null;
      return issueNumber !== null
        ? this.store.turns.getWorkflowBadge(session.id, issueNumber)
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Node-global session-totals aggregate for the federation read path (issue
   * #1674, epic #1662 Sub L). Thin wrapper over the turnStore reader — read-only
   * SELECT over `v_session_totals`, never on the prompt/reply path. The
   * federation telemetry routes (local read + peer receiver) call this.
   */
  getSessionTotalsAggregate(opts?: {
    fromMs?: number;
    toMs?: number;
    limit?: number;
  }): SessionTokenTotals[] {
    return this.store.turns.getAllSessionTotals(opts);
  }

  /**
   * Assemble a turn-ledger mirror feed page for the #4614 receiver — this node's
   * FINALIZED turns + adjustments changed since the caller's cursors, plus the
   * ledger incarnation and high-water marks (the puller's lag + rewind-resync
   * inputs). Thin read-only wrapper over the TurnStore readers; never on the
   * prompt/reply path. `nextCursor` is the last returned row's change_seq (rows
   * are change_seq-ASC), so the puller resumes at `change_seq > nextCursor`.
   */
  getTurnFeedPage(opts: {
    cursor?: number;
    adjCursor?: number;
    limit?: number;
  }): TurnFeedPage {
    const cursor = opts.cursor ?? 0;
    const adjCursor = opts.adjCursor ?? 0;
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
    const turns = this.store.turns.getTurnFeedPage(cursor, limit);
    const adjustments = this.store.turns.getAdjustmentsFeedPage(
      adjCursor,
      limit
    );
    return {
      incarnation: this.store.turns.getLedgerIncarnation(),
      maxChangeSeq: this.store.turns.getMaxFinalizedChangeSeq(),
      adjMaxChangeSeq: this.store.turns.getMaxAdjustmentChangeSeq(),
      turns,
      adjustments,
      nextCursor:
        turns.length > 0 ? turns[turns.length - 1]!.changeSeq : cursor,
      adjNextCursor:
        adjustments.length > 0
          ? adjustments[adjustments.length - 1]!.changeSeq
          : adjCursor,
    };
  }

  /** Per-day digest of this node's finalized turns for the #4614 drift check (R10). */
  getTurnFeedDigest(): TurnFeedDigest {
    return {
      incarnation: this.store.turns.getLedgerIncarnation(),
      days: this.store.turns.getTurnDigest(),
    };
  }

  /** Per-origin turn-mirror sync status for the #4614 status read (R6). */
  getTurnMirrorStatus(): TurnMirrorOriginStatus[] {
    return this.store.turnMirror.getStatus();
  }

  /**
   * Node-local per-turn query for the admin session-metadata surface (issue
   * #1675, epic #1662 Sub M). Thin read-only wrapper over the turnStore reader —
   * SELECT over `turns` (+`turn_events` EXISTS for event-kind), never on the
   * prompt/reply path. The `/api/session-metadata/turns` route calls this.
   */
  querySessionMetadataTurns(
    opts?: SessionMetadataQuery
  ): SessionMetadataTurn[] {
    return this.store.turns.queryTurns(opts);
  }

  /**
   * Distinct filter values for the admin session-metadata filter dropdowns
   * (issue #1675). Thin read-only wrapper over the turnStore reader.
   */
  getSessionMetadataFilterOptions(): SessionMetadataFilterOptions {
    return this.store.turns.getTurnFilterOptions();
  }

  // ── PM spawn-roster (issue #1936) ──────────────────────────────────────────
  // Thin read/write wrappers over PmRosterStore for the /api/session-metadata/
  // spawn-roster routes + the federation aggregate receiver. No SSE/Socket
  // broadcast and no NodeRegistry.updateCachedSession* call: the roster is
  // queryable operational metadata, NOT a session-summary field that clients
  // render live (so the "Federation Development Rules" cache-update contract
  // (docs/internal/architecture/federation.md),
  // which covers name/emoji/linkedIssue, does not apply here). Low-volume, off
  // the prompt/reply path.

  /** Register a spawn; idempotent on completion_token (R1). Returns the row. */
  upsertPmSpawn(input: PmSpawnRosterUpsert): PmSpawnRosterRecord {
    return this.store.pmRoster.upsertSpawn(input);
  }

  /** Enrich cc/hapi session ids on a roster row (R2). Returns rows updated
   *  (0 ⟺ unknown completion_token) so the route can return 404 (issue #1941). */
  enrichPmSpawn(input: {
    completionToken: string;
    ccSessionId?: string;
    hapiSessionId?: string;
  }): number {
    return this.store.pmRoster.enrich(input);
  }

  /** Transition a roster row's reconciliation status (R3). Returns rows updated
   *  (0 ⟺ unknown completion_token) so the route can return 404 (issue #1941). */
  setPmSpawnStatus(input: {
    completionToken: string;
    status: PmSpawnReconciliationStatus;
  }): number {
    return this.store.pmRoster.setStatus(input);
  }

  /** Node-local roster filtered by PM (+ optional status) (R4; receiver source R5). */
  queryPmSpawnRoster(
    pmSessionId: string,
    status?: PmSpawnReconciliationStatus
  ): PmSpawnRosterRecord[] {
    return this.store.pmRoster.queryByPm(pmSessionId, status);
  }

  async renameSession(
    sessionId: string,
    name: string,
    options?: { skipTmuxSync?: boolean }
  ): Promise<void> {
    // First, rename in the session cache (database)
    await this.sessionCache.renameSession(sessionId, name);

    // Then, sync the rename to the tmux window (best-effort, doesn't fail the rename)
    // This is Phase 1.3: Hapimatic → Tmux one-way sync
    // Skip tmux sync if the rename originated from tmux (to prevent infinite loops)
    if (options?.skipTmuxSync) {
      this.errorLogger?.info(
        `Skipping tmux sync for session ${sessionId} (rename came from tmux)`,
        { category: "sync", sessionId }
      );
      return;
    }

    const session = this.sessionCache.getSession(sessionId);
    const machineId = session?.metadata?.machineId;
    const sessionTag = this.sessionCache.getSessionTag(sessionId);

    if (machineId && sessionTag) {
      const result = await this.rpcGateway.renameTmuxWindow(
        machineId,
        sessionTag,
        name
      );
      this.errorLogger?.info(
        `Tmux window rename for session ${sessionId}: ${result.success ? "success" : (result.message ?? "failed")}`,
        { category: "sync", sessionId }
      );
    }
  }

  /**
   * Delete a single session: tmux + worktree cleanup, DB/cache removal,
   * file-claim release, MCP batch-state teardown (issue #2080: delegated to
   * SessionDeletion).
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.sessionDeletion.deleteSession(sessionId);
    // Issue #1883 (in-path leak fix) — prune the model-downgrade + auto-abort
    // dedupe sets. `downgradeNotified` leaked one entry per downgraded session
    // for the process lifetime; #2080 moved deletion into sessionDeletion.ts
    // where these private Sets are unreachable, so they are pruned here at the
    // facade delegator (SessionDeletion's only caller).
    this.downgradeNotified.delete(sessionId);
    this.abortedSessions.delete(sessionId);
  }

  /**
   * Bulk-delete sessions in a namespace (PARALLEL sibling of deleteSession —
   * the #1364 within-batch sibling check differs). Issue #2080: delegated to
   * SessionDeletion.
   */
  async deleteSessions(
    sessionIds: string[],
    namespace: string
  ): Promise<{ deleted: string[]; skipped: string[] }> {
    const result = await this.sessionDeletion.deleteSessions(
      sessionIds,
      namespace
    );
    // Issue #1883 (in-path leak fix) — prune dedupe state for ACTUALLY-deleted
    // sessions ONLY. `skipped` sessions are still live and MUST keep their
    // dedupe state (mirror the #1102 rationale in sessionDeletion.ts).
    for (const id of result.deleted) {
      this.downgradeNotified.delete(id);
      this.abortedSessions.delete(id);
    }
    return result;
  }

  async updateSessionNotes(
    sessionId: string,
    notes: string | null
  ): Promise<void> {
    await this.sessionCache.updateSessionNotes(sessionId, notes);
  }

  async updateSessionView(
    sessionId: string,
    view: SessionView | null
  ): Promise<void> {
    await this.sessionCache.updateSessionView(sessionId, view);
  }

  async updateSessionPromptDraft(
    sessionId: string,
    promptDraft: string | null
  ): Promise<void> {
    await this.sessionCache.updateSessionPromptDraft(sessionId, promptDraft);
  }

  async updateSessionEmoji(
    sessionId: string,
    emoji: string | null
  ): Promise<void> {
    await this.sessionCache.updateSessionEmoji(sessionId, emoji);
  }

  async updateSessionSource(
    sessionId: string,
    source: "scheduler" | "heartbeat",
    scheduleKind?: "at" | "cron" | "every",
    scheduleId?: string
  ): Promise<void> {
    await this.sessionCache.updateSessionSource(
      sessionId,
      source,
      scheduleKind,
      scheduleId
    );
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
    await this.sessionCache.updateSessionLinkedIssue(sessionId, linkedIssue);
  }

  /**
   * Issue #2862 (Fix 1): retroactively stamp a session's managed-peer parent
   * link, mirroring {@link updateSessionLinkedIssue}. Public wrapper over the
   * cache-level write (which already existed, called only from the spawn
   * choke point) so the `PUT /sessions/:id/parent` mutation descriptor's
   * `applyLocal` can heal an orphan whose spawn timed out after success.
   */
  async updateSessionParentRelationship(
    sessionId: string,
    parentSessionId: string,
    parentRelationship: "branch" | "spawn"
  ): Promise<void> {
    this.sessionCache.updateSessionParentRelationship(
      sessionId,
      parentSessionId,
      parentRelationship
    );
  }

  async updateSessionNeedsReviewOverride(
    sessionId: string,
    needsReviewOverride: "read" | "unread" | null
  ): Promise<void> {
    await this.sessionCache.updateSessionNeedsReviewOverride(
      sessionId,
      needsReviewOverride
    );
  }

  async updateSessionAutoRecoverFromApiError(
    sessionId: string,
    autoRecover: boolean | null
  ): Promise<void> {
    await this.sessionCache.updateSessionAutoRecoverFromApiError(
      sessionId,
      autoRecover
    );
  }

  /**
   * Issue #1905: set or clear a session's per-session ceiling override — the
   * `applyLocal` of `CEILING_OVERRIDE_MUTATION`. Writes a partial
   * {@link CeilingGuardConfigPatch} onto `session.metadata.ceilingOverride`
   * (`null` clears it) via the version-checked metadata-fields writer; the
   * `.passthrough()` metadata blob round-trips it through the CLI. Read by
   * {@link checkSessionCeilings} (R7).
   */
  async updateSessionCeilingOverride(
    sessionId: string,
    value: CeilingGuardConfigPatch | null
  ): Promise<void> {
    await this.sessionCache.updateSessionMetadataFields(sessionId, m => ({
      ...m,
      ceilingOverride: value ?? undefined,
    }));
  }

  async updateSessionUiCollapseState(
    sessionId: string,
    uiCollapseState: UiCollapseState | null
  ): Promise<void> {
    await this.sessionCache.updateSessionUiCollapseState(
      sessionId,
      uiCollapseState
    );
  }

  /**
   * Apply a session's permission/model config via RPC, restarting on a
   * tmux/pty model-mode change (#1633). Issue #2080: delegated to
   * SessionLifecycleOps (modelModeRestart moved with it).
   */
  async applySessionConfig(
    sessionId: string,
    config: {
      permissionMode?: PermissionMode;
      modelMode?: ModelMode;
      effort?: EffortLevel;
      rawModel?: string;
    }
    // Issue #3769 (Task 1d): additively return the live-apply method the CLI
    // reported ("sdk" | "config"), threaded from sessionLifecycleOps.
  ): Promise<{ method: "sdk" | "config" }> {
    return this.sessionLifecycleOps.applySessionConfig(sessionId, config);
  }

  /**
   * Issue #2149: relaunch an active session with new spawn-frozen params
   * (launcher / safeMode) via teardown + `--resume` respawn through the
   * `spawnSession` choke point. Delegated to SessionRelaunch.
   */
  async relaunchSession(
    sessionId: string,
    overrides: RelaunchOverrides
  ): Promise<RelaunchResult> {
    return this.sessionRelaunch.relaunchSession(sessionId, overrides);
  }

  async spawnSession(
    opts: SpawnSessionOptions
  ): Promise<
    | { type: "success"; sessionId: string; resolvedName?: string }
    | { type: "error"; message: string; code?: string }
  > {
    // Issue #1698 (G1, linchpin): server-side pre-spawn account-health gate.
    // spawnSession is the universal spawn choke point — create (machines.ts),
    // reconnect start-fresh, restart/switch respawns, branch, scheduler, and
    // federation peer-incoming all funnel through here. Rejecting a dead-account
    // spawn BEFORE invoking the daemon surfaces the existing account_unrefreshable
    // code (→ HTTP 409 at the route) instead of an opaque daemon timeout, AND
    // leaves no zombie "offline" record (the daemon is never invoked, so no tmux
    // window / session record is created — closes G3-a for already-flagged
    // accounts). Reuses the switchAccount/restart validation pattern.
    // Fail-OPEN when the validator is unwired (no accountService) or the spawn is
    // host-credential (no accountUuid) — the inverse of switchAccount's
    // fail-closed, because a missing validator must never block host-credential
    // or test spawns.
    // Issue #4568: an API-key session carries exactly ONE credential. Every spawn
    // path funnels through here, so a payload naming BOTH a key and an account —
    // whichever caller built it — is refused before the daemon could deliver two
    // credentials (an account switch clears `apiKeyId` itself, so it never trips
    // this; the route answers the same case with a 400).
    if (opts.apiKeyId && opts.accountUuid) {
      return {
        type: "error",
        message:
          "An API-key session binds no subscription account — the spawn named both a key and an account",
        code: "api_key_with_account",
      };
    }
    if (opts.accountUuid && this.accountService) {
      const acct = this.accountService.getRaw(opts.accountUuid);
      if (acct?.unrefreshable) {
        return {
          type: "error",
          message: `Account ${acct.emailAddress} is unrefreshable — user must re-login before it can be used`,
          code: "account_unrefreshable",
        };
      }
      // Issue #2457: an account whose stored token is clock-EXPIRED with no path
      // to refresh (no refresh token) will deterministically throw in the CLI
      // injection path (resolveAccountTokenForSession → "token expired and
      // on-demand refresh failed"), spawning a prompt-less husk record with no
      // HTTP surface (symptom 1). Refuse it here, pre-daemon, so no husk is
      // created AND the create route surfaces a coded 409 (R2/R3). Behavior-based,
      // NOT a `status != ok` blacklist:
      //  - env-token accounts are EXEMPT (their synthesized `expiresAt: 0` reads
      //    as expired, but they carry a long-lived token injected directly — see
      //    isEnvTokenAccount / accountTokenInjection.ts #2268);
      //  - a refreshable account (still carries a refresh token) is LET THROUGH so
      //    the injection path's near-expiry safety-net refresh can run — refusing
      //    it would reintroduce the false "Re-login required" that #2281 fixes
      //    (IF-2). post-#2281 `refreshing` and post-#2608 `rate_limited` accounts
      //    are likewise never refused here (neither is unrefreshable nor
      //    expired-with-no-refresh-token).
      if (
        acct &&
        !isEnvTokenAccount(acct) &&
        typeof acct.expiresAt === "number" &&
        acct.expiresAt <= Date.now() &&
        !(acct.refreshToken && acct.refreshToken.length > 0)
      ) {
        return {
          type: "error",
          message: `Account ${acct.emailAddress} token is expired with no refresh path — user must re-login before it can be used`,
          code: "account_token_expired",
        };
      }
    }

    // Issue #2862 (Fix 2): pre-stamp the managed-peer parent link keyed by the
    // session TAG BEFORE the daemon RPC. The post-success stamp below keys on the
    // awaited `result.sessionId`, which is never delivered when
    // `rpcGateway.spawnSession` times out (SPAWN_RPC_TIMEOUT_MS) AFTER the daemon
    // has committed the spawn — leaving the session created but unstamped (the
    // "timeout after success" bug). The tag is the only id known pre-registration
    // (the store uuid is minted at first registration), so we generate one if the
    // caller did not (the daemon honours a provided hapiSessionId) and queue by
    // tag; `sessionCache.getOrCreateSession` applies it when the child registers.
    // Idempotent with the post-success fallback (that write skips if already set).
    if (opts.parentRelationship === "spawn" && opts.parentSessionId) {
      if (!opts.hapiSessionId) {
        opts.hapiSessionId = generateSessionId();
      }
      this.sessionCache.queuePendingParentByTag(
        opts.hapiSessionId,
        opts.parentSessionId,
        "spawn"
      );
    }

    // Issue #3611: stamp the resolved `autoSelectOptimalAccount` opt-in onto `opts`
    // so it rides the spawn RPC to the daemon (rpcGateway forwards
    // `opts.autoSelectOptimalAccount`). Done HERE at the universal choke point so
    // EVERY spawn caller — create route, scheduler taskExecutor, controlServer —
    // inherits the pick with no per-caller edit (R5). Fail-CLOSED: an unset or
    // throwing reader resolves `false`, so the daemon runs no optimal-pick and
    // #3023's decision is byte-identical to today (R3). A respawn still carries the
    // flag, but the daemon's R7 fresh-spawn whitelist gates the actual pick out.
    if (this.readAutoSelectOptimalAccount) {
      try {
        opts.autoSelectOptimalAccount =
          await this.readAutoSelectOptimalAccount();
      } catch {
        opts.autoSelectOptimalAccount = false;
      }
    }

    // [perf] issue #2147: universal spawn choke-point timing. Every spawn path
    // (create, reconnect start-fresh, branch, scheduler, federation peer-incoming)
    // funnels through here, so this one stamp gives the local baseline for free
    // and the remote raw-RPC total. Additive log only; grep `[perf][spawn]`.
    const perfSpawnT0 = Date.now();
    const result = await this.rpcGateway.spawnSession(opts);
    this.errorLogger?.info(
      `[perf][spawn] stage=syncEngine-spawnSession key=${opts.hapiSessionId ?? (result.type === "success" ? result.sessionId : "")} dir=${opts.directory} node=${opts.originatingNodeId ?? "local"} result=${result.type} ms=${Date.now() - perfSpawnT0}`,
      { category: "perf" }
    );

    // Issue #1698 (G2-edge, R2): classify a spawn-failure cause. The gate above
    // catches accounts ALREADY flagged unrefreshable. But the flag is set lazily
    // (tokenRefreshService marks it on invalid_grant), so an account can pass the
    // gate, fail to initialize, and only get flagged DURING the spawn attempt.
    // When the daemon returns a generic error and the bound account has since
    // become unrefreshable, re-tag the error as account_unrefreshable so the route
    // surfaces the actionable re-login state instead of a bare timeout.
    if (result.type === "error" && opts.accountUuid && this.accountService) {
      const acct = this.accountService.getRaw(opts.accountUuid);
      if (acct?.unrefreshable) {
        return {
          type: "error",
          message: `Account ${acct.emailAddress} became unrefreshable during spawn — user must re-login`,
          code: "account_unrefreshable",
        };
      }
    }

    // Issue #2434: surface the spawn-time pin on the session record immediately
    // so the header badge reads the pinned model instead of flashing "default"
    // until the first keepAlive arrives.
    //
    // 🔴 The DURABLE `metadata.modelMode` write deliberately does NOT happen
    // here. `updateMetadata` on the CLI side rebuilds the blob from that
    // process's LOCALLY CACHED metadata, so a server-side write racing the
    // CLI's own post-spawn stamps (claudeSessionId, launcherKind) is silently
    // clobbered — measured: `metadata.launcherKind` landed while
    // `metadata.modelMode` came back null. The pin is therefore stamped
    // CLI-side in `runClaude`, atomically in the SAME `updateMetadata` call as
    // `launcherKind`, exactly like safeMode / launcherKind / sessionRole.
    if (
      result.type === "success" &&
      (opts.modelMode !== undefined ||
        opts.effort !== undefined ||
        opts.rawModel !== undefined)
    ) {
      // Issue #2456: mirror the effort + raw-model spawn pins onto the record
      // immediately (same rationale as modelMode) so the header badge/effort tag
      // read them before the first keepAlive arrives.
      this.sessionCache.applySessionConfig(result.sessionId, {
        ...(opts.modelMode !== undefined ? { modelMode: opts.modelMode } : {}),
        ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
        ...(opts.rawModel !== undefined ? { rawModel: opts.rawModel } : {}),
      });
    }

    // Issue #3348: the non-claude native model is stamped CLI-side into
    // `metadata.nativeModel` (buildSessionMetadata reads HAPI_NATIVE_MODEL), NOT
    // server-side here — the SAME reason the durable modelMode pin above is
    // CLI-stamped: the CLI's updateMetadata rebuilds the blob from its local
    // cache, so a server-side write racing the CLI's post-spawn stamps is
    // silently clobbered. The daemon sets HAPI_NATIVE_MODEL in the gemini/codex
    // spawn env (sessionSpawner); the child reports it in its initial metadata.

    // Issue #2479: persist the spawn-originated parent link for a PM-spawned
    // managed peer. This is the ONLY spawn-path write of parent_session_id —
    // parentSessionId otherwise dead-ends at sessionSpawner.ts (destructured,
    // never used) and the session INSERT omits it. Fires ONLY for "spawn": a
    // branch persists via branchSession → updateSessionBranchInfo (which stamps
    // 'branch'), so skipping "branch"/undefined here dedupes the two writers.
    // The cache method resolves result.sessionId → the store uuid before the
    // UPDATE — result.sessionId is a tag on reattach paths, but a fresh managed-
    // peer spawn returns the uuid (expert-review 2026-08-02, R-1).
    if (
      result.type === "success" &&
      opts.parentSessionId &&
      opts.parentRelationship === "spawn"
    ) {
      this.sessionCache.updateSessionParentRelationship(
        result.sessionId,
        opts.parentSessionId,
        "spawn"
      );
    }

    return result;
  }

  /**
   * #1778: Thin passthrough so the federated node-to-node reconnect endpoint
   * (web/routes/federation/sessionLifecycle.ts) can mark a session orphaned
   * when it detects the cwd is gone in its synchronous pre-check — BEFORE the
   * fire-and-forget reconnectSession kickoff that would otherwise swallow the
   * terminal error. Mirrors the markOrphaned call inside reconnectSession /
   * archiveSession (#1364). No new state — delegates to sessionCache.
   */
  markSessionOrphaned(sessionId: string, reason: string): void {
    this.sessionCache.markOrphaned(sessionId, reason);
  }

  /**
   * #3172: dissolve a scheduler-spawned session's link to its (deleted)
   * schedule — the schedule analogue of #2480's `dissolveChildSessions`. Nulls
   * `metadata.scheduleId` (keeping `source` as provenance) through the
   * version-checked patch, so the session becomes an independent top-level
   * session instead of pointing at a schedule that no longer exists.
   */
  async clearSessionScheduleLink(sessionId: string): Promise<boolean> {
    return this.sessionCache.updateSessionMetadataFields(sessionId, current => {
      const { scheduleId: _dropped, ...rest } = current;
      return rest;
    });
  }
  /**
   * Reconnect to an existing (disconnected) session by spawning a new
   * process with the --resume flag (issue #2080: delegated to SessionRespawn).
   */
  async reconnectSession(
    sessionId: string,
    // Issue #2301 (Task 4): forward the route abort signal to the bounded
    // wait-for-slot poll (a client disconnect cancels the wait).
    signal?: AbortSignal
  ): Promise<
    | { type: "success"; newSessionId: string }
    | { type: "error"; message: string; code?: string }
  > {
    return this.sessionRespawn.reconnectSession(sessionId, signal);
  }

  /**
   * Inject the target-account validator (issue #1456, Sub-Issue J). Wired in
   * web/server.ts after AccountService is constructed (AccountService
   * post-dates SyncEngine construction, so it cannot be a constructor arg).
   */
  setAccountService(svc: AccountValidator): void {
    this.accountService = svc;
  }

  /**
   * Inject the loop-cron lifecycle coupler (issue #2453, Task 7). Wired in
   * web/server.ts after the SystemJobsService exists. The hooks (session end →
   * auto-pause, reconnect → auto-resume, delete → purge) are all best-effort.
   */
  setLoopCronCoupler(coupler: LoopCronLifecycleCoupler): void {
    this.loopCronCoupler = coupler;
  }

  /**
   * Emit the R6 "loops resuming" SSE event (issue #2453, Task 14). Fired by the
   * lifecycle coupler after a reconnect auto-resumes the loops it auto-paused —
   * the web bridges it to the standard bottom-center toast.
   */
  emitLoopsResuming(signal: {
    sessionId: string;
    count: number;
    pausedAtMs: number;
  }): void {
    this.eventPublisher.emit({
      type: "loops-resuming",
      sessionId: signal.sessionId,
      count: signal.count,
      pausedAtMs: signal.pausedAtMs,
    });
  }

  /**
   * Issue #1664 (epic #1662, Sub B): wire the turn-lifecycle orchestrator and
   * run the one-time BOOT orphan sweep (R5). A fresh server process tracks no
   * open turns in memory, so every persisted `status='open'` row is from a dead
   * prior generation and is orphaned here. Migrations have already run (Store
   * construction predates SyncEngine). The per-session resume sweep runs in
   * reconnectSession(). Off any session path; sweepOrphans is fail-open.
   */
  setTurnLifecycle(turnLifecycle: TurnLifecycle): void {
    this.turnLifecycle = turnLifecycle;
    const orphaned = turnLifecycle.sweepOrphans();
    if (orphaned > 0) {
      this.errorLogger?.info(
        `Turn boot sweep: marked ${orphaned} stale-open turn(s) orphaned (issue #1664)`,
        { category: "sync" }
      );
    }
  }

  /**
   * Issue #1883 (G3) — wire the out-of-band escalation surface post-construction
   * (mirror the `setTurnLifecycle` / `setAccountService` convention). No
   * construction-order dependency; keeps the constructor + all `new SyncEngine`
   * call sites untouched. Unset → session-fatal escalation degrades to G1+G2.
   */
  setNotifier(notifier: Notifier): void {
    this.notifier = notifier;
  }

  /**
   * Issue #3611 — inject the server-side `autoSelectOptimalAccount` preference
   * reader (wired from `index.ts` over the node's `settingsFile`). Unset ⇒
   * `spawnSession` stamps `false` and the daemon runs no optimal-pick (fail-closed,
   * so behavior is byte-identical to #3023 until the operator opts in — R3).
   */
  setAutoSelectOptimalAccountReader(reader: () => Promise<boolean>): void {
    this.readAutoSelectOptimalAccount = reader;
  }

  /**
   * Issue #1883 (Phase 2, R7) — set the auto-abort config flag (default OFF).
   * Loaded from settings.json in `index.ts` and injected here.
   */
  setSessionFatalConfig(config: { autoAbortEnabled: boolean }): void {
    this.sessionFatalAutoAbortEnabled = config.autoAbortEnabled;
  }
  /**
   * Switch the Anthropic account bound to an ACTIVE session (issue #1456,
   * Sub-Issue J) — validate -> archive -> respawn under the new account, with
   * R4 rollback (issue #2080: delegated to AccountRestart).
   *
   * Issue #3633: a DISCONNECTED session STAGES the account pair instead — see
   * `AccountRestart.stageAccount`. The `!active` decision lives HERE in the
   * engine op (the round-11 `applySessionConfig` idiom), so the `/account` route
   * and the federation receiver carry no `!active` guard and inherit staging for
   * free. `AccountRestart.switchAccount` stays byte-stable and keeps `not_active`
   * as a defensive backstop for direct active-only callers. A null session falls
   * through to the delegate, which returns `session_not_found` as before.
   */
  async switchAccount(
    sessionId: string,
    accountUuid: string,
    // Issue #2299 (Task 4): thread the route abort signal to AccountRestart's
    // bounded pre-kill wait.
    signal?: AbortSignal
  ): Promise<
    | {
        type: "success";
        newSessionId: string;
        accountEmail: string;
        accountUuid: string;
        claudeAccount: ClaudeAccountInfo;
        /** Issue #4823: the binding now on the record — the federation receiver
         *  returns it so the hub's cache stops naming an API key. */
        authBinding: AuthBinding;
        staged?: boolean;
      }
    | { type: "error"; message: string; code?: string }
  > {
    const session = this.sessionCache.getSession(sessionId);
    if (session && !session.active) {
      // #3633: stageAccount validates + persists the pair with NO kill/respawn,
      // so it takes no abort signal (nothing to cancel). The #2299 pre-kill wait
      // only applies to the live active-session switch below.
      return this.accountRestart.stageAccount(sessionId, accountUuid);
    }
    return this.accountRestart.switchAccount(sessionId, accountUuid, signal);
  }

  /**
   * Issue #4823: switch (or, for a DISCONNECTED session, stage) a session's
   * payment method — a subscription account or a node-vault Anthropic API key.
   * Same `!active` routing as {@link switchAccount}; both target kinds share
   * `AccountRestart`'s one validation, persistence and rollback body.
   */
  async switchPaymentMethod(
    sessionId: string,
    target: PaymentMethodTarget,
    signal?: AbortSignal
  ): Promise<PaymentMethodSwitchResult | PaymentMethodStageResult> {
    const session = this.sessionCache.getSession(sessionId);
    if (session && !session.active) {
      return this.accountRestart.stagePaymentMethod(sessionId, target);
    }
    return this.accountRestart.switchPaymentMethod(sessionId, target, signal);
  }
  /**
   * Issue #1507: restart a bound session with a freshly refreshed token
   * (same-account; mid-inference sessions defer). Issue #2080: delegated to
   * AccountRestart.
   */
  async tokenRefreshRestart(
    sessionId: string,
    accountUuid: string,
    opts?: { force?: boolean }
  ): Promise<
    | { type: "success" }
    | { type: "deferred"; reason: string }
    | { type: "error"; message: string; code?: string }
  > {
    return this.accountRestart.tokenRefreshRestart(
      sessionId,
      accountUuid,
      opts
    );
  }
  /**
   * Branch a session via Claude's --fork-session flag: create a NEW HAPI
   * session that inherits the parent's conversation history (issue #2080:
   * delegated to SessionRespawn).
   */
  async branchSession(
    sessionId: string,
    branchLabel?: string
  ): Promise<
    | { type: "success"; newSessionId: string }
    | { type: "error"; message: string }
  > {
    return this.sessionRespawn.branchSession(sessionId, branchLabel);
  }

  async checkPathsExist(
    machineId: string,
    paths: string[]
  ): Promise<Record<string, boolean>> {
    return await this.rpcGateway.checkPathsExist(machineId, paths);
  }

  async listDirectory(
    machineId: string,
    path: string
  ): Promise<DirectoryEntry[]> {
    return await this.rpcGateway.listDirectory(machineId, path);
  }

  // issue #3498: create a directory on the machine (New Session form's "New
  // folder"). Machine-scoped, mirroring listDirectory above — distinct from the
  // session-cwd-scoped createSessionDirectory (#2715). The daemon runs the
  // authoritative create-target UNION guard + realpath.
  async createDirectory(
    machineId: string,
    path: string,
    recursive: boolean
  ): Promise<DirectoryEntry> {
    return await this.rpcGateway.createDirectory(machineId, path, recursive);
  }

  getRecentPaths(machineId: string, namespace: string): string[] {
    return this.store.recentPaths.getRecentPaths(machineId, namespace);
  }

  addRecentPath(machineId: string, namespace: string, path: string): void {
    this.store.recentPaths.addRecentPath(machineId, namespace, path);
  }

  removeRecentPath(
    machineId: string,
    namespace: string,
    path: string
  ): boolean {
    return this.store.recentPaths.removeRecentPath(machineId, namespace, path);
  }

  async getGitStatus(
    sessionId: string,
    cwd?: string
  ): Promise<RpcCommandResponse> {
    return await this.rpcGateway.getGitStatus(sessionId, cwd);
  }

  async getGitDiffNumstat(
    sessionId: string,
    options: { cwd?: string; staged?: boolean }
  ): Promise<RpcCommandResponse> {
    return await this.rpcGateway.getGitDiffNumstat(sessionId, options);
  }

  async getGitDiffFile(
    sessionId: string,
    options: { cwd?: string; filePath: string; staged?: boolean }
  ): Promise<RpcCommandResponse> {
    return await this.rpcGateway.getGitDiffFile(sessionId, options);
  }

  async getGitRemoteUrl(
    sessionId: string,
    cwd?: string
  ): Promise<RpcCommandResponse> {
    return await this.rpcGateway.getGitRemoteUrl(sessionId, cwd);
  }

  async readSessionFile(
    sessionId: string,
    path: string
  ): Promise<RpcReadFileResponse> {
    return await this.rpcGateway.readSessionFile(sessionId, path);
  }

  async writeSessionFile(
    sessionId: string,
    options: { path: string; content: string; expectedHash?: string | null }
  ): Promise<RpcWriteFileResponse> {
    return await this.rpcGateway.writeSessionFile(sessionId, options);
  }

  async listSessionDirectory(
    sessionId: string,
    path: string
  ): Promise<ListDirectoryResponse> {
    return await this.rpcGateway.listSessionDirectory(sessionId, path);
  }

  // issue #2715: the V2 mutating file ops delegate to the gateway, which routes
  // to the CLI handler where the authoritative path guard runs.
  async createSessionDirectory(
    sessionId: string,
    path: string
  ): Promise<RpcMutationResponse> {
    return await this.rpcGateway.createSessionDirectory(sessionId, path);
  }

  async renameSessionPath(
    sessionId: string,
    options: { path: string; newPath: string }
  ): Promise<RpcMutationResponse> {
    return await this.rpcGateway.renameSessionPath(sessionId, options);
  }

  async deleteSessionPath(
    sessionId: string,
    options: { path: string; recursive?: boolean }
  ): Promise<RpcMutationResponse> {
    return await this.rpcGateway.deleteSessionPath(sessionId, options);
  }

  async runRipgrep(
    sessionId: string,
    args: string[],
    cwd?: string
  ): Promise<RpcCommandResponse> {
    return await this.rpcGateway.runRipgrep(sessionId, args, cwd);
  }

  async listSlashCommands(
    sessionId: string,
    agent: string
  ): Promise<{
    success: boolean;
    commands?: Array<{
      name: string;
      description?: string;
      source: "builtin" | "user";
    }>;
    error?: string;
  }> {
    return await this.rpcGateway.listSlashCommands(sessionId, agent);
  }
}
