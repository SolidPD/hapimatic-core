// SPDX-License-Identifier: AGPL-3.0-only
import type { ToolViewProps } from "@/ext/host";
import { DiffView } from "@/components/DiffView";
import { parseUnifiedDiff } from "@/lib/unifiedDiff";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function renderDiff(block: ToolViewProps["block"], showFileHeader: boolean) {
  const input = block.tool.input;
  if (!isObject(input) || typeof input.unified_diff !== "string") return null;

  const parsed = parseUnifiedDiff(input.unified_diff);
  return (
    <DiffView
      oldString={parsed.oldText}
      newString={parsed.newText}
      filePath={showFileHeader ? parsed.fileName : undefined}
      variant={showFileHeader ? "inline" : undefined}
    />
  );
}

export function CodexDiffCompactView(props: ToolViewProps) {
  return renderDiff(props.block, false);
}

export function CodexDiffFullView(props: ToolViewProps) {
  return renderDiff(props.block, true);
}
