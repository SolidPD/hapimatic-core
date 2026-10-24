// SPDX-License-Identifier: AGPL-3.0-only
import type { ModelMode, PermissionMode } from "./modes";
import type {
  AgentState,
  AuthBinding,
  BackgroundShellCounts,
  CeilingGuardConfigPatch,
  ClaudeAccountInfo,
  LinkedIssue,
  RepoIdentity,
  Session,
  SessionView,
  SessionWorkflowBadge,
  UiCollapseState,
  WorktreeMetadata,
} from "./schemas";
import type { ClaudeRemoteLauncherKind } from "./launcherResolver";

/**
 * Recovery status for sessions that persist across restarts
 */
export type RecoveryStatus = "none" | "recovering" | "recovered" | "failed";

/**
 * Check if any pending request is an AskUserQuestion tool.
 * This indicates Claude is waiting for user input and timers should pause.
 */
export function checkIsWaitingForUserQuestion(
  agentState: AgentState | null | undefined
): boolean {
  const requests = agentState?.requests ?? {};
  return Object.values(requests).some(
    r => r.tool === "AskUserQuestion" || r.tool === "ask_user_question"
  );
}

/**
 * Freshness window (ms) for judging a session "live"/"fresh" by its `activeAt`
 * heartbeat. Issue #2761 (R4): this is the SINGLE SOURCE OF TRUTH for BOTH
 *   - the daemon idle-refresh liveness guard (`cli/src/daemon/sessionLiveness.ts`,
 *     which imports and re-exports it), and
 *   - the server's offline-node `active:false` read-path projection
 *     (`server/src/federation/nodeRegistry.ts` → `getAllRemoteSessions`),
 * so the two can never drift. It lives here (alongside the `activeAt` field it
 * interprets, re-exported from `shared/src/index.ts`) precisely so a future edit to
 * one consumer cannot silently diverge from the other.
 *
 * Lower bound is the max *legitimate* staleness of a live remote session as seen
 * at the hub: `TMUX_PTY_INACTIVE_TOLERANCE_MS` (30s) + one federation poll interval
 * (~15s) + cross-machine clock skew ≈ ~45s. 120s gives comfortable headroom yet is
 * ~240× below the ~8h token lifetime, so the added starvation risk is negligible
 * while a zombie is caught within ~2 min of its `activeAt` freezing.
 *
 * The daemon guard is additionally env-overridable via `HAPI_LIVE_FRESHNESS_WINDOW_MS`
 * (its documented rollback lever, `resolveLiveFreshnessWindowMs`). That override is
 * cli-scoped by design and deliberately does NOT govern the server projection (#2761 R4).
 */
export const LIVE_SESSION_FRESHNESS_WINDOW_MS = 120_000; // 2 min

export type SessionSummaryMetadata = {
  name?: string;
  path: string;
  machineId?: string;
  summary?: { text: string };
  flavor?: string | null;
  worktree?: WorktreeMetadata;
  /**
   * Opaque notes payload: a JSON-serialized `NotesContent` envelope (#1075) or a
   * legacy plain string. Decode with `parseNotes()` from `@hapi/protocol`.
   */
  notes?: string;
  /** Issue #3286 (View Picker): server-persisted selected view (cross-device via
   *  SSE). Mirrors the `notes` metadata projection; null/absent = DEFAULT_SESSION_VIEW. */
  persistedView?: SessionView | null;
  promptDraft?: string | null;
  claudeSessionId?: string;
  /** #3811: codex native session id (threadId ?? sessionId). Projected here so
   *  the LIST card's harness-neutral SessionIdDisplay sees it — before #3811 even
   *  the EXISTING codex id never reached the list (the #1616 launcherKind trap). */
  codexSessionId?: string;
  /** #3811: ACP native session id (gemini/opencode + ACP tier-2). Projected so
   *  the list card can surface it via the flavor's nativeSessionId descriptor. */
  acpSessionId?: string;
  emoji?: string;
  /** Claude account info (plan type, tier) for display */
  claudeAccount?: ClaudeAccountInfo;
  /** Origin of this session: "scheduler" | "heartbeat" | undefined (user-created) */
  source?: "scheduler" | "heartbeat";
  /** Schedule kind for scheduler-created sessions */
  scheduleKind?: "at" | "cron" | "every";
  /** Schedule ID for deep-linking back to the spawning schedule */
  scheduleId?: string;
  /** Git repo identity for project grouping and header display */
  repoIdentity?: RepoIdentity;
  /** Federation: nodeId of the peer that spawned this session (dual-node visibility) */
  originatingNodeId?: string;
  /** Multi-account (epic #1446): the Anthropic account this session is bound to
   *  (set by the spawn-wiring sub-issue #1455 via HAPI_ACCOUNT_UUID; stamped onto
   *  metadata by Sub-Issue D). Absent → host/node-default credential. */
  accountUuid?: string;
  /** Launcher kind frozen at spawn (#1613/#1616): drives the per-session
   *  "Launcher: <kind>" badge in SessionHeader. Omitting this field from the
   *  projection (toSessionSummary) is exactly why the badge never rendered. */
  launcherKind?: ClaudeRemoteLauncherKind;
  /** Issue #2434: the DURABLE Claude model pin stamped at spawn / on a
   *  mid-session change. Distinct from the top-level ephemeral
   *  `SessionSummary.modelMode` (the currently-displayed mode): THIS is the
   *  persisted value the respawn paths (model switch, account switch,
   *  reconnect) re-source from. Projected here — mirroring launcherKind — so
   *  clients and API consumers can observe that the pin actually persisted;
   *  omitting it made the durable write invisible through `/api/sessions`. */
  modelMode?: ModelMode;
  /** Issue #1905: per-session runaway-guard ceiling override (a partial ceiling
   *  config, or absent = follow the global config). Projected — mirroring
   *  `modelMode` — so the override is observable via `/api/sessions` and the
   *  federated cache, and a fresh federation poll re-populates it after a
   *  proxied `PUT /sessions/:id/ceiling-override`. */
  ceilingOverride?: CeilingGuardConfigPatch;
  /** Issue #3351 (epic #3345 Sub-Issue F): the per-session auth binding (kind +
   *  display identity). Projected here — mirroring `launcherKind`/`accountUuid`
   *  — so LIST views, the degraded proxy-failure fallback, and every
   *  summary-level consumer see it; without this line an unprojected field is
   *  invisible off the detail path (the exact `launcherKind` #1616 regression).
   *  Consumed by #3353's cost display and the SessionHeader auth-binding badge. */
  authBinding?: AuthBinding;
  /** Issue #4568: the API-key binding's vault id (never key material) —
   *  projected beside `authBinding` so a LIST-opened Session Configuration
   *  modal can mark the session's current key (#4823's current-key marker)
   *  without the detail-path record. Absent for every non-key session. */
  apiKeyId?: string;
  /** Issue #2150: set ONLY on a hub-side federation spawn placeholder row in
   *  `/federation/all-sessions` — the caller-generated correlation id the row is
   *  keyed by, so a poller (CLI or web) can match the row to its own spawn. */
  spawnCorrelationId?: string;
  /** Issue #2150: the peer's refusal code on a FAILED federation spawn
   *  placeholder (e.g. `account_unrefreshable`); the message rides in
   *  `summary.text`. Absent on a message-only failure. */
  spawnErrorCode?: string;
};

/**
 * Issue #4383: the counts-only background-Agent projection carried on the
 * SessionSummary (the list path). `shells` is #4388's optional nested object,
 * copied through unchanged so the federation bridge (#4387) and the shell counts
 * (#4388) share ONE projection and neither invents its own null rule.
 */
export type BackgroundAgentsSummary = {
  running: number;
  done: number;
  error: number;
  total: number;
  /** #4388 (R3): background Bash shell counts, copied through unchanged. */
  shells?: BackgroundShellCounts;
};

/**
 * Issue #4383: the ONE shared projector of the full Session background-Agent
 * snapshot down to the counts-only summary. Its parameter is the NON-NULL
 * snapshot; the CALLER owns the null/absent case — `toSessionSummary` writes
 * `session.backgroundAgents ? projectBackgroundAgentsSummary(...) : null`, and
 * #4387's federation bridge writes the same guard. Keeping the null rule at the
 * caller (not here) lets #4387 and #4388 reuse this byte for byte.
 */
export function projectBackgroundAgentsSummary(
  snapshot: NonNullable<Session["backgroundAgents"]>
): BackgroundAgentsSummary {
  const { running, done, error, total } = snapshot;
  const shells = snapshot.shells;
  return {
    running,
    done,
    error,
    total,
    ...(shells !== undefined ? { shells } : {}),
  };
}

export type SessionSummary = {
  id: string;
  /** Hapimatic short ID (e.g., "hapi-1769639959206-yra1vabo") - used for session correlation */
  tag?: string | null;
  active: boolean;
  thinking: boolean;
  /**
   * Issue #1653: when set, Claude's TUI is blocked on a terminal prompt the
   * user must answer in the terminal (e.g. a permission ask). The web chat
   * surfaces a banner linking to the claude-pty terminal route. `null`/absent
   * = no pending prompt.
   */
  blockedOnTuiPrompt?: { message: string; since: number } | null;
  /**
   * Issue #1647: when set, the session hit a 429 session limit and is waiting
   * for the quota window to reset. The web surfaces a "rate-limited — resets
   * {time}" chip (and drops the thinking dot). `null`/absent = not rate-limited.
   */
  rateLimited?: {
    resetText: string;
    resetAt: number | null;
    since: number;
  } | null;
  /**
   * Issue #4383: background-Agent counts for the list badge (DD4–DD8). Counts
   * only — the full per-agent list the modal reads lives on the Session record,
   * not the summary. `null`/absent = no background agents. Projected from the
   * Session snapshot via `projectBackgroundAgentsSummary` (an unprojected field
   * is invisible to the list — the #1616 lesson).
   */
  backgroundAgents?: BackgroundAgentsSummary | null;
  /** Server-tracked: timestamp when current thinking segment began */
  thinkingStartedAt?: number;
  /** Server-tracked: total accumulated thinking time in ms */
  serverAccumulatedMs?: number;
  activeAt: number;
  updatedAt: number;
  /** Issue #942: session creation timestamp — drives the "Created" sort option. */
  createdAt?: number;
  metadata: SessionSummaryMetadata | null;
  todoProgress: { completed: number; total: number } | null;
  pendingRequestsCount: number;
  modelMode?: ModelMode;
  /** Permission mode (default, acceptEdits, bypassPermissions, plan) */
  permissionMode?: PermissionMode;
  /** Resolved model identifier from SDK (e.g., "claude-opus-4-6"). Issue #1469: now fed live per-turn (bare), not from the system.init snapshot. */
  resolvedModel?: string;
  /** Issue #1469: first-order effective context window (e.g. 1_000_000 for a [1m] session). */
  contextWindowTokens?: number;
  /** Issue #1469: live total tokens currently in the context window. */
  contextUsedTokens?: number;
  /** Issue #1469: live context usage percentage (0-100). */
  contextPercentage?: number;
  /** Recovery status for tmux-backed persistent sessions */
  recoveryStatus?: RecoveryStatus;
  /**
   * Issue #1565: server-authoritative spawn lifecycle state, projected from
   * metadata.lifecycleState so CLI + web read it uniformly. "spawning" (early-ack
   * placeholder) → "running" (child reported in == "ready") | "failed" (background
   * spawn failure). Absent for legacy/in-flight sessions.
   */
  lifecycleState?: string;
  /** Session emoji for visual identification */
  emoji?: string | null;
  /** Number of messages in session history */
  messageCount?: number;
  /** Whether Claude is waiting for user response to AskUserQuestion tool */
  isWaitingForUserQuestion: boolean;
  /** Linked GitHub issue for this session */
  linkedIssue?: LinkedIssue | null;
  /**
   * Issue #1804: resolved workflow-state badge for the linked issue, derived
   * from `v_workflow_state` (highest active lock P1, else highest checkpoint P2).
   * Computed server-side in this projection and `null` when the session has no
   * linked issue or no workflow-state row yet — the card then falls back to the
   * standard `👤 standard` type badge. Rides the summary through the existing
   * list / SSE / federation flow (no new field on `LinkedIssue`, no migration).
   */
  workflowBadge?: SessionWorkflowBadge | null;
  /** Manual read/unread override for cross-device sync */
  needsReviewOverride?: "read" | "unread" | null;
  /** Per-session auto-recover override: null=follow global, true=force on, false=force off */
  autoRecoverFromApiError?: boolean | null;
  /** UI collapse state for prompt/notes sections (cross-device sync) */
  uiCollapseState?: UiCollapseState | null;
  /** Federation: originating node ID (only present for remote sessions) */
  nodeId?: string;
  /** Federation: originating node display label */
  nodeLabel?: string;
  /** Federation: URL of the originating node (for "open in node" navigation) */
  nodeUrl?: string;
  /** Federation: current status of the originating node */
  nodeStatus?: "online" | "degraded" | "offline";
  /** Federation: hub nodeId that spawned this session (for instance isolation filtering) */
  originatingNodeId?: string;
  /** Branching: parent session ID (this session was forked from) */
  parentSessionId?: string | null;
  /** Relationship to parent (issue #2479): "branch" (forked) or "spawn" (PM-spawned managed peer). */
  parentRelationship?: "branch" | "spawn" | null;
  /** Branching: user-provided label for this branch */
  branchLabel?: string | null;
  /** Branching: timestamp when this branch was created */
  branchCreatedAt?: number | null;
  /** Branching: number of child branches spawned from this session */
  childBranchCount?: number;
};

export function toSessionSummary(
  session: Session,
  messageCount?: number,
  childBranchCount?: number,
  workflowBadge?: SessionWorkflowBadge | null
): SessionSummary {
  const requests = session.agentState?.requests ?? {};
  const pendingRequestsCount = Object.keys(requests).length;
  const isWaitingForUserQuestion = checkIsWaitingForUserQuestion(
    session.agentState
  );

  const metadata: SessionSummaryMetadata | null = session.metadata
    ? {
        name: session.metadata.name,
        path: session.metadata.path,
        machineId: session.metadata.machineId ?? undefined,
        summary: session.metadata.summary
          ? { text: session.metadata.summary.text }
          : undefined,
        flavor: session.metadata.flavor ?? null,
        worktree: session.metadata.worktree,
        notes: session.notes,
        persistedView: session.persistedView,
        promptDraft: session.promptDraft,
        claudeSessionId: session.metadata.claudeSessionId ?? undefined,
        // #3811: project codex + ACP native ids so the LIST card's SessionIdDisplay
        // resolves them via the flavor's nativeSessionId descriptor (mirrors the
        // claudeSessionId line above — an unprojected field is invisible to the list).
        codexSessionId: session.metadata.codexSessionId ?? undefined,
        acpSessionId: session.metadata.acpSessionId ?? undefined,
        claudeAccount: session.metadata.claudeAccount,
        source: session.metadata.source,
        scheduleKind: session.metadata.scheduleKind,
        scheduleId: session.metadata.scheduleId,
        repoIdentity: session.metadata.repoIdentity,
        originatingNodeId: session.metadata.originatingNodeId,
        // #1455: surface the bound account so the session record (and UI) can
        // show which account a session is using — without this projection the
        // accountUuid stamped on metadata never reaches the web client.
        accountUuid: session.metadata.accountUuid,
        // #1616: copy the spawn-frozen launcher kind through so the per-session
        // launcher badge can render. Mirrors the accountUuid passthrough above.
        launcherKind: session.metadata.launcherKind,
        // #2434: copy the DURABLE model pin through (mirrors launcherKind) so
        // the persisted `metadata.modelMode` is observable via the API — the
        // respawn paths read it from the real metadata, but without this
        // projection line every consumer of a SessionSummary saw it as absent.
        modelMode: session.metadata.modelMode,
        // #1905: project the per-session ceiling override so it survives the
        // federation poll (the cache-update writes it after a proxied mutation).
        ceilingOverride: session.metadata.ceilingOverride,
        // #3351: project the per-session auth binding (mirrors launcherKind) so
        // LIST views + the degraded proxy-failure fallback show it — an
        // unprojected field is invisible off the raw-record detail path.
        authBinding: session.metadata.authBinding,
        // #4568: the API-key binding's vault id (mirrors authBinding) — the
        // current-key marker on a list-opened modal reads it.
        apiKeyId: session.metadata.apiKeyId,
      }
    : null;

  const todoProgress = session.todos?.length
    ? {
        completed: session.todos.filter(t => t.status === "completed").length,
        total: session.todos.length,
      }
    : null;

  return {
    id: session.id,
    tag: session.tag ?? null,
    active: session.active,
    thinking: session.thinking,
    blockedOnTuiPrompt: session.blockedOnTuiPrompt ?? null,
    rateLimited: session.rateLimited ?? null,
    // #4383: project counts only; the caller owns the null case.
    backgroundAgents: session.backgroundAgents
      ? projectBackgroundAgentsSummary(session.backgroundAgents)
      : null,
    thinkingStartedAt: session.thinkingStartedAt,
    serverAccumulatedMs: session.serverAccumulatedMs ?? 0,
    activeAt: session.activeAt,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    metadata,
    todoProgress,
    pendingRequestsCount,
    modelMode: session.modelMode,
    permissionMode: session.permissionMode,
    resolvedModel: session.resolvedModel,
    contextWindowTokens: session.contextWindowTokens,
    contextUsedTokens: session.contextUsedTokens,
    contextPercentage: session.contextPercentage,
    emoji: session.emoji ?? null,
    messageCount,
    isWaitingForUserQuestion,
    lifecycleState: session.metadata?.lifecycleState,
    linkedIssue: session.linkedIssue ?? null,
    needsReviewOverride: session.needsReviewOverride ?? null,
    autoRecoverFromApiError: session.autoRecoverFromApiError ?? null,
    uiCollapseState: session.uiCollapseState ?? null,
    parentSessionId: session.parentSessionId ?? null,
    parentRelationship: session.parentRelationship ?? null,
    branchLabel: session.branchLabel ?? null,
    branchCreatedAt: session.branchCreatedAt ?? null,
    childBranchCount: childBranchCount ?? 0,
    workflowBadge: workflowBadge ?? null,
  };
}
