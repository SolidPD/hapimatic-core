// SPDX-License-Identifier: AGPL-3.0-only
// Session clustering for the session list: which sessions nest under a schedule
// row, and how a project's remaining sessions group into parent → children
// clusters. Moved verbatim out of SessionListContainer.tsx to keep the container
// clear of the 1,500-line guardrail (the one change: `crossRepoPeerIds` is now
// exported, because the container still calls it). The container re-exports the
// public helpers, so existing imports of them from that module are unchanged.
import type { SessionSummary } from "@/types/api";
import type { SessionGroup } from "./grouping";

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
export function crossRepoPeerIds(group: SessionGroup): Set<string> {
  return new Set((group.crossRepoManagedPeers ?? []).map(p => p.id));
}
