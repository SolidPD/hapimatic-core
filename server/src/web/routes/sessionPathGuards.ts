// SPDX-License-Identifier: AGPL-3.0-only
import { isAbsolute, resolve, sep } from "node:path";

/**
 * Server-side string pre-filters for session file operations (#6224 Task 9).
 *
 * The session routes (`extensions/git-rpc/routes/git.ts`) and the federation
 * receivers (`web/routes/federation/sessionData.ts`) each carried their own copy
 * of these two checks. They now share this one. The authoritative,
 * symlink-hardened guard still runs CLI-side in `validatePath`, where the file
 * lives; the server cannot realpath a remote session's filesystem, so these are
 * cheap string checks only.
 */

export type PathGuardError = { error: string; status: 400 | 403 };

/**
 * H-5 (#1281 / SEC-1, #2518): reject an absolute path and any path that
 * resolves outside the session working directory. The root itself is allowed,
 * because read, list and write legitimately target `.`.
 */
export function checkPathContainment(
  sessionPath: string,
  relPath: string
): PathGuardError | null {
  if (isAbsolute(relPath)) {
    return { error: "Absolute paths not allowed", status: 400 };
  }
  const resolvedCwd = resolve(sessionPath);
  const resolvedPath = resolve(resolvedCwd, relPath);
  if (
    resolvedPath !== resolvedCwd &&
    !resolvedPath.startsWith(resolvedCwd + sep)
  ) {
    return { error: "Path escapes session working directory", status: 403 };
  }
  return null;
}

/**
 * #2715 R5 (sweep finding 2715-1): a mutating operation must never target the
 * session working-directory root, because a recursive delete of `.` would wipe
 * the workspace. A pure `resolve()` comparison, so it is valid for a remote
 * session too.
 */
export function rejectWorkingDirRoot(
  sessionPath: string,
  relPath: string
): { error: string; status: 403 } | null {
  if (resolve(sessionPath, relPath) === resolve(sessionPath)) {
    return {
      error: "Cannot target the session working directory root",
      status: 403,
    };
  }
  return null;
}
