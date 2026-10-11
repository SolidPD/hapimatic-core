// SPDX-License-Identifier: AGPL-3.0-only
import type { ComponentPropsWithoutRef, ReactElement } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared inline-markdown renderers — the single source of truth for the house
 * inline `<a>` and inline `<code>` styling (issue #3719, follow-up to #3591).
 *
 * Consumed by all THREE markdown surfaces that render inline `a`/`code`:
 *   - `assistant-ui/markdown-text.tsx` (the assistant thread)
 *   - `AssistantChat/messages/StageReportCard.tsx` (a stage-report card value)
 *   - `SimpleMarkdown.tsx` (standalone markdown — session notes, etc.)
 *
 * This module is a pure LEAF: it imports ONLY `cn` + React types, never from any
 * of its three consumers. `markdown-text.tsx` imports `remarkStageReport` FROM
 * `StageReportCard.tsx`, so a shared module that imported either would reintroduce
 * a circular import — hence the leaf constraint.
 *
 * ONLY the INLINE code path lives here. Block code stays local to each consumer:
 * `markdown-text`'s `Code` keeps its `useIsMarkdownCodeBlock` branch and
 * `SimpleMarkdown`'s `Code` keeps its `/language-/` regex branch, each delegating
 * only the inline case to `InlineMarkdownCode`. (StageReportCard values are
 * inline-only and have no block-code path.)
 */

/** Inline `<a>` — opens in a new tab safely, with the house link styling. */
export function InlineMarkdownAnchor(
  props: ComponentPropsWithoutRef<"a">
): ReactElement {
  return (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "aui-md-a text-[var(--app-link)] underline",
        props.className
      )}
    />
  );
}

/** Inline `<code>` — the house inline-code styling (NOT block/fenced code). */
export function InlineMarkdownCode(
  props: ComponentPropsWithoutRef<"code">
): ReactElement {
  return (
    <code
      {...props}
      className={cn(
        "aui-md-code whitespace-pre-wrap rounded bg-[var(--app-inline-code-bg)] px-[0.3em] py-[0.1em] font-mono text-[0.9em]",
        props.className
      )}
    />
  );
}
