// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Capability catalog — `mcp` surface entries (issue #3745, epic #3740, Sub-Issue E).
 *
 * One `defineCapability({ surface: "mcp", invocation: { kind: "mcp", tool } })`
 * literal per tool the HAPI MCP server registers in `startHappyServer.ts`. The
 * codex stdio bridge (`happyMcpStdioBridge.ts`) re-exposes a subset (only
 * `change_title` today), so these entries — matched by bare tool name — cover
 * every observed MCP harness (#3744's per-harness audit).
 *
 * 🔒 THE SINGLE HOME FOR `mcp` ENTRIES (R7). ANY issue that adds a
 * `startHappyServer` tool MUST append its entry HERE in the SAME PR — otherwise
 * #3748's Tier-0 tool list (generated from these `invocation.tool` values, never
 * hardcoded) permanently omits it, and that PR lands red on #3744's MCP
 * reverse-drift rule and #3747's ratchet. This is a live contract with #3751,
 * whose Task 5 adds `hapi_catalog` + `hapi_call` and appends their entries here.
 *
 * `invocation.tool` is the CANONICAL BARE name (matching the exported
 * `HAPY_MCP_TOOL_NAMES`); per-harness prefixing (Claude's MCP prefix, #3748's
 * `functions.hapi__` Codex-bridge form) is the renderer's job in #3748, NEVER a
 * second value stored here — else the model is told to call a name it cannot use.
 * Pure object literals only (the #3743 AST generator extracts the untouched
 * literal); text respects #3741's caps (description ≤ 200, whenToUse ≤ 160).
 */
import { defineCapability } from "@hapi/protocol";

export const mcpCatalogEntries = [
  defineCapability({
    id: "session-lifecycle.change-title",
    domain: "session-lifecycle",
    surface: "mcp",
    description: "Change the title of the current chat session.",
    whenToUse: "To rename the current chat session from within the agent.",
    invocation: { kind: "mcp", tool: "change_title" },
    auth: "cli-token",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "messaging.image-fetch",
    domain: "messaging",
    surface: "mcp",
    description:
      "Fetch an image from a public URL and display it inline in the chat.",
    whenToUse: "To show the user an image from a public URL inline.",
    invocation: { kind: "mcp", tool: "image_fetch" },
    auth: "none",
    riskTier: "readonly",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "accounts.register-service-key",
    domain: "accounts",
    surface: "mcp",
    description:
      "Open a secure entry card so the user can register a provider API key (never in chat).",
    whenToUse: "To let the user register a provider API key securely.",
    invocation: { kind: "mcp", tool: "register_service_key" },
    auth: "cli-token",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "session-introspection.hapi-capabilities",
    domain: "session-introspection",
    surface: "mcp",
    description:
      "Enumerate a target session's live, invocable capabilities (methods + meta).",
    whenToUse:
      "To discover what capabilities a session exposes before invoking.",
    invocation: { kind: "mcp", tool: "hapi_capabilities" },
    auth: "cli-token",
    riskTier: "readonly",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "session-lifecycle.hapi-invoke",
    domain: "session-lifecycle",
    surface: "mcp",
    description:
      "Invoke a readonly capability on a session. Mutating/destructive methods return tier_not_invocable.",
    whenToUse:
      "To run a readonly capability on a session discovered via hapi_capabilities.",
    invocation: { kind: "mcp", tool: "hapi_invoke" },
    auth: "cli-token",
    riskTier: "readonly",
    availability: { scope: "user" },
  }),
  // Issue #3751 (Sub-Issue K): the Tier-1 on-demand catalog lookup + the generic
  // tier-gated REST invoker.
  defineCapability({
    id: "mcp.hapi-catalog",
    domain: "mcp",
    surface: "mcp",
    description:
      "Look up this session's Tier-1 capability catalog for one domain (bounded on-demand lookup).",
    whenToUse: "To look up one domain's capabilities.",
    invocation: { kind: "mcp", tool: "hapi_catalog" },
    auth: "cli-token",
    riskTier: "readonly",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "mcp.hapi-call",
    domain: "mcp",
    surface: "mcp",
    description:
      "Invoke a catalogued REST capability by method+path (+ optional query object) through the tier-gated generic invoker.",
    whenToUse: "To invoke a catalogued REST capability.",
    invocation: { kind: "mcp", tool: "hapi_call" },
    auth: "cli-token",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  // Issue #3842 (epic #4403 member C): typed session / worktree / schedule tools.
  // Each wraps REST entries through hapi_call, so its tier equals the wrapped
  // route's: list_sessions wraps the readonly session-introspection.list, and
  // respond_to_permission wraps both approve and deny (nine entries, eight of
  // them promoted). Short `whenToUse` text
  // keeps the Tier-0 block small (epic #4403 OD-1).
  defineCapability({
    id: "mcp.spawn-session",
    domain: "mcp",
    surface: "mcp",
    description:
      "Spawn a peer session on a machine (sessionType worktree creates a git worktree) through the tier-gated invoker.",
    whenToUse: "To spawn a peer.",
    invocation: { kind: "mcp", tool: "spawn_session" },
    auth: "cli-token",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "mcp.send-message",
    domain: "mcp",
    surface: "mcp",
    description:
      "Send a message to a peer session, stamped as sent by this session, through the tier-gated invoker.",
    whenToUse: "To message peers.",
    invocation: { kind: "mcp", tool: "send_message" },
    auth: "cli-token",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "mcp.list-sessions",
    domain: "mcp",
    surface: "mcp",
    description:
      "List the sessions in this namespace with their ids, state, and metadata.",
    whenToUse: "To list sessions.",
    invocation: { kind: "mcp", tool: "list_sessions" },
    auth: "cli-token",
    riskTier: "readonly",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "mcp.read-session-messages",
    domain: "mcp",
    surface: "mcp",
    description:
      "Read a session's message history page by page through the tier-gated invoker.",
    whenToUse: "To read messages.",
    invocation: { kind: "mcp", tool: "read_session_messages" },
    auth: "cli-token",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "mcp.archive-session",
    domain: "mcp",
    surface: "mcp",
    description:
      "Archive (disconnect) a live peer session you are finished with; its record stays.",
    whenToUse: "To archive peers.",
    invocation: { kind: "mcp", tool: "archive_session" },
    auth: "cli-token",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "mcp.create-schedule",
    domain: "mcp",
    surface: "mcp",
    description:
      "Create a scheduled task that runs a prompt on a cron, interval, or one-shot timer; bypass-mode sessions only.",
    whenToUse: "To schedule work.",
    invocation: { kind: "mcp", tool: "create_schedule" },
    auth: "cli-token",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "mcp.update-schedule",
    domain: "mcp",
    surface: "mcp",
    description:
      "Update a scheduled task's timing, prompt, or enablement; bypass-mode sessions only.",
    whenToUse: "To reschedule.",
    invocation: { kind: "mcp", tool: "update_schedule" },
    auth: "cli-token",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  defineCapability({
    id: "mcp.respond-to-permission",
    domain: "mcp",
    surface: "mcp",
    description:
      "Approve or deny another session's pending permission request; bypass-mode sessions only, never your own.",
    whenToUse: "To grant or deny.",
    invocation: { kind: "mcp", tool: "respond_to_permission" },
    auth: "cli-token",
    riskTier: "mutating",
    availability: { scope: "user" },
  }),
  // Issue #4450: the one operator-scope tool. Destructive and operator-only, so
  // it is never Tier-0 and never on the stdio bridge; the server lists it only
  // to a caller that derives operator scope, and the Claude launchers register it
  // only after seeing it here (`HAPY_MCP_OPERATOR_TOOL_NAMES`).
  defineCapability({
    id: "mcp.remove-worktree",
    domain: "mcp",
    surface: "mcp",
    description:
      "Move the idle worktree of a session you spawned to .trash (recoverable); operator hosts only.",
    whenToUse: "To remove a spawned peer's idle worktree.",
    invocation: { kind: "mcp", tool: "remove_worktree" },
    auth: "cli-token",
    riskTier: "destructive",
    availability: { scope: "operator" },
  }),
];
