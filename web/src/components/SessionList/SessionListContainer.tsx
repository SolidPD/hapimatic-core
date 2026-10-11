// SPDX-License-Identifier: AGPL-3.0-only
// SessionListContainer — the SessionList container: queries, SSE-invalidated state,
// selection, grouping, and orchestration of the presentational SessionList modules.
// Extracted from SessionList.tsx (issue #2083, epic #2077 F) — verbatim move.
import type { ApiClient } from "@/api/client";
import { PendingSpawnItem } from "@/components/PendingSpawnItem";
import {
  HeartbeatListEntry,
  ScheduleListRow,
  useExpandedSchedules,
  useSchedulerSubheaderCollapsed,
  useSpawnedSessionsCollapsed,
} from "@/components/ScheduleListEntry";
import { useNeedsReview } from "@/hooks/useNeedsReview";
import { usePendingSpawns } from "@/hooks/usePendingSpawns";
import { pruneOrphanedSessions } from "@/lib/localStorageCleanup";
import { getSessionTitle, getStatusBreakdown } from "@/lib/sessionHelpers";
import type { PendingSpawn } from "@/lib/pending-spawns";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  HeartbeatConfig,
  HeartbeatStatus,
  ScheduledTask,
  SessionSummary,
} from "@/types/api";
import { SessionItem } from "./SessionItem";
import { ProjectHeader } from "./ProjectHeader";
import { SessionCountBadge } from "./SessionCountBadge";
import { SubheadingBar } from "./SubheadingBar";
import { SchedulerSubheader } from "./SchedulerSubheader";
import {
  groupSessionsByProject,
  getRepoDisplayName,
  getFolderDisplayName,
  makeDirGroupLookupKey,
} from "./grouping";
import type { SessionGroup, FilterView } from "./grouping";
import { LOCAL_NODE_ID } from "@hapi/protocol";
import { useProjectExpandState, useExpandedSessions } from "./expandState";
import {
  SortableListEntry,
  type SortableDragHandle,
} from "./SortableListEntry";
import {
  DRAG_ACTIVATION,
  GuardedPointerSensor,
  GuardedTouchSensor,
} from "./guardedDragSensors";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import {
  getStoredManualActive,
  persistManualActive,
  getStoredProjectOrder,
  persistProjectOrder,
  getStoredSessionOrder,
  persistSessionOrder,
  orderByCustom,
} from "@/lib/sessionListManualOrder";

/**
 * #2700 (epic #2698 F6): THE single definition of "scheduler-spawned session with a
 * schedule" — returns its `scheduleId`, or `undefined` for any other session. Every
 * scheduler-scope check in the list (the `scheduleId → sessions` lookup, the main-list
 * exclusion, and — once it lands — sibling #3172's delete prompt) keys on this one
 * expression so the scope can never drift between call sites.
 */
export function schedulerScheduleId(s: SessionSummary): string | undefined {
  const sid = s.metadata?.scheduleId;
  return s.metadata?.source === "scheduler" && sid ? sid : undefined;
}

/**
 * #2700: a scheduler-spawned session is excluded from the main list ONLY when its
 * schedule is present in `knownScheduleIds` (every schedule in `props.schedules` gets a
 * row — matched or synthetic group — in the "all" and "schedules" views, whose nested
 * list shows it; the "sessions" view renders no schedule rows, unchanged by #2700). An orphan
 * (its one-shot schedule self-deleted) is NOT excluded, so it re-homes into the main
 * list instead of becoming an invisible-but-alive ghost — the schedule-level analogue
 * of `treeSortSessions`' branch-orphan fallback in grouping.ts.
 */
export function isNestedUnderSchedule(
  s: SessionSummary,
  knownScheduleIds: ReadonlySet<string>
): boolean {
  const sid = schedulerScheduleId(s);
  return sid !== undefined && knownScheduleIds.has(sid);
}

/**
 * Build parent→children clusters for a group's sessions (issue #466). Extracted from the
 * inline render logic so the same clustering feeds BOTH the render loop and the reorder
 * root-id computation. Scheduler-spawned sessions nested under a known schedule row are
 * excluded (orphans re-home here, #2700); each cluster is `[root, ...children]` in
 * depth-first order, and `depth` maps every session id to its branch depth (0 = root)
 * for indentation.
 */
export function buildClusters(
  sessions: SessionSummary[],
  knownScheduleIds: ReadonlySet<string>,
  excludePeerIds?: ReadonlySet<string>
): {
  clusters: SessionSummary[][];
  depth: Map<string, number>;
} {
  const main = sessions.filter(
    s =>
      !isNestedUnderSchedule(s, knownScheduleIds) &&
      // #3265: cross-repo managed peers render in the "managed peers" subheading,
      // not as top-level clusters — exclude them here so they don't render twice.
      !excludePeerIds?.has(s.id)
  );
  const depth = new Map<string, number>();
  for (const s of main) {
    if (!s.parentSessionId) depth.set(s.id, 0);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of main) {
      if (
        s.parentSessionId &&
        !depth.has(s.id) &&
        depth.has(s.parentSessionId)
      ) {
        depth.set(s.id, depth.get(s.parentSessionId)! + 1);
        changed = true;
      }
    }
  }
  const clusters: SessionSummary[][] = [];
  let current: SessionSummary[] = [];
  for (const s of main) {
    const d = depth.get(s.id) ?? 0;
    if (d === 0) {
      if (current.length > 0) clusters.push(current);
      current = [s];
    } else {
      current.push(s);
    }
  }
  if (current.length > 0) clusters.push(current);
  return { clusters, depth };
}

/**
 * #3265: the ids of a group's cross-repo managed peers, passed to `buildClusters`
 * so they are excluded from the top-level cluster pass (they render in the
 * "managed peers" subheading instead). Shared across all three `buildClusters`
 * call sites (render, rootIdsInOrder, first-drag seed) so the exclusion stays
 * consistent everywhere the cluster layout is computed.
 */
function crossRepoPeerIds(group: SessionGroup): Set<string> {
  return new Set((group.crossRepoManagedPeers ?? []).map(p => p.id));
}

// ── Always-armed drag arming (issue #3114, extracted to guardedDragSensors #3537) ──
// `DRAG_ACTIVATION`, `GuardedPointerSensor` and `GuardedTouchSensor` now live in
// `./guardedDragSensors` (imported above) — a behaviour-preserving move so the Account
// Usage page (#3537) reuses the exact same press-and-hold physics + interactive-target
// veto shipped here for #3114. See that module for the sensor definitions.

// ── Managed-peer (spawn) + branch (mint) cluster chrome ──────────────────────
// Both mirror the scheduler cluster's THREE-element shape EXACTLY
// (SchedulerSubheader → ScheduleListRow → "scheduled peers" box), measured on
// prod 1.0.1088: one 4px dark rail on the OUTERMOST element only, a parent row
// that paints NO left border of its own, and a separate rounded hairline CARD
// nested inside the rail whose subheading + rows paint their own 4px light rail.
// Net: parent row = single-wide dark; child rows = dark + light side by side.
//
// RAIL: the ONLY darker-gold (--session-rel-spawn-parent) band, full cluster
// height. `[&_.session-list-item]:border-l-0` strips the PM parent row's own
// border-l-4 so the rail never doubles up on the parent (the #3440 bug was an
// un-stripped parent row stacking a second 4px dark band beside this one).
const SPAWN_CLUSTER_RAIL =
  "border-l-4 border-l-[color:var(--session-rel-spawn-parent)] [&_.session-list-item]:border-l-0";
// CARD: the child group. 1px hairline on all sides (never a 4px rail), rounded,
// and `[&_.session-list-item]:border-l-4` re-enables the rows' own light-gold
// rail inside it — the same variant pair the scheduler box uses.
const SPAWN_PEERS_CARD =
  "border border-[var(--session-rel-spawn)]/30 rounded-sm [&_.session-list-item]:border-l-4";
// Same-repo clusters have a PM parent row above the card, so the card's top edge
// is the SOLID darker-gold parent→children separator (#3264 R4) — where the
// scheduler box paints its solid --session-rel-schedule top. Cross-repo clusters
// have no parent row and keep the plain hairline (#3265 F4/CV3).
const SPAWN_PEERS_CARD_WITH_SEPARATOR = `${SPAWN_PEERS_CARD} border-t-[color:var(--session-rel-spawn-parent)]`;
// Branch (mint) cluster — the SAME three-element shape as the spawn cluster and
// the scheduler cluster (#3484): outer dark-mint RAIL → branch-root row →
// hairline children CARD (solid dark-mint top separator) → light-mint subheading
// + branch rows. Only the hue differs from the SPAWN_* trio: three colors, ONE
// structure. (Supersedes #3264 R7's single flat hairline wrapper, which painted
// no rail at all and left the root row's own rail in place — the one group type
// that did not match the other two.)
const BRANCH_CLUSTER_RAIL =
  "border-l-4 border-l-[color:var(--session-rel-branch-parent)] [&_.session-list-item]:border-l-0";
const BRANCH_CHILDREN_CARD =
  "border border-[var(--session-rel-branch)]/30 rounded-sm [&_.session-list-item]:border-l-4";
const BRANCH_CHILDREN_CARD_WITH_SEPARATOR = `${BRANCH_CHILDREN_CARD} border-t-[color:var(--session-rel-branch-parent)]`;

export function SessionList(props: {
  sessions: SessionSummary[];
  onSelect: (sessionId: string) => void;
  /**
   * Select Mode (#3292, epic #3285 S7) — lifted from SessionsPage (router.tsx) so the
   * Control Bar Select button, these cards, and the Chip Row share one ephemeral store.
   * Absent → cards keep normal navigate-on-tap.
   */
  selectMode?: boolean;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (sessionId: string) => void;
  onNewSession: () => void;
  onRefresh: () => void;
  isLoading: boolean;
  api: ApiClient | null;
  /**
   * #3877: the local hub's federation nodeId (`localNode?.nodeId ?? LOCAL_NODE_ID`, from
   * router.tsx). Hub-local schedules + heartbeat carry NO nodeId, so they attach to the
   * group for THIS node; the node-aware `dirToGroupKey` lookup uses this value for them.
   */
  localNodeId?: string;
  /** Lifted state — when provided, SessionList uses these instead of internal hooks */
  liftedGroups?: SessionGroup[];
  liftedProjectExpandState?: Map<string, boolean>;
  liftedSetProjectExpanded?: (directory: string, expanded: boolean) => void;
  liftedExpandedSessions?: Set<string>;
  liftedToggleSessionExpanded?: (sessionId: string) => void;
  /**
   * #3114: lifted "manual sort active" flag + setter. When provided (by router.tsx),
   * the container shares this state with SearchFilterBar so the Sort control can
   * display "Manual" and clear it. Falls back to internal state when absent.
   */
  liftedManualActive?: boolean;
  liftedSetManualActive?: (active: boolean) => void;
  /** Schedule integration for unified list view (issue #392) */
  schedules?: ScheduledTask[];
  heartbeatConfig?: HeartbeatConfig | null;
  heartbeatStatus?: HeartbeatStatus | null;
  filterView?: FilterView;
  onEditSchedule?: (task: ScheduledTask) => void;
  onEditHeartbeat?: () => void;
  onCreateSchedule?: () => void;
  /** Deep-link: auto-expand this schedule ID */
  initialScheduleId?: string;
}) {
  const { api } = props;
  const filterView = props.filterView ?? "all";
  // #3877: hub-local schedules/heartbeat attach to THIS node's groups (they carry no
  // nodeId); fall back to the LOCAL sentinel so single-node behavior is unchanged.
  const localNodeId = props.localNodeId ?? LOCAL_NODE_ID;

  // Build lookup: scheduleId → sessions spawned by that scheduler.
  // Sessions are filtered out of the main list at render time (in the
  // clustering loop) so this works with both internal and lifted groups.
  const sessionsByScheduleId = useMemo(() => {
    const map = new Map<string, SessionSummary[]>();
    for (const session of props.sessions) {
      const sid = schedulerScheduleId(session);
      if (sid) {
        const list = map.get(sid) ?? [];
        list.push(session);
        map.set(sid, list);
      }
    }
    return map;
  }, [props.sessions]);

  // #2700: ids of every schedule that renders a row. A scheduler-spawned session is
  // nested (and excluded from the main list) only when its schedule is in this set;
  // an orphan whose schedule self-deleted re-homes into the main list instead.
  const knownScheduleIds = useMemo(
    () => new Set((props.schedules ?? []).map(t => t.id)),
    [props.schedules]
  );

  // Use lifted state when provided, otherwise fall back to internal hooks
  const internalGroups = useMemo(
    () => groupSessionsByProject(props.sessions),
    [props.sessions]
  );
  const groups = props.liftedGroups ?? internalGroups;

  // Per-project expand/collapse state (persisted to localStorage)
  const [internalProjectExpandState, internalSetProjectExpanded] =
    useProjectExpandState();
  const projectExpandState =
    props.liftedProjectExpandState ?? internalProjectExpandState;
  const setProjectExpanded =
    props.liftedSetProjectExpanded ?? internalSetProjectExpanded;

  // Per-session expand/collapse state
  const [internalExpandedSessions, internalToggleSessionExpanded] =
    useExpandedSessions();
  const expandedSessions =
    props.liftedExpandedSessions ?? internalExpandedSessions;
  const toggleSessionExpanded =
    props.liftedToggleSessionExpanded ?? internalToggleSessionExpanded;

  // Schedule expand/collapse state (unified list)
  const scheduleInitialIds = useMemo(() => {
    if (!props.initialScheduleId) return undefined;
    return new Set([props.initialScheduleId]);
  }, [props.initialScheduleId]);
  const [scheduleExpandedIds, toggleScheduleExpanded] =
    useExpandedSchedules(scheduleInitialIds);

  // Spawned sessions collapse state (tracks which scheduler task IDs
  // have their spawned sessions section collapsed). Default: collapsed.
  const [spawnedSessionsCollapsed, toggleSpawnedSessionsCollapsed] =
    useSpawnedSessionsCollapsed();

  // Branch cluster collapse state (tracks which parent session IDs have
  // their branch children hidden). Default is expanded (not in set).
  const BRANCH_COLLAPSED_KEY = "hapi:collapsedBranchClusters";
  const [collapsedBranchClusters, setCollapsedBranchClusters] = useState<
    Set<string>
  >(() => {
    try {
      const stored = localStorage.getItem(BRANCH_COLLAPSED_KEY);
      if (stored) return new Set(JSON.parse(stored) as string[]);
    } catch {
      /* ignore */
    }
    return new Set();
  });
  const toggleBranchCluster = useCallback((parentId: string) => {
    setCollapsedBranchClusters(prev => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      try {
        localStorage.setItem(BRANCH_COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // #2479: managed-peer relationship maps + reciprocal-highlight / tap-flash state.
  // - managedPeerCounts: parentId → count of its spawn children (per-node only).
  // - sessionNameById: id → display name, for a managed peer's "managed by …"
  //   breadcrumb. Re-resolves on rename because props.sessions re-renders with
  //   the new name (the map is rebuilt each time).
  const { managedPeerCounts, sessionNameById } = useMemo(() => {
    const counts = new Map<string, number>();
    const names = new Map<string, string>();
    for (const s of props.sessions) {
      names.set(s.id, getSessionTitle(s));
      if (s.parentRelationship === "spawn" && s.parentSessionId) {
        counts.set(s.parentSessionId, (counts.get(s.parentSessionId) ?? 0) + 1);
      }
    }
    return { managedPeerCounts: counts, sessionNameById: names };
  }, [props.sessions]);

  // #2479 (X2 reciprocal highlight): the session currently hovered (a managed
  // peer or a managed parent). relatedIds derives the reciprocal rows to ring.
  const [hoverRelId, setHoverRelId] = useState<string | null>(null);
  const relatedIds = useMemo(() => {
    const set = new Set<string>();
    if (!hoverRelId) return set;
    const hovered = props.sessions.find(s => s.id === hoverRelId);
    // Hovered a managed peer → highlight its parent.
    if (hovered?.parentRelationship === "spawn" && hovered.parentSessionId) {
      set.add(hovered.parentSessionId);
    }
    // Hovered a managed parent → highlight its spawn children.
    for (const s of props.sessions) {
      if (
        s.parentRelationship === "spawn" &&
        s.parentSessionId === hoverRelId
      ) {
        set.add(s.id);
      }
    }
    return set;
  }, [hoverRelId, props.sessions]);

  // #2479 (X3 tap-to-flash): a one-shot flash on a target row (breadcrumb → parent).
  // The functional clear guards against a re-flash racing the timeout.
  const [flashSessionId, setFlashSessionId] = useState<string | null>(null);
  const flashSession = useCallback((sessionId: string) => {
    setFlashSessionId(sessionId);
    window.setTimeout(() => {
      setFlashSessionId(cur => (cur === sessionId ? null : cur));
    }, 700);
  }, []);

  // Scheduler subheader collapse state (per-group, persisted)
  const [schedulerCollapsed, toggleSchedulerCollapsed] =
    useSchedulerSubheaderCollapsed();

  // Pending remote spawn stubs (instant feedback before federation poll)
  const pendingSpawns = usePendingSpawns();

  // Track which sessions need user review (new content since last viewed)
  const { checkNeedsReview, pruneStaleEntries } = useNeedsReview();

  // #2900: the per-session review flag, threaded into getStatusBreakdown for the
  // collapsed-surface hidden-status hints EXACTLY as the toolbar threads it into
  // its statusCounts (router.tsx). Sharing this predicate keeps the hints and the
  // toolbar total consistent (R4) — a needs-review session buckets orange in both.
  const needsReviewFor = useCallback(
    (s: SessionSummary) =>
      checkNeedsReview(
        s.id,
        s.updatedAt,
        s.active,
        s.thinking,
        s.needsReviewOverride as "read" | "unread" | null | undefined
      ),
    [checkNeedsReview]
  );

  // Prune stale entries when session list changes
  // Note: pruneStaleEntries is stable (useCallback with empty deps) so safe to omit from deps
  useEffect(() => {
    // Don't prune when sessions list is empty - could be loading state
    // This prevents wiping all timer data when navigating back to list view
    if (props.sessions.length === 0) return;

    const validIds = new Set(props.sessions.map(s => s.id));
    pruneStaleEntries(validIds);
    pruneOrphanedSessions(validIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessions]);

  // Group schedules by project directory to render within session groups.
  // Unmatched schedules get synthetic SessionGroup entries so they always
  // appear under a project/directory header (issue #476).
  const { schedulesByGroupKey, syntheticGroups, heartbeatGroupKey } =
    useMemo(() => {
      const byGroup = new Map<string, ScheduledTask[]>();
      const unmatched: ScheduledTask[] = [];

      // #4076: keys of the existing real repo/dir groups. An unmatched schedule whose
      // resolved synthetic key equals one of these MUST merge into that group rather
      // than spawn a second group under the same key — two groups sharing a groupKey
      // render as duplicate-keyed sibling <div>s, which React 19 reconciles by
      // overwriting the earlier fiber (its DOM lingers, never updating). Merging keeps
      // groupKey — the manual-order persistence key — unchanged (R4).
      const realGroupKeys = new Set(groups.map(g => g.groupKey));

      // #3877: node-aware directory → groupKey lookup keyed on (nodeId, directory), so a
      // same-path group on a DIFFERENT node cannot capture this node's schedule.
      const dirToGroupKey = new Map<string, string>();
      for (const g of groups) {
        dirToGroupKey.set(
          makeDirGroupLookupKey(g.nodeId, g.directory),
          g.groupKey
        );
      }

      // Match each schedule to a group by projectDirectory
      for (const task of props.schedules ?? []) {
        // #3877: schedules are hub-local (no nodeId) → look up under THIS node.
        let gk = dirToGroupKey.get(
          makeDirGroupLookupKey(localNodeId, task.projectDirectory)
        );
        if (!gk) {
          // Try matching by trailing directory name (schedule path may differ slightly)
          const taskDirName = task.projectDirectory
            .split(/[\\/]+/)
            .filter(Boolean)
            .pop();
          if (taskDirName) {
            for (const g of groups) {
              // #3877: only fuzzy-match groups on THIS node (schedules are hub-local).
              if (g.nodeId !== localNodeId) continue;
              const groupDirName = g.directory
                .split(/[\\/]+/)
                .filter(Boolean)
                .pop();
              if (groupDirName === taskDirName) {
                gk = g.groupKey;
                break;
              }
            }
          }
        }
        if (gk) {
          if (!byGroup.has(gk)) byGroup.set(gk, []);
          byGroup.get(gk)!.push(task);
        } else {
          unmatched.push(task);
        }
      }

      // Create synthetic groups for unmatched schedules, keyed by projectDirectory.
      // If the schedule has repoIdentity (server-enriched), use it for proper
      // repo headers with GitHub links — matching how sessions behave.
      const syntheticMap = new Map<string, SessionGroup>();
      for (const task of unmatched) {
        const dir = task.projectDirectory;
        const repo = task.repoIdentity;
        // #3877: node-aware synthetic key (hub-local schedule → THIS node) so two
        // same-path unmatched schedules on different nodes don't collide.
        const baseKey = repo?.name ?? dir;
        const groupKey = makeDirGroupLookupKey(localNodeId, baseKey);
        // #4076: the synthetic key collides with an existing real group's key → merge
        // the schedule into that group instead of creating a second group. The render's
        // schedulesByGroupKey.get(group.groupKey) read then shows it once, in place.
        if (realGroupKeys.has(groupKey)) {
          if (!byGroup.has(groupKey)) byGroup.set(groupKey, []);
          byGroup.get(groupKey)!.push(task);
          continue;
        }
        if (!syntheticMap.has(groupKey)) {
          syntheticMap.set(groupKey, {
            groupKey,
            nodeId: localNodeId,
            baseKey,
            directory: dir,
            displayName: repo
              ? getRepoDisplayName(repo.name)
              : getFolderDisplayName(dir),
            repoUrl: repo?.url,
            isRepo: !!repo,
            sessions: [],
            latestUpdatedAt: -Infinity,
            hasActiveSession: false,
          });
        }
        if (!byGroup.has(groupKey)) byGroup.set(groupKey, []);
        byGroup.get(groupKey)!.push(task);
      }

      // Match heartbeat to a group by sessionDirectory
      let hbGroupKey: string | undefined;
      if (props.heartbeatConfig) {
        const hbDir = props.heartbeatConfig.sessionDirectory;
        hbGroupKey = dirToGroupKey.get(
          makeDirGroupLookupKey(localNodeId, hbDir)
        );
        if (!hbGroupKey) {
          const hbDirName = hbDir
            .split(/[\\/]+/)
            .filter(Boolean)
            .pop();
          if (hbDirName) {
            for (const g of groups) {
              // #3877: heartbeat is hub-local → only fuzzy-match THIS node's groups.
              if (g.nodeId !== localNodeId) continue;
              const groupDirName = g.directory
                .split(/[\\/]+/)
                .filter(Boolean)
                .pop();
              if (groupDirName === hbDirName) {
                hbGroupKey = g.groupKey;
                break;
              }
            }
          }
        }
        // If still unmatched, create or reuse a synthetic group
        if (!hbGroupKey) {
          const hbGroupKeyCandidate = makeDirGroupLookupKey(localNodeId, hbDir);
          // #4076: same merge guard as the schedule loop (defensive — the exact and
          // fuzzy matches above already catch a real-group heartbeat, so this is not
          // reachable today, but it stops any synthetic source from recreating a
          // duplicate key). hbGroupKey is still set to the candidate either way, so a
          // heartbeat whose key is a real group's renders under that group.
          if (
            !realGroupKeys.has(hbGroupKeyCandidate) &&
            !syntheticMap.has(hbGroupKeyCandidate)
          ) {
            syntheticMap.set(hbGroupKeyCandidate, {
              groupKey: hbGroupKeyCandidate,
              nodeId: localNodeId,
              baseKey: hbDir,
              directory: hbDir,
              displayName: getFolderDisplayName(hbDir),
              isRepo: false,
              sessions: [],
              latestUpdatedAt: -Infinity,
              hasActiveSession: false,
            });
          }
          hbGroupKey = hbGroupKeyCandidate;
        }
      }

      return {
        schedulesByGroupKey: byGroup,
        syntheticGroups: Array.from(syntheticMap.values()),
        heartbeatGroupKey: hbGroupKey,
      };
      // #4076 (E9): localNodeId is a prop (props.localNodeId ?? LOCAL_NODE_ID, :261)
      // read throughout this memo, so it belongs in the deps — it can change after
      // federation info loads. react-hooks/exhaustive-deps is warn-severity, so this is
      // a correctness fix, not a build unblock.
    }, [groups, props.schedules, props.heartbeatConfig, localNodeId]);

  // Group pending spawns by project directory → groupKey, mirroring the
  // schedule matching pattern above. Unmatched spawns get synthetic groups.
  const { spawnsByGroupKey, spawnSyntheticGroups } = useMemo(() => {
    const byGroup = new Map<string, PendingSpawn[]>();
    const unmatched: PendingSpawn[] = [];

    // #3877: node-aware directory → groupKey lookup keyed on (nodeId, directory).
    const dirToGroupKey = new Map<string, string>();
    for (const g of groups) {
      dirToGroupKey.set(
        makeDirGroupLookupKey(g.nodeId, g.directory),
        g.groupKey
      );
    }

    for (const spawn of pendingSpawns) {
      // #3877: a pending spawn carries its OWN nodeId → look up under that node, so a
      // remote spawn attaches to the remote group (not this node's same-path group).
      let gk = dirToGroupKey.get(
        makeDirGroupLookupKey(spawn.nodeId, spawn.directory)
      );
      if (!gk) {
        // Try matching by trailing directory name (remote paths may differ)
        const spawnDirName = spawn.directory
          .split(/[\\/]+/)
          .filter(Boolean)
          .pop();
        if (spawnDirName) {
          for (const g of groups) {
            // #3877: only fuzzy-match groups on the spawn's OWN node.
            if (g.nodeId !== spawn.nodeId) continue;
            const groupDirName = g.directory
              .split(/[\\/]+/)
              .filter(Boolean)
              .pop();
            if (groupDirName === spawnDirName) {
              gk = g.groupKey;
              break;
            }
          }
        }
      }
      if (gk) {
        if (!byGroup.has(gk)) byGroup.set(gk, []);
        byGroup.get(gk)!.push(spawn);
      } else {
        unmatched.push(spawn);
      }
    }

    // Create synthetic groups for unmatched spawns (new directories)
    const syntheticMap = new Map<string, SessionGroup>();
    for (const spawn of unmatched) {
      const dir = spawn.directory;
      // #3877: node-aware synthetic key (spawn carries its own nodeId + nodeLabel).
      const groupKey = makeDirGroupLookupKey(spawn.nodeId, dir);
      if (!syntheticMap.has(groupKey)) {
        syntheticMap.set(groupKey, {
          groupKey,
          nodeId: spawn.nodeId,
          nodeLabel: spawn.nodeLabel,
          baseKey: dir,
          directory: dir,
          displayName: getFolderDisplayName(dir),
          isRepo: false,
          sessions: [],
          latestUpdatedAt: spawn.createdAt,
          hasActiveSession: true,
        });
      }
      if (!byGroup.has(groupKey)) byGroup.set(groupKey, []);
      byGroup.get(groupKey)!.push(spawn);
    }

    return {
      spawnsByGroupKey: byGroup,
      spawnSyntheticGroups: Array.from(syntheticMap.values()),
    };
  }, [groups, pendingSpawns]);

  // Merge session-based groups with schedule-only and spawn-only synthetic groups.
  // #4076: first-wins de-dup across ALL sources (real groups first, so a real group
  // always wins over any same-key synthetic), so no synthetic source — schedule,
  // heartbeat or spawn — can reintroduce a duplicate React key. Generalizes the former
  // spawn-only filter.
  const allGroups = useMemo(() => {
    const seen = new Set<string>();
    const result: SessionGroup[] = [];
    for (const g of [...groups, ...syntheticGroups, ...spawnSyntheticGroups]) {
      if (seen.has(g.groupKey)) continue;
      seen.add(g.groupKey);
      result.push(g);
    }
    return result;
  }, [groups, syntheticGroups, spawnSyntheticGroups]);
  // #3877: render the per-project node badge only when >1 distinct node is present, so a
  // single-node setup has ZERO visible change (R5) while multi-node headers are node-labeled (R4).
  const multiNode = useMemo(
    () => new Set(allGroups.map(g => g.nodeId)).size > 1,
    [allGroups]
  );
  const isGroupCollapsed = (group: SessionGroup): boolean => {
    // #3877: migration read — new composite groupKey first, then the pre-#3877 base key
    // (== the old node-blind groupKey), then the directory. Preserves single-node expand
    // state across the key-format change without a bespoke migration pass. In multi-node,
    // two same-baseKey groups share this fallback read until each is toggled (one-load
    // cosmetic only; thereafter each stores under its own composite key).
    const stored =
      projectExpandState.get(group.groupKey) ??
      projectExpandState.get(group.baseKey) ??
      projectExpandState.get(group.directory);
    if (stored !== undefined) {
      // stored is "expanded" state, return inverse for "collapsed"
      return !stored;
    }
    // Default: collapsed (per issue #81 requirements)
    return true;
  };

  const toggleGroup = (groupKey: string, isCollapsed: boolean) => {
    // Set expanded state (inverse of collapsed)
    setProjectExpanded(groupKey, isCollapsed);
  };

  // ── Always-armed manual drag-to-reorder (issue #466, #3114) ──────────────
  // The drag apparatus is ALWAYS mounted (no reorder mode). A device-local
  // `manualActive` flag records whether a custom order should OVERRIDE the #942
  // server sort: false → server sort governs (allGroups untouched); true (after
  // the first completed drag) → the stored custom order applies and the sort
  // selector shows "Manual". A mid-drag snapshot freezes the list vs SSE refetches.
  const [internalManualActive, internalSetManualActive] = useState<boolean>(
    () => getStoredManualActive()
  );
  const manualActive = props.liftedManualActive ?? internalManualActive;
  const setManualActive =
    props.liftedSetManualActive ?? internalSetManualActive;
  // Bumped after every persist so the order-derived memos recompute.
  const [orderVersion, setOrderVersion] = useState(0);
  // Mid-drag freeze (finding 466-4): a snapshot captured on drag start. While
  // set, the list renders from it and drop indexes resolve against it, so an
  // SSE refetch mid-drag cannot shift rows under the pointer or misresolve the drop.
  const [frozen, setFrozen] = useState<null | {
    groups: SessionGroup[];
    projectIds: string[];
    rootIdsByGroup: Record<string, string[]>;
  }>(null);

  const sensors = useSensors(
    // Desktop click-and-hold + mobile tap-and-hold both arm on a ~300ms hold on a
    // non-interactive area (guarded sensors exclude interactive children — R4). The
    // shared delay means a short tap navigates and a normal touch-drag still scrolls
    // the list / pull-to-refresh until the hold threshold elapses (R2).
    useSensor(GuardedPointerSensor, { activationConstraint: DRAG_ACTIVATION }),
    useSensor(GuardedTouchSensor, { activationConstraint: DRAG_ACTIVATION }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Per-group root-session order (stable during a drag; re-read after a persist).
  const currentSessionOrder = useMemo(
    () => getStoredSessionOrder(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orderVersion, manualActive]
  );

  // Project order applied over the live allGroups (covers lifted + internal +
  // synthetic groups — finding 466-6). When manual sort is inactive, returns
  // allGroups untouched so the #942 server sort governs until the first drag.
  const displayGroups = useMemo(() => {
    if (!manualActive) return allGroups;
    return orderByCustom(allGroups, getStoredProjectOrder(), g => g.groupKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualActive, allGroups, orderVersion]);

  // The list actually rendered — the frozen snapshot while dragging, else live.
  const groupsToRender = frozen?.groups ?? displayGroups;

  // Root session ids for a group in reorder render order (feeds the freeze
  // snapshot and drop-index resolution).
  const rootIdsInOrder = useCallback(
    (group: SessionGroup, sessionOrder: Record<string, string[]>): string[] => {
      const rootIds = buildClusters(
        group.sessions,
        knownScheduleIds,
        crossRepoPeerIds(group)
      ).clusters.map(c => c[0].id);
      return orderByCustom(
        rootIds,
        sessionOrder[group.groupKey] ?? [],
        id => id
      );
    },
    [knownScheduleIds]
  );

  const onDragStart = useCallback(
    (_e: DragStartEvent) => {
      const sessionOrder = getStoredSessionOrder();
      const rootIdsByGroup: Record<string, string[]> = {};
      for (const g of displayGroups) {
        rootIdsByGroup[g.groupKey] = rootIdsInOrder(g, sessionOrder);
      }
      setFrozen({
        groups: displayGroups,
        projectIds: displayGroups.map(g => `proj:${g.groupKey}`),
        rootIdsByGroup,
      });
    },
    [displayGroups, rootIdsInOrder]
  );

  const onDragCancel = useCallback(() => setFrozen(null), []);

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const snap = frozen;
      setFrozen(null);
      const { active, over } = e;
      if (!snap || !over || active.id === over.id) return;
      const activeId = String(active.id);
      const overId = String(over.id);

      // #3114: the first completed drag seeds the FULL on-screen arrangement as the
      // custom order (mirrors the removed toggleReorderMode ON-branch) so an SSE
      // refetch can't shift un-dragged rows, then flips the effective sort to Manual.
      // The reorder branch below then overrides the ONE dragged dimension on top.
      const firstDrag = !manualActive;
      if (firstDrag) {
        persistProjectOrder(allGroups.map(g => g.groupKey));
        const seed: Record<string, string[]> = {};
        for (const g of allGroups) {
          seed[g.groupKey] = buildClusters(
            g.sessions,
            knownScheduleIds,
            crossRepoPeerIds(g)
          ).clusters.map(c => c[0].id);
        }
        persistSessionOrder(seed);
      }

      let didReorder = false;
      if (activeId.startsWith("proj:") && overId.startsWith("proj:")) {
        // Reorder projects among the top-level rows.
        const ids = snap.projectIds;
        const oldIndex = ids.indexOf(activeId);
        const newIndex = ids.indexOf(overId);
        if (oldIndex >= 0 && newIndex >= 0) {
          const next = arrayMove(ids, oldIndex, newIndex).map(id =>
            id.slice("proj:".length)
          );
          persistProjectOrder(next);
          didReorder = true;
        }
      } else if (activeId.startsWith("sess:") && overId.startsWith("sess:")) {
        // Reorder a root cluster WITHIN its own group only.
        const rootActive = activeId.slice("sess:".length);
        const rootOver = overId.slice("sess:".length);
        const groupKey = Object.keys(snap.rootIdsByGroup).find(k =>
          snap.rootIdsByGroup[k].includes(rootActive)
        );
        const roots = groupKey ? snap.rootIdsByGroup[groupKey] : undefined;
        // Ignore a cross-group drop (rootOver not in the active group).
        if (groupKey && roots && roots.includes(rootOver)) {
          const oldIndex = roots.indexOf(rootActive);
          const newIndex = roots.indexOf(rootOver);
          if (oldIndex >= 0 && newIndex >= 0) {
            const nextRoots = arrayMove(roots, oldIndex, newIndex);
            persistSessionOrder({
              ...getStoredSessionOrder(),
              [groupKey]: nextRoots,
            });
            didReorder = true;
          }
        }
      }
      // Cross-type (proj vs sess) drops are ignored → entry returns to origin.

      if (didReorder) {
        // First completed drag → switch the effective sort to Manual (R7).
        if (firstDrag) {
          setManualActive(true);
          persistManualActive(true);
        }
        setOrderVersion(v => v + 1);
      }
    },
    [frozen, manualActive, allGroups, knownScheduleIds]
  );

  return (
    <div className="mx-auto w-full max-w-content flex flex-col">
      <div className="flex flex-col">
        {/* Filter-aware empty state (issue #942 R18): sessions exist but the
            active search/filter narrowed everything out. Distinct from the
            genuine no-sessions-at-all state (props.sessions.length === 0). */}
        {allGroups.length === 0 && props.sessions.length > 0 && (
          <div className="mx-auto w-full max-w-content px-3 py-10 text-center text-sm text-[var(--app-hint)]">
            No sessions match your filters
          </div>
        )}
        {/* Unified grouped list: each group renders its sessions + matched schedules + pending spawns */}
        {(() => {
          const listItems = groupsToRender.map(group => {
            const isCollapsed = isGroupCollapsed(group);
            const groupSchedules =
              filterView !== "sessions"
                ? (schedulesByGroupKey.get(group.groupKey) ?? [])
                : [];
            const showHeartbeat =
              filterView !== "sessions" &&
              heartbeatGroupKey === group.groupKey &&
              !!props.heartbeatConfig;
            const showSessions = filterView !== "schedules";
            const hasScheduleContent =
              showHeartbeat || groupSchedules.length > 0;

            // In "schedules" filter, skip groups with no schedule content
            if (filterView === "schedules" && !hasScheduleContent) return null;

            return (
              <div key={group.groupKey}>
                {/* #3114: the drag apparatus is always mounted — the header wraps in
                    SortableListEntry unconditionally. Press-and-hold on the header
                    arms a project reorder; the custom order only GOVERNS once manual
                    sort is active (first drag). */}
                <SortableListEntry id={`proj:${group.groupKey}`}>
                  {({ attributes, listeners }) => (
                    <ProjectHeader
                      group={group}
                      isCollapsed={isCollapsed}
                      showNode={multiNode}
                      onToggle={() => toggleGroup(group.groupKey, isCollapsed)}
                      api={api}
                      onRefresh={props.onRefresh}
                      dragHandle={{ attributes, listeners }}
                    />
                  )}
                </SortableListEntry>
                {!isCollapsed ? (
                  <div className="flex flex-col divide-y divide-[var(--app-divider)] border-b border-[var(--app-divider)]">
                    {/* Scheduler subheader with grouped schedule entries */}
                    {hasScheduleContent &&
                      (() => {
                        const totalCount =
                          groupSchedules.length + (showHeartbeat ? 1 : 0);
                        const enabledCount =
                          groupSchedules.filter(t => t.enabled).length +
                          (showHeartbeat && props.heartbeatConfig?.enabled
                            ? 1
                            : 0);
                        const isSchedulerCollapsed = schedulerCollapsed.has(
                          group.groupKey
                        );
                        return (
                          <SchedulerSubheader
                            groupKey={group.groupKey}
                            totalCount={totalCount}
                            enabledCount={enabledCount}
                            isCollapsed={isSchedulerCollapsed}
                            onToggle={() =>
                              toggleSchedulerCollapsed(group.groupKey)
                            }
                          >
                            {showHeartbeat && props.heartbeatConfig && (
                              <HeartbeatListEntry
                                api={api}
                                config={props.heartbeatConfig}
                                status={props.heartbeatStatus ?? null}
                                onCreate={props.onCreateSchedule ?? (() => {})}
                                onEdit={props.onEditHeartbeat}
                                isExpanded={scheduleExpandedIds.has(
                                  "heartbeat"
                                )}
                                onToggleExpanded={() =>
                                  toggleScheduleExpanded("heartbeat")
                                }
                              />
                            )}
                            {groupSchedules.map(task => {
                              const spawned =
                                sessionsByScheduleId.get(task.id) ?? [];
                              return (
                                <ScheduleListRow
                                  key={task.id}
                                  api={api}
                                  task={task}
                                  onEdit={props.onEditSchedule ?? (() => {})}
                                  isExpanded={scheduleExpandedIds.has(task.id)}
                                  onToggleExpanded={() =>
                                    toggleScheduleExpanded(task.id)
                                  }
                                  spawnedSessionCount={spawned.length}
                                  isSpawnedCollapsed={
                                    !spawnedSessionsCollapsed.has(task.id)
                                  }
                                  // #3133: always surface the scheduler-spawned
                                  // sessions' status breakdown (was #2900
                                  // collapsed-only) so it reconciles with the toolbar.
                                  statusBreakdown={getStatusBreakdown(
                                    spawned,
                                    needsReviewFor
                                  )}
                                  onToggleSpawnedCollapsed={() =>
                                    toggleSpawnedSessionsCollapsed(task.id)
                                  }
                                  renderSpawnedSessions={() =>
                                    spawned.map(s => (
                                      <SessionItem
                                        key={s.id}
                                        session={s}
                                        onSelect={props.onSelect}
                                        selectMode={props.selectMode}
                                        selected={
                                          props.selectedIds?.has(s.id) ?? false
                                        }
                                        onToggleSelect={props.onToggleSelect}
                                        showPath={false}
                                        api={api}
                                        needsReview={checkNeedsReview(
                                          s.id,
                                          s.updatedAt,
                                          s.active,
                                          s.thinking,
                                          s.needsReviewOverride as
                                            | "read"
                                            | "unread"
                                            | null
                                            | undefined
                                        )}
                                        isExpanded={expandedSessions.has(s.id)}
                                        onToggleExpanded={() =>
                                          toggleSessionExpanded(s.id)
                                        }
                                        onReconnect={undefined}
                                        branchDepth={0}
                                      />
                                    ))
                                  }
                                />
                              );
                            })}
                          </SchedulerSubheader>
                        );
                      })()}
                    {/* Pending spawn stubs matched to this group */}
                    {showSessions &&
                      (spawnsByGroupKey.get(group.groupKey) ?? []).map(
                        spawn => (
                          <PendingSpawnItem key={spawn.id} spawn={spawn} />
                        )
                      )}
                    {/* Session entries within this group */}
                    {showSessions &&
                      (() => {
                        // Build parent→children clusters (shared helper — also feeds
                        // the reorder root-id computation). When manual sort is active
                        // the clusters are re-ordered by the custom root order (frozen
                        // snapshot while dragging, else the persisted order); children
                        // stay under their root, so the tree invariant holds (466-2).
                        const { clusters: rawClusters, depth: depthMap } =
                          buildClusters(
                            group.sessions,
                            knownScheduleIds,
                            crossRepoPeerIds(group)
                          );
                        const clusters = manualActive
                          ? orderByCustom(
                              rawClusters,
                              frozen?.rootIdsByGroup[group.groupKey] ??
                                currentSessionOrder[group.groupKey] ??
                                [],
                              c => c[0].id
                            )
                          : rawClusters;

                        const renderItem = (
                          s: SessionSummary,
                          dragHandle?: SortableDragHandle
                        ) => (
                          <SessionItem
                            key={s.id}
                            session={s}
                            onSelect={props.onSelect}
                            selectMode={props.selectMode}
                            selected={props.selectedIds?.has(s.id) ?? false}
                            onToggleSelect={props.onToggleSelect}
                            showPath={false}
                            api={api}
                            needsReview={checkNeedsReview(
                              s.id,
                              s.updatedAt,
                              s.active,
                              s.thinking,
                              s.needsReviewOverride as
                                | "read"
                                | "unread"
                                | null
                                | undefined
                            )}
                            isExpanded={expandedSessions.has(s.id)}
                            onToggleExpanded={() => toggleSessionExpanded(s.id)}
                            onReconnect={undefined}
                            branchDepth={depthMap.get(s.id) ?? 0}
                            managedPeerCount={managedPeerCounts.get(s.id) ?? 0}
                            parentName={
                              s.parentRelationship === "spawn" &&
                              s.parentSessionId
                                ? (sessionNameById.get(s.parentSessionId) ??
                                  null)
                                : null
                            }
                            isRelHighlighted={relatedIds.has(s.id)}
                            isFlashing={flashSessionId === s.id}
                            onRelHover={setHoverRelId}
                            onFlashSession={flashSession}
                            dragHandle={dragHandle}
                          />
                        );

                        const renderCluster = (
                          cluster: SessionSummary[],
                          dragHandle?: SortableDragHandle
                        ) => {
                          const hasChildren = cluster.length > 1;
                          if (!hasChildren) {
                            return renderItem(cluster[0], dragHandle);
                          }
                          const parentId = cluster[0].id;
                          const children = cluster.slice(1);
                          const isCollapsed =
                            collapsedBranchClusters.has(parentId);
                          // #2479: a cluster whose children are all spawn peers is
                          // a MANAGED cluster (gold "managed peers"); otherwise it
                          // stays the branch cluster (mint "branched conversations").
                          // Mixed clusters fall back to branch chrome — the spawn
                          // rows still render their own gold accent + pill.
                          // #3038: the former Task-14 remainder ("an opacity
                          // modifier on a CSS var does not compose cleanly") is
                          // overturned for Tailwind 4.1: `bg-[var(--x)]/10` and
                          // `bg-[#hex]/10` both compile to the same
                          // color-mix(in oklab, … N%, transparent) expression, so
                          // the token forms below render identically to the old
                          // hex literals while restoring the runtime-swap contract.
                          const isSpawnCluster =
                            children.length > 0 &&
                            children.every(
                              c => c.parentRelationship === "spawn"
                            );
                          // Cluster chrome: SPAWN_CLUSTER_RAIL / SPAWN_PEERS_CARD_WITH_SEPARATOR
                          // (spawn) vs BRANCH_CLUSTER_RAIL / BRANCH_CHILDREN_CARD_WITH_SEPARATOR
                          // (branch) — module scope; chosen in the return below.
                          // Tint/rail CHROME only (#3484) — layout (flex / gap /
                          // height / padding / alignment) is owned by SubheadingBar;
                          // this string carries only the hue: the 4px gold/mint left
                          // rail that sits just inside the card hairline (R5), the
                          // alpha fill/hover, and the text color. Neither variant
                          // paints a top border — the CARD's solid dark top edge is
                          // the root→children separator for both (#3484).
                          const clusterTint = isSpawnCluster
                            ? "bg-[var(--session-rel-spawn)]/10 border-l-4 border-l-[color:var(--session-rel-spawn)] text-[var(--session-rel-spawn-text)] hover:opacity-80 hover:bg-[var(--session-rel-spawn)]/15"
                            : "bg-accent/10 border-l-4 border-l-[color:var(--session-rel-branch)] text-accent/70 hover:text-accent hover:bg-accent/15";
                          const clusterDivide = isSpawnCluster
                            ? "divide-y divide-[var(--session-rel-spawn)]/30"
                            : "divide-y divide-accent/30";
                          const clusterLabel = isSpawnCluster
                            ? "managed peers"
                            : "branched conversations";
                          const clusterBody = (
                            <>
                              {/* Collapsible subheading between parent and children.
                                  #3484: the shared SubheadingBar — status cluster far
                                  left (aligned columns under the toolbar accumulator),
                                  label + count to its right, chevron far right. */}
                              <SubheadingBar
                                collapsed={isCollapsed}
                                onToggle={() => toggleBranchCluster(parentId)}
                                label={clusterLabel}
                                count={`(${children.length})`}
                                className={clusterTint}
                                // #3484 Option 2: BOTH cluster cards sit inside
                                // an outer 4px dark RAIL (gold / mint), so both
                                // bars take the nested pl-1 — the status clusters
                                // land on the same x by structure, not by a
                                // per-kind padding compensation.
                                nestedInRail
                                // #3133: always-on session-count badge for this
                                // branch/managed cluster — the child sessions' status
                                // breakdown, reconciling with the toolbar total.
                                cluster={
                                  <SessionCountBadge
                                    variant="aligned"
                                    breakdown={getStatusBreakdown(
                                      children,
                                      needsReviewFor
                                    )}
                                  />
                                }
                              />
                              {!isCollapsed && (
                                <div className={clusterDivide}>
                                  {children.map(c => renderItem(c))}
                                </div>
                              )}
                            </>
                          );
                          // ONE shape for both cluster kinds (#3484) — only the
                          // hue differs (gold vs mint):
                          // RAIL (the only dark band; strips the root row's own rail)
                          //   ├─ root row (PM parent / branch root) → single-wide dark
                          //   └─ CARD (hairline + solid dark top separator)
                          //        ├─ subheading  → dark rail + card hairline + light rail
                          //        └─ child rows  → dark rail + card hairline + light rail
                          const clusterRail = isSpawnCluster
                            ? SPAWN_CLUSTER_RAIL
                            : BRANCH_CLUSTER_RAIL;
                          const clusterCard = isSpawnCluster
                            ? SPAWN_PEERS_CARD_WITH_SEPARATOR
                            : BRANCH_CHILDREN_CARD_WITH_SEPARATOR;
                          return (
                            <div className={clusterRail}>
                              {renderItem(cluster[0], dragHandle)}
                              <div className={clusterCard}>{clusterBody}</div>
                            </div>
                          );
                        };

                        // Wrap each cluster as a sortable unit keyed by its ROOT id
                        // (clusters move whole; children re-derive under their root).
                        // #3114: always sortable — press-and-hold on the row arms the
                        // drag; the guarded sensors gate on the hold threshold + target.
                        const clusterItems = clusters.map(cluster => {
                          const rootId = cluster[0].id;
                          return (
                            <SortableListEntry
                              key={`sess:${rootId}`}
                              id={`sess:${rootId}`}
                            >
                              {({ attributes, listeners }) =>
                                renderCluster(cluster, {
                                  attributes,
                                  listeners,
                                })
                              }
                            </SortableListEntry>
                          );
                        });

                        // #3265: cross-repo managed peers — sessions whose PM lives
                        // in ANOTHER project group. Rendered here under a collapsible
                        // "managed peers" subheading beneath this project's header,
                        // reusing #3264's standardized gold spawn-cluster chrome
                        // (chevron · label · (N) · count BESIDE the label, R4) — but
                        // with NO PM parent row and NO darker-gold parent-top border
                        // (F4/CV3): the PM lives in another repo, so there is no parent
                        // row to carry it. Peers render via the shared `renderItem`, so
                        // SessionItem's `isManagedPeer` gold accent + "managed by <PM>"
                        // breadcrumb are inherited and the false "Branch created here"
                        // separator (#2904) is not reintroduced (F6/CV5).
                        const crossRepoPeers =
                          group.crossRepoManagedPeers ?? [];
                        const crossRepoCollapseKey = `${group.groupKey}:managed-peers`;
                        const crossRepoCollapsed =
                          collapsedBranchClusters.has(crossRepoCollapseKey);

                        // A per-group SortableContext scopes the session ids so a
                        // cluster can only move within its own project group (R6).
                        return (
                          <>
                            {crossRepoPeers.length > 0 && (
                              // Same three-element shape as the same-repo cluster and the scheduler
                              // cluster: outer dark-gold RAIL → hairline peers CARD → light-gold
                              // subheading + rows. No PM parent row here, so the card's top edge
                              // stays the plain hairline (F4/CV3: no parent to separate from).
                              <div className={SPAWN_CLUSTER_RAIL}>
                                <div className={SPAWN_PEERS_CARD}>
                                  {/* #3484: shared SubheadingBar — cluster far left
                                      (aligned under the toolbar accumulator), label +
                                      count to its right, chevron far right. */}
                                  <SubheadingBar
                                    collapsed={crossRepoCollapsed}
                                    onToggle={() =>
                                      toggleBranchCluster(crossRepoCollapseKey)
                                    }
                                    label="managed peers"
                                    count={`(${crossRepoPeers.length})`}
                                    // #3484 Option 2: card nested in the outer
                                    // dark-gold RAIL → pl-1 (see SubheadingBar).
                                    nestedInRail
                                    className="bg-[var(--session-rel-spawn)]/10 border-l-4 border-l-[color:var(--session-rel-spawn)] text-[var(--session-rel-spawn-text)] hover:opacity-80 hover:bg-[var(--session-rel-spawn)]/15"
                                    cluster={
                                      <SessionCountBadge
                                        variant="aligned"
                                        breakdown={getStatusBreakdown(
                                          crossRepoPeers,
                                          needsReviewFor
                                        )}
                                      />
                                    }
                                  />
                                  {!crossRepoCollapsed && (
                                    <div className="divide-y divide-[var(--session-rel-spawn)]/30">
                                      {crossRepoPeers.map(p => renderItem(p))}
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                            <SortableContext
                              items={clusters.map(c => `sess:${c[0].id}`)}
                              strategy={verticalListSortingStrategy}
                            >
                              {clusterItems}
                            </SortableContext>
                          </>
                        );
                      })()}
                  </div>
                ) : null}
              </div>
            );
          });
          // #3114: the whole project list is ALWAYS wrapped in one DndContext +
          // the project-level SortableContext (namespaced `proj:` ids). The drag is
          // armed by press-and-hold on any row/header; the guarded sensors ensure a
          // short tap or a press on an interactive child never starts a drag.
          return (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDragCancel={onDragCancel}
            >
              <SortableContext
                items={groupsToRender.map(g => `proj:${g.groupKey}`)}
                strategy={verticalListSortingStrategy}
              >
                {listItems}
              </SortableContext>
            </DndContext>
          );
        })()}
      </div>
    </div>
  );
}
