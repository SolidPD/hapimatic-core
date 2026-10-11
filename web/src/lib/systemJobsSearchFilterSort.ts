// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure search / filter / sort helpers for the System Jobs page (issue #2599).
 *
 * React-free and dependency-light by design (mirrors `sessionSearchFilterSort.ts`
 * and `accountSort.ts`): per-kind field accessors, a health/enabled classifier,
 * and stable filter + sort over the five job kinds. Grouping and rendering stay
 * in `routes/settings/system-jobs.tsx`; keeping this module pure makes it
 * trivially unit-testable.
 *
 * The five kinds carry heterogeneous name/health/enabled/time fields, and the
 * time units are mixed: systemd-timer run times are MICROSECONDS while every
 * other kind is MILLISECONDS. `nextRunMs`/`lastRunMs` normalize systemd µs → ms
 * so cross-kind time sorts compare like units (directive D3 / the unit hazard
 * documented in `types/systemJobs.ts`).
 *
 * The first four kinds are node-grouped `SystemJobView` members; the fifth
 * (`scheduled-session`) is a client-only `ScheduledTask` rendered in its own
 * node-independent section — its accessors live alongside so all five kinds
 * share one classifier.
 */
import type { SystemJobView } from "@/types/systemJobs";
import type { ScheduledTask } from "@/types/api";

// --- Public option-value types (shared with the toolbar + preferences hook) --------

/** The five job kinds the page renders. The first four are node-grouped
 *  `SystemJobView` members; `scheduled-session` is the client-only fifth kind. */
export type SystemJobKind =
  | "systemd-timer"
  | "in-process-loop"
  | "os-cron"
  | "loop-cron"
  | "scheduled-session";

/** Normalized health bucket. `neutral` means "no health signal" (os-cron, an
 *  unsupported systemd host) — it matches only the "All" health filter. */
export type JobHealth = "healthy" | "warning" | "unhealthy" | "neutral";

export type KindFilter = "all" | SystemJobKind;
export type HealthFilter = "all" | "healthy" | "warning" | "unhealthy";
export type EnabledFilter = "all" | "enabled" | "disabled";

export type SystemJobsFilters = {
  kind: KindFilter;
  health: HealthFilter;
  /** "all" or a federation nodeId. Applies to node-grouped kinds only — the
   *  node-independent scheduled section ignores it (directive point a). */
  node: string;
  enabled: EnabledFilter;
};

export type SortMode = "name" | "next" | "last" | "health";
export type SortDirection = "asc" | "desc";

// --- Per-kind accessors: SystemJobView (the four node-grouped kinds) ----------------

/** The user-visible name field for each node-grouped kind. */
export function jobName(view: SystemJobView): string {
  switch (view.kind) {
    case "systemd-timer":
      return view.job.name;
    case "in-process-loop":
      return view.loop.name;
    case "os-cron":
      return view.cron.command;
    case "loop-cron":
      return view.loop.label;
  }
}

/**
 * True when a loop-cron's bound session is no longer live. Mirrors the route's
 * orphan rule: only marks orphaned once sessions have loaded (an empty live set
 * never false-orphans mid-fetch).
 */
export function isLoopOrphaned(
  loop: { sessionUuid: string | null },
  liveSessionIds: ReadonlySet<string>
): boolean {
  return (
    loop.sessionUuid !== null &&
    liveSessionIds.size > 0 &&
    !liveSessionIds.has(loop.sessionUuid)
  );
}

/**
 * Classify a job's health onto the Healthy / Warning / Unhealthy triad (+ neutral).
 * Per-kind mapping (directive D2, corrected 2026-08-15 expert review):
 * - systemd-timer: unsupported host → neutral; else enabled → healthy, disabled → warning.
 * - in-process-loop: LOCKED enum {ok,stalled,dead,stopped}; only `ok` is healthy.
 * - os-cron: no health signal → neutral.
 * - loop-cron: orphaned → unhealthy; state stalled → unhealthy; paused or degraded
 *   → warning; live → healthy.
 */
export function jobHealth(
  view: SystemJobView,
  opts: { orphaned?: boolean } = {}
): JobHealth {
  switch (view.kind) {
    case "systemd-timer":
      if (view.liveState.code !== "ok") return "neutral"; // unsupported host
      return view.liveState.enabled ? "healthy" : "warning"; // disabled → warning
    case "in-process-loop":
      return view.loop.status === "ok" ? "healthy" : "unhealthy";
    case "os-cron":
      return "neutral";
    case "loop-cron":
      if (opts.orphaned) return "unhealthy";
      if (view.loop.state === "stalled") return "unhealthy";
      if (view.loop.state === "paused" || view.loop.degraded) return "warning";
      return "healthy"; // live
  }
}

/**
 * Whether a job counts as "enabled" for the Enabled filter. Kinds with no on/off
 * axis (in-process-loop, os-cron) and an unsupported systemd host are "always-on"
 * → true. loop-cron is off when paused OR done.
 */
export function jobEnabled(view: SystemJobView): boolean {
  switch (view.kind) {
    case "systemd-timer":
      return view.liveState.code === "ok" ? view.liveState.enabled : true;
    case "in-process-loop":
      return true;
    case "os-cron":
      return true;
    case "loop-cron":
      return !view.loop.paused && !view.loop.done;
  }
}

/** Next-run epoch ms, or null. systemd is µs → ÷1000; every other kind is ms. */
export function nextRunMs(view: SystemJobView): number | null {
  switch (view.kind) {
    case "systemd-timer":
      return view.liveState.code === "ok" && view.liveState.nextRun != null
        ? view.liveState.nextRun / 1000
        : null;
    case "in-process-loop":
      return null;
    case "os-cron":
      return null;
    case "loop-cron":
      return view.loop.nextFireAtMs;
  }
}

/** Last-run epoch ms, or null. systemd is µs → ÷1000; every other kind is ms. */
export function lastRunMs(view: SystemJobView): number | null {
  switch (view.kind) {
    case "systemd-timer":
      return view.liveState.code === "ok" && view.liveState.lastRun != null
        ? view.liveState.lastRun / 1000
        : null;
    case "in-process-loop":
      return view.loop.lastTickAt;
    case "os-cron":
      return null;
    case "loop-cron":
      return view.loop.lastTickAtMs;
  }
}

// --- Per-kind accessors: scheduled-session (the client-only fifth kind) -------------

export function scheduleName(s: ScheduledTask): string {
  return s.name;
}

/**
 * Scheduled-session health (directive D2): `consecutiveErrors > 0` → warning;
 * a disabled schedule → warning (the Warning bucket lists `disabled`); else
 * healthy. `ScheduledTask` carries no failure state, so it never reads Unhealthy.
 */
export function scheduleHealth(s: ScheduledTask): JobHealth {
  if (s.consecutiveErrors > 0) return "warning";
  if (!s.enabled) return "warning";
  return "healthy";
}

export function scheduleEnabled(s: ScheduledTask): boolean {
  return s.enabled;
}

/** Next-run epoch ms, or null (already ms — `nextExecutionAt`, directive D3). */
export function scheduleNextRunMs(s: ScheduledTask): number | null {
  return s.nextExecutionAt;
}

/** Last-run epoch ms, or null (already ms — `lastExecutedAt`, directive D3). */
export function scheduleLastRunMs(s: ScheduledTask): number | null {
  return s.lastExecutedAt;
}

// --- Comparator machinery ----------------------------------------------------------

/** Severity rank for the Health-severity sort (higher = more severe). */
function healthSeverity(h: JobHealth): number {
  switch (h) {
    case "unhealthy":
      return 3;
    case "warning":
      return 2;
    case "healthy":
      return 1;
    case "neutral":
      return 0;
  }
}

/** Compare two nullable timestamps; nulls sort to the END in BOTH directions
 *  ("no run time" is not an earliest/latest value — mirrors `accountSort`). */
function compareNullableTime(
  a: number | null,
  b: number | null,
  sign: number
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1; // a missing → after b (both directions)
  if (b == null) return -1; // b missing → after a (both directions)
  return sign * (a - b);
}

type Accessors<T> = {
  name: (t: T) => string;
  next: (t: T) => number | null;
  last: (t: T) => number | null;
  health: (t: T) => JobHealth;
};

/**
 * Build a comparator for a sort mode + direction. `asc` (the default) means:
 * Name A→Z, soonest next-run first, earliest last-run first, and — for Health
 * severity — most-severe first (problems first). `desc` flips PRESENT values;
 * missing run times stay pinned to the end regardless of direction.
 */
function makeComparator<T>(
  mode: SortMode,
  direction: SortDirection,
  acc: Accessors<T>
): (a: T, b: T) => number {
  const sign = direction === "asc" ? 1 : -1;
  return (a, b) => {
    switch (mode) {
      case "name":
        return sign * acc.name(a).localeCompare(acc.name(b));
      case "next":
        return compareNullableTime(acc.next(a), acc.next(b), sign);
      case "last":
        return compareNullableTime(acc.last(a), acc.last(b), sign);
      case "health":
        // asc = most-severe first (problems first); desc reverses.
        return (
          sign * (healthSeverity(acc.health(b)) - healthSeverity(acc.health(a)))
        );
    }
  };
}

function viewAccessors(
  liveSessionIds: ReadonlySet<string>
): Accessors<SystemJobView> {
  return {
    name: v => jobName(v),
    next: v => nextRunMs(v),
    last: v => lastRunMs(v),
    health: v =>
      jobHealth(v, {
        orphaned:
          v.kind === "loop-cron" && isLoopOrphaned(v.loop, liveSessionIds),
      }),
  };
}

const scheduleAccessors: Accessors<ScheduledTask> = {
  name: s => scheduleName(s),
  next: s => scheduleNextRunMs(s),
  last: s => scheduleLastRunMs(s),
  health: s => scheduleHealth(s),
};

// --- Filter + sort: node-grouped jobs ----------------------------------------------

export type FilterJobsOptions = {
  search: string;
  filters: SystemJobsFilters;
  /** #2453 `?session=` — narrows to that session's loop-cron rows only. */
  sessionFilter?: string;
  /** R7 — the deep-linked loop-cron id always shows (bypasses search/filter). */
  highlightId?: string;
  liveSessionIds: ReadonlySet<string>;
};

/**
 * Filter a node's jobs by search + kind/health/enabled. The Node filter is
 * applied at the group level (which node groups render), NOT here. R7: the
 * highlighted loop-cron always passes so the #2596 jump-to-job path lands even
 * under an active filter.
 */
export function filterJobs(
  views: SystemJobView[],
  opts: FilterJobsOptions
): SystemJobView[] {
  const { search, filters, sessionFilter, highlightId, liveSessionIds } = opts;
  const q = search.trim().toLowerCase();
  return views.filter(v => {
    // R7: the deep-linked target bypasses all active narrowing.
    if (highlightId && v.kind === "loop-cron" && v.loop.id === highlightId) {
      return true;
    }
    // #2453 ?session= — only that session's loop-cron rows survive.
    if (sessionFilter) {
      if (v.kind !== "loop-cron" || v.loop.sessionUuid !== sessionFilter) {
        return false;
      }
    }
    if (filters.kind !== "all" && v.kind !== filters.kind) return false;
    if (q && !jobName(v).toLowerCase().includes(q)) return false;
    if (filters.health !== "all") {
      const orphaned =
        v.kind === "loop-cron" && isLoopOrphaned(v.loop, liveSessionIds);
      if (jobHealth(v, { orphaned }) !== filters.health) return false;
    }
    if (filters.enabled !== "all") {
      const enabled = jobEnabled(v);
      if (filters.enabled === "enabled" && !enabled) return false;
      if (filters.enabled === "disabled" && enabled) return false;
    }
    return true;
  });
}

/** Sort a node's jobs (stable; JS sort is stable). Kinds with no run time sort
 *  to the end of the group under the time modes. */
export function sortJobs(
  views: SystemJobView[],
  mode: SortMode,
  direction: SortDirection,
  liveSessionIds: ReadonlySet<string>
): SystemJobView[] {
  return [...views].sort(
    makeComparator(mode, direction, viewAccessors(liveSessionIds))
  );
}

// --- Filter + sort: scheduled sessions (node-independent) ---------------------------

export type FilterSchedulesOptions = {
  search: string;
  filters: SystemJobsFilters;
};

/**
 * Filter the node-independent scheduled-session list. The Node filter never
 * applies (schedules belong to no node — directive point a). A Kind filter set
 * to a specific NODE kind hides the section entirely (point b: only "All" or
 * "scheduled-session" keep it visible).
 */
export function filterSchedules(
  schedules: ScheduledTask[],
  opts: FilterSchedulesOptions
): ScheduledTask[] {
  const { search, filters } = opts;
  if (filters.kind !== "all" && filters.kind !== "scheduled-session") return [];
  const q = search.trim().toLowerCase();
  return schedules.filter(s => {
    if (q && !scheduleName(s).toLowerCase().includes(q)) return false;
    if (filters.health !== "all" && scheduleHealth(s) !== filters.health) {
      return false;
    }
    if (filters.enabled === "enabled" && !scheduleEnabled(s)) return false;
    if (filters.enabled === "disabled" && scheduleEnabled(s)) return false;
    return true;
  });
}

/** Sort schedules (stable). Nulls to the end. Applied for consistency so the
 *  Sort control reorders every visible list, not just node groups. */
export function sortSchedules(
  schedules: ScheduledTask[],
  mode: SortMode,
  direction: SortDirection
): ScheduledTask[] {
  return [...schedules].sort(
    makeComparator(mode, direction, scheduleAccessors)
  );
}
