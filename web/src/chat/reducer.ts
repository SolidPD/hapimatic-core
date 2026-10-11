// SPDX-License-Identifier: AGPL-3.0-only
import {
  foldSessionTokenUsage,
  type TokenUsageRow,
} from "@hapi/protocol/tokenUsageAggregation";

import type { AgentState } from "@/types/api";
import type {
  ChatBlock,
  NormalizedMessage,
  SessionTokenStats,
  UsageData,
} from "@/chat/types";
import { traceMessages, type TracedMessage } from "@/chat/tracer";
import { dedupeAgentEvents, foldApiErrorEvents } from "@/chat/reducerEvents";
import {
  collectTitleChanges,
  collectToolIdsFromMessages,
  ensureToolBlock,
  getPermissions,
} from "@/chat/reducerTools";
import { reduceTimeline } from "@/chat/reducerTimeline";

// Calculate context size from usage data
function calculateContextSize(usage: UsageData): number {
  return (
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    usage.input_tokens
  );
}

export type LatestUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
  contextSize: number;
  timestamp: number;
};

export function reduceChatBlocks(
  normalized: NormalizedMessage[],
  agentState: AgentState | null | undefined
): {
  blocks: ChatBlock[];
  hasReadyEvent: boolean;
  latestUsage: LatestUsage | null;
  tokenStats: SessionTokenStats | null;
} {
  const permissionsById = getPermissions(agentState);
  const toolIdsInMessages = collectToolIdsFromMessages(normalized);
  const titleChangesByToolUseId = collectTitleChanges(normalized);

  const traced = traceMessages(normalized);
  const groups = new Map<string, TracedMessage[]>();
  const root: TracedMessage[] = [];

  for (const msg of traced) {
    if (msg.sidechainId) {
      const existing = groups.get(msg.sidechainId) ?? [];
      existing.push(msg);
      groups.set(msg.sidechainId, existing);
    } else {
      root.push(msg);
    }
  }

  const consumedGroupIds = new Set<string>();
  const emittedTitleChangeToolUseIds = new Set<string>();
  const reducerContext = {
    permissionsById,
    groups,
    consumedGroupIds,
    titleChangesByToolUseId,
    emittedTitleChangeToolUseIds,
  };
  const rootResult = reduceTimeline(root, reducerContext);
  let hasReadyEvent = rootResult.hasReadyEvent;

  // Create permission-only tool cards for PENDING permissions that need user action.
  // Skip completed/denied/canceled permissions whose tool-call messages are in unloaded
  // pages — otherwise they appear as phantom duplicate cards at the bottom of the chat.
  for (const [id, entry] of permissionsById) {
    if (toolIdsInMessages.has(id)) continue;
    if (rootResult.toolBlocksById.has(id)) continue;
    if (entry.permission.status !== "pending") continue;

    const createdAt = entry.permission.createdAt ?? Date.now();
    ensureToolBlock(rootResult.blocks, rootResult.toolBlocksById, id, {
      createdAt,
      localId: null,
      name: entry.toolName,
      input: entry.input,
      description: null,
      permission: entry.permission,
    });
  }

  // Aggregate token usage (#2229): the four cumulative TOTALS come from the
  // SHARED per-run fold (`@hapi/protocol/tokenUsageAggregation` — message.id
  // dedup for per-content-block duplicate rows; a result event closes its run
  // sourcing modelUsage/usage, the only real output-token source in
  // SDK-launcher sessions). The server parity recompute consumes the SAME
  // module, so the harness baseline provably mirrors this display.
  const foldTotals = foldSessionTokenUsage(
    normalized.map(
      (msg): TokenUsageRow => ({
        apiMessageId: msg.apiMessageId ?? null,
        usage: msg.usage ? { ...msg.usage } : null,
        resultUsage: msg.resultUsage ?? null,
        resultModelUsage: msg.resultModelUsage ?? null,
      })
    )
  );
  const totalInput = foldTotals.tokIn;
  const totalOutput = foldTotals.tokOut;
  const totalCacheCreation = foldTotals.tokCacheWrite;
  const totalCacheRead = foldTotals.tokCacheRead;

  // Per-message artifacts (latestUsage / peakContextSize / timeline) stay a
  // forward pass over per-message usage — they are display timelines, not
  // billable totals, and result rows deliberately do NOT contribute entries.
  // Context occupancy (input+cache) is final at message_start, so placeholder
  // output does not affect it.
  let latestUsage: LatestUsage | null = null;
  let turnCount = 0;
  let peakContextSize = 0;
  const timeline: SessionTokenStats["timeline"] = [];
  const timelineSeenIds = new Set<string>();

  for (const msg of normalized) {
    if (!msg.usage) continue;
    const u = msg.usage;

    // #2229: dedup timeline/turnCount by apiMessageId so ~1.5 rows per API
    // message no longer over-count turns; rows without an id count per-row.
    const isDuplicateBlockRow =
      msg.apiMessageId !== undefined && timelineSeenIds.has(msg.apiMessageId);
    if (!isDuplicateBlockRow) {
      if (msg.apiMessageId !== undefined) {
        timelineSeenIds.add(msg.apiMessageId);
      }
      turnCount++;
      timeline.push({
        timestamp: msg.createdAt,
        input: u.input_tokens,
        output: u.output_tokens,
      });
    }

    const ctx = calculateContextSize(u);
    if (ctx > peakContextSize) peakContextSize = ctx;

    // Last message with usage becomes latestUsage (forward pass — final
    // assignment wins, equivalent to the previous reverse-scan)
    latestUsage = {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheCreation: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      contextSize: ctx,
      timestamp: msg.createdAt,
    };
  }

  const tokenStats: SessionTokenStats | null =
    turnCount > 0 ||
    totalInput + totalOutput + totalCacheCreation + totalCacheRead > 0
      ? {
          totalInput,
          totalOutput,
          totalCacheCreation,
          totalCacheRead,
          turnCount,
          peakContextSize,
          timeline,
        }
      : null;

  const finalBlocks = dedupeAgentEvents(foldApiErrorEvents(rootResult.blocks));

  return {
    blocks: finalBlocks,
    hasReadyEvent,
    latestUsage,
    tokenStats,
  };
}
