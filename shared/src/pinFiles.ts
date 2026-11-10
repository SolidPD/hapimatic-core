// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import { PinMutationResponseSchema } from "./pins";

// Where a pin's files live and how its links resolve (issue #6453, epic #6446).
// Pure, with no dependency beyond zod and the pin schemas, so the server and the
// web share one rule for every path built from an agent's key.
//
// ## Layout
// A pin's pages and images go under `.hapi/pins/<sessionId>/<pinFolderName(key)>/`
// in the session's folder, git-ignored by `.hapi/pins/.gitignore` and deleted with
// the session. "Save to session folder" copies them into
// `GeneratedFiles/pins/<pinFolderName(key)>/`, which sessions commit. The session
// level is the server's session id (a lowercase UUID), so one plain folder can host
// several sessions and one session's delete never touches another's files.
//
// ## Folder names
// A key is one safe path segment on Linux, but not on every disk: `:` is not
// allowed in a Windows file name, `CON` and `nul.txt` are reserved there, a
// trailing `.` is dropped, and `Foo` and `foo` are one folder on a case-insensitive
// disk. `pinFolderName` keeps a typical key readable (`pm26:release-go` →
// `pm26+release-go`) and adds a hash of the exact key when the plain form would be
// unsafe or could collide (see the function).

export const PIN_FILES_DIR = ".hapi/pins";
export const PIN_SAVED_DIR = "GeneratedFiles/pins";
/** The readable part of a folder name; a hashed name adds `-` and 8 hex characters. */
export const PIN_FOLDER_NAME_MAX = 64;
/** Save copies at most this many files... */
export const PIN_SAVE_MAX_FILES = 200;
/** ...and at most this many bytes, or nothing at all. */
export const PIN_SAVE_MAX_BYTES = 50 * 1024 * 1024;

const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Windows reserves these stems, alone or before an extension (`nul.txt`). */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
/** The tail a hashed name ends in; a plain name never ends this way. */
const HASH_TAIL = /-[0-9a-f]{8}$/;

/** The server's session id: a lowercase UUID, which is what `randomUUID()` emits. */
export function isPinSessionId(id: string): boolean {
  return SESSION_ID.test(id);
}

/** FNV-1a 32-bit over the string's UTF-16 code units, as 8 lowercase hex digits. */
function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** `text` without its trailing dots (a loop, because `/\.+$/` is quadratic on a run of dots). */
function trimTrailingDots(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x2e) end--;
  return text.slice(0, end);
}

function hasReservedStem(name: string): boolean {
  return WINDOWS_RESERVED.test(name.split(".")[0].toLowerCase());
}

/**
 * One pin key's folder name, valid on Linux, macOS and Windows, and distinct per
 * key even on a case-insensitive disk. Each `:` becomes `+`, which is not in the
 * key alphabet, so the plain form is one-to-one. The plain form is kept only when
 * it is all lowercase, at most 64 characters, does not end in `.`, has no Windows
 * reserved stem, and does not already end the way a hashed name does. Otherwise
 * the name is lowercased (a reserved stem gains a leading `_`), cut to 64
 * characters, stripped of trailing dots, and followed by `-` and an FNV-1a hash of
 * the exact key: at most 73 characters. Plain and hashed names cannot coincide,
 * because only a hashed name ends in `-` and 8 hex digits.
 */
export function pinFolderName(key: string): string {
  const plain = key.replace(/:/g, "+");
  const needsHash =
    plain !== plain.toLowerCase() ||
    plain.length > PIN_FOLDER_NAME_MAX ||
    plain.endsWith(".") ||
    hasReservedStem(plain) ||
    HASH_TAIL.test(plain);
  if (!needsHash) return plain;
  let base = plain.toLowerCase();
  if (hasReservedStem(base)) base = `_${base}`;
  base = trimTrailingDots(base.slice(0, PIN_FOLDER_NAME_MAX));
  return `${base}-${fnv1a32(key)}`;
}

/** `.hapi/pins/<sessionId>`, relative to the session's folder. */
export function pinSessionDir(sessionId: string): string {
  return `${PIN_FILES_DIR}/${sessionId}`;
}

/** `.hapi/pins/<sessionId>/<folder>`, relative to the session's folder. */
export function pinFolderPath(sessionId: string, key: string): string {
  return `${pinSessionDir(sessionId)}/${pinFolderName(key)}`;
}

/** `GeneratedFiles/pins/<folder>`, relative to the session's folder. */
export function pinSavedPath(key: string): string {
  return `${PIN_SAVED_DIR}/${pinFolderName(key)}`;
}

/** A path's segments with empty and `.` segments dropped. */
function segmentsOf(path: string): string[] {
  return path.split("/").filter(segment => segment !== "" && segment !== ".");
}

/**
 * What "Save to session folder" copies, relative to `pinSessionDir(sessionId)`:
 * a path two or more levels below the session folder contributes its first-level
 * folder (whole, so a page's sibling assets come along), and a path directly in
 * it contributes that file alone. Evidence anywhere else, another session's
 * folder included, is ignored.
 */
export function pinSaveSources(
  sessionId: string,
  evidence: readonly { path: string }[]
): { folders: string[]; files: string[] } {
  const folders = new Set<string>();
  const files = new Set<string>();
  for (const { path } of evidence) {
    const parts = segmentsOf(path);
    if (
      parts.length < 4 ||
      parts[0] !== ".hapi" ||
      parts[1] !== "pins" ||
      parts[2] !== sessionId ||
      parts.includes("..")
    ) {
      continue;
    }
    if (parts.length === 4) files.add(parts[3]);
    else folders.add(parts[3]);
  }
  return { folders: [...folders].sort(), files: [...files].sort() };
}

/**
 * The `GeneratedFiles/pins/<folder>/` of the first evidence path below it, for an
 * asset the agent keeps building on and saved there itself; else null. A file
 * directly in `GeneratedFiles/pins/` has no folder and does not count.
 */
export function derivedSavedTo(
  evidence: readonly { path: string }[]
): string | null {
  for (const { path } of evidence) {
    const parts = segmentsOf(path);
    if (
      parts.length >= 4 &&
      parts[0] === "GeneratedFiles" &&
      parts[1] === "pins" &&
      !parts.includes("..")
    ) {
      return `${PIN_SAVED_DIR}/${parts[2]}/`;
    }
  }
  return null;
}

/** A pin's saved folder: the one Save recorded, else one its evidence implies. */
export function effectiveSavedTo(pin: {
  savedTo?: string | null;
  evidence?: readonly { path: string }[];
}): string | null {
  return pin.savedTo ?? derivedSavedTo(pin.evidence ?? []);
}

/** `pin_folder`'s answer: both paths end in `/`. */
export const PinFolderResponseSchema = z
  .object({ folder: z.string(), savedFolder: z.string() })
  .loose();
export type PinFolderResponse = z.infer<typeof PinFolderResponseSchema>;

/**
 * "Save to session folder"'s answer: the saved pin, the folder, and what was
 * copied, kept (the destination was newer) and skipped, with paths below
 * `GeneratedFiles/pins/`. `skipped` holds at most 50; `skippedMore` counts the rest.
 */
export const PinSaveResponseSchema = PinMutationResponseSchema.extend({
  savedTo: z.string(),
  copied: z.array(z.string()),
  kept: z.array(z.string()),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() }).loose()),
  skippedMore: z.number().int().positive().optional(),
}).loose();
export type PinSaveResponse = z.infer<typeof PinSaveResponseSchema>;

/** One issue reference in a text: `#12` or `owner/repo#12`. */
export type PinIssueRef = {
  /** Where the reference starts (its `owner/` or `#`) and ends, in code units. */
  start: number;
  end: number;
  /** `owner/repo` when written, else null (a bare `#N`). */
  repo: string | null;
  number: number;
};

// A reference stands alone: not after a word character, `/`, `&` or `#` (so
// `abc#12`, `&#123;` and `##12` are not references), and not before a word
// character or `-`. GitHub numbers start at 1 and need no leading zero.
const ISSUE_REF =
  /(^|[^\w/&#])(?:([A-Za-z0-9][\w.-]*\/[\w.-]+))?#([1-9]\d{0,6})(?![\w-])/g;

/** Every issue reference in plain text. The caller skips code and links. */
export function findIssueRefs(text: string): PinIssueRef[] {
  const refs: PinIssueRef[] = [];
  for (const match of text.matchAll(ISSUE_REF)) {
    const start = (match.index ?? 0) + match[1].length;
    refs.push({
      start,
      end: (match.index ?? 0) + match[0].length,
      repo: match[2] ?? null,
      number: Number(match[3]),
    });
  }
  return refs;
}

/** True for `owner/repo`: exactly one `/`, with something on each side. */
export function isIssueRepo(repo: string | null | undefined): repo is string {
  return typeof repo === "string" && /^[^/\s]+\/[^/\s]+$/.test(repo);
}

/**
 * The repository a reference names, the way GitHub reads it: an explicit
 * `owner/repo`, else the session's own repository, else the linked issue's. Null
 * when none is known, so a bare `#N` is never sent to an unrelated repository.
 */
export function resolveIssueRepo(
  ref: Pick<PinIssueRef, "repo">,
  context: { repoIdentity?: string | null; linkedIssueRepo?: string | null }
): string | null {
  for (const candidate of [
    ref.repo,
    context.repoIdentity,
    context.linkedIssueRepo,
  ]) {
    if (isIssueRepo(candidate)) return candidate;
  }
  return null;
}
