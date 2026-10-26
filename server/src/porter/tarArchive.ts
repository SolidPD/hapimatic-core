// SPDX-License-Identifier: AGPL-3.0-only
import { promisify } from "node:util";
import { gunzip, gunzipSync } from "node:zlib";
import { ARCHIVE_LIMITS } from "@hapi/protocol/porter";
import type { ArchiveEntryKind } from "./archiveContainment";

/**
 * Read-only gzip-compressed POSIX tar (`.tar.gz`) reader for the Configuration
 * Porter import path (issue #2343, epic #2339 Sub D).
 *
 * Hand-rolled deliberately: the repo has no `tar` dependency, and a
 * security-critical importer wants FULL control over how entry paths, member
 * kinds (regular/dir/symlink/hardlink), and sizes are classified — a general tar
 * library would silently follow its own symlink/extraction semantics. The
 * container format (gzip-compressed POSIX tar) is fixed by #2340
 * (`ARCHIVE_FORMAT`). Parsing is decode-only: this module NEVER touches the
 * filesystem, so there is no extraction-time traversal here — containment
 * (`archiveContainment.ts`) and materialisation (`importArchive.ts`) own that.
 *
 * F9 (anti-bomb): the caps in `ARCHIVE_LIMITS` (#2340) are enforced HERE, at
 * decode time — the compressed size cap alone does not stop a decompression
 * bomb, so this module bounds total-uncompressed, per-entry, entry-count, and
 * decompression-ratio before materialising anything.
 *
 * #4285: every member is named as GNU tar and BusyBox name it, or the archive
 * is refused. The extraction prompt's Step 11 check (#4164) vouches for an
 * archive by listing it with the LOCAL tar, so a header form that tar reads
 * differently from this parser would let the check pass names the importer
 * never uses. The rules (refuse where the readers disagree, align where they
 * agree) are listed in docs/internal/architecture/config-porter-archive.md,
 * "The importer's tar rules".
 */

/** One parsed tar member. `data` is present only for regular files. */
export interface TarEntry {
  /** The full archive-relative path (ustar prefix + name, or GNU/pax long name). */
  path: string;
  /** POSIX mode bits (from the octal `mode` field), or undefined if unparseable. */
  mode?: number;
  /** Classified member kind (drives containment's link rejection). */
  kind: ArchiveEntryKind;
  /** Regular-file contents. Empty for directories / links. */
  data: Buffer;
}

/**
 * Thrown when an archive exceeds a #2340 `ARCHIVE_LIMITS` cap (F9) — a
 * decompression/tar bomb, an oversized member, or too many entries. Typed so the
 * import path rejects the whole archive with zero bytes written.
 */
export class ArchiveLimitError extends Error {
  readonly limit: string;
  constructor(limit: string, detail: string) {
    super(`Archive rejected (${limit}): ${detail}`);
    this.name = "ArchiveLimitError";
    this.limit = limit;
  }
}

/** Thrown when the byte stream is not a well-formed POSIX tar. */
export class TarParseError extends Error {
  constructor(message: string) {
    super(`Malformed tar archive: ${message}`);
    this.name = "TarParseError";
  }
}

const BLOCK = 512;

/** The six POSIX ustar magic bytes at offset 257 (version bytes not included). */
const POSIX_MAGIC = "ustar\0";

/**
 * Typeflags GNU tar and BusyBox read with no data, whatever the size field
 * says (link, symlink, char/block device, directory, FIFO) — #4285, probed
 * with GNU tar 1.35 and BusyBox 1.36: both read the next block as a header.
 */
const DATALESS_TYPEFLAGS = new Set(["1", "2", "3", "4", "5", "6"]);

/**
 * Regular-file typeflags. A BusyBox built with OLDGNU compatibility (BusyBox's
 * defconfig; Alpine) reads one whose name ends in `/` as a size-0 directory,
 * where GNU tar reads its data by the size field (#4285).
 */
const REGULAR_TYPEFLAGS = new Set(["0", "\0", "7"]);

/**
 * Every typeflag this parser reads. Any other one — old GNU sparse `S`, whose
 * extension blocks GNU tar reads before the data, and the volume, multivolume
 * and vendor flags — is refused: BusyBox refuses them, GNU tar does not (#4285).
 */
const KNOWN_TYPEFLAGS = new Set([
  ...REGULAR_TYPEFLAGS,
  ...DATALESS_TYPEFLAGS,
  "D",
  "L",
  "K",
  "x",
  "g",
  "X",
]);

/** Every BusyBox skips a pax `x`/`g` header larger than this; GNU tar reads it. */
const BUSYBOX_MAX_PAX_HEADER = 0xfffff;

/** Parse an octal ASCII numeric field (space/NUL terminated). Returns 0 if blank. */
function parseOctal(buf: Buffer, off: number, len: number): number {
  // Trim trailing NUL/space and leading NUL/space.
  let s = buf.toString("ascii", off, off + len);
  s = s.replace(/\0/g, " ").trim();
  if (s.length === 0) return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The octal digits of a numeric field, or null when the field is not leading
 * spaces, octal digits, then NUL/space padding. Digits after a leading NUL are
 * refused: GNU tar and BusyBox read `" \0…"` and an all-NUL field as 0 but
 * disagree on digits after one leading NUL, so trimming it would frame a
 * member unlike both.
 */
function octalDigits(buf: Buffer, off: number, len: number): string | null {
  const m = /^ *([0-7]*)[ \0]*$/.exec(buf.toString("latin1", off, off + len));
  return m ? m[1] : null;
}

/**
 * Parse the 12-byte `size` field strictly (#4285 R4). A lenient parse
 * (`parseInt("12x", 8) === 10`, base-256 → 0, padding trimmed from both ends)
 * frames a member differently from GNU tar and BusyBox, which honour base-256
 * and refuse or zero the rest. No member under
 * `ARCHIVE_LIMITS.maxEntryUncompressedBytes` needs base-256, so it is refused,
 * as is any field {@link octalDigits} does not accept.
 */
function parseSizeField(buf: Buffer, off: number): number {
  if (buf[off] & 0x80) throw new TarParseError("base-256 size field");
  const digits = octalDigits(buf, off, 12);
  if (digits === null) throw new TarParseError("non-octal size field");
  return digits.length === 0 ? 0 : parseInt(digits, 8);
}

/**
 * True when the stored checksum (offset 148) equals the unsigned or the signed
 * byte sum of the header, the checksum field counted as eight spaces (#4285
 * R6). GNU tar and BusyBox refuse a header that fails this, so a block they
 * never list must not be read as a member here.
 */
function checksumMatches(buf: Buffer, off: number): boolean {
  const stored = octalDigits(buf, off + 148, 8);
  if (!stored) return false;
  let unsigned = 0;
  let signed = 0;
  for (let i = off; i < off + BLOCK; i++) {
    const b = i >= off + 148 && i < off + 156 ? 0x20 : buf[i];
    unsigned += b;
    signed += b > 0x7f ? b - 0x100 : b;
  }
  const want = parseInt(stored, 8);
  return want === unsigned || want === signed;
}

/**
 * The ustar `prefix` to join before the name (#4285 R2). GNU tar and bsdtar
 * join it whenever the six magic bytes are POSIX `ustar\0`, version bytes
 * ignored. BusyBox joins it for ANY magic that starts `ustar`, GNU's own
 * `ustar  \0` included, where GNU tar keeps atime/ctime/offset in that slot and
 * ignores it for naming. Under such a magic the prefix is ignored, as GNU tar
 * does, and the slot must hold only octal digits, spaces and NULs (GNU's own
 * content); anything else is refused. A digits-only slot BusyBox still joins
 * (`<atime>/CLAUDE.md`) is closed by the duplicate-path rule and by Step 11's
 * count check — the D9 ruling, under which AC3 is GNU-tar-only. A BusyBox
 * built with OLDGNU compatibility also joins a non-empty slot under the v7
 * (no-magic) header; that name likewise always gains a segment, so the same
 * two checks close it.
 */
function ustarPrefix(buf: Buffer, off: number): string {
  const magic = buf.toString("latin1", off + 257, off + 263);
  if (magic === POSIX_MAGIC) return readStr(buf, off + 345, 155);
  if (
    magic.startsWith("ustar") &&
    !/^[0-7 \0]*$/.test(buf.toString("latin1", off + 345, off + 500))
  ) {
    throw new TarParseError(
      "a non-POSIX ustar header carries non-numeric bytes in its prefix slot " +
        "(BusyBox would read them as a path prefix)"
    );
  }
  return "";
}

/** Read a NUL-terminated ASCII string field. */
function readStr(buf: Buffer, off: number, len: number): string {
  const slice = buf.subarray(off, off + len);
  const nul = slice.indexOf(0);
  return slice.toString("utf8", 0, nul === -1 ? len : nul);
}

/** True when a 512-byte block is entirely zero (end-of-archive marker). */
function isZeroBlock(buf: Buffer, off: number): boolean {
  for (let i = off; i < off + BLOCK; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

/** Map a tar typeflag char to an {@link ArchiveEntryKind}. */
function classifyTypeflag(flag: string): ArchiveEntryKind {
  switch (flag) {
    case "0":
    case "\0":
    case "7": // contiguous file — treat as regular
      return "file";
    case "5":
    case "D": // GNU dumpdir (`tar --incremental`): a directory plus a listing (#4285 R10)
      return "directory";
    case "2":
      return "symlink";
    case "1":
      return "hardlink";
    default:
      // 3/4 device and 6 fifo → "other" (containment refuses). parseTar
      // refuses every unknown flag before it gets here (#4285).
      return "other";
  }
}

/**
 * Parse a `pax` extended-header body into its key→value records (#4285 R3).
 * Each record is "<len> <key>=<value>\n", where `len` is a decimal count of
 * the record's BYTES, its own digits and the newline included — counting
 * decoded characters instead misreads every non-ASCII value. A malformed
 * record is refused, not skipped: GNU tar drops it (and a blank before the
 * key) differently from BusyBox, so the two would name the member
 * differently. NUL padding after the last record ends the body.
 */
function parsePaxRecords(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  const malformed = () =>
    new TarParseError("malformed pax extended header record");
  let pos = 0;
  while (pos < body.byteLength) {
    if (body[pos] === 0) {
      if (body.subarray(pos).some(b => b !== 0)) throw malformed();
      break;
    }
    const space = body.indexOf(0x20, pos);
    if (space === -1) throw malformed();
    const digits = body.toString("latin1", pos, space);
    if (!/^[0-9]+$/.test(digits)) throw malformed();
    const end = pos + Number(digits);
    const eq = body.indexOf(0x3d, space + 1);
    if (
      end <= space + 1 ||
      end > body.byteLength ||
      body[end - 1] !== 0x0a ||
      eq === -1 ||
      eq >= end - 1 ||
      eq === space + 1 ||
      body[space + 1] === 0x20 ||
      body[space + 1] === 0x09 ||
      body.subarray(space + 1, eq).includes(0)
    ) {
      throw malformed();
    }
    out[body.toString("utf8", space + 1, eq)] = body.toString(
      "utf8",
      eq + 1,
      end - 1
    );
    pos = end;
  }
  return out;
}

/** Pax keys that name or frame a member (path, linkpath, size, GNU.sparse.*). */
const isNamingKey = (key: string): boolean =>
  key === "path" ||
  key === "linkpath" ||
  key === "size" ||
  key.startsWith("GNU.sparse.");

/**
 * Check a local (`x`) pax header's records (#4285). A `GNU.sparse.*` record
 * renames or re-frames the member under GNU tar and is ignored by BusyBox; an
 * empty `path`/`linkpath`/`size` value (after the first NUL, where both tars
 * end a string) reverts to the header field under GNU tar but not BusyBox.
 */
function checkLocalPax(records: Record<string, string>): void {
  for (const [key, value] of Object.entries(records)) {
    if (key.startsWith("GNU.sparse.")) {
      throw new TarParseError(
        `pax header carries a ${key} record (GNU tar reads the member's name ` +
          "or layout from it, BusyBox ignores it)"
      );
    }
    if (isNamingKey(key) && cString(value) === "") {
      throw new TarParseError(`pax header carries an empty ${key} record`);
    }
  }
}

/** A string as C reads it: up to the first NUL (GNU tar and BusyBox both do). */
function cString(s: string): string {
  const nul = s.indexOf("\0");
  return nul === -1 ? s : s.slice(0, nul);
}

/** The inflate bound for an archive, and which F9 cap it comes from. */
export interface InflateBound {
  maxOutputLength: number;
  limit: "maxDecompressionRatio" | "maxTotalUncompressedBytes";
}

/**
 * The most bytes an archive of `compressedBytes` may inflate to: the smaller of
 * the total cap and the ratio cap × the compressed size (#5228). Passed to zlib
 * as `maxOutputLength`, so the ratio cap stops inflation instead of being
 * checked after it (a ~200 KB bomb used to inflate to 200 MiB first). Never
 * below 1, because zlib refuses a `maxOutputLength` of 0.
 */
export function inflateBound(compressedBytes: number): InflateBound {
  const byRatio = Math.floor(
    compressedBytes * ARCHIVE_LIMITS.maxDecompressionRatio
  );
  if (byRatio < ARCHIVE_LIMITS.maxTotalUncompressedBytes) {
    return {
      maxOutputLength: Math.max(1, byRatio),
      limit: "maxDecompressionRatio",
    };
  }
  return {
    maxOutputLength: ARCHIVE_LIMITS.maxTotalUncompressedBytes,
    limit: "maxTotalUncompressedBytes",
  };
}

/** The compressed-size check, then the archive as a Buffer for zlib. */
function compressedInput(compressed: Uint8Array): Buffer {
  if (compressed.byteLength > ARCHIVE_LIMITS.maxCompressedBytes) {
    throw new ArchiveLimitError(
      "maxCompressedBytes",
      `${compressed.byteLength} bytes > ${ARCHIVE_LIMITS.maxCompressedBytes}`
    );
  }
  return Buffer.from(
    compressed.buffer,
    compressed.byteOffset,
    compressed.byteLength
  );
}

/** Map a zlib failure to the typed error the import routes classify. */
function inflateError(err: unknown, bound: InflateBound): Error {
  // node:zlib throws ERR_BUFFER_TOO_LARGE when output would exceed
  // maxOutputLength — that is the bomb signal.
  if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
    // The plan route shows this text to the user, so a ratio refusal names the
    // ratio, not only a byte count that looks small for a small archive.
    const cause =
      bound.limit === "maxDecompressionRatio"
        ? ` (more than ${ARCHIVE_LIMITS.maxDecompressionRatio} × the compressed size)`
        : "";
    return new ArchiveLimitError(
      bound.limit,
      `decompressed output exceeds ${bound.maxOutputLength} bytes${cause}`
    );
  }
  return new TarParseError(
    `gzip decompression failed: ${err instanceof Error ? err.message : String(err)}`
  );
}

/** Belt to the maxOutputLength braces (in case a runtime does not honour it). */
function checkInflated(out: Buffer, compressedBytes: number): Buffer {
  if (out.byteLength > ARCHIVE_LIMITS.maxTotalUncompressedBytes) {
    throw new ArchiveLimitError(
      "maxTotalUncompressedBytes",
      `${out.byteLength} bytes > ${ARCHIVE_LIMITS.maxTotalUncompressedBytes}`
    );
  }
  if (
    compressedBytes > 0 &&
    out.byteLength / compressedBytes > ARCHIVE_LIMITS.maxDecompressionRatio
  ) {
    throw new ArchiveLimitError(
      "maxDecompressionRatio",
      `ratio ${(out.byteLength / compressedBytes).toFixed(1)} > ` +
        `${ARCHIVE_LIMITS.maxDecompressionRatio}`
    );
  }
  return out;
}

/**
 * Decompress a `.tar.gz` buffer to its uncompressed tar bytes, enforcing the
 * compressed-size cap, the total-uncompressed cap, and the decompression-ratio
 * cap (F9). The ratio cap binds DURING inflation via {@link inflateBound}
 * (#5228). Synchronous: kept for tools and tests; the server's import path uses
 * {@link decompressArchiveAsync}, which does not block the event loop.
 */
export function decompressArchive(compressed: Uint8Array): Buffer {
  const input = compressedInput(compressed);
  const bound = inflateBound(compressed.byteLength);
  let out: Buffer;
  try {
    out = gunzipSync(input, { maxOutputLength: bound.maxOutputLength });
  } catch (err) {
    throw inflateError(err, bound);
  }
  return checkInflated(out, compressed.byteLength);
}

const gunzipAsync = promisify(gunzip);

/**
 * One inflate in flight at a time (#5228). The synchronous inflate ran one
 * archive at a time by blocking the loop; this queue keeps that bound for the
 * inflate step, so concurrent uploads never inflate side by side. It does not
 * bound what a finished plan holds afterwards (`planImport` keeps its entries
 * across later awaits, as it did before).
 */
let inflateQueue: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const run = inflateQueue.then(task, task);
  inflateQueue = run.catch(() => undefined);
  return run;
}

/**
 * {@link decompressArchive} with the same caps, inflated on zlib's thread pool
 * so a large archive does not stall every other request (#5228).
 */
export function decompressArchiveAsync(
  compressed: Uint8Array
): Promise<Buffer> {
  return oneAtATime(async () => {
    const input = compressedInput(compressed);
    const bound = inflateBound(compressed.byteLength);
    let out: Buffer;
    try {
      out = await gunzipAsync(input, {
        maxOutputLength: bound.maxOutputLength,
      });
    } catch (err) {
      throw inflateError(err, bound);
    }
    return checkInflated(out, compressed.byteLength);
  });
}

/**
 * Parse uncompressed tar bytes into {@link TarEntry}s, enforcing the entry-count
 * and per-entry-size caps (F9). Handles ustar prefix+name, GNU long names
 * (`L`/`K` typeflags), and `pax` extended headers (`x`/`g`) so real `tar czf`
 * output with deep paths parses correctly — and refuses the header forms GNU
 * tar and BusyBox name differently (#4285, module header).
 */
export function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let off = 0;
  // Pending overrides from a preceding GNU/pax metadata entry (#4285 R5: at
  // most one long name and one pax header per member).
  let pendingLongName: string | undefined;
  let pendingPax: Record<string, string> | undefined;

  while (off + BLOCK <= buf.byteLength) {
    if (isZeroBlock(buf, off)) {
      // End of archive. GNU tar stops at the first zero block, but BusyBox
      // reads on past a LONE one, so a header after it is refused (#4285).
      const next = off + BLOCK;
      if (next + BLOCK <= buf.byteLength && !isZeroBlock(buf, next)) {
        throw new TarParseError(
          "a header follows a lone zero block (GNU tar stops there, BusyBox reads on)"
        );
      }
      break;
    }
    if (!checksumMatches(buf, off)) {
      throw new TarParseError("header checksum mismatch");
    }
    if (buf[off] === 0 && buf[off + 345] === 0) {
      // With no long name or pax path pending, BusyBox reads a header whose
      // name and prefix both start with NUL as an empty block (two in a row
      // end the archive) and reads on 512 bytes later; GNU tar reads it as a
      // header. No exporter writes one, so it is refused in every position.
      throw new TarParseError(
        "a header has an empty name and prefix (BusyBox reads it as an empty block)"
      );
    }

    const typeflag = String.fromCharCode(buf[off + 156]);
    if (typeflag === "S") {
      throw new TarParseError(
        "old GNU sparse member (typeflag S) is not supported (GNU tar reads " +
          "its extension blocks before the data, BusyBox refuses it)"
      );
    }
    if (!KNOWN_TYPEFLAGS.has(typeflag)) {
      throw new TarParseError(
        `unsupported typeflag ${JSON.stringify(typeflag)} (GNU tar and ` +
          "BusyBox handle it differently)"
      );
    }
    const size = parseSizeField(buf, off + 124);
    if (size !== 0 && DATALESS_TYPEFLAGS.has(typeflag)) {
      throw new TarParseError(
        `a typeflag-${typeflag} member declares a nonzero size (GNU tar and ` +
          "BusyBox read no data for it and take the next block as a header)"
      );
    }
    if (size < 0 || size > ARCHIVE_LIMITS.maxEntryUncompressedBytes) {
      throw new ArchiveLimitError(
        "maxEntryUncompressedBytes",
        `entry size ${size} > ${ARCHIVE_LIMITS.maxEntryUncompressedBytes}`
      );
    }
    const dataStart = off + BLOCK;
    if (dataStart + size > buf.byteLength) {
      throw new TarParseError("entry data extends past end of archive");
    }
    const body = buf.subarray(dataStart, dataStart + size);
    const advance = BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (
      (typeflag === "x" || typeflag === "g") &&
      size > BUSYBOX_MAX_PAX_HEADER
    ) {
      throw new TarParseError(
        `a pax header over ${BUSYBOX_MAX_PAX_HEADER} bytes (every BusyBox ` +
          "skips it, GNU tar applies it)"
      );
    }

    // --- GNU long name / long linkname ---
    if (typeflag === "L") {
      if (pendingLongName !== undefined) {
        throw new TarParseError("two GNU long-name headers before one member");
      }
      pendingLongName = readStr(body, 0, body.byteLength);
      off += advance;
      continue;
    }
    if (typeflag === "K") {
      // long linkname — irrelevant (links are refused), skip its body.
      off += advance;
      continue;
    }
    // --- pax extended headers ---
    if (typeflag === "x") {
      if (pendingPax !== undefined) {
        throw new TarParseError("two pax extended headers before one member");
      }
      pendingPax = parsePaxRecords(body);
      checkLocalPax(pendingPax);
      off += advance;
      continue;
    }
    if (typeflag === "g") {
      // A global header never names or frames a member here: GNU tar applies
      // its path to EVERY later member, BusyBox ignores it (#4285 R1). Other
      // keys (git archive's `comment`) are accepted and ignored.
      const key = Object.keys(parsePaxRecords(body)).find(isNamingKey);
      if (key !== undefined) {
        throw new TarParseError(
          `global pax header carries a ${key} record (GNU tar applies it to ` +
            "every later member, BusyBox ignores it)"
        );
      }
      off += advance;
      continue;
    }
    if (typeflag === "X") {
      // GNU tar and bsdtar read a Solaris extended header as a pax `x` header;
      // BusyBox refuses it, and no exporter writes one.
      throw new TarParseError(
        "Solaris extended header (typeflag X) is not supported"
      );
    }

    // --- regular member ---
    const name = readStr(buf, off, 100);
    const prefix = ustarPrefix(buf, off);
    if (pendingPax?.path !== undefined && pendingLongName !== undefined) {
      throw new TarParseError(
        "a pax path and a GNU long name both name one member (GNU tar and " +
          "BusyBox pick different ones)"
      );
    }
    if (
      pendingPax?.size !== undefined &&
      (!/^[0-9]+$/.test(pendingPax.size) || Number(pendingPax.size) !== size)
    ) {
      throw new TarParseError("pax size record disagrees with the header size");
    }
    const path = cString(
      pendingPax?.path ??
        pendingLongName ??
        (prefix ? `${prefix}/${name}` : name)
    );
    if (path === "") {
      // An empty GNU long name, or a non-POSIX header whose name field is empty
      // (its prefix slot, which BusyBox would join, is not part of the name).
      throw new TarParseError("a member has an empty name");
    }
    if (path.includes("//")) {
      // GNU tar joins `prefix/` + `name` as `prefix//name`; BusyBox collapses
      // the doubled slash (and a name's leading one), so the two would name
      // the member differently. No writer emits an empty segment.
      throw new TarParseError(
        `member path ${JSON.stringify(path)} has an empty segment (BusyBox ` +
          "collapses the doubled slash, GNU tar keeps it)"
      );
    }
    // The resolved path, not the 100-byte name field: GNU tar truncates a long
    // name into that field, and BusyBox skips this check when a long name or
    // pax path names the member (get_header_tar.c, 1_36_stable).
    if (size !== 0 && REGULAR_TYPEFLAGS.has(typeflag) && path.endsWith("/")) {
      throw new TarParseError(
        `a sized regular member ${JSON.stringify(path)} ends in "/" (a ` +
          "BusyBox built with OLDGNU compatibility reads it as a directory " +
          "and its data as headers)"
      );
    }
    if (seen.has(path)) {
      throw new TarParseError(`duplicate member path ${JSON.stringify(path)}`);
    }
    seen.add(path);

    const kind = classifyTypeflag(typeflag);
    const mode = parseOctal(buf, off + 100, 8);

    entries.push({
      path,
      mode: mode || undefined,
      kind,
      // Only regular files carry data; a directory member's "size" is 0.
      data: kind === "file" ? Buffer.from(body) : Buffer.alloc(0),
    });

    if (entries.length > ARCHIVE_LIMITS.maxEntries) {
      throw new ArchiveLimitError(
        "maxEntries",
        `more than ${ARCHIVE_LIMITS.maxEntries} entries`
      );
    }

    pendingLongName = undefined;
    pendingPax = undefined;
    off += advance;
  }

  return entries;
}

/** Decompress + parse a `.tar.gz` in one call. */
export function parseTarGz(compressed: Uint8Array): TarEntry[] {
  return parseTar(decompressArchive(compressed));
}

/** {@link parseTarGz} with the asynchronous, one-at-a-time inflate (#5228). */
export async function parseTarGzAsync(
  compressed: Uint8Array
): Promise<TarEntry[]> {
  return parseTar(await decompressArchiveAsync(compressed));
}
