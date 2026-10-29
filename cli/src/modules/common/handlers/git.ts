// SPDX-License-Identifier: AGPL-3.0-only
import { execFile, type ExecFileOptions } from "child_process";
import { realpathSync } from "fs";
import { isAbsolute, resolve } from "path";
import { promisify } from "util";
import { validateBranchName } from "@hapi/protocol/gitBranches";
import type { RpcHandlerManager } from "@/api/rpc/RpcHandlerManager";
import { validatePath } from "../pathSecurity";
import { rpcError } from "../rpcResponses";
import {
  GIT_STATUS_META,
  GIT_DIFF_NUMSTAT_META,
  GIT_DIFF_FILE_META,
  GIT_REMOTE_URL_META,
} from "@/api/rpc/capabilityMeta";
import { isBranchPreserved, readBranchOriginMarker } from "@/daemon/worktree";

const execFileAsync = promisify(execFile);

interface GitStatusRequest {
  cwd?: string;
  timeout?: number;
}

interface GitDiffNumstatRequest {
  cwd?: string;
  staged?: boolean;
  /**
   * #4469: a branch name to measure the diff against (a fan-out parent's
   * branch). Absent → the plain uncommitted diff, unchanged.
   */
  base?: string;
  timeout?: number;
}

interface GitDiffFileRequest {
  cwd?: string;
  filePath: string;
  staged?: boolean;
  /** #4469: see {@link GitDiffNumstatRequest.base}. */
  base?: string;
  timeout?: number;
}

/**
 * #4469: which commit a `base` diff was measured against.
 * - `branch-start`: the commit this session's own branch was created from
 *   (its oldest reflog entry), so the count holds only this branch's work,
 *   even after the base branch is rebased.
 * - `merge-base`: `git merge-base refs/heads/<base> HEAD`; it can include
 *   upstream commits the base branch did not have when this branch started.
 */
type DiffBaseSource = "branch-start" | "merge-base";

interface GitCommandResponse {
  success: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
  /** #4469: echoed when the request carried a `base`. */
  base?: string;
  /**
   * #4469: the commit the diff was measured against. Absent with a `base` means
   * neither step resolved, and the answer is the plain uncommitted diff —
   * callers label it "uncommitted only" (never a failed call).
   */
  mergeBase?: string;
  baseSource?: DiffBaseSource;
}

function resolveCwd(
  requestedCwd: string | undefined,
  workingDirectory: string
): { cwd: string; error?: string } {
  const cwd = requestedCwd ?? workingDirectory;
  const validation = validatePath(cwd, workingDirectory);
  if (!validation.valid) {
    return { cwd, error: validation.error ?? "Invalid working directory" };
  }
  return { cwd };
}

function validateFilePath(
  filePath: string,
  workingDirectory: string
): string | null {
  const validation = validatePath(filePath, workingDirectory);
  if (!validation.valid) {
    return validation.error ?? "Invalid file path";
  }
  return null;
}

async function runGitCommand(
  args: string[],
  cwd: string,
  timeout?: number
): Promise<GitCommandResponse> {
  try {
    const options: ExecFileOptions = {
      cwd,
      timeout: timeout ?? 10_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    };
    const { stdout, stderr } = await execFileAsync("git", args, options);
    return {
      success: true,
      stdout: stdout ? stdout.toString() : "",
      stderr: stderr ? stderr.toString() : "",
      exitCode: 0,
    };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
    };

    if (execError.code === "ETIMEDOUT" || execError.killed) {
      return rpcError("Command timed out", {
        stdout: execError.stdout ? execError.stdout.toString() : "",
        stderr: execError.stderr ? execError.stderr.toString() : "",
        exitCode: typeof execError.code === "number" ? execError.code : -1,
      });
    }

    return rpcError(execError.message || "Command failed", {
      stdout: execError.stdout ? execError.stdout.toString() : "",
      stderr: execError.stderr
        ? execError.stderr.toString()
        : execError.message || "Command failed",
      exitCode: typeof execError.code === "number" ? execError.code : 1,
    });
  }
}

const SHA_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * #4469: check a requested diff `base`. Returns `undefined` for an absent or
 * empty base, the name when it is a valid branch name, or `null` when it is
 * invalid. `validateBranchName` trims its input and accepts "", so a base that
 * differs from its trimmed form is refused here first; git then gets the last
 * word with `check-ref-format --branch`.
 */
async function checkDiffBase(
  base: string | undefined,
  cwd: string,
  timeout?: number
): Promise<string | undefined | null> {
  if (base === undefined || base === "") return undefined;
  if (base !== base.trim()) return null;
  if (validateBranchName(base) !== null) return null;
  const formatted = await runGitCommand(
    ["check-ref-format", "--branch", base],
    cwd,
    timeout
  );
  return formatted.success ? base : null;
}

/** Resolve a git path the way `probeLinkedWorktree` compares them. */
function normalizeGitPath(rawPath: string, cwd: string): string {
  const resolved = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * #4469 step 1: the commit the session's own branch was created from, read
 * from the OLDEST reflog entry of `refs/heads/<branch>` (`git worktree add -b`
 * writes `branch: Created from <start>`). Used only when every guard holds,
 * because a branch that existed before the session (an `existing-local` pick,
 * a main checkout's long-lived branch, or the base branch itself) has a
 * creation entry older than the session.
 */
async function findBranchStart(
  base: string,
  cwd: string,
  timeout?: number
): Promise<string | null> {
  const head = await runGitCommand(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    cwd,
    timeout
  );
  const branch = head.success ? (head.stdout ?? "").trim() : "";
  if (!branch || branch === base) return null;

  const dirs = await runGitCommand(
    ["rev-parse", "--git-dir", "--git-common-dir"],
    cwd,
    timeout
  );
  if (!dirs.success) return null;
  const [gitDir, commonDir] = (dirs.stdout ?? "").trim().split("\n");
  if (!gitDir || !commonDir) return null;
  if (normalizeGitPath(gitDir, cwd) === normalizeGitPath(commonDir, cwd)) {
    return null; // not a linked worktree
  }

  if (isBranchPreserved(await readBranchOriginMarker(cwd, branch))) {
    return null;
  }

  const reflog = await runGitCommand(
    ["reflog", "show", "--format=%H %gs", `refs/heads/${branch}`],
    cwd,
    timeout
  );
  if (!reflog.success) return null;
  const entries = (reflog.stdout ?? "")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0);
  const oldest = entries[entries.length - 1];
  if (!oldest) return null;
  const space = oldest.indexOf(" ");
  const sha = space > 0 ? oldest.slice(0, space) : "";
  const subject = space > 0 ? oldest.slice(space + 1) : "";
  if (!SHA_PATTERN.test(sha) || !subject.startsWith("branch: Created from")) {
    return null;
  }

  const ancestor = await runGitCommand(
    ["merge-base", "--is-ancestor", sha, "HEAD"],
    cwd,
    timeout
  );
  return ancestor.success ? sha : null;
}

/**
 * #4469: pick the commit a `base` diff is measured against — the branch start
 * (step 1), else `git merge-base refs/heads/<base> HEAD` (step 2), else null
 * (step 3: merge-base found no common commit, e.g. the base branch is missing,
 * the histories are unrelated, or git failed or timed out; the caller answers
 * the plain uncommitted diff). `.worktree-meta.json` is never read: it records no
 * start commit and its `source_branch` can be overwritten (#4487).
 */
async function resolveDiffBase(
  base: string,
  cwd: string,
  timeout?: number
): Promise<{ mergeBase: string; baseSource: DiffBaseSource } | null> {
  const start = await findBranchStart(base, cwd, timeout);
  if (start) return { mergeBase: start, baseSource: "branch-start" };

  const mergeBase = await runGitCommand(
    ["merge-base", `refs/heads/${base}`, "HEAD"],
    cwd,
    timeout
  );
  const sha = mergeBase.success ? (mergeBase.stdout ?? "").trim() : "";
  if (SHA_PATTERN.test(sha))
    return { mergeBase: sha, baseSource: "merge-base" };
  return null;
}

/**
 * #4469: run a diff with an optional `base`. `buildArgs` gets the resolved
 * commit (or undefined for the plain diff). Committed and uncommitted TRACKED
 * changes count against the base; untracked files never do.
 */
async function runDiffWithBase(
  requestedBase: string | undefined,
  cwd: string,
  timeout: number | undefined,
  buildArgs: (mergeBase: string | undefined) => string[]
): Promise<GitCommandResponse> {
  const base = await checkDiffBase(requestedBase, cwd, timeout);
  if (base === null) return rpcError("invalid base");
  if (base === undefined) {
    return await runGitCommand(buildArgs(undefined), cwd, timeout);
  }
  const resolved = await resolveDiffBase(base, cwd, timeout);
  if (!resolved) {
    return {
      ...(await runGitCommand(buildArgs(undefined), cwd, timeout)),
      base,
    };
  }
  const result = await runGitCommand(
    buildArgs(resolved.mergeBase),
    cwd,
    timeout
  );
  return { ...result, base, ...resolved };
}

export function registerGitHandlers(
  rpcHandlerManager: RpcHandlerManager,
  workingDirectory: string
): void {
  rpcHandlerManager.registerHandler<GitStatusRequest, GitCommandResponse>(
    "git-status",
    async data => {
      const resolved = resolveCwd(data.cwd, workingDirectory);
      if (resolved.error) {
        return rpcError(resolved.error);
      }
      return await runGitCommand(
        ["status", "--porcelain=v2", "--branch", "--untracked-files=all"],
        resolved.cwd,
        data.timeout
      );
    },
    GIT_STATUS_META
  );

  rpcHandlerManager.registerHandler<GitDiffNumstatRequest, GitCommandResponse>(
    "git-diff-numstat",
    async data => {
      const resolved = resolveCwd(data.cwd, workingDirectory);
      if (resolved.error) {
        return rpcError(resolved.error);
      }
      return await runDiffWithBase(
        data.base,
        resolved.cwd,
        data.timeout,
        mergeBase => [
          "diff",
          ...(data.staged ? ["--cached"] : []),
          "--numstat",
          ...(mergeBase ? [mergeBase] : []),
        ]
      );
    },
    GIT_DIFF_NUMSTAT_META
  );

  rpcHandlerManager.registerHandler<GitDiffFileRequest, GitCommandResponse>(
    "git-diff-file",
    async data => {
      const resolved = resolveCwd(data.cwd, workingDirectory);
      if (resolved.error) {
        return rpcError(resolved.error);
      }
      const fileError = validateFilePath(data.filePath, workingDirectory);
      if (fileError) {
        return rpcError(fileError);
      }

      return await runDiffWithBase(
        data.base,
        resolved.cwd,
        data.timeout,
        mergeBase => [
          "diff",
          ...(data.staged ? ["--cached"] : []),
          "--no-ext-diff",
          ...(mergeBase ? [mergeBase] : []),
          "--",
          data.filePath,
        ]
      );
    },
    GIT_DIFF_FILE_META
  );

  rpcHandlerManager.registerHandler<GitStatusRequest, GitCommandResponse>(
    "git-remote-url",
    async data => {
      const resolved = resolveCwd(data.cwd, workingDirectory);
      if (resolved.error) {
        return rpcError(resolved.error);
      }
      return await runGitCommand(
        ["remote", "get-url", "origin"],
        resolved.cwd,
        data.timeout
      );
    },
    GIT_REMOTE_URL_META
  );
}
