// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * Canonical git-root resolution — shared by the CLI daemon poller and the
 * SERVER on-demand poller (hapimatic-private#2142) so both key
 * `disabledMcpServers` by the SAME project key Claude Code (and the #1347/#2364
 * spawn scrub) uses. Formerly lived only in `cli/src/claude/utils/canonicalGitRoot.ts`
 * (which now re-exports these); the server package cannot import from `cli/`, so
 * the pure implementation moved here.
 *
 * NOTE: this module imports `node:fs` and is therefore exposed only via the
 * `@hapi/protocol/gitRoot` subpath — deliberately NOT re-exported from the
 * package barrel (`index.ts`) that the browser bundles.
 */

/**
 * Walk up from startPath looking for a `.git` file or directory.
 *
 * Returns the directory containing `.git` (regular repo OR worktree), or null
 * if no `.git` ancestor exists. Mirrors Claude Code's `findGitRoot` in
 * `utils/git.ts`.
 */
export function findGitRoot(startPath: string): string | null {
  let current: string;
  try {
    current = resolve(startPath);
  } catch {
    return null;
  }

  const fsRoot = current.substring(0, current.indexOf(sep) + 1) || sep;

  while (current !== fsRoot) {
    if (hasGit(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  if (hasGit(fsRoot)) {
    return fsRoot;
  }

  return null;
}

function hasGit(dir: string): boolean {
  try {
    const gitPath = join(dir, ".git");
    const s = statSync(gitPath);
    return s.isDirectory() || s.isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a git root to the canonical main repository root.
 *
 * - Regular repo (`.git` is a directory): returns the input root unchanged.
 * - Worktree (`.git` is a file with `gitdir: <path>`): follows the
 *   `gitdir` -> `commondir` chain to find the main repo's working directory.
 * - Submodule (`.git` is a file but no `commondir`): returns the input root.
 *
 * Two security validations reject malicious `.git` files that would otherwise
 * let a cloned/downloaded repo redirect `commondir` to attacker-controlled
 * paths. Both must pass; on failure the input root is returned (safe default).
 * On any exception, returns the input root.
 *
 * Mirrors Claude Code's `findCanonicalGitRoot` in `utils/git.ts`.
 */
export function findCanonicalGitRoot(startPath: string): string | null {
  const root = findGitRoot(startPath);
  if (!root) return null;

  try {
    const gitContent = readFileSync(join(root, ".git"), "utf-8").trim();
    if (!gitContent.startsWith("gitdir:")) {
      return root;
    }

    const worktreeGitDir = resolve(
      root,
      gitContent.slice("gitdir:".length).trim()
    );

    const commonDir = resolve(
      worktreeGitDir,
      readFileSync(join(worktreeGitDir, "commondir"), "utf-8").trim()
    );

    if (resolve(dirname(worktreeGitDir)) !== join(commonDir, "worktrees")) {
      return root;
    }

    const backlink = realpathSync(
      readFileSync(join(worktreeGitDir, "gitdir"), "utf-8").trim()
    );
    if (backlink !== join(realpathSync(root), ".git")) {
      return root;
    }

    if (basename(commonDir) !== ".git") {
      return commonDir;
    }
    return dirname(commonDir);
  } catch {
    return root;
  }
}
