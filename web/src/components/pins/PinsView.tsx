// SPDX-License-Identifier: AGPL-3.0-only
import {
  Fragment,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { PIN_LIST_MAX_LIMIT } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { CompletedPinRow } from "@/components/pins/CompletedPinRow";
import { PinRow } from "@/components/pins/PinRow";
import { PinsSection } from "@/components/pins/PinsSection";
import { PinsTimeline } from "@/components/pins/PinsTimeline";
import { PinsToolbar } from "@/components/pins/PinsToolbar";
import { useArmedRows } from "@/components/pins/useArmedRows";
import {
  flashRow,
  PinsContext,
  useMinuteClock,
  type PinsContextValue,
} from "@/components/pins/pinsShared";
import { ProjectManagersSection } from "@/components/pins/ProjectManagersSection";
import { Button } from "@/components/ui/button";
import { useMarkPinSeen, usePins, useStarPin } from "@/hooks/queries/usePins";
import { usePinsViewDefaults } from "@/hooks/usePinsViewDefaults";
import { usePinDeadlineOf } from "@/lib/pins/deadline";
import { formatPinAge, formatPinTime, toPinViewModel } from "@/lib/pins/ledger";
import { useStagedPins } from "@/lib/pins/staging";
import { resolvePinZone } from "@/lib/pins/zoneTime";
import {
  buildPinsView,
  hasEvidenceFiles,
  noReviewComments,
  type PinViewSection,
  type PinsViewContext,
} from "@/lib/pins/view";
import { usePinsViewState } from "@/lib/pins/viewState";

/** A section with no entry is open, except Completed, which starts closed (R4). */
function isSectionOpen(
  open: Readonly<Record<string, boolean>>,
  id: string
): boolean {
  return open[id] ?? id !== "completed";
}

const NO_KEYS: ReadonlySet<string> = new Set();
function EmptyLine(props: { children: ReactNode }) {
  return (
    <div className="px-2.5 py-3.5 text-center text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
      {props.children}
    </div>
  );
}

/**
 * #6449: the Ledger's sections and rows, with controlled expansion — the seam
 * G's `?pin=` deep link and E's timeline scroll-and-flash drive. Every row has
 * the stable id `pin-row-<key>`. #6451: the sections come from the toolbar's
 * view, and their open state is lifted to `PinsView` so a timeline click can
 * open a section. `layoutKey` changes with the facets, the search and the
 * grouping; each change disarms the rows, so a bulk remount does not mount
 * every row's tooltips at once.
 */
export const PinsList = memo(function PinsList(props: {
  sections: readonly PinViewSection[];
  expandedKeys: ReadonlySet<string>;
  onExpandedChange: (key: string, expanded: boolean) => void;
  onStar: (key: string, starred: boolean) => void;
  openSections: Readonly<Record<string, boolean>>;
  onToggleSection: (id: string) => void;
  now: number;
  /** #6452: the zone the row tooltips use (`PinsContext.timeZone`). */
  timeZone: string;
  layoutKey: string;
  /** The scroll box the rows move in, for arming their tooltips ahead of view. */
  scrollRoot?: Element | null;
  /**
   * #6454: rendered just before the first Completed section, or last when there
   * is none: the Project Managers section sits between Action Items and
   * Completed (mockup v6).
   */
  beforeCompleted?: ReactNode;
}) {
  const { sections, expandedKeys, onExpandedChange, onStar, now, timeZone } =
    props;
  const { armed, observe, reset } = useArmedRows(props.scrollRoot ?? null);
  // Reset in the render that changes the list, so no row mounts armed.
  const [layoutKey, setLayoutKey] = useState(props.layoutKey);
  if (layoutKey !== props.layoutKey) {
    setLayoutKey(props.layoutKey);
    reset();
  }
  // Read through a ref so the handler stays stable and an expand re-renders
  // only the row that changed (the rows are memoized).
  const expandedRef = useRef(expandedKeys);
  expandedRef.current = expandedKeys;
  const toggleRow = useCallback(
    (key: string) => onExpandedChange(key, !expandedRef.current.has(key)),
    [onExpandedChange]
  );
  const firstCompleted = sections.findIndex(section => section.completed);
  return (
    <>
      {sections.map((section, index) => {
        const open = isSectionOpen(props.openSections, section.id);
        return (
          <Fragment key={section.id}>
            {index === firstCompleted ? props.beforeCompleted : null}
            <PinsSection
              id={section.id}
              look={section.look}
              kind={section.kind}
              title={section.title}
              count={section.pins.length}
              open={open}
              onToggle={props.onToggleSection}
            >
              {section.pins.length === 0 ? (
                <EmptyLine>Nothing here</EmptyLine>
              ) : section.completed ? (
                section.pins.map(model => (
                  <CompletedPinRow
                    key={model.pin.key}
                    model={model}
                    expanded={expandedKeys.has(model.pin.key)}
                    armed={armed.has(model.pin.key)}
                    onToggle={toggleRow}
                    observe={observe}
                  />
                ))
              ) : (
                section.pins.map(model => (
                  <PinRow
                    key={model.pin.key}
                    model={model}
                    expanded={expandedKeys.has(model.pin.key)}
                    ageLabel={formatPinAge(model.pin.createdAt, now)}
                    ageTooltip={`Raised ${formatPinTime(model.pin.createdAt, timeZone)}`}
                    armed={armed.has(model.pin.key)}
                    onToggle={toggleRow}
                    onStar={onStar}
                    observe={observe}
                  />
                ))
              )}
            </PinsSection>
          </Fragment>
        );
      })}
      {firstCompleted === -1 ? props.beforeCompleted : null}
    </>
  );
});

/**
 * #6449: the Pins view — the session's pins as the Ledger (R4-R15): sections
 * outlined (H2), each row one line. `usePins` → `toPinViewModel` in one memo
 * keyed on the list, so an unchanged pin keeps its view model and its
 * memoized row. #6451: the toolbar's search, facets, sort and grouping
 * (`buildPinsView`), the view saved per session (`usePinsViewState`) over the
 * Preferences defaults, and the timeline of automatic picks. Mount it keyed
 * by session: the route keys it, so nothing carries over between sessions.
 */
export function PinsView(props: {
  api: ApiClient | null;
  sessionId: string;
  sessionActive: boolean;
  /** False until the page's gate has settled open. */
  enabled: boolean;
  /** The page's scroll box (see `PinsList`). */
  scrollRoot?: Element | null;
  /** #6453 (R12): a pin to reveal once the list has loaded (`?pin=`). */
  revealKey?: string;
  /** Called once `revealKey` has been handed to the reveal, so the page can clear it. */
  onRevealConsumed?: () => void;
}) {
  const { api, sessionId, scrollRoot, revealKey, onRevealConsumed } = props;
  const query = usePins(api, sessionId, props.enabled);
  const starPin = useStarPin(api, sessionId);
  const markSeen = useMarkPinSeen(api, sessionId);
  const now = useMinuteClock();
  const deadlineOf = usePinDeadlineOf();
  const listZone =
    query.data?.kind === "ready" ? (query.data.timeZone ?? null) : null;
  const zone = useMemo(() => resolvePinZone(listZone), [listZone]);
  const { defaults } = usePinsViewDefaults(api);
  const { view, actions } = usePinsViewState(sessionId, defaults);
  // D's staging is read unconditionally (hooks), but it feeds the view only
  // while the Answer state facet is set, so staging edits do not rebuild it.
  const staged = useStagedPins(sessionId);

  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(NO_KEYS);
  // R9, R11: rows listed whatever the facets say — an expanded row (so marking
  // it seen or staging its answer cannot pull it away) and a revealed one.
  const [held, setHeld] = useState<ReadonlySet<string>>(NO_KEYS);
  const facetKey = JSON.stringify(view.filters);
  const [heldFor, setHeldFor] = useState({ facetKey, search });
  if (heldFor.facetKey !== facetKey || heldFor.search !== search) {
    setHeldFor({ facetKey, search });
    setHeld(NO_KEYS);
  }
  const [openSections, setOpenSections] = useState<
    Readonly<Record<string, boolean>>
  >({});
  const [pendingReveal, setPendingReveal] = useState<string | null>(null);

  const hold = useCallback((key: string) => {
    setHeld(prev => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, []);
  const onExpandedChange = useCallback(
    (key: string, on: boolean) => {
      if (on) hold(key);
      setExpanded(prev => {
        if (prev.has(key) === on) return prev;
        const next = new Set(prev);
        if (on) next.add(key);
        else next.delete(key);
        return next;
      });
    },
    [hold]
  );
  const onToggleSection = useCallback((id: string) => {
    setOpenSections(prev => ({ ...prev, [id]: !isSectionOpen(prev, id) }));
  }, []);
  // Stable, so the memoized timeline never re-renders for it.
  const revealPin = useCallback(
    (key: string) => {
      hold(key);
      setPendingReveal(key);
    },
    [hold]
  );

  const pins = query.data?.kind === "ready" ? query.data.pins : null;
  const models = useMemo(
    () => (pins ? pins.map(toPinViewModel) : null),
    [pins]
  );
  // `now` and staging feed the view only when it reads them, so the list is
  // not rebuilt each minute or on each staging edit.
  const viewNow =
    view.filters.deadline === "soon" || view.group === "window" ? now : 0;
  const viewStaged = view.filters.answer !== "all" ? staged : null;
  const ctx = useMemo<PinsViewContext>(
    () => ({
      sessionId,
      now: viewNow,
      deadlineOf,
      staged: viewStaged,
      hasReviewComments: noReviewComments,
      hasFiles: hasEvidenceFiles,
      held,
    }),
    [sessionId, viewNow, deadlineOf, viewStaged, held]
  );
  const built = useMemo(
    () => (models ? buildPinsView(models, view, deferredSearch, ctx) : null),
    [models, view, deferredSearch, ctx]
  );
  const layoutKey = `${facetKey}|${deferredSearch}|${view.group}`;

  // #6453 (R12): a `?pin=` link reveals its pin once per key, through the same
  // path as the timeline; an unknown key is cleared silently by the layout
  // effect below.
  const revealedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!revealKey) {
      revealedKey.current = null;
      return;
    }
    if (!built || revealedKey.current === revealKey) return;
    revealedKey.current = revealKey;
    revealPin(revealKey);
    onRevealConsumed?.();
  }, [revealKey, built, revealPin, onRevealConsumed]);

  // R9: once a revealed pin is listed, open its section, then scroll its row
  // into view and flash it.
  useLayoutEffect(() => {
    if (!pendingReveal || !built) return;
    const section = built.sections.find(s =>
      s.pins.some(m => m.pin.key === pendingReveal)
    );
    if (!section) {
      setPendingReveal(null); // the pin is gone
      return;
    }
    if (!isSectionOpen(openSections, section.id)) {
      setOpenSections(prev => ({ ...prev, [section.id]: true }));
      return;
    }
    const row = document.getElementById(`pin-row-${pendingReveal}`);
    if (!row) return;
    setPendingReveal(null);
    // A long smooth scroll arms every row it passes and can outlast the
    // flash, so a row more than two screens away is jumped to.
    const box = scrollRoot?.getBoundingClientRect();
    const height = box?.height || window.innerHeight;
    const middle = (box?.top ?? 0) + height / 2;
    const far = Math.abs(row.getBoundingClientRect().top - middle) > 2 * height;
    row.scrollIntoView({ block: "center", behavior: far ? "auto" : "smooth" });
    flashRow(row);
  }, [pendingReveal, built, openSections, scrollRoot]);

  const context = useMemo<PinsContextValue>(
    () => ({
      api,
      sessionId,
      sessionActive: props.sessionActive,
      markSeen,
      via: "pins",
      timeZone: zone,
    }),
    [api, sessionId, props.sessionActive, markSeen, zone]
  );

  const clearAll = useCallback(() => {
    actions.clearFilters();
    setSearch("");
  }, [actions]);

  // #6454: dashboards are not pins, so the toolbar's facets and search never
  // apply to the Project Managers section.
  const projectManagers = (
    <ProjectManagersSection
      api={api}
      sessionId={sessionId}
      open={isSectionOpen(openSections, "pm")}
      onToggle={onToggleSection}
      scrollRoot={scrollRoot}
    />
  );

  if (query.isPending) {
    return <EmptyLine>Loading pins…</EmptyLine>;
  }
  if (query.isError) {
    return (
      <EmptyLine>
        {query.error instanceof Error
          ? `Pins could not load: ${query.error.message}`
          : "Pins could not load"}
      </EmptyLine>
    );
  }
  if (query.data.kind === "unavailable" || !built || !models) {
    return <PinsUnavailable />;
  }
  return (
    <PinsContext.Provider value={context}>
      <PinsToolbar
        view={view}
        actions={actions}
        search={search}
        onSearchChange={setSearch}
      />
      {view.timeline ? (
        <PinsTimeline
          models={models}
          now={now}
          deadlineOf={deadlineOf}
          zone={zone}
          onGo={revealPin}
        />
      ) : null}
      <div className="pb-3">
        {built.shown === 0 && built.filtered ? (
          <EmptyLine>
            No pins match.{" "}
            <Button
              type="button"
              variant="ghostStatic"
              size="bare"
              onClick={clearAll}
              className="text-[length:var(--text-body-dense)] text-[var(--app-link)] hover:underline"
            >
              Clear filters and search
            </Button>
          </EmptyLine>
        ) : null}
        {built.shown === 0 && built.filtered ? (
          projectManagers
        ) : (
          <PinsList
            sections={built.sections}
            expandedKeys={expanded}
            onExpandedChange={onExpandedChange}
            onStar={starPin}
            openSections={openSections}
            onToggleSection={onToggleSection}
            now={now}
            timeZone={zone}
            layoutKey={layoutKey}
            scrollRoot={scrollRoot}
            beforeCompleted={projectManagers}
          />
        )}
        {query.data.hasMore ? (
          <EmptyLine>
            {`Not every pin is shown: the list stops at ${PIN_LIST_MAX_LIMIT}`}
          </EmptyLine>
        ) : null}
      </div>
    </PinsContext.Provider>
  );
}

/** R19: the session's node cannot serve pins. */
export function PinsUnavailable() {
  return <EmptyLine>Pins are not available for this session</EmptyLine>;
}
