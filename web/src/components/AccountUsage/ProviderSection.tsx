// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from "react";
import type { ProviderId } from "@hapi/protocol";
import type { UsageViewId } from "@hapi/protocol/schemas";
import { ChevronIcon, PlusIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { UsageViewContext } from "./views/UsageViewContext";
import { ViewSwitcherPopover } from "./views/ViewSwitcherPopover";

type ProviderSectionProps = {
  /** Section heading — "Anthropic" / "OpenAI" / "Google Gemini". */
  title: string;
  /** The provider the section holds (the #4231/#4467 name; absent for the
   *  foot "Provider API Keys" section). */
  providerId?: ProviderId;
  /** Stable test id for the section wrapper (header button gets `${testId}-header`). */
  testId: string;
  /** Whether the section starts expanded. Defaults to expanded. */
  defaultExpanded?: boolean;
  /** #4466 R1: the account and key counts, shown after the title. */
  counts?: { accounts: number; keys: number };
  /** #4466 R2: the header's "+ Add" pill. */
  onAdd?: () => void;
  /** #6211: the `data-guide` the first-run wizard highlights this Add button by. */
  addGuide?: string;
  /** #4466 R10: a right-aligned row at the foot of the body. */
  footer?: ReactNode;
  /** #4467: this section's usage view. With BOTH `usageView` and
   *  `onUsageViewChange` the header shows the ⊞ switcher and the body's cards
   *  render this view; with either missing the cards render Bars. */
  usageView?: UsageViewId;
  onUsageViewChange?: (view: UsageViewId) => void;
  children: ReactNode;
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The header's count line (#4466 R1): "7 accounts · 1 API key" in full, "7 · 1
 * key" compact. A zero count is left out; both zero is "".
 */
export function formatProviderCounts(
  counts: { accounts: number; keys: number },
  opts: { compact?: boolean } = {}
): string {
  const parts: string[] = [];
  if (counts.accounts > 0) {
    parts.push(
      opts.compact
        ? String(counts.accounts)
        : plural(counts.accounts, "account", "accounts")
    );
  }
  if (counts.keys > 0) {
    parts.push(
      opts.compact
        ? plural(counts.keys, "key", "keys")
        : plural(counts.keys, "API key", "API keys")
    );
  }
  return parts.join(" · ");
}

/**
 * ProviderSection — a single independently-collapsible provider group on the
 * Accounts page (issue #3806, epic #3345). The page renders three of these —
 * Anthropic / OpenAI / Google Gemini — each owning its OWN expand/collapse state
 * (a local `useState`), so the three collapse independently (R1). Presentational
 * and self-contained; the caller supplies the section body.
 *
 * The header row holds the collapse toggle (title + counts) and, beside it,
 * an actions container (`${testId}-actions`) with the usage-view switcher
 * (#4467, when the page passes `usageView` and `onUsageViewChange`) before the "+ Add" pill; both sit
 * outside the toggle button. `footer` renders at the foot of the
 * expanded body (the "Other ways to add an account" link, #4466 R10).
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
  counts,
  onAdd,
  addGuide,
  footer,
  usageView,
  onUsageViewChange,
  children,
}: ProviderSectionProps) {
  const switchable = usageView != null && onUsageViewChange != null;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const full = counts ? formatProviderCounts(counts) : "";
  const compact = counts ? formatProviderCounts(counts, { compact: true }) : "";
  return (
    <section
      data-testid={testId}
      className="mt-2 overflow-hidden rounded-[13px] border border-[var(--app-border)] bg-[var(--app-bg)]" /* design-tokens-allow: 13px card radius — matches the account cards (no --radius token maps to 13px) */
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
          {full ? (
            <span
              data-testid={`${testId}-counts`}
              className="min-w-0 truncate text-[length:var(--text-caption)] leading-none text-[var(--app-hint)]"
            >
              <span className="hidden sm:inline">{full}</span>
              <span className="sm:hidden">{compact}</span>
            </span>
          ) : null}
        </Button>
        <div
          data-testid={`${testId}-actions`}
          className="flex shrink-0 items-center gap-1.5"
        >
          {switchable ? (
            <ViewSwitcherPopover
              value={usageView}
              onChange={onUsageViewChange}
              testId={`${testId}-view`}
            />
          ) : null}
          {onAdd ? (
            <Button
              type="button"
              size="sm"
              variant="ghostStatic"
              onClick={onAdd}
              aria-label={`Add to ${title}`}
              data-testid={`${testId}-add`}
              data-guide={addGuide}
              className="h-auto gap-1 rounded-md bg-[color-mix(in_srgb,var(--app-accent)_10%,transparent)] px-2 py-1 text-[length:var(--text-body-dense)] font-semibold text-[var(--app-accent)] hover:opacity-80"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              Add
            </Button>
          ) : null}
        </div>
      </div>

      {expanded && (
        <div
          className="border-t border-[var(--app-border)] px-3.5 py-2.5"
          data-testid={`${testId}-body`}
        >
          {switchable ? (
            <UsageViewContext.Provider value={usageView}>
              {children}
            </UsageViewContext.Provider>
          ) : (
            children
          )}
          {footer != null ? (
            <div className="mt-2 flex justify-end">{footer}</div>
          ) : null}
        </div>
      )}
    </section>
  );
}
