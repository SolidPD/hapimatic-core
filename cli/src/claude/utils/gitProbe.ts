// SPDX-License-Identifier: MIT
/**
 * Sub D (#1666, epic #1662): local working-tree git probe for per-turn telemetry.
 *
 * The CLI `TurnReporter` captures git_sha / branch / dirty at turn boundaries
 * because the server's git-status RPC is async and cannot run inside the
 * synchronous turn enrichment seams. This runs the SAME
 * `git status --porcelain=v2 --branch` the server's git-status RPC handler uses
 * (`cli/src/modules/common/handlers/git.ts`), parsed into a `GitSnapshot`.
 *
 * Bounded + fail-open (R9): a missing cwd, a non-git directory (exit 128), a
 * missing `git`, or a timeout all return `null` so a probe NEVER disturbs the
 * turn path. The probe fires only at turn boundaries (UserPromptSubmit / Stop
 * hooks), never on the inference hot path — a bounded synchronous git call there
 * is acceptable.
 */

import { execFileSync } from "node:child_process";

import type { GitProbe, GitSnapshot } from "./turnReporter";

/** Hard ceiling for the probe subprocess — a hung git must never stall a turn. */
const GIT_PROBE_TIMEOUT_MS = 2000;

/**
 * Parse `git status --porcelain=v2 --branch` stdout into a `GitSnapshot`.
 * - `# branch.oid <sha>` → `sha` (null for the `(initial)` sentinel — unborn HEAD)
 * - `# branch.head <name>` → `branch` (null for the `(detached)` sentinel)
 * - any entry line (`1 `, `2 `, `u `, `? `) → `dirty = true`
 *
 * Exported for unit testing — the porcelain-v2 parse is the bug-prone surface.
 */
export function parseGitStatusPorcelainV2(stdout: string): GitSnapshot {
  let sha: string | null = null;
  let branch: string | null = null;
  let dirty = false;

  for (const line of stdout.split("\n")) {
    if (line.startsWith("# branch.oid ")) {
      const value = line.slice("# branch.oid ".length).trim();
      sha = value === "(initial)" ? null : value;
    } else if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      branch = value === "(detached)" ? null : value;
    } else if (
      line.startsWith("1 ") ||
      line.startsWith("2 ") ||
      line.startsWith("u ") ||
      line.startsWith("? ")
    ) {
      dirty = true;
    }
  }

  return { sha, branch, dirty };
}

/**
 * Build the production git probe: a bounded, synchronous
 * `git status --porcelain=v2 --branch --untracked-files=all` in `cwd`, parsed
 * into a `GitSnapshot`. Returns null on a missing cwd or ANY failure (R9).
 */
export function makeGitProbe(): GitProbe {
  return (cwd: string | undefined): GitSnapshot | null => {
    if (!cwd) return null;
    try {
      const stdout = execFileSync(
        "git",
        ["status", "--porcelain=v2", "--branch", "--untracked-files=all"],
        {
          cwd,
          encoding: "utf8",
          timeout: GIT_PROBE_TIMEOUT_MS,
          // ignore stdin/stderr; only stdout is parsed. A non-git dir exits 128
          // → execFileSync throws → caught below → null.
          stdio: ["ignore", "pipe", "ignore"],
        }
      );
      return parseGitStatusPorcelainV2(stdout);
    } catch {
      return null;
    }
  };
}
