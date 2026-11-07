// SPDX-License-Identifier: AGPL-3.0-only
import { open, type FileHandle } from "node:fs/promises";
import {
  SKIP_TYPES,
  contentBlocks,
  isAsyncLaunchedResult,
  isBackgroundLaunchInput,
  isMainChainPrompt,
  matchExternalSubAgents,
  occupancy,
  tsMsOf,
  type MatchedSubAgent,
  type TranscriptEntry,
} from "../sync/transcript/transcriptParser";
import { TASK_NOTIFICATION_MARKER, type OpeningEvidence } from "./provenance";
import { isTestCommand, parseTestOutput, toolResultText } from "./testRuns";

/**
 * Streamed, resumable transcript reader for the throughput facts loop
 * (issue #6164, A1 — T4, findings F2/F3).
 *
 * The finalize parser reads a whole transcript synchronously (`readFileSync`);
 * a 314 MB transcript peaked at 1.2 GiB there. This reader instead pulls the
 * file in {@link CHUNK_BYTES} pieces through one file handle, checks the
 * caller's deadline after every chunk, and keeps its position, a partial-line
 * remainder and the fold state between calls, so one large file is read across
 * several loop ticks.
 *
 * The fold projects only what the facts need and applies the finalize
 * parser's OWN rules (imported, not copied): the same skip set, `uuid` dedup,
 * segmentation at {@link isMainChainPrompt}, usage counted once per
 * `message.id` within a segment, and the parser's background-launch arms. So a
 * segment's summed usage equals `parseAllTurns`' totals for it (the parity
 * test). Unlike the parser it keeps `queue-operation` lines, as prompt-queue
 * evidence for the wait classifier (F3).
 *
 * A `<synthetic>` entry is a record Claude Code writes itself (a usage-limit
 * or API error) and made no API call. Its usage (zero in practice) still sums
 * into the segment, as the parser counts it, but it is never a priced call,
 * never moves the idle clock and never sets the turn's effort or entrypoint.
 */

/** The model Claude Code stamps on the records it writes itself. */
export const SYNTHETIC_MODEL = "<synthetic>";

/** One API call (the first line of each `message.id` in its segment). */
export interface TranscriptCall {
  id: string | null;
  /** Entry timestamp in ms (0 when unparseable). */
  ts: number;
  model: string | null;
  /** An inline (legacy) sidechain call — sub-agent work inside the transcript. */
  sidechain: boolean;
  in: number;
  out: number;
  cr: number;
  /** All cache-creation tokens (`cache_creation_input_tokens`). */
  cw: number;
  /** The 1-hour part of `cw` (`cache_creation.ephemeral_1h_input_tokens`). */
  w1: number;
  occupancy: number;
  /** Top-level `attributionSkill`, or null. */
  stage: string | null;
  effort: string | null;
}

/** A real model call with usage: the only kind any figure counts. */
export function isPricedCall(c: TranscriptCall): boolean {
  return c.model !== SYNTHETIC_MODEL && c.in + c.out + c.cr + c.cw > 0;
}

export interface TestRunRecord {
  toolUseId: string;
  failed: boolean;
  units: string[];
}

export interface SkillCall {
  skill: string;
  args: string | null;
  ts: number;
}

export interface TranscriptSegment {
  index: number;
  promptUuid: string | null;
  promptTs: number | null;
  /** The opening prompt's text (≤ 2,000 chars) — classification only. */
  promptText: string | null;
  turnOrigin: string | null;
  originKind: string | null;
  /** A `<task-notification>` left the prompt queue ≤ 2 s before the prompt. */
  taskNotificationDequeued: boolean;
  calls: TranscriptCall[];
  /**
   * The last main-chain assistant entry's timestamp, `<synthetic>` entries
   * excluded: when the segment last used the cache (the next gap's start).
   */
  lastAssistantTs: number | null;
  taskToolUseIds: string[];
  backgroundToolUseIds: string[];
  tests: TestRunRecord[];
  skills: SkillCall[];
  perTurnEffort: string | null;
  entrypoint: string | null;
}

export type ReadStatus =
  | "done"
  | "more"
  | "missing"
  | "read_error"
  | "too_large";

/** The transcript-side wait evidence of a segment's opening prompt. */
export function openingEvidenceOf(segment: TranscriptSegment): OpeningEvidence {
  return {
    promptText: segment.promptText,
    turnOrigin: segment.turnOrigin,
    originKind: segment.originKind,
    taskNotificationDequeued: segment.taskNotificationDequeued,
  };
}

/** Files larger than this are not read (`too_large`). */
export const MAX_TRANSCRIPT_BYTES = 512 * 1024 * 1024;
/** Read granularity; the deadline is checked after every chunk. */
export const CHUNK_BYTES = 1024 * 1024;

const PROMPT_TEXT_CAP = 2_000;
const DEQUEUE_WINDOW_MS = 2_000;
const QUEUE_CAP = 64;
const SKILL_ARGS_CAP = 200;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function promptTextOf(e: TranscriptEntry): string | null {
  const content = e.message?.content;
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .map(b =>
        b &&
        typeof b === "object" &&
        typeof (b as { text?: unknown }).text === "string"
          ? (b as { text: string }).text
          : ""
      )
      .join("\n");
  } else return null;
  return text.length > PROMPT_TEXT_CAP ? text.slice(0, PROMPT_TEXT_CAP) : text;
}

interface SegmentBuilder {
  seg: TranscriptSegment;
  seenIds: Set<string>;
  task: Set<string>;
  background: Set<string>;
  /** Test commands awaiting their result: tool-use id → the command. */
  pendingTests: Map<string, string>;
}

/** Line-by-line fold of one main transcript into segments. */
export class TranscriptFold {
  private readonly seenUuids = new Set<string>();
  private readonly segments: TranscriptSegment[] = [];
  private current: SegmentBuilder | null = null;
  private readonly queue: string[] = [];
  private lastDequeue: { ts: number; taskNotification: boolean } | null = null;
  private finished = false;
  /** Lines skipped: unparseable, non-object, unknown type, uuid duplicates. */
  skipped = 0;

  push(line: string): void {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.skipped += 1;
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.skipped += 1;
      return;
    }
    const rec = value as Record<string, unknown>;
    const type = rec.type;
    if (typeof type !== "string") {
      this.skipped += 1;
      return;
    }
    if (type === "queue-operation") {
      this.queueEvent(rec);
      return;
    }
    if (SKIP_TYPES.has(type)) {
      this.skipped += 1;
      return;
    }
    const uuid = typeof rec.uuid === "string" ? rec.uuid : undefined;
    if (uuid !== undefined) {
      if (this.seenUuids.has(uuid)) {
        this.skipped += 1;
        return;
      }
      this.seenUuids.add(uuid);
    }
    const e = rec as unknown as TranscriptEntry;
    if (isMainChainPrompt(e)) this.openSegment(e, rec);
    const b = this.current;
    if (!b) return;
    if (e.type === "assistant") this.assistant(b, e, rec);
    else if (e.type === "user") this.user(b, e);
  }

  /** Close the last segment and return them all (idempotent). */
  finish(): TranscriptSegment[] {
    if (!this.finished) {
      this.closeSegment();
      this.finished = true;
    }
    return this.segments;
  }

  private queueEvent(rec: Record<string, unknown>): void {
    const op = rec.operation;
    const ts = tsMsOf(rec as unknown as TranscriptEntry, 0);
    const content = typeof rec.content === "string" ? rec.content : null;
    if (op === "enqueue" && content !== null) {
      this.queue.push(content);
      if (this.queue.length > QUEUE_CAP) this.queue.shift();
    } else if (op === "dequeue") {
      const head = this.queue.shift();
      this.lastDequeue = {
        ts,
        taskNotification: head?.includes(TASK_NOTIFICATION_MARKER) ?? false,
      };
    } else if (op === "remove") {
      if (content !== null) {
        const at = this.queue.indexOf(content);
        if (at >= 0) this.queue.splice(at, 1);
      }
      this.lastDequeue = {
        ts,
        taskNotification: content?.includes(TASK_NOTIFICATION_MARKER) ?? false,
      };
    }
  }

  private openSegment(e: TranscriptEntry, rec: Record<string, unknown>): void {
    this.closeSegment();
    const ts = tsMsOf(e, 0);
    const promptTs = ts > 0 ? ts : null;
    const origin =
      rec.origin && typeof rec.origin === "object" && !Array.isArray(rec.origin)
        ? (rec.origin as Record<string, unknown>)
        : null;
    const dq = this.lastDequeue;
    this.current = {
      seg: {
        index: this.segments.length,
        promptUuid: e.uuid ?? null,
        promptTs,
        promptText: promptTextOf(e),
        turnOrigin: str(rec.turnOrigin),
        originKind: str(origin?.kind),
        taskNotificationDequeued: Boolean(
          dq &&
          dq.taskNotification &&
          promptTs !== null &&
          promptTs - dq.ts >= 0 &&
          promptTs - dq.ts <= DEQUEUE_WINDOW_MS
        ),
        calls: [],
        lastAssistantTs: null,
        taskToolUseIds: [],
        backgroundToolUseIds: [],
        tests: [],
        skills: [],
        perTurnEffort: null,
        entrypoint: null,
      },
      seenIds: new Set(),
      task: new Set(),
      background: new Set(),
      pendingTests: new Map(),
    };
  }

  private closeSegment(): void {
    const b = this.current;
    if (!b) return;
    b.seg.taskToolUseIds = [...b.task];
    b.seg.backgroundToolUseIds = [...b.background];
    this.segments.push(b.seg);
    this.current = null;
  }

  private assistant(
    b: SegmentBuilder,
    e: TranscriptEntry,
    rec: Record<string, unknown>
  ): void {
    const ts = tsMsOf(e, 0);
    const msg = e.message ?? null;
    const synthetic = str(msg?.model) === SYNTHETIC_MODEL;
    if (!e.isSidechain && ts > 0 && !synthetic) b.seg.lastAssistantTs = ts;
    const usage = msg?.usage;
    if (usage) {
      const id = typeof msg?.id === "string" && msg.id !== "" ? msg.id : null;
      // The parser's rule (addUsage): an id counts once, and only a line that
      // carries usage marks it seen.
      const fresh = id === null || !b.seenIds.has(id);
      if (fresh) {
        if (id !== null) b.seenIds.add(id);
        const cc = usage.cache_creation as Record<string, unknown> | undefined;
        b.seg.calls.push({
          id,
          ts,
          model: str(msg?.model),
          sidechain: Boolean(e.isSidechain),
          in: num(usage.input_tokens),
          out: num(usage.output_tokens),
          cr: num(usage.cache_read_input_tokens),
          cw: num(usage.cache_creation_input_tokens),
          w1: num(cc?.ephemeral_1h_input_tokens),
          occupancy: occupancy(usage),
          stage: str(rec.attributionSkill),
          effort: str(rec.effort),
        });
      }
    }
    if (!synthetic && b.seg.perTurnEffort === null)
      b.seg.perTurnEffort = str(rec.perTurnEffort);
    if (!synthetic && b.seg.entrypoint === null)
      b.seg.entrypoint = str(rec.entrypoint);

    for (const block of contentBlocks(e)) {
      if (block.type !== "tool_use") continue;
      const name = typeof block.name === "string" ? block.name : "";
      const id = typeof block.id === "string" ? block.id : null;
      const input = (block.input ?? {}) as Record<string, unknown>;
      if (name === "Task" || name === "Agent") {
        if (id !== null) {
          if (isBackgroundLaunchInput(input)) b.background.add(id);
          else b.task.add(id);
        }
      } else if (name === "Bash") {
        const command = typeof input.command === "string" ? input.command : "";
        if (id !== null && command && isTestCommand(command)) {
          b.pendingTests.set(id, command);
        }
      } else if (name === "Skill") {
        const skill = str(input.skill);
        if (skill) {
          const args = typeof input.args === "string" ? input.args : null;
          b.seg.skills.push({
            skill,
            args: args === null ? null : args.slice(0, SKILL_ARGS_CAP),
            ts,
          });
        }
      }
    }
  }

  private user(b: SegmentBuilder, e: TranscriptEntry): void {
    const asyncLaunched = isAsyncLaunchedResult(e);
    for (const block of contentBlocks(e)) {
      if (block.type !== "tool_result") continue;
      const id =
        typeof block.tool_use_id === "string" ? block.tool_use_id : null;
      if (id === null) continue;
      if (asyncLaunched && b.task.has(id)) {
        b.task.delete(id);
        b.background.add(id);
      }
      const command = b.pendingTests.get(id);
      if (command !== undefined) {
        b.pendingTests.delete(id);
        const result = parseTestOutput(toolResultText(block.content), command);
        b.seg.tests.push({ toolUseId: id, ...result });
      }
    }
  }
}

/**
 * Chunked, resumable line reader over one file: each {@link step} reads until
 * the end of the file or the deadline (checked after every chunk), handing each
 * complete line to `onLine`. Reads up to the size seen at open, so a file that
 * grows mid-read ends at a consistent point; a partial last line is handed over
 * as-is (the consumer's JSON parse rejects it).
 */
export class ChunkedLineReader {
  private handle: FileHandle | null = null;
  private position = 0;
  private size = 0;
  private mtimeMs = 0;
  private remainder = "";
  private readonly decoder = new TextDecoder("utf-8");
  private status: "new" | "open" | ReadStatus = "new";
  /** The longest synchronous stretch (one chunk's lines folded), in ms. */
  maxSyncMs = 0;

  constructor(
    readonly path: string,
    private readonly onLine: (line: string) => void,
    private readonly opts: { maxBytes?: number; chunkBytes?: number } = {}
  ) {}

  get bytesRead(): number {
    return this.position;
  }

  get fileSize(): number {
    return this.size;
  }

  get fileMtimeMs(): number {
    return this.mtimeMs;
  }

  async step(
    deadlineMs: number,
    now: () => number = Date.now
  ): Promise<ReadStatus> {
    if (this.status !== "new" && this.status !== "open") return this.status;
    if (this.status === "new") {
      try {
        this.handle = await open(this.path, "r");
        const st = await this.handle.stat();
        this.size = st.size;
        this.mtimeMs = st.mtimeMs;
      } catch (error) {
        await this.close();
        const code = (error as NodeJS.ErrnoException | null)?.code;
        this.status = code === "ENOENT" ? "missing" : "read_error";
        return this.status;
      }
      if (this.size > (this.opts.maxBytes ?? MAX_TRANSCRIPT_BYTES)) {
        await this.close();
        this.status = "too_large";
        return this.status;
      }
      this.status = "open";
    }
    const chunk = Buffer.allocUnsafe(this.opts.chunkBytes ?? CHUNK_BYTES);
    try {
      while (this.position < this.size) {
        const want = Math.min(chunk.length, this.size - this.position);
        const { bytesRead } = await this.handle!.read(
          chunk,
          0,
          want,
          this.position
        );
        if (bytesRead <= 0) break; // truncated underneath us: end here
        this.position += bytesRead;
        const text =
          this.remainder +
          this.decoder.decode(chunk.subarray(0, bytesRead), { stream: true });
        const lines = text.split("\n");
        this.remainder = lines.pop() ?? "";
        const t0 = performance.now();
        for (const line of lines) this.onLine(line);
        this.maxSyncMs = Math.max(this.maxSyncMs, performance.now() - t0);
        if (this.position < this.size && now() >= deadlineMs) return "more";
      }
      const tail = this.remainder + this.decoder.decode();
      this.remainder = "";
      if (tail.trim() !== "") this.onLine(tail);
      await this.close();
      this.status = "done";
      return "done";
    } catch {
      await this.close();
      this.status = "read_error";
      return this.status;
    }
  }

  async close(): Promise<void> {
    const h = this.handle;
    this.handle = null;
    if (h) {
      try {
        await h.close();
      } catch {
        // already closed
      }
    }
  }
}

/** A main transcript read across ticks into segments. */
export class TranscriptReader {
  readonly fold = new TranscriptFold();
  private readonly lines: ChunkedLineReader;

  constructor(
    path: string,
    opts: { maxBytes?: number; chunkBytes?: number } = {}
  ) {
    this.lines = new ChunkedLineReader(
      path,
      line => this.fold.push(line),
      opts
    );
  }

  get path(): string {
    return this.lines.path;
  }

  get bytesRead(): number {
    return this.lines.bytesRead;
  }

  get fileSize(): number {
    return this.lines.fileSize;
  }

  get fileMtimeMs(): number {
    return this.lines.fileMtimeMs;
  }

  get maxSyncMs(): number {
    return this.lines.maxSyncMs;
  }

  step(deadlineMs: number, now?: () => number): Promise<ReadStatus> {
    return this.lines.step(deadlineMs, now);
  }

  /** The segments (call once the read is `done`). */
  segments(): TranscriptSegment[] {
    return this.fold.finish();
  }

  close(): Promise<void> {
    return this.lines.close();
  }
}

/** One sub-agent file, summed with the finalize rollup's rules. */
export interface AgentCallsSummary {
  file: string;
  status: "done" | "missing" | "read_error" | "too_large";
  /** The agent's own model (the last real assistant model). */
  model: string | null;
  in: number;
  out: number;
  cr: number;
  w1: number;
  w5: number;
  /** Priced calls (a real model and non-zero usage). */
  calls: number;
  /** Context occupancy of each priced call. */
  occupancies: number[];
}

/**
 * Read one agent file (`agent-<id>.jsonl`) to its end: usage once per
 * `message.id` (per file, as `rollupExternalSubAgents` and
 * `summarizeAgentTranscript` count it), the agent's model and per-call
 * occupancy. Agent files are small next to a main transcript, so this runs to
 * completion; a large one is still streamed, never loaded whole.
 */
export async function summarizeAgentCalls(
  path: string,
  opts: { maxBytes?: number; chunkBytes?: number } = {}
): Promise<AgentCallsSummary> {
  const out: AgentCallsSummary = {
    file: path,
    status: "done",
    model: null,
    in: 0,
    out: 0,
    cr: 0,
    w1: 0,
    w5: 0,
    calls: 0,
    occupancies: [],
  };
  const seenUuids = new Set<string>();
  const seenIds = new Set<string>();
  const reader = new ChunkedLineReader(
    path,
    line => {
      if (line.trim() === "") return;
      let rec: Record<string, unknown>;
      try {
        const v = JSON.parse(line) as unknown;
        if (!v || typeof v !== "object" || Array.isArray(v)) return;
        rec = v as Record<string, unknown>;
      } catch {
        return;
      }
      if (rec.type !== "assistant") return;
      const uuid = typeof rec.uuid === "string" ? rec.uuid : undefined;
      if (uuid !== undefined) {
        if (seenUuids.has(uuid)) return;
        seenUuids.add(uuid);
      }
      const msg = (rec.message ?? null) as TranscriptEntry["message"];
      const usage = msg?.usage;
      if (!usage) return;
      const id = typeof msg?.id === "string" && msg.id !== "" ? msg.id : null;
      if (id !== null) {
        if (seenIds.has(id)) return;
        seenIds.add(id);
      }
      const model = str(msg?.model);
      if (model && model !== SYNTHETIC_MODEL) out.model = model;
      const cc = usage.cache_creation as Record<string, unknown> | undefined;
      const cw = num(usage.cache_creation_input_tokens);
      const w1 = num(cc?.ephemeral_1h_input_tokens);
      const tin = num(usage.input_tokens);
      const tout = num(usage.output_tokens);
      const cr = num(usage.cache_read_input_tokens);
      out.in += tin;
      out.out += tout;
      out.cr += cr;
      out.w1 += w1;
      out.w5 += Math.max(0, cw - w1);
      if (model !== SYNTHETIC_MODEL && tin + tout + cr + cw > 0) {
        out.calls += 1;
        out.occupancies.push(occupancy(usage));
      }
    },
    opts
  );
  const status = await reader.step(Number.POSITIVE_INFINITY);
  out.status = status === "more" ? "done" : status;
  return out;
}

/** The sub-agent files one segment launched, summed. */
export interface SegmentAgents {
  foreground: AgentCallsSummary[];
  background: AgentCallsSummary[];
  /** Every matched launch (foreground and background), for the launch map. */
  matched: MatchedSubAgent[];
}

/**
 * Match a segment's `Task`/`Agent` launches to `subagentsDir`'s meta files with
 * the finalize rollup's own matcher, then stream each matched agent file. A
 * missing or unreadable directory matches nothing (as in the rollup).
 */
export async function readSegmentAgents(
  segment: TranscriptSegment,
  subagentsDir: string
): Promise<SegmentAgents> {
  let matched: MatchedSubAgent[] = [];
  try {
    matched = matchExternalSubAgents(
      new Set(segment.taskToolUseIds),
      new Set(segment.backgroundToolUseIds),
      subagentsDir
    );
  } catch {
    matched = []; // a malformed meta file: no rollup, like the parser's R12 path
  }
  const foreground: AgentCallsSummary[] = [];
  const background: AgentCallsSummary[] = [];
  for (const agent of matched) {
    const summary = await summarizeAgentCalls(agent.file);
    (agent.background ? background : foreground).push(summary);
  }
  return { foreground, background, matched };
}
