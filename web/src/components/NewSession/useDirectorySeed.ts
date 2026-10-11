// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from "react";
import type { MutableRefObject } from "react";

/**
 * Resolve the directory the Create page should pre-populate, from the seed
 * sources in precedence order. Pure — unit-testable without React.
 *
 * Precedence (issue #2533 / #2269 F18):
 *   1. Most-recent node-scoped path — operator history wins (recentPaths is
 *      already scoped to the selected target via useRecentPaths).
 *   2. The selected remote node's advertised home dir — its REAL home, which
 *      the hub-scoped default need not match on a cloud VM (the MS1 502/ENOENT
 *      trigger: a hub path like /home/matt does not exist on the VM).
 *   3. The hub's daemon-user home (versionInfo.defaultDirectory).
 * Returns undefined when no source is available (leave the field blank).
 */
export function resolveDirectorySeed(opts: {
  recentPaths: readonly string[];
  nodeHomeDir?: string;
  defaultDirectory?: string;
}): string | undefined {
  if (opts.recentPaths[0]) return opts.recentPaths[0];
  if (opts.nodeHomeDir) return opts.nodeHomeDir;
  if (opts.defaultDirectory) return opts.defaultDirectory;
  return undefined;
}

/**
 * Pre-populate the Create page's Directory field from the best available seed,
 * until the user has taken over the field. The `hasUserEdited` ref is owned by
 * the caller (it is also flipped by the Directory change / clone handlers, and
 * reset to `false` when the spawn target changes so the new target re-seeds).
 *
 * Re-seeds when the seed sources change (e.g. switching the spawn target to a
 * different node surfaces that node's `homeDir` / recent paths) — but only while
 * `hasUserEdited.current` is false.
 */
export function useDirectorySeed(opts: {
  hasUserEdited: MutableRefObject<boolean>;
  recentPaths: readonly string[];
  nodeHomeDir?: string;
  defaultDirectory?: string;
  setDirectory: (path: string) => void;
}): void {
  const {
    hasUserEdited,
    recentPaths,
    nodeHomeDir,
    defaultDirectory,
    setDirectory,
  } = opts;

  useEffect(() => {
    if (hasUserEdited.current) return;
    const seed = resolveDirectorySeed({
      recentPaths,
      nodeHomeDir,
      defaultDirectory,
    });
    if (seed) setDirectory(seed);
  }, [hasUserEdited, recentPaths, nodeHomeDir, defaultDirectory, setDirectory]);
}
