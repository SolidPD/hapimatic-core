// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Transcript reader: bytes on disk → transcript entries (issue #6264).
 *
 * Split out of `transcriptParser.ts`, which keeps the turn semantics (segmenting,
 * token sums, events). This module owns how a Claude JSONL transcript is read:
 * the whole-file read (`readTranscript`), the per-line parse/admit rules shared by
 * every reader, and the bounded primitives for large files — a backward line scan
 * from EOF in fixed chunks (`scanLinesBackward`) and a forward read of a window
 * (`readEntriesFrom`). All reads are synchronous: they run inside the finalize
 * seam, on the server's only event loop.
 */

import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";

/** A bounded read stopped at a cap before finding what it needed (#6264). */
export interface TranscriptCapHit {
  path: string;
  sizeBytes: number;
  bytesScanned: number;
  reason: "scan-cap" | "parse-budget";
}

/**
 * Knobs for the bounded readers (#6264). Every field defaults to the exported
 * constant; tests pass small values to force the tail path, a short cap, or a
 * tiny chunk. `onCapHit` is how these pure functions report a cap hit — the
 * impure callers log it.
 */
export interface BoundedReadOptions {
  /** Files at or below this size take the full read (today's path). */
  fullReadMaxBytes?: number;
  /** Max bytes read backward from EOF. */
  tailScanMaxBytes?: number;
  /** Max bytes JSON-parsed from the window. */
  tailParseMaxBytes?: number;
  /** Bytes per backward `readSync`. */
  chunkBytes?: number;
  onCapHit?: (hit: TranscriptCapHit) => void;
  /** A read of an existing transcript failed (EACCES, truncation, a parse
   *  bug). The reader still fails open; this is how the cause gets logged.
   *  Not called for a missing file, which is a normal fail-open case. */
  onReadError?: (error: unknown) => void;
}

// ───────────────────────────── entry shape ─────────────────────────────

/**
 * Minimal transcript-entry shape (the "minimal schema" — every field optional,
 * everything else tolerated). We validate only `type` is a string and the line
 * is an object; all field access below is defensive. A heavyweight per-line Zod
 * parse over a full re-read buys no correctness here (every field is
 * optional/passthrough) and costs latency, so the schema is this typed view +
 * the skip-set + the object guard.
 */
export interface TranscriptEntry {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean | null;
  isMeta?: boolean | null;
  isCompactSummary?: boolean | null;
  isVisibleInTranscriptOnly?: boolean | null;
  isApiErrorMessage?: boolean | null;
  subtype?: string | null;
  timestamp?: string | number | null;
  compactMetadata?: Record<string, unknown> | null;
  /** Claude Code's structured tool result on a tool_result-carrying user entry.
   *  #4385: `status: "async_launched"` marks a background `Agent` launch. */
  toolUseResult?: unknown;
  message?: {
    /** Anthropic API message id (`msg_…`) — the #2229 usage-dedup key. */
    id?: string;
    role?: string;
    model?: string;
    usage?: Record<string, unknown>;
    content?: unknown;
  } | null;
}

/**
 * Internal Claude Code event types + Hapimatic bridge entries to skip (verified
 * present in real transcripts). Never parsed as turns/prompts; never counted.
 * Exported for the throughput facts reader (#6164), which skips the same set
 * except `queue-operation` (its prompt-queue events are provenance evidence).
 */
export const SKIP_TYPES: ReadonlySet<string> = new Set([
  // Claude Code internal state/tracking events.
  "file-history-snapshot",
  "change",
  "queue-operation",
  // Hapimatic bridge entries written into the same JSONL stream.
  "attachment",
  "bridge-session",
  "last-prompt",
  "mode",
  "permission-mode",
]);

// ───────────────────────────── reader (Task 2) ─────────────────────────────

/**
 * Full-read the transcript, JSON-parse each non-empty line, skip
 * internal/unknown/malformed entries, normalize `session_id`→`sessionId`, and
 * dedup by `uuid` (R7). Synchronous (B's seam is sync). Returns `[]` when the
 * file is missing — the caller treats that as a fail-open NULL result.
 */
export function readTranscript(path: string): {
  entries: TranscriptEntry[];
  skipped: number;
  /** #4385: true when the file exists but could not be read (EACCES, EISDIR,
   *  …). A missing file (ENOENT) is not a read error. */
  readError?: boolean;
} {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return { entries: [], skipped: 0, readError: code !== "ENOENT" };
  }

  const acc: CollectedEntries = { entries: [], skipped: 0 };
  const seenUuids = new Set<string>();
  for (const line of raw.split("\n")) collectLine(line, seenUuids, acc);
  return acc;
}

interface CollectedEntries {
  entries: TranscriptEntry[];
  skipped: number;
}

/**
 * Add one line to a file-order read: blank lines are ignored, malformed or
 * skipped lines count in `skipped`, uuid copies after the first are dropped.
 * `readTranscript` and `readEntriesFrom` both use this, so a window read and a
 * full read over the same lines cannot drift apart (#6264).
 */
function collectLine(
  line: string,
  seenUuids: Set<string>,
  acc: CollectedEntries
): void {
  const parsed = parseTranscriptLine(line);
  if (parsed === "blank") return;
  const entry =
    parsed === "bad" ? null : acceptTranscriptRecord(parsed, seenUuids);
  if (entry === null) acc.skipped += 1;
  else acc.entries.push(entry);
}

/**
 * JSON-parse one transcript line. `"blank"` is not counted as a skip; `"bad"`
 * (malformed JSON or a non-object) is. Shared by the full and bounded readers
 * so both apply one set of rules (#6264).
 */
function parseTranscriptLine(
  line: string
): Record<string, unknown> | "blank" | "bad" {
  if (line.trim() === "") return "blank";
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return "bad";
  }
  if (typeof obj !== "object" || obj === null) return "bad";
  return obj as Record<string, unknown>;
}

/**
 * Admit a parsed record as a transcript entry, or `null` to skip it: normalize
 * `session_id`→`sessionId`, require a string `type`, drop `SKIP_TYPES`, and dedup
 * by `uuid` (first occurrence wins). Pass `seenUuids = null` to skip the dedup —
 * the bounded readers' newest-first stop tests use that, so a stop can never land
 * on a copy a full read would have dropped (#6264).
 */
function acceptTranscriptRecord(
  rec: Record<string, unknown>,
  seenUuids: Set<string> | null
): TranscriptEntry | null {
  // Dual-schema session_id normalization (legacy camelCase vs current snake).
  if ("session_id" in rec && !("sessionId" in rec)) {
    rec.sessionId = rec.session_id;
  }
  const type = rec.type;
  if (typeof type !== "string" || SKIP_TYPES.has(type)) return null;
  // Dedup by uuid (when present). Entries without a uuid (rare) are kept.
  if (seenUuids !== null) {
    const uuid = typeof rec.uuid === "string" ? rec.uuid : undefined;
    if (uuid !== undefined) {
      if (seenUuids.has(uuid)) return null;
      seenUuids.add(uuid);
    }
  }
  return rec as unknown as TranscriptEntry;
}

// ───────────────────────── bounded reads (#6264) ─────────────────────────
//
// A session's JSONL transcript only grows (195,351 lines / 520 MB on a weeks-old
// PM session), and these readers run synchronously on the server's only event
// loop. Above `TRANSCRIPT_FULL_READ_MAX_BYTES` they read backward from EOF in
// fixed chunks and stop as soon as they have what they need, bounded by a scan
// cap (bytes read) and a parse budget (bytes JSON-parsed).

/** Files at or below this size keep today's full read (about ms2's p90). */
export const TRANSCRIPT_FULL_READ_MAX_BYTES = 4 * 1024 * 1024;
/** Max bytes read backward from EOF by a bounded reader. */
export const TRANSCRIPT_TAIL_SCAN_MAX_BYTES = 64 * 1024 * 1024;
/** Max bytes JSON-parsed by a bounded reader (covers all but 2 of 506 turns on ms2). */
export const TRANSCRIPT_TAIL_PARSE_MAX_BYTES = 16 * 1024 * 1024;
/** `classifyAgentLaunch` parses only lines holding the id, so it may scan further. */
export const TRANSCRIPT_CLASSIFY_SCAN_MAX_BYTES = 256 * 1024 * 1024;
const TRANSCRIPT_TAIL_CHUNK_BYTES = 1024 * 1024;

export interface ResolvedBounds {
  fullReadMaxBytes: number;
  tailScanMaxBytes: number;
  tailParseMaxBytes: number;
  chunkBytes: number;
}

export function resolveBounds(
  opts: BoundedReadOptions | undefined,
  scanDefault: number = TRANSCRIPT_TAIL_SCAN_MAX_BYTES
): ResolvedBounds {
  return {
    fullReadMaxBytes: opts?.fullReadMaxBytes ?? TRANSCRIPT_FULL_READ_MAX_BYTES,
    tailScanMaxBytes: opts?.tailScanMaxBytes ?? scanDefault,
    tailParseMaxBytes:
      opts?.tailParseMaxBytes ?? TRANSCRIPT_TAIL_PARSE_MAX_BYTES,
    chunkBytes: Math.max(
      1,
      Math.floor(opts?.chunkBytes ?? TRANSCRIPT_TAIL_CHUNK_BYTES)
    ),
  };
}

/** Size of the file at `path`, or null when it is missing or cannot be stat'd. */
function fileSizeOrNull(path: string): number | null {
  try {
    const st = statSync(path, { throwIfNoEntry: false });
    return st && st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/** True for the error a vanished transcript raises — a normal fail-open case
 *  that `onReadError` does not report. */
export function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** True when the file is big enough to take a bounded read. A file that cannot be
 *  stat'd takes the full read, whose ENOENT / readError handling is the contract. */
export function useBoundedRead(
  path: string,
  fullReadMaxBytes: number
): boolean {
  const size = fileSizeOrNull(path);
  return size !== null && size > fullReadMaxBytes;
}

function readExactly(fd: number, buf: Buffer, position: number): void {
  let done = 0;
  while (done < buf.length) {
    const n = readSync(fd, buf, done, buf.length - done, position + done);
    if (n <= 0) throw new Error("transcript read ended early");
    done += n;
  }
}

/**
 * Visit the complete lines of `path` newest first, reading backward from EOF in
 * `chunkBytes` chunks. Splitting on byte 0x0a is UTF-8 safe (a newline byte never
 * occurs inside a multibyte sequence), and each line is handed over whole, so a
 * caller decodes complete lines only. A line spanning several chunks is kept as a
 * list of views and joined once. The final line counts even without a trailing
 * newline, as in a full read. With `needle`, only lines containing it are visited
 * (a per-line test, so a needle across a chunk boundary is still found). Stops
 * when `visit` returns "stop" or when `maxBytes` have been read (`hitCap`).
 */
export function scanLinesBackward(
  path: string,
  visit: (line: Buffer, lineStart: number) => "stop" | "continue",
  opts: { maxBytes: number; chunkBytes: number; needles?: Buffer[] }
): { sizeBytes: number; bytesScanned: number; hitCap: boolean } {
  const fd = openSync(path, "r");
  try {
    const sizeBytes = fstatSync(fd).size;
    let pos = sizeBytes;
    // Bytes of the line currently being assembled, in file order.
    let partial: Buffer[] = [];
    const emit = (line: Buffer, lineStart: number): "stop" | "continue" => {
      if (line.length === 0) return "continue";
      if (
        opts.needles !== undefined &&
        !opts.needles.some(n => line.indexOf(n) !== -1)
      ) {
        return "continue";
      }
      return visit(line, lineStart);
    };
    const join = (head: Buffer): Buffer =>
      partial.length === 0 ? head : Buffer.concat([head, ...partial]);

    while (pos > 0) {
      if (sizeBytes - pos >= opts.maxBytes) {
        return { sizeBytes, bytesScanned: sizeBytes - pos, hitCap: true };
      }
      const len = Math.min(opts.chunkBytes, pos);
      const buf = Buffer.allocUnsafe(len);
      readExactly(fd, buf, pos - len);
      pos -= len;
      let end = len;
      while (end > 0) {
        const nl = buf.lastIndexOf(0x0a, end - 1);
        if (nl === -1) break;
        const line = join(buf.subarray(nl + 1, end));
        partial = [];
        if (emit(line, pos + nl + 1) === "stop") {
          return { sizeBytes, bytesScanned: sizeBytes - pos, hitCap: false };
        }
        end = nl;
      }
      if (end > 0) partial.unshift(buf.subarray(0, end));
    }
    // The first line of the file has no newline before it.
    if (partial.length > 0) emit(join(Buffer.alloc(0)), 0);
    return { sizeBytes, bytesScanned: sizeBytes, hitCap: false };
  } finally {
    closeSync(fd);
  }
}

/** Parse the bytes `[start, EOF)` as transcript lines in file order, with a fresh
 *  first-occurrence dedup set — the same rules as `readTranscript`. */
export function readEntriesFrom(
  path: string,
  start: number
): { entries: TranscriptEntry[]; skipped: number } {
  const fd = openSync(path, "r");
  let buf: Buffer;
  try {
    const size = fstatSync(fd).size;
    buf = Buffer.allocUnsafe(Math.max(0, size - start));
    if (buf.length > 0) readExactly(fd, buf, start);
  } finally {
    closeSync(fd);
  }
  const acc: CollectedEntries = { entries: [], skipped: 0 };
  const seenUuids = new Set<string>();
  let lineStart = 0;
  while (lineStart <= buf.length) {
    let nl = buf.indexOf(0x0a, lineStart);
    if (nl === -1) nl = buf.length;
    collectLine(buf.toString("utf8", lineStart, nl), seenUuids, acc);
    lineStart = nl + 1;
  }
  return acc;
}

/**
 * Parse and admit one line from a backward scan WITHOUT uuid dedup, or `null`
 * for a blank, malformed or skipped line. The bounded readers' stop tests use
 * this, so a stop can never land on a copy a full read would have dropped.
 */
export function admitScannedLine(line: Buffer): TranscriptEntry | null {
  const parsed = parseTranscriptLine(line.toString("utf8"));
  if (parsed === "blank" || parsed === "bad") return null;
  return acceptTranscriptRecord(parsed, null);
}

/**
 * Which of `needles` occur anywhere in the file at `path`, found by a forward
 * scan in `chunkBytes` chunks (#6264). Each chunk is searched together with the
 * last `longest needle - 1` bytes of the one before, so a match that spans a
 * chunk boundary is still found, and no more than about one chunk is held at a
 * time. Stops once every needle has been found. Returns the indexes of the
 * needles found. Throws on an I/O error; callers own the fail-open.
 */
export function findNeedlesInFile(
  path: string,
  needles: Buffer[],
  chunkBytes: number = TRANSCRIPT_TAIL_CHUNK_BYTES
): Set<number> {
  const found = new Set<number>();
  if (needles.length === 0) return found;
  const overlap = Math.max(...needles.map(n => n.length)) - 1;
  const step = Math.max(1, Math.floor(chunkBytes));
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    let pos = 0;
    while (pos < size && found.size < needles.length) {
      const chunk = Buffer.allocUnsafe(Math.min(step, size - pos));
      readExactly(fd, chunk, pos);
      pos += chunk.length;
      const window = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      needles.forEach((needle, i) => {
        if (!found.has(i) && window.indexOf(needle) !== -1) found.add(i);
      });
      carry = window.subarray(Math.max(0, window.length - overlap));
    }
    return found;
  } finally {
    closeSync(fd);
  }
}
