// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Resolve git repo identity from a directory path.
 * Runs `git remote get-url origin` and parses the result.
 * Uses an in-memory cache to avoid repeated shell calls. A negative answer
 * ("no origin", "not a repository") is kept at most
 * `REPO_IDENTITY_NEGATIVE_TTL_MS`, so a folder that becomes a repository is
 * seen as one within that time (#6780, ruling D-A).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { GIT_REMOTE_TIMEOUT_MS, parseGitRemoteUrl } from "@hapi/protocol";

export type RepoIdentity = {
  name: string;
  url?: string;
};

/**
 * Issue #6780 (ruling D-A): how long a negative answer on an existing folder is
 * kept, by both caches below. The Create page's project chip shows what this
 * file answers, while a session's CLI asks git afresh
 * (`cli/src/agent/sessionFactory.ts`), so a negative kept forever showed a folder
 * path for a folder that had since become a repository. One git call per such
 * folder per minute is the cost.
 */
export const REPO_IDENTITY_NEGATIVE_TTL_MS = 60_000;

/** A kept negative answer: when it was taken (`Date.now()`). */
type NegativeAnswer = { negativeAt: number };

const negativeAnswer = (): NegativeAnswer => ({ negativeAt: Date.now() });

/** True while a kept negative answer is younger than the time limit. */
function isFreshNegative(entry: NegativeAnswer): boolean {
  return Date.now() - entry.negativeAt < REPO_IDENTITY_NEGATIVE_TTL_MS;
}

const cache = new Map<string, RepoIdentity | NegativeAnswer>();

// Issue #2270 (F25): TRUE git-ness cache, distinct from `cache` above.
// `resolveRepoIdentity` answers "does this dir have a forge-parseable origin?"
// (forge identity); this answers "is this dir inside a git work tree?" — the
// question the Git-Type control actually needs. A `git init`/no-origin/
// local-path/NAS-path-origin repo has NO forge identity but IS a git repo the
// daemon can worktree-spawn in (`worktree.ts` fetch is non-fatal without origin).
const gitRepoCache = new Map<string, true | NegativeAnswer>();

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
  const kept = gitRepoCache.get(directory);
  if (kept === true) return true;
  if (kept !== undefined) {
    if (isFreshNegative(kept)) return false;
    gitRepoCache.delete(directory);
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
    // cache it, so a later call can still resolve `true`. Only keep a genuine
    // git failure on an EXISTING directory (not a repo), and only for
    // REPO_IDENTITY_NEGATIVE_TTL_MS (#6780, ruling D-A). A missing directory
    // never reaches here (#3558, R8).
    const e = err as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string;
    };
    const isTransient =
      e?.killed === true || e?.signal === "SIGTERM" || e?.code === "ETIMEDOUT";
    if (!isTransient) {
      gitRepoCache.set(directory, negativeAnswer());
    }
    return false;
  }
}

export function resolveRepoIdentity(
  directory: string
): RepoIdentity | undefined {
  const kept = cache.get(directory);
  if (kept !== undefined) {
    if (!("negativeAt" in kept)) return kept;
    if (isFreshNegative(kept)) return undefined;
    cache.delete(directory);
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
      // Issue #6646: one budget shared with the CLI's resolver.
      timeout: GIT_REMOTE_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!remoteUrl) {
      cache.set(directory, negativeAnswer());
      return undefined;
    }

    const parsed = parseGitRemoteUrl(remoteUrl);
    if (!parsed) {
      cache.set(directory, negativeAnswer());
      return undefined;
    }

    cache.set(directory, parsed);
    return parsed;
  } catch (err) {
    // A timeout / process-kill is TRANSIENT (slow CIFS under load) — do NOT
    // poison the cache with a negative, so a later call can still succeed.
    // Only keep a negative, for REPO_IDENTITY_NEGATIVE_TTL_MS, for a genuine
    // git failure on an EXISTING directory (no origin remote, or not a repo).
    // A missing directory never reaches here (#3558, R8).
    const e = err as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string;
    };
    const isTransient =
      e?.killed === true || e?.signal === "SIGTERM" || e?.code === "ETIMEDOUT";
    if (!isTransient) {
      cache.set(directory, negativeAnswer());
    }
    return undefined;
  }
}
