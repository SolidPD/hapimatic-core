// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import type { BranchSummary } from "@/hooks/useBranchSummary";
import { ChevronDownIcon, ChevronUpIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";

/**
 * A compact, collapsible orientation card that appears below the
 * branch-point separator ("🌿 Branch created here") in branched sessions.
 *
 * Displays key context from the parent session so the user doesn't
 * need to ask "where are we?" when entering a branch.
 */
export function BranchSummaryCard({ summary }: { summary: BranchSummary }) {
  const [expanded, setExpanded] = useState(true);

  const shortPath = summary.projectPath
    ? summary.projectPath.replace(/^\/home\/[^/]+\//, "~/")
    : null;

  return (
    <div className="mx-auto w-full max-w-content px-4 pb-2">
      <div className="rounded-lg border border-[var(--app-link)]/20 bg-[var(--app-subtle-bg)]">
        {/* Header — always visible */}
        <Button
          type="button"
          variant="ghostStatic"
          onClick={() => setExpanded(prev => !prev)}
          className="flex h-auto w-full items-center justify-between gap-2 rounded-none px-3 py-2 text-left text-sm font-normal hover:text-[var(--app-fg)]"
        >
          <span className="flex items-center gap-1.5 text-[var(--app-link)] font-medium min-w-0">
            <span className="shrink-0">🌿</span>
            <span className="truncate">
              Branch from: {summary.parentSessionName}
            </span>
          </span>
          <span className="shrink-0 text-[var(--app-hint)]">
            {expanded ? (
              <ChevronUpIcon className="h-4 w-4" />
            ) : (
              <ChevronDownIcon className="h-4 w-4" />
            )}
          </span>
        </Button>

        {/* Expanded content */}
        {expanded ? (
          <div className="border-t border-[var(--app-link)]/10 px-3 py-2 text-xs text-[var(--app-hint)] space-y-1.5">
            {shortPath ? (
              <div className="flex items-center gap-1.5">
                <span className="shrink-0">📁</span>
                <span className="truncate">{shortPath}</span>
              </div>
            ) : null}

            {summary.linkedIssue ? (
              <div className="flex items-center gap-1.5">
                <span className="shrink-0">🏷️</span>
                <span className="truncate">
                  Issue: #{summary.linkedIssue.number} —{" "}
                  {summary.linkedIssue.title}
                </span>
              </div>
            ) : null}

            {summary.lastUserMessage || summary.lastAgentResponse ? (
              <div className="mt-1.5 space-y-1 rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5">
                <div className="text-[length:var(--text-caption-xs)] uppercase tracking-wider text-[var(--app-hint)] opacity-60">
                  Last exchange
                </div>
                {summary.lastUserMessage ? (
                  <div className="flex items-start gap-1.5">
                    <span className="shrink-0">👤</span>
                    <span className="break-words">
                      {summary.lastUserMessage}
                    </span>
                  </div>
                ) : null}
                {summary.lastAgentResponse ? (
                  <div className="flex items-start gap-1.5">
                    <span className="shrink-0">🤖</span>
                    <span className="break-words">
                      {summary.lastAgentResponse}
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="flex items-center gap-1.5 pt-0.5 opacity-60">
              <span className="shrink-0">📊</span>
              <span>
                {summary.messageCount} message
                {summary.messageCount !== 1 ? "s" : ""} in parent session
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
