// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useCallback, useContext, useMemo, useRef } from "react";
import type { AppendMessage, ThreadMessageLike } from "@assistant-ui/react";
import {
  getExternalStoreMessages,
  useExternalMessageConverter,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { renderEventLabel } from "@/chat/presentation";
import type { ChatBlock, CliOutputBlock } from "@/chat/types";
import type { AgentEvent, ToolCallBlock } from "@/chat/types";
import type { MessageStatus as HappyMessageStatus, Session } from "@/types/api";
import type {
  GateDenialOutcome,
  TurnTokenBreakdown,
  TurnWorkflowBreakdown,
} from "@hapi/protocol";
import { labelToPhase } from "@hapi/protocol/workflowPhases";
import { turnCostTreatment, type CostTreatment } from "@/lib/costEstimate";

export const TurnDurationsContext = createContext<Map<string, number>>(
  new Map()
);

export const TurnStatusTextsContext = createContext<Map<string, string>>(
  new Map()
);

export function useTurnDuration(messageId: string): number | null {
  const durations = useContext(TurnDurationsContext);
  return durations.get(messageId) ?? null;
}

export function useTurnStatusText(messageId: string): string | null {
  const texts = useContext(TurnStatusTextsContext);
  return texts.get(messageId) ?? null;
}

/**
 * Per-turn token + cost totals attached to a turn-concluding message (issue
 * #1671, epic #1662 Sub I). Sourced from the server DB turn (R2), NOT the web
 * reducer's per-API-call aggregation — so the footer and `v_session_totals`
 * never disagree. `costTotal` is the rate-card-computed API value (D5).
 */
export type TurnTokens = {
  tokIn: number | null;
  tokOut: number | null;
  tokCacheRead: number | null;
  tokCacheWrite: number | null;
  costTotal: number | null;
  /**
   * Issue #3353: how this turn's cost is presented (the SINGLE real-vs-EQ
   * discriminator). Issue #4824: PER TURN — from the binding the ledger
   * recorded when THIS turn opened (`turnCostTreatment`), so a mid-session
   * switch never re-colours an earlier turn. A row with no recorded binding
   * falls back to the session's binding, never as a real charge. Carried here
   * so the per-turn footer classes its cost span with no new context.
   */
  costTreatment: CostTreatment;
};

export const TurnTokensContext = createContext<Map<string, TurnTokens>>(
  new Map()
);

export function useTurnTokens(messageId: string): TurnTokens | null {
  const tokens = useContext(TurnTokensContext);
  return tokens.get(messageId) ?? null;
}

/**
 * One workflow phase transition shown by the per-turn chip (issue #1672, Sub J).
 * `kind: "lock"` = phase active; `"checkpoint"` = phase done (R1). `issueNumber`
 * is the issue the label event actually touched — may be a sibling/epic, NOT the
 * session's linked issue (R5).
 */
export type WorkflowChip = {
  order: number;
  kind: "lock" | "checkpoint";
  display: string;
  issueNumber: number;
};

/**
 * Issue #1945: collapse a turn's raw per-event chips to AT MOST ONE chip per
 * (issueNumber, phase order). A full workflow phase emits THREE events within a
 * single turn — lock_added, checkpoint_added, lock_removed — and `labelToPhase`
 * is add/remove-agnostic, so the raw list contains three near-duplicate chips
 * ("researching" / "researched" / "researching"). Option C keeps the CHECKPOINT
 * chip when the phase completed in-turn (done), else a single LOCK chip for an
 * in-progress phase. Distinct issues at the same order are never merged (R5).
 * Output is ordered by phase order, then issue number, so the row reads in
 * workflow sequence regardless of label-event arrival order.
 */
export function collapseWorkflowChips(
  chips: readonly WorkflowChip[]
): WorkflowChip[] {
  const byKey = new Map<string, WorkflowChip>();
  for (const chip of chips) {
    const key = `${chip.issueNumber}:${chip.order}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, chip);
    } else if (existing.kind === "lock" && chip.kind === "checkpoint") {
      // Checkpoint (phase done) wins over lock (phase in-progress).
      byKey.set(key, chip);
    }
    // else: keep existing — already a checkpoint, or both lock (dedupe).
  }
  return [...byKey.values()].sort(
    (a, b) => a.order - b.order || a.issueNumber - b.issueNumber
  );
}

export const TurnWorkflowContext = createContext<Map<string, WorkflowChip[]>>(
  new Map()
);

export function useTurnWorkflow(messageId: string): WorkflowChip[] | null {
  const map = useContext(TurnWorkflowContext);
  return map.get(messageId) ?? null;
}

/**
 * Correlate a turn-concluding message to its server DB turn by timestamp bracket
 * (issue #1671, R2/R6). Turns are non-overlapping and ascending by seq, so the
 * first turn whose [startedAtMs, endedAtMs] window contains `createdAt` is the
 * match. Falls back to the most recent turn that STARTED before `createdAt` when
 * no window matches (handles the small skew where a concluding message's
 * createdAt lands just after the turn's ended_at_ms). Returns null when no turn
 * started before the message — e.g. a tool-only / no-text turn never reaches
 * this helper, so it cannot inherit the duration back-walk misattribution (R6).
 */
export function findTurnForTimestamp<
  T extends { startedAtMs: number; endedAtMs: number | null },
>(turns: readonly T[], createdAt: number): T | null {
  let best: T | null = null;
  for (const t of turns) {
    if (t.startedAtMs > createdAt) continue;
    if (t.endedAtMs == null || createdAt <= t.endedAtMs) return t;
    if (!best || t.startedAtMs > best.startedAtMs) best = t;
  }
  return best;
}

/**
 * Issue #3972: strict counterpart of `findTurnForTimestamp` for turns that have
 * no `turn-result` anchor (non-claude runners, and claude on the pty/tmux
 * launcher — #4068). Returns the FINALIZED turn
 * (`endedAtMs != null`) whose inclusive [startedAtMs, endedAtMs] window contains
 * `createdAt` — the latest-started one if windows overlap — else null. There is
 * deliberately no skew fallback: a message's `created_at` and its turn's times
 * normally come from the same CLI clock (the server substitutes its own clock
 * only for a future-dated `generatedAt` or an orphan close), and a mismatch then
 * just means no attachment — whereas, without an anchor event, a fallback would
 * pin a newer turn's text onto an older finalized turn whenever the breakdown
 * query is stale. An in-flight turn (`endedAtMs == null`) never matches.
 */
export function findFinalizedTurnBracketing<
  T extends { startedAtMs: number; endedAtMs: number | null },
>(turns: readonly T[], createdAt: number): T | null {
  let best: T | null = null;
  for (const t of turns) {
    if (t.endedAtMs == null) continue;
    if (createdAt < t.startedAtMs || createdAt > t.endedAtMs) continue;
    if (!best || t.startedAtMs > best.startedAtMs) best = t;
  }
  return best;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const stringified = JSON.stringify(value, null, 2);
    return typeof stringified === "string" ? stringified : String(value);
  } catch {
    return String(value);
  }
}

export type HappyChatMessageMetadata = {
  kind: "user" | "assistant" | "tool" | "event" | "cli-output";
  status?: HappyMessageStatus;
  localId?: string | null;
  originalText?: string;
  toolCallId?: string;
  event?: AgentEvent;
  source?: CliOutputBlock["source"];
  isInherited?: boolean;
  isTaskNotification?: boolean;
  /** #2162: synthetic/meta record (stop-hook feedback, etc.) → collapsed chip. */
  isMeta?: boolean;
  /** #3579: gate-denial outcome on a "blocked" user bubble (R2). */
  denial?: GateDenialOutcome;
};

/**
 * Issue #3270 (ruling D6): a `title-changed` agent-event is TURN-DERIVED when it
 * was built inside an assistant turn — a mid-turn `change_title` tool call
 * (`reducerTimeline.ts:186-193` / `:233-240`), which gives its block the composite
 * `${msg.id}:${idx}` id. A STANDALONE (turn-less) title-change event message
 * (`reducerTimeline.ts:49-69`) carries the bare server message id instead. Only the
 * turn-derived case takes the inline-part render path (so it joins the response
 * chunk and the `[data-cat="response"]` border stays unbroken); the standalone case
 * keeps the centered `HappySystemMessage` bubble — no information loss across the two
 * provenances. The composite `${msg.id}:${idx}` id is the reducer's documented block
 * convention (`types.ts:244`) and the only colon-bearing block-id shape (no synthetic
 * colon-bearing message ids exist in `normalize*.ts`).
 */
export function isTurnDerivedTitleChange(block: ChatBlock): boolean {
  return (
    block.kind === "agent-event" &&
    block.event.type === "title-changed" &&
    /:\d+$/.test(block.id)
  );
}

// Module-level pure converter — its identity MUST stay constant for the
// lifetime of the app. useExternalMessageConverter keys ALL of its caches on
// callback identity; a churning callback discards every cached converted
// message, invalidating every per-message tap store at once and tripping
// @assistant-ui/tap's >50-dirty-schedulers flush guard on long threads
// (issue #1636). Turn durations are delivered via TurnDurationsContext, NOT
// through message metadata.
//
// Exported for the converter-level test (issue #3270, expert-review [3270-8]):
// the concat-join split/merge — the actual bug mechanism — is unobservable in
// AssistantMessage.test.tsx (which stubs assistant-ui wholesale), so the role
// decision is asserted directly against this pure function.
export function toThreadMessageLike(block: ChatBlock): ThreadMessageLike {
  if (block.kind === "user-text") {
    const messageId = `user:${block.id}`;
    return {
      role: "user",
      id: messageId,
      createdAt: new Date(block.createdAt),
      content: [{ type: "text", text: block.text }],
      metadata: {
        custom: {
          kind: "user",
          status: block.status,
          localId: block.localId,
          originalText: block.originalText,
          denial: block.denial,
          isInherited: block.isInherited,
          isTaskNotification: block.isTaskNotification,
        } satisfies HappyChatMessageMetadata,
      },
    };
  }

  if (block.kind === "agent-text") {
    const messageId = `assistant:${block.id}`;
    return {
      role: "assistant",
      id: messageId,
      createdAt: new Date(block.createdAt),
      content: [{ type: "text", text: block.text }],
      metadata: {
        custom: {
          kind: "assistant",
          isInherited: block.isInherited,
          isTaskNotification: block.isTaskNotification,
          // #2162: surface the meta marker so AssistantMessage renders a chip.
          isMeta: block.isMeta,
        } satisfies HappyChatMessageMetadata,
      },
    };
  }

  if (block.kind === "agent-reasoning") {
    const messageId = `assistant:${block.id}`;
    return {
      role: "assistant",
      id: messageId,
      createdAt: new Date(block.createdAt),
      content: [{ type: "reasoning", text: block.text }],
      metadata: {
        custom: {
          kind: "assistant",
          isInherited: block.isInherited,
        } satisfies HappyChatMessageMetadata,
      },
    };
  }

  if (block.kind === "agent-event") {
    // Issue #3270 (ruling D6): a TURN-DERIVED title-change renders as an INLINE
    // assistant content part rather than a standalone role:"system" message. As
    // role:"assistant" it accretes into the surrounding response chunk
    // (assistant-ui's chunkExternalMessages joins consecutive assistant/tool
    // messages; user/system messages are chunk boundaries), so it no longer splits
    // the run and the [data-cat="response"] left border runs unbroken through it.
    // The label lives IN the part text so a transient part↔block correlation miss
    // in AssistantMessage degrades to plain text, never a lost bubble (the
    // AssistantMessage.tsx:104-108 safety floor). Standalone (turn-less)
    // title-change events and every other event type keep the role:"system"
    // conversion below → the centered HappySystemMessage bubble.
    if (isTurnDerivedTitleChange(block)) {
      return {
        role: "assistant",
        id: `assistant:${block.id}`,
        createdAt: new Date(block.createdAt),
        content: [{ type: "text", text: renderEventLabel(block.event) }],
        metadata: {
          custom: {
            kind: "assistant",
            event: block.event,
            isInherited: block.isInherited,
          } satisfies HappyChatMessageMetadata,
        },
      };
    }
    const messageId = `event:${block.id}`;
    return {
      role: "system",
      id: messageId,
      createdAt: new Date(block.createdAt),
      content: [{ type: "text", text: renderEventLabel(block.event) }],
      metadata: {
        custom: {
          kind: "event",
          event: block.event,
          isInherited: block.isInherited,
        } satisfies HappyChatMessageMetadata,
      },
    };
  }

  if (block.kind === "cli-output") {
    const messageId = `cli:${block.id}`;
    return {
      role: block.source === "user" ? "user" : "assistant",
      id: messageId,
      createdAt: new Date(block.createdAt),
      content: [{ type: "text", text: block.text }],
      metadata: {
        custom: {
          kind: "cli-output",
          source: block.source,
          isInherited: block.isInherited,
        } satisfies HappyChatMessageMetadata,
      },
    };
  }

  const toolBlock: ToolCallBlock = block;
  const messageId = `tool:${toolBlock.id}`;
  const inputText = safeStringify(toolBlock.tool.input);

  return {
    role: "assistant",
    id: messageId,
    createdAt: new Date(toolBlock.createdAt),
    content: [
      {
        type: "tool-call",
        toolCallId: toolBlock.id,
        toolName: toolBlock.tool.name,
        argsText: inputText,
        result: toolBlock.tool.result,
        isError: toolBlock.tool.state === "error",
        artifact: toolBlock,
      },
    ],
    metadata: {
      custom: {
        kind: "tool",
        toolCallId: toolBlock.id,
        isInherited: toolBlock.isInherited,
      } satisfies HappyChatMessageMetadata,
    },
  };
}

function getTextFromAppendMessage(message: AppendMessage): string | null {
  if (message.role !== "user") return null;

  const parts = message.content;
  const text = parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof part.text === "string"
    )
    .map(part => part.text)
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
}

export function useHappyRuntime(props: {
  session: Session;
  blocks: readonly ChatBlock[];
  isSending: boolean;
  onSendMessage: (text: string) => void;
  onAbort: () => Promise<void>;
  /**
   * Server per-turn token breakdown (issue #1671). Used to attach DB-turn tokens
   * to each turn-concluding message by timestamp bracket. Undefined until the
   * `useSessionTokenStats` query resolves; the footer just shows no tokens until
   * then (graceful — the duration/status footer still renders).
   */
  turnBreakdown?: readonly TurnTokenBreakdown[];
  /**
   * Server per-turn workflow label events (issue #1672, Sub J). Attached to each
   * turn-concluding message by the same timestamp bracket as tokens. Undefined
   * until `useSessionWorkflowState` resolves (graceful — chips just don't show).
   */
  turnWorkflow?: readonly TurnWorkflowBreakdown[];
}) {
  // Pre-process blocks: extract turn-result / turn-duration (#4095) durations
  // and background task status, attach them to the preceding assistant
  // messages, then filter out internal event blocks.
  const {
    filteredBlocks,
    turnDurations,
    turnStatusTexts,
    turnTokens,
    turnWorkflow,
  } = useMemo(() => {
    const durations = new Map<string, number>();
    const statusTexts = new Map<string, string>();
    const tokensMap = new Map<string, TurnTokens>();
    const workflowMap = new Map<string, WorkflowChip[]>();
    // Issue #3972: DB turns already attached by a `turn-result` (pass 1), so the
    // second pass below never re-attaches one to a second block.
    const attachedSeqs = new Set<number>();
    const breakdown = props.turnBreakdown ?? [];
    const workflowBreakdown = props.turnWorkflow ?? [];
    const blocks = props.blocks as ChatBlock[];
    // Issue #3353 / #4824: each turn's cost treatment comes from the binding
    // recorded on THAT turn; the session's binding (#3351) is only the fallback
    // for a row with none.
    const sessionBindingKind = props.session.metadata?.authBinding?.kind;

    // Track active background tasks across the message stream
    const activeTasks = new Set<string>();

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.kind !== "agent-event") continue;

      if (block.event.type === "task-started") {
        const evt = block.event as { task_id: string };
        activeTasks.add(evt.task_id);
      } else if (block.event.type === "task-completed") {
        const evt = block.event as { task_id: string };
        activeTasks.delete(evt.task_id);
      } else if (block.event.type === "turn-result") {
        const event = block.event as { duration_ms: number };
        // Walk backwards to find the last agent-text block
        for (let j = i - 1; j >= 0; j--) {
          if (blocks[j].kind === "agent-text") {
            durations.set(blocks[j].id, event.duration_ms);
            // Issue #1671: attach the DB turn's tokens + API value to this
            // turn-concluding message (R2 — DB turn, not the reducer aggregate).
            const turn = findTurnForTimestamp(breakdown, blocks[j].createdAt);
            if (turn) {
              attachedSeqs.add(turn.seq);
              tokensMap.set(blocks[j].id, {
                tokIn: turn.tokIn,
                tokOut: turn.tokOut,
                tokCacheRead: turn.tokCacheRead,
                tokCacheWrite: turn.tokCacheWrite,
                costTotal: turn.costTotal,
                costTreatment: turnCostTreatment(
                  turn.authBindingKind,
                  sessionBindingKind
                ),
              });
            }
            // Issue #1672 (Sub J): attach this turn's workflow label events
            // as per-turn chips, keyed by the issue each event touched (R5).
            // Skip non-workflow labels (labelToPhase returns null).
            const wfTurn = findTurnForTimestamp(
              workflowBreakdown,
              blocks[j].createdAt
            );
            if (wfTurn) {
              const chips: WorkflowChip[] = [];
              for (const ev of wfTurn.events) {
                const phase = labelToPhase(ev.label);
                if (phase) {
                  chips.push({
                    order: phase.order,
                    kind: phase.kind,
                    display: phase.display,
                    issueNumber: ev.issueNumber,
                  });
                }
              }
              if (chips.length > 0)
                workflowMap.set(blocks[j].id, collapseWorkflowChips(chips));
            }
            // If there are active background tasks at this turn boundary,
            // record a status text for this assistant message
            if (activeTasks.size > 0) {
              const n = activeTasks.size;
              statusTexts.set(
                blocks[j].id,
                `${n} background ${n === 1 ? "task" : "tasks"} running`
              );
            }
            break;
          }
        }
      } else if (block.event.type === "turn-duration") {
        // Issue #4095: claude pty/tmux turn clock. Duration ONLY — tokens/cost
        // stay on the second pass (#4068) and background-task text stays
        // SDK-only. A `turn-result` for the same text always wins (its set above
        // is unconditional), and this never crosses a user message, so a
        // text-less turn attaches nothing (no back-walk misattribution, #1671 R6).
        const event = block.event as { duration_ms: number };
        for (let j = i - 1; j >= 0; j--) {
          const prev = blocks[j];
          if (prev.kind === "user-text") break;
          if (prev.kind === "agent-text") {
            if (!durations.has(prev.id))
              durations.set(prev.id, event.duration_ms);
            break;
          }
        }
      }
    }

    // Issue #3972: non-claude runners (gemini/opencode ACP, codex) write DB turn
    // rows (#3352) but never emit a `turn-result` — only the Claude SDK launcher
    // does — so pass 1 never fires for them. Attach each FINALIZED turn to the
    // last agent-text block inside its window.
    // Issue #4068: claude on the pty/tmux launcher emits no `turn-result` either.
    // A claude session can switch launchers across a #1660 relaunch, so each turn
    // is judged by the launcher its own DB row recorded, falling back to the
    // session's current launcher for rows (or older federation peers) that carry
    // none. An `sdk` turn never enters this pass, so the SDK footer stays
    // byte-identical; flavor-absent sessions are treated as claude.
    const flavor = props.session.metadata?.flavor;
    const isClaudeSession = !flavor || flavor === "claude";
    const sessionLauncher = props.session.metadata?.launcherKind;
    const pass2Turns = isClaudeSession
      ? breakdown.filter(t => {
          const launcher = t.launcher ?? sessionLauncher;
          return launcher === "pty" || launcher === "tmux";
        })
      : breakdown;
    if (pass2Turns.length > 0) {
      const lastTextBySeq = new Map<number, string>();
      for (const b of blocks) {
        if (b.kind !== "agent-text") continue;
        const turn = findFinalizedTurnBracketing(pass2Turns, b.createdAt);
        if (turn && !attachedSeqs.has(turn.seq))
          lastTextBySeq.set(turn.seq, b.id);
      }
      for (const turn of pass2Turns) {
        const id = lastTextBySeq.get(turn.seq);
        if (id === undefined || tokensMap.has(id)) continue;
        tokensMap.set(id, {
          tokIn: turn.tokIn,
          tokOut: turn.tokOut,
          tokCacheRead: turn.tokCacheRead,
          tokCacheWrite: turn.tokCacheWrite,
          costTotal: turn.costTotal,
          costTreatment: turnCostTreatment(
            turn.authBindingKind,
            sessionBindingKind
          ),
        });
      }
    }

    // Filter out internal event blocks (turn-result, turn-duration, task-started,
    // task-completed)
    const filtered = blocks.filter(
      b =>
        !(
          b.kind === "agent-event" &&
          (b.event.type === "turn-result" ||
            b.event.type === "turn-duration" ||
            b.event.type === "task-started" ||
            b.event.type === "task-completed")
        )
    );

    return {
      filteredBlocks: filtered,
      turnDurations: durations,
      turnStatusTexts: statusTexts,
      turnTokens: tokensMap,
      turnWorkflow: workflowMap,
    };
    // Issue #3353: recompute when the session's auth-binding kind changes (an
    // account switch rewrites it mid-session). #4824: that re-tints only rows
    // with no recorded binding — a recorded turn keeps its own treatment.
  }, [
    props.blocks,
    props.turnBreakdown,
    props.turnWorkflow,
    props.session.metadata?.authBinding?.kind,
    // Issue #3972: the flavor selects the second pass's gate (all turns for
    // non-claude runners, per-turn launcher for claude).
    props.session.metadata?.flavor,
    // Issue #4068: the session launcher is the per-turn gate's fallback.
    props.session.metadata?.launcherKind,
  ]);

  // Pass the module-level converter directly — constant identity preserves
  // the converter's per-block caches across blocks changes, so unchanged
  // blocks keep their converted-message identity (issue #1636).
  const convertedMessages = useExternalMessageConverter<ChatBlock>({
    callback: toThreadMessageLike,
    messages: filteredBlocks,
    isRunning: props.session.thinking,
  });

  const threadDurations = useMemo(() => {
    if (turnDurations.size === 0) return turnDurations;
    const map = new Map<string, number>();
    for (const msg of convertedMessages) {
      const innerBlocks = getExternalStoreMessages<ChatBlock>(msg);
      for (const block of innerBlocks) {
        const dur = turnDurations.get(block.id);
        if (dur != null) {
          map.set(msg.id, dur);
          break;
        }
      }
    }
    return map;
  }, [convertedMessages, turnDurations]);

  const threadStatusTexts = useMemo(() => {
    if (turnStatusTexts.size === 0) return turnStatusTexts;
    const map = new Map<string, string>();
    for (const msg of convertedMessages) {
      const innerBlocks = getExternalStoreMessages<ChatBlock>(msg);
      for (const block of innerBlocks) {
        const text = turnStatusTexts.get(block.id);
        if (text != null) {
          map.set(msg.id, text);
          break;
        }
      }
    }
    return map;
  }, [convertedMessages, turnStatusTexts]);

  // Issue #1671: re-key per-block turn tokens onto the converted message id
  // (mirrors threadDurations/threadStatusTexts so AssistantMessage can read it
  // via TurnTokensContext by message id).
  const threadTokens = useMemo(() => {
    if (turnTokens.size === 0) return turnTokens;
    const map = new Map<string, TurnTokens>();
    for (const msg of convertedMessages) {
      const innerBlocks = getExternalStoreMessages<ChatBlock>(msg);
      for (const block of innerBlocks) {
        const tok = turnTokens.get(block.id);
        if (tok != null) {
          map.set(msg.id, tok);
          break;
        }
      }
    }
    return map;
  }, [convertedMessages, turnTokens]);

  // Issue #1672: re-key per-block workflow chips onto the converted message id
  // (mirrors threadTokens) so AssistantMessage reads it via TurnWorkflowContext.
  const threadWorkflow = useMemo(() => {
    if (turnWorkflow.size === 0) return turnWorkflow;
    const map = new Map<string, WorkflowChip[]>();
    for (const msg of convertedMessages) {
      const innerBlocks = getExternalStoreMessages<ChatBlock>(msg);
      for (const block of innerBlocks) {
        const chips = turnWorkflow.get(block.id);
        if (chips != null) {
          map.set(msg.id, chips);
          break;
        }
      }
    }
    return map;
  }, [convertedMessages, turnWorkflow]);

  // Latest-ref pattern: onNew/onCancel read live props through a ref so their
  // identity never tracks parent-render churn (an un-memoized onSendMessage
  // prop used to recreate the adapter every render, and
  // useExternalStoreRuntime's setAdapter notifies subscribers even when
  // nothing changed — issue #1636 amplifier A).
  const latestProps = useRef(props);
  latestProps.current = props;

  const onNew = useCallback(async (message: AppendMessage) => {
    const { onSendMessage } = latestProps.current;
    const text = getTextFromAppendMessage(message);
    if (!text) return;
    // Issue #2556: never silently drop a submitted message. The primary
    // inactive-session path is owned by HappyComposer.handleSubmit, which routes
    // to the #1325 server-backed queue (with a visible chip) BEFORE
    // api.composer().send() ever reaches this callback. If we still get here with
    // an inactive session — a client-state divergence like the 2026-08-02
    // incident, where the composer believed the session active but the runtime
    // saw it inactive — fall through to the optimistic send so the message
    // surfaces as a visible sent / failed-with-retry bubble instead of vanishing
    // with zero HTTP and zero feedback (was: `if (!session.active) return;`).
    onSendMessage(text);
  }, []);

  const onCancel = useCallback(async () => {
    await latestProps.current.onAbort();
  }, []);

  // Memoize the adapter to avoid recreating on every render
  // useExternalStoreRuntime may use adapter identity for subscriptions
  const adapter = useMemo(
    () => ({
      isDisabled: props.isSending,
      isRunning: props.session.thinking,
      messages: convertedMessages,
      onNew,
      onCancel,
      unstable_capabilities: { copy: true },
    }),
    [
      props.isSending,
      props.session.thinking,
      convertedMessages,
      onNew,
      onCancel,
    ]
  );

  const runtime = useExternalStoreRuntime(adapter);
  return {
    runtime,
    turnDurations: threadDurations,
    turnStatusTexts: threadStatusTexts,
    turnTokens: threadTokens,
    turnWorkflow: threadWorkflow,
  };
}
