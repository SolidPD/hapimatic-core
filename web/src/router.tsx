// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- Route manifest at capacity: the #1773 harness-updates
   and #3128 harness-scorecard routes tip this append-only registry past the Epic-0
   (#2077) 1500-line guardrail (a route needs ≥7 lines). Decomposing the settings/admin
   route block into a submodule is the tracked follow-up; grandfathered like
   web/src/api/client.ts until then. See claudedocs/architecture-hotspot-review.md (#2077). */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ScrollPositionRail } from "@/components/ui/ScrollPositionRail";
import {
  Navigate,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { App } from "@/App";
import { reconcileSessionViewOpenRedirects } from "@/lib/session-view";
import { NotFoundPage } from "@/components/NotFoundPage";
import { SessionChat } from "@/components/SessionChat";
import {
  SessionList,
  groupSessionsByProject,
  useProjectExpandState,
  useExpandedSessions,
} from "@/components/SessionList";
import type { FilterView } from "@/components/SessionList";
import {
  NewSession,
  type NewSessionHandle,
  type ExpandState,
} from "@/components/NewSession";
import type { AgentType } from "@/components/NewSession/types";
import { LoadingState } from "@/components/LoadingState";
import { useAppContext } from "@/lib/app-context";
import { clearLastRoute } from "@/lib/route-persistence";
import { useAppGoBack } from "@/hooks/useAppGoBack";
import { useMessages } from "@/hooks/queries/useMessages";
import { useParentMessages } from "@/hooks/queries/useParentMessages";
import { useMachines } from "@/hooks/queries/useMachines";
import { useSession } from "@/hooks/queries/useSession";
import { useSessions } from "@/hooks/queries/useSessions";
import { SpawningSessionView } from "@/components/SpawningSessionView";
import { useSpawnHandoverActive } from "@/lib/spawn-draft";
import { useFederatedSessions } from "@/hooks/queries/useFederatedSessions";
import { useSlashCommands } from "@/hooks/queries/useSlashCommands";
import { useSendMessage } from "@/hooks/mutations/useSendMessage";
import {
  useSessionActions,
  dedupeById,
} from "@/hooks/mutations/useSessionActions";
import { useNeedsReview } from "@/hooks/useNeedsReview";
import { useAdminPreferences } from "@/hooks/useAdminPreferences";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { getSessionTitle, getStatusBreakdown } from "@/lib/sessionHelpers";
import type { RecoveryStatus } from "@/types/api";
import { checkIsWaitingForUserQuestion, LOCAL_NODE_ID } from "@hapi/protocol";
import {
  BackIcon,
  PlusIcon,
  ChevronIcon,
  RotateCcwIcon,
  SelectIcon,
} from "@/components/icons";
import { CumulativeTimer, ClockIcon } from "@/components/SessionTimer";
import { useToast } from "@/components/Toast";
import { queryKeys } from "@/lib/query-keys";
import { isActionPending } from "@/lib/session-action-pending";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScheduleForm } from "@/extensions/scheduler/components/ScheduleForm";
import { HeartbeatSettings } from "@/extensions/heartbeat/HeartbeatSettings";
import { useSchedules } from "@/extensions/scheduler/hooks/useSchedules";
import {
  useHeartbeatConfig,
  useHeartbeatStatus,
} from "@/extensions/heartbeat/useHeartbeat";
import type { ScheduledTask } from "@/types/api";
import ErrorLogsPage from "@/extensions/error-log-viewer/routes/error-logs";
import ExtensionMarketplacePage from "@/extensions/extension-marketplace/routes/extensions";
import {
  SearchFilterBar,
  getSearchFilterEngagement,
} from "@/components/SearchFilterBar";
import { SelectModeChipRow } from "@/components/SessionList/SelectModeChipRow";
import { useSelectMode } from "@/components/SessionList/useSelectMode";
import {
  applySessionSearchFilter,
  makeSessionComparator,
} from "@/lib/sessionSearchFilterSort";
import { useSearchFilterPreferences } from "@/hooks/useSearchFilterPreferences";
import { useSessionFilterOptions } from "@/hooks/useSessionFilterOptions";
import {
  getStoredManualActive,
  persistManualActive,
} from "@/lib/sessionListManualOrder";
import { useSplitViewContext } from "@/lib/split-view-context";
import { SplitPaneContentView } from "@/components/SplitPaneContentView";
import FilesPage from "@/extensions/git-rpc/routes/files";
import FilePage from "@/extensions/git-rpc/routes/file";
import TerminalPage from "@/routes/sessions/terminal";
import ClaudePtyPage from "@/routes/sessions/claude-pty";
import DesktopPage from "@/routes/sessions/desktop";
import AccountUsagePage from "@/routes/account-usage";
// Admin pages promoted from in-drawer `?section=` overlays to their own routes (#1935).
import FederationDashboard from "@/routes/settings/federation";
import { NodeDetailView } from "@/components/federation/NodeDetailView";
import AdminSystemJobsPage from "@/routes/settings/system-jobs";
import type { SystemJobKind } from "@/lib/systemJobsSearchFilterSort";
import AdminFileConflictsPage from "@/routes/settings/file-conflicts";
import TimeLogPage from "@/extensions/time-log/routes/time-log";
import SessionMetadataPage from "@/routes/settings/session-metadata";
import TranscriptsPage from "@/routes/settings/transcripts";
import AdminFeedbackPage from "@/routes/settings/feedback";
import AdminPreferencesPage from "@/routes/settings/preferences";
import AdminAboutPage from "@/routes/settings/about";
import AdminKeysPage from "@/routes/settings/keys";
import ExtensionsAdminPage from "@/routes/settings/extensions";
import ConfigurationAdminPage from "@/routes/settings/configuration";
import AdminVmsPage from "@/routes/settings/vms";
import HarnessScorecardPage from "@/routes/settings/harness-scorecard";
import AdminHarnessUpdatesPage from "@/routes/settings/harness-updates";
// #3752: capability panel lives under components/Settings (per the directive),
// not routes/settings — a deliberate placement deviation.
import CapabilitiesPanel from "@/components/Settings/CapabilitiesPanel";
import { makeLegacyAdminRedirects } from "@/routes/legacyAdminRedirects";
import { makeDesignRoutes } from "@/routes/design/designRoute";
import { Button } from "@/components/ui/button";

const LazyAnalyticsPage = lazy(
  () => import("@/extensions/analytics/routes/analytics")
);

// Get status emoji for document title / favicon based on session state.
// Priority matches getStatusDotClass() in RecoveryStatusBadge.tsx:
// ⚠️  recovering - Session recovery in progress
// 🔴 failed     - Session recovery failed
// ⚫ disconnected - Session not active
// 🟠 waiting    - Claude blocked on user input (AskUserQuestion)
// 🔵 thinking   - Claude is actively working
// 🟠 needs review - Claude finished, user hasn't reviewed yet
// 🟢 idle       - Session active, up to date
function getStatusEmoji(
  active: boolean,
  thinking: boolean,
  needsReview: boolean,
  recoveryStatus?: RecoveryStatus,
  isWaitingForUserQuestion?: boolean
): string {
  if (recoveryStatus === "recovering") return "⚠️";
  if (recoveryStatus === "failed") return "🔴";
  if (!active) return "⚫";
  if (isWaitingForUserQuestion) return "🟠";
  if (thinking) return "🔵";
  if (needsReview) return "🟠";
  return "🟢";
}

function SessionsPage() {
  const { api } = useAppContext();
  const navigate = useNavigate();
  const { view: searchView, scheduleId: searchScheduleId } =
    sessionsRoute.useSearch();
  const {
    sessions: localSessions,
    isLoading,
    error,
    refetch,
  } = useSessions(api);
  const { remoteSessions, localNode } = useFederatedSessions(api);

  // Schedule data for unified list
  const { schedules } = useSchedules(api);
  const { config: heartbeatConfig } = useHeartbeatConfig(api);
  const { status: heartbeatStatus } = useHeartbeatStatus(api);

  // Filter view state — initialized from URL (filter cycle button removed in #872)
  const [filterView] = useState<FilterView>(searchView ?? "all");

  // Merge local + remote (federated) sessions.
  // When federation is enabled, enrich local sessions with the hub's own
  // nodeId/nodeLabel so NodeBadge renders for ALL sessions, not just remote.
  const sessions = useMemo(() => {
    const enrichedLocal = localNode
      ? localSessions.map(s => ({
          ...s,
          nodeId: localNode.nodeId,
          nodeLabel: localNode.nodeLabel,
        }))
      : localSessions;
    // #2826 / #2900: dedupe the merged local+federation set by id (first wins,
    // so the hub-enriched local copy takes precedence over a federation echo of
    // the same session). Both the toolbar total (`statusCounts`) and the grouped
    // list derive from this single array, so deduping HERE keeps a federation hub
    // from double-counting sessions — the exact class #2826 fixed for the
    // delete-all dialog. Reused, never re-implemented inline (epic CF-4).
    return dedupeById([...enrichedLocal, ...remoteSessions]);
  }, [localSessions, remoteSessions, localNode]);

  // Search/filter/sort bar state (server-synced). Destructured here — ABOVE the
  // groups memo — so filtering and the sort comparator can feed grouping (#942).
  const {
    prefs: searchFilterPrefs,
    setSearchText,
    setFilterStatus,
    setFilterType,
    setFilterProject,
    setFilterNode,
    setFilterHarness,
    setFilterAccount,
    setFilterProvider,
    setFilterReview,
    setFilterLinkedIssue,
    setSort,
    setSortDirection,
    clearAll: clearSearchFilters,
    clearFilters,
    clearSort,
  } = useSearchFilterPreferences(api);

  // #3114: manual drag-sort. `manualActive` (device-local) records that a custom
  // drag order overrides the #942 server sort. It is set true by SessionListContainer
  // on the first completed drag (shared via the lifted setter below); while set, the
  // SearchFilterBar Sort control displays "Manual". Explicitly choosing — or clearing
  // — a sort exits Manual and returns to the server order.
  const [manualActive, setManualActive] = useState(() =>
    getStoredManualActive()
  );
  const exitManualSort = useCallback(() => {
    setManualActive(false);
    persistManualActive(false);
  }, []);
  const handleSortChange = useCallback(
    (next: Parameters<typeof setSort>[0]) => {
      exitManualSort();
      setSort(next);
    },
    [exitManualSort, setSort]
  );
  const handleClearSort = useCallback(() => {
    exitManualSort();
    clearSort();
  }, [exitManualSort, clearSort]);
  const handleClearAll = useCallback(() => {
    exitManualSort();
    clearSearchFilters();
  }, [exitManualSort, clearSearchFilters]);

  // #3810: harness + account filter option lists + the resolved node→account
  // map, derived in a hook so router.tsx grows only by wiring lines (max-lines
  // discipline, R4).
  const {
    harnessOptions,
    accountOptions,
    providerOptions,
    resolvedNodeAccounts,
  } = useSessionFilterOptions(api, sessions);

  // Filter the flat list BEFORE grouping (order-independent; empty groups
  // vanish automatically since groupSessionsByProject only emits non-empty
  // groups). #942. #3810: the resolved node→account map feeds the account
  // predicate; it is a memo dep so a late node-account resolution re-filters.
  const filteredSessions = useMemo(
    () =>
      applySessionSearchFilter(
        sessions,
        searchFilterPrefs,
        resolvedNodeAccounts
      ),
    [sessions, searchFilterPrefs, resolvedNodeAccounts]
  );

  // Distinct nodes present in the (unfiltered) session list — feeds the Node
  // filter options (#942 R6).
  const nodeFilterOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of sessions) {
      if (s.nodeId && !seen.has(s.nodeId)) {
        seen.set(s.nodeId, s.nodeLabel ?? s.nodeId);
      }
    }
    return Array.from(seen.entries()).map(([value, label]) => ({
      value,
      label,
    }));
  }, [sessions]);

  // Aggregate session status counts for toolbar status indicators.
  //
  // #2900: this counts ALL sessions across ALL groups (by design — an
  // at-a-glance total must NOT fluctuate as the user collapses/expands groups).
  // Because the list is default-collapsed (#81), the total can exceed the number
  // of visible cards. Each surface (project group, branch cluster, managed-peer
  // cluster, scheduler-spawned section) carries an always-on `SessionCountBadge`
  // (#3133) in SessionListContainer so the total reconciles visually with what is
  // on screen. `getStatusBreakdown` shares `getSessionStatusCategory` with those
  // badges, so they cannot diverge (R4).
  const { checkNeedsReview } = useNeedsReview();
  const statusCounts = useMemo(
    () =>
      getStatusBreakdown(sessions, s =>
        checkNeedsReview(
          s.id,
          s.updatedAt,
          s.active,
          s.thinking,
          s.needsReviewOverride as "read" | "unread" | null | undefined
        )
      ),
    [sessions, checkNeedsReview]
  );

  // Split-view state (shared instance — the top-bar SplitScreen toggle in
  // BrandedFrame drives the same state; #1043). #3280 (Split-view v2): the pane
  // view identity (`paneAView`/`paneBView`/`setPaneView`) is now LIFTED into the
  // SplitViewProvider so it survives this route unmounting on a full `/settings/*`
  // navigation and is restored on back-navigation (R5). The old route-local pane
  // `useState`, the `lastActivePane` ref, and the collapse-to-last-active
  // `useEffect([isSplit])` were removed — collapse-on-exit navigation is now the
  // single collapse path in `App.tsx`'s split-toggle handler (#3280 Task 6, R7).
  const { isSplit, paneAView, paneBView, setPaneView } = useSplitViewContext();

  // Lifted expand/collapse state for global chevron control (Pane A — persisted)
  const groups = useMemo(() => {
    // KD-2: keep the active/pending-first priority order for the DEFAULT sort
    // (Last Active / desc) by passing no comparator; any non-default sort uses
    // a pure comparator so e.g. "Name A→Z" is purely alphabetical.
    const isDefaultSort =
      searchFilterPrefs.sort === "updated" &&
      searchFilterPrefs.sortDirection === "desc";
    const comparator = isDefaultSort
      ? undefined
      : makeSessionComparator(
          searchFilterPrefs.sort,
          searchFilterPrefs.sortDirection
        );
    return groupSessionsByProject(filteredSessions, comparator);
  }, [
    filteredSessions,
    searchFilterPrefs.sort,
    searchFilterPrefs.sortDirection,
  ]);
  const [projectExpandState, setProjectExpanded] = useProjectExpandState();
  const [expandedSessions, toggleSessionExpanded, setAllSessionsExpanded] =
    useExpandedSessions();

  // Auto-expand repo groups on first mount per tab when the user preference is
  // enabled (#1040 R8). Ref-gated so it applies exactly once, after the session
  // list has resolved (groups are keyed by groupKey, matching the global
  // expand/collapse-all control below).
  const { prefs: adminPrefs } = useAdminPreferences();
  // #3276: which end of the session list the control bar renders at ("top" default).
  const controlBarPosition = adminPrefs.sessionListControlBarPosition;
  const autoExpandAppliedRef = useRef(false);
  // Epic #3285 round 14 (item 1 / option B): the list's scroll owners, for the
  // overlay ScrollPositionRail(s). Native scrollbars are hidden (`scrollbar-none`)
  // so no layout width is reserved and the row chevron column lines up with the
  // app-bar gear column at every viewport width.
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const paneAScrollRef = useRef<HTMLDivElement | null>(null);
  const paneBScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!adminPrefs.autoExpandRepoGroups) return;
    if (autoExpandAppliedRef.current) return;
    if (sessions.length === 0) return;
    autoExpandAppliedRef.current = true;
    for (const group of groups) {
      setProjectExpanded(group.groupKey, true);
    }
  }, [adminPrefs.autoExpandRepoGroups, sessions, groups, setProjectExpanded]);

  // Pane B expand/collapse state — non-persisting, diverges from Pane A in-memory
  const [paneBProjectExpand, setPaneBProjectExpand] = useState<
    Map<string, boolean>
  >(() => new Map());
  const setPaneBProjectExpandFn = useCallback(
    (directory: string, expanded: boolean) => {
      setPaneBProjectExpand(prev => {
        const next = new Map(prev);
        next.set(directory, expanded);
        return next;
      });
    },
    []
  );
  const [paneBExpandedSessions, setPaneBExpandedSessions] = useState<
    Set<string>
  >(() => new Set());
  const togglePaneBSessionExpanded = useCallback((sessionId: string) => {
    setPaneBExpandedSessions(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  const isGroupCollapsed = useCallback(
    (groupKey: string, directory: string): boolean => {
      const stored =
        projectExpandState.get(groupKey) ?? projectExpandState.get(directory);
      return stored !== undefined ? !stored : true; // default collapsed
    },
    [projectExpandState]
  );

  // Set document title to "Sessions - Hapimatic" for list view
  useDocumentTitle("Sessions - Hapimatic");

  // Reset favicon to default when viewing session list (no session-specific status)
  useEmojiFavicon(null);

  // Issue #1892 (Sub H2): the legacy free-running client-timer store
  // (useAllSessionTimers) and its SSE-listener hook (useTimeLogReset) were
  // deleted with the client timer surface. The cumulative header timer now sums
  // the retained serverAccumulatedMs; the `timer-reset` → time-log cache
  // invalidation lives directly in useSSE.ts (the belt-and-suspenders path that
  // survived useTimeLogReset's deletion).

  const queryClient = useQueryClient();

  const handleRefresh = useCallback(() => {
    void refetch();
    void queryClient.invalidateQueries({
      queryKey: queryKeys.federationAllSessions,
    });
  }, [refetch, queryClient]);

  // Schedule edit dialogs — open ScheduleForm/HeartbeatSettings in overlay
  const [editingSchedule, setEditingSchedule] = useState<ScheduledTask | null>(
    null
  );
  const [editingHeartbeat, setEditingHeartbeat] = useState(false);

  const handleEditSchedule = useCallback((task: ScheduledTask) => {
    setEditingSchedule(task);
  }, []);

  const handleEditHeartbeat = useCallback(() => {
    setEditingHeartbeat(true);
  }, []);

  const handleCreateSchedule = useCallback(() => {
    navigate({ to: "/sessions/new" });
  }, [navigate]);

  // Select Mode (#3292, epic #3285 S7) — ephemeral multi-select store shared by the
  // Control Bar Select button, the Session cards, and the Chip Row (see useSelectMode).
  const {
    selectMode,
    selectedIds,
    toggleSelectMode,
    exitSelectMode,
    toggleSelect,
    selectAll,
    selectNone,
  } = useSelectMode();

  // Toolbar content rendered per-pane (or once when not split).
  // Includes timer, time log, split toggle, and all action icons in a single row.
  // E8/E9 Control Bar: the Revert (clear-all) control sits in a slot of its own,
  // directly under the app bar's split icon, and shows only while a filter or a
  // non-default sort is engaged (the Search Field's own ✕ clears a search term).
  const { filtersActive, sortActive } = getSearchFilterEngagement({
    filters: searchFilterPrefs.filters,
    sort: searchFilterPrefs.sort,
    sortDirection: searchFilterPrefs.sortDirection,
    searchText: searchFilterPrefs.searchText,
    manualSortActive: manualActive,
  });
  const revertVisible = filtersActive || sortActive;

  // (`setPaneView` is now provided by the split-view context — #3280 Task 3.)
  const renderPaneToolbar = (pane?: "A" | "B"): React.ReactElement => (
    <div className="mx-auto w-full max-w-content flex items-center gap-2 pl-2 pr-2 py-1">
      {/* Left: Timer + status counts */}
      <div className="flex flex-col leading-none w-fit">
        <div className="flex items-center gap-1">
          <span className="flex h-2.5 w-2.5 items-center justify-center shrink-0">
            <ClockIcon className="h-2.5 w-2.5 text-[var(--app-hint)]" />
          </span>
          <CumulativeTimer sessions={sessions} />
        </div>
        <div
          // #3484: pinned to --status-cluster-w (index.css) so the four flex-1
          // columns stop following the timer text's width above — every
          // SubheadingBar's status cluster is sized from the same token, which
          // is what lets the subheading columns align under these by construction.
          className="flex items-center mt-px text-[10px] tabular-nums w-[var(--status-cluster-w)]"
          title="Session status across ALL sessions, including sessions in collapsed groups"
          aria-label={`Session status across all sessions, including collapsed groups: ${statusCounts.orange} need attention, ${statusCounts.blue} working, ${statusCounts.green} active, ${statusCounts.gray} inactive`}
        >
          <span className="flex-1 text-right text-[var(--status-cat-attention)]">
            {statusCounts.orange}
          </span>
          {/* design-system PERMANENT exception (#3336, from #3038 pilot): decorative
              6px separator dot, far below the type-scale floor — a glyph size, not
              "type". Registered in docs/design/design-system/decision-typography.md
              § Sub-floor type-size exceptions. */}
          <span className="shrink-0 text-[var(--app-hint)] text-[6px] leading-none px-1">
            •
          </span>
          <span className="flex-1 text-right text-[var(--status-cat-working)]">
            {statusCounts.blue}
          </span>
          {/* design-system PERMANENT exception (#3336, from #3038 pilot): decorative
              6px separator dot, far below the type-scale floor — a glyph size, not
              "type". Registered in docs/design/design-system/decision-typography.md
              § Sub-floor type-size exceptions. */}
          <span className="shrink-0 text-[var(--app-hint)] text-[6px] leading-none px-1">
            •
          </span>
          <span className="flex-1 text-right text-[var(--status-cat-active)]">
            {statusCounts.green}
          </span>
          {/* design-system PERMANENT exception (#3336, from #3038 pilot): decorative
              6px separator dot, far below the type-scale floor — a glyph size, not
              "type". Registered in docs/design/design-system/decision-typography.md
              § Sub-floor type-size exceptions. */}
          <span className="shrink-0 text-[var(--app-hint)] text-[6px] leading-none px-1">
            •
          </span>
          <span className="flex-1 text-right text-[var(--status-cat-inactive)]">
            {statusCounts.gray}
          </span>
        </div>
      </div>
      {/* Search / filter / sort — fills the space between the status counts and
          the action icons, forming the single toolbar row (#942). E8/E9: the
          Search Field is ALWAYS expanded and fills the rest; Filter and Sort sit
          right after it, immediately left of the Revert slot below. */}
      <SearchFilterBar
        searchText={searchFilterPrefs.searchText}
        filters={searchFilterPrefs.filters}
        sort={searchFilterPrefs.sort}
        sortDirection={searchFilterPrefs.sortDirection}
        nodeOptions={nodeFilterOptions}
        harnessOptions={harnessOptions}
        accountOptions={accountOptions}
        providerOptions={providerOptions}
        onSearchTextChange={setSearchText}
        onFilterStatusChange={setFilterStatus}
        onFilterTypeChange={setFilterType}
        onFilterProjectChange={setFilterProject}
        onFilterNodeChange={setFilterNode}
        onFilterHarnessChange={setFilterHarness}
        onFilterAccountChange={setFilterAccount}
        onFilterProviderChange={setFilterProvider}
        onFilterReviewChange={setFilterReview}
        onFilterLinkedIssueChange={setFilterLinkedIssue}
        onSortChange={handleSortChange}
        onSortDirectionChange={setSortDirection}
        onClearAll={handleClearAll}
        onClearFilters={clearFilters}
        onClearSort={handleClearSort}
        manualSortActive={manualActive}
      />
      {/* Right: action icons — icon-col system for vertical alignment.
          #3292: Delete-All-Disconnected + Connect/Disconnect-All RETIRED into Select
          Mode (chip row). Epic #3285 correction pass (2026-09-05): the global
          Expand/Collapse-All control is REMOVED — the taxonomy's Control Bar is
          Search · Filter · Sort · Select · Create only; expand/collapse is the
          per-project chevron in the ProjectHeader. Create (+) stays rightmost.
          E8/E9 (approved 2026-09-05): three slots that seat directly under the
          app bar's three icons — Revert slot under Split · Select under Refresh
          · Create under the gear. */}
      <div
        className="icon-row"
        style={{
          width: "calc(var(--icon-slot) * 2 + var(--icon-btn-size))",
        }}
      >
        {/* Revert slot — col-3, directly under the app bar's split icon. ALWAYS
            reserved (so Filter/Sort never move); its clear-all control appears only
            while a filter or a non-default sort is engaged. Moved here from
            SearchFilterBar, which used to float it after Sort. */}
        <div className="icon-col-3">
          {revertVisible && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={handleClearAll}
              className="text-[var(--app-hint)]"
              title="Clear all filters, search, and sort"
              aria-label="Clear all filters, search, and sort"
            >
              <RotateCcwIcon className="h-5 w-5" />
            </Button>
          )}
        </div>
        {/* Select Mode toggle — col-2. #3292 R4: var(--app-accent) (mint) background
            while active — no mint literal. */}
        <div className="icon-col-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={toggleSelectMode}
            className={
              selectMode
                ? "bg-[var(--app-accent)] text-[var(--app-bg)] hover:bg-[var(--app-accent)] hover:text-[var(--app-bg)]"
                : "text-[var(--app-hint)]"
            }
            title={selectMode ? "Exit Select Mode" : "Select sessions"}
            aria-label={selectMode ? "Exit Select Mode" : "Select sessions"}
            aria-pressed={selectMode}
          >
            <SelectIcon className="h-5 w-5" />
          </Button>
        </div>
        {/* New Session — col-1 (rightmost). Production presentation, kept by the
            E8/E9 mockups (`.createbtn`) and the operator's standing ruling
            (2026-09-06, restated 2026-09-07): a WHITE (+) glyph inside an
            ALWAYS-ON accent-colored ring — var(--app-accent) is the runtime
            accent, mint by default. The empty-state pulse (create-ring-pulse)
            animates that same ring when there are no sessions. #3292's bare
            mint glyph was a regression; do not reintroduce it. */}
        <div className="icon-col-1">
          <button
            type="button"
            onClick={() =>
              isSplit && pane
                ? setPaneView(pane, { type: "new-session" })
                : navigate({ to: "/sessions/new" })
            }
            // NB: keep the space before `${` — Tailwind's scanner drops a class
            // candidate that is glued to a template expression, and the bare
            // `border-[var(--app-accent)]` utility is emitted from THIS line only
            // (verified 2026-09-07: without the space the ring never compiled).
            className={`session-list-new-button p-1.5 rounded-full text-[var(--app-fg)] transition-colors border-[1.5px] border-[var(--app-accent)] ${
              !isLoading && sessions.length === 0 ? "create-ring-pulse" : ""
            }`}
            title="New Session"
            aria-label="Create new session"
          >
            <PlusIcon className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );

  // Select-Mode Chip Row (#3292) — ephemeral bulk-action bar rendered below the
  // Control Bar in every pane while Select Mode is active (`false` renders nothing).
  const chipRow = selectMode ? (
    <SelectModeChipRow
      sessions={sessions}
      selectedIds={selectedIds}
      api={api}
      onSelectAll={selectAll}
      onSelectNone={selectNone}
      onExit={exitSelectMode}
      onRefresh={handleRefresh}
    />
  ) : null;

  return (
    // `chip-scope` (tokens.css "Chip surfaces") — round 14 follow-up: inside the
    // session list every chip surface that mixes against --chip-base becomes
    // OPAQUE, so a tinted row (managed-peer gold, scheduled blue) can no longer
    // bleed through the idle pill / node badge / counters / account chip. #4553:
    // a class, not an inline `[--chip-base:…]`, because the chip TOKENS must be
    // re-declared on this element too for their var(--chip-base) to resolve here.
    <div className="chip-scope relative flex h-full flex-col">
      <div
        ref={listScrollRef}
        className={`flex-1 ${
          isSplit
            ? "flex flex-col min-h-0"
            : controlBarPosition === "bottom"
              ? "flex flex-col overflow-y-auto scrollbar-none"
              : "overflow-y-auto scrollbar-none"
        } bg-[var(--app-bg)]`}
      >
        {/* Toolbar (non-split): sticky at the top by default. When the
            control-bar position pref is "bottom" it renders in the mt-auto
            sticky-bottom wrapper below instead (#3276). */}
        {!isSplit && controlBarPosition === "top" && (
          <div className="sticky top-0 z-30 bg-[var(--app-bg)]">
            {renderPaneToolbar()}
            {chipRow}
          </div>
        )}
        {error ? (
          <div className="mx-auto w-full max-w-content px-3 py-2">
            <div className="text-sm text-red-600">{error}</div>
          </div>
        ) : null}
        {/* Pane container — single scroll when not split, dual independent scroll when split */}
        <div className={isSplit ? "relative flex flex-1 min-h-0" : ""}>
          {/* Pane A (primary — persisted expand/collapse state) */}
          <div
            ref={paneAScrollRef}
            className={
              isSplit
                ? "flex flex-col flex-1 min-w-0 overflow-y-auto scrollbar-none bg-[var(--app-bg)]"
                : ""
            }
          >
            {/* Per-pane toolbar (top): only when pane is displaying the list and
                the control-bar position pref is "top" (#3276). */}
            {isSplit &&
              paneAView.type === "list" &&
              controlBarPosition === "top" && (
                <>
                  {renderPaneToolbar("A")}
                  {chipRow}
                </>
              )}
            {paneAView.type !== "list" && isSplit && api ? (
              <SplitPaneContentView
                view={paneAView}
                api={api}
                onBack={() => setPaneView("A", { type: "list" })}
                onNavigate={v => setPaneView("A", v)}
              />
            ) : (
              <SessionList
                sessions={sessions}
                localNodeId={localNode?.nodeId ?? LOCAL_NODE_ID}
                onSelect={sessionId =>
                  isSplit
                    ? setPaneView("A", { type: "session", sessionId })
                    : navigate({
                        to: "/sessions/$sessionId",
                        params: { sessionId },
                      })
                }
                onNewSession={() =>
                  isSplit
                    ? setPaneView("A", { type: "new-session" })
                    : navigate({ to: "/sessions/new" })
                }
                onRefresh={handleRefresh}
                isLoading={isLoading}
                api={api}
                liftedGroups={groups}
                liftedProjectExpandState={projectExpandState}
                liftedSetProjectExpanded={setProjectExpanded}
                liftedExpandedSessions={expandedSessions}
                liftedToggleSessionExpanded={toggleSessionExpanded}
                liftedManualActive={manualActive}
                liftedSetManualActive={setManualActive}
                selectMode={selectMode}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                schedules={schedules}
                heartbeatConfig={heartbeatConfig}
                heartbeatStatus={heartbeatStatus}
                filterView={filterView}
                onEditSchedule={handleEditSchedule}
                onEditHeartbeat={handleEditHeartbeat}
                onCreateSchedule={handleCreateSchedule}
                initialScheduleId={searchScheduleId}
              />
            )}
            {/* Per-pane toolbar (bottom): pinned above the footer when the pref
                is "bottom" (#3276). The pane container is already flex flex-col
                overflow-y-auto, so the mt-auto wrapper alone pins it. */}
            {isSplit &&
              paneAView.type === "list" &&
              controlBarPosition === "bottom" && (
                <div className="mt-auto sticky bottom-0 z-30 bg-[var(--app-bg)]">
                  {renderPaneToolbar("A")}
                  {chipRow}
                </div>
              )}
          </div>
          {isSplit && (
            <>
              <div className="w-px bg-[var(--app-border)] shrink-0" />
              {/* Pane B (secondary — non-persisting expand/collapse state) */}
              <div
                ref={paneBScrollRef}
                className="flex flex-col flex-1 min-w-0 overflow-y-auto scrollbar-none bg-[var(--app-bg)]"
              >
                {paneBView.type === "list" && controlBarPosition === "top" && (
                  <>
                    {renderPaneToolbar("B")}
                    {chipRow}
                  </>
                )}
                {paneBView.type !== "list" && api ? (
                  <SplitPaneContentView
                    view={paneBView}
                    api={api}
                    onBack={() => setPaneView("B", { type: "list" })}
                    onNavigate={v => setPaneView("B", v)}
                  />
                ) : (
                  <SessionList
                    sessions={sessions}
                    localNodeId={localNode?.nodeId ?? LOCAL_NODE_ID}
                    onSelect={sessionId =>
                      setPaneView("B", { type: "session", sessionId })
                    }
                    onNewSession={() =>
                      setPaneView("B", { type: "new-session" })
                    }
                    onRefresh={handleRefresh}
                    isLoading={isLoading}
                    api={api}
                    liftedGroups={groups}
                    liftedProjectExpandState={paneBProjectExpand}
                    liftedSetProjectExpanded={setPaneBProjectExpandFn}
                    liftedExpandedSessions={paneBExpandedSessions}
                    liftedToggleSessionExpanded={togglePaneBSessionExpanded}
                    liftedManualActive={manualActive}
                    liftedSetManualActive={setManualActive}
                    selectMode={selectMode}
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                    schedules={schedules}
                    heartbeatConfig={heartbeatConfig}
                    heartbeatStatus={heartbeatStatus}
                    filterView={filterView}
                    onEditSchedule={handleEditSchedule}
                    onEditHeartbeat={handleEditHeartbeat}
                    onCreateSchedule={handleCreateSchedule}
                  />
                )}
                {/* Per-pane toolbar (bottom): pinned above the footer when the
                    pref is "bottom" (#3276). */}
                {paneBView.type === "list" &&
                  controlBarPosition === "bottom" && (
                    <div className="mt-auto sticky bottom-0 z-30 bg-[var(--app-bg)]">
                      {renderPaneToolbar("B")}
                      {chipRow}
                    </div>
                  )}
              </div>
            </>
          )}
          {/* Round 14: one position rail per split pane (each overlays its own
              pane's right edge; renders nothing while a pane does not overflow). */}
          {isSplit && (
            <>
              <ScrollPositionRail scrollRef={paneAScrollRef} />
              <ScrollPositionRail scrollRef={paneBScrollRef} />
            </>
          )}
        </div>
        {/* Toolbar (non-split): rendered at the bottom, pinned just above the
            shell footer, when the control-bar position pref is "bottom" (#3276).
            mt-auto pins it when the list is shorter than the scrollport; sticky
            bottom-0 keeps it pinned once the list overflows. */}
        {!isSplit && controlBarPosition === "bottom" && (
          <div className="mt-auto sticky bottom-0 z-30 bg-[var(--app-bg)]">
            {renderPaneToolbar()}
            {chipRow}
          </div>
        )}
      </div>
      {/* Round 14: the single-list position rail (overlays the scroll div above;
          renders nothing in split view, where the panes carry their own). */}
      <ScrollPositionRail scrollRef={listScrollRef} />

      {/* Schedule edit dialog — fullscreen overlay with ScheduleForm */}
      <Dialog
        open={editingSchedule !== null}
        onOpenChange={open => {
          if (!open) setEditingSchedule(null);
        }}
      >
        <DialogContent fullscreen className="flex flex-col overflow-y-auto">
          <DialogTitle className="sr-only">Edit schedule</DialogTitle>
          <DialogDescription className="sr-only">
            Edit settings for the selected schedule.
          </DialogDescription>
          {editingSchedule && (
            <ScheduleForm
              api={api}
              existing={editingSchedule}
              onBack={() => setEditingSchedule(null)}
              onSaved={() => setEditingSchedule(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Heartbeat edit dialog — fullscreen overlay with HeartbeatSettings */}
      <Dialog
        open={editingHeartbeat}
        onOpenChange={open => {
          if (!open) setEditingHeartbeat(false);
        }}
      >
        <DialogContent fullscreen className="flex flex-col overflow-y-auto">
          <DialogTitle className="sr-only">Edit Heartbeat</DialogTitle>
          <DialogDescription className="sr-only">
            Configure heartbeat monitoring settings.
          </DialogDescription>
          <div className="flex flex-col gap-4 p-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEditingHeartbeat(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)]"
              >
                <BackIcon className="h-5 w-5" />
              </button>
              <h2 className="flex-1 truncate text-base font-semibold text-[var(--app-fg)]">
                Edit Heartbeat
              </h2>
            </div>
            {api && <HeartbeatSettings api={api} />}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SessionPage() {
  const { api } = useAppContext();
  const goBack = useAppGoBack();
  const { sessionId } = useParams({ from: "/sessions/$sessionId" });
  const {
    session,
    messageCount,
    isLoading: sessionLoading,
    refetch: refetchSession,
  } = useSession(api, sessionId, true); // isActiveSession=true enables polling fallback for timer
  const { localNode } = useFederatedSessions(api);
  const {
    messages,
    warning: messagesWarning,
    isLoading: messagesLoading,
    isLoadingMore: messagesLoadingMore,
    hasMore: messagesHasMore,
    loadMore: loadMoreMessages,
    refetch: refetchMessages,
  } = useMessages(api, sessionId);
  const { parentMessages, isLoading: parentMessagesLoading } =
    useParentMessages(api, session?.parentSessionId);
  const { sendMessage, retryMessage, isSending } = useSendMessage(
    api,
    sessionId
  );

  // Track "needs review" state - mark session as seen ONLY on explicit user interaction
  const { markAsSeen, checkNeedsReview } = useNeedsReview();

  // Optimistic mutation for needs-review override (emoji, read/unread)
  const { setNeedsReviewOverride } = useSessionActions(api, sessionId ?? null);

  // Calculate if session needs review
  const needsReview = session
    ? checkNeedsReview(
        session.id,
        session.updatedAt,
        session.active,
        session.thinking,
        session.needsReviewOverride as "read" | "unread" | null | undefined
      )
    : false;

  // Callback for compose field focus — clears "needs review" indicator (#279).
  // Passed through SessionChat → HappyComposer → ComposerPrimitive.Input onFocus.
  // On desktop, autoFocus fires this on navigation (acceptable: user navigated intentionally).
  // On mobile/touch, autoFocus is disabled so user must tap compose field to clear.
  const onComposeFocus = useCallback(() => {
    if (session) {
      markAsSeen(session.id, session.updatedAt);
      // Clear any manual override — composing means user is actively reading
      if (session.needsReviewOverride) {
        void setNeedsReviewOverride(null);
      }
    }
  }, [session, markAsSeen, setNeedsReviewOverride]);

  // Compute isWaitingForUserQuestion from agentState (matches SessionHeader pattern)
  const isWaitingForUserQuestion = session
    ? checkIsWaitingForUserQuestion(session.agentState)
    : false;
  // effectiveThinking: not truly "thinking" if blocked on user input
  const effectiveThinking = session
    ? session.thinking && !isWaitingForUserQuestion
    : false;

  // Dynamic document title and favicon based on session state
  // Order matches session row: [favicon: status] [title: session emoji + name]
  const sessionTitle = session ? getSessionTitle(session) : null;
  const sessionEmoji = session?.emoji ? `${session.emoji} ` : "";
  const statusEmoji = session
    ? getStatusEmoji(
        session.active,
        effectiveThinking,
        needsReview,
        session.recoveryStatus as RecoveryStatus | undefined,
        isWaitingForUserQuestion
      )
    : null;
  const documentTitle = sessionTitle
    ? `${sessionEmoji}${sessionTitle} - Hapimatic`
    : "Hapimatic";
  useDocumentTitle(documentTitle);

  // Dynamic favicon shows status indicator (matches session row order)
  useEmojiFavicon(statusEmoji);

  // Get agent type from session metadata for slash commands
  const agentType = session?.metadata?.flavor ?? "claude";
  const { getSuggestions: getSlashSuggestions } = useSlashCommands(
    api,
    sessionId,
    agentType
  );

  const onToggleReadStatus = useCallback(
    (action: "read" | "unread") => {
      if (session) {
        void setNeedsReviewOverride(action);
      }
    },
    [session, setNeedsReviewOverride]
  );

  const refreshSelectedSession = useCallback(() => {
    void refetchSession();
    void refetchMessages();
  }, [refetchMessages, refetchSession]);

  // Self-heal (#1257): if the persisted deep link resolved to a session that no
  // longer exists, clear the lastRoute key so the next cold start doesn't
  // re-trap the user on this not-found view. Gated on a definitively-failed
  // load (!sessionLoading && !session) — a bare-[] effect would also clear the
  // key on successful loads and defeat the iOS PWA route persistence (#518).
  useEffect(() => {
    if (!sessionLoading && !session) {
      clearLastRoute();
    }
  }, [sessionLoading, session]);

  if (!session) {
    // Still loading — show spinner
    if (sessionLoading) {
      return (
        <div className="flex-1 flex items-center justify-center p-4">
          <LoadingState label="Loading session…" className="text-sm" />
        </div>
      );
    }
    // Load finished but session doesn't exist — show not-found UI
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-4 gap-3">
        <p className="text-sm text-[var(--app-fg)]/60">Session not found</p>
        <button
          type="button"
          onClick={goBack}
          className="text-sm text-[var(--app-link)] hover:underline"
        >
          Back to sessions
        </button>
      </div>
    );
  }

  return (
    <SessionChat
      api={api}
      session={session}
      messages={messages}
      parentMessages={parentMessages}
      isLoadingParentMessages={parentMessagesLoading}
      messagesWarning={messagesWarning}
      hasMoreMessages={messagesHasMore}
      isLoadingMessages={messagesLoading}
      isLoadingMoreMessages={messagesLoadingMore}
      isSending={isSending}
      onBack={goBack}
      onRefresh={refreshSelectedSession}
      onLoadMore={loadMoreMessages}
      onSend={sendMessage}
      onRetryMessage={retryMessage}
      autocompleteSuggestions={getSlashSuggestions}
      onComposeFocus={onComposeFocus}
      needsReview={needsReview}
      onToggleReadStatus={onToggleReadStatus}
      serverMessageCount={messageCount}
      nodeId={session.nodeId ?? localNode?.nodeId}
      nodeLabel={session.nodeLabel ?? localNode?.nodeLabel}
      nodeUrl={session.nodeUrl}
      nodeStatus={session.nodeStatus}
    />
  );
}

function NewSessionPage() {
  const { api } = useAppContext();
  const navigate = useNavigate();
  // #3132: respawn pre-fill from a capability-miss offer (optional; absent on a
  // normal Create navigation).
  const { agent: initialAgent, pendingSkill } = newSessionRoute.useSearch();
  const newSessionRef = useRef<NewSessionHandle>(null);
  const [expandState, setExpandState] = useState<ExpandState>("none");
  const queryClient = useQueryClient();
  const {
    machines,
    isLoading: machinesLoading,
    error: machinesError,
  } = useMachines(api, true);
  const { remoteNodes, remoteSessions, localNode } = useFederatedSessions(api);
  const { showToast } = useToast();

  // Enrich remote nodes with connected/disconnected counts from session data
  const enrichedRemoteNodes = useMemo(() => {
    return remoteNodes.map(node => {
      const nodeSessions = remoteSessions.filter(s => s.nodeId === node.nodeId);
      return {
        ...node,
        connectedCount: nodeSessions.filter(s => s.active).length,
        disconnectedCount: nodeSessions.filter(s => !s.active).length,
      };
    });
  }, [remoteNodes, remoteSessions]);

  const handleCancel = useCallback(() => {
    navigate({ to: "/sessions" });
  }, [navigate]);

  const handleSuccess = useCallback(
    (sessionId: string, isRemote: boolean) => {
      // Query invalidation is handled by useSpawnSession.onSuccess —
      // avoid double-invalidating which evicts optimistic cache data.
      if (!isRemote) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      }

      // Remote spawns are fire-and-forget — the node returns before the
      // session exists, so sessionId is empty.  Navigate to the session
      // list where the pending spawn stub provides instant visual feedback.
      if (!sessionId) {
        showToast("Session is being created on the remote node…", {
          type: "success",
        });
        navigate({ to: "/sessions", replace: true });
        return;
      }

      if (isRemote) {
        showToast("Session created on remote node", { type: "success" });
      }

      navigate({
        to: "/sessions/$sessionId",
        params: { sessionId },
        replace: true,
      });
    },
    [navigate, queryClient, showToast]
  );

  const handleScheduleCreated = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
    navigate({
      to: "/sessions",
      search: { view: "schedules" as const },
      replace: true,
    });
  }, [queryClient, navigate]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* pr-0 puts the master expand/collapse-all chevron's center at the same
        16px-from-edge as the per-section chevrons. With the scroll bar hidden
        (no width reserved), both the header and the sections span the full
        width, so the chevrons line up with no scrollbar-gutter mechanism. */}
      <div className="mx-auto w-full max-w-content flex shrink-0 items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-bg)] py-1.5 pl-3 pr-0">
        {/* Page-identity icon (replaces the redundant in-page back button — the
          app bar already provides Back for this route). */}
        <span
          className="grid h-8 w-8 place-items-center text-[var(--app-link)]"
          aria-hidden="true"
        >
          <svg
            className="h-5 w-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v8M8 12h8" />
          </svg>
        </span>
        <div className="flex-1 font-semibold">Create</div>
        <button
          type="button"
          onClick={() => newSessionRef.current?.toggleAll()}
          title="Expand / collapse all sections"
          aria-label="Expand or collapse all sections"
          className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
        >
          {expandState === "mixed" ? (
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m7 9 5-5 5 5M7 15l5 5 5-5" />
            </svg>
          ) : (
            <ChevronIcon
              className="h-4 w-4"
              collapsed={expandState === "none"}
            />
          )}
        </button>
      </div>

      {machinesError ? (
        <div className="mx-auto w-full max-w-content shrink-0 p-3 text-sm text-red-600">
          {machinesError}
        </div>
      ) : null}

      <div className="mx-auto flex min-h-0 w-full max-w-content flex-1 flex-col">
        <NewSession
          ref={newSessionRef}
          onExpandStateChange={setExpandState}
          api={api}
          machines={machines}
          remoteNodes={enrichedRemoteNodes}
          localNode={localNode}
          isLoading={machinesLoading}
          onCancel={handleCancel}
          onSuccess={handleSuccess}
          onScheduleCreated={handleScheduleCreated}
          initialAgent={initialAgent}
          pendingSkill={pendingSkill}
        />
      </div>
    </div>
  );
}

/**
 * Admin-drawer overlay search param (#1036; trimmed in #1935). Declared on the ROOT
 * route so the `?drawer=settings` navigation type-checks across the app. The key MUST be
 * declared OPTIONAL via this explicit return type — without it, TanStack infers it as a
 * REQUIRED search param and propagates that requirement to every route's navigations
 * (`MakeRequiredSearchParams`), breaking app-wide `navigate({ to: "/x" })` calls. Mirrors
 * the optional-key pattern used by `sessionsRoute`'s `validateSearch`.
 *
 * #1935 removed the `section` and `nodeId` keys: the admin sections were promoted from
 * in-drawer `?section=`/`?nodeId=` overlays to their own `/settings/*` routes, so the drawer
 * is now a pure menu toggled solely by `?drawer=settings`.
 */
type DrawerSearch = {
  drawer?: string;
};

// #3286 (View Picker): drive the open-redirect reconcile on every navigation, so
// the one-shot redirect flag clears when the user leaves a session (a genuine
// reopen then redirects again; Back never re-loops). Wraps App at the router root.
function RootRouteComponent() {
  const pathname = useLocation({ select: location => location.pathname });
  useEffect(() => {
    reconcileSessionViewOpenRedirects(pathname);
  }, [pathname]);
  return <App />;
}

const rootRoute = createRootRoute({
  component: RootRouteComponent,
  // Catch any URL that no route in the tree resolves (e.g. a persisted but
  // structurally malformed deep link on iOS PWA cold start). Renders inside
  // App's BrandedFrame chrome via <Outlet /> with an in-app escape. (#1257)
  notFoundComponent: () => <NotFoundPage />,
  validateSearch: (search: Record<string, unknown>): DrawerSearch => ({
    drawer: typeof search.drawer === "string" ? search.drawer : undefined,
  }),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => <Navigate to="/sessions" replace />,
});

type SessionsSearch = {
  view?: FilterView;
  scheduleId?: string;
};

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions",
  component: SessionsPage,
  validateSearch: (search: Record<string, unknown>): SessionsSearch => {
    const view = search.view;
    const validViews: FilterView[] = ["all", "sessions", "schedules"];
    return {
      view:
        typeof view === "string" && validViews.includes(view as FilterView)
          ? (view as FilterView)
          : undefined,
      scheduleId:
        typeof search.scheduleId === "string" ? search.scheduleId : undefined,
    };
  },
});

/**
 * Issue #3515: the `/sessions/$sessionId` component switch. During the
 * optimistic-create window the route param is a placeholder TAG (the pre-
 * generated `hapiSessionId`, finding 3515-1) that `useSession`/`GET /sessions/:id`
 * would 404 — so when this route param is a `spawning`/`failed` placeholder row
 * OR carries an active client-side handover (this tab optimistically created it),
 * render `SpawningSessionView` instead of `SessionPage`. SpawningSessionView owns
 * the placeholder composer and the swap/failure navigation.
 *
 * This structurally gates SessionPage's #1257 self-heal (`clearLastRoute` on a
 * not-found session): SessionPage never renders for a placeholder, so its
 * self-heal only ever sees a genuinely-missing session, exactly as intended.
 */
function SessionRouteComponent() {
  const { api } = useAppContext();
  const navigate = useNavigate();
  const { sessionId } = useParams({ from: "/sessions/$sessionId" });
  const { sessions } = useSessions(api);
  const handoverActive = useSpawnHandoverActive(sessionId);

  const placeholder = sessions.find(
    s =>
      s.id === sessionId &&
      (s.lifecycleState === "spawning" || s.lifecycleState === "failed")
  );
  // The real row materialised under the shared tag (a fresh uuid id). Keep
  // SpawningSessionView mounted through this window too: the route param is only
  // ever a TAG during an optimistic create (or a deliberate tag deep-link), and
  // SpawningSessionView's swap effect navigates to the uuid. Without this, the
  // instant the handover clears (before the replace-navigation lands) the switch
  // would fall through to SessionPage(tag) → useSession/useMessages(tag) 404s.
  const materializedUnderTag = sessions.some(
    s => s.tag === sessionId && s.id !== sessionId
  );

  if (placeholder || handoverActive || materializedUnderTag) {
    return (
      <SpawningSessionView
        api={api}
        placeholderId={sessionId}
        onFailureBack={() =>
          void navigate({ to: "/sessions/new", replace: true })
        }
      />
    );
  }
  return <SessionPage />;
}

const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$sessionId",
  // Issue #3516: guard against re-entering a mid-delete session from a stale link.
  // Keyed on isActionPending(id, "delete") ONLY (K12) — a #3515 `spawning`
  // placeholder is also absent from the cache but is NOT delete-pending, so it is
  // untouched. The mark is cleared by the delete mutation's onSettled (+ 90s TTL),
  // after which the not-found UI handles a genuinely-stale link.
  beforeLoad: ({ params }) => {
    if (isActionPending(params.sessionId, "delete")) {
      throw redirect({ to: "/sessions", replace: true });
    }
  },
  component: SessionRouteComponent,
});

const sessionFilesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$sessionId/files",
  component: FilesPage,
});

const sessionTerminalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$sessionId/terminal",
  component: TerminalPage,
});

const sessionDesktopRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$sessionId/desktop",
  component: DesktopPage,
});

const sessionClaudePtyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$sessionId/claude-pty",
  component: ClaudePtyPage,
});

type SessionFileSearch = {
  path: string;
  staged?: boolean;
};

const sessionFileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$sessionId/file",
  validateSearch: (search: Record<string, unknown>): SessionFileSearch => {
    const path = typeof search.path === "string" ? search.path : "";
    const staged =
      search.staged === true || search.staged === "true"
        ? true
        : search.staged === false || search.staged === "false"
          ? false
          : undefined;

    return staged === undefined ? { path } : { path, staged };
  },
  component: FilePage,
});

/**
 * #3132: respawn pre-fill search params. A capability-miss offer's "respawn"
 * navigates to `/sessions/new?agent=<capable>&pendingSkill=<skill>`. Both keys
 * are OPTIONAL (a normal Create navigation carries neither) — declared via the
 * explicit return type so TanStack does not infer them as REQUIRED app-wide
 * (the optional-key pattern `sessionsRoute`'s `validateSearch` uses).
 */
type NewSessionSearch = {
  agent?: AgentType;
  pendingSkill?: string;
};

const AGENT_TYPES: readonly AgentType[] = [
  "claude",
  "codex",
  "gemini",
  "opencode",
];

const newSessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/new",
  component: NewSessionPage,
  validateSearch: (search: Record<string, unknown>): NewSessionSearch => {
    const agent = AGENT_TYPES.includes(search.agent as AgentType)
      ? (search.agent as AgentType)
      : undefined;
    const pendingSkill =
      typeof search.pendingSkill === "string" && search.pendingSkill.length > 0
        ? search.pendingSkill
        : undefined;
    return {
      ...(agent ? { agent } : {}),
      ...(pendingSkill ? { pendingSkill } : {}),
    };
  },
});

const errorLogsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/error-logs",
  component: ErrorLogsPage,
});

const extensionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/extensions",
  component: ExtensionMarketplacePage,
});

function AnalyticsRoutePage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-[var(--app-muted)]">
          Loading analytics...
        </div>
      }
    >
      <LazyAnalyticsPage />
    </Suspense>
  );
}

// #2745 feedback round: Analytics + Account Usage are Settings-menu pages, so
// they live under /settings/* like every other settings page (#2765's rule).
// Legacy top-level paths redirect in legacyAdminRedirects.tsx.
const analyticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/analytics",
  component: AnalyticsRoutePage,
});

const accountUsageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/account-usage",
  component: AccountUsagePage,
});

// Admin sections promoted to their own routes (#1935). Each is a FLAT child of the
// root route (no `/admin` parent layout, so there is no `/admin` <Outlet /> that could
// double-render the page — see the #1035 double-render history in SettingsDrawer.tsx).
const settingsFederationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/federation",
  component: FederationDashboard,
});

// Per-node federation detail — the nested route mirrors the closed #1444 design.
// Reads the `$nodeId` path param (was a `?nodeId=` search param pre-#1935).
function AdminFederationNodeRoutePage() {
  const { nodeId } = useParams({ from: "/settings/federation/$nodeId" });
  return <NodeDetailView nodeId={nodeId} />;
}

const settingsFederationNodeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/federation/$nodeId",
  component: AdminFederationNodeRoutePage,
});

// Issue #2453: `?highlight=<lc-id>` (deep-link a loop-cron card) and
// `?session=<uuid>` (filter to a session's loops). Issue #3291 (S6): `?kind=`
// (a transient per-navigation Kind pre-filter — the Loop-Cron Modal's "Open in
// System Jobs" deep link lands pre-filtered to Loop-Crons; the page applies it as
// an override that NEVER writes the persisted `prefs.filters.kind`). Scoped to
// this route — the app-wide-required-param concern (root route) does NOT apply,
// and TanStack search params inherit parent→child only. All keys are declared
// OPTIONAL via the explicit return type (the DrawerSearch optional-key pattern).
const SYSTEM_JOB_KINDS: readonly SystemJobKind[] = [
  "systemd-timer",
  "in-process-loop",
  "os-cron",
  "loop-cron",
  "scheduled-session",
];
type AdminSystemJobsSearch = {
  highlight?: string;
  session?: string;
  kind?: SystemJobKind;
};

const settingsSystemJobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/system-jobs",
  component: AdminSystemJobsPage,
  validateSearch: (search: Record<string, unknown>): AdminSystemJobsSearch => ({
    highlight:
      typeof search.highlight === "string" ? search.highlight : undefined,
    session: typeof search.session === "string" ? search.session : undefined,
    kind: SYSTEM_JOB_KINDS.includes(search.kind as SystemJobKind)
      ? (search.kind as SystemJobKind)
      : undefined,
  }),
});

const settingsFileConflictsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/file-conflicts",
  component: AdminFileConflictsPage,
});

const settingsTimeLogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/time-log",
  component: TimeLogPage,
});

const settingsSessionMetadataRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/session-metadata",
  component: SessionMetadataPage,
});

// Transcript browser (issue #3839). Registered here AND as a settings nav row
// (settings/index.tsx) — an unregistered route is an invisible page (#2344).
const settingsTranscriptsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/transcripts",
  component: TranscriptsPage,
});

// Admin Feedback viewer (issue #2666, epic #2663 Sub C). Registered here AND as
// an ADMIN_SECTIONS row (admin/index.tsx) — an unregistered route is an
// invisible page (#2344).
const settingsFeedbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/feedback",
  component: AdminFeedbackPage,
});

const settingsPreferencesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/preferences",
  component: AdminPreferencesPage,
});

const settingsAboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/about",
  component: AdminAboutPage,
});

// Keys — the provider API-key vault (#1955) + the per-VM backup age identity
// (#2507) folded onto one page by the Settings sidebar reorganization. The
// sidebar's nested rows deep-link to its `#api-keys` / `#backup-key` anchors.
const settingsKeysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/keys",
  component: AdminKeysPage,
});

// Extension control plane (issue #2329, epic #2325). Distinct from `/extensions`,
// which is the community marketplace (browse + install); this page manages what is
// already composed into the build.
const settingsExtensionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/extensions",
  component: ExtensionsAdminPage,
});

// Configuration Porter — Admin → Configuration (issue #2344, epic #2339 Sub E).
// The single import-UI implementation; the onboarding wizard stage deep-links
// here rather than duplicating the form.
const settingsConfigurationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/configuration",
  component: ConfigurationAdminPage,
});

// Admin VM provisioning — Admin → VMs (issue #2470, epic #2467 Sub C). Fleet
// inventory, New VM form, live job log, two-step deprovision. Registered here AND
// as an ADMIN_SECTIONS row (admin/index.tsx) — an unregistered route is an
// invisible page (#2344).
const settingsVmsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/vms",
  component: AdminVmsPage,
});

// Harness Scorecard (issue #3128, epic #3117 Sub N). Also a SYSTEM settings row
// (settings/index.tsx) — an unregistered route is an invisible page (#2344).
const settingsHarnessScorecardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/harness-scorecard",
  component: HarnessScorecardPage,
});

// Harness Updates — Admin → Harness Updates (issue #1773, epic #1769 Sub-Issue D).
// The color-coded self-update impact panel. Registered here AND as an ADMIN_SECTIONS
// row (settings/index.tsx) — an unregistered route is an invisible page (#2344).
const settingsHarnessUpdatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/harness-updates",
  component: AdminHarnessUpdatesPage,
});

// Capabilities — Settings → Capabilities (issue #3752, epic #3740 Sub-Issue L).
// The read-only capability panel: coverage, catalog, drift, availability.
// Registered here AND as an ADMIN_SECTIONS row (settings/index.tsx) — an
// unregistered route is an invisible page (#2344).
const settingsCapabilitiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/capabilities",
  component: CapabilitiesPanel,
});

// #2765: permanent /admin/* -> /settings/* redirects (legacy deep links / PWA shortcuts).
const legacyAdminRedirects = makeLegacyAdminRedirects(rootRoute);

// Dev-only component catalog / pattern lab (#3036, epic #3028). `import.meta.env.DEV`
// is statically replaced by Vite at build time (`false` in production), so this whole
// branch is dead-code-eliminated in a prod build: the `/design` route and its lazily-
// imported catalog chunk are tree-shaken out — measured prod bundle delta ~0. Mirrors
// the `import.meta.env.DEV` dev-gate precedent at web/src/design/tokens.ts:132. Access
// control IS this exclusion (the catalog is never production-reachable). See
// docs/design/design-system/catalog.md.
const designRoutes = import.meta.env.DEV ? makeDesignRoutes(rootRoute) : [];

export const routeTree = rootRoute.addChildren([
  indexRoute,
  sessionsRoute,
  sessionRoute,
  sessionTerminalRoute,
  sessionDesktopRoute,
  sessionClaudePtyRoute,
  sessionFilesRoute,
  sessionFileRoute,
  newSessionRoute,
  errorLogsRoute,
  extensionsRoute,
  analyticsRoute,
  accountUsageRoute,
  settingsFederationRoute,
  settingsFederationNodeRoute,
  settingsSystemJobsRoute,
  settingsFileConflictsRoute,
  settingsTimeLogRoute,
  settingsSessionMetadataRoute,
  settingsTranscriptsRoute,
  settingsFeedbackRoute,
  settingsPreferencesRoute,
  settingsAboutRoute,
  settingsKeysRoute,
  settingsExtensionsRoute,
  settingsConfigurationRoute,
  settingsVmsRoute,
  settingsHarnessScorecardRoute,
  settingsHarnessUpdatesRoute,
  settingsCapabilitiesRoute,
  ...designRoutes,
  ...legacyAdminRedirects,
]);

/** One entry in the flat UI route manifest (issue #3744, Sub-Issue D / Task 9). */
export interface UiRouteEntry {
  path: string;
}

/**
 * A flat, de-duplicated, sorted `{ path }` view of the router's route manifest —
 * the SHAPE CONTRACT the capability audit's `ui` surface reconciles against (issue
 * #3744, Sub-Issue D / R2 / Task 9). D does NOT consume this at runtime (`server/`
 * and `cli/` cannot import `web/`); it is defined HERE, once, so #3752's Task 5
 * (which redundantly claims the same deliverable) cannot diverge from it. Derived
 * by WALKING the TanStack tree — never a hand-authored list — so it survives
 * lazy / code-split route definitions (#3098). The walker is shape-defensive
 * (`.path` or `.options.path`; array- or record-valued `.children`) so a TanStack
 * internal-shape change degrades gracefully rather than throwing.
 */
export function listUiRoutes(): UiRouteEntry[] {
  // Build the router so `routesByPath` (keyed by FULL path) is populated: the raw
  // route tree exposes only relative path SEGMENTS (`account-usage`, `/`), so the
  // built router is the reliable source of full paths (`/settings/account-usage`).
  // It survives lazy/code-split routes (#3098) — a route's DEFINITION is eager even
  // when its component is `React.lazy`. Mirrors `router.test.tsx`'s
  // `registeredPaths()`; memory history keeps it environment-agnostic (no `window`).
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: ["/"] })
  ) as unknown as {
    routesByPath?: Record<string, unknown>;
    flatRoutes?: ReadonlyArray<{ fullPath?: string }>;
  };
  const rawPaths = router.routesByPath
    ? Object.keys(router.routesByPath)
    : (router.flatRoutes ?? []).map(r => r.fullPath ?? "");
  const paths = new Set(rawPaths.filter(p => p.length > 0));
  return [...paths]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map(path => ({ path }));
}

type RouterHistory = Parameters<typeof createRouter>[0]["history"];

export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
