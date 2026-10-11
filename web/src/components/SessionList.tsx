// SPDX-License-Identifier: AGPL-3.0-only
// Re-export barrel (issue #2083, epic #2077 F). Kept for one release; removed in a follow-up sweep.
// The SessionList container + its presentational/support modules now live in ./SessionList/*.
// Keep this as the .tsx FILE (deliberately NO ./SessionList/index.ts) so external
// "@/components/SessionList" imports resolve to this barrel over the directory.
export type { FilterView, SessionGroup } from "./SessionList/grouping";
export { groupSessionsByProject } from "./SessionList/grouping";
export {
  useProjectExpandState,
  useExpandedSessions,
} from "./SessionList/expandState";
export { SessionList } from "./SessionList/SessionListContainer";
