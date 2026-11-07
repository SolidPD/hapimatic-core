// SPDX-License-Identifier: AGPL-3.0-only
import { getStorageKey } from "@/lib/storage-keys";
import {
  DEFAULT_SORT,
  type BrowseSort,
  type SortDir,
  type SortKey,
} from "./browseModel";

/**
 * Files tab Browse preferences (#6224): the sort, whether hidden files show, and
 * where the search box looks ("This folder" filters the listing, "Everywhere"
 * searches the session folder's tree). One port-scoped localStorage entry per
 * instance, like `lib/files-view.ts`.
 * Every access is guarded, so a disabled or full store falls back to the
 * defaults and never throws into render.
 */

export type SearchScope = "folder" | "everywhere";

export type BrowsePrefs = {
  sort: BrowseSort;
  showHidden: boolean;
  scope: SearchScope;
};

export const DEFAULT_BROWSE_PREFS: BrowsePrefs = {
  sort: DEFAULT_SORT,
  showHidden: false,
  scope: "folder",
};

const STORAGE_BASE_KEY = "hapi:files-browse:v1";
const SORT_KEYS: readonly SortKey[] = ["name", "modified", "size"];
const SORT_DIRS: readonly SortDir[] = ["asc", "desc"];

export function readBrowsePrefs(): BrowsePrefs {
  try {
    const raw = window.localStorage.getItem(getStorageKey(STORAGE_BASE_KEY));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_BROWSE_PREFS;
    const p = parsed as Record<string, unknown>;
    const key = SORT_KEYS.includes(p.sortKey as SortKey)
      ? (p.sortKey as SortKey)
      : DEFAULT_SORT.key;
    const dir = SORT_DIRS.includes(p.sortDir as SortDir)
      ? (p.sortDir as SortDir)
      : DEFAULT_SORT.dir;
    return {
      sort: { key, dir },
      showHidden: p.showHidden === true,
      scope: p.scope === "everywhere" ? "everywhere" : "folder",
    };
  } catch {
    return DEFAULT_BROWSE_PREFS;
  }
}

export function writeBrowsePrefs(prefs: BrowsePrefs): void {
  try {
    window.localStorage.setItem(
      getStorageKey(STORAGE_BASE_KEY),
      JSON.stringify({
        sortKey: prefs.sort.key,
        sortDir: prefs.sort.dir,
        showHidden: prefs.showHidden,
        scope: prefs.scope,
      })
    );
  } catch {
    // localStorage disabled or full: this change isn't saved. The next visit
    // reads the last saved prefs, or the defaults.
  }
}
