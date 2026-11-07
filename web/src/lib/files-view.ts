// SPDX-License-Identifier: AGPL-3.0-only
import { getStorageKey } from "@/lib/storage-keys";
import type { GitStatusFiles } from "@/types/api";

/**
 * Files tab (issue #6222): the view a session's tab remembers, and whether its
 * Changes view is on offer. Kept apart from the page so the rules are testable
 * without rendering it.
 */

export type FilesView = "changes" | "browse";

export type ChangesAvailability = "available" | "unavailable" | "unknown";

// One port-scoped map. Browse is the default, so only sessions left on Changes
// have an entry. Capped rather than pruned against the session list, because that
// list can briefly hold only this node's sessions on a federation hub, and a prune
// then would forget the view of every session on another node.
const STORAGE_BASE_KEY = "hapi:files-view:v1";
const MAX_REMEMBERED_SESSIONS = 200;

function readViews(): Record<string, unknown> {
  try {
    const raw = window.localStorage.getItem(getStorageKey(STORAGE_BASE_KEY));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function readFilesView(sessionId: string): FilesView {
  return readViews()[sessionId] === "changes" ? "changes" : "browse";
}

export function writeFilesView(sessionId: string, view: FilesView): void {
  const views = readViews();
  // Deleting first moves a re-chosen session to the end, so the cap drops the
  // session that has gone longest without being chosen.
  delete views[sessionId];
  if (view === "changes") {
    views[sessionId] = "changes";
    const sessionIds = Object.keys(views);
    const excess = sessionIds.length - MAX_REMEMBERED_SESSIONS;
    for (const oldest of sessionIds.slice(0, Math.max(0, excess))) {
      delete views[oldest];
    }
  }
  try {
    window.localStorage.setItem(
      getStorageKey(STORAGE_BASE_KEY),
      JSON.stringify(views)
    );
  } catch {
    // localStorage disabled/full: the tab opens on Browse next time.
  }
}

// Git's two "no repo" messages both open this way. The bare "not a git repository:
// <path>" means a repo with a broken link (a moved main repo, a missing submodule
// gitdir), which may have real changes and an error the user needs to see.
const NOT_A_GIT_REPO = /not a git repository \(or any/i;

// `git diff -- <path>` outside a repo does not print either message above: it
// warns "Not a git repository. Use --no-index to compare two paths outside a
// working tree" and prints its usage (git 2.43, verified 2026-11-05 for #6224).
const DIFF_OUTSIDE_REPO = /Not a git repository\. Use --no-index/;

/**
 * #6224: whether a file-diff error only means "this folder is not a Git repo",
 * so the file viewer can drop the diff instead of showing git's usage text. A
 * broken-repo error (`not a git repository: <path>`) is NOT this, and stays
 * visible.
 */
export function isNoRepoGitError(error: string | null | undefined): boolean {
  if (!error) return false;
  return NOT_A_GIT_REPO.test(error) || DIFF_OUTSIDE_REPO.test(error);
}

/**
 * Whether Changes has anything to show. Only a positive signal makes it
 * unavailable: a repo with nothing changed and no error, or git reporting no repo.
 * Any other failure (a timeout, an RPC error, a failed refetch over an old clean
 * status) is "unknown", so an unexplained failure never hides Changes in a repo
 * that has changes.
 */
export function getChangesAvailability(
  status: Pick<GitStatusFiles, "totalStaged" | "totalUnstaged"> | null,
  error: string | null
): ChangesAvailability {
  if (status && status.totalStaged + status.totalUnstaged > 0) {
    return "available";
  }
  if (status) return error ? "unknown" : "unavailable";
  return error && NOT_A_GIT_REPO.test(error) ? "unavailable" : "unknown";
}

/** Whether the Changes button can be tapped while the tab is showing Browse. */
export function isChangesSelectable(
  availability: ChangesAvailability,
  gitSettled: boolean
): boolean {
  if (availability === "available") return true;
  return availability === "unknown" && gitSettled;
}

/**
 * Whether a session left on Changes has to show Browse instead. Waits for Git
 * status to settle, so a stale cached "no changes" does not send it to Browse when
 * the refetch in flight is about to find some.
 */
export function shouldFallBackToBrowse(
  chosen: FilesView,
  availability: ChangesAvailability,
  gitSettled: boolean
): boolean {
  return chosen === "changes" && gitSettled && availability === "unavailable";
}
