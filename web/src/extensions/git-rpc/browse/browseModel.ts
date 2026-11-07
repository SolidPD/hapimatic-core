// SPDX-License-Identifier: AGPL-3.0-only
import type { DirectoryEntry } from "@/types/api";

/**
 * Files tab Browse rules (#6224), kept apart from the components so they are
 * testable without rendering. Sorting, the hidden-file filter, the folder
 * filter and path arithmetic all live here.
 */

export type SortKey = "name" | "modified" | "size";
export type SortDir = "asc" | "desc";
export type BrowseSort = { key: SortKey; dir: SortDir };

export const DEFAULT_SORT: BrowseSort = { key: "name", dir: "asc" };

// One collator for every comparison: `localeCompare` with options builds a new
// one per call, which is measurably slow on a 5,000-entry folder. `numeric`
// sorts `file2` before `file10`, as every mainstream file manager does.
const nameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function compareNames(a: string, b: string): number {
  return nameCollator.compare(a, b);
}

const isFolder = (entry: DirectoryEntry) => entry.type === "directory";

/**
 * Folders first, then the chosen key. A missing size or date sorts last in
 * either direction, and ties fall back to the name, so the order is stable.
 */
export function sortEntries(
  entries: readonly DirectoryEntry[],
  sort: BrowseSort
): DirectoryEntry[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (isFolder(a) !== isFolder(b)) return isFolder(a) ? -1 : 1;
    if (sort.key !== "name") {
      const field = sort.key === "size" ? "size" : "modified";
      const av = a[field];
      const bv = b[field];
      if (av === undefined && bv !== undefined) return 1;
      if (bv === undefined && av !== undefined) return -1;
      if (av !== undefined && bv !== undefined && av !== bv) {
        return (av - bv) * sign;
      }
    }
    const byName = compareNames(a.name, b.name);
    return sort.key === "name" ? byName * sign : byName;
  });
}

export function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

// The partial file a Browse upload writes before it commits (PR-3); never listed.
const UPLOAD_PARTIAL = /^\.hapi-upload-.+\.partial$/;

export function isUploadPartial(name: string): boolean {
  return UPLOAD_PARTIAL.test(name);
}

/**
 * The entries Browse shows: upload partials never, hidden names only when
 * asked, and only those whose name contains the folder filter (case-blind).
 * `hiddenCount` is what the hidden-file toggle would add back.
 */
export function visibleEntries(
  entries: readonly DirectoryEntry[],
  options: { showHidden: boolean; filter: string; sort: BrowseSort }
): { entries: DirectoryEntry[]; hiddenCount: number } {
  const needle = options.filter.trim().toLocaleLowerCase();
  let hiddenCount = 0;
  const kept = entries.filter(entry => {
    if (isUploadPartial(entry.name)) return false;
    if (needle && !entry.name.toLocaleLowerCase().includes(needle)) {
      return false;
    }
    if (!options.showHidden && isHiddenName(entry.name)) {
      hiddenCount += 1;
      return false;
    }
    return true;
  });
  return { entries: sortEntries(kept, options.sort), hiddenCount };
}

/** Join a relative browse path and a child name; `.` / "" is the root. */
export function joinBrowsePath(base: string, child: string): string {
  if (base === "" || base === ".") return child;
  return `${base}/${child}`;
}

/** The parent of a relative browse path; the root's parent is the root. */
export function parentBrowsePath(path: string): string {
  if (path === "" || path === ".") return ".";
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "." : path.slice(0, slash);
}

function trimTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end -= 1;
  return path.slice(0, end);
}

/** The absolute path on the session's machine, for Copy path. */
export function absolutePath(sessionRoot: string, relPath: string): string {
  const root = trimTrailingSlashes(sessionRoot) || "/";
  if (relPath === "" || relPath === ".") return root;
  return root === "/" ? `/${relPath}` : `${root}/${relPath}`;
}

/** The last segment of a path, for the breadcrumb root label. */
export function baseName(path: string): string {
  const trimmed = trimTrailingSlashes(path);
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

// Epic #3285 correction pass 1: the raw transport error the RPC gateway throws
// when a session's CLI process has no file handlers ("RPC handler not
// registered: …" — a session started on an older Hapimatic binary, or one whose
// CLI is gone) is meaningless to the user. Map it to an actionable sentence; any
// other error passes through verbatim.
const RPC_HANDLER_MISSING_COPY =
  "File browsing is not available for this session's CLI process — it predates the file-browser handlers or is no longer running. Reconnect the session to enable it.";

export function friendlyRpcError(message: string): string {
  return /RPC handler not registered|RPC socket|not connected to daemon/i.test(
    message
  )
    ? RPC_HANDLER_MISSING_COPY
    : message;
}
