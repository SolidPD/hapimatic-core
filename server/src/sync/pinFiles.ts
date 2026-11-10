// SPDX-License-Identifier: AGPL-3.0-only
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, sep } from "node:path";
import {
  isPinSessionId,
  PIN_SAVE_MAX_BYTES,
  PIN_SAVE_MAX_FILES,
  pinFolderName,
  pinFolderPath,
  PinKeySchema,
  pinSavedPath,
} from "@hapi/protocol";

// The file work behind pin files (issue #6453, epic #6446): the folder an agent
// writes a pin's pages into, its removal when the session is deleted, and "Save to
// session folder". It runs in the server process against the session's folder
// (`metadata.path`), the way uploads write `UserFileUploads` there
// (`web/routes/upload.ts`), so it works with the daemon offline and for an ended
// session. It rests on the same assumption uploads do: a server's sessions run on
// its own machine (a federated session is proxied to its owning node).
//
// ## What it may touch
// Only `<cwd>/.hapi/pins/<sessionId>/` (create, delete) and
// `<cwd>/GeneratedFiles/pins/<folder>/` (copy into), plus creating the
// `.hapi/pins/.gitignore` marker once. `sessionId` must be the server's session
// UUID and the folder is `pinFolderName(key)`, so no agent text reaches a path
// segment unchecked.
//
// ## Links
// Every directory on the way is checked with `lstat`, and a symlink refuses: a
// symlinked `.hapi` would otherwise redirect a delete outside the session's folder
// (research fixture P6). A symlinked session folder is unlinked, never followed
// (P5), and `rm` never follows a link inside the tree (P4). Save copies regular
// files only (P7: `fs.cp` copies a link to a secret as a link). A link swapped in
// between a check and its use is accepted, as the directive's risk table records.

/** Never read or copied, wherever they appear in a path (the CLI's deny list). */
const SENSITIVE_NAMES = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".env",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".docker",
  ".bash_history",
  ".zsh_history",
]);

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAMES.has(name) || name.startsWith(".env.");
}

const GITIGNORE = "*\n";

export type PinFileRefusal = {
  ok: false;
  code:
    | "folder_missing"
    | "unsafe_path"
    | "nothing_to_save"
    | "over_limit"
    | "write_failed";
  error: string;
};

type Roots =
  | { kind: "ready"; cwd: string; hapi: boolean; pins: boolean }
  | { kind: "absent" }
  | { kind: "refused"; error: string };

function errorCode(error: unknown): string | undefined {
  return (error as { code?: unknown } | null)?.code as string | undefined;
}

/** `lstat`, or null when nothing is there. Other errors throw. */
async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

/**
 * The session's real folder and the state of `.hapi` and `.hapi/pins` in it.
 * Refuses a relative, NUL-carrying or root folder, a credential folder, a session
 * id that is not the server's UUID, and a `.hapi` or `.hapi/pins` that is a
 * symlink or not a directory. A folder that no longer exists is `absent`.
 */
export async function resolvePinRoots(
  cwd: string | null | undefined,
  sessionId: string
): Promise<Roots> {
  if (!isPinSessionId(sessionId)) {
    return { kind: "refused", error: "not a session id" };
  }
  if (typeof cwd !== "string" || cwd === "") {
    return { kind: "refused", error: "the session has no folder" };
  }
  if (cwd.includes("\0") || !isAbsolute(cwd)) {
    return {
      kind: "refused",
      error: "the session's folder is not an absolute path",
    };
  }
  let real: string;
  try {
    real = await realpath(cwd);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "absent" };
    return { kind: "refused", error: "the session's folder cannot be read" };
  }
  if (parse(real).root === real) {
    return {
      kind: "refused",
      error: "the session's folder is a filesystem root",
    };
  }
  if (real.split(sep).some(isSensitiveName)) {
    return { kind: "refused", error: "the session's folder holds credentials" };
  }
  const hapi = await lstatOrNull(join(real, ".hapi"));
  if (!hapi) return { kind: "ready", cwd: real, hapi: false, pins: false };
  if (hapi.isSymbolicLink() || !hapi.isDirectory()) {
    return { kind: "refused", error: ".hapi is a link or not a folder" };
  }
  const pins = await lstatOrNull(join(real, ".hapi", "pins"));
  if (!pins) return { kind: "ready", cwd: real, hapi: true, pins: false };
  if (pins.isSymbolicLink() || !pins.isDirectory()) {
    return { kind: "refused", error: ".hapi/pins is a link or not a folder" };
  }
  return { kind: "ready", cwd: real, hapi: true, pins: true };
}

/** Create one real directory (never through a link), or say why not. */
async function mkdirReal(path: string): Promise<string | null> {
  try {
    await mkdir(path);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const stats = await lstat(path);
  return stats.isSymbolicLink() || !stats.isDirectory()
    ? `${path.split(sep).at(-1)} is a link or not a folder`
    : null;
}

function refusal(code: PinFileRefusal["code"], error: string): PinFileRefusal {
  return { ok: false, code, error };
}

/**
 * `pin_folder`: create `.hapi/pins/<sessionId>/<folder>/` and the git-ignore
 * marker, one level at a time, and name the folder and its saved twin (both
 * relative to the session's folder, ending in `/`). The pin need not exist yet.
 */
export async function ensurePinFolder(
  cwd: string | null | undefined,
  sessionId: string,
  key: string
): Promise<{ ok: true; folder: string; savedFolder: string } | PinFileRefusal> {
  if (!PinKeySchema.safeParse(key).success) {
    return refusal("unsafe_path", "not a valid pin key");
  }
  const roots = await resolvePinRoots(cwd, sessionId);
  if (roots.kind === "absent") {
    return refusal("folder_missing", "the session's folder no longer exists");
  }
  if (roots.kind === "refused") return refusal("unsafe_path", roots.error);
  const hapi = join(roots.cwd, ".hapi");
  const pins = join(hapi, "pins");
  for (const dir of [hapi, pins]) {
    const problem = await mkdirReal(dir);
    if (problem) return refusal("unsafe_path", problem);
  }
  try {
    // `wx`: never overwrite, and never write through a link someone placed there.
    await writeFile(join(pins, ".gitignore"), GITIGNORE, { flag: "wx" });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  for (const dir of [
    join(pins, sessionId),
    join(pins, sessionId, pinFolderName(key)),
  ]) {
    const problem = await mkdirReal(dir);
    if (problem) return refusal("unsafe_path", problem);
  }
  return {
    ok: true,
    folder: `${pinFolderPath(sessionId, key)}/`,
    savedFolder: `${pinSavedPath(key)}/`,
  };
}

export type PinReapResult =
  | { removed: boolean }
  | { removed: false; refused: string }
  | { removed: false; error: string };

/**
 * On session delete: remove `<cwd>/.hapi/pins/<sessionId>/` and nothing else. A
 * symlinked session folder is unlinked, not followed; `.hapi/pins` and its marker
 * stay for the folder's other sessions. Never throws, so a delete never fails on it.
 */
export async function reapSessionPinFiles(
  cwd: string | null | undefined,
  sessionId: string
): Promise<PinReapResult> {
  try {
    const roots = await resolvePinRoots(cwd, sessionId);
    if (roots.kind === "absent") return { removed: false };
    if (roots.kind === "refused")
      return { removed: false, refused: roots.error };
    if (!roots.pins) return { removed: false };
    const sessionDir = join(roots.cwd, ".hapi", "pins", sessionId);
    const stats = await lstatOrNull(sessionDir);
    if (!stats) return { removed: false };
    if (stats.isSymbolicLink()) {
      await unlink(sessionDir);
      return { removed: true };
    }
    if (!stats.isDirectory()) {
      return {
        removed: false,
        refused: "the session's pin folder is not a folder",
      };
    }
    // `.hapi` and `.hapi/pins` are real directories (checked above), so the real
    // path must be exactly this; re-check it just before removing.
    if ((await realpath(sessionDir)) !== sessionDir) {
      return { removed: false, refused: "the session's pin folder moved" };
    }
    await rm(sessionDir, { recursive: true, force: true });
    return { removed: true };
  } catch (error) {
    return {
      removed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** How much of a pin's tree Save looks at before it gives up, so an agent cannot make it walk forever. */
const SAVE_WALK_MAX_ENTRIES = PIN_SAVE_MAX_FILES * 10;
const SAVE_WALK_MAX_DEPTH = 16;
/** The longest skipped list Save reports; the rest are counted. */
const SKIPPED_REPORT_MAX = 50;
/** A destination counts as newer only past this, so float rounding of the copied time never does. */
const NEWER_THAN_SOURCE_MS = 1;

type Skipped = { path: string; reason: string };

type Candidate = {
  /** Path segments below the destination folder. */
  dest: string[];
  /** The file's path below the session's pin folder, for the report. */
  label: string;
  src: string;
};

type SourceFile = Candidate & {
  data: Buffer;
  atimeMs: number;
  mtimeMs: number;
};

/** Why a non-regular, or a hard-linked, file is not copied; null for a plain file. */
function skipReason(stats: Awaited<ReturnType<typeof lstat>>): string | null {
  if (stats.isSymbolicLink()) return "a link";
  if (stats.isFile()) return stats.nlink > 1 ? "a hard link" : null;
  if (stats.isFIFO()) return "a pipe";
  if (stats.isSocket()) return "a socket";
  return "a device or special file";
}

function isPlainSegment(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[/\\\0]/.test(name);
}

export type PinSaveResult =
  | {
      ok: true;
      savedTo: string;
      copied: string[];
      kept: string[];
      /** At most 50; `skippedMore` counts the rest. */
      skipped: Skipped[];
      skippedMore?: number;
    }
  | PinFileRefusal;

/** Pass 1 of Save: what to copy, found by a bounded walk that never throws. */
class SaveWalk {
  readonly candidates: Candidate[] = [];
  readonly skipped: Skipped[] = [];
  /** Why the whole save must refuse (a credential name, or over a cap), or null. */
  stop: PinFileRefusal | null = null;
  private visited = 0;

  skip(path: string, reason: string): void {
    this.skipped.push({ path, reason });
  }

  async add(
    src: string,
    label: string,
    dest: string[],
    depth: number
  ): Promise<void> {
    if (this.stop) return;
    if (++this.visited > SAVE_WALK_MAX_ENTRIES) {
      this.stop = refusal(
        "over_limit",
        `the pin's folders hold more than ${SAVE_WALK_MAX_ENTRIES} entries, so nothing was saved`
      );
      return;
    }
    const name = label.split("/").at(-1) ?? label;
    if (isSensitiveName(name)) {
      this.stop = refusal(
        "unsafe_path",
        `${label} looks like a credential, so nothing was saved`
      );
      return;
    }
    if (name === ".git") {
      this.skip(label, "a git folder");
      return;
    }
    let stats: Awaited<ReturnType<typeof lstat>> | null;
    try {
      stats = await lstatOrNull(src);
    } catch {
      this.skip(label, "unreadable");
      return;
    }
    if (!stats) {
      this.skip(label, "missing");
      return;
    }
    if (stats.isDirectory()) {
      if (depth >= SAVE_WALK_MAX_DEPTH) {
        this.stop = refusal(
          "over_limit",
          `the pin's folders nest deeper than ${SAVE_WALK_MAX_DEPTH} levels, so nothing was saved`
        );
        return;
      }
      let names: string[];
      try {
        names = await this.listBounded(src);
      } catch {
        this.skip(label, "unreadable");
        return;
      }
      for (const entry of names) {
        await this.add(
          join(src, entry),
          `${label}/${entry}`,
          [...dest, entry],
          depth + 1
        );
        if (this.stop) return;
      }
      return;
    }
    const reason = skipReason(stats);
    if (reason) {
      this.skip(label, reason);
      return;
    }
    if (this.candidates.length >= PIN_SAVE_MAX_FILES) {
      this.stop = refusal(
        "over_limit",
        `the pin has more than ${PIN_SAVE_MAX_FILES} files, so nothing was saved`
      );
      return;
    }
    this.candidates.push({ dest: dest.length > 0 ? dest : [name], label, src });
  }

  /** A directory's names, sorted, read only as far as the walk could still go. */
  private async listBounded(dir: string): Promise<string[]> {
    const room = SAVE_WALK_MAX_ENTRIES - this.visited + 1;
    const names: string[] = [];
    const handle = await opendir(dir);
    try {
      for await (const entry of handle) {
        names.push(entry.name);
        if (names.length >= room) break;
      }
    } finally {
      await handle.close().catch(() => {});
    }
    return names.sort();
  }
}

/**
 * Read one candidate without following a link or blocking on a pipe swapped in
 * for it: `O_NOFOLLOW | O_NONBLOCK`, then `fstat` the open file, which is the
 * authority, then read at most `budget + 1` bytes, so a file that grew since the
 * walk cannot carry the save past its byte cap.
 */
async function readCandidate(
  candidate: Candidate,
  budget: number
): Promise<{ file: SourceFile } | { skip: string } | { overBudget: true }> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      candidate.src,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error) {
    return { skip: errorCode(error) === "ELOOP" ? "a link" : "unreadable" };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return {
        skip: stats.isFIFO()
          ? "a pipe"
          : stats.isSocket()
            ? "a socket"
            : "a device or special file",
      };
    }
    if (stats.nlink > 1) return { skip: "a hard link" };
    if (stats.size > budget) return { overBudget: true };
    const buffer = Buffer.alloc(Math.min(stats.size, budget) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > budget) return { overBudget: true };
    return {
      file: {
        ...candidate,
        data: buffer.subarray(0, length),
        atimeMs: stats.atimeMs,
        mtimeMs: stats.mtimeMs,
      },
    };
  } catch {
    return { skip: "unreadable" };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * "Save to session folder": copy the pin's own files from
 * `.hapi/pins/<sessionId>/` into `GeneratedFiles/pins/<folder>/`. `sources` comes
 * from `pinSaveSources` (names directly below the session's pin folder). The
 * pin's own folder is copied into the destination itself; any other folder, and
 * a loose file, keeps its name inside it.
 *
 * Nothing is written until everything has been read and checked: a credential
 * name, more than 200 files or 50 MiB, a walk past 2,000 entries or 16 levels, or
 * a destination that is a link refuses the whole save. Links, hard links, pipes,
 * special files, `.git` folders and unreadable files are skipped and reported.
 * Each file is then written to a temporary name and renamed, keeps its source's
 * modification time, and is never written over a destination file that is newer
 * (the agent may keep building on it there) or that is a link. A file that fails
 * to write is reported as skipped. Extra destination files are left alone.
 */
export async function savePinFiles(
  cwd: string | null | undefined,
  sessionId: string,
  key: string,
  sources: { folders: readonly string[]; files: readonly string[] }
): Promise<PinSaveResult> {
  if (!PinKeySchema.safeParse(key).success) {
    return refusal("unsafe_path", "not a valid pin key");
  }
  const roots = await resolvePinRoots(cwd, sessionId);
  if (roots.kind === "absent" || (roots.kind === "ready" && !roots.pins)) {
    return refusal(
      "folder_missing",
      "the pin's files are not in the session's folder"
    );
  }
  if (roots.kind === "refused") return refusal("unsafe_path", roots.error);
  const own = pinFolderName(key);
  const sessionDir = join(roots.cwd, ".hapi", "pins", sessionId);
  const sessionStats = await lstatOrNull(sessionDir);
  if (!sessionStats) {
    return refusal(
      "folder_missing",
      "the pin's files are not in the session's folder"
    );
  }
  if (sessionStats.isSymbolicLink() || !sessionStats.isDirectory()) {
    return refusal(
      "unsafe_path",
      "the session's pin folder is a link or not a folder"
    );
  }

  // Pass 1: walk, then read, everything; refuse before anything is written.
  const walk = new SaveWalk();
  const names = [...sources.folders, ...sources.files].filter(isPlainSegment);
  for (const name of [...new Set(names)]) {
    await walk.add(join(sessionDir, name), name, name === own ? [] : [name], 0);
    if (walk.stop) return walk.stop;
  }
  const files: SourceFile[] = [];
  // The pin's own folder copies to the destination root, so its entries share
  // names with loose files and other folders: the first readable file keeps a
  // destination, and a later one is skipped rather than overwriting it.
  const claimed = new Set<string>();
  let bytes = 0;
  for (const candidate of walk.candidates) {
    const destKey = candidate.dest.join("/");
    if (claimed.has(destKey)) {
      walk.skip(
        candidate.label,
        "another of the pin's files has the same name in the saved folder"
      );
      continue;
    }
    const read = await readCandidate(candidate, PIN_SAVE_MAX_BYTES - bytes);
    if ("overBudget" in read) {
      return refusal(
        "over_limit",
        `the pin's files are over ${PIN_SAVE_MAX_BYTES} bytes, so nothing was saved`
      );
    }
    if ("skip" in read) {
      walk.skip(candidate.label, read.skip);
      continue;
    }
    bytes += read.file.data.length;
    claimed.add(destKey);
    files.push(read.file);
  }
  if (files.length === 0) {
    return refusal("nothing_to_save", "the pin has no files to save");
  }

  // The destination: checked whole before any of it is created.
  const chain = ["GeneratedFiles", "pins", own].map((_, i, all) =>
    join(roots.cwd, ...all.slice(0, i + 1))
  );
  for (const dir of chain) {
    const stats = await lstatOrNull(dir);
    if (stats && (stats.isSymbolicLink() || !stats.isDirectory())) {
      return refusal(
        "unsafe_path",
        `${dir.slice(roots.cwd.length + 1)} is a link or not a folder`
      );
    }
  }
  for (const dir of chain) {
    const problem = await mkdirReal(dir);
    if (problem) return refusal("unsafe_path", problem);
  }
  const destDir = chain[chain.length - 1];

  // Pass 2: write only.
  const copied: string[] = [];
  const kept: string[] = [];
  for (const file of files) {
    try {
      const outcome = await writeOne(destDir, file);
      if (outcome === "copied") copied.push(file.label);
      else if (outcome === "kept") kept.push(file.label);
      else walk.skip(file.label, outcome.skip);
    } catch (error) {
      walk.skip(
        file.label,
        `could not be written (${errorCode(error) ?? "error"})`
      );
    }
  }
  if (copied.length === 0 && kept.length === 0) {
    // Nothing reached the folder (a full disk, an unwritable destination), so it
    // is not a save: the pin must not be marked saved or reported to the agent.
    const last = walk.skipped.at(-1);
    return refusal(
      "write_failed",
      `nothing was saved: no file reached the folder${last ? ` (${last.path}: ${last.reason})` : ""}`
    );
  }
  const skipped = walk.skipped.slice(0, SKIPPED_REPORT_MAX);
  const skippedMore = walk.skipped.length - skipped.length;
  return {
    ok: true,
    savedTo: `${pinSavedPath(key)}/`,
    copied,
    kept,
    skipped,
    ...(skippedMore > 0 ? { skippedMore } : {}),
  };
}

/**
 * Write one read file below `destDir`, creating its folders one real level at a
 * time: to a temporary sibling, with its source's times, then renamed into
 * place. Keeps a newer destination file and never writes through a link.
 */
async function writeOne(
  destDir: string,
  file: SourceFile
): Promise<"copied" | "kept" | { skip: string }> {
  let parent = destDir;
  for (const name of file.dest.slice(0, -1)) {
    parent = join(parent, name);
    if (await mkdirReal(parent)) {
      return { skip: "its destination folder is a link or not a folder" };
    }
  }
  const dest = join(destDir, ...file.dest);
  const existing = await lstatOrNull(dest);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      return { skip: "its destination is a link or not a file" };
    }
    if (existing.mtimeMs - file.mtimeMs > NEWER_THAN_SOURCE_MS) return "kept";
  }
  const temp = join(dirname(dest), `.pin-save-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, file.data, { flag: "wx" });
    // Numeric seconds keep sub-millisecond precision where the platform does; any
    // rounding is far inside NEWER_THAN_SOURCE_MS.
    await utimes(temp, file.atimeMs / 1000, file.mtimeMs / 1000);
    await rename(temp, dest);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return "copied";
}
