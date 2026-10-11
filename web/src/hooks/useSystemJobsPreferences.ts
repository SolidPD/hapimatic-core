// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Device-scoped persisted preferences for the System Jobs page (issue #2599, R6).
 *
 * Mirrors the `accountSort.ts` / `themePersistence.ts` localStorage pattern — NOT
 * the session bar's server-synced `useSearchFilterPreferences` (that hook is the
 * wrong analog per the directive). State persists port-scoped via `getStorageKey`
 * under versioned `:v1` keys; every read/write is try/catch-guarded so a disabled
 * or full store degrades to defaults and never throws into render. A malformed
 * blob is sanitized field-by-field back to defaults on load.
 *
 * Two keys: the search/filter/sort blob and the per-node collapse map.
 */
import { useEffect, useState } from "react";
import { getStorageKey } from "@/lib/storage-keys";
import type {
  SystemJobsFilters,
  SortMode,
  SortDirection,
} from "@/lib/systemJobsSearchFilterSort";

const SFS_KEY = "hapi:systemJobs:searchFilterSort:v1";
const COLLAPSE_KEY = "hapi:systemJobs:nodeCollapse:v1";

export const DEFAULT_FILTERS: SystemJobsFilters = {
  kind: "all",
  health: "all",
  node: "all",
  enabled: "all",
};
export const DEFAULT_SORT: SortMode = "name";
export const DEFAULT_SORT_DIRECTION: SortDirection = "asc";

/** Persisted search/filter/sort blob. */
type SfsState = {
  searchText: string;
  filters: SystemJobsFilters;
  sort: SortMode;
  sortDirection: SortDirection;
};

const DEFAULT_SFS: SfsState = {
  searchText: "",
  filters: DEFAULT_FILTERS,
  sort: DEFAULT_SORT,
  sortDirection: DEFAULT_SORT_DIRECTION,
};

const KIND_VALUES = new Set([
  "all",
  "systemd-timer",
  "in-process-loop",
  "os-cron",
  "loop-cron",
  "scheduled-session",
]);
const HEALTH_VALUES = new Set(["all", "healthy", "warning", "unhealthy"]);
const ENABLED_VALUES = new Set(["all", "enabled", "disabled"]);
const SORT_VALUES = new Set(["name", "next", "last", "health"]);
const DIRECTION_VALUES = new Set(["asc", "desc"]);

function pick<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  fallback: T
): T {
  return typeof value === "string" && allowed.has(value)
    ? (value as T)
    : fallback;
}

/** Coerce an untrusted parsed blob back to a valid `SfsState`, field by field. */
function sanitizeSfs(raw: unknown): SfsState {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SFS;
  const r = raw as Record<string, unknown>;
  const f =
    typeof r.filters === "object" && r.filters !== null
      ? (r.filters as Record<string, unknown>)
      : {};
  return {
    searchText: typeof r.searchText === "string" ? r.searchText : "",
    filters: {
      kind: pick(f.kind, KIND_VALUES, "all"),
      health: pick(f.health, HEALTH_VALUES, "all"),
      node: typeof f.node === "string" ? f.node : "all",
      enabled: pick(f.enabled, ENABLED_VALUES, "all"),
    },
    sort: pick(r.sort, SORT_VALUES, DEFAULT_SORT),
    sortDirection: pick(
      r.sortDirection,
      DIRECTION_VALUES,
      DEFAULT_SORT_DIRECTION
    ),
  };
}

function loadSfs(): SfsState {
  try {
    const raw = localStorage.getItem(getStorageKey(SFS_KEY));
    if (raw != null) return sanitizeSfs(JSON.parse(raw));
  } catch {
    /* ignore storage / parse errors (private mode / disabled / corrupt) */
  }
  return DEFAULT_SFS;
}

function loadCollapse(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(getStorageKey(COLLAPSE_KEY));
    if (raw != null) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        const out: Record<string, boolean> = {};
        for (const [k, v] of Object.entries(
          parsed as Record<string, unknown>
        )) {
          if (typeof v === "boolean") out[k] = v;
        }
        return out;
      }
    }
  } catch {
    /* ignore storage / parse errors */
  }
  return {};
}

export type SystemJobsPreferences = {
  searchText: string;
  setSearchText: (text: string) => void;
  filters: SystemJobsFilters;
  setKind: (kind: SystemJobsFilters["kind"]) => void;
  setHealth: (health: SystemJobsFilters["health"]) => void;
  setNode: (node: string) => void;
  setEnabled: (enabled: SystemJobsFilters["enabled"]) => void;
  sort: SortMode;
  setSort: (sort: SortMode) => void;
  sortDirection: SortDirection;
  setSortDirection: (direction: SortDirection) => void;
  nodeCollapse: Record<string, boolean>;
  isNodeCollapsed: (nodeId: string) => boolean;
  toggleNode: (nodeId: string) => void;
  /** Reset search + filters + sort to defaults (leaves per-node collapse). */
  clearAll: () => void;
  clearFilters: () => void;
  clearSort: () => void;
};

/** Read + persist the System Jobs search/filter/sort + per-node collapse state. */
export function useSystemJobsPreferences(): SystemJobsPreferences {
  const [sfs, setSfs] = useState<SfsState>(loadSfs);
  const [nodeCollapse, setNodeCollapse] =
    useState<Record<string, boolean>>(loadCollapse);

  useEffect(() => {
    try {
      localStorage.setItem(getStorageKey(SFS_KEY), JSON.stringify(sfs));
    } catch {
      /* ignore storage errors (non-persisted is cosmetic) */
    }
  }, [sfs]);

  useEffect(() => {
    try {
      localStorage.setItem(
        getStorageKey(COLLAPSE_KEY),
        JSON.stringify(nodeCollapse)
      );
    } catch {
      /* ignore storage errors */
    }
  }, [nodeCollapse]);

  return {
    searchText: sfs.searchText,
    setSearchText: text => setSfs(p => ({ ...p, searchText: text })),
    filters: sfs.filters,
    setKind: kind => setSfs(p => ({ ...p, filters: { ...p.filters, kind } })),
    setHealth: health =>
      setSfs(p => ({ ...p, filters: { ...p.filters, health } })),
    setNode: node => setSfs(p => ({ ...p, filters: { ...p.filters, node } })),
    setEnabled: enabled =>
      setSfs(p => ({ ...p, filters: { ...p.filters, enabled } })),
    sort: sfs.sort,
    setSort: sort => setSfs(p => ({ ...p, sort })),
    sortDirection: sfs.sortDirection,
    setSortDirection: sortDirection => setSfs(p => ({ ...p, sortDirection })),
    nodeCollapse,
    isNodeCollapsed: nodeId => nodeCollapse[nodeId] ?? false,
    toggleNode: nodeId =>
      setNodeCollapse(p => ({ ...p, [nodeId]: !(p[nodeId] ?? false) })),
    clearAll: () => setSfs({ ...DEFAULT_SFS, filters: { ...DEFAULT_FILTERS } }),
    clearFilters: () =>
      setSfs(p => ({ ...p, filters: { ...DEFAULT_FILTERS } })),
    clearSort: () =>
      setSfs(p => ({
        ...p,
        sort: DEFAULT_SORT,
        sortDirection: DEFAULT_SORT_DIRECTION,
      })),
  };
}
