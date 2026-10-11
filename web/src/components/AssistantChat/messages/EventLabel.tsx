// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Issue #4043: the shared icon + muted-text label rendered by the inline
 * title-change bubble (`AssistantMessage.tsx` `TitleChangeBubble`) and the
 * standalone system-event bubble (`SystemMessage.tsx` default branch).
 *
 * Owns ONLY the inner span both bubbles share. Each caller keeps its own
 * wrapper (left-aligned in-flow vs centered pill) and passes any styling that
 * lives on the span via `className` — the title-change bubble passes its muted
 * text classes, the standalone bubble passes none (its wrapper carries them).
 */
export function EventLabel(props: {
  icon?: ReactNode;
  text: ReactNode;
  className?: string;
}): React.JSX.Element {
  const { icon, text, className } = props;
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      <span>{text}</span>
    </span>
  );
}
