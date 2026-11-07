// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

// Issue #6170 (epic #6163, Sub D1) — the wire contract for Claude Code's full
// `get_context_usage` reply, as the `get-context-usage` capability returns it
// when called with `{ "detail": "full" }`. Without that input the capability
// returns only the five core fields below (the #1469 shape), so existing callers
// and agents see no change.
//
// Claude Code adds fields between versions — `mcpInstructions` exists from
// 2.1.316 on and only where the CLI answers on its own stdio (Hapimatic's SDK
// launcher does) — so everything except the five core fields is optional, every
// object schema is `.passthrough()` per the shared/CLAUDE.md upstream rule, and
// `parseContextUsageDetail` validates each section on its own: one malformed
// section is dropped instead of failing the whole reply. Keys this module does
// not model (`gridRows`, `apiUsage`, `slashCommands`, …) ride through untouched.

/** One row of the context stack, in the order Claude Code reports it (context order). */
export const ContextUsageCategorySchema = z
  .object({
    name: z.string(),
    tokens: z.number(),
    color: z.string().optional(),
    /** Loaded on demand (deferred tool schemas); not in the context window. */
    isDeferred: z.boolean().optional(),
    /** `used` | `free` | `buffer` | `deferred` (Claude Code 2.1.302+). */
    kind: z.string().optional(),
  })
  .passthrough();
export type ContextUsageCategory = z.infer<typeof ContextUsageCategorySchema>;

export const ContextUsageMemoryFileSchema = z
  .object({ path: z.string(), type: z.string(), tokens: z.number() })
  .passthrough();
export type ContextUsageMemoryFile = z.infer<
  typeof ContextUsageMemoryFileSchema
>;

export const ContextUsageMcpToolSchema = z
  .object({
    name: z.string(),
    /** Normalized server name (the `mcp__<server>__` segment of the tool name). */
    serverName: z.string(),
    tokens: z.number(),
    /** `false` = a deferred schema, not in the context window. */
    isLoaded: z.boolean().optional(),
  })
  .passthrough();
export type ContextUsageMcpTool = z.infer<typeof ContextUsageMcpToolSchema>;

export const ContextUsageMcpInstructionSchema = z
  .object({
    /** Raw server name, as `mcp_status` reports it (NOT normalized). */
    serverName: z.string(),
    tokens: z.number(),
  })
  .passthrough();
export type ContextUsageMcpInstruction = z.infer<
  typeof ContextUsageMcpInstructionSchema
>;

export const ContextUsageAgentSchema = z
  .object({ agentType: z.string(), source: z.string(), tokens: z.number() })
  .passthrough();
export type ContextUsageAgent = z.infer<typeof ContextUsageAgentSchema>;

export const ContextUsageSkillSchema = z
  .object({
    name: z.string(),
    source: z.string(),
    pluginName: z.string().optional(),
    tokens: z.number(),
  })
  .passthrough();
export type ContextUsageSkill = z.infer<typeof ContextUsageSkillSchema>;

export const ContextUsageSkillsSchema = z
  .object({
    totalSkills: z.number(),
    includedSkills: z.number(),
    tokens: z.number(),
    skillFrontmatter: z.array(ContextUsageSkillSchema).optional(),
  })
  .passthrough();
export type ContextUsageSkills = z.infer<typeof ContextUsageSkillsSchema>;

export const ContextUsageToolTypeSchema = z
  .object({
    name: z.string(),
    callTokens: z.number(),
    resultTokens: z.number(),
  })
  .passthrough();
export type ContextUsageToolType = z.infer<typeof ContextUsageToolTypeSchema>;

export const ContextUsageAttachmentTypeSchema = z
  .object({ name: z.string(), tokens: z.number() })
  .passthrough();

export const ContextUsageMessageBreakdownSchema = z
  .object({
    toolCallTokens: z.number(),
    toolResultTokens: z.number(),
    attachmentTokens: z.number(),
    assistantMessageTokens: z.number(),
    userMessageTokens: z.number(),
    redirectedContextTokens: z.number().optional(),
    unattributedTokens: z.number().optional(),
    toolCallsByType: z.array(ContextUsageToolTypeSchema).optional(),
    attachmentsByType: z.array(ContextUsageAttachmentTypeSchema).optional(),
  })
  .passthrough();
export type ContextUsageMessageBreakdown = z.infer<
  typeof ContextUsageMessageBreakdownSchema
>;

/** The five fields the capability has returned since #1469 (always present). */
export const ContextUsageCoreSchema = z
  .object({
    model: z.string(),
    maxTokens: z.number(),
    rawMaxTokens: z.number(),
    totalTokens: z.number(),
    percentage: z.number(),
  })
  .passthrough();

/**
 * The optional sections, each validated on its own by
 * {@link parseContextUsageDetail}. Defined once so the documented schema and the
 * tolerant parser cannot disagree about a section's shape.
 */
const CONTEXT_USAGE_SECTIONS = {
  categories: z.array(ContextUsageCategorySchema),
  memoryFiles: z.array(ContextUsageMemoryFileSchema),
  mcpTools: z.array(ContextUsageMcpToolSchema),
  mcpInstructions: z.array(ContextUsageMcpInstructionSchema),
  agents: z.array(ContextUsageAgentSchema),
  skills: ContextUsageSkillsSchema,
  messageBreakdown: ContextUsageMessageBreakdownSchema,
  autoCompactThreshold: z.number(),
  isAutoCompactEnabled: z.boolean(),
} as const;

/**
 * The full reply: the five core fields plus every optional section. This is the
 * documented shape (its JSON Schema is the capability's `outputSchema`); parse
 * untrusted input with {@link parseContextUsageDetail}, not with this schema,
 * so one bad section does not discard the rest.
 */
export const ContextUsageDetailSchema = ContextUsageCoreSchema.extend({
  categories: CONTEXT_USAGE_SECTIONS.categories.optional(),
  memoryFiles: CONTEXT_USAGE_SECTIONS.memoryFiles.optional(),
  mcpTools: CONTEXT_USAGE_SECTIONS.mcpTools.optional(),
  mcpInstructions: CONTEXT_USAGE_SECTIONS.mcpInstructions.optional(),
  agents: CONTEXT_USAGE_SECTIONS.agents.optional(),
  skills: CONTEXT_USAGE_SECTIONS.skills.optional(),
  messageBreakdown: CONTEXT_USAGE_SECTIONS.messageBreakdown.optional(),
  autoCompactThreshold: CONTEXT_USAGE_SECTIONS.autoCompactThreshold.optional(),
  isAutoCompactEnabled: CONTEXT_USAGE_SECTIONS.isAutoCompactEnabled.optional(),
}).passthrough();
export type ContextUsageDetail = z.infer<typeof ContextUsageDetailSchema>;

/** The array sections, parsed entry by entry (one odd entry drops only itself). */
const CONTEXT_USAGE_ARRAY_ENTRIES = {
  categories: ContextUsageCategorySchema,
  memoryFiles: ContextUsageMemoryFileSchema,
  mcpTools: ContextUsageMcpToolSchema,
  mcpInstructions: ContextUsageMcpInstructionSchema,
  agents: ContextUsageAgentSchema,
} as const;

/**
 * Where {@link parseContextUsageDetail} could not read part of a reply: the
 * section name → how many entries it dropped (`0` when the whole section was
 * unreadable). Absent when everything parsed. A client-side annotation, not a
 * Claude Code field.
 */
export type ContextUsageUnreadEntries = Record<string, number>;

export type ParsedContextUsageDetail = ContextUsageDetail & {
  unreadEntries?: ContextUsageUnreadEntries;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a `get-context-usage` `usage` payload tolerantly. Returns `null` when the
 * five core fields are missing or malformed; otherwise keeps every key except a
 * reply-supplied `unreadEntries` (which a reply must not be able to forge) and
 * replaces each known section with its parsed value. An array section keeps the
 * entries that match and drops the rest; any other section that does not match
 * is dropped whole. Everything dropped is counted in `unreadEntries`, so a reader
 * can say "could not read N entries" instead of showing an empty list.
 */
export function parseContextUsageDetail(
  raw: unknown
): ParsedContextUsageDetail | null {
  if (!isRecord(raw)) return null;
  const core = ContextUsageCoreSchema.safeParse(raw);
  if (!core.success) return null;
  const out: Record<string, unknown> = { ...raw, ...core.data };
  delete out.unreadEntries;
  const unread: ContextUsageUnreadEntries = {};
  for (const [key, schema] of Object.entries(CONTEXT_USAGE_SECTIONS)) {
    if (!(key in raw)) continue;
    const value = raw[key];
    const entry =
      CONTEXT_USAGE_ARRAY_ENTRIES[
        key as keyof typeof CONTEXT_USAGE_ARRAY_ENTRIES
      ];
    if (entry && Array.isArray(value)) {
      const kept: unknown[] = [];
      for (const item of value) {
        const parsed = entry.safeParse(item);
        if (parsed.success) kept.push(parsed.data);
      }
      out[key] = kept;
      if (kept.length < value.length) unread[key] = value.length - kept.length;
      continue;
    }
    const section = schema.safeParse(value);
    if (section.success) {
      out[key] = section.data;
    } else {
      delete out[key];
      unread[key] = 0;
    }
  }
  if (Object.keys(unread).length > 0) out.unreadEntries = unread;
  return out as ParsedContextUsageDetail;
}

/** The handler's reply, carried in the invoke envelope's `data`. */
export type GetContextUsageResult =
  | { ok: true; usage: ParsedContextUsageDetail }
  | { ok: false; code: string; error: string };

/**
 * Parse the `data` of a `get-context-usage` invoke reply. A CLI-shaped failure
 * keeps its code and message. A throwing RPC handler answers
 * `{ type: "error", errorMessage }` inside a 200 envelope; that becomes code
 * `handler_error` with the handler's message. Returns `null` for any other
 * shape.
 */
export function parseGetContextUsageResult(
  data: unknown
): GetContextUsageResult | null {
  if (!isRecord(data)) return null;
  if (data.ok === true) {
    const usage = parseContextUsageDetail(data.usage);
    return usage ? { ok: true, usage } : null;
  }
  if (
    data.ok === false &&
    typeof data.code === "string" &&
    typeof data.error === "string"
  ) {
    return { ok: false, code: data.code, error: data.error };
  }
  if (data.type === "error") {
    return {
      ok: false,
      code: "handler_error",
      error:
        typeof data.errorMessage === "string"
          ? data.errorMessage
          : "The session's context handler failed.",
    };
  }
  return null;
}
