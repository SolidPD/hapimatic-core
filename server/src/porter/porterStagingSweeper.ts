// SPDX-License-Identifier: AGPL-3.0-only
import { porterExposed } from "../config/porterExposureConfig";
import {
  PORTER_STAGING_TTL_MS,
  sweepExpiredPorterDirs,
  type ImportPlan,
} from "./importArchive";

/**
 * Configuration Porter staging sweeper (issue #5170).
 *
 * An uploaded plan that is never committed must not outlive its TTL: its
 * in-memory {@link ImportPlan} carries the decrypted MCP configuration, and its
 * `porter-staging/<handle>` dir holds the extracted archive. Before #5170 the
 * only sweep ran inside the authenticated plan route, the plan store had no
 * expiry at all, and an idle instance kept both indefinitely.
 *
 * ONE sweeper is built in `buildWebApp.ts` over the shared plan store, with a
 * timer, and injected into the plan route and the public upload leg (each also
 * kicks it). A sweep:
 *  1. deletes every plan older than its own `ttlMs`, so no commit can START on
 *     an expired plan (the commit route answers 410 for a missing handle);
 *  2. then removes staging/backup dirs older than the TTL plus a grace, never a
 *     dir whose handle is still in the store. Commit checks the staging dir only
 *     when it starts and the sweep takes no import lock, so the grace lets a
 *     commit that began just before the TTL finish.
 *
 * Calls are coalesced (a sweep in flight is shared) and never reject. The timer
 * sweeps only while Porter is exposed, so a withheld instance (#4533) does no
 * Porter I/O.
 */

/** How long after the staging TTL a dir may still be removed. */
export const STAGING_SWEEP_GRACE_MS = 5 * 60 * 1000;

export interface PorterStagingSweeper {
  /** Expire plans, then reap dirs. Coalesced; never rejects. */
  sweep(): Promise<void>;
  /** Stop the timer (shutdown / tests). */
  stop(): void;
}

export interface PorterStagingSweeperOptions {
  dataDir: string;
  planStore: Map<string, ImportPlan>;
  /** Sweep on an unref'd interval of this many ms. Omitted → no timer. */
  intervalMs?: number;
  /** Grace past the staging TTL before a dir is removed. */
  graceMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
  /** Whether a timer tick may sweep (default: Porter is exposed). */
  isEnabled?: () => boolean;
}

/**
 * Whether `plan` has outlived its own TTL at `now`. The one expiry rule: the
 * sweep and the commit route's refusal (`routes/porterImport.ts`) both use it,
 * so no commit can start on a plan the sweeper treats as expired.
 */
export function isPlanExpired(
  plan: Pick<ImportPlan, "createdAt" | "ttlMs">,
  now: number
): boolean {
  return now - plan.createdAt > plan.ttlMs;
}

/** Delete every plan whose own TTL has passed; returns how many went. */
export function expirePlanStore(
  store: Map<string, ImportPlan>,
  now: number
): number {
  let expired = 0;
  for (const [handle, plan] of store) {
    if (isPlanExpired(plan, now)) {
      store.delete(handle);
      expired++;
    }
  }
  return expired;
}

export function createPorterStagingSweeper(
  opts: PorterStagingSweeperOptions
): PorterStagingSweeper {
  const graceMs = opts.graceMs ?? STAGING_SWEEP_GRACE_MS;
  const now = opts.now ?? (() => Date.now());
  const isEnabled = opts.isEnabled ?? porterExposed;
  let inflight: Promise<void> | null = null;

  function sweep(): Promise<void> {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const t = now();
        expirePlanStore(opts.planStore, t);
        await sweepExpiredPorterDirs(
          opts.dataDir,
          PORTER_STAGING_TTL_MS + graceMs,
          t,
          new Set(opts.planStore.keys())
        );
      } catch {
        // Best-effort: a failed sweep is retried on the next kick or tick.
      }
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  if (opts.intervalMs !== undefined) {
    timer = setInterval(() => {
      if (isEnabled()) void sweep();
    }, opts.intervalMs);
    // Never keep the process alive for the sweep (porterToken.ts pattern).
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { sweep, stop };
}
