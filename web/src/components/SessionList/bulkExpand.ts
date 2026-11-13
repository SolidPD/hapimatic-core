// SPDX-License-Identifier: AGPL-3.0-only
// Bulk expand / collapse for the session list: the pure half of the chevron
// "Expand All / Collapse All" menu. ExpandCollapseAllMenu.tsx renders the menu
// and SessionListContainer wires it to the list's state.
//
// The list keeps its disclosure state in several independent stores, each a set
// of ids with a per-id toggle (session details, branch / managed-peer
// subheadings, the Schedulers subheading, scheduled peers). This module works
// out which ids a bulk action covers and brings each store to the wanted state
// through that same toggle, so a bulk change takes exactly the path, and the
// persistence, of a single tap.

/**
 * One chevron menu's scope: what "All" covers there, and the two actions.
 * Built by SessionListContainer (one for the project headers, one per project
 * for its session rows) and rendered by ExpandCollapseAllMenu.
 */
export type ExpandCollapseAllScope = {
  /** The menu's accessible name: what "All" covers (e.g. "All projects"). */
  label: string;
  /** Tooltip of the "Expand All" item: exactly what it changes. */
  expandAllHint: string;
  /** Tooltip of the "Collapse All" item: exactly what it changes. */
  collapseAllHint: string;
  onExpandAll: () => void;
  onCollapseAll: () => void;
};

/** The project headers' scope: "All" is every project the list shows. */
export function allProjectsScope(
  setAllExpanded: (expanded: boolean) => void
): ExpandCollapseAllScope {
  return {
    label: "All projects",
    expandAllHint: "Expand every project in the list",
    collapseAllHint: "Collapse every project in the list",
    onExpandAll: () => setAllExpanded(true),
    onCollapseAll: () => setAllExpanded(false),
  };
}

/** A project's session rows' scope: "All" is every session under it. */
export function allSessionsScope(
  projectName: string,
  setAllExpanded: (expanded: boolean) => void
): ExpandCollapseAllScope {
  return {
    label: `All sessions in ${projectName}`,
    expandAllHint:
      "Show the details of every session in this project, and open every subheading",
    collapseAllHint: "Hide the details of every session in this project",
    onExpandAll: () => setAllExpanded(true),
    onCollapseAll: () => setAllExpanded(false),
  };
}

/** A disclosure store: the ids currently in its set, and its per-id toggle. */
export type ToggleSetStore = {
  ids: ReadonlySet<string>;
  toggle: (id: string) => void;
};

/**
 * Bring every id in `ids` to the wanted membership of a toggle-only store. An
 * id already in the wanted state is left alone and a repeated id is toggled
 * once, so the call is safe to repeat. `store.ids` must be the set the toggle
 * acts on (the current render's), because a toggle flips rather than sets.
 */
export function syncMembership(
  store: ToggleSetStore,
  ids: Iterable<string>,
  member: boolean
): void {
  for (const id of new Set(ids)) {
    if (store.ids.has(id) !== member) store.toggle(id);
  }
}

/**
 * The collapse-store key of a project's cross-repo "managed peers" subheading
 * (#3265): the peers whose Project Manager lives in another project, so there
 * is no parent session id to key the subheading by.
 */
export function crossRepoClusterKey(groupKey: string): string {
  return `${groupKey}:managed-peers`;
}

type WithId = { id: string };

/** Everything one project's "Expand All" / "Collapse All" acts on. */
export type GroupExpandTargets = {
  /** Every session row listed under the project. */
  sessionIds: string[];
  /** Its branch / managed-peer subheadings, as collapse-store keys. */
  clusterKeys: string[];
  /** The project's own key when it shows a "Schedulers" subheading. */
  schedulerGroupKeys: string[];
  /** The schedules whose "scheduled peers" box holds at least one session. */
  scheduleIdsWithPeers: string[];
};

/**
 * Work out what a project's bulk action covers, from exactly what the list
 * renders under that project's header. Pass only what the current view shows
 * (no schedules in the "sessions" view, no clusters in the "schedules" view),
 * so a bulk action never changes something that is not on screen.
 */
export function collectGroupExpandTargets(input: {
  groupKey: string;
  /** The project's main-list clusters (`buildClusters`): `[root, ...children]`. */
  clusters: readonly (readonly WithId[])[];
  /** Managed peers whose Project Manager lives in another project (#3265). */
  crossRepoPeers: readonly WithId[];
  /** The schedule rows listed under this project. */
  schedules: readonly WithId[];
  /** True when the project shows a "Schedulers" subheading at all. */
  hasSchedulerSection: boolean;
  /** scheduleId → the sessions nested under that schedule's row. */
  sessionsByScheduleId: ReadonlyMap<string, readonly WithId[]>;
}): GroupExpandTargets {
  // A Set, because one session can be listed twice: a cross-repo managed peer
  // is both in the project's sessions and in its flagged peers (#3265).
  const sessionIds = new Set<string>();
  const clusterKeys: string[] = [];

  for (const cluster of input.clusters) {
    for (const session of cluster) sessionIds.add(session.id);
    // Only a cluster with children draws a subheading, keyed by its root.
    if (cluster.length > 1) clusterKeys.push(cluster[0].id);
  }

  if (input.crossRepoPeers.length > 0) {
    clusterKeys.push(crossRepoClusterKey(input.groupKey));
    for (const peer of input.crossRepoPeers) sessionIds.add(peer.id);
  }

  const scheduleIdsWithPeers: string[] = [];
  for (const schedule of input.schedules) {
    const peers = input.sessionsByScheduleId.get(schedule.id) ?? [];
    if (peers.length === 0) continue;
    scheduleIdsWithPeers.push(schedule.id);
    for (const peer of peers) sessionIds.add(peer.id);
  }

  return {
    sessionIds: [...sessionIds],
    clusterKeys,
    schedulerGroupKeys: input.hasSchedulerSection ? [input.groupKey] : [],
    scheduleIdsWithPeers,
  };
}

/** The four stores a project's bulk action reaches. */
export type GroupExpandStores = {
  /** Session rows showing their details. */
  expandedSessions: ToggleSetStore;
  /** Branch / managed-peer subheadings that are collapsed. */
  collapsedClusters: ToggleSetStore;
  /** Projects whose "Schedulers" subheading is collapsed. */
  collapsedSchedulerGroups: ToggleSetStore;
  /**
   * Schedules whose "scheduled peers" box is OPEN. This is
   * `useSpawnedSessionsCollapsed`, whose set holds the opened ids despite its
   * name (the box is closed by default).
   */
  openScheduledPeers: ToggleSetStore;
};

/**
 * Apply a project's bulk action.
 *
 * "Expand All" shows every session's details AND opens every subheading in the
 * project, because an expanded session inside a closed subheading is still
 * hidden. "Collapse All" hides every session's details and leaves the
 * subheadings as they are: closing them would hide the sessions themselves,
 * which is a different act from collapsing their details.
 */
export function applyGroupExpand(
  targets: GroupExpandTargets,
  expanded: boolean,
  stores: GroupExpandStores
): void {
  syncMembership(stores.expandedSessions, targets.sessionIds, expanded);
  if (!expanded) return;
  syncMembership(stores.collapsedClusters, targets.clusterKeys, false);
  syncMembership(
    stores.collapsedSchedulerGroups,
    targets.schedulerGroupKeys,
    false
  );
  syncMembership(stores.openScheduledPeers, targets.scheduleIdsWithPeers, true);
}
