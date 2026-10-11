// SPDX-License-Identifier: AGPL-3.0-only
import type { ToolViewProps } from "@/ext/host";
import { DiffView } from "@/components/DiffView";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function WriteView(props: ToolViewProps) {
  const input = props.block.tool.input;
  if (!isObject(input)) return null;

  const content =
    typeof input.content === "string"
      ? input.content
      : typeof input.text === "string"
        ? input.text
        : null;
  if (content === null) return null;

  return <DiffView oldString="" newString={content} variant="inline" />;
}
