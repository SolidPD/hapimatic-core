// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AccountHealthEnvelope,
  AccountMonogram,
  AccountUsage,
  AccountUsageHistory,
  GateDenialOutcome,
  ProviderAccountUsage,
  ProviderAuthStateEnvelope,
  ProviderId,
  SessionMetadataTurn,
} from "@hapi/protocol";
import type {
  DecryptedMessage as ProtocolDecryptedMessage,
  FeedbackEntryCategory,
  FederationNodeInfo,
  FederationNodeState,
  FederationNodeStatus,
  McpServerStatus,
  McpStatusUpdate,
  Session,
  SessionSummary,
  SyncEvent as ProtocolSyncEvent,
  WorktreeMetadata,
} from "@hapi/protocol/types";

export type {
  FeedbackAttachment,
  FeedbackCategory,
  FeedbackEntryCategory,
  FeedbackMetadata,
  FeedbackRequest,
  FeedbackResponse,
  AgentState,
  FederationNodeInfo,
  FederationNodeState,
  FederationNodeStatus,
  ModelMode,
  PermissionMode,
  RecoveryStatus,
  Session,
  SessionSummary,
  SessionSummaryMetadata,
  TodoItem,
  WorktreeMetadata,
} from "@hapi/protocol/types";

export type SessionMetadataSummary = {
  path: string;
  host: string;
  version?: string;
  name?: string;
  os?: string;
  summary?: { text: string; updatedAt: number };
  machineId?: string;
  tools?: string[];
  flavor?: string | null;
  worktree?: WorktreeMetadata;
};

// #3579: "blocked" — a gate-class denial refused this optimistic send. Distinct
// from "failed" (a transport error, retryable): a "blocked" bubble is not
// retryable (re-sending the same token would refuse again — recovery is the chip
// on the durable in-thread notice), and mergeMessages only auto-drops "sent"
// bubbles, so a "blocked" bubble correctly persists client-side until reload.
export type MessageStatus = "sending" | "sent" | "failed" | "blocked";

export type DecryptedMessage = ProtocolDecryptedMessage & {
  status?: MessageStatus;
  originalText?: string;
  // #3579: the server-resolved gate-denial outcome carried on a "blocked" bubble
  // (the copy carrier for the composer-side render; the durable notice is the
  // in-thread half).
  denial?: GateDenialOutcome;
};

export type Machine = {
  id: string;
  active: boolean;
  metadata: {
    host: string;
    platform: string;
    happyCliVersion: string;
    displayName?: string;
    // Issue #1081/#3458: node capabilities — agent CLIs as `agent:<name>` (e.g.
    // `agent:claude`) and hardware toolchains as `tool:<name>` (e.g.
    // `tool:kicad-cli`, #3458). Absent on older machine records; an absent
    // `tool:*` tag means *unknown*, never "toolchain absent".
    capabilities?: string[];
  } | null;
};

export type AuthResponse = {
  token: string;
  user: {
    id: number;
    username?: string;
    firstName?: string;
    lastName?: string;
  };
};

export type SessionsResponse = { sessions: SessionSummary[] };
export type SessionResponse = { session: Session; messageCount?: number };
export type MessagesResponse = {
  messages: DecryptedMessage[];
  page: {
    limit: number;
    beforeSeq: number | null;
    nextBeforeSeq: number | null;
    hasMore: boolean;
  };
};

export type MachinesResponse = { machines: Machine[] };
export type MachinePathsExistsResponse = { exists: Record<string, boolean> };

// ── Account management (epic #1446 — multi-account OAuth switcher) ──────────
// Mirrors the server's whitelist-by-construction `RedactedAccount`
// (server/src/services/accountService.ts, issue #1451 / Sub-Issue E). Token
// fields (accessToken/refreshToken/scopes) are structurally excluded server-side.
export type RedactedAccount = {
  // #3808: the account's provider ("anthropic" | "openai" | "google"). Emitted
  // explicitly by the server ("anthropic" for legacy records whose on-disk
  // `provider` is absent); optional here only for forward-compat with an older
  // peer binary that predates #3808 — consumers default an absent value to
  // "anthropic".
  provider?: ProviderId;
  accountUuid: string;
  emailAddress: string;
  organizationUuid: string;
  organizationName: string;
  displayName: string;
  billingType: string;
  subscriptionType: string;
  rateLimitTier: string;
  // #3392: ADVISORY CACHE — non-authoritative for availability. The store-cache
  // copy of the token expiry; it LAGS the live isolated credential by up to ~24h
  // for isolated accounts (#1635). Never gate selection/availability on it. The
  // HARD gate is `unrefreshable`; `AccountUsage.status` (from GET /api/accounts/usage)
  // is a SOFT live-probe signal only — `"expired"` → confirm, never a disable.
  expiresAt: number;
  capturedAt: number;
  lastUsedAt: number;
  // #3392: ADVISORY CACHE (see `expiresAt` above) — non-authoritative for availability.
  lastRefreshedAt: number;
  // #1658: sticky dead-family flag (re-login required). Optional on the web
  // side (unlike the server's always-present normalized boolean) because a
  // federated response can come from an older peer binary that does not emit
  // it — consumers read truthiness so absence degrades to false.
  unrefreshable?: boolean;
  /** #4568 (D-4568-3 A): an OpenAI record's login kind — "chatgpt" (a ChatGPT
   *  subscription login) or "api-key" (a #3807 Codex API-key login), so the spawn
   *  picker labels each Codex credential. Absent for anthropic / google rows and
   *  from an older peer binary. */
  authMode?: "chatgpt" | "api-key";
  /** Operator-set nickname from the node's NicknameStore (epic #1855; surfaced on
   * GET /api/accounts by epic #3285 correction pass 1). Absent when unset or when
   * the response comes from an older peer binary. */
  nickname?: string;
  /** Operator-set monogram override (letter + color) from the node's MonogramStore
   * (issue #3621), merged into GET /api/accounts the same read-time way as
   * `nickname`. Absent when unset or when the response comes from an older peer
   * binary. Not stored on the token-bearing credentials record. */
  monogram?: AccountMonogram;
};
export type AccountsResponse = {
  accounts: RedactedAccount[];
  /** True when the node's process env carries a Claude credential
   * (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY) — the cloud-VM case where the
   * store is empty but account-less spawn works via the env-token fallback (#2095). */
  envCredentialPresent?: boolean;
  /** #4736: the node's onboarding sign-in (service-env credential) is not in the
   * account store — `"missing"`, or `"pending"` while the daemon's seed is still in
   * flight; `null` when there is nothing to report. Absent from older servers. */
  onboardingRegistration?: OnboardingRegistration;
};
export type OnboardingRegistration = "missing" | "pending" | null;

// Per-account usage history (epic #1855, Sub I — #1864)
export type AccountUsageHistoryResponse = { history: AccountUsageHistory };
// Per-account usage envelope (epic #1855, Sub D — issue #1859). Server route
// GET /api/accounts/usage returns `{ usage }`; `AccountUsage` is the redacted
// protocol type (shared/src/usage.ts).
export type AccountUsageResponse = {
  usage: AccountUsage[];
  // Issue #3809 (D5 = C): the SIBLING non-Anthropic providerUsage[] key (OpenAI
  // codex snapshots + Google spend counters). Optional for defensive
  // backward-compat with a response serialized before #3809; the hook defaults it
  // to []. `usage[]` is byte-identical to the pre-#3809 contract.
  providerUsage?: ProviderAccountUsage[];
};
// Provider auth-state envelope (issue #3806, epic #3345). Server routes
// GET /api/accounts/provider-auth-state (local) and
// GET /api/federation/provider-auth-state (aggregated) both return the
// `{ nodes: NodeProviderAuthState[] }` envelope — the DERIVED-fields-only view of
// each node's Codex (OpenAI) + Gemini (Google) auth state (shared/src/providerAuthState.ts).
export type ProviderAuthStateResponse = ProviderAuthStateEnvelope;
// Per-node account health (issue #4461, epic #4460 A). Server route
// GET /api/federation/account-health returns one row per known node (this node
// first), each listing every account record THAT node holds with needsRelogin /
// since derived server-side (shared/src/accountHealth.ts). Never a token.
export type AccountHealthResponse = AccountHealthEnvelope;
// Admin session-metadata node-local query envelope (issue #1675, Sub M). Server
// route GET /api/session-metadata/turns returns `{ turns }`; SessionMetadataTurn
// is the curated per-turn row from shared/src/sessionMetadata.ts.
export type SessionMetadataTurnsResponse = { turns: SessionMetadataTurn[] };

// Admin Feedback viewer (issue #2666, epic #2663 Sub C). One serialized
// `feedback` row as returned by `GET /api/feedback` — the camelCase shape of the
// server's `StoredFeedback`. `emailed`/`emailError` carry the email outcome so a
// persist-only (`emailed=false`) row is visibly the durable safety net (R3).
export type FeedbackListItem = {
  id: string;
  createdAt: number;
  namespace: string | null;
  category: FeedbackEntryCategory;
  description: string;
  submitterEmail: string | null;
  /** Scrubbed, composed `FeedbackMetadata`, JSON-serialized (render read-only). */
  metadataJson: string;
  emailed: boolean;
  emailError: string | null;
};

export type FeedbackListResponse = {
  items: FeedbackListItem[];
  total: number;
};

// In-app self-help support (issue #4371, E6 Sub F). The shapes of
// `server/src/web/routes/support.ts`.
export type SupportChannelKind = "relay" | "agentmail" | "telegram" | "none";

export type SupportChannelInfo = {
  kind: SupportChannelKind;
  /** The human-support reply-times text; empty when none is configured. */
  hoursText: string;
  /** Operator-configured issue URL; empty → the public Core repo's. */
  issueUrl: string;
  /** Absolute path of the support workspace (identifies support sessions). */
  workspacePath: string;
};

export type SupportSessionResponse = { sessionId: string; reused: boolean };

export type SupportEscalationPreview = {
  /** The exact text that will be sent. */
  bundle: string;
  /** sha256 of `bundle`; `send` refuses when it no longer matches. */
  hash: string;
  channel: SupportChannelKind;
};

export type SupportEscalationSendResponse = { id: string; delivered: boolean };
// Web-initiated OAuth login (issue #1263). `start` returns the Anthropic
// authorize URL + an opaque loginToken; `complete` returns the redacted new
// account on success, or a structured error code on failure. Token values are
// never present in either response.
export type AccountLoginStartResponse = {
  loginToken: string;
  authorizeUrl: string;
  /** #4462: present when the login runs on another federation node. */
  nodeId?: string;
  nodeLabel?: string;
};
export type AccountLoginCompleteResponse =
  | {
      ok: true;
      account: RedactedAccount;
      /** #4462: the node the account was stored on (node-targeted login only). */
      nodeId?: string;
      nodeLabel?: string;
    }
  | { ok: false; error: string; code: string };
/**
 * Issue #4349: the error code the web OAuth login answers on a tenant VM, where the user signs in
 * inside the VM with Claude Code's own /login instead (the in-VM routes below).
 */
export const IN_VM_SIGN_IN_REQUIRED = "in_vm_sign_in_required";
/** Issue #4349: a started in-VM sign-in — the command to run in a terminal on the VM. */
export type InVmLoginStartResponse = {
  loginToken: string;
  accountUuid: string;
  configDir: string;
  command: string;
};
/** Issue #4349: `not_signed_in` (HTTP 202) means "keep waiting", not a failure. */
export type InVmLoginCompleteResponse =
  | { ok: true; account: RedactedAccount }
  | { ok: false; error: string; code: string };
// Codex (OpenAI) in-app login (issue #3807, epic #3345). The API-key path
// completes synchronously (`state: ok|disabled|failed`); the device-auth path
// returns `state: pending` with a verification link + one-time code that the
// client polls to a terminal state. No key/token value is ever present in any
// response — the server returns only state + the (non-secret) device prompt.
export type OpenAiLoginState =
  | "ok"
  | "pending"
  | "disabled"
  | "unsupported"
  | "failed"
  | "cancelled";
export type OpenAiLoginStartResponse = {
  loginToken: string;
  state: OpenAiLoginState;
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: string;
};
export type OpenAiLoginStatusResponse = {
  state: OpenAiLoginState;
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: string;
};
export type NodeActiveAccountResponse = {
  activeAccount: RedactedAccount | null;
};
export type SetSessionAccountResponse = {
  ok: boolean;
  restartRequired: boolean;
  // issue #3633: true when the session was disconnected and the account was
  // staged for the next reconnect; `restartRequired` is then false.
  staged?: boolean;
};

/** Issue #4823: the payment-method switch body — EXACTLY ONE of a subscription
 *  account or a node-vault Anthropic API key (its vault id, never the key). */
export type SetSessionPaymentMethodRequest =
  | { accountUuid: string }
  | { apiKeyId: string };

export type DirectoryEntry = {
  name: string;
  type: "file" | "directory" | "other";
  size?: number;
  modified?: number;
};

export type ListDirectoryResponse = { entries: DirectoryEntry[] };

// issue #3498: the machine create-directory route returns the created entry
// (the federation node route wraps it as { type: "success", entry }).
export type CreateDirectoryResponse = { entry: DirectoryEntry };

export type SpawnResponse =
  | { type: "success"; sessionId: string; resolvedName?: string }
  // Issue #3515: early-ack (`earlyReturn:true`) optimistic-spawn variant. The
  // server mints the session id (= the future session TAG), registers a
  // `spawning` placeholder, and answers before the daemon spawn RPC resolves.
  // The web navigates to `/sessions/<sessionId>` immediately (finding 3515-1:
  // this id is the tag, not the row uuid) and swaps to the real uuid at
  // materialisation. Falls back to `error` if the caller did not opt in.
  | { type: "accepted"; sessionId: string }
  | { type: "error"; message: string };

export type RepoIssue = {
  number: number;
  title: string;
  labels: string[];
  state: "open" | "closed";
};

export type RepoIssuesResponse = {
  success: boolean;
  repo: string | null;
  issues: RepoIssue[];
  /**
   * Issue #2270 (F25): true git-ness of the queried directory (`git rev-parse`),
   * distinct from `repo` (forge-origin identity). Tri-state: `undefined` when
   * unknown (repo-by-name, or a remote dir with no forge origin we can't probe).
   */
  directoryIsGitRepo?: boolean;
  error?: string;
};

export type GitCommandResponse = {
  success: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
};

export type FileSearchItem = {
  fileName: string;
  filePath: string;
  fullPath: string;
  fileType: "file" | "folder";
};

export type FileSearchResponse = {
  success: boolean;
  files?: FileSearchItem[];
  error?: string;
};

export type FileReadResponse = {
  success: boolean;
  content?: string;
  // issue #2518: sha256 of the file (for conflict-safe edit round-trips) + byte
  // size; tooLarge flags an oversized file the server refused to base64-load.
  hash?: string;
  size?: number;
  tooLarge?: boolean;
  error?: string;
};

// issue #2518: response of PUT /api/sessions/:id/file (conflict-safe write).
// `conflict` = the expectedHash no longer matches the file on disk (409).
export type FileWriteResponse = {
  success: boolean;
  hash?: string;
  conflict?: boolean;
  error?: string;
};

// issue #2518: response of GET /api/sessions/:id/directory (session-scoped
// directory listing for the file browser).
export type SessionDirectoryResponse = {
  success: boolean;
  entries?: DirectoryEntry[];
  error?: string;
};

// issue #2715: response of the V2 mutating file ops (create-folder / rename /
// delete) — POST /api/sessions/:id/{directory,rename,delete}.
export type FileMutationResponse = {
  success: boolean;
  error?: string;
};

export type GitFileStatus = {
  fileName: string;
  filePath: string;
  fullPath: string;
  status:
    | "modified"
    | "added"
    | "deleted"
    | "renamed"
    | "untracked"
    | "conflicted";
  isStaged: boolean;
  linesAdded: number;
  linesRemoved: number;
  oldPath?: string;
};

export type GitStatusFiles = {
  stagedFiles: GitFileStatus[];
  unstagedFiles: GitFileStatus[];
  branch: string | null;
  totalStaged: number;
  totalUnstaged: number;
};

export type SlashCommand = {
  name: string;
  description?: string;
  source: "builtin" | "user";
  content?: string; // Expanded content for Codex user prompts
  textOverride?: string; // Insert this text instead of /name (e.g. "ultraplan" without slash)
};

export type SlashCommandsResponse = {
  success: boolean;
  commands?: SlashCommand[];
  error?: string;
};

export type PushSubscriptionKeys = {
  p256dh: string;
  auth: string;
};

export type PushSubscriptionPayload = {
  endpoint: string;
  keys: PushSubscriptionKeys;
};

export type PushUnsubscribePayload = {
  endpoint: string;
};

export type PushVapidPublicKeyResponse = {
  publicKey: string;
};

export type SyncEvent = ProtocolSyncEvent;

// Time Log types
export type TimeLogEntry = {
  id: string;
  sessionId: string;
  sessionName: string;
  projectDirectory: string;
  date: string;
  durationMs: number;
  createdAt: number;
  namespace: string;
};

export type TimeLogFilters = {
  startDate?: string;
  endDate?: string;
  sessionId?: string;
  projectDirectory?: string;
  limit?: number;
};

export type TimeLogListResponse = {
  entries: TimeLogEntry[];
  total: number;
};

export type TimeLogDailySummary = {
  date: string;
  totalMs: number;
  sessionCount: number;
  entries: Array<{
    sessionId: string;
    sessionName: string;
    durationMs: number;
  }>;
};

export type TimeLogWeeklySummary = {
  startDate: string;
  endDate: string;
  totalMs: number;
  dailyTotals: Array<{
    date: string;
    totalMs: number;
    sessionCount: number;
  }>;
};

export type TimeLogCreateRequest = {
  sessionId: string;
  sessionName: string;
  projectDirectory: string;
  date: string;
  durationMs: number;
};

export type TimeLogEntryResponse = {
  entry: TimeLogEntry;
};

export type TimeLogProjectsResponse = {
  projects: string[];
};

// Issue #1670 (Sub H1, PR-2): six-control ledger + derived read + cutover gate.
export type TimelogControlType =
  | "adjust"
  | "set"
  | "reset"
  | "undo"
  | "disable"
  | "enable";

/** Discriminated request body for POST /api/timelogs/adjustments (R3/R4). */
export type TimelogAdjustmentRequest =
  | { type: "adjust"; hapiSessionId: string; deltaMs: number; note?: string }
  | {
      type: "set";
      hapiSessionId: string;
      toMs: number;
      fromMs?: number;
      note?: string;
    }
  | { type: "reset"; hapiSessionId: string; fromMs?: number; note?: string }
  | {
      type: "undo";
      hapiSessionId: string;
      targetAdjustmentId: string;
      note?: string;
    }
  | {
      type: "disable";
      hapiSessionId: string;
      fromMs: number;
      toMs: number;
      note?: string;
    }
  | {
      type: "enable";
      hapiSessionId: string;
      fromMs: number;
      toMs: number;
      note?: string;
    };

export type TimelogAdjustmentRow = {
  id: string;
  hapiSessionId: string;
  nodeId: string;
  namespace: string | null;
  tsMs: number;
  type: string;
  deltaMs: number | null;
  fromMs: number | null;
  toMs: number | null;
  targetAdjustmentId: string | null;
  actor: string | null;
  note: string | null;
};

export type TimelogAdjustmentResponse = { adjustment: TimelogAdjustmentRow };
export type TimelogAdjustmentsResponse = {
  adjustments: TimelogAdjustmentRow[];
};

/**
 * One per-session row of the turns-derived daily breakdown (issue #1892 Task 3B).
 * `ms` is the summed auto-turn duration for that session in the bucket.
 */
export type SessionBreakdownItem = {
  sessionId: string;
  sessionName: string;
  projectDirectory: string;
  ms: number;
};

/** One derived daily bucket (per-namespace local day) — mirrors the server. */
export type DerivedDailyBucket = {
  namespace: string;
  localDate: string;
  autoMs: number;
  adjustmentMs: number;
  netMs: number;
  /**
   * Issue #1892 Task 3B: per-session breakdown from turns. Optional for
   * backward-compat with an older server that omits it.
   */
  breakdown?: SessionBreakdownItem[];
};

export type DerivedTimeLogResponse = { buckets: DerivedDailyBucket[] };
export type TimelogCutoverStatus = {
  ready: boolean;
  /**
   * #2247: present (true) only when the operator override forces the gate open
   * (settings.json `timelogCutover.force`). Optional — an older server never
   * sends it (deploy-skew safe).
   */
  forced?: boolean;
};

export type TimeLogProjectGroupedSummary = {
  startDate: string;
  endDate: string;
  totalMs: number;
  projects: Array<{
    projectDirectory: string;
    /** Stable project identity (e.g., "owner/repo") for grouping across worktrees */
    projectIdentity: string;
    /** Short display name derived from projectIdentity */
    displayName: string;
    totalMs: number;
    sessions: Array<{
      sessionId: string;
      sessionName: string;
      totalMs: number;
    }>;
  }>;
};

// Schedule types
export type ScheduleKind = "at" | "every" | "cron";
export type OverlapPolicy = "skip" | "queue" | "allow";
export type NotifyOn = "completion" | "error" | "both" | "none";
export type ExecutionStatus =
  | "pending"
  | "running"
  | "delivered"
  | "failed"
  | "timed_out"
  | "skipped"
  | "completed";

export type ScheduledTask = {
  id: string;
  name: string;
  emoji: string | null;
  prompt: string;
  projectDirectory: string;
  scheduleType: ScheduleKind;
  cronExpression: string | null;
  scheduledAt: number | null;
  intervalMs: number | null;
  timezone: string;
  enabled: boolean;
  deleteAfterRun: boolean;
  maxRuntimeMs: number | null;
  notifyOn: NotifyOn;
  overlapPolicy: OverlapPolicy;
  consecutiveErrors: number;
  lastSessionId: string | null;
  namespace: string;
  createdAt: number;
  updatedAt: number;
  lastExecutedAt: number | null;
  nextExecutionAt: number | null;
  // 5-Layer Temporal Model
  operatingSchedule: string | null;
  exclusionSchedule: string | null;
  lifetimeStart: number | null;
  lifetimeEnd: number | null;
  eventCountLimit: number | null;
  eventCountCurrent: number;
  jitterMaxMs: number | null;
  heartbeatMode: boolean;
  standingOrders: string | null;
  preWorkInstructions: string | null;
  closingInstructions: string | null;
  ackMaxChars: number | null;
  rotationConfig: string | null;
  backoffConfig: string | null;
  runOnceAtCreation: boolean;
  dstAdjustment: string | null;
  // Session configuration
  sessionType: "simple" | "worktree";
  worktreeBranchName: string | null;
  // Server-enriched repo identity (resolved from projectDirectory)
  repoIdentity?: { name: string; url?: string };
};

export type TaskExecution = {
  id: string;
  taskId: string;
  sessionId: string | null;
  scheduledFor: number;
  startedAt: number | null;
  completedAt: number | null;
  status: ExecutionStatus;
  errorMessage: string | null;
  createdAt: number;
};

export type CreateScheduledTaskRequest = {
  name: string;
  emoji?: string;
  prompt: string;
  projectDirectory: string;
  scheduleType: ScheduleKind;
  cronExpression?: string;
  scheduledAt?: number;
  intervalMs?: number;
  timezone?: string;
  deleteAfterRun?: boolean;
  maxRuntimeMs?: number;
  notifyOn?: NotifyOn;
  overlapPolicy?: OverlapPolicy;
  // 5-Layer Temporal Model
  operatingSchedule?: string;
  exclusionSchedule?: string;
  lifetimeStart?: number;
  lifetimeEnd?: number;
  eventCountLimit?: number;
  jitterMaxMs?: number;
  heartbeatMode?: boolean;
  standingOrders?: string;
  preWorkInstructions?: string;
  closingInstructions?: string;
  ackMaxChars?: number;
  rotationConfig?: string;
  backoffConfig?: string;
  runOnceAtCreation?: boolean;
  dstAdjustment?: string;
  sessionType?: "simple" | "worktree";
  worktreeBranchName?: string;
};

export type UpdateScheduledTaskRequest = Partial<
  Omit<CreateScheduledTaskRequest, "maxRuntimeMs">
> & {
  enabled?: boolean;
  maxRuntimeMs?: number | null;
  eventCountCurrent?: number;
};

export type SchedulesResponse = { schedules: ScheduledTask[] };
export type ScheduleResponse = { schedule: ScheduledTask };
export type ExecutionHistoryResponse = {
  history: TaskExecution[];
  limit: number;
  offset: number;
};
export type ExecutionResponse = { execution: TaskExecution };

// Heartbeat types
export type HeartbeatConfig = {
  enabled: boolean;
  every: number;
  activeHours: {
    start: number;
    end: number;
    timezone: string;
  };
  instructionsFile: string;
  sessionDirectory: string;
  ackMaxChars: number;
  rotateAfterBeats: number;
  maxSessionAgeMs: number;
  machine?: string;
  sessionName?: string;
  sessionEmoji?: string;
  sessionType?: "simple" | "worktree";
  worktreeBranchName?: string;
};

export type HeartbeatStatus = {
  enabled: boolean;
  running: boolean;
  lastTickAt: number | null;
  nextTickAt: number | null;
  sessionId: string | null;
  beatsSinceRotation: number;
  consecutiveFailures: number;
  currentInterval: number;
  activeHoursActive: boolean;
};

export type HeartbeatHistoryEntry = {
  timestamp: number;
  success: boolean;
  skipped: boolean;
  skipReason?: string;
  responseLength?: number;
  suppressed?: boolean;
  durationMs: number;
  error?: string;
  sessionId: string | null;
  beatNumber: number;
};

export type HeartbeatConfigResponse = { config: HeartbeatConfig };
export type HeartbeatHistoryResponse = { history: HeartbeatHistoryEntry[] };
export type HeartbeatInstructionsResponse = { content: string };

// Error Log types
export type ErrorLogSeverity = "debug" | "info" | "warn" | "error" | "fatal";
export type ErrorLogSource = "server" | "client" | "cli";

export type ErrorLogEntry = {
  id: string;
  timestamp: number;
  severity: ErrorLogSeverity;
  category: string;
  source: ErrorLogSource;
  message: string;
  stack: string | null;
  sessionId: string | null;
  namespace: string | null;
  context: string | null;
  userAgent: string | null;
  requestPath: string | null;
  requestMethod: string | null;
  statusCode: number | null;
  /**
   * Issue #1244 finding #4: client-side enqueuedAt for replayed reports.
   * NULL on live POSTs. The existing `timestamp` field is the server-side
   * INSERT time, preserved unchanged. UI render of this field is OUT OF
   * SCOPE for #1244 — type plumbed end-to-end so a follow-up can add a
   * "Replayed (original X ago)" tag without re-touching schema.
   */
  originalTimestamp: number | null;
};

export type ErrorLogFiltersParam = {
  severity?: ErrorLogSeverity;
  category?: string;
  source?: ErrorLogSource;
  sessionId?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
};

export type ErrorLogListResponse = {
  entries: ErrorLogEntry[];
  count: number;
};

export type ErrorLogStatsResponse = {
  bySeverity: Record<string, number>;
};

// Federation types
export type FederationNodesResponse = {
  nodes: FederationNodeState[];
  role: "hub" | "node" | "peer";
  enabled: boolean;
  localNode: { nodeId: string; nodeLabel: string } | null;
};

export type FederationAllSessionsResponse = {
  sessions: SessionSummary[];
  nodes: Array<{
    nodeId: string;
    nodeLabel: string;
    status: FederationNodeStatus;
    url: string;
  }>;
};

// Telemetry types
export type TelemetrySummary = {
  byFile: Array<{ filePath: string; count: number }>;
  byType: Array<{ fileType: string; count: number }>;
};

export type TelemetryTimeseries = {
  buckets: Array<{ bucket: string; count: number }>;
};

export type TelemetryFile = {
  filePath: string;
  fileType: string;
  count: number;
  lastSeen: number;
};

export type TelemetryFilesResponse = {
  files: TelemetryFile[];
};

export type TelemetryDurationStats = {
  filePath: string;
  fileType: string;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  avgMs: number | null;
  maxMs: number | null;
  sampleCount: number;
};

export type TelemetryOutcomeRate = {
  filePath: string;
  fileType: string;
  totalCount: number;
  successCount: number;
  failureCount: number;
  errorCount: number;
  skipCount: number;
  blockCount: number;
  failureRate: number;
};

export type TelemetryAnomaly = {
  filePath: string;
  fileType: string;
  date: string;
  count: number;
  baselineMean: number;
  baselineStddev: number;
  zScore: number;
};

export type TelemetryPeriodComparison = {
  filePath: string;
  fileType: string;
  period1Count: number;
  period2Count: number;
  delta: number;
  deltaPercent: number | null;
};

/**
 * Measured per-skill context-load cost (issue #2154). Mirrors the server's
 * `SkillTokenEstimate`.
 *
 * Replaces the previous `estimatedTokensPerLoad`/`estimatedWeeklyTokens` pair,
 * which was derived from a per-fileType constant rather than measured — every
 * skill reported the same 2,250 tokens, so the numbers could rank skills only by
 * how often they ran, never by what they cost.
 *
 * `measured: false` (with null percentiles) means no token-bearing sample in the
 * window. Render it as unknown — never as 0, which would present the skill as
 * free.
 */
export type TelemetryTokenEstimate = {
  filePath: string;
  fileType: string;
  invocationCount: number;
  tokensP50: number | null;
  tokensP90: number | null;
  measured: boolean;
  sampleCount: number;
};

export type TelemetrySessionAggregate = {
  sessionId: string;
  totalEvents: number;
  uniqueFiles: number;
  archetype: string;
  startTime: number;
  endTime: number;
  hookCount: number;
  skillCount: number;
  agentCount: number;
  errorCount: number;
};

// MCP server status
export type { McpServerStatus, McpStatusUpdate };
export type {
  McpBatchOutcome,
  McpBatchSnapshot,
  McpToggleErrorCode,
  McpToggleRequest,
  McpToggleResponse,
} from "@hapi/protocol/types";
export type McpStatusResponse = {
  servers: McpServerStatus[];
  checkedAt: string | null;
  disabledServers?: string[];
};
export type McpSetDesiredResponse =
  | { ok: true; snapshot: import("@hapi/protocol/types").McpBatchSnapshot }
  | { ok: false; error: string; code: string };
export type McpBatchStateResponse = {
  snapshot: import("@hapi/protocol/types").McpBatchSnapshot | null;
};
