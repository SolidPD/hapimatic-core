// SPDX-License-Identifier: AGPL-3.0-only
import { SimpleMarkdown } from "@/components/SimpleMarkdown";
import { ImpactColorChip } from "@/components/harnessUpdates/ImpactColorChip";
import type { Headline, ImpactItem } from "@/types/harnessUpdates";

/**
 * The count of DISTINCT open issues the update touches — unique `{repo, number}`
 * across every item's `impacted_issues`, deduped across items. The headline's own
 * string arrays (`must_investigate`, `watch_areas_hit`) are free-text summaries,
 * NOT countable issue refs, so the count is derived from the items (R4).
 */
export function countImpactedIssues(items: ImpactItem[]): number {
  const seen = new Set<string>();
  for (const item of items) {
    for (const issue of item.impacted_issues) {
      seen.add(`${issue.repo}#${issue.number}`);
    }
  }
  return seen.size;
}

/**
 * The at-a-glance impact headline (epic #1769 Sub-Issue D, issue #1773 — R4).
 * Leads with "This update touches N of your open issues", then surfaces the
 * overall verdict chip, the free-text summary, and the `must_investigate` /
 * `watch_areas_hit` display chips.
 */
export function ImpactHeadline({
  headline,
  items,
}: {
  headline: Headline;
  items: ImpactItem[];
}) {
  const impactedCount = countImpactedIssues(items);

  return (
    <section
      data-testid="impact-headline"
      className="flex flex-col gap-2 rounded-md border border-[var(--app-secondary-bg)] bg-[var(--app-secondary-bg)]/40 px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <ImpactColorChip color={headline.overall_color} />
        <span
          data-testid="impact-headline-count"
          className={
            /* design-tokens-allow: 15px header size, above the --text-label-strong ladder cap */ "min-w-0 flex-1 text-[15px] font-semibold text-[var(--app-fg)]"
          }
        >
          This update touches {impactedCount} of your open{" "}
          {impactedCount === 1 ? "issue" : "issues"}
        </span>
      </div>

      {headline.summary && (
        <div className="text-[length:var(--text-body)] text-[var(--app-fg)]">
          <SimpleMarkdown content={headline.summary} />
        </div>
      )}

      {headline.must_investigate.length > 0 && (
        <div
          data-testid="impact-must-investigate"
          className="flex flex-col gap-1"
        >
          <span className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
            Must investigate
          </span>
          <div className="flex flex-wrap gap-1.5">
            {headline.must_investigate.map((label, i) => (
              <ImpactColorChip key={`mi-${i}`} color="red" label={label} />
            ))}
          </div>
        </div>
      )}

      {headline.watch_areas_hit.length > 0 && (
        <div data-testid="impact-watch-areas" className="flex flex-col gap-1">
          <span className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
            Watch areas hit
          </span>
          <div className="flex flex-wrap gap-1.5">
            {headline.watch_areas_hit.map((label, i) => (
              <ImpactColorChip key={`wa-${i}`} color="orange" label={label} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
