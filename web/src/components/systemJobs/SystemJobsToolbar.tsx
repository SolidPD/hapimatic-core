// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { FilterIcon, SortIcon, RotateCcwIcon } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  MenuHeader,
  MenuRadioSection,
  MenuTrigger,
} from "@/components/ui/menuPrimitives";
import { SearchInput } from "@/components/ui/SearchInput";
import { Toolbar } from "@/components/ui/Toolbar";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_SORT,
  DEFAULT_SORT_DIRECTION,
} from "@/hooks/useSystemJobsPreferences";
import type {
  SystemJobsFilters,
  KindFilter,
  HealthFilter,
  EnabledFilter,
  SortMode,
  SortDirection,
} from "@/lib/systemJobsSearchFilterSort";

export type NodeFilterOption = { value: string; label: string };

/**
 * The System Jobs search/filter/sort toolbar (issue #2599, R2/R3/R4).
 *
 * Composed from the SAME primitives as `SearchFilterBar` (`SearchInput` +
 * shadcn `DropdownMenu` + `menuPrimitives`) — the exact pattern `account-usage`
 * already uses — so visuals are byte-identical to the session toolbar with ZERO
 * change to `SearchFilterBar`'s session consumers ("compose, don't generalize",
 * epic CF-5). Node options are supplied dynamically, like the session bar's.
 */

const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "systemd-timer", label: "systemd timer" },
  { value: "in-process-loop", label: "In-process loop" },
  { value: "os-cron", label: "OS cron" },
  { value: "loop-cron", label: "Loop cron" },
  { value: "scheduled-session", label: "Scheduled session" },
];
const HEALTH_OPTIONS: { value: HealthFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "healthy", label: "Healthy" },
  { value: "warning", label: "Warning" },
  { value: "unhealthy", label: "Unhealthy" },
];
const ENABLED_OPTIONS: { value: EnabledFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled or paused" },
];
const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "next", label: "Next run" },
  { value: "last", label: "Last run" },
  { value: "health", label: "Health severity" },
];
const DIRECTION_OPTIONS: { value: SortDirection; label: string }[] = [
  { value: "asc", label: "Ascending" },
  { value: "desc", label: "Descending" },
];

type SystemJobsToolbarProps = {
  searchText: string;
  filters: SystemJobsFilters;
  sort: SortMode;
  sortDirection: SortDirection;
  /** Distinct federation nodes present in the aggregate (dynamic). */
  nodeOptions: NodeFilterOption[];
  onSearchTextChange: (text: string) => void;
  onKindChange: (kind: KindFilter) => void;
  onHealthChange: (health: HealthFilter) => void;
  onNodeChange: (node: string) => void;
  onEnabledChange: (enabled: EnabledFilter) => void;
  onSortChange: (sort: SortMode) => void;
  onSortDirectionChange: (direction: SortDirection) => void;
  onClearAll: () => void;
  onClearFilters: () => void;
  onClearSort: () => void;
};

export function SystemJobsToolbar({
  searchText,
  filters,
  sort,
  sortDirection,
  nodeOptions,
  onSearchTextChange,
  onKindChange,
  onHealthChange,
  onNodeChange,
  onEnabledChange,
  onSortChange,
  onSortDirectionChange,
  onClearAll,
  onClearFilters,
  onClearSort,
}: SystemJobsToolbarProps) {
  // On mobile, hide the Filter/Sort/Reset cluster while the search is focused
  // so the field expands into it; `SearchInput` reports focus via onFocusChange.
  const [focused, setFocused] = useState(false);

  const filtersActive =
    filters.kind !== "all" ||
    filters.health !== "all" ||
    filters.node !== "all" ||
    filters.enabled !== "all";
  const sortActive =
    sort !== DEFAULT_SORT || sortDirection !== DEFAULT_SORT_DIRECTION;
  // Shown only when a filter or sort is engaged — a search-only state is cleared
  // via the field's own X, so the reset would be redundant there.
  const showReset = filtersActive || sortActive;

  return (
    // #3032 Sub D — migrated to the shared `Toolbar` composite (behavior-preserving
    // shell extraction; the filter/sort vocabularies stay local per epic CF-5).
    <Toolbar
      className="flex-1 min-w-0"
      collapseEndWhenFocused
      focused={focused}
      start={
        <SearchInput
          searchText={searchText}
          onSearchTextChange={onSearchTextChange}
          onFocusChange={setFocused}
        />
      }
      end={
        <>
          {/* Filter dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <MenuTrigger active={filtersActive} title="Filter system jobs">
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
                label="Kind"
                value={filters.kind}
                options={KIND_OPTIONS}
                onChange={onKindChange}
              />
              <DropdownMenuSeparator className="my-0.5" />
              <MenuRadioSection
                label="Health"
                value={filters.health}
                options={HEALTH_OPTIONS}
                onChange={onHealthChange}
              />
              <DropdownMenuSeparator className="my-0.5" />
              <MenuRadioSection
                label="Node"
                value={filters.node}
                options={[{ value: "all", label: "All" }, ...nodeOptions]}
                onChange={onNodeChange}
              />
              <DropdownMenuSeparator className="my-0.5" />
              <MenuRadioSection
                label="Enabled"
                value={filters.enabled}
                options={ENABLED_OPTIONS}
                onChange={onEnabledChange}
              />
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Sort dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <MenuTrigger active={sortActive} title="Sort system jobs">
                <SortIcon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Sort</span>
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
              <MenuRadioSection
                label="Sort by"
                value={sort}
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

          {showReset && (
            <Button
              type="button"
              variant="ghost"
              onClick={onClearAll}
              className="flex h-auto items-center rounded-md px-2 py-1 text-xs hover:bg-[var(--app-secondary-bg)]"
              title="Clear all filters, search, and sort"
              aria-label="Clear all filters, search, and sort"
            >
              <RotateCcwIcon className="h-3.5 w-3.5" />
            </Button>
          )}
        </>
      }
    />
  );
}
