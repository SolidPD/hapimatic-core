// SPDX-License-Identifier: MIT
import React from "react";
import { randomUUID } from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import { join } from "node:path";

import { CodexMcpClient } from "./codexMcpClient";
import { CodexPermissionHandler } from "./utils/permissionHandler";
import { ReasoningProcessor } from "./utils/reasoningProcessor";
import { DiffProcessor } from "./utils/diffProcessor";
import { logger } from "@/ui/logger";
import { NO_META_TEARDOWN } from "@/api/rpc/types";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
import type { CodexSessionConfig } from "./types";
import { buildHapiMcpBridge } from "./utils/buildHapiMcpBridge";
import { emitReadyIfIdle } from "./utils/emitReadyIfIdle";
import type { CodexSession } from "./session";
import type { EnhancedMode } from "./loop";
import { hasCodexCliOverrides } from "./utils/codexCliOverrides";
import { buildCodexStartConfig } from "./utils/codexStartConfig";
import { convertCodexEvent } from "./utils/codexEventConverter";
import { AgentTurnReporter } from "@/agent/utils/agentTurnReporter";
import type { CodexEvent } from "./codexMcpClient";
import type { ProviderUsageSnapshotWindow } from "@hapi/protocol/schemas";
import {
  RemoteLauncherBase,
  type RemoteLauncherDisplayContext,
  type RemoteLauncherExitReason,
} from "@/modules/common/remote/RemoteLauncherBase";

type HappyServer = Awaited<ReturnType<typeof buildHapiMcpBridge>>["server"];

const SIGNAL_NAMES: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  6: "SIGABRT",
  9: "SIGKILL",
  11: "SIGSEGV",
  15: "SIGTERM",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Finite non-negative number, else undefined (rejects NaN/negatives/non-number). */
function nonNegNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Issue #3352: extract per-turn usage from a codex `token_count` event and feed
 * the turn reporter (per-turn stats, R5/R8) + `onContextUsage` (context window,
 * R6). Verified against codex-cli 0.147.0: usage nests under `info`, with
 * `last_token_usage` = the current turn's delta, `total_token_usage` = the
 * session-cumulative occupancy, and `model_context_window` = the window size.
 * Each usage carries `{ input_tokens, cached_input_tokens, output_tokens,
 * reasoning_output_tokens, total_tokens }` — a cache-READ count but NO
 * cache-write split, so `tokCacheWrite` stays absent (R4). Defensive against
 * codex protocol volatility (#2196/#3060/#3216): a missing/renamed field is
 * simply skipped (tolerates a flat OR `info`-nested shape); never throws.
 */
function recordCodexTokenUsage(
  msg: CodexEvent,
  turnReporter: AgentTurnReporter,
  session: CodexSession,
  modelId: string | undefined
): void {
  const raw = msg as unknown as Record<string, unknown>;
  const info = isRecord(raw.info) ? raw.info : raw;
  const last = isRecord(info.last_token_usage)
    ? info.last_token_usage
    : undefined;
  const total = isRecord(info.total_token_usage)
    ? info.total_token_usage
    : undefined;
  const windowTokens = nonNegNum(info.model_context_window);

  if (last) {
    turnReporter.recordUsage({
      tokIn: nonNegNum(last.input_tokens),
      tokOut: nonNegNum(last.output_tokens),
      // R4: codex exposes a cache-READ count only; no write split is emitted.
      tokCacheRead: nonNegNum(last.cached_input_tokens),
      modelId,
      modelProvider: "openai",
    });
  }

  // R6: derive context occupancy from the session-cumulative total against the
  // window. Feeds keepAlive (the web context tier) AND the per-turn row.
  const used = total ? nonNegNum(total.total_tokens) : undefined;
  if (windowTokens !== undefined && windowTokens > 0 && used !== undefined) {
    session.onContextUsage({
      resolvedModel: modelId ?? "codex",
      contextWindowTokens: windowTokens,
      contextUsedTokens: used,
      contextPercentage: Math.min(100, Math.round((used / windowTokens) * 100)),
    });
    turnReporter.recordUsage({
      contextWindowTokens: windowTokens,
      contextUsedTokens: used,
    });
  }
}

/**
 * Issue #3809: extract the OpenAI pacing snapshot from a codex `token_count`
 * event's `rate_limits` sibling into the CLI→server carrier window shape. The
 * raw shape is `{ primary: {...}, secondary: {...} }` where each window carries
 * `{ used_percent, window_minutes, resets_at | resets_in_seconds }` (the reset
 * field name on the installed 0.147.x is pinned by #3352; both forms are carried
 * RAW and normalized server-side). A window with no `used_percent` is skipped.
 * Never throws.
 */
function extractCodexRateLimitWindows(
  rateLimits: Record<string, unknown>
): ProviderUsageSnapshotWindow[] {
  const windows: ProviderUsageSnapshotWindow[] = [];
  for (const name of ["primary", "secondary"] as const) {
    const w = isRecord(rateLimits[name]) ? rateLimits[name] : undefined;
    if (!w) continue;
    const usedPercent = nonNegNum(w.used_percent);
    if (usedPercent === undefined) continue;
    const resetsAt =
      typeof w.resets_at === "number" || typeof w.resets_at === "string"
        ? w.resets_at
        : null;
    windows.push({
      name,
      used_percent: usedPercent,
      window_minutes: nonNegNum(w.window_minutes) ?? 0,
      resets_at: resetsAt,
      resets_in_seconds: nonNegNum(w.resets_in_seconds) ?? null,
    });
  }
  return windows;
}

/** Enrich an error message with signal name when exit code indicates a signal kill. */
function enrichWithSignalContext(detail: string): string {
  const match = detail.match(/exited with code (\d+)/);
  if (!match) return detail;
  const code = parseInt(match[1]);
  if (code < 128) return detail;
  const sigNum = code - 128;
  const sigName = SIGNAL_NAMES[sigNum] ?? `signal ${sigNum}`;
  return `${detail} (killed by ${sigName})`;
}

class CodexRemoteLauncher extends RemoteLauncherBase {
  private readonly session: CodexSession;
  private readonly client: CodexMcpClient;
  private permissionHandler: CodexPermissionHandler | null = null;
  private reasoningProcessor: ReasoningProcessor | null = null;
  private diffProcessor: DiffProcessor | null = null;
  private happyServer: HappyServer | null = null;
  private abortController: AbortController = new AbortController();
  private storedSessionIdForResume: string | null = null;

  constructor(session: CodexSession) {
    super(process.env.DEBUG ? session.logPath : undefined);
    this.session = session;
    this.client = new CodexMcpClient();
  }

  protected createDisplay(
    context: RemoteLauncherDisplayContext
  ): React.ReactElement {
    return React.createElement(CodexDisplay, context);
  }

  private async handleAbort(): Promise<void> {
    logger.debug("[Codex] Abort requested - stopping current task");
    try {
      if (this.client.hasActiveSession()) {
        this.storedSessionIdForResume = this.client.storeSessionForResume();
        logger.debug(
          "[Codex] Stored session for resume:",
          this.storedSessionIdForResume
        );
      }

      this.abortController.abort();
      this.session.queue.reset();
      this.permissionHandler?.reset();
      this.reasoningProcessor?.abort();
      this.diffProcessor?.reset();
      logger.debug("[Codex] Abort completed - session remains active");
    } catch (error) {
      logger.debug("[Codex] Error during abort:", error);
      logger.reportCaught(error, {
        category: "codex-abort",
        severity: "warn",
      });
    } finally {
      this.abortController = new AbortController();
    }
  }

  private async handleExitFromUi(): Promise<void> {
    logger.debug("[codex-remote]: Exiting agent via Ctrl-C");
    this.exitReason = "exit";
    this.shouldExit = true;
    await this.handleAbort();
  }

  private async handleSwitchFromUi(): Promise<void> {
    logger.debug("[codex-remote]: Switching to local mode via double space");
    this.exitReason = "switch";
    this.shouldExit = true;
    await this.handleAbort();
  }

  private async handleSwitchRequest(): Promise<void> {
    this.exitReason = "switch";
    this.shouldExit = true;
    await this.handleAbort();
  }

  public async launch(): Promise<RemoteLauncherExitReason> {
    if (this.session.codexArgs && this.session.codexArgs.length > 0) {
      if (hasCodexCliOverrides(this.session.codexCliOverrides)) {
        logger.debug(
          `[codex-remote] CLI args include sandbox/approval overrides; other args ` +
            `are ignored in remote mode.`
        );
      } else {
        logger.debug(
          `[codex-remote] Warning: CLI args [${this.session.codexArgs.join(", ")}] are ignored in remote mode. ` +
            `Remote mode uses message-based configuration (model/sandbox set via web interface).`
        );
      }
    }

    return this.start({
      onExit: () => this.handleExitFromUi(),
      onSwitchToLocal: () => this.handleSwitchFromUi(),
    });
  }

  protected async runMainLoop(): Promise<void> {
    const session = this.session;
    const messageBuffer = this.messageBuffer;
    const client = this.client;

    function findCodexResumeFile(sessionId: string | null): string | null {
      if (!sessionId) return null;
      try {
        const codexHomeDir =
          process.env.CODEX_HOME || join(os.homedir(), ".codex");
        const rootDir = join(codexHomeDir, "sessions");

        function collectFilesRecursive(
          dir: string,
          acc: string[] = []
        ): string[] {
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            // expected: directory may not exist or have permission issues —
            // return acc and skip this branch of the recursion.
            return acc;
          }
          for (const entry of entries) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
              collectFilesRecursive(full, acc);
            } else if (entry.isFile()) {
              acc.push(full);
            }
          }
          return acc;
        }

        const candidates = collectFilesRecursive(rootDir)
          .filter(full => full.endsWith(`-${sessionId}.jsonl`))
          .filter(full => {
            try {
              return fs.statSync(full).isFile();
            } catch {
              // expected: file may have been deleted between readdir and stat —
              // exclude from candidates.
              return false;
            }
          })
          .sort((a, b) => {
            try {
              const sa = fs.statSync(a).mtimeMs;
              const sb = fs.statSync(b).mtimeMs;
              return sb - sa;
            } catch {
              // expected: TOCTOU race — a file may disappear between filter
              // and sort. Tie-sort means the disappearing file gets ordered
              // arbitrarily but won't crash the comparator.
              return 0;
            }
          });
        return candidates[0] || null;
      } catch {
        // expected: outer fallback for findCodexResumeFile — return null on
        // any failure so the caller starts a fresh session instead of crashing.
        return null;
      }
    }

    const RESUME_CONTEXT_MAX_ITEMS = 40;
    const RESUME_CONTEXT_MAX_CHARS = 16000;
    const RESUME_CONTEXT_TOOL_MAX_CHARS = 2000;
    const RESUME_CONTEXT_REASONING_MAX_CHARS = 2000;

    function readResumeFileContent(
      resumeFile: string
    ): { content: string; truncated: boolean } | null {
      try {
        const stat = fs.statSync(resumeFile);
        if (!stat.isFile()) {
          return null;
        }
        return {
          content: fs.readFileSync(resumeFile, "utf8"),
          truncated: false,
        };
      } catch (error) {
        logger.debug("[Codex] Failed to read resume file:", error);
        logger.reportCaught(error, {
          category: "codex-resume-read",
          severity: "warn",
        });
        return null;
      }
    }

    function safeStringify(value: unknown): string | null {
      if (value === null || value === undefined) {
        return null;
      }
      if (typeof value === "string") {
        return value;
      }
      try {
        return JSON.stringify(value);
      } catch {
        // expected: JSON.stringify can throw on circular refs or BigInt —
        // fall back to null and skip this value.
        return null;
      }
    }

    function formatResumeValue(
      value: unknown,
      maxChars: number,
      singleLine = false
    ): string | null {
      const raw = safeStringify(value);
      if (!raw) {
        return null;
      }
      const normalized = singleLine ? raw.replace(/\s+/g, " ").trim() : raw;
      if (!normalized) {
        return null;
      }
      if (normalized.length <= maxChars) {
        return normalized;
      }
      return `${normalized.slice(0, maxChars)}...`;
    }

    function buildResumeInstructionsFromFile(
      resumeFile: string
    ): string | undefined {
      const result = readResumeFileContent(resumeFile);
      if (!result) {
        return undefined;
      }

      const items: { role: "user" | "assistant" | "tool"; text: string }[] = [];
      let truncated = result.truncated;

      const lines = result.content.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const parsed = JSON.parse(trimmed);
          const converted = convertCodexEvent(parsed);
          if (converted?.userMessage) {
            items.push({ role: "user", text: converted.userMessage });
          }
          if (converted?.message?.type === "message") {
            items.push({ role: "assistant", text: converted.message.message });
          }
          if (converted?.message?.type === "reasoning") {
            const reasoning = formatResumeValue(
              converted.message.message,
              RESUME_CONTEXT_REASONING_MAX_CHARS
            );
            if (reasoning) {
              items.push({
                role: "assistant",
                text: `Reasoning: ${reasoning}`,
              });
            }
          }
          if (converted?.message?.type === "tool-call") {
            const input = formatResumeValue(
              converted.message.input,
              RESUME_CONTEXT_TOOL_MAX_CHARS,
              true
            );
            const text = input
              ? `Call ${converted.message.name} ${input}`
              : `Call ${converted.message.name}`;
            items.push({ role: "tool", text });
          }
          if (converted?.message?.type === "tool-call-result") {
            const output = formatResumeValue(
              converted.message.output,
              RESUME_CONTEXT_TOOL_MAX_CHARS,
              true
            );
            if (output) {
              items.push({ role: "tool", text: `Result ${output}` });
            }
          }
        } catch {
          // expected: malformed JSONL line — skip and continue parsing the rest.
          continue;
        }
      }

      if (items.length === 0) {
        return undefined;
      }

      if (items.length > RESUME_CONTEXT_MAX_ITEMS) {
        items.splice(0, items.length - RESUME_CONTEXT_MAX_ITEMS);
        truncated = true;
      }

      const rendered = items.map(item => {
        if (item.role === "user") {
          return `User: ${item.text}`;
        }
        if (item.role === "tool") {
          return `Tool: ${item.text}`;
        }
        return `Assistant: ${item.text}`;
      });
      let totalChars = rendered.reduce((sum, line) => sum + line.length + 1, 0);
      while (rendered.length > 1 && totalChars > RESUME_CONTEXT_MAX_CHARS) {
        const removed = rendered.shift();
        totalChars -= (removed?.length ?? 0) + 1;
        truncated = true;
      }

      if (rendered.length === 0) {
        return undefined;
      }

      const header = truncated
        ? "Continue from the prior session context below (transcript truncated):"
        : "Continue from the prior session context below:";
      return `${header}\n${rendered.join("\n")}`;
    }

    const permissionHandler = new CodexPermissionHandler(session.client);
    const reasoningProcessor = new ReasoningProcessor(message => {
      session.sendCodexMessage(message);
    });
    const diffProcessor = new DiffProcessor(message => {
      session.sendCodexMessage(message);
    });
    this.permissionHandler = permissionHandler;
    this.reasoningProcessor = reasoningProcessor;
    this.diffProcessor = diffProcessor;

    // Issue #3352: agent-side per-turn telemetry for codex. Codex emits explicit
    // turn events (task_started / task_complete / turn_aborted) — cleaner
    // boundaries than the ACP prompt cycle — plus token_count usage events. The
    // reporter emits through the SAME sendTurnEvent seam as claude; the server is
    // flavor-agnostic. Codex is OpenAI/ChatGPT-billed (modelProvider "openai");
    // model id from metadata.nativeModel (#3348).
    const turnReporter = new AgentTurnReporter({
      emit: payload => session.client.sendTurnEvent(payload),
      launcher: "codex",
    });
    const codexModelId = session.client.getMetadata()?.nativeModel ?? undefined;

    client.setPermissionHandler(permissionHandler);
    client.setHandler(msg => {
      logger.debug(`[Codex] MCP message: ${JSON.stringify(msg)}`);

      if (msg.type === "agent_message") {
        messageBuffer.addMessage(msg.message!, "assistant");
      } else if (msg.type === "agent_reasoning_delta") {
      } else if (msg.type === "agent_reasoning") {
        messageBuffer.addMessage(
          `[Thinking] ${msg.text!.substring(0, 100)}...`,
          "system"
        );
      } else if (msg.type === "exec_command_begin") {
        messageBuffer.addMessage(`Executing: ${msg.command}`, "tool");
      } else if (msg.type === "exec_command_end") {
        const output = msg.output || msg.error || "Command completed";
        const truncatedOutput = output.substring(0, 200);
        messageBuffer.addMessage(
          `Result: ${truncatedOutput}${output.length > 200 ? "..." : ""}`,
          "result"
        );
      } else if (msg.type === "task_started") {
        messageBuffer.addMessage("Starting task...", "status");
      } else if (msg.type === "task_complete") {
        messageBuffer.addMessage("Task completed", "status");
        sendReady();
      } else if (msg.type === "turn_aborted") {
        messageBuffer.addMessage("Turn aborted", "status");
        sendReady();
      }

      if (msg.type === "task_started") {
        // Issue #3352: open the turn boundary; record a base attribution (R8)
        // so even a zero-token turn row carries a provider.
        turnReporter.open();
        turnReporter.recordUsage({
          modelId: codexModelId,
          modelProvider: "openai",
        });
        if (!session.thinking) {
          logger.debug("thinking started");
          session.onThinkingChange(true);
        }
      }
      if (msg.type === "task_complete" || msg.type === "turn_aborted") {
        // Issue #3352: finalize the turn boundary — the accumulated usage rides
        // turn:finalize. `interrupted` on a user abort, else `completed`.
        turnReporter.finalize(
          msg.type === "turn_aborted" ? "interrupted" : "completed"
        );
        if (session.thinking) {
          logger.debug("thinking completed");
          session.onThinkingChange(false);
        }
        diffProcessor.reset();
      }
      if (msg.type === "agent_reasoning_section_break") {
        reasoningProcessor.handleSectionBreak();
      }
      if (msg.type === "agent_reasoning_delta") {
        reasoningProcessor.processDelta(msg.delta!);
      }
      if (msg.type === "agent_reasoning") {
        reasoningProcessor.complete(msg.text!);
      }
      if (msg.type === "agent_message") {
        session.sendCodexMessage({
          type: "message",
          message: msg.message!,
          id: randomUUID(),
        });
      }
      if (
        msg.type === "exec_command_begin" ||
        msg.type === "exec_approval_request"
      ) {
        const { call_id, type, ...inputs } = msg;
        session.sendCodexMessage({
          type: "tool-call",
          name: "CodexBash",
          callId: call_id!,
          input: inputs,
          id: randomUUID(),
        });
      }
      if (msg.type === "exec_command_end") {
        const { call_id, type, ...output } = msg;
        session.sendCodexMessage({
          type: "tool-call-result",
          callId: call_id!,
          output: output,
          id: randomUUID(),
        });
      }
      if (msg.type === "token_count") {
        // Issue #3352: extract per-turn usage (last_token_usage) + context
        // occupancy (total_token_usage / model_context_window) onto the turn.
        recordCodexTokenUsage(msg, turnReporter, session, codexModelId);
        session.sendCodexMessage({
          ...msg,
          id: randomUUID(),
        });
        // Issue #3809: forward the OpenAI pacing snapshot (the `rate_limits`
        // sibling of `info`) over the SAME /cli socket the turn reporter uses.
        // Fail-open (sendProviderUsageSnapshot swallows) — a pacing signal must
        // never disturb the codex session.
        if (isRecord(msg.rate_limits)) {
          const windows = extractCodexRateLimitWindows(msg.rate_limits);
          if (windows.length > 0) {
            session.client.sendProviderUsageSnapshot({
              provider: "openai",
              windows,
            });
          }
        }
      }
      if (msg.type === "patch_apply_begin") {
        const { call_id, auto_approved, changes } = msg;

        const changeCount = Object.keys(changes!).length;
        const filesMsg = changeCount === 1 ? "1 file" : `${changeCount} files`;
        messageBuffer.addMessage(`Modifying ${filesMsg}...`, "tool");

        session.sendCodexMessage({
          type: "tool-call",
          name: "CodexPatch",
          callId: call_id!,
          input: {
            auto_approved,
            changes,
          },
          id: randomUUID(),
        });
      }
      if (msg.type === "patch_apply_end") {
        const { call_id, stdout, stderr, success } = msg;

        if (success) {
          const message = stdout || "Files modified successfully";
          messageBuffer.addMessage(message.substring(0, 200), "result");
        } else {
          const errorMsg = stderr || "Failed to modify files";
          messageBuffer.addMessage(
            `Error: ${errorMsg.substring(0, 200)}`,
            "result"
          );
        }

        session.sendCodexMessage({
          type: "tool-call-result",
          callId: call_id!,
          output: {
            stdout,
            stderr,
            success,
          },
          id: randomUUID(),
        });
      }
      if (msg.type === "turn_diff") {
        if (msg.unified_diff) {
          diffProcessor.processDiff(msg.unified_diff);
        }
      }
    });

    const { server: happyServer, mcpServers } = await buildHapiMcpBridge(
      session.client
    );
    this.happyServer = happyServer;

    this.setupAbortHandlers(
      session.client.rpcHandlerManager,
      {
        onAbort: () => this.handleAbort(),
        onSwitch: () => this.handleSwitchRequest(),
      },
      // issue #3742: setupAbortHandlers' abortMeta is now required — codex passes
      // the sentinel so its abort stays meta-less (D4-A: never a Claude-worded
      // meta on a codex session).
      NO_META_TEARDOWN,
      // issue #3745: switchMeta is likewise required — codex passes the sentinel
      // so its switch stays meta-less (same D4-A rationale as abort above).
      NO_META_TEARDOWN
    );

    function logActiveHandles(tag: string) {
      if (!process.env.DEBUG) return;
      const nodeProc = process as NodeJS.Process & {
        _getActiveHandles?: () => object[];
        _getActiveRequests?: () => object[];
      };
      const handles =
        typeof nodeProc._getActiveHandles === "function"
          ? nodeProc._getActiveHandles()
          : [];
      const requests =
        typeof nodeProc._getActiveRequests === "function"
          ? nodeProc._getActiveRequests()
          : [];
      logger.debug(
        `[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`
      );
      try {
        const kinds = handles.map((h: object) =>
          h && h.constructor ? h.constructor.name : typeof h
        );
        logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
      } catch {
        // expected: debug introspection only; failure of _getActiveHandles
        // serialization is non-actionable and does not affect correctness.
      }
    }

    const sendReady = () => {
      session.sendSessionEvent({ type: "ready" });
    };

    const syncSessionId = () => {
      const clientSessionId = client.getSessionId();
      if (clientSessionId && clientSessionId !== session.sessionId) {
        session.onSessionFound(clientSessionId);
      }
    };

    await client.connect();

    let wasCreated = false;
    let currentModeHash: string | null = null;
    let pending: {
      message: string;
      mode: EnhancedMode;
      isolate: boolean;
      hash: string;
    } | null = null;
    let nextExperimentalResume: string | null = null;
    let first = true;

    while (!this.shouldExit) {
      logActiveHandles("loop-top");
      let message: {
        message: string;
        mode: EnhancedMode;
        isolate: boolean;
        hash: string;
      } | null = pending;
      pending = null;
      if (!message) {
        const waitSignal = this.abortController.signal;
        const batch =
          await session.queue.waitForMessagesAndGetAsString(waitSignal);
        if (!batch) {
          if (waitSignal.aborted && !this.shouldExit) {
            logger.debug(
              "[codex]: Wait aborted while idle; ignoring and continuing"
            );
            continue;
          }
          logger.debug(
            `[codex]: batch=${!!batch}, shouldExit=${this.shouldExit}`
          );
          break;
        }
        message = batch;
      }

      if (!message) {
        break;
      }

      if (wasCreated && currentModeHash && message.hash !== currentModeHash) {
        logger.debug("[Codex] Mode changed – restarting Codex session");
        messageBuffer.addMessage("═".repeat(40), "status");
        messageBuffer.addMessage(
          "Starting new Codex session (mode changed)...",
          "status"
        );
        try {
          const prevSessionId = client.getSessionId();
          nextExperimentalResume = findCodexResumeFile(prevSessionId);
          if (nextExperimentalResume) {
            logger.debug(
              `[Codex] Found resume file for session ${prevSessionId}: ${nextExperimentalResume}`
            );
            messageBuffer.addMessage("Resuming previous context…", "status");
          } else {
            logger.debug("[Codex] No resume file found for previous session");
          }
        } catch (error) {
          logger.debug("[Codex] Error while searching resume file", error);
          logger.reportCaught(error, {
            category: "codex-resume-mode-change",
            severity: "warn",
          });
        }
        client.clearSession();
        wasCreated = false;
        currentModeHash = null;
        pending = message;
        permissionHandler.reset();
        reasoningProcessor.abort();
        diffProcessor.reset();
        session.onThinkingChange(false);
        continue;
      }

      messageBuffer.addMessage(message.message, "user");
      currentModeHash = message.hash;

      try {
        if (!wasCreated) {
          let resumeFile: string | null = null;
          if (nextExperimentalResume) {
            resumeFile = nextExperimentalResume;
            nextExperimentalResume = null;
            logger.debug(
              "[Codex] Using resume file from mode change:",
              resumeFile
            );
          } else if (this.storedSessionIdForResume) {
            const abortResumeFile = findCodexResumeFile(
              this.storedSessionIdForResume
            );
            if (abortResumeFile) {
              resumeFile = abortResumeFile;
              logger.debug(
                "[Codex] Using resume file from aborted session:",
                resumeFile
              );
              messageBuffer.addMessage(
                "Resuming from aborted session...",
                "status"
              );
            }
            this.storedSessionIdForResume = null;
          } else if (first && session.sessionId) {
            const localResumeFile = findCodexResumeFile(session.sessionId);
            if (localResumeFile) {
              resumeFile = localResumeFile;
              logger.debug(
                "[Codex] Using resume file from local session:",
                localResumeFile
              );
              messageBuffer.addMessage(
                "Resuming from local session log...",
                "status"
              );
            }
          }

          const developerInstructions = resumeFile
            ? buildResumeInstructionsFromFile(resumeFile)
            : undefined;
          const startConfig: CodexSessionConfig = buildCodexStartConfig({
            message: message.message,
            mode: message.mode,
            first,
            mcpServers,
            cliOverrides: session.codexCliOverrides,
            developerInstructions,
          });

          if (resumeFile) {
            if (!startConfig.config) {
              startConfig.config = {};
            }
            startConfig.config.experimental_resume = resumeFile;
          }

          await client.startSession(startConfig, {
            signal: this.abortController.signal,
          });
          wasCreated = true;
          first = false;
          syncSessionId();
        } else {
          await client.continueSession(message.message, {
            signal: this.abortController.signal,
          });
          syncSessionId();
        }
      } catch (error) {
        logger.warn("Error in codex session:", error);
        const isAbortError =
          error instanceof Error && error.name === "AbortError";

        if (isAbortError) {
          messageBuffer.addMessage("Aborted by user", "status");
          session.sendSessionEvent({
            type: "message",
            message: "Aborted by user",
          });
          wasCreated = false;
          currentModeHash = null;
          logger.debug(
            "[Codex] Marked session as not created after abort for proper resume"
          );
        } else {
          const errorDetail = enrichWithSignalContext(
            error instanceof Error ? error.message : String(error)
          );
          messageBuffer.addMessage(
            `Process exited unexpectedly: ${errorDetail}`,
            "status"
          );
          session.sendSessionEvent({
            type: "message",
            message: `Process exited unexpectedly: ${errorDetail}`,
          });
          if (client.hasActiveSession()) {
            this.storedSessionIdForResume = client.storeSessionForResume();
            logger.debug(
              "[Codex] Stored session after unexpected error:",
              this.storedSessionIdForResume
            );
          }
          logger.reportCaught(error, {
            category: "codex-session-error",
            severity: "error",
          });
        }
      } finally {
        permissionHandler.reset();
        reasoningProcessor.abort();
        diffProcessor.reset();
        session.onThinkingChange(false);
        emitReadyIfIdle({
          pending,
          queueSize: () => session.queue.size(),
          shouldExit: this.shouldExit,
          sendReady,
        });
        logActiveHandles("after-turn");
      }
    }
  }

  protected async cleanup(): Promise<void> {
    logger.debug("[codex-remote]: cleanup start");
    try {
      await this.client.disconnect();
    } catch (error) {
      logger.debug("[codex-remote]: Error disconnecting client", error);
      logger.reportCaught(error, {
        category: "codex-cleanup-disconnect",
        severity: "warn",
      });
    }

    this.clearAbortHandlers(this.session.client.rpcHandlerManager);

    if (this.happyServer) {
      this.happyServer.stop();
      this.happyServer = null;
    }

    this.permissionHandler?.reset();
    this.reasoningProcessor?.abort();
    this.diffProcessor?.reset();
    this.permissionHandler = null;
    this.reasoningProcessor = null;
    this.diffProcessor = null;

    logger.debug("[codex-remote]: cleanup done");
  }
}

export async function codexRemoteLauncher(
  session: CodexSession
): Promise<"switch" | "exit"> {
  const launcher = new CodexRemoteLauncher(session);
  return launcher.launch();
}
