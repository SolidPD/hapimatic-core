// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Account-list sorting for the `/account-usage` page (issue #2133).
 *
 * A pure, framework-free module: sort-mode definitions, a mode → comparator factory
 * (ascending = most-available-first, with missing keys sorted to the end), a device-local
 * Manual drag-order applier with graceful degradation, and port-scoped localStorage
 * persistence. Kept dependency-free (no React, no component imports) so it unit-tests
 * in isolation — the persistence pattern mirrors `src/design/themePersistence.ts`
 * (versioned `:v1` key, `getStorageKey` port scoping, every access try/catch-guarded).
 *
 * Direction contract (R1, amended 2026-07-20): every mode's BASE order is ASCENDING,
 * i.e. most-available-first — a lower value (lower pace score, lower utilization %,
 * lower credit-usage %, sooner reset) sorts first. A user-facing direction toggle
 * (asc ⇄ desc, persisted alongside the mode) flips the comparison of PRESENT values
 * only: accounts missing the active key sort to the END in BOTH directions,
 * deterministically (R3) — a missing key means "no data", not a largest/smallest value.
 * The device-local Manual arrangement (a flag — {@link getStoredManualActive} — not a
 * sort mode; issue #3537 retired the old "custom" mode) ignores direction: the stored
 * drag order is absolute.
 */
import type { AccountUsage, Spend, SpendMoney } from "@hapi/protocol";
import { getStorageKey } from "@/lib/storage-keys";

export type SortMode =
  | "pace"
  | "five_hour"
  | "five_hour_reset"
  | "weekly"
  | "weekly_reset"
  | "fable_weekly"
  | "credits";

/** The sort modes in display order, with their control labels and the `< sm`
 *  two-letter abbreviations (issue #2133; reset-time modes added 2026-07-20; the
 *  `abbr` field added #3537 — the strings are operator-fixed, verbatim). The Manual
 *  drag-order indicator is UI-only ("Manual" / "Mn"), NOT a SORT_MODES entry — it is
 *  a device-local flag ({@link getStoredManualActive}), not a sort mode. */
export const SORT_MODES: { id: SortMode; label: string; abbr: string }[] = [
  { id: "pace", label: "Pace score", abbr: "PS" },
  { id: "five_hour", label: "5h %", abbr: "5h%" },
  { id: "five_hour_reset", label: "5h reset", abbr: "5hR" },
  { id: "weekly", label: "Weekly %", abbr: "Wk%" },
  { id: "weekly_reset", label: "Weekly reset", abbr: "WkR" },
  { id: "fable_weekly", label: "Fable weekly %", abbr: "Fb%" },
  { id: "credits", label: "Usage credits", abbr: "UC" },
];

const SORT_MODE_IDS = new Set<string>(SORT_MODES.map(m => m.id));

/** Default sort on a fresh device (no stored preference) — R2. */
export const DEFAULT_SORT_MODE: SortMode = "pace";

/** Sort direction for the sort modes (2026-07-20). `asc` = the R1 base order
 *  (most-available / soonest-reset first); `desc` flips present values only —
 *  missing keys stay pinned to the end either way. (The device-local Manual
 *  arrangement is direction-agnostic — the drag order is absolute.) */
export type SortDirection = "asc" | "desc";

/** Default direction on a fresh device (the pre-toggle behavior). */
export const DEFAULT_SORT_DIRECTION: SortDirection = "asc";

// --- Money helpers -----------------------------------------------------------------
// Canonical source: `AccountUsageCard.tsx` (`moneyToUsd`, `overagePercent`). Duplicated
// here (a few trivial lines) rather than imported so this lib stays React-free and
// independently testable — the money math (Anthropic `spend` minor-units → dollars →
// uncapped %) is stable. Keep the two in sync if the spend schema ever changes.

/** Resolve a `spend` money object to whole dollars: `amount_minor / 10^exponent`. */
function moneyToUsd(m: SpendMoney | null | undefined): number | null {
  if (m == null) return null;
  const minor = m.amount_minor;
  if (minor == null || !Number.isFinite(minor)) return null;
  const exp =
    m.exponent != null && Number.isFinite(m.exponent) ? m.exponent : 0;
  return minor / Math.pow(10, exp);
}

/** Uncapped usage-credits percentage: `used$ / limit$ × 100` (may exceed 100). */
function overagePercent(spend: Spend | null | undefined): number | null {
  if (spend == null) return null;
  const used = moneyToUsd(spend.used);
  const limit = moneyToUsd(spend.limit);
  if (used == null || limit == null || limit <= 0) return null;
  return (used / limit) * 100;
}

// --- Sort values + comparator ------------------------------------------------------

/** Epoch ms of a window's `resets_at`, or null when absent/unparseable. Sorting by
 *  the raw epoch is order-equivalent to "time until reset" (`now` is the same for
 *  every compared account), so the reset-time modes need no injected clock. */
function parseResetMs(resetsAt: string | null | undefined): number | null {
  if (!resetsAt) return null;
  const ms = Date.parse(resetsAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The sort value for `account` under `mode`, or `null` when the key is missing /
 * unavailable (null sorts to the end — R3). The Manual arrangement has no comparator
 * value — its order comes from {@link orderByCustom} keyed off the device-local flag.
 */
export function sortValue(
  account: AccountUsage,
  mode: SortMode
): number | null {
  const finite = (v: number | null | undefined): number | null =>
    v != null && Number.isFinite(v) ? v : null;
  const u = account.utilization;
  switch (mode) {
    case "pace":
      return finite(account.score);
    case "five_hour":
      return finite(u.five_hour?.utilization);
    case "five_hour_reset":
      return parseResetMs(u.five_hour?.resets_at);
    case "weekly":
      return finite(u.seven_day?.utilization);
    case "weekly_reset":
      return parseResetMs(u.seven_day?.resets_at);
    case "fable_weekly": {
      const fable = (u.limits ?? []).find(
        l =>
          l != null &&
          l.kind === "weekly_scoped" &&
          l.percent != null &&
          l.scope?.model?.display_name === "Fable"
      );
      return finite(fable?.percent);
    }
    case "credits":
      return finite(overagePercent(u.spend));
  }
}

/**
 * Comparator for a non-custom sort mode: `asc` (default) orders by the mode's value
 * ascending (most-available / soonest-reset first); `desc` flips the comparison of
 * present values. Missing (null) values sort AFTER all present values in BOTH
 * directions — "no data" is not a largest/smallest value, and pinning it to the end
 * keeps the flip symmetric. Equal keys and both-null pairs return 0, so JS's stable
 * sort preserves input order — a deterministic tail for missing-key accounts (R1/R3).
 */
export function compareByMode(
  mode: SortMode,
  direction: SortDirection = "asc"
): (a: AccountUsage, b: AccountUsage) => number {
  const sign = direction === "desc" ? -1 : 1;
  return (a, b) => {
    const va = sortValue(a, mode);
    const vb = sortValue(b, mode);
    if (va == null && vb == null) return 0;
    if (va == null) return 1; // a missing → sorts after b (both directions)
    if (vb == null) return -1; // b missing → sorts after a (both directions)
    return sign * (va - vb);
  };
}

/**
 * Custom-mode order (R4/R6): return `items` ordered by the stored `uuidOrder`, then
 * APPEND any item whose uuid is not in the stored order (newly-added accounts, in input
 * order), and DROP stored uuids no longer present (removed accounts). Never throws on an
 * unknown/stale uuid — degrades cleanly.
 */
export function orderByCustom<T>(
  items: T[],
  uuidOrder: string[],
  getUuid: (item: T) => string
): T[] {
  const rank = new Map<string, number>();
  uuidOrder.forEach((uuid, i) => rank.set(uuid, i));
  const known: T[] = [];
  const unknown: T[] = [];
  for (const item of items) {
    if (rank.has(getUuid(item))) known.push(item);
    else unknown.push(item);
  }
  known.sort((a, b) => rank.get(getUuid(a))! - rank.get(getUuid(b))!);
  return [...known, ...unknown];
}

// --- Persistence (port-scoped, versioned :v1, try/catch-guarded) --------------------

const SORT_MODE_KEY = "hapi:accountUsage:sortMode:v1";
const SORT_DIRECTION_KEY = "hapi:accountUsage:sortDirection:v1";
const CUSTOM_ORDER_KEY = "hapi:accountUsage:customOrder:v1";
/** #3982: the OpenAI section's own drag order (a sibling key — the Anthropic key
 *  above stays byte-unchanged). Google has no key: #4466 lists key cards in vault
 *  order. */
const OPENAI_CUSTOM_ORDER_KEY = "hapi:accountUsage:customOrder:openai:v1";

/** #3982: which provider's custom order a reader/writer addresses. */
export type CustomOrderProvider = "anthropic" | "openai";

function customOrderKey(provider: CustomOrderProvider): string {
  return provider === "openai" ? OPENAI_CUSTOM_ORDER_KEY : CUSTOM_ORDER_KEY;
}
const MANUAL_ACTIVE_KEY = "hapi:accountUsage:manualActive:v1";

/** Read the persisted sort mode, or {@link DEFAULT_SORT_MODE} when absent/invalid. */
export function getStoredSortMode(): SortMode {
  try {
    const raw = localStorage.getItem(getStorageKey(SORT_MODE_KEY));
    if (raw != null && SORT_MODE_IDS.has(raw)) return raw as SortMode;
  } catch {
    /* ignore storage errors (private mode / disabled) */
  }
  return DEFAULT_SORT_MODE;
}

/** Persist the selected sort mode. Swallows storage errors (non-persisted is cosmetic). */
export function persistSortMode(mode: SortMode): void {
  try {
    localStorage.setItem(getStorageKey(SORT_MODE_KEY), mode);
  } catch {
    /* ignore storage errors */
  }
}

/**
 * Read the device-local "Manual" flag (default: off) — issue #3537, mirroring the
 * session list's `sessionListManualOrder.getStoredManualActive`. While set, the stored
 * `customOrder` governs the account list (over the sort mode) and both the Account Usage
 * page AND the AccountSelectorModal read "Manual".
 *
 * PURE READ — never writes storage (two surfaces read these keys and neither controls
 * which mounts first, so the migration must be order-independent and must never mutate
 * on a read). Precedence: an explicitly persisted value ALWAYS wins — a raw "1" → true,
 * a raw "0" → false. ONLY when the key is ABSENT does it fall back to the legacy signal:
 * a stored sort mode of "custom" (the retired Custom mode, issue #2133) means this device
 * had a drag order active before #3537 retired the mode, so it wakes up in Manual with
 * its `customOrder` intact (R10 migration). The fallback is read-only and becomes
 * unreachable the moment `persistManualActive` has written either "1" or "0".
 */
export function getStoredManualActive(): boolean {
  try {
    const raw = localStorage.getItem(getStorageKey(MANUAL_ACTIVE_KEY));
    if (raw === "1") return true;
    if (raw === "0") return false;
    // Key absent → legacy migration: a stored "custom" sort mode maps to Manual.
    return localStorage.getItem(getStorageKey(SORT_MODE_KEY)) === "custom";
  } catch {
    /* ignore storage errors (private mode / disabled) */
  }
  return false;
}

/** Persist the device-local "Manual" flag. Swallows storage errors (non-persisted is
 *  cosmetic). Mirrors `sessionListManualOrder.persistManualActive` byte-for-byte. */
export function persistManualActive(on: boolean): void {
  try {
    localStorage.setItem(getStorageKey(MANUAL_ACTIVE_KEY), on ? "1" : "0");
  } catch {
    /* ignore storage errors */
  }
}

/** Read the persisted sort direction, or {@link DEFAULT_SORT_DIRECTION} when
 *  absent/invalid. */
export function getStoredSortDirection(): SortDirection {
  try {
    const raw = localStorage.getItem(getStorageKey(SORT_DIRECTION_KEY));
    if (raw === "asc" || raw === "desc") return raw;
  } catch {
    /* ignore storage errors (private mode / disabled) */
  }
  return DEFAULT_SORT_DIRECTION;
}

/** Persist the sort direction. Swallows storage errors (non-persisted is cosmetic). */
export function persistSortDirection(direction: SortDirection): void {
  try {
    localStorage.setItem(getStorageKey(SORT_DIRECTION_KEY), direction);
  } catch {
    /* ignore storage errors */
  }
}

/** Read the persisted custom order (accountUuid array), or `[]` when absent/invalid.
 *  #3982: `provider` selects that provider's order (default anthropic). */
export function getStoredCustomOrder(
  provider: CustomOrderProvider = "anthropic"
): string[] {
  try {
    const raw = localStorage.getItem(getStorageKey(customOrderKey(provider)));
    if (raw == null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(x => typeof x === "string")) {
      return parsed as string[];
    }
  } catch {
    /* ignore storage / parse errors */
  }
  return [];
}

/** Persist the custom order (accountUuid array). Swallows storage errors.
 *  #3982: `provider` selects that provider's order (default anthropic). */
export function persistCustomOrder(
  uuids: string[],
  provider: CustomOrderProvider = "anthropic"
): void {
  try {
    localStorage.setItem(
      getStorageKey(customOrderKey(provider)),
      JSON.stringify(uuids)
    );
  } catch {
    /* ignore storage errors */
  }
}
