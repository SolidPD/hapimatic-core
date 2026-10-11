// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDown,
  ArrowUp,
  ArrowDown,
  Minus,
  MessagesSquare,
  ExternalLink,
} from "lucide-react";
import { SimpleMarkdown } from "@/components/SimpleMarkdown";
import { ImpactColorChip } from "@/components/harnessUpdates/ImpactColorChip";
import { Button } from "@/components/ui/button";
import type { ImpactItem, ImpactedIssue } from "@/types/harnessUpdates";

/** Direction → icon + tint for an impacted-issue link (R3). */
function DirectionIcon({
  direction,
}: {
  direction: ImpactedIssue["direction"];
}) {
  if (direction === "positive") {
    return (
      <ArrowUp
        className="h-3 w-3 text-[var(--app-badge-success-text)]"
        aria-label="positive impact"
      />
    );
  }
  if (direction === "negative") {
    return (
      <ArrowDown
        className="h-3 w-3 text-[var(--app-badge-error-text)]"
        aria-label="negative impact"
      />
    );
  }
  return (
    <Minus
      className="h-3 w-3 text-[var(--app-hint)]"
      aria-label="neutral impact"
    />
  );
}

/**
 * One classified changelog bullet (epic #1769 Sub-Issue D, issue #1773 — R3/R6):
 * a color chip + the bullet text, an expandable rationale (collapsed by default,
 * `useState` + `aria-expanded` per the SystemJobCard precedent), the evidence
 * refs, directional impacted-issue links, and an "Ask Claude about this" button
 * that navigates to the companion session (guarded when it is null — the session
 * may have been archived by #1774).
 */
export function ImpactItemRow({
  item,
  companionSessionId,
}: {
  item: ImpactItem;
  companionSessionId: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();

  return (
    <section
      data-testid="impact-item-row"
      className="flex flex-col gap-1.5 rounded-md border border-[var(--app-secondary-bg)] bg-[var(--app-secondary-bg)]/30 px-3 py-2"
    >
      <div className="flex items-start gap-2">
        <div className="flex-shrink-0 pt-0.5">
          <ImpactColorChip color={item.color} label={item.category} />
        </div>
        <span className="min-w-0 flex-1 text-[length:var(--text-body)] text-[var(--app-fg)]">
          {item.bullet}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="ghostStatic"
          size="bare"
          type="button"
          onClick={() => setExpanded(e => !e)}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} rationale`}
          data-testid="impact-item-expand"
          className="justify-start gap-1 text-[length:var(--text-body-dense)] font-normal hover:text-[var(--app-fg)]"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${expanded ? "" : "-rotate-90"}`}
            aria-hidden="true"
          />
          Why this verdict
        </Button>
        {companionSessionId && (
          <Button
            variant="ghostStatic"
            size="bare"
            type="button"
            onClick={() =>
              void navigate({
                to: "/sessions/$sessionId",
                params: { sessionId: companionSessionId },
              })
            }
            data-testid="impact-item-ask"
            className="ml-auto gap-1 text-[length:var(--text-body-dense)] font-normal text-[var(--app-link)] hover:text-[var(--app-link)] hover:underline"
          >
            <MessagesSquare className="h-3.5 w-3.5" aria-hidden="true" />
            Ask Claude about this
          </Button>
        )}
      </div>

      {expanded && (
        <div
          data-testid="impact-item-rationale"
          className="flex flex-col gap-2 border-l-2 border-[var(--app-secondary-bg)] pl-3"
        >
          <div className="text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
            <SimpleMarkdown content={item.rationale} />
          </div>

          {item.evidence.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <span className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
                Evidence
              </span>
              <ul className="flex flex-col gap-0.5" role="list">
                {item.evidence.map((ref, i) => (
                  <li
                    key={`ev-${i}`}
                    className="font-mono text-[length:var(--text-caption)] text-[var(--app-hint)]"
                  >
                    {ref}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {item.impacted_issues.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
                Impacted issues
              </span>
              <div className="flex flex-wrap gap-1.5">
                {item.impacted_issues.map((issue, i) => (
                  <a
                    key={`ii-${i}`}
                    href={`https://github.com/${issue.repo}/issues/${issue.number}`}
                    target="_blank"
                    rel="noreferrer"
                    title={issue.note}
                    data-testid="impact-item-issue-link"
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[length:var(--text-caption)] text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
                  >
                    <DirectionIcon direction={issue.direction} />
                    <span className="font-mono">
                      {issue.repo}#{issue.number}
                    </span>
                    <ExternalLink
                      className="h-2.5 w-2.5 text-[var(--app-hint)]"
                      aria-hidden="true"
                    />
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
