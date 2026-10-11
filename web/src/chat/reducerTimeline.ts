// SPDX-License-Identifier: AGPL-3.0-only
import type { ChatBlock, ToolCallBlock, ToolPermission } from "@/chat/types";
import type { TracedMessage } from "@/chat/tracer";
import {
  createCliOutputBlock,
  isCliOutputText,
  mergeCliOutputBlocks,
} from "@/chat/reducerCliOutput";
import { parseMessageAsEvent } from "@/chat/reducerEvents";
import {
  ensureToolBlock,
  extractTitleFromChangeTitleInput,
  isChangeTitleToolName,
  type PermissionEntry,
} from "@/chat/reducerTools";
import { isStopHookFeedbackBlock } from "@/chat/stopHookFeedback";

export function reduceTimeline(
  messages: TracedMessage[],
  context: {
    permissionsById: Map<string, PermissionEntry>;
    groups: Map<string, TracedMessage[]>;
    consumedGroupIds: Set<string>;
    titleChangesByToolUseId: Map<string, string>;
    emittedTitleChangeToolUseIds: Set<string>;
  }
): {
  blocks: ChatBlock[];
  toolBlocksById: Map<string, ToolCallBlock>;
  hasReadyEvent: boolean;
} {
  const blocks: ChatBlock[] = [];
  const toolBlocksById = new Map<string, ToolCallBlock>();
  let hasReadyEvent = false;

  // Issue #1020: Map of message-uuid → Skill tool_use_id for any user-turn
  // message that carried a `tool_result` for a `Skill` tool. Claude Code's
  // SkillTool injects the SKILL.md body as a sibling user-turn text block
  // whose `parentUuid` points back at the tool_result message. We route that
  // text onto the Skill's ToolCallBlock (as `tool.skillBody`) and suppress
  // the separate agent-text emission so the skill body renders inside the
  // Skill ToolCard dialog instead of as an inline dump.
  const skillToolResultMsgUuids = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === "event") {
      if (msg.content.type === "ready") {
        hasReadyEvent = true;
        continue;
      }
      blocks.push({
        kind: "agent-event",
        id: msg.id,
        createdAt: msg.createdAt,
        event: msg.content,
        meta: msg.meta,
        isInherited: msg.isInherited,
      });
      continue;
    }

    const event = parseMessageAsEvent(msg);
    if (event) {
      blocks.push({
        kind: "agent-event",
        id: msg.id,
        createdAt: msg.createdAt,
        event,
        meta: msg.meta,
        isInherited: msg.isInherited,
      });
      continue;
    }

    if (msg.role === "user") {
      if (isCliOutputText(msg.content.text, msg.meta)) {
        blocks.push({
          ...createCliOutputBlock({
            id: msg.id,
            localId: msg.localId,
            createdAt: msg.createdAt,
            text: msg.content.text,
            source: "user",
            meta: msg.meta,
          }),
          isInherited: msg.isInherited,
        });
        continue;
      }
      blocks.push({
        kind: "user-text",
        id: msg.id,
        localId: msg.localId,
        createdAt: msg.createdAt,
        text: msg.content.text,
        status: msg.status,
        originalText: msg.originalText,
        denial: msg.denial,
        meta: msg.meta,
        isInherited: msg.isInherited,
        isTaskNotification: msg.isTaskNotification,
      });
      continue;
    }

    if (msg.role === "agent") {
      for (let idx = 0; idx < msg.content.length; idx += 1) {
        const c = msg.content[idx];
        if (c.type === "text") {
          // Issue #1020: If this text block's parentUUID matches a recorded
          // Skill tool_result message uuid, it is the SKILL.md body injected
          // by Claude Code's SkillTool. Attach it to the Skill's
          // ToolCallBlock and skip the separate agent-text emission.
          if (c.parentUUID) {
            const skillToolUseId = skillToolResultMsgUuids.get(c.parentUUID);
            if (skillToolUseId) {
              const skillBlock = toolBlocksById.get(skillToolUseId);
              if (skillBlock) {
                skillBlock.tool.skillBody = c.text;
                continue;
              }
            }
          }

          if (isCliOutputText(c.text, msg.meta)) {
            blocks.push({
              ...createCliOutputBlock({
                id: `${msg.id}:${idx}`,
                localId: msg.localId,
                createdAt: msg.createdAt,
                text: c.text,
                source: "assistant",
                meta: msg.meta,
              }),
              isInherited: msg.isInherited,
            });
            continue;
          }
          blocks.push({
            kind: "agent-text",
            id: `${msg.id}:${idx}`,
            localId: msg.localId,
            createdAt: msg.createdAt,
            text: c.text,
            meta: msg.meta,
            isInherited: msg.isInherited,
            isTaskNotification: msg.isTaskNotification,
            // #2162: carry the meta marker to the block so AssistantMessage.tsx
            // renders a collapsed chip (mirrors isTaskNotification threading).
            isMeta: msg.isMeta,
          });
          continue;
        }

        if (c.type === "reasoning") {
          blocks.push({
            kind: "agent-reasoning",
            id: `${msg.id}:${idx}`,
            localId: msg.localId,
            createdAt: msg.createdAt,
            text: c.text,
            meta: msg.meta,
            isInherited: msg.isInherited,
            isTaskNotification: msg.isTaskNotification,
          });
          continue;
        }

        if (c.type === "summary") {
          blocks.push({
            kind: "agent-event",
            id: `${msg.id}:${idx}`,
            createdAt: msg.createdAt,
            event: { type: "conversation-branched" },
            meta: msg.meta,
            isInherited: msg.isInherited,
          });
          continue;
        }

        if (c.type === "tool-call") {
          if (isChangeTitleToolName(c.name)) {
            const title =
              context.titleChangesByToolUseId.get(c.id) ??
              extractTitleFromChangeTitleInput(c.input);
            if (title && !context.emittedTitleChangeToolUseIds.has(c.id)) {
              context.emittedTitleChangeToolUseIds.add(c.id);
              blocks.push({
                kind: "agent-event",
                id: `${msg.id}:${idx}`,
                createdAt: msg.createdAt,
                event: { type: "title-changed", title },
                meta: msg.meta,
                isInherited: msg.isInherited,
              });
            }
            continue;
          }

          const permission = context.permissionsById.get(c.id)?.permission;

          const block = ensureToolBlock(blocks, toolBlocksById, c.id, {
            createdAt: msg.createdAt,
            localId: msg.localId,
            meta: msg.meta,
            name: c.name,
            input: c.input,
            description: c.description,
            permission,
          });

          if (block.tool.state === "pending") {
            block.tool.state = "running";
            block.tool.startedAt = msg.createdAt;
          }

          if (c.name === "Task" && !context.consumedGroupIds.has(msg.id)) {
            const sidechain = context.groups.get(msg.id) ?? null;
            if (sidechain && sidechain.length > 0) {
              context.consumedGroupIds.add(msg.id);
              const child = reduceTimeline(sidechain, context);
              hasReadyEvent = hasReadyEvent || child.hasReadyEvent;
              block.children = child.blocks;
            }
          }
          continue;
        }

        if (c.type === "tool-result") {
          const title =
            context.titleChangesByToolUseId.get(c.tool_use_id) ?? null;
          if (title) {
            if (!context.emittedTitleChangeToolUseIds.has(c.tool_use_id)) {
              context.emittedTitleChangeToolUseIds.add(c.tool_use_id);
              blocks.push({
                kind: "agent-event",
                id: `${msg.id}:${idx}`,
                createdAt: msg.createdAt,
                event: { type: "title-changed", title },
                meta: msg.meta,
                isInherited: msg.isInherited,
              });
            }
            continue;
          }

          const permissionEntry = context.permissionsById.get(c.tool_use_id);
          const permissionFromResult = c.permissions
            ? ({
                id: c.tool_use_id,
                status:
                  c.permissions.result === "approved" ? "approved" : "denied",
                date: c.permissions.date,
                mode: c.permissions.mode,
                allowedTools: c.permissions.allowedTools,
                decision: c.permissions.decision,
              } satisfies ToolPermission)
            : undefined;

          const permission = (() => {
            if (permissionFromResult && permissionEntry?.permission) {
              return {
                ...permissionEntry.permission,
                ...permissionFromResult,
                allowedTools:
                  permissionFromResult.allowedTools ??
                  permissionEntry.permission.allowedTools,
                decision:
                  permissionFromResult.decision ??
                  permissionEntry.permission.decision,
              } satisfies ToolPermission;
            }
            return permissionFromResult ?? permissionEntry?.permission;
          })();

          // Issue #1074: When pagination loads only the most recent ~50 messages,
          // a tool-result can arrive whose matching tool-call lives in an unloaded
          // older page. Without this guard, ensureToolBlock would create a phantom
          // ToolCallBlock with placeholder name "Tool" and input null, appended to
          // the end of the timeline — visible to the user as a confusing tool
          // bubble pinned below the latest real message.
          //
          // Mirror the #31 guard at reducer.ts:81 (the parallel post-loop
          // permission-only path). Skip the orphan tool-result silently. If the
          // matching tool-call is later loaded via "load more", reduceChatBlocks
          // re-runs over the merged message set and the result attaches normally.
          //
          // Note: this also drops the result content for the Skill body
          // attachment chain (#1020 — skillToolResultMsgUuids). That's
          // acceptable because if the Skill tool-call is paginated out, both
          // the skill card and its body are orphaned; suppressing the phantom
          // card is preferable to showing a "Skill — Tool" card with null input.
          if (!toolBlocksById.has(c.tool_use_id) && !permissionEntry) {
            // Issue #1074 hardening: log skipped orphan tool-results so a
            // pagination regression that drops legitimate tool-results is
            // observable in devtools rather than silently invisible.
            console.debug(
              "[reducerTimeline] skipping orphan tool-result (no matching tool-call in window)",
              { toolUseId: c.tool_use_id }
            );
            continue;
          }

          const block = ensureToolBlock(blocks, toolBlocksById, c.tool_use_id, {
            createdAt: msg.createdAt,
            localId: msg.localId,
            meta: msg.meta,
            name: permissionEntry?.toolName ?? "Tool",
            input: permissionEntry?.input ?? null,
            description: null,
            permission,
          });

          block.tool.result = c.content;
          block.tool.completedAt = msg.createdAt;
          block.tool.state = c.is_error ? "error" : "completed";

          // Issue #1020: If this is a Skill tool_result, record the
          // carrying message's uuid so we can attribute any following
          // text block (linked by parentUUID) as the SKILL.md body.
          if (block.tool.name === "Skill") {
            skillToolResultMsgUuids.set(c.uuid, c.tool_use_id);
          }

          continue;
        }

        if (c.type === "sidechain") {
          blocks.push({
            kind: "user-text",
            id: `${msg.id}:${idx}`,
            localId: null,
            createdAt: msg.createdAt,
            text: c.prompt,
          });
          continue;
        }
      }
    }
  }

  // #3154 (Task 3, KD2) + #3267 (fail-open, contiguous-run): interstitial-vs-final
  // narration classification. A single O(n) reverse post-pass over the built
  // `blocks`. Turn-tail look-ahead is impossible while emitting a turn's head in the
  // forward loop above, so this runs after the loop. Segments are delimited by ANY
  // user-originated block — `user-text` (regular OR mid-turn sidechain) OR a
  // `cli-output` with `source === "user"` (a slash command typed in the terminal is
  // emitted as the latter, never `user-text`; keying on `user-text` alone would
  // merge the two turns and misclassify the first turn's final response as
  // narration) OR a synthetic/meta user record — `isMeta` (any synthetic user record:
  // Stop-hook feedback is the common case; system-reminder / caveat injections are
  // stamped the same way), or the "Stop hook feedback:" prefix fallback for legacy
  // flag-less records (#3778). Such a record ends the prior response's turn, so the
  // text before it is a task-final response and the text after it is the next
  // response; the first response text after it is stamped `afterHookBoundary` so the
  // render layer can attribute it to the hook.
  //
  // #3267 fail-open rule (operator ruling; D2 = contiguous-run): within an assistant
  // segment an `agent-text` block is NARRATION only when ALL hold — a `tool-call`
  // FOLLOWS it AND a later RESPONSE text also exists in the segment AND the block is
  // NOT part of the trailing contiguous text run (the run containing the
  // segment-final text, broken only by a tool-call or a segment boundary). The whole
  // trailing run stays uncategorized (the task-final RESPONSE), so split final
  // answers (`[txtA, txtB, tool]`) show whole and a lone final text followed only by
  // trailing notification/cleanup tool-calls is a response, not collapsed narration.
  // Accepted trade-off: narration immediately adjacent to the final-answer run (no
  // tool-call between them) over-shows — "bias fail-open" is the intended direction.
  // The reverse scan lets us know a text block's segment tail while we visit it.
  //
  // Invariants this pass upholds:
  //   - R7 (streaming idempotency): reads ONLY the freshly-built `blocks` (no
  //     memoized prior category), so the per-tick recompute converges — a text
  //     that was response at tick T becomes narration at tick T+1 when a later
  //     response text arrives *beyond an intervening tool-call* in the segment (a
  //     trailing tool-call alone no longer hides the trailing text run; #3267).
  //     Block ids stay `${msg.id}:${idx}` so the render layer diffs in place rather
  //     than remounting.
  //   - R6 (blast radius): it ONLY sets the new `category` field on `agent-text`
  //     blocks — never reorders, drops, merges, or re-keys any block, and never
  //     touches `agent-reasoning`/`tool-call`/`cli-output`/`user-text`.
  //   - Exclusions: `isTaskNotification` and `isMeta` (#2162) agent-text are skipped
  //     — and crucially neither sets the later-response-text tracker, so a trailing
  //     notification/meta block never makes the real final answer look interstitial.
  //     Title-change tool calls never emit a `tool-call` block (they emit an
  //     `agent-event`), so scanning `kind === "tool-call"` already excludes them —
  //     title changes are meta, not task work.
  // Runs BEFORE `mergeCliOutputBlocks` (which never touches agent-text, so the
  // classification survives the merge).
  let toolCallFollowsInSegment = false;
  // #3267: a later task-final-eligible agent-text exists later in the segment.
  let responseTextFollowsInSegment = false;
  // #3267 D2(b): the current contiguous text run classifies as the response.
  let inResponseRun = false;
  // #3778 (Task 5): lowest-index agent-text seen so far in the current segment. The
  // reverse scan visits decreasing indices, so this ends at the FIRST response text
  // of the segment. When the scan hits a Stop-hook feedback boundary, the first text
  // of the segment that FOLLOWED that hook is stamped `afterHookBoundary` for the
  // render-layer attribution badge (R5).
  let firstTextIdxInSegment: number | null = null;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i];
    if (
      b.kind === "user-text" ||
      (b.kind === "cli-output" && b.source === "user")
    ) {
      // Segment boundary: blocks at lower indices belong to an earlier segment.
      toolCallFollowsInSegment = false;
      responseTextFollowsInSegment = false; // #3267: reset later-text
      inResponseRun = false; // #3267 D2(b): boundary ends the run
      firstTextIdxInSegment = null; // #3778 (Task 5): a user turn ends the segment
      continue;
    }
    // #3778 (Task 1): a synthetic/meta user record — Stop-hook feedback is the common
    // case — is a turn boundary too. Primary signal is the #2162 `isMeta` flag; the
    // literal "Stop hook feedback:" prefix is the fallback for the ~218 legacy flag-less
    // records (both handled by `isStopHookFeedbackBlock`). The record itself is NOT
    // classified (it is also excluded from the classifier by the `!b.isMeta` guard
    // below), but the reset it performs makes the assistant text on EITHER side of it a
    // task-final response rather than folded narration.
    if (b.kind === "agent-text" && isStopHookFeedbackBlock(b)) {
      // Task 5: the segment that FOLLOWED this hook (higher indices, already scanned in
      // this reverse pass) has its first response text at `firstTextIdxInSegment` —
      // stamp that block so the render layer draws the "after a Stop hook" badge on it.
      if (firstTextIdxInSegment !== null) {
        const firstText = blocks[firstTextIdxInSegment];
        if (firstText.kind === "agent-text") firstText.afterHookBoundary = true;
      }
      // Reset ALL trackers (mirrors the user-boundary reset above) so a later-segment
      // response text cannot leak across the hook boundary and re-fold resp1.
      toolCallFollowsInSegment = false;
      responseTextFollowsInSegment = false;
      inResponseRun = false;
      firstTextIdxInSegment = null;
      continue;
    }
    if (b.kind === "tool-call") {
      toolCallFollowsInSegment = true;
      inResponseRun = false; // #3267 D2(b): a tool-call breaks the run
      continue;
    }
    if (b.kind === "agent-text" && !b.isTaskNotification && !b.isMeta) {
      // #3267 fail-open (operator ruling; D2 = contiguous-run): narration ONLY
      // when a tool-call trails AND a later response text exists in the segment
      // AND this text is not part of the trailing contiguous response run. The
      // whole run containing the task-final text stays uncategorized — split
      // final answers get through whole. `isMeta` (#2162) is excluded alongside
      // `isTaskNotification`: like a task-notification, a meta block is not the
      // task-final answer, so it neither classifies nor sets the later-text
      // tracker.
      if (
        toolCallFollowsInSegment &&
        responseTextFollowsInSegment &&
        !inResponseRun
      ) {
        b.category = "narration";
      } else {
        inResponseRun = true; // #3267: run extends across adjacent texts
      }
      responseTextFollowsInSegment = true;
      // #3778 (Task 5): reverse scan visits decreasing indices, so the last assignment
      // before a boundary leaves this at the FIRST (lowest-index) agent-text of the
      // segment — the block a following hook boundary stamps `afterHookBoundary`.
      firstTextIdxInSegment = i;
    }
  }

  return {
    blocks: mergeCliOutputBlocks(blocks),
    toolBlocksById,
    hasReadyEvent,
  };
}
