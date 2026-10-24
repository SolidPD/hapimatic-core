// SPDX-License-Identifier: AGPL-3.0-only
/* Extracted from importArchive.ts (#2077 max-lines). */
/**
 * Commit-side filesystem primitives for the Configuration Porter import — split
 * out of `importArchive.ts` (#3553, #2077 max-lines): the atomic dest-dir write,
 * the R6 rollback restore, their record/DI-seam types, `importFileMode` (whose
 * result the commit loop passes to `atomicWriteFile`), and `settingsWriteMode`
 * (the settings.json merge write's mode, #4130; `writeMergedSettings` uses it
 * for a regular file or an outside-root link, #4281). `importArchive.ts`
 * newly exports `RestoreFileOps` (module-private before the split) so the type
 * of the `CommitImportOptions.restoreFileOps` seam is nameable from there.
 *
 * #4146 adds the symlink handling: a link-aware backup + restore (a path that was
 * a symlink comes back as the same link), and the `settings.json` link rule —
 * classify the link, refuse an unacknowledged out-of-root / dangling / looping /
 * non-regular one before any write, and write an in-root one THROUGH the link.
 */
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  SymlinkedSettingsError,
  type SymlinkedSettingsReason,
} from "./importArchiveErrors";
import type { SettingsLinkState } from "@hapi/protocol/porter";

/**
 * The fs ops {@link restoreBackups} uses to undo a partial commit — a test-only
 * DI seam (#2563). Defaults to real `node:fs/promises`, so prod is byte-identical.
 * The symlink ops (#4146) are optional, so a `{ copyFile, rm }` seam still fits.
 */
export interface RestoreFileOps {
  copyFile: typeof copyFile;
  rm: typeof rm;
  lstat?: typeof lstat;
  readlink?: typeof readlink;
  symlink?: typeof symlink;
  unlink?: typeof unlink;
}

export interface BackupRecord {
  origPath: string;
  backupPath: string;
  existed: boolean;
  /**
   * #4146: the path was a symlink; `target` is its `readlink` string.
   * `realTarget` is the file a write-through wrote (set with `writtenThrough`).
   */
  link?: { target: string; realTarget?: string };
  /**
   * #4146 (K7): the commit wrote or created the path ITSELF. `false` = never
   * written, so the rollback leaves it alone; `undefined` = unknown, restored.
   */
  touched?: boolean;
  /**
   * #4146 (K7): an `atomicWriteFile(realTarget)` completed for this `settings.json`
   * link (the in-root write-through) — the only case the rollback writes a
   * link's target.
   */
  writtenThrough?: boolean;
}

/** Whether `p` resolves (following links) to a regular file. Never throws. */
export async function isRegularFile(p: string): Promise<boolean> {
  return stat(p).then(
    s => s.isFile(),
    () => false
  );
}

/**
 * Back up `origPath` to `backupPath` before the commit touches it (#4146; was
 * `runCommit`'s `backupOf`). `lstat`, not `existsSync`: a dangling or looping
 * link is a present path whose link must come back on rollback, not an absent
 * one to delete. A link records its `readlink` string, plus its target's bytes
 * when the target is a regular file (so a write-through can be undone). Any
 * other `lstat` failure is recorded as absent, as `existsSync` reported it.
 */
export async function captureBackup(
  origPath: string,
  backupPath: string
): Promise<BackupRecord> {
  const rec: BackupRecord = {
    origPath,
    backupPath,
    existed: false,
    touched: false,
  };
  const st = await lstat(origPath).catch(() => null);
  if (!st) return rec;
  rec.existed = true;
  if (st.isSymbolicLink()) {
    rec.link = { target: await readlink(origPath) };
    if (await isRegularFile(origPath)) await copyFile(origPath, backupPath);
  } else {
    await copyFile(origPath, backupPath);
  }
  return rec;
}

/** #4146: record whether the commit wrote each of `paths` (see {@link BackupRecord.touched}). */
export function markTouched(
  backups: BackupRecord[],
  paths: readonly string[],
  touched = true
): void {
  for (const b of backups) if (paths.includes(b.origPath)) b.touched = touched;
}

/**
 * #4146: the MCP merge's `.claude.json` records are marked touched BEFORE
 * `importMcpServers` runs, because a throw part-way through (an account merge
 * after the host was written) returns no result to learn from. After a
 * successful return, only the files it actually wrote (`imported.length > 0`;
 * it writes nothing otherwise) stay touched.
 */
export function settleMcpTouched(
  backups: BackupRecord[],
  paths: readonly string[],
  mcp: {
    host: { configPath: string; imported: readonly string[] };
    perAccount: { configPath: string; imported: readonly string[] }[];
  }
): void {
  const wrote = [mcp.host, ...mcp.perAccount]
    .filter(r => r.imported.length > 0)
    .map(r => r.configPath);
  for (const p of paths) markTouched(backups, [p], wrote.includes(p));
}

/** What the `settings.json` link resolves to (#4146); see {@link classifySettingsLink}.
 * One shared source with the web (#4288), re-exported for existing importers. */
export type { SettingsLinkState };

export interface SettingsLink {
  /** The link's `readlink` string — echoed by the 409 and matched by the acknowledge. */
  target: string;
  state: SettingsLinkState;
  /** The resolved target; set only for `inside`. */
  realTarget?: string;
}

/**
 * Classify `<root>/settings.json` when it is a symlink (#4146); `undefined` when
 * it is not one (absent, or a regular file). `inside` = it resolves to a regular
 * file inside `realpath(root)` (the same `=== || startsWith(root + sep)` rule as
 * `assertContained`, on resolved paths); `outside` = a regular file elsewhere;
 * `dangling` = it does not resolve (ENOENT, or an unreadable path component);
 * `loop` = ELOOP; `not-regular` = it resolves to a directory, FIFO, device, ….
 */
export async function classifySettingsLink(
  root: string,
  settingsPath: string
): Promise<SettingsLink | undefined> {
  let target: string;
  try {
    if (!(await lstat(settingsPath)).isSymbolicLink()) return undefined;
    target = await readlink(settingsPath);
  } catch {
    return undefined;
  }
  let realTarget: string;
  try {
    realTarget = await realpath(settingsPath);
  } catch (err) {
    const loop = (err as NodeJS.ErrnoException).code === "ELOOP";
    return { target, state: loop ? "loop" : "dangling" };
  }
  if (!(await isRegularFile(realTarget))) {
    return { target, state: "not-regular" };
  }
  const realRoot = await realpath(root).catch(() => null);
  const inside =
    realRoot !== null &&
    (realTarget === realRoot || realTarget.startsWith(realRoot + sep));
  return inside
    ? { target, state: "inside", realTarget }
    : { target, state: "outside" };
}

/**
 * #4146 (D14): the commit's pre-write refusal. A `settings.json` link that the
 * merge cannot write through (anything but `inside`) throws
 * {@link SymlinkedSettingsError} unless `acknowledged` equals the link's
 * current `readlink` string — the value the 409 echoed. Callers run this BEFORE
 * `runCommit`'s try, which would flatten a typed error to a 500. Returns the
 * classification the write must still match ({@link writeMergedSettings}).
 */
export async function checkSettingsLink(
  root: string,
  settingsPath: string,
  acknowledged: string | undefined
): Promise<SettingsLink | undefined> {
  const link = await classifySettingsLink(root, settingsPath);
  if (link && link.state !== "inside" && link.target !== acknowledged) {
    const reason: SymlinkedSettingsReason =
      link.state === "outside" ? "outside-root" : link.state;
    throw new SymlinkedSettingsError(settingsPath, link.target, reason);
  }
  return link;
}

/**
 * The settings merge's write (#4146). It first re-classifies the path. If a link
 * was added, removed or re-pointed since {@link checkSettingsLink} ran, it
 * throws, so runCommit's rollback runs and the link is never replaced
 * unacknowledged. An `inside` link is written THROUGH: tmp + rename in the
 * target's own directory, leaving the link untouched. `record` is then marked
 * `writtenThrough` (K7). Anything else is written at `settingsPath` as before
 * (an acknowledged link is replaced), with `record` marked `touched` first.
 * `write` is a test-only seam.
 */
export async function writeMergedSettings(
  root: string,
  settingsPath: string,
  content: Buffer,
  expected: SettingsLink | undefined,
  record: BackupRecord | undefined,
  write: typeof atomicWriteFile = atomicWriteFile
): Promise<void> {
  // Compare against what the check saw (and the operator acknowledged):
  //  - no link then → still none;
  //  - an in-root link → still resolving to the same file (the write target);
  //  - an acknowledged link → still that link (same `readlink`). Where it
  //    resolves now does not matter, because it is replaced, never written
  //    through. So a dangling link whose target the commit just created (a file
  //    item) is still replaced as acknowledged — and at 0o600, because its mode
  //    comes from the check-time state below, not from that created file (#4281).
  const now = await classifySettingsLink(root, settingsPath);
  const unchanged = !expected
    ? now === undefined
    : expected.state === "inside"
      ? now?.state === "inside" && now.realTarget === expected.realTarget
      : now !== undefined && now.target === expected.target;
  if (!unchanged) {
    throw new Error(
      `${settingsPath} changed during the import (a symlink was added, ` +
        `removed or re-pointed), so it was not written`
    );
  }
  if (expected?.state === "inside" && expected.realTarget) {
    await write(
      expected.realTarget,
      content,
      await settingsWriteMode(expected.realTarget)
    );
    if (record) {
      record.writtenThrough = true;
      record.link = {
        target: expected.target,
        realTarget: expected.realTarget,
      };
    }
    return;
  }
  if (record) record.touched = true;
  // #4281 (O1 = B): a link that was dangling, looping or not a regular file when
  // checked commits at 0o600; only an outside-root regular target keeps its mode.
  const mode =
    expected && expected.state !== "outside"
      ? SETTINGS_CREATE_MODE
      : await settingsWriteMode(settingsPath);
  await write(settingsPath, content, mode);
}

/**
 * The POSIX mode an imported file is committed with (#3553 R3): the archive is
 * untrusted, so only `& 0o755` is honoured — the exec bit is carried, group/other
 * write and setuid/setgid/sticky never are. `| 0o600` is an owner floor: the
 * owner can always read and write the committed file, so a read-only (0o444) or
 * bit-less (0o7000 → 0) archive mode can never block the R6 rollback's restore
 * copy or a later import's conflict hash. A missing mode defaults to 0o644 (the
 * tar reader maps a raw zero mode to `undefined`, tarArchive.ts:257).
 */
export function importFileMode(m?: number): number {
  return ((m ?? 0o644) & 0o755) | 0o600;
}

/** The mode a `settings.json` the merge CREATES is committed with (#4130 D2). */
const SETTINGS_CREATE_MODE = 0o600;

/**
 * The mode the `settings.json` merge write commits with (#4130). The merge
 * rewrites the file via tmp + rename — a NEW inode — so without an explicit
 * mode a 0600 file silently lands at the umask default (0644 under umask 022).
 *
 *  - Existing file: its current mode, read with `stat`, which FOLLOWS a
 *    symlink, so a linked `settings.json` uses its target's mode. That target
 *    is the file `readJsonObjectStrict` merged; `lstat` would read the link's
 *    own 0o777. The mode then goes through {@link importFileMode}: group/other
 *    write and special bits are dropped (a group/other-writable settings.json
 *    lets another local account register a hook that runs as the owner), and
 *    the owner floor keeps the file owner-writable, so the R6 rollback's
 *    `copyFile` can restore over it (a 0o400 file fails that copy with EACCES).
 *    Reusing the archive mask here is deliberate (#4130 D1): the same owner
 *    floor is what keeps the rollback copy writable.
 *  - No prior file (ENOENT) or a mode that cannot be read (ELOOP, EACCES,
 *    EIO): 0o600 — the file can hold `env` tokens and `apiKeyHelper`, so an
 *    unknown prior mode fails closed (#4130 D3).
 *  - A path that is not a regular file (a directory or FIFO): 0o600 as well. It
 *    has no settings-file mode to keep, and a directory's 0o755 would commit
 *    the file group/other-readable and executable.
 *
 * `writeMergedSettings` calls this only for a `settings.json` with no link, or
 * one linked to a regular file outside the root when checked. A link that was
 * dangling, looping or not a regular file when checked is committed at 0o600
 * without calling this, whatever it resolves to at write time, since a file
 * item of the same import may have created its target (#4281).
 */
export async function settingsWriteMode(settingsPath: string): Promise<number> {
  try {
    const st = await stat(settingsPath);
    return st.isFile() ? importFileMode(st.mode) : SETTINGS_CREATE_MODE;
  } catch {
    return SETTINGS_CREATE_MODE;
  }
}

/**
 * Atomic write via a dest-dir tmp file + rename (same-filesystem by construction).
 * With `mode`, the TMP file is chmod'ed before the rename (#3553) — umask-
 * independent, and the live path never exists in an intermediate mode. Without
 * `mode` no chmod runs and the umask default applies — every commit write passes
 * one: file items `importFileMode`, the settings.json merge the mode
 * `writeMergedSettings` chooses (`settingsWriteMode`, or 0o600 for an
 * acknowledged link that was not a regular file when checked; #4130, #4281). With `mode`, the tmp file is also CREATED owner-only (0o600) before
 * that chmod (#4130), so secret-bearing content (settings.json `env` tokens,
 * `apiKeyHelper`) is never briefly group/other-readable at the umask default —
 * the same create-owner-only convention as mcpImport's tmp write.
 */
export async function atomicWriteFile(
  destPath: string,
  content: Buffer,
  mode?: number
): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  const tmp = join(
    dirname(destPath),
    `.porter-tmp.${process.pid}.${randomUUID()}`
  );
  await writeFile(
    tmp,
    content,
    mode !== undefined ? { mode: 0o600 } : undefined
  );
  if (mode !== undefined) await chmod(tmp, mode);
  await rename(tmp, destPath);
}

/**
 * Restore destinations from a backup set (R6 rollback). Returns the paths that
 * FAILED to restore (#2563) — empty on a clean rollback. Restore is reverse,
 * best-effort continue; failures are COLLECTED so the caller reports an honest
 * PARTIAL rollback. `ops` is a test-only DI seam.
 *
 * #4146: a path the commit never wrote (`touched: false`, not `writtenThrough`)
 * is skipped — rewriting it would copy through an intact link, possibly to a
 * file outside the config root. A symlink record is restored by
 * {@link restoreLink}, as the link itself.
 */
export async function restoreBackups(
  backups: BackupRecord[],
  ops: RestoreFileOps = { copyFile, rm }
): Promise<string[]> {
  // Restore in LIFO order. Only files are restored or removed — parent
  // directories the commit created (atomicWriteFile's mkdir -p) are left in place.
  const failed: string[] = [];
  for (const b of [...backups].reverse()) {
    if (b.touched === false && !b.writtenThrough) continue;
    try {
      if (b.link) {
        if (!(await restoreLink(b, b.link.target, ops)))
          failed.push(b.origPath);
      } else if (b.existed) {
        await ops.copyFile(b.backupPath, b.origPath);
      } else if (existsSync(b.origPath)) {
        await ops.rm(b.origPath, { force: true });
      }
    } catch {
      // Best-effort restore — continue restoring the rest, but RECORD the failed
      // destination so the caller reports a PARTIAL rollback (#2563, R1/R4).
      failed.push(b.origPath);
    }
  }
  return failed;
}

/**
 * Put a symlink record back (#4146). Returns `false` when it cannot be restored
 * honestly (the caller reports the path as a PARTIAL rollback).
 *
 *  - The path is still the same link. Not written through: nothing to undo.
 *    Written through: restore the bytes + mode of the file it wrote
 *    (`copyFile` carries the backup's mode), but only if the link still
 *    resolves to that file; if it now resolves elsewhere, report the path.
 *  - The commit replaced the link (`touched`): remove what it wrote and re-create
 *    the link. The backup is NEVER copied through the re-created link — the
 *    target (possibly outside the root) was never written by the commit.
 *  - Anything else is left alone and reported: a write-through whose link has
 *    since changed (`restoreBackups` skips an untouched record that was not
 *    written through), or another link now at the path — something other than
 *    the commit re-pointed it, and restoring would clobber that change.
 */
async function restoreLink(
  b: BackupRecord,
  target: string,
  ops: RestoreFileOps
): Promise<boolean> {
  const cur = await (ops.lstat ?? lstat)(b.origPath).catch(() => null);
  const sameLink =
    cur?.isSymbolicLink() &&
    (await (ops.readlink ?? readlink)(b.origPath)) === target;
  if (sameLink) {
    if (!b.writtenThrough) return true;
    // Undo the write-through at the file it wrote, and only if the link still
    // resolves there: the same `readlink` text can resolve elsewhere once an
    // intermediate directory is re-pointed, and the copy must not follow it.
    const real = await realpath(b.origPath).catch(() => null);
    if (!b.link?.realTarget || real !== b.link.realTarget) return false;
    await ops.copyFile(b.backupPath, real);
    return true;
  }
  if (b.touched === false || cur?.isSymbolicLink()) return false;
  if (cur) await (ops.unlink ?? unlink)(b.origPath);
  await (ops.symlink ?? symlink)(target, b.origPath);
  return true;
}
