// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Create-page branch listing runner (hapimatic-private#4481).
 *
 * Runs git against a directory on THIS node and returns a {@link GitBranchListing}.
 * Called in-process for a local target (`GET /api/git/branches`) and by the
 * federation peer receiver (`POST /api/federation/git-branches`) for a remote
 * target, so the listing always reflects the TARGET node's repository.
 *
 * Deliberately async (`execFile`, bounded timeout) — unlike `isGitRepo`
 * (`repoIdentity.ts`), which blocks the event loop with `execFileSync`. No
 * `git fetch` here: first paint stays a pair of local reads; remote refs are as
 * fresh as the last fetch, and the spawn path fetches the chosen remote branch.
 *
 * Path policy (tilde expansion, `isSafeMachinePath`) is the CALLER's job; this
 * module only answers "what branches does this directory's repo have".
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import {
  buildBranchListing,
  FOR_EACH_REF_FORMAT,
  NON_GIT_LISTING,
  parseForEachRef,
  parseWorktreePorcelain,
  type GitBranchListing,
} from "@hapi/protocol/gitBranches";

const execFileAsync = promisify(execFile);

/** Matches `isGitRepo`'s CIFS-aware budget (a cold `.git` stat on a NAS mount). */
const GIT_LIST_TIMEOUT_MS = 10_000;

async function git(directory: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: directory,
    timeout: GIT_LIST_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

export async function listGitBranches(
  directory: string,
  options?: { limit?: number }
): Promise<GitBranchListing> {
  if (!directory || !existsSync(directory)) return NON_GIT_LISTING;

  let repoRoot: string;
  try {
    repoRoot = (await git(directory, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return NON_GIT_LISTING;
  }
  if (!repoRoot) return NON_GIT_LISTING;

  // Both reads must succeed for an honest listing — a failure here propagates
  // so the route reports "unavailable" rather than a misleading empty list.
  const [refsOut, worktreesOut] = await Promise.all([
    git(directory, [
      "for-each-ref",
      "--sort=-committerdate",
      `--format=${FOR_EACH_REF_FORMAT}`,
      "refs/heads",
      "refs/remotes/origin",
    ]),
    git(directory, ["worktree", "list", "--porcelain"]),
  ]);
  const refs = parseForEachRef(refsOut);

  let detachedSha: string | null = null;
  let unbornName: string | null = null;
  if (!refs.some(r => r.isHead && r.source === "local")) {
    // No ref is HEAD: either an unborn branch (symbolic-ref resolves, no commit)
    // or a detached HEAD (symbolic-ref fails, rev-parse yields the commit).
    const symbolic = await git(directory, [
      "symbolic-ref",
      "-q",
      "--short",
      "HEAD",
    ]).catch(() => "");
    if (symbolic.trim()) {
      unbornName = symbolic.trim();
    } else {
      detachedSha =
        (
          await git(directory, ["rev-parse", "--short", "HEAD"]).catch(() => "")
        ).trim() || null;
    }
  }

  return buildBranchListing({
    refs,
    worktrees: parseWorktreePorcelain(worktreesOut),
    repoRoot,
    detachedSha,
    unbornName,
    limit: options?.limit,
  });
}
