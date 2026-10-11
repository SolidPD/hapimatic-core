// SPDX-License-Identifier: AGPL-3.0-only
import type { SessionView, UiCollapseState } from "@hapi/protocol";

export type StoredSession = {
  id: string;
  tag: string | null;
  namespace: string;
  machineId: string | null;
  createdAt: number;
  updatedAt: number;
  metadata: unknown | null;
  metadataVersion: number;
  agentState: unknown | null;
  agentStateVersion: number;
  todos: unknown | null;
  todosUpdatedAt: number | null;
  active: boolean;
  activeAt: number | null;
  seq: number;
  notes: string | null;
  /** Issue #3286 (View Picker): server-persisted selected view (TEXT column). */
  persistedView: SessionView | null;
  promptDraft: string | null;
  emoji: string | null;
  timerData: string | null;
  serverAccumulatedMs: number;
  linkedIssue: {
    number: number;
    title: string;
    repo: string;
    state?: "open" | "closed";
  } | null;
  resolvedModel: string | null;
  contextWindowTokens: number | null;
  contextUsedTokens: number | null;
  contextPercentage: number | null;
  needsReviewOverride: "read" | "unread" | null;
  autoRecoverFromApiError: boolean | null;
  uiCollapseState: UiCollapseState | null;
  messageCount?: number;
  /** Branching: parent session ID (this session was forked from) */
  parentSessionId: string | null;
  /** #2479: relationship to parent — "branch" (forked) or "spawn" (managed peer) */
  parentRelationship: "branch" | "spawn" | null;
  /** Branching: user-provided label for this branch */
  branchLabel: string | null;
  /** Branching: timestamp when this branch was created */
  branchCreatedAt: number | null;
};

export type StoredMachine = {
  id: string;
  namespace: string;
  createdAt: number;
  updatedAt: number;
  metadata: unknown | null;
  metadataVersion: number;
  daemonState: unknown | null;
  daemonStateVersion: number;
  active: boolean;
  activeAt: number | null;
  seq: number;
};

export type StoredMessage = {
  id: string;
  sessionId: string;
  content: unknown;
  createdAt: number;
  seq: number;
  localId: string | null;
};

export type StoredUser = {
  id: number;
  platform: string;
  platformUserId: string;
  namespace: string;
  createdAt: number;
};

export type StoredPushSubscription = {
  id: number;
  namespace: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: number;
};

export type TimeLogEventType =
  | "flush"
  | "midnight-reset"
  | "manual"
  | "session-end"
  | "backfill";

export type StoredTimeLogEntry = {
  id: string;
  sessionId: string;
  sessionName: string;
  projectDirectory: string;
  date: string;
  durationMs: number;
  createdAt: number;
  namespace: string;
  /** Issue #1120: how the row was produced. NULL on legacy rows pre-migration. */
  eventType?: TimeLogEventType | null;
  /** Issue #1120: IANA timezone used to compute `date` at write time. */
  timezone?: string | null;
  /** Issue #1120: ms timestamp of the source midnight-reset SSE event (only set for midnight-reset rows). */
  resetEpoch?: number | null;
};

export type TimeLogFilters = {
  startDate?: string;
  endDate?: string;
  sessionId?: string;
  projectDirectory?: string;
  limit?: number;
};

export type DailySummary = {
  date: string;
  totalMs: number;
  sessionCount: number;
  entries: Array<{
    sessionId: string;
    sessionName: string;
    durationMs: number;
  }>;
};

export type WeeklySummary = {
  startDate: string;
  endDate: string;
  totalMs: number;
  dailyTotals: Array<{
    date: string;
    totalMs: number;
    sessionCount: number;
  }>;
};

export type ProjectGroupedSummary = {
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

export type VersionedUpdateResult<T> =
  | { result: "success"; version: number; value: T }
  | { result: "version-mismatch"; version: number; value: T }
  | { result: "error" };

export type ErrorLogSeverity = "debug" | "info" | "warn" | "error" | "fatal";
export type ErrorLogSource = "server" | "client" | "cli";

export type StoredErrorLog = {
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
  /** Issue #1244: client-side enqueuedAt for replayed reports. NULL on live POSTs. */
  originalTimestamp: number | null;
};

export type ErrorLogFilters = {
  severity?: ErrorLogSeverity;
  category?: string;
  source?: ErrorLogSource;
  sessionId?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
};

// File Conflict Monitor (Epic #1965, Sub A / #1966): per-session file claims.
export type FileClaimType = "expected" | "active";
export type FileClaimChangeKind = "edit" | "rename" | "move" | "delete";

export type StoredFileClaim = {
  id: string;
  sessionId: string;
  repo: string;
  path: string;
  claimType: FileClaimType;
  changeKind: FileClaimChangeKind;
  claimedAt: number;
  /** Null while the claim is live; set to the release timestamp on release. */
  releasedAt: number | null;
};

// File Conflict Monitor (Epic #1965, Sub G / #1972): predicted-vs-actual footprint accuracy.
export type StoredPredictionAccuracy = {
  id: string;
  repo: string;
  issue: string;
  /** Predicted footprint paths (deduped set), as stored. */
  predicted: string[];
  /** Actual footprint paths (deduped set), as stored. */
  actual: string[];
  precision: number; // 0..1
  recall: number; // 0..1
  recordedAt: number; // epoch ms
};

// Skill-revamp 3.1 (#2156, epic rp1-home#1319): the first-class initiative object —
// scope ref + session roster + token budget + current phase + an append-only event
// log. Store lives in `initiativeStore.ts` over the `initiatives`/`initiative_roster`/
// `initiative_events` tables. A CACHE over GitHub label truth, never authoritative.
export type InitiativePhase =
  | "planning"
  | "researching"
  | "implementing"
  | "reviewing"
  | "closing"
  | "done";

// The canonical event kinds at the API edge (zod-gated there). House rule K1: the
// DB `kind` column is unconstrained TEXT (no CHECK), so #2157/#2158 can append
// SUPERSET kinds via `appendEvent(kind: string)`. Stored rows therefore read back
// with `kind: string` (below), never a narrowed union.
export type InitiativeEventKind =
  | "initiative_created"
  | "session_attached"
  | "session_detached"
  | "phase_changed"
  | "budget_updated"
  | "reconciled"
  | "session_handoff";

/** One roster membership (camelCase view of an `initiative_roster` row). */
export type StoredInitiativeRosterEntry = {
  sessionId: string;
  attachedAtMs: number;
  /** Null while attached; set to the detach timestamp on detach. */
  detachedAtMs: number | null;
};

/** An initiative row (camelCase view of `initiatives`) with its roster embedded. */
export type StoredInitiative = {
  id: string;
  scopeRef: string;
  phase: InitiativePhase;
  tokenBudget: number | null;
  tokensSpent: number;
  roster: StoredInitiativeRosterEntry[];
  createdAtMs: number;
  /** Nullable to match the nullable `updated_at_ms` DDL (pm_spawn_roster precedent). */
  updatedAtMs: number | null;
  reconciledAtMs: number | null;
};

/** One append-only event (camelCase view of an `initiative_events` row). */
export type StoredInitiativeEvent = {
  id: string;
  initiativeId: string;
  // `string`, NOT `InitiativeEventKind` — the DB column is unconstrained (K1) and
  // superset kinds are valid. The route re-narrows via zod at the API edge.
  kind: string;
  payload: Record<string, unknown> | null;
  createdAtMs: number;
};

// Extension System Architecture (Epic #1264, Sub-Issue E / #1269): per-extension
// user preferences (enabled flag + arbitrary JSON config). Keyed by the extension
// manifest id (e.g. "builtin.notifications-push"). Canonical row-shape type; the
// store class in extensionPrefsStore.ts re-exports it so both import paths are valid.
export type StoredExtensionPref = {
  id: string;
  enabled: boolean;
  config: Record<string, unknown> | null;
  updatedAt: number;
};
