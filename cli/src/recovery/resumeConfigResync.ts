// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Resume-time `.claude/` re-sync queue (issue #5117).
 *
 * On a daemon start, `RecoveryService` schedules one `.claude/` re-sync per
 * recovered record with a live window (#1320, source-branch-aware since #1399).
 * Before #5117 each was a detached task with no bound, so one restart ran
 * ~112 `git fetch origin ms-dev` against one clone at once. This queue runs at
 * most `HAPI_SYNC_CONFIG_ON_RESUME_CONCURRENCY` (default 2) jobs at a time, in
 * FIFO order, and never blocks recovery; the per-pass fetch coalescer
 * (`createSourceBranchFetchCoalescer`) is passed through to each job.
 */

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

import { logger } from "@/ui/logger";
import { syncConfigFromMain, type SourceBranchFetch } from "@/daemon/worktree";
import { readClaimedPort } from "@/daemon/worktreeMeta";

const execFileAsync = promisify(execFile);

export const DEFAULT_RESUME_SYNC_CONCURRENCY = 2;

/**
 * `HAPI_SYNC_CONFIG_ON_RESUME_CONCURRENCY` as a positive integer, else 2.
 */
export function resolveResumeSyncConcurrency(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.HAPI_SYNC_CONFIG_ON_RESUME_CONCURRENCY;
  if (!raw) return DEFAULT_RESUME_SYNC_CONCURRENCY;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RESUME_SYNC_CONCURRENCY;
}

/** The existing opt-out: `HAPI_SYNC_CONFIG_ON_RESUME=0` disables the re-sync. */
export function isResumeSyncEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.HAPI_SYNC_CONFIG_ON_RESUME !== "0";
}

/**
 * Issue #1328: Determine whether a session's cwd is a hapimatic-private
 * working tree. Used to scope the resume-time `.claude/` re-sync gate so the
 * daemon does NOT issue `git fetch` against unrelated repos' origins (rp1-home,
 * rp1-home worktrees, etc.) on every recovery cycle.
 *
 * Cheap path: Hapimatic-spawned worktrees carry `.worktree-meta.json`. The
 * presence of a parseable meta-file with a claimed_port implies the worktree
 * was created by Hapimatic, which by current construction only spawns
 * hapimatic-private worktrees.
 *
 * Fallback path: query the cwd's `origin` remote URL. Covers manual
 * `git worktree add` worktrees AND the base clones (which lack a meta-file
 * but have the right origin).
 *
 * Fail-closed: any error returns false. The caller logs at debug level and
 * skips the re-sync.
 */
export async function isHapimaticPrivateCwd(cwd: string): Promise<boolean> {
  if ((await readClaimedPort(cwd)) !== null) {
    return true;
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["remote", "get-url", "origin"],
      { cwd, timeout: 5000 }
    );
    return stdout.includes("MattStarfield/hapimatic-private");
  } catch {
    return false;
  }
}

/**
 * Whether `path` is still there. Only ENOENT reads as gone (#5202 U6): an
 * EACCES or EIO path is still there, so the job proceeds and git reports the
 * real error instead of the record being skipped as a removed worktree.
 */
export async function pathExists(
  path: string,
  accessPath: (path: string) => Promise<void> = access
): Promise<boolean> {
  try {
    await accessPath(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    logger.debug(
      `[resume-resync] could not check ${path} (${code ?? String(err)}); treating it as present`
    );
    return true;
  }
}

export type ResumeResyncJob = {
  worktreePath: string;
  sessionId: string;
  fetch?: SourceBranchFetch;
};

export type ResumeResyncDeps = {
  sync: typeof syncConfigFromMain;
  isEligible: (cwd: string) => Promise<boolean>;
  pathExists: (path: string) => Promise<boolean>;
};

/**
 * A FIFO queue of resume-time re-sync jobs with a concurrency cap. `schedule`
 * returns at once and never throws; a job can never reject.
 */
export class ResumeConfigResyncQueue {
  private readonly concurrency: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly deps: ResumeResyncDeps;
  private readonly pending: ResumeResyncJob[] = [];
  private running = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(
    options: {
      concurrency?: number;
      env?: NodeJS.ProcessEnv;
      deps?: Partial<ResumeResyncDeps>;
    } = {}
  ) {
    this.env = options.env ?? process.env;
    this.concurrency =
      options.concurrency ?? resolveResumeSyncConcurrency(this.env);
    this.deps = {
      sync: options.deps?.sync ?? syncConfigFromMain,
      isEligible: options.deps?.isEligible ?? isHapimaticPrivateCwd,
      pathExists: options.deps?.pathExists ?? pathExists,
    };
  }

  /** Queue a re-sync. A no-op when `HAPI_SYNC_CONFIG_ON_RESUME=0`. */
  schedule(job: ResumeResyncJob): void {
    if (!isResumeSyncEnabled(this.env)) {
      return;
    }
    this.pending.push(job);
    this.pump();
  }

  /** Resolves when nothing is queued or running. Production never awaits it. */
  whenIdle(): Promise<void> {
    if (this.running === 0 && this.pending.length === 0) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.idleWaiters.push(resolve);
    });
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift() as ResumeResyncJob;
      this.running++;
      void this.runJob(job).finally(() => {
        this.running--;
        this.pump();
        if (this.running === 0 && this.pending.length === 0) {
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          for (const resolve of waiters) resolve();
        }
      });
    }
  }

  private async runJob(job: ResumeResyncJob): Promise<void> {
    const { worktreePath, sessionId } = job;
    try {
      // #5117: the job may run seconds after it was scheduled; a worktree
      // removed in between must not reach git.
      if (!(await this.deps.pathExists(worktreePath))) {
        logger.debug(
          `[RecoveryService] Resume-time .claude/ re-sync: skipping gone cwd ${worktreePath} (${sessionId})`
        );
        return;
      }

      // Issue #1328: scope to hapimatic-private worktrees. Skip the
      // sync for sessions whose cwd belongs to a different repo
      // (rp1-home, rp1-home worktrees, other projects) so we don't
      // issue `git fetch` against unrelated origins on every daemon
      // recovery.
      if (!(await this.deps.isEligible(worktreePath))) {
        logger.debug(
          `[RecoveryService] Resume-time .claude/ re-sync: skipping non-hapimatic-private cwd ${worktreePath} (${sessionId})`
        );
        return;
      }

      const syncResult = await this.deps.sync({
        worktreePath,
        fetch: job.fetch,
      });
      if (syncResult.ok) {
        // Issue #1327: surface fetch failure even when sync overall
        // succeeded — without this, a hung/failed fetch followed by a
        // successful diff/checkout against the (potentially stale) local
        // origin/<source-branch> ref would log nothing, recreating the
        // silent-failure mode that #1320 was meant to close.
        if (!syncResult.fetchSucceeded) {
          logger.warn(
            `[RecoveryService] Resume-time .claude/ re-sync: fetch failed, used local origin/<source-branch> ref (${syncResult.filesUpdated} files updated) (${sessionId})`
          );
        } else if (syncResult.filesUpdated > 0) {
          logger.info(
            `[RecoveryService] Resume-time .claude/ re-sync: ${syncResult.filesUpdated} files updated (${sessionId})`
          );
        }
      } else {
        logger.warn(
          `[RecoveryService] Resume-time .claude/ re-sync failed (non-fatal): ${syncResult.error} (${sessionId})`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[RecoveryService] Resume-time .claude/ re-sync threw (non-fatal): ${message} (${sessionId})`
      );
    }
  }
}
