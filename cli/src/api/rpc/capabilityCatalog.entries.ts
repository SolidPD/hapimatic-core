// SPDX-License-Identifier: MIT
/**
 * Capability catalog — `rpc` surface entries (issue #3745, epic #3740, Sub-Issue E).
 *
 * One `defineCapability({ surface: "rpc", ... })` literal per LIVE RPC method the
 * cli registers (39 after `capabilityOffer` was removed as dead code, R10). The
 * #3743 AST generator extracts these literals into the committed Tier-0 index;
 * they must stay PURE OBJECT LITERALS (no spreads, no variable refs — KD-3).
 *
 * 🔴 `riskTier` here MUST equal the method's `*_META.riskTier` in
 * `capabilityMeta.ts` — that meta value is the ONLY one with security effect
 * (it rides `rpc-register` → `rpcRegistry.getMeta` → `isInvocable`), while this
 * literal is what humans/models see via the catalog + `hapi_catalog`. The two
 * are cross-checked by `capabilityCatalog.entries.test.ts` (R12), and no
 * `TOOL_GROUP_METHODS` member may be `readonly` (R4 / V4). Text respects #3741's
 * caps (description ≤ 200, whenToUse ≤ 160) — written FRESH, never copied from the
 * meta descriptions (several of which exceed the cap).
 *
 * Domains: session-lifecycle / session-introspection / mcp / model-permission /
 * files-git (the session tool group) / machine-daemon (apiMachine, scope-isolated
 * from the session invoke path by the registry key, KD-4).
 */
import { defineCapability } from "@hapi/protocol";

export const rpcCatalogEntries = [
  // ── Session-control (session-scoped, launcher-registered) ──────────────────
  defineCapability({
    id: "session-lifecycle.abort",
    domain: "session-lifecycle",
    surface: "rpc",
    description:
      "Abort the current Claude turn, clear the queue, and switch the session to remote mode.",
    whenToUse: "To interrupt the session's in-flight turn.",
    invocation: { kind: "rpc", method: "abort" },
    auth: "jwt",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "session-lifecycle.switch",
    domain: "session-lifecycle",
    surface: "rpc",
    description:
      "Switch the session between local (terminal) and remote (mobile) I/O mode.",
    whenToUse: "To move a session between local and remote control.",
    invocation: { kind: "rpc", method: "switch" },
    auth: "jwt",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "session-lifecycle.set-session-config",
    domain: "session-lifecycle",
    surface: "rpc",
    description:
      "Mutate the session's runtime configuration (permission mode, model mode, effort).",
    whenToUse: "To change several live session settings at once.",
    invocation: { kind: "rpc", method: "set-session-config" },
    auth: "jwt",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "session-lifecycle.kill-session",
    domain: "session-lifecycle",
    surface: "rpc",
    description:
      "Terminate the running Claude session and its process. Irreversible teardown.",
    whenToUse: "To force-kill a session's process.",
    invocation: { kind: "rpc", method: "killSession" },
    auth: "jwt",
    riskTier: "destructive",
    availability: { scope: "user" },
  }),

  // ── MCP control ────────────────────────────────────────────────────────────
  defineCapability({
    id: "mcp.toggle",
    domain: "mcp",
    surface: "rpc",
    description:
      "Enable or disable an MCP server for the running session. Local mode rejects.",
    whenToUse: "To turn an MCP server on or off mid-session (remote mode).",
    invocation: { kind: "rpc", method: "mcp-toggle" },
    auth: "jwt",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "mcp.status",
    domain: "mcp",
    surface: "rpc",
    description:
      "Read the session's live MCP server status (connected / failed / needs_auth / hosted).",
    whenToUse: "To inspect which MCP servers the session has connected.",
    invocation: { kind: "rpc", method: "mcp-status" },
    auth: "jwt",
    riskTier: "readonly",
    availability: { scope: "user" },
  }),

  // ── Model / permission / effort ────────────────────────────────────────────
  defineCapability({
    id: "model-permission.set-permission-mode",
    domain: "model-permission",
    surface: "rpc",
    description:
      "Set the session's Claude permission mode. Functional in remote (sdk) mode; local rejects.",
    whenToUse: "To change the session's tool-permission mode.",
    invocation: { kind: "rpc", method: "set-permission-mode" },
    auth: "jwt",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "model-permission.set-model",
    domain: "model-permission",
    surface: "rpc",
    description:
      "Set the session's model family/mode (sonnet | opus | fable | default). Mutating.",
    whenToUse: "To change the model the session runs on.",
    invocation: { kind: "rpc", method: "set-model" },
    auth: "jwt",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "model-permission.permission",
    domain: "model-permission",
    surface: "rpc",
    description:
      "Deliver the user's answer (approve/deny) to a pending tool-permission request.",
    whenToUse: "To resolve a permission prompt gating a tool call.",
    invocation: { kind: "rpc", method: "permission" },
    auth: "jwt",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),

  // ── Session introspection ──────────────────────────────────────────────────
  defineCapability({
    id: "session-introspection.get-context-usage",
    domain: "session-introspection",
    surface: "rpc",
    description:
      "Read the session's live context-window usage (model, window, token count, percentage).",
    whenToUse: "To read how much of the context window the session has used.",
    invocation: { kind: "rpc", method: "get-context-usage" },
    auth: "jwt",
    riskTier: "readonly",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "session-introspection.list-slash-commands",
    domain: "session-introspection",
    surface: "rpc",
    description:
      "Enumerate an agent's available slash commands. A read tagged mutating (tool group, R4).",
    whenToUse: "To list the slash commands available to the session's agent.",
    invocation: { kind: "rpc", method: "listSlashCommands" },
    auth: "jwt",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),

  // ── Session tool group (files / exec / git / search) ───────────────────────
  // 🔴 Every entry below is a TOOL_GROUP_METHODS member — NONE is `readonly`,
  // even the pure reads (R4). Tagging any of them `readonly` would model-face a
  // fs-content-bearing or shell RPC via the generic invoke path.
  defineCapability({
    id: "files-git.bash",
    domain: "files-git",
    surface: "rpc",
    description:
      "Run a shell command in the session's working directory. Arbitrary shell execution.",
    whenToUse: "To run a shell command on the session's working tree.",
    invocation: { kind: "rpc", method: "bash" },
    auth: "jwt",
    riskTier: "destructive",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "files-git.read-file",
    domain: "files-git",
    surface: "rpc",
    description:
      "Read a file's contents from the session's working directory. A read tagged mutating (R4).",
    whenToUse: "To read a file in the session's working tree.",
    invocation: { kind: "rpc", method: "readFile" },
    auth: "jwt",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "files-git.write-file",
    domain: "files-git",
    surface: "rpc",
    description:
      "Write (create or overwrite) a file in the session's working directory.",
    whenToUse: "To write a file in the session's working tree.",
    invocation: { kind: "rpc", method: "writeFile" },
    auth: "jwt",
    riskTier: "destructive",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "files-git.create-directory",
    domain: "files-git",
    surface: "rpc",
    description: "Create a directory in the session's working directory.",
    whenToUse: "To make a new directory in the session's working tree.",
    invocation: { kind: "rpc", method: "createDirectory" },
    auth: "jwt",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "files-git.rename-path",
    domain: "files-git",
    surface: "rpc",
    description:
      "Rename or move a file/directory within the session's working directory.",
    whenToUse: "To rename or move a path in the session's working tree.",
    invocation: { kind: "rpc", method: "renamePath" },
    auth: "jwt",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "files-git.delete-path",
    domain: "files-git",
    surface: "rpc",
    description:
      "Delete a file or directory (recursive is an explicit opt-in). Irreversible.",
    whenToUse: "To delete a path in the session's working tree.",
    invocation: { kind: "rpc", method: "deletePath" },
    auth: "jwt",
    riskTier: "destructive",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "files-git.list-directory",
    domain: "files-git",
    surface: "rpc",
    description:
      "List a directory's entries in the session's working directory. A read tagged mutating (R4).",
    whenToUse: "To list a directory in the session's working tree.",
    invocation: { kind: "rpc", method: "listDirectory" },
    auth: "jwt",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "files-git.get-directory-tree",
    domain: "files-git",
    surface: "rpc",
    description:
      "Read a bounded-depth directory tree from the session's working directory. A read (R4).",
    whenToUse: "To read a directory tree in the session's working tree.",
    invocation: { kind: "rpc", method: "getDirectoryTree" },
    auth: "jwt",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "files-git.ripgrep",
    domain: "files-git",
    surface: "rpc",
    description:
      "Full-text search (ripgrep) under the session's working directory. A read tagged mutating (R4).",
    whenToUse: "To full-text search the session's working tree.",
    invocation: { kind: "rpc", method: "ripgrep" },
    auth: "jwt",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "files-git.difftastic",
    domain: "files-git",
    surface: "rpc",
    description:
      "Structural (syntax-aware) diff under the session's working directory. A read (R4).",
    whenToUse: "To produce a structural diff in the session's working tree.",
    invocation: { kind: "rpc", method: "difftastic" },
    auth: "jwt",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "files-git.git-status",
    domain: "files-git",
    surface: "rpc",
    description:
      "Run `git status` in the session's working directory. A read tagged mutating (R4).",
    whenToUse: "To read the working tree's git status.",
    invocation: { kind: "rpc", method: "git-status" },
    auth: "jwt",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "files-git.git-diff-numstat",
    domain: "files-git",
    surface: "rpc",
    description:
      "Run `git diff --numstat` (per-file add/delete counts). A read tagged mutating (R4).",
    whenToUse: "To read per-file change counts in the working tree.",
    invocation: { kind: "rpc", method: "git-diff-numstat" },
    auth: "jwt",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "files-git.git-diff-file",
    domain: "files-git",
    surface: "rpc",
    description:
      "Run `git diff` for one file in the session's working directory. A read (R4).",
    whenToUse: "To read the git diff of one file in the working tree.",
    invocation: { kind: "rpc", method: "git-diff-file" },
    auth: "jwt",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "files-git.git-remote-url",
    domain: "files-git",
    surface: "rpc",
    description:
      "Read the origin remote URL of the session's repository. A read tagged mutating (R4).",
    whenToUse: "To read the working tree's origin remote URL.",
    invocation: { kind: "rpc", method: "git-remote-url" },
    auth: "jwt",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),

  // ── Machine & daemon (apiMachine, scope-isolated from the session path) ─────
  defineCapability({
    id: "machine-daemon.spawn-happy-session",
    domain: "machine-daemon",
    surface: "rpc",
    description:
      "Create a new Claude/agent session (tmux window + child process) on this machine.",
    whenToUse: "To spawn a new session on this node.",
    invocation: { kind: "rpc", method: "spawn-happy-session" },
    auth: "cli-token",
    riskTier: "mutating",
    availability: { scope: "operator" },
  }),
  defineCapability({
    id: "machine-daemon.stop-session",
    domain: "machine-daemon",
    surface: "rpc",
    description: "Tear down a running session on this machine. Irreversible.",
    whenToUse: "To stop a running session on this node.",
    invocation: { kind: "rpc", method: "stop-session" },
    auth: "cli-token",
    riskTier: "destructive",
    availability: { scope: "operator" },
  }),
  defineCapability({
    id: "machine-daemon.stop-daemon",
    domain: "machine-daemon",
    surface: "rpc",
    description:
      "Stop this machine's Hapimatic daemon. Halts session spawning on the node.",
    whenToUse: "To stop this node's daemon.",
    invocation: { kind: "rpc", method: "stop-daemon" },
    auth: "cli-token",
    riskTier: "destructive",
    availability: { scope: "operator" },
  }),
  defineCapability({
    id: "machine-daemon.cleanup-tmux-session",
    domain: "machine-daemon",
    surface: "rpc",
    description:
      "Remove a session's tmux window and store entry after deletion. Irreversible.",
    whenToUse: "To clean up a deleted session's tmux state.",
    invocation: { kind: "rpc", method: "cleanup-tmux-session" },
    auth: "cli-token",
    riskTier: "destructive",
    availability: { scope: "operator" },
  }),
  defineCapability({
    id: "machine-daemon.reap-remote-window",
    domain: "machine-daemon",
    surface: "rpc",
    description:
      "Reap a session's dead launcher (hapimatic-remote) tmux window(s). Irreversible.",
    whenToUse: "To reap a session's dead launcher tmux window.",
    invocation: { kind: "rpc", method: "reap-remote-window" },
    auth: "cli-token",
    riskTier: "destructive",
    availability: { scope: "operator" },
  }),
  defineCapability({
    id: "machine-daemon.rename-tmux-window",
    domain: "machine-daemon",
    surface: "rpc",
    description: "Rename a session's tmux window.",
    whenToUse: "To relabel a session's tmux window.",
    invocation: { kind: "rpc", method: "rename-tmux-window" },
    auth: "cli-token",
    riskTier: "mutating",
    availability: { scope: "operator" },
  }),
  defineCapability({
    id: "machine-daemon.cleanup-worktree",
    domain: "machine-daemon",
    surface: "rpc",
    description:
      "Remove a session's git worktree and its feature branch. Irreversible.",
    whenToUse: "To clean up a session's git worktree.",
    invocation: { kind: "rpc", method: "cleanup-worktree" },
    auth: "cli-token",
    riskTier: "destructive",
    availability: { scope: "operator" },
  }),
  defineCapability({
    id: "machine-daemon.get-session-claude-id",
    domain: "machine-daemon",
    surface: "rpc",
    description:
      "Read a session's Claude session id (machine-scoped). A pure read of session state.",
    whenToUse: "To look up a session's Claude session id on this node.",
    invocation: { kind: "rpc", method: "get-session-claude-id" },
    auth: "cli-token",
    riskTier: "readonly",
    availability: { scope: "operator" },
  }),
  defineCapability({
    id: "machine-daemon.has-claude-conversation",
    domain: "machine-daemon",
    surface: "rpc",
    description:
      "Probe whether a session's Claude conversation transcript file exists. Existence probe.",
    whenToUse: "To check if a session has a conversation transcript on disk.",
    invocation: { kind: "rpc", method: "has-claude-conversation" },
    auth: "cli-token",
    riskTier: "readonly",
    availability: { scope: "operator" },
  }),
  defineCapability({
    id: "machine-daemon.is-session-alive",
    domain: "machine-daemon",
    surface: "rpc",
    description: "Liveness probe for a session on this machine. A pure read.",
    whenToUse: "To check whether a session is still alive on this node.",
    invocation: { kind: "rpc", method: "is-session-alive" },
    auth: "cli-token",
    riskTier: "readonly",
    availability: { scope: "operator" },
  }),
  defineCapability({
    id: "machine-daemon.list-directory",
    domain: "machine-daemon",
    surface: "rpc",
    description:
      "Browse any directory on the machine (New Session form). fs read tagged mutating (R4).",
    whenToUse: "To browse the machine's filesystem for a new session.",
    invocation: { kind: "rpc", method: "list-directory" },
    auth: "cli-token",
    riskTier: "mutating",
    availability: { scope: "operator" },
  }),
  defineCapability({
    id: "machine-daemon.path-exists",
    domain: "machine-daemon",
    surface: "rpc",
    description:
      "Probe whether machine paths exist and are directories. fs probe tagged mutating (R4).",
    whenToUse: "To check whether machine paths exist for a new session.",
    invocation: { kind: "rpc", method: "path-exists" },
    auth: "cli-token",
    riskTier: "mutating",
    availability: { scope: "operator" },
  }),
  defineCapability({
    id: "machine-daemon.set-archive-tag",
    domain: "machine-daemon",
    surface: "rpc",
    description:
      "Tag a session's tmux window as archived-for-reconnect. Changes tmux window state.",
    whenToUse: "To mark a session's tmux window archived-for-reconnect.",
    invocation: { kind: "rpc", method: "set-archive-tag" },
    auth: "cli-token",
    riskTier: "mutating",
    availability: { scope: "operator" },
  }),
  defineCapability({
    id: "machine-daemon.capacity-probe",
    domain: "machine-daemon",
    surface: "rpc",
    description:
      "Read the daemon's live spawn capacity (effectiveCount / headroom). A pure read.",
    whenToUse: "To read this node's live session spawn capacity.",
    invocation: { kind: "rpc", method: "capacity-probe" },
    auth: "cli-token",
    riskTier: "readonly",
    availability: { scope: "operator" },
  }),
];
