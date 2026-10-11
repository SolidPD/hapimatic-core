// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useAppContext } from "@/lib/app-context";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import { LoadingState } from "@/components/LoadingState";
import { useHarnessUpdates } from "@/hooks/queries/useHarnessUpdates";
import { useHarnessChangelog } from "@/hooks/queries/useHarnessChangelog";
import { useHarnessAnalysis } from "@/hooks/queries/useHarnessAnalysis";
import { useReviewImpact } from "@/hooks/mutations/useReviewImpact";
import { useHarnessActions } from "@/hooks/mutations/useHarnessActions";
import { HarnessUpdateCard } from "@/components/harnessUpdates/HarnessUpdateCard";
import { HarnessUpdateActions } from "@/components/harnessUpdates/HarnessUpdateActions";
import { HarnessPollSettings } from "@/components/harnessUpdates/HarnessPollSettings";
import { ChangelogSpanView } from "@/components/harnessUpdates/ChangelogSpanView";
import { ImpactHeadline } from "@/components/harnessUpdates/ImpactHeadline";
import { ImpactItemRow } from "@/components/harnessUpdates/ImpactItemRow";
import type {
  RedactedHarnessDescriptor,
  HarnessDetectionState,
} from "@/types/harnessUpdates";

/**
 * Harness Updates — the `/settings/harness-updates` route (epic #1769 Sub-Issue D,
 * issue #1773). Lists the installed harnesses (Claude Code first), shows installed
 * vs latest version, renders the raw changelog span when an update is available,
 * and — once an impact analysis exists — renders the color-coded impact table with
 * an entry point into the companion session.
 *
 * Consumes the merged backends directly: #1770 (`GET /api/harness/status`), #1771
 * (`GET /api/harness/:id/changelog`), #1772 (`GET /api/harness/:id/analysis`,
 * `POST /api/harness/:id/analyze`). Renders graceful loading / unavailable / empty /
 * error / terminal states — never an indefinite spinner (R8).
 *
 * The status response is single-node (this node); its `node_id` is surfaced as a
 * header so per-node selection is an additive later step (R7).
 */
export default function AdminHarnessUpdatesPage() {
  useDocumentTitle("Harness Updates - Hapimatic");
  useEmojiFavicon(null);
  const { api } = useAppContext();
  const { status, unavailable, isLoading, error } = useHarnessUpdates(api);

  return (
    <div
      data-testid="settings-harness-updates-root"
      className="flex h-full flex-col overflow-y-auto"
    >
      <SettingsSectionHeader
        icon={<TitleChip icon={RefreshCw} accent="var(--accent-green-400)" />}
        title="Harness Updates"
      />

      <div className="mx-auto w-full max-w-content">
        {isLoading ? (
          <div className="px-4 py-8">
            <LoadingState label="Loading harness updates…" />
          </div>
        ) : error ? (
          <p
            data-testid="harness-updates-error"
            className="px-4 py-8 text-center text-[length:var(--text-body)] text-red-400"
          >
            Couldn't load harness updates: {error}
          </p>
        ) : unavailable ? (
          <p
            data-testid="harness-updates-unavailable"
            className="px-4 py-8 text-center text-[length:var(--text-body)] text-[var(--app-hint)]"
          >
            Harness update data isn't available on this node yet. It appears
            once the harness detection poll has run.
          </p>
        ) : !status || status.harnesses.length === 0 ? (
          <p
            data-testid="harness-updates-empty-state"
            className="px-4 py-8 text-center text-[length:var(--text-body)] text-[var(--app-hint)]"
          >
            No harnesses are registered for self-update on this node.
          </p>
        ) : (
          <div className="flex flex-col gap-4 px-4 py-3">
            <div className="flex items-center gap-2">
              <span
                className="h-2 w-2 flex-shrink-0 rounded-full bg-emerald-400"
                aria-hidden="true"
              />
              <h2 className="min-w-0 truncate text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
                {status.node_id}
              </h2>
              <span className="text-[length:var(--text-caption)] text-[var(--app-hint)]">
                this node
              </span>
            </div>
            {/* #1775 (Sub-Issue F): global poll-cadence control. Rendered once
                (not per-harness) — v1's cadence is a single global value (KD-2). */}
            <HarnessPollSettings api={api} />
            {status.harnesses.map(h => (
              <HarnessUpdateSection
                key={h.descriptor.id}
                descriptor={h.descriptor}
                state={h.state}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One harness's full section: the card (with the "Review impact" trigger), the
 * analysis state block, and the raw changelog. Its own component so each harness
 * owns its per-harness changelog / analysis / review hooks (hooks cannot be called
 * in a loop in the parent).
 */
function HarnessUpdateSection({
  descriptor,
  state,
}: {
  descriptor: RedactedHarnessDescriptor;
  state: HarnessDetectionState | null;
}) {
  const { api } = useAppContext();
  const navigate = useNavigate();
  const [analysisSessionId, setAnalysisSessionId] = useState<string | null>(
    null
  );
  // #1775 (Sub-Issue F): "Check now" reuses #1770's POST /api/harness/check.
  const { checkNow, isChecking, checkCoalesced } = useHarnessActions(api);

  const updateAvailable = state?.update_available === true;
  const from = state?.installed_version ?? null;
  const to = state?.latest_version ?? null;
  const range = updateAvailable && from && to ? `${from}..${to}` : null;

  const { changelog } = useHarnessChangelog(
    api,
    updateAvailable ? descriptor.id : null
  );
  const { analysis } = useHarnessAnalysis(
    api,
    updateAvailable ? descriptor.id : null,
    range
  );
  const { reviewImpact, isPending } = useReviewImpact(api);

  const analyzing = isPending || analysis?.status === "analyzing";
  const reviewLabel = analyzing
    ? "Analyzing…"
    : analysis?.status === "failed"
      ? "Retry impact review"
      : "Review impact";

  const onReviewImpact =
    range == null
      ? undefined
      : () => {
          void reviewImpact({ harnessId: descriptor.id, range }).then(res => {
            if (res.status === "analyzing" && res.session_id) {
              setAnalysisSessionId(res.session_id);
            }
          });
        };

  return (
    <div className="flex flex-col gap-3">
      <HarnessUpdateCard
        descriptor={descriptor}
        state={state}
        onReviewImpact={onReviewImpact}
        reviewLabel={reviewLabel}
        reviewDisabled={analyzing}
        onCheckNow={() => void checkNow()}
        checkingNow={isChecking}
        checkNote={checkCoalesced ? "A check is already running…" : null}
      />

      {/* #1774 (Sub-Issue E): Update + Rollback actions. Rendered here (not in
          the presentational card) so the card stays byte-identical — #1775 (Sub F)
          edits the card next, so keeping Task 9 out of it avoids a merge collision.
          The component self-gates: Update shows only when an update is available,
          Rollback only when a prior version was captured. `hasImpactReview` drives
          the R1 "no impact review run" nudge in the update dialog. */}
      <HarnessUpdateActions
        descriptor={descriptor}
        state={state}
        hasImpactReview={analysis?.status === "ready"}
      />

      {updateAvailable && analysis?.status === "analyzing" && (
        <div
          data-testid="harness-analysis-analyzing"
          className="flex flex-col gap-1 rounded-md bg-[var(--app-secondary-bg)]/40 px-3 py-2 text-[length:var(--text-body)] text-[var(--app-hint)]"
        >
          <LoadingState label="Analyzing… this may take a minute." />
          {analysisSessionId && (
            <button /* design-tokens-allow: bare-inline text link (hover:underline, no box) - Button box breaks the inline link - D2 exception (#3358) */
              type="button"
              onClick={() =>
                void navigate({
                  to: "/sessions/$sessionId",
                  params: { sessionId: analysisSessionId },
                })
              }
              data-testid="harness-analysis-session-link"
              className="self-start text-[length:var(--text-body-dense)] text-[var(--app-link)] hover:underline"
            >
              View the analysis session
            </button>
          )}
        </div>
      )}

      {updateAvailable && analysis?.status === "at_capacity" && (
        <p
          data-testid="harness-analysis-at-capacity"
          className="rounded-md bg-[var(--app-secondary-bg)]/40 px-3 py-2 text-[length:var(--text-body)] text-[var(--app-badge-warning-text)]"
        >
          At session capacity — archive a session and retry.
        </p>
      )}

      {updateAvailable && analysis?.status === "failed" && (
        <p
          data-testid="harness-analysis-failed"
          className="rounded-md bg-[var(--app-secondary-bg)]/40 px-3 py-2 text-[length:var(--text-body)] text-[var(--app-badge-error-text)]"
        >
          Impact analysis failed. Use "Retry impact review" above to try again.
        </p>
      )}

      {updateAvailable &&
        analysis?.status === "ready" &&
        analysis.artifact.items.length > 0 && (
          <div className="flex flex-col gap-2">
            <ImpactHeadline
              headline={analysis.artifact.headline}
              items={analysis.artifact.items}
            />
            {analysis.artifact.items.map((item, i) => (
              <ImpactItemRow
                key={`item-${i}`}
                item={item}
                companionSessionId={analysis.companion_session_id}
              />
            ))}
          </div>
        )}

      {updateAvailable && changelog && (
        <ChangelogSpanView changelog={changelog} />
      )}
    </div>
  );
}
