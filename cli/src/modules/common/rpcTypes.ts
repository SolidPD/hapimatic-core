// SPDX-License-Identifier: AGPL-3.0-only
export interface SpawnSessionOptions {
  machineId?: string;
  directory: string;
  sessionId?: string;
  approvedNewDirectoryCreation?: boolean;
  agent?: "claude" | "codex" | "gemini" | "opencode";
  yolo?: boolean;
  /** Issue #1262: opt-in to spawn-time port claim (default false). When
   *  false/omitted, worktree creation writes `claimed_port: null` and the
   *  port is claimed later via `scripts/hapi-worktree.sh claim` at the time
   *  a Hapimatic instance is actually deployed. */
  claimPort?: boolean;
  /** Issue #1555: when false, the daemon returns spawn success once the child
   *  process has STARTED (waitForAnyChild) rather than waiting for the full
   *  "I'm alive" webhook. Used by reconnect-style respawns (account switch /
   *  token-refresh restart) whose success does not depend on the webhook — the
   *  cold MCP load then finishes asynchronously. Default true = legacy
   *  full-boot gate (new-session / fork / scheduler spawns). */
  awaitWebhook?: boolean;
  token?: string;
  sessionType?: "simple" | "worktree";
  worktreeName?: string;
  /** hapimatic-private#4481: open the worktree on this EXISTING branch (no `-b`).
   *  Implies `sessionType: "worktree"`; `worktreeName` is ignored when set. */
  existingBranch?: { name: string; remote: boolean };
  /** Claude session ID to resume (for reconnecting to an existing conversation) */
  resumeSessionId?: string;
  /** HAPI session ID to reuse (for reconnecting within the same session instance) */
  hapiSessionId?: string;
  /** Session display name — used as tmux window name and worktree branch hint */
  name?: string;
  /** Fork the Claude session (create new session ID with full conversation history) */
  forkSession?: boolean;
  /** Parent Hapimatic session ID (set when branching to link child to parent) */
  parentSessionId?: string;
  /** #2479: relationship to the parent — "branch" (forked) or "spawn" (managed peer) */
  parentRelationship?: "branch" | "spawn";
  /** Federation: nodeId of the peer that initiated this spawn (dual-node visibility) */
  originatingNodeId?: string;
  /** Multi-account (epic #1446, Sub-Issue J): account to bind the spawned
   *  process to via HAPI_ACCOUNT_UUID (daemon sets the env; D's launcher
   *  injection resolves the token). Absent → host-credential fallback. */
  accountUuid?: string;
  /** Issue #4568: bill the session to the node-vault Anthropic API key with this
   *  id (never key material). Mutually exclusive with `accountUuid`. The daemon
   *  verifies the vault entry, binds no account / instance token, forces the SDK
   *  launcher, and delivers HAPI_API_KEY_ID + HAPI_API_KEY_MASKED to the wrapper,
   *  which checks the binding at each launch (`verifyApiKeyForSession`); Claude
   *  Code reads the key itself through the session's `apiKeyHelper`. */
  apiKeyId?: string;
  /** Issue #4568: the masked form recorded at the first spawn — set on a respawn
   *  so a key replaced under the same vault id is refused when its last four
   *  characters differ. A replacement ending in the same four characters is not
   *  detected (the mask is the only fingerprint recorded). */
  apiKeyMasked?: string;
  /** Issue #1633: launch the claude child with --safe-mode (CLAUDE.md, skills,
   *  hooks, MCP customizations disabled). Hapimatic's own injections are
   *  suppressed by the launchers when the flag is present in claudeArgs. */
  safeMode?: boolean;
  /** Issue #1660: per-session launcher override (sdk | tmux | pty). The daemon
   *  injects it as HAPI_CLAUDE_LAUNCHER on the spawned process env so the
   *  resolver's env tier wins per-session. Typed as string here (mirrors
   *  modelMode) to avoid a cross-package union import; validated upstream by
   *  ClaudeRemoteLauncherKindSchema. */
  launcher?: string;
  /** Issue #1633: explicit model mode ("sonnet" | "opus" | "fable") threaded
   *  as `--hapi-model-mode <mode>` so a model-switch respawn preserves the
   *  user's explicit selection across the restart. */
  modelMode?: string;
  /** Issue #1733: free-form gateway model id ("provider/model", e.g.
   *  "openai/gpt-4o") for an OpenRouter-routed Codex session. Distinct from
   *  modelMode (the Claude sonnet|opus|fable axis) — do NOT conflate. Threaded
   *  field-by-field through every spawn hop (the #1262 trap); any un-enumerated
   *  hop silently drops it (guarded by syncEngine.spawnModel.test.ts). */
  model?: string;
  /** Issue #3349 (ruling D4(a)): native-vs-OpenRouter routing discriminator for
   *  an opencode spawn. `"native"` → sessionSpawner treats `model` above as a
   *  native `provider/model` and resolves the provider's key from the #1955
   *  apiKeys vault; `"openrouter"`/absent → the OpenRouter gateway branch
   *  (absent = today's model-presence-means-OpenRouter semantics, R6 skew-safe).
   *  Inline literal union (self-contained, no cross-package import — same rule as
   *  modelMode above); validated upstream by machines.ts / federation.ts. */
  modelRouting?: "native" | "openrouter";
  /** Issue #2456: reasoning-effort level ("low"|"medium"|"high"|"xhigh"|"max")
   *  threaded as `--hapi-effort <level>` so a model/effort-switch respawn
   *  preserves the user's selection. Reaches the claude child as `--effort`
   *  (accepted natively by the binary). Typed as string here (mirrors modelMode)
   *  to avoid a cross-package import; validated upstream by EffortLevelSchema.
   *  Threaded field-by-field through every spawn hop (the #1262 trap); any
   *  un-enumerated hop silently drops it (guarded by syncEngine.spawnEffort.test.ts). */
  effort?: string;
  /** Issue #2456: a specific pinned raw Claude model id ("claude-opus-4-6")
   *  selected via "More models". The Claude `--model` axis — distinct from the
   *  gateway `model` field above (OpenRouter/Codex) and from `modelMode` (the
   *  family quick-pick). Threaded as `--hapi-raw-model <id>`; takes precedence
   *  over `modelMode` in runClaude's currentModel resolution. Threaded
   *  field-by-field through every spawn hop (the #1262 trap); any un-enumerated
   *  hop silently drops it (guarded by syncEngine.spawnEffort.test.ts). */
  rawModel?: string;
  /** Issue #1953 (A6): clone-on-spawn repo ("owner/repo"). When set, the daemon
   *  clones it into the working directory before launching the agent. Threaded
   *  field-by-field through every spawn hop (the #1262 trap); any un-enumerated
   *  hop silently drops it (guarded by syncEngine.spawnClone.test.ts). */
  cloneRepo?: string;
  /** Issue #2155: role-scoped `@`-include profile ("pm" | "worker" |
   *  "researcher" | "closer" | "interactive"). The daemon threads it to the
   *  claude child as --hapi-session-role (runClaude merges the role's
   *  claudeMdExcludes) and injects HAPI_SESSION_ROLE. Threaded field-by-field
   *  through every spawn hop (the #1262 trap); any un-enumerated hop silently
   *  drops it (guarded by syncEngine.spawnRole.test.ts). */
  sessionRole?: string;
  /** Issue #2626 (D): per-session output style name ("default" | "Explanatory"
   *  | "Learning" or a custom style). The daemon threads it to the claude child
   *  as --hapi-output-style; runClaude injects it into the generated --settings
   *  file (the choke point every launcher delivers). Threaded field-by-field
   *  through every spawn hop (the #1262 trap); any un-enumerated hop silently
   *  drops it (guarded by apiMachine.spawnOutputStyle.test.ts). */
  outputStyle?: string;
  /** Issue #3348: bundled non-claude native model selection. `modelId` is the
   *  gemini model id (the daemon sets `GEMINI_MODEL` in the gemini spawn env) OR
   *  the codex ChatGPT-token model id (the daemon bakes it into
   *  `CODEX_HOME/config.toml` on BOTH spawn paths); `reasoningEffort` is codex's
   *  `model_reasoning_effort`. Interpreted by AGENT in sessionSpawner. Threaded
   *  field-by-field through every spawn hop (the #1262 trap); any un-enumerated
   *  hop silently drops it (guarded by apiMachine.spawnNativeModel.test.ts). */
  nativeModelSelection?: { modelId?: string; reasoningEffort?: string };
  /** Scheduler: schedule UUID for the task that spawned this session */
  scheduleId?: string;
  /** Absolute path to vanilla Claude CLI on this node (issue #933) */
  claudePath?: string;
  /** Issue #1661: when reconnecting into a REUSED tmux window, whether the
   *  spawn is permitted to `respawn-pane -k` (kill) whatever occupies the pane.
   *  Default true preserves switch/token-refresh/model-restart semantics (they
   *  intentionally replace a live process). reconnectSession passes `false` ONLY
   *  when the daemon-authoritative `is-session-alive` RPC was uncertain (null),
   *  so the adapter does a fresh daemon-local liveness re-check before killing —
   *  a genuinely-live wrapper is re-attached, never respawn-killed. Threaded
   *  field-by-field through the spawn RPC (the #1262 trap), so any un-enumerated
   *  hop silently drops it. */
  killLivePane?: boolean;
  /** Issue #3632: the OWNING SERVER's `messageHooksEnabled()` snapshot at spawn
   *  time (server env `HAPI_MESSAGE_HOOKS`), threaded to the daemon so it can
   *  export the literal `HAPI_MESSAGE_HOOKS=1|0` marker into the spawned child
   *  env. `boolean | undefined` end-to-end: `undefined` is MEANINGFUL — it means
   *  the server did not stamp a value (daemon-local spawn, or a rolling-deploy
   *  window where an old server talks to a new daemon), and the daemon then OMITS
   *  the marker entirely (never `"0"`) so the rp1-home mint fallback DEFERS
   *  (fail-closed). Threaded field-by-field through every spawn hop (the #1262
   *  trap); any un-enumerated hop silently drops it (guarded by
   *  apiMachine.spawnMessageHooks.test.ts). */
  messageHooksEnabled?: boolean;
  /** Issue #3611: the resolved `autoSelectOptimalAccount` opt-in (the server's
   *  preference-mirror snapshot at spawn time), threaded to the daemon so the
   *  un-pinned spawn resolver (`selectHealthyAccount.ts`) may bind the lowest
   *  served-score healthy account. `boolean | undefined`: `undefined`/`false` ⇒
   *  NO pick — #3023's decision is byte-identical to today (R3). The daemon-local
   *  `/spawn-session` bypass carries no payload, so it is `undefined` there
   *  (deliberate scope-out). Threaded field-by-field through every spawn hop (the
   *  #1262 trap); any un-enumerated hop silently drops it. */
  autoSelectOptimalAccount?: boolean;
}

export type SpawnSessionResult =
  | { type: "success"; sessionId: string; resolvedName?: string }
  | { type: "requestToApproveDirectoryCreation"; directory: string }
  // Issue #1772: optional error classifier (e.g. "at_capacity"). Optional so
  // every existing error producer stays valid; enumerated hop-by-hop on the
  // return path (the #1262 field-by-field trap drops un-listed fields).
  | { type: "error"; errorMessage: string; code?: string };

// --- Force-refresh harness (issue #1547) ----------------------------------------
// Control-payload + report types for the daemon `/force-refresh-account` endpoint,
// driven by `hapi accounts force-refresh <uuid>`. Lives here (alongside
// SpawnSessionOptions/Result) so the daemon (controlServer), the CLI client
// (controlClient), the harness orchestrator (accounts/forceRefreshHarness), and the
// command (commands/accounts) all consume ONE definition.

/** Request body for the daemon `/force-refresh-account` control endpoint. */
export interface ForceRefreshAccountOptions {
  accountUuid: string;
}

/**
 * Tally of the daemon's `restartBoundSessions(accountUuid)` pass — the result of
 * step 3/4 of the force-refresh chain. `skipped` is true when the per-account
 * in-flight guard short-circuited (another restart for the same account was
 * already running — e.g. the scheduler's onSuccessfulRefresh callback). Counts
 * reflect the FIRST restart attempt per bound session; a `busy` (HTTP 202) session
 * still retries in the background but is reported as busy without awaiting it.
 */
export interface RestartSummary {
  skipped: boolean;
  boundCount: number;
  restarted: number;
  busy: number;
  failed: number;
  errors: string[];
}

/** One asserted step in the force-refresh chain (OAuth fetch, store delta, restart). */
export interface ForceRefreshStep {
  name: string;
  status: "pass" | "fail" | "skipped";
  detail: string;
}

/**
 * Full per-step result of a `hapi accounts force-refresh <uuid>` run. Returned by
 * the daemon endpoint and rendered by the CLI (human table or `--json`).
 * `overall`:
 *  - `pass`     — OAuth fetch + all store-delta assertions passed
 *  - `fail`     — OAuth fetch failed (e.g. invalid_grant) or a delta assertion failed
 *  - `deferred` — host-default account (#1520); not refreshable by Hapimatic (NOT a failure)
 *  - `not-found`— no such account in the store
 * `tokenRotated`/`crossInstanceResyncNeeded` flag a successful non-host rotation
 * that staled the same account's stored copy in other Hapimatic instances (R6).
 */
export interface ForceRefreshReport {
  accountUuid: string;
  emailAddress?: string;
  overall: "pass" | "fail" | "deferred" | "not-found";
  durationMs: number;
  steps: ForceRefreshStep[];
  tokenRotated?: boolean;
  crossInstanceResyncNeeded?: boolean;
  warnings: string[];
}

// --- Session liveness RPC (issue #1661) -----------------------------------------
// Request/response for the daemon `is-session-alive` RPC. Used by the server's
// reconnectSession (re-attach gate) and the 5-min force-kill watchdog to ask the
// daemon whether a tmux-launcher session's launcher wrapper + tmux pane are
// actually alive BEFORE deciding to respawn (kill) it. The daemon holds the
// authoritative liveness signal (`pidToTrackedSession` + `tmux.isPaneDead`); the
// server's `active` flag is the unreliable 10s-trip-wire that caused the bug.

/** Request body for the daemon `is-session-alive` RPC. */
export interface IsSessionAliveRequest {
  /** The HAPI session tag (hapiSessionId), e.g. "hapi-1234567890-abc123". */
  sessionTag: string;
}

/**
 * Response from the daemon `is-session-alive` RPC. Three-valued, mirroring the
 * null-tolerance of `hasClaudeConversation` (#1396):
 *  - `true`  — the session's wrapper is tracked in `pidToTrackedSession` AND its
 *              tmux pane is not dead → genuinely alive; the caller MUST re-attach
 *              and MUST NOT respawn/kill the process.
 *  - `false` — the session is untracked OR its pane is dead → the caller may
 *              respawn (a dead session's pane usually holds a live `; exec bash`
 *              shell that must be forcibly respawned).
 *  - `null`  — liveness is UNCERTAIN (RPC fault, daemon offline, malformed
 *              response). The caller MUST NOT block recovery — it falls through
 *              to the respawn path with a fresh daemon-local re-check
 *              (Fallback Preservation Rule).
 */
export interface IsSessionAliveResponse {
  alive: boolean | null;
}
