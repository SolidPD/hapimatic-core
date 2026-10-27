// SPDX-License-Identifier: AGPL-3.0-only
/* Extracted from importArchive.ts (#2077 max-lines). */
/**
 * Commit-side filesystem primitives for the Configuration Porter import — split
 * out of `importArchive.ts` (#3553, #2077 max-lines): the atomic dest-dir write,
 * the R6 rollback restore, their record/DI-seam types, `importFileMode` (whose
 * result the commit loop passes to `atomicWriteFile`), and `settingsWriteMode`
 * (the settings.json merge write's mode, #4130; `writeMergedSettings` uses it
 * for a regular file, an in-root link's target, or an outside-root link,
 * #4281). `importArchive.ts`
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
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  SymlinkedSettingsError,
  type SymlinkedSettingsReason,
} from "./importArchiveErrors";
import { readDestination } from "./regularFile";
import type { Omission, SettingsLinkState } from "@hapi/protocol/porter";

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

/**
 * #3022 (F2): one path the R6 rollback could not restore, and why. Returned by
 * {@link restoreBackups} and `restoreModes` (./modeReconcile), so `runCommit`'s
 * PARTIAL message names the cause of each failure, not only the path.
 */
export interface RestoreFailure {
  path: string;
  cause: string;
}

/**
 * #3022 (F2): the cause text for a restore failure — the errno code and the
 * syscall ("ENOSPC on copyfile"), which tells EACCES, ENOSPC and a missing
 * backup apart. Not the fs message: it repeats the destination and adds the
 * backup path, whose staging handle stays committable after a rolled-back
 * commit, to the HTTP body and Sentry. A code-less error is an internal one
 * (the test seam), so its message is used. #5787: also the cause part of the
 * original failure's text ({@link commitFailureText}, after any destination)
 * and the replacement for its message in its stack
 * ({@link commitFailureStack}).
 */
export function restoreCause(err: unknown): string {
  if (hasErrnoCode(err)) {
    return err.syscall ? `${err.code} on ${err.syscall}` : err.code;
  }
  return err instanceof Error ? err.message : "unknown error";
}

/** The name prefix of {@link atomicWriteFile}'s tmp file (#5787 reads it back). */
const PORTER_TMP_PREFIX = ".porter-tmp.";

/** Whether `err` carries a string `code` (an fs or Node error), the rule {@link restoreCause} keys on. */
function hasErrnoCode(
  err: unknown
): err is NodeJS.ErrnoException & { code: string } {
  return typeof (err as NodeJS.ErrnoException | null)?.code === "string";
}

/** #5787: what {@link commitFailureText} reads from the import plan. */
export interface CommitFailurePlan {
  dataDir: string;
  stagingHandle: string;
  files: readonly { stagedPath: string; destPath: string }[];
}

/**
 * #5787: the data-dir subtrees that hold staging handles; no commit-failure
 * text names a path in them ({@link isPorterInternalPath}).
 */
const PORTER_INTERNAL_DIRS = ["porter-backup", "porter-staging"] as const;

/**
 * #5787: the text a failed commit reports for its original failure — the
 * rollback messages, and the commit route's body and log. An error with a
 * `code` is rendered as {@link restoreCause}, never its fs message: Bun's
 * message names the path of the failed call (both paths, for a `rename`), so
 * a failed backup write names `porter-backup/<handle>/N` and a failed staged
 * read names `porter-staging/<handle>/…`, and the handle stays committable
 * after a rolled-back commit (clean or PARTIAL). The failure's path is named
 * as {@link failedDestination} resolves it. A code-less error is a
 * porter-raised Error whose text names no backup or staging path (a
 * destination, a server or key name, or a fixed reason such as #5676's
 * `is not valid JSON`), so its message is kept.
 */
export function commitFailureText(
  err: unknown,
  plan: CommitFailurePlan
): string {
  if (!hasErrnoCode(err)) {
    return err instanceof Error ? err.message : String(err);
  }
  const cause = restoreCause(err);
  const dest = failedDestination(err, plan);
  return dest ? `${dest} (${cause})` : cause;
}

/**
 * #5787: the path a failure names, or undefined. A staged path is replaced by
 * its item's destination. {@link atomicWriteFile}'s tmp file stands for the
 * destination it replaces: the rename's target, else the tmp file's directory.
 * A path that holds the staging handle is never named (the handle is a
 * `randomUUID`, so no destination holds it), nor any path at or under
 * `<dataDir>/porter-backup` or `<dataDir>/porter-staging`: a recursive `mkdir`
 * that cannot create the backup root reports that root, without the handle.
 */
function failedDestination(
  err: NodeJS.ErrnoException & { dest?: unknown },
  plan: CommitFailurePlan
): string | undefined {
  const raw = err.path;
  if (typeof raw !== "string" || raw === "") return undefined;
  const isTmp = basename(raw).startsWith(PORTER_TMP_PREFIX);
  const tmpDest = typeof err.dest === "string" ? err.dest : dirname(raw);
  const path = isTmp ? tmpDest : raw;
  const item = plan.files.find(f => f.stagedPath === path);
  if (item) return item.destPath;
  return isPorterInternalPath(path, plan) ? undefined : path;
}

/**
 * #5787: whether `path` holds the staging handle or lies in a
 * {@link PORTER_INTERNAL_DIRS} subtree.
 */
function isPorterInternalPath(path: string, plan: CommitFailurePlan): boolean {
  if (path.includes(plan.stagingHandle)) return true;
  return PORTER_INTERNAL_DIRS.some(sub => {
    const base = join(plan.dataDir, sub);
    return path === base || path.startsWith(base + sep);
  });
}

/**
 * #5787: `err`'s stack for the commit route's log. Bun's stack begins
 * `Error: <message>`, so a failed fs call's stack names the same backup or
 * staged path its message does: for an error with a `code`, that message is
 * replaced by {@link restoreCause} and the frames are kept. Any other error's
 * stack is returned as it is.
 */
export function commitFailureStack(err: Error): string | null {
  const stack = err.stack ?? null;
  if (stack === null || !hasErrnoCode(err) || err.message === "") return stack;
  return stack.split(err.message).join(restoreCause(err));
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
 *
 * #5759: the backup never reads a FIFO, socket or device (the old `copyFile`
 * on a FIFO blocked under the import lock until a writer appeared). Bytes are
 * read through {@link readDestination}'s one checked descriptor and written
 * with the source's permission bits, as `copyFile` gave them, so the rollback's
 * `copyFile(backup → orig)` restores the mode as before. A link to a special
 * file is recorded as a link with no bytes, like any non-regular target. A
 * special file that is not a link is refused before any destination is
 * written: it has no bytes to back up, and the rollback could not recreate it.
 * The refusal's advice fits every caller: this also runs for `settings.json`,
 * `~/.claude.json` and account configs, which have no conflict to keep.
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
    if (await isRegularFile(origPath)) {
      const r = await readDestination(origPath);
      if (r.kind === "file") await writeBackupCopy(backupPath, r);
    }
    return rec;
  }
  const r = await readDestination(origPath, { nofollow: true });
  if (r.kind === "special") {
    throw new Error(
      `${origPath} is ${r.what}, not a regular file, so the import cannot ` +
        `back it up and does not replace it. Remove it or replace it with a ` +
        `regular file, then import again (for an archive file, keeping its ` +
        `conflict instead of choosing Overwrite also works).`
    );
  }
  if (r.kind === "absent") {
    throw new Error(`${origPath} changed during the import`);
  }
  await writeBackupCopy(backupPath, r);
  return rec;
}

/**
 * #5759: write a backup copy with the source's permission bits, as `copyFile`
 * does (Bun gives the new file the source's mode, setuid included). Created
 * owner-only first, so the bytes are never readable at the umask default.
 */
async function writeBackupCopy(
  backupPath: string,
  r: { content: Buffer; mode: number }
): Promise<void> {
  await writeFile(backupPath, r.content, { mode: 0o600 });
  await chmod(backupPath, r.mode);
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

/** Per check-time state: true when the check saw no regular file behind the link. */
const LINK_HAS_NO_SETTINGS_FILE: Record<SettingsLinkState, boolean> = {
  inside: false,
  outside: false,
  dangling: true,
  loop: true,
  "not-regular": true,
};

/**
 * #4281 (O1 = B), #5534: whether a `settings.json` link did not resolve to a
 * regular file (dangling, looping or not-regular) when {@link checkSettingsLink}
 * classified it. Such a link had no settings to keep, so the merge starts from an
 * empty base (`runCommit`) and the replacement commits at 0o600
 * ({@link writeMergedSettings}). The check-time state decides the empty base
 * and the 0o600 mode, not where the link resolves at write time: a file item
 * of the same import can create a dangling link's target, replace a link in
 * the chain that points at a device such as `/dev/null`, or replace a link
 * partway along a chain of more than 40 links, which `realpath` reports as a
 * loop while the file item's own path still resolves. False when there is no
 * link, so a regular `settings.json` keeps its keys. #5759: write-time
 * resolution decides one thing, a refusal. If the link now reaches a regular
 * file the import did not write (the file was created, or a later link in the
 * chain re-pointed, after the check), the write refuses rather than drop that
 * file's keys; a re-pointed `settings.json` link itself fails the `readlink`
 * re-check first.
 */
export function isLinkWithoutSettingsFile(
  link: SettingsLink | undefined
): boolean {
  return link !== undefined && LINK_HAS_NO_SETTINGS_FILE[link.state];
}

/**
 * The directory entry a write to `path` replaces: the real parent directory
 * plus the last name. `atomicWriteFile` renames into `dirname(path)`, which
 * follows directory links, so two spellings of one file give the same key.
 * `null` when the parent does not resolve.
 */
export async function direntKey(path: string): Promise<string | null> {
  try {
    return join(await realpath(dirname(path)), basename(path));
  } catch {
    return null;
  }
}

/**
 * #5760: the directory entries `settings.json` resolves through when
 * {@link checkSettingsLink} saw an `inside` or `outside` link: each link in
 * the chain and the regular file it ends at, as {@link direntKey} keys. A file
 * item written at one of them would replace the settings the merge reads, so
 * `runCommit` holds it. Empty for no link, and for a dangling, looping or
 * not-regular link, whose merge already starts from an empty base (#5534). A
 * file item cannot target a link to a directory: the plan's conflict read
 * stops on EISDIR. A walk that fails partway keeps what it collected.
 */
export async function settingsResolutionEntries(
  settingsPath: string,
  link: SettingsLink | undefined
): Promise<Set<string>> {
  const keys = new Set<string>();
  if (link?.state !== "inside" && link?.state !== "outside") return keys;
  // The file the chain ends at, as the kernel resolves it: held even if the
  // walk below stops early.
  const real = await realpath(settingsPath).catch(() => null);
  if (real !== null) keys.add(real);
  let cur = settingsPath;
  // realpath succeeded at the check, so the chain is at most 40 links long.
  for (let hop = 0; hop <= 40; hop++) {
    const key = await direntKey(cur);
    if (key === null) break;
    keys.add(key);
    try {
      if (!(await lstat(cur)).isSymbolicLink()) break;
      // A relative target is resolved from the real directory holding the
      // link, so join it to that directory as text and let the next
      // direntKey resolve it: path.resolve would collapse a ".." before
      // following a directory link, and the kernel does not (#5760 R1).
      const target = await readlink(cur);
      cur = isAbsolute(target) ? target : `${dirname(key)}${sep}${target}`;
    } catch {
      break;
    }
  }
  return keys;
}

/** #5760: the result notice for a file item held by {@link onSettingsResolution}. */
export function settingsResolutionNotice(
  root: string,
  destPath: string
): Omission {
  return {
    surface: `file ${relative(root, destPath)}`,
    reason:
      "not imported: settings.json resolves through this path, so writing it " +
      "would have replaced your settings; your settings were kept as the merge base",
  };
}

/** #5760: the `destPaths` whose directory entry is on that chain (see above). */
export async function onSettingsResolution(
  settingsPath: string,
  link: SettingsLink | undefined,
  destPaths: readonly string[]
): Promise<Set<string>> {
  const held = new Set<string>();
  const chain = await settingsResolutionEntries(settingsPath, link);
  if (chain.size === 0) return held;
  for (const p of destPaths) {
    const key = await direntKey(p);
    if (key !== null && chain.has(key)) held.add(p);
  }
  return held;
}

/**
 * #5759: whether `settingsPath` resolves (following links) to a regular file
 * that is none of `writtenPaths`, compared by device and inode so any spelling
 * of the same file matches. False when it does not resolve or is not a regular
 * file: there are no settings to lose.
 */
async function reachesUnwrittenFile(
  settingsPath: string,
  writtenPaths: readonly string[]
): Promise<boolean> {
  const st = await stat(settingsPath).catch(() => null);
  if (!st?.isFile()) return false;
  for (const p of writtenPaths) {
    const w = await stat(p).catch(() => null);
    if (w && w.dev === st.dev && w.ino === st.ino) return false;
  }
  return true;
}

/**
 * The settings merge's write (#4146). It first re-classifies the path. If a link
 * was added, removed or re-pointed since {@link checkSettingsLink} ran, it
 * throws, so runCommit's rollback runs and the link is never replaced
 * unacknowledged. An `inside` link is written THROUGH: tmp + rename in the
 * target's own directory, leaving the link untouched. `record` is then marked
 * `writtenThrough` (K7). Anything else is written at `settingsPath` as before
 * (an acknowledged link is replaced), with `record` marked `touched` first.
 * #5759: a link the check saw with no settings file behind it is refused if it
 * now reaches a regular file that is none of `writtenPaths` (the file items
 * this import wrote). `write` is a test-only seam.
 */
export async function writeMergedSettings(
  root: string,
  settingsPath: string,
  content: Buffer,
  expected: SettingsLink | undefined,
  record: BackupRecord | undefined,
  writtenPaths: readonly string[],
  write: typeof atomicWriteFile = atomicWriteFile
): Promise<void> {
  // Compare against what the check saw (and the operator acknowledged):
  //  - no link then → still none;
  //  - an in-root link → still resolving to the same file (the write target);
  //  - an acknowledged link → still that link (same `readlink`). Where it
  //    resolves now does not matter to this comparison, because it is
  //    replaced, never written through (only the #5759 guard below looks at
  //    where it resolves now). So a dangling link whose target the commit just
  //    created (a file item), or a looping chain a file item shortened, is
  //    still replaced as acknowledged — and at 0o600, because its mode comes
  //    from the check-time state below, not from the file it now reaches
  //    (#4281, #5534).
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
  // #5759: the check saw no settings file behind the link, so the merge started
  // from an empty base. If the link now reaches a regular file that this import
  // did not write, something created that file or re-pointed a later link in
  // the chain after the check (for example another writer's delete-then-write
  // save), and replacing the link would drop that file's keys. A file a file
  // item of this import wrote (#5534) is still replaced as acknowledged.
  if (
    isLinkWithoutSettingsFile(expected) &&
    (await reachesUnwrittenFile(settingsPath, writtenPaths))
  ) {
    throw new Error(
      `${settingsPath} changed during the import (its link now reaches a ` +
        `settings file this import did not write), so it was not written`
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
  // #4281 (O1 = B), #5534: a link that was dangling, looping or not a regular file
  // when checked commits at 0o600; an outside-root regular target keeps its mode.
  // An `inside` link never gets here: it is written through above, or (without
  // `realTarget`) the re-check throws first.
  const mode = isLinkWithoutSettingsFile(expected)
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
 * `writeMergedSettings` calls this for a `settings.json` with no link, for the
 * file an in-root link points at (the write-through), and for a link to a
 * regular file outside the root when checked. A link that did not resolve to a
 * regular file when checked ({@link isLinkWithoutSettingsFile}) is committed at
 * 0o600 without calling this, whatever it resolves to at write time, since a
 * file item of the same import may have created its target or replaced a link
 * in its chain (#4281, #5534).
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
 * acknowledged link that did not resolve to a regular file when checked; #4130,
 * #4281, #5534). With `mode`, the tmp file is also CREATED owner-only (0o600) before
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
    `${PORTER_TMP_PREFIX}${process.pid}.${randomUUID()}`
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
 * FAILED to restore (#2563), each with its cause (#3022) — empty on a clean
 * rollback. Restore is reverse, best-effort continue; failures are COLLECTED so
 * the caller reports an honest PARTIAL rollback. `ops` is a test-only DI seam.
 *
 * #4146: a path the commit never wrote (`touched: false`, not `writtenThrough`)
 * is skipped — rewriting it would copy through an intact link, possibly to a
 * file outside the config root. A symlink record is restored by
 * {@link restoreLink}, as the link itself.
 */
export async function restoreBackups(
  backups: BackupRecord[],
  ops: RestoreFileOps = { copyFile, rm }
): Promise<RestoreFailure[]> {
  // Restore in LIFO order. Only files are restored or removed — parent
  // directories the commit created (atomicWriteFile's mkdir -p) are left in place.
  const failed: RestoreFailure[] = [];
  for (const b of [...backups].reverse()) {
    if (b.touched === false && !b.writtenThrough) continue;
    try {
      if (b.link) {
        const refused = await restoreLink(b, b.link.target, ops);
        if (refused !== null) failed.push({ path: b.origPath, cause: refused });
      } else if (b.existed) {
        await ops.copyFile(b.backupPath, b.origPath);
      } else if (existsSync(b.origPath)) {
        await ops.rm(b.origPath, { force: true });
      }
    } catch (err) {
      // Best-effort restore — continue restoring the rest, but RECORD the failed
      // destination and its cause so the caller reports a PARTIAL rollback
      // (#2563, R1/R4; #3022).
      failed.push({ path: b.origPath, cause: restoreCause(err) });
    }
  }
  return failed;
}

/**
 * #3022 (F2): why {@link restoreLink} left a link as found. Fixed text — never
 * the `readlink` target.
 */
export const LINK_NOW_RESOLVES_ELSEWHERE =
  "not restored: the link no longer resolves to the file the import wrote";
export const LINK_CHANGED_AFTER_IMPORT =
  "not restored: the link at this path changed after the import, so it was left as found";

/**
 * Put a symlink record back (#4146). Returns `null` when restored (or nothing
 * to undo), or the reason it cannot be restored honestly (the caller reports
 * the path as a PARTIAL rollback with that reason, #3022).
 *
 *  - The path is still the same link. Not written through: nothing to undo.
 *    Written through: restore the bytes + mode of the file it wrote
 *    (`copyFile` carries the backup's mode), but only if the link still
 *    resolves to that file; if it no longer resolves there (re-pointed or
 *    dangling), report the path.
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
): Promise<
  typeof LINK_NOW_RESOLVES_ELSEWHERE | typeof LINK_CHANGED_AFTER_IMPORT | null
> {
  const cur = await (ops.lstat ?? lstat)(b.origPath).catch(() => null);
  const sameLink =
    cur?.isSymbolicLink() &&
    (await (ops.readlink ?? readlink)(b.origPath)) === target;
  if (sameLink) {
    if (!b.writtenThrough) return null;
    // Undo the write-through at the file it wrote, and only if the link still
    // resolves there: the same `readlink` text can resolve elsewhere once an
    // intermediate directory is re-pointed, and the copy must not follow it.
    const real = await realpath(b.origPath).catch(() => null);
    if (!b.link?.realTarget || real !== b.link.realTarget)
      return LINK_NOW_RESOLVES_ELSEWHERE;
    await ops.copyFile(b.backupPath, real);
    return null;
  }
  if (b.touched === false || cur?.isSymbolicLink())
    return LINK_CHANGED_AFTER_IMPORT;
  if (cur) await (ops.unlink ?? unlink)(b.origPath);
  await (ops.symlink ?? symlink)(target, b.origPath);
  return null;
}
