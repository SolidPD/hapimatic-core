// SPDX-License-Identifier: AGPL-3.0-only
import { Pin } from "lucide-react";
import type { ApiClient } from "@/api/client";
import { PinsFilterMenu, PinsSortMenu } from "@/components/pins/PinsViewMenus";
import { IconSectionHeading } from "@/components/settings/IconSectionHeading";
import { tokens } from "@/design/tokens";
import { usePinsViewDefaults } from "@/hooks/usePinsViewDefaults";
import {
  PIN_DIRECTION_OPTIONS,
  PIN_FILTER_FACETS,
  PIN_GROUP_OPTIONS,
  PIN_SORT_OPTIONS,
  type PinsViewState,
} from "@/lib/pins/view";
import { resolvePinsView } from "@/lib/pins/viewState";

/** One line saying what a session with no saved choice opens with. */
export function pinsDefaultsSummary(view: PinsViewState): string {
  const facets = PIN_FILTER_FACETS.flatMap(facet => {
    const value = view.filters[facet.id];
    if (value === "all") return [];
    return facet.options.find(o => o.value === value)?.label ?? [];
  });
  const sort = PIN_SORT_OPTIONS.find(o => o.value === view.sort)?.label;
  const dir = PIN_DIRECTION_OPTIONS.find(o => o.value === view.dir)?.label;
  const group =
    view.group === "none"
      ? "not grouped"
      : `grouped by ${PIN_GROUP_OPTIONS.find(o => o.value === view.group)?.label}`;
  return [
    facets.length > 0 ? facets.join(" · ") : "Everything",
    `${sort}, ${dir?.toLowerCase()}`,
    group,
  ].join(" · ");
}

/**
 * #6451 (R6): the Pins tab's defaults — the filters, sort, direction and
 * grouping a session opens with until the operator changes them there. They
 * are the federation setting `pinsView`, so they follow the operator to every
 * node. The toolbar's own menus edit them (KD8), which keeps the section to
 * one row on a phone; a menu's clear removes its fields, so they fall back to
 * the built-in view. Mounted only while the Pins gate is open.
 */
export function PinsDefaultsSection(props: { api: ApiClient | null }) {
  const { defaults, ready, setDefaults } = usePinsViewDefaults(props.api);
  const view = resolvePinsView({}, defaults);
  return (
    <section
      id="pins"
      aria-label="Pins"
      className="flex scroll-mt-2 flex-col gap-3 border-t border-[var(--app-border)] pt-6"
    >
      <IconSectionHeading icon={Pin} accent={tokens.view.pins} title="Pins" />
      <p className="text-xs text-[var(--app-hint)]">
        The view a session&rsquo;s Pins tab opens with until you change it
        there.
      </p>
      <div className="flex min-w-0 items-center gap-0.5">
        <PinsFilterMenu
          filters={view.filters}
          onChange={(facet, value) =>
            setDefaults({ filters: { [facet]: value } })
          }
          onClear={() => setDefaults({ filters: null })}
          disabled={!ready}
        />
        <PinsSortMenu
          sort={view.sort}
          dir={view.dir}
          group={view.group}
          onSort={sort => setDefaults({ sort })}
          onDir={dir => setDefaults({ dir })}
          onGroup={group => setDefaults({ group })}
          onClear={() => setDefaults({ sort: null, dir: null, group: null })}
          disabled={!ready}
        />
        <span
          data-testid="pins-defaults-summary"
          className="ml-1.5 min-w-0 truncate text-xs text-[var(--app-hint)]"
        >
          {pinsDefaultsSummary(view)}
        </span>
      </div>
    </section>
  );
}
