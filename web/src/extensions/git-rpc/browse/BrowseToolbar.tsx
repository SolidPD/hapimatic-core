// SPDX-License-Identifier: AGPL-3.0-only
import { SortIcon } from "@/components/icons";
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
  DEFAULT_SORT,
  type BrowseSort,
  type SortDir,
  type SortKey,
} from "./browseModel";

const SORT_KEY_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "modified", label: "Date modified" },
  { value: "size", label: "Size" },
];

const SORT_DIR_OPTIONS: { value: SortDir; label: string }[] = [
  { value: "asc", label: "Ascending" },
  { value: "desc", label: "Descending" },
];

const HIDDEN_OPTIONS: { value: "hide" | "show"; label: string }[] = [
  { value: "hide", label: "Hide" },
  { value: "show", label: "Show" },
];

const isDefaultView = (sort: BrowseSort, showHidden: boolean) =>
  sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir && !showHidden;

/**
 * #6224 Task 3: the Browse view menu: sort key, order, and whether hidden
 * files show. It is the phone's only sort control; a wider screen also gets
 * the column headers below. Built from the shared sort-menu primitives, so it
 * reads like the session list's Sort menu.
 */
export function BrowseViewMenu(props: {
  sort: BrowseSort;
  showHidden: boolean;
  onSortChange: (sort: BrowseSort) => void;
  onShowHiddenChange: (show: boolean) => void;
}) {
  const nonDefault = !isDefaultView(props.sort, props.showHidden);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <MenuTrigger
          active={nonDefault}
          title="Sort and view options"
          aria-label="Sort and view options"
          className="shrink-0"
        >
          <SortIcon className="h-3.5 w-3.5" />
          <span>Sort</span>
        </MenuTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[12rem]">
        <MenuHeader
          title="Sort"
          clearLabel="Reset sort and hidden files"
          showClear={nonDefault}
          onClear={() => {
            props.onSortChange(DEFAULT_SORT);
            props.onShowHiddenChange(false);
          }}
        />
        <MenuRadioSection
          label="Sort by"
          value={props.sort.key}
          options={SORT_KEY_OPTIONS}
          onChange={key => props.onSortChange({ ...props.sort, key })}
        />
        <MenuRadioSection
          label="Order"
          value={props.sort.dir}
          options={SORT_DIR_OPTIONS}
          onChange={dir => props.onSortChange({ ...props.sort, dir })}
        />
        <DropdownMenuSeparator />
        <MenuRadioSection
          label="Hidden files"
          value={props.showHidden ? "show" : "hide"}
          options={HIDDEN_OPTIONS}
          onChange={value => props.onShowHiddenChange(value === "show")}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ColumnHeader(props: {
  label: string;
  column: SortKey;
  sort: BrowseSort;
  onSortChange: (sort: BrowseSort) => void;
  className: string;
}) {
  const active = props.sort.key === props.column;
  const ariaSort = active
    ? props.sort.dir === "asc"
      ? "ascending"
      : "descending"
    : "none";
  return (
    <div role="columnheader" aria-sort={ariaSort} className={props.className}>
      <button
        type="button"
        onClick={() =>
          props.onSortChange({
            key: props.column,
            // A second click on the sorted column reverses it; a new column
            // starts ascending.
            dir: active && props.sort.dir === "asc" ? "desc" : "asc",
          })
        }
        className={`rounded px-1 py-0.5 transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] ${active ? "text-[var(--app-fg)]" : ""}`}
      >
        {props.label}
        {active ? (
          <span aria-hidden className="ml-1">
            {props.sort.dir === "asc" ? "↑" : "↓"}
          </span>
        ) : null}
      </button>
    </div>
  );
}

/**
 * #6224 Task 3: the wider screen's column headers, as buttons that sort. The
 * widths match `BrowseRow`'s cells. Hidden on a phone, where the menu sorts.
 */
export function BrowseColumnHeaders(props: {
  sort: BrowseSort;
  onSortChange: (sort: BrowseSort) => void;
}) {
  return (
    <div
      role="row"
      className="hidden items-center gap-1 border-b border-[var(--app-divider)] pr-2 text-xs font-semibold text-[var(--app-hint)] sm:flex"
    >
      <ColumnHeader
        label="Name"
        column="name"
        sort={props.sort}
        onSortChange={props.onSortChange}
        className="min-w-0 flex-1 py-1.5 pl-[2.6rem]"
      />
      <ColumnHeader
        label="Modified"
        column="modified"
        sort={props.sort}
        onSortChange={props.onSortChange}
        className="w-28 shrink-0 py-1.5 text-right"
      />
      <ColumnHeader
        label="Size"
        column="size"
        sort={props.sort}
        onSortChange={props.onSortChange}
        className="w-20 shrink-0 py-1.5 text-right"
      />
      {/* Spacer for the action cell: two icons and the menu, 28 px each. */}
      <div role="columnheader" className="w-[5.25rem] shrink-0">
        <span className="sr-only">Actions</span>
      </div>
    </div>
  );
}
