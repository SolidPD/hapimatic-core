// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useAppContext } from "@/lib/app-context";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { useSystemJobs } from "@/hooks/queries/useSystemJobs";
import { useSessions } from "@/hooks/queries/useSessions";
import { useFederatedSessions } from "@/hooks/queries/useFederatedSessions";
import { useSchedules } from "@/extensions/scheduler/hooks/useSchedules";
import { CalendarClock, ChevronDown } from "lucide-react";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import { LoadingState } from "@/components/LoadingState";
import {
  SystemJobCard,
  InProcessLoopCard,
  OsCronCard,
} from "@/components/systemJobs/SystemJobCard";
import { LoopCronCard } from "@/components/systemJobs/LoopCronCard";
import { SystemJobsToolbar } from "@/components/systemJobs/SystemJobsToolbar";
import { Button } from "@/components/ui/button";
import {
  useSystemJobsPreferences,
  type SystemJobsPreferences,
} from "@/hooks/useSystemJobsPreferences";
import {
  filterJobs,
  sortJobs,
  filterSchedules,
  sortSchedules,
  isLoopOrphaned,
} from "@/lib/systemJobsSearchFilterSort";
import type {
  SystemJobKind,
  SystemJobsFilters,
} from "@/lib/systemJobsSearchFilterSort";
import type { SystemJobsNode } from "@/types/systemJobs";

/**
 * Search params for the panel (issue #2453 deep links; #3291 S6 adds `kind`).
 * Mirrors `AdminSystemJobsSearch` in `router.tsx` (the route owns validation);
 * this is the local cast over `useSearch`.
 */
type SystemJobsSearch = {
  highlight?: string;
  session?: string;
  kind?: SystemJobKind;
};

/** Reachability dot color for a node group header (R2). */
function statusDotClass(status: string): string {
  if (status === "online") return "bg-emerald-400";
  if (status === "offline") return "bg-red-400";
  return "bg-amber-400"; // degraded / anything non-healthy
}

/**
 * System Jobs — the `/settings/system-jobs` route (epic #1534 Sub-Issue D, issue #1538;
 * promoted from an in-drawer `?section=` view in #1935).
 *
 * Consumes the #1537 aggregate (`useSystemJobs`), renders jobs grouped by federation
 * node, and degrades gracefully when a node is unreachable or empty (R6).
 *
 * Issue #2599: gains a search/filter/sort toolbar + persistent per-node collapse.
 * Search/filter/sort state persists device-scoped (`useSystemJobsPreferences`) and
 * drives both the node groups and the node-independent scheduled-session section.
 */
export default function AdminSystemJobsPage() {
  useDocumentTitle("System Jobs - Hapimatic");
  useEmojiFavicon(null);
  const { api } = useAppContext();
  const { nodes, isLoading, error } = useSystemJobs(api);
  // #2453: deep-link search params (string form avoids a circular import).
  const search = useSearch({
    from: "/settings/system-jobs",
  }) as SystemJobsSearch;

  // #2599: device-scoped search/filter/sort + per-node collapse (localStorage).
  const prefs = useSystemJobsPreferences();
  // #3291 (S6, R2): `?kind=` is a TRANSIENT per-navigation override — the
  // Loop-Cron Modal's "Open in System Jobs" deep link pre-filters to Loop-Crons
  // WITHOUT rewriting the user's saved filter. Compose it over the persisted
  // filters here (a derived value, NEVER a `prefs.setKind` write), exactly the
  // way `?session=`/`?highlight=` already override at read time. The toolbar
  // stays bound to `prefs.filters` (the persisted, user-owned state), so the
  // saved filter is unchanged after the deep link.
  const effectiveFilters: SystemJobsFilters = useMemo(
    () =>
      search.kind ? { ...prefs.filters, kind: search.kind } : prefs.filters,
    [search.kind, prefs.filters]
  );
  // #2599: dynamic Node filter options, built from the loaded nodes (like the
  // session bar's `nodeOptions`).
  const nodeOptions = useMemo(
    () => nodes.map(n => ({ value: n.nodeId, label: n.nodeLabel })),
    [nodes]
  );

  // #2453 orphan detection: a loop whose bound session no longer exists renders
  // the red orphaned card (R6). Best-effort — the union of LOCAL + REMOTE session
  // ids (so a cross-node loop is not false-orphaned), and only marks orphaned
  // once sessions load (an empty set never marks live loops orphaned mid-fetch).
  const { sessions } = useSessions(api);
  const { remoteSessions } = useFederatedSessions(api);
  const liveSessionIds = new Set<string>(
    [...sessions, ...remoteSessions].map(s => s.id)
  );

  return (
    <div
      data-testid="settings-system-jobs-root"
      className="flex h-full flex-col overflow-y-auto"
    >
      <SettingsSectionHeader
        icon={
          <TitleChip icon={CalendarClock} accent="var(--accent-violet-400)" />
        }
        title="System Jobs"
      />

      {/* #2331: ONE shared wrapper caps all four body branches at the header's
          `max-w-content`, rather than four separate edits. The branch classNames
          below are untouched so their padding and text-centring are preserved.
          The scroll root above stays full-width so the scrollbar sits at the
          viewport edge. */}
      <div className="mx-auto w-full max-w-content">
        {/* #2599: the toolbar sits at the top of the successfully-loaded panel,
            above the empty/content branches (hidden while loading/errored so it
            never renders over a spinner or a load failure). */}
        {!isLoading && !error && (
          <div className="px-4 pt-3">
            <SystemJobsToolbar
              searchText={prefs.searchText}
              filters={prefs.filters}
              sort={prefs.sort}
              sortDirection={prefs.sortDirection}
              nodeOptions={nodeOptions}
              onSearchTextChange={prefs.setSearchText}
              onKindChange={prefs.setKind}
              onHealthChange={prefs.setHealth}
              onNodeChange={prefs.setNode}
              onEnabledChange={prefs.setEnabled}
              onSortChange={prefs.setSort}
              onSortDirectionChange={prefs.setSortDirection}
              onClearAll={prefs.clearAll}
              onClearFilters={prefs.clearFilters}
              onClearSort={prefs.clearSort}
            />
          </div>
        )}
        {isLoading ? (
          <div className="px-4 py-8">
            <LoadingState label="Loading system jobs…" />
          </div>
        ) : error ? (
          <p
            data-testid="system-jobs-error"
            className="px-4 py-8 text-center text-[length:var(--text-body)] text-red-400"
          >
            Couldn't load system jobs: {error}
          </p>
        ) : (
          <>
            {nodes.length === 0 ? (
              <p
                data-testid="system-jobs-empty-state"
                className="px-4 py-8 text-center text-[length:var(--text-body)] text-[var(--app-hint)]"
              >
                No federation nodes are currently reporting system jobs.
              </p>
            ) : (
              <div className="flex flex-col gap-4 px-4 py-3">
                {nodes.map(node => (
                  <NodeGroup
                    key={node.nodeId}
                    node={node}
                    prefs={prefs}
                    filters={effectiveFilters}
                    highlightId={search.highlight}
                    sessionFilter={search.session}
                    liveSessionIds={liveSessionIds}
                  />
                ))}
              </div>
            )}
            {/* R7: scheduled-session entries as a read-only fifth kind —
                independent of nodes (namespace-scoped, not node-global). */}
            <div className="px-4 py-3">
              <ScheduledSessionsSection
                prefs={prefs}
                filters={effectiveFilters}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Scheduled-session section (issue #2453, R7 / Decision 7) — a read-only fifth
 * kind. The scheduler LIST surface (`GET /api/schedules`) is namespace-scoped,
 * not node-global, so it cannot merge inside `listJobs()`; it is fetched
 * client-side here. Rows link to the existing schedule editor. Create-flow
 * consolidation is an explicit NON-GOAL (follow-up issue).
 *
 * #2599: search + filter (kind/health/enabled) apply here too — the Node filter
 * never does (schedules are node-independent). The section returns `null` when
 * the filter empties it, matching its existing no-schedules behavior.
 */
function ScheduledSessionsSection({
  prefs,
  filters,
}: {
  prefs: SystemJobsPreferences;
  /** #3291: effective filters (persisted prefs + the transient `?kind=` override). */
  filters: SystemJobsFilters;
}) {
  const { api } = useAppContext();
  const navigate = useNavigate();
  // Reuse the existing scheduler hook (namespace-scoped `GET /api/schedules`).
  const { schedules } = useSchedules(api);
  const visible = sortSchedules(
    filterSchedules(schedules, {
      search: prefs.searchText,
      filters,
    }),
    prefs.sort,
    prefs.sortDirection
  );
  if (visible.length === 0) return null;

  return (
    <section
      data-testid="system-jobs-scheduled-sessions"
      className="flex flex-col gap-2"
    >
      <div className="flex items-center gap-2">
        <span
          className="h-2 w-2 flex-shrink-0 rounded-full bg-[var(--app-hint)]"
          aria-hidden="true"
        />
        <h2 className="min-w-0 truncate text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
          Scheduled sessions
        </h2>
        <span className="text-[length:var(--text-caption)] text-[var(--app-hint)]">
          read-only
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {visible.map(s => (
          <Button
            key={s.id}
            type="button"
            variant="ghost"
            data-testid={`scheduled-session-row-${s.id}`}
            onClick={() =>
              void navigate({
                to: "/sessions",
                search: { view: "schedules", scheduleId: s.id },
              })
            }
            className="flex h-auto items-center justify-start gap-2 rounded-md border border-[var(--app-secondary-bg)] bg-[var(--app-secondary-bg)]/40 px-3 py-2 text-left hover:bg-[var(--app-secondary-bg)]/40"
          >
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-label-strong)] font-medium text-[var(--app-fg)]">
              {s.emoji ? `${s.emoji} ` : ""}
              {s.name}
            </span>
            <span className="flex-shrink-0 text-[length:var(--text-caption)] text-[var(--app-hint)]">
              scheduled
            </span>
            <span className="flex-shrink-0 rounded-full bg-[var(--app-hint)]/15 px-2 py-0.5 font-mono text-[length:var(--text-caption)] text-[var(--app-hint)]">
              {s.cronExpression ?? s.scheduleType}
            </span>
          </Button>
        ))}
      </div>
    </section>
  );
}

function NodeGroup({
  node,
  prefs,
  filters,
  highlightId,
  sessionFilter,
  liveSessionIds,
}: {
  node: SystemJobsNode;
  prefs: SystemJobsPreferences;
  /**
   * #3291: effective filters — the persisted `prefs.filters` composed with the
   * transient `?kind=` override. Used for the filter/narrow reads below; the
   * toolbar still binds to `prefs.filters` so the saved state is untouched.
   */
  filters: SystemJobsFilters;
  highlightId?: string;
  sessionFilter?: string;
  liveSessionIds: Set<string>;
}) {
  // R7: the deep-linked target's node is force-shown + force-expanded so the
  // #2596 jump-to-job path lands even under an active node filter / collapse.
  const nodeHasHighlight =
    highlightId != null &&
    (node.jobs ?? []).some(
      v => v.kind === "loop-cron" && v.loop.id === highlightId
    );

  // Node filter removes a node — unless it holds the highlighted target (R7).
  if (
    filters.node !== "all" &&
    node.nodeId !== filters.node &&
    !nodeHasHighlight
  ) {
    return null;
  }

  const baseJobs = node.jobs ?? [];
  const jobs = sortJobs(
    filterJobs(baseJobs, {
      search: prefs.searchText,
      filters,
      sessionFilter,
      highlightId,
      liveSessionIds,
    }),
    prefs.sort,
    prefs.sortDirection,
    liveSessionIds
  );

  // Under an active narrowing (search / kind / health / enabled / ?session=), a
  // node whose jobs all filter out vanishes — matching the session list and the
  // existing ?session= hide-empty behavior. Node-load errors are orthogonal to a
  // job search, so an errored node stays visible (its failure is a node signal).
  const narrowing =
    prefs.searchText.trim() !== "" ||
    filters.kind !== "all" ||
    filters.health !== "all" ||
    filters.enabled !== "all" ||
    Boolean(sessionFilter);
  if (narrowing && jobs.length === 0 && !node.error) return null;

  // R2 (#1964, extended #2453): a node with any stalled/dead in-process loop OR
  // any stalled loop-cron flips its group dot red, independent of node
  // reachability — the silent-failure class this portal exists to surface. The
  // dot reflects the currently-visible (filtered/sorted) jobs.
  const hasUnhealthyLoop = jobs.some(
    v =>
      (v.kind === "in-process-loop" &&
        (v.loop.status === "stalled" || v.loop.status === "dead")) ||
      (v.kind === "loop-cron" && v.loop.state === "stalled")
  );
  const dotClass = hasUnhealthyLoop
    ? "bg-red-400"
    : statusDotClass(node.status);

  // R5/R6: per-node collapse (persisted). The highlighted node force-expands.
  const collapsed = prefs.isNodeCollapsed(node.nodeId) && !nodeHasHighlight;

  return (
    <section
      data-testid={`system-jobs-node-${node.nodeId}`}
      className="flex flex-col gap-2"
    >
      <Button
        type="button"
        variant="ghost"
        onClick={() => prefs.toggleNode(node.nodeId)}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${node.nodeLabel} jobs`}
        data-testid={`system-jobs-node-toggle-${node.nodeId}`}
        className="flex h-auto w-full items-center justify-start gap-2 rounded-md px-1 py-0.5 text-left hover:bg-[var(--app-secondary-bg)]/40"
      >
        <span
          className={`h-2 w-2 flex-shrink-0 rounded-full ${dotClass}`}
          aria-hidden="true"
        />
        <h2 className="min-w-0 truncate text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
          {node.nodeLabel}
        </h2>
        <span className="text-[length:var(--text-caption)] text-[var(--app-hint)]">
          {node.status}
        </span>
        <ChevronDown
          className={`ml-auto h-3.5 w-3.5 flex-shrink-0 text-[var(--app-hint)] transition-transform ${collapsed ? "-rotate-90" : ""}`}
          aria-hidden="true"
        />
      </Button>

      {!collapsed &&
        (node.error ? (
          <p
            data-testid={`system-jobs-node-error-${node.nodeId}`}
            className="rounded-md bg-[var(--app-secondary-bg)]/40 px-3 py-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
          >
            Couldn't load jobs from {node.nodeLabel}: {node.error}
          </p>
        ) : jobs.length === 0 ? (
          <p
            data-testid={`system-jobs-node-empty-${node.nodeId}`}
            className="px-3 py-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
          >
            No system jobs on {node.nodeLabel}.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {jobs.map((view, i) => {
              if (view.kind === "in-process-loop") {
                return (
                  <InProcessLoopCard
                    key={`loop-${view.loop.name}`}
                    loop={view.loop}
                  />
                );
              }
              if (view.kind === "os-cron") {
                return <OsCronCard key={`cron-${i}`} cron={view.cron} />;
              }
              if (view.kind === "loop-cron") {
                // #2453: key on loop.id (NOT array index — the os-cron rows do,
                // but loop-cron rows have stable ids for the ?highlight deep link).
                return (
                  <LoopCronCard
                    key={`lc-${view.loop.id}`}
                    loop={view.loop}
                    nodeId={node.nodeId}
                    highlighted={highlightId === view.loop.id}
                    orphaned={isLoopOrphaned(view.loop, liveSessionIds)}
                  />
                );
              }
              return (
                <SystemJobCard
                  key={view.job.name}
                  job={view.job}
                  liveState={view.liveState}
                  nodeId={node.nodeId}
                />
              );
            })}
          </div>
        ))}
    </section>
  );
}
