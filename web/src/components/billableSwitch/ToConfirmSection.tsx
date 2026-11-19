// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #6646 (Task 14, AGL-A): the "To confirm" section at the top of the session
 * list. Waiting sessions (`billableConfirm: "pending"`) of every node gather
 * here, each the normal session row with its project named and Keep · Reverse
 * (ruling REV-1: Reverse opens the switch-off confirmation; Keep and Keep all
 * act at once). A decided row returns to its place in the list, and the section
 * disappears when no session waits.
 *
 * One rule against search, filters and Keep all (review P18): the section shows
 * the waiting sessions that pass the search and every filter except the Filter
 * menu's Billable section; its bar states the total and how many a filter
 * hides; Keep all sends only the ids shown, and its toast names the number
 * left.
 *
 * The collapsed state is not stored: the section is open on every page load,
 * because a waiting session is logged at midnight (HOLD-2).
 */
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectBaseKey } from "@hapi/protocol";
import type { ApiClient, BillableSwitchHistoryEvent } from "@/api/client";
import { SessionItem } from "@/components/SessionList/SessionItem";
import { SubheadingBar } from "@/components/SessionList/SubheadingBar";
import { getRepoDisplayName } from "@/components/SessionList/grouping";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import {
  afterBillableWrite,
  useKeepAllBillable,
  type BillableSwitchMode,
} from "@/hooks/useBillableSwitch";
import { useNeedsReview } from "@/hooks/useNeedsReview";
import { queryKeys } from "@/lib/query-keys";
import { formatRelativeTime } from "@/lib/sessionHelpers";
import type { SessionSummary } from "@/types/api";

/** The waiting sessions as the list places them. */
export type ToConfirmSplit = {
  /** Every waiting session: they leave their project groups and schedule rows. */
  ids: ReadonlySet<string>;
  /** The ones that pass the search and every filter but the Billable one. */
  shown: SessionSummary[];
  /** How many sessions wait in the whole list. */
  total: number;
};

export function isToConfirm(session: SessionSummary): boolean {
  return session.billableConfirm === "pending";
}

/**
 * `all` is the unfiltered list; `passing` is the list after the search and the
 * filters other than the Filter menu's Billable section.
 */
export function toConfirmSplit(
  all: readonly SessionSummary[],
  passing: readonly SessionSummary[]
): ToConfirmSplit {
  const waiting = all.filter(isToConfirm);
  return {
    ids: new Set(waiting.map(s => s.id)),
    shown: passing.filter(isToConfirm),
    total: waiting.length,
  };
}

/** A waiting session's project: its repository's short name, else its folder. */
export function toConfirmProject(session: SessionSummary): string {
  const repo = session.metadata?.repoIdentity?.name;
  if (repo) return getRepoDisplayName(repo);
  const key = projectBaseKey(session.metadata);
  return key.split("/").filter(Boolean).pop() ?? key;
}

/** The bar's count: the total, and how many a filter hides when any. */
export function toConfirmCount(split: ToConfirmSplit): string {
  const hidden = split.total - split.shown.length;
  const base = `· ${split.total} started billable`;
  return hidden > 0 ? `${base} · ${hidden} hidden by filters` : base;
}

/** Keep all's toast (the mock-up's words), naming the number left. */
export function keepAllToast(
  kept: number,
  asked: number,
  left: number
): string {
  const rest = left > 0 ? `${left} left to confirm` : "nothing left to confirm";
  return kept === asked
    ? `Kept ${kept} billable · ${rest}`
    : `Kept ${kept} of ${asked} billable · ${rest}`;
}

/**
 * What made a waiting session billable, from its start event: the nodes whose
 * header was on ("billable on <node>, last seen <age>"), or, from a node that
 * does not send them, a sentence built from the start's reason.
 */
export function toConfirmCauseText(
  start: Pick<BillableSwitchHistoryEvent, "reason" | "causeNodes"> | undefined
): string {
  const nodes = start?.causeNodes ?? [];
  if (nodes.length > 0) {
    const parts = nodes.map(n => {
      const seen =
        n.reportedAt !== null ? formatRelativeTime(n.reportedAt) : null;
      return seen
        ? `billable on ${n.nodeLabel}, last seen ${seen}`
        : `billable on ${n.nodeLabel}`;
    });
    return `Started billable: ${parts.join("; ")}`;
  }
  if (
    start?.reason === "cross-node" ||
    start?.reason === "cross-node-unasked"
  ) {
    return "Started billable: this project is billable on another node";
  }
  return "Started billable";
}

/**
 * The row's tooltip: mounted when the tooltip opens, so the history is read
 * once, on the first open, and then served from the cache.
 */
export function ToConfirmCause(props: {
  api: ApiClient | null;
  sessionId: string;
}) {
  const { api, sessionId } = props;
  const { data, isError } = useQuery({
    queryKey: queryKeys.billableSwitchHistory(sessionId),
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getSessionBillableHistory(sessionId);
    },
    enabled: Boolean(api),
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (isError) return <>Why it started billable could not be read.</>;
  if (!data) return <>Reading why it started billable…</>;
  return <>{toConfirmCauseText(data.events.find(e => e.kind === "start"))}</>;
}

export const TO_CONFIRM_CLOSED_LINE =
  "Billable sessions are closed on this server: nothing can be kept or switched on.";

export function ToConfirmSection(props: {
  api: ApiClient | null;
  mode: BillableSwitchMode;
  split: ToConfirmSplit;
  onSelect: (sessionId: string) => void;
  isExpanded: (sessionId: string) => boolean;
  onToggleExpanded: (sessionId: string) => void;
  /**
   * SEL-TC (2026-11-18): the list's select mode, passed to each row as every
   * other row gets it, so a waiting session can be selected like any other.
   */
  selectMode?: boolean;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (sessionId: string) => void;
}) {
  const { api, mode, split } = props;
  const [collapsed, setCollapsed] = useState(false);
  const rowsId = useId();
  const { checkNeedsReview } = useNeedsReview();
  const { showToast } = useToast();
  const keepAll = useKeepAllBillable(api);
  const canKeep = mode === "on";
  const shownIds = split.shown.map(s => s.id);

  const onKeepAll = () => {
    if (shownIds.length === 0) return;
    // Keeping every waiting session empties this section, which the list then
    // drops, so the toast hangs on the write rather than on this component.
    afterBillableWrite(keepAll.mutateAsync({ ids: shownIds }), data => {
      const kept = data.results.filter(r => r.outcome === "ok").length;
      showToast(keepAllToast(kept, shownIds.length, split.total - kept), {
        type: kept === shownIds.length ? "success" : "warning",
      });
    });
  };

  return (
    <section
      aria-label="To confirm"
      className="mx-auto w-full max-w-content"
      data-testid="to-confirm-section"
    >
      <SubheadingBar
        collapsed={collapsed}
        onToggle={() => setCollapsed(c => !c)}
        label="To confirm"
        count={toConfirmCount(split)}
        aria-controls={rowsId}
        className="bg-[color-mix(in_srgb,var(--status-cat-attention)_12%,transparent)] text-[var(--status-cat-attention)]"
        action={
          canKeep ? (
            <Button
              type="button"
              variant="ghostStatic"
              size="bare"
              // Hover and disabled as select mode's accent chip (PATTERN-AUDIT).
              className="-my-1.5 inline-flex h-6 shrink-0 items-center px-1 text-[length:var(--text-caption-xs)] font-semibold leading-none text-[var(--app-accent)] hover:opacity-80 disabled:text-[var(--app-hint)] disabled:opacity-50"
              disabled={shownIds.length === 0 || keepAll.isPending}
              title={`Keep the ${shownIds.length} shown billable`}
              onClick={onKeepAll}
            >
              Keep all
            </Button>
          ) : undefined
        }
      />
      {mode === "closed" ? (
        <p className="px-3 py-1 text-[length:var(--text-caption-xs)] text-[var(--app-hint)]">
          {TO_CONFIRM_CLOSED_LINE}
        </p>
      ) : null}
      {collapsed ? null : (
        <div id={rowsId} className="divide-y divide-[var(--app-divider)]">
          {split.shown.map(s => (
            <SessionItem
              key={s.id}
              session={s}
              onSelect={props.onSelect}
              showPath={false}
              api={api}
              needsReview={checkNeedsReview(
                s.id,
                s.updatedAt,
                s.active,
                s.thinking,
                s.needsReviewOverride as "read" | "unread" | null | undefined
              )}
              isExpanded={props.isExpanded(s.id)}
              onToggleExpanded={() => props.onToggleExpanded(s.id)}
              selectMode={props.selectMode}
              selected={props.selectedIds?.has(s.id) ?? false}
              onToggleSelect={props.onToggleSelect}
              toConfirm={{
                project: toConfirmProject(s),
                canKeep,
                cause: <ToConfirmCause api={api} sessionId={s.id} />,
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}
