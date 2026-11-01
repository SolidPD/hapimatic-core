// SPDX-License-Identifier: MIT AND AGPL-3.0-only
import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { logger } from "@/ui/logger";
import { getProjectPath } from "./path";
import {
  BaseSessionScanner,
  SessionFileScanEntry,
  SessionFileScanResult,
  SessionFileScanStats,
} from "@/modules/common/session/BaseSessionScanner";

/**
 * Known internal Claude Code event types that should be silently skipped.
 * These are written to session JSONL files by Claude Code but are not
 * actual conversation messages - they're internal state/tracking events.
 */
const INTERNAL_CLAUDE_EVENT_TYPES = new Set([
  "file-history-snapshot",
  "change",
  "queue-operation",
]);

/**
 * Issue #6088 (SINK-3): the most bytes one read takes from a transcript. A line
 * longer than this is still read whole (the window grows until it holds a
 * newline). Bounding the read keeps a multi-hundred-MB transcript from being
 * decoded into one string (measured: a 314 MB file peaked at 1,222 MiB read
 * whole, 258 MiB read in windows) and keeps any read under Bun's maximum
 * string length.
 */
export const MAX_READ_WINDOW_BYTES = 16 * 1024 * 1024;

/** Issue #6088 (SINK-2): bound on each per-scanner set of logged rejects. */
const MAX_REJECT_KEYS = 64;

/**
 * Issue #6088 (SINK-2): debug lines per (type, field) per scanner before the
 * rest are suppressed. Each line is a synchronous log write, and a schema break
 * (the #6065 class) rejects every record of a type.
 */
const MAX_REJECT_DEBUG_LINES = 20;

/** Issue #6088 (SINK-2): one transcript line `RawJSONLinesSchema` rejected. */
export type SchemaReject = {
  /**
   * The record's `type`, printable ASCII, at most 64 chars. When there is no
   * string `type` it is a placeholder in angle brackets: `<no type>`, or the
   * JSON type of the value (`<number>`, or `<null>` for a line that is not an
   * object).
   */
  type: string;
  /** Each zod issue as `path:code`, at most 8. */
  paths: string[];
  /**
   * True when the only issue is "no matching discriminator" at `type`: a type
   * the schema does not model (Claude Code writes many, `attachment`,
   * `api-request`, `ai-title` …), and also a record whose `type` is missing or
   * not a string. A modelled type failing is the signal that matters (the
   * #6065 root-cause class).
   */
  unmodelled: boolean;
  /** The record's Claude Code `version`, when present. */
  version: string | null;
  /** The Claude session id the transcript file is named after. */
  claudeSessionId: string | null;
};

export async function createSessionScanner(opts: {
  sessionId: string | null;
  /**
   * Issue #6088 (SINK-1): the id a fresh process was started with
   * `--resume <id>`, read from claudeArgs before the first spawn. The scanner
   * marks every record already in that transcript as processed and starts its
   * cursor at the file's end, so resumed history reaches neither the chat nor
   * any detector. It only seeds: the id becomes current when the SessionStart
   * hook reports it (`onNewSession`), and no watcher is added for it before
   * then. Claude Code 2.1.312 appends a resumed session to the same file under
   * the same id. A `--fork-session` copy in a new file is deduped by the
   * seeded keys only for `onMessage`, and only when it keeps the record uuids;
   * the `onRawLine` tap sees the copy, as it did before #6088. Ignored when
   * `sessionId` is set (that file is seeded instead). The value becomes a file
   * name, so pass only a validated id (`resumeSessionIdFromArgs`).
   */
  resumeSessionId?: string;
  workingDirectory: string;
  onMessage: (message: RawJSONLines) => void;
  /**
   * Issue #1573: the session's resolved account CLAUDE_CONFIG_DIR (from
   * resolveAccountConfigDirForSession). When set, the scanner watches that
   * isolated config dir's projects tree — the same place the account-bound claude
   * child writes — instead of host ~/.claude/projects. Omit (undefined) for
   * host-credential / non-isolated sessions.
   */
  configDir?: string;
  /**
   * Issue #4383: tap EVERY parsed raw transcript line (including the
   * `queue-operation` lines the INTERNAL_CLAUDE_EVENT_TYPES skip drops) so the
   * background-Agent tracker sees the `<task-notification>` enqueue/remove that
   * local mode never forwards through onMessage. Fed ONLY from the incremental
   * parseSessionFile pass, NEVER the initialize() seed read (which replays the
   * whole file and would re-count a resumed session's historical notifications).
   */
  onRawLine?: (raw: Record<string, unknown>) => void;
}) {
  const scanner = new ClaudeSessionScanner({
    sessionId: opts.sessionId,
    resumeSessionId: opts.resumeSessionId,
    workingDirectory: opts.workingDirectory,
    onMessage: opts.onMessage,
    configDir: opts.configDir,
    onRawLine: opts.onRawLine,
  });

  await scanner.start();

  return {
    cleanup: async () => {
      await scanner.cleanup();
    },
    onNewSession: (sessionId: string) => {
      scanner.onNewSession(sessionId);
    },
  };
}

export type SessionScanner = ReturnType<typeof createSessionScanner>;

class ClaudeSessionScanner extends BaseSessionScanner<RawJSONLines> {
  private readonly projectDir: string;
  private readonly onMessage: (message: RawJSONLines) => void;
  private readonly onRawLine?: (raw: Record<string, unknown>) => void;
  private readonly resumeSessionId: string | null;
  private readonly finishedSessions = new Set<string>();
  private readonly pendingSessions = new Set<string>();
  private currentSessionId: string | null;
  private readonly scannedSessions = new Set<string>();
  private readonly reportedRejects = new Set<string>();
  private readonly rejectDebugLines = new Map<string, number>();
  private readonly unmodelledTypesSeen = new Set<string>();
  /** Issue #6088: the resume seed, while it is still running. */
  private resumeSeed: Promise<void> | null = null;
  private resumeSeedFile: string | null = null;

  constructor(opts: {
    sessionId: string | null;
    resumeSessionId?: string;
    workingDirectory: string;
    onMessage: (message: RawJSONLines) => void;
    configDir?: string;
    onRawLine?: (raw: Record<string, unknown>) => void;
  }) {
    super({ intervalMs: 3000 });
    // Issue #1573: resolve the projects dir against the session's account config
    // dir (when isolated) so the scanner watches exactly where the claude child
    // writes — independent of the host-projects symlink.
    this.projectDir = getProjectPath(opts.workingDirectory, opts.configDir);
    this.onMessage = opts.onMessage;
    this.onRawLine = opts.onRawLine;
    this.currentSessionId = opts.sessionId;
    this.resumeSessionId = opts.resumeSessionId ?? null;
  }

  public onNewSession(sessionId: string): void {
    if (this.currentSessionId === sessionId) {
      logger.debug(
        `[SESSION_SCANNER] New session: ${sessionId} is the same as the current session, skipping`
      );
      return;
    }
    if (this.finishedSessions.has(sessionId)) {
      logger.debug(
        `[SESSION_SCANNER] New session: ${sessionId} is already finished, skipping`
      );
      return;
    }
    if (this.pendingSessions.has(sessionId)) {
      logger.debug(
        `[SESSION_SCANNER] New session: ${sessionId} is already pending, skipping`
      );
      return;
    }
    if (this.currentSessionId) {
      this.pendingSessions.add(this.currentSessionId);
    }
    logger.debug(`[SESSION_SCANNER] New session: ${sessionId}`);
    this.currentSessionId = sessionId;
    this.invalidate();
  }

  protected async initialize(): Promise<void> {
    if (this.currentSessionId) {
      // An in-process mode switch: the file is current, so seed before the
      // first scan reads it.
      await this.seedFrom(this.currentSessionId, false);
      return;
    }
    if (!this.resumeSessionId) {
      return;
    }
    // Issue #6088 (SINK-1): a fresh `--resume` process has no current id yet,
    // so seed from the resumed id instead; it stays non-current (unwatched)
    // until the SessionStart hook reports it. Nothing is scanned before then,
    // so the seed runs while claude starts rather than delaying its spawn (a
    // multi-hundred-MB transcript takes seconds); the first scan waits for it
    // (parseSessionFile). The history's end is fixed NOW, before the spawn, so
    // a record the resumed claude appends while the seed is still reading is
    // new, never seeded as history.
    this.resumeSeedFile = this.sessionFilePath(this.resumeSessionId);
    const historyEnd = await stat(this.resumeSeedFile).then(
      s => s.size,
      () => 0
    );
    this.resumeSeed = this.seedFrom(
      this.resumeSessionId,
      true,
      historyEnd
    ).catch(error => {
      logger.debug(`[SESSION_SCANNER] Resume seed failed: ${error}`);
    });
  }

  /**
   * Mark every record already in a session's transcript as processed and put
   * its cursor at the end. Window by window (#6088, SINK-3); never with the
   * onRawLine tap, because the seed read is history (#4383). `endByte`, when
   * given, is where the history ends: nothing past it is seeded, and the
   * cursor ends there even when a read failed (everything before it is
   * history), so a failed seed never brings the replay back.
   */
  private async seedFrom(
    seedId: string,
    resumed: boolean,
    endByte?: number
  ): Promise<void> {
    const sessionFile = this.sessionFilePath(seedId);
    let cursor = 0;
    let seeded = 0;
    for (;;) {
      const { events, nextCursor } = await readSessionLog(
        sessionFile,
        cursor,
        undefined,
        this.onReject,
        endByte
      );
      this.seedProcessedKeys(events.map(entry => messageKey(entry.event)));
      seeded += events.length;
      if (nextCursor <= cursor) {
        break;
      }
      cursor = nextCursor;
    }
    logger.debug(
      `[SESSION_SCANNER] Marking ${seeded} existing messages as processed from session ${seedId}${
        resumed ? " (resumed, #6088)" : ""
      }`
    );
    this.setCursor(sessionFile, endByte !== undefined ? endByte : cursor);
  }

  protected async beforeScan(): Promise<void> {
    this.scannedSessions.clear();
  }

  /**
   * Issue #1573: only watch transcript files that currently exist on disk.
   *
   * The hook reports a transcript id slightly BEFORE claude writes that file, and
   * after a switch/reconnect a stale (now-absent) id can sit in pendingSessions.
   * Without this guard `ensureWatcher` would start a single-file `fs.watch` on a
   * missing path, spinning the `[FILE_WATCHER] … ENOENT … restarting watcher` loop.
   * The 3s interval scan still parses every findSessionFiles() entry regardless of
   * the watcher, so deferring the watcher until the file exists costs no relay — it
   * only suppresses the ENOENT churn. A file that appears later is picked up by
   * ensureWatcher on the next scan tick.
   */
  protected shouldWatchFile(filePath: string): boolean {
    return existsSync(filePath);
  }

  protected async findSessionFiles(): Promise<string[]> {
    const files = new Set<string>();
    for (const sessionId of this.pendingSessions) {
      files.add(this.sessionFilePath(sessionId));
    }
    if (
      this.currentSessionId &&
      !this.pendingSessions.has(this.currentSessionId)
    ) {
      files.add(this.sessionFilePath(this.currentSessionId));
    }
    // Issue #6088 (SINK-3): every watched file stays in the scan, by design.
    // onNewSession skips an id already finished, so a session the user returns
    // to relays its new lines only through this rescan; with byte-offset reads
    // an unchanged file costs a stat or two per tick.
    for (const watched of this.getWatchedFiles()) {
      files.add(watched);
    }
    return [...files];
  }

  protected async parseSessionFile(
    filePath: string,
    cursor: number
  ): Promise<SessionFileScanResult<RawJSONLines>> {
    if (this.resumeSeed) {
      // Issue #6088: the resume seed must finish before any file is read: its
      // keys dedupe a history copy in a new file (a fork), and the base read
      // this file's cursor before the seed had set it.
      await this.resumeSeed;
      this.resumeSeed = null;
      if (filePath === this.resumeSeedFile) {
        cursor = this.getCursor(filePath);
      }
    }
    const sessionId = sessionIdFromPath(filePath);
    if (sessionId) {
      this.scannedSessions.add(sessionId);
    }
    // Issue #4383: pass the raw-line tap ONLY from the incremental pass. The
    // initialize() seed read deliberately does NOT.
    const { events, nextCursor, more } = await readSessionLog(
      filePath,
      cursor,
      this.onRawLine,
      this.onReject
    );
    if (more) {
      // Issue #6088 (SINK-3): this read stopped at the window bound; run the
      // next window straight after this scan instead of waiting for a tick.
      this.invalidate();
    }
    return {
      events,
      nextCursor,
    };
  }

  protected generateEventKey(event: RawJSONLines): string {
    return messageKey(event);
  }

  protected async handleFileScan(
    stats: SessionFileScanStats<RawJSONLines>
  ): Promise<void> {
    for (const message of stats.events) {
      const id = message.type === "summary" ? message.leafUuid : message.uuid;
      logger.debug(
        `[SESSION_SCANNER] Sending new message: type=${message.type}, uuid=${id}`
      );
      this.onMessage(message);
    }
    if (stats.parsedCount > 0) {
      const sessionId = sessionIdFromPath(stats.filePath) ?? "unknown";
      logger.debug(
        `[SESSION_SCANNER] Session ${sessionId}: found=${stats.parsedCount}, skipped=${stats.skippedCount}, sent=${stats.newCount}`
      );
    }
  }

  protected async afterScan(): Promise<void> {
    for (const sessionId of this.scannedSessions) {
      if (this.pendingSessions.has(sessionId)) {
        this.pendingSessions.delete(sessionId);
        this.finishedSessions.add(sessionId);
      }
    }
  }

  /**
   * Issue #6088 (SINK-2): report schema-rejected lines. An unmodelled record
   * type gets one debug line per scanner. A modelled type that fails gets up
   * to MAX_REJECT_DEBUG_LINES debug lines and one server error-log `warn` per
   * (type, field) per scanner. Each of the three sets keeps its first
   * MAX_REJECT_KEYS keys; a type or field seen after that is not logged.
   * `reportError` writes the file log and the server's error_logs, never the
   * terminal (local mode runs the Claude TUI there). No record content is
   * logged.
   */
  private readonly onReject = (reject: SchemaReject): void => {
    if (reject.unmodelled) {
      if (
        this.unmodelledTypesSeen.size < MAX_REJECT_KEYS &&
        !this.unmodelledTypesSeen.has(reject.type)
      ) {
        this.unmodelledTypesSeen.add(reject.type);
        logger.debug(
          `[SESSION_SCANNER] Skipping transcript record type "${reject.type}" (not in the transcript schema; logged once)`
        );
      }
      return;
    }
    const field = reject.paths[0] ?? "<none>";
    const key = `${reject.type} ${field}`;
    const logged = this.rejectDebugLines.get(key) ?? 0;
    if (
      logged < MAX_REJECT_DEBUG_LINES &&
      (logged > 0 || this.rejectDebugLines.size < MAX_REJECT_KEYS)
    ) {
      this.rejectDebugLines.set(key, logged + 1);
      logger.debug(
        `[SESSION_SCANNER] Transcript record rejected by the schema: type=${reject.type} issues=${reject.paths.join(", ")}${
          logged + 1 === MAX_REJECT_DEBUG_LINES
            ? ` (further rejects of this type and field are not logged)`
            : ""
        }`
      );
    }
    if (
      this.reportedRejects.has(key) ||
      this.reportedRejects.size >= MAX_REJECT_KEYS
    ) {
      return;
    }
    this.reportedRejects.add(key);
    logger.reportError({
      message: `Transcript record rejected by the schema: type=${reject.type} field=${field}`,
      category: "transcript-schema-reject",
      severity: "warn",
      // The Claude session id, as the sibling detectors report it.
      sessionId: reject.claudeSessionId,
      context: JSON.stringify({
        type: reject.type,
        paths: reject.paths,
        claudeSessionId: reject.claudeSessionId,
        version: reject.version,
      }),
    });
  };

  private sessionFilePath(sessionId: string): string {
    return join(this.projectDir, `${sessionId}.jsonl`);
  }
}

//
// Helpers
//

function messageKey(message: RawJSONLines): string {
  if (message.type === "user") {
    return message.uuid;
  } else if (message.type === "assistant") {
    return message.uuid;
  } else if (message.type === "summary") {
    return "summary: " + message.leafUuid + ": " + message.summary;
  } else if (message.type === "system") {
    return message.uuid;
  } else {
    throw Error(); // Impossible
  }
}

/** A zod issue, as much of it as describeSchemaReject reads. */
type SchemaIssue = { code: string; path: ReadonlyArray<PropertyKey> };

/**
 * Issue #6088 (SINK-2): summarise a schema rejection without any record
 * content. Exported for tests.
 */
export function describeSchemaReject(
  message: unknown,
  issues: ReadonlyArray<SchemaIssue>,
  filePath: string
): SchemaReject {
  const record =
    typeof message === "object" && message !== null
      ? (message as Record<string, unknown>)
      : null;
  const rawType = record?.type;
  let type: string;
  if (record === null) {
    // Not an object at all: name the line's own JSON type.
    type = `<${message === null ? "null" : typeof message}>`;
  } else if (typeof rawType === "string") {
    type = rawType.replace(/[^\x20-\x7e]/g, "?").slice(0, 64);
  } else {
    type = `<${rawType === undefined ? "no type" : typeof rawType}>`;
  }
  const only = issues.length === 1 ? issues[0] : null;
  const unmodelled =
    only !== null &&
    only.code === "invalid_union" &&
    only.path.length === 1 &&
    only.path[0] === "type";
  const paths = issues
    .slice(0, 8)
    .map(
      issue => `${issue.path.map(String).join(".") || "<root>"}:${issue.code}`
    );
  const rawVersion = record?.version;
  return {
    type,
    paths,
    unmodelled,
    version: typeof rawVersion === "string" ? rawVersion.slice(0, 32) : null,
    claudeSessionId: sessionIdFromPath(filePath),
  };
}

/**
 * Whether a trailing segment (after the last newline) is already a complete
 * JSON record. A record still being written parses as incomplete, so this
 * tells a final record flushed without a newline from a partial write. Only a
 * segment ending in `}` is parsed (every JSONL record is an object).
 */
function isCompleteJsonLine(segment: Buffer): boolean {
  // Check the last non-whitespace byte before decoding, so a long stalled tail
  // costs no decode on each tick.
  let end = segment.length - 1;
  while (
    end >= 0 &&
    (segment[end] === 0x20 || segment[end] === 0x09 || segment[end] === 0x0d)
  ) {
    end--;
  }
  if (end < 0 || segment[end] !== 0x7d) {
    return false;
  }
  try {
    JSON.parse(segment.subarray(0, end + 1).toString("utf-8"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Issue #6088 (SINK-3): read from `from` toward `size`, at most
 * MAX_READ_WINDOW_BYTES at a time, until the bytes read hold a newline or EOF.
 * A single read may return fewer bytes than asked, so each window loops; only
 * the bytes actually read are returned (an allocUnsafe tail is uninitialised).
 */
async function readWindow(
  fd: FileHandle,
  from: number,
  size: number
): Promise<Buffer> {
  const parts: Buffer[] = [];
  let pos = from;
  while (pos < size) {
    const length = Math.min(size - pos, MAX_READ_WINDOW_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const result = await fd.read(
        buffer,
        bytesRead,
        length - bytesRead,
        pos + bytesRead
      );
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
    const part = buffer.subarray(0, bytesRead);
    parts.push(part);
    pos += bytesRead;
    if (bytesRead < length || part.includes(0x0a)) {
      break;
    }
  }
  return parts.length === 1 ? parts[0] : Buffer.concat(parts);
}

/**
 * Incrementally read and parse a session log file (issue #6088, SINK-3; ported
 * from upstream tiann/hapi 95eee432d, tiann/hapi#1081).
 *
 * The cursor is a BYTE OFFSET into the append-only JSONL. Each call stats the
 * file and reads only bytes after the cursor, at most one window (or a single
 * line longer than a window), so the cost is O(new bytes) however large the
 * transcript has grown. A trailing partial line (a write in progress) is left
 * unconsumed until its newline arrives, unless the read reached EOF and the
 * segment is already a complete record flushed without a newline. A file that
 * shrank is re-read from 0 (the base scanner's processed keys absorb the
 * re-sent records), so `nextCursor` can be lower than `startByte`. A missing
 * file, a failed read, no new bytes and an incomplete last line all return no
 * events and a cursor that does not advance, so a transient error never skips
 * content. `more` is true only when this read consumed bytes and more remain
 * past the window. `endByte`, when given, caps the read there (the resume seed
 * reads history only up to the end it saw before the spawn).
 */
export async function readSessionLog(
  filePath: string,
  startByte: number,
  onRawLine?: (raw: Record<string, unknown>) => void,
  onReject?: (reject: SchemaReject) => void,
  endByte?: number
): Promise<{
  events: SessionFileScanEntry<RawJSONLines>[];
  nextCursor: number;
  more: boolean;
}> {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    logger.debug(`[SESSION_SCANNER] Session file not found: ${filePath}`);
    return { events: [], nextCursor: startByte, more: false };
  }
  if (endByte !== undefined && endByte < size) {
    size = endByte;
  }

  let from = startByte;
  if (from > size) {
    from = 0; // the file shrank or was rewritten: re-read from the top
  }
  if (from >= size) {
    return { events: [], nextCursor: size, more: false };
  }

  let chunk: Buffer;
  try {
    const fd = await open(filePath, "r");
    try {
      chunk = await readWindow(fd, from, size);
    } finally {
      await fd.close();
    }
  } catch (error) {
    logger.debug(
      `[SESSION_SCANNER] Failed to read session file ${filePath}: ${error}`
    );
    return { events: [], nextCursor: startByte, more: false };
  }
  const more = from + chunk.length < size;

  // Everything up to and including the last newline is complete lines (0x0a
  // never occurs inside a multi-byte UTF-8 sequence, so this cut is safe).
  let readableEnd = chunk.lastIndexOf(0x0a) + 1;
  const trailing = chunk.subarray(readableEnd);
  if (!more && trailing.length > 0 && isCompleteJsonLine(trailing)) {
    readableEnd = chunk.length;
  }
  if (readableEnd === 0) {
    return { events: [], nextCursor: from, more: false };
  }
  const nextCursor = from + readableEnd;
  const text = chunk.subarray(0, readableEnd).toString("utf-8");

  const messages: SessionFileScanEntry<RawJSONLines>[] = [];
  for (const l of text.split("\n")) {
    try {
      if (l.trim() === "") {
        continue;
      }
      const message = JSON.parse(l);

      // Issue #4383: tap the raw parsed line BEFORE the internal-event skip, so
      // the background-Agent tracker sees the `queue-operation` `<task-notification>`
      // enqueue/remove that onMessage never receives (it is dropped just below).
      // Fail-soft: a tap fault must never break transcript parsing.
      if (onRawLine && typeof message === "object" && message !== null) {
        try {
          onRawLine(message as Record<string, unknown>);
        } catch (tapErr) {
          logger.debug(`[SESSION_SCANNER] onRawLine tap error: ${tapErr}`);
        }
      }

      // Silently skip known internal Claude Code events
      // These are state/tracking events, not conversation messages
      if (message.type && INTERNAL_CLAUDE_EVENT_TYPES.has(message.type)) {
        continue;
      }

      // Dual-schema normalization (R16): newer Claude Code transcripts emit
      // `session_id` (snake_case); legacy ones emit `sessionId` (camelCase).
      // Normalize before schema validation so downstream consumers see a
      // single shape. RawJSONLinesSchema uses .passthrough() so the original
      // `session_id` field is preserved alongside the alias.
      if (
        typeof message === "object" &&
        message !== null &&
        "session_id" in message &&
        !("sessionId" in message)
      ) {
        (message as Record<string, unknown>).sessionId = (
          message as Record<string, unknown>
        ).session_id;
      }

      const parsed = RawJSONLinesSchema.safeParse(message);
      if (!parsed.success) {
        // Issue #6088 (SINK-2): report the rejection; a reporting fault must
        // never break transcript parsing.
        if (onReject) {
          try {
            onReject(
              describeSchemaReject(message, parsed.error.issues, filePath)
            );
          } catch (rejectErr) {
            logger.debug(
              `[SESSION_SCANNER] schema-reject report error: ${rejectErr}`
            );
          }
        }
        continue;
      }
      messages.push({ event: parsed.data });
    } catch (e) {
      logger.debug(`[SESSION_SCANNER] Error processing message: ${e}`);
      continue;
    }
  }
  return { events: messages, nextCursor, more };
}

function sessionIdFromPath(filePath: string): string | null {
  const base = basename(filePath);
  if (!base.endsWith(".jsonl")) {
    return null;
  }
  return base.slice(0, -".jsonl".length);
}
