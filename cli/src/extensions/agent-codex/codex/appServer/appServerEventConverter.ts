// SPDX-License-Identifier: AGPL-3.0-only
// Ported from tiann/hapi@34f931ef5 (cli/src/codex/utils/appServerEventConverter.ts), AGPL-3.0-only, with changes.
// Turn and thread id extraction follows tiann/hapi main (appServerEventConverter.ts:209-242 at 2161a9ff);
// the thread systemError handling follows tiann/hapi@19e74456.
/**
 * Turns `codex app-server` notifications into the legacy event objects the
 * remote launcher consumes (`codexRemoteLauncher.ts` handleCodexEvent), so
 * the launcher needs no app-server knowledge (#6263 R5).
 *
 * Shapes are those measured in the captures of Codex 0.147.0, 0.166.0 and
 * 0.167.0 (`__fixtures__/capture-*.jsonl`).
 */

import { logger } from "@/ui/logger";
import type { CodexEvent } from "../types";

/** A converted event plus the turn and thread it belongs to (for filtering). */
export interface ScopedCodexEvent {
  event: CodexEvent;
  turnId: string | null;
  threadId: string | null;
}

export const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "task_complete",
  "task_failed",
  "turn_aborted",
]);

/** Notifications that carry nothing the launcher shows. */
const IGNORED_METHODS: ReadonlySet<string> = new Set([
  "remoteControl/status/changed",
  "thread/started",
  "thread/readState/changed",
  "serverRequest/resolved",
  "turn/plan/updated",
  "thread/compacted",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractScope(params: Record<string, unknown>): {
  threadId: string | null;
  turnId: string | null;
} {
  const turn = asRecord(params.turn);
  const item = asRecord(params.item);
  return {
    threadId: asString(params.threadId ?? params.thread_id ?? item?.threadId),
    turnId: asString(
      params.turnId ?? params.turn_id ?? turn?.id ?? item?.turnId
    ),
  };
}

function joinStrings(value: unknown, separator: string): string | null {
  if (!Array.isArray(value)) return null;
  const parts = value.filter(
    (part): part is string => typeof part === "string" && part.length > 0
  );
  return parts.length > 0 ? parts.join(separator) : null;
}

/** Codex `FileChange` (the MCP-era shape) for one app-server change entry. */
function toLegacyFileChange(entry: Record<string, unknown>): unknown {
  const kind = asRecord(entry.kind);
  const type = asString(kind?.type) ?? asString(entry.kind);
  const diff = typeof entry.diff === "string" ? entry.diff : "";
  if (type === "add") return { add: { content: diff } };
  if (type === "delete") return { delete: { content: diff } };
  return {
    update: {
      unified_diff: diff,
      move_path: asString(kind?.move_path ?? kind?.movePath),
    },
  };
}

/**
 * App-server `changes` is an array of `{ path, kind: { type }, diff }`; the
 * launcher (`Object.keys(changes)`) and the web CodexPatch card read a map
 * keyed by path.
 */
export function toChangeMap(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) return asRecord(value);
  const changes: Record<string, unknown> = {};
  for (const entry of value) {
    const record = asRecord(entry);
    const path = asString(record?.path);
    if (record && path) changes[path] = toLegacyFileChange(record);
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

/** `commandActions` → legacy `parsed_cmd`, which picks the web card's icon and title. */
function toParsedCommand(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: Record<string, unknown>[] = [];
  for (const entry of value) {
    const action = asRecord(entry);
    const type = asString(action?.type);
    if (!action || !type) continue;
    const out: Record<string, unknown> = { type, cmd: action.command ?? null };
    const name = asString(action.name ?? action.path);
    if (name) out.name = name;
    parsed.push(out);
  }
  return parsed.length > 0 ? parsed : null;
}

function snakeUsage(value: unknown): Record<string, number> | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const out: Record<string, number> = {};
  const fields: Array<[string, string]> = [
    ["inputTokens", "input_tokens"],
    ["cachedInputTokens", "cached_input_tokens"],
    ["outputTokens", "output_tokens"],
    ["reasoningOutputTokens", "reasoning_output_tokens"],
    ["totalTokens", "total_tokens"],
    ["cacheWriteInputTokens", "cache_write_input_tokens"],
  ];
  for (const [camel, snake] of fields) {
    const n = asNumber(usage[camel] ?? usage[snake]);
    if (n !== null) out[snake] = n;
  }
  return out;
}

function snakeRateLimitWindow(value: unknown): Record<string, unknown> | null {
  const window = asRecord(value);
  if (!window) return null;
  const usedPercent = asNumber(window.usedPercent ?? window.used_percent);
  if (usedPercent === null) return null;
  const out: Record<string, unknown> = { used_percent: usedPercent };
  const minutes = asNumber(window.windowDurationMins ?? window.window_minutes);
  if (minutes !== null) out.window_minutes = minutes;
  const resetsAt = window.resetsAt ?? window.resets_at;
  if (typeof resetsAt === "number" || typeof resetsAt === "string") {
    out.resets_at = resetsAt;
  }
  return out;
}

export class AppServerEventConverter {
  private readonly agentMessageBuffers = new Map<string, string>();
  private readonly reasoningBuffers = new Map<string, string>();
  private readonly commandOutputBuffers = new Map<string, string>();
  private readonly commandMeta = new Map<string, Record<string, unknown>>();
  private readonly fileChanges = new Map<string, Record<string, unknown>>();
  private readonly reasoningSectionBreakKeys = new Set<string>();
  /** The last non-terminal `error` text per turn (failure text fallback). */
  private readonly errorTextByTurn = new Map<string, string>();
  private readonly loggedUnknownMethods = new Set<string>();

  /** The change map of a file-change item seen in `item/started`. */
  getFileChanges(itemId: string): Record<string, unknown> | null {
    return this.fileChanges.get(itemId) ?? null;
  }

  handleNotification(method: string, params: unknown): ScopedCodexEvent[] {
    const record = asRecord(params) ?? {};
    const scope = extractScope(record);
    const scoped = (event: CodexEvent): ScopedCodexEvent => ({
      event,
      turnId: scope.turnId,
      threadId: scope.threadId,
    });
    const events = this.convert(method, record, scope);
    return events.map(scoped);
  }

  private convert(
    method: string,
    params: Record<string, unknown>,
    scope: { threadId: string | null; turnId: string | null }
  ): CodexEvent[] {
    if (IGNORED_METHODS.has(method)) return [];

    switch (method) {
      case "turn/started":
        return [{ type: "task_started", ...this.turnField(scope.turnId) }];
      case "turn/completed":
        return this.convertTurnCompleted(params, scope.turnId);
      case "error":
        return this.convertError(params, scope.turnId);
      case "thread/status/changed":
        return this.convertThreadStatus(params, scope.threadId);
      case "turn/diff/updated": {
        const diff = asString(params.diff ?? params.unifiedDiff);
        return diff ? [{ type: "turn_diff", unified_diff: diff }] : [];
      }
      case "thread/tokenUsage/updated":
        return this.convertTokenUsage(params);
      case "account/rateLimits/updated":
        return this.convertRateLimits(params);
      case "item/agentMessage/delta":
        this.appendDelta(this.agentMessageBuffers, params);
        return [];
      case "item/commandExecution/outputDelta":
        this.appendDelta(this.commandOutputBuffers, params);
        return [];
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const delta = asString(params.delta);
        if (!delta) return [];
        const itemId = asString(params.itemId) ?? "reasoning";
        this.reasoningBuffers.set(
          itemId,
          (this.reasoningBuffers.get(itemId) ?? "") + delta
        );
        return [{ type: "agent_reasoning_delta", delta }];
      }
      case "item/reasoning/summaryPartAdded": {
        const itemId = asString(params.itemId) ?? "reasoning";
        const index = asNumber(params.summaryIndex);
        if (index !== null) {
          const key = `${itemId}:${index}`;
          if (this.reasoningSectionBreakKeys.has(key)) return [];
          this.reasoningSectionBreakKeys.add(key);
        }
        return [{ type: "agent_reasoning_section_break" }];
      }
      case "item/started":
      case "item/completed":
        return this.convertItem(method === "item/started", params);
      case "warning":
      case "deprecationNotice":
        // Kept in the log: 0.153.4's mcp-server deprecation went unseen.
        logger.debug(
          `[CodexAppServer] ${method} ${JSON.stringify(params).slice(0, 300)}`
        );
        return [];
      case "mcpServer/startupStatus/updated":
        // The `hapi` bridge's readiness (V5/V7 evidence), log only.
        logger.debug(
          `[CodexAppServer] mcpServer/startupStatus/updated ${JSON.stringify(params).slice(0, 300)}`
        );
        return [];
      default:
        if (!this.loggedUnknownMethods.has(method)) {
          this.loggedUnknownMethods.add(method);
          logger.debug(
            `[CodexAppServer] Unhandled notification ${method} ${JSON.stringify(params).slice(0, 200)}`
          );
        }
        return [];
    }
  }

  private turnField(turnId: string | null): { turn_id?: string } {
    return turnId ? { turn_id: turnId } : {};
  }

  private convertTurnCompleted(
    params: Record<string, unknown>,
    turnId: string | null
  ): CodexEvent[] {
    const turn = asRecord(params.turn) ?? params;
    const status = asString(turn.status)?.toLowerCase();
    const fallbackError = turnId ? this.errorTextByTurn.get(turnId) : undefined;
    if (turnId) this.errorTextByTurn.delete(turnId);

    if (
      status === "interrupted" ||
      status === "cancelled" ||
      status === "canceled"
    ) {
      return [{ type: "turn_aborted", ...this.turnField(turnId) }];
    }
    if (status === "failed" || status === "error") {
      // R8: the failure text from turn.error.message, else the turn's last
      // `error` notification (never terminal on its own).
      const errorRecord = asRecord(turn.error);
      const message =
        asString(errorRecord?.message) ??
        asString(turn.error) ??
        fallbackError ??
        "Codex turn failed";
      return [
        { type: "task_failed", ...this.turnField(turnId), error: message },
      ];
    }
    return [{ type: "task_complete", ...this.turnField(turnId) }];
  }

  /**
   * An `error` notification is never terminal, whatever `willRetry` says:
   * measured, a 401 sends `error {willRetry: false}` and then
   * `turn/completed {status: "failed"}`. Keep its text as the fallback.
   */
  private convertError(
    params: Record<string, unknown>,
    turnId: string | null
  ): CodexEvent[] {
    const errorRecord = asRecord(params.error);
    const message = asString(errorRecord?.message) ?? asString(params.message);
    logger.debug(
      `[CodexAppServer] error notification (turn ${turnId ?? "?"}, willRetry ${String(params.willRetry)}): ${message ?? "?"}`
    );
    if (message && turnId) this.errorTextByTurn.set(turnId, message);
    return [];
  }

  /** A thread in `systemError` will not finish its turn: fail it (19e74456). */
  private convertThreadStatus(
    params: Record<string, unknown>,
    threadId: string | null
  ): CodexEvent[] {
    const status = asRecord(params.status);
    if (asString(status?.type) !== "systemError") return [];
    const error =
      asString(status?.message ?? status?.error) ??
      "Codex thread entered systemError";
    return [
      {
        type: "task_failed",
        ...(threadId ? { thread_id: threadId } : {}),
        terminal_source: "thread_status",
        error,
      },
    ];
  }

  /**
   * `tokenUsage: { last, total, modelContextWindow }` with camelCase counters
   * → `token_count { info: { last_token_usage, total_token_usage,
   * model_context_window } }`, so recordCodexTokenUsage works unchanged.
   */
  private convertTokenUsage(params: Record<string, unknown>): CodexEvent[] {
    const usage = asRecord(params.tokenUsage);
    if (!usage) return [];
    const info: Record<string, unknown> = {};
    const last = snakeUsage(usage.last);
    const total = snakeUsage(usage.total);
    if (last) info.last_token_usage = last;
    if (total) info.total_token_usage = total;
    const window = asNumber(usage.modelContextWindow);
    if (window !== null) info.model_context_window = window;
    return [{ type: "token_count", info }];
  }

  private convertRateLimits(params: Record<string, unknown>): CodexEvent[] {
    const limits = asRecord(params.rateLimits);
    if (!limits) return [];
    const rateLimits: Record<string, unknown> = {};
    for (const name of ["primary", "secondary"] as const) {
      const window = snakeRateLimitWindow(limits[name]);
      if (window) rateLimits[name] = window;
    }
    if (Object.keys(rateLimits).length === 0) return [];
    return [{ type: "rate_limits", rate_limits: rateLimits }];
  }

  private appendDelta(
    buffers: Map<string, string>,
    params: Record<string, unknown>
  ): void {
    const itemId = asString(params.itemId);
    const delta = asString(params.delta);
    if (!itemId || !delta) return;
    buffers.set(itemId, (buffers.get(itemId) ?? "") + delta);
  }

  private convertItem(
    started: boolean,
    params: Record<string, unknown>
  ): CodexEvent[] {
    const item = asRecord(params.item);
    const type = asString(item?.type);
    const itemId = asString(item?.id ?? params.itemId);
    if (!item || !type || !itemId) return [];

    switch (type) {
      case "agentMessage": {
        if (started) return [];
        // One agent_message per completed item (a turn can carry a preamble
        // and then the answer).
        const text =
          asString(item.text) ?? this.agentMessageBuffers.get(itemId);
        this.agentMessageBuffers.delete(itemId);
        return text ? [{ type: "agent_message", message: text }] : [];
      }
      case "reasoning": {
        if (started) return [];
        const text =
          asString(item.text) ??
          joinStrings(item.summary, "\n") ??
          joinStrings(item.content, "") ??
          this.reasoningBuffers.get(itemId) ??
          null;
        this.reasoningBuffers.delete(itemId);
        return text ? [{ type: "agent_reasoning", text }] : [];
      }
      case "commandExecution":
        return started
          ? this.commandBegin(itemId, item)
          : this.commandEnd(itemId, item);
      case "fileChange":
        return started
          ? this.patchBegin(itemId, item)
          : this.patchEnd(itemId, item);
      default:
        // userMessage and anything newer: nothing to show.
        return [];
    }
  }

  private commandBegin(
    itemId: string,
    item: Record<string, unknown>
  ): CodexEvent[] {
    const meta: Record<string, unknown> = {};
    const command = asString(item.command);
    if (command) meta.command = command;
    const cwd = asString(item.cwd);
    if (cwd) meta.cwd = cwd;
    const parsed = toParsedCommand(item.commandActions);
    if (parsed) meta.parsed_cmd = parsed;
    this.commandMeta.set(itemId, meta);
    return [{ type: "exec_command_begin", call_id: itemId, ...meta }];
  }

  private commandEnd(
    itemId: string,
    item: Record<string, unknown>
  ): CodexEvent[] {
    const meta = this.commandMeta.get(itemId) ?? {};
    this.commandMeta.delete(itemId);
    const output =
      typeof item.aggregatedOutput === "string"
        ? item.aggregatedOutput
        : (this.commandOutputBuffers.get(itemId) ?? "");
    this.commandOutputBuffers.delete(itemId);
    const status = asString(item.status);
    const exitCode = asNumber(item.exitCode);
    const event: CodexEvent = {
      type: "exec_command_end",
      call_id: itemId,
      ...meta,
      output,
    };
    if (exitCode !== null) event.exit_code = exitCode;
    if (status) event.status = status;
    if (status && status !== "completed") event.error = `Command ${status}`;
    return [event];
  }

  private patchBegin(
    itemId: string,
    item: Record<string, unknown>
  ): CodexEvent[] {
    const changes = toChangeMap(item.changes) ?? {};
    this.fileChanges.set(itemId, changes);
    return [{ type: "patch_apply_begin", call_id: itemId, changes }];
  }

  private patchEnd(
    itemId: string,
    item: Record<string, unknown>
  ): CodexEvent[] {
    this.fileChanges.delete(itemId);
    const status = asString(item.status);
    const event: CodexEvent = {
      type: "patch_apply_end",
      call_id: itemId,
      success: status === "completed",
    };
    if (status && status !== "completed") event.stderr = `Patch ${status}`;
    return [event];
  }

  reset(): void {
    this.agentMessageBuffers.clear();
    this.reasoningBuffers.clear();
    this.commandOutputBuffers.clear();
    this.commandMeta.clear();
    this.fileChanges.clear();
    this.reasoningSectionBreakKeys.clear();
    this.errorTextByTurn.clear();
  }
}
