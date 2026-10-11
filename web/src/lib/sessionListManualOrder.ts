// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Manual drag-to-reorder persistence for the session list (issue #466).
 *
 * A pure, framework-free module: a device-local "manual sort active" flag, a project-level
 * order (SessionGroup.groupKey array), a per-group root-session order (groupKey → root
 * session-id array), a generic custom-order applier with graceful degradation, and a
 * prune helper for orphaned session ids. Kept dependency-free (no React, no component
 * imports) so it unit-tests in isolation.
 *
 * The persistence pattern mirrors `src/lib/accountSort.ts` and `src/design/themePersistence.ts`
 * exactly: versioned `:v1` keys, `getStorageKey` port scoping, and every access try/catch-guarded
 * so a disabled or full localStorage degrades cleanly to the default and never throws into render.
 *
 * Ordering is at ROOT-SESSION / cluster granularity (issue #466 finding 466-2): children are
 * never stored — they re-derive under their root via `treeSortSessions`, so a persisted order
 * only ever names root session ids (sessions with no `parentSessionId`).
 */
import { getStorageKey } from "@/lib/storage-keys";

const MANUAL_ACTIVE_KEY = "hapi:sessionList:manualActive:v1";
const PROJECT_ORDER_KEY = "hapi:sessionList:projectOrder:v1";
const SESSION_ORDER_KEY = "hapi:sessionList:sessionOrder:v1";

/**
 * Read the persisted "manual sort active" flag (default: off). Set true after the
 * first completed manual drag (issue #3114) — while set, the stored custom order
 * governs the session list over the #942 server sort, and SearchFilterBar displays
 * "Manual". Cleared when the user explicitly picks a server sort. Replaces the removed
 * reorder-mode flag (the drag apparatus is now always armed, not mode-gated).
 */
export function getStoredManualActive(): boolean {
  try {
    return localStorage.getItem(getStorageKey(MANUAL_ACTIVE_KEY)) === "1";
  } catch {
    /* ignore storage errors (private mode / disabled) */
  }
  return false;
}

/** Persist the "manual sort active" flag. Swallows storage errors (non-persisted is cosmetic). */
export function persistManualActive(on: boolean): void {
  try {
    localStorage.setItem(getStorageKey(MANUAL_ACTIVE_KEY), on ? "1" : "0");
  } catch {
    /* ignore storage errors */
  }
}

/** Read the persisted project order (SessionGroup.groupKey array), or `[]` when absent/invalid. */
export function getStoredProjectOrder(): string[] {
  return readStringArray(PROJECT_ORDER_KEY);
}

/** Persist the project order (groupKey array). Swallows storage errors. */
export function persistProjectOrder(groupKeys: string[]): void {
  writeJson(PROJECT_ORDER_KEY, groupKeys);
}

/** Read the persisted per-group root-session order map, or `{}` when absent/invalid. */
export function getStoredSessionOrder(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(getStorageKey(SESSION_ORDER_KEY));
    if (raw == null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed != null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      const out: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(v) && v.every(x => typeof x === "string")) {
          out[k] = v as string[];
        }
      }
      return out;
    }
  } catch {
    /* ignore storage / parse errors */
  }
  return {};
}

/** Persist the per-group root-session order map. Swallows storage errors. */
export function persistSessionOrder(order: Record<string, string[]>): void {
  writeJson(SESSION_ORDER_KEY, order);
}

/**
 * Custom-order applier (mirrors `accountSort.orderByCustom`): return `items` ordered by the
 * stored `order`, then APPEND any item whose key is not in the stored order (newly-added, in
 * input order), and DROP stored keys no longer present. Never throws on an unknown/stale key —
 * degrades cleanly.
 */
export function orderByCustom<T>(
  items: T[],
  order: string[],
  getKey: (item: T) => string
): T[] {
  const rank = new Map<string, number>();
  order.forEach((key, i) => rank.set(key, i));
  const known: T[] = [];
  const unknown: T[] = [];
  for (const item of items) {
    if (rank.has(getKey(item))) known.push(item);
    else unknown.push(item);
  }
  known.sort((a, b) => rank.get(getKey(a))! - rank.get(getKey(b))!);
  return [...known, ...unknown];
}

/**
 * Prune the per-group root order against a set of valid session ids (issue #466, finding 466-9).
 * Drops root ids for deleted sessions and any groupKey whose array becomes empty; writes back only
 * when something changed. Called from `localStorageCleanup.pruneOrphanedSessions`.
 */
export function pruneSessionOrder(validIds: Set<string>): void {
  const order = getStoredSessionOrder();
  let changed = false;
  const next: Record<string, string[]> = {};
  for (const [groupKey, ids] of Object.entries(order)) {
    const filtered = ids.filter(id => validIds.has(id));
    if (filtered.length !== ids.length) changed = true;
    if (filtered.length > 0) next[groupKey] = filtered;
    else if (ids.length > 0) changed = true;
  }
  if (changed) persistSessionOrder(next);
}

// --- internal helpers --------------------------------------------------------------

function readStringArray(baseKey: string): string[] {
  try {
    const raw = localStorage.getItem(getStorageKey(baseKey));
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

function writeJson(baseKey: string, value: unknown): void {
  try {
    localStorage.setItem(getStorageKey(baseKey), JSON.stringify(value));
  } catch {
    /* ignore storage errors */
  }
}
