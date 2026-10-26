// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The execute-bit reconcile for byte-identical files on a Configuration Porter
 * re-import (#4129). Split out of `importArchive.ts` to keep it under the #2077
 * max-lines cap.
 *
 * Conflict detection keys on content only (`conflictDetection.ts`), so a
 * re-import skips every `exists` file and the #3553 mode fix never reached one.
 * A hook the pre-#3553 porter wrote at 0644 stayed 0644. This module gives such
 * a file the archive's execute bit, and nothing else:
 *
 *  - A class (owner, group, other) gains an execute bit only when the masked
 *    archive mode carries it AND the class can already read the file. That
 *    grants no capability: a class that can read a script can run it through an
 *    interpreter, and a class that can read a binary can copy it.
 *  - Read and write are never granted, and execute is never removed. A missing
 *    archive execute bit is weak evidence: `tarArchive.ts` parses a zero ustar
 *    mode as `undefined`, which `importFileMode` (`commitFs.ts`) defaults to
 *    0o644, and a Windows `tar.exe` archive carries no execute bits.
 *  - A written mode drops group/other write and setuid/setgid/sticky (the same
 *    `& 0o755` mask every porter-written mode obeys). There is no owner floor,
 *    so a read-only 0o444 file becomes 0o555, not 0o755.
 *
 * The plan previews every change ({@link previewModeReconcile}); the operator
 * can keep any row's current mode, and the caller removes kept paths before the
 * reconcile (a choice, not a skip). The commit applies ONLY previewed changes:
 * it decides again from a fresh `lstat` and skips the file as `changed` unless
 * that decision equals the previewed `from` → `to` — so a mode changed after
 * the preview is never silently re-decided. Each change then goes through an
 * `O_NOFOLLOW` file descriptor after re-checking the file (regular, same
 * inode/device/mode as the commit's decision, and its content still hashes to
 * the plan's `incomingHash`), so a symlink is never followed. The undo
 * ({@link restoreModes}) is mode-only, never a `copyFile` restore: the bytes
 * never changed, and `copyFile` follows links.
 */
import { constants, type Stats } from "node:fs";
import { lstat, open, stat, type FileHandle } from "node:fs/promises";
import { importFileMode, restoreCause, type RestoreFailure } from "./commitFs";
import { hashContent, type Conflict } from "./conflictDetection";
import type { PlannedItemKind } from "./importArchive";
import type {
  ModeCorrection,
  ModeReconcilePreview,
  ModeSkip,
  ModeSkipReason,
} from "@hapi/protocol/porter";
// #5601: the wire shapes live in @hapi/protocol/porter (importWire.ts).
export type {
  ModeCorrection,
  ModeSkipReason,
  ModeSkip,
  ModePreviewFix,
  ModePreviewSkip,
  ModeReconcilePreview,
} from "@hapi/protocol/porter";

/** What the reconcile needs from a planned file item (`PlannedFileItem` fits). */
export interface ModeReconcileItem {
  destPath: string;
  /** The item kind; a `hook-lib` file follows the hooks' Step-1 selection. */
  kind: PlannedItemKind;
  /** The archive entry's unmasked mode. */
  mode?: number;
  /** SHA-256 of the archive content; the file must still hash to it. */
  incomingHash: string;
}

/** The undo record for one applied chmod ({@link restoreModes}). */
export interface AppliedModeFix {
  destPath: string;
  from: number;
  ino: number;
  dev: number;
}

/** Test-only DI seam. Defaults to the real filesystem and process uid. */
export interface ModeReconcileOps {
  lstat: (path: string) => Promise<Stats>;
  stat: (path: string) => Promise<Stats>;
  uid: () => number | undefined;
}

const DEFAULT_OPS: ModeReconcileOps = {
  lstat: p => lstat(p),
  stat: p => stat(p),
  uid: () => process.getuid?.(),
};

/** `O_NOFOLLOW` refuses a symlink; `O_NONBLOCK` keeps a FIFO from hanging the open. */
const OPEN_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** `0o755` → `0755`. */
const octal = (m: number): string => `0${m.toString(8).padStart(3, "0")}`;

/**
 * The mode a byte-identical file should have, or `null` to leave it alone.
 * `null` whenever the file already carries every execute bit the archive
 * grants to a class that can read it, which includes a file whose mode already
 * equals `importFileMode(archiveMode)`.
 */
export function reconcileExistingMode(
  cur: number,
  archiveMode?: number
): number | null {
  const n = cur & 0o755;
  const add = importFileMode(archiveMode) & 0o111 & ((n & 0o444) >> 2);
  if ((cur & add) === add) return null;
  return n | add;
}

interface PlannedFix extends ModeCorrection {
  ino: number;
  dev: number;
}

/** Decide one item from `lstat` alone. Read-only. */
async function planOne(
  item: ModeReconcileItem,
  ops: ModeReconcileOps
): Promise<{ fix?: PlannedFix; skip?: ModeSkip }> {
  const { destPath } = item;
  let st: Stats;
  try {
    st = await ops.lstat(destPath);
  } catch {
    return { skip: { destPath, reason: "unreadable" } };
  }
  if (st.isSymbolicLink()) {
    const target = await ops.stat(destPath).catch(() => null);
    const warranted =
      target?.isFile() === true &&
      reconcileExistingMode(target.mode, item.mode) !== null;
    return warranted ? { skip: { destPath, reason: "symlink" } } : {};
  }
  if (!st.isFile()) return { skip: { destPath, reason: "not-a-file" } };
  const to = reconcileExistingMode(st.mode, item.mode);
  if (to === null) return {};
  const uid = ops.uid();
  if (uid !== undefined && uid !== 0 && st.uid !== uid) {
    return { skip: { destPath, reason: "not-owner" } };
  }
  return {
    fix: { destPath, from: st.mode & 0o7777, to, ino: st.ino, dev: st.dev },
  };
}

/**
 * Plan-time preview over the plan's `exists` items. Read-only. The commit
 * applies only these fixes ({@link reconcileExistingModes}).
 */
export async function previewModeReconcile(
  files: readonly ModeReconcileItem[],
  conflicts: readonly Conflict[],
  ops: ModeReconcileOps = DEFAULT_OPS
): Promise<ModeReconcilePreview> {
  const exists = new Set(
    conflicts.filter(c => c.kind === "exists").map(c => c.destPath)
  );
  const preview: ModeReconcilePreview = { fixes: [], skipped: [] };
  const seen = new Set<string>();
  for (const item of files) {
    if (!exists.has(item.destPath) || seen.has(item.destPath)) continue;
    seen.add(item.destPath);
    const { fix, skip } = await planOne(item, ops);
    if (fix) {
      const { destPath, from, to } = fix;
      preview.fixes.push({ destPath, from, to, kind: item.kind });
    }
    if (skip) preview.skipped.push({ ...skip, kind: item.kind });
  }
  return preview;
}

/**
 * #4177 (L2): the `keepModes` paths that are not one of the plan's File-modes
 * rows (`preview.fixes`). `keepModes` is an opt-OUT list, so an unmatched path
 * would let the chmod the caller meant to prevent go ahead; the commit route
 * refuses them. A skipped row is not a fix row (it offers no Keep).
 */
export function unknownKeepModes(
  preview: ModeReconcilePreview,
  keepModes: readonly string[]
): string[] {
  const rows = new Set(preview.fixes.map(f => f.destPath));
  return keepModes.filter(p => !rows.has(p));
}

/**
 * Re-check one planned fix through an `O_NOFOLLOW` descriptor and chmod it.
 * Returns `null` once applied (recorded in `applied` right after the chmod),
 * or the reason it was skipped. A failed chmod throws, so the commit rolls back.
 */
async function applyOne(
  fix: PlannedFix,
  incomingHash: string,
  applied: AppliedModeFix[]
): Promise<ModeSkipReason | null> {
  let fh: FileHandle;
  try {
    fh = await open(fix.destPath, OPEN_FLAGS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ELOOP" || code === "ENOENT" || code === "ENOTDIR"
      ? "changed"
      : "unreadable";
  }
  try {
    let content: Buffer;
    let s: Stats;
    try {
      s = await fh.stat();
      if (!s.isFile()) return "changed";
      content = await fh.readFile();
    } catch {
      return "unreadable";
    }
    if (
      s.ino !== fix.ino ||
      s.dev !== fix.dev ||
      (s.mode & 0o7777) !== fix.from ||
      hashContent(content) !== incomingHash
    ) {
      return "changed";
    }
    try {
      await fh.chmod(fix.to);
    } catch (err) {
      // A FileHandle error carries no path (`EPERM … fchmod`): name the file so
      // the rollback message says which row to keep.
      throw new Error(
        `Could not give ${fix.destPath} the archive's execute bit ` +
          `(${octal(fix.from)} → ${octal(fix.to)}): ${(err as Error).message}. ` +
          `Tick "Keep" for this file under File modes to import without changing it.`,
        { cause: err }
      );
    }
    applied.push({
      destPath: fix.destPath,
      from: fix.from,
      ino: fix.ino,
      dev: fix.dev,
    });
    return null;
  } finally {
    // #4177 (L3): a rejected close() must not replace the error in flight (the
    // named chmod error) or turn a `changed`/`unreadable` return into an abort.
    // The fd is released either way — the same pattern as restoreModes below.
    await fh.close().catch(() => {});
  }
}

/**
 * Restore the archive's execute bits on the commit's `exists` items, applying
 * ONLY `previewed` fixes: the commit decides again from a fresh `lstat` and
 * skips the file as `changed` unless that decision equals the previewed
 * `from` → `to` (a change needed now but never previewed is `changed` too).
 * Each applied chmod is pushed onto `applied` (owned by the caller, so a later
 * failure can undo it with {@link restoreModes}).
 */
export async function reconcileExistingModes(
  items: readonly ModeReconcileItem[],
  previewed: readonly ModeCorrection[],
  applied: AppliedModeFix[],
  ops: ModeReconcileOps = DEFAULT_OPS
): Promise<{ corrected: ModeCorrection[]; skipped: ModeSkip[] }> {
  const previewedByPath = new Map(previewed.map(f => [f.destPath, f]));
  const corrected: ModeCorrection[] = [];
  const skipped: ModeSkip[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const { destPath } = item;
    if (seen.has(destPath)) continue;
    seen.add(destPath);
    const { fix, skip } = await planOne(item, ops);
    if (skip) {
      skipped.push(skip);
      continue;
    }
    const prev = previewedByPath.get(destPath);
    if (!fix && !prev) continue; // nothing needed, nothing previewed
    if (!fix || !prev || fix.from !== prev.from || fix.to !== prev.to) {
      skipped.push({ destPath, reason: "changed" });
      continue;
    }
    const reason = await applyOne(fix, item.incomingHash, applied);
    if (reason) {
      skipped.push({ destPath: fix.destPath, reason });
    } else {
      corrected.push({ destPath: fix.destPath, from: fix.from, to: fix.to });
    }
  }
  return { corrected, skipped };
}

/**
 * Undo applied chmods, newest first. A file that was since removed, replaced
 * (different inode or device) or turned into a symlink has nothing of ours
 * left to undo. Returns the paths whose mode could not be restored, each with
 * its cause (#3022), so the caller reports a PARTIAL rollback (#2563).
 */
export async function restoreModes(
  applied: readonly AppliedModeFix[]
): Promise<RestoreFailure[]> {
  const failed: RestoreFailure[] = [];
  for (const a of [...applied].reverse()) {
    let fh: FileHandle;
    try {
      fh = await open(a.destPath, OPEN_FLAGS);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ELOOP") {
        failed.push({ path: a.destPath, cause: restoreCause(err) });
      }
      continue;
    }
    try {
      const s = await fh.stat();
      if (s.isFile() && s.ino === a.ino && s.dev === a.dev) {
        await fh.chmod(a.from);
      }
    } catch (err) {
      failed.push({ path: a.destPath, cause: restoreCause(err) });
    } finally {
      await fh.close().catch(() => {});
    }
  }
  return failed;
}
