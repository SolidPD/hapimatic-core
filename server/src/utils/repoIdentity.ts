// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Resolve git repo identity from a directory path.
 * Runs `git remote get-url origin` and parses the result.
 * Uses an in-memory cache to avoid repeated shell calls.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export type RepoIdentity = {
  name: string;
  url?: string;
};

const cache = new Map<string, RepoIdentity | null>();

// Issue #2270 (F25): TRUE git-ness cache, distinct from `cache` above.
// `resolveRepoIdentity` answers "does this dir have a forge-parseable origin?"
// (forge identity); this answers "is this dir inside a git work tree?" — the
// question the Git-Type control actually needs. A `git init`/no-origin/
// local-path/NAS-path-origin repo has NO forge identity but IS a git repo the
// daemon can worktree-spawn in (`worktree.ts` fetch is non-fatal without origin).
const gitRepoCache = new Map<string, boolean>();

/**
 * Issue #2270 (F25): true git-ness probe for a directory.
 *
 * Runs `git rev-parse --show-toplevel` — the SAME probe the daemon uses at
 * spawn time (`cli/src/daemon/sessionSpawner.ts`) — so the web Git-Type control
 * and the daemon's worktree gate agree by construction. Returns `true` iff
 * `directory` is inside a git work tree.
 *
 * Distinct from `resolveRepoIdentity`, which requires a forge-parseable `origin`
 * remote and would read `false` for a no-origin repo the daemon spawns in fine.
 * A transient timeout / kill (slow CIFS under load) returns `false` WITHOUT
 * poisoning the cache, so a later call can still resolve the true answer — the
 * tri-state control leaves the Worktree option selectable regardless, so a rare
 * transient false-negative only changes the DEFAULT, never blocks a worktree.
 */
export function isGitRepo(directory: string): boolean {
  if (gitRepoCache.has(directory)) {
    return gitRepoCache.get(directory) ?? false;
  }
  // #3558 (R8): a directory that does not exist YET is not a stable negative —
  // the clone-on-spawn destination is probed before the daemon clones it (in a
  // different process). Answer false WITHOUT caching so the next probe, after
  // the clone lands, sees the real answer.
  if (!existsSync(directory)) {
    return false;
  }

  try {
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: directory,
      // Match resolveRepoIdentity's CIFS-aware budget — a cold `.git` stat up
      // the tree on a NAS mount can take several seconds.
      timeout: 10000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    gitRepoCache.set(directory, true);
    return true;
  } catch (err) {
    // A timeout / process-kill is TRANSIENT (slow CIFS under load) — do NOT
    // cache it, so a later call can still resolve `true`. Only cache a genuine
    // git failure on an EXISTING directory (not a repo), which is a stable
    // negative. A missing directory never reaches here (#3558, R8).
    const e = err as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string;
    };
    const isTransient =
      e?.killed === true || e?.signal === "SIGTERM" || e?.code === "ETIMEDOUT";
    if (!isTransient) {
      gitRepoCache.set(directory, false);
    }
    return false;
  }
}

function parseGitRemoteUrl(
  remoteUrl: string
): { name: string; url?: string } | null {
  const trimmed = remoteUrl.trim();

  // SSH format: git@github.com:owner/repo.git
  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const [, host, owner, repo] = sshMatch;
    const name = `${owner}/${repo}`;
    const isGitHub = host === "github.com";
    return {
      name,
      url: isGitHub ? `https://github.com/${name}` : `https://${host}/${name}`,
    };
  }

  // HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = trimmed.match(
    /^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/
  );
  if (httpsMatch) {
    const [, host, owner, repo] = httpsMatch;
    const name = `${owner}/${repo}`;
    return { name, url: `https://${host}/${name}` };
  }

  return null;
}

export function resolveRepoIdentity(
  directory: string
): RepoIdentity | undefined {
  if (cache.has(directory)) {
    return cache.get(directory) ?? undefined;
  }
  // #3558 (R8): see isGitRepo — never cache a negative for a directory that
  // does not exist yet (the clone-on-spawn destination).
  if (!existsSync(directory)) {
    return undefined;
  }

  try {
    const remoteUrl = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: directory,
      encoding: "utf8",
      // Bumped from 3000ms: `git` on a CIFS mount (e.g. /mnt/netshare,
      // cache=none) can take 6+ seconds for a cold round-trip to the NAS,
      // which exceeded the old 3s timeout under load and poisoned the cache.
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!remoteUrl) {
      cache.set(directory, null);
      return undefined;
    }

    const parsed = parseGitRemoteUrl(remoteUrl);
    if (!parsed) {
      cache.set(directory, null);
      return undefined;
    }

    cache.set(directory, parsed);
    return parsed;
  } catch (err) {
    // A timeout / process-kill is TRANSIENT (slow CIFS under load) — do NOT
    // poison the cache with `null`, so a later call can still succeed. Only
    // cache `null` for a genuine git failure on an EXISTING directory (no
    // origin remote, or not a repo), which is a stable, correct negative
    // result. A missing directory never reaches here (#3558, R8).
    const e = err as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string;
    };
    const isTransient =
      e?.killed === true || e?.signal === "SIGTERM" || e?.code === "ETIMEDOUT";
    if (!isTransient) {
      cache.set(directory, null);
    }
    return undefined;
  }
}
