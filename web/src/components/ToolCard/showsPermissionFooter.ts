// SPDX-License-Identifier: AGPL-3.0-only
import type { ChatBlock } from "@/chat/types";

/**
 * Actionable/explanatory permission-footer test (#2625/#3015; extracted by #3068):
 * `pending`, OR (`denied`/`canceled` WITH a reason). Single source of truth for
 * ToolCard's `hasBody` and for ToolMessage's `mustAlwaysRender` / `hasPermissionFloor`.
 * Lives in a pure leaf module on purpose: `ToolCard/` never imports from
 * `AssistantChat/`, so there is no ToolCard → ToolMessage cycle, and no test suite
 * `vi.mock`s this path, so the ToolMessage mock literals in ToolRunGroup/AssistantMessage
 * tests cannot poison it (same reasoning as the #2989 `CompactChevron` split).
 */
export function showsPermissionFooter(block: ChatBlock): boolean {
  if (block.kind !== "tool-call") return false;
  const permission = block.tool.permission;
  return Boolean(
    permission &&
    (permission.status === "pending" ||
      ((permission.status === "denied" || permission.status === "canceled") &&
        Boolean(permission.reason)))
  );
}
