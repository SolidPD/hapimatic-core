// SPDX-License-Identifier: AGPL-3.0-only
import { type Pin, type PinRisk, type PinStakes } from "@hapi/protocol";
import {
  PINS_VIEW_BUILTIN,
  PINS_VIEW_FACETS,
  type PinsViewDirection,
  type PinsViewFacet,
  type PinsViewFilters,
  type PinsViewGroup,
  type PinsViewSort,
} from "@hapi/protocol/schemas";
import { normalizeSearchText } from "@/lib/sessionSearchFilterSort";
import { hasAutomaticPick } from "./deadline";
import {
  COMPLETED_STATUSES,
  completedAnswerText,
  isPinNew,
  PIN_KIND_INDEX,
  pinDecidedBy,
  settlingAnswerNote,
  sortPins,
  type DeadlineOf,
  type PinViewModel,
} from "./ledger";
import type { StagedPins } from "./staging";

/**
 * #6451: the Pins toolbar's view model — the 13 facets, the search, the held
 * rows and the five groupings over C's view models, sorted by `sortPins`.
 * React-free. Behaviour of record: mockup v6 `passes` / `groups` (:643-647,
 * :801-812).
 */

/** A session's view, every field resolved (saved ?? Preferences ?? built-in). */
export type PinsViewState = {
  filters: PinsViewFilters;
  sort: PinsViewSort;
  dir: PinsViewDirection;
  group: PinsViewGroup;
  timeline: boolean;
};

export type PinsViewContext = {
  sessionId: string;
  now: number;
  deadlineOf: DeadlineOf;
  /** D's staging store; null while the Answer state facet is All. */
  staged: StagedPins | null;
  /** K (#6457) fills it. */
  hasReviewComments: (model: PinViewModel) => boolean;
  /** G (#6453) may widen it to pin-folder files. */
  hasFiles: (model: PinViewModel) => boolean;
  /** Rows listed whatever the facets and search say (R9, R11). */
  held: ReadonlySet<string>;
};

export const noReviewComments = (): boolean => false;
export const hasEvidenceFiles = (model: PinViewModel): boolean =>
  model.evidence.length > 0;

export const BUILTIN_FILTERS: PinsViewFilters = PINS_VIEW_BUILTIN.filters;

export const BUILTIN_VIEW: PinsViewState = {
  ...PINS_VIEW_BUILTIN,
  timeline: false,
};

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Facets ──────────────────────────────────────────────────────────────────

export type PinFilterOption = { value: string; label: string };
export type PinFilterFacet = {
  id: PinsViewFacet;
  label: string;
  options: PinFilterOption[];
};

// Label-only, so this module stays free of the React icon map
// (`components/pins/pinsShared.tsx` `pinKindMeta` / `STAKES_META` / `RISK_META`
// hold the same words).
const KIND_LABELS: Record<string, string> = {
  decision: "Decision",
  steps: "Steps",
  variants: "Variants",
  review: "Review",
  dashboard: "Dashboard",
  detected: "Detected",
};
const STAKES_LABELS: Record<PinStakes, string> = {
  irreversible: "Irreversible",
  costly: "Costly to undo",
  reversible: "Reversible",
};
const RISK_LABELS: Record<PinRisk, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function pinKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? (kind || "Pin");
}

const ALL: PinFilterOption = { value: "all", label: "All" };

function facet(
  id: PinsViewFacet,
  label: string,
  options: Array<[string, string]>
): PinFilterFacet {
  return {
    id,
    label,
    options: [ALL, ...options.map(([value, text]) => ({ value, label: text }))],
  };
}

/** The Filter menu, in the mockup's order (:626-640), "All" first in each. */
export const PIN_FILTER_FACETS: readonly PinFilterFacet[] = [
  facet("status", "Status", [
    ["action", "Action Items"],
    ["completed", "Completed"],
  ]),
  facet(
    "kind",
    "Kind",
    PINS_VIEW_FACETS.kind.slice(1).map(kind => [kind, pinKindLabel(kind)])
  ),
  facet("blocking", "Blocking", [
    ["yes", "Blocks work"],
    ["no", "Doesn't block"],
  ]),
  // The tuples run mildest first; the menu reads most severe first.
  facet(
    "stakes",
    "Stakes",
    [...PINS_VIEW_FACETS.stakes.slice(1)]
      .reverse()
      .map(value => [value, STAKES_LABELS[value as PinStakes]])
  ),
  facet(
    "risk",
    "Risk",
    [...PINS_VIEW_FACETS.risk.slice(1)]
      .reverse()
      .map(value => [value, RISK_LABELS[value as PinRisk]])
  ),
  facet("deadline", "Deadline", [
    ["has", "Has an automatic pick"],
    ["soon", "Due within 24 hours"],
    ["none", "None"],
  ]),
  facet("decidedBy", "Completed by", [
    ["operator", "You"],
    ["auto", "Automatically"],
    ["agent", "The agent"],
  ]),
  facet("answer", "Answer state", [
    ["chosen", "Answer chosen, not sent"],
    ["none", "Not answered"],
  ]),
  facet("comments", "Review comments", [["yes", "Has review comments"]]),
  facet("files", "Has files", [["yes", "Has files"]]),
  facet("starred", "Starred", [["yes", "Starred"]]),
  facet("changed", "New or changed", [["yes", "New or changed"]]),
  facet("source", "Source session", [
    ["this", "This session"],
    ["other", "Another session"],
  ]),
];

/** The Sort menu: label and the two-letter trigger code (R3). */
export const PIN_SORT_OPTIONS: ReadonlyArray<{
  value: PinsViewSort;
  label: string;
  code: string;
}> = [
  { value: "priority", label: "Priority", code: "Pr" },
  { value: "deadline", label: "Deadline", code: "Dl" },
  { value: "updated", label: "Last updated", code: "LU" },
  { value: "created", label: "Created", code: "Cr" },
  { value: "kind", label: "Kind", code: "Kd" },
  { value: "title", label: "Title", code: "Ti" },
  { value: "source", label: "Source", code: "Sr" },
];

export const PIN_DIRECTION_OPTIONS: ReadonlyArray<{
  value: PinsViewDirection;
  label: string;
}> = [
  { value: "desc", label: "Descending" },
  { value: "asc", label: "Ascending" },
];

export const PIN_GROUP_OPTIONS: ReadonlyArray<{
  value: PinsViewGroup;
  label: string;
}> = [
  { value: "status", label: "Status" },
  { value: "kind", label: "Kind" },
  { value: "source", label: "Source session" },
  { value: "window", label: "Deadline window" },
  { value: "none", label: "None" },
];

export function isFilterActive(filters: PinsViewFilters): boolean {
  return Object.values(filters).some(value => value !== "all");
}

export function isSortActive(
  view: Pick<PinsViewState, "sort" | "dir" | "group">
): boolean {
  return (
    view.sort !== PINS_VIEW_BUILTIN.sort ||
    view.dir !== PINS_VIEW_BUILTIN.dir ||
    view.group !== PINS_VIEW_BUILTIN.group
  );
}

/** A note or a question alone is not "an answer chosen"; a choice or unsent ticks are. */
function hasStagedAnswer(staged: StagedPins | null, key: string): boolean {
  const entry = staged?.[key];
  if (!entry) return false;
  const ticks = entry.ticks?.length ?? 0;
  return (
    entry.choice !== undefined ||
    (ticks > 0 && ticks !== (entry.ticksSent ?? 0))
  );
}

function isDueSoon(model: PinViewModel, ctx: PinsViewContext): boolean {
  if (!hasAutomaticPick(model)) return false;
  const at = ctx.deadlineOf(model.pin);
  // Overdue counts as soon, as the mockup does.
  return at !== undefined && at < ctx.now + DAY_MS;
}

function matchesFacet(
  id: PinsViewFacet,
  value: string,
  model: PinViewModel,
  ctx: PinsViewContext
): boolean {
  const { pin } = model;
  switch (id) {
    case "status":
      return value === "action"
        ? pin.status === "open"
        : COMPLETED_STATUSES.has(pin.status);
    case "kind":
      return pin.kind === value;
    case "blocking":
      return pin.blocking === (value === "yes");
    case "stakes":
      return pin.stakes === value;
    case "risk":
      return pin.risk === value;
    case "deadline":
      if (value === "has") return hasAutomaticPick(model);
      if (value === "soon") return isDueSoon(model, ctx);
      return !hasAutomaticPick(model);
    case "decidedBy":
      return pinDecidedBy(pin) === value;
    case "answer":
      if (pin.status !== "open") return false;
      return hasStagedAnswer(ctx.staged, pin.key) === (value === "chosen");
    case "comments":
      return ctx.hasReviewComments(model);
    case "files":
      return ctx.hasFiles(model);
    case "starred":
      return pin.starred;
    case "changed":
      return isPinNew(pin);
    case "source":
      return (pin.sourceSessionId === ctx.sessionId) === (value === "this");
  }
}

function passesFacets(
  model: PinViewModel,
  filters: PinsViewFilters,
  ctx: PinsViewContext
): boolean {
  for (const [id, value] of Object.entries(filters) as Array<
    [PinsViewFacet, string]
  >) {
    if (value === "all") continue;
    if (!matchesFacet(id, value, model, ctx)) return false;
  }
  return true;
}

function matchesSearch(pin: Pin, query: string): boolean {
  const answer = completedAnswerText(pin);
  return [
    pin.key,
    pin.title,
    pin.context,
    pin.plainText,
    answer === "—" ? undefined : answer,
    settlingAnswerNote(pin),
  ].some(
    field => field !== undefined && normalizeSearchText(field).includes(query)
  );
}

// ── Sections ────────────────────────────────────────────────────────────────

/** How a section looks (`PinsSection`'s icon and color). */
export type PinSectionLook =
  | "action"
  | "completed"
  | "kind"
  | "source"
  | "soon"
  | "later"
  | "nodeadline"
  | "all"
  /** The Project Managers section (#6454), gold like every managed group. */
  | "pm";

export type PinViewSection = {
  id: string;
  title: string;
  completed: boolean;
  look: PinSectionLook;
  /** For a `kind` section, the kind it holds. */
  kind?: string;
  pins: PinViewModel[];
};

type Bucket = Omit<PinViewSection, "pins" | "completed">;

/** The one open-pin section a grouping lists even when it is empty. */
const ALWAYS_LISTED: Partial<Record<PinsViewGroup, Bucket>> = {
  status: { id: "action", title: "Action Items", look: "action" },
  none: { id: "all", title: "All pins", look: "all" },
};

function bucketOf(
  model: PinViewModel,
  group: PinsViewGroup,
  ctx: PinsViewContext
): Bucket {
  const { pin } = model;
  switch (group) {
    case "kind":
      return {
        id: `kind:${pin.kind}`,
        title: pinKindLabel(pin.kind),
        look: "kind",
        kind: pin.kind,
      };
    case "source":
      return pin.sourceSessionId === ctx.sessionId
        ? { id: "source:this", title: "This session", look: "source" }
        : {
            // A session's list holds only its own pins (`sourceSessionId` is the
            // owner, shared/src/pins.ts), so this branch is defensive; H (#6454)
            // shows other sessions' pins in their lane boxes instead.
            id: `source:${pin.sourceSessionId}`,
            title: pin.sourceSessionId,
            look: "source",
          };
    case "window":
      if (!hasAutomaticPick(model)) {
        return { id: "window:none", title: "No deadline", look: "nodeadline" };
      }
      // An automatic pick with no known time yet counts as later.
      return isDueSoon(model, ctx)
        ? { id: "window:soon", title: "Due within 24 hours", look: "soon" }
        : { id: "window:later", title: "Due later", look: "later" };
    case "none":
    case "status":
    default:
      return ALWAYS_LISTED[group] ?? (ALWAYS_LISTED.status as Bucket);
  }
}

const WINDOW_ORDER = ["window:soon", "window:later", "window:none"];

/** The order a grouping's open-pin sections are listed in. */
function compareBuckets(group: PinsViewGroup, a: Bucket, b: Bucket): number {
  if (group === "kind") {
    const ai = PIN_KIND_INDEX.get(a.kind ?? "") ?? Number.POSITIVE_INFINITY;
    const bi = PIN_KIND_INDEX.get(b.kind ?? "") ?? Number.POSITIVE_INFINITY;
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  if (group === "window") {
    return WINDOW_ORDER.indexOf(a.id) - WINDOW_ORDER.indexOf(b.id);
  }
  if (group === "source") {
    if (a.id === "source:this") return -1;
    if (b.id === "source:this") return 1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export type PinsViewResult = {
  sections: PinViewSection[];
  /** The rows listed, across every section. */
  shown: number;
  /** A facet or the search is narrowing the list. */
  filtered: boolean;
};

/**
 * Filter, group and sort (R2-R4, R10, R11). Dashboards are dropped (H lists
 * them). A key in `ctx.held` skips the facets and the search, but is grouped
 * and sorted like any other. A status this build does not know goes nowhere,
 * as in `groupPins`. Every grouping ends with Completed, omitted when empty.
 */
export function buildPinsView(
  models: readonly PinViewModel[],
  view: Pick<PinsViewState, "filters" | "sort" | "dir" | "group">,
  search: string,
  ctx: PinsViewContext
): PinsViewResult {
  const query = normalizeSearchText(search.trim());
  const facetsOn = isFilterActive(view.filters);
  const buckets = new Map<string, Bucket & { pins: PinViewModel[] }>();
  const completed: PinViewModel[] = [];
  const always = ALWAYS_LISTED[view.group];
  if (always) buckets.set(always.id, { ...always, pins: [] });
  for (const model of models) {
    const { pin } = model;
    if (pin.kind === "dashboard") continue;
    const isOpen = pin.status === "open";
    if (!isOpen && !COMPLETED_STATUSES.has(pin.status)) continue;
    if (!ctx.held.has(pin.key)) {
      if (facetsOn && !passesFacets(model, view.filters, ctx)) continue;
      if (query && !matchesSearch(pin, query)) continue;
    }
    if (!isOpen) {
      completed.push(model);
      continue;
    }
    const bucket = bucketOf(model, view.group, ctx);
    const existing = buckets.get(bucket.id);
    if (existing) existing.pins.push(model);
    else buckets.set(bucket.id, { ...bucket, pins: [model] });
  }
  const sortOpts = { deadlineOf: ctx.deadlineOf, sessionId: ctx.sessionId };
  const open = [...buckets.values()].sort((a, b) =>
    compareBuckets(view.group, a, b)
  );
  const sections: PinViewSection[] = open.map(b => ({
    ...b,
    completed: false,
    pins: sortPins(b.pins, view.sort, view.dir, {
      ...sortOpts,
      completed: false,
    }),
  }));
  if (completed.length > 0) {
    sections.push({
      id: "completed",
      title: "Completed",
      completed: true,
      look: "completed",
      pins: sortPins(completed, view.sort, view.dir, {
        ...sortOpts,
        completed: true,
      }),
    });
  }
  const shown = sections.reduce((n, s) => n + s.pins.length, 0);
  return { sections, shown, filtered: facetsOn || query.length > 0 };
}
