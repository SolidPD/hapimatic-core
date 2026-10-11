// SPDX-License-Identifier: AGPL-3.0-only
import { ChevronRight } from "lucide-react";
import { EntryRow } from "./EntryRow";
import type { AnnotatedCatalogEntry } from "@/types/capabilities";

/**
 * DomainGroup (issue #3752, Sub-Issue L / R5, R6) — one domain's catalog entries,
 * collapsible. Uses native `<details>`/`<summary>` (NOT a raw `<button>`, so it
 * needs no design-token suppression) — extracted from the panel to clear the
 * eslint `max-lines` cap (OR-4). Presentational only; `domain` and every entry
 * string render as React TEXT nodes.
 */
export function DomainGroup({
  domain,
  entries,
}: {
  domain: string;
  entries: AnnotatedCatalogEntry[];
}) {
  return (
    <details
      data-testid={`capability-domain-${domain}`}
      className="mb-2 rounded border border-[var(--app-border)]"
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-[length:var(--text-label-strong)] font-semibold text-[var(--app-fg)]">
        <ChevronRight
          size={14}
          className="shrink-0 text-[var(--app-muted)] transition-transform [details[open]_&]:rotate-90"
        />
        <span className="min-w-0 truncate">{domain}</span>
        <span className="ml-auto shrink-0 rounded border border-[var(--app-border)] px-1 text-[length:var(--text-caption)] tabular-nums text-[var(--app-muted)]">
          {entries.length}
        </span>
      </summary>
      <div>
        {entries.map(entry => (
          <EntryRow key={entry.id} entry={entry} />
        ))}
      </div>
    </details>
  );
}
