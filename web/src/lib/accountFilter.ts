// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Account-list FILTERING for the switch-account modal and the `/account-usage`
 * page (issue #3880).
 *
 * A pure, framework-free sibling to `accountSort.ts`: four independent, "all"-defaulted
 * filter dimensions (remaining 5-hour / weekly / Fable capacity + node holding the
 * account), a predicate that ANDs the active dimensions, dynamic node-option derivation,
 * and port-scoped localStorage persistence (versioned `:v1` key, every access
 * try/catch-guarded) — the SAME persistence discipline as `accountSort.ts`, so a filter
 * set on either surface carries to the other.
 *
 * The UI SHAPE mirrors the session-list `SearchFilterBar` (radio-per-dimension with an
 * "all" default, on the shared `menuPrimitives`), but NOT its state layer: SearchFilterBar
 * is session-domain + server-persisted, whereas this is device-local like the sort.
 *
 * Capacity semantics: a "remaining" dimension keeps only accounts with a KNOWN,
 * below-cap value for that window (`utilization != null && < 100`). An account with no
 * usage datum for that window (a synthesized degraded envelope, or one the usage fetch
 * has not covered yet) is HIDDEN under an active capacity filter — "unknown" is not
 * "affirmatively available", the same principle behind accountSort's missing-sorts-to-the-
 * end contract. The Fable percent is read via `sortValue(account, "fable_weekly")`, so
 * the strict `kind === "weekly_scoped"` predicate stays byte-identical to the sort's
 * (NOT the looser `display_name === "Fable"` paraphrase).
 */
import type { AccountUsage } from "@hapi/protocol";
import { getStorageKey } from "@/lib/storage-keys";
import { sortValue } from "@/lib/accountSort";

/** A capacity dimension: "all" = no constraint (default); "remaining" = keep only
 *  accounts with a known below-cap value for that window. */
export type CapacityFilter = "all" | "remaining";

/** The full filter state — four independent dimensions, each defaulting to "all"
 *  (no constraint). `node` is "all" or an exact `AccountUsage.machines[]` node label. */
export type AccountFilters = {
  fiveHour: CapacityFilter;
  weekly: CapacityFilter;
  fable: CapacityFilter;
  node: string;
};

/** Default filter state on a fresh device (no constraint on any dimension). */
export const DEFAULT_FILTERS: AccountFilters = {
  fiveHour: "all",
  weekly: "all",
  fable: "all",
  node: "all",
};

/** Shared radio options for each of the three capacity dimensions — the section's own
 *  `label` ("5-hour" / "Weekly" / "Fable") names the axis, so a generic value label
 *  suffices (mirrors SearchFilterBar's per-dimension option constants). */
export const CAPACITY_OPTIONS: { value: CapacityFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "remaining", label: "Has capacity" },
];

/** Utilization at/above this percentage means the window is EXHAUSTED (locked until
 *  reset) — mirrors accountSort's HARD_LOCK_UTILIZATION. Below it, capacity remains. */
const CAP = 100;

/** True when any dimension deviates from its "all" default (drives the trigger's mint
 *  accent + the "Clear filters" affordance). */
export function filtersActive(f: AccountFilters): boolean {
  return (
    f.fiveHour !== "all" ||
    f.weekly !== "all" ||
    f.fable !== "all" ||
    f.node !== "all"
  );
}

/** A window's utilization "has remaining capacity" when it is a finite number below the
 *  cap. `null` / `undefined` / `NaN` (no data) is NOT remaining, so an account with no
 *  datum for that window is hidden under an active capacity filter (R4). */
function hasRemaining(util: number | null | undefined): boolean {
  return util != null && Number.isFinite(util) && util < CAP;
}

/**
 * Does `account` satisfy ALL active filter dimensions (AND-composition)? An "all"
 * dimension always passes (pass-through); a "remaining" capacity dimension requires a
 * known below-cap value for that window; the node dimension requires the account to list
 * the selected node label.
 */
export function matchesFilters(
  account: AccountUsage,
  f: AccountFilters
): boolean {
  if (
    f.fiveHour === "remaining" &&
    !hasRemaining(account.utilization.five_hour?.utilization)
  ) {
    return false;
  }
  if (
    f.weekly === "remaining" &&
    !hasRemaining(account.utilization.seven_day?.utilization)
  ) {
    return false;
  }
  // Fable percent via the sort sibling's strict `weekly_scoped` predicate (NOT the
  // issue body's looser `display_name === "Fable"` paraphrase).
  if (
    f.fable === "remaining" &&
    !hasRemaining(sortValue(account, "fable_weekly"))
  ) {
    return false;
  }
  if (f.node !== "all" && !account.machines.includes(f.node)) {
    return false;
  }
  return true;
}

/** The sorted, de-duplicated set of node labels present across `usage` — the dynamic
 *  option list for the Node filter (mirrors SearchFilterBar's dynamic node options). */
export function nodeOptions(usage: AccountUsage[]): string[] {
  const set = new Set<string>();
  for (const u of usage) {
    for (const label of u.machines) set.add(label);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

// --- Persistence (port-scoped, versioned :v1, try/catch-guarded) --------------------
// Mirrors accountSort.ts's persistence discipline: one JSON object under a port-scoped
// :v1 key, validated per-field on read (unknown/malformed → DEFAULT_FILTERS), every
// access guarded so a disabled/full store degrades cleanly instead of throwing.

const FILTERS_KEY = "hapi:accountUsage:filters:v1";

const isCapacity = (v: unknown): v is CapacityFilter =>
  v === "all" || v === "remaining";

/** Read the persisted filters, or {@link DEFAULT_FILTERS} when absent/invalid. Each key
 *  is validated independently, so a partial / legacy object degrades per-field to its
 *  default rather than discarding the whole object. */
export function getStoredFilters(): AccountFilters {
  try {
    const raw = localStorage.getItem(getStorageKey(FILTERS_KEY));
    if (raw != null) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed != null && typeof parsed === "object") {
        const o = parsed as Record<string, unknown>;
        return {
          fiveHour: isCapacity(o.fiveHour) ? o.fiveHour : "all",
          weekly: isCapacity(o.weekly) ? o.weekly : "all",
          fable: isCapacity(o.fable) ? o.fable : "all",
          node: typeof o.node === "string" ? o.node : "all",
        };
      }
    }
  } catch {
    /* ignore storage / parse errors (private mode / disabled) */
  }
  return { ...DEFAULT_FILTERS };
}

/** Persist the filter state. Swallows storage errors (non-persisted is cosmetic). */
export function persistFilters(f: AccountFilters): void {
  try {
    localStorage.setItem(getStorageKey(FILTERS_KEY), JSON.stringify(f));
  } catch {
    /* ignore storage errors */
  }
}
