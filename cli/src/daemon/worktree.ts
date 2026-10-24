// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- Grandfathered god-file (Epic 0, #2077); decomposition verdict tracked in claudedocs/architecture-hotspot-review.md. */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  access,
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { WorktreeMetaSchema, trimChars } from "@hapi/protocol";
import type { ExistingBranch } from "@hapi/protocol/gitBranches";

import { logger } from "@/ui/logger";
import { withFileLock } from "@/utils/fileLock";
import { deriveWorktreeBranchName } from "@/utils/id";
import { logProcessHygieneEvent } from "@/utils/processHygieneEvents";
import { probeLinkedWorktree } from "@/utils/worktreeEnv";

import {
  buildScrubbedGitEnv,
  collectOwnedWorktreePorts,
  detectSourceBranch,
  getGitFetchTimeoutMs,
  getGitTimeoutMs,
  getListeningPorts,
  getWorktreeAddTimeoutMs,
  readClaimedPort,
  writeWorktreeMeta,
} from "./worktreeMeta";
import { resolveWorktreeHostBase } from "./worktreeHostBase";

const execFileAsync = promisify(execFile);

export type WorktreeInfo = {
  basePath: string;
  worktreePath: string;
  branch: string;
  name: string;
  createdAt: number;
};

type WorktreeResult =
  | { ok: true; info: WorktreeInfo }
  | { ok: false; error: string };

export type RemoveWorktreeResult = { ok: true } | { ok: false; error: string };

const MAX_ATTEMPTS = 5;
const TRASH_DIR_NAME = ".trash";
// Retention window for the AUTOMATIC purge. TWO automatic triggers exist
// (issue #3451): (1) the daemon at worktree-spawn time (see sessionSpawner.ts +
// the single-flight `kickExpiredWorktreePurge()` below), and (2) the daily
// 05:00-local `SupervisedLoop` collector (`cli/src/daemon/worktreeCollector.ts`),
// which sweeps every discovered repo root when `HAPI_WORKTREE_COLLECTOR=1` is set
// on the daemon's systemd unit (exactly one daemon per node — DEFAULT OFF).
// `scripts/hapi-worktree.sh purge` and `scripts/worktree-cleanup.sh clean` remain
// manual-only and each hardcode their own mirror of this value; bump all three
// together to keep them consistent.
const DEFAULT_RETENTION_DAYS = 10;

export type SoftDeleteMetadata = {
  originalPath: string;
  branch: string;
  deletedAt: string;
  sessionId?: string;
  basePath: string;
  /**
   * hapimatic-private#4481: copied from the worktree's `.worktree-meta.json`
   * `branch_origin` at soft-delete time, so the purge (which runs days later
   * from the trash meta) never `git branch -D`s a pre-existing branch.
   */
  branchOrigin?: BranchOrigin;
};

/**
 * How a worktree's branch came to be (hapimatic-private#4481):
 *  - "new" — the session created it (`git worktree add -b`) — the pre-#4481 shape
 *  - "existing-local" — the user picked a branch that already existed locally
 *  - "existing-remote" — the session created a local tracking branch of origin/<name>
 */
export type BranchOrigin = "new" | "existing-local" | "existing-remote";

function parseBranchOrigin(value: unknown): BranchOrigin | undefined {
  return value === "new" ||
    value === "existing-local" ||
    value === "existing-remote"
    ? value
    : undefined;
}

/**
 * Read a worktree's `branch_origin` from `.worktree-meta.json`. Absent or
 * malformed meta → "new" (today's behavior). Must be read BEFORE the worktree
 * directory is moved or removed (the meta lives inside it).
 *
 * Reads the one field, not the whole schema: an unrelated out-of-schema field
 * (a future `schema_version`, a stray type) must not drop the marker — the bash
 * readers grep the field the same way. The meta can still be missing (folder
 * removed out of band, `git clean -fdx`), so cleanup ALSO consults the branch's
 * git-config marker (`readBranchOriginMarker`) — see `isPreservedBranch`.
 */
export async function readWorktreeBranchOrigin(
  worktreePath: string | undefined
): Promise<BranchOrigin> {
  if (!worktreePath) return "new";
  try {
    const raw = await readFile(
      join(worktreePath, ".worktree-meta.json"),
      "utf-8"
    );
    const json: unknown = JSON.parse(raw);
    const origin =
      json && typeof json === "object"
        ? parseBranchOrigin((json as Record<string, unknown>).branch_origin)
        : undefined;
    return origin ?? "new";
  } catch {
    return "new";
  }
}

/**
 * hapimatic-private#4481: the second, durable record of a branch's origin —
 * `git config branch.<name>.hapimaticOrigin`. It lives in the repo's shared
 * config, not in the worktree folder, so it survives the folder being removed
 * and `git clean`; git renames it with the branch (`git branch -m`) and a
 * normal `git branch -D` removes it. It CAN outlive its branch — a delete via
 * plumbing (`git update-ref -d`) or under a held `.git/config.lock` leaves it
 * behind — and a later same-named branch then inherits it. That fails toward
 * keeping a branch, never toward deleting one (tracked in the #4481 sink).
 */
const BRANCH_ORIGIN_CONFIG_KEY = "hapimaticOrigin";

/** The branch's git-config origin marker. Absent / unreadable → undefined. */
export async function readBranchOriginMarker(
  repoRoot: string,
  branch: string
): Promise<BranchOrigin | undefined> {
  if (!branch) return undefined;
  try {
    const result = await runGit(
      ["config", "--get", `branch.${branch}.${BRANCH_ORIGIN_CONFIG_KEY}`],
      repoRoot
    );
    return parseBranchOrigin(result.stdout.trim());
  } catch {
    return undefined;
  }
}

/** A pre-existing local branch belongs to the user — cleanup must never delete it. */
export function isBranchPreserved(origin: BranchOrigin | undefined): boolean {
  return origin === "existing-local";
}

/**
 * Whether cleanup must keep `branch`: preserved when EITHER record says it
 * pre-existed — the worktree meta (`metaOrigin`, read before the folder goes)
 * or the branch's git-config marker. Both fail toward "new"; requiring only one
 * of them closes the missing-meta → `git branch -D` path.
 */
export async function isPreservedBranch(args: {
  repoRoot: string;
  branch: string;
  metaOrigin?: BranchOrigin;
}): Promise<boolean> {
  if (isBranchPreserved(args.metaOrigin)) return true;
  return isBranchPreserved(
    await readBranchOriginMarker(args.repoRoot, args.branch)
  );
}

type SoftDeleteResult =
  | { ok: true; holdingPath: string }
  /** `refused`: the #4450 guard's re-check stopped the move (nothing changed). */
  | { ok: false; error: string; refused?: true };

type RecoverResult =
  | { ok: true; info: WorktreeInfo }
  | { ok: false; error: string };

export interface WorktreePathValidation {
  valid: boolean;
  error?: string;
}

/**
 * Defense-in-depth: assert that `worktreePath` lies under `<basePath>/.worktrees/`
 * and contains no `..` segments. Mirrors the pattern in
 * `cli/src/modules/common/pathSecurity.ts::validatePath` but encodes the
 * worktree-specific invariant.
 *
 * `basePath` is the worktree HOST BASE — the directory that contains
 * `.worktrees/`. For repos whose worktrees were relocated onto local NVMe
 * (issue #1558) this is the NVMe host base from `resolveWorktreeHostBase`, NOT
 * necessarily the repo root; for the default (un-relocated) case it IS the repo
 * root. This function stays a PURE containment predicate — callers resolve the
 * host base and pass it in, so the security check is identical for both cases.
 *
 * Issue #1382 (security-auditor M1 from PR #1344 review): the
 * `cleanup-worktree` RPC and its callers must reject malicious or malformed
 * paths before any `git worktree` / `bash hapi-worktree.sh stop` / `rm`
 * side effects fire.
 *
 * Trust model: defense-in-depth. Currently not exploitable under the
 * single-user `matt@RP{1,2}` + SSH-trusted `matt@SL7` model, but this
 * helper guarantees the invariant holds if surrounding guards loosen.
 */
export function isWithinWorktreeBase(
  basePath: string,
  worktreePath: string
): WorktreePathValidation {
  if (typeof basePath !== "string" || basePath.length === 0) {
    return { valid: false, error: "basePath must be a non-empty string" };
  }
  if (typeof worktreePath !== "string" || worktreePath.length === 0) {
    return {
      valid: false,
      error: "worktreePath must be a non-empty string",
    };
  }

  // Reject any literal `..` segment, even if `resolve` would normalize it
  // away. Catches adversarial inputs early with a precise error and mirrors
  // the issue's stated acceptance criterion verbatim.
  const segments = worktreePath.split(/[\\/]/);
  if (segments.includes("..")) {
    return {
      valid: false,
      error: `worktreePath must not contain '..' segments (got: ${worktreePath})`,
    };
  }

  const resolvedBase = resolve(basePath);
  const resolvedWorktree = resolve(worktreePath);
  const baseWithoutTrailingSep = resolvedBase.endsWith(sep)
    ? resolvedBase.slice(0, -1)
    : resolvedBase;
  const expectedPrefix = `${baseWithoutTrailingSep}${sep}.worktrees${sep}`;

  const normalize = (p: string): string =>
    process.platform === "win32" ? p.toLowerCase() : p;

  if (!normalize(resolvedWorktree).startsWith(normalize(expectedPrefix))) {
    return {
      valid: false,
      error: `worktreePath must reside under ${expectedPrefix} (resolved: ${resolvedWorktree})`,
    };
  }

  return { valid: true };
}

/**
 * Thrown when the resolved repo root does not exist on disk or is not a real
 * Git repository. Originally added for polluted `core.worktree` configs (issue
 * #1191). After the issue #1219 switch from `--show-toplevel` to
 * `dirname(--git-common-dir)`, polluted `core.worktree` configs no longer
 * reach this branch (the new resolution bypasses `core.worktree` honoring
 * entirely), but the validation is preserved as defense-in-depth for
 * unforeseen edge cases (malformed gitdir, submodules — see resolveRepoRoot).
 */
export class RepoRootResolutionError extends Error {
  override name = "RepoRootResolutionError";
}

// The git timeout getters (getGitTimeoutMs, getGitFetchTimeoutMs,
// getWorktreeAddTimeoutMs) and the #1435 GIT_* env scrub (buildScrubbedGitEnv)
// live in ./worktreeMeta (#4058, decision D1 = B); they are imported above.

export async function runGit(
  args: string[],
  cwd: string,
  options?: {
    timeoutMs?: number;
    timeoutEnvHint?: string;
    /**
     * Run git under `LC_ALL=C` (and without `LANGUAGE`), so its messages are
     * git's English source text. The two `git worktree add` calls set it,
     * because their refusals are classified: under another locale git
     * translates them (#4058). The older `branch -D` callers that match
     * stderr predate it and do not set it.
     */
    cLocale?: boolean;
    /**
     * Name the repository explicitly as `GIT_DIR` + `GIT_WORK_TREE`, set
     * after the GIT_* scrub, so git never discovers one by walking up from
     * `cwd`. Phase 2 of a worktree add needs this: the same form git's own
     * `worktree add` uses for its checkout child (#4058, CR-R1).
     */
    repo?: { gitDir: string; workTree: string };
  }
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options?.timeoutMs ?? getGitTimeoutMs();
  const env = buildScrubbedGitEnv();
  if (options?.cLocale) {
    env.LC_ALL = "C";
    delete env.LANGUAGE;
  }
  if (options?.repo) {
    env.GIT_DIR = options.repo.gitDir;
    env.GIT_WORK_TREE = options.repo.workTree;
  }
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout: timeoutMs,
      // SIGKILL (not SIGTERM) because git can be in an uninterruptible syscall
      // (DNS resolution, TCP handshake) where SIGTERM is queued but not
      // delivered until the syscall returns. SIGKILL is kernel-delivered.
      // Diverges from cli/src/modules/common/handlers/git.ts (which omits
      // killSignal and uses Node's default SIGTERM) because runGit's failure
      // surface is infrastructure ops (spawn / resume) where reliability of
      // the kill matters more than graceful shutdown.
      killSignal: "SIGKILL",
      // Issue #1435: scrub inherited GIT_* env vars before spawning git.
      env,
    });
    return {
      stdout: result.stdout ? result.stdout.toString() : "",
      stderr: result.stderr ? result.stderr.toString() : "",
    };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    const stderr = execError.stderr ? execError.stderr.toString() : "";
    const stdout = execError.stdout ? execError.stdout.toString() : "";
    // Classify timeouts distinctly so callers (and log scanners) can tell a
    // kill-by-timeout from a normal git failure. Matches the precedent at
    // cli/src/modules/common/handlers/git.ts:83 and bash.ts:62.
    if (execError.code === "ETIMEDOUT" || execError.killed) {
      const cmdHint = args.slice(0, 2).join(" ");
      const envHint = options?.timeoutEnvHint ?? "HAPI_GIT_TIMEOUT_MS";
      throw new Error(
        `git ${cmdHint} timed out after ${timeoutMs}ms (${envHint} to override)`
      );
    }
    const message =
      stderr.trim() ||
      stdout.trim() ||
      execError.message ||
      "Git command failed";
    throw new Error(message);
  }
}

/**
 * True iff `ancestor` is an ancestor of `descendant` — i.e. the local source
 * branch is strictly BEHIND the origin tip (issue #1470). Uses
 * `git merge-base --is-ancestor` (exit 0 = ancestor, exit 1 = not an ancestor).
 * Because `runGit` THROWS on any non-zero exit, a `false` return conflates "not
 * an ancestor" (exit 1) with a genuine git error — both mean "do NOT advance the
 * spawn base off the local branch", which is the safe direction (Fallback Preservation
 * Rule). Bounded by `runGit`'s timeout; never throws.
 */
async function gitIsAncestor(
  repoRoot: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  try {
    await runGit(
      ["merge-base", "--is-ancestor", ancestor, descendant],
      repoRoot
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Issue #4370: the commit a ref points at, or `null` when it does not resolve.
 * Bounded by `runGit`'s timeout; never throws, so a missing ref and a git
 * error both read as "no such ref" to createWorktree's base resolution. The
 * cause is logged at `debug` so a timeout is traceable in the daemon log.
 */
async function resolveRefSha(
  repoRoot: string,
  ref: string
): Promise<string | null> {
  try {
    const result = await runGit(
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      repoRoot
    );
    return result.stdout.trim() || null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug(`[worktree] ref ${ref} did not resolve: ${message}`);
    return null;
  }
}

/**
 * Issue #4370: the two refs a worktree's base can come from — the local branch
 * and its remote-tracking ref. The ONE lookup shared by createWorktree and
 * probeSourceRepoHead, so the spawn gate and the create cannot disagree on
 * which refs count.
 */
async function resolveBaseBranchShas(
  repoRoot: string,
  branch: string
): Promise<{ localSha: string | null; originSha: string | null }> {
  return {
    localSha: await resolveRefSha(repoRoot, `refs/heads/${branch}`),
    originSha: await resolveRefSha(repoRoot, `refs/remotes/origin/${branch}`),
  };
}

/**
 * Fail-safe pre-deletion guard for unpushed-branch commits (issue #2007).
 *
 * If `branch`'s tip commit is present on NO remote-tracking ref (never pushed,
 * never merged onto a remote branch), its commits are local-only and would be
 * silently lost once the branch is `git branch -D`'d — either at the 10-day
 * soft-delete purge (`purgeExpiredWorktrees`) or in the immediate hard-delete
 * fallback of `cleanupWorktreeAndBranch`. In that case, create a durable backup
 * ref under `refs/hapimatic-backup/` pointing at the tip and warn loudly, so the
 * commits survive that deletion. Returns the backup ref name when one was
 * created, else `null`.
 *
 * Detection: `git branch -r --contains <tip>` empty ⇒ at-risk. This single check
 * subsumes the issue's "not reachable from origin/dev AND not present on any
 * remote" — being reachable from a remote branch ⟹ that remote-tracking ref
 * contains the tip — and is integration-branch-agnostic (this repo uses
 * `ms-dev`, not `dev`). It reads only local `refs/remotes/*`; it never fetches
 * (no network on the deletion path).
 *
 * NEVER throws and NEVER changes the caller's deletion outcome — any git or
 * detection error degrades to the pre-guard behavior (R3). R3 forbids throwing,
 * NOT logging: a persistent `runGit` timeout on `git branch -r --contains`
 * would otherwise silently disable this safety net on exactly the large repos
 * that need it most, so the `catch` logs a debug breadcrumb rather than going
 * dark (mirrors the never-throw contracts of `gitIsAncestor` and
 * `logProcessHygieneEvent`).
 *
 * Known benign false positives (fires with a backup ref + warn, never blocks):
 * (i) the local integration branch is AHEAD of origin — a fresh commit-less
 * worktree tip == the local `ms-dev` tip, on no remote-tracking ref — and
 * (ii) a repo with no remotes at all. In both states the guard fires on EVERY
 * commit-less worktree cleanup: expect recurring warn noise and
 * `refs/hapimatic-backup/*` accumulation there (accepted + documented). A
 * squash-merged branch whose remote branch AND local `refs/remotes/origin/*`
 * ref were both pruned is the third such edge — a tiny harmless ref keeping
 * already-merged commits reachable.
 */
async function backupUnpushedBranch(
  basePath: string,
  branch: string
): Promise<string | null> {
  try {
    // Resolve the branch tip. If the branch is already gone, there is nothing
    // to lose — no-op.
    const tip = (
      await runGit(["rev-parse", "--verify", `refs/heads/${branch}`], basePath)
    ).stdout.trim();
    if (!tip) return null;

    // Any remote-tracking ref that contains the tip means it was pushed and/or
    // merged onto a remote branch → recoverable → no backup needed (R2).
    const remotes = (
      await runGit(["branch", "-r", "--contains", tip], basePath)
    ).stdout.trim();
    if (remotes) return null;

    // At-risk: commits exist only in this local clone. Create a durable backup
    // ref OUTSIDE refs/heads/ so `git branch -D <branch>` cannot remove it and
    // git will not GC the objects (R4). Timestamp suffix mirrors the .trash
    // holding-name convention and makes re-deletions collision-free.
    const backupRef = `refs/hapimatic-backup/${branch}-${Date.now()}`;
    await runGit(["update-ref", backupRef, tip], basePath);

    logger.warn(
      `[worktree] issue #2007: branch '${branch}' has commits on no remote ` +
        `(tip ${tip.slice(0, 12)}). Backed up to '${backupRef}' before deletion. ` +
        `Recover with: git log ${backupRef}`
    );
    return backupRef;
  } catch (err) {
    // Fail-safe (R3): any detection/backup error degrades to today's behavior.
    // Do not go silent — a fully swallowed catch would let a persistent
    // `git branch -r --contains` timeout inert the safety net invisibly.
    logger.debug(
      `[worktree] issue #2007: unpushed-branch backup guard degraded to ` +
        `no-op for '${branch}' (non-fatal): ${err}`
    );
    return null;
  }
}

export async function resolveRepoRoot(basePath: string): Promise<string> {
  // Issue #1219: use --git-common-dir (returns the *shared* .git directory —
  // the MAIN repo's .git, not a worktree's per-worktree pointer file) and
  // take its parent. From a worktree, --show-toplevel returns the worktree's
  // own path, which produced nested .worktrees/.worktrees/ creation when
  // createWorktree was invoked with a worktree-cwd basePath.
  // --git-common-dir bypasses that AND obsoletes the polluted core.worktree
  // failure mode that motivated issue #1191 (it points at the shared .git,
  // not the working tree, so core.worktree honoring does not apply).
  // Submodule edge case (theoretical — Hapimatic does not exercise this):
  // --git-common-dir returns <parent>/.git/modules/<name> from inside a
  // submodule, dirname gives <parent>/.git/modules, defensive validation
  // throws RepoRootResolutionError. Fail fast, clear error.
  const result = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    basePath
  );
  const commonDir = result.stdout.trim();
  if (!commonDir) {
    throw new Error("Unable to resolve Git repository root.");
  }
  const root = dirname(commonDir);

  // Defensive: validate the resolved root exists AND contains .git. This is
  // mostly defense-in-depth — see the comment block above for which failure
  // modes still reach this branch and which do not.
  const rootExists = await pathExists(root);
  const dotGitExists = rootExists && (await pathExists(join(root, ".git")));
  if (!rootExists || !dotGitExists) {
    let coreWorktree = "";
    try {
      const cfg = await runGit(["config", "--get", "core.worktree"], basePath);
      coreWorktree = cfg.stdout.trim();
    } catch {
      // best-effort enrichment — non-fatal
    }
    const reason = rootExists
      ? "is not a Git repository (no .git found)"
      : "does not exist";
    const lines = [`Resolved repo root '${root}' ${reason}.`];
    if (coreWorktree) {
      lines.push(
        `The 'core.worktree' git config in ${basePath} is set to: ${coreWorktree}`,
        `Run \`git -C ${basePath} config --unset core.worktree\` to clear it.`
      );
    } else {
      lines.push(
        `Check 'core.worktree' git config in ${basePath}'s .git/config.`
      );
    }
    throw new RepoRootResolutionError(lines.join("\n"));
  }

  return root;
}

// Issue #5106: the outcome of a git call that must tell its failure modes
// apart. `runGit` rethrows `new Error(message)` and drops the exit status, so
// the spawn-gate probes below use this never-throwing variant. Same exec
// options as `runGit` (the #1435 GIT_* scrub, the HAPI_GIT_TIMEOUT_MS bound,
// SIGKILL on timeout), plus LC_ALL=C: the probes classify git's stderr, and git
// translates those messages under other locales.
type GitStatusResult =
  | { kind: "exit"; status: number; stdout: string; stderr: string }
  | { kind: "spawn-error"; code: string }
  | { kind: "signal"; signal: string }
  | { kind: "timeout"; timeoutMs: number };

async function runGitStatus(
  args: string[],
  cwd: string
): Promise<GitStatusResult> {
  const timeoutMs = getGitTimeoutMs();
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      env: { ...buildScrubbedGitEnv(), LC_ALL: "C" },
    });
    return {
      kind: "exit",
      status: 0,
      stdout: result.stdout ? result.stdout.toString() : "",
      stderr: result.stderr ? result.stderr.toString() : "",
    };
  } catch (error) {
    const execError = error as {
      code?: number | string | null;
      killed?: boolean;
      signal?: string | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    // A child SIGKILLed on timeout has `code === null`, so test `killed` first.
    if (execError.killed || execError.code === "ETIMEDOUT") {
      return { kind: "timeout", timeoutMs };
    }
    // A non-zero exit carries the numeric status in `code` (Node and Bun alike);
    // a failure to start git at all carries a string code such as "ENOENT".
    if (typeof execError.code === "number") {
      return {
        kind: "exit",
        status: execError.code,
        stdout: execError.stdout ? execError.stdout.toString() : "",
        stderr: execError.stderr ? execError.stderr.toString() : "",
      };
    }
    // git started but died on a signal other than the timeout kill.
    if (typeof execError.signal === "string" && execError.signal.length > 0) {
      return { kind: "signal", signal: execError.signal };
    }
    return {
      kind: "spawn-error",
      code: typeof execError.code === "string" ? execError.code : "UNKNOWN",
    };
  }
}

/** First meaningful line of a git failure, without git's `fatal: ` prefix. */
function firstGitErrorLine(text: string): string | null {
  const line = text
    .split("\n")
    .map(part => part.trim())
    .find(part => part.length > 0);
  return line ? line.replace(/^fatal:\s*/, "") : null;
}

function describeGitFailure(args: string[], result: GitStatusResult): string {
  const command = `git ${args.join(" ")}`;
  switch (result.kind) {
    case "timeout":
      return `${command} timed out after ${result.timeoutMs}ms (HAPI_GIT_TIMEOUT_MS to override)`;
    case "spawn-error":
      return `could not run git (${result.code})`;
    case "signal":
      return `${command} was terminated by ${result.signal}`;
    case "exit":
      return firstGitErrorLine(result.stderr) ?? `git exited ${result.status}`;
  }
}

/** Issue #5106 (R6): what the worktree-spawn gate's git-ness probe found. */
export type GitRepoProbe =
  | { state: "repo"; toplevel: string }
  | { state: "not-a-repo" }
  | { state: "git-unavailable" }
  | { state: "probe-failed"; detail: string };

/**
 * Issue #5106 (R5/R6): the worktree-spawn gate's git-ness probe (the #2270
 * `--show-toplevel` check), classified instead of reading every failure as
 * "not a git repository". Never throws.
 *
 * The directory is checked FIRST: a missing cwd fails the spawn with the same
 * `ENOENT` / `spawn git` error as a missing git binary (Node and Bun alike), so
 * without the check a nonexistent folder would read as "git not installed".
 * A missing directory stays `not-a-repo`, which keeps the pre-#5106 flow (a
 * defaulted spawn becomes a simple session, which offers to create the folder).
 */
export async function probeGitRepo(directory: string): Promise<GitRepoProbe> {
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) {
      return { state: "not-a-repo" };
    }
  } catch (err) {
    // #5202 (U4): only a missing path (or a file where a folder is expected)
    // is "not a repo". EACCES / ELOOP / EIO mean the folder could not be
    // read — reading those as not-a-repo is the misclassification #5106 set
    // out to remove (a defaulted spawn would silently run as simple).
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { state: "not-a-repo" };
    }
    return { state: "probe-failed", detail: `stat ${code ?? String(err)}` };
  }

  const args = ["rev-parse", "--show-toplevel"];
  const result = await runGitStatus(args, directory);
  if (result.kind === "exit" && result.status === 0) {
    const toplevel = result.stdout.trim();
    return toplevel
      ? { state: "repo", toplevel }
      : {
          state: "probe-failed",
          detail: `git ${args.join(" ")} printed no path`,
        };
  }
  if (
    result.kind === "exit" &&
    result.status === 128 &&
    /not a git repository/i.test(result.stderr)
  ) {
    return { state: "not-a-repo" };
  }
  if (result.kind === "spawn-error" && result.code === "ENOENT") {
    return { state: "git-unavailable" };
  }
  return { state: "probe-failed", detail: describeGitFailure(args, result) };
}

/** Issue #5106 (R1/R4): whether the HEAD a new worktree branches from has a commit. */
export type SourceHeadProbe =
  | { state: "present"; repoRoot: string }
  | { state: "unborn"; repoRoot: string }
  | { state: "unknown"; detail: string };

/**
 * Issue #5106 (R1/R4): does the base that {@link createWorktree} branches from
 * have a commit? Never throws.
 *
 * MIRRORS createWorktree's base (#4370): at `resolveRepoRoot(basePath)` (the
 * MAIN checkout, via `--git-common-dir`, #1219), the source branch
 * (`sourceBranch`, else `detectSourceBranch`) as `refs/heads/<b>` or
 * `refs/remotes/origin/<b>` → `present`. Only when neither resolves does
 * createWorktree fall back to the main checkout's HEAD, and so does this probe:
 * `git rev-parse --verify HEAD`. Keep the two in step; the agreement test in
 * worktree.test.ts fails when they diverge. Two differences are deliberate.
 * The probe does not fetch, so a branch that exists only on the remote and was
 * never fetched reads from the HEAD fallback here, where createWorktree's fetch
 * would find it. And for an EXPLICIT branch that resolves nowhere,
 * createWorktree fails (`failIfBaseMissing`) while this probe still reads HEAD:
 * on an unborn repo the spawn then shows the no-commits refusal instead of
 * "Source branch not found".
 *
 * Only exit status 1 (`--quiet` on an unborn HEAD) reads as `unborn`. Any other
 * failure (exit 128, a spawn error, a timeout, or a root that does not resolve,
 * e.g. inside a submodule) is `unknown`, and the caller continues to
 * createWorktree, whose own HEAD check reports a real failure.
 */
export async function probeSourceRepoHead(
  basePath: string,
  sourceBranch?: string
): Promise<SourceHeadProbe> {
  let repoRoot: string;
  try {
    repoRoot = await resolveRepoRoot(basePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: "unknown",
      detail: firstGitErrorLine(message) ?? "repository root did not resolve",
    };
  }

  const baseBranch = sourceBranch ?? (await detectSourceBranch(repoRoot));
  const { localSha, originSha } = await resolveBaseBranchShas(
    repoRoot,
    baseBranch
  );
  if (localSha || originSha) {
    return { state: "present", repoRoot };
  }

  const args = ["rev-parse", "--verify", "--quiet", "HEAD"];
  const result = await runGitStatus(args, repoRoot);
  if (result.kind === "exit" && result.status === 0) {
    return { state: "present", repoRoot };
  }
  if (result.kind === "exit" && result.status === 1) {
    return { state: "unborn", repoRoot };
  }
  return { state: "unknown", detail: describeGitFailure(args, result) };
}

function toSlug(value: string): string {
  const cleaned = trimChars(
    value.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    "-"
  );
  return cleaned;
}

function formatDatePrefix(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}${day}`;
}

function normalizeNameHint(nameHint?: string): string | null {
  if (!nameHint) {
    return null;
  }
  const trimmed = nameHint.trim();
  if (!trimmed) {
    return null;
  }
  const slug = toSlug(trimmed);
  return slug ? slug : null;
}

function makeDefaultBaseName(): string {
  const suffix = randomBytes(2).toString("hex");
  return `${formatDatePrefix()}-${suffix}`;
}

// Mirrors `issue-([0-9]+)` in scripts/hapi-worktree.sh:155 — keeps daemon and
// script paths byte-identical for branches like `issue-1145-foo`.
function issueNumberFromBranch(branch: string): number | null {
  const match = branch.match(/^issue-(\d+)/);
  return match ? Number(match[1]) : null;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function branchExists(
  repoRoot: string,
  branch: string
): Promise<boolean> {
  try {
    await runGit(["show-ref", "--verify", `refs/heads/${branch}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

async function ensureGitExclude(
  repoRoot: string,
  pattern: string
): Promise<void> {
  const excludePath = join(repoRoot, ".git", "info", "exclude");
  try {
    const content = await readFile(excludePath, "utf-8");
    if (content.split("\n").some(line => line.trim() === pattern)) {
      return;
    }
  } catch {
    // File doesn't exist or not readable — we'll create/append
  }
  try {
    await mkdir(join(repoRoot, ".git", "info"), { recursive: true });
    await appendFile(excludePath, `\n${pattern}\n`);
  } catch {
    // Best effort — don't fail worktree creation over this
  }
}

export type ProcessKillResult = {
  /** PIDs that exited after SIGTERM (no SIGKILL required). */ terminated: number[];
  /** PIDs that required SIGKILL after SIGTERM timeout. */
  killed: number[];
  /** Non-fatal errors encountered during scan/kill. */
  errors: string[];
};

/**
 * Process names we consider candidates for cwd-scoped cleanup. Filtering by
 * name before resolving `/proc/<pid>/cwd` symlinks keeps the scan cheap on
 * boxes with thousands of processes (issue #1031).
 */
const KILL_CANDIDATE_NAMES = new Set([
  "node",
  "bun",
  "tsserver",
  "typingsInstaller",
  "typescript-language-server",
  "vitest",
  "bash",
  "sh",
  "zsh",
]);

const SIGTERM_GRACE_MS = 500;

async function readProcComm(pid: string): Promise<string | null> {
  try {
    const content = await readFile(`/proc/${pid}/comm`, "utf-8");
    return content.trim() || null;
  } catch {
    return null;
  }
}

async function resolveProcCwd(pid: string): Promise<string | null> {
  try {
    const target = await readlink(`/proc/${pid}/cwd`);
    // A deleted cwd is reported as "/path/to/dir (deleted)". Strip the suffix
    // so we can still match ghost processes against the original path.
    return target.replace(/ \(deleted\)$/, "");
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan `/proc` for processes whose `comm` is in `candidateNames`, resolving
 * each match's cwd. Factored out of `killProcessesWithCwdUnder` (#1683) so the
 * read-only liveness scan (`listLiveCwds`) and the kill scan share one /proc
 * walk → comm-filter → cwd-resolve pipeline. Filtering by `comm` before
 * resolving `/proc/<pid>/cwd` keeps the scan cheap on boxes with thousands of
 * processes (issue #1031).
 *
 * Returns `[]` on non-Linux (no `/proc`) or on `readdir(/proc)` failure (the
 * error is pushed onto `errors` when provided). Skips the current process.
 * Never throws.
 */
async function scanProcCwds(
  candidateNames: ReadonlySet<string>,
  errors?: string[]
): Promise<Array<{ pid: number; comm: string; cwd: string }>> {
  if (process.platform !== "linux") return [];

  let procEntries: string[];
  try {
    procEntries = await readdir("/proc");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors?.push(`readdir(/proc): ${message}`);
    return [];
  }

  const pidRegex = /^\d+$/;
  const selfPid = String(process.pid);
  const matches: Array<{ pid: number; comm: string; cwd: string }> = [];

  for (const pid of procEntries) {
    if (!pidRegex.test(pid)) continue;
    if (pid === selfPid) continue;

    const comm = await readProcComm(pid);
    if (!comm || !candidateNames.has(comm)) continue;

    const cwd = await resolveProcCwd(pid);
    if (!cwd) continue;

    matches.push({ pid: Number(pid), comm, cwd });
  }

  return matches;
}

/**
 * Terminate processes whose current working directory is inside `targetPath`.
 *
 * Sends SIGTERM to every matching PID, waits 500 ms, then SIGKILLs survivors.
 * Designed to be called before `git worktree move/remove` so that tsservers
 * and other long-lived children holding the worktree cwd are cleaned up
 * rather than left as ghosts on a deleted directory.
 *
 * No-op on non-Linux platforms (no `/proc`). Best-effort overall: never
 * throws — permission errors and races are swallowed and surfaced in
 * `result.errors` for observability.
 */
export async function killProcessesWithCwdUnder(
  targetPath: string
): Promise<ProcessKillResult> {
  const result: ProcessKillResult = {
    terminated: [],
    killed: [],
    errors: [],
  };

  if (process.platform !== "linux") {
    return result;
  }

  const normalizedTarget = targetPath.endsWith("/")
    ? targetPath.slice(0, -1)
    : targetPath;
  const targetPrefix = `${normalizedTarget}/`;

  // #1683: use the shared /proc scan (comm-filtered by the kill set), then
  // apply the cwd path filter to find PIDs rooted inside targetPath.
  const scanned = await scanProcCwds(KILL_CANDIDATE_NAMES, result.errors);
  const candidates: number[] = [];
  for (const { pid, cwd } of scanned) {
    if (cwd !== normalizedTarget && !cwd.startsWith(targetPrefix)) continue;
    candidates.push(pid);
  }

  if (candidates.length === 0) return result;

  for (const pid of candidates) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have already exited between scan and kill; ignore.
    }
  }

  await new Promise(resolve => setTimeout(resolve, SIGTERM_GRACE_MS));

  for (const pid of candidates) {
    if (!isProcessAlive(pid)) {
      result.terminated.push(pid);
      continue;
    }

    try {
      process.kill(pid, "SIGKILL");
      result.killed.push(pid);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`SIGKILL ${pid}: ${message}`);
    }
  }

  return result;
}

/**
 * Process `comm` names treated as worktree-session liveness signals (#1683).
 * Broader than `KILL_CANDIDATE_NAMES` because the reclaim must NOT miss the
 * owning session: `claude` is the Claude Code process (the session itself) and
 * a session's interactive shell shows up as `bash`/`sh`; `node`/`bun` cover
 * dev-mode Claude and the Bun-compiled HAPI binary. Empirically (#1683) a live
 * worktree's owning processes report comm `claude` + `bash` (plus the deployed
 * HAPI binary, which the reclaim's listening-port gate also catches). Reusing
 * the narrower kill set here would make the reclaim blind to live sessions →
 * false reclaim of a working worktree.
 */
const LIVENESS_CANDIDATE_NAMES = new Set([
  "node",
  "bun",
  "claude",
  "bash",
  "sh",
]);

/**
 * Read-only scan of `/proc` for the cwds of live processes that could own a
 * worktree session (#1683). Returns the de-duplicated set of resolved cwds.
 * No-op `[]` on non-Linux. Never throws — a liveness miss is recoverable since
 * the port reclaim that consumes this is port-only (it never deletes work).
 */
export async function listLiveCwds(): Promise<string[]> {
  const scanned = await scanProcCwds(LIVENESS_CANDIDATE_NAMES);
  return Array.from(new Set(scanned.map(s => s.cwd)));
}

/**
 * True when any live process cwd is inside `worktreeDir` (the dir itself or a
 * descendant) — i.e. the worktree has a live owning session (#1683). Pure and
 * synchronous so the reclaim's liveness gate is unit-testable against a
 * synthetic cwd list. The descendant check uses a trailing-separator guard so
 * `/a/wt` does not match a sibling `/a/wt-2`.
 */
export function isWorktreeLive(
  worktreeDir: string,
  liveCwds: string[]
): boolean {
  const normalized = worktreeDir.endsWith("/")
    ? worktreeDir.slice(0, -1)
    : worktreeDir;
  const prefix = `${normalized}/`;
  return liveCwds.some(cwd => cwd === normalized || cwd.startsWith(prefix));
}

/** Injectable readers for {@link scanAllProcCwds} (tests never touch real
 *  processes); each default reads the live `/proc`. */
export interface ProcScanSeams {
  platform?: string;
  listPids?: () => Promise<string[]>;
  readCwd?: (pid: string) => Promise<string>;
  /** The uid owning `/proc/<pid>` (who the process runs as). */
  ownerUid?: (pid: string) => Promise<number>;
  selfUid?: number;
  selfPid?: string;
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * The liveness scan for the guarded removal (#4450 R5): the cwd of EVERY
 * process, with no `comm` filter, and every failure reported instead of
 * swallowed — so a caller can refuse when it cannot prove a worktree idle.
 * `listLiveCwds` stays as it is: it keeps five process names and drops a
 * `/proc` read failure, which is fine for a port reclaim but not for a delete.
 *
 * Reported as errors: a non-Linux host, a failed `/proc` listing, a cwd read
 * that fails with any other errno (any user's process), an unreadable
 * (`EACCES`/`EPERM`) cwd of a process that runs as the daemon's own user, and a
 * failed owner lookup of such a process. Skipped: the daemon's own process, a
 * process that exited mid-scan (`ENOENT`/`ESRCH`) and another user's process
 * whose cwd may not be read (`EACCES`/`EPERM`) — every host runs those, and an
 * agent session runs as the daemon's user. Never throws.
 */
export async function scanAllProcCwds(
  seams: ProcScanSeams = {}
): Promise<{ cwds: string[]; errors: string[] }> {
  const platform = seams.platform ?? process.platform;
  if (platform !== "linux") {
    return { cwds: [], errors: [`no /proc on platform ${platform}`] };
  }
  const listPids = seams.listPids ?? (() => readdir("/proc"));
  const readCwd = seams.readCwd ?? (pid => readlink(`/proc/${pid}/cwd`));
  const ownerUid =
    seams.ownerUid ?? (async pid => (await stat(`/proc/${pid}`)).uid);
  const selfUid = seams.selfUid ?? process.getuid?.();
  const selfPid = seams.selfPid ?? String(process.pid);

  let entries: string[];
  try {
    entries = await listPids();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { cwds: [], errors: [`readdir(/proc): ${message}`] };
  }

  const cwds = new Set<string>();
  const errors: string[] = [];
  for (const pid of entries) {
    if (!/^\d+$/.test(pid) || pid === selfPid) continue;
    try {
      cwds.add((await readCwd(pid)).replace(/ \(deleted\)$/, ""));
      continue;
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ENOENT" || code === "ESRCH") continue;
      if (code !== "EACCES" && code !== "EPERM") {
        errors.push(`cwd of pid ${pid}: ${code ?? String(error)}`);
        continue;
      }
    }
    // Permission denied: refuse only when the process is the daemon's own user.
    try {
      if ((await ownerUid(pid)) === selfUid) {
        errors.push(`cwd of own-user pid ${pid} is unreadable`);
      }
    } catch (error) {
      const code = errnoCode(error);
      if (code !== "ENOENT" && code !== "ESRCH") {
        errors.push(`owner of pid ${pid}: ${code ?? String(error)}`);
      }
    }
  }
  return { cwds: [...cwds], errors };
}

/**
 * Result of {@link isExistingLinkedWorktree}. Nullable-record (not a boolean)
 * so the #3372 gate can name the meta's `session_id` in its adoption WARN
 * without a second fs read.
 */
export type LinkedWorktreeProbe = {
  worktreePath: string;
  branch: string;
  ownerSessionId: string | null;
};

/**
 * Issue #3372: decide whether `dir` is an EXISTING Hapimatic linked worktree
 * that a defaulted-`worktree` spawn should ADOPT (run in as-is) rather than cut
 * a fresh `ms-hapi-*` sibling off. Returns non-null ONLY when ALL of:
 *   (a) `probeLinkedWorktree(dir)` classifies `dir` as inside a LINKED worktree
 *       (git-dir ≠ git-common-dir) — not the main clone / a plain repo;
 *   (b) the linked-worktree root realpath-equals `dir` — so a SUBDIR of a
 *       worktree is not mistaken for the worktree itself;
 *   (c) a `.worktree-meta.json` marker exists in `dir` (written by
 *       {@link createWorktree} / the bash `write_worktree_meta`) — so an
 *       unrelated non-Hapimatic linked worktree is never adopted.
 * `ownerSessionId` is the meta's `session_id` (best-effort; `null` on any parse
 * failure), and exists solely to feed the #3372 (B-D6) adoption WARN. Returns
 * `null` on ANY error → Fallback Preservation (R4): a probe failure just keeps
 * today's fresh-create path. Mirrors the null-safe read-meta-and-tolerate shape
 * of `readClaimedPort` (worktreeMeta.ts).
 */
export async function isExistingLinkedWorktree(
  dir: string
): Promise<LinkedWorktreeProbe | null> {
  try {
    const info = probeLinkedWorktree(dir);
    if (!info) return null;

    // (b) the linked-worktree root must BE `dir`, not an ancestor worktree of a
    // subdir. `info.worktreePath` is already realpath-normalised (git
    // `--show-toplevel` + normalizePath); realpath `dir` for an apples-to-apples
    // compare (tolerate a non-existent path via resolve()).
    const resolvedDir = await realpath(dir).catch(() => resolve(dir));
    if (info.worktreePath !== resolvedDir) return null;

    // (c) require the Hapimatic `.worktree-meta.json` MARKER. Its absence means
    // an unrelated (non-Hapimatic) linked worktree → do not adopt.
    const metaPath = join(dir, ".worktree-meta.json");
    let raw: string;
    try {
      raw = await readFile(metaPath, "utf-8");
    } catch {
      return null;
    }
    // session_id is best-effort: the marker existing is what qualifies the
    // worktree; a malformed/partial meta still adopts, just with a null owner.
    let ownerSessionId: string | null = null;
    try {
      const parsed = WorktreeMetaSchema.partial().safeParse(JSON.parse(raw));
      if (
        parsed.success &&
        typeof parsed.data.session_id === "string" &&
        parsed.data.session_id.length > 0
      ) {
        ownerSessionId = parsed.data.session_id;
      }
    } catch {
      ownerSessionId = null;
    }

    return {
      worktreePath: info.worktreePath,
      branch: info.branch,
      ownerSessionId,
    };
  } catch {
    return null;
  }
}

// Belt-and-suspenders retry for the documented HEAD-failure shape (#1435).
// With HEAD-resolve-first + pass-by-value in createWorktree, this should NOT
// fire — but if a mechanism we haven't accounted for surfaces the same symptom,
// retry once. Hoisted to module scope (#1464) so classifyWorktreeAddFailure can
// reference it. No `g` flag → `.test()` is stateless and safe to share.
const HEAD_RETRY_PATTERN = /not a valid object name:\s*['"]?HEAD['"]?/;

/**
 * Decide what createWorktree's inner `git worktree add` retry should do after a
 * failed attempt. Pure + side-effect-free so it is unit-testable without mocking
 * `runGit` (the file's no-mock convention leaves the retry I/O path untested;
 * this extracts the *decision* so it can be tested directly). #1464.
 *
 *  - "retry-head": first attempt, error matches the documented HEAD shape →
 *    retry the SAME name once (preserves #1435 single-retry behavior).
 *  - "fresh-name": the HEAD-retry already fired and the attempt still failed
 *    (runGitAttempts >= 2). The first `git worktree add -b` may have partially
 *    mutated (created `branch`) before failing, so retrying the same name would
 *    hit "branch already exists". Recover via the outer fresh-name loop. #1464.
 *  - "rethrow": first attempt, non-HEAD error (disk full, permission, etc.). A
 *    fresh name won't help — surface the specific error (pre-#1464 behavior).
 */
export type WorktreeAddFailureAction = "retry-head" | "fresh-name" | "rethrow";

export function classifyWorktreeAddFailure(
  runGitAttempts: number,
  errMsg: string
): WorktreeAddFailureAction {
  if (runGitAttempts < 2 && HEAD_RETRY_PATTERN.test(errMsg)) {
    return "retry-head";
  }
  if (runGitAttempts >= 2) {
    return "fresh-name";
  }
  return "rethrow";
}

/**
 * Issue #4058 (contract K-1 with #4508): the worktree paths a `createWorktree`
 * in THIS daemon is creating right now, keyed by `resolve(worktreePath)`.
 *
 * The failed-add rollback below may force-remove whatever is registered at the
 * attempt's path and delete the attempt's branch. That is only safe while no
 * other creator works the same path, and nothing else guarantees it:
 * `createWorktree` is serialized only for `claimPort:true` spawns, and a
 * re-spawn after the server's 75s RPC give-up can run the same name again. Each
 * add path claims its path here (check and add in one synchronous step, before
 * any await) and releases it in a `finally`; a claimed path reads as taken, so a
 * concurrent same-name call moves on to a suffixed name. A creator outside the
 * daemon (a hand-run `git worktree add` of the same path) is not covered.
 * Exported so #4508's existing-branch work reuses this one set.
 */
export const inFlightWorktreePaths = new Set<string>();

/** git's "branch is held by another worktree" refusal (wording varies by version). */
const BRANCH_HELD_PATTERN =
  /is already (?:checked out|used by worktree) at '([^']+)'/;
const BRANCH_EXISTS_PATTERN = /a branch named '[^']*' already exists/;
const PATH_TAKEN_PATTERN =
  /'[^']*' already exists|is a missing but (?:locked|already registered) worktree/;

/**
 * Issue #4058: what a refused `git worktree add` says about who owns the
 * conflicting object. Measured on git 2.39.5:
 *  - "branch": `a branch named 'B' already exists` (with `-b`) or the branch is
 *    checked out elsewhere (no `-b`). git refused before creating anything.
 *  - "path": `'<path>' already exists` or the path is a missing-but-registered
 *    worktree. With `-b`, git's `git branch` step has ALREADY created the branch
 *    by then (it runs before the path check), so the branch is this call's own
 *    and the path or registration belongs to someone else.
 *  - null: anything else (a timeout, a signal, disk full, …).
 */
export type WorktreeAddConflict = "branch" | "path" | null;

export function classifyWorktreeAddConflict(
  errMsg: string
): WorktreeAddConflict {
  if (BRANCH_EXISTS_PATTERN.test(errMsg) || BRANCH_HELD_PATTERN.test(errMsg)) {
    return "branch";
  }
  if (PATH_TAKEN_PATTERN.test(errMsg)) {
    return "path";
  }
  return null;
}

/** The state {@link planWorktreeAddRollback} decides from. */
export type WorktreeAddRollbackFacts = {
  /** The failure's error message. */
  errMsg: string;
  /**
   * "add" = `git worktree add` itself failed; "after-add" = it succeeded and a
   * later step failed (the checkout, the meta write), so the worktree is this
   * call's own and no conflict reading applies. The branch is this call's own
   * only when `baseCommit` is set: an existing local branch has a null
   * `baseCommit` and is always kept.
   */
  stage: "add" | "after-add";
  /** How many times `git worktree add` ran for THIS name (the inner retry counter). */
  addAttempts: number;
  /** `git worktree list` registers exactly this attempt's path. */
  registered: boolean;
  /** The attempt's directory exists on disk. */
  pathExists: boolean;
  /** The path passes `isWithinWorktreeBase` for the repo's worktree host base. */
  pathInsideBase: boolean;
  /** The branch's tip, or null when the branch does not exist. */
  branchTip: string | null;
  /**
   * The commit this attempt creates its branch at, or null when the attempt
   * never creates a branch (it opens an existing local branch), which keeps the
   * branch unconditionally.
   */
  baseCommit: string | null;
  /** A worktree other than this attempt's path has the branch checked out. */
  branchCheckedOutElsewhere: boolean;
  /** The branch carries a pre-existing-branch record (#4481 `isPreservedBranch`). */
  branchPreserved: boolean;
};

export type WorktreeAddRollbackPlan = {
  worktree: "keep" | "remove-registered" | "remove-unregistered-dir";
  branch: "keep" | "delete";
  /** Why something this attempt may have created is left in place (empty when nothing is). */
  residual: string[];
};

/**
 * Issue #4058: decide what a failed worktree add rolls back. Pure, so the
 * scoping rules are unit-tested without git. Before the add, the caller proves
 * that the path did not exist and that no other add in this daemon works it
 * ({@link inFlightWorktreePaths}). On the new-branch and remote-tracking paths
 * it also proves the branch did not exist; on the existing-local path the
 * branch exists by definition, and its null `baseCommit` keeps it. These rules
 * keep the rollback to what THIS attempt created:
 *
 *  (a) A "branch" conflict on the FIRST add attempt: git refused before
 *      creating anything, so nothing is touched. On attempt 2 or later (the
 *      `fresh-name` exit) the branch is this call's own residue from attempt 1,
 *      so the rules below apply.
 *  (a') A "path" conflict on the first attempt: the path or registration
 *      belongs to someone else and is never touched; the branch is this call's
 *      own (git creates it before the path check) and goes through rule (c).
 *  (b) The worktree is removed only when it is registered at exactly this path,
 *      or is an unregistered directory at this path inside the worktree base.
 *  (c) The branch is deleted only when its tip is still `baseCommit`, no other
 *      worktree has it checked out, and it carries no pre-existing record.
 */
export function planWorktreeAddRollback(
  facts: WorktreeAddRollbackFacts
): WorktreeAddRollbackPlan {
  const conflict =
    facts.stage === "add" && facts.addAttempts === 1
      ? classifyWorktreeAddConflict(facts.errMsg)
      : null;
  if (conflict === "branch") {
    return { worktree: "keep", branch: "keep", residual: [] };
  }

  const residual: string[] = [];
  let worktree: WorktreeAddRollbackPlan["worktree"] = "keep";
  if (conflict !== "path") {
    if (facts.registered) {
      worktree = "remove-registered";
    } else if (facts.pathExists) {
      if (facts.pathInsideBase) {
        worktree = "remove-unregistered-dir";
      } else {
        residual.push("directory outside the worktree base");
      }
    }
  }

  let branch: WorktreeAddRollbackPlan["branch"] = "keep";
  if (
    facts.branchTip !== null &&
    facts.baseCommit !== null &&
    !facts.branchPreserved
  ) {
    if (facts.branchTip !== facts.baseCommit) {
      residual.push(
        `branch tip ${facts.branchTip} is not the base ${facts.baseCommit}`
      );
    } else if (facts.branchCheckedOutElsewhere) {
      residual.push("branch is checked out by another worktree");
    } else {
      branch = "delete";
    }
  }
  return { worktree, branch, residual };
}

type WorktreeListEntry = { path: string; branch: string | null };

function parseWorktreeListPorcelain(stdout: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null };
      entries.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    }
  }
  return entries;
}

/**
 * The spellings git may have recorded for `worktreePath`: as given, resolved,
 * and real (git records the real path, and the directory may be gone, so the
 * parent's real path is tried too).
 */
async function worktreePathSpellings(
  worktreePath: string
): Promise<Set<string>> {
  const spellings = new Set([worktreePath, resolve(worktreePath)]);
  try {
    spellings.add(await realpath(worktreePath));
  } catch {
    // The directory does not exist (a killed add may not have created it).
  }
  try {
    spellings.add(
      join(await realpath(dirname(worktreePath)), basename(worktreePath))
    );
  } catch {
    // The parent does not exist either.
  }
  return spellings;
}

async function listWorktrees(repoRoot: string): Promise<WorktreeListEntry[]> {
  const listed = await runGit(["worktree", "list", "--porcelain"], repoRoot);
  return parseWorktreeListPorcelain(listed.stdout);
}

async function isRegisteredWorktree(
  repoRoot: string,
  spellings: Set<string>
): Promise<boolean> {
  return (await listWorktrees(repoRoot)).some(entry =>
    spellings.has(entry.path)
  );
}

/**
 * Issue #4058: phase 2 of the two-phase add — the checkout, with git's own
 * command, run by this process so the timeout kills the writer. It writes
 * every tracked file, so it gets the checkout budget, not the generic one.
 * Both add paths call this, so the command and its budget cannot drift apart.
 *
 * The repository is named explicitly (GIT_DIR = the worktree's admin dir,
 * GIT_WORK_TREE = the worktree), as git does for its own checkout child. With
 * the cwd alone, a `.git` file removed after phase 1 makes git walk up to the
 * enclosing repository — the main checkout, or `~` for a relocated base — and
 * `reset --hard` there exits 0 after discarding its uncommitted edits (CR-R1,
 * reproduced on git 2.39.5). An unreadable `.git` file therefore fails the
 * checkout instead.
 */
async function checkoutNewWorktree(worktreePath: string): Promise<void> {
  const gitDir = await readLinkedWorktreeGitDir(worktreePath);
  await runGit(["reset", "--hard", "--no-recurse-submodules"], worktreePath, {
    timeoutMs: getWorktreeAddTimeoutMs(),
    timeoutEnvHint: "HAPI_GIT_WORKTREE_ADD_TIMEOUT_MS",
    repo: { gitDir, workTree: worktreePath },
  });
}

/**
 * The admin dir (`<common>/worktrees/<id>`) a linked worktree's `.git` file
 * points at. Throws when the file is missing, is not a file, or holds no
 * `gitdir:` line, because every caller would otherwise let git discover a
 * repository on its own.
 */
async function readLinkedWorktreeGitDir(worktreePath: string): Promise<string> {
  let content: string;
  try {
    content = await readFile(join(worktreePath, ".git"), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    throw new Error(
      `refusing to check out ${worktreePath}: its .git file cannot be read (${code}), so git would resolve the enclosing repository`
    );
  }
  const match = content.match(/^gitdir:[ \t]*(.+?)[ \t]*$/m);
  if (!match) {
    throw new Error(
      `refusing to check out ${worktreePath}: its .git file names no gitdir, so git would resolve the enclosing repository`
    );
  }
  return resolve(worktreePath, match[1]);
}

export type WorktreeAddRollbackResult = {
  /** null when the facts could not be read (nothing was touched). */
  plan: WorktreeAddRollbackPlan | null;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  /** Everything left in place that this attempt may have created. */
  residual: string[];
};

/**
 * Issue #4058: roll back what a failed worktree add created, scoped by
 * {@link planWorktreeAddRollback}. A SIGKILLed `git worktree add` leaves a
 * `.git/worktrees/<id>/locked` file reading `initializing` that git itself
 * never removes (prune skips locked entries), so a registered worktree is
 * removed with `--force --force`, falling back to `unlock` + `prune` when the
 * directory is missing. The worktree goes before the branch, because
 * `branch -D` refuses a branch that a worktree still has checked out.
 *
 * Best-effort and never throws: every git call is bounded by runGit's generic
 * timeout, and the caller still returns the ORIGINAL error. Anything left in
 * place is reported once under `daemon-worktree-add-rollback`.
 */
export async function rollbackFailedWorktreeAdd(options: {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseCommit: string | null;
  errMsg: string;
  stage?: "add" | "after-add";
  addAttempts?: number;
}): Promise<WorktreeAddRollbackResult> {
  const { repoRoot, worktreePath, branch, baseCommit, errMsg } = options;
  const stage = options.stage ?? "add";
  const residual: string[] = [];
  let plan: WorktreeAddRollbackPlan | null = null;
  let worktreeRemoved = false;
  let branchDeleted = false;

  try {
    const spellings = await worktreePathSpellings(worktreePath);
    const entries = await listWorktrees(repoRoot);
    const branchRef = `refs/heads/${branch}`;
    let branchTip: string | null = null;
    try {
      branchTip =
        (
          await runGit(
            ["rev-parse", "--verify", "--quiet", branchRef],
            repoRoot
          )
        ).stdout.trim() || null;
    } catch {
      // The branch does not exist.
    }
    plan = planWorktreeAddRollback({
      errMsg,
      stage,
      addAttempts: options.addAttempts ?? 1,
      registered: entries.some(entry => spellings.has(entry.path)),
      pathExists: await pathExists(worktreePath),
      pathInsideBase: isWithinWorktreeBase(
        resolveWorktreeHostBase(repoRoot),
        worktreePath
      ).valid,
      branchTip,
      baseCommit,
      branchCheckedOutElsewhere: entries.some(
        entry => entry.branch === branchRef && !spellings.has(entry.path)
      ),
      branchPreserved:
        branchTip !== null && (await isPreservedBranch({ repoRoot, branch })),
    });
    residual.push(...plan.residual);

    if (plan.worktree === "remove-registered") {
      try {
        await runGit(
          ["worktree", "remove", "--force", "--force", worktreePath],
          repoRoot
        );
      } catch {
        // The directory is missing or the remove refused: drop the
        // registration directly (prune skips a still-locked entry).
        try {
          await runGit(["worktree", "unlock", worktreePath], repoRoot);
        } catch {
          // Not locked.
        }
        try {
          await runGit(["worktree", "prune"], repoRoot);
        } catch {
          // Best-effort; the re-probe below decides.
        }
      }
      let stillRegistered = false;
      try {
        stillRegistered = await isRegisteredWorktree(repoRoot, spellings);
      } catch {
        residual.push("could not re-read the worktree list after removal");
      }
      worktreeRemoved = !stillRegistered && !(await pathExists(worktreePath));
    } else if (plan.worktree === "remove-unregistered-dir") {
      // The purge-convergence precedent: an unregistered directory git will
      // never reap, at the exact path, inside the worktree base (checked above).
      await rm(worktreePath, { recursive: true, force: true });
      try {
        await runGit(["worktree", "prune"], repoRoot);
      } catch {
        // Best-effort.
      }
      worktreeRemoved = !(await pathExists(worktreePath));
    }
    if (plan.worktree !== "keep" && !worktreeRemoved) {
      residual.push("worktree survived removal");
    }

    if (plan.branch === "delete") {
      try {
        await runGit(["branch", "-D", branch], repoRoot);
        branchDeleted = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        residual.push(`branch delete failed: ${message}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    residual.push(`rollback could not read the repository state: ${message}`);
  }

  logger.info(
    `[worktree] add rollback for ${worktreePath} (${branch}): worktree=${plan?.worktree ?? "unknown"} removed=${worktreeRemoved} branch=${plan?.branch ?? "unknown"} deleted=${branchDeleted}`
  );
  if (residual.length > 0) {
    logger.reportError({
      message: `[worktree] add rollback left ${worktreePath} (${branch}) partly in place: ${residual.join("; ")}`,
      category: "daemon-worktree-add-rollback",
      severity: "warn",
      context: JSON.stringify({
        worktreePath,
        branch,
        baseCommit,
        stage,
        errMsg,
        plan,
        residual,
      }),
    });
  }
  return { plan, worktreeRemoved, branchDeleted, residual };
}

export async function createWorktree(options: {
  basePath: string;
  nameHint?: string;
  /** Fallback branch name when no nameHint is provided (uses hapiSessionId) */
  hapiSessionId?: string;
  /** Port to record in `.worktree-meta.json`. Pass `null` for the two-phase
   * write (caller patches the port after a later claim). Defaults to `null`. */
  claimedPort?: number | null;
  /** Branch the worktree is cut from, also recorded as `source_branch` in
   * `.worktree-meta.json`. The base commit is `refs/heads/<b>` when it exists,
   * else `refs/remotes/origin/<b>`, never the parent repo's HEAD (#4370).
   * Defaults to `detectSourceBranch(repoRoot)`, the repo's target branch. */
  sourceBranch?: string;
  /** Issue #4370 (operator ruling 4370-D1 = C): fail the create when
   * `sourceBranch` resolves to neither ref. Set it when the caller named the
   * branch explicitly. Unset (the default), a missing branch falls back to the
   * parent's HEAD and logs a `warn` with `fallback:head-commit`. */
  failIfBaseMissing?: boolean;
  /** Issue number to record. `undefined` falls back to extraction from the
   * branch name via `^issue-(\d+)`; `null` writes `null` explicitly. */
  issueNumber?: number | null;
  /**
   * hapimatic-private#4481: open the worktree on this EXISTING branch instead of
   * creating a new one (`git worktree add --no-checkout <path> <branch>`, no
   * `-b`, then the #4058 checkout). A `remote: true` branch exists only as
   * `origin/<name>` and gets a local tracking branch. Handled by
   * {@link addWorktreeForExistingBranch}; #4481 left the new-branch path
   * unchanged.
   */
  existingBranch?: ExistingBranch;
}): Promise<WorktreeResult> {
  const { basePath, nameHint } = options;
  let repoRoot: string;

  try {
    repoRoot = await resolveRepoRoot(basePath);
  } catch (error) {
    if (error instanceof RepoRootResolutionError) {
      // Already a structured, actionable message — propagate verbatim
      return { ok: false, error: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Path is not a Git repository: ${message}`,
    };
  }

  // Issue #1558: route through resolveWorktreeHostBase so a CIFS-mounted repo's
  // worktrees land on local NVMe (default-off → returns repoRoot unchanged).
  const repoWorktreesRoot = join(
    resolveWorktreeHostBase(repoRoot),
    ".worktrees"
  );
  try {
    await mkdir(repoWorktreesRoot, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Cannot create worktree directory at ${repoWorktreesRoot}: ${message}`,
    };
  }

  await ensureGitExclude(repoRoot, ".worktrees");

  const baseName =
    normalizeNameHint(nameHint) ??
    options.hapiSessionId ??
    makeDefaultBaseName();

  // hapimatic-private#4481: existing-branch worktrees take a sibling path — no
  // HEAD resolve, no base fetch, no `-b` loop. #4481 left the new-branch path
  // below unchanged (Fallback Preservation Rule); #4058 later gave both paths
  // the two-phase add and the scoped rollback.
  if (options.existingBranch) {
    return addWorktreeForExistingBranch({
      repoRoot,
      repoWorktreesRoot,
      existing: options.existingBranch,
      sourceBranch:
        options.sourceBranch ?? (await detectSourceBranch(repoRoot)),
      hapiSessionId: options.hapiSessionId,
      claimedPort: options.claimedPort ?? null,
      issueNumber: options.issueNumber,
    });
  }

  // Issue #1470: branch the worktree from origin/<sourceBranch>'s tip when the
  // parent clone's local source branch is behind origin — otherwise every
  // worktree silently inherits a stale snapshot (right branch, but missing
  // commits that already landed on origin). Resolve the source-branch LABEL once
  // here and reuse it for the fetch, the base-ref lookup AND the
  // `.worktree-meta.json` write further down (the caller passes `sourceBranch`
  // for spawn-path worktrees; detectSourceBranch resolves the repo's target
  // branch for ad-hoc callers, #4370).
  const baseBranch =
    options.sourceBranch ?? (await detectSourceBranch(repoRoot));

  // Fetch first so the origin ref below is current. Non-fatal: a failed or
  // timed-out fetch still leaves the last-fetched `refs/remotes/origin/<b>`,
  // which the lookup below reads anyway (#4370).
  try {
    // Route the fetch through runGit so an unroutable/auth-failing origin is
    // bounded by its timeout (SIGKILL) and cannot hang the spawn (R4).
    // Mirrors syncConfigFromMain's non-fatal fetch + fetchSucceeded discriminator
    // (#1320 / #1327). A fetch only updates remote-tracking refs — it never
    // touches the parent clone's working tree, so this is safe on a shared clone.
    //
    // Issue #1557: this fetch-first base (added by #1470) is the non-fatal twin
    // of syncConfigFromMain's config fetch. It takes the SAME short, independent
    // budget (HAPI_GIT_FETCH_TIMEOUT_MS, default 8s) so a slow/hung fetch fails
    // fast to the local-ref lookup below WITHOUT consuming the fatal
    // worktree-add budgets (HAPI_GIT_TIMEOUT_MS for the registration,
    // HAPI_GIT_WORKTREE_ADD_TIMEOUT_MS for the checkout, #4058).
    // [perf] issue #2147 stage (d1): time createWorktree's base-branch fetch —
    // freshly answers #2852 R5's deferred "is the duplicate git fetch material?"
    // question (the paired fetch is in syncConfigFromMain). Daemon log file, not
    // journalctl (cli/src/ui/logger.ts). grep `[perf][spawn]`.
    const perfCwFetchT0 = Date.now();
    await runGit(["fetch", "origin", baseBranch], repoRoot, {
      timeoutMs: getGitFetchTimeoutMs(),
      timeoutEnvHint: "HAPI_GIT_FETCH_TIMEOUT_MS",
    });
    logger.debug(
      `[perf][spawn] stage=worktree-fetch which=createWorktree branch=${baseBranch} ms=${Date.now() - perfCwFetchT0}`
    );
  } catch (fetchError) {
    // Fetch failed (offline / auth / timeout / no origin remote) — non-fatal
    // (R2). The lookup below still reads the last-fetched origin ref, so a
    // transient fetch failure never reads as "branch not found" (#4370).
    const message =
      fetchError instanceof Error ? fetchError.message : String(fetchError);
    logger.warn(
      `[worktree] createWorktree: git fetch origin ${baseBranch} failed (non-fatal): ${message}. Resolving the base from the local refs.`
    );
    logger.reportCaught(fetchError, {
      category: "daemon-worktree-fetch-base",
      severity: "warn",
    });
  }

  // Issue #4370: the base COMMIT follows the resolved branch, never the
  // parent's HEAD: `refs/heads/<b>` when it exists, else
  // `refs/remotes/origin/<b>`. When the parent is checked out on <b>,
  // `refs/heads/<b>` IS its HEAD, so the #1470 R3 case (local ahead of origin
  // → local tip) needs no special case.
  //
  // Issue #1435: the commit is resolved once, BEFORE the attempt loop, and
  // passed by value to `git worktree add` (last positional arg), so git never
  // does its own HEAD discovery — the daemon's execution context
  // intermittently failed that with `fatal: not a valid object name: 'HEAD'`.
  const { localSha, originSha } = await resolveBaseBranchShas(
    repoRoot,
    baseBranch
  );

  let baseCommit: string;
  let baseRef: string;
  if (localSha) {
    baseCommit = localSha;
    baseRef = `refs/heads/${baseBranch}`;
    // #1470: ADVANCE to origin's tip only when the local branch is strictly
    // BEHIND it (ancestry guard). Ahead/diverged keeps the local commits.
    // The fast path augments, never replaces, the local base (Fallback
    // Preservation Rule, ~/CLAUDE.md).
    if (originSha && originSha !== localSha) {
      if (await gitIsAncestor(repoRoot, localSha, originSha)) {
        baseCommit = originSha;
        baseRef = `refs/remotes/origin/${baseBranch}`;
        logger.info(
          `[worktree] createWorktree: advancing base from ${baseBranch} ${localSha} to origin/${baseBranch} ${originSha} (local was behind).`
        );
      } else {
        logger.warn(
          `[worktree] createWorktree: ${baseBranch} ${localSha} is not an ancestor of origin/${baseBranch} ${originSha} (ahead/diverged); branching from the local branch to preserve its commits.`
        );
      }
    }
  } else if (originSha) {
    baseCommit = originSha;
    baseRef = `refs/remotes/origin/${baseBranch}`;
  } else {
    // Neither ref resolves. Operator ruling 4370-D1 = C: a branch the caller
    // named explicitly fails the create, because it cannot be "used exactly"
    // (R2); a daemon-resolved default keeps the degraded path and is cut from
    // the parent's HEAD under a label that does not match it.
    if (options.failIfBaseMissing) {
      return {
        ok: false,
        error: `Source branch '${baseBranch}' not found locally or on origin at ${repoRoot}`,
      };
    }
    const headSha = await resolveRefSha(repoRoot, "HEAD");
    if (!headSha) {
      return {
        ok: false,
        error: `Source repo HEAD not resolvable at ${repoRoot}. The repo may be in an unborn-branch state.`,
      };
    }
    baseCommit = headSha;
    baseRef = "HEAD";
    logger.warn(
      `[worktree] createWorktree: base branch '${baseBranch}' not found locally or on origin at ${repoRoot} (reason: fallback:head-commit); branching from the parent HEAD ${headSha}, so the recorded source_branch does not match the base.`
    );
  }
  logger.info(
    `[worktree] createWorktree: base ${baseRef} ${baseCommit} (source branch ${baseBranch}) for ${repoRoot}`
  );

  attemptLoop: for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const name =
      attempt === 0
        ? baseName
        : `${baseName}-${randomBytes(2).toString("hex")}`;
    // HP1 (#1560): prefix session-id-derived branches `hapi-*` → `ms-hapi-*`.
    // The directory basename stays `name` (unprefixed) — Option B, branch-only.
    const branch = deriveWorktreeBranchName(name);
    const worktreePath = join(repoWorktreesRoot, name);
    const inFlightKey = resolve(worktreePath);

    // #4058 (K-1): claim the path before any await, so a concurrent same-name
    // createWorktree in this daemon moves on to a suffixed name instead of
    // working (and later rolling back) the same path.
    if (inFlightWorktreePaths.has(inFlightKey)) {
      continue;
    }
    inFlightWorktreePaths.add(inFlightKey);
    try {
      if (await pathExists(worktreePath)) {
        continue;
      }

      if (await branchExists(repoRoot, branch)) {
        continue;
      }

      try {
        let runGitAttempts = 0;
        while (true) {
          runGitAttempts += 1;
          try {
            // #4058 phase 1 of 2: register the worktree and create the branch
            // WITHOUT a checkout. This is metadata only and fits the generic
            // budget. A one-phase `git worktree add` runs its checkout as a
            // separate `git reset --hard` child that a timeout kill does not
            // reach, so that child kept writing into a path being rolled back.
            await runGit(
              [
                "worktree",
                "add",
                "--no-checkout",
                "-b",
                branch,
                worktreePath,
                baseCommit,
              ],
              // The failure is classified (HEAD retry, rollback conflict
              // rules), so read git's English wording under any locale.
              repoRoot,
              { cLocale: true }
            );
            break;
          } catch (addError) {
            const errMsg =
              addError instanceof Error ? addError.message : String(addError);
            const action = classifyWorktreeAddFailure(runGitAttempts, errMsg);
            if (action === "retry-head") {
              logger.warn(
                `[worktree] git worktree add hit HEAD-failure on attempt ${runGitAttempts}; retrying once. base=${baseRef} ${baseCommit} raw=${errMsg}`
              );
              logger.reportCaught(addError, {
                category: "daemon-worktree-add-head-retry",
                severity: "warn",
              });
              await new Promise(resolve => setTimeout(resolve, 100));
              continue;
            }
            // #4058: both exits below roll back what this name's attempts
            // created first, so a retry (here, or the caller's next spawn of
            // the same name) does not trip over the residue.
            await rollbackFailedWorktreeAdd({
              repoRoot,
              worktreePath,
              branch,
              baseCommit,
              errMsg,
              stage: "add",
              addAttempts: runGitAttempts,
            });
            if (action === "fresh-name") {
              // The HEAD-retry already fired and the attempt still failed. The
              // first `git worktree add -b` may have partially created `branch`
              // (rolled back above). Fall through to the outer loop for a fresh
              // randomized name (#1464). `continue attemptLoop` is control flow,
              // not a throw — it bypasses both the success path and the outer
              // catch.
              logger.warn(
                `[worktree] git worktree add retry exhausted for name=${name}; recovering via fresh randomized name. raw=${errMsg}`
              );
              logger.reportCaught(addError, {
                category: "daemon-worktree-add-fresh-name-fallthrough",
                severity: "warn",
              });
              continue attemptLoop;
            }
            throw addError;
          }
        }

        // #4058 phase 2 of 2: the checkout (see checkoutNewWorktree).
        try {
          await checkoutNewWorktree(worktreePath);
        } catch (checkoutError) {
          await rollbackFailedWorktreeAdd({
            repoRoot,
            worktreePath,
            branch,
            baseCommit,
            errMsg:
              checkoutError instanceof Error
                ? checkoutError.message
                : String(checkoutError),
            stage: "after-add",
            addAttempts: runGitAttempts,
          });
          throw checkoutError;
        }

        // Write `.worktree-meta.json` inline so the contract is enforced by the
        // function that produces worktrees, not by every caller. Issue #1145.
        // Non-fatal: meta-write failures are logged via the result type but do
        // NOT fail createWorktree — the caller's bolt-on path (or the auto-
        // bootstrap in issue-worker SKILL.md, #1025) recovers either way.
        // Reuse the source-branch label resolved once above (issue #1470)
        // instead of re-running detectSourceBranch — single resolution for both
        // the fetch and this `.worktree-meta.json` write.
        const sourceBranch = baseBranch;
        const resolvedIssueNumber =
          options.issueNumber !== undefined
            ? options.issueNumber
            : issueNumberFromBranch(branch);
        await writeWorktreeMeta({
          worktreePath,
          repoRoot,
          branch,
          sourceBranch,
          sessionId: options.hapiSessionId ?? branch,
          port: options.claimedPort ?? null,
          issueNumber: resolvedIssueNumber,
        });

        return {
          ok: true,
          info: {
            basePath: repoRoot,
            worktreePath,
            branch,
            name,
            createdAt: Date.now(),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: `Failed to create worktree: ${message}`,
        };
      }
    } finally {
      inFlightWorktreePaths.delete(inFlightKey);
    }
  }

  return {
    ok: false,
    error: "Failed to create worktree after multiple attempts. Try again.",
  };
}

/**
 * hapimatic-private#4481: create a worktree on a branch that ALREADY exists.
 *
 *  - local branch  → `git worktree add --no-checkout -- <path> <branch>` (no `-b`)
 *  - remote-only   → `git fetch origin <name>`, then
 *                    `git worktree add --no-checkout --track -b <name> -- <path> origin/<name>`
 *
 * Either add is followed by the checkout (`git reset --hard` in the worktree,
 * under the checkout budget), the same two phases as createWorktree (#4058).
 * The parent checkout's branch is never switched. The directory name is the
 * branch slug (`feature/x` → `feature-x`), randomized only on a path collision —
 * the BRANCH is fixed, so there is no fresh-name retry around `git worktree add`.
 * On failure, only what THIS call created is rolled back, by
 * {@link rollbackFailedWorktreeAdd}: the worktree registered at this path, and
 * (remote-only) the tracking branch while it still points at the remote tip it
 * was created at. A pre-existing local branch is never deleted. The worktree
 * meta records `branch_origin` so config sync and every cleanup path treat the
 * branch correctly.
 */
async function addWorktreeForExistingBranch(args: {
  repoRoot: string;
  repoWorktreesRoot: string;
  existing: ExistingBranch;
  sourceBranch: string;
  hapiSessionId?: string;
  claimedPort: number | null;
  issueNumber?: number | null;
}): Promise<WorktreeResult> {
  const { repoRoot, repoWorktreesRoot, existing } = args;
  const name = existing.name.trim();
  if (!name || name.startsWith("-")) {
    return { ok: false, error: `Invalid branch name: '${existing.name}'.` };
  }
  // git's own ref-format rules (the API schema applies the same rules): a name
  // git would read as a refspec (`+a:b`) or a glob (`*`) never reaches `fetch`.
  try {
    await runGit(["check-ref-format", `refs/heads/${name}`], repoRoot);
  } catch {
    return { ok: false, error: `Invalid branch name: '${existing.name}'.` };
  }

  const localExists = await branchExists(repoRoot, name);
  let useRemote = existing.remote && !localExists;
  if (existing.remote && !localExists) {
    // Refresh the remote-tracking ref (bounded, non-fatal — a stale but present
    // origin/<name> still works). An explicit refspec, so the fetch can only
    // ever write refs/remotes/origin/<name>.
    try {
      await runGit(
        ["fetch", "origin", `+refs/heads/${name}:refs/remotes/origin/${name}`],
        repoRoot,
        {
          timeoutMs: getGitFetchTimeoutMs(),
          timeoutEnvHint: "HAPI_GIT_FETCH_TIMEOUT_MS",
        }
      );
    } catch (fetchError) {
      const message =
        fetchError instanceof Error ? fetchError.message : String(fetchError);
      logger.warn(
        `[worktree] existing-branch: git fetch origin ${name} failed (non-fatal): ${message}`
      );
    }
    try {
      await runGit(
        ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${name}`],
        repoRoot
      );
    } catch {
      return { ok: false, error: `Remote branch origin/${name} not found.` };
    }
    // A concurrent actor may have created the local branch meanwhile.
    if (await branchExists(repoRoot, name)) useRemote = false;
  } else if (!localExists) {
    return {
      ok: false,
      error: `Branch '${name}' no longer exists in ${repoRoot}.`,
    };
  }

  // #4058 (K-2): the commit the tracking branch is created at (the remote tip
  // this call opens), so a rollback deletes that branch only while its tip is
  // still there. null → this call creates no branch, so none is ever deleted.
  let createdBranchSha: string | null = null;
  if (useRemote) {
    try {
      createdBranchSha =
        (
          await runGit(
            ["rev-parse", "--verify", `refs/remotes/origin/${name}`],
            repoRoot
          )
        ).stdout.trim() || null;
    } catch {
      // Unreadable: keep whatever the rollback finds (fails toward keeping).
    }
  }

  const dirBase = normalizeNameHint(name) ?? makeDefaultBaseName();
  let dirName: string | null = null;
  let inFlightKey: string | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const candidate =
      attempt === 0 ? dirBase : `${dirBase}-${randomBytes(2).toString("hex")}`;
    // #4058 (K-1): a path another add in this daemon is creating reads as taken
    // (claimed before any await, released in the finally below).
    const key = resolve(join(repoWorktreesRoot, candidate));
    if (inFlightWorktreePaths.has(key)) continue;
    inFlightWorktreePaths.add(key);
    if (!(await pathExists(join(repoWorktreesRoot, candidate)))) {
      dirName = candidate;
      inFlightKey = key;
      break;
    }
    inFlightWorktreePaths.delete(key);
  }
  if (!dirName || !inFlightKey) {
    return {
      ok: false,
      error: "Failed to find a free worktree directory name. Try again.",
    };
  }
  const worktreePath = join(repoWorktreesRoot, dirName);

  try {
    // #4058: two-phase add, as in createWorktree — register without a checkout
    // (generic budget), then check out in the worktree under the checkout
    // budget so the timeout kills the writer itself.
    const addArgs = useRemote
      ? [
          "worktree",
          "add",
          "--no-checkout",
          "--track",
          "-b",
          name,
          "--",
          worktreePath,
          `origin/${name}`,
        ]
      : ["worktree", "add", "--no-checkout", "--", worktreePath, name];
    // Roll back only what this call created (#4058 rules, K-2): the worktree
    // registered at this path, and the tracking branch only while it still
    // points at `createdBranchSha`. A pre-existing local branch is kept.
    const rollback = (
      errMsg: string,
      stage: "add" | "after-add"
    ): Promise<WorktreeAddRollbackResult> =>
      rollbackFailedWorktreeAdd({
        repoRoot,
        worktreePath,
        branch: name,
        baseCommit: createdBranchSha,
        errMsg,
        stage,
        addAttempts: 1,
      });

    try {
      // cLocale: the failure is classified (rollback rules, branch-held).
      await runGit(addArgs, repoRoot, { cLocale: true });
    } catch (addError) {
      const errMsg =
        addError instanceof Error ? addError.message : String(addError);
      await rollback(errMsg, "add");
      const held = errMsg.match(BRANCH_HELD_PATTERN);
      return {
        ok: false,
        error: held
          ? `Branch '${name}' is already checked out at ${held[1]}.`
          : `Failed to create worktree on branch '${name}': ${errMsg}`,
      };
    }
    try {
      await checkoutNewWorktree(worktreePath);
    } catch (checkoutError) {
      const errMsg =
        checkoutError instanceof Error
          ? checkoutError.message
          : String(checkoutError);
      await rollback(errMsg, "after-add");
      return {
        ok: false,
        error: `Failed to create worktree on branch '${name}': ${errMsg}`,
      };
    }

    const branchOrigin = useRemote ? "existing-remote" : "existing-local";
    // The durable second record (survives the folder and `git clean`). A few
    // attempts because a concurrent `worktree add --track` can hold
    // `.git/config.lock` for a moment. Non-fatal: the meta below is the primary
    // record, and the create fails without it.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await runGit(
          [
            "config",
            `branch.${name}.${BRANCH_ORIGIN_CONFIG_KEY}`,
            branchOrigin,
          ],
          repoRoot
        );
        break;
      } catch (configError) {
        if (attempt === 3) {
          const message =
            configError instanceof Error
              ? configError.message
              : String(configError);
          logger.warn(
            `[worktree] existing-branch: could not write the ${BRANCH_ORIGIN_CONFIG_KEY} marker for ${name} (the worktree meta still records it): ${message}`
          );
        } else {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
    const metaResult = await writeWorktreeMeta({
      worktreePath,
      repoRoot,
      branch: name,
      sourceBranch: args.sourceBranch,
      sessionId: args.hapiSessionId ?? name,
      port: args.claimedPort,
      issueNumber:
        args.issueNumber !== undefined
          ? args.issueNumber
          : issueNumberFromBranch(name),
      branchOrigin,
    });
    if (!metaResult.ok) {
      // The meta is what config sync and every cleanup path read first; without
      // it the auto-bootstrap rewrite would drop branch_origin. Undo the worktree
      // (keeping a pre-existing branch) and fail loudly instead.
      await rollback(`meta write failed: ${metaResult.error}`, "after-add");
      logger.warn(
        `[worktree] existing-branch: meta write failed for ${worktreePath}; worktree rolled back: ${metaResult.error}`
      );
      return {
        ok: false,
        error: `Failed to record the worktree on branch '${name}': ${metaResult.error}`,
      };
    }
    logger.info(
      `[worktree] Created worktree on existing branch ${name} (${branchOrigin}) at ${worktreePath}`
    );
    return {
      ok: true,
      info: {
        basePath: repoRoot,
        worktreePath,
        branch: name,
        name: dirName,
        createdAt: Date.now(),
      },
    };
  } finally {
    inFlightWorktreePaths.delete(inFlightKey);
  }
}

export type SyncConfigResult =
  | { ok: true; filesUpdated: number; fetchSucceeded: boolean }
  | { ok: false; error: string };

/**
 * Sync `.claude/` configuration from the worktree's recorded `source_branch`
 * (default `origin/main` if `.worktree-meta.json` is missing or malformed)
 * into a worktree.
 *
 * Fetches `origin/<source_branch>` first so a stale local clone (federation
 * nodes whose local source branch has not been fast-forwarded recently) does
 * not propagate pre-fix content into the new worktree (#1320).
 *
 * This prevents worktree sessions from running with stale hooks, skills, and
 * config files as the source branch advances after worktree creation.
 *
 * Non-fatal at multiple layers:
 *   - `.worktree-meta.json` read/parse failure: fall back to `origin/main`
 *     (matches pre-#1399 behavior; preserves #1320's federation-node drift
 *     mitigation for legacy worktrees created before `.worktree-meta.json`
 *     was introduced, and for ad-hoc `git worktree add` invocations that
 *     bypass `createWorktree`).
 *   - `git fetch origin <source_branch>` failure: log a warning, continue
 *     against whatever `origin/<source_branch>` is currently at locally.
 *   - Sync failure: return `{ ok: false, error }` and the session starts with
 *     whatever `.claude/` the worktree already has (preserves existing *     behavior as fallback).
 *
 * Issue #5117: the fetch step is caller-supplied through `options.fetch`, never
 * inferred here. Without it, `fetchSourceBranch` runs the same
 * `git fetch origin <source_branch>` as before #5117, so the spawn caller is
 * unchanged. The
 * resume caller passes a per-recovery-pass coalescer
 * (`createSourceBranchFetchCoalescer`) so the worktrees of one clone share one
 * fetch per source branch. A throw from `options.fetch` is a failed fetch: it
 * sets `fetchSucceeded=false` and the overlay runs against the local ref.
 */
export async function syncConfigFromMain(options: {
  worktreePath: string;
  fetch?: SourceBranchFetch;
}): Promise<SyncConfigResult> {
  const { worktreePath } = options;
  let fetchSucceeded = true;

  // Issue #1399: resolve sync source from worktree's recorded source_branch
  // rather than hardcoded "main". The previous hardcoded behavior caused
  // phantom reverts whenever `dev` was ahead of `main` on any `.claude/*`
  // file (the merge-dev-to-prod lag window). Defensive read swallows all
  // errors and returns "main" — preserves pre-#1399 behavior for missing
  // or malformed meta and keeps #1320's federation-drift mitigation intact.
  let resolvedSourceBranch = "main";
  try {
    const raw = await readFile(
      join(worktreePath, ".worktree-meta.json"),
      "utf-8"
    );
    const json: unknown = JSON.parse(raw);
    const parsed = WorktreeMetaSchema.partial().safeParse(json);
    if (
      parsed.success &&
      typeof parsed.data.source_branch === "string" &&
      parsed.data.source_branch.length > 0
    ) {
      resolvedSourceBranch = parsed.data.source_branch;
    }
    // hapimatic-private#4481: a worktree opened on a branch that already existed
    // carries its OWN committed `.claude/`. Checking out the source branch's
    // `.claude/` over it would leave the branch modified (premise fixture P3:
    // ` M .claude/x`). Covers both callers — spawn and resume. The one field is
    // read on its own, so an unrelated out-of-schema field can't hide it.
    const origin =
      json && typeof json === "object"
        ? parseBranchOrigin((json as Record<string, unknown>).branch_origin)
        : undefined;
    if (origin === "existing-local" || origin === "existing-remote") {
      logger.debug(
        `[worktree] syncConfigFromMain: skipped — existing-branch worktree (branch_origin=${origin}, worktreePath=${worktreePath})`
      );
      return { ok: true, filesUpdated: 0, fetchSucceeded: true };
    }
  } catch {
    // Fall back to "main"; matches pre-#1399 behavior.
  }
  logger.debug(
    `[worktree] syncConfigFromMain: source_branch=${resolvedSourceBranch} (worktreePath=${worktreePath})`
  );

  // Refresh origin/<source_branch> so a stale local clone cannot propagate
  // pre-fix content. Non-fatal — if fetch fails (network, auth, timeout,
  // etc.), continue against the local origin/<source_branch> ref (which may
  // itself be stale, but is no worse than the pre-#1320 behavior). Issue
  // #1327 added the fetchSucceeded discriminator so callers can distinguish
  // "fetch worked, local ref is current" from "fetch failed, using whatever
  // local ref we happened to have" — closing the silent-failure hole flagged
  // by the silent-failure-hunter agent during PR #1324 review.
  try {
    // Issue #5117: the fetch step is injectable; the default is fetchSourceBranch.
    await (options.fetch ?? fetchSourceBranch)({
      worktreePath,
      sourceBranch: resolvedSourceBranch,
    });
  } catch (fetchError) {
    fetchSucceeded = false;
    const message =
      fetchError instanceof Error ? fetchError.message : String(fetchError);
    logger.warn(
      `[worktree] syncConfigFromMain: git fetch origin ${resolvedSourceBranch} failed (non-fatal): ${message}`
    );
  }

  try {
    // Count files that differ before sync
    const diffResult = await runGit(
      [
        "diff",
        "--name-only",
        `origin/${resolvedSourceBranch}`,
        "--",
        ".claude/",
      ],
      worktreePath
    );
    const filesUpdated = diffResult.stdout
      .trim()
      .split("\n")
      .filter(Boolean).length;

    if (filesUpdated === 0) {
      return { ok: true, filesUpdated: 0, fetchSucceeded };
    }

    // Overlay origin/<source_branch>'s .claude/ onto the worktree
    await runGit(
      ["checkout", `origin/${resolvedSourceBranch}`, "--", ".claude/"],
      worktreePath
    );

    // Unstage the changes to keep git status clean
    await runGit(["reset", "HEAD", "--", ".claude/"], worktreePath);

    return { ok: true, filesUpdated, fetchSucceeded };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

/**
 * The fetch step of `syncConfigFromMain` (issue #5117). Resolving means the
 * fetch ran; throwing means it failed, which the caller treats as non-fatal.
 */
export type SourceBranchFetch = (args: {
  worktreePath: string;
  sourceBranch: string;
}) => Promise<void>;

/**
 * The default fetch step: `git fetch origin <sourceBranch>` from the worktree.
 */
export async function fetchSourceBranch(args: {
  worktreePath: string;
  sourceBranch: string;
}): Promise<void> {
  // Issue #1557: the non-fatal config fetch gets its OWN short timeout
  // (HAPI_GIT_FETCH_TIMEOUT_MS, default 8s) so a slow/hung fetch fails fast to
  // the local-ref fallback WITHOUT consuming the fatal worktree-op budgets
  // (HAPI_GIT_TIMEOUT_MS, and HAPI_GIT_WORKTREE_ADD_TIMEOUT_MS for the checkout,
  // #4058).
  // [perf] issue #2147 stage (d1): time syncConfigFromMain's config fetch —
  // the SECOND per-spawn fetch #2852 R5 deferred measuring. grep `[perf][spawn]`.
  const perfCfgFetchT0 = Date.now();
  await runGit(["fetch", "origin", args.sourceBranch], args.worktreePath, {
    timeoutMs: getGitFetchTimeoutMs(),
    timeoutEnvHint: "HAPI_GIT_FETCH_TIMEOUT_MS",
  });
  logger.debug(
    `[perf][spawn] stage=worktree-fetch which=syncConfigFromMain branch=${args.sourceBranch} ms=${Date.now() - perfCfgFetchT0}`
  );
}

/**
 * The shared git directory of `worktreePath` (every linked worktree of one
 * clone resolves to the same path), or `null` when it cannot be read. Unlike
 * `resolveRepoRoot` it never throws: a missing key means "fetch on your own".
 */
export async function resolveGitCommonDir(
  worktreePath: string
): Promise<string | null> {
  try {
    const result = await runGit(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      worktreePath
    );
    const commonDir = result.stdout.trim();
    return commonDir || null;
  } catch (err) {
    // #5202 (U6): a null key makes this worktree fetch on its own, which
    // brings back the per-record fetches #5117 removed — log why.
    logger.debug(
      `[worktree] could not resolve the git common dir of ${worktreePath}, fetching without coalescing: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/** Fetch attempts per (clone, source branch) key within one recovery pass. */
export const RESUME_FETCH_ATTEMPTS_PER_KEY = 2;

/**
 * Issue #5117: a fetch step for one recovery pass that fetches each
 * (git common dir, source branch) key once. All linked worktrees of a clone
 * share `refs/remotes/origin/<branch>`, so one fetch refreshes the ref every
 * sibling's overlay reads, and concurrent same-ref fetches lose the ref lock
 * (`cannot lock ref`). Callers sharing a key join the in-flight fetch; after a
 * success the key is never fetched again in this pass; a failure is retried by
 * a later caller until `maxAttemptsPerKey`, after which the last error is
 * rethrown so each record still reports `fetchSucceeded: false`. A worktree
 * whose key cannot be resolved always runs its own fetch.
 *
 * The memo is deliberately NOT cleared on settle (unlike
 * `kickExpiredWorktreePurge`): "already fetched in this pass" must hold for the
 * records processed after the fetch completed. Create one per pass.
 */
export function createSourceBranchFetchCoalescer(
  options: {
    fetch?: SourceBranchFetch;
    resolveKey?: (worktreePath: string) => Promise<string | null>;
    maxAttemptsPerKey?: number;
  } = {}
): SourceBranchFetch {
  const fetch = options.fetch ?? fetchSourceBranch;
  const resolveKey = options.resolveKey ?? resolveGitCommonDir;
  const maxAttempts =
    options.maxAttemptsPerKey ?? RESUME_FETCH_ATTEMPTS_PER_KEY;
  type Entry = {
    inFlight: Promise<void> | null;
    succeeded: boolean;
    attempts: number;
    lastError: unknown;
  };
  const entries = new Map<string, Entry>();

  return async (args): Promise<void> => {
    const commonDir = await resolveKey(args.worktreePath);
    if (commonDir === null) {
      return fetch(args);
    }
    // No await between the get and the set below, so claiming a key is atomic
    // in single-threaded JS.
    const key = `${commonDir}\0${args.sourceBranch}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        inFlight: null,
        succeeded: false,
        attempts: 0,
        lastError: undefined,
      };
      entries.set(key, entry);
    }
    if (entry.succeeded) {
      return;
    }
    if (entry.inFlight) {
      return entry.inFlight;
    }
    if (entry.attempts >= maxAttempts) {
      // #5202 (U6): label the rethrow, so a record that never ran a fetch of
      // its own does not report another record's failure as if it were fresh.
      throw new Error(
        `stored fetch failure after ${entry.attempts} attempt(s): ${entry.lastError instanceof Error ? entry.lastError.message : String(entry.lastError)}`,
        { cause: entry.lastError }
      );
    }
    entry.attempts++;
    const current = entry;
    current.inFlight = fetch(args)
      .then(
        () => {
          current.succeeded = true;
        },
        (error: unknown) => {
          current.lastError = error;
          throw error;
        }
      )
      .finally(() => {
        current.inFlight = null;
      });
    return current.inFlight;
  };
}

// Issue #1646: the daemon's worktree-spawn path (sessionSpawner.ts) writes a
// `.worktree-meta.json` with a claimed_port but historically never installed
// `node_modules`. The #1209 "port claim implies deps ready" invariant lived
// only in the shell `cmd_start` path, and broke for daemon-spawned worktrees
// when #1262 made the daemon claim ports too — so a fresh session's first
// `bun run typecheck` failed TS2688 until a manual `bun install`. A generous,
// env-overridable timeout: a cold `bun install` (~25s+ for ~2,776 packages on
// a loaded Pi 5) must not hit the 30s git default and manufacture a false
// failure. NOTE (#2147 / #2852): since #2852 this install runs in the
// BACKGROUND — kicked off after createWorktree and awaited by NOTHING on the
// spawn path (see sessionSpawner.ts `depsPromise`), so its cost is CPU
// contention with Claude boot on a Pi, NOT a serial spawn stage. The timeout
// only bounds the background task. Modeled on getWorktreeStopTimeoutMs() (the non-git
// env-knob-with-default pattern).
const DEFAULT_WORKTREE_INSTALL_TIMEOUT_MS = 300_000;
function getInstallTimeoutMs(): number {
  const raw = process.env.HAPI_WORKTREE_INSTALL_TIMEOUT_MS;
  if (!raw) return DEFAULT_WORKTREE_INSTALL_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_WORKTREE_INSTALL_TIMEOUT_MS;
}

// True when `path` is a symbolic link (whether or not its target exists).
// `lstat` does not follow the link, so a dangling symlink still reports true.
// Issue #1646: asserts the `web/node_modules/@hapi/protocol` workspace symlink,
// mirroring the shell helper's `[[ -L ... ]]` test.
async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Default installer for ensureWorktreeNodeModules: `bun install --frozen-lockfile`
 * (fast/offline against the warm shared bun cache), falling back to a plain
 * `bun install` (handles lockfile drift) — mirrors the shell helper's
 * `bun install --frozen-lockfile 2>/dev/null || bun install`
 * (scripts/hapi-worktree.sh:ensure_worktree_node_modules). Throws if BOTH
 * attempts fail; the caller maps the throw to R4's structured error. Issue #1646.
 */
async function defaultBunInstall(worktreePath: string): Promise<void> {
  const timeout = getInstallTimeoutMs();
  try {
    await execFileAsync("bun", ["install", "--frozen-lockfile"], {
      cwd: worktreePath,
      timeout,
    });
  } catch {
    // Lockfile drift / cache miss — retry non-frozen. Let this throw on failure.
    await execFileAsync("bun", ["install"], { cwd: worktreePath, timeout });
  }
}

/**
 * Result of ensureWorktreeNodeModules. Discriminated union mirroring the
 * structured-result convention used by the other worktree primitives.
 */
export type EnsureNodeModulesResult =
  | {
      ok: true;
      action:
        | "installed"
        | "skipped-already-present"
        | "skipped-not-bun-workspace";
    }
  | { ok: false; error: string };

/**
 * Ensure a worktree's `node_modules` is installed so the session's first
 * `bun run typecheck` / build does not fail with TS2688. Issue #1646.
 *
 * TS-native reimplementation of
 * `scripts/hapi-worktree.sh:ensure_worktree_node_modules` (#1209) — the daemon
 * is a compiled single-exe and cannot shell out to `scripts/` at runtime, which
 * is why worktree.ts already reimplements stop/teardown in TS. Called from the
 * daemon worktree-spawn path (sessionSpawner.ts) after syncConfigFromMain.
 *
 * Guarded so it is safe for ANY repo the daemon spawns a worktree for:
 *  - R3: not a bun workspace (no package.json + bun.lock) → skip; never run
 *    `bun install` in an arbitrary git repo.
 *  - R2: deps already present (node_modules dir, and — for the hapimatic
 *    monorepo — the `web/node_modules/@hapi/protocol` workspace symlink) →
 *    idempotent no-op. Degrades gracefully for a generic bun project with no
 *    `web/` workspace.
 *  - R1: otherwise install via `defaultBunInstall`, then verify the
 *    @hapi/protocol symlink (hapimatic-monorepo only).
 *  - R4: on any failure return `{ ok: false }` with a `cd <path> && bun install`
 *    recovery hint — the caller surfaces it loudly (WARN + reportCaught). Never
 *    throws.
 *
 * `runInstall` is an injectable seam (default = `defaultBunInstall`). It exists
 * so the install-success / install-failure branches are unit-testable WITHOUT a
 * real (~25s, network-touching) `bun install` and WITHOUT mocking the exec
 * layer — this file's no-exec-mock convention (cf. classifyWorktreeAddFailure,
 * #1464). The default is the only production caller.
 */
export async function ensureWorktreeNodeModules(options: {
  worktreePath: string;
  runInstall?: (worktreePath: string) => Promise<void>;
}): Promise<EnsureNodeModulesResult> {
  const { worktreePath } = options;
  const runInstall = options.runInstall ?? defaultBunInstall;

  // Guard 1 (R3): bun-workspace detection. Both files must be present.
  // NOTE: the lockfile is `bun.lock` (text format), NOT `bun.lockb`.
  const hasPackageJson = await pathExists(join(worktreePath, "package.json"));
  const hasBunLock = await pathExists(join(worktreePath, "bun.lock"));
  if (!hasPackageJson || !hasBunLock) {
    return { ok: true, action: "skipped-not-bun-workspace" };
  }

  // Guard 2 (R2): idempotency. node_modules present AND (no web workspace, or
  // the @hapi/protocol workspace symlink resolved) → already installed.
  const hapiLink = join(
    worktreePath,
    "web",
    "node_modules",
    "@hapi",
    "protocol"
  );
  const nmPresent = await pathExists(join(worktreePath, "node_modules"));
  const hasWebWorkspace = await pathExists(
    join(worktreePath, "web", "package.json")
  );
  const hapiLinkIsSymlink = await isSymlink(hapiLink);
  if (nmPresent && (!hasWebWorkspace || hapiLinkIsSymlink)) {
    return { ok: true, action: "skipped-already-present" };
  }

  // Install (R1). On failure, R4: structured error with recovery hint.
  try {
    await runInstall(worktreePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `bun install failed in ${worktreePath}: ${message}. Manual recovery: cd '${worktreePath}' && bun install`,
    };
  }

  // Verify (R1, hapimatic-monorepo only): the workspace symlink must exist
  // post-install. Skip the assertion for a generic bun project with no web/.
  if (hasWebWorkspace && !(await isSymlink(hapiLink))) {
    return {
      ok: false,
      error: `bun install succeeded but @hapi/protocol symlink missing at ${worktreePath}. Manual recovery: cd '${worktreePath}' && bun install`,
    };
  }

  return { ok: true, action: "installed" };
}

export async function removeWorktree(options: {
  repoRoot: string;
  worktreePath: string;
}): Promise<RemoveWorktreeResult> {
  try {
    await runGit(
      ["worktree", "remove", "--force", options.worktreePath],
      options.repoRoot
    );
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

/**
 * Hard-remove a worktree AND force-delete its branch. Issue #1202.
 *
 * Unlike `cleanupWorktreeAndBranch`, this does NOT soft-delete to
 * `.worktrees/.trash/` and does NOT preserve the branch. Used for partial
 * worktrees produced by failed spawn pipelines:
 *
 * - The worktree has no commits worth preserving (the branch was just created)
 * - Soft-delete would keep the branch alive — defeating retry-after-cleanup
 *   acceptance: `createWorktree` skips a name if its branch already exists,
 *   so a preserved branch forces the next attempt to suffix the worktree
 *   name (e.g. `.worktrees/issue-1149-202b/`).
 *
 * Tolerates "already gone" cases for both worktree and branch — callers can
 * call this multiple times without errors.
 */
export async function forceRemoveWorktreeAndBranch(options: {
  basePath: string;
  worktreePath: string;
  branch: string;
  sessionId?: string;
}): Promise<RemoveWorktreeResult> {
  const { basePath, worktreePath, branch, sessionId } = options;
  // #4481: read before removal (the meta lives inside the worktree); the
  // branch's git-config marker is the second record, so a missing meta can't
  // turn a pre-existing branch into a `branch -D`.
  const preserveBranch = await isPreservedBranch({
    repoRoot: basePath,
    branch,
    metaOrigin: await readWorktreeBranchOrigin(worktreePath),
  });

  // Kill cwd-holders so `git worktree remove` doesn't fail on busy paths.
  // Same pattern as cleanupWorktreeAndBranch's hard-delete fallback (issue #1031).
  const killResult = await killProcessesWithCwdUnder(worktreePath);
  logProcessHygieneEvent({
    source: "cli-worktree",
    action: "kill",
    path: worktreePath,
    sessionId,
    pidsTerminated: killResult.terminated,
    pidsKilled: killResult.killed,
    errors: killResult.errors.length ? killResult.errors : undefined,
    reason: "force-remove-partial",
  });

  // Step 1: Hard-remove the worktree directory
  const removeResult = await removeWorktree({
    repoRoot: basePath,
    worktreePath,
  });
  if (!removeResult.ok) {
    const isAlreadyGone =
      removeResult.error.includes("is not a working tree") ||
      removeResult.error.includes("No such file or directory");
    if (!isAlreadyGone) {
      return removeResult;
    }
  }

  // Step 2: Force-delete the branch. `-D` deletes regardless of merge state.
  // Tolerate "branch not found" — partial spawns may have failed before
  // `git worktree add -b <branch>` ran, so the branch may not exist.
  // #4481: a pre-existing local branch is the user's — never delete it.
  if (preserveBranch) {
    logger.info(
      `[worktree] forceRemoveWorktreeAndBranch: branch ${branch} preserved — pre-existing (branch_origin=existing-local)`
    );
    return { ok: true };
  }
  try {
    await runGit(["branch", "-D", branch], basePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isAlreadyGone =
      message.includes("not found") ||
      message.includes("error: branch '") || // git's "not found" wording
      message.includes("No such ref");
    if (!isAlreadyGone) {
      return { ok: false, error: `Branch deletion failed: ${message}` };
    }
  }

  return { ok: true };
}

/**
 * Canonical TS implementation of worktree-instance teardown (#1385).
 *
 * Replaces the TS→bash→systemctl ladder previously at the head of
 * `cleanupWorktreeAndBranch` (Step 0.5) and the bash duplications in
 * `scripts/worktree-crash-recovery.sh` and `scripts/worktree-ttl-cleanup.sh`.
 *
 * Sequence (matches `stop_instance` in `scripts/hapi-worktree.sh:349-383`):
 *   1. Kill the tmux server for `hapimatic-wt-<port>` to empty the daemon's
 *      cgroup (tmux children survive `KillMode=process` otherwise — issue
 *      #914).
 *   2. `systemctl --user stop` the daemon unit; `reset-failed` to clear any
 *      dead-but-loaded state that would block a future `systemd-run`.
 *   3. Same for the server unit.
 *   4. Sleep 1s for the OS to release the listening socket.
 *   5. Verify the port is no longer bound via `getListeningPorts()`. If still
 *      bound, return a structured failure with the offending PID list — fixes
 *      the silent-success path the code-reviewer flagged at the old
 *      `cleanupWorktreeAndBranch:822-830`.
 *
 * Concurrency: serialized per-port via `withFileLock` on
 * `/tmp/hapimatic-wt-<port>-teardown.lock`. Three actors mutate worktree
 * systemd units (daemon RecoveryService, the bash crons, this function); the
 * file lock makes the per-port invariant explicit instead of relying on
 * systemctl's implicit serialization.
 *
 * Idempotent: missing units and already-stopped state fall through to
 * `{ ok: true }`. Matches the "already gone" tolerance elsewhere in this file.
 *
 * Timeout: each `systemctl`/`tmux` call is bounded by
 * `HAPI_WORKTREE_STOP_TIMEOUT_MS` (default 120000ms). Distinct from
 * `HAPI_GIT_TIMEOUT_MS` (30s for git network ops) — `systemctl stop` can
 * legitimately take ≥90s waiting for unit shutdown. Addresses the timeout
 * mismatch the code-reviewer flagged at the old
 * `cleanupWorktreeAndBranch:813-820`.
 *
 * Caller contract: `port` must be within the worktree port range
 * (`WORKTREE_PORT_MIN..WORKTREE_PORT_MAX`). The Step 5 port-still-bound check
 * uses `getListeningPorts()` which filters to that range; a port outside the
 * range would always return "all clear", producing a false positive.
 *
 * Optional cleanup: when `clean: true` and teardown succeeded (port released),
 * also remove the per-instance data directory (`$HOME/.hapimatic-wt-<port>/`)
 * and per-port binary (`$HOME/.local/bin/hapimatic-wt-<port>`). Matches the
 * `--clean` behavior of `scripts/hapi-worktree.sh stop --clean`. Cleanup is
 * skipped on teardown failure to avoid removing files that a still-bound
 * process may be holding open.
 */
export type TearDownWorktreeInstanceResult =
  | { ok: true }
  | { ok: false; error: string; details?: { stillBoundPids?: number[] } };

const DEFAULT_WORKTREE_STOP_TIMEOUT_MS = 120_000;

function getWorktreeStopTimeoutMs(): number {
  const raw = process.env.HAPI_WORKTREE_STOP_TIMEOUT_MS;
  if (!raw) return DEFAULT_WORKTREE_STOP_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_WORKTREE_STOP_TIMEOUT_MS;
}

export async function tearDownWorktreeInstance(options: {
  port: number;
  sessionId?: string;
  /** When true, also remove `$HOME/.hapimatic-wt-<port>/` data dir and
   *  `$HOME/.local/bin/hapimatic-wt-<port>` per-port binary AFTER successful
   *  teardown. Matches `--clean` in `scripts/hapi-worktree.sh:cmd_stop`.
   *  Skipped on teardown failure (port still bound) to avoid removing files a
   *  still-running process holds open. */
  clean?: boolean;
}): Promise<TearDownWorktreeInstanceResult> {
  const { port, sessionId, clean = false } = options;
  const serverUnit = `hapimatic-wt-${port}-server`;
  const daemonUnit = `hapimatic-wt-${port}-daemon`;
  const tmuxSocket = `hapimatic-wt-${port}`;
  const lockPath = `/tmp/hapimatic-wt-${port}-teardown.lock`;
  const timeoutMs = getWorktreeStopTimeoutMs();

  return withFileLock({ lockPath, staleTimeoutMs: 30_000 }, async () => {
    // Step 1: Kill tmux server first. Empties the daemon's cgroup so the
    // transient unit can fully unload (issue #914). Tolerate "no such
    // session" — the tmux server may already be gone or never started.
    try {
      await execFileAsync("tmux", ["-L", tmuxSocket, "kill-server"], {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
    } catch {
      // Match `tmux kill-server 2>/dev/null || true` at hapi-worktree.sh:354
    }

    // Step 2: Stop daemon (it depends on server). Reset-failed clears any
    // dead-but-loaded state that would block a future systemd-run.
    try {
      await execFileAsync("systemctl", ["--user", "stop", daemonUnit], {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
    } catch {
      // Tolerate already-stopped / never-existed
    }
    try {
      await execFileAsync("systemctl", ["--user", "reset-failed", daemonUnit], {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
    } catch {
      // Tolerate non-existent unit
    }

    // Step 3: Stop server. Same idempotent tolerance.
    try {
      await execFileAsync("systemctl", ["--user", "stop", serverUnit], {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
    } catch {
      // Tolerate already-stopped / never-existed
    }
    try {
      await execFileAsync("systemctl", ["--user", "reset-failed", serverUnit], {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
    } catch {
      // Tolerate non-existent unit
    }

    // Step 4: Brief wait for the OS to release the listening socket.
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Step 5: Verify the port is no longer bound. Surface a structured
    // failure with the PID list if anything is still listening — fixes the
    // silent-success path at the old `cleanupWorktreeAndBranch:822-830`.
    const stillBound = await getListeningPorts();
    if (stillBound.has(port)) {
      let stillBoundPids: number[] | undefined;
      try {
        const { stdout } = await execFileAsync(
          "ss",
          ["-tlnp", `sport = :${port}`],
          { timeout: timeoutMs, killSignal: "SIGKILL" }
        );
        const pidMatches = stdout.matchAll(/pid=(\d+)/g);
        const pids = Array.from(pidMatches, m => Number(m[1])).filter(p =>
          Number.isFinite(p)
        );
        if (pids.length > 0) stillBoundPids = Array.from(new Set(pids));
      } catch {
        // ss failed or unavailable — return without PID details
      }

      logger.warn(
        `[TEARDOWN] Port ${port} still bound after systemd unit stop` +
          (stillBoundPids
            ? `. Remaining PIDs: ${stillBoundPids.join(", ")}`
            : "")
      );
      logProcessHygieneEvent({
        source: "cli-worktree",
        action: "skip",
        sessionId,
        reason: "port-still-bound-after-teardown",
        port,
        stillBoundPids,
      });

      return {
        ok: false,
        error: `Port ${port} remained bound after systemd unit stop`,
        details: { stillBoundPids },
      };
    }

    // Step 6 (optional): If clean was requested, remove data dir + binary.
    // Only runs after successful teardown — never tries to delete files that
    // a still-bound process might be using. Cleanup failures are non-fatal:
    // log a warning and return ok:true, matching the bash `rm -rf` /
    // `rm -f` semantics where missing paths silently succeed.
    if (clean) {
      const home = process.env.HOME ?? "";
      if (home) {
        const dataDir = `${home}/.hapimatic-wt-${port}`;
        const binaryPath = `${home}/.local/bin/hapimatic-wt-${port}`;
        try {
          await rm(dataDir, { recursive: true, force: true });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.warn(
            `[TEARDOWN] Failed to remove data dir ${dataDir}: ${message}`
          );
        }
        try {
          await rm(binaryPath, { force: true });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.warn(
            `[TEARDOWN] Failed to remove binary ${binaryPath}: ${message}`
          );
        }
      }
    }

    logger.debug(`[TEARDOWN] Worktree instance on port ${port} stopped`);
    return { ok: true };
  });
}

/**
 * Soft-delete a worktree by moving it to `.worktrees/.trash/` instead of destroying it.
 * Uses `git worktree move` which is an atomic rename on the same filesystem.
 * The branch is preserved so commits remain reachable during the grace period.
 */
export async function softDeleteWorktree(options: {
  basePath: string;
  worktreePath: string;
  branch: string;
  sessionId?: string;
  /**
   * #4450: the guarded removal (`cleanupIdleWorktree`). It kills no process:
   * `recheck` runs right before the move and returns a refusal message when the
   * worktree is no longer idle, and `keepBranch` records the branch as
   * `existing-local` in the trash meta so the purge keeps it.
   */
  guard?: {
    recheck: () => Promise<string | null>;
    keepBranch: boolean;
  };
}): Promise<SoftDeleteResult> {
  const { basePath, worktreePath, branch, sessionId, guard } = options;

  // Issue #1558: resolve the host base so the trash dir lands on the SAME
  // filesystem as a relocated worktree — otherwise `git worktree move` below
  // is a cross-device rename and fails with EXDEV. Default-off → basePath.
  const worktreesRoot = join(resolveWorktreeHostBase(basePath), ".worktrees");
  const trashDir = join(worktreesRoot, TRASH_DIR_NAME);

  try {
    await mkdir(trashDir, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Cannot create trash directory: ${message}` };
  }

  // #4481: read before the move — the meta file travels with the directory.
  // A pre-existing branch is recorded as such in the trash meta when EITHER
  // the worktree meta or the branch's git-config marker says so.
  const metaOrigin = await readWorktreeBranchOrigin(worktreePath);
  const branchOrigin: BranchOrigin =
    guard?.keepBranch ||
    (await isPreservedBranch({
      repoRoot: basePath,
      branch,
      metaOrigin,
    }))
      ? "existing-local"
      : metaOrigin;

  const worktreeName = basename(worktreePath);
  const timestamp = Date.now();
  const holdingName = `${worktreeName}-${timestamp}`;
  const holdingPath = join(trashDir, holdingName);

  if (guard) {
    // #4450: never kill on the guarded path — refuse instead if a holder
    // appeared since the caller's idle check.
    const refusal = await guard.recheck();
    if (refusal) return { ok: false, error: refusal, refused: true };
  } else {
    // Issue #1031: SIGTERM any process holding a cwd inside the worktree BEFORE
    // the git worktree move. Otherwise tsservers/vitest/bash retain an open cwd
    // on the now-moved inode and become ghosts on a (deleted) path.
    const killResult = await killProcessesWithCwdUnder(worktreePath);
    logProcessHygieneEvent({
      source: "cli-worktree",
      action: "kill",
      path: worktreePath,
      sessionId,
      pidsTerminated: killResult.terminated,
      pidsKilled: killResult.killed,
      errors: killResult.errors.length ? killResult.errors : undefined,
      reason: "soft-delete",
    });
  }

  try {
    await runGit(["worktree", "move", worktreePath, holdingPath], basePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `git worktree move failed: ${message}` };
  }

  const metadata: SoftDeleteMetadata = {
    originalPath: worktreePath,
    branch,
    deletedAt: new Date().toISOString(),
    sessionId,
    basePath,
    // #4481: omitted for "new" so pre-#4481 trash metas and new ones match.
    ...(branchOrigin !== "new" ? { branchOrigin } : {}),
  };

  try {
    const metaPath = join(trashDir, `${holdingName}.meta.json`);
    await writeFile(metaPath, JSON.stringify(metadata, null, 2));
  } catch {
    // Metadata write failure is non-fatal — the worktree is already moved
  }

  return { ok: true, holdingPath };
}

/**
 * Full worktree lifecycle cleanup: remove the worktree directory AND delete the branch.
 * `removeWorktree()` only calls `git worktree remove` — the branch persists as an orphan.
 * This function does both, used when a session is permanently deleted.
 */
export async function cleanupWorktreeAndBranch(options: {
  basePath: string;
  worktreePath?: string;
  branch: string;
  sessionId?: string;
}): Promise<RemoveWorktreeResult> {
  const { basePath, worktreePath, branch, sessionId } = options;

  // Issue #1382: defense-in-depth path validation. Mirrors the explicit
  // RPC-handler check in cli/src/api/apiMachine.ts so future direct callers
  // (cli/src/daemon/run.ts:826, 1085, 1327) are also protected. Skipping when
  // worktreePath is undefined preserves the existing contract — see
  // worktree.test.ts "returns ok without teardown when worktreePath is absent".
  if (worktreePath !== undefined) {
    // Issue #1558: validate against the resolved worktree host base, not
    // basePath directly, so a relocated (NVMe) worktree path passes containment
    // while the `..`-rejection and out-of-base checks remain intact. Default-off
    // → resolveWorktreeHostBase(basePath) === basePath (legacy behavior).
    const validation = isWithinWorktreeBase(
      resolveWorktreeHostBase(basePath),
      worktreePath
    );
    if (!validation.valid) {
      return {
        ok: false,
        error: `Invalid worktreePath: ${validation.error}`,
      };
    }
  }

  // Step 0: Resolve the actual branch name from the worktree. The branch may
  // have been renamed by the issue-worker-detector hook (e.g. "0312-a1b2" →
  // "issue-276-auto-rename-worktree-branch"). Must run BEFORE worktree removal,
  // because git symbolic-ref needs the worktree's .git file to be present.
  let actualBranch = branch;
  // #4481: read before the worktree is moved/removed (the meta lives inside it).
  // The branch's git-config marker is checked again at deletion time, so a
  // worktree whose folder (or meta) is already gone still keeps its branch.
  const metaOrigin = await readWorktreeBranchOrigin(worktreePath);
  if (worktreePath) {
    try {
      const ref = await runGit(
        ["symbolic-ref", "--short", "HEAD"],
        worktreePath
      );
      const resolved = ref.stdout.trim();
      if (resolved) {
        actualBranch = resolved;
      }
    } catch {
      // Worktree may already be gone — fall back to stored branch name
    }
  }
  // #4481: preserved when EITHER the meta or the branch's git-config marker
  // says it pre-existed (the marker lives in the repo config, so it is still
  // readable when the worktree folder or its meta is already gone).
  const preserveBranch =
    !!actualBranch &&
    (await isPreservedBranch({
      repoRoot: basePath,
      branch: actualBranch,
      metaOrigin,
    }));

  // Step 0.4 (issue #2007): before ANY destructive step, back up commits that
  // live only in this local clone (present on no remote-tracking ref). Covers
  // BOTH the soft-delete path (branch is preserved for the grace period, then
  // `git branch -D`'d at purge) AND the hard-delete fallback (immediate
  // `git branch -D actualBranch` below). Not gated on `worktreePath` — the
  // fallback deletes the branch even when `worktreePath` is undefined.
  // Fail-safe: never throws, never changes the deletion outcome.
  // #4481: a preserved (pre-existing) branch is never deleted, so no backup.
  if (actualBranch && !preserveBranch) {
    await backupUnpushedBranch(basePath, actualBranch);
  }

  // Step 0.5: Stop the worktree instance (systemd units, tmux server, data
  // dir, binary) BEFORE the soft-delete moves the worktree dir to `.trash/`.
  // Without this, deleting a session via the web UI leaves the
  // hapimatic-wt-<port>-{server,daemon} units running forever, holding the
  // port against a deleted worktree (Mode A in epic #1336). Issue #1337.
  //
  // #1385 Task 3: replaces the prior TS→bash→systemctl ladder
  // (`bash scripts/hapi-worktree.sh stop --clean --force`) with a direct call
  // to the canonical `tearDownWorktreeInstance` TS primitive. The function
  // is per-port `withFileLock`-serialized against the bash cron actors
  // (worktree-crash-recovery, worktree-ttl-cleanup), surfaces structured
  // failure on port-still-bound (fixes the silent-success bug from the old
  // shell-out's catch block), and uses a teardown-specific 120s timeout
  // (fixes the 30s `getGitTimeoutMs()` mismatch in the old call).
  //
  // Failures here log but do NOT abort — soft-delete still runs (R2 graceful
  // degradation, preserved from #1337).
  if (worktreePath) {
    const claimedPort = await readClaimedPort(worktreePath);
    if (claimedPort !== null) {
      const teardown = await tearDownWorktreeInstance({
        port: claimedPort,
        sessionId,
        clean: true,
      });
      if (teardown.ok) {
        logger.debug(
          `[CLEANUP] Stopped worktree instance on port ${claimedPort}`
        );
      } else {
        const detail = teardown.details?.stillBoundPids
          ? ` (still-bound PIDs: ${teardown.details.stillBoundPids.join(", ")})`
          : "";
        logger.error(
          `[CLEANUP] Teardown failed for port ${claimedPort}: ${teardown.error}${detail}`
        );
        // Continue to soft-delete — do not return early.
      }
    }
  }

  // Step 1: Try soft-delete first (move to .trash instead of destroying)
  if (worktreePath) {
    const softResult = await softDeleteWorktree({
      basePath,
      worktreePath,
      branch: actualBranch,
      sessionId,
    });
    if (softResult.ok) {
      // Soft-delete succeeded — branch is preserved for the grace period
      return { ok: true };
    }
    // Soft-delete failed — fall back to hard delete below
  }

  // Fallback: Hard delete (original behavior)
  if (worktreePath) {
    // Issue #1031: re-kill cwd-holders before the hard remove. softDeleteWorktree
    // already did this once above, but a short-lived race could have respawned
    // something. Cheap to re-scan.
    const killResult = await killProcessesWithCwdUnder(worktreePath);
    logProcessHygieneEvent({
      source: "cli-worktree",
      action: "kill",
      path: worktreePath,
      sessionId,
      pidsTerminated: killResult.terminated,
      pidsKilled: killResult.killed,
      errors: killResult.errors.length ? killResult.errors : undefined,
      reason: "hard-delete-fallback",
    });

    const removeResult = await removeWorktree({
      repoRoot: basePath,
      worktreePath,
    });
    if (!removeResult.ok) {
      const isAlreadyGone =
        removeResult.error.includes("is not a working tree") ||
        removeResult.error.includes("No such file or directory");
      if (!isAlreadyGone) {
        return removeResult;
      }
    }
  }

  // Delete the branch (only in fallback path — soft-delete preserves it).
  // #4481: never delete a pre-existing local branch — it belongs to the user
  // (`preserveBranch` above: the meta OR the branch's git-config marker).
  if (actualBranch && preserveBranch) {
    logger.info(
      `[worktree] cleanupWorktreeAndBranch: branch ${actualBranch} preserved — pre-existing (branch_origin=existing-local)`
    );
  } else if (actualBranch) {
    try {
      await runGit(["branch", "-D", actualBranch], basePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("not found")) {
        return { ok: false, error: `Branch deletion failed: ${message}` };
      }
    }
  }

  return { ok: true };
}

/** The stable refusal codes of {@link cleanupIdleWorktree} (#4450). */
export type IdleWorktreeRefusal =
  | "invalid_request"
  | "worktree_not_found"
  | "symlink_escape"
  | "worktree_in_use"
  | "worktree_owner_unknown"
  | "worktree_owner_mismatch"
  | "worktree_instance_claimed"
  | "branch_unknown"
  | "protected_branch"
  | "soft_delete_failed";

export type IdleWorktreeResult =
  | { ok: true; holdingPath: string; keptBranch: boolean }
  | { ok: false; code: IdleWorktreeRefusal; error: string };

/** Branches the guarded removal never takes a worktree off, besides the
 *  meta's `source_branch` and the branch `origin/HEAD` names. */
const ALWAYS_PROTECTED_BRANCHES = ["ms-dev", "main", "master"];

/**
 * The guarded worktree removal behind the operator `remove_worktree` tool
 * (#4450 R4 meta half, R5, R9, R11). Unlike `cleanupWorktreeAndBranch`, which
 * session delete uses and which is unchanged, it REFUSES rather than forces:
 * every check below runs before anything changes on disk, it never kills a
 * process, never stops a worktree instance, never hard-deletes, and never runs
 * `git branch -D`. The worktree is only moved to `.worktrees/.trash/`, where
 * `recoverWorktree` (`hapi-worktree.sh recover`) can restore it.
 *
 * Checks, in order: the real path is a direct child of `<hostBase>/.worktrees/`
 * (a symlink cannot lead out); no process of any name has its cwd inside it,
 * proven by a scan that reports its own failures; the `.worktree-meta.json`
 * parses (read ONCE — every later check uses that copy) and names
 * `expectedOwnerTag`; the meta holds an explicit `"claimed_port": null`; the
 * HEAD branch is not the meta's `source_branch`, the `origin/HEAD` branch,
 * `ms-dev`, `main` or `master`.
 *
 * Branch keeping (R11): the trash record marks the branch `existing-local` (the
 * purge's keep signal) unless the meta has no `branch_origin`, the branch has no
 * `hapimaticOrigin` marker, and HEAD is on `branch`, the branch the server
 * recorded. Anything else means the branch may not be the session's own.
 */
export async function cleanupIdleWorktree(
  options: {
    basePath: string;
    worktreePath: string;
    branch: string;
    expectedOwnerTag: string;
    sessionId?: string;
  },
  seams: { scan?: () => Promise<{ cwds: string[]; errors: string[] }> } = {}
): Promise<IdleWorktreeResult> {
  const { basePath, worktreePath, branch, expectedOwnerTag, sessionId } =
    options;
  const refuse = (
    code: IdleWorktreeRefusal,
    error: string
  ): IdleWorktreeResult => ({ ok: false, code, error });
  const scan = seams.scan ?? (() => scanAllProcCwds());

  // 1. Path: lexical containment first, then the same test on the real paths.
  const hostBase = resolveWorktreeHostBase(basePath);
  const lexical = isWithinWorktreeBase(hostBase, worktreePath);
  if (!lexical.valid) {
    return refuse("invalid_request", lexical.error ?? "invalid worktreePath");
  }
  let realBase: string;
  let realWorktree: string;
  try {
    realBase = await realpath(hostBase);
    realWorktree = await realpath(worktreePath);
  } catch (error) {
    return refuse(
      "worktree_not_found",
      `cannot resolve ${worktreePath}: ${errnoCode(error) ?? String(error)}`
    );
  }
  const worktreesRoot = join(realBase, ".worktrees");
  if (
    dirname(realWorktree) !== worktreesRoot ||
    basename(realWorktree) === TRASH_DIR_NAME
  ) {
    return refuse(
      "symlink_escape",
      `${worktreePath} resolves to ${realWorktree}, not a worktree directly under ${worktreesRoot}`
    );
  }

  // 2. Liveness: any holder, or any doubt, refuses.
  const inUse = async (): Promise<string | null> => {
    const { cwds, errors } = await scan();
    if (errors.length > 0) {
      return `cannot prove the worktree idle: ${errors.slice(0, 3).join("; ")}`;
    }
    return isWorktreeLive(realWorktree, cwds)
      ? `a live process has its cwd inside ${realWorktree}`
      : null;
  };
  const busy = await inUse();
  if (busy) return refuse("worktree_in_use", busy);

  // 3. Owner: read and parse the meta once.
  let raw: Record<string, unknown>;
  try {
    const parsedJson: unknown = JSON.parse(
      await readFile(join(realWorktree, ".worktree-meta.json"), "utf-8")
    );
    if (!parsedJson || typeof parsedJson !== "object") {
      throw new Error("not a JSON object");
    }
    raw = parsedJson as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return refuse("worktree_owner_unknown", `unreadable meta: ${reason}`);
  }
  const meta = WorktreeMetaSchema.partial().safeParse(raw);
  if (!meta.success) {
    return refuse(
      "worktree_owner_unknown",
      `invalid meta: ${meta.error.issues[0]?.message ?? "schema mismatch"}`
    );
  }
  const owner = meta.data.session_id;
  if (!owner || !expectedOwnerTag) {
    return refuse("worktree_owner_unknown", "the meta names no owner session");
  }
  if (owner !== expectedOwnerTag) {
    return refuse(
      "worktree_owner_mismatch",
      "the meta's owner is not the session the server recorded"
    );
  }

  // 4. Instance claim: only an explicit null means no instance owns a port.
  if (!Object.hasOwn(raw, "claimed_port") || raw.claimed_port !== null) {
    return refuse(
      "worktree_instance_claimed",
      "the worktree still holds an instance port claim; stop its instance first"
    );
  }

  // 5. Branch: never take a worktree off a source or default branch.
  let actualBranch = "";
  try {
    actualBranch = (
      await runGit(["symbolic-ref", "--short", "HEAD"], realWorktree)
    ).stdout.trim();
  } catch {
    // Detached or unreadable HEAD: refused below.
  }
  if (!actualBranch) {
    return refuse("branch_unknown", "the worktree's HEAD is not on a branch");
  }
  const protectedBranches = new Set(ALWAYS_PROTECTED_BRANCHES);
  if (meta.data.source_branch) protectedBranches.add(meta.data.source_branch);
  try {
    const originHead = (
      await runGit(
        ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        basePath
      )
    ).stdout.trim();
    if (originHead) protectedBranches.add(originHead.replace(/^origin\//, ""));
  } catch {
    // No origin/HEAD: the fixed names and source_branch still apply.
  }
  if (protectedBranches.has(actualBranch)) {
    return refuse(
      "protected_branch",
      `the worktree is on ${actualBranch}, a protected branch`
    );
  }

  // R11: keep the branch unless all three records say the session made it.
  let markerPresent = true;
  try {
    markerPresent =
      (
        await runGit(
          [
            "config",
            "--default",
            "",
            "--get",
            `branch.${actualBranch}.hapimaticOrigin`,
          ],
          basePath
        )
      ).stdout.trim() !== "";
  } catch {
    // An unreadable marker counts as present: fail toward keeping the branch.
  }
  const keepBranch =
    meta.data.branch_origin !== undefined ||
    markerPresent ||
    actualBranch !== branch;

  const soft = await softDeleteWorktree({
    basePath,
    worktreePath: realWorktree,
    branch: actualBranch,
    sessionId,
    guard: { recheck: inUse, keepBranch },
  });
  if (!soft.ok) {
    return soft.refused
      ? refuse("worktree_in_use", soft.error)
      : refuse("soft_delete_failed", soft.error);
  }
  // The move leaves the branch in place (only the purge can delete it), so the
  // #2007 backup runs after it and a refusal above changes nothing at all.
  if (!keepBranch) await backupUnpushedBranch(basePath, actualBranch);
  return { ok: true, holdingPath: soft.holdingPath, keptBranch: keepBranch };
}

/**
 * Recover a soft-deleted worktree by moving it back from `.trash/` to its original path.
 */
export async function recoverWorktree(options: {
  basePath: string;
  holdingName?: string;
  branch?: string;
}): Promise<RecoverResult> {
  const { basePath, holdingName, branch } = options;
  // Issue #1558: resolve the host base so recover/list/purge operate on the
  // same (possibly NVMe-relocated) trash dir the soft-delete wrote to.
  const trashDir = join(
    resolveWorktreeHostBase(basePath),
    ".worktrees",
    TRASH_DIR_NAME
  );

  let targetMeta: SoftDeleteMetadata | null = null;
  let targetHoldingName = holdingName ?? "";
  let metaPath = "";

  if (holdingName) {
    metaPath = join(trashDir, `${holdingName}.meta.json`);
    try {
      const raw = await readFile(metaPath, "utf-8");
      targetMeta = JSON.parse(raw) as SoftDeleteMetadata;
    } catch {
      return { ok: false, error: `No metadata found for: ${holdingName}` };
    }
  } else if (branch) {
    // Search by branch name
    try {
      const files = await readdir(trashDir);
      for (const file of files) {
        if (!file.endsWith(".meta.json")) continue;
        const raw = await readFile(join(trashDir, file), "utf-8");
        const meta = JSON.parse(raw) as SoftDeleteMetadata;
        if (meta.branch === branch) {
          targetMeta = meta;
          targetHoldingName = file.replace(".meta.json", "");
          metaPath = join(trashDir, file);
          break;
        }
      }
    } catch {
      return { ok: false, error: "Cannot read trash directory" };
    }
    if (!targetMeta) {
      return {
        ok: false,
        error: `No soft-deleted worktree found for branch: ${branch}`,
      };
    }
  } else {
    return { ok: false, error: "Either holdingName or branch is required" };
  }

  const holdingPath = join(trashDir, targetHoldingName);
  const originalPath = targetMeta.originalPath;

  // Check if original path is already occupied
  if (await pathExists(originalPath)) {
    return {
      ok: false,
      error: `Original path is occupied: ${originalPath}`,
    };
  }

  try {
    await runGit(["worktree", "move", holdingPath, originalPath], basePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `git worktree move failed: ${message}` };
  }

  // Clean up metadata file
  try {
    await rm(metaPath);
  } catch {
    // Non-fatal
  }

  return {
    ok: true,
    info: {
      basePath,
      worktreePath: originalPath,
      branch: targetMeta.branch,
      name: basename(originalPath),
      createdAt: Date.now(),
    },
  };
}

/**
 * List all soft-deleted worktrees in the `.trash/` directory.
 */
export async function listSoftDeletedWorktrees(
  basePath: string
): Promise<(SoftDeleteMetadata & { holdingName: string })[]> {
  // Issue #1558: resolve the host base so recover/list/purge operate on the
  // same (possibly NVMe-relocated) trash dir the soft-delete wrote to.
  const trashDir = join(
    resolveWorktreeHostBase(basePath),
    ".worktrees",
    TRASH_DIR_NAME
  );
  const results: (SoftDeleteMetadata & { holdingName: string })[] = [];

  let files: string[];
  try {
    files = await readdir(trashDir);
  } catch {
    return results;
  }

  for (const file of files) {
    if (!file.endsWith(".meta.json")) continue;
    try {
      const raw = await readFile(join(trashDir, file), "utf-8");
      const meta = JSON.parse(raw) as SoftDeleteMetadata;
      results.push({
        ...meta,
        holdingName: file.replace(".meta.json", ""),
      });
    } catch {
      // Skip malformed metadata files
    }
  }

  return results;
}

/**
 * Purge soft-deleted worktrees older than the retention period.
 * Permanently removes the worktree directory and deletes the branch.
 *
 * TRIGGER: TWO automatic callers (issue #3451). (1) The spawn-time single-flight
 * `kickExpiredWorktreePurge()` wrapper below, invoked from
 * cli/src/daemon/sessionSpawner.ts AFTER the spawn's own createWorktree, off the
 * critical path (#2852 + #2450). (2) The daily 05:00-local `SupervisedLoop`
 * collector (`cli/src/daemon/worktreeCollector.ts`), which sweeps every
 * discovered repo root when `HAPI_WORKTREE_COLLECTOR=1` is set on the daemon's
 * systemd unit (exactly one daemon per node — default OFF). With the collector
 * enabled an idle repo no longer waits for its next spawn to reclaim trash.
 * `scripts/hapi-worktree.sh purge` / `worktree-cleanup.sh clean` remain
 * manual-only. See CLAUDE.md "Worktree Soft-Delete & Recovery".
 */
export async function purgeExpiredWorktrees(options: {
  basePath: string;
  retentionDays?: number;
}): Promise<number> {
  const { basePath, retentionDays = DEFAULT_RETENTION_DAYS } = options;
  // Issue #1558: resolve the host base so recover/list/purge operate on the
  // same (possibly NVMe-relocated) trash dir the soft-delete wrote to.
  const trashDir = join(
    resolveWorktreeHostBase(basePath),
    ".worktrees",
    TRASH_DIR_NAME
  );
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let purged = 0;

  // #3451: report a RETAINED (not-purged) entry through the ONLY log channel
  // that reaches error_logs (logger.reportError POSTs /cli/error-reports;
  // logger.warn is console+debug only and logProcessHygieneEvent appends JSONL —
  // neither is queryable). The DISTINCT category `daemon-worktree-purge-retained`
  // keeps these expected CIFS transients OUT of the V8-gated
  // `daemon-worktree-purge` category (a retain must not turn that gate red).
  const reportRetained = (
    hPath: string,
    branch: string,
    reason: string
  ): void => {
    const detail =
      reason === "wrong-root"
        ? "meta.basePath does not resolve to the purge root"
        : "holding directory survived removal";
    logger.reportError({
      message: `[worktree] purge retained ${hPath}: ${detail}`,
      category: "daemon-worktree-purge-retained",
      severity: "warn",
      context: JSON.stringify({ holdingPath: hPath, branch, basePath, reason }),
    });
  };

  // #3451: normalize a path for the wrong-root comparison. realpath resolves
  // symlinks + CIFS mount indirection so a symlinked root is NOT a false
  // mismatch; on ENOENT (a broken/relocated meta.basePath) fall back to a pure
  // resolve(). Returns null only for a non-string/empty input.
  const normPath = async (p: string | undefined): Promise<string | null> => {
    if (typeof p !== "string" || p.length === 0) return null;
    try {
      return await realpath(p);
    } catch {
      return resolve(p);
    }
  };
  // Hoisted — the purge root's normalized form is constant across the loop.
  const purgeBaseNorm = await normPath(basePath);

  let files: string[];
  try {
    files = await readdir(trashDir);
  } catch {
    return 0;
  }

  for (const file of files) {
    if (!file.endsWith(".meta.json")) continue;
    const metaPath = join(trashDir, file);
    let meta: SoftDeleteMetadata;
    try {
      const raw = await readFile(metaPath, "utf-8");
      meta = JSON.parse(raw) as SoftDeleteMetadata;
    } catch {
      continue;
    }

    const deletedTime = new Date(meta.deletedAt).getTime();
    if (deletedTime > cutoff) continue;

    const holdingName = file.replace(".meta.json", "");
    const holdingPath = join(trashDir, holdingName);

    // (a) #3451 wrong-root assertion — BEFORE any process kill or git op. Guards
    // against a misrouted meta whose recorded basePath disagrees with the root
    // being purged: such an entry's `git branch -D meta.branch` would otherwise
    // fire in the WRONG repo. Compare realpath-normalized on BOTH sides
    // (meta.basePath is stored verbatim from the caller, so a symlinked/CIFS
    // root must not false-positive). A meta with NO basePath field (a pre-field
    // legacy entry) is NOT flagged: its physical location under THIS trash dir
    // already proves ownership, and retaining it forever would defeat the
    // collector's whole purpose.
    if (meta.basePath) {
      const metaBaseNorm = await normPath(meta.basePath);
      if (
        purgeBaseNorm === null ||
        metaBaseNorm === null ||
        metaBaseNorm !== purgeBaseNorm
      ) {
        reportRetained(holdingPath, meta.branch, "wrong-root");
        continue;
      }
    }

    // Issue #1031: kill any lingering cwd-holders BEFORE the final git remove.
    // Insertion point matters — must run even when the holding directory is
    // already missing (re-entrant purge), so it's outside the try/catch below.
    const killResult = await killProcessesWithCwdUnder(holdingPath);
    logProcessHygieneEvent({
      source: "cli-worktree",
      action: "kill",
      path: holdingPath,
      sessionId: meta.sessionId,
      pidsTerminated: killResult.terminated,
      pidsKilled: killResult.killed,
      errors: killResult.errors.length ? killResult.errors : undefined,
      reason: "purge-expired",
    });

    // (b) #3451 capture whether the worktree directory was actually removed. The
    // pre-#3451 code swallowed this failure and then rm'd the meta
    // unconditionally, leaking an invisible holding dir (list/recover/purge all
    // iterate *.meta.json). Now a surviving directory is the only failure state,
    // and it gates the meta-delete + branch-delete below.
    let removed = false;
    let removeError: unknown = null;
    try {
      await runGit(["worktree", "remove", "--force", holdingPath], basePath);
      removed = true;
    } catch (err) {
      removeError = err;
    }
    if (!removed && !(await pathExists(holdingPath))) {
      // Already gone (re-entrant purge or a prior partial remove) — removed.
      removed = true;
    }

    // (c) #3451 convergence fallback (B-D13 = A — OPERATOR-AUTHORIZED, strictly
    // scoped). Attempt to converge a stuck holding dir, but ONLY under BOTH
    // guards: (i) isWithinWorktreeBase rejects `..` and enforces the
    // <hostBase>/.worktrees/ prefix, and (ii) the path is under
    // <hostBase>/.worktrees/.trash/ specifically. The operator authorized this
    // recursive delete on THAT scoping — do not widen it, and derive the path
    // only from join(trashDir, holdingName) above.
    if (!removed) {
      const hostBase = resolveWorktreeHostBase(basePath);
      const trashRoot = join(hostBase, ".worktrees", TRASH_DIR_NAME);
      const withinBase = isWithinWorktreeBase(hostBase, holdingPath).valid;
      const underTrash = resolve(holdingPath).startsWith(trashRoot + sep);
      if (withinBase && underTrash) {
        try {
          const listed = (
            await runGit(["worktree", "list", "--porcelain"], basePath)
          ).stdout;
          const resolvedHolding = resolve(holdingPath);
          const stillRegistered = listed
            .split("\n")
            .some(
              line =>
                line === `worktree ${holdingPath}` ||
                line === `worktree ${resolvedHolding}`
            );
          if (!stillRegistered) {
            // Unregistered: git will never reap it via `worktree remove` — the
            // directory outlived its registration. rm -rf + prune converges it.
            await rm(holdingPath, { recursive: true, force: true });
            await runGit(["worktree", "prune"], basePath);
          } else if (
            /locked/i.test(
              removeError instanceof Error
                ? removeError.message
                : String(removeError ?? "")
            )
          ) {
            // Locked worktree: git requires a doubled --force. Manual-lock-only
            // (nothing in cli/src runs `worktree lock`); kept for completeness.
            await runGit(
              ["worktree", "remove", "--force", "--force", holdingPath],
              basePath
            );
          }
        } catch {
          // Convergence is best-effort; the re-probe below decides the outcome.
        }
        if (!(await pathExists(holdingPath))) {
          removed = true;
        }
      }
    }

    if (removed) {
      // (Task 3 / R6, #3451) Protect unpushed commits BEFORE deleting the
      // branch. This must run at PURGE time, not only at soft-delete time — the
      // bulk of the standing expired backlog was soft-deleted before #2007
      // landed and so carries no `refs/hapimatic-backup/*` ref. Args are
      // (basePath, branch) IN THIS ORDER: both are strings, so a swap is
      // invisible to tsc but would run git with cwd = branch and silently no-op.
      // The guard never blocks deletion (any error degrades to null).
      // Delete the branch — unless it pre-existed the session (#4481): the
      // trash meta carries the worktree's branch_origin from soft-delete time,
      // and the branch's git-config marker is checked as the second record.
      if (
        await isPreservedBranch({
          repoRoot: basePath,
          branch: meta.branch,
          metaOrigin: meta.branchOrigin,
        })
      ) {
        logger.info(
          `[worktree] purge: branch ${meta.branch} preserved — pre-existing (branchOrigin=existing-local)`
        );
      } else {
        await backupUnpushedBranch(basePath, meta.branch);
        try {
          await runGit(["branch", "-D", meta.branch], basePath);
        } catch {
          // Branch may already be gone
        }
      }

      // Remove metadata file — ONLY after a confirmed removal (meta-leak fix).
      try {
        await rm(metaPath);
      } catch {
        // Non-fatal
      }

      purged += 1;
      continue;
    }

    // (d) #3451 retain + report: the holding directory survived removal. Keep
    // the meta (list/recover still see it; the next sweep retries), keep the
    // branch (recover needs it), and do NOT count it as purged.
    reportRetained(holdingPath, meta.branch, "remove-failed");
  }

  return purged;
}

// #2450: single-flight, fire-and-forget trigger for the expired-worktree purge.
// TWO callers now invoke this wrapper (issue #3451): a worktree spawn AFTER the
// spawn's own `git worktree add` (see sessionSpawner.ts), AND the daily 05:00
// collector tick (worktreeCollector.ts). #2852 first moved this purge off the
// spawning session's perceived latency (a bare per-spawn
// `void purgeExpiredWorktrees(...)`); #2450 adds this module-scoped guard so
// concurrent kicks coalesce to ONE purge at a time PER REPO ROOT — they never run
// overlapping `git worktree remove`/`branch -D` against the same shared .git/
// (AC #3 / R4). The map is process-local: cross-DAEMON exclusion (one collector
// per node) is delivered by the collector's enablement gate, not by this map.
// Keyed (resolved repo root -> in-flight promise): an UNKEYED guard would drop
// OTHER repos' purges outright during concurrent multi-repo spawns; the cited
// idiom (accounts/tokenRefreshService.ts inFlight map) is itself a keyed Map.
const expiredWorktreePurgeInFlight = new Map<
  string /* resolved repo root */,
  Promise<number>
>();

// Returns the in-flight Promise<number> so tests can await settlement and reset
// between cases. Production callers preserve fire-and-forget by NOT awaiting:
// `void kickExpiredWorktreePurge(directory)`. The returned promise NEVER rejects
// (R3): the outer `.catch` swallows BOTH the repo-root resolve and the purge, so
// a background failure can never surface as an unhandled rejection in the daemon.
export function kickExpiredWorktreePurge(
  spawnDirectory: string
): Promise<number> {
  return (async (): Promise<number> => {
    // Resolve the repo root so the trash-dir namespace matches
    // create/soft-delete/recover (#1567). Done INSIDE the background job so even
    // this cheap resolve stays off the spawn critical path (R1).
    const basePath = await resolveRepoRoot(spawnDirectory);

    // Coalesce PER repo root. The get->set below has no await between it, so it
    // is atomic in single-threaded JS: whichever kick resumes first claims the
    // slot; every other kick for this root joins the same purge. A kick that
    // lands mid-flight is dropped; the NEXT spawn's kick covers it (OR2) —
    // purgeExpiredWorktrees readdirs .trash and computes the expiry cutoff ONCE
    // at entry, so an in-flight purge does not reclaim entries that expire after
    // it started.
    const existing = expiredWorktreePurgeInFlight.get(basePath);
    if (existing) return existing;

    const run = purgeExpiredWorktrees({ basePath })
      .then(purged => {
        if (purged > 0) {
          logger.debug(
            `[DAEMON RUN] Purged ${purged} expired worktrees (background)`
          );
        }
        return purged;
      })
      .finally(() => {
        expiredWorktreePurgeInFlight.delete(basePath);
      });
    expiredWorktreePurgeInFlight.set(basePath, run);
    return run;
  })().catch(err => {
    // R3: best-effort — log and swallow; mirrors the pre-#2450 call site's
    // posture (logger.warn + reportCaught category "daemon-worktree-purge",
    // severity "warn"). The catch body is itself wrapped in try/catch so a
    // throwing logger cannot turn the never-rejects contract into an unhandled
    // rejection.
    try {
      logger.warn(
        `[DAEMON RUN] purgeExpiredWorktrees failed (non-fatal, background): ${err}`
      );
      logger.reportCaught(err, {
        category: "daemon-worktree-purge",
        severity: "warn",
      });
    } catch {
      // Logging must never break the never-rejects contract.
    }
    return 0;
  });
}

// ============================================================================
// #3210: Fleet sweep for orphaned `hapimatic-wt-*` units
// ============================================================================
// Reaps `hapimatic-wt-<port>-server`/`-daemon` systemd units that outlived their
// worktree entirely (meta gone, or the port claimed by no extant worktree).
// Composition of existing primitives: enumerate (listWorktreeUnitStates below),
// own-scan (collectOwnedWorktreePorts, worktreeMeta.ts), stop
// (tearDownWorktreeInstance), single-flight kick (kickOrphanedUnitSweep, mirrors
// kickExpiredWorktreePurge). Ships in `observe` mode first (log-only); `reap` is
// operator-gated via `HAPI_WT_ORPHAN_SWEEP=reap` on the daemon unit. Every design
// choice is biased toward UNDER-reaping — a wrong reap kills a live worktree's
// Claude sessions (HIGH failure impact).

/** One running `hapimatic-wt-<port>-{server,daemon}` unit and its ACTIVE state. */
export type WorktreeUnitState = {
  unit: string;
  port: number;
  suffix: "server" | "daemon";
  activeState: string;
};

/**
 * Enumerate running `hapimatic-wt-*` units (both `-server` and `-daemon`) with
 * their systemd ACTIVE state, in ONE `list-units` call. Returns `null` on a
 * non-zero exit or thrown execFile — an unreadable user bus (cron / `env -i` /
 * no `XDG_RUNTIME_DIR`) MUST mean "do nothing", the fail-toward-RUNNING posture
 * of `scripts/hapi-worktree.sh:58-72` — NOT `[]` (which reads as "no units").
 * Empty stdout with exit 0 → `[]` (genuinely no running units).
 *
 * Mirrors `listDaemonPortsByState` (cleanupWorktreesCli.ts) — same flags,
 * surfaces failure instead of swallowing it — but keeps BOTH suffixes and the
 * ACTIVE column (the tri-state `active|activating|reloading` the sweep needs).
 * `--plain --no-legend` columns are `UNIT LOAD ACTIVE SUB DESCRIPTION`.
 */
export async function listWorktreeUnitStates(): Promise<
  WorktreeUnitState[] | null
> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("systemctl", [
      "--user",
      "list-units",
      "--type=service",
      "--state=active,activating,reloading",
      "--no-legend",
      "--plain",
      "hapimatic-wt-*.service",
    ]));
  } catch {
    // Unreadable user bus — do nothing (fail toward RUNNING). NOT [].
    return null;
  }

  const states: WorktreeUnitState[] = [];
  const lineRe = /^(hapimatic-wt-(\d+)-(server|daemon))\.service\s+\S+\s+(\S+)/;
  for (const line of stdout.split("\n")) {
    const m = line.match(lineRe);
    if (!m) continue;
    const port = Number(m[2]);
    if (!Number.isFinite(port)) continue;
    states.push({
      unit: `${m[1]}.service`,
      port,
      suffix: m[3] as "server" | "daemon",
      activeState: m[4],
    });
  }
  return states;
}

/**
 * The `ActiveEnterTimestamp` of a unit as an epoch (seconds), or `null` on any
 * error / empty value. Belt-and-suspenders min-age grace for the sweep — only
 * ever queried for an UNOWNED, settled-`active` unit, so the extra per-candidate
 * `systemctl show` is bounded. Mirrors `getDaemonUptimeSeconds`
 * (cleanupWorktreesCli.ts) but keyed by unit name and returning the epoch.
 */
export async function getUnitActiveEnterEpoch(
  unit: string
): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("systemctl", [
      "--user",
      "show",
      "-p",
      "ActiveEnterTimestamp",
      "--value",
      unit,
    ]);
    const ts = stdout.trim();
    if (!ts) return null;
    const enterMs = Date.parse(ts);
    if (!Number.isFinite(enterMs)) return null;
    return Math.floor(enterMs / 1000);
  } catch {
    return null;
  }
}

/** Sweep mode: `observe` logs would-reap candidates (default, first deploy
 *  cycle); `reap` actually stops them. Selected by `HAPI_WT_ORPHAN_SWEEP`. */
export type OrphanSweepMode = "observe" | "reap";

/**
 * Read the sweep mode from the env (mirrors `getWorktreeStopTimeoutMs`). Default
 * `observe` — the issue's own risk table rates a false-positive reap HIGH, so
 * `reap` is opt-in via `HAPI_WT_ORPHAN_SWEEP=reap` on the daemon unit.
 */
export function getOrphanSweepMode(): OrphanSweepMode {
  return process.env.HAPI_WT_ORPHAN_SWEEP === "reap" ? "reap" : "observe";
}

const DEFAULT_ORPHAN_MIN_UNIT_AGE_SECONDS = 120;

/**
 * Fleet sweep: stop `hapimatic-wt-<port>-{server,daemon}` units whose port is
 * owned by NO extant worktree meta of the unit-owning repo (#3210). Ships
 * observe-first (log-only) — pass `mode: "reap"` (or set
 * `HAPI_WT_ORPHAN_SWEEP=reap`) to actually stop units. Returns the count of
 * ports reaped (reap) or would-reap (observe).
 *
 * INVARIANT (why the step-0 R6 gate exists): `hapimatic-wt-<port>-{server,daemon}`
 * units are created with `systemd-run --user --unit=… --working-directory="$HOME"`
 * (`scripts/hapi-worktree.sh`) and carry NO repo/worktree pointer — `list-units`
 * is HOST-global, while `owned` is computed from ONE repo's `.worktrees`. The
 * gate (`<repoRoot>/scripts/hapi-worktree.sh` present, the same ownership test
 * `release-worktree-port.sh:96-102` uses) makes the two domains coincide when
 * exactly one unit-owning repo exists on the host (RP1 today). Two clones of
 * hapimatic-private on one host would yield a partial `owned` set — an OPEN,
 * documented invariant; upgrade path is a union over #3451's
 * `discoverWorktreeRoots`.
 *
 * ORDER IS LOAD-BEARING (KD-2): enumerate units (step 1) BEFORE scanning owners
 * (step 2). Every unit is started by bash `start_instance` AFTER
 * `write_worktree_meta`, so a unit present in the step-1 snapshot had its meta
 * written first and the step-2 scan sees it. Computing `owned` first opens the
 * window "owner writes meta → forks unit → list-units sees an active+unowned
 * unit → reaped in its first second". Do NOT `Promise.all` steps 1 and 2.
 */
export async function sweepOrphanedWorktreeUnits(options: {
  basePath: string;
  mode?: OrphanSweepMode;
  minUnitAgeSeconds?: number;
  seams?: {
    listUnits?: () => Promise<WorktreeUnitState[] | null>;
    collectOwned?: (repoRoot: string) => Promise<Set<number> | null>;
    unitActiveEnterEpoch?: (unit: string) => Promise<number | null>;
    teardown?: (port: number) => Promise<TearDownWorktreeInstanceResult>;
    hasOwnerScript?: (repoRoot: string) => Promise<boolean>;
  };
}): Promise<number> {
  const mode = options.mode ?? getOrphanSweepMode();
  const minUnitAgeSeconds =
    options.minUnitAgeSeconds ?? DEFAULT_ORPHAN_MIN_UNIT_AGE_SECONDS;
  const listUnits = options.seams?.listUnits ?? listWorktreeUnitStates;
  const collectOwned = options.seams?.collectOwned ?? collectOwnedWorktreePorts;
  const unitActiveEnterEpoch =
    options.seams?.unitActiveEnterEpoch ?? getUnitActiveEnterEpoch;
  const teardown =
    options.seams?.teardown ??
    ((port: number) => tearDownWorktreeInstance({ port, clean: false }));
  const hasOwnerScript =
    options.seams?.hasOwnerScript ??
    ((repoRoot: string) =>
      pathExists(join(repoRoot, "scripts", "hapi-worktree.sh")));

  // `resolveRepoRoot` returns the MAIN root even from inside a linked worktree.
  const repoRoot = await resolveRepoRoot(options.basePath);

  // Step 0 — ownership-domain gate (R6). Only a unit-owning repo may sweep the
  // host-global units; any other root computes an empty `owned` and would reap
  // every live instance.
  if (!(await hasOwnerScript(repoRoot))) {
    logger.debug(
      `[DAEMON RUN] orphan sweep: ${repoRoot} does not own hapimatic-wt units — skipped`
    );
    return 0;
  }

  // Step 1 — enumerate units FIRST (order is load-bearing; see doc block).
  const units = await listUnits();
  if (units === null) {
    logger.debug(
      "[DAEMON RUN] orphan sweep: unit enumeration unreadable (user bus) — skipped"
    );
    return 0;
  }

  // Step 2 — THEN scan owners.
  const owned = await collectOwned(repoRoot);
  if (owned === null) {
    logger.debug(
      `[DAEMON RUN] orphan sweep: owner scan unreadable (.worktrees under ${repoRoot}) — skipped`
    );
    return 0;
  }

  // Step 3 — decide per PORT (dedupe `-server`/`-daemon` to one decision).
  const byPort = new Map<number, WorktreeUnitState[]>();
  for (const u of units) {
    const list = byPort.get(u.port);
    if (list) list.push(u);
    else byPort.set(u.port, [u]);
  }

  let count = 0;
  for (const [port, portUnits] of byPort) {
    if (owned.has(port)) continue; // R2 — owned, never touched.

    // R3/KD-2: any unit still `activating`/`reloading` → skip this pass (grace
    // for an in-flight spawn). Belt-and-suspenders; the real race guard is the
    // step-1-before-step-2 ordering above.
    if (
      portUnits.some(
        u => u.activeState === "activating" || u.activeState === "reloading"
      )
    ) {
      continue;
    }

    // Optional min-age grace (belt-and-suspenders): skip a freshly-started unit.
    if (minUnitAgeSeconds > 0) {
      const nowEpoch = Math.floor(Date.now() / 1000);
      let tooYoung = false;
      for (const u of portUnits) {
        const enter = await unitActiveEnterEpoch(u.unit);
        if (enter !== null && nowEpoch - enter < minUnitAgeSeconds) {
          tooYoung = true;
          break;
        }
      }
      if (tooYoung) continue;
    }

    // Settled `active` + unowned → ORPHAN.
    if (mode === "observe") {
      logger.warn(
        `[DAEMON RUN] orphan sweep (observe): WOULD stop hapimatic-wt-${port} (unowned, active)`
      );
      count += 1;
      continue;
    }

    const result = await teardown(port);
    if (result.ok) {
      logger.warn(
        `[DAEMON RUN] orphan sweep (reap): stopped hapimatic-wt-${port} (unowned, active)`
      );
      count += 1;
    } else {
      logger.warn(
        `[DAEMON RUN] orphan sweep (reap): failed to stop hapimatic-wt-${port}: ${result.error}`
      );
    }
  }

  return count;
}

// #3210: single-flight, fire-and-forget trigger for the orphan-unit sweep.
// Mirrors kickExpiredWorktreePurge verbatim — own module-scoped Map keyed by
// resolved repo root, atomic get->set (no await between), .finally delete, and a
// never-rejects outer .catch. Kicked at worktree-spawn time (sessionSpawner.ts);
// production callers `void` it. #3451's SupervisedLoop may later call this from
// its tick (KD-4). The returned promise NEVER rejects.
const orphanUnitSweepInFlight = new Map<
  string /* resolved repo root */,
  Promise<number>
>();

export function kickOrphanedUnitSweep(spawnDirectory: string): Promise<number> {
  return (async (): Promise<number> => {
    const basePath = await resolveRepoRoot(spawnDirectory);

    const existing = orphanUnitSweepInFlight.get(basePath);
    if (existing) return existing;

    const run = sweepOrphanedWorktreeUnits({ basePath })
      .then(count => {
        if (count > 0) {
          logger.debug(
            `[DAEMON RUN] orphan sweep complete (background): ${count} candidate(s)`
          );
        }
        return count;
      })
      .finally(() => {
        orphanUnitSweepInFlight.delete(basePath);
      });
    orphanUnitSweepInFlight.set(basePath, run);
    return run;
  })().catch(err => {
    try {
      logger.warn(
        `[DAEMON RUN] orphan sweep failed (non-fatal, background): ${err}`
      );
      logger.reportCaught(err, {
        category: "daemon-worktree-orphan-sweep",
        severity: "warn",
      });
    } catch {
      // Logging must never break the never-rejects contract.
    }
    return 0;
  });
}
