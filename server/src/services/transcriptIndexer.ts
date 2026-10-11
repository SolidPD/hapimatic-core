// SPDX-License-Identifier: AGPL-3.0-only
import { createReadStream, existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  SupervisedLoop,
  WORKTREE_PORT_MAX,
  WORKTREE_PORT_MIN,
  scrubThenCap,
  scrubTranscriptSecrets,
  type JobRegistry,
} from "@hapi/protocol";
import type { Session } from "@hapi/protocol/types";
import type { TranscriptIndexStatus } from "@hapi/protocol/schemas";
import {
  TranscriptIndexStore,
  type NamespaceScope,
  type TranscriptIndexRow,
} from "../store/transcriptIndexStore";
import { parseAccessToken } from "../utils/accessToken";
import { getKnownSecretLiterals } from "./knownSecretLiterals";

/**
 * Transcript indexer (issue #3839) — keeps `transcripts.db` in step with the
 * Claude JSONL transcripts on this node's disk.
 *
 * **Roots.** `~/.claude/projects` ∪ `$CLAUDE_CONFIG_DIR/projects` ∪ every
 * non-symlink `<accountConfigsDir>/<uuid>/projects` (an isolated account's
 * projects dir is normally a symlink back to the host's, #1643, but a stale
 * REAL dir orphans transcripts, #1574) — deduped by realpath. Each
 * `<root>/<slug>/<ccSessionId>.jsonl` is one row; its sibling
 * `<ccSessionId>/subagents/*.jsonl` files are folded into that row's text and
 * counted, so a search hit in a sub-agent surfaces its parent.
 *
 * **Bounded, off the hot path.** A `SupervisedLoop` (started from `index.ts`
 * AFTER listen) runs a stat-only sweep, queues new/changed files keyed by
 * (path, mtime, size), and parses at most one small batch per tick — never a
 * synchronous boot-time walk (precedent: `store/turns/backfillTurns.ts` runs as
 * a script, not at boot). A session end enqueues that session's transcript
 * immediately. Every operation shares one promise chain, so a tick and a
 * session-end reindex never overlap. Files are read line-by-line (streamed),
 * so a 100 MB transcript never lands in memory whole. Read-only on the JSONL.
 *
 * **Scrub before index (R6).** Every extracted text run, the first prompt and
 * the title pass `scrubTranscriptSecrets` (#4053: everything `scrubString`
 * masks — Anthropic, provider and age keys, bearer/JWT/`token=` — plus GitHub,
 * AWS, Telegram and `cliApiToken` values and this node's known instance-token
 * literals) BEFORE they reach the store, and each piece is scrubbed BEFORE it
 * is capped (`scrubThenCap`), so a cut can never leave a fragment unmatched.
 * Transcripts on disk are unscrubbed; the index never is.
 *
 * **Namespace (D27).** A row takes its namespace from the Hapimatic session
 * whose `metadata.claudeSessionId` matches. A transcript with no live row is an
 * orphan (`namespace = null`) — the store serves it only to the node's owning
 * namespace, resolved from the node's own `cliApiToken`.
 */

const TEXT_CAP_BYTES = 512 * 1024;
const TOOL_RESULT_CAP = 1000;
const TOOL_INPUT_CAP = 500;
const FIRST_PROMPT_CAP = 280;
const TITLE_CAP = 120;
const BATCH_FILES = 20;
/**
 * One tick's shared budget for the enumeration pass + the index batch (#4060).
 * The watchdog flags a stall when no tick has ended for stallFactor (3) ×
 * BUSY_INTERVAL_MS, and the next busy tick starts BUSY_INTERVAL_MS after the
 * last one ended — so one tick may take at most ≈ 4000 ms. Measured on RP1
 * (normal load): a full pass over ~2.6k transcripts takes 0.2–0.3 s, and the
 * worst tick is ≈ 1.8 s (this budget + one 51 MB extract + the checkpoint).
 */
const TICK_BUDGET_MS = 1000;
export const BUSY_INTERVAL_MS = 2000;
export const IDLE_INTERVAL_MS = 5 * 60 * 1000;
/**
 * A live session's transcript larger than this is re-indexed only at session
 * end, never at the idle cadence (extracting 17 MB takes ~0.2 s, 51 MB ~0.75 s
 * on RP1 — #4060).
 */
export const LIVE_REFRESH_MAX_BYTES = 16 * 1024 * 1024;
/**
 * A transcript whose file changed within this window is treated as live even
 * when no session on THIS instance owns it (#4060): every instance on a node
 * indexes the same shared `projects` corpus, but each one only knows its own
 * sessions, so another instance's live transcript looked idle and was re-parsed
 * on every pass (measured on RP1: one 31 MB re-read = 3.8 s of a ~4 s tick
 * allowance at load ~10). Once the file has been quiet this long, the next pass
 * indexes it normally. Compared against wall-clock `Date.now()` because file
 * mtimes are wall-clock.
 */
export const HOT_WINDOW_MS = IDLE_INTERVAL_MS;
/**
 * The JSONL entry types the transcript browser counts, searches and renders.
 * Shared with the messages route (`routes/transcripts.ts`) so the reader shows
 * exactly the entries the index counted.
 */
export const INDEXED_ENTRY_TYPES: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "summary",
  "system",
]);

/** One on-disk transcript: the main JSONL plus its sub-agent files. */
export interface TranscriptFile {
  ccSessionId: string;
  path: string;
  /** max(mtime) over the main file and its sub-agent files. */
  mtimeMs: number;
  /** Sum of the main file's and its sub-agent files' sizes. */
  sizeBytes: number;
  subagentPaths: string[];
}

/** The fields the indexer reads from a Hapimatic session. */
export type IndexerSession = Pick<
  Session,
  "id" | "namespace" | "metadata" | "linkedIssue"
> & {
  /** A live session's transcript is deferred to session end / idle (#4060). */
  active?: boolean;
};

export interface TranscriptIndexerOptions {
  store: TranscriptIndexStore;
  /** Candidate `projects` roots (the indexer resolves + dedupes them). */
  roots: string[];
  getSessions: () => IndexerSession[];
  /** The node's owning namespace (null → orphans hidden, fail-closed). */
  ownerNamespace: string | null;
  now?: () => number;
  /** Override LIVE_REFRESH_MAX_BYTES (tests). */
  liveRefreshMaxBytes?: number;
  /** False when the kill switch / worktree default has indexing off (#4053). */
  indexingEnabled?: () => boolean;
  /** Known secret literals masked at index time (#4053). */
  getLiterals?: () => readonly string[];
}

export interface ExtractedTranscript {
  firstUuid: string | null;
  cwd: string | null;
  gitBranch: string | null;
  startedAtMs: number | null;
  lastActivityMs: number | null;
  messageCount: number;
  firstPrompt: string | null;
  /** Scrubbed. */
  text: string;
  /** A file failed mid-read: the row is stored but retried next pass (#4053). */
  partial: boolean;
}

/** A JSONL `timestamp` (epoch ms or ISO string) as epoch ms, else null. */
export function toMs(ts: unknown): number | null {
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "string") {
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part =>
        part && typeof part === "object" && typeof part.text === "string"
          ? part.text
          : ""
      )
      .join(" ");
  }
  return "";
}

/** The repo root a (possibly worktree) cwd belongs to: strip `/.worktrees/<name>`. */
export function repoRootOf(cwd: string): string {
  const at = cwd.indexOf("/.worktrees/");
  return at >= 0 ? cwd.slice(0, at) : cwd;
}

/** The repo a cwd belongs to: the basename of its repo root. */
export function repoFromCwd(cwd: string | null): string | null {
  if (!cwd) return null;
  return basename(repoRootOf(cwd)) || null;
}

/**
 * Stream one or more JSONL files and extract the index fields. Read-only.
 * Malformed lines are skipped; a missing file contributes nothing. Every piece
 * is scrubbed with the transcript scrub (plus the node's known instance-token
 * `literals`) BEFORE it is capped (#4053).
 */
export async function extractTranscript(
  paths: string[],
  literals: readonly string[] = []
): Promise<ExtractedTranscript> {
  const out: ExtractedTranscript = {
    firstUuid: null,
    cwd: null,
    gitBranch: null,
    startedAtMs: null,
    lastActivityMs: null,
    messageCount: 0,
    firstPrompt: null,
    text: "",
    partial: false,
  };
  const parts: string[] = [];
  let textBytes = 0;
  const push = (s: string) => {
    if (!s || textBytes >= TEXT_CAP_BYTES) return;
    const piece = scrubThenCap(s, TEXT_CAP_BYTES - textBytes, literals);
    parts.push(piece);
    textBytes += piece.length + 1;
  };

  for (const [fileIndex, path] of paths.entries()) {
    const isMain = fileIndex === 0;
    let lines: AsyncIterable<string>;
    try {
      const stream = createReadStream(path, { encoding: "utf8" });
      lines = createInterface({ input: stream, crlfDelay: Infinity });
    } catch {
      continue;
    }
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let rec: Record<string, unknown>;
        try {
          const parsed = JSON.parse(line);
          if (!parsed || typeof parsed !== "object") continue;
          rec = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = rec.type;
        if (typeof type !== "string" || !INDEXED_ENTRY_TYPES.has(type))
          continue;
        if (isMain) {
          if (!out.firstUuid && typeof rec.uuid === "string") {
            out.firstUuid = rec.uuid;
          }
          if (!out.cwd && typeof rec.cwd === "string") out.cwd = rec.cwd;
          if (!out.gitBranch && typeof rec.gitBranch === "string") {
            out.gitBranch = rec.gitBranch;
          }
          const ts = toMs(rec.timestamp);
          if (ts !== null) {
            if (out.startedAtMs === null || ts < out.startedAtMs) {
              out.startedAtMs = ts;
            }
            if (out.lastActivityMs === null || ts > out.lastActivityMs) {
              out.lastActivityMs = ts;
            }
          }
        }
        if (rec.isMeta === true) continue;

        if (type === "summary") {
          if (typeof rec.summary === "string") push(rec.summary);
          continue;
        }
        const message = rec.message as Record<string, unknown> | undefined;
        const content = message?.content;
        if (type === "user") {
          if (typeof content === "string") {
            if (isMain) {
              out.messageCount += 1;
              if (out.firstPrompt === null) {
                out.firstPrompt = scrubThenCap(
                  content,
                  FIRST_PROMPT_CAP,
                  literals
                );
              }
            }
            push(content);
          } else if (Array.isArray(content)) {
            for (const part of content) {
              if (!part || typeof part !== "object") continue;
              if (part.type === "text" && typeof part.text === "string") {
                push(part.text);
              } else if (part.type === "tool_result") {
                push(
                  scrubThenCap(
                    toolResultText(part.content),
                    TOOL_RESULT_CAP,
                    literals
                  )
                );
              }
            }
          }
        } else if (type === "assistant" && Array.isArray(content)) {
          if (isMain) out.messageCount += 1;
          for (const part of content) {
            if (!part || typeof part !== "object") continue;
            if (part.type === "text" && typeof part.text === "string") {
              push(part.text);
            } else if (part.type === "tool_use") {
              const input = JSON.stringify(part.input ?? {});
              push(
                `${part.name ?? "tool"} ${scrubThenCap(input, TOOL_INPUT_CAP, literals)}`
              );
            }
          }
        }
      }
    } catch {
      // Unreadable / vanished mid-read: keep what was extracted so far, and
      // flag it so the row is not stamped current (#4053 — retried next pass).
      out.partial = true;
    }
  }

  // Every piece is already scrubbed; this pass is an idempotent backstop.
  out.text = scrubTranscriptSecrets(parts.join("\n"), literals);
  return out;
}

async function listDir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Like {@link listDir}, but tells a directory that is GONE (`ENOENT`/`ENOTDIR`
 * — its rows may be pruned) from one that cannot be READ (`EACCES`, `EIO`, …
 * — its rows must be kept), logging the latter (#4053).
 */
async function listDirChecked(
  dir: string
): Promise<{ entries: Dirent[]; unreadable: boolean }> {
  try {
    return {
      entries: await readdir(dir, { withFileTypes: true }),
      unreadable: false,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { entries: [], unreadable: false };
    }
    console.warn(
      `[TranscriptIndexer] cannot read ${dir} (${code ?? "error"}); keeping its rows`
    );
    return { entries: [], unreadable: true };
  }
}

/** Resolve the candidate roots: existing directories, deduped by realpath. */
export async function resolveRoots(candidates: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    try {
      const real = await realpath(candidate);
      const st = await stat(real);
      if (!st.isDirectory() || seen.has(real)) continue;
      seen.add(real);
      out.push(real);
    } catch {
      // Missing root — skip.
    }
  }
  return out;
}

/**
 * The default root candidates. Isolated-account `projects` dirs are included
 * ONLY when they are real directories (a symlink resolves to the host root and
 * would be deduped anyway, but skipping it avoids the extra realpath).
 */
export async function defaultRootCandidates(
  dataDir: string
): Promise<string[]> {
  const candidates = [join(homedir(), ".claude", "projects")];
  if (process.env.CLAUDE_CONFIG_DIR?.trim()) {
    candidates.push(join(process.env.CLAUDE_CONFIG_DIR.trim(), "projects"));
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  for (const base of [
    join(xdg, "hapimatic", "account-configs"),
    join(dataDir, "account-configs"),
  ]) {
    for (const entry of await listDir(base)) {
      if (!entry.isDirectory()) continue;
      const projects = join(base, entry.name, "projects");
      const inner = (await listDir(join(base, entry.name))).find(
        e => e.name === "projects"
      );
      if (inner && inner.isDirectory() && !inner.isSymbolicLink()) {
        candidates.push(projects);
      }
    }
  }
  return candidates;
}

/** One on-disk transcript, stat-only; `<cc>/subagents` read only if it exists. */
export async function statTranscript(
  projectDir: string,
  fileName: string,
  dirNames: ReadonlySet<string>
): Promise<TranscriptFile | null> {
  const ccSessionId = fileName.slice(0, -".jsonl".length);
  const path = join(projectDir, fileName);
  let st;
  try {
    st = await stat(path);
  } catch {
    return null;
  }
  let mtimeMs = Math.floor(st.mtimeMs);
  let sizeBytes = st.size;
  const subagentPaths: string[] = [];
  // #4060: most transcripts have no `<cc>/` directory — reading
  // `<cc>/subagents` for each of them was ~2.5k ENOENT readdirs per sweep.
  if (dirNames.has(ccSessionId)) {
    const subDir = join(projectDir, ccSessionId, "subagents");
    for (const sub of await listDir(subDir)) {
      if (!sub.isFile() || !sub.name.endsWith(".jsonl")) continue;
      const subPath = join(subDir, sub.name);
      try {
        const sst = await stat(subPath);
        mtimeMs = Math.max(mtimeMs, Math.floor(sst.mtimeMs));
        sizeBytes += sst.size;
        subagentPaths.push(subPath);
      } catch {
        // Vanished between readdir and stat.
      }
    }
  }
  return {
    ccSessionId,
    path,
    mtimeMs,
    sizeBytes,
    subagentPaths: subagentPaths.sort(),
  };
}

/**
 * A resumable, stat-only walk of the roots (#4060). `advancePass` scans one
 * project directory per step and stops once the deadline passes, so a tick
 * never walks the whole corpus; the caller resumes it on the next tick.
 */
export interface EnumerationPass {
  roots: string[];
  rootIdx: number;
  projects: string[] | null;
  projIdx: number;
  files: Map<string, TranscriptFile>;
  /** Directories that exist but could not be read this pass (#4053). */
  unreadable: string[];
}

export function newPass(roots: string[]): EnumerationPass {
  return {
    roots,
    rootIdx: 0,
    projects: null,
    projIdx: 0,
    files: new Map(),
    unreadable: [],
  };
}

/**
 * Advance `pass` until it completes or `now() >= deadline` (always at least one
 * step, so a pass always progresses). `deadline === null` runs to completion.
 * Returns true once every root has been walked.
 */
export async function advancePass(
  pass: EnumerationPass,
  deadline: number | null,
  now: () => number = Date.now
): Promise<boolean> {
  do {
    if (pass.rootIdx >= pass.roots.length) return true;
    const root = pass.roots[pass.rootIdx];
    if (pass.projects === null) {
      const listed = await listDirChecked(root);
      if (listed.unreadable) pass.unreadable.push(root);
      pass.projects = listed.entries
        .filter(project => project.isDirectory())
        .map(project => project.name);
      pass.projIdx = 0;
    }
    if (pass.projIdx >= pass.projects.length) {
      pass.rootIdx += 1;
      pass.projects = null;
      continue;
    }
    const projectDir = join(root, pass.projects[pass.projIdx]);
    pass.projIdx += 1;
    const listed = await listDirChecked(projectDir);
    if (listed.unreadable) pass.unreadable.push(projectDir);
    const entries = listed.entries;
    const dirNames = new Set(
      entries.filter(e => e.isDirectory()).map(e => e.name)
    );
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const file = await statTranscript(projectDir, entry.name, dirNames);
      if (!file) continue;
      const prior = pass.files.get(file.ccSessionId);
      if (!prior || prior.mtimeMs < file.mtimeMs) {
        pass.files.set(file.ccSessionId, file);
      }
    }
  } while (deadline === null || now() < deadline);
  return pass.rootIdx >= pass.roots.length;
}

/** Stat-only walk of the roots → one entry per Claude session id. */
export async function enumerateTranscripts(
  roots: string[]
): Promise<Map<string, TranscriptFile>> {
  const pass = newPass(roots);
  await advancePass(pass, null);
  return pass.files;
}

export class TranscriptIndexer {
  private readonly store: TranscriptIndexStore;
  private readonly rootCandidates: string[];
  private readonly getSessions: () => IndexerSession[];
  private readonly ownerNamespace: string | null;
  private readonly now: () => number;
  private readonly liveRefreshMaxBytes: number;
  private readonly indexingEnabled: () => boolean;
  private readonly getLiterals: () => readonly string[];
  /** ccIds whose partial read was already logged (one warning each). */
  private readonly partialLogged = new Set<string>();
  /** The last COMPLETE pass — a pass in progress never replaces it early. */
  private files = new Map<string, TranscriptFile>();
  private pending: string[] = [];
  private lastSweepAtMs: number | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  /** The resumable enumeration pass in progress (#4060). */
  private pass: EnumerationPass | null = null;
  /** Ended sessions no pass had seen yet — indexed when a pass finds them. */
  private endedUnknown = new Set<string>();
  private lastLiveRefreshAtMs: number | null = null;

  constructor(opts: TranscriptIndexerOptions) {
    this.store = opts.store;
    this.rootCandidates = opts.roots;
    this.getSessions = opts.getSessions;
    this.ownerNamespace = opts.ownerNamespace;
    this.now = opts.now ?? Date.now;
    this.liveRefreshMaxBytes =
      opts.liveRefreshMaxBytes ?? LIVE_REFRESH_MAX_BYTES;
    this.indexingEnabled = opts.indexingEnabled ?? (() => true);
    this.getLiterals = opts.getLiterals ?? (() => []);
  }

  get indexStore(): TranscriptIndexStore {
    return this.store;
  }

  /** The caller's read scope (D27): owner status decides orphan visibility. */
  scopeFor(namespace: string): NamespaceScope {
    return {
      namespace,
      isOwner:
        this.ownerNamespace !== null && namespace === this.ownerNamespace,
    };
  }

  status(): TranscriptIndexStatus {
    const total = this.files.size;
    return {
      indexed: Math.max(0, total - this.pending.length),
      total,
      fts5: this.store.fts5,
      lastSweepAtMs: this.lastSweepAtMs,
      // #4053 (M8): say so when indexing is off, so "Indexed 0 of 0" never
      // reads as "you have no transcripts".
      disabled: !this.indexingEnabled(),
    };
  }

  /**
   * The loop's next delay: fast until the first sweep has run, while a pass is
   * in progress, while a backlog remains, or while an ended session waits for a
   * pass — slow otherwise. Live sessions' transcripts are deferred, so they do
   * not keep the loop busy (#4060). (Before the first sweep the queue is empty
   * by definition — keying only on the backlog would delay every boot's
   * backfill by a full idle interval.)
   */
  nextIntervalMs(): number {
    return this.lastSweepAtMs === null ||
      this.pass !== null ||
      this.pending.length > 0 ||
      this.endedUnknown.size > 0
      ? BUSY_INTERVAL_MS
      : IDLE_INTERVAL_MS;
  }

  /** The disk path of an indexed transcript (read-side only). */
  pathOf(ccSessionId: string): string | null {
    return this.files.get(ccSessionId)?.path ?? null;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /**
   * One supervised tick, bounded by TICK_BUDGET_MS (#4060): advance the
   * enumeration pass (resuming one in progress, or starting one when the queue
   * is empty), then index a batch with whatever budget is left.
   */
  tick(): Promise<void> {
    return this.serialize(async () => {
      const deadline = this.now() + TICK_BUDGET_MS;
      if (this.pass !== null || this.pending.length === 0) {
        await this.advanceSweep(deadline);
      }
      await this.processBatch(deadline);
    });
  }

  /**
   * Session-end trigger: re-index that session's transcript now. An id no pass
   * has seen yet advances the pass under the same budget instead of a full
   * synchronous sweep; if the budget runs out, the next tick finishes it.
   */
  notifySessionEnded(
    claudeSessionId: string | null | undefined
  ): Promise<void> {
    if (!claudeSessionId) return Promise.resolve();
    const cc = claudeSessionId;
    return this.serialize(async () => {
      let known = this.files.get(cc) ?? this.pass?.files.get(cc);
      if (!known) {
        this.endedUnknown.add(cc);
        await this.advanceSweep(this.now() + TICK_BUDGET_MS);
        known = this.files.get(cc);
        if (!known) return; // pass unfinished — completePass() queues it
        await this.processBatch(this.now() + TICK_BUDGET_MS);
        return;
      }
      // Re-stat so the stored key matches the file's final state; indexing
      // with the sweep-time stat made the next pass re-index it again.
      const fresh = await statTranscript(
        dirname(known.path),
        basename(known.path),
        new Set([cc])
      );
      if (!fresh) return; // vanished — the next complete pass prunes it
      this.files.set(cc, fresh);
      await this.indexOne(fresh, this.sessionsByCcId());
      this.pending = this.pending.filter(id => id !== cc);
    });
  }

  /** Run until the pass is done and the backlog is empty (tests + diagnostics). */
  async drain(): Promise<void> {
    await this.tick();
    while (this.pass !== null || this.pending.length > 0) await this.tick();
  }

  private async advanceSweep(deadline: number): Promise<void> {
    if (this.pass === null) {
      this.pass = newPass(await resolveRoots(this.rootCandidates));
    }
    if (await advancePass(this.pass, deadline, this.now)) {
      this.completePass(this.pass.files, this.pass.unreadable);
    }
  }

  /**
   * A pass finished: adopt its file map, queue stale transcripts (deferring the
   * already-indexed transcripts of live sessions — this instance's own, or any
   * instance's, judged by a recent write), and — only now, after a COMPLETE
   * walk — drop rows whose JSONL is gone.
   */
  private completePass(
    files: Map<string, TranscriptFile>,
    unreadable: readonly string[] = []
  ): void {
    this.pass = null;
    this.files = files;
    const indexed = this.store.getIndexedKeys();
    const live = this.liveCcIds();
    const stale: string[] = [];
    const deferred = new Set<string>();
    const wallNowMs = Date.now();
    for (const [cc, file] of files) {
      const key = indexed.get(cc);
      if (
        key &&
        key.path === file.path &&
        key.mtimeMs === file.mtimeMs &&
        key.sizeBytes === file.sizeBytes
      ) {
        continue;
      }
      // A live session's transcript is indexed once, then refreshed at the
      // idle cadence or at session end — it never keeps the loop busy. "Live"
      // is this instance's own active session OR a recent write (another
      // instance's live session on the same corpus).
      const hot = wallNowMs - file.mtimeMs < HOT_WINDOW_MS;
      if (key && (live.has(cc) || hot) && !this.endedUnknown.has(cc)) {
        deferred.add(cc);
      } else {
        stale.push(cc);
      }
    }
    const nowMs = this.now();
    if (this.lastLiveRefreshAtMs === null) {
      this.lastLiveRefreshAtMs = nowMs;
    } else if (
      deferred.size > 0 &&
      nowMs - this.lastLiveRefreshAtMs >= IDLE_INTERVAL_MS
    ) {
      for (const cc of deferred) {
        if ((files.get(cc)?.sizeBytes ?? 0) <= this.liveRefreshMaxBytes) {
          stale.push(cc);
          deferred.delete(cc);
        }
      }
      this.lastLiveRefreshAtMs = nowMs;
    }
    // Newest first, so recent history becomes searchable soonest.
    stale.sort(
      (a, b) => (files.get(b)?.mtimeMs ?? 0) - (files.get(a)?.mtimeMs ?? 0)
    );
    this.pending = stale;
    this.endedUnknown.clear();
    // A row under a directory that could not be READ is kept: absence of a
    // listing is not absence of the file (#4053). ENOENT still prunes.
    const underUnreadable = (path: string): boolean =>
      unreadable.some(dir => path.startsWith(`${dir}/`));
    const gone = [...indexed.entries()]
      .filter(([cc, key]) => !files.has(cc) && !underUnreadable(key.path))
      .map(([cc]) => cc);
    this.store.deleteMany(gone);
    this.lastSweepAtMs = nowMs;
  }

  private liveCcIds(): Set<string> {
    const ids = new Set<string>();
    for (const s of this.getSessions()) {
      const cc = s.metadata?.claudeSessionId;
      if (cc && s.active === true) ids.add(cc);
    }
    return ids;
  }

  private sessionsByCcId(): Map<string, IndexerSession> {
    const map = new Map<string, IndexerSession>();
    for (const s of this.getSessions()) {
      const cc = s.metadata?.claudeSessionId;
      if (cc) map.set(cc, s);
    }
    return map;
  }

  private async processBatch(deadline: number): Promise<void> {
    if (this.pending.length === 0) return;
    const sessions = this.sessionsByCcId();
    let done = 0;
    while (
      this.pending.length > 0 &&
      done < BATCH_FILES &&
      this.now() < deadline
    ) {
      const cc = this.pending.shift() as string;
      const file = this.files.get(cc);
      if (file) await this.indexOne(file, sessions);
      done += 1;
    }
  }

  private async indexOne(
    file: TranscriptFile,
    sessions: Map<string, IndexerSession>
  ): Promise<void> {
    const literals = this.getLiterals();
    const extracted = await extractTranscript(
      [file.path, ...file.subagentPaths],
      literals
    );
    if (extracted.partial && !this.partialLogged.has(file.ccSessionId)) {
      this.partialLogged.add(file.ccSessionId);
      console.warn(
        `[TranscriptIndexer] partial read of ${file.path}; will retry on the next pass`
      );
    }
    const session = sessions.get(file.ccSessionId) ?? null;
    const meta = session?.metadata ?? null;
    const cwd = extracted.cwd ?? meta?.path ?? null;
    const rawTitle =
      meta?.name || meta?.summary?.text || extracted.firstPrompt || null;
    const row: TranscriptIndexRow = {
      ccSessionId: file.ccSessionId,
      path: file.path,
      // A partial extract keeps its text but never looks current, so the
      // next completed pass queues it again (#4053).
      mtimeMs: extracted.partial ? 0 : file.mtimeMs,
      sizeBytes: file.sizeBytes,
      namespace: session?.namespace ?? null,
      hapiSessionId: session?.id ?? null,
      hasSessionRow: session !== null,
      firstUuid: extracted.firstUuid,
      title: rawTitle ? scrubThenCap(rawTitle, TITLE_CAP, literals) : null,
      cwd,
      gitBranch: extracted.gitBranch,
      repo: meta?.worktree?.basePath
        ? basename(meta.worktree.basePath)
        : repoFromCwd(cwd),
      harness: meta?.flavor ?? "claude",
      account: meta?.claudeAccount?.email ?? meta?.accountUuid ?? null,
      linkedIssue: session?.linkedIssue?.number ?? null,
      startedAtMs: extracted.startedAtMs,
      lastActivityMs: extracted.lastActivityMs ?? file.mtimeMs,
      messageCount: extracted.messageCount,
      subagentCount: file.subagentPaths.length,
      firstPrompt: extracted.firstPrompt,
      text: extracted.text,
    };
    this.store.upsert(row, this.now());
  }
}

// ───────────────────────── process singleton ─────────────────────────
//
// `index.ts` is at its `max-lines` ceiling, so it wires this module with a
// namespace import + one `start(...)` + one `stop()` line; the routes read the
// running instance through `getTranscriptIndexer()` (buildWebApp mounts them
// without a new startWebServer option — `web/server.ts` is also at its cap).

let instance: TranscriptIndexer | null = null;
let loop: SupervisedLoop | null = null;
let indexing = true;

/**
 * The boot state the routes report (#4053): `starting` → 503 "starting";
 * `failed` → a distinct start error; `disabled-no-index` → indexing is off
 * and no `transcripts.db` exists (none is created). `running` covers a live
 * index AND a disabled one that still reads an existing database.
 */
export type TranscriptIndexState =
  | "starting"
  | "running"
  | "disabled-no-index"
  | "failed";
let state: TranscriptIndexState = "starting";

export function getTranscriptIndexer(): TranscriptIndexer | null {
  return instance;
}

export function getTranscriptIndexState(): TranscriptIndexState {
  return state;
}

const GATE_OFF = new Set(["0", "false", "no", "off"]);
const GATE_ON = new Set(["1", "true", "yes", "on"]);

/** Where the resolved indexing state came from (logged at start). */
export interface IndexingGate {
  enabled: boolean;
  source: "env" | "worktree-default" | "default";
  /** A set-but-unrecognised switch value (then the default applies). */
  ignored?: string;
}

/**
 * The indexing switch (#4053, building on the #4060 kill switch — ONE flag).
 * An explicit `HAPI_TRANSCRIPT_INDEXER_ENABLED` wins: `0`/`false`/`no`/`off`
 * turns indexing off, `1`/`true`/`yes`/`on` turns it on (trimmed,
 * case-insensitive). Unset, empty or unrecognised → the default: OFF on a
 * worktree instance (listen port in the worktree range), because every
 * instance otherwise builds its own ~200 MB copy of the same corpus; ON for
 * prod and dev. Off keeps an existing index readable but runs no sweeps and
 * no session-end re-index.
 */
export function resolveIndexingGate(
  env: Record<string, string | undefined> = process.env,
  opts: { listenPort?: number } = {}
): IndexingGate {
  const raw = env.HAPI_TRANSCRIPT_INDEXER_ENABLED;
  const value = raw?.trim().toLowerCase() ?? "";
  if (GATE_OFF.has(value)) return { enabled: false, source: "env" };
  if (GATE_ON.has(value)) return { enabled: true, source: "env" };
  const port = opts.listenPort;
  const worktree =
    port !== undefined &&
    port >= WORKTREE_PORT_MIN &&
    port <= WORKTREE_PORT_MAX;
  return {
    enabled: !worktree,
    source: worktree ? "worktree-default" : "default",
    ...(value !== "" ? { ignored: raw } : {}),
  };
}

/** Back-compat wrapper over {@link resolveIndexingGate}. */
export function indexingEnabledFromEnv(
  env: Record<string, string | undefined> = process.env,
  opts: { listenPort?: number } = {}
): boolean {
  return resolveIndexingGate(env, opts).enabled;
}

/** Boot wiring (called once from `index.ts`, AFTER listen). Fail-soft. */
export function start(opts: {
  config: { dataDir: string; cliApiToken: string; webappPort?: number };
  jobNodeId: string;
  jobRegistry: JobRegistry;
  syncEngine: { getSessions(): IndexerSession[] } | null;
}): void {
  if (instance) return;
  const gate = resolveIndexingGate(process.env, {
    listenPort: opts.config.webappPort,
  });
  indexing = gate.enabled;
  if (gate.ignored !== undefined) {
    console.warn(
      `[TranscriptIndexer] ignoring HAPI_TRANSCRIPT_INDEXER_ENABLED=${JSON.stringify(gate.ignored)} (use 1/true/yes/on or 0/false/no/off)`
    );
  }
  console.log(
    `[TranscriptIndexer] indexing ${indexing ? "on" : "off"} (source: ${gate.source})`
  );
  const dbPath = join(opts.config.dataDir, "transcripts.db");
  if (!indexing && !existsSync(dbPath)) {
    // Nothing to read and nothing to build: never create the database.
    state = "disabled-no-index";
    return;
  }
  state = "starting";
  void (async () => {
    try {
      const store = new TranscriptIndexStore(dbPath);
      instance = new TranscriptIndexer({
        store,
        roots: await defaultRootCandidates(opts.config.dataDir),
        getSessions: () => opts.syncEngine?.getSessions() ?? [],
        ownerNamespace:
          parseAccessToken(opts.config.cliApiToken)?.namespace ?? null,
        indexingEnabled: () => indexing,
        getLiterals: () =>
          getKnownSecretLiterals({ ownToken: opts.config.cliApiToken }),
      });
      const indexer = instance;
      loop = new SupervisedLoop({
        name: "transcript-indexer",
        node: opts.jobNodeId,
        intervalMs: BUSY_INTERVAL_MS,
        getIntervalMs: () => indexer.nextIntervalMs(),
        immediate: false,
        enabled: indexing,
        registry: opts.jobRegistry,
        tick: async () => {
          await indexer.tick();
          store.walCheckpoint();
        },
      });
      loop.start();
      state = "running";
    } catch (error) {
      state = "failed";
      console.error("[TranscriptIndexer] failed to start:", error);
    }
  })();
}

export function stop(): void {
  loop?.stop();
  loop = null;
  instance?.indexStore.close();
  instance = null;
  state = "starting";
}

/** `syncEngine.handleSessionEnd` hook — no-op until the indexer is running. */
export function notifySessionEnded(
  claudeSessionId: string | null | undefined
): void {
  // Disabled: an unknown session id would otherwise trigger a full sweep.
  if (!instance || !indexing) return;
  instance.notifySessionEnded(claudeSessionId).catch(error => {
    console.warn("[TranscriptIndexer] session-end reindex failed:", error);
  });
}
