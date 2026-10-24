// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Central CapabilityMeta constants (issue #2417, epic #2416).
 *
 * Each capability's zod input/output schema is the single source of truth here;
 * the wire JSON Schema is derived mechanically via zod v4's native
 * `z.toJSONSchema()` (KD-1 — the `zod-to-json-schema` package is a zod-v3-era,
 * unmaintained library and is deliberately NOT a dependency).
 *
 * Defining the constants once (KD-3) means #2421's fleet-wide launcher
 * migration is a reference-swap at each `registerHandler` call site, not a
 * rewrite of inline meta objects.
 */
import { z } from "zod";
import type { CapabilityMeta } from "./types";

const abortInput = z.object({});
const mcpToggleInput = z.object({
  serverName: z.string(),
  enabled: z.boolean(),
});

/**
 * `abort` — aborts the current Claude turn, clears the queue, and switches the
 * session to remote mode. `mutating` (NOT `readonly`): it changes session
 * state, so the readonly-only generic invoke path in #2419 must NOT pick it up.
 */
export const ABORT_META: CapabilityMeta = {
  description:
    "Abort the current Claude turn, clear the queue, and switch the session to remote mode.",
  inputSchema: z.toJSONSchema(abortInput),
  riskTier: "mutating",
  since: "2026-07-27",
};

/**
 * `mcp-toggle` — enable or disable an MCP server for the running session.
 * Truthful-description note (expert-review 1B-3): the functional toggle lives
 * in the remote-launcher path; the local-launcher handler this constant
 * annotates is `createLocalModeRejectionHandler()`, which REJECTS in local mode
 * (callers fall back to `/mcp enable|disable` in the session UI). `mutating`.
 */
export const MCP_TOGGLE_META: CapabilityMeta = {
  description:
    "Enable or disable an MCP server for the running session. Functional in remote mode; local mode rejects with LOCAL_MODE_NOT_SUPPORTED.",
  inputSchema: z.toJSONSchema(mcpToggleInput),
  riskTier: "mutating",
  since: "2026-07-27",
};

// ── Issue #2421 (epic #2416, Sub-Issue E) — control-backlog migration ─────────
// The first three capabilities migrated through the registry. `get-context-usage`
// and `mcp-status` are pure reads (readonly → generically invocable); `set-model`
// changes session state (mutating → enumerable-with-meta but blocked by #2419's
// readonly-only gate, the deliberate enumerable-but-not-invocable demonstration).
// `mcp_reconnect` was DROPPED (expert-review ruling 1B-29): zero implementation
// exists repo-wide, and advertising meta for vaporware would make the registry lie.

const getContextUsageInput = z.object({});
const setModelInput = z.object({
  // Model family/mode: "sonnet" | "opus" | "fable" | "default" (kept a bare
  // string here to avoid coupling the meta module to ModelModeSchema's enum —
  // the handler validates via resolveModelMode at runClaude.ts).
  modelMode: z.string(),
});

// Slim shape of Query.getContextUsage()'s ContextUsagePayload (cli/src/claude/
// sdk/types.ts) — documents the `usage` field the handler returns on success.
const contextUsagePayloadSchema = z.object({
  model: z.string(),
  maxTokens: z.number(),
  rawMaxTokens: z.number(),
  totalTokens: z.number(),
  percentage: z.number(),
});

/**
 * `get-context-usage` — the session's live context-window usage (model,
 * effective window, live token count + percentage). `readonly`: a pure read
 * that returns the payload; the handler wraps the already-built
 * `Query.getContextUsage()` (issue #1469) and returns a CLI-shaped
 * `no_active_query` when the session is idle.
 */
export const GET_CONTEXT_USAGE_META: CapabilityMeta = {
  description:
    "Live context-window usage for this session: active model, effective context window, live token count and usage percentage. Returns { ok: true, usage } on success, or a { ok: false, code: 'no_active_query' } response when the session is idle.",
  inputSchema: z.toJSONSchema(getContextUsageInput),
  outputSchema: z.toJSONSchema(contextUsagePayloadSchema),
  riskTier: "readonly",
  since: "2026-08-08",
};

/**
 * `mcp-status` — the session's live MCP server status, read from the existing
 * live source (`pollMcpStatus`, which shells `claude mcp list` in the session's
 * cwd). `readonly`. outputSchema is intentionally omitted: the canonical
 * `McpStatusUpdateSchema` (shared/src/schemas.ts) is not re-exported from
 * `@hapi/protocol`, and outputSchema is documentation-only (the invoke gate
 * validates input, never output) — so duplicating the schema here would only
 * invite drift.
 */
export const MCP_STATUS_META: CapabilityMeta = {
  description:
    "Live MCP server status for this session — each configured server's connection state (connected/failed/needs_auth/hosted), read from `claude mcp list`. Readonly.",
  inputSchema: z.toJSONSchema(z.object({})),
  riskTier: "readonly",
  since: "2026-08-08",
};

/**
 * `set-model` — change the session's model family/mode. `mutating`: it changes
 * session state, so the #2419 readonly-only invoke gate BLOCKS it with
 * `tier_not_invocable`. It is registered purely so the capability is
 * DISCOVERABLE via enumeration (the registry's value even where invocation
 * stays gated); a future promotion to the generic invoke path is a reviewed
 * change to `INVOCABLE_TIERS`, not something this registration grants.
 */
export const SET_MODEL_META: CapabilityMeta = {
  description:
    'Set the session\'s model family/mode (sonnet | opus | fable | default). Applies a durable model pin AND, when a live SDK query is present, reaches it out-of-band via the set_model control_request (method:"sdk"; method:"config" when no live query). Mutating — enumerable for discovery but blocked by the readonly invoke gate (tier_not_invocable); promotion to generic invoke is a future reviewed change.',
  inputSchema: z.toJSONSchema(setModelInput),
  riskTier: "mutating",
  since: "2026-08-08",
};

// ── Issue #3745 (epic #3740, Sub-Issue E) — full cli-side surface ─────────────
// Real CapabilityMeta for every remaining live RPC method — #3742's named
// allowlist (scripts/capability-meta-allowlist.json) is now drained to EMPTY and
// DELETED, so the #3742 registrations guard is ABSOLUTE (R11). 🔒 THE `riskTier`
// FIELD IS
// THE ONLY VALUE WITH SECURITY EFFECT: `isInvocable` (server/src/web/routes/
// capabilityPolicy.ts:41-45) reads `riskTier` ALONE over `INVOCABLE_TIERS =
// {"readonly"}` — the method name is NEVER a parameter. So in this codebase
// `readonly` is not a description, it is a PROMOTION onto the generic
// `hapi_invoke` path. That is why every filesystem/exec/git tool-group method
// below is `mutating`/`destructive` EVEN when it is a semantically pure read
// (readFile, ripgrep, git-*, listDirectory, …): tagging any of them `readonly`
// would model-face a fs-content-bearing or shell RPC (R4 / ER D3). Do NOT
// "correct" a tool-group read back to `readonly` — the V4 test over
// TOOL_GROUP_METHODS (cli/src/api/rpc/toolGroup.ts) guards against exactly that.
// Tiers for the 14 inventory-covered methods are seeded from
// claudedocs/capability-inventory.md; the rest are fresh classifications.

// ── Session-control methods (session-scoped, launcher-registered) ────────────

const switchInput = z.object({});
/**
 * `switch` — switch the session between local (terminal PTY) and remote (mobile
 * WebSocket) mode. `mutating` (inventory-seeded): it changes the session's live
 * I/O mode, so the readonly-only invoke gate must NOT pick it up.
 */
export const SWITCH_META: CapabilityMeta = {
  description:
    "Switch the session between local (terminal) and remote (mobile) mode. Mutating — changes the session's live I/O mode.",
  inputSchema: z.toJSONSchema(switchInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

const setPermissionModeInput = z.object({
  // Claude permission mode: "default" | "acceptEdits" | "plan" |
  // "bypassPermissions" (kept a bare string here to avoid coupling the meta
  // module to PermissionModeSchema — the handler validates at runtime).
  mode: z.string(),
});
/**
 * `set-permission-mode` — change the session's Claude permission mode. `mutating`
 * (fresh classification): it changes session permission state, so the
 * readonly-only invoke gate blocks it (tier_not_invocable). Functional in remote
 * (sdk) mode; the pty/tmux/local launchers register a local-mode rejection.
 */
export const SET_PERMISSION_MODE_META: CapabilityMeta = {
  description:
    "Set the session's Claude permission mode (default | acceptEdits | plan | bypassPermissions). Functional in remote (sdk) mode; local/pty/tmux modes reject with LOCAL_MODE_NOT_SUPPORTED. Mutating.",
  inputSchema: z.toJSONSchema(setPermissionModeInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

const setSessionConfigInput = z.object({}).passthrough();
/**
 * `set-session-config` — mutate the session's runtime config (e.g. model,
 * output style, effort). `mutating` (inventory-seeded): it changes session state.
 */
export const SET_SESSION_CONFIG_META: CapabilityMeta = {
  description:
    "Mutate the session's runtime configuration (model, output style, effort, …). Mutating — changes session state; blocked by the readonly invoke gate.",
  inputSchema: z.toJSONSchema(setSessionConfigInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

const killSessionInput = z.object({});
/**
 * `killSession` — terminate the running Claude session/process. `destructive`
 * (fresh classification): irreversible teardown of the live session, so the
 * readonly-only invoke gate must never launch it.
 */
export const KILL_SESSION_META: CapabilityMeta = {
  description:
    "Terminate the running Claude session and its process. Destructive — irreversible teardown; never auto-invoked by the generic invoke path.",
  inputSchema: z.toJSONSchema(killSessionInput),
  riskTier: "destructive",
  since: "2026-09-17",
};

const permissionInput = z.object({
  // The permission-request id being answered plus the user's decision — kept
  // loose here (the concrete shape is TResponse in BasePermissionHandler).
  id: z.string(),
});
/**
 * `permission` — deliver a user's answer to a pending tool-permission request.
 * `mutating` (fresh classification): it resolves a pending permission decision
 * that gates a tool call, changing session state; blocked by the invoke gate.
 */
export const PERMISSION_META: CapabilityMeta = {
  description:
    "Deliver the user's answer (approve/deny) to a pending tool-permission request. Mutating — resolves a decision that gates a tool call.",
  inputSchema: z.toJSONSchema(permissionInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

// ── Session tool group (registerCommonHandlers, on BOTH managers) ─────────────
// 🔒 R4 SECURITY BLOCK: every method here is a TOOL_GROUP_METHODS member. NONE is
// `readonly`, even the pure reads — see the module-level R4 note above. The
// honest read/write semantics live in each description; the tier is the gate's
// input, not a description.

const bashInput = z.object({
  command: z.string(),
  cwd: z.string().optional(),
  timeout: z.number().optional(),
});
/**
 * `bash` — run a shell command in the session's working directory. `destructive`
 * (fresh): arbitrary shell execution can irreversibly change the filesystem; it
 * must never be reachable via the readonly generic-invoke path.
 */
export const BASH_META: CapabilityMeta = {
  description:
    "Run a shell command in the session's working directory (returns stdout/stderr/exit). Destructive — arbitrary shell execution; never readonly, never generically invocable.",
  inputSchema: z.toJSONSchema(bashInput),
  riskTier: "destructive",
  since: "2026-09-17",
};

const readFileInput = z.object({ path: z.string() });
/**
 * `readFile` — read a file's contents from the session's working directory.
 * `mutating`, NOT `readonly` (fresh, R4): although a pure read, the tier is the
 * invoke gate's input, so tagging it `readonly` would expose arbitrary
 * fs-content over the generic `hapi_invoke` path. Kept OFF that path by tier.
 */
export const READ_FILE_META: CapabilityMeta = {
  description:
    "Read a file's contents from the session's working directory. Semantically a pure read, but tagged mutating (NOT readonly) so it stays off the generic invoke path — the tier is the gate's input (R4).",
  inputSchema: z.toJSONSchema(readFileInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

const writeFileInput = z.object({
  path: z.string(),
  content: z.string(),
  expectedHash: z.string().nullable().optional(),
});
/**
 * `writeFile` — write/overwrite a file in the session's working directory.
 * `destructive` (fresh): overwrites arbitrary file content; never readonly.
 */
export const WRITE_FILE_META: CapabilityMeta = {
  description:
    "Write (create or overwrite) a file in the session's working directory. Destructive — overwrites arbitrary content; never readonly, never generically invocable.",
  inputSchema: z.toJSONSchema(writeFileInput),
  riskTier: "destructive",
  since: "2026-09-17",
};

const createDirectoryInput = z.object({ path: z.string() });
/**
 * `createDirectory` — create a directory in the session's working directory.
 * `mutating` (fresh): a bounded filesystem mutation; never readonly.
 */
export const CREATE_DIRECTORY_META: CapabilityMeta = {
  description:
    "Create a directory in the session's working directory. Mutating — a bounded filesystem write; never readonly.",
  inputSchema: z.toJSONSchema(createDirectoryInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

const renamePathInput = z.object({ path: z.string(), newPath: z.string() });
/**
 * `renamePath` — rename/move a file or directory. `mutating` (fresh): a bounded
 * filesystem mutation; never readonly.
 */
export const RENAME_PATH_META: CapabilityMeta = {
  description:
    "Rename or move a file/directory within the session's working directory. Mutating — a bounded filesystem change; never readonly.",
  inputSchema: z.toJSONSchema(renamePathInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

const deletePathInput = z.object({
  path: z.string(),
  recursive: z.boolean().optional(),
});
/**
 * `deletePath` — delete a file or directory (recursive is an explicit opt-in).
 * `destructive` (fresh): irreversible removal; never readonly.
 */
export const DELETE_PATH_META: CapabilityMeta = {
  description:
    "Delete a file or directory (recursive removal is an explicit opt-in). Destructive — irreversible removal; never readonly, never generically invocable.",
  inputSchema: z.toJSONSchema(deletePathInput),
  riskTier: "destructive",
  since: "2026-09-17",
};

const listDirectoryInput = z.object({ path: z.string() });
/**
 * `listDirectory` — list a directory's entries in the session's working
 * directory. `mutating`, NOT `readonly` (fresh, R4): a pure read tagged mutating
 * so it stays off the generic invoke path (it discloses filesystem structure).
 */
export const LIST_DIRECTORY_META: CapabilityMeta = {
  description:
    "List the entries of a directory in the session's working directory. Semantically a read, but tagged mutating (NOT readonly) so it stays off the generic invoke path (R4).",
  inputSchema: z.toJSONSchema(listDirectoryInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

const getDirectoryTreeInput = z.object({
  path: z.string(),
  maxDepth: z.number(),
});
/**
 * `getDirectoryTree` — read a bounded-depth directory tree. `mutating`, NOT
 * `readonly` (fresh, R4): a pure read tagged mutating to keep it off the generic
 * invoke path (it discloses filesystem structure).
 */
export const GET_DIRECTORY_TREE_META: CapabilityMeta = {
  description:
    "Read a bounded-depth directory tree from the session's working directory. Semantically a read, but tagged mutating (NOT readonly) so it stays off the generic invoke path (R4).",
  inputSchema: z.toJSONSchema(getDirectoryTreeInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

const ripgrepInput = z.object({
  args: z.array(z.string()),
  cwd: z.string().optional(),
});
/**
 * `ripgrep` — full-text search under the session's working directory.
 * `mutating`, NOT `readonly` (fresh, R4): a pure read tagged mutating so it stays
 * off the generic invoke path (it discloses file contents matching a pattern).
 */
export const RIPGREP_META: CapabilityMeta = {
  description:
    "Full-text search (ripgrep) under the session's working directory. Semantically a read, but tagged mutating (NOT readonly) so it stays off the generic invoke path — it discloses file contents (R4).",
  inputSchema: z.toJSONSchema(ripgrepInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

const difftasticInput = z.object({
  args: z.array(z.string()),
  cwd: z.string().optional(),
});
/**
 * `difftastic` — structural (syntax-aware) diff under the session's working
 * directory. `mutating`, NOT `readonly` (fresh, R4): a pure read tagged mutating
 * so it stays off the generic invoke path (it discloses file contents).
 */
export const DIFFTASTIC_META: CapabilityMeta = {
  description:
    "Structural (syntax-aware) diff under the session's working directory. Semantically a read, but tagged mutating (NOT readonly) so it stays off the generic invoke path (R4).",
  inputSchema: z.toJSONSchema(difftasticInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

const gitStatusInput = z.object({
  cwd: z.string().optional(),
  timeout: z.number().optional(),
});
/**
 * `git-status` — `git status` in the session's working directory. `mutating`,
 * NOT `readonly` (fresh, R4): a pure read tagged mutating so it stays off the
 * generic invoke path (it discloses repository state).
 */
export const GIT_STATUS_META: CapabilityMeta = {
  description:
    "Run `git status` in the session's working directory. Semantically a read, but tagged mutating (NOT readonly) so it stays off the generic invoke path (R4).",
  inputSchema: z.toJSONSchema(gitStatusInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

const gitDiffNumstatInput = z.object({
  cwd: z.string().optional(),
  staged: z.boolean().optional(),
  timeout: z.number().optional(),
});
/**
 * `git-diff-numstat` — `git diff --numstat`. `mutating`, NOT `readonly` (fresh,
 * R4): a pure read tagged mutating to keep it off the generic invoke path.
 */
export const GIT_DIFF_NUMSTAT_META: CapabilityMeta = {
  description:
    "Run `git diff --numstat` in the session's working directory (per-file add/delete counts). A read, tagged mutating (NOT readonly) so it stays off the generic invoke path (R4).",
  inputSchema: z.toJSONSchema(gitDiffNumstatInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

const gitDiffFileInput = z.object({
  cwd: z.string().optional(),
  filePath: z.string(),
  staged: z.boolean().optional(),
  timeout: z.number().optional(),
});
/**
 * `git-diff-file` — `git diff` for one file. `mutating`, NOT `readonly` (fresh,
 * R4): a pure read tagged mutating to keep it off the generic invoke path (it
 * discloses file contents).
 */
export const GIT_DIFF_FILE_META: CapabilityMeta = {
  description:
    "Run `git diff` for one file in the session's working directory. A read, tagged mutating (NOT readonly) so it stays off the generic invoke path — it discloses file contents (R4).",
  inputSchema: z.toJSONSchema(gitDiffFileInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

const gitRemoteUrlInput = z.object({
  cwd: z.string().optional(),
  timeout: z.number().optional(),
});
/**
 * `git-remote-url` — `git remote get-url origin`. `mutating`, NOT `readonly`
 * (fresh, R4): a pure read tagged mutating to keep it off the generic invoke
 * path (uniform with the rest of the tool group; discloses repo metadata).
 */
export const GIT_REMOTE_URL_META: CapabilityMeta = {
  description:
    "Read the `origin` remote URL of the session's repository. A read, tagged mutating (NOT readonly) so it stays off the generic invoke path, uniform with the tool group (R4).",
  inputSchema: z.toJSONSchema(gitRemoteUrlInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

const listSlashCommandsInput = z.object({ agent: z.string() });
/**
 * `listSlashCommands` — enumerate an agent's available slash commands.
 * `mutating`, NOT `readonly` (fresh, R4): registered by registerCommonHandlers
 * (a TOOL_GROUP_METHODS member) and reads slash-command definitions off disk, so
 * it is tagged mutating to keep it off the generic invoke path uniformly.
 */
export const LIST_SLASH_COMMANDS_META: CapabilityMeta = {
  description:
    "Enumerate an agent's available slash commands (built-in + on-disk definitions). A read, tagged mutating (NOT readonly) so the tool group stays uniformly off the generic invoke path (R4).",
  inputSchema: z.toJSONSchema(listSlashCommandsInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

// ── Machine layer (apiMachine, scope = machine.id) ───────────────────────────
// Machine-scoped methods are un-invocable over the SESSION invoke path because
// of the registry key (`${sessionId}:${method}` vs `${machineId}:${method}`,
// KD-4) — NOT because of their tier. Tiers below are honest: the pure-read
// probes are `readonly`; the fs-content-bearing machine reads (list-directory,
// path-exists) are `mutating` (R4), never `readonly`, notwithstanding scope
// isolation.

const spawnHappySessionInput = z.object({}).passthrough();
/**
 * `spawn-happy-session` — create a new Claude/agent session on this machine.
 * `mutating` (inventory-seeded): creates a new session/process.
 */
export const SPAWN_HAPPY_SESSION_META: CapabilityMeta = {
  description:
    "Create a new Claude/agent session (tmux window + child process) on this machine. Mutating — creates a new session/process.",
  inputSchema: z.toJSONSchema(spawnHappySessionInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

const sessionIdInput = z.object({ sessionId: z.string() });
/**
 * `stop-session` — tear down a running session on this machine. `destructive`
 * (inventory-seeded): irreversible session teardown.
 */
export const STOP_SESSION_META: CapabilityMeta = {
  description:
    "Tear down a running session on this machine. Destructive — irreversible teardown.",
  inputSchema: z.toJSONSchema(sessionIdInput),
  riskTier: "destructive",
  since: "2026-09-17",
};

const stopDaemonInput = z.object({}).passthrough();
/**
 * `stop-daemon` — stop this machine's Hapimatic daemon. `destructive`
 * (inventory-seeded): stops the daemon, ending session management on the node.
 */
export const STOP_DAEMON_META: CapabilityMeta = {
  description:
    "Stop this machine's Hapimatic daemon. Destructive — halts session spawning/management on the node.",
  inputSchema: z.toJSONSchema(stopDaemonInput),
  riskTier: "destructive",
  since: "2026-09-17",
};

const cleanupTmuxSessionInput = z.object({
  sessionId: z.string(),
  serverSessionId: z.string().optional(),
});
/**
 * `cleanup-tmux-session` — remove a session's tmux window/store entry.
 * `destructive` (inventory-seeded): removes a tmux session.
 */
export const CLEANUP_TMUX_SESSION_META: CapabilityMeta = {
  description:
    "Remove a session's tmux window and store entry after deletion. Destructive — removes a tmux session.",
  inputSchema: z.toJSONSchema(cleanupTmuxSessionInput),
  riskTier: "destructive",
  since: "2026-09-17",
};

const reapRemoteWindowInput = z.object({
  sessionId: z.string(),
  serverSessionId: z.string().optional(),
});
/**
 * `reap-remote-window` — reap a session's dead hapimatic-remote tmux window(s).
 * `destructive` (inventory-seeded): reaps a dead tmux window.
 */
export const REAP_REMOTE_WINDOW_META: CapabilityMeta = {
  description:
    "Reap a session's dead launcher (hapimatic-remote) tmux window(s). Destructive — removes a dead tmux window.",
  inputSchema: z.toJSONSchema(reapRemoteWindowInput),
  riskTier: "destructive",
  since: "2026-09-17",
};

const renameTmuxWindowInput = z.object({
  sessionId: z.string(),
  newName: z.string(),
});
/**
 * `rename-tmux-window` — rename a session's tmux window. `mutating`
 * (inventory-seeded): renames a tmux window.
 */
export const RENAME_TMUX_WINDOW_META: CapabilityMeta = {
  description:
    "Rename a session's tmux window. Mutating — changes the window label.",
  inputSchema: z.toJSONSchema(renameTmuxWindowInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

const cleanupWorktreeInput = z.object({
  basePath: z.string(),
  worktreePath: z.string().optional(),
  branch: z.string(),
  sessionId: z.string().optional(),
});
/**
 * `cleanup-worktree` — remove a session's git worktree + branch. `destructive`
 * (inventory-seeded): removes a git worktree.
 */
export const CLEANUP_WORKTREE_META: CapabilityMeta = {
  description:
    "Remove a session's git worktree and its feature branch. Destructive — removes a git worktree.",
  inputSchema: z.toJSONSchema(cleanupWorktreeInput),
  riskTier: "destructive",
  since: "2026-09-17",
};

/**
 * The input of `cleanup-idle-worktree` (#4450 R9). Every field the guarded
 * removal depends on is required and non-empty; the handler validates with this
 * schema before anything else, because `RpcHandlerManager` passes params
 * through unvalidated.
 */
export const cleanupIdleWorktreeInput = z.object({
  basePath: z.string().min(1),
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  expectedOwnerTag: z.string().min(1),
  sessionId: z.string().optional(),
});
/**
 * `cleanup-idle-worktree` — the guarded removal behind the operator
 * `remove_worktree` tool (#4450). `destructive`: it moves a worktree to
 * `.trash`. A separate method from `cleanup-worktree`, so a daemon older than
 * the server never registers it and the server's call fails
 * (`daemon_unavailable`) instead of running the unguarded path.
 */
export const CLEANUP_IDLE_WORKTREE_META: CapabilityMeta = {
  description:
    "Move an idle, owner-verified git worktree to .trash (recoverable). Refuses a live, claimed, protected or unverifiable worktree. Destructive — removes a git worktree.",
  inputSchema: z.toJSONSchema(cleanupIdleWorktreeInput),
  riskTier: "destructive",
  since: "2026-10-23",
};

const getSessionClaudeIdInput = z.object({ sessionId: z.string() });
/**
 * `get-session-claude-id` — read a session's Claude session id. `readonly`
 * (inventory-seeded): a pure read of session state (no fs content), and
 * machine-scoped, so KD-4's registry-key isolation keeps it off the session
 * invoke path regardless of tier.
 */
export const GET_SESSION_CLAUDE_ID_META: CapabilityMeta = {
  description:
    "Read a session's Claude session id (machine-scoped). Readonly — a pure read of session state; scope-isolated from the session invoke path (KD-4).",
  inputSchema: z.toJSONSchema(getSessionClaudeIdInput),
  riskTier: "readonly",
  since: "2026-09-17",
};

const hasClaudeConversationInput = z.object({
  sessionId: z.string().optional(),
  claudeSessionId: z.string().optional(),
});
/**
 * `has-claude-conversation` — probe whether a session's conversation transcript
 * exists. `readonly` (inventory-seeded): an existence probe (no content read),
 * machine-scoped and scope-isolated (KD-4).
 */
export const HAS_CLAUDE_CONVERSATION_META: CapabilityMeta = {
  description:
    "Probe whether a session's Claude conversation transcript file exists (machine-scoped). Readonly — an existence probe, not a content read; scope-isolated (KD-4).",
  inputSchema: z.toJSONSchema(hasClaudeConversationInput),
  riskTier: "readonly",
  since: "2026-09-17",
};

const recoverWorktreeInput = z.object({ originalPath: z.string() });
/**
 * `recover-worktree` — re-materialise a soft-deleted worktree from
 * `.worktrees/.trash/` back to its ORIGINAL recorded path (issue #3839, D28:
 * restore-from-trash before resuming an orphaned transcript). `mutating`: it
 * moves a worktree, but it never deletes or overwrites anything — it refuses
 * when the destination already exists and touches only the trash entry whose
 * recorded `originalPath` equals the requested path (no caller-named holding
 * dir, no branch operation).
 */
export const RECOVER_WORKTREE_META: CapabilityMeta = {
  description:
    "Restore a soft-deleted worktree from .worktrees/.trash to its original recorded path (machine-scoped). Mutating — moves a worktree; refuses when the destination exists, never deletes, never touches a branch.",
  inputSchema: z.toJSONSchema(recoverWorktreeInput),
  riskTier: "mutating",
  since: "2026-09-23",
};

const isSessionAliveInput = z.object({ sessionId: z.string() });
/**
 * `is-session-alive` — liveness probe for a session on this machine. `readonly`
 * (inventory-seeded): a pure liveness read, machine-scoped and scope-isolated.
 */
export const IS_SESSION_ALIVE_META: CapabilityMeta = {
  description:
    "Liveness probe for a session on this machine. Readonly — a pure liveness read; scope-isolated from the session invoke path (KD-4).",
  inputSchema: z.toJSONSchema(isSessionAliveInput),
  riskTier: "readonly",
  since: "2026-09-17",
};

const machineListDirectoryInput = z.object({ path: z.string() });
/**
 * `list-directory` (machine-scoped) — browse ANY directory on the machine (New
 * Session form). `mutating`, NOT `readonly` (fresh, R4): fs-content-bearing, so
 * never `readonly` notwithstanding its scope isolation (belt-and-suspenders —
 * the tier, not only KD-4's registry key, keeps it off the invoke path).
 */
export const MACHINE_LIST_DIRECTORY_META: CapabilityMeta = {
  description:
    "Browse any directory on the machine (New Session form). Semantically a read, but tagged mutating (NOT readonly) — fs-content-bearing, never readonly regardless of scope isolation (R4).",
  inputSchema: z.toJSONSchema(machineListDirectoryInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

const machineCreateDirectoryInput = z.object({
  path: z.string(),
  recursive: z.boolean(),
});
/**
 * `create-directory` (machine-scoped) — create a directory anywhere on the
 * machine (the New Session form's "New folder", issue #3498). `mutating`
 * (fresh): a bounded filesystem write; never `readonly`. Machine-scoped, so
 * KD-4's registry-key isolation ALSO keeps it off the session invoke path.
 * Distinct from the session-scoped `createDirectory` (`CREATE_DIRECTORY_META`),
 * which is cwd-relative and carries no `recursive` flag.
 */
export const MACHINE_CREATE_DIRECTORY_META: CapabilityMeta = {
  description:
    "Create a directory anywhere on the machine (the New Session form's New folder). Mutating — a bounded filesystem write; never readonly, never generically invocable.",
  inputSchema: z.toJSONSchema(machineCreateDirectoryInput),
  riskTier: "mutating",
  since: "2026-09-20",
};

const pathExistsInput = z.object({ paths: z.array(z.string()) });
/**
 * `path-exists` (machine-scoped) — probe whether machine paths exist/are
 * directories. `mutating`, NOT `readonly` (fresh, R4): fs-probing, never
 * `readonly` notwithstanding scope isolation (belt-and-suspenders).
 */
export const PATH_EXISTS_META: CapabilityMeta = {
  description:
    "Probe whether machine paths exist and are directories. A filesystem probe, tagged mutating (NOT readonly) — never readonly regardless of scope isolation (R4).",
  inputSchema: z.toJSONSchema(pathExistsInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

const setArchiveTagInput = z.object({ sessionId: z.string() });
/**
 * `set-archive-tag` — tag a session's tmux window as archived-for-reconnect.
 * `mutating` (fresh): changes the session's tmux window state.
 */
export const SET_ARCHIVE_TAG_META: CapabilityMeta = {
  description:
    "Tag a session's tmux window as archived-for-reconnect. Mutating — changes the session's tmux window state.",
  inputSchema: z.toJSONSchema(setArchiveTagInput),
  riskTier: "mutating",
  since: "2026-09-17",
};

const capacityProbeInput = z.object({
  creditHapiSessionId: z.string().optional(),
});
/**
 * `capacity-probe` — read the daemon's live spawn capacity (effectiveCount).
 * `readonly` (fresh): a pure read of daemon capacity (no fs content), and
 * machine-scoped so scope-isolated from the session invoke path (KD-4).
 */
export const CAPACITY_PROBE_META: CapabilityMeta = {
  description:
    "Read the daemon's live spawn capacity (effectiveCount / headroom). Readonly — a pure capacity read; scope-isolated from the session invoke path (KD-4).",
  inputSchema: z.toJSONSchema(capacityProbeInput),
  riskTier: "readonly",
  since: "2026-09-17",
};
