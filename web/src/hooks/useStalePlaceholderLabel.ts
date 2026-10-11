// SPDX-License-Identifier: AGPL-3.0-only
import { useRef } from "react";

/**
 * #3177: the label the activity-placeholder shell should render for a reasoning
 * group slot, or `null` for "not the placeholder".
 *
 * When a tool/text block replaces the placeholder — or lands above it and pushes
 * it down one index — assistant-ui re-renders the outgoing group ONCE with its
 * stale range before it unmounts or re-groups (measured live). For that one commit
 * the range no longer ends on a reasoning part, so keep returning the last label:
 * a "Reasoning" header would flash, and `null` would blink the row for ~2 frames.
 * Scoped to an instance that was showing the placeholder, so a real reasoning group
 * is never affected.
 *
 * Shared by `ReasoningGroup` and the AssistantMessage hide-map group slot so the
 * two cannot drift (they did once, before this was extracted).
 *
 * @param label the placeholder label detected for this render, or `null`
 * @param rangeEndPart the message part at the group's (possibly stale) `endIndex`
 */
export function useStalePlaceholderLabel(
  label: string | null,
  rangeEndPart: { type?: string } | undefined
): string | null {
  const lastLabelRef = useRef<string | null>(null);
  if (label !== null) {
    lastLabelRef.current = label;
    return label;
  }
  if (lastLabelRef.current !== null && rangeEndPart?.type !== "reasoning") {
    return lastLabelRef.current;
  }
  lastLabelRef.current = null;
  return null;
}
