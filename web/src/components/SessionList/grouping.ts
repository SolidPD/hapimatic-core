// SPDX-License-Identifier: AGPL-3.0-only
// Session grouping + pure display helpers.
// Extracted from SessionList.tsx (issue #2083, epic #2077 F) — verbatim move,
// re-exported through the SessionList barrel to preserve public import paths.
import { LOCAL_NODE_ID } from "@hapi/protocol";
import type { SessionSummary } from "@/types/api";

export type FilterView = "all" | "sessions" | "schedules";

export type SessionGroup = {
  /**
   * Node-aware grouping key `<nodeId>\u0000<baseKey>` (#3877). The base is
   * repoIdentity.name (e.g., "MattStarfield/rp1-home") or a directory path; the
   * nodeId prefix keeps same-path/repo sessions on DIFFERENT federation nodes in
   * distinct groups. Opaque — never split back apart (use `baseKey`/`nodeId`).
   */
  groupKey: string;
  /**
   * Federation node this group belongs to (#3877). `LOCAL_NODE_ID` when federation
   * is off or the session was never node-enriched.
   */
  nodeId: string;
  /** Node label for header disambiguation (from the enriching session; may be absent). #3877 */
  nodeLabel?: string;
  /**
   * The node's URL + connectivity status (from the enriching session), so the
   * header's Node Badge resolves the SAME color the session rows' badge does: a
   * badge with no `nodeUrl` reads as the local hub and renders muted gray.
   */
  nodeUrl?: string;
  nodeStatus?: SessionSummary["nodeStatus"];
  /**
   * Node-blind base of the group key — repoIdentity.name / basePath / path (#3877).
   * Drives `displayName` and the expand-state migration read (it equals the
   * pre-#3877 group key).
   */
  baseKey: string;
  /** Directory path (for line 2 display and fallback grouping) */
  directory: string;
  /** Display name for line 1: repo name (e.g., "rp1-home") or folder name */
  displayName: string;
  /** Repo web URL if available (for clickable link) */
  repoUrl?: string;
  /** Whether this group is backed by a git repo */
  isRepo: boolean;
  sessions: SessionSummary[];
  latestUpdatedAt: number;
  hasActiveSession: boolean;
  /**
   * Managed peers spawned by a PM that lives in a DIFFERENT group (#3265, Sub B).
   * Each such peer is a `spawn` child whose `parentSessionId` resolves to a PM in
   * another project group. These sessions ALSO remain in `sessions` (dual-membership)
   * — this field only FLAGS them so the container renders them under a collapsible
   * "managed peers" subheading beneath this project's header, rather than as
   * anonymous top-level clusters. Grouped by the spawn relationship, never by shared
   * project/branch (R3). Absent/empty when the group has no cross-repo peers.
   */
  crossRepoManagedPeers?: SessionSummary[];
};

// NUL separator (#3877) — cannot appear in a nodeId, filesystem path, or repo name,
// so the composite key is collision-safe and never needs to be split back apart.
const GROUP_KEY_SEP = "\u0000";

/**
 * The federation node a session belongs to for grouping (#3877). Falls back to the
 * `LOCAL_NODE_ID` sentinel when the session carries no nodeId (federation disabled, or
 * a local session that was never hub-enriched) — so single-node grouping is unchanged.
 */
function getSessionNodeId(session: SessionSummary): string {
  return session.nodeId ?? LOCAL_NODE_ID;
}

/**
 * The node-blind base of the group key: repoIdentity.name (owner/repo) for git-backed
 * sessions, else worktree.basePath, else the raw path. This equals the pre-#3877 group
 * key, and is used for `displayName` derivation and the expand-state migration read.
 */
function getSessionBaseKey(session: SessionSummary): string {
  return (
    session.metadata?.repoIdentity?.name ??
    session.metadata?.worktree?.basePath ??
    session.metadata?.path ??
    "Other"
  );
}

/**
 * Get the node-aware project grouping key for a session (#3877): `<nodeId> <baseKey>`.
 * Two sessions sharing the same path/repo on DIFFERENT federation nodes group separately
 * (the bug this fixes); on a single node every session shares the same nodeId prefix, so
 * grouping is identical to the pre-#3877 base-only behavior.
 */
function getSessionGroupKey(session: SessionSummary): string {
  return `${getSessionNodeId(session)}${GROUP_KEY_SEP}${getSessionBaseKey(session)}`;
}

/**
 * Compose a node-aware directory→group lookup key for schedule / pending-spawn /
 * heartbeat attachment in SessionListContainer (#3877). Keyed on (nodeId, directory) so
 * a same-path group on a different node cannot capture another node's schedule or spawn.
 */
export function makeDirGroupLookupKey(
  nodeId: string,
  directory: string
): string {
  return `${nodeId}${GROUP_KEY_SEP}${directory}`;
}

/**
 * Extract the short repo name from an owner/repo string.
 * e.g., "MattStarfield/rp1-home" → "rp1-home"
 */
export function getRepoDisplayName(repoName: string): string {
  const slashIdx = repoName.lastIndexOf("/");
  return slashIdx >= 0 ? repoName.slice(slashIdx + 1) : repoName;
}

/**
 * Get the folder display name from a directory path.
 * e.g., "/home/matt/projects/rp1-home" → "rp1-home"
 */
export function getFolderDisplayName(directory: string): string {
  if (directory === "Other") return directory;
  const parts = directory.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return directory;
  return parts[parts.length - 1];
}

/**
 * Get the short path for the project header subtitle (parent + directory name).
 * e.g., "/home/matt/projects/rp1-home" → "projects/rp1-home"
 *        "/home/matt" → "home/matt"
 *        "/root" → "/root"
 */
export function getShortPath(directory: string): string {
  if (directory === "Other") return directory;
  const parts = directory.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 1) return directory;
  return parts.slice(-2).join("/");
}

/**
 * Sort comparator: active+pending first, then active, then inactive.
 * Within same rank, most recently updated first.
 */
function sessionPriorityCompare(a: SessionSummary, b: SessionSummary): number {
  const rankA = a.active ? (a.pendingRequestsCount > 0 ? 0 : 1) : 2;
  const rankB = b.active ? (b.pendingRequestsCount > 0 ? 0 : 1) : 2;
  if (rankA !== rankB) return rankA - rankB;
  return b.updatedAt - a.updatedAt;
}

/**
 * Flatten sessions into tree order: each parent is followed by its children
 * (recursively). Root sessions keep their priority order; children within
 * each parent are also sorted by priority. Orphans (children whose parent
 * isn't in this group) are appended at the end.
 */
function treeSortSessions(
  sessions: SessionSummary[],
  rootComparator?: (a: SessionSummary, b: SessionSummary) => number
): SessionSummary[] {
  // Build parent → children map
  const childrenMap = new Map<string, SessionSummary[]>();
  const roots: SessionSummary[] = [];

  for (const s of sessions) {
    if (s.parentSessionId) {
      const siblings = childrenMap.get(s.parentSessionId) ?? [];
      siblings.push(s);
      childrenMap.set(s.parentSessionId, siblings);
    } else {
      roots.push(s);
    }
  }

  // Sort roots by the injected comparator when provided (issue #942 — e.g. a
  // non-default sort like Name A→Z), otherwise fall back to the default
  // active/pending-first priority order. Children always keep priority order
  // so branch nesting is unchanged (R11).
  roots.sort(rootComparator ?? sessionPriorityCompare);
  for (const children of childrenMap.values()) {
    children.sort(sessionPriorityCompare);
  }

  // Depth-first walk to flatten tree
  const result: SessionSummary[] = [];
  const visited = new Set<string>();

  function walk(s: SessionSummary): void {
    if (visited.has(s.id)) return;
    visited.add(s.id);
    result.push(s);
    const children = childrenMap.get(s.id);
    if (children) {
      for (const child of children) {
        walk(child);
      }
    }
  }

  for (const root of roots) {
    walk(root);
  }

  // Append orphans whose parent isn't in this group
  for (const s of sessions) {
    if (!visited.has(s.id)) {
      result.push(s);
    }
  }

  return result;
}

/**
 * Decide whether `session` (which lives in the group keyed `thisGroupKey`) is a
 * CROSS-REPO managed peer — a `spawn` child whose PM lives in a different group
 * (#3265, Sub B). Qualifies iff ALL hold:
 *  - it is a managed peer: `parentRelationship === "spawn"` with a `parentSessionId`;
 *  - it is NOT scheduler-spawned — those nest under their schedule row and would
 *    otherwise render twice. Keyed on scheduler PROVENANCE (`source`/`scheduleId`),
 *    not on whether the schedule row currently renders (#2700-safe);
 *  - its PM is PRESENT in the grouping input — an absent PM (deleted, or filtered out
 *    by the active search filter) keeps today's orphan-append path (`treeSortSessions`);
 *  - its PM lives in a DIFFERENT group (the cross-repo condition, R3).
 */
function isCrossRepoManagedPeer(
  session: SessionSummary,
  thisGroupKey: string,
  sessionIdToGroupKey: Map<string, string>,
  presentIds: Set<string>
): boolean {
  if (session.parentRelationship !== "spawn" || !session.parentSessionId) {
    return false;
  }
  if (
    session.metadata?.source === "scheduler" &&
    session.metadata?.scheduleId
  ) {
    return false;
  }
  const parentId = session.parentSessionId;
  if (!presentIds.has(parentId)) return false;
  return sessionIdToGroupKey.get(parentId) !== thisGroupKey;
}

export function groupSessionsByProject(
  sessions: SessionSummary[],
  rootComparator?: (a: SessionSummary, b: SessionSummary) => number
): SessionGroup[] {
  const groups = new Map<
    string,
    {
      sessions: SessionSummary[];
      directory: string;
      repoUrl?: string;
      isRepo: boolean;
      nodeId: string;
      nodeLabel?: string;
      nodeUrl?: string;
      nodeStatus?: SessionSummary["nodeStatus"];
      baseKey: string;
    }
  >();

  // #3265: resolve each session's group key + input-membership up front, so a
  // cross-repo managed peer can locate its PM's group across the whole
  // (search-filtered) grouping input in the per-group pass below.
  const sessionIdToGroupKey = new Map<string, string>();
  const presentIds = new Set<string>();

  sessions.forEach(session => {
    const groupKey = getSessionGroupKey(session);
    sessionIdToGroupKey.set(session.id, groupKey);
    presentIds.add(session.id);
    const repoIdentity = session.metadata?.repoIdentity;
    const directory =
      session.metadata?.worktree?.basePath ?? session.metadata?.path ?? "Other";

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        sessions: [],
        directory,
        repoUrl: repoIdentity?.url,
        isRepo: !!repoIdentity,
        nodeId: getSessionNodeId(session),
        nodeLabel: session.nodeLabel,
        nodeUrl: session.nodeUrl,
        nodeStatus: session.nodeStatus,
        baseKey: getSessionBaseKey(session),
      });
    }
    groups.get(groupKey)!.sessions.push(session);
  });

  return Array.from(groups.entries())
    .map(
      ([
        groupKey,
        {
          sessions: groupSessions,
          directory,
          repoUrl,
          isRepo,
          nodeId,
          nodeLabel,
          nodeUrl,
          nodeStatus,
          baseKey,
        },
      ]) => {
        const sortedSessions = treeSortSessions(groupSessions, rootComparator);
        const latestUpdatedAt = groupSessions.reduce(
          (max, s) => (s.updatedAt > max ? s.updatedAt : max),
          -Infinity
        );
        const hasActiveSession = groupSessions.some(s => s.active);
        // #3877: derive the display name from the node-blind `baseKey`, NOT the
        // composite `groupKey` (which carries the nodeId prefix + NUL separator).
        const displayName = isRepo
          ? getRepoDisplayName(baseKey)
          : getFolderDisplayName(directory);
        // #3265: managed peers whose PM lives in another group. They remain in
        // `sessions` (so ProjectHeader counts and same-group nesting are unchanged)
        // and are additionally flagged here for the "managed peers" subheading.
        const crossRepoManagedPeers = groupSessions.filter(s =>
          isCrossRepoManagedPeer(s, groupKey, sessionIdToGroupKey, presentIds)
        );

        return {
          groupKey,
          nodeId,
          nodeLabel,
          nodeUrl,
          nodeStatus,
          baseKey,
          directory,
          displayName,
          repoUrl,
          isRepo,
          sessions: sortedSessions,
          latestUpdatedAt,
          hasActiveSession,
          crossRepoManagedPeers,
        };
      }
    )
    .sort((a, b) => {
      if (a.hasActiveSession !== b.hasActiveSession) {
        return a.hasActiveSession ? -1 : 1;
      }
      return b.latestUpdatedAt - a.latestUpdatedAt;
    });
}

export function getTodoProgress(
  session: SessionSummary
): { completed: number; total: number } | null {
  if (!session.todoProgress) return null;
  if (session.todoProgress.completed === session.todoProgress.total)
    return null;
  return session.todoProgress;
}
