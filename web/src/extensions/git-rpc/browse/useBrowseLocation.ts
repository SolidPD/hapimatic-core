// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { decodeBase64, encodeBase64 } from "@/lib/utils";

/**
 * #6224 Task 2: the Files tab's folder and search live in the URL (`dir`, the
 * base64 relative folder, and `q`), so the viewer can hand them back and Back
 * returns to the same place.
 */

/** The relative folder a URL names, or `.` when absent or invalid. */
export function decodeBrowseDir(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return ".";
  const { text, ok } = decodeBase64(raw);
  if (!ok || !text) return ".";
  // A hand-edited URL never names a folder above the session folder; the
  // server and CLI refuse one too.
  if (text.startsWith("/") || text.split("/").includes("..")) return ".";
  return text;
}

/** The `dir` value for a relative folder; absent at the session folder. */
export function encodeBrowseDir(path: string): string | undefined {
  return path === "." || path === "" ? undefined : encodeBase64(path);
}

/** The `dir` and `q` to hand to the file viewer, omitting the empty ones. */
export function browseLocationSearch(
  path: string,
  query: string
): { dir?: string; q?: string } {
  const dir = encodeBrowseDir(path);
  const q = query.trim();
  return {
    ...(dir ? { dir } : {}),
    ...(q ? { q } : {}),
  };
}

export function useBrowseLocation(sessionId: string) {
  const navigate = useNavigate();
  // `select` keeps each read to one string, so a search write re-renders only
  // when that value changes. A non-string read (a missing key) is absent.
  const rawDir: unknown = useSearch({
    from: "/sessions/$sessionId/files",
    select: search => search.dir,
  });
  const rawQuery: unknown = useSearch({
    from: "/sessions/$sessionId/files",
    select: search => search.q,
  });

  // Entering a folder is a history entry, so the browser's Back steps out of it.
  const pushDir = useCallback(
    (path: string) => {
      void navigate({
        to: "/sessions/$sessionId/files",
        params: { sessionId },
        search: browseLocationSearch(path, ""),
      });
    },
    [navigate, sessionId]
  );

  // A search edit replaces the entry, so typing never fills the history.
  const replaceQuery = useCallback(
    (query: string) => {
      const q = query.trim();
      void navigate({
        to: "/sessions/$sessionId/files",
        params: { sessionId },
        search: prev => ({ ...prev, q: q || undefined }),
        replace: true,
      });
    },
    [navigate, sessionId]
  );

  return {
    urlDir: decodeBrowseDir(rawDir),
    urlQuery: typeof rawQuery === "string" ? rawQuery : "",
    pushDir,
    replaceQuery,
  };
}
