// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #4383: `BackgroundAgentTracker` — the single component that sees every
 * launcher's background-Agent START and END.
 *
 * Why the CLI owns this counter (not the web): remote (SDK) sessions see
 * `system/task_started` / `system/task_notification` on the SDK stream, but
 * **local (tmux/pty) sessions never forward the completion** — Claude Code
 * records it as a `queue-operation` line that the session scanner skips as
 * internal. The CLI is therefore the only process that observes both launchers'
 * starts AND ends and owns the session's `subagents/` disk. The derived snapshot
 * rides the always-present keepAlive runtime (the `rateLimited` contract, Task 3).
 *
 * This is a pure detector in the spirit of `contextUsageDetector.ts`: it is fed
 * parsed messages/lines and holds state, and it reads the session's `subagents/`
 * directory only when explicitly reconciled (`reconcile`) or for the ONE cheap
 * existence check that separates a real agent's completion from a background Bash
 * shell's (R6). It never performs network I/O and never touches keepAlive — the
 * owning `SessionBase` reads `snapshot()` each tick.
 *
 * Lifecycle (DD14 / T1): a done agent's badge clears on the first turn END after
 * the last completion was CONSUMED (the `queue-operation` `remove`, else the
 * notification), driven by `SessionBase.onThinkingChange(false)` — never a turn
 * start. See `onTurnEnd` + `maybeClear`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  BackgroundAgentEntry,
  BackgroundAgentsSnapshot,
} from "@hapi/protocol/schemas";
import {
  foldSessionTokenUsage,
  type TokenUsageRow,
} from "@hapi/protocol/tokenUsageAggregation";

export type { BackgroundAgentEntry, BackgroundAgentsSnapshot };

export type BackgroundAgentStatus = "running" | "done" | "error";

/** Max agents carried in the snapshot list (oldest finished dropped first). */
const AGENT_LIST_CAP = 50;
/** Description field cap in the snapshot list. */
const DESCRIPTION_CAP = 200;
/** A tracked running agent whose file has been silent this long AND ends in a
 *  finished `end_turn` line is drift-detected as done (a missed completion). */
const DRIFT_SILENCE_MS = 10 * 60 * 1000;

/**
 * SDK `task_type` strings that name a background **Bash shell**, not an agent —
 * excluded from the count (R6 / DD17). PINNED from a live Claude Code 2.1.287
 * remote session (#4383 Task 8 / V4): a background Bash shell's `task_started`
 * carries `task_type:"local_bash"` and a background Agent's carries
 * `task_type:"local_agent"`. The earlier `["bash","shell"]` guess MISSED
 * `local_bash` and counted the shell — caught by the V4 live run. `bash`/`shell`
 * are kept as defensive aliases. The disk-check discriminator
 * (`agent-<id>.meta.json` existence) remains the authoritative LOCAL-mode guard.
 */
export const SHELL_TASK_TYPES = new Set<string>([
  "local_bash",
  "bash",
  "shell",
]);

/**
 * Generic SDK `task_type` values that are NOT a user-meaningful agent name — a
 * background Agent's `task_started` reports the generic `local_agent`, while the
 * Agent tool_use carries the real `subagent_type` (e.g. "Explore"). The tracker
 * prefers the specific subagent_type over a generic type for display (#4383 V4).
 */
const GENERIC_AGENT_TYPES = new Set<string>([
  "local_agent",
  "remote_agent",
  "agent",
  "",
]);

/** Prefer a specific agent type (subagent_type) over a generic one. */
function betterAgentType(
  current: string,
  incoming: string | undefined
): string {
  if (!incoming) return current;
  if (GENERIC_AGENT_TYPES.has(current) && !GENERIC_AGENT_TYPES.has(incoming))
    return incoming;
  return current || incoming;
}

interface InternalAgent extends BackgroundAgentEntry {
  /** The `remove` time (local) or the notification time (SDK) — the T1 clock. */
  consumedAt?: number;
  /** Last completion-record timestamp applied, for idempotent re-delivery. */
  lastNotificationTs?: number;
  /** Last size/mtime seen for the drift guard (reconcile). */
  lastMetaMtime?: number;
  /** PENDING-ONLY (#4599): the `Agent` tool_use carried `run_in_background:true`.
   *  Gates the tool_result tap — a flagged launch is background. `snapshot()` maps
   *  fields explicitly, so this never leaks into a `BackgroundAgentEntry`. */
  runInBackground?: boolean;
  /** #4385: the agent file's (mtime, size) when `tokens` was last summed — an
   *  unchanged file is never re-read. */
  tokensFileMtime?: number;
  tokensFileSize?: number;
}

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec | undefined {
  return typeof v === "object" && v !== null ? (v as Rec) : undefined;
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Parse an ISO-8601 string or epoch-ms number to epoch ms, else undefined. */
function parseTs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

/** Extract `agentId: <id>` from a launch tool_result's text. */
function parseAgentIdFromResult(text: string): string | undefined {
  const m = text.match(/agentId:\s*"?([A-Za-z0-9_-]+)"?/);
  return m ? m[1] : undefined;
}

/** Extract a background Bash shell's id from its launch tool_result text
 *  (`Command running in background with ID: <id>`). #4388 Task 5. */
function parseShellIdFromResult(text: string): string | undefined {
  const m = text.match(
    /Command running in background with ID:\s*"?([A-Za-z0-9_-]+)"?/
  );
  return m ? m[1] : undefined;
}

/**
 * #4388 (R3): a background Bash shell. A SEPARATE bucket from `agents` so the
 * agent counts stay agents-only (DD5); it rides the SAME `<task-notification>`
 * channel and the same T1 clear-clock, but a shell id never names an
 * `agent-<id>.jsonl`, so the tracker never looks for a file for one.
 */
interface ShellEntry {
  id: string;
  status: BackgroundAgentStatus;
  startedAt: number;
  endedAt?: number;
  consumedAt?: number;
  lastNotificationTs?: number;
}

interface ParsedNotification {
  taskId?: string;
  toolUseId?: string;
  status?: string;
}

/** Parse a `<task-notification>` block's `<task-id>`, `<tool-use-id>`, `<status>`. */
function parseTaskNotification(content: string): ParsedNotification {
  const taskId = content.match(/<task-id>([^<]+)<\/task-id>/)?.[1]?.trim();
  const toolUseId = content
    .match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1]
    ?.trim();
  const status = content.match(/<status>([^<]+)<\/status>/)?.[1]?.trim();
  return { taskId, toolUseId, status };
}

function statusFromNotification(
  raw: string | undefined
): BackgroundAgentStatus {
  // `stopped` is an operator stop, not a failure — keeps DD8's red for real
  // errors only. `failed` → error; `completed`/`stopped`/anything else → done.
  return raw === "failed" ? "error" : "done";
}

export class BackgroundAgentTracker {
  /** Canonical store, keyed by the agent id (== task-id == file id). */
  private readonly agents = new Map<string, InternalAgent>();
  /** Agents seen via a tool_use but not yet resolved to an agent id. */
  private readonly pending = new Map<string, InternalAgent>();
  /** toolUseId → resolved agent id (once the tool_result mapped it). */
  private readonly toolUseIndex = new Map<string, string>();
  /** #4388 (R2): per-agent-file cache of the `Agent` tool_use ids in its
   *  assistant lines, keyed by (size, mtime) so an unchanged parent file is never
   *  rescanned during nested-agent parent resolution (bounds the reconcile cost). */
  private readonly agentToolUseCache = new Map<
    string,
    { size: number; mtimeMs: number; ids: Set<string> }
  >();
  /** #4388 (R3): background Bash shells, keyed by shell id (== task-id). A
   *  SEPARATE bucket so `agents` (DD5) never counts a shell. */
  private readonly shells = new Map<string, ShellEntry>();
  /** #4388 (R3): a background `Bash` tool_use seen but not yet resolved to a
   *  shell id (its `Command running in background with ID:` result maps it). */
  private readonly pendingShells = new Map<string, { startedAt: number }>();
  /** A turn ended while a done agent had no `consumedAt` — armed for re-eval. */
  private armedTurnEndAt: number | null = null;
  /** The resolved `subagents/` dir for this session (the disk-check + reconcile). */
  private subagentsDir: string | undefined;
  private readonly now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? (() => Date.now());
  }

  /** Set the session's resolved `subagents/` directory (account-isolated config
   *  dir root, NOT a hardcoded ~/.claude). Omit/undefined → no disk checks. */
  setSubagentsDir(dir: string | undefined): void {
    this.subagentsDir = dir;
  }

  // ─────────────────────────── Feed: SDK (remote) ───────────────────────────

  onSdkMessage(msg: unknown): void {
    const rec = asRec(msg);
    if (!rec) return;
    const type = rec.type;
    if (type === "system") {
      const subtype = rec.subtype;
      if (subtype === "task_started") {
        const taskId = asStr(rec.task_id);
        if (!taskId) return;
        const taskType = asStr(rec.task_type);
        // #4388 R3: a shell task_type starts a background SHELL (its own bucket),
        // never an agent (DD5). Previously these were dropped (counted as nothing).
        if (taskType && SHELL_TASK_TYPES.has(taskType)) {
          this.startShell(taskId, parseTs(rec.timestamp));
          return;
        }
        this.startAgent({
          id: taskId,
          agentType: taskType ?? "agent",
          description: asStr(rec.description) ?? "",
          ts: parseTs(rec.timestamp),
        });
        return;
      }
      if (subtype === "task_notification") {
        const taskId = asStr(rec.task_id);
        if (!taskId) return;
        // #4388 R3: a notification for a tracked SHELL completes the shell. SDK
        // has no observable dequeue, so the notification IS the consume signal.
        if (this.shells.has(taskId)) {
          this.applyShellCompletion(
            taskId,
            statusFromNotification(asStr(rec.status)),
            parseTs(rec.timestamp),
            true
          );
          return;
        }
        // Ignore a notification for an id we never started (not an agent either).
        if (!this.agents.has(taskId)) return;
        // SDK has no observable dequeue — the notification itself IS the
        // "consumed" signal (consumedAt = the notification time).
        this.applyCompletion(
          taskId,
          statusFromNotification(asStr(rec.status)),
          parseTs(rec.timestamp),
          true
        );
        return;
      }
      return;
    }
    // Shared tool_use / tool_result ingestion (appears in both streams).
    this.ingestConversationMessage(rec);
  }

  // ─────────────────────────── Feed: transcript (local) ─────────────────────

  onTranscriptLine(line: unknown): void {
    const rec = asRec(line);
    if (!rec) return;
    if (rec.type === "queue-operation") {
      const op = rec.operation;
      const content = asStr(rec.content);
      if (!content || !content.includes("<task-notification>")) return;
      const parsed = parseTaskNotification(content);
      if (!parsed.taskId) return;
      const ts = parseTs(rec.timestamp);
      if (op === "enqueue") {
        this.handleTranscriptNotification(parsed, ts);
      } else if (op === "remove") {
        this.handleRemove(parsed.taskId, ts ?? this.now());
      }
      return;
    }
    this.ingestConversationMessage(rec);
  }

  // ───────────────────────── Shared conversation ingest ─────────────────────

  private ingestConversationMessage(rec: Rec): void {
    const ts = parseTs(rec.timestamp);
    const inner = asRec(rec.message);
    const content = inner?.content;
    if (!Array.isArray(content)) return;

    if (rec.type === "assistant") {
      for (const block of content) {
        const b = asRec(block);
        if (!b) continue;
        if (b.type !== "tool_use") continue;
        const name = asStr(b.name);
        const toolUseId = asStr(b.id);
        if (!toolUseId) continue;
        const input = asRec(b.input);
        // #4388 R3: a background `Bash` tool_use → pending shell, resolved to a
        // shell id by its `Command running in background with ID:` result below.
        if (name === "Bash") {
          if (input?.run_in_background === true) {
            this.pendingShells.set(toolUseId, { startedAt: ts ?? this.now() });
          }
          continue;
        }
        if (name !== "Agent") continue;
        // #4599: record EVERY Agent tool_use in `pending` (not only flagged ones),
        // carrying whether it was a background launch. The tool_result tap reads
        // this flag — a sync (foreground) Agent must NOT start an agent even though
        // its completed result carries the `agentId:` trailer.
        this.handleAgentToolUse(
          toolUseId,
          asStr(input?.subagent_type) ?? "agent",
          asStr(input?.description) ?? "",
          ts,
          input?.run_in_background === true
        );
      }
      return;
    }

    if (rec.type === "user") {
      // One `toolUseResult` per user line (the local transcript sibling of
      // `message`; the SDK stream may omit it). Read it once per line (#4599).
      const tur = asRec(rec.toolUseResult) ?? asRec(rec.tool_use_result);
      const isAsync = asStr(tur?.status) === "async_launched";
      for (const block of content) {
        const b = asRec(block);
        if (!b) continue;
        if (b.type !== "tool_result") continue;
        const toolUseId = asStr(b.tool_use_id);
        if (!toolUseId) continue;
        const text = resultText(b.content);
        // #4388 R3: resolve a pending background Bash shell to its shell id
        // (`Command running in background with ID: <id>`) and start the shell.
        const pendShell = this.pendingShells.get(toolUseId);
        if (pendShell) {
          this.pendingShells.delete(toolUseId);
          const shellId = text ? parseShellIdFromResult(text) : undefined;
          if (shellId) this.startShell(shellId, pendShell.startedAt);
          continue;
        }
        const pend = this.pending.get(toolUseId);
        const textId = text ? parseAgentIdFromResult(text) : undefined;
        // #4599: start an agent ONLY on a real background launch — a flagged
        // tool_use, an `async_launched` result, or an id already tracked (the SDK
        // `task_started` order). EVERY completed sync `Agent` result carries an
        // `agentId:` trailer, and any tool output can mention one, so an ungated
        // tap started a phantom `running` agent that never ended.
        const background =
          pend?.runInBackground === true ||
          isAsync ||
          (textId !== undefined && this.agents.has(textId));
        if (!background) {
          // A sync result or an interrupted call — never starts an agent.
          this.pending.delete(toolUseId);
          continue;
        }
        const agentId = (isAsync ? asStr(tur?.agentId) : undefined) ?? textId;
        if (!agentId) {
          // A background launch with no resolvable id — a failed launch.
          this.pending.delete(toolUseId);
          continue;
        }
        // A flag-less background launch's description lives on the async result.
        if (isAsync && pend && !pend.description) {
          const desc = asStr(tur?.description);
          if (desc) pend.description = desc;
        }
        this.handleAgentToolResult(toolUseId, agentId, ts);
      }
      return;
    }
  }

  // ─────────────────────────────── Primitives ───────────────────────────────

  private startAgent(a: {
    id: string;
    agentType: string;
    description: string;
    toolUseId?: string;
    ts?: number;
  }): void {
    const existing = this.agents.get(a.id);
    if (existing) {
      // A `task_started` for a done id is a resume → running again.
      existing.status = "running";
      existing.endedAt = undefined;
      existing.consumedAt = undefined;
      existing.lastNotificationTs = undefined;
      existing.agentType = betterAgentType(existing.agentType, a.agentType);
      if (a.description && !existing.description)
        existing.description = a.description;
      if (a.toolUseId) existing.toolUseId = a.toolUseId;
      return;
    }
    this.agents.set(a.id, {
      id: a.id,
      toolUseId: a.toolUseId,
      agentType: a.agentType,
      description: a.description,
      status: "running",
      startedAt: a.ts ?? this.now(),
      notifications: 0,
    });
    this.pruneFinished();
  }

  private handleAgentToolUse(
    toolUseId: string,
    agentType: string,
    description: string,
    ts: number | undefined,
    runInBackground: boolean
  ): void {
    // Already resolved to an agent id → update that agent's metadata.
    const resolved = this.toolUseIndex.get(toolUseId);
    if (resolved) {
      const agent = this.agents.get(resolved);
      if (agent) {
        agent.agentType = betterAgentType(agent.agentType, agentType);
        if (description && !agent.description) agent.description = description;
      }
      return;
    }
    const existing = this.pending.get(toolUseId);
    if (existing) {
      existing.agentType = betterAgentType(existing.agentType, agentType);
      if (description) existing.description = description;
      if (runInBackground) existing.runInBackground = true;
      return;
    }
    this.pending.set(toolUseId, {
      id: `pending:${toolUseId}`,
      toolUseId,
      agentType,
      description,
      status: "running",
      startedAt: ts ?? this.now(),
      notifications: 0,
      runInBackground,
    });
  }

  private handleAgentToolResult(
    toolUseId: string,
    agentId: string,
    ts: number | undefined
  ): void {
    this.toolUseIndex.set(toolUseId, agentId);
    const pend = this.pending.get(toolUseId);
    const existing = this.agents.get(agentId);
    if (existing) {
      // task_started already created the canonical entry; carry the tool_use id.
      existing.toolUseId = toolUseId;
      if (pend) {
        existing.agentType = betterAgentType(
          existing.agentType,
          pend.agentType
        );
        if (pend.description && !existing.description)
          existing.description = pend.description;
      }
      this.pending.delete(toolUseId);
      return;
    }
    if (pend) {
      this.pending.delete(toolUseId);
      this.agents.set(agentId, { ...pend, id: agentId });
      this.pruneFinished();
      return;
    }
    // No pending and no canonical entry — create running from the result alone.
    this.agents.set(agentId, {
      id: agentId,
      toolUseId,
      agentType: "agent",
      description: "",
      status: "running",
      startedAt: ts ?? this.now(),
      notifications: 0,
    });
    this.pruneFinished();
  }

  /**
   * A transcript `<task-notification>` enqueue. Resolve the target agent:
   *   1. a known agent id (== task-id);
   *   2. a known background `Agent` tool_use (by tool-use-id);
   *   3. ONE cheap disk check — `agent-<task-id>.meta.json` exists → a real agent
   *      whose start we missed (CLI restart / resume / skipped scan); attach it;
   *   4. otherwise the record is a background Bash shell's → IGNORED (R6).
   */
  private handleTranscriptNotification(
    parsed: ParsedNotification,
    ts: number | undefined
  ): void {
    const taskId = parsed.taskId!;
    const status = statusFromNotification(parsed.status);
    // #4388 R3: a notification for a tracked SHELL completes it (local path —
    // consumedAt is set by the `queue-operation` `remove`, like agents).
    if (this.shells.has(taskId)) {
      this.applyShellCompletion(taskId, status, ts, false);
      return;
    }
    if (this.agents.has(taskId)) {
      this.applyCompletion(taskId, status, ts);
      return;
    }
    if (parsed.toolUseId) {
      const resolved = this.toolUseIndex.get(parsed.toolUseId);
      if (resolved && this.agents.has(resolved)) {
        this.applyCompletion(resolved, status, ts);
        return;
      }
      const pend = this.pending.get(parsed.toolUseId);
      if (pend) {
        // Promote the pending tool_use agent to the now-known task id.
        this.pending.delete(parsed.toolUseId);
        this.toolUseIndex.set(parsed.toolUseId, taskId);
        this.agents.set(taskId, { ...pend, id: taskId });
        this.applyCompletion(taskId, status, ts);
        return;
      }
    }
    // Disk check — IS the <task-id> an agent file, or a background shell's id?
    if (this.subagentsDir && this.metaExists(taskId)) {
      const meta = this.readMeta(taskId);
      this.agents.set(taskId, {
        id: taskId,
        toolUseId: meta?.toolUseId,
        agentType: meta?.agentType ?? "agent",
        description: meta?.description ?? "",
        status: "running",
        startedAt: ts ?? this.now(),
        notifications: 0,
      });
      this.applyCompletion(taskId, status, ts);
      this.pruneFinished();
      return;
    }
    // No agent file and not a tracked shell → a shell whose launch we never saw
    // (CLI restart / skipped scan). Ignored: a shell has no file to attach and no
    // start to display (#4388 R3 — shell ids never name an `agent-<id>.jsonl`).
  }

  private applyCompletion(
    id: string,
    status: BackgroundAgentStatus,
    ts: number | undefined,
    setConsumed = false
  ): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    const recordTs = ts;
    // Idempotent: a re-delivered IDENTICAL record (same timestamp) is a no-op.
    if (
      recordTs !== undefined &&
      agent.lastNotificationTs !== undefined &&
      recordTs === agent.lastNotificationTs
    ) {
      return;
    }
    agent.status = status;
    agent.endedAt = recordTs ?? this.now();
    agent.lastNotificationTs = recordTs;
    agent.notifications += 1;
    // SDK path: the notification is also the consume signal. Local path leaves
    // consumedAt unset — the `queue-operation` `remove` sets it.
    if (setConsumed) agent.consumedAt = recordTs ?? this.now();
  }

  private handleRemove(taskId: string, removeTs: number): void {
    // #4388 R3: a `remove` consumes an agent OR a shell (same T1 clock).
    const entry = this.agents.get(taskId) ?? this.shells.get(taskId);
    if (!entry) return;
    entry.consumedAt = removeTs;
    // #4383 [ER 4383-3]: a `remove` can land AFTER the turn's `onTurnEnd` (the
    // watcher and the Stop hook are unordered). If a turn end already armed a
    // re-eval and this remove is at/before it, clear now without a further turn.
    if (
      this.armedTurnEndAt !== null &&
      removeTs <= this.armedTurnEndAt &&
      this.runningCount() === 0 &&
      this.allFinishedConsumed()
    ) {
      this.clearAll();
    }
  }

  // ─────────────────────────────── Shells (#4388 R3) ────────────────────────

  private startShell(id: string, ts: number | undefined): void {
    const existing = this.shells.get(id);
    if (existing) {
      // A re-start for a done shell id → running again.
      existing.status = "running";
      existing.endedAt = undefined;
      existing.consumedAt = undefined;
      existing.lastNotificationTs = undefined;
      return;
    }
    this.shells.set(id, { id, status: "running", startedAt: ts ?? this.now() });
    this.pruneShells();
  }

  private applyShellCompletion(
    id: string,
    status: BackgroundAgentStatus,
    ts: number | undefined,
    setConsumed: boolean
  ): void {
    const shell = this.shells.get(id);
    if (!shell) return;
    const recordTs = ts;
    // Idempotent: a re-delivered identical record (same timestamp) is a no-op.
    if (
      recordTs !== undefined &&
      shell.lastNotificationTs !== undefined &&
      recordTs === shell.lastNotificationTs
    ) {
      return;
    }
    shell.status = status;
    shell.endedAt = recordTs ?? this.now();
    shell.lastNotificationTs = recordTs;
    // SDK path: the notification is the consume signal. Local path leaves
    // consumedAt unset — the `queue-operation` `remove` sets it (handleRemove).
    if (setConsumed) shell.consumedAt = recordTs ?? this.now();
  }

  /** Bound memory: keep all running + the newest AGENT_LIST_CAP finished shells. */
  private pruneShells(): void {
    const finished = [...this.shells.values()].filter(
      s => s.status !== "running"
    );
    if (finished.length <= AGENT_LIST_CAP) return;
    finished
      .sort((x, y) => (x.endedAt ?? x.startedAt) - (y.endedAt ?? y.startedAt))
      .slice(0, finished.length - AGENT_LIST_CAP)
      .forEach(s => this.shells.delete(s.id));
  }

  // ───────────────────────────────── Reconcile ──────────────────────────────

  /**
   * Reconcile against the session's `subagents/` dir (every 30 s while
   * `total > 0`, and at each turn end):
   *   - a `*.meta.json` with an unknown `toolUseId` and `requestShape:"background"`
   *     whose `agent-<id>.jsonl` is still LIVE → add as running; a
   *     finished historical meta older than the tracker is skipped;
   *   - a tracked running agent whose file has been silent ≥10 min and ends in a
   *     finished `end_turn` line → drift-done (missed completion), consumedAt now.
   * Unreadable dir → no-op.
   *
   * `requestShape` is absent on CC 2.1.260 for EVERY agent (foreground included),
   * and later builds' synchronous metas carry `requestShape:"foreground"` — so an
   * absent field is FOREGROUND, NOT background (#4599). Only a `"background"` meta
   * is ADDED; the drift guard runs for ANY already-tracked agent regardless of its
   * meta's `requestShape`.
   */
  reconcile(subagentsDir?: string): void {
    const dir = subagentsDir ?? this.subagentsDir;
    if (!dir) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable dir → no-op
    }
    const now = this.now();
    const knownToolUseIds = new Set(this.toolUseIndex.keys());
    for (const name of entries) {
      const m = name.match(/^agent-(.+)\.meta\.json$/);
      if (!m) continue;
      const id = m[1];
      const meta = this.readMeta(id);
      if (!meta) continue;
      const jsonlPath = join(dir, `agent-${id}.jsonl`);
      // Drift guard FIRST, before the shape filter: an already-tracked agent must
      // drift-done whatever its meta's requestShape says — a `foreground`/absent
      // meta previously skipped the guard and made the phantom permanent (#4599).
      if (this.agents.has(id)) {
        this.driftCheck(this.agents.get(id)!, jsonlPath, now);
        continue;
      }
      // absent is foreground: CC 2.1.260 writes none for any agent; later sync
      // metas say foreground — add ONLY a `"background"` meta (#4599).
      if (meta.requestShape !== "background") continue;
      if (meta.toolUseId && knownToolUseIds.has(meta.toolUseId)) continue;
      // Unknown agent — add ONLY while its file is live; a finished historical
      // meta (a resumed session's earlier agent) is skipped so we never carry it.
      if (this.fileIsLive(jsonlPath, now)) {
        const depth = meta.spawnDepth;
        // #4388 (R2): a depth-≥2 agent is nested — resolve its parent by the
        // `Agent` tool_use that launched it (its launch lives in the parent's
        // file). Depth-1 (and depth-less) agents stay top-level (flat).
        const parentAgentId =
          depth !== undefined && depth >= 2 && meta.toolUseId
            ? this.resolveParentAgentId(id, meta.toolUseId, dir, entries)
            : undefined;
        this.agents.set(id, {
          id,
          toolUseId: meta.toolUseId,
          agentType: meta.agentType ?? "agent",
          description: meta.description ?? "",
          status: "running",
          startedAt: now,
          notifications: 0,
          ...(depth !== undefined ? { depth } : {}),
          ...(parentAgentId ? { parentAgentId } : {}),
        });
        this.pruneFinished();
      }
    }
    this.refreshTokens(dir);
  }

  /**
   * #4385 (Task 7): refresh each tracked agent's live `tokens` from its
   * `agent-<id>.jsonl`, summed with the #2229 per-API-message-id dedup (the
   * shared `foldSessionTokenUsage` fold — Claude Code repeats a message's usage
   * on every content-block line, so a naive per-line sum reads several times
   * high). Re-reads only a file whose (mtime, size) changed, so a finished agent
   * is read once more after its last write and never again. A live estimate:
   * the server's stored row is authoritative once the agent has finished.
   */
  private refreshTokens(dir: string): void {
    for (const agent of this.agents.values()) {
      const jsonlPath = join(dir, `agent-${agent.id}.jsonl`);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(jsonlPath);
      } catch {
        continue; // no file yet
      }
      if (
        agent.tokensFileMtime === st.mtimeMs &&
        agent.tokensFileSize === st.size
      ) {
        continue;
      }
      const totals = sumAgentFileUsage(jsonlPath);
      if (!totals) continue;
      agent.tokens = totals;
      agent.tokensFileMtime = st.mtimeMs;
      agent.tokensFileSize = st.size;
    }
  }

  private driftCheck(
    agent: InternalAgent,
    jsonlPath: string,
    now: number
  ): void {
    if (agent.status !== "running") return;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(jsonlPath);
    } catch {
      return;
    }
    if (now - st.mtimeMs < DRIFT_SILENCE_MS) return;
    if (!this.fileEndsFinished(jsonlPath)) return;
    // Drift-done: no notification, no remove — set consumedAt so the T1 rule
    // (now > consumedAt of the LAST agent) still clears it at the next turn end.
    agent.status = "done";
    agent.endedAt = st.mtimeMs;
    agent.consumedAt = now;
  }

  /** A jsonl file is "live" if it grew within DRIFT_SILENCE_MS OR does not yet
   *  end in a finished assistant `stop_reason:"end_turn"` line. */
  private fileIsLive(jsonlPath: string, now: number): boolean {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(jsonlPath);
    } catch {
      return false; // no jsonl yet → not live
    }
    if (now - st.mtimeMs < DRIFT_SILENCE_MS) return true;
    return !this.fileEndsFinished(jsonlPath);
  }

  private fileEndsFinished(jsonlPath: string): boolean {
    let text: string;
    try {
      text = readFileSync(jsonlPath, "utf-8");
    } catch {
      return false;
    }
    const lines = text.split("\n").filter(l => l.trim() !== "");
    const last = lines[lines.length - 1];
    if (!last) return false;
    try {
      const obj = asRec(JSON.parse(last));
      const inner = asRec(obj?.message);
      if (inner?.stop_reason === "end_turn") return true;
      if (obj?.stop_reason === "end_turn") return true;
      return false;
    } catch {
      return false;
    }
  }

  private metaExists(id: string): boolean {
    if (!this.subagentsDir) return false;
    return existsSync(join(this.subagentsDir, `agent-${id}.meta.json`));
  }

  private readMeta(id: string):
    | {
        agentType?: string;
        description?: string;
        toolUseId?: string;
        requestShape?: string;
        /** #4388: nesting depth (1 = top-level). A depth-≥2 meta is a nested agent. */
        spawnDepth?: number;
      }
    | undefined {
    if (!this.subagentsDir) return undefined;
    try {
      const raw = readFileSync(
        join(this.subagentsDir, `agent-${id}.meta.json`),
        "utf-8"
      );
      const obj = asRec(JSON.parse(raw));
      if (!obj) return undefined;
      return {
        agentType: asStr(obj.agentType),
        description: asStr(obj.description),
        toolUseId: asStr(obj.toolUseId),
        requestShape: asStr(obj.requestShape),
        spawnDepth:
          typeof obj.spawnDepth === "number" && Number.isFinite(obj.spawnDepth)
            ? obj.spawnDepth
            : undefined,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * #4388 (R2): the `Agent` tool_use ids inside one agent file's `assistant`
   * lines — the ids a nested child's `meta.toolUseId` is matched against. Cached
   * by (size, mtime); an unchanged file is never re-read. A background agent that
   * itself launched a background `Agent` carries that launch here (the child's
   * launch lives in the PARENT's file, not the main transcript).
   */
  private agentToolUseIds(path: string): Set<string> {
    try {
      const st = statSync(path);
      const cached = this.agentToolUseCache.get(path);
      if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
        return cached.ids;
      }
      const ids = new Set<string>();
      const text = readFileSync(path, "utf-8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let rec: Rec | undefined;
        try {
          rec = asRec(JSON.parse(line));
        } catch {
          continue;
        }
        if (!rec || rec.type !== "assistant") continue;
        const content = asRec(rec.message)?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          const b = asRec(block);
          if (b?.type === "tool_use" && asStr(b.name) === "Agent") {
            const id = asStr(b.id);
            if (id) ids.add(id);
          }
        }
      }
      this.agentToolUseCache.set(path, {
        size: st.size,
        mtimeMs: st.mtimeMs,
        ids,
      });
      return ids;
    } catch {
      return new Set();
    }
  }

  /**
   * #4388 (R2): resolve a nested child's parent — the candidate agent file whose
   * `Agent` tool_use ids include the child's `toolUseId`. Scans only the other
   * `agent-*.jsonl` files in the dir (bounded by the per-file cache above), never
   * the child's own file.
   */
  private resolveParentAgentId(
    childId: string,
    childToolUseId: string,
    dir: string,
    entries: readonly string[]
  ): string | undefined {
    for (const name of entries) {
      const m = name.match(/^agent-(.+)\.jsonl$/);
      if (!m) continue;
      const pid = m[1];
      if (pid === childId) continue; // an agent is never its own parent
      if (this.agentToolUseIds(join(dir, name)).has(childToolUseId)) return pid;
    }
    return undefined;
  }

  // ───────────────────────────────── Turn end (T1) ──────────────────────────

  onTurnEnd(): void {
    this.maybeClear(this.now());
  }

  private maybeClear(now: number): void {
    // #4388 R3: "empty" counts shells too — the snapshot is non-null while either
    // an agent OR a shell is present.
    if (this.agents.size === 0 && this.shells.size === 0) {
      this.armedTurnEndAt = null;
      return;
    }
    if (this.runningCount() > 0) return; // active agents — never clear
    if (!this.allFinishedConsumed()) {
      // A done agent has no consumedAt yet (its `remove` may still arrive) —
      // arm ONE re-evaluation so a late `remove` can clear without a new turn.
      this.armedTurnEndAt = now;
      return;
    }
    const lastConsumed = this.maxConsumedAt();
    if (lastConsumed !== undefined && now > lastConsumed) {
      this.clearAll();
    } else {
      this.armedTurnEndAt = now;
    }
  }

  private clearAll(): void {
    this.agents.clear();
    this.pending.clear();
    this.toolUseIndex.clear();
    this.shells.clear(); // #4388 R3
    this.pendingShells.clear(); // #4388 R3
    this.armedTurnEndAt = null;
  }

  // ───────────────────────────────── Snapshot ───────────────────────────────

  snapshot(): BackgroundAgentsSnapshot | null {
    // #4388 R3: non-null while either an agent OR a shell is present.
    if (this.agents.size === 0 && this.shells.size === 0) return null;
    let running = 0;
    let done = 0;
    let error = 0;
    for (const a of this.agents.values()) {
      if (a.status === "running") running += 1;
      else if (a.status === "error") error += 1;
      else done += 1;
    }
    const total = this.agents.size;
    // Cap the list at 50 (oldest finished dropped first); keep all running.
    const all = [...this.agents.values()];
    const runningAgents = all.filter(a => a.status === "running");
    const finished = all
      .filter(a => a.status !== "running")
      .sort((x, y) => (y.endedAt ?? y.startedAt) - (x.endedAt ?? x.startedAt));
    const room = Math.max(0, AGENT_LIST_CAP - runningAgents.length);
    const kept = [...runningAgents, ...finished.slice(0, room)];
    const agents = kept.map(a => ({
      id: a.id,
      ...(a.toolUseId ? { toolUseId: a.toolUseId } : {}),
      agentType: a.agentType,
      description: a.description.slice(0, DESCRIPTION_CAP),
      status: a.status,
      startedAt: a.startedAt,
      ...(a.endedAt !== undefined ? { endedAt: a.endedAt } : {}),
      notifications: a.notifications,
      // #4385: the live per-agent token figure (present after the first reconcile).
      ...(a.tokens ? { tokens: { ...a.tokens } } : {}),
      // #4388 (R2): nested-tree fields, present only for a reconciled depth-≥2 agent.
      ...(a.depth !== undefined ? { depth: a.depth } : {}),
      ...(a.parentAgentId ? { parentAgentId: a.parentAgentId } : {}),
    }));
    // The agent counts above are agents-only (DD5). #4388 R3: shell counts ride
    // their own nested bucket, present only when shells exist (D-4388-D1 = A).
    const snap: BackgroundAgentsSnapshot = {
      running,
      done,
      error,
      total,
      agents,
    };
    if (this.shells.size > 0) {
      let sRunning = 0;
      let sDone = 0;
      let sError = 0;
      for (const s of this.shells.values()) {
        if (s.status === "running") sRunning += 1;
        else if (s.status === "error") sError += 1;
        else sDone += 1;
      }
      snap.shells = {
        running: sRunning,
        done: sDone,
        error: sError,
        total: this.shells.size,
      };
    }
    return snap;
  }

  // ───────────────────────────────── Helpers ────────────────────────────────

  private runningCount(): number {
    let n = 0;
    for (const a of this.agents.values()) if (a.status === "running") n += 1;
    for (const s of this.shells.values()) if (s.status === "running") n += 1; // #4388 R3
    return n;
  }

  private allFinishedConsumed(): boolean {
    for (const a of this.agents.values()) {
      if (a.status !== "running" && a.consumedAt === undefined) return false;
    }
    for (const s of this.shells.values()) {
      // #4388 R3: a finished shell must be consumed before the set can clear.
      if (s.status !== "running" && s.consumedAt === undefined) return false;
    }
    return true;
  }

  private maxConsumedAt(): number | undefined {
    let max: number | undefined;
    const consider = (c: number | undefined): void => {
      if (c !== undefined && (max === undefined || c > max)) max = c;
    };
    for (const a of this.agents.values()) consider(a.consumedAt);
    for (const s of this.shells.values()) consider(s.consumedAt); // #4388 R3
    return max;
  }

  /** Bound memory: keep all running + the newest AGENT_LIST_CAP finished. */
  private pruneFinished(): void {
    const finished = [...this.agents.values()].filter(
      a => a.status !== "running"
    );
    if (finished.length <= AGENT_LIST_CAP) return;
    finished
      .sort((x, y) => (x.endedAt ?? x.startedAt) - (y.endedAt ?? y.startedAt))
      .slice(0, finished.length - AGENT_LIST_CAP)
      .forEach(a => this.agents.delete(a.id));
  }
}

/**
 * #4385: sum one agent file's assistant usage, deduped by API message id. Null
 * when the file cannot be read (the caller keeps the previous figure).
 */
function sumAgentFileUsage(jsonlPath: string): {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
} | null {
  let text: string;
  try {
    text = readFileSync(jsonlPath, "utf-8");
  } catch {
    return null;
  }
  const rows: TokenUsageRow[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let obj: Rec | undefined;
    try {
      obj = asRec(JSON.parse(raw));
    } catch {
      continue;
    }
    if (!obj || obj.type !== "assistant") continue;
    const inner = asRec(obj.message);
    const usage = asRec(inner?.usage);
    if (!usage) continue;
    rows.push({ apiMessageId: asStr(inner?.id), usage });
  }
  const t = foldSessionTokenUsage(rows);
  return {
    in: t.tokIn,
    out: t.tokOut,
    cacheRead: t.tokCacheRead,
    cacheWrite: t.tokCacheWrite,
  };
}

/** A tool_result's `content` may be a plain string or an array of text blocks. */
function resultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = asRec(block);
      const t = asStr(b?.text);
      if (t) parts.push(t);
      else if (typeof block === "string") parts.push(block);
    }
    return parts.length ? parts.join("\n") : undefined;
  }
  return undefined;
}
