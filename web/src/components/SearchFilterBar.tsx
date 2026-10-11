// SPDX-License-Identifier: AGPL-3.0-only
import { FilterIcon, SortIcon } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  MenuHeader,
  MenuRadioSection,
  MenuTrigger,
} from "@/components/ui/menuPrimitives";
import { SearchInput } from "@/components/ui/SearchInput";
import type { SearchFilterPreferences } from "@hapi/protocol/schemas";

type Filters = SearchFilterPreferences["filters"];

export type NodeFilterOption = { value: string; label: string };

type SearchFilterBarProps = {
  searchText: string;
  filters: Filters;
  sort: SearchFilterPreferences["sort"];
  sortDirection: SearchFilterPreferences["sortDirection"];
  /** Distinct nodes present in the session list (issue #942 R6 — dynamic). */
  nodeOptions: NodeFilterOption[];
  /** Distinct harnesses (session flavor) present in the list (#3810). */
  harnessOptions: NodeFilterOption[];
  /** Distinct bound accounts present in the list (#3810). */
  accountOptions: NodeFilterOption[];
  /** Distinct auth-binding provider ids present in the list (#3810 Phase B). */
  providerOptions: NodeFilterOption[];
  onSearchTextChange: (text: string) => void;
  onFilterStatusChange: (status: Filters["status"]) => void;
  onFilterTypeChange: (type: Filters["type"]) => void;
  onFilterProjectChange: (project: Filters["project"]) => void;
  onFilterNodeChange: (node: string) => void;
  onFilterHarnessChange: (harness: string) => void;
  onFilterAccountChange: (account: string) => void;
  onFilterProviderChange: (provider: string) => void;
  onFilterReviewChange: (review: Filters["review"]) => void;
  onFilterLinkedIssueChange: (linkedIssue: Filters["linkedIssue"]) => void;
  onSortChange: (sort: SearchFilterPreferences["sort"]) => void;
  onSortDirectionChange: (
    direction: SearchFilterPreferences["sortDirection"]
  ) => void;
  onClearAll: () => void;
  /** Reset just the filter groups to default (leaves sort + search). (post-#942) */
  onClearFilters: () => void;
  /** Reset just the sort to default (leaves filters + search). (post-#942) */
  onClearSort: () => void;
  /**
   * #3114: a custom drag order is active and overrides the server sort. While set,
   * the Sort control reads "Manual" and no server-sort option is highlighted;
   * choosing any sort option (or clearing sort) exits Manual via `onSortChange` /
   * `onClearSort`, which the container wires to clear the flag.
   */
  manualSortActive?: boolean;
};

const STATUS_OPTIONS: { value: Filters["status"]; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];
const TYPE_OPTIONS: { value: Filters["type"]; label: string }[] = [
  { value: "all", label: "All" },
  { value: "standard", label: "Standard" },
  { value: "scheduler", label: "Scheduler" },
];
const PROJECT_OPTIONS: { value: Filters["project"]; label: string }[] = [
  { value: "all", label: "All" },
  { value: "repo", label: "GitHub Repo" },
  { value: "directory", label: "Directory Only" },
];
const REVIEW_OPTIONS: { value: Filters["review"]; label: string }[] = [
  { value: "all", label: "All" },
  { value: "needsReview", label: "Needs Review" },
  { value: "read", label: "Read" },
];
const LINKED_OPTIONS: { value: Filters["linkedIssue"]; label: string }[] = [
  { value: "all", label: "All" },
  { value: "hasIssue", label: "Has Issue" },
  { value: "noIssue", label: "No Issue" },
];
const SORT_OPTIONS: {
  value: SearchFilterPreferences["sort"];
  label: string;
  /** #3537: the `< sm` two-letter abbreviation shown on the collapsed sort trigger. */
  abbr: string;
}[] = [
  { value: "updated", label: "Last Active", abbr: "LA" },
  { value: "created", label: "Created", abbr: "Cr" },
  { value: "name", label: "Name", abbr: "Nm" },
  { value: "timeLogged", label: "Time Logged", abbr: "TL" },
];
const DIRECTION_OPTIONS: {
  value: SearchFilterPreferences["sortDirection"];
  label: string;
}[] = [
  { value: "desc", label: "Descending" },
  { value: "asc", label: "Ascending" },
];

// The menu building blocks (MenuTrigger, MenuHeader, MenuRadioSection,
// compact spacing) live in ui/menuPrimitives.tsx — shared with the
// account-usage page's Sort control so every sort surface looks and behaves
// identically. (post-#942, extracted for the account-usage sort unification)

/**
 * Which of the three controls is off its default. Shared with `router.tsx`,
 * which owns the Control Bar's Revert slot (E8/E9): the slot is ALWAYS
 * reserved under the app bar's split icon, and its clear-all control appears
 * only while a filter or a non-default sort is engaged — a search-only
 * engagement is cleared by the Search Field's own ✕, which is always visible
 * now that the field no longer collapses.
 */
export function getSearchFilterEngagement(state: {
  filters: Filters;
  sort: SearchFilterPreferences["sort"];
  sortDirection: SearchFilterPreferences["sortDirection"];
  searchText: string;
  manualSortActive?: boolean;
}): { filtersActive: boolean; sortActive: boolean; searchActive: boolean } {
  const { filters, sort, sortDirection, searchText, manualSortActive } = state;
  const filtersActive =
    filters.status !== "all" ||
    filters.type !== "all" ||
    filters.project !== "all" ||
    filters.node !== "all" ||
    filters.harness !== "all" ||
    filters.account !== "all" ||
    filters.provider !== "all" ||
    filters.review !== "all" ||
    filters.linkedIssue !== "all";
  // #3114: a live custom drag order counts as a non-default sort ("Manual"), so
  // the Sort trigger + the per-menu clear both light up while it is active.
  const sortActive =
    sort !== "updated" || sortDirection !== "desc" || manualSortActive === true;
  return { filtersActive, sortActive, searchActive: searchText.length > 0 };
}

export function SearchFilterBar({
  searchText,
  filters,
  sort,
  sortDirection,
  nodeOptions,
  harnessOptions,
  accountOptions,
  providerOptions,
  onSearchTextChange,
  onFilterStatusChange,
  onFilterTypeChange,
  onFilterProjectChange,
  onFilterNodeChange,
  onFilterHarnessChange,
  onFilterAccountChange,
  onFilterProviderChange,
  onFilterReviewChange,
  onFilterLinkedIssueChange,
  onSortChange,
  onSortDirectionChange,
  onClearAll,
  onClearFilters,
  onClearSort,
  manualSortActive = false,
}: SearchFilterBarProps) {
  const { filtersActive, sortActive } = getSearchFilterEngagement({
    filters,
    sort,
    sortDirection,
    searchText,
    manualSortActive,
  });

  return (
    <div className="flex-1 min-w-0 flex items-center gap-1.5">
      {/* Search Field — ALWAYS the expanded field, filling everything left of the
          Filter/Sort cluster (E8/E9 Control Bar, approved 2026-09-05: "Search
          Field fills the rest"). The #3537 `< sm` magnifier collapse and the #942
          focus-time cluster hide are retired here: nothing in the bar moves. */}
      <SearchInput
        searchText={searchText}
        onSearchTextChange={onSearchTextChange}
      />

      {/* Control cluster — Filter / Sort kept tight together (gap-0.5 = the E9 2px
          icon gap). The Revert (clear-all) control no longer floats after Sort:
          E8/E9 seat it in the Control Bar's icon-row, directly under the app bar's
          split icon (router.tsx `renderPaneToolbar`), so Filter/Sort never move
          when it appears. */}
      <div className="flex items-center gap-0.5 shrink-0">
        {/* Filter dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <MenuTrigger active={filtersActive} title="Filter sessions">
              <FilterIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Filter</span>
            </MenuTrigger>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="max-h-[85vh] overflow-y-auto p-0.5"
          >
            <MenuHeader
              title="Filter"
              clearLabel="Clear filters"
              showClear={filtersActive}
              onClear={onClearFilters}
            />
            <DropdownMenuSeparator className="my-0.5" />
            <MenuRadioSection
              label="Status"
              value={filters.status}
              options={STATUS_OPTIONS}
              onChange={onFilterStatusChange}
            />
            <DropdownMenuSeparator className="my-0.5" />
            <MenuRadioSection
              label="Type"
              value={filters.type}
              options={TYPE_OPTIONS}
              onChange={onFilterTypeChange}
            />
            <DropdownMenuSeparator className="my-0.5" />
            <MenuRadioSection
              label="Project"
              value={filters.project}
              options={PROJECT_OPTIONS}
              onChange={onFilterProjectChange}
            />
            <DropdownMenuSeparator className="my-0.5" />
            <MenuRadioSection
              label="Node"
              value={filters.node}
              options={[{ value: "all", label: "All" }, ...nodeOptions]}
              onChange={onFilterNodeChange}
            />
            <DropdownMenuSeparator className="my-0.5" />
            <MenuRadioSection
              label="Harness"
              value={filters.harness}
              options={[{ value: "all", label: "All" }, ...harnessOptions]}
              onChange={onFilterHarnessChange}
            />
            <DropdownMenuSeparator className="my-0.5" />
            <MenuRadioSection
              label="Account"
              value={filters.account}
              options={[{ value: "all", label: "All" }, ...accountOptions]}
              onChange={onFilterAccountChange}
            />
            <DropdownMenuSeparator className="my-0.5" />
            <MenuRadioSection
              label="Provider"
              value={filters.provider}
              options={[{ value: "all", label: "All" }, ...providerOptions]}
              onChange={onFilterProviderChange}
            />
            <DropdownMenuSeparator className="my-0.5" />
            <MenuRadioSection
              label="Review"
              value={filters.review}
              options={REVIEW_OPTIONS}
              onChange={onFilterReviewChange}
            />
            <DropdownMenuSeparator className="my-0.5" />
            <MenuRadioSection
              label="Linked Issue"
              value={filters.linkedIssue}
              options={LINKED_OPTIONS}
              onChange={onFilterLinkedIssueChange}
            />
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Sort dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <MenuTrigger active={sortActive} title="Sort sessions">
              <SortIcon className="h-3.5 w-3.5" />
              {/* #3537: always names the active sort — full label ≥ sm, the two-letter
                  abbreviation < sm (paired breakpoint spans so the trigger is never
                  empty), "Manual"/"Mn" while a drag order governs the list (#3114). */}
              <span className="hidden sm:inline">
                {manualSortActive
                  ? "Manual"
                  : (SORT_OPTIONS.find(o => o.value === sort)?.label ?? "Sort")}
              </span>
              <span className="sm:hidden">
                {manualSortActive
                  ? "Mn"
                  : (SORT_OPTIONS.find(o => o.value === sort)?.abbr ?? "")}
              </span>
            </MenuTrigger>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="p-0.5">
            <MenuHeader
              title="Sort"
              clearLabel="Clear sort"
              showClear={sortActive}
              onClear={onClearSort}
            />
            <DropdownMenuSeparator className="my-0.5" />
            {/* #3114: while a drag order is active, "Manual" is the effective sort —
                surface it in mint and highlight no server-sort option; picking one
                (below) exits Manual via onSortChange. */}
            {manualSortActive && (
              <>
                <DropdownMenuLabel className="py-0.5 text-[var(--app-accent)]">
                  Manual (drag order)
                </DropdownMenuLabel>
                <DropdownMenuSeparator className="my-0.5" />
              </>
            )}
            <MenuRadioSection
              label="Sort by"
              value={manualSortActive ? "__manual__" : sort}
              options={SORT_OPTIONS}
              onChange={onSortChange}
            />
            <DropdownMenuSeparator className="my-0.5" />
            <MenuRadioSection
              label="Direction"
              value={sortDirection}
              options={DIRECTION_OPTIONS}
              onChange={onSortDirectionChange}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
