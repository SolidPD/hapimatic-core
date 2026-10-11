// SPDX-License-Identifier: AGPL-3.0-only
import { ExternalLink } from "lucide-react";
import { SimpleMarkdown } from "@/components/SimpleMarkdown";
import type { ChangelogSpan } from "@/types/harnessUpdates";

/**
 * Renders #1771's changelog span (epic #1769 Sub-Issue D, issue #1773 — R2/R8).
 *
 * `available: true` → per-version sections of the verbatim bullets via
 * `SimpleMarkdown` (NOT `MarkdownRenderer`, which needs the assistant-ui thread
 * runtime context — KD-4). `available: false` → a `reason`-aware fallback: a
 * "View changelog" link when the response carries a URL, else "no changelog
 * available". A degraded span is never an error — the endpoint 200s with the
 * `reason` set, so the panel always renders something (never an indefinite
 * spinner).
 */
export function ChangelogSpanView({ changelog }: { changelog: ChangelogSpan }) {
  if (!changelog.available) {
    return (
      <div
        data-testid="changelog-unavailable"
        className="rounded-md bg-[var(--app-secondary-bg)]/40 px-3 py-2 text-[length:var(--text-body)] text-[var(--app-hint)]"
      >
        {changelog.changelog_url ? (
          <a
            href={changelog.changelog_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[var(--app-link)] hover:underline"
          >
            View changelog
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        ) : (
          <span>No changelog available for this update.</span>
        )}
      </div>
    );
  }

  return (
    <div data-testid="changelog-span" className="flex flex-col gap-3">
      {changelog.truncated && (
        <p className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
          Showing the most recent versions only.
        </p>
      )}
      {changelog.versions.length === 0 ? (
        <p className="text-[length:var(--text-body)] text-[var(--app-hint)]">
          No changelog entries for this version range.
        </p>
      ) : (
        changelog.versions.map(version => (
          <section
            key={version.version}
            data-testid={`changelog-version-${version.version}`}
            className="flex flex-col gap-1"
          >
            <h3 className="font-mono text-[length:var(--text-body)] font-semibold text-[var(--app-fg)]">
              {version.version}
            </h3>
            <div className="text-[length:var(--text-body)] text-[var(--app-fg)]">
              <SimpleMarkdown
                content={version.bullets.map(b => `- ${b}`).join("\n")}
              />
            </div>
          </section>
        ))
      )}
      {changelog.changelog_url && (
        <a
          href={changelog.changelog_url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[length:var(--text-body-dense)] text-[var(--app-link)] hover:underline"
        >
          Full changelog
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      )}
    </div>
  );
}
