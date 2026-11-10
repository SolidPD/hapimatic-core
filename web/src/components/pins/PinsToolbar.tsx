// SPDX-License-Identifier: AGPL-3.0-only
import { CalendarDays } from "lucide-react";
import type { PinsViewFacet } from "@hapi/protocol/schemas";
import { SearchInput } from "@/components/ui/SearchInput";
import { menuTriggerClass } from "@/components/ui/menuPrimitives";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import type { PinsViewState } from "@/lib/pins/view";
import type { PinsViewActions } from "@/lib/pins/viewState";
import { cn } from "@/lib/utils";
import { PinsFilterMenu, PinsSortMenu } from "./PinsViewMenus";

/**
 * #6451 (R1, R7): the Pins toolbar — a search field filling the row, then the
 * Filter, Sort and calendar controls in one tight cluster, as in the session
 * list's `SearchFilterBar` row (mockup v6 `.toolbar` :82). It sticks to the
 * top of the Pins scroll box; D's Submit bar sits below that box, so the two
 * never overlap.
 */
export function PinsToolbar(props: {
  view: PinsViewState;
  actions: PinsViewActions;
  search: string;
  onSearchChange: (text: string) => void;
}) {
  const { view, actions } = props;
  const on = view.timeline;
  return (
    <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-[var(--app-divider)] bg-[var(--app-bg)] px-2 py-1.5">
      <SearchInput
        placeholder="Search pins"
        searchText={props.search}
        onSearchTextChange={props.onSearchChange}
      />
      <div className="flex shrink-0 items-center gap-0.5">
        <PinsFilterMenu
          filters={view.filters}
          onChange={(facet: PinsViewFacet, value: string) =>
            actions.setFacet(facet, value)
          }
          onClear={actions.clearFilters}
        />
        <PinsSortMenu
          sort={view.sort}
          dir={view.dir}
          group={view.group}
          onSort={actions.setSort}
          onDir={actions.setDir}
          onGroup={actions.setGroup}
          onClear={actions.clearSort}
        />
        {/* A tap on a phone runs onClick (fixture P3), so the tooltip button
            toggles on the first tap there too. */}
        <HoverTooltipButton
          type="button"
          content={
            on
              ? "Hide the timeline of automatic picks"
              : "Show the timeline of automatic picks"
          }
          aria-label="Timeline of automatic picks"
          aria-pressed={on}
          onClick={() => actions.setTimeline(!on)}
          className={cn(
            menuTriggerClass(false),
            on &&
              "bg-[var(--pins-timeline)]/15 text-[var(--pins-timeline)] hover:bg-[var(--pins-timeline)]/15"
          )}
        >
          <CalendarDays className="h-3.5 w-3.5" aria-hidden />
        </HoverTooltipButton>
      </div>
    </div>
  );
}
