// SPDX-License-Identifier: AGPL-3.0-only
import { RefreshCw, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatRelativeTime } from "@/lib/sessionHelpers";
import type {
  RedactedHarnessDescriptor,
  HarnessDetectionState,
} from "@/types/harnessUpdates";

/**
 * One harness row (epic #1769 Sub-Issue D, issue #1773 — R1/R5/R9): display name,
 * installed→latest versions, last-checked relative time, an "update available"
 * indicator, and the "Review impact" button (the ONLY action #1773 renders — the
 * Update + Rollback controls are #1774's scope, mounted at the documented seam).
 *
 * Presentational: the page owns the review mutation and passes `onReviewImpact`
 * plus the button's live label/disabled state (so an in-flight analysis reads
 * "Analyzing…").
 */
export function HarnessUpdateCard({
  descriptor,
  state,
  onReviewImpact,
  reviewLabel = "Review impact",
  reviewDisabled = false,
  onCheckNow,
  checkingNow = false,
  checkNote = null,
}: {
  descriptor: RedactedHarnessDescriptor;
  state: HarnessDetectionState | null;
  onReviewImpact?: () => void;
  reviewLabel?: string;
  reviewDisabled?: boolean;
  // #1775 (Sub-Issue F): "Check now" — always available (checking is how you
  // discover an update), so it is NOT gated on updateAvailable. The page owns the
  // mutation and passes the handler + live state, keeping this card presentational.
  onCheckNow?: () => void;
  checkingNow?: boolean;
  checkNote?: string | null;
}) {
  const installed = state?.installed_version ?? "unknown";
  const latest = state?.latest_version ?? "unknown";
  const updateAvailable = state?.update_available === true;
  const lastChecked =
    state?.last_checked_at != null
      ? formatRelativeTime(state.last_checked_at)
      : null;

  return (
    <section
      data-testid={`harness-card-${descriptor.id}`}
      className="flex flex-col gap-2 rounded-md border border-[var(--app-secondary-bg)] bg-[var(--app-secondary-bg)]/40 px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <span
          className={
            /* design-tokens-allow: 15px header size, above the --text-label-strong ladder cap */ "min-w-0 flex-1 truncate text-[15px] font-semibold text-[var(--app-fg)]"
          }
        >
          {descriptor.display_name}
        </span>
        {descriptor.is_session_backend && (
          <Badge variant="subscription" className="flex-shrink-0">
            session backend
          </Badge>
        )}
        {updateAvailable ? (
          <Badge
            variant="mint"
            className="flex-shrink-0"
            data-testid={`harness-update-available-${descriptor.id}`}
          >
            Update available
          </Badge>
        ) : (
          <Badge variant="success" className="flex-shrink-0">
            Up to date
          </Badge>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--text-body)] text-[var(--app-hint)]">
        <span className="font-mono text-[var(--app-fg)]">{installed}</span>
        {updateAvailable && (
          <>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="font-mono text-[var(--app-accent)]">{latest}</span>
          </>
        )}
        <span aria-hidden="true">·</span>
        <span>{lastChecked ? `checked ${lastChecked}` : "never checked"}</span>
      </div>

      {state?.last_error && (
        <p
          data-testid={`harness-card-error-${descriptor.id}`}
          className="text-[length:var(--text-body-dense)] text-[var(--app-badge-warning-text)]"
        >
          Last check reported: {state.last_error}
        </p>
      )}

      {onCheckNow && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCheckNow}
            disabled={checkingNow}
            data-testid={`harness-check-now-${descriptor.id}`}
          >
            <RefreshCw
              className={`mr-1.5 h-3.5 w-3.5 ${checkingNow ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            {checkingNow ? "Checking…" : "Check now"}
          </Button>
          {checkNote && (
            <span
              data-testid={`harness-check-note-${descriptor.id}`}
              className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
            >
              {checkNote}
            </span>
          )}
        </div>
      )}

      {updateAvailable && onReviewImpact && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onReviewImpact}
            disabled={reviewDisabled}
            data-testid={`harness-review-impact-${descriptor.id}`}
          >
            <RefreshCw
              className={`mr-1.5 h-3.5 w-3.5 ${reviewDisabled ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            {reviewLabel}
          </Button>
          {/* #1774: Update + Rollback buttons mount here (their action components
              land in this same web/src/components/harnessUpdates/ directory, with
              the mutation hook at web/src/hooks/mutations/useApplyHarnessUpdate.ts).
              #1773 renders ONLY "Review impact" — no dead/disabled Update button. */}
        </div>
      )}
    </section>
  );
}
