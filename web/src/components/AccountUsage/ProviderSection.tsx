// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from "react";
import { ChevronIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";

type ProviderSectionProps = {
  /** Section heading — "Anthropic" / "OpenAI" / "Google Gemini". */
  title: string;
  /** Stable test id for the section wrapper (header button gets `${testId}-header`). */
  testId: string;
  /** Whether the section starts expanded. Defaults to expanded. */
  defaultExpanded?: boolean;
  /** Optional right-aligned summary in the header row (e.g. a row count). */
  summary?: ReactNode;
  children: ReactNode;
};

/**
 * ProviderSection — a single independently-collapsible provider group on the
 * Accounts page (issue #3806, epic #3345). The page renders three of these —
 * Anthropic / OpenAI / Google Gemini — each owning its OWN expand/collapse state
 * (a local `useState`), so the three collapse independently (R1). Presentational
 * and self-contained; the caller supplies the section body.
 *
 * Styling uses design tokens only (no hardcoded hex — the new-file design-token
 * ratchet). D2 layering (#4465): the section paints `--app-bg`, one step above
 * the page's `--app-deepest-bg` and one step below the `--app-secondary-bg`
 * account / key cards and inner rows it holds, so the three layers read apart.
 */
export function ProviderSection({
  title,
  testId,
  defaultExpanded = true,
  summary,
  children,
}: ProviderSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <section
      data-testid={testId}
      className="mt-2 overflow-hidden rounded-[13px] border border-[var(--app-border)] bg-[var(--app-bg)]" /* design-tokens-allow: 13px card radius — matches AddAccountSection (no --radius token maps to 13px) */
    >
      <div className="flex items-center gap-2 px-3.5 py-2">
        <Button
          type="button"
          variant="ghostStatic"
          size="bare"
          onClick={() => setExpanded(e => !e)}
          aria-expanded={expanded}
          data-testid={`${testId}-header`}
          className="flex min-w-0 flex-1 items-center justify-start gap-2.5 text-left font-normal hover:text-[var(--app-fg)]"
        >
          <ChevronIcon
            className="h-3.5 w-3.5 shrink-0 text-[var(--app-hint)]"
            collapsed={!expanded}
          />
          <span className="text-[length:var(--text-label-strong)] font-semibold leading-none text-[var(--app-fg)]">
            {title}
          </span>
        </Button>
        {summary != null && (
          <span className="shrink-0 text-[length:var(--text-caption)] text-[var(--app-hint)]">
            {summary}
          </span>
        )}
      </div>

      {expanded && (
        <div
          className="border-t border-[var(--app-border)] px-3.5 py-2.5"
          data-testid={`${testId}-body`}
        >
          {children}
        </div>
      )}
    </section>
  );
}
