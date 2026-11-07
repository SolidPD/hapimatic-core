// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure helpers behind the context breakdown modal (issue #6170, epic #6163
 * Sub D1): the section stack, the per-MCP-server list, the trend over the
 * session, and the trim suggestions. No React, no I/O — the modal renders what
 * these return.
 *
 * The section order is Claude Code's own: it reports `categories` in the order
 * they enter the context (system prompt, system tools, MCP, custom agents,
 * memory files, skills, messages, compact buffer, free space — verified against
 * Claude Code 2.1.302 and 2.1.316). These helpers keep that order, merge the two
 * MCP rows into one section, and move deferred rows (tool schemas loaded on
 * demand, not in the context window) into their own list.
 */
import type {
  ContextUsageCategory,
  ContextUsageDetail,
  TurnTokenBreakdown,
} from "@hapi/protocol";
import { formatTokens } from "@/lib/formatTokens";

export type ContextSectionKey =
  | "system-prompt"
  | "system-tools"
  | "mcp"
  | "agents"
  | "memory"
  | "skills"
  | "messages"
  | "buffer"
  | "free"
  | "other";

export interface ContextSection {
  key: ContextSectionKey;
  label: string;
  tokens: number;
  /** tokens / the context window, 0..1. */
  shareOfWindow: number;
}

const SECTION_KEY_BY_CATEGORY: Record<string, ContextSectionKey> = {
  "System prompt": "system-prompt",
  "System tools": "system-tools",
  "MCP tools": "mcp",
  "MCP server instructions": "mcp",
  "Custom agents": "agents",
  "Memory files": "memory",
  Skills: "skills",
  Messages: "messages",
  "Autocompact buffer": "buffer",
  "Compact buffer": "buffer",
  "Free space": "free",
};

/** The label for a merged section; other sections keep Claude Code's name. */
const MERGED_LABEL: Partial<Record<ContextSectionKey, string>> = {
  mcp: "MCP",
};

export function isDeferredCategory(category: ContextUsageCategory): boolean {
  return category.isDeferred === true || category.kind === "deferred";
}

function share(tokens: number, windowTokens: number): number {
  return windowTokens > 0 ? tokens / windowTokens : 0;
}

/**
 * The context stack in Claude Code's order. Unknown future category names keep
 * their upstream position (key `other`). Empty when the reply has no categories.
 */
export function buildContextSections(detail: ContextUsageDetail): {
  sections: ContextSection[];
  deferred: ContextSection[];
} {
  const windowTokens = detail.maxTokens;
  const sections: ContextSection[] = [];
  const deferred: ContextSection[] = [];
  for (const category of detail.categories ?? []) {
    if (isDeferredCategory(category)) {
      deferred.push({
        key: "other",
        label: category.name,
        tokens: category.tokens,
        shareOfWindow: share(category.tokens, windowTokens),
      });
      continue;
    }
    const key = SECTION_KEY_BY_CATEGORY[category.name] ?? "other";
    const merged = MERGED_LABEL[key];
    const existing = merged
      ? sections.find(section => section.key === key)
      : undefined;
    if (existing) {
      existing.tokens += category.tokens;
      existing.shareOfWindow = share(existing.tokens, windowTokens);
      continue;
    }
    sections.push({
      key,
      label: merged ?? category.name,
      tokens: category.tokens,
      shareOfWindow: share(category.tokens, windowTokens),
    });
  }
  return { sections, deferred };
}

/**
 * The key `mcpTools[].serverName` carries for a raw server name, so the raw
 * `mcpInstructions[].serverName` can be joined to its tools. Mirrors Claude
 * Code (2.1.302): it replaces every character outside `[a-zA-Z0-9_-]` with
 * `_`, and for a `claude.ai ` name also collapses `_` runs and trims an edge
 * `_`; a tool's `serverName` is then the segment of `mcp__<server>__<tool>`
 * before the next `__`. Idempotent on a tool's `serverName`.
 */
export function normalizeMcpServerName(name: string): string {
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (name.startsWith("claude.ai ")) {
    normalized = normalized.replace(/_+/g, "_").replace(/^_|_$/g, "");
  }
  return normalized.split("__")[0] || normalized;
}

export interface McpServerUsage {
  /** The raw server name when known (from the instructions), else the tools'. */
  name: string;
  /** Tools whose schemas are in the context window. */
  loadedTokens: number;
  loadedTools: number;
  /** Deferred tool schemas — not in the context window. */
  deferredTokens: number;
  /** The server's instructions (Claude Code 2.1.316+); 0 when not reported. */
  instructionTokens: number;
}

/** In-context tokens a server costs: its loaded tool schemas plus its instructions. */
export function mcpServerContextTokens(server: McpServerUsage): number {
  return server.loadedTokens + server.instructionTokens;
}

/** One row per MCP server, largest in-context cost first. */
export function groupMcpServers(detail: ContextUsageDetail): McpServerUsage[] {
  const servers = new Map<string, McpServerUsage>();
  const entry = (name: string): McpServerUsage => {
    const key = normalizeMcpServerName(name);
    let server = servers.get(key);
    if (!server) {
      server = {
        name,
        loadedTokens: 0,
        loadedTools: 0,
        deferredTokens: 0,
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
    } else {
      server.loadedTokens += tool.tokens;
      server.loadedTools += 1;
    }
  }
  for (const instruction of detail.mcpInstructions ?? []) {
    const server = entry(instruction.serverName);
    server.name = instruction.serverName;
    server.instructionTokens += instruction.tokens;
  }
  return [...servers.values()].sort(
    (a, b) =>
      mcpServerContextTokens(b) - mcpServerContextTokens(a) ||
      b.deferredTokens - a.deferredTokens
  );
}

/**
 * In-context MCP tokens no server row accounts for: the MCP section's total
 * minus every server's loaded tools and instructions. Claude Code before
 * 2.1.316 sends no `mcpInstructions`, so there this is the whole instructions
 * total. 0 when every token is split by server.
 */
export function unitemizedMcpTokens(detail: ContextUsageDetail): number {
  const section = buildContextSections(detail).sections.find(
    s => s.key === "mcp"
  );
  if (!section) return 0;
  const itemized = groupMcpServers(detail).reduce(
    (sum, server) => sum + mcpServerContextTokens(server),
    0
  );
  return Math.max(0, section.tokens - itemized);
}

export interface ContextTrendPoint {
  at: number;
  tokens: number;
}

export interface ContextTrend {
  points: ContextTrendPoint[];
  start: number | null;
  peak: number | null;
  current: number | null;
  /** Indexes of points more than {@link TREND_DROP_SHARE} below the previous one. */
  drops: number[];
}

/** A point this far below the previous one reads as a compaction or a clear. */
export const TREND_DROP_SHARE = 0.2;

/**
 * The context size over the session: one point per turn that recorded it (the
 * server's turn-end `contextUsedTokens`), then the current reading.
 */
export function buildContextTrend(
  turns: readonly TurnTokenBreakdown[],
  current?: ContextTrendPoint
): ContextTrend {
  const points: ContextTrendPoint[] = [];
  for (const turn of turns) {
    const tokens = turn.contextUsedTokens;
    if (typeof tokens !== "number" || tokens <= 0) continue;
    points.push({ at: turn.endedAtMs ?? turn.startedAtMs, tokens });
  }
  if (current && current.tokens > 0) points.push(current);
  const drops: number[] = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i].tokens < points[i - 1].tokens * (1 - TREND_DROP_SHARE)) {
      drops.push(i);
    }
  }
  return {
    points,
    start: points.length > 0 ? points[0].tokens : null,
    peak:
      points.length > 0 ? Math.max(...points.map(point => point.tokens)) : null,
    current: points.length > 0 ? points[points.length - 1].tokens : null,
    drops,
  };
}

export interface TrimSuggestion {
  id: string;
  title: string;
  detail: string;
  /** The tokens the suggestion is about (the sort key). */
  tokens: number;
}

/** A memory file at least this large gets its own suggestion. */
export const MEMORY_FILE_LARGE_TOKENS = 5_000;
/** An MCP server whose loaded tools plus instructions reach this. */
export const MCP_SERVER_LARGE_TOKENS = 5_000;
/** The skills listing at least this large. */
export const SKILLS_LARGE_TOKENS = 10_000;
/** Custom agents at least this large. */
export const AGENTS_LARGE_TOKENS = 5_000;
/** The conversation at least this share of the window… */
export const MESSAGES_SHARE_OF_WINDOW = 0.5;
/** …or the context at least this full (percent), while the conversation… */
export const CONTEXT_FULL_PERCENT = 75;
/** …holds at least this share of what is used (so /compact would free room). */
export const MESSAGES_SHARE_OF_USED = 0.3;
/** One tool type's results at least this share of the conversation… */
export const TOOL_RESULTS_SHARE = 0.3;
/** …once the conversation holds at least this many tokens. */
export const TOOL_RESULTS_MIN_MESSAGE_TOKENS = 20_000;
/** At most this many suggestions are shown. */
export const MAX_TRIM_SUGGESTIONS = 5;

function categoryTokens(detail: ContextUsageDetail, name: string): number {
  return (detail.categories ?? [])
    .filter(category => category.name === name && !isDeferredCategory(category))
    .reduce((sum, category) => sum + category.tokens, 0);
}

/**
 * Rule-based suggestions for shrinking the context, largest first. Deferred
 * tool schemas take no context and never count toward a rule.
 */
export function buildTrimSuggestions(
  detail: ContextUsageDetail
): TrimSuggestion[] {
  const suggestions: TrimSuggestion[] = [];

  for (const file of detail.memoryFiles ?? []) {
    if (file.tokens < MEMORY_FILE_LARGE_TOKENS) continue;
    suggestions.push({
      id: `memory:${file.path}`,
      title: `${file.path} is ${formatTokens(file.tokens)} tokens`,
      detail:
        "Move sections Claude rarely needs into a file it reads on demand, or leave the file out of this project with the claudeMdExcludes setting.",
      tokens: file.tokens,
    });
  }

  for (const server of groupMcpServers(detail)) {
    const tokens = mcpServerContextTokens(server);
    if (tokens < MCP_SERVER_LARGE_TOKENS) continue;
    suggestions.push({
      id: `mcp:${server.name}`,
      title: `MCP server ${server.name} loads ${formatTokens(tokens)} tokens`,
      detail:
        "Turn it off for sessions that do not use it; its tools and instructions load into every turn.",
      tokens,
    });
  }

  const skills = detail.skills;
  if (skills && skills.tokens >= SKILLS_LARGE_TOKENS) {
    suggestions.push({
      id: "skills",
      title: `${skills.includedSkills} of ${skills.totalSkills} skills are listed (${formatTokens(skills.tokens)} tokens)`,
      detail:
        "Disable plugins or skills this project does not use so their descriptions stay out of the context.",
      tokens: skills.tokens,
    });
  }

  const agentTokens = categoryTokens(detail, "Custom agents");
  if (agentTokens >= AGENTS_LARGE_TOKENS) {
    suggestions.push({
      id: "agents",
      title: `Custom agents take ${formatTokens(agentTokens)} tokens`,
      detail: "Disable plugin agents this project does not use.",
      tokens: agentTokens,
    });
  }

  const messageTokens = categoryTokens(detail, "Messages");
  if (
    messageTokens > 0 &&
    (messageTokens >= MESSAGES_SHARE_OF_WINDOW * detail.maxTokens ||
      (detail.percentage >= CONTEXT_FULL_PERCENT &&
        messageTokens >= MESSAGES_SHARE_OF_USED * detail.totalTokens))
  ) {
    suggestions.push({
      id: "messages",
      title: `The conversation holds ${formatTokens(messageTokens)} tokens`,
      detail: "Run /compact, or start a new session for the next task.",
      tokens: messageTokens,
    });
  }

  const toolTypes = detail.messageBreakdown?.toolCallsByType ?? [];
  if (messageTokens >= TOOL_RESULTS_MIN_MESSAGE_TOKENS && toolTypes.length) {
    const largest = toolTypes.reduce((a, b) =>
      b.resultTokens > a.resultTokens ? b : a
    );
    if (largest.resultTokens >= TOOL_RESULTS_SHARE * messageTokens) {
      suggestions.push({
        id: `tool:${largest.name}`,
        title: `${largest.name} results take ${formatTokens(largest.resultTokens)} tokens of the conversation`,
        detail:
          "Ask for narrower output (filters, line ranges, specific files) so each result stays small.",
        tokens: largest.resultTokens,
      });
    }
  }

  return suggestions
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, MAX_TRIM_SUGGESTIONS);
}
