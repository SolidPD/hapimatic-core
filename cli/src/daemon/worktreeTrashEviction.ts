// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Disk-pressure eviction of soft-deleted worktrees (issue #6158, D4).
 *
 * A soft-deleted worktree sits full-size in `.worktrees/.trash` for 10 days
 * (`DEFAULT_RETENTION_DAYS`), and each new worker worktree costs 1-2.5 GB. When
 * the filesystem holding the trash is at or above `HAPI_WORKTREE_TRASH_DISK_PCT`
 * percent used (default 85), the purge evicts the oldest trash entries first
 * until usage drops back below the threshold. Below it, nothing is evicted.
 *
 * Eviction removes the working tree only. Before it, the entry's uncommitted
 * changes and untracked, non-ignored files are snapshotted into a
 * `refs/hapimatic-backup/<branch>-wip-*` ref — a hard precondition: no ref, no
 * eviction. An entry holding a nested git repository gets no ref (its content
 * would be a gitlink only), so it is never evicted. The ref is written into the
 * trash meta (`wipRef`, with the `.worktree-meta.json` text) BEFORE anything is
 * removed, because a removal that fails partway still deletes files: a later
 * pass reuses that recorded ref instead of snapshotting what is left. After the
 * removal the meta gains `evictedAt`. The branch and the meta stay, so
 * `recoverWorktree` can recreate the worktree from the branch and restore the
 * snapshot, and the normal 10-day purge still owns branch deletion. Only ignored
 * files (node_modules, build output — the bulk of the size) are lost.
 *
 * Every side effect is injected (`EvictionDeps`), so this module imports
 * nothing from `worktree.ts`; `purgeExpiredWorktrees` wires the real ones.
 */

export const DEFAULT_TRASH_DISK_PCT = 85;

/**
 * The eviction threshold from `HAPI_WORKTREE_TRASH_DISK_PCT`: an integer 1-99,
 * or `0`/`off` to disable eviction (`pct: null`). Anything else falls back to
 * the default with a warning.
 */
export function resolveTrashDiskPct(
  env: Record<string, string | undefined> = process.env
): { pct: number | null; warning?: string } {
  const raw = env.HAPI_WORKTREE_TRASH_DISK_PCT?.trim().toLowerCase();
  if (!raw) return { pct: DEFAULT_TRASH_DISK_PCT };
  if (raw === "0" || raw === "off") return { pct: null };
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n >= 1 && n <= 99) return { pct: n };
  }
  return {
    pct: DEFAULT_TRASH_DISK_PCT,
    warning: `HAPI_WORKTREE_TRASH_DISK_PCT=${JSON.stringify(env.HAPI_WORKTREE_TRASH_DISK_PCT)} is not 0, off or an integer 1-99; using ${DEFAULT_TRASH_DISK_PCT}`,
  };
}

export interface StatfsLike {
  blocks: number | bigint;
  bfree: number | bigint;
  bavail: number | bigint;
}

/** Percent of the filesystem in use, computed as `df` does (rounded up). */
export function usedPercent(s: StatfsLike): number {
  const blocks = Number(s.blocks);
  const used = blocks - Number(s.bfree);
  const denom = used + Number(s.bavail);
  if (!(denom > 0)) return 0;
  return Math.ceil((used * 100) / denom);
}

/** The trash meta fields eviction reads and writes (a subset of SoftDeleteMetadata). */
export interface EvictableMeta {
  branch: string;
  deletedAt: string;
  evictedAt?: string;
  wipRef?: string;
  worktreeMetaJson?: string;
  [key: string]: unknown;
}

export interface TrashEntry {
  holdingName: string;
  holdingPath: string;
  metaPath: string;
  meta: EvictableMeta;
  /** `deletedAt` as epoch ms, or the meta file's mtime when `deletedAt` is invalid. */
  deletedMs: number;
}

export interface EvictionDeps {
  statfs(path: string): Promise<StatfsLike>;
  /** Non-evicted entries that belong to this repo root (the wrong-root check already applied). */
  listCandidates(): Promise<TrashEntry[]>;
  killCwdHolders(entry: TrashEntry): Promise<void>;
  /** Snapshot uncommitted + untracked work; the backup ref, or null when it failed. */
  snapshotWip(entry: TrashEntry): Promise<string | null>;
  /** True when a snapshot ref an earlier pass recorded still names a commit. */
  snapshotExists(entry: TrashEntry, ref: string): Promise<boolean>;
  /** The holding dir's `.worktree-meta.json` text, or null. */
  readWorktreeMeta(entry: TrashEntry): Promise<string | null>;
  /** Remove the holding dir; true when it is gone. */
  removeHoldingDir(entry: TrashEntry): Promise<boolean>;
  writeMeta(entry: TrashEntry, meta: EvictableMeta): Promise<void>;
  /**
   * Run `fn` under the host-wide eviction lock, or report `acquired: false`
   * without waiting when another eviction holds it.
   */
  withLock<T>(fn: () => Promise<T>): Promise<{ acquired: boolean; value?: T }>;
  now(): Date;
}

export interface EvictionResult {
  /** Why nothing ran, when nothing ran. */
  skipped?: "below-threshold" | "statfs-failed" | "lock-held";
  usedBefore?: number;
  usedAfter?: number;
  evicted: { holdingName: string; wipRef: string }[];
  /** Entries left in place, with the reason and any snapshot already taken. */
  kept: { holdingName: string; reason: string; wipRef?: string }[];
}

export async function evictTrashUnderDiskPressure(
  opts: { trashDir: string; thresholdPct: number },
  deps: EvictionDeps
): Promise<EvictionResult> {
  const result: EvictionResult = { evicted: [], kept: [] };
  const readUsed = async (): Promise<number | null> => {
    try {
      return usedPercent(await deps.statfs(opts.trashDir));
    } catch {
      return null;
    }
  };

  const before = await readUsed();
  if (before === null) return { ...result, skipped: "statfs-failed" };
  result.usedBefore = before;
  if (before < opts.thresholdPct) {
    return { ...result, skipped: "below-threshold", usedAfter: before };
  }

  const locked = await deps.withLock(async () => {
    let used: number | null = await readUsed();
    const candidates = (await deps.listCandidates()).sort(
      (a, b) => a.deletedMs - b.deletedMs
    );
    for (const entry of candidates) {
      if (used === null || used < opts.thresholdPct) break;
      await deps.killCwdHolders(entry);
      // An earlier pass that was cut off mid-removal already recorded the
      // snapshot of the intact tree: reuse it, never re-snapshot what is left.
      const recorded =
        typeof entry.meta.wipRef === "string" && entry.meta.wipRef !== ""
          ? entry.meta.wipRef
          : null;
      if (recorded && !(await deps.snapshotExists(entry, recorded))) {
        result.kept.push({
          holdingName: entry.holdingName,
          reason: "the recorded snapshot no longer exists",
          wipRef: recorded,
        });
        continue;
      }
      const wipRef = recorded ?? (await deps.snapshotWip(entry));
      if (!wipRef) {
        result.kept.push({
          holdingName: entry.holdingName,
          reason: "work-in-progress snapshot failed",
        });
        continue;
      }
      const worktreeMetaJson =
        typeof entry.meta.worktreeMetaJson === "string"
          ? entry.meta.worktreeMetaJson
          : await deps.readWorktreeMeta(entry);
      const pending: EvictableMeta = {
        ...entry.meta,
        wipRef,
        ...(worktreeMetaJson !== null ? { worktreeMetaJson } : {}),
      };
      // Record the snapshot BEFORE removing anything: `git worktree remove`
      // deletes what it can before it fails, and the meta is the only record
      // recovery reads.
      if (!recorded) {
        try {
          await deps.writeMeta(entry, pending);
        } catch (err) {
          result.kept.push({
            holdingName: entry.holdingName,
            reason: `could not record the snapshot in the trash meta: ${err instanceof Error ? err.message : String(err)}`,
            wipRef,
          });
          continue;
        }
      }
      if (!(await deps.removeHoldingDir(entry))) {
        result.kept.push({
          holdingName: entry.holdingName,
          reason: "holding directory survived removal",
          wipRef,
        });
        continue;
      }
      await deps.writeMeta(entry, {
        ...pending,
        evictedAt: deps.now().toISOString(),
      });
      result.evicted.push({ holdingName: entry.holdingName, wipRef });
      used = await readUsed();
    }
    result.usedAfter = used ?? undefined;
  });

  if (!locked.acquired) return { ...result, skipped: "lock-held" };
  return result;
}
