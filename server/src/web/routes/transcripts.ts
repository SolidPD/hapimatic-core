// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from "hono";
import {
  closeSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  defineCapability,
  scrubThenCap,
  scrubTranscriptSecrets,
  scrubTranscriptValue,
} from "@hapi/protocol";
import {
  TRANSCRIPT_MESSAGES_BYTE_BUDGET,
  TRANSCRIPT_MESSAGES_PAGE,
  TRANSCRIPT_TOOL_RESULT_SERVE_CAP,
  TranscriptMessagesQuerySchema,
  TranscriptListQuerySchema,
  TranscriptResumeRequestSchema,
  type DecryptedMessage,
  type TranscriptResumeResponse,
  type TranscriptSummary,
} from "@hapi/protocol/schemas";
import type { SyncEngine } from "../../sync/syncEngine";
import { resolveTranscriptPaths } from "../../sync/transcript/transcriptPath";
import {
  INDEXED_ENTRY_TYPES,
  getTranscriptIndexState,
  getTranscriptIndexer,
  repoRootOf,
  type TranscriptIndexState,
  toMs,
  type TranscriptIndexer,
} from "../../services/transcriptIndexer";
import type { WebAppEnv } from "../middleware/auth";
import { cataloged } from "../../capabilities/cataloged";
import { getKnownSecretLiterals } from "../../services/knownSecretLiterals";

/**
 * Transcript-browser routes (issue #3839) — the `/settings/transcripts` archive
 * of every Claude-harness transcript ever run on this node.
 *
 * **Namespace-scoped (D27, OPERATOR-RULED 2026-09-23).** Every route reads
 * `c.get("namespace")` and resolves rows through the index store's scope
 * predicate — exactly the session tier (`store/sessions.ts:314`; server/CLAUDE.md
 * "Federation Authorization Model" steps 3-4): a transcript in another
 * namespace answers 404, never 403, so existence does not leak. Orphans (their
 * session row already deleted) are served only to the node's owning namespace.
 *
 * **Scrub before serve (R6).** List rows and snippets come from the index,
 * which only ever stored scrubbed text; the messages route re-reads the JSONL
 * from disk and passes every adapted message through `scrubTranscriptValue`
 * (#4053) — a value-level walk that masks everything `scrubString` masks plus
 * transcript-only classes and this node's known instance tokens — before it
 * leaves the server. An entry whose scrub throws is replaced, never served raw.
 *
 * **Sensitive reads (#3837 F.16 R12).** The two content-bearing GETs (search
 * with snippets, messages) are catalogued `riskTier: "mutating"` + listed in
 * `SENSITIVE_READ_MATCHERS`, so the generic capability invoker can never
 * auto-launch them.
 *
 * **Resume (R4, D28 OPERATOR-RULED).** A transcript whose session row is the
 * one currently resuming it goes through `engine.reconnectSession`; otherwise
 * (an orphan, or an older resume-chain file) the resume is a fresh
 * `spawnSession({ resumeSessionId })`. When the transcript's cwd is gone the
 * policy is: FIRST restore a soft-deleted worktree to its original path (the
 * `recover-worktree` daemon RPC), THEN — only when nothing was restorable —
 * answer `needsDirectory` so the client opens the picker; the chosen directory
 * gets a copy of the JSONL under its own slug before the spawn. No silent
 * fallback. The target directory always exists before `spawnSession` (the
 * daemon refuses a missing cwd, `sessionSpawner.ts:634-655`).
 */

/** Scrubs one adapted message's content for serving. Injectable for tests. */
export type TranscriptScrubber = (
  value: unknown,
  literals: readonly string[]
) => unknown;

/**
 * Stand-in content for an entry whose scrub threw (#4053): an agent `system`
 * event the reader already renders as a neutral line. FAIL CLOSED — the raw
 * entry is never served in its place.
 */
const SCRUB_FAILED_CONTENT = {
  role: "agent",
  content: {
    type: "output",
    data: { type: "system", subtype: "hapi_scrub_failed" },
  },
} as const;

/**
 * Re-scrub an index row's text fields at serve time (#4053). Rows indexed
 * before the transcript-scoped patterns existed still carry the old
 * `scrubString` output, so the serve seam masks the broader set itself rather
 * than trusting the index to be current.
 */
function scrubSummary<T extends TranscriptSummary>(
  row: T,
  literals: readonly string[]
): T {
  const f = (v: string | null): string | null =>
    v === null ? null : scrubTranscriptSecrets(v, literals);
  return {
    ...row,
    title: f(row.title),
    firstPrompt: f(row.firstPrompt),
    snippet: f(row.snippet),
  };
}

/** This node's known instance tokens (cached by the service). */
const defaultLiterals = (): readonly string[] =>
  getKnownSecretLiterals({ ownToken: null });

/**
 * Adapt one raw JSONL entry to the renderer's `DecryptedMessage` input.
 * Human-typed text → the `normalizeUserRecord` shape; everything else (assistant
 * turns, tool results, summaries, system events, meta user records) → the CLI's
 * own persisted wrapper `{role:"agent", content:{type:"output", data}}`
 * (`cli/src/api/apiSession.ts`), which `normalizeAgent.ts` already dispatches.
 */
export function transcriptEntryToMessage(
  entry: Record<string, unknown>,
  seq: number,
  ccSessionId: string,
  literals: readonly string[] = [],
  scrub: TranscriptScrubber = scrubTranscriptValue
): DecryptedMessage | null {
  const type = entry.type;
  if (typeof type !== "string" || !INDEXED_ENTRY_TYPES.has(type)) return null;
  const id =
    typeof entry.uuid === "string" ? entry.uuid : `${ccSessionId}:${seq}`;
  const createdAt = toMs(entry.timestamp) ?? 0;
  const message = entry.message as Record<string, unknown> | undefined;
  const isHumanText =
    type === "user" &&
    entry.isMeta !== true &&
    typeof message?.content === "string";
  const content = isHumanText
    ? { role: "user", content: { type: "text", text: message?.content } }
    : { role: "agent", content: { type: "output", data: entry } };
  let scrubbed: unknown;
  try {
    // Value-level scrub (#4053): the regexes see decoded strings, never JSON.
    scrubbed = scrub(content, literals);
  } catch {
    console.error(`[Transcripts] scrub failed for ${ccSessionId} seq ${seq}`);
    scrubbed = SCRUB_FAILED_CONTENT;
  }
  return { id, seq, localId: null, createdAt, content: scrubbed };
}

/** A page of a transcript's scrubbed messages (#4053). */
export interface TranscriptPage {
  messages: DecryptedMessage[];
  nextCursor: string | null;
  truncatedToolResults: Record<string, { seq: number; chars: number }>;
  /**
   * #4386: `<kept entries consumed>:<byte offset after the last newline-
   * terminated line processed>`. Always present. Unlike `nextCursor` (null at
   * end of file) this always resumes the read, so a live-tail poll
   * (`nextCursor ?? endCursor`) never runs out of a cursor to poll with.
   */
  endCursor: string;
}

export interface TranscriptPageOptions {
  /** Kept entries already served (the next entry gets `afterSeq + 1`). */
  afterSeq?: number;
  /** Byte offset where the next unread line starts (fast-path hint). */
  offset?: number;
  limit?: number;
  byteBudget?: number;
  /** Serve tool results untruncated (the expand-on-demand read). */
  full?: boolean;
  literals?: readonly string[];
  /**
   * #4386: treat a final line with no trailing newline as still being written —
   * do not parse it, do not advance past it, and point `endCursor` at its start.
   * Default false, so the transcript browser's paging is unchanged; the agent
   * live-tail path (`after=`) sets it so a poll landing mid-write re-reads the
   * line whole on the next poll instead of losing it.
   */
  holdUnterminatedTail?: boolean;
}

/** Parse an opaque `<afterSeq>:<byteOffset>` cursor (schema-validated shape). */
export function parseTranscriptCursor(cursor: string | undefined): {
  afterSeq: number;
  offset: number;
} {
  if (!cursor) return { afterSeq: 0, offset: 0 };
  const [seq, offset] = cursor.split(":").map(Number);
  return { afterSeq: seq, offset };
}

/** True when `offset` is 0 or immediately follows a newline in `path`. */
function isLineStart(path: string, offset: number): boolean {
  if (offset === 0) return true;
  let fd: number | null = null;
  try {
    if (offset > statSync(path).size) return false;
    fd = openSync(path, "r");
    const buf = Buffer.alloc(1);
    return readSync(fd, buf, 0, 1, offset - 1) === 1 && buf[0] === 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function isKeptEntry(entry: unknown): entry is Record<string, unknown> {
  if (!entry || typeof entry !== "object") return false;
  const type = (entry as Record<string, unknown>).type;
  return typeof type === "string" && INDEXED_ENTRY_TYPES.has(type);
}

/**
 * Cut oversize tool results in a freshly parsed entry (mutates it) and record
 * each cut under its tool_use id. `toolUseResult` wins over `tool_result`
 * content in the renderer (`normalizeAgent.ts`), so an oversize one is DROPPED
 * — the (already cut) block content then shows — rather than replaced.
 */
export function truncateToolResults(
  entry: Record<string, unknown>,
  seq: number,
  out: Record<string, { seq: number; chars: number }>,
  literals: readonly string[]
): void {
  const message = entry.message as Record<string, unknown> | undefined;
  const parts = message?.content;
  if (entry.type !== "user" || !Array.isArray(parts)) return;
  const cap = TRANSCRIPT_TOOL_RESULT_SERVE_CAP;
  const ids: string[] = [];
  let longest = 0;
  for (const part of parts as Array<Record<string, unknown>>) {
    if (!part || part.type !== "tool_result") continue;
    const id = typeof part.tool_use_id === "string" ? part.tool_use_id : null;
    let cut = 0;
    if (typeof part.content === "string" && part.content.length > cap) {
      cut = part.content.length;
      // Scrub, then cut: a secret straddling the cut must not survive as an
      // unmatched fragment (the full-value scrub later sees only the prefix).
      part.content = scrubThenCap(part.content, cap, literals);
    } else if (Array.isArray(part.content)) {
      for (const inner of part.content as Array<Record<string, unknown>>) {
        if (typeof inner?.text === "string" && inner.text.length > cap) {
          cut = Math.max(cut, inner.text.length);
          inner.text = scrubThenCap(inner.text, cap, literals);
        }
      }
    }
    if (id) ids.push(id);
    if (cut > 0 && id) out[id] = { seq, chars: cut };
    longest = Math.max(longest, cut);
  }
  if (entry.toolUseResult !== undefined) {
    const size = JSON.stringify(entry.toolUseResult)?.length ?? 0;
    if (size > cap) {
      delete entry.toolUseResult;
      for (const id of ids) {
        out[id] = { seq, chars: Math.max(out[id]?.chars ?? 0, size, longest) };
      }
    }
  }
}

/**
 * Stream ONE page of a transcript as scrubbed messages (read-only, #4053). A
 * page stops at `limit` entries or `byteBudget` serialized bytes (always at
 * least one entry), so a response never scales with the file.
 *
 * Cursor fast path: resume reading at the byte `offset` when it is a line
 * start (JSONL is append-only, so a line-boundary offset stays valid while a
 * live transcript grows). Otherwise FALL BACK to skipping the first `afterSeq`
 * kept entries from the top (parse + type check only) — a bad offset costs
 * time, never correctness.
 */
export async function readTranscriptPage(
  path: string,
  ccSessionId: string,
  opts: TranscriptPageOptions = {}
): Promise<TranscriptPage> {
  const afterSeq = opts.afterSeq ?? 0;
  const limit = opts.limit ?? TRANSCRIPT_MESSAGES_PAGE;
  const budget = opts.byteBudget ?? TRANSCRIPT_MESSAGES_BYTE_BUDGET;
  const literals = opts.literals ?? [];
  const fastPath = (opts.offset ?? 0) > 0 && isLineStart(path, opts.offset!);
  let pos = fastPath ? opts.offset! : 0;
  let seq = fastPath ? afterSeq : 0;
  // #4386: only stat the file when we need the held-tail boundary, so the hot
  // transcript-browser path (holdUnterminatedTail off) adds no extra syscall.
  const hold = opts.holdUnterminatedTail === true;
  const fileSize = hold ? statSync(path).size : Infinity;
  const messages: DecryptedMessage[] = [];
  const truncatedToolResults: TranscriptPage["truncatedToolResults"] = {};
  let bytes = 0;
  let nextCursor: string | null = null;
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8", start: pos }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const lineStart = pos;
    // #4386: a final line with no trailing newline is still being written under
    // `holdUnterminatedTail`. Break WITHOUT advancing `pos`, so `endCursor`
    // points at the line's start and the next poll re-reads it whole.
    if (hold && lineStart + Buffer.byteLength(line, "utf8") >= fileSize) break;
    pos += Buffer.byteLength(line, "utf8") + 1;
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isKeptEntry(entry)) continue;
    if (seq < afterSeq) {
      seq += 1; // slow-path skip: no adapt, no scrub
      continue;
    }
    if (messages.length >= limit) {
      nextCursor = `${seq}:${lineStart}`;
      break;
    }
    const cuts: TranscriptPage["truncatedToolResults"] = {};
    if (!opts.full) truncateToolResults(entry, seq + 1, cuts, literals);
    const msg = transcriptEntryToMessage(entry, seq + 1, ccSessionId, literals);
    if (!msg) continue;
    const size = JSON.stringify(msg).length;
    if (messages.length > 0 && bytes + size > budget) {
      nextCursor = `${seq}:${lineStart}`;
      break;
    }
    seq += 1;
    bytes += size;
    messages.push(msg);
    Object.assign(truncatedToolResults, cuts);
  }
  lines.close();
  // #4386: `endCursor` resumes the forward read from the byte offset after the
  // last newline-terminated line processed (or the held tail's start). Always
  // non-null; the agent live-tail returns `nextCursor ?? endCursor`.
  const endCursor = `${seq}:${pos}`;
  return { messages, nextCursor, truncatedToolResults, endCursor };
}

function isExistingDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Put a copy of the transcript under `<cfg>/projects/<slug(target)>/` so
 * `claude --resume <id>` finds it from the new directory. Never overwrites an
 * existing file there; the source JSONL is only read.
 */
function copyTranscriptForDirectory(
  sourcePath: string,
  ccSessionId: string,
  target: string
): void {
  // sourcePath = <cfg>/projects/<slug>/<id>.jsonl → cfg is three levels up.
  const configDir = dirname(dirname(dirname(sourcePath)));
  const dest = resolveTranscriptPaths({
    ccSessionId,
    workingDirectory: target,
    configDir,
  }).main;
  if (dest === sourcePath || existsSync(dest)) return;
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  copyFileSync(sourcePath, dest, constants.COPYFILE_EXCL);
}

export function createTranscriptRoutes(
  getSyncEngine: () => SyncEngine | null,
  getIndexer: () => TranscriptIndexer | null = getTranscriptIndexer,
  getLiterals: () => readonly string[] = defaultLiterals,
  getState: () => TranscriptIndexState = getTranscriptIndexState
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  /**
   * The answer when no indexer instance exists (#4053): a failed start is a
   * distinct 500 (not "starting" forever); a disabled instance with no index
   * answers `indexer_disabled`; otherwise it is genuinely still starting.
   */
  const indexUnavailable = (c: Context<WebAppEnv>): Response => {
    const current = getState();
    if (current === "failed") {
      return c.json(
        {
          error: "Transcript index failed to start",
          code: "indexer_start_failed",
        },
        500
      );
    }
    if (current === "disabled-no-index") {
      return c.json(
        {
          error: "Transcript indexing is disabled on this instance",
          code: "indexer_disabled",
        },
        404
      );
    }
    return c.json({ error: "Transcript index is starting" }, 503);
  };
  const disabledNoIndex = (): boolean => getState() === "disabled-no-index";

  const numQuery = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const strQuery = (raw: string | undefined): string | undefined =>
    raw === undefined || raw === "" ? undefined : raw;

  // GET /transcripts — list + full-text search + filters (namespace-scoped).
  app.get(
    "/transcripts",
    cataloged(
      defineCapability({
        id: "session-introspection.transcripts-list",
        domain: "session-introspection",
        surface: "rest",
        description:
          "List and full-text search this node's Claude transcript archive, deleted sessions included; filter by date, harness, account, repo, linked issue. Namespace-scoped.",
        whenToUse:
          "When finding a past conversation by content or metadata in the transcript browser.",
        invocation: { kind: "rest", method: "GET", path: "/api/transcripts" },
        auth: "jwt",
        // Content-bearing (search snippets) → never readonly (#3837 R12).
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    c => {
      const indexer = getIndexer();
      if (!indexer) {
        if (disabledNoIndex()) {
          return c.json({
            transcripts: [],
            total: 0,
            status: {
              indexed: 0,
              total: 0,
              fts5: false,
              lastSweepAtMs: null,
              disabled: true,
            },
          });
        }
        return indexUnavailable(c);
      }
      const parsed = TranscriptListQuerySchema.safeParse({
        q: strQuery(c.req.query("q")),
        fromMs: numQuery(c.req.query("from")),
        toMs: numQuery(c.req.query("to")),
        harness: strQuery(c.req.query("harness")),
        account: strQuery(c.req.query("account")),
        repo: strQuery(c.req.query("repo")),
        linkedIssue: numQuery(c.req.query("linkedIssue")),
        sort: strQuery(c.req.query("sort")),
        limit: numQuery(c.req.query("limit")),
        offset: numQuery(c.req.query("offset")),
      });
      if (!parsed.success) {
        return c.json(
          { error: "Invalid query", details: parsed.error.issues },
          400
        );
      }
      const scope = indexer.scopeFor(c.get("namespace"));
      const result = indexer.indexStore.query(scope, parsed.data);
      const literals = getLiterals();
      return c.json({
        ...result,
        transcripts: result.transcripts.map(t => scrubSummary(t, literals)),
        status: indexer.status(),
      });
    }
  );

  // GET /transcripts/filter-options — distinct dropdown values (no content).
  app.get(
    "/transcripts/filter-options",
    cataloged(
      defineCapability({
        id: "session-introspection.transcripts-filter-options",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Return the distinct harnesses, accounts, repos and linked issues present in the caller's transcript archive, for the transcript browser's filters.",
        whenToUse: "When populating the transcript browser's filter controls.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/transcripts/filter-options",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const indexer = getIndexer();
      if (!indexer) {
        if (disabledNoIndex()) {
          return c.json({
            harnesses: [],
            accounts: [],
            repos: [],
            linkedIssues: [],
          });
        }
        return indexUnavailable(c);
      }
      const scope = indexer.scopeFor(c.get("namespace"));
      return c.json(indexer.indexStore.filterOptions(scope));
    }
  );

  // GET /transcripts/:ccSessionId/messages — read in place (scrubbed).
  app.get(
    "/transcripts/:ccSessionId/messages",
    cataloged(
      defineCapability({
        id: "session-introspection.transcripts-messages",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Read one archived transcript as renderer-ready messages, secret tokens masked. Works for deleted sessions (disk-backed). Namespace-scoped.",
        whenToUse:
          "When opening a past transcript read-only in the transcript browser.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/transcripts/:ccSessionId/messages",
        },
        auth: "jwt",
        // Historical conversation content → never readonly (#3837 R12).
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const indexer = getIndexer();
      if (!indexer) return indexUnavailable(c);
      const scope = indexer.scopeFor(c.get("namespace"));
      const row = indexer.indexStore.getScoped(
        scope,
        c.req.param("ccSessionId")
      );
      if (!row || !existsSync(row.path)) {
        return c.json({ error: "Transcript not found" }, 404);
      }
      const parsed = TranscriptMessagesQuerySchema.safeParse({
        cursor: strQuery(c.req.query("cursor")),
        limit: numQuery(c.req.query("limit")),
        full: strQuery(c.req.query("full")),
      });
      if (!parsed.success) {
        return c.json(
          { error: "Invalid query", details: parsed.error.issues },
          400
        );
      }
      const { path, ...transcript } = row;
      const literals = getLiterals();
      const { afterSeq, offset } = parseTranscriptCursor(parsed.data.cursor);
      const page = await readTranscriptPage(path, row.ccSessionId, {
        afterSeq,
        offset,
        limit: parsed.data.limit,
        full: parsed.data.full === "1",
        literals,
      });
      return c.json({
        transcript: scrubSummary(transcript, literals),
        ...page,
        truncated: page.nextCursor !== null,
      });
    }
  );

  // POST /transcripts/:ccSessionId/resume — continue a transcript in a session.
  app.post(
    "/transcripts/:ccSessionId/resume",
    cataloged(
      defineCapability({
        id: "session-lifecycle.transcripts-resume",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Continue an archived Claude transcript: reconnect its session, or spawn with --resume after restoring a trashed worktree or taking a chosen directory. Namespace-scoped.",
        whenToUse:
          "When the user resumes a past transcript from the transcript browser.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/transcripts/:ccSessionId/resume",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const indexer = getIndexer();
      const engine = getSyncEngine();
      if (!indexer) return indexUnavailable(c);
      if (!engine) {
        return c.json({ error: "Transcript resume is unavailable" }, 503);
      }
      const namespace = c.get("namespace");
      const row = indexer.indexStore.getScoped(
        indexer.scopeFor(namespace),
        c.req.param("ccSessionId")
      );
      if (!row) return c.json({ error: "Transcript not found" }, 404);
      if (row.harness !== "claude") {
        return c.json(
          { error: "Only Claude-harness transcripts can be resumed" },
          409
        );
      }
      const body = TranscriptResumeRequestSchema.safeParse(
        await c.req.json().catch(() => ({}))
      );
      if (!body.success) {
        return c.json(
          { error: "Invalid request", details: body.error.issues },
          400
        );
      }

      const result = await resumeTranscript(
        engine,
        namespace,
        row,
        body.data.directory
      );
      if ("status" in result) {
        return c.json(
          { error: result.error, code: result.code },
          result.status
        );
      }
      return c.json(result);
    }
  );

  return app;
}

type ResumeFailure = {
  status: 400 | 404 | 409 | 502;
  error: string;
  code?: string;
};

async function resumeTranscript(
  engine: SyncEngine,
  namespace: string,
  row: TranscriptSummary & { path: string },
  chosenDirectory: string | undefined
): Promise<TranscriptResumeResponse | ResumeFailure> {
  // (a) The transcript IS its session's current conversation → reconnect it.
  const session = row.hapiSessionId
    ? engine.getSessionByNamespace(row.hapiSessionId, namespace)
    : undefined;
  if (
    !chosenDirectory &&
    session &&
    session.metadata?.claudeSessionId === row.ccSessionId
  ) {
    const directory = session.metadata?.path ?? row.cwd ?? "";
    if (session.active) {
      return {
        type: "resumed",
        sessionId: session.id,
        via: "reconnect",
        restoredWorktree: false,
        directory,
      };
    }
    const reconnected = await engine.reconnectSession(session.id);
    if (reconnected.type === "success") {
      return {
        type: "resumed",
        sessionId: reconnected.newSessionId,
        via: "reconnect",
        restoredWorktree: false,
        directory,
      };
    }
    // Fallback preservation: a missing cwd falls through to the D28 path
    // below; any other reconnect failure is a real error.
    if (reconnected.code !== "cwd_missing") {
      return {
        status: 502,
        error: reconnected.message,
        code: reconnected.code,
      };
    }
  }

  // (b) Orphan / older chain file / cwd gone → spawn with --resume.
  const machine = engine.getOnlineMachinesByNamespace(namespace)[0];
  if (!machine) {
    return {
      status: 409,
      error: "No online machine to resume on",
      code: "no_machine",
    };
  }

  let directory: string;
  let restoredWorktree = false;
  if (chosenDirectory) {
    // D28 step A: the operator picked a directory. It must already exist.
    if (!isAbsolute(chosenDirectory) || chosenDirectory.includes("\0")) {
      return { status: 400, error: "directory must be an absolute path" };
    }
    directory = resolve(chosenDirectory);
    if (!isExistingDir(directory)) {
      return { status: 400, error: `Directory does not exist: ${directory}` };
    }
    copyTranscriptForDirectory(row.path, row.ccSessionId, directory);
  } else if (row.cwd && isExistingDir(row.cwd)) {
    directory = row.cwd;
  } else {
    // D28 step C: restore a trashed worktree to its ORIGINAL path first.
    const cwd = row.cwd;
    if (cwd && cwd.includes("/.worktrees/")) {
      const recovered = await engine.recoverWorktree(machine.id, cwd);
      if (recovered.ok && isExistingDir(cwd)) {
        directory = cwd;
        restoredWorktree = true;
      } else {
        return needsDirectory(
          machine.id,
          cwd,
          recovered.ok ? "restored path missing" : recovered.error
        );
      }
    } else {
      return needsDirectory(
        machine.id,
        cwd,
        "the transcript's directory no longer exists"
      );
    }
  }

  // The daemon refuses a missing cwd (#956) — assert it before spawning.
  if (!isExistingDir(directory)) {
    return {
      status: 409,
      error: `Directory does not exist: ${directory}`,
      code: "cwd_missing",
    };
  }
  const spawned = await engine.spawnSession({
    machineId: machine.id,
    directory,
    agent: "claude",
    // A resume must run IN the transcript's directory: a defaulted sessionType
    // cuts a fresh worktree for any git repo that is not already a linked
    // worktree, so `--resume` would look under the wrong slug. Every existing
    // resume path pins "simple" (respawnBase.ts, sessionRespawn.ts).
    sessionType: "simple",
    resumeSessionId: row.ccSessionId,
    // Resume spawns skip the daemon's un-pinned account pick (#3023), so bind
    // the node default explicitly — as the create-session form does.
    ...accountOpt(engine),
    ...(row.title ? { name: row.title.slice(0, 80) } : {}),
  });
  if (spawned.type !== "success") {
    return { status: 502, error: spawned.message, code: spawned.code };
  }
  return {
    type: "resumed",
    sessionId: spawned.sessionId,
    via: "spawn",
    restoredWorktree,
    directory,
  };
}

function accountOpt(engine: SyncEngine): { accountUuid?: string } {
  const accountUuid = engine.getNodeActiveAccountUuid();
  return accountUuid ? { accountUuid } : {};
}

function needsDirectory(
  machineId: string,
  cwd: string | null,
  reason: string
): TranscriptResumeResponse {
  const root = cwd ? repoRootOf(cwd) : null;
  return {
    type: "needsDirectory",
    suggestedDirectory: root && isExistingDir(root) ? root : homedir(),
    machineId,
    reason,
  };
}
