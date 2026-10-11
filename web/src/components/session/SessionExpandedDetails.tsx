// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SessionExpandedDetails — composes a session's expanded detail block (the inner two-column
 * layout) from the shared metadata primitives. Extracted from SessionList + SessionHeader
 * (issue #1050).
 *
 * The expand/collapse wrapper (`overflow-hidden … max-h-[400px]`) stays in each container —
 * each drives its own expanded state. This composer renders only the inner block.
 *
 * The action row is now the SHARED `SessionActionCluster`, rendered HERE from
 * `actionClusterProps` (issue #3288 S3, R7). This REPLACED the former per-container
 * `actions` ReactNode injection — the two containers used to render near-duplicate action
 * rows and pass them in, which made list/instance parity (R7) structurally impossible.
 * The container now passes session + handlers + surface; the ONE list/instance divergence
 * (kebab-hover Notes Preview, R3) is carried by the cluster's `surface` prop.
 *
 * Variant props (R6): 0 — every field is data, a callback, or a pre-computed prop object.
 * The per-primitive prop types are reused via `React.ComponentProps` so the composer can
 * never drift out of sync with the primitives' signatures.
 */
import { IssueBadge } from "@/components/IssueBadge";
import { SessionIdDisplay } from "@/components/SessionIdDisplay";
import { resolveNativeSessionId } from "@/lib/sessionHelpers";
import type { SessionLike } from "@/lib/sessionHelpers";
import { SessionBranchRow } from "./SessionBranchRow";
import { SessionModelInfo } from "./SessionModelInfo";
import { SessionActionCluster } from "./SessionActionCluster";
import { SessionPathRow } from "./SessionPathRow";
import { SessionRepoRow } from "./SessionRepoRow";

type SessionExpandedDetailsProps = {
  session: SessionLike;
  hapiShortId: string;
  pathProps: React.ComponentProps<typeof SessionPathRow>;
  /** #4538: the GitHub-repo hotlink row (replaces the project header's button). */
  repoProps: React.ComponentProps<typeof SessionRepoRow>;
  branchProps: React.ComponentProps<typeof SessionBranchRow>;
  issueProps: React.ComponentProps<typeof IssueBadge>;
  modelInfoProps: Omit<
    React.ComponentProps<typeof SessionModelInfo>,
    "session"
  >;
  /** Props for the shared Session Action Cluster (Row 1 + R5), rendered here so
   *  the list card and instance header compose the SAME cluster (#3288 R7). */
  actionClusterProps: React.ComponentProps<typeof SessionActionCluster>;
};

export function SessionExpandedDetails({
  session,
  hapiShortId,
  pathProps,
  repoProps,
  branchProps,
  issueProps,
  modelInfoProps,
  actionClusterProps,
}: SessionExpandedDetailsProps) {
  // #3811: resolve the harness-neutral native session id + descriptor from the
  // session's flavor, so SessionIdDisplay renders the "CLI ID" (#4479) id +
  // per-flavor tooltip (claude/codex/gemini/opencode). A tier-2 / unknown
  // flavor resolves to `absent` → the toggle is hidden.
  const { descriptor, nativeId } = resolveNativeSessionId(session);
  return (
    <div className="mt-1.5 pl-2 py-2 rounded-lg bg-[var(--app-secondary-bg)]">
      {/* Two-column expanded layout - tight gap for maximum content space */}
      <div className="flex gap-1">
        {/* Left column: Session details */}
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          {/* #4479 / #4538: path → repo → branch → linked issue (the Session ID
              moved to the right column, beneath the action cluster; the repo row
              took the line it left and carries the GitHub hotlink the project
              header no longer has). */}
          <SessionPathRow {...pathProps} />
          <SessionRepoRow {...repoProps} />
          <SessionBranchRow {...branchProps} />
          {/* Link Issue */}
          <div className="flex items-center gap-2 min-w-0">
            <IssueBadge {...issueProps} />
          </div>
        </div>

        {/* Right column (#4479): Session Action Cluster (Row 1) → Session ID
            row → `[terminal] Harness | Launcher` line. ONE left-aligned block
            (E6 `.dcol-r`, `align-items:flex-start`) — the cluster and the text
            rows share the column's left edge (`pl-1.5` seats them on the Chain
            Icon's glyph edge). The column width comes from the cluster (or the
            un-pinned harness line, if wider); the ID row is width-pinned so it
            cannot widen it. Keep `gap-2`: the ID
            row's hit band extends exactly 8px up to the cluster's bottom edge. */}
        <div className="flex flex-col items-start gap-2 shrink-0">
          <SessionActionCluster {...actionClusterProps} />
          <SessionIdDisplay
            hapiShortId={hapiShortId}
            nativeId={nativeId}
            nativeIdDescription={descriptor.description}
            hasNativeId={descriptor.mode === "native"}
          />
          <SessionModelInfo session={session} {...modelInfoProps} />
        </div>
      </div>
    </div>
  );
}
