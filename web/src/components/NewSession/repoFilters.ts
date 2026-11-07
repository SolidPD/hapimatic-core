// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Filter, sort and remember the Create page's repository picker (issue #6326).
 *
 * Pure functions over the loaded list — the server already sends every field these read, and
 * the list is at most a few hundred rows, so all filtering and sorting is client-side.
 *
 * Two rules keep a filter from making a repository look missing (the #6312 symptom):
 *   - a field no loaded repository reports (an older federation peer or gateway) leaves out the
 *     control that depends on it instead of offering a toggle that does nothing
 *     ({@link reportedFields}, {@link effectiveFilters});
 *   - every search result the filters hide is counted, so the picker can say so and offer to
 *     reveal it ({@link RepoView.hiddenByFilters}, {@link RepoView.hiddenArchived}).
 */
import type { GitHubRepo } from "@hapi/protocol/githubRepo";
import { getStorageKey } from "@/lib/storage-keys";
import { repoOwner } from "./cloneDestination";

// Each union is derived from its list, so a value cannot be added to one and missed in the other
// (a sort missing from REPO_SORTS would make sanitizeRepoFilters reset a saved choice).
export const REPO_VISIBILITIES = ["all", "private", "public"] as const;
export const REPO_SORTS = [
  "pushed",
  "created-desc",
  "created-asc",
  "name",
] as const;

export type RepoVisibility = (typeof REPO_VISIBILITIES)[number];
export type RepoSort = (typeof REPO_SORTS)[number];

/** The picker's filter and sort settings, as remembered between visits. */
export interface RepoFilters {
  /** An owner login, or null for every owner. */
  owner: string | null;
  visibility: RepoVisibility;
  hideForks: boolean;
  showArchived: boolean;
  sort: RepoSort;
}

/** First visit: every owner and visibility, forks shown, archived hidden, last active first. */
export const DEFAULT_REPO_FILTERS: Readonly<RepoFilters> = Object.freeze({
  owner: null,
  visibility: "all",
  hideForks: false,
  showArchived: false,
  sort: "pushed",
});

/** Which optional fields at least one loaded repository carries. */
export interface ReportedFields {
  fork: boolean;
  archived: boolean;
  created: boolean;
}

/** One owner chip: the owner as GitHub spells it, and how many rows selecting it would show. */
export interface OwnerChip {
  owner: string;
  count: number;
}

export interface RepoView {
  /** The rows to render: every filter applied, then the search, then the sort. */
  rows: GitHubRepo[];
  /** One chip per owner in the loaded list, in a stable order. */
  ownerChips: OwnerChip[];
  /** The "All" chip's count. */
  allCount: number;
  /**
   * Search matches hidden by the owner, visibility or fork filters — including one that is also
   * archived: clearing those filters then shows it as an archived match.
   */
  hiddenByFilters: number;
  /** Search matches hidden only because archived repositories are hidden. */
  hiddenArchived: number;
}

/** A control is offered when ANY loaded repository reports its field. */
export function reportedFields(repos: readonly GitHubRepo[]): ReportedFields {
  return {
    fork: repos.some(r => r.isFork !== undefined),
    archived: repos.some(r => r.isArchived !== undefined),
    created: repos.some(r => r.createdAt !== undefined),
  };
}

/**
 * The settings actually applied to this list. Never written back to storage, so switching
 * GitHub account (or a list still loading) does not erase the remembered choice.
 *   - an owner absent from the list behaves as "every owner";
 *   - a control whose field no repository reports is neutral (forks shown, archived shown,
 *     the created sorts fall back to last active).
 */
export function effectiveFilters(
  stored: RepoFilters,
  repos: readonly GitHubRepo[],
  reported: ReportedFields
): RepoFilters {
  const ownerKey = stored.owner?.toLowerCase() ?? null;
  const ownerPresent =
    ownerKey !== null &&
    repos.some(r => repoOwner(r.nameWithOwner).toLowerCase() === ownerKey);
  const createdSort =
    stored.sort === "created-desc" || stored.sort === "created-asc";
  return {
    owner: ownerPresent ? stored.owner : null,
    visibility: stored.visibility,
    hideForks: reported.fork ? stored.hideForks : false,
    showArchived: reported.archived ? stored.showArchived : true,
    sort: createdSort && !reported.created ? "pushed" : stored.sort,
  };
}

const collator = new Intl.Collator(undefined, { sensitivity: "base" });

/** Parse an ISO date; a missing or unparseable one is NaN, which every date sort puts last. */
function time(value: string | null | undefined): number {
  return value ? Date.parse(value) : Number.NaN;
}

/** Order two timestamps, newest first (or oldest first), with NaN always last. */
function byTime(a: number, b: number, newestFirst: boolean): number {
  const aMissing = Number.isNaN(a);
  const bMissing = Number.isNaN(b);
  if (aMissing || bMissing)
    return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
  return newestFirst ? b - a : a - b;
}

/** Every sort's last tie-break: `nameWithOwner`, case-insensitively. */
function byFullName(a: GitHubRepo, b: GitHubRepo): number {
  return collator.compare(a.nameWithOwner, b.nameWithOwner);
}

/**
 * The timestamp a date sort reads and its direction, or null for the name sort. The one
 * place a sort mode maps to a field, so the comparator and the pre-parsed sort cannot drift.
 */
function dateSort(
  sort: RepoSort
): { field: "pushedAt" | "createdAt"; newestFirst: boolean } | null {
  switch (sort) {
    case "pushed":
      return { field: "pushedAt", newestFirst: true };
    case "created-desc":
      return { field: "createdAt", newestFirst: true };
    case "created-asc":
      return { field: "createdAt", newestFirst: false };
    case "name":
      return null;
  }
}

/** The comparator for a sort mode; ties break on `nameWithOwner`, case-insensitively. */
export function compareRepos(
  sort: RepoSort
): (a: GitHubRepo, b: GitHubRepo) => number {
  const date = dateSort(sort);
  if (date === null)
    return (a, b) => collator.compare(a.name, b.name) || byFullName(a, b);
  const { field, newestFirst } = date;
  return (a, b) =>
    byTime(time(a[field]), time(b[field]), newestFirst) || byFullName(a, b);
}

/**
 * Sort in place by `sort`. A date sort parses each timestamp once up front instead of twice
 * per comparison (500 rows: ~7,700 `Date.parse` calls on every keystroke otherwise).
 */
function sortRepos(rows: GitHubRepo[], sort: RepoSort): void {
  const date = dateSort(sort);
  if (date === null) {
    rows.sort(compareRepos(sort));
    return;
  }
  const { field, newestFirst } = date;
  const times = new Map(rows.map(r => [r, time(r[field])]));
  rows.sort(
    (a, b) =>
      byTime(
        times.get(a) ?? Number.NaN,
        times.get(b) ?? Number.NaN,
        newestFirst
      ) || byFullName(a, b)
  );
}

/**
 * One pass over the loaded list. A chip's count is what selecting it would show: every
 * other control — visibility, forks, archived and the search text — applies, the owner
 * selection does not. Chips are ordered by each owner's loaded total, so they do not
 * reshuffle while other controls change.
 */
export function deriveRepoView(
  repos: readonly GitHubRepo[],
  filters: RepoFilters,
  query: string
): RepoView {
  const q = query.trim().toLowerCase();
  const ownerKey = filters.owner?.toLowerCase() ?? null;
  const owners = new Map<
    string,
    { owner: string; total: number; count: number }
  >();
  const rows: GitHubRepo[] = [];
  let allCount = 0;
  let hiddenByFilters = 0;
  let hiddenArchived = 0;

  for (const repo of repos) {
    const owner = repoOwner(repo.nameWithOwner);
    const key = owner.toLowerCase();
    let entry = owners.get(key);
    if (!entry) {
      entry = { owner, total: 0, count: 0 };
      owners.set(key, entry);
    }
    entry.total += 1;

    if (q && !repo.nameWithOwner.toLowerCase().includes(q)) continue;

    const passVisibility =
      filters.visibility === "all" ||
      repo.isPrivate === (filters.visibility === "private");
    const passFork = !filters.hideForks || repo.isFork !== true;
    const passArchived = filters.showArchived || repo.isArchived !== true;
    const passOwner = ownerKey === null || key === ownerKey;
    const passOther = passOwner && passVisibility && passFork;

    if (passVisibility && passFork && passArchived) {
      entry.count += 1;
      allCount += 1;
    }
    // A match hidden by both rules counts as hidden by filters, so it is never counted nowhere
    // (#6326 review): Clear filters then shows it as an archived match.
    if (passOther && passArchived) rows.push(repo);
    else if (!passOther) hiddenByFilters += 1;
    else hiddenArchived += 1;
  }

  sortRepos(rows, filters.sort);
  const ownerChips = [...owners.values()]
    .sort((a, b) => b.total - a.total || collator.compare(a.owner, b.owner))
    .map(({ owner, count }) => ({ owner, count }));

  return { rows, ownerChips, allCount, hiddenByFilters, hiddenArchived };
}

/** True when owner, visibility and forks are at their defaults (sort and archived aside). */
export function isDefaultOtherFilters(filters: RepoFilters): boolean {
  return (
    filters.owner === null && filters.visibility === "all" && !filters.hideForks
  );
}

/** "Clear filters": owner, visibility and forks back to their defaults; sort and archived kept. */
export function clearOtherFilters(filters: RepoFilters): RepoFilters {
  return {
    ...filters,
    owner: DEFAULT_REPO_FILTERS.owner,
    visibility: DEFAULT_REPO_FILTERS.visibility,
    hideForks: DEFAULT_REPO_FILTERS.hideForks,
  };
}

/** "Showing N of M", with "M+" when the server stopped at its cap with more available. */
export function formatCount(
  shown: number,
  loaded: number,
  truncated: boolean
): string {
  return `Showing ${shown} of ${loaded}${truncated ? "+" : ""}`;
}

/** Port-scoped, versioned (`getStorageKey` appends the port). */
export const REPO_FILTERS_STORAGE_KEY = "hapi:create:repo-picker-filters:v1";

/** A GitHub login: letters, digits, `.`, `_`, `-`, at most 100 characters. */
const OWNER_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Validate a stored value field by field: an invalid field takes its default, the valid
 * ones are kept, and anything that is not an object yields the defaults.
 */
export function sanitizeRepoFilters(value: unknown): RepoFilters {
  if (!value || typeof value !== "object") return { ...DEFAULT_REPO_FILTERS };
  const v = value as Record<string, unknown>;
  return {
    owner:
      typeof v.owner === "string" && OWNER_PATTERN.test(v.owner)
        ? v.owner
        : DEFAULT_REPO_FILTERS.owner,
    visibility: REPO_VISIBILITIES.includes(v.visibility as RepoVisibility)
      ? (v.visibility as RepoVisibility)
      : DEFAULT_REPO_FILTERS.visibility,
    hideForks:
      typeof v.hideForks === "boolean"
        ? v.hideForks
        : DEFAULT_REPO_FILTERS.hideForks,
    showArchived:
      typeof v.showArchived === "boolean"
        ? v.showArchived
        : DEFAULT_REPO_FILTERS.showArchived,
    sort: REPO_SORTS.includes(v.sort as RepoSort)
      ? (v.sort as RepoSort)
      : DEFAULT_REPO_FILTERS.sort,
  };
}

/** The remembered settings, or the defaults when none are stored or storage is unavailable. */
export function readRepoFilters(): RepoFilters {
  try {
    const raw = localStorage.getItem(getStorageKey(REPO_FILTERS_STORAGE_KEY));
    if (raw === null) return { ...DEFAULT_REPO_FILTERS };
    return sanitizeRepoFilters(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_REPO_FILTERS };
  }
}

export function writeRepoFilters(filters: RepoFilters): void {
  try {
    localStorage.setItem(
      getStorageKey(REPO_FILTERS_STORAGE_KEY),
      JSON.stringify(filters)
    );
  } catch {
    // Storage unavailable (private mode / quota): the settings last for this visit only.
  }
}
