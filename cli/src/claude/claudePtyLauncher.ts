// SPDX-License-Identifier: AGPL-3.0-only
import { logger } from "@/ui/logger";
import { Session } from "./session";
import { Future } from "@/utils/future";
import { createSessionScanner } from "./utils/sessionScanner";
import {
  createWebEchoSuppressor,
  shouldSuppressUserEcho,
} from "./utils/webEchoSuppressor";
import { ToolErrorDetector } from "./utils/toolErrorDetector";
import { ApiErrorDetector } from "./utils/apiErrorDetector";
import { CronUsageDetector } from "./utils/cronUsageDetector";
import { ContextUsageDetector } from "./utils/contextUsageDetector";
import {
  SurrogateErrorDetector,
  SURROGATE_LOOP_USER_MESSAGE,
} from "./utils/surrogateErrorDetector";
import {
  RefusalDetector,
  buildRefusalUserMessage,
} from "./utils/refusalDetector";
import { RateLimitDetector } from "./utils/rateLimitDetector";
import { TurnEndDetector } from "./utils/turnEndDetector";
import { claudePty, type ClaudePtyHandle } from "./claudePty";
import {
  ABORT_INTERRUPT_DEBOUNCE_MS,
  createInterruptHandler,
} from "./claudeTmuxRemoteLauncher";
import { createReadinessGate } from "./claudeTmuxRemote";
import {
  resolveAccountTokenForSession,
  resolveAccountConfigDirForSession,
  readBoundApiKeyId,
  API_KEY_SDK_ONLY_MESSAGE,
  withAccountToken,
  withAccountConfigDir,
  resolveSpawnClaudeArgs,
  resolveSpawnContextWindow,
} from "./accountTokenInjection";
import {
  createCleanupHandler,
  createLocalModeRejectionHandler,
} from "./services/mcpToggleService";
import { createLocalModeRejectionHandler as createSetPermissionModeLocalRejection } from "./services/setPermissionModeService";
import { createAnsiQueryResponder } from "./utils/ansiQueryResponder";
import {
  registerActivePty,
  unregisterActivePty,
} from "./utils/activePtyRegistry";
import { wrapBracketedPaste } from "./utils/bracketedPaste";
import { NO_META_TEARDOWN } from "@/api/rpc/types";

const PTY_INITIAL_COLS = 100;
const PTY_INITIAL_ROWS = 30;

/**
 * Resolve the delay (ms) between writing a message's bracketed-paste body and
 * writing the submit Enter. Overridable via HAPI_PTY_SUBMIT_DELAY_MS for live
 * tuning without a rebuild (issue #1459 Task 6 validation). Defaults to 250ms.
 */
function resolvePtySubmitDelayMs(): number {
  const raw = process.env.HAPI_PTY_SUBMIT_DELAY_MS;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 250;
}

/**
 * Delay between the bracketed-paste body write and the submit-Enter write.
 *
 * Issue #1459: claude's Ink TUI absorbs a `\r` that arrives in the same stdin
 * chunk as a pending bracketed paste (a guard against a different submit race),
 * so the Enter must land in a SEPARATE write after the paste-completion debounce
 * has flushed. claude's paste-completion timeout was 100ms in the v1.0.x source;
 * 250ms is a safety margin.
 */
const PTY_SUBMIT_DELAY_MS = resolvePtySubmitDelayMs();

export interface PtySubmitDelivery {
  /** Write the bracketed-paste body now, then schedule the submit Enter. */
  deliver: (message: string) => void;
  /** Cancel all pending submit timers (call on abort/exit/finally). */
  clearPending: () => void;
  /** Pending submit-timer count (test introspection). */
  pendingCount: () => number;
}

/**
 * Message-delivery sequencer for the PTY launcher (issue #1459).
 *
 * Each delivered message is written as TWO PTY writes:
 *   1. the bracketed-paste body (ESC[200~ … ESC[201~, no CR) — written now;
 *   2. the submit Enter (`\r`) — written after `submitDelayMs`, in its own
 *      write, so claude's paste debounce has flushed and the CR is treated as a
 *      submit rather than absorbed into the pending paste.
 *
 * Pending submit timers are tracked so they can be cancelled on abort/exit/
 * finally (mirrors the abort-listener cleanup discipline in claudePty.ts —
 * #1310). The timer re-checks liveness at fire time, so a teardown that races
 * the timer never writes to a dead handle.
 *
 * Exported for unit testing (mirrors the helper-export convention in
 * claudeTmuxRemoteLauncher.ts).
 */
export function createPtySubmitDelivery(opts: {
  write: (data: string) => void;
  isAlive: () => boolean;
  submitDelayMs: number;
  /**
   * Issue #1488 (Gap 3): invoked when a message body was written to the prompt
   * but its submit `\r` was abandoned — either because the handle died before the
   * submit timer fired, or because `clearPending()` cancelled a still-pending
   * submit on teardown. The body is sitting unsubmitted; the caller surfaces an
   * operator signal (log + toast) instead of dropping it silently.
   */
  onSubmitDropped?: (message: string) => void;
}): PtySubmitDelivery {
  // Map timer → the message body it would submit, so a drop can report WHAT was
  // abandoned. A submit that fires normally deletes its entry first, so it is
  // never reported — only bodies caught mid-window by teardown surface a signal.
  const pendingSubmits = new Map<ReturnType<typeof setTimeout>, string>();
  return {
    deliver: (message: string) => {
      opts.write(wrapBracketedPaste(message));
      const timer = setTimeout(() => {
        pendingSubmits.delete(timer);
        if (!opts.isAlive()) {
          opts.onSubmitDropped?.(message);
          return;
        }
        opts.write("\r");
      }, opts.submitDelayMs);
      pendingSubmits.set(timer, message);
    },
    clearPending: () => {
      for (const [timer, message] of pendingSubmits) {
        clearTimeout(timer);
        opts.onSubmitDropped?.(message);
      }
      pendingSubmits.clear();
    },
    pendingCount: () => pendingSubmits.size,
  };
}

export async function claudePtyLauncher(
  session: Session
): Promise<"switch" | "exit"> {
  // Issue #4568 (R5, D-4568-2 A): REFUSE an API-key session before any side
  // effect. API billing is verified and supported on the SDK launcher only (the
  // ruling); this launcher's credential path was never verified for a key, so it
  // refuses rather than risk billing the wrong credential. The daemon forces the
  // SDK launcher for a key spawn; this is the backstop.
  if (readBoundApiKeyId()) {
    session.client.sendSessionEvent({
      type: "message",
      message: API_KEY_SDK_ONLY_MESSAGE,
    });
    throw new Error(API_KEY_SDK_ONLY_MESSAGE);
  }
  const toolErrorDetector = new ToolErrorDetector();
  // Issue #1232: detect Anthropic API errors (exhausted/retrying) → error_logs
  const apiErrorDetector = new ApiErrorDetector();
  // Issue #1488 (Gap 1): surface the in-session-cron reliability warning (#1460)
  // on the PTY launcher, mirroring the SDK launcher's CronUsageDetector wiring.
  const cronUsageDetector = new CronUsageDetector();
  // Issue #1488 (Gap 2): assigned just before spawn, once the spawn `--model`
  // (and thus the context window) is known. The scanner closure reads it lazily;
  // scanner messages only arrive after the spawn, so the null guard is sufficient.
  let contextUsageDetector: ContextUsageDetector | null = null;
  // Issue #1604: detect the UTF-16 surrogate-truncation 400 death-loop and break
  // it via this launcher's existing terminate (doAbort, defined below — referenced
  // lazily, only fires after spawn). reportError (server error_logs) happens inside
  // the detector; the callback adds the loud session-chat notify + the terminate.
  // Issue #1633: surface model content-policy refusals (stop_reason: refusal)
  // visibly in the chat thread — notify-only, never terminate (a refusal is
  // per-turn and recoverable, unlike the surrogate loop's persisted poison).
  const refusalDetector = new RefusalDetector((sessionId, model) => {
    logger.warn(
      `[pty]: model refusal detected for session ${sessionId} (model: ${model ?? "unknown"}) — notifying chat (issue #1633)`
    );
    try {
      session.client.sendSessionEvent({
        type: "message",
        message: buildRefusalUserMessage(model),
      });
    } catch {
      // best-effort notify
    }
  });
  const surrogateErrorDetector = new SurrogateErrorDetector(
    (sessionId, errorText) => {
      logger.warn(
        `[pty]: surrogate-400 compaction death-loop detected for session ${sessionId} — terminating (issue #1604). Error: ${errorText.slice(0, 200)}`
      );
      try {
        session.client.sendSessionEvent({
          type: "message",
          message: SURROGATE_LOOP_USER_MESSAGE,
        });
      } catch {
        // best-effort notify
      }
      void doAbort();
    }
  );

  // Issue #1647: detect the 429 session-limit and flip the session into the
  // rate-limited state (which also clears `thinking` — a rate-limited turn fires
  // no Stop hook under tmux/pty, so the #1611 latch would otherwise stick).
  const rateLimitDetector = new RateLimitDetector(
    (sessionId, info) => {
      session.setRateLimited({
        resetText: info.resetText,
        resetAt: info.resetAt,
        since: Date.now(),
      });
    },
    // Issue #3235: clear the chip on the FALLING edge (genuine forward progress).
    // onThinkingChange no longer clears `rateLimited`, so this is the resume-path
    // clear; teardown clears it separately in the `finally` below.
    () => session.setRateLimited(null),
    // Issue #4936: an API spend cap / user-set spend limit never latches the
    // chip (it is not a usage window), so clear `thinking` at that turn
    // boundary here — TurnEndDetector skips synthetic records and no Stop hook
    // fires on an API-error turn under tmux/pty.
    () => session.onThinkingChange(false)
  );

  // Issue #1742: clear `thinking` on a clean turn-end the same way the SDK
  // launcher does (stream `result` → updateThinking(false)). The Stop hook
  // (#1611) is the fast path but is not reliably delivered out-of-process, so
  // the transcript is the reliable fallback (Fallback Preservation Rule).
  const turnEndDetector = new TurnEndDetector(() => {
    session.onThinkingChange(false);
  });

  // Issue #1573: resolve the account config dir up front (it never throws —
  // returns null for host/non-isolated sessions) so the scanner watches the SAME
  // projects tree the account-bound claude child writes to under isolation,
  // instead of host ~/.claude/projects. Reused for token/model resolution below.
  const accountConfigDir = await resolveAccountConfigDirForSession(session);

  // Issue #1719: suppress the scanner's re-emit of a web-originated user
  // message — the web POST already persisted it (Message A, with localId).
  // Records every web-queue submit (readiness gate below); the scanner consumes
  // a matching record and skips the duplicate. TUI-typed messages never pass
  // through submit, so their echo is never suppressed (Fallback Preservation).
  const webEchoSuppressor = createWebEchoSuppressor();

  const scanner = await createSessionScanner({
    sessionId: session.sessionId,
    workingDirectory: session.path,
    configDir: accountConfigDir ?? undefined,
    onMessage: message => {
      // Issue #1719: skip the duplicate web-user echo (Message A already
      // rendered it). Only this send is gated — the detectors below still run
      // (they act on tool/agent/system messages; a suppressed user-text echo is
      // inert to them, and transcript activity must still clear a TUI prompt).
      if (!shouldSuppressUserEcho(message, webEchoSuppressor)) {
        session.client.sendClaudeSessionMessage(message);
      }
      toolErrorDetector.processMessage(message, session.sessionId);
      // Detect and report Anthropic API errors to the error log system (#1232)
      apiErrorDetector.processMessage(message, session.sessionId);
      cronUsageDetector.processMessage(message, session.sessionId);
      contextUsageDetector?.processMessage(message, session.sessionId);
      // Detect the surrogate-truncation 400 death-loop (#1604)
      surrogateErrorDetector.processMessage(message, session.sessionId);
      // Surface model content-policy refusals in the chat thread (#1633)
      refusalDetector.processMessage(message, session.sessionId);
      // Surface the 429 session-limit rate-limited state + clear thinking (#1647)
      rateLimitDetector.processMessage(message, session.sessionId);
      // Clear thinking on a clean turn-end — the Stop hook (#1611) is the fast
      // path but unreliable under tmux/pty; the transcript is the reliable
      // fallback (#1742).
      turnEndDetector.processMessage(message, session.sessionId);
    },
    // Issue #4383: feed the background-Agent tracker every raw transcript line.
    onRawLine: raw => session.backgroundAgentTracker.onTranscriptLine(raw),
  });

  // Issue #4383: hand the tracker this session's reconcile context (the same
  // account-config dir the scanner watches, #1573).
  session.setBackgroundAgentContext({
    configDir: accountConfigDir ?? undefined,
    workingDirectory: session.path,
  });

  let exitReason: "switch" | "exit" | null = null;
  const processAbortController = new AbortController();
  const exitFuture = new Future<void>();
  let exitFutureResolved = false;
  const resolveExitFuture = () => {
    if (exitFutureResolved) return;
    exitFutureResolved = true;
    exitFuture.resolve(undefined);
  };
  let ptyHandle: ClaudePtyHandle | null = null;

  // Issue #1459: sequences each remote message as a bracketed-paste body write
  // followed by a SEPARATE, delayed submit-Enter write (see
  // createPtySubmitDelivery). The closures read the live `ptyHandle` at call
  // time and re-check it when the submit timer fires.
  const submitDelivery = createPtySubmitDelivery({
    write: data => {
      if (ptyHandle !== null && !ptyHandle.killed()) {
        ptyHandle.write(data);
      }
    },
    isAlive: () => ptyHandle !== null && !ptyHandle.killed(),
    submitDelayMs: PTY_SUBMIT_DELAY_MS,
    // Issue #1488 (Gap 3): a written body whose submit-Enter was cancelled on
    // teardown is surfaced as a warning toast (reusing the #1078/#1460 toast
    // path) rather than silently dropped. The user message text is kept out of
    // the toast body (it can be long/sensitive) — only a length preview is logged.
    onSubmitDropped: message => {
      logger.reportError({
        message: `PTY submit cancelled on teardown — unsubmitted body (${message.length} chars)`,
        category: "pty-submit-dropped",
        severity: "warn",
        sessionId: session.sessionId,
        context: JSON.stringify({
          toolName: "PTY message delivery",
          errorContent:
            "A message was written to the prompt but its submit (Enter) was cancelled by session teardown — it may be sitting unsubmitted.",
        }),
      });
    },
  });

  // #1703: readiness gate — hold queued messages until Claude's Ink TUI is
  // interactive (the SessionStart-driven handleSessionFound below), then flush
  // them exactly once via the #1459 split-Enter submitDelivery.deliver path.
  // Before this gate, setOnMessage submitted the instant ptyHandle was non-null
  // — when `claude` was SPAWNED, not when the TUI mounted — so a cold-start
  // prompt was typed into a not-yet-ready PTY and lost. The gate drains
  // session.queue (catching items pushed before this listener attached too) and
  // never writes to a dead handle (onDropped surfaces an undeliverable message).
  // Mirrors claudeTmuxRemoteLauncher.ts's gate wiring (#1701).
  const readinessGate = createReadinessGate({
    submit: message => {
      // Issue #1719: record the web-origin body so the scanner's echo of it is
      // suppressed (the web POST already persisted this message as Message A).
      webEchoSuppressor.record(message);
      submitDelivery.deliver(message);
    },
    isAlive: () => ptyHandle !== null && !ptyHandle.killed(),
    drainPending: () => session.queue.drainAll().map(item => item.message),
    onDropped: message =>
      logger.warn(
        `[pty]: queued message dropped — PTY not alive at flush (${message.length} chars)`
      ),
  });

  const handleSessionFound = (sessionId: string) => {
    scanner.onNewSession(sessionId);
    // #1703: TUI is ready (SessionStart) → flush messages held during cold start.
    readinessGate.markReady();
  };
  session.addSessionFoundCallback(handleSessionFound);

  const abort = async () => {
    submitDelivery.clearPending();
    if (!processAbortController.signal.aborted) {
      processAbortController.abort();
    }
    if (ptyHandle && !ptyHandle.killed()) {
      ptyHandle.kill();
    }
    await exitFuture.promise;
  };

  const doAbort = async () => {
    logger.debug("[pty]: doAbort");
    if (!exitReason) {
      exitReason = "exit";
    }
    session.queue.reset();
    await abort();
  };

  try {
    // #1654: abort = turn interrupt, not process kill — mirrors the tmux
    // launcher's re-map (launchers mirror line-for-line by design). The PTY
    // equivalent of the tmux Escape named key is a raw ESC byte ("\x1b" —
    // escaped form mandatory; a literal ESC char in source ships an empty
    // write. Matches the submit-Enter precedent write("\r")). Kill semantics
    // preserved for `switch` + teardown (Fallback Preservation Rule).
    session.client.rpcHandlerManager.registerHandler(
      "abort",
      createInterruptHandler({
        getHandle: () => {
          const handle = ptyHandle;
          if (handle === null || handle.killed()) return null;
          return { interruptTurn: () => handle.write("\x1b") };
        },
        debounceMs: ABORT_INTERRUPT_DEBOUNCE_MS,
        log: message => logger.debug(`[pty]: ${message}`),
        // Interrupted turns get no Stop hook — release the thinking dot so
        // the web client doesn't queue follow-ups behind thinking=true.
        onInterrupted: () => {
          session.onThinkingChange(false);
          // Issue #1664 (Sub B): web-stop fires Escape (\x1b) → no Stop hook
          // (#1611 R4 / #1654). Finalize the open turn as interrupted here.
          // "switch" below uses doAbort (teardown) and is NOT finalized — a
          // turn left open by teardown/kill is the orphan case (server sweep,
          // KD-4). The reporter's idempotency guard makes a race safe.
          session.turnReporter?.finalize("interrupted");
        },
      }),
      NO_META_TEARDOWN
    );
    session.client.rpcHandlerManager.registerHandler(
      "switch",
      doAbort,
      NO_META_TEARDOWN
    );
    session.client.rpcHandlerManager.registerHandler(
      "mcp-toggle",
      createLocalModeRejectionHandler(),
      NO_META_TEARDOWN
    );
    // Issue #2346: PTY launcher has no SDK control channel → local_mode_not_supported.
    session.client.rpcHandlerManager.registerHandler(
      "set-permission-mode",
      createSetPermissionModeLocalRejection(),
      NO_META_TEARDOWN
    );

    // #1703: delegate to the readiness gate — held until TUI-ready (markReady),
    // then flushed via submitDelivery.deliver (the #1459 split-Enter path).
    // Mirrors the tmux launcher's setOnMessage → gate.onMessage wiring (#1701).
    session.queue.setOnMessage(() => {
      readinessGate.onMessage();
    });

    const ansiResponder = createAnsiQueryResponder({
      cols: PTY_INITIAL_COLS,
      rows: PTY_INITIAL_ROWS,
      xtversionId: "hapimatic",
    });

    logger.debug("[pty]: spawning claude in PTY");
    // Multi-account (epic #1446, Sub-Issue D): resolve the bound account's token
    // at each launcher (re)entry (R7). Throws on unknown/unrefreshable (R3).
    // Issue #1551: prefer per-account CLAUDE_CONFIG_DIR isolation for a bound
    // non-host account (native owns refresh). null falls through to the env-token
    // path, which AUGMENTS — never replaces — isolation (Fallback Preservation
    // Rule) and carries the unknown/unrefreshable throws (R3/R4).
    // accountConfigDir was resolved up front (above createSessionScanner, #1573)
    // and is reused here. resolveAccountTokenForSession still runs lazily here
    // because it THROWS on unknown/unrefreshable (R3) and must stay in the try.
    const accountToken = accountConfigDir
      ? null
      : await resolveAccountTokenForSession(session);
    // Issue #1488 (Gap 4): append the entitled `--model` pin at spawn time when
    // the session is account-bound and has no explicit model selection, so the
    // child does not silently fall back to Sonnet 4.6 (the #1506/#1509 downgrade).
    // Issue #1551: SKIP the pin for a CLAUDE_CONFIG_DIR-isolated session — native
    // reads the isolated credentials and self-resolves the SAME entitled model
    // (verified: `CLAUDE_CONFIG_DIR=<iso> claude -p` → claude-opus-4-8[1m] @ 1M), so
    // the pin is redundant AND collides with native's self-resolution, oscillating
    // modelMode (default<->opus) → respawn loop → SIGTERM 143 / code=1. The
    // host/env-token paths (accountConfigDir === null) keep the pin — they have no
    // isolated config to self-resolve from.
    // Issue #1608: the isolated-vs-env-token branch + entitled-pin derivation now
    // live in resolveSpawnClaudeArgs, which keys the pin off session.getModel()
    // (the #1506-resilient discriminator) instead of the display-overloaded
    // session.getModelMode() that previously leaked "opus" → dropped the pin.
    const claudeArgs = await resolveSpawnClaudeArgs(
      session,
      accountConfigDir,
      session.claudeArgs
    );
    // Issue #1488 (Gap 2) + #1556: derive the context window from the spawn
    // `--model` value (pinned entitled model or explicit user selection), OR —
    // for a CLAUDE_CONFIG_DIR-isolated session that carries no `--model` pin
    // (#1551 default-mode path) — from the entitled model native self-resolves.
    // Reads claudeArgs only; never mutates them (no `--model` re-added — R3).
    const contextWindowTokens = await resolveSpawnContextWindow(
      claudeArgs,
      accountConfigDir
    );
    contextUsageDetector = new ContextUsageDetector({
      contextWindowTokens,
      onContextUsage: session.onContextUsage,
    });
    ptyHandle = await claudePty({
      path: session.path,
      sessionId: session.sessionId,
      abort: processAbortController.signal,
      claudeEnvVars: withAccountConfigDir(
        withAccountToken(session.claudeEnvVars, accountToken),
        accountConfigDir
      ),
      claudeArgs,
      mcpServers: session.mcpServers,
      allowedTools: session.allowedTools,
      hookSettingsPath: session.hookSettingsPath,
      initialCols: PTY_INITIAL_COLS,
      initialRows: PTY_INITIAL_ROWS,
      onPtyOutput: data => {
        const responses = ansiResponder.scan(data);
        if (responses.length > 0 && ptyHandle && !ptyHandle.killed()) {
          for (const r of responses) {
            ptyHandle.write(r);
          }
        }
        session.client.sendClaudePtyOutput(data);
      },
      onExit: (code, signal) => {
        logger.debug(`[pty]: pty exit code=${code} signal=${signal}`);
        if (!exitReason) {
          exitReason = "exit";
        }
        resolveExitFuture();
      },
    });

    registerActivePty(session.client.sessionId, ptyHandle);

    session.consumeOneTimeFlags();

    if (session.queue.size() > 0) {
      logger.debug(
        `[pty]: pre-existing queue items: ${session.queue.size()}; held by the readiness gate, will flush on TUI-ready (SessionStart) — #1703`
      );
    }

    await exitFuture.promise;
  } catch (error) {
    logger.debug("[pty]: launcher error", { error });
    const message = error instanceof Error ? error.message : String(error);
    try {
      session.client.sendSessionEvent({
        type: "message",
        message: `PTY launcher failed: ${message}`,
      });
    } catch {
      // ignore
    }
    if (!exitReason) {
      exitReason = "exit";
    }
  } finally {
    // Issue #1611 (R4): a session aborted/interrupted/switched mid-turn never
    // receives a Stop hook, so force thinking=false on teardown to release the
    // status dot (mirrors the sdk path's finally thinking reset).
    session.onThinkingChange(false);
    // Issue #3235: onThinkingChange no longer clears `rateLimited`, so clear the
    // chip explicitly on teardown — a dead session must not show a stale chip.
    session.setRateLimited(null);

    session.client.rpcHandlerManager.registerHandler(
      "abort",
      async () => {},
      NO_META_TEARDOWN
    );
    session.client.rpcHandlerManager.registerHandler(
      "switch",
      async () => {},
      NO_META_TEARDOWN
    );
    session.client.rpcHandlerManager.registerHandler(
      "mcp-toggle",
      createCleanupHandler({ sessionPath: session.path }),
      NO_META_TEARDOWN
    );
    session.queue.setOnMessage(null);
    submitDelivery.clearPending();

    session.removeSessionFoundCallback(handleSessionFound);

    unregisterActivePty(session.client.sessionId);

    if (ptyHandle && !ptyHandle.killed()) {
      ptyHandle.kill();
    }

    await scanner.cleanup();

    resolveExitFuture();
  }

  return exitReason ?? "exit";
}
