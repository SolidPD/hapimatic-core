// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ApiClient } from "@/api/client";
import type { CurrentIssue } from "@/types/github";
import { SimpleMarkdown } from "@/components/SimpleMarkdown";
import { ChevronIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useGitHubIssue } from "@/hooks/queries/useGitHubIssue";

interface IssueLabel {
  name: string;
  color: string;
}

interface IssueInfoModalProps {
  issue: CurrentIssue;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: ApiClient | null;
}

function ExternalLinkIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function LabelBadge({ label }: { label: IssueLabel }) {
  // GitHub dark-mode style: text is the label color, background is that color at ~15% opacity,
  // border is that color at ~30% opacity.
  const hexColor = `#${label.color}`;

  return (
    <span
      className={
        /* design-tokens-allow: 18px badge line-height, no exact --leading token (the ladder is unitless multipliers) (L8 #3410) */ "inline-flex items-center rounded-full border px-2 py-px text-[length:var(--text-caption)] font-medium whitespace-nowrap leading-[18px] h-5"
      }
      style={{
        color: hexColor,
        backgroundColor: `color-mix(in srgb, ${hexColor} 15%, transparent)`,
        borderColor: `color-mix(in srgb, ${hexColor} 30%, transparent)`,
      }}
    >
      {label.name}
    </span>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" strokeOpacity="0.75" />
    </svg>
  );
}

/**
 * Near-fullscreen modal displaying GitHub issue details:
 * number + title, collapsible labels section, and markdown body.
 *
 * Fetches labels and body from the server API on open.
 */
export function IssueInfoModal({
  issue,
  open,
  onOpenChange,
  api,
}: IssueInfoModalProps) {
  const [labelsOpen, setLabelsOpen] = useState(true);

  const [owner, repo] = issue.repo.split("/");
  const { details, isLoading, error } = useGitHubIssue(
    api,
    owner,
    repo,
    issue.number,
    { enabled: open }
  );

  const stateColor =
    issue.state === "closed" ? "text-purple-400" : "text-green-400";

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80" />
        <DialogPrimitive.Content
          className="fixed z-50 flex flex-col bg-[var(--app-secondary-bg)] rounded-xl overflow-hidden"
          style={{
            top: "max(5%, env(safe-area-inset-top, 5%))",
            bottom: "max(3%, env(safe-area-inset-bottom, 3%))",
            left: "max(2%, env(safe-area-inset-left, 2%))",
            right: "max(2%, env(safe-area-inset-right, 2%))",
          }}
          aria-describedby={undefined}
        >
          {/* Hidden accessible title */}
          <DialogPrimitive.Title className="sr-only">
            Issue #{issue.number}: {issue.title}
          </DialogPrimitive.Title>

          {/* Header */}
          <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-[var(--app-divider)]">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-sm font-semibold ${stateColor}`}>
                  #{issue.number}
                </span>
                <span
                  className={`text-[length:var(--text-caption-xs)] px-1.5 py-0.5 rounded-full font-medium ${
                    issue.state === "closed"
                      ? "bg-purple-400/15 text-purple-400"
                      : "bg-green-400/15 text-green-400"
                  }`}
                >
                  {issue.state === "closed" ? "Closed" : "Open"}
                </span>
              </div>
              <a
                href={issue.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium text-[var(--app-fg)] hover:text-[var(--app-link)] transition-colors inline-flex items-center gap-1.5"
              >
                <span className="break-words">{issue.title}</span>
                <ExternalLinkIcon className="shrink-0 opacity-50" />
              </a>
            </div>
            <DialogPrimitive.Close
              className="rounded-full p-2 text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors shrink-0 min-w-[var(--control-touch)] min-h-[var(--control-touch)] flex items-center justify-center"
              aria-label="Close"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </DialogPrimitive.Close>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {isLoading && (
              <div className="flex items-center justify-center py-12 text-[var(--app-hint)]">
                <Spinner />
                <span className="ml-2 text-sm">Loading issue details...</span>
              </div>
            )}

            {error && (
              <div className="flex items-center justify-center py-12 text-red-400 px-4 text-center text-sm">
                {error}
              </div>
            )}

            {details && !isLoading && !error && (
              <>
                {/* Labels section — collapsible, expanded by default */}
                {details.labels.length > 0 && (
                  <div className="border-b border-[var(--app-divider)]">
                    <Button
                      type="button"
                      variant="ghostStatic"
                      onClick={() => setLabelsOpen(prev => !prev)}
                      className="flex h-auto w-full items-center gap-2 rounded-none px-4 py-2.5 text-xs font-medium text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                    >
                      <ChevronIcon
                        className="h-3 w-3"
                        collapsed={!labelsOpen}
                      />
                      <span>Labels</span>
                      <span className="text-[length:var(--text-caption-xs)] text-[var(--app-hint)] opacity-60">
                        {details.labels.length}
                      </span>
                    </Button>
                    <div
                      className={`overflow-hidden transition-all duration-200 ease-in-out ${
                        labelsOpen
                          ? "max-h-[500px] opacity-100" /* design-tokens-allow: 500px labels-expand scroll-cap sentinel, off the spacing scale (L8 #3410) */
                          : "max-h-0 opacity-0"
                      }`}
                    >
                      <div className="flex flex-wrap gap-1.5 px-4 pb-3">
                        {details.labels.map(label => (
                          <LabelBadge key={label.name} label={label} />
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* Issue body */}
                {details.body ? (
                  <div className="px-4 py-3">
                    <SimpleMarkdown content={details.body} />
                  </div>
                ) : (
                  <div className="flex items-center justify-center py-8 text-[var(--app-hint)] text-sm">
                    No description provided.
                  </div>
                )}
              </>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
