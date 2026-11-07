// SPDX-License-Identifier: AGPL-3.0-only
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  RETENTION_WINDOW_DAYS,
  SupervisedLoop,
  parseTurnFacts,
  type JobFailureEvent,
  type JobRegistry,
} from "@hapi/protocol";
import {
  expectationOf,
  type FactsTurnRow,
  type FactsWrite,
  type ProgressRow,
  type ThroughputFactsStore,
} from "../store/throughput/factsStore";
import { bgFingerprint, computeSessionFacts } from "./sessionFacts";
import {
  MAX_TRANSCRIPT_BYTES,
  TranscriptReader,
  summarizeAgentCalls,
  type ReadStatus,
} from "./transcriptCalls";
import { backgroundFacts, capFacts, factsFingerprint } from "./turnFacts";

/**
 * The `throughput-facts` loop (issue #6164, A1 — R1, R3, R13, R14).
 *
 * Node-local: it reads ONLY this node's transcripts and writes ONLY this node's
 * `turns.throughput_json`; the #4614 mirror carries the facts to every peer.
 *
 * Each tick, inside {@link TICK_BUDGET_MS}:
 *   1. Discovery — a cursor over local `turns.change_seq` (finalized rows):
 *      a row inside the 35-day window whose fingerprint differs from its
 *      progress row is marked `pending` BEFORE the cursor advances, so the
 *      node-local progress table is a persisted work queue (a restart loses
 *      nothing). The loop's own writes come back through the cursor and are
 *      skipped, because a facts write leaves the fingerprint unchanged.
 *      Older rows get `out_of_window` and no write (stamping old rows would
 *      re-replicate the whole ledger).
 *   2. Background agents — an agent that completed since the last tick refolds
 *      only the `bg` section of the turn that launched it, from its own file.
 *   3. Transcripts — pending rows are grouped by Claude session. A live file
 *      waits (`deferred`) until it has been quiet {@link LIVE_QUIET_MS}, and an
 *      active session is collected at most every {@link LIVE_REFRESH_MS}. The
 *      read streams and resumes across ticks; then segments are aligned to the
 *      session's rows, facts are computed per row and written by
 *      compare-and-set in bounded batches, yielding between them.
 *
 * Fail-open: a throw never escapes the SupervisedLoop, and nothing here ever
 * blocks a session (the work is off every session path).
 */

export const FACTS_LOOP_NAME = "throughput-facts";
export const TICK_BUDGET_MS = 750;
export const BUSY_INTERVAL_MS = 5_000;
export const IDLE_INTERVAL_MS = 5 * 60_000;
export const LIVE_QUIET_MS = 5 * 60_000;
export const LIVE_REFRESH_MS = 6 * 3_600_000;
export const DEFER_RECHECK_MS = 5 * 60_000;
export const PROGRESS_RETENTION_DAYS = 60;
const DISCOVERY_BATCH = 500;
const WORK_BATCH = 200;
const BG_BATCH = 200;
const MAX_READ_ATTEMPTS = 3;
const DAY_MS = 86_400_000;

const CURSOR_KEY = "facts.cursor";
const BG_CURSOR_KEY = "facts.bg_cursor";
const PRUNE_KEY = "facts.pruned_day";

export interface FactsCollectorOptions {
  facts: ThroughputFactsStore;
  /** Wall clock (ms): windows, file mtimes. */
  now?: () => number;
  /** Budget clock (ms, monotonic). */
  monotonic?: () => number;
  tickBudgetMs?: number;
  retentionDays?: number;
  /** Known secret literals masked in test-unit ids. */
  literals?: () => readonly string[];
  maxTranscriptBytes?: number;
  chunkBytes?: number;
}

export interface FactsTickReport {
  discovered: number;
  written: number;
  unchanged: number;
  refused: number;
  bgRefolded: number;
  outcomes: Record<string, number>;
  bytesRead: number;
  tickMs: number;
  maxSyncMs: number;
  busy: boolean;
}

interface ReadJob {
  cc: string;
  path: string;
  reader: TranscriptReader;
  rowIds: string[];
  bytesSeen: number;
}

function emptyReport(): FactsTickReport {
  return {
    discovered: 0,
    written: 0,
    unchanged: 0,
    refused: 0,
    bgRefolded: 0,
    outcomes: {},
    bytesRead: 0,
    tickMs: 0,
    maxSyncMs: 0,
    busy: false,
  };
}

const yieldToEventLoop = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, 0));

function ccOf(row: FactsTurnRow): string | null {
  if (row.ccSessionId) return row.ccSessionId;
  return row.transcriptPath ? basename(row.transcriptPath, ".jsonl") : null;
}

export class ThroughputFactsCollector {
  private job: ReadJob | null = null;
  private busy = true;
  private readonly now: () => number;
  private readonly mono: () => number;

  constructor(private readonly opts: FactsCollectorOptions) {
    this.now = opts.now ?? Date.now;
    this.mono = opts.monotonic ?? (() => performance.now());
  }

  /** True while work is queued or a read is mid-file (the loop's busy cadence). */
  get isBusy(): boolean {
    return this.busy;
  }

  async tick(): Promise<FactsTickReport> {
    const facts = this.opts.facts;
    const report = emptyReport();
    const start = this.mono();
    const deadline = start + (this.opts.tickBudgetMs ?? TICK_BUDGET_MS);
    this.pruneDaily();
    report.discovered = this.discover();
    await this.refreshBackgroundAgents(report);

    while (this.mono() < deadline) {
      if (!this.job) {
        this.job = await this.nextJob(report);
        if (!this.job) break;
      }
      const job = this.job;
      const status = await job.reader.step(deadline, this.mono);
      report.bytesRead += job.reader.bytesRead - job.bytesSeen;
      job.bytesSeen = job.reader.bytesRead;
      report.maxSyncMs = Math.max(report.maxSyncMs, job.reader.maxSyncMs);
      if (status === "more") break;
      this.job = null;
      await this.finishJob(job, status, report);
    }
    this.busy = this.job !== null || facts.hasPending();
    report.busy = this.busy;
    report.tickMs = this.mono() - start;
    return report;
  }

  /** Abandon a read in progress (shutdown). */
  async close(): Promise<void> {
    const job = this.job;
    this.job = null;
    if (job) await job.reader.close();
  }

  // ─────────────────────────── discovery ───────────────────────────

  private discover(): number {
    const facts = this.opts.facts;
    const cursor = Number(facts.getState(CURSOR_KEY) ?? "0");
    const rows = facts.listChangedSince(cursor, DISCOVERY_BATCH);
    if (rows.length === 0) return 0;
    const now = this.now();
    const windowStart =
      now - (this.opts.retentionDays ?? RETENTION_WINDOW_DAYS) * DAY_MS;
    const keepStart = now - PROGRESS_RETENTION_DAYS * DAY_MS;
    const progress = facts.getProgress(rows.map(r => r.id));
    const updates: ProgressRow[] = [];
    let queued = 0;
    for (const row of rows) {
      const fp = factsFingerprint(expectationOf(row));
      const p = progress.get(row.id);
      if (row.startedAtMs < windowStart) {
        // No facts outside the transcript window. A row older than the
        // progress retention needs no record (it would be pruned today).
        if (
          row.startedAtMs >= keepStart &&
          (!p || p.outcome !== "out_of_window" || p.fp !== fp)
        ) {
          updates.push(progressOf(row, fp, "out_of_window", now));
        }
        continue;
      }
      if (p && (p.outcome === "pending" || p.outcome === "deferred")) continue;
      if (p && p.fp === fp) continue; // done for this fingerprint
      updates.push({
        ...progressOf(row, null, "pending", now),
        attempts: 0,
        bgFp: p?.bgFp ?? null,
      });
      queued += 1;
    }
    facts.upsertProgress(updates);
    facts.setState(CURSOR_KEY, String(rows[rows.length - 1]!.changeSeq));
    return queued;
  }

  // ─────────────────────────── transcripts ───────────────────────────

  private async nextJob(report: FactsTickReport): Promise<ReadJob | null> {
    const facts = this.opts.facts;
    const now = this.now();
    const work = facts.listWork(now - DEFER_RECHECK_MS, WORK_BATCH);
    if (work.length === 0) return null;
    const groups = new Map<string, FactsTurnRow[]>();
    const noTranscript: ProgressRow[] = [];
    for (const p of work) {
      const row = facts.getTurn(p.turnId);
      if (!row) {
        // The turn row is gone (session deleted): nothing to collect.
        noTranscript.push({ ...p, outcome: "missing", lastMs: now });
        continue;
      }
      const cc = ccOf(row);
      if (!cc || !row.transcriptPath) {
        record(report, "missing");
        noTranscript.push(
          progressOf(row, factsFingerprint(expectationOf(row)), "missing", now)
        );
        continue;
      }
      const list = groups.get(cc) ?? [];
      list.push(row);
      groups.set(cc, list);
    }
    facts.upsertProgress(noTranscript);

    for (const [cc, rows] of groups) {
      const path = rows[0]!.transcriptPath!;
      const verdict = await this.liveVerdict(cc, path, rows, now);
      if (verdict === "read") {
        return {
          cc,
          path,
          reader: new TranscriptReader(path, {
            maxBytes: this.opts.maxTranscriptBytes ?? MAX_TRANSCRIPT_BYTES,
            chunkBytes: this.opts.chunkBytes,
          }),
          rowIds: rows.map(r => r.id),
          bytesSeen: 0,
        };
      }
      record(report, verdict, rows.length);
      facts.upsertProgress(
        rows.map(row => {
          const fp =
            verdict === "deferred"
              ? null
              : factsFingerprint(expectationOf(row));
          return progressOf(row, fp, verdict, now);
        })
      );
    }
    return null;
  }

  /** Read now, or why not (directive 4.6 live-file policy). */
  private async liveVerdict(
    cc: string,
    path: string,
    rows: readonly FactsTurnRow[],
    now: number
  ): Promise<"read" | "deferred" | "missing" | "read_error" | "too_large"> {
    let size: number;
    let mtimeMs: number;
    try {
      const st = await stat(path);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      return code === "ENOENT" ? "missing" : "read_error";
    }
    if (size > (this.opts.maxTranscriptBytes ?? MAX_TRANSCRIPT_BYTES)) {
      return "too_large";
    }
    if (now - mtimeMs < LIVE_QUIET_MS) return "deferred";
    const facts = this.opts.facts;
    const active = rows.some(r => facts.sessionIsActive(r.hapiSessionId));
    if (active) {
      const last = facts.lastCollectedMs(cc);
      if (last !== null && now - last < LIVE_REFRESH_MS) return "deferred";
    }
    return "read";
  }

  private async finishJob(
    job: ReadJob,
    status: ReadStatus,
    report: FactsTickReport
  ): Promise<void> {
    const facts = this.opts.facts;
    const now = this.now();
    if (status !== "done") {
      const progress = facts.getProgress(job.rowIds);
      const updates: ProgressRow[] = [];
      for (const id of job.rowIds) {
        const row = facts.getTurn(id);
        if (!row) continue;
        const attempts = (progress.get(id)?.attempts ?? 0) + 1;
        // A read error is retried a few times (deferred), then recorded.
        const retry = status === "read_error" && attempts < MAX_READ_ATTEMPTS;
        const outcome = retry ? "deferred" : (status as ProgressRow["outcome"]);
        record(report, outcome);
        updates.push({
          ...progressOf(
            row,
            retry ? null : factsFingerprint(expectationOf(row)),
            outcome,
            now
          ),
          attempts,
        });
      }
      facts.upsertProgress(updates);
      return;
    }

    const segments = job.reader.segments();
    const sessionRows = facts.listForCcSession(job.cc);
    const known = new Set(sessionRows.map(r => r.id));
    for (const id of job.rowIds) {
      if (known.has(id)) continue;
      const row = facts.getTurn(id);
      if (row) sessionRows.push(row);
    }
    // Fresh reads: a row may have moved mid-read.
    const targets: FactsTurnRow[] = [];
    for (const id of job.rowIds) {
      const row = facts.getTurn(id);
      if (row && row.status !== "open") targets.push(row);
    }
    const byId = new Map(targets.map(r => [r.id, r]));
    const results = await computeSessionFacts({
      facts,
      sessionRows,
      targets,
      segments,
      subagentsDir: join(dirname(job.path), job.cc, "subagents"),
      literals: this.opts.literals?.() ?? [],
    });
    const writes: FactsWrite[] = [];
    const done = new Map<string, ProgressRow>();
    const progress: ProgressRow[] = [];
    for (const r of results) {
      const row = byId.get(r.id)!;
      if (r.status === "unaligned") {
        record(report, "unaligned");
        progress.push(progressOf(row, r.fp, "unaligned", now));
        continue;
      }
      writes.push({ id: r.id, json: r.json, expect: expectationOf(row) });
      if (
        r.launches.length > 0 ||
        facts.listBackgroundLaunches(r.id).length > 0
      ) {
        facts.replaceBackgroundLaunches(r.id, r.launches);
      }
      done.set(r.id, {
        ...progressOf(row, r.fp, "facts", now),
        fileSize: job.reader.fileSize,
        fileMtimeMs: job.reader.fileMtimeMs,
        bgFp: r.bgFp,
      });
    }

    let pending = writes;
    while (pending.length > 0) {
      const r = facts.writeFactsBatch(pending);
      if (r.busy) {
        // Nothing in this batch was written: those rows stay `pending`.
        for (const w of pending) done.delete(w.id);
        break;
      }
      report.written += r.written;
      report.unchanged += r.unchanged;
      report.refused += r.refused;
      for (const id of r.refusedIds) {
        // A fingerprint column moved mid-collection: recompute it.
        const p = done.get(id);
        if (p) done.set(id, { ...p, fp: null, outcome: "pending" });
      }
      pending = pending.slice(r.consumed);
      if (pending.length > 0) await yieldToEventLoop();
    }
    for (const p of done.values()) record(report, p.outcome);
    facts.upsertProgress([...progress, ...done.values()]);
  }

  // ─────────────────────────── background agents ───────────────────────────

  private async refreshBackgroundAgents(
    report: FactsTickReport
  ): Promise<void> {
    const facts = this.opts.facts;
    const cursor = Number(facts.getState(BG_CURSOR_KEY) ?? "0");
    const ended = facts.listBackgroundAgentsEndedSince(cursor, BG_BATCH);
    if (ended.length === 0) return;
    const turnIds = new Set<string>();
    let maxEnded = cursor;
    for (const a of ended) {
      maxEnded = Math.max(maxEnded, a.endedAtMs ?? cursor);
      if (!a.toolUseId) continue;
      const turnId = facts.launchingTurnOf(a.toolUseId);
      if (turnId) turnIds.add(turnId);
    }
    let busy = false;
    for (const turnId of turnIds) {
      const outcome = await this.refoldBackground(turnId, report);
      if (outcome === "written") report.bgRefolded += 1;
      else if (outcome === "busy") busy = true;
    }
    // A busy write stored nothing, and discovery never re-queues a turn whose
    // row did not change, so moving the cursor would lose the agent's usage
    // for good (#6164 round 1, IR4). Keep it and re-read the batch next tick
    // (a refold is idempotent).
    if (busy) return;
    // A full batch may end mid-millisecond: re-read that millisecond next tick.
    const next = ended.length === BG_BATCH ? maxEnded - 1 : maxEnded;
    facts.setState(BG_CURSOR_KEY, String(Math.max(cursor, next)));
  }

  /** Rewrite only `bg` of a collected turn from its agents' own files. */
  private async refoldBackground(
    turnId: string,
    report: FactsTickReport
  ): Promise<"written" | "busy" | "none"> {
    const facts = this.opts.facts;
    const row = facts.getTurn(turnId);
    if (!row?.throughputJson || !row.transcriptPath) return "none";
    const old = parseTurnFacts(row.throughputJson);
    if (!old) return "none";
    const now = this.now();
    const fp = factsFingerprint(expectationOf(row));
    if (old.fp !== fp) {
      // The ledger moved since collection: a full recompute, not a patch.
      facts.upsertProgress([progressOf(row, null, "pending", now)]);
      return "none";
    }
    const launches = facts.listBackgroundLaunches(turnId);
    const cc = ccOf(row)!;
    const dir = join(dirname(row.transcriptPath), cc, "subagents");
    const files = [];
    for (const l of launches) {
      if (l.agentId) {
        files.push(
          await summarizeAgentCalls(join(dir, `agent-${l.agentId}.jsonl`))
        );
      }
    }
    const out = capFacts({
      ...old,
      bg: backgroundFacts(launches.length, files),
    });
    const r = facts.writeFactsBatch([
      { id: turnId, json: out.json, expect: expectationOf(row) },
    ]);
    report.written += r.written;
    report.unchanged += r.unchanged;
    report.refused += r.refused;
    const prev = facts.getProgress([turnId]).get(turnId);
    if (prev && r.refused === 0 && !r.busy) {
      facts.upsertProgress([
        { ...prev, bgFp: bgFingerprint(files), lastMs: now },
      ]);
    }
    if (r.busy) return "busy";
    return r.written > 0 ? "written" : "none";
  }

  private pruneDaily(): void {
    const facts = this.opts.facts;
    const now = this.now();
    const today = new Date(now).toISOString().slice(0, 10);
    if (facts.getState(PRUNE_KEY) === today) return;
    facts.pruneProgress(now - PROGRESS_RETENTION_DAYS * DAY_MS);
    facts.setState(PRUNE_KEY, today);
  }
}

function progressOf(
  row: FactsTurnRow,
  fp: string | null,
  outcome: ProgressRow["outcome"],
  now: number
): ProgressRow {
  return {
    turnId: row.id,
    startedAtMs: row.startedAtMs,
    fp,
    outcome,
    attempts: 0,
    lastMs: now,
    fileSize: null,
    fileMtimeMs: null,
    bgFp: null,
  };
}

function record(report: FactsTickReport, outcome: string, n = 1): void {
  report.outcomes[outcome] = (report.outcomes[outcome] ?? 0) + n;
}

/** The loop's per-tick observability, recorded on its registry row (R14). */
export interface FactsLoopMetrics {
  tickMs: number;
  mbRead: number;
  rowsWritten: number;
  longestSyncMs: number;
  outcomes: Record<string, number>;
}

/**
 * Build the `throughput-facts` SupervisedLoop (busy 5 s / idle 5 min). A
 * disabled loop still registers, as `stopped`, so it shows in System Jobs.
 */
export function createFactsLoop(opts: {
  collector: ThroughputFactsCollector;
  node: string;
  enabled: boolean;
  registry?: JobRegistry;
  onEvent?: (event: JobFailureEvent) => void;
}): SupervisedLoop {
  const { collector, registry } = opts;
  return new SupervisedLoop({
    name: FACTS_LOOP_NAME,
    node: opts.node,
    intervalMs: IDLE_INTERVAL_MS,
    getIntervalMs: () =>
      collector.isBusy ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS,
    enabled: opts.enabled,
    immediate: false,
    registry,
    onEvent: opts.onEvent,
    tick: async () => {
      const r = await collector.tick();
      const metrics: FactsLoopMetrics = {
        tickMs: Math.round(r.tickMs),
        mbRead: Math.round((r.bytesRead / (1024 * 1024)) * 100) / 100,
        rowsWritten: r.written,
        longestSyncMs: Math.round(r.maxSyncMs),
        outcomes: r.outcomes,
      };
      registry?.update(FACTS_LOOP_NAME, { throughput: metrics });
    },
  });
}
