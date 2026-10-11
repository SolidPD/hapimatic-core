// SPDX-License-Identifier: AGPL-3.0-only
import { gunzipSync } from "node:zlib";
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

/** Parse an octal ASCII numeric field (space/NUL terminated). Returns 0 if blank. */
function parseOctal(buf: Buffer, off: number, len: number): number {
  // Trim trailing NUL/space and leading NUL/space.
  let s = buf.toString("ascii", off, off + len);
  s = s.replace(/\0/g, " ").trim();
  if (s.length === 0) return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
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
      return "directory";
    case "2":
      return "symlink";
    case "1":
      return "hardlink";
    default:
      // 3/4 device, 6 fifo, and any unknown flag → "other" (containment refuses).
      return "other";
  }
}

/** Parse a `pax` extended-header block body into its key→value records. */
function parsePaxRecords(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let text = body.toString("utf8");
  // Each record: "<len> <key>=<value>\n". `len` counts the whole record incl. the
  // leading length digits and trailing newline.
  while (text.length > 0) {
    const space = text.indexOf(" ");
    if (space === -1) break;
    const len = parseInt(text.slice(0, space), 10);
    if (!Number.isFinite(len) || len <= 0 || len > text.length) break;
    const record = text.slice(space + 1, len - 1); // drop trailing "\n"
    const eq = record.indexOf("=");
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1);
    text = text.slice(len);
  }
  return out;
}

/**
 * Decompress a `.tar.gz` buffer to its uncompressed tar bytes, enforcing the
 * compressed-size cap, the total-uncompressed cap, and the decompression-ratio
 * cap (F9). `maxOutputLength` makes `gunzipSync` itself refuse a bomb before it
 * allocates gigabytes.
 */
export function decompressArchive(compressed: Uint8Array): Buffer {
  if (compressed.byteLength > ARCHIVE_LIMITS.maxCompressedBytes) {
    throw new ArchiveLimitError(
      "maxCompressedBytes",
      `${compressed.byteLength} bytes > ${ARCHIVE_LIMITS.maxCompressedBytes}`
    );
  }
  const input = Buffer.from(
    compressed.buffer,
    compressed.byteOffset,
    compressed.byteLength
  );

  let out: Buffer;
  try {
    out = gunzipSync(input, {
      maxOutputLength: ARCHIVE_LIMITS.maxTotalUncompressedBytes,
    });
  } catch (err) {
    // node:zlib throws ERR_BUFFER_TOO_LARGE when output would exceed
    // maxOutputLength — that is the bomb signal.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ERR_BUFFER_TOO_LARGE") {
      throw new ArchiveLimitError(
        "maxTotalUncompressedBytes",
        `decompressed output exceeds ${ARCHIVE_LIMITS.maxTotalUncompressedBytes} bytes`
      );
    }
    throw new TarParseError(
      `gzip decompression failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Belt to the maxOutputLength braces (in case a runtime does not honour it).
  if (out.byteLength > ARCHIVE_LIMITS.maxTotalUncompressedBytes) {
    throw new ArchiveLimitError(
      "maxTotalUncompressedBytes",
      `${out.byteLength} bytes > ${ARCHIVE_LIMITS.maxTotalUncompressedBytes}`
    );
  }
  // Decompression-ratio guard: a compressed cap alone lets a high-ratio bomb
  // through under the total cap.
  if (
    compressed.byteLength > 0 &&
    out.byteLength / compressed.byteLength >
      ARCHIVE_LIMITS.maxDecompressionRatio
  ) {
    throw new ArchiveLimitError(
      "maxDecompressionRatio",
      `ratio ${(out.byteLength / compressed.byteLength).toFixed(1)} > ` +
        `${ARCHIVE_LIMITS.maxDecompressionRatio}`
    );
  }
  return out;
}

/**
 * Parse uncompressed tar bytes into {@link TarEntry}s, enforcing the entry-count
 * and per-entry-size caps (F9). Handles ustar prefix+name, GNU long names
 * (`L`/`K` typeflags), and `pax` extended headers (`x`/`g`) so real `tar czf`
 * output with deep paths parses correctly.
 */
export function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let off = 0;
  // Pending overrides from a preceding GNU/pax metadata entry.
  let pendingLongName: string | undefined;
  let pendingPax: Record<string, string> = {};
  let globalPax: Record<string, string> = {};

  while (off + BLOCK <= buf.byteLength) {
    if (isZeroBlock(buf, off)) {
      break; // end-of-archive (first zero block is sufficient for our purposes)
    }

    const typeflag = String.fromCharCode(buf[off + 156]);
    const size = parseOctal(buf, off + 124, 12);
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

    // --- GNU long name / long linkname ---
    if (typeflag === "L") {
      pendingLongName = readStr(body, 0, body.byteLength).replace(/\0+$/, "");
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
      pendingPax = parsePaxRecords(body);
      off += advance;
      continue;
    }
    if (typeflag === "g") {
      globalPax = { ...globalPax, ...parsePaxRecords(body) };
      off += advance;
      continue;
    }

    // --- regular member ---
    const name = readStr(buf, off, 100);
    const prefix = readStr(buf, off + 345, 155);
    let path =
      pendingPax.path ??
      globalPax.path ??
      pendingLongName ??
      (prefix ? `${prefix}/${name}` : name);
    path = path.replace(/\0+$/, "");

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
    pendingPax = {};
    off += advance;
  }

  return entries;
}

/** Decompress + parse a `.tar.gz` in one call. */
export function parseTarGz(compressed: Uint8Array): TarEntry[] {
  return parseTar(decompressArchive(compressed));
}
