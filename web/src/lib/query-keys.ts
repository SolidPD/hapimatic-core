// SPDX-License-Identifier: AGPL-3.0-only
import { LOCAL_NODE_ID } from "@hapi/protocol";
export const queryKeys = {
  sessions: ["sessions"] as const,
  session: (sessionId: string) => ["session", sessionId] as const,
  messages: (sessionId: string) => ["messages", sessionId] as const,
  // Issue #2556: client-only cache of optimistic message bubbles
  // (sending/failed) that must survive a poll refetch of `messages`. The base
  // messages query replaces its pages with server-only messages on every poll,
  // which used to wipe attempted-and-failed sends; keeping optimistic bubbles in
  // this separate key (never fetched from the server) makes them refetch-proof.
  optimisticMessages: (sessionId: string) =>
    ["optimistic-messages", sessionId] as const,
  // #3559 (R6): per-issue approval-gate state for the server-driven approval card.
  // Keyed by session + challengeId (the issue number) so each gate polls its own
  // cache entry.
  approvalState: (sessionId: string, challengeId: string) =>
    ["approval-state", sessionId, challengeId] as const,
  machines: ["machines"] as const,
  // Account management (epic #1446 — multi-account OAuth switcher)
  accounts: ["accounts"] as const,
  voiceStatus: ["voice-status"] as const,
  account: (accountUuid: string) => ["account", accountUuid] as const,
  // #3808 Task 4b: an optional provider keys the PER-PROVIDER node default
  // separately, so the OpenAI/Google default caches never collide with the
  // Anthropic one. Absent ⇒ the 2-element Anthropic key (byte-identical to before).
  nodeActiveAccount: (nodeId: string, provider?: string) =>
    provider
      ? (["node-active-account", nodeId, provider] as const)
      : (["node-active-account", nodeId] as const),
  // Session capacity / max-concurrency (issue #1805)
  daemonCapacity: ["daemon-capacity"] as const,
  nodeMaxConcurrency: (nodeId: string) =>
    ["node-max-concurrency", nodeId] as const,
  // About page host-info + harness enumeration (issue #1983 B2 — consumer of
  // B3's /api/about; static per server-process lifetime, staleTime Infinity)
  about: ["about"] as const,
  // API Keys vault (issue #1955, epic #1954)
  apiKeys: ["api-keys"] as const,
  // Extension control plane — Admin → Extensions (issue #2329)
  extensionRegistry: ["extension-registry"] as const,
  // Configuration Porter — Admin → Configuration (issue #2344, epic #2339)
  porterInstalled: ["porter-installed"] as const,
  // Issue #3116: one installed file's content for the Configuration preview pane.
  porterContent: (dimension: string, name: string) =>
    ["porter-content", dimension, name] as const,
  porterRecipient: ["porter-recipient"] as const,
  // #4533: the Porter exposure probe (404 = withheld, fail-closed).
  porterStatus: ["porter-status"] as const,
  // #3446: per-token status for the tokenized one-liner export (poll fallback +
  // SSE-woken refetch). Keyed by token so each mint gets its own cache entry.
  porterTokenStatus: (token: string) => ["porter-token-status", token] as const,
  // Per-VM backup age identity — Admin → Backup Key (issue #2507, epic #2493)
  backupIdentityStatus: ["backup-identity-status"] as const,
  // Admin VM provisioning control plane — Admin → VMs (issue #2470, epic #2467)
  vmInventory: ["vm-inventory"] as const,
  vmPreflight: ["vm-preflight"] as const,
  // #2910: the operator-instance feedback-inbox gate (`GET /api/feedback/preflight`).
  feedbackPreflight: ["feedback-preflight"] as const,
  vmJobs: ["vm-jobs"] as const,
  vmJob: (jobId: string) => ["vm-job", jobId] as const,
  // Binary auto-update status (issue #1006, D999-10 control-plane push)
  updateStatus: ["update-status"] as const,
  // OpenRouter catalog + favorites (#1975)
  openRouterModels: ["openrouter-models"] as const,
  // Live Claude model catalog (#2456)
  claudeModels: ["claude-models"] as const,
  // Output-style catalog for the Create-page selector (#2626 D)
  outputStyles: ["output-styles"] as const,
  // Harness capability-manifest catalog for the Create-page disclosure chips
  // (#3121, epic #3117 Sub E). Static per server-process lifetime.
  harnessManifests: ["harness-manifests"] as const,
  // Harness self-update panel (epic #1769 Sub-Issue D — #1773). Keyed per harness +
  // version-range so a newer version's analysis invalidates cleanly. The changelog
  // key carries no range — #1771's endpoint computes the span server-side from
  // detection state; the 30s status poll drives changelog invalidation on a version
  // change.
  harnessUpdates: ["harness-updates"] as const,
  harnessChangelog: (harnessId: string) =>
    ["harness-changelog", harnessId] as const,
  harnessAnalysis: (harnessId: string, range: string) =>
    ["harness-analysis", harnessId, range] as const,
  openRouterFavorites: ["openrouter-favorites"] as const,
  // Per-account usage history (epic #1855, Sub I — #1864)
  usageHistory: (accountUuid: string) =>
    ["usage-history", accountUuid] as const,
  // Per-account usage dashboard (epic #1855, Sub D — issue #1859)
  accountUsage: ["account-usage"] as const,
  // Non-Anthropic provider auth-state (Codex/Gemini) for the Accounts page's
  // OpenAI + Google Gemini sections (issue #3806, epic #3345). The key #3807
  // invalidates after a successful in-app add (K9).
  providerAuthState: ["provider-auth-state"] as const,
  // Per-node account health (issue #4461, epic #4460 A) — the read #4462/#4464/
  // #4466 consume; a re-login on a node should invalidate it.
  accountHealth: ["account-health"] as const,
  // Admin session-metadata query surface (epic #1662, Sub M — issue #1675)
  sessionMetadataTurns: (filters: Record<string, unknown>) =>
    ["session-metadata-turns", JSON.stringify(filters ?? {})] as const,
  sessionMetadataFilterOptions: ["session-metadata-filter-options"] as const,
  // Transcript browser (issue #3839)
  transcripts: (filters: Record<string, unknown>) =>
    ["transcripts", JSON.stringify(filters ?? {})] as const,
  transcriptFilterOptions: ["transcript-filter-options"] as const,
  transcriptMessages: (ccSessionId: string) =>
    ["transcript-messages", ccSessionId] as const,
  transcriptToolResult: (ccSessionId: string, seq: number) =>
    ["transcript-messages", ccSessionId, "full", seq] as const,
  // #4386 background-agent peek.
  agentTranscript: (sessionId: string, agentId: string) =>
    ["agent-transcript", sessionId, agentId] as const,
  agentToolResult: (sessionId: string, agentId: string, seq: number) =>
    ["agent-transcript", sessionId, agentId, "full", seq] as const,
  federationTurnAggregate: (from?: number, to?: number, limit?: number) =>
    [
      "federation-turn-aggregate",
      from ?? "all",
      to ?? "all",
      limit ?? "default",
    ] as const,
  // Server-side chat bookmarks (issue #3115) — per-session, node-local.
  bookmarks: (sessionId: string) => ["bookmarks", sessionId] as const,
  gitStatus: (sessionId: string) => ["git-status", sessionId] as const,
  sessionFiles: (sessionId: string, query: string) =>
    ["session-files", sessionId, query] as const,
  sessionFile: (sessionId: string, path: string) =>
    ["session-file", sessionId, path] as const,
  // issue #2518: session-scoped directory listing for the VM file browser.
  sessionDirectory: (sessionId: string, path: string) =>
    ["session-directory", sessionId, path] as const,
  gitFileDiff: (sessionId: string, path: string, staged?: boolean) =>
    ["git-file-diff", sessionId, path, staged ? "staged" : "unstaged"] as const,
  slashCommands: (sessionId: string) => ["slash-commands", sessionId] as const,
  gitRemoteUrl: (sessionId: string) => ["git-remote-url", sessionId] as const,
  timeLogs: (filters?: { date?: string; projectDirectory?: string }) =>
    [
      "time-logs",
      filters?.date ?? "all",
      filters?.projectDirectory ?? "all",
    ] as const,
  timeLogDailySummary: (date?: string) =>
    ["time-log-daily-summary", date ?? "today"] as const,
  timeLogProjectGrouped: (startDate: string, endDate: string) =>
    ["time-log-project-grouped", startDate, endDate] as const,
  timeLogProjects: ["time-log-projects"] as const,
  // Issue #1670 (PR-2): "time-log" prefix so the timer-reset invalidation
  // predicate (useSSE.ts) + the control mutations both cover these keys.
  timeLogCutoverStatus: ["time-log-cutover-status"] as const,
  timeLogDerived: (startDate: string, endDate: string) =>
    ["time-log-derived", startDate, endDate] as const,
  timeLogAdjustments: ["time-log-adjustments"] as const,
  schedules: ["schedules"] as const,
  schedule: (id: string) => ["schedule", id] as const,
  scheduleHistory: (id: string) => ["schedule-history", id] as const,
  // System jobs (epic #1534 Sub-Issue D — node-aware admin section)
  systemJobs: ["system-jobs"] as const,
  // Issue #2453: the header badge's own-instance session→loop summary (30s poll).
  sessionLoopSummaries: ["session-loop-summaries"] as const,
  heartbeatConfig: ["heartbeat-config"] as const,
  heartbeatStatus: ["heartbeat-status"] as const,
  heartbeatHistory: ["heartbeat-history"] as const,
  heartbeatInstructions: ["heartbeat-instructions"] as const,
  federationNodes: ["federation-nodes"] as const,
  federationAllSessions: ["federation-all-sessions"] as const,
  // File Conflict Monitor (#1971): per-repo live claims + umbrella recompute key.
  fileClaims: (repo: string) => ["file-claims", repo] as const,
  fileConflicts: ["file-conflicts"] as const,
  // #2815: deliberately OUTSIDE the ["file-claims"] prefix — useSSE.ts
  // invalidates that prefix on EVERY session event, and history is an
  // on-demand forensic view, not a live surface.
  fileClaimHistory: (days: number) => ["file-claim-history", days] as const,
  // Federation health (issue #1445; consumed by #1040 / #1037 / #1444)
  federationHealthAggregate: ["federation-health-aggregate"] as const,
  federationNodeHealth: (nodeId: string) =>
    ["federation-node-health", nodeId] as const,
  // Federation health — batch per-node + alerts feed (issue #1037 / #1632)
  federationHealthNodes: ["federation-health-nodes"] as const,
  federationAlerts: (nodeId?: string) =>
    ["federation-alerts", nodeId ?? "all"] as const,
  // Per-node health detail with 404/503 error taxonomy (issue #1444). Distinct
  // from `federationNodeHealth` so the detail view's taxonomy-aware
  // `useNodeHealth` observer never merges options with #1037's plain
  // `useFederationNodeHealth` observer.
  nodeHealth: (nodeId: string) => ["node-health", nodeId] as const,
  errorLogs: (filters?: {
    severity?: string;
    source?: string;
    startTime?: number;
  }) =>
    [
      "error-logs",
      filters?.severity ?? "all",
      filters?.source ?? "all",
      filters?.startTime ?? "all",
    ] as const,
  errorLogStats: ["error-log-stats"] as const,
  // Admin Feedback viewer (issue #2666, epic #2663 Sub C) — paginated list of
  // persisted feedback rows from `GET /api/feedback`.
  feedbackList: (limit: number, offset: number) =>
    ["feedback-list", limit, offset] as const,
  // Issue #4371: in-app support channel info from `GET /api/support/channel`.
  supportChannel: ["support-channel"] as const,
  searchFilterPreferences: ["search-filter-preferences"] as const,
  mcpStatus: (projectDir?: string) =>
    ["mcp-status", projectDir ?? "global"] as const,
  mcpBatchState: (sessionId: string) => ["mcp-batch-state", sessionId] as const,
  repoIssues: (directory: string, nodeId?: string) =>
    ["repo-issues", directory, nodeId ?? LOCAL_NODE_ID] as const,
  // hapimatic-private#4481: Create-page Branch control listing.
  gitBranches: (directory: string, nodeId?: string) =>
    ["git-branches", directory, nodeId ?? LOCAL_NODE_ID] as const,
  githubIssue: (owner: string, repo: string, number: number) =>
    ["github-issue", owner, repo, number] as const,
  // Issue #1953 (A6): GitHub-account selector → repo picker.
  githubAccounts: (nodeId?: string | null) =>
    ["github-accounts", nodeId ?? LOCAL_NODE_ID] as const,
  githubRepos: (account: string | null, nodeId?: string | null) =>
    ["github-repos", account ?? "none", nodeId ?? LOCAL_NODE_ID] as const,
  telemetrySummary: (fileType?: string, startTime?: number) =>
    ["telemetry-summary", fileType ?? "all", startTime ?? "all"] as const,
  telemetryTimeseries: (interval: string, filePath?: string) =>
    ["telemetry-timeseries", interval, filePath ?? "all"] as const,
  telemetryFiles: (fileType?: string) =>
    ["telemetry-files", fileType ?? "all"] as const,
  telemetryDurationStats: (fileType?: string) =>
    ["telemetry-duration-stats", fileType ?? "all"] as const,
  telemetryOutcomeRates: (fileType?: string) =>
    ["telemetry-outcome-rates", fileType ?? "all"] as const,
  telemetryAnomalies: () => ["telemetry-anomalies"] as const,
  telemetryComparison: (p1s: number, p1e: number, p2s: number, p2e: number) =>
    ["telemetry-comparison", p1s, p1e, p2s, p2e] as const,
  telemetryTokenEstimates: (fileType?: string, startTime?: number) =>
    [
      "telemetry-token-estimates",
      fileType ?? "all",
      startTime ?? "all",
    ] as const,
  telemetrySessionAggregates: (startTime?: number) =>
    ["telemetry-session-aggregates", startTime ?? "all"] as const,
  // Harness Scorecard — Settings → Harness Scorecard (issue #3128, epic #3117
  // Sub N). Per-(skill × harness × model) evidence rollup.
  harnessScorecard: ["harness-scorecard"] as const,
  // Capability panel — Settings → Capabilities (issue #3752, epic #3740). Two
  // read-only queries: the live scope-filtered catalog + the runtime self-audit.
  capabilityCatalog: ["capability-catalog"] as const,
  capabilityAudit: ["capability-audit"] as const,
  // Issue #1325: server-backed message queue per session.
  queue: (sessionId: string) => ["queue", sessionId] as const,
  // Issue #1671 (epic #1662, Sub I): server-authoritative per-session token stats.
  sessionTokenStats: (sessionId: string) =>
    ["session-token-stats", sessionId] as const,
  // Issue #1672 (epic #1662, Sub J): per-session workflow-state badge + chips.
  sessionWorkflowState: (sessionId: string) =>
    ["session-workflow-state", sessionId] as const,
  // Harness self-update — poll cadence config (#1775, Sub F, epic #1769). The
  // panel's detection-status query is #1773's `harnessUpdates` key (above);
  // #1775's "Check now" invalidates that to refresh the panel + last-checked.
  harnessPollConfig: ["harness-poll-config"] as const,
};
