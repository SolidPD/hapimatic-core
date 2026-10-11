// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Finalize-time transcript parser (issue #1665, epic #1662 — Sub C).
 *
 * The canonical, launcher-agnostic extraction path (R13): at turn finalize it
 * re-reads the session's JSONL transcript and derives the turn's billable token
 * totals, model, context occupancy, `prompt_msg_uuid` backfill, sub-agent
 * rollup, and `turn_events` (skill / mcp_call / subagent / compaction / error /
 * api_error / model_switch / label mutations). Launcher parity is structural —
 * the transcript JSONL is the uniform source of truth for sdk/tmux/pty.
 *
 * **Purity (directive Tasks 1–8 are self-contained):** this module imports NO
 * Sub A schema and NO Sub B seam — it is a pure function over the transcript +
 * the finalize context, returning a launcher-agnostic `TurnParseResult`. The
 * adapter that maps that onto B's `FinalizeStep` / A's `FinalizeTurnInput`
 * lives at the wiring site (Task 9, `createParseStep`) so the parser stays
 * unit-testable in isolation.
 *
 * **Fail-open (R12):** `parseTurn` wraps its entire body in try/catch — ANY
 * failure (missing file, malformed JSONL, schema drift) returns partial data
 * with NULLs + `capture_source="parsed"` and NEVER throws. A parser failure
 * must not block or crash `finalizeTurn`.
 *
 * **Correctness model (D10):** full re-read + uuid dedup is the correctness
 * mechanism; a per-file offset would be an optimization only (not implemented —
 * finalize runs off the session hot path). Reads `readFileSync` because B's
 * `parseStep` seam is synchronous (`FinalizeStep = (ctx) => Partial<...>`).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { resolveTranscriptPaths } from "./transcriptPath";
import type { ResolveTranscriptPathsInput } from "./transcriptPath";
import type { FinalizeStepContext, FinalizeStepResult } from "../turnLifecycle";

// ───────────────────────────── public types ─────────────────────────────

/** A single turn_event the parser emits — structurally A's `TurnEventInput`. */
export interface TurnParseEvent {
  tsMs: number;
  /** One of A's canonical `TurnEventKind` values (kept as string for purity). */
  kind:
    | "skill"
    | "mcp_call"
    | "subagent"
    | "compaction"
    | "label_added"
    | "label_removed"
    | "error"
    | "api_error"
    | "model_switch";
  name?: string | null;
  payload?: Record<string, unknown> | null;
}

/**
 * Launcher-agnostic parse result for one finalizing turn. Field names mirror A's
 * `FinalizeTurnInput` so the Task-9 adapter is a near-identity map. Every token
 * field is nullable: on a parse failure or an empty turn they are NULL and the
 * downstream COALESCE leaves the open-time value intact.
 */
export interface TurnParseResult {
  promptMsgUuid: string | null;
  modelProvider: string | null;
  modelId: string | null;
  tokIn: number | null;
  tokOut: number | null;
  tokCacheRead: number | null;
  tokCacheWrite: number | null;
  tokensExtra: Record<string, unknown> | null;
  contextUsedTokens: number | null;
  contextRemainingTokens: number | null;
  captureSource: "parsed";
  transcriptPath: string | null;
  promptHash: string | null;
  /** Opening main-chain prompt timestamp (ms). The segment's started_at — used by
   *  the backfill tool (#1668) to reconstruct started_at_ms; null when unparseable. */
  startedAtMs: number | null;
  /** Transcript-detected turn-level error (isApiErrorMessage) → B upgrades status. */
  errored: boolean;
  events: TurnParseEvent[];
  /** Per-line skip count from `readTranscript` (#1921, R3): JSON-parse failures,
   *  non-object lines, unknown/internal `type`, and uuid-dedup drops. A high ratio
   *  is a softer format-drift signal than a full R12 catch. 0 on the catch path
   *  (the count is unknown when readTranscript/segmentation threw). */
  skipped: number;
  /** The swallowed R12 error message (#1921, R1): non-null ONLY when `parseTurn`'s
   *  fail-open catch fired. NULL on success AND on the legitimate empty-turn
   *  (`segments.length === 0`) / missing-transcript early return — neither is a
   *  parse failure (R4). Surfaced as DATA so the impure finalize seam can log +
   *  count it; the pure parser does NO I/O in the catch (R5). */
  parseError: string | null;
}

/** Finalize context the parser needs (a subset of B's finalize event + spawn data). */
export interface ParseTurnContext extends Partial<ResolveTranscriptPathsInput> {
  ccSessionId?: string;
  /** Spawn-resolved context window; usually unknown at finalize → remaining NULL. */
  contextWindow?: number | null;
  /** Fallback ms timestamp for events whose entry has no parseable timestamp. */
  fallbackTsMs?: number;
}

/** Parser-evolution marker → A's `schema_version` column. Bump on format changes.
 *  2 = #4385: background `Agent` launches are excluded from the finalize rollup
 *  (they are accounted once at completion in `background_agent_usage`). Under
 *  K-4578-1 each parser behaviour change bumps this by one; a later lander
 *  rebases to max + 1. */
export const TRANSCRIPT_PARSER_SCHEMA_VERSION = 2;

// ───────────────────────────── entry shape ─────────────────────────────

/**
 * Minimal transcript-entry shape (the "minimal schema" — every field optional,
 * everything else tolerated). We validate only `type` is a string and the line
 * is an object; all field access below is defensive. A heavyweight per-line Zod
 * parse over a full re-read buys no correctness here (every field is
 * optional/passthrough) and costs latency, so the schema is this typed view +
 * the skip-set + the object guard.
 */
interface TranscriptEntry {
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
 */
const SKIP_TYPES = new Set([
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

  const lines = raw.split("\n");
  const entries: TranscriptEntry[] = [];
  const seenUuids = new Set<string>();
  let skipped = 0;

  for (const line of lines) {
    if (line.trim() === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (typeof obj !== "object" || obj === null) {
      skipped += 1;
      continue;
    }
    const rec = obj as Record<string, unknown>;

    // Dual-schema session_id normalization (legacy camelCase vs current snake).
    if ("session_id" in rec && !("sessionId" in rec)) {
      rec.sessionId = rec.session_id;
    }

    const type = rec.type;
    if (typeof type !== "string") {
      skipped += 1;
      continue;
    }
    if (SKIP_TYPES.has(type)) {
      skipped += 1;
      continue;
    }

    // Dedup by uuid (when present). Entries without a uuid (rare) are kept.
    const uuid = typeof rec.uuid === "string" ? rec.uuid : undefined;
    if (uuid !== undefined) {
      if (seenUuids.has(uuid)) {
        skipped += 1;
        continue;
      }
      seenUuids.add(uuid);
    }

    entries.push(rec as unknown as TranscriptEntry);
  }

  return { entries, skipped };
}

/**
 * Last-observed-activity watermark for a turn: `MAX(entry.timestamp)` over the
 * session transcript (issue #2248). Used by the orphan sweep to close an orphaned
 * turn at a STRICT lower-bound duration instead of NULL — an orphaned turn never
 * finalizes, so it carries no `turn_events`; the transcript's last message
 * timestamp is the only crash-surviving record of when the turn was still active.
 *
 * Reads the stored `transcriptPath` directly when present (so a missing
 * `ccSessionId` — which `resolveTranscriptPaths` requires — cannot block the read),
 * else reconstructs the path from `ccSessionId` + `workingDirectory`. `upperBoundMs`
 * (the same session's next-turn `started_at_ms`, when one exists) prevents a later
 * turn's messages from being mis-attributed to a stale-open orphan.
 *
 * Fail-open (mirrors `parseAllTurns` R12): returns `null` on ANY failure (missing
 * file, unresolvable path, no parseable timestamp) — the caller falls back to the
 * `started_at_ms` floor.
 */
export function lastMessageTsMs(ctx: {
  transcriptPath?: string | null;
  ccSessionId?: string | null;
  workingDirectory?: string | null;
  configDir?: string;
  upperBoundMs?: number;
}): number | null {
  try {
    let mainPath: string;
    if (ctx.transcriptPath) {
      // The stored transcript_path IS the main JSONL — read it directly.
      mainPath = ctx.transcriptPath;
    } else {
      mainPath = resolveTranscriptPaths({
        ccSessionId: ctx.ccSessionId ?? "",
        workingDirectory: ctx.workingDirectory ?? undefined,
        configDir: ctx.configDir,
      }).main;
    }
    const { entries } = readTranscript(mainPath);
    let max: number | null = null;
    for (const e of entries) {
      const ts = tsMsOf(e, 0); // fallback 0 marks an unparseable/absent timestamp
      if (ts <= 0) continue;
      if (typeof ctx.upperBoundMs === "number" && ts > ctx.upperBoundMs)
        continue;
      if (max === null || ts > max) max = ts;
    }
    return max;
  } catch {
    return null;
  }
}

// ───────────────────────── segmentation (Task 3, R5/R6) ─────────────────────────

/** True iff `content` is a non-empty array whose blocks are ALL `tool_result`. */
function contentIsSolelyToolResult(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(
    block =>
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>).type === "tool_result"
  );
}

/**
 * A main-chain user PROMPT (R5): a `type:"user"` entry that is NOT sidechain,
 * meta, a compact summary, or visible-only, and whose content is not solely a
 * `tool_result` (a tool-result carrier is not a prompt). Treats null/false/absent
 * equivalently for the meta flags (real transcripts emit `isMeta:null`).
 */
function isMainChainPrompt(e: TranscriptEntry): boolean {
  return (
    e.type === "user" &&
    !e.isSidechain &&
    !e.isMeta &&
    !e.isCompactSummary &&
    !e.isVisibleInTranscriptOnly &&
    !contentIsSolelyToolResult(e.message?.content)
  );
}

/**
 * Segment the transcript into turns by main-chain prompts. Each segment is the
 * contiguous run of entries from one main-chain prompt (inclusive) to the next
 * (exclusive) or EOF — INCLUDING any interleaved inline sidechain entries
 * (legacy sub-agent layout), which roll up into the turn (R8). The finalizing
 * turn is the LAST segment. Returns `[]` when no main-chain prompt exists.
 */
function segmentTurns(entries: TranscriptEntry[]): TranscriptEntry[][] {
  const promptIdxs: number[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    if (isMainChainPrompt(entries[i])) promptIdxs.push(i);
  }
  if (promptIdxs.length === 0) return [];

  const segments: TranscriptEntry[][] = [];
  for (let p = 0; p < promptIdxs.length; p += 1) {
    const start = promptIdxs[p];
    const end = p + 1 < promptIdxs.length ? promptIdxs[p + 1] : entries.length;
    segments.push(entries.slice(start, end));
  }
  return segments;
}

// ───────────────────────────── token helpers ─────────────────────────────

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

interface TokenSums {
  tokIn: number;
  tokOut: number;
  tokCacheRead: number;
  tokCacheWrite: number;
  ephemeral5m: number;
  ephemeral1h: number;
  webSearch: number;
  webFetch: number;
  /** Whether any usage block was seen (so we know to emit tokens_extra). */
  sawUsage: boolean;
}

function emptyTokenSums(): TokenSums {
  return {
    tokIn: 0,
    tokOut: 0,
    tokCacheRead: 0,
    tokCacheWrite: 0,
    ephemeral5m: 0,
    ephemeral1h: 0,
    webSearch: 0,
    webFetch: 0,
    sawUsage: false,
  };
}

/**
 * Add one assistant `usage` block's billable classes into the running sums (R1/R3).
 *
 * #2229 (R2): Claude Code writes ONE transcript line per content block, each
 * repeating the parent API message's FINAL usage verbatim (verified: zero
 * within-id variance). Summing per line therefore over-counts ~2.17×. When the
 * entry carries an API `message.id` and a `seenMessageIds` set is provided,
 * each id is counted at most once; entries lacking an id keep per-line counting
 * (defensive fallback — never under-count an uncorrelatable line). First-wins
 * is deliberate here (identical-usage empirically holds on transcripts; per-id
 * max would need pre-sum buckets in this streaming accumulator) — the
 * CLIENT-side fold (`@hapi/protocol/tokenUsageAggregation`) uses per-class max
 * instead; if a future Claude Code writes progressively-accumulating per-block
 * usage, align this site to max at the same time.
 */
function addUsage(
  sums: TokenSums,
  usage: Record<string, unknown> | undefined,
  apiMessageId?: string,
  seenMessageIds?: Set<string>
): void {
  if (!usage) return;
  if (seenMessageIds && typeof apiMessageId === "string" && apiMessageId) {
    if (seenMessageIds.has(apiMessageId)) return;
    seenMessageIds.add(apiMessageId);
  }
  sums.sawUsage = true;
  sums.tokIn += num(usage.input_tokens);
  sums.tokOut += num(usage.output_tokens);
  sums.tokCacheRead += num(usage.cache_read_input_tokens);
  sums.tokCacheWrite += num(usage.cache_creation_input_tokens);
  const cc = usage.cache_creation as Record<string, unknown> | undefined;
  if (cc) {
    sums.ephemeral5m += num(cc.ephemeral_5m_input_tokens);
    sums.ephemeral1h += num(cc.ephemeral_1h_input_tokens);
  }
  const stu = usage.server_tool_use as Record<string, unknown> | undefined;
  if (stu) {
    sums.webSearch += num(stu.web_search_requests);
    sums.webFetch += num(stu.web_fetch_requests);
  }
}

function isAssistant(e: TranscriptEntry): boolean {
  return e.type === "assistant";
}

/** Context occupancy of an assistant `usage` block (R2): in + cacheCreate + cacheRead. */
function occupancy(usage: Record<string, unknown> | undefined): number {
  if (!usage) return 0;
  return (
    num(usage.input_tokens) +
    num(usage.cache_creation_input_tokens) +
    num(usage.cache_read_input_tokens)
  );
}

/**
 * #4386: sum one agent sub-transcript's billable token usage, deduped by API
 * message id per file — the exact fold `rollupExternalSubAgents` applies to a
 * matched sub-agent file (R2 #2229: Claude Code repeats the parent message's
 * usage on every content-block line, so per-id dedup avoids a ~2.17× overcount).
 * Exported so the agent-peek page (#4386), #4385 and #4388 all sum with ONE
 * implementation. A missing/unreadable file sums to zero (`readTranscript`
 * swallows the read error); the agent-peek route 404s before reaching here.
 */
export function sumAgentTranscriptUsage(path: string): {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
} {
  const {
    in: tokIn,
    out,
    cacheRead,
    cacheWrite,
  } = summarizeAgentTranscript(path);
  return { in: tokIn, out, cacheRead, cacheWrite };
}

/**
 * #4385: one read of an agent sub-transcript returning its deduped usage (the
 * exact `sumAgentTranscriptUsage` fold — that function delegates here, so there
 * is ONE sum implementation), the agent's OWN model (the last assistant
 * `message.model`, which prices its usage — never the parent turn's model) and
 * its first assistant timestamp (the rate-card effective time). `exists` is
 * false when the file is missing; `readable` is false when it exists but the
 * read failed. Either way the writer leaves any stored row in place and logs it,
 * because the agent is already excluded from the rollup.
 */
export function summarizeAgentTranscript(path: string): {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  modelId: string | null;
  firstAssistantTsMs: number | null;
  exists: boolean;
  /** False when the file exists but the read failed; the sums are then zero
   *  and must not replace a stored row (#4385 fix round 1). */
  readable: boolean;
} {
  const exists = existsSync(path);
  const sums = emptyTokenSums();
  const seenMessageIds = new Set<string>();
  let modelId: string | null = null;
  let firstAssistantTsMs: number | null = null;
  const { entries, readError } = readTranscript(path);
  for (const e of entries) {
    if (!isAssistant(e)) continue;
    addUsage(sums, e.message?.usage, e.message?.id, seenMessageIds);
    const model = e.message?.model;
    if (typeof model === "string" && model !== "" && model !== "<synthetic>") {
      modelId = model;
    }
    if (firstAssistantTsMs === null) {
      const ts = tsMsOf(e, 0);
      if (ts > 0) firstAssistantTsMs = ts;
    }
  }
  return {
    in: sums.tokIn,
    out: sums.tokOut,
    cacheRead: sums.tokCacheRead,
    cacheWrite: sums.tokCacheWrite,
    modelId,
    firstAssistantTsMs,
    exists,
    readable: !readError,
  };
}

/** #4385: the fields of `agent-<id>.meta.json` the recorder reads. */
export interface AgentMeta {
  agentType?: string;
  toolUseId?: string;
  description?: string;
  requestShape?: string;
}

/** #4385: read `agent-<id>.meta.json`; null when missing or unparseable. */
export function readAgentMeta(
  subagentsDir: string,
  agentId: string
): AgentMeta | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(subagentsDir, `agent-${agentId}.meta.json`), "utf-8")
    ) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const str = (v: unknown) =>
      typeof v === "string" && v !== "" ? v : undefined;
    return {
      agentType: str(r.agentType),
      toolUseId: str(r.toolUseId),
      description: str(r.description),
      requestShape: str(r.requestShape),
    };
  } catch {
    return null;
  }
}

/**
 * #4385 (T10): classify an `Agent` launch by its `toolUseId` in the session's
 * MAIN transcript, with Task 1's two transcript arms — the input's
 * `run_in_background === true` and the result's `async_launched` status. Used
 * only when the agent's meta carries no `requestShape`. `"foreground"` when the
 * launch is found with neither arm; `"unknown"` when it is not found.
 */
export function classifyAgentLaunch(
  mainTranscriptPath: string,
  toolUseId: string
): "background" | "foreground" | "unknown" {
  const { entries } = readTranscript(mainTranscriptPath);
  let found = false;
  for (const e of entries) {
    if (isAssistant(e)) {
      for (const block of contentBlocks(e)) {
        if (block.type !== "tool_use" || block.id !== toolUseId) continue;
        const name = typeof block.name === "string" ? block.name : "";
        if (name !== "Agent" && name !== "Task") continue;
        found = true;
        const input = (block.input ?? {}) as Record<string, unknown>;
        if (isBackgroundLaunchInput(input)) return "background";
      }
    } else if (e.type === "user" && isAsyncLaunchedResult(e)) {
      for (const block of contentBlocks(e)) {
        if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
          return "background";
        }
      }
    }
  }
  return found ? "foreground" : "unknown";
}

function modelProviderOf(modelId: string | null): string | null {
  if (!modelId) return null;
  if (modelId.startsWith("claude")) return "anthropic";
  return null;
}

// ───────────────────────── event extraction (Task 5/6) ─────────────────────────

function tsMsOf(e: TranscriptEntry, fallback: number): number {
  const t = e.timestamp;
  if (typeof t === "number" && Number.isFinite(t)) return t;
  if (typeof t === "string") {
    const parsed = Date.parse(t);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

function contentBlocks(e: TranscriptEntry): Array<Record<string, unknown>> {
  const c = e.message?.content;
  if (!Array.isArray(c)) return [];
  return c.filter(b => typeof b === "object" && b !== null) as Array<
    Record<string, unknown>
  >;
}

/**
 * UTF-8 byte size of a `tool_result` block's content (issue #2154).
 *
 * `content` is either a bare string or an array of blocks; only the textual
 * parts count, since those are what enter the model's context. Returns null when
 * nothing measurable is found, which the caller must treat as "not measured"
 * rather than as a zero-cost invocation.
 */
function toolResultBytes(block: Record<string, unknown>): number | null {
  const content = block.content;
  if (typeof content === "string") {
    return Buffer.byteLength(content, "utf8");
  }
  if (!Array.isArray(content)) return null;

  let total = 0;
  let sawText = false;
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const text = (part as Record<string, unknown>).text;
    if (typeof text !== "string") continue;
    total += Buffer.byteLength(text, "utf8");
    sawText = true;
  }
  return sawText ? total : null;
}

/**
 * Detect GitHub label mutations from the `gh issue edit … --add-label/--remove-label`
 * grammar in a Bash command (R10). LITERAL issue number + LITERAL label → resolved
 * events (comma-joined AND repeated flags both handled). Variable/placeholder forms
 * (`$X`, `{x}`, backticks) → an `unresolved` event — NEVER a wrong label. The parsed
 * label string is recorded verbatim; canonical-set validation is downstream (J #1672).
 *
 * Payload keys (`label`, `issue_number`) match A's `v_workflow_state` view's
 * `json_extract(payload, '$.label' | '$.issue_number')` contract.
 */
function detectLabelMutations(command: string, tsMs: number): TurnParseEvent[] {
  const out: TurnParseEvent[] = [];
  // Find each `gh issue edit <token>` invocation; its flag segment runs up to
  // the next `gh issue edit` (or end of command).
  const editRe = /gh\s+issue\s+edit\s+(\S+)/g;
  const editMatches = [...command.matchAll(editRe)].map(mm => ({
    idx: mm.index ?? 0,
    end: (mm.index ?? 0) + mm[0].length,
    issueToken: mm[1],
  }));

  const hasVar = (s: string): boolean => /[$`{]/.test(s);
  const labelRe = /--(add|remove)-label[=\s]+("([^"]*)"|'([^']*)'|(\S+))/g;

  for (let i = 0; i < editMatches.length; i += 1) {
    const { end, issueToken } = editMatches[i];
    const segEnd =
      i + 1 < editMatches.length ? editMatches[i + 1].idx : command.length;
    const segment = command.slice(end, segEnd);
    const issueLiteral = /^\d+$/.test(issueToken);

    for (const lm of segment.matchAll(labelRe)) {
      const kind: TurnParseEvent["kind"] =
        lm[1] === "add" ? "label_added" : "label_removed";
      const rawValue = lm[3] ?? lm[4] ?? lm[5] ?? "";

      if (!issueLiteral || hasVar(rawValue)) {
        out.push({
          tsMs,
          kind,
          name: null,
          payload: { unresolved: true, raw: `${issueToken} ${lm[0]}`.trim() },
        });
        continue;
      }
      // Resolved literal: split comma-joined values; emit one event per label.
      const issueNumber = Number(issueToken);
      for (const part of rawValue.split(",")) {
        const label = part.trim();
        if (label === "") continue;
        out.push({
          tsMs,
          kind,
          name: label,
          payload: { label, issue_number: issueNumber },
        });
      }
    }
  }
  return out;
}

// ───────────────────────── sub-agent rollup (Task 4, R8) ─────────────────────────

interface SubAgentMeta {
  agentType?: string;
  toolUseId?: string;
  description?: string;
  /** `"background"` / `"foreground"` on Claude Code builds that write it;
   *  absent on older builds (2.1.260 writes none, foreground metas included). */
  requestShape?: string;
}

/**
 * #4385 (T8): true when a launching `Agent` tool_use's input asks for a
 * background run. Only an explicit `true` counts — an absent flag is never
 * read as background (CC 2.1.271 launched background agents with no flag; the
 * `async_launched` result arm and the meta arm catch those).
 */
function isBackgroundLaunchInput(input: Record<string, unknown>): boolean {
  return input.run_in_background === true;
}

/**
 * #4385 (T8): true when a tool_result-carrying user entry reports an
 * asynchronous launch (`toolUseResult.status === "async_launched"`).
 */
function isAsyncLaunchedResult(e: TranscriptEntry): boolean {
  const tur = e.toolUseResult;
  return (
    typeof tur === "object" &&
    tur !== null &&
    (tur as Record<string, unknown>).status === "async_launched"
  );
}

/**
 * Roll external sub-agent (Task/Agent) token usage into the turn totals and emit
 * one `subagent` event per matched sub-agent file (current layout). The main
 * transcript in the current layout has NO inline sidechain entries, and a legacy
 * inline transcript has NO external files, so summing the segment's assistant
 * usage (above) plus matched external files never double-counts.
 *
 * #4385: a BACKGROUND agent is never rolled up — it can outlive this turn, so its
 * file is partial at `Stop`; it is accounted once, in full, at completion
 * (`background_agent_usage`). Three arms mark one (T8): the launch input's
 * `run_in_background === true`, the launch result's `async_launched` status
 * (both collected into `backgroundToolUseIds`), and the meta's
 * `requestShape === "background"`. An absent field is never background. The
 * agent still emits a token-less `subagent` event (`background: true`) so the
 * agent-invocation analytics (`analyticsCounts.ts`) keep counting it.
 */
function rollupExternalSubAgents(
  taskToolUseIds: Set<string>,
  backgroundToolUseIds: Set<string>,
  subagentsDir: string,
  sums: TokenSums,
  events: TurnParseEvent[],
  fallbackTsMs: number
): void {
  if (taskToolUseIds.size === 0 && backgroundToolUseIds.size === 0) return;
  if (!existsSync(subagentsDir)) return;

  let metaFiles: string[];
  try {
    metaFiles = readdirSync(subagentsDir).filter(f => f.endsWith(".meta.json"));
  } catch {
    return; // unreadable dir degrades to no rollup (R12)
  }

  for (const metaFile of metaFiles) {
    let meta: SubAgentMeta;
    try {
      meta = JSON.parse(
        readFileSync(join(subagentsDir, metaFile), "utf-8")
      ) as SubAgentMeta;
    } catch {
      continue;
    }
    const toolUseId = meta.toolUseId;
    if (!toolUseId) continue;
    const launchedHere =
      taskToolUseIds.has(toolUseId) || backgroundToolUseIds.has(toolUseId);
    if (!launchedHere) continue;

    if (
      backgroundToolUseIds.has(toolUseId) ||
      meta.requestShape === "background"
    ) {
      // `agentId` (from the meta filename) lets the finalize seed step write
      // this agent's row from its file as it is now (#4385 fix round 1).
      events.push({
        tsMs: fallbackTsMs,
        kind: "subagent",
        name: meta.agentType ?? null,
        payload: {
          toolUseId,
          background: true,
          agentId: metaFile.slice("agent-".length, -".meta.json".length),
        },
      });
      continue;
    }

    // agent-<id>.jsonl sits next to agent-<id>.meta.json.
    const agentFile = metaFile.replace(/\.meta\.json$/, ".jsonl");
    const { entries: subEntries } = readTranscript(
      join(subagentsDir, agentFile)
    );

    const subSums = emptyTokenSums();
    // #2229 (R2): per-file seen-set — sub-agent transcripts duplicate usage per
    // content-block line exactly like the main transcript. API message ids are
    // globally unique, so per-file scoping cannot collide with the main chain.
    const subSeenMessageIds = new Set<string>();
    for (const se of subEntries) {
      if (isAssistant(se)) {
        addUsage(subSums, se.message?.usage, se.message?.id, subSeenMessageIds);
      }
    }

    // Roll the sub-agent's billable tokens into the parent turn (R8).
    sums.tokIn += subSums.tokIn;
    sums.tokOut += subSums.tokOut;
    sums.tokCacheRead += subSums.tokCacheRead;
    sums.tokCacheWrite += subSums.tokCacheWrite;
    sums.ephemeral5m += subSums.ephemeral5m;
    sums.ephemeral1h += subSums.ephemeral1h;
    sums.webSearch += subSums.webSearch;
    sums.webFetch += subSums.webFetch;
    if (subSums.sawUsage) sums.sawUsage = true;

    events.push({
      tsMs: fallbackTsMs,
      kind: "subagent",
      name: meta.agentType ?? null,
      payload: {
        toolUseId,
        tokens: {
          in: subSums.tokIn,
          out: subSums.tokOut,
          cacheRead: subSums.tokCacheRead,
          cacheWrite: subSums.tokCacheWrite,
        },
      },
    });
  }
}

// ───────────────────────── public entry point (Task 7) ─────────────────────────

function nullResult(transcriptPath: string | null): TurnParseResult {
  return {
    promptMsgUuid: null,
    modelProvider: null,
    modelId: null,
    tokIn: null,
    tokOut: null,
    tokCacheRead: null,
    tokCacheWrite: null,
    tokensExtra: null,
    contextUsedTokens: null,
    contextRemainingTokens: null,
    captureSource: "parsed",
    transcriptPath,
    promptHash: null,
    startedAtMs: null,
    errored: false,
    events: [],
    // #1921: defaults for the empty-turn / missing-transcript early return AND the
    // R12 catch. `parseError: null` keeps the empty-turn path NON-failing (R4);
    // `parseTurn` overrides `skipped` (success/empty paths) and `parseError` (catch).
    skipped: 0,
    parseError: null,
  };
}

/**
 * Parse the finalizing turn from the session transcript. Pure + fail-open (R12):
 * any error returns a NULL result with `capture_source="parsed"` and never throws.
 */
export function parseTurn(ctx: ParseTurnContext): TurnParseResult {
  let resolvedMain: string | null = ctx.transcriptPath ?? null;
  try {
    const paths = resolveTranscriptPaths({
      ccSessionId: ctx.ccSessionId ?? "",
      transcriptPath: ctx.transcriptPath,
      workingDirectory: ctx.workingDirectory,
      configDir: ctx.configDir,
    });
    resolvedMain = paths.main;
    const fallbackTsMs = ctx.fallbackTsMs ?? 0;

    const { entries, skipped } = readTranscript(paths.main);
    const segments = segmentTurns(entries);
    if (segments.length === 0) {
      // No detectable main-chain prompt — nothing to attribute. Fail-open NULLs.
      // #1921 (R3/R4): thread `skipped` even here (a high skip ratio is observable);
      // `parseError` stays null — an empty turn is NOT a parse failure.
      return { ...nullResult(resolvedMain), skipped };
    }
    const turn = segments[segments.length - 1];
    // #1921 (R3): thread the per-line skip count into the success result.
    return {
      ...parseSegment(turn, {
        fallbackTsMs,
        contextWindow:
          typeof ctx.contextWindow === "number" ? ctx.contextWindow : null,
        subagentsDir: paths.subagentsDir,
        resolvedMain,
      }),
      skipped,
    };
  } catch (err) {
    // R12: ANY failure → NULLs + capture_source, never throw.
    // #1921 (R1/R5): surface the swallowed message as DATA so the impure finalize
    // seam can log + count it. NO I/O here — the parser stays pure and this path
    // cannot throw. `skipped` stays 0 (unknown once the catch fired).
    return {
      ...nullResult(resolvedMain),
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Parse ONE pre-segmented turn (the main-chain prompt + its responses) into a
 * launcher-agnostic TurnParseResult. Extracted from parseTurn (#1668) so both the
 * live finalize seam (parseTurn, last segment) and the backfill tool (parseAllTurns,
 * every segment) share identical attribution logic.
 */
function parseSegment(
  turn: TranscriptEntry[],
  opts: {
    fallbackTsMs: number;
    contextWindow: number | null;
    subagentsDir: string;
    resolvedMain: string | null;
  }
): TurnParseResult {
  const { fallbackTsMs, contextWindow, subagentsDir, resolvedMain } = opts;
  const sums = emptyTokenSums();
  // #2229 (R2): per-turn usage-dedup set — one count per API message.id across
  // main-chain + inline-sidechain entries of this segment.
  const seenMessageIds = new Set<string>();
  const events: TurnParseEvent[] = [];
  const taskToolUseIds = new Set<string>();
  // #4385: background `Agent` launches — excluded from the rollup (see
  // `rollupExternalSubAgents`); moved here from `taskToolUseIds` when the launch
  // result reports `async_launched`.
  const backgroundToolUseIds = new Set<string>();
  // #2154: Skill tool_use id → index of that skill event in `events`. The
  // tool_use block names the skill but carries no body; the injected SKILL.md
  // arrives later as a tool_result in a separate user entry, so the size is
  // patched in by index once that entry is reached. Mirrors the taskToolUseIds
  // correlation above.
  const skillEventIdxByToolUseId = new Map<string, number>();
  let promptMsgUuid: string | null = null;
  let startedAtMs: number | null = null;
  let promptContent: unknown = null;
  let lastMainModel: string | null = null;
  let contextUsedTokens: number | null = null;
  let errored = false;

  for (const e of turn) {
    const ts = tsMsOf(e, fallbackTsMs);
    const sidechain = Boolean(e.isSidechain);

    // The opening main-chain prompt of this segment (R5).
    if (promptMsgUuid === null && isMainChainPrompt(e)) {
      promptMsgUuid = e.uuid ?? null;
      promptContent = e.message?.content ?? null;
      startedAtMs = ts;
    }

    if (isAssistant(e)) {
      // Token rollup over ALL assistant entries (main + inline sidechain),
      // deduped by API message.id (#2229 R2).
      addUsage(sums, e.message?.usage, e.message?.id, seenMessageIds);

      if (!sidechain) {
        // Main-chain only: model + model_switch + context occupancy.
        const model = e.message?.model ?? null;
        if (model) {
          if (lastMainModel !== null && lastMainModel !== model) {
            events.push({
              tsMs: ts,
              kind: "model_switch",
              name: model,
              payload: { from: lastMainModel, to: model },
            });
          }
          lastMainModel = model;
        }
        const occ = occupancy(e.message?.usage);
        if (occ > 0) contextUsedTokens = occ; // latest main-chain wins (R2)
      }

      if (e.isApiErrorMessage) {
        errored = true;
        events.push({ tsMs: ts, kind: "api_error", name: null });
      }

      // Tool-use derived events.
      for (const block of contentBlocks(e)) {
        if (block.type !== "tool_use") continue;
        const name = typeof block.name === "string" ? block.name : "";
        const input = (block.input ?? {}) as Record<string, unknown>;
        if (name === "Skill") {
          const skill = typeof input.skill === "string" ? input.skill : null;
          if (typeof block.id === "string") {
            skillEventIdxByToolUseId.set(block.id, events.length);
          }
          events.push({ tsMs: ts, kind: "skill", name: skill });
        } else if (name.startsWith("mcp__")) {
          events.push({ tsMs: ts, kind: "mcp_call", name });
        } else if (name === "Task" || name === "Agent") {
          if (typeof block.id === "string") {
            if (isBackgroundLaunchInput(input)) {
              backgroundToolUseIds.add(block.id);
            } else {
              taskToolUseIds.add(block.id);
            }
          }
        } else if (name === "Bash") {
          const command =
            typeof input.command === "string" ? input.command : "";
          if (command) {
            for (const ev of detectLabelMutations(command, ts)) {
              events.push(ev);
            }
          }
        }
      }
    } else if (e.type === "user") {
      const asyncLaunched = isAsyncLaunchedResult(e);
      for (const block of contentBlocks(e)) {
        if (block.type !== "tool_result") continue;
        const toolUseId =
          typeof block.tool_use_id === "string" ? block.tool_use_id : null;

        // #4385 (T8): an `Agent` launch whose result reports `async_launched` is
        // a background agent even when its input carried no flag.
        if (
          asyncLaunched &&
          toolUseId !== null &&
          taskToolUseIds.has(toolUseId)
        ) {
          taskToolUseIds.delete(toolUseId);
          backgroundToolUseIds.add(toolUseId);
        }

        // tool_result errors (R9): a failed tool inside a user-role content array.
        if (block.is_error === true) {
          events.push({
            tsMs: ts,
            kind: "error",
            name: null,
            payload: toolUseId !== null ? { tool_use_id: toolUseId } : null,
          });
        }

        // #2154: a Skill's tool_result carries the SKILL.md body that was injected
        // into context. Measure it and patch it onto the skill event emitted
        // earlier. Errored results are skipped — a failed invocation loaded no
        // skill body, and recording its size would understate the real cost.
        if (toolUseId === null || block.is_error === true) continue;
        const skillIdx = skillEventIdxByToolUseId.get(toolUseId);
        if (skillIdx === undefined) continue;
        const injectedBytes = toolResultBytes(block);
        if (injectedBytes === null) continue;
        events[skillIdx].payload = {
          ...(events[skillIdx].payload ?? {}),
          injectedBytes,
        };
      }
    } else if (e.type === "system" && e.subtype === "compact_boundary") {
      const cm = e.compactMetadata ?? {};
      events.push({
        tsMs: ts,
        kind: "compaction",
        name: null,
        payload: {
          trigger: cm.trigger ?? null,
          preTokens: cm.preTokens ?? null,
          postTokens: cm.postTokens ?? null,
          durationMs: cm.durationMs ?? null,
        },
      });
    }
  }

  // External sub-agent rollup (current layout).
  rollupExternalSubAgents(
    taskToolUseIds,
    backgroundToolUseIds,
    subagentsDir,
    sums,
    events,
    fallbackTsMs
  );

  const tokensExtra: Record<string, unknown> | null = sums.sawUsage
    ? {
        cache_creation: {
          ephemeral_5m_input_tokens: sums.ephemeral5m,
          ephemeral_1h_input_tokens: sums.ephemeral1h,
        },
        server_tool_use: {
          web_search_requests: sums.webSearch,
          web_fetch_requests: sums.webFetch,
        },
      }
    : null;

  const contextRemainingTokens =
    contextWindow !== null && contextUsedTokens !== null
      ? Math.max(0, contextWindow - contextUsedTokens)
      : null;

  const promptHash =
    promptContent !== null
      ? createHash("sha256")
          .update(
            typeof promptContent === "string"
              ? promptContent
              : JSON.stringify(promptContent)
          )
          .digest("hex")
      : null;

  return {
    promptMsgUuid,
    modelProvider: modelProviderOf(lastMainModel),
    modelId: lastMainModel,
    tokIn: sums.sawUsage ? sums.tokIn : null,
    tokOut: sums.sawUsage ? sums.tokOut : null,
    tokCacheRead: sums.sawUsage ? sums.tokCacheRead : null,
    tokCacheWrite: sums.sawUsage ? sums.tokCacheWrite : null,
    tokensExtra,
    contextUsedTokens,
    contextRemainingTokens,
    captureSource: "parsed",
    transcriptPath: resolvedMain,
    promptHash,
    startedAtMs,
    errored,
    events,
    // #1921: a successful parse is never a failure. `parseTurn` overrides `skipped`
    // with the real readTranscript count via spread; here it defaults to 0.
    skipped: 0,
    parseError: null,
  };
}

/**
 * Parse EVERY turn from the session transcript — one TurnParseResult per main-chain
 * prompt segment, in transcript order. Used by the backfill/repair tool (Sub F, #1668)
 * to (re)derive arbitrary historical turns: parseTurn returns ONLY the last segment
 * (correct for the live finalize seam, useless for after-the-fact backfill of a
 * non-final turn, since one transcript accumulates all of a session's turns).
 * Pure + fail-open (R12): returns [] on any error.
 */
export function parseAllTurns(ctx: ParseTurnContext): TurnParseResult[] {
  try {
    const paths = resolveTranscriptPaths({
      ccSessionId: ctx.ccSessionId ?? "",
      transcriptPath: ctx.transcriptPath,
      workingDirectory: ctx.workingDirectory,
      configDir: ctx.configDir,
    });
    const resolvedMain = paths.main;
    const fallbackTsMs = ctx.fallbackTsMs ?? 0;
    const contextWindow =
      typeof ctx.contextWindow === "number" ? ctx.contextWindow : null;

    const { entries } = readTranscript(paths.main);
    const segments = segmentTurns(entries);
    return segments.map(seg =>
      parseSegment(seg, {
        fallbackTsMs,
        contextWindow,
        subagentsDir: paths.subagentsDir,
        resolvedMain,
      })
    );
  } catch {
    // R12: ANY failure → empty list, never throw.
    return [];
  }
}

// ───────────────────────── Task 9 adapter (B seam wiring) ─────────────────────────

/**
 * Build the Sub B `parseStep` for the finalize seam (Task 9). Maps the pure
 * `TurnParseResult` onto B's `FinalizeStepResult` (= `Partial<FinalizeTurnInput>`
 * + the out-of-band `errored` signal). The transcript path + cc session id come
 * from the finalize event (set at open by the cli turnReporter, account-isolation
 * aware); the event's `endedAtMs` is the event-timestamp fallback. `parseTurn`
 * is already fail-open, and B's `runFinalizeSteps` wraps this in its own
 * try/catch — a throw can never abort finalize (Fallback Preservation Rule / R12).
 */
export function createParseStep(): (
  ctx: FinalizeStepContext
) => FinalizeStepResult {
  return ctx => {
    const result = parseTurn({
      transcriptPath: ctx.event.transcriptPath,
      ccSessionId: ctx.event.ccSessionId,
      fallbackTsMs: ctx.event.endedAtMs,
    });
    return {
      promptMsgUuid: result.promptMsgUuid,
      modelProvider: result.modelProvider,
      modelId: result.modelId,
      tokIn: result.tokIn,
      tokOut: result.tokOut,
      tokCacheRead: result.tokCacheRead,
      tokCacheWrite: result.tokCacheWrite,
      tokensExtra: result.tokensExtra,
      contextUsedTokens: result.contextUsedTokens,
      contextRemainingTokens: result.contextRemainingTokens,
      captureSource: result.captureSource,
      transcriptPath: result.transcriptPath,
      promptHash: result.promptHash,
      schemaVersion: TRANSCRIPT_PARSER_SCHEMA_VERSION,
      events: result.events,
      errored: result.errored,
      // #1921: out-of-band signals (like `errored`) — NOT write-service columns.
      // The finalize seam (turnLifecycle) reads these to log + count a parse failure.
      parseError: result.parseError,
      parseSkipped: result.skipped,
    };
  };
}
