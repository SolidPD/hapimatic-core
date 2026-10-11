// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Agent-peek transcript pager (issue #4386, R2/R3/R5/R8).
 *
 * Reads one background agent's `subagents/agent-<id>.jsonl` from the owning
 * node's disk and serves it NEWEST-FIRST, one bounded page at a time, through
 * the same transcript-serve seam the transcript browser uses — the per-entry
 * 8 KB scrub-then-cut (`truncateToolResults`) and `DecryptedMessage` adapter
 * (`transcriptEntryToMessage`), so R8 (a 1 MB+ transcript opens without
 * freezing) holds and the peek carries the SAME scrub (`scrubTranscriptSecrets`,
 * #4053 + the #4386 approval-nonce pattern) as the browser.
 *
 * Two paging axes (mutually exclusive, the route schema enforces it):
 *   - `before` (default): a cached kept-entry byte-offset index serves the last
 *     `limit` kept entries before the cursor; the response's `before` cursor
 *     loads the next OLDER page ("Load earlier · N more"). Append-stable: a new
 *     entry gets a higher ordinal and never shifts an older one, so an in-flight
 *     `before` cursor stays valid.
 *   - `after` (live-tail, #4388): delegates to `readTranscriptPage` with
 *     `holdUnterminatedTail` so a poll landing on a half-written last line
 *     re-reads it whole next time. Returns `nextCursor ?? endCursor` so the poll
 *     always has a cursor even at end of file.
 *
 * Security (why this issue is risk: high): `agentId` is `^[A-Za-z0-9_-]{1,64}$`
 * and the resolved file's realpath must stay inside the realpath of
 * `subagentsDir` — a traversal or a symlinked file answers 400, never serves.
 */

import {
  createReadStream,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, sep } from "node:path";
import { createInterface } from "node:readline";
import { scrubTranscriptSecrets } from "@hapi/protocol";
import {
  TRANSCRIPT_MESSAGES_PAGE,
  type DecryptedMessage,
} from "@hapi/protocol/schemas";
import { INDEXED_ENTRY_TYPES } from "../../services/transcriptIndexer";
import {
  parseTranscriptCursor,
  readTranscriptPage,
  transcriptEntryToMessage,
  truncateToolResults,
} from "../../web/routes/transcripts";
import { isValidAgentId } from "../agentId";
import { sumAgentTranscriptUsage } from "./transcriptParser";

const DEFAULT_LIMIT = 50;

export interface AgentTranscriptTokens {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface AgentTranscriptPageQuery {
  limit?: number;
  /** Newest-first older-page cursor `<seq>:<byteOffset>`. */
  before?: string;
  /** Forward (live-tail) cursor `<seq>:<byteOffset>`; mutually exclusive with `before`. */
  after?: string;
  /** Serve one entry untruncated (only with `limit=1` + `after`). */
  full?: boolean;
}

export interface AgentTranscriptPageResult {
  messages: DecryptedMessage[];
  /** Cursor for the next OLDER page, or null at the start of the transcript. */
  before: string | null;
  /** Kept entries still older than the oldest one served (for "Load earlier · N more"). */
  remaining: number;
  /** Forward resume cursor (the #4388 live-tail seam); always a valid cursor. */
  nextCursor: string;
  truncatedToolResults: Record<string, { seq: number; chars: number }>;
  tokens: AgentTranscriptTokens;
  agentType: string | null;
  description: string | null;
}

export type AgentTranscriptPageOutcome =
  | { ok: true; page: AgentTranscriptPageResult }
  | { ok: false; status: 400 | 404 | 500; error: string };

/** Same keep-rule as `transcripts.ts` (INDEXED_ENTRY_TYPES), reimplemented to avoid exporting it. */
function isKeptEntry(entry: unknown): entry is Record<string, unknown> {
  if (!entry || typeof entry !== "object") return false;
  const type = (entry as Record<string, unknown>).type;
  return typeof type === "string" && INDEXED_ENTRY_TYPES.has(type);
}

interface AgentIndex {
  /** Byte offset of each kept entry's line start, oldest-first. */
  offsets: number[];
  totalKept: number;
  /** File size at index time — the forward (live-tail) cursor anchor. */
  fileSize: number;
  tokens: AgentTranscriptTokens;
}

const indexCache = new Map<
  string,
  { size: number; mtimeMs: number; index: AgentIndex }
>();

/**
 * Build (or reuse) the kept-entry byte-offset index for `path`, keyed by
 * (size, mtime). One full read on a cache miss walks the file as bytes to record
 * each kept entry's start offset; a page then reads only its own byte range. The
 * token sum is computed once here via the exported `sumAgentTranscriptUsage` so
 * every consumer shares ONE token-fold implementation (#4386 verify).
 */
function getIndex(path: string): AgentIndex {
  const st = statSync(path);
  const cached = indexCache.get(path);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
    return cached.index;
  }
  const buf = readFileSync(path);
  const offsets: number[] = [];
  let lineStart = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0x0a) {
      if (i > lineStart) {
        const line = buf.toString("utf8", lineStart, i);
        if (line.trim()) {
          let entry: unknown = null;
          try {
            entry = JSON.parse(line);
          } catch {
            entry = null;
          }
          if (isKeptEntry(entry)) offsets.push(lineStart);
        }
      }
      lineStart = i + 1;
    }
  }
  const index: AgentIndex = {
    offsets,
    totalKept: offsets.length,
    fileSize: buf.length,
    tokens: sumAgentTranscriptUsage(path),
  };
  indexCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, index });
  return index;
}

/** Test seam — drop the index cache between cases. */
export function resetAgentIndexCache(): void {
  indexCache.clear();
}

/** True when `candidate` resolves inside `dir` (both realpath'd by the caller). */
function isInside(realDir: string, realFile: string): boolean {
  return realFile === realDir || realFile.startsWith(realDir + sep);
}

/** Read `agent-<id>.meta.json`'s scrubbed agentType + description; absent → nulls. */
function readAgentMeta(
  subagentsDir: string,
  agentId: string,
  literals: readonly string[]
): { agentType: string | null; description: string | null } {
  const metaPath = join(subagentsDir, `agent-${agentId}.meta.json`);
  if (!existsSync(metaPath)) return { agentType: null, description: null };
  // Defense-in-depth: a symlinked meta must not read outside subagentsDir.
  try {
    const realDir = realpathSync(subagentsDir);
    if (!isInside(realDir, realpathSync(metaPath))) {
      return { agentType: null, description: null };
    }
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
      agentType?: unknown;
      description?: unknown;
    };
    const scrub = (v: unknown): string | null =>
      typeof v === "string" ? scrubTranscriptSecrets(v, literals) : null;
    return {
      agentType: scrub(meta.agentType),
      description: scrub(meta.description),
    };
  } catch {
    return { agentType: null, description: null };
  }
}

/**
 * Serve one page of an agent sub-transcript (see module header). Returns a typed
 * outcome the route maps to a status code (400 invalid agentId / traversal, 404
 * missing file, 500 unreadable with NO path in the message).
 */
export async function agentTranscriptPage(opts: {
  subagentsDir: string;
  ccSessionId: string;
  agentId: string;
  query: AgentTranscriptPageQuery;
  literals: readonly string[];
}): Promise<AgentTranscriptPageOutcome> {
  const { subagentsDir, ccSessionId, agentId, query, literals } = opts;

  if (!isValidAgentId(agentId)) {
    return { ok: false, status: 400, error: "invalid agentId" };
  }
  const agentFile = join(subagentsDir, `agent-${agentId}.jsonl`);
  if (!existsSync(agentFile)) {
    return { ok: false, status: 404, error: "agent transcript not found" };
  }
  // Path-traversal guard (the reason this issue is risk: high).
  try {
    const realDir = realpathSync(subagentsDir);
    const realFile = realpathSync(agentFile);
    if (!isInside(realDir, realFile)) {
      return { ok: false, status: 400, error: "invalid agent transcript path" };
    }
  } catch {
    return { ok: false, status: 404, error: "agent transcript not found" };
  }

  const limit = Math.min(
    query.limit ?? DEFAULT_LIMIT,
    TRANSCRIPT_MESSAGES_PAGE
  );
  const full = query.full === true;

  try {
    const index = getIndex(agentFile);
    const { agentType, description } = readAgentMeta(
      subagentsDir,
      agentId,
      literals
    );

    // Forward / live-tail path (#4388 seam) — append-safe held-tail read.
    if (query.after !== undefined) {
      const { afterSeq, offset } = parseTranscriptCursor(query.after);
      const page = await readTranscriptPage(agentFile, ccSessionId, {
        afterSeq,
        offset,
        limit,
        full,
        literals,
        holdUnterminatedTail: true,
      });
      return {
        ok: true,
        page: {
          messages: page.messages,
          before: null,
          remaining: 0,
          nextCursor: page.nextCursor ?? page.endCursor,
          truncatedToolResults: page.truncatedToolResults,
          tokens: index.tokens,
          agentType,
          description,
        },
      };
    }

    // Newest-first path (the default the peek opens with). `endIdx` is the
    // EXCLUSIVE upper bound into the oldest-first offsets array.
    const endIdx = query.before
      ? Math.max(0, parseTranscriptCursor(query.before).afterSeq - 1)
      : index.totalKept;
    const startIdx = Math.max(0, endIdx - limit);

    const messages: DecryptedMessage[] = [];
    const truncatedToolResults: Record<string, { seq: number; chars: number }> =
      {};
    if (endIdx > startIdx) {
      const rangeStart = index.offsets[startIdx] ?? 0;
      const rangeEnd =
        endIdx < index.totalKept ? index.offsets[endIdx] : index.fileSize;
      let k = 0;
      const lines = createInterface({
        input: createReadStream(agentFile, {
          encoding: "utf8",
          start: rangeStart,
          end: Math.max(rangeStart, rangeEnd - 1),
        }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (k >= endIdx - startIdx) break;
        if (!line.trim()) continue;
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isKeptEntry(entry)) continue;
        const seq = startIdx + k + 1; // 1-based kept-entry ordinal
        k += 1;
        if (!full)
          truncateToolResults(entry, seq, truncatedToolResults, literals);
        const msg = transcriptEntryToMessage(entry, seq, ccSessionId, literals);
        if (msg) messages.push(msg);
      }
      lines.close();
    }

    const before =
      startIdx > 0 ? `${startIdx + 1}:${index.offsets[startIdx]}` : null;
    return {
      ok: true,
      page: {
        messages,
        before,
        remaining: startIdx,
        // Forward resume at the current end of file (the #4388 live-tail seam).
        nextCursor: `${index.totalKept}:${index.fileSize}`,
        truncatedToolResults,
        tokens: index.tokens,
        agentType,
        description,
      },
    };
  } catch {
    // No path in the message — a 500 must not leak the on-disk location.
    return { ok: false, status: 500, error: "could not read agent transcript" };
  }
}
