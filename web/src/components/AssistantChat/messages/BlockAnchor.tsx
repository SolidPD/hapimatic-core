// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import {
  getExternalStoreMessages,
  useMessage,
  useMessagePartRuntime,
} from "@assistant-ui/react";
import type { ChatBlock } from "@/chat/types";

/**
 * Wraps one rendered message PART so its DOM carries the source block's identity
 * for arbitrary scroll-position bookmark anchoring (issues #3115, #3146).
 *
 * ## Recovering the block id per part
 *
 * The chat converter emits exactly ONE assistant-ui part per source `ChatBlock`,
 * in order, then concat-joins consecutive assistant messages into one turn-level
 * rendered message. So inside a part component:
 *   - a TOOL part's runtime path is `{ type: "toolCallId", toolCallId }`, and the
 *     `toolCallId` IS the source `block.id`;
 *   - a TEXT/REASONING part's path is `{ type: "index", index }`, and
 *     `getExternalStoreMessages(message)[index].id` recovers the block id (the
 *     external-store blocks are the same ordered array as the parts).
 *
 * A block id is the STABLE inner `block.id` (survives streaming re-renders), so it
 * is a reliable durability reference for a bookmark's pixel offset. The wrapper
 * emits `data-bookmark-anchor={blockId}` — the ONLY bookmark hook it carries:
 *   - the gutter's press→offset resolver finds the block CONTAINING the tap and
 *     measures the pixel offset within it (issue #3146);
 *   - `useBookmarkNavigation` resolves a block-anchored bookmark's jump target via
 *     the same attribute.
 *
 * Per issue #3146, blocks have ZERO visible standing: a bookmarked block gets NO
 * border, highlight, or any other visual treatment (the yellow left-accent the
 * pre-#3146 model drew was never part of the operator's intent and is removed).
 *
 * When the block id can't be resolved (never expected, but defensive), the wrapper
 * emits no anchor and a tap there falls back to whole-turn anchoring via the
 * gutter strip's `data-bookmark-message`.
 */
export function BlockAnchor({ children }: { children: ReactNode }) {
  const message = useMessage();
  // #3147: request the part runtime OPTIONALLY. During streaming it is
  // transiently unavailable, and a non-optional `useMessagePartRuntime()` THROWS
  // ("MessagePartRuntime is not available"), crashing the whole turn subtree
  // through the message error boundary until reload (a pre-existing #3115
  // regression, now hit on every streaming turn including the reasoning
  // affordance this issue surfaces). When it is null we fall through to the
  // documented no-anchor fallback below rather than crashing.
  const partRuntime = useMessagePartRuntime({ optional: true });

  let blockId: string | null = null;
  const selector = partRuntime?.path.messagePartSelector;
  if (selector?.type === "toolCallId") {
    blockId = selector.toolCallId;
  } else if (selector) {
    try {
      const blocks = getExternalStoreMessages<ChatBlock>(message);
      blockId = blocks[selector.index]?.id ?? null;
    } catch {
      blockId = null;
    }
  }

  return (
    <div
      data-bookmark-anchor={blockId ?? undefined}
      className="min-w-0 max-w-full"
    >
      {children}
    </div>
  );
}
