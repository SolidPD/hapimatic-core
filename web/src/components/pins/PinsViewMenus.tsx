// SPDX-License-Identifier: AGPL-3.0-only
import { Fragment } from "react";
import type {
  PinsViewDirection,
  PinsViewFacet,
  PinsViewFilters,
  PinsViewGroup,
  PinsViewSort,
} from "@hapi/protocol/schemas";
import { FilterIcon, SortIcon } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MenuHeader,
  MenuRadioSection,
  MenuTrigger,
} from "@/components/ui/menuPrimitives";
import {
  PIN_DIRECTION_OPTIONS,
  PIN_FILTER_FACETS,
  PIN_GROUP_OPTIONS,
  PIN_SORT_OPTIONS,
  isFilterActive,
  isSortActive,
} from "@/lib/pins/view";

/**
 * #6451 (R1-R3): the Pins Filter and Sort menus, built from `SearchFilterBar`'s
 * primitives (an anchored `DropdownMenu` aligned to the trigger's end, the
 * scoped-clear `MenuHeader`, one `MenuRadioSection` per facet with "All"
 * first, separators) — never a bottom sheet. The toolbar and the Preferences
 * section both mount them, so the two read the same.
 */

/*
 * The triggers name themselves with `SearchFilterBar`'s `title` attribute, not
 * a tooltip. Checked in a browser (#6451 V9, fixture P4): a Radix tooltip
 * around a menu trigger reopens when the menu closes and hands focus back to
 * the trigger, and stays open until focus moves on.
 */

/**
 * The panel scrolls inside `SearchFilterBar`'s 85vh, or inside the room Radix
 * reports between the trigger and the screen edge when that is less. In
 * Settings the triggers sit mid-page, where a menu flipped above its trigger
 * would otherwise run off the top of a short window (#6451 re-validation).
 */
const MENU_PANEL =
  "max-h-[min(85vh,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto p-0.5";

export function PinsFilterMenu(props: {
  filters: PinsViewFilters;
  onChange: (facet: PinsViewFacet, value: string) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  const active = isFilterActive(props.filters);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <MenuTrigger
          active={active}
          title="Filter pins"
          aria-label="Filter pins"
          disabled={props.disabled}
        >
          <FilterIcon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Filter</span>
        </MenuTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={MENU_PANEL}>
        <MenuHeader
          title="Filter"
          clearLabel="Clear filters"
          showClear={active}
          onClear={props.onClear}
        />
        {PIN_FILTER_FACETS.map(facet => (
          <Fragment key={facet.id}>
            <DropdownMenuSeparator className="my-0.5" />
            <MenuRadioSection
              label={facet.label}
              value={props.filters[facet.id]}
              options={facet.options}
              onChange={value => props.onChange(facet.id, value)}
            />
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PinsSortMenu(props: {
  sort: PinsViewSort;
  dir: PinsViewDirection;
  group: PinsViewGroup;
  onSort: (sort: PinsViewSort) => void;
  onDir: (dir: PinsViewDirection) => void;
  onGroup: (group: PinsViewGroup) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  const active = isSortActive(props);
  const code = PIN_SORT_OPTIONS.find(o => o.value === props.sort)?.code ?? "";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <MenuTrigger
          active={active}
          title="Sort and group pins"
          aria-label="Sort and group pins"
          disabled={props.disabled}
        >
          <SortIcon className="h-3.5 w-3.5" />
          {/* KD2: the two-letter code at every width (mockup v6 :815-819). */}
          <span>{code}</span>
        </MenuTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={MENU_PANEL}>
        <MenuHeader
          title="Sort"
          clearLabel="Clear sort"
          showClear={active}
          onClear={props.onClear}
        />
        <DropdownMenuSeparator className="my-0.5" />
        <MenuRadioSection
          label="Sort by"
          value={props.sort}
          options={PIN_SORT_OPTIONS.map(({ value, label }) => ({
            value,
            label,
          }))}
          onChange={props.onSort}
        />
        <DropdownMenuSeparator className="my-0.5" />
        <MenuRadioSection
          label="Direction"
          value={props.dir}
          options={[...PIN_DIRECTION_OPTIONS]}
          onChange={props.onDir}
        />
        <DropdownMenuSeparator className="my-0.5" />
        <MenuRadioSection
          label="Group by"
          value={props.group}
          options={[...PIN_GROUP_OPTIONS]}
          onChange={props.onGroup}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
