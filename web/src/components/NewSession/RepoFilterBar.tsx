// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Select Repository modal's filter and sort controls (issue #6326). Presentational: the
 * modal owns the settings (`repoFilters.ts`) and passes the derived view in.
 *
 * Built from the design-system primitives: `SegmentedToggle` for the single-choice owner and
 * visibility groups (radiogroups), `Checkbox` for the two on/off filters, `Select` for the
 * sort. The owner row scrolls sideways instead of wrapping, so the sticky header stays one
 * row tall on a phone; everything else sits at the top of the scrolling list.
 */
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { Select } from "@/components/ui/Select";
import type {
  OwnerChip,
  RepoFilters,
  RepoSort,
  RepoVisibility,
  ReportedFields,
} from "./repoFilters";

/** The "All" chip's value. Never a GitHub login: logins cannot contain `*`. */
const ALL_OWNERS = "*";

function ChipLabel(props: { label: string; count: number }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {/* The space keeps the accessible name "SolidPD 36"; flex layout ignores it visually. */}
      {props.label}{" "}
      <span className="text-[var(--app-hint)]">{props.count}</span>
    </span>
  );
}

/** One chip per owner plus "All", each showing how many rows selecting it would show. */
export function OwnerChipRow(props: {
  chips: OwnerChip[];
  allCount: number;
  /** The applied owner (null = every owner). */
  selected: string | null;
  onSelect: (owner: string | null) => void;
}) {
  const { chips, allCount, selected, onSelect } = props;
  const options = [
    {
      value: ALL_OWNERS,
      label: <ChipLabel label="All" count={allCount} />,
    },
    ...chips.map(chip => ({
      value: chip.owner,
      label: <ChipLabel label={chip.owner} count={chip.count} />,
    })),
  ];
  const selectedChip =
    selected === null
      ? ALL_OWNERS
      : (chips.find(c => c.owner.toLowerCase() === selected.toLowerCase())
          ?.owner ?? ALL_OWNERS);
  return (
    <SegmentedToggle
      ariaLabel="Repository owner"
      variant="outline"
      options={options}
      value={selectedChip}
      onChange={value => onSelect(value === ALL_OWNERS ? null : value)}
      testIdPrefix="repo-owner"
      className="scrollbar-none mt-2 flex-nowrap gap-1.5 overflow-x-auto [&>*]:shrink-0"
    />
  );
}

const SORT_LABELS: Record<RepoSort, string> = {
  pushed: "Last active",
  "created-desc": "Recently created",
  "created-asc": "Oldest",
  name: "Name A–Z",
};

const VISIBILITY_OPTIONS: Array<{ value: RepoVisibility; label: string }> = [
  { value: "all", label: "All" },
  { value: "private", label: "Private" },
  { value: "public", label: "Public" },
];

/**
 * Visibility, the two on/off filters, the sort, and the count line. A control whose field no
 * loaded repository reports is left out (`reported`), so nothing is offered that does nothing.
 */
export function RepoFilterControls(props: {
  filters: RepoFilters;
  reported: ReportedFields;
  /** "Showing N of M" / "Showing N of M+". */
  countText: string;
  /** Explains a "+" count: only the most recently pushed repositories are loaded. */
  countTitle?: string;
  /** Owner, visibility or forks differ from their defaults. */
  showClear: boolean;
  onChange: (patch: Partial<RepoFilters>) => void;
  onClearOther: () => void;
}) {
  const { filters, reported, countText, countTitle, showClear } = props;
  const sorts = (Object.keys(SORT_LABELS) as RepoSort[]).filter(
    sort =>
      reported.created || (sort !== "created-desc" && sort !== "created-asc")
  );
  return (
    <div className="flex flex-col gap-1.5 px-1 pb-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <SegmentedToggle
          ariaLabel="Visibility"
          variant="outline"
          options={VISIBILITY_OPTIONS}
          value={filters.visibility}
          onChange={visibility => props.onChange({ visibility })}
          testIdPrefix="repo-visibility"
          className="gap-1"
        />
        {reported.fork && (
          <label className="inline-flex items-center gap-1.5 text-xs text-[var(--app-fg)]">
            <Checkbox
              checked={filters.hideForks}
              onChange={e => props.onChange({ hideForks: e.target.checked })}
            />
            Hide forks
          </label>
        )}
        {reported.archived && (
          <label className="inline-flex items-center gap-1.5 text-xs text-[var(--app-fg)]">
            <Checkbox
              checked={filters.showArchived}
              onChange={e => props.onChange({ showArchived: e.target.checked })}
            />
            Show archived
          </label>
        )}
        <Select
          aria-label="Sort repositories"
          value={filters.sort}
          onChange={e => props.onChange({ sort: e.target.value as RepoSort })}
          className="h-[var(--control-sm)] w-auto px-2 text-xs"
        >
          {sorts.map(sort => (
            <option key={sort} value={sort}>
              {SORT_LABELS[sort]}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-[var(--app-hint)]">
        <span title={countTitle}>{countText}</span>
        {showClear && (
          <>
            <span aria-hidden="true">·</span>
            <Button
              type="button"
              variant="ghostStatic"
              size="bare"
              onClick={props.onClearOther}
              className="text-xs text-[var(--app-link)] hover:underline"
            >
              Clear filters
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
