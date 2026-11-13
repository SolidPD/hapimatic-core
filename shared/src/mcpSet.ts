// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import type { ContextUsageDetail } from "./contextUsage";

// Issue #6171 (epic #6163, Sub D2) — a session's MCP set: which MCP servers it
// starts with. Omitted = the project default, else today's behavior. Enforced by
// `deniedMcpServers` in the per-session `--settings` file, which is per-process
// and writes nothing shared. Measured on Claude Code 2.1.312: a deny entry matches
// the exact `claude mcp list` name for stdio, plugin and connector servers. An
// allowlist cannot admit plugin or connector servers by name, and it would block
// the `--mcp-config` `hapi` server unless listed.

/** The name Hapimatic registers its MCP server under in spawned Claude sessions. */
export const HAPI_MCP_SERVER_NAME = "hapi";

/** Display-name prefix of Anthropic-hosted connectors in `claude mcp list`. */
export const CLAUDE_AI_CONNECTOR_PREFIX = "claude.ai ";

/** Node capability: this binary honors `mcpSet` on a spawn and serves the catalog. */
export const MCP_SET_CAPABILITY = "spawn:mcp-set";

/** Upper bound on the names one set may carry; a real project has far fewer. */
export const MCP_SET_MAX_SERVERS = 200;

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A server name as `claude mcp list` prints it. Names carry spaces and colons
 * (`claude.ai Claude Docs`, `plugin:context7:context7`), so no character class is
 * enforced beyond control characters. Claude Code rejects a deny entry with a
 * blank name or edge whitespace, and that would lose the whole settings file.
 */
export const McpServerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(value => !hasControlCharacter(value), {
    message: "MCP server name contains a control character",
  });

/** True for a name a deny entry can carry exactly as written. */
export function isDenyableMcpName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const parsed = McpServerNameSchema.safeParse(name);
  return parsed.success && parsed.data === name;
}

export const McpSetSchema = z.discriminatedUnion("mode", [
  // Every configured server, overriding a project default.
  z.object({ mode: z.literal("all") }),
  z.object({
    mode: z.literal("only"),
    servers: z.array(McpServerNameSchema).max(MCP_SET_MAX_SERVERS),
    /** Servers in `servers` that are off for the project, to turn on for the whole
     *  project. Claude Code has no per-session way to enable one. Single-use: it is
     *  not stamped on the session. */
    enableForProject: z
      .array(McpServerNameSchema)
      .max(MCP_SET_MAX_SERVERS)
      .optional(),
  }),
]);
export type McpSet = z.infer<typeof McpSetSchema>;

/** True for a set that narrows the session's servers. */
export function isNarrowingMcpSet(
  set: McpSet | null | undefined
): set is Extract<McpSet, { mode: "only" }> {
  return set?.mode === "only";
}

/**
 * Canonical form of a set: names unique and sorted, `hapi` removed because it is
 * always on, and `enableForProject` limited to names in the set and dropped when
 * empty. Idempotent.
 */
export function normalizeMcpSet(set: McpSet): McpSet {
  if (set.mode === "all") return { mode: "all" };
  const servers = [...new Set(set.servers)]
    .filter(name => name !== HAPI_MCP_SERVER_NAME)
    .sort();
  const inSet = new Set(servers);
  const enableForProject = [...new Set(set.enableForProject ?? [])]
    .filter(name => inSet.has(name))
    .sort();
  return enableForProject.length > 0
    ? { mode: "only", servers, enableForProject }
    : { mode: "only", servers };
}

/** What the per-session settings file must carry for a set. */
export interface McpDenyPolicy {
  /** Server names to deny, sorted. Never contains `hapi`. */
  deny: string[];
  /** True when the set names no connector, so connectors are off outright (this
   *  also covers a connector added after the last status poll). */
  connectorsOff: boolean;
}

/**
 * The deny list for a set, given every server name known for the project. A name
 * nothing knows about cannot be denied, so it stays on: this fails toward an extra
 * server, never toward losing tools.
 */
export function resolveMcpDenyPolicy(
  set: McpSet,
  known: Iterable<string>
): McpDenyPolicy {
  if (set.mode === "all") return { deny: [], connectorsOff: false };
  const keep = new Set(set.servers);
  keep.add(HAPI_MCP_SERVER_NAME);
  // Only names a deny entry can carry: Claude Code rejects the whole settings
  // file over one bad entry, which would lose more than the set.
  const deny = [...new Set(known)]
    .filter(name => isDenyableMcpName(name) && !keep.has(name))
    .sort();
  return {
    deny,
    connectorsOff: !set.servers.some(name =>
      name.startsWith(CLAUDE_AI_CONNECTOR_PREFIX)
    ),
  };
}

/**
 * The set as a session or a project default records it: normalized, with the
 * single-use `enableForProject` dropped (the project write already happened).
 */
export function stampedMcpSet(set: McpSet): McpSet {
  const normalized = normalizeMcpSet(set);
  return normalized.mode === "only"
    ? { mode: "only", servers: normalized.servers }
    : normalized;
}

/** Why a live MCP toggle (or a desired-state batch) is refused, if it is. */
export interface McpLiveToggleRefusal {
  code: "hapi_protected" | "mcp_set_requires_relaunch";
  message: string;
}

/**
 * Issue #6171: refuse a live MCP change before anything is written.
 *
 * - Turning `hapi` off would cut the session off from Hapimatic's own tools, and
 *   the durable write lands before the SDK call, so it is refused up front.
 * - A session started with a narrowing set denies its other servers through its
 *   `--settings` file, which Claude Code reads only at start: a toggle there fails
 *   ("blocked by enterprise managed policy") AFTER the durable write has changed
 *   the project's list. Its servers change through the set and a relaunch.
 */
export function mcpLiveToggleRefusal(
  sessionSet: McpSet | undefined,
  changes: Record<string, boolean>
): McpLiveToggleRefusal | null {
  if (changes[HAPI_MCP_SERVER_NAME] === false) {
    return {
      code: "hapi_protected",
      message: "Hapimatic's own MCP server (hapi) stays on in every session.",
    };
  }
  if (sessionSet?.mode === "only") {
    return {
      code: "mcp_set_requires_relaunch",
      message:
        "This session started with a chosen set of MCP servers, which Claude Code reads only at start. Change the session's MCP servers and relaunch it instead.",
    };
  }
  return null;
}

/** Upper bound on the known names one launch carries. */
export const MCP_KNOWN_MAX_NAMES = 1000;

/**
 * The known names a deny list can use: valid names exactly as written (a name
 * with edge whitespace cannot be a deny entry), unique, sorted, capped at
 * `MCP_KNOWN_MAX_NAMES`. A dropped name is not denied, so it stays on. That
 * fails toward an extra server, never toward losing the set (#6171: one bad name
 * from a config file used to make the wrapper discard the whole set).
 */
export function sanitizeKnownMcpNames(names: Iterable<unknown>): string[] {
  const valid = new Set<string>();
  for (const name of names) {
    if (isDenyableMcpName(name)) valid.add(name);
  }
  return [...valid].sort().slice(0, MCP_KNOWN_MAX_NAMES);
}

/**
 * What the daemon hands the session wrapper as `--hapi-mcp-set <json>`: the set
 * and the names the server knows for the project, from which the wrapper builds
 * the deny list. One JSON argument so names with spaces and colons need no
 * further quoting rules beyond the tmux path's `escapeShellArg`. `known` is
 * read leniently: a bad entry is dropped, never the payload.
 */
export const McpSetLaunchPayloadSchema = z.object({
  set: McpSetSchema,
  known: z
    .array(z.unknown())
    .default([])
    .transform(names => sanitizeKnownMcpNames(names)),
});
export type McpSetLaunchPayload = z.infer<typeof McpSetLaunchPayloadSchema>;

export function encodeMcpSetLaunchArg(set: McpSet, known: string[]): string {
  return JSON.stringify({ set, known: sanitizeKnownMcpNames(known) });
}

/** The payload, or null when the argument or its set is not a valid one. */
export function parseMcpSetLaunchArg(
  raw: string | undefined
): McpSetLaunchPayload | null {
  if (!raw) return null;
  try {
    const result = McpSetLaunchPayloadSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a raw MCP server name to the key its tools carry, so
 * `mcpInstructions[].serverName` can be joined to its tools. Mirrors Claude Code
 * (2.1.302): it replaces every character outside `[a-zA-Z0-9_-]` with `_`, and for
 * a `claude.ai ` name also collapses `_` runs and trims an edge `_`; a tool's
 * `serverName` is then the segment of `mcp__<server>__<tool>` before the next `__`.
 * Idempotent on a tool's `serverName`. The `__` suffix keeps a trailing `_` that
 * `split` would otherwise lose (#6409 item 2: `MyServer(dev)`).
 */
export function normalizeMcpServerName(name: string): string {
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (name.startsWith(CLAUDE_AI_CONNECTOR_PREFIX)) {
    normalized = normalized.replace(/_+/g, "_").replace(/^_|_$/g, "");
  }
  return `${normalized}__`.split("__")[0] || normalized;
}

export interface McpServerUsage {
  /**
   * The raw server name when known (the first of {@link names} from the
   * instructions), else the tools'.
   */
  name: string;
  /**
   * Every raw server name this row covers, from Claude Code's instruction rows
   * in reply order, else the tools' key. More than one means the servers share
   * the tool prefix before `__`, so Claude Code reports their tools together
   * and their costs cannot be split (#6409 item 3).
   */
  names: string[];
  /** Tools whose schemas are in the context window. */
  loadedTokens: number;
  loadedTools: number;
  /** Deferred tool schemas — not in the context window. */
  deferredTokens: number;
  /** Deferred tools, counted beside `loadedTools`. */
  deferredTools: number;
  /** The server's instructions; 0 when Claude Code reports none. */
  instructionTokens: number;
}

/** In-context tokens a server costs: its loaded tool schemas plus its instructions. */
export function mcpServerContextTokens(server: McpServerUsage): number {
  return server.loadedTokens + server.instructionTokens;
}

/** One row per MCP server, largest in-context cost first. */
export function groupMcpServers(
  detail: Pick<ContextUsageDetail, "mcpTools" | "mcpInstructions">
): McpServerUsage[] {
  const servers = new Map<string, McpServerUsage>();
  const entry = (name: string): McpServerUsage => {
    const key = normalizeMcpServerName(name);
    let server = servers.get(key);
    if (!server) {
      server = {
        name,
        names: [],
        loadedTokens: 0,
        loadedTools: 0,
        deferredTokens: 0,
        deferredTools: 0,
        instructionTokens: 0,
      };
      servers.set(key, server);
    }
    return server;
  };
  for (const tool of detail.mcpTools ?? []) {
    const server = entry(tool.serverName);
    if (tool.isLoaded === false) {
      server.deferredTokens += tool.tokens;
      server.deferredTools += 1;
    } else {
      server.loadedTokens += tool.tokens;
      server.loadedTools += 1;
    }
  }
  // `names` comes from the instructions only: a tool's key is the prefix before
  // `__`, so an ordinary `my__x` server would otherwise read as two servers.
  for (const instruction of detail.mcpInstructions ?? []) {
    const server = entry(instruction.serverName);
    if (!server.names.includes(instruction.serverName)) {
      server.names.push(instruction.serverName);
    }
    server.instructionTokens += instruction.tokens;
  }
  for (const server of servers.values()) {
    if (server.names.length === 0) server.names = [server.name];
    server.name = server.names[0];
  }
  return [...servers.values()].sort(
    (a, b) =>
      mcpServerContextTokens(b) - mcpServerContextTokens(a) ||
      b.deferredTokens - a.deferredTokens
  );
}
