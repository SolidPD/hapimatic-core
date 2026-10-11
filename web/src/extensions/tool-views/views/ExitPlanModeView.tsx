// SPDX-License-Identifier: AGPL-3.0-only
import type { ToolViewProps } from "@/ext/host";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function ExitPlanModeView(props: ToolViewProps) {
  const input = props.block.tool.input;
  if (!isObject(input)) return null;
  const plan = typeof input.plan === "string" ? input.plan : null;
  if (!plan) return null;
  return <MarkdownRenderer content={plan} />;
}
