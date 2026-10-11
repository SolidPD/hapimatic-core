// SPDX-License-Identifier: MIT
/**
 * `claudeTmuxRemoteLauncher` — backup remote launcher invoked by
 * `launcherDispatch` when `HAPI_CLAUDE_LAUNCHER=tmux`. Mirrors
 * `claudePtyLauncher.ts` line-for-line: same RPC registrations, same
 * scanner/exit machinery, same activePtyRegistry usage. The ONLY structural
 * difference is the spawn primitive — `claudeTmuxRemote` instead of
 * `claudePty`.
 *
 * Issue #1310 Task 8.
 *
 * Why mirror so closely:
 * - R5 — JSONL scanner integration MUST be identical to the PTY path
 *   (same `onMessage` callback shape, same `sendClaudeSessionMessage`).
 * - Sub-Issue C (#1308) shipped the `claude:pty-output` channel + the
 *   `activePtyRegistry` mechanism. Both launchers feed that same channel
 *   and register their handles in the same registry so the web client's
 *   `claude:pty-write` / `claude:pty-resize` events route correctly
 *   regardless of which launcher served the session.
 * - The launcher contract is precise; the architect's review explicitly
 *   noted no specialist agents are needed for this file because the
 *   structure is dictated by the launcher type.
 */

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
import { AuthErrorDetector } from "./utils/authErrorDetector";
import { RateLimitDetector } from "./utils/rateLimitDetector";
import { TurnEndDetector } from "./utils/turnEndDetector";
import {
  RefusalDetector,
  buildRefusalUserMessage,
} from "./utils/refusalDetector";
import {
  claudeTmuxRemote,
  createReadinessGate,
  type ClaudeTmuxRemoteHandle,
} from "./claudeTmuxRemote";
import {
  createCleanupHandler,
  createLocalModeRejectionHandler,
} from "./services/mcpToggleService";
import { createLocalModeRejectionHandler as createSetPermissionModeLocalRejection } from "./services/setPermissionModeService";
import { createAnsiQueryResponder } from "./utils/ansiQueryResponder";
import {
  resolveAccountTokenForSession,
  resolveAccountConfigDirForSession,
  readBoundApiKeyId,
  API_KEY_SDK_ONLY_MESSAGE,
  withAccountToken,
  withAccountConfigDir,
  resolveSpawnClaudeArgs,
  resolveSpawnContextWindow,
  readBoundAccountUuid,
} from "./accountTokenInjection";
import { accountStore } from "@/accounts/accountStore";
import {
  registerActivePty,
  unregisterActivePty,
} from "./utils/activePtyRegistry";
import { NO_META_TEARDOWN } from "@/api/rpc/types";

const TMUX_INITIAL_COLS = 100;
const TMUX_INITIAL_ROWS = 30;

// R14/R19 (#1429) — burst-load detection window. A spawn that exits in
// less than 5 seconds with non-clean status is treated as a burst-load
// retry candidate (the empirical signal Hapimatic observes when Anthropic
// rate-limits a session bootstrap). Conservative — no stderr parsing, no
// HTTP-status detection.
export const BURST_LOAD_WINDOW_MS = 5000;
export const DEFAULT_RETRY_BUDGET = 3;
export const MAX_RETRY_BUDGET = 10; // clamp to prevent pathological budgets

// Issue #1741 — deaf-launch readiness detection. The tmux remote launcher
// `exec`s claude into the pane. If the `exec claude` send-keys is LOST (a
// shell-readiness race against a just-created pane), the pane stays a live
// login `bash` — `isWindowAlive` (pane_pid + kill -0) reports it alive
// forever, so onExit never fires and the retry loop wedges permanently
// (no retry, no error, no SessionStart → queued prompts never drain). These
// two timers, raced against attemptExit + exitFuture, turn a deaf launch
// into a retryable failure.

// Fast pane-command probe — fires shortly after spawn. If SessionStart has
// NOT been observed AND the pane is still a login shell, the exec was lost.
// Default 5s: well past the sub-second window where bash is still launching
// `exec claude`, yet fast enough to satisfy "within N seconds of window
// creation" (AC #1). A slow-but-started claude reads as node/bun/claude, so
// this never false-positives on a healthy slow start.
export const DEFAULT_LAUNCH_PROBE_MS = 5000;
// Slow readiness watchdog backstop — catches "claude started but never
// reached SessionStart" (startup crash / hung plugin), which the pane-command
// probe cannot see (the pane IS running node). Generous default (45s) because
// plugins + SessionStart hooks can take >30s (daemon run.ts notes this).
export const DEFAULT_READINESS_TIMEOUT_MS = 45000;

// Login-shell basenames. A pane reporting one of these (after stripping a
// leading `-` from login shells like `-bash`) while SessionStart has not
// fired means `exec claude` never ran. node/bun/claude/anything-else ⇒ the
// exec took effect.
const LOGIN_SHELL_COMMANDS = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "dash",
  "ash",
]);

/**
 * Issue #1741 — pure decision: is this spawn a "deaf launch"?
 *
 * Returns true iff SessionStart has NOT been observed AND the pane's current
 * command is a login shell (the `exec claude` send-keys was lost, leaving the
 * pane a live bash). A null `paneCurrentCommand` (tmux fault, or post-exit)
 * returns false — never declare a launch failed on an unreadable signal
 * (Fallback Preservation Rule; mirrors `decideWrapperAlive`'s null-tolerant
 * path). Exported for unit testing.
 */
export function isDeafLaunch(
  sessionStartObserved: boolean,
  paneCurrentCommand: string | null
): boolean {
  if (sessionStartObserved) return false;
  if (!paneCurrentCommand) return false;
  const normalized = paneCurrentCommand.trim().replace(/^-/, "").toLowerCase();
  return LOGIN_SHELL_COMMANDS.has(normalized);
}

/**
 * Issue #1741 — resolve a launch-timeout env knob
 * (`HAPI_TMUX_READINESS_TIMEOUT_MS` / `HAPI_TMUX_LAUNCH_PROBE_MS`), falling
 * back to the supplied default. Mirrors `resolveTmuxSubmitDelayMs`'s
 * NaN/negative guard. Exported for unit testing.
 */
export function resolveLaunchTimeoutMs(
  envValue: string | undefined,
  fallback: number
): number {
  if (envValue === undefined || envValue === "") return fallback;
  const parsed = parseInt(envValue, 10);
  if (isNaN(parsed) || parsed < 0) return fallback;
  return parsed;
}

/**
 * R18 (#1429) — parse `--retries N` from claudeArgs, returning the parsed
 * value (or null when absent) AND a copy of claudeArgs with the flag pair
 * removed (so it doesn't leak to `claude`). Mirrors the
 * `shared/src/launcherResolver.ts` precedence chain: CLI > env > default.
 *
 * Exported for unit testing.
 */
export function parseAndStripRetriesArg(claudeArgs?: string[]): {
  retries: number | null;
  remaining: string[] | undefined;
} {
  if (!claudeArgs || claudeArgs.length === 0) {
    return { retries: null, remaining: claudeArgs };
  }
  const remaining: string[] = [];
  let retries: number | null = null;
  let i = 0;
  while (i < claudeArgs.length) {
    const arg = claudeArgs[i];
    if (arg === "--retries" && i + 1 < claudeArgs.length) {
      const next = claudeArgs[i + 1];
      const parsed = parseInt(next, 10);
      if (!isNaN(parsed)) {
        retries = parsed;
        i += 2;
        continue;
      }
    }
    remaining.push(arg);
    i++;
  }
  return { retries, remaining };
}

/**
 * R18 (#1429) — resolve the effective retry budget from the precedence
 * chain (CLI > env > default 3) and return the cleaned claudeArgs (with
 * `--retries N` stripped). Exported for unit testing.
 *
 * @param claudeArgs the launcher's `claudeArgs` array (may be undefined)
 * @param envValue   the resolved value of `HAPI_TMUX_LAUNCHER_RETRIES`
 *                   (or undefined). Accepted as a parameter (instead of
 *                   reading process.env directly) so tests can drive the
 *                   precedence chain without env mutation.
 */
export function resolveRetryBudget(
  claudeArgs?: string[],
  envValue?: string | undefined
): {
  budget: number;
  remainingArgs: string[] | undefined;
  source: "cli" | "env" | "default";
} {
  const { retries: cliRetries, remaining } =
    parseAndStripRetriesArg(claudeArgs);
  if (cliRetries !== null) {
    return {
      budget: Math.max(0, Math.min(MAX_RETRY_BUDGET, cliRetries)),
      remainingArgs: remaining,
      source: "cli",
    };
  }
  if (envValue !== undefined && envValue !== "") {
    const envParsed = parseInt(envValue, 10);
    if (!isNaN(envParsed)) {
      return {
        budget: Math.max(0, Math.min(MAX_RETRY_BUDGET, envParsed)),
        remainingArgs: remaining,
        source: "env",
      };
    }
  }
  return {
    budget: DEFAULT_RETRY_BUDGET,
    remainingArgs: remaining,
    source: "default",
  };
}

/**
 * R19 (#1429) — conservative burst-load classifier. Returns true iff the
 * spawn primitive reported a fast (<5s), non-clean exit AND we're NOT
 * currently aborting. The abort guard prevents retrying when the kill
 * we just issued caused the fast exit. Exported for unit testing.
 *
 * Non-clean exit = any non-zero code OR any signal. Tmux reports both
 * as null today (see claudeTmuxRemote.ts onExit comment), but a future
 * enhancement that exposes them gets the right semantics.
 */
export function isBurstLoadExit(
  code: number | null,
  signal: string | null,
  elapsedMs: number | undefined,
  aborted: boolean
): boolean {
  if (aborted) return false;
  if (typeof elapsedMs !== "number") return false;
  if (elapsedMs >= BURST_LOAD_WINDOW_MS) return false;
  return code !== 0 || signal !== null;
}

/**
 * #1463 — retry-exhaustion classifier. Returns true iff the retry loop's
 * fall-through was caused by a burst-load exit with no retry budget remaining
 * (as opposed to a clean / non-burst exit, which must stay silent). Pure +
 * exported for unit testing, mirroring isBurstLoadExit.
 */
export function isRetryBudgetExhausted(
  burstLoadExit: boolean,
  attempt: number,
  retryBudget: number
): boolean {
  return burstLoadExit && attempt >= retryBudget;
}

/**
 * #1654: debounce window for repeated `abort` RPCs. A second Escape landing
 * after the turn has already stopped is hypothesized to open the TUI's
 * history-rewind affordance (fable-review 2026-06-12 — not spike-confirmed;
 * the live matrix characterizes actual idle-Escape behavior), so rapid
 * repeats inside this window are dropped.
 */
export const ABORT_INTERRUPT_DEBOUNCE_MS = 1500;

/** Minimal surface createInterruptHandler needs from a launcher handle. */
export interface InterruptableHandle {
  interruptTurn: () => void;
}

/**
 * #1654: web stop = turn interrupt, not process kill.
 *
 * Pure factory for the `abort` RPC handler under the tmux/pty launchers
 * (exported for direct unit testing — the test file has no registrar/handle
 * mock harness, so suites exercise this factory with a fake handle).
 *
 * Fallback Preservation Rule: this handler AUGMENTS the stop path only — it
 * re-maps the `"abort"` registration to a turn interrupt. Kill semantics
 * stay reachable everywhere else: `"switch"` still routes to doAbort (local
 * takeover legitimately terminates the remote launcher), the surrogate-400
 * death-loop terminator (#1604) still calls doAbort, and per-session
 * teardown kills via `tmuxHandle.kill()` → `killWindow`
 * (claudeTmuxRemote.ts) with orphan reap in `reapOrphanedSessions`
 * (launcherShared.ts).
 *
 * The debounce timestamp is closure-scoped — NOT module-level — so it resets
 * cleanly when a mode-switch re-invokes the launcher (R3). A dropped attempt
 * (no live handle) does not stamp the debounce. Never throws into the RPC
 * layer (R6).
 */
export function createInterruptHandler(opts: {
  getHandle: () => InterruptableHandle | null;
  debounceMs: number;
  log: (message: string) => void;
  /**
   * Fired once per ACCEPTED interrupt (not on dropped or debounced attempts).
   * The launchers pass `() => session.onThinkingChange(false)` here: an
   * Escape-interrupted turn never receives a Stop hook (#1611 R4's
   * mechanism), and the teardown `finally` that used to reset the thinking
   * dot no longer runs because the process stays alive — without this reset
   * the web client queues all follow-up messages behind a stuck
   * thinking=true (live-verified during #1654 Task 5.2).
   */
  onInterrupted?: () => void;
  /** Injectable clock for unit tests; defaults to Date.now. */
  now?: () => number;
}): () => Promise<void> {
  const now = opts.now ?? Date.now;
  let lastInterruptAt: number | null = null;
  return async () => {
    const handle = opts.getHandle();
    if (!handle) {
      opts.log("abort->interrupt: no live handle; dropping");
      return;
    }
    const t = now();
    if (lastInterruptAt !== null && t - lastInterruptAt < opts.debounceMs) {
      opts.log("abort->interrupt: debounced repeat abort; dropping");
      return;
    }
    lastInterruptAt = t;
    try {
      handle.interruptTurn();
      opts.onInterrupted?.();
    } catch (err) {
      // R6: never propagate into the RPC layer.
      opts.log(`abort->interrupt: interruptTurn threw: ${String(err)}`);
    }
  };
}

/**
 * Best-effort lookup of the bound account's email for user-facing auth-failure
 * messaging (#1635). Never throws; returns null when unbound or on any error.
 * Token values are never read or logged here — identity fields only.
 */
async function resolveBoundAccountEmail(): Promise<string | null> {
  try {
    const uuid = readBoundAccountUuid();
    if (!uuid) return null;
    const res = await accountStore.get(uuid);
    return res?.ok ? res.account.emailAddress || null : null;
  } catch {
    return null;
  }
}

/**
 * Issue #1653: best-effort epoch-ms extraction from a scanner message for the
 * blocked-on-TUI-prompt since-guard. Transcript entries carry an untyped ISO
 * `timestamp` (RawJSONLines is `.passthrough()` — cli/src/claude/types.ts; the
 * field is not on the typed shape, per fable-review [1653-4]). Returns
 * `undefined` when absent/unparseable, in which case the caller
 * (`clearTuiPromptOnActivity`) falls back to an unconditional clear.
 */
function extractActivityEpochMs(message: unknown): number | undefined {
  if (message && typeof message === "object" && "timestamp" in message) {
    const ts = (message as { timestamp?: unknown }).timestamp;
    if (typeof ts === "string") {
      const ms = Date.parse(ts);
      return Number.isNaN(ms) ? undefined : ms;
    }
  }
  return undefined;
}

export async function claudeTmuxRemoteLauncher(
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
  // on the tmux launcher, mirroring the SDK launcher's CronUsageDetector wiring.
  const cronUsageDetector = new CronUsageDetector();
  // Issue #1488 (Gap 2): assigned before the spawn loop, once the spawn `--model`
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
      `[tmux-remote]: model refusal detected for session ${sessionId} (model: ${model ?? "unknown"}) — notifying chat (issue #1633)`
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
        `[tmux-remote]: surrogate-400 compaction death-loop detected for session ${sessionId} — terminating (issue #1604). Error: ${errorText.slice(0, 200)}`
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

  // Issue #1635 (R3/R4): latch auth-class API errors (401/403
  // authentication_error) from the message stream. The R14 retry decision
  // below consults the latch — an auth-dead spawn fails fast with ONE clear
  // message instead of burning the burst-load retry budget (the account
  // binding is frozen per launcher invocation, so retries cannot heal auth).
  const authErrorDetector = new AuthErrorDetector();

  // Issue #1647: detect the 429 session-limit in the transcript stream and flip
  // the session into the rate-limited state (which also clears `thinking` — a
  // rate-limited turn fires no Stop hook under tmux/pty, so the #1611 latch would
  // otherwise stick forever). Mirrors the other detectors' onMessage wiring.
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
      // Issue #1653 clear-site (ii): transcript activity means Claude has moved
      // past a pending TUI prompt (answered in the TUI / web terminal, or
      // dismissed via the #1654 web-Stop→Escape path that fires NO Stop hook).
      // The since-guard inside clearTuiPromptOnActivity skips backlog deliveries
      // older than when the prompt fired; it is a no-op when nothing is blocked.
      session.clearTuiPromptOnActivity(extractActivityEpochMs(message));
      toolErrorDetector.processMessage(message, session.sessionId);
      // Detect and report Anthropic API errors to the error log system (#1232)
      apiErrorDetector.processMessage(message, session.sessionId);
      cronUsageDetector.processMessage(message, session.sessionId);
      contextUsageDetector?.processMessage(message, session.sessionId);
      // Detect the surrogate-truncation 400 death-loop (#1604)
      surrogateErrorDetector.processMessage(message, session.sessionId);
      // Surface model content-policy refusals in the chat thread (#1633)
      refusalDetector.processMessage(message, session.sessionId);
      // Latch auth-class 401/403 errors for the R14 fail-fast decision (#1635)
      authErrorDetector.processMessage(message, session.sessionId);
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
  let tmuxHandle: ClaudeTmuxRemoteHandle | null = null;

  // #1701: readiness gate — hold queued messages until Claude's Ink TUI is
  // interactive (the SessionStart-driven handleSessionFound below), then flush
  // them exactly once via the #1599 split-Enter submitMessage path. Before this
  // gate, the setOnMessage callback submitted the instant tmuxHandle became
  // non-null — when the launch command was *typed* (claudeTmuxRemote.ts:767),
  // NOT when the TUI mounted — so a prompt auto-sent in the cold-start window was
  // typed into a not-yet-ready pane and silently lost. The gate drains
  // session.queue (catching items pushed before this listener attached too) and
  // never types into a dead pane (onDropped surfaces an undeliverable message).
  const readinessGate = createReadinessGate({
    submit: message => {
      // Issue #1719: record the web-origin body so the scanner's echo of it is
      // suppressed (the web POST already persisted this message as Message A).
      webEchoSuppressor.record(message);
      tmuxHandle?.submitMessage(message);
    },
    isAlive: () => tmuxHandle !== null && !tmuxHandle.killed(),
    drainPending: () => session.queue.drainAll().map(item => item.message),
    onDropped: message =>
      logger.warn(
        `[tmux-remote]: queued message dropped — pane not alive at flush (${message.length} chars)`
      ),
  });

  // Issue #1741: track whether SessionStart fired (TUI reached interactive).
  // The readiness watchdog + pane-command probe in the retry loop consult this
  // flag to detect a deaf launch (claude never started). Set once in
  // handleSessionFound below; the timers self-cancel when it flips true.
  let sessionStartObserved = false;
  const handleSessionFound = (sessionId: string) => {
    scanner.onNewSession(sessionId);
    // #1701: TUI is ready (SessionStart) → flush messages held during cold start.
    sessionStartObserved = true; // #1741: cancels the deaf-launch watchdog/probe.
    readinessGate.markReady();
  };
  session.addSessionFoundCallback(handleSessionFound);

  const abort = async () => {
    if (!processAbortController.signal.aborted) {
      processAbortController.abort();
    }
    if (tmuxHandle && !tmuxHandle.killed()) {
      tmuxHandle.kill();
    }
    await exitFuture.promise;
  };

  const doAbort = async () => {
    logger.debug("[tmux-remote]: doAbort");
    if (!exitReason) {
      exitReason = "exit";
    }
    session.queue.reset();
    await abort();
  };

  try {
    // #1654: `abort` (web stop, `hapi api sessions abort`, federation proxy)
    // interrupts the current turn instead of killing the window — restoring
    // semantic parity with the SDK launcher's handleAbortRequest. Fallback
    // Preservation Rule: `switch`, the surrogate-400 terminator (#1604), and
    // teardown keep full kill semantics via doAbort / tmuxHandle.kill().
    session.client.rpcHandlerManager.registerHandler(
      "abort",
      createInterruptHandler({
        getHandle: () => tmuxHandle,
        debounceMs: ABORT_INTERRUPT_DEBOUNCE_MS,
        log: message => logger.debug(`[tmux-remote]: ${message}`),
        // Interrupted turns get no Stop hook — release the thinking dot so
        // the web client doesn't queue follow-ups behind thinking=true.
        onInterrupted: () => {
          session.onThinkingChange(false);
          // Issue #1664 (Sub B): web-stop fires Escape → no Stop hook
          // (#1611 R4 / #1654). Finalize the open turn as interrupted here.
          // This is the genuine interrupt RPC ("abort"); "switch" below uses
          // doAbort (teardown) and is deliberately NOT finalized — a turn left
          // open by teardown/kill is the orphan case (server sweep, KD-4). The
          // reporter's idempotency guard makes a racing Stop-vs-interrupt safe.
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
    // Issue #2346: tmux launcher has no SDK control channel → local_mode_not_supported.
    session.client.rpcHandlerManager.registerHandler(
      "set-permission-mode",
      createSetPermissionModeLocalRejection(),
      NO_META_TEARDOWN
    );

    // #1701: delegate to the readiness gate (declared above). The message body
    // is ignored here — the gate pulls from session.queue via drainPending, so
    // items pushed before this listener attached are flushed too. Before
    // TUI-ready the gate holds (no-op); after ready it flushes via the #1599
    // split-Enter submitMessage. This eliminates both the drop-before-ready and
    // the submit-into-a-dead-pane losses.
    session.queue.setOnMessage(() => {
      readinessGate.onMessage();
    });

    const ansiResponder = createAnsiQueryResponder({
      cols: TMUX_INITIAL_COLS,
      rows: TMUX_INITIAL_ROWS,
      xtversionId: "hapimatic",
    });

    // R14/R18 (#1429) — resolve retry budget: CLI arg > env var > default 3.
    // The `--retries N` pair (if present in claudeArgs) is stripped from the
    // arg list so it doesn't leak to `claude` itself. The env value is
    // injected here (rather than read inside resolveRetryBudget) so the
    // helper stays pure-testable.
    const {
      budget: retryBudget,
      remainingArgs,
      source: retrySource,
    } = resolveRetryBudget(
      session.claudeArgs,
      process.env.HAPI_TMUX_LAUNCHER_RETRIES
    );
    const claudeArgsForSpawn = remainingArgs;
    logger.debug(
      `[tmux-remote]: retry budget=${retryBudget} source=${retrySource}`
    );

    // R14 (#1429) — retry loop. Each iteration spawns a fresh tmux window
    // with a per-attempt suffix and waits for that attempt to exit (or for
    // an abort, which always wins). Burst-load exits with retries
    // remaining trigger a fresh spawn; any other exit propagates to the
    // outer finally-block cleanup.
    // Multi-account (epic #1446, Sub-Issue D): resolve ONCE per launcher
    // invocation — outside the burst-load retry loop (retries are within
    // seconds; R7 re-resolution happens on the next launcher (re)entry, not per
    // retry). Throws on unknown/unrefreshable (R3).
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
    // Issue #1488 (Gap 4): append the entitled `--model` pin to the (retries-
    // stripped) spawn args when account-bound with no explicit model selection,
    // so the child does not silently fall back to Sonnet 4.6 (#1506/#1509).
    // Resolved once per launcher invocation (outside the burst-load retry loop,
    // mirroring `accountToken`) — every retry re-spawns with the same args.
    // Issue #1551: SKIP the #1506 pin for a CLAUDE_CONFIG_DIR-isolated session —
    // native self-resolves the same entitled model (opus[1m] @ 1M) from the
    // isolated credentials, so the pin is redundant AND collides with native's
    // resolution (modelMode oscillation → respawn → SIGTERM 143 / code=1). The
    // host/env-token paths (accountConfigDir === null) keep the pin.
    // Issue #1608: the isolated-vs-env-token branch + entitled-pin derivation now
    // live in resolveSpawnClaudeArgs, which keys the pin off session.getModel()
    // (the #1506-resilient discriminator) instead of the display-overloaded
    // session.getModelMode() that previously leaked "opus" → dropped the pin.
    const claudeArgsWithModel = await resolveSpawnClaudeArgs(
      session,
      accountConfigDir,
      claudeArgsForSpawn
    );
    // Issue #1488 (Gap 2) + #1556: derive the context window from the spawn
    // `--model` value (pinned entitled model or explicit user selection), OR —
    // for a CLAUDE_CONFIG_DIR-isolated session that carries no `--model` pin
    // (#1551 default-mode path) — from the entitled model native self-resolves.
    // Reads claudeArgsWithModel only; never mutates them (no `--model` re-added — R3).
    const contextWindowTokens = await resolveSpawnContextWindow(
      claudeArgsWithModel,
      accountConfigDir
    );
    contextUsageDetector = new ContextUsageDetector({
      contextWindowTokens,
      onContextUsage: session.onContextUsage,
    });
    // Issue #1741: resolve the deaf-launch detection timeouts once per launcher
    // invocation (env-overridable for live tuning, mirroring TMUX_SUBMIT_DELAY_MS).
    const launchProbeMs = resolveLaunchTimeoutMs(
      process.env.HAPI_TMUX_LAUNCH_PROBE_MS,
      DEFAULT_LAUNCH_PROBE_MS
    );
    const readinessTimeoutMs = resolveLaunchTimeoutMs(
      process.env.HAPI_TMUX_READINESS_TIMEOUT_MS,
      DEFAULT_READINESS_TIMEOUT_MS
    );
    let attempt = 0;
    let retryThisAttempt = false;
    do {
      retryThisAttempt = false;

      // Per-attempt exit capture — fully separate from the outer
      // `exitFuture` so the wrapper can inspect (code, signal, elapsedMs)
      // without short-circuiting the abort path.
      const attemptExit = new Future<{
        code: number | null;
        signal: string | null;
        elapsedMs: number | undefined;
      }>();

      logger.debug(
        `[tmux-remote]: spawning claude in tmux window (attempt ${attempt + 1}/${retryBudget + 1})`
      );
      tmuxHandle = await claudeTmuxRemote({
        path: session.path,
        sessionId: session.sessionId,
        abort: processAbortController.signal,
        hapiSessionId: session.client.sessionId,
        claudeEnvVars: withAccountConfigDir(
          withAccountToken(session.claudeEnvVars, accountToken),
          accountConfigDir
        ),
        claudeArgs: claudeArgsWithModel,
        mcpServers: session.mcpServers,
        allowedTools: session.allowedTools,
        hookSettingsPath: session.hookSettingsPath,
        initialCols: TMUX_INITIAL_COLS,
        initialRows: TMUX_INITIAL_ROWS,
        // R14 (#1429) — first attempt omits attemptId so the window/FIFO
        // names are byte-identical to pre-R14. Retries get `-r1`, `-r2`,
        // etc., guaranteeing fresh names.
        attemptId: attempt === 0 ? undefined : `r${attempt}`,
        // R3 — wire the tmux pane output to Sub-Issue C's `claude:pty-output`
        // channel via the same emit-site the PTY launcher uses. Both
        // launchers feed the same xterm.js renderer; the misnomer
        // `claude:pty-output` is documented in #1310 Open Risks #3 as a
        // future rename candidate.
        onTmuxOutput: data => {
          const responses = ansiResponder.scan(data);
          if (responses.length > 0 && tmuxHandle && !tmuxHandle.killed()) {
            for (const r of responses) {
              tmuxHandle.write(r);
            }
          }
          session.client.sendClaudePtyOutput(data);
        },
        onExit: (code, signal, elapsedMs) => {
          logger.debug(
            `[tmux-remote]: tmux exit code=${code} signal=${signal} elapsedMs=${elapsedMs ?? "?"}`
          );
          attemptExit.resolve({ code, signal, elapsedMs });
        },
      });

      // Register the tmux handle in the activePtyRegistry so inbound
      // `claude:pty-write` / `claude:pty-resize` events from the web client
      // (handled in apiSession.ts) route to this handle. The registry's
      // ClaudePtyHandle type is structurally compatible with our
      // ClaudeTmuxRemoteHandle (identical method signatures), so the cast
      // here is purely nominal — TypeScript accepts it via structural
      // typing.
      registerActivePty(session.client.sessionId, tmuxHandle);

      // Only consume one-time flags + drain pre-existing queue on the
      // first attempt — retries should not re-consume.
      if (attempt === 0) {
        session.consumeOneTimeFlags();
        if (session.queue.size() > 0) {
          logger.debug(
            `[tmux-remote]: pre-existing queue items: ${session.queue.size()}; held by the readiness gate, will flush on TUI-ready (SessionStart) — #1701`
          );
        }
      }

      // Issue #1741: deaf-launch detection. A lost `exec claude` send-keys
      // leaves a live login-bash pane that isWindowAlive cannot distinguish
      // from a running Claude, so onExit never fires and the race below would
      // wedge forever. Race a fast pane-command probe (lost-exec) + a slow
      // SessionStart watchdog (claude started but never reached SessionStart)
      // against attemptExit, turning either into a retryable launch failure.
      const launchFailure = new Future<{
        reason: "deaf" | "no-sessionstart";
      }>();
      let launchFailureResolved = false;
      const resolveLaunchFailure = (reason: "deaf" | "no-sessionstart") => {
        if (launchFailureResolved) return;
        launchFailureResolved = true;
        launchFailure.resolve({ reason });
      };
      const launchTimers: NodeJS.Timeout[] = [];
      const clearLaunchTimers = () => {
        for (const t of launchTimers) clearTimeout(t);
        launchTimers.length = 0;
      };
      const probeHandle = tmuxHandle;
      launchTimers.push(
        setTimeout(() => {
          if (sessionStartObserved || probeHandle.killed()) return;
          void probeHandle
            .paneCurrentCommand()
            .then(cmd => {
              if (isDeafLaunch(sessionStartObserved, cmd)) {
                logger.warn(
                  `[tmux-remote]: deaf-launch probe — pane is '${cmd}' (login shell) ${launchProbeMs}ms after spawn with no SessionStart; exec claude was lost`
                );
                resolveLaunchFailure("deaf");
              }
            })
            .catch(err =>
              logger.debug("[tmux-remote]: deaf-launch probe error", { err })
            );
        }, launchProbeMs)
      );
      launchTimers.push(
        setTimeout(() => {
          if (sessionStartObserved) return;
          logger.warn(
            `[tmux-remote]: readiness watchdog — SessionStart not observed within ${readinessTimeoutMs}ms; treating as a failed launch`
          );
          resolveLaunchFailure("no-sessionstart");
        }, readinessTimeoutMs)
      );

      // Race: this attempt's exit vs. an abort triggered externally vs. a
      // deaf-launch detection (#1741). Abort always wins — it's how the user /
      // RPC handlers cancel mid-flight. A clean exit from the spawn primitive
      // lands on attemptExit. We then inspect to decide retry vs. fall-through.
      const raced = await Promise.race([
        attemptExit.promise.then(r => ({ kind: "exit" as const, ...r })),
        exitFuture.promise.then(() => ({ kind: "abort" as const })),
        launchFailure.promise.then(r => ({
          kind: "launch-failed" as const,
          ...r,
        })),
      ]);

      // Cancel the deaf-launch timers on every race outcome (exit / abort /
      // launch-failed) so they never leak past this attempt.
      clearLaunchTimers();

      if (raced.kind === "abort") {
        // Abort wins — outer finally cleans up. No retry under any
        // circumstance.
        logger.debug(
          "[tmux-remote]: abort observed during attempt; not retrying"
        );
        break;
      }

      if (raced.kind === "launch-failed") {
        // Issue #1741: claude never started in the pane (deaf launch). Treat as
        // a retryable failure within the existing retry budget; on exhaustion,
        // surface a clear error and EXIT so the session never lingers green.
        logger.warn(
          `[tmux-remote]: launch failed (reason=${raced.reason}) on attempt ${attempt + 1}/${retryBudget + 1} — claude did not start in the tmux pane`
        );
        unregisterActivePty(session.client.sessionId);
        if (tmuxHandle && !tmuxHandle.killed()) {
          tmuxHandle.kill();
        }
        tmuxHandle = null;
        if (attempt < retryBudget) {
          attempt++;
          logger.warn(
            `[tmux-remote]: retrying after deaf launch ${attempt}/${retryBudget}`
          );
          retryThisAttempt = true;
          continue;
        }
        try {
          session.client.sendSessionEvent({
            type: "message",
            message:
              `Claude did not start in the tmux pane after ${attempt + 1} attempt(s) — ` +
              `the launch command was not delivered (issue #1741). The session is not ` +
              `alive. Retry by re-spawning, or switch to the sdk launcher ` +
              `(\`hapi launcher set sdk\`).`,
          });
        } catch {
          // ignore — mirrors the catch-block sendSessionEvent guard
        }
        if (!exitReason) {
          exitReason = "exit";
        }
        resolveExitFuture();
        break;
      }

      const { code, signal, elapsedMs } = raced;
      const burstLoadExit = isBurstLoadExit(
        code,
        signal,
        elapsedMs,
        processAbortController.signal.aborted
      );
      // Issue #1635 (R3/R4) — auth-aware effective retry budget. Auth-class
      // failures cannot be healed by respawning (the account binding/token is
      // resolved ONCE per launcher invocation, above the loop):
      //  - auth latch set → 0 retries: fail fast with one clear message
      //  - account-bound session → cap at 1 (belt-and-suspenders: a <5s auth
      //    exit may write NO transcript record, so the latch alone is not
      //    sufficient; a second burst-load exit on a bound session is
      //    auth-suspect)
      //  - unbound (host) session → full budget (pre-#1635 behavior)
      // #3731 R2b: keyed on the binding SOURCE (HAPI_ACCOUNT_UUID), not on token
      // presence — an UNBOUND session now resolves the node's instance credential
      // as its explicit token, which must not demote it to the bound retry cap.
      const accountBound = readBoundAccountUuid() !== null;
      const authLatched = authErrorDetector.authErrorObserved();
      const effectiveRetryBudget = authLatched
        ? 0
        : accountBound
          ? Math.min(1, retryBudget)
          : retryBudget;
      if (burstLoadExit && attempt < effectiveRetryBudget) {
        attempt++;
        logger.warn(
          `[tmux-remote]: burst-load exit detected (code=${code} signal=${signal} elapsed=${elapsedMs}ms); retrying ${attempt}/${effectiveRetryBudget}`
        );
        // Clean up the dead attempt's registry entry + handle so the next
        // iteration's `registerActivePty` call doesn't see a stale handle.
        unregisterActivePty(session.client.sessionId);
        if (tmuxHandle && !tmuxHandle.killed()) {
          tmuxHandle.kill();
        }
        tmuxHandle = null;
        retryThisAttempt = true;
        continue;
      }

      // #1463 — retry-exhaustion signal. The fall-through is reached either on
      // a non-burst exit (happy path — stay silent) OR on a burst-load exit
      // with no retry budget left (exhaustion — emit an operator breadcrumb).
      if (
        isRetryBudgetExhausted(burstLoadExit, attempt, effectiveRetryBudget)
      ) {
        // Issue #1635 (R3/R4): name the failure class precisely. An auth-dead
        // spawn gets ONE actionable message (re-login remedy) instead of the
        // misleading rate-limit framing; a bound-session burst recurrence
        // without a transcript latch is flagged auth-suspect.
        let exhaustionMessage: string;
        if (authLatched) {
          const email = await resolveBoundAccountEmail();
          exhaustionMessage =
            `Session failed with an authentication error (401/403) for the bound account` +
            `${email ? ` ${email}` : ""}. The account's stored credentials were revoked ` +
            `server-side (token-family rotation — issue #1635). Retrying cannot fix this: ` +
            `re-login the account on the host (\`claude /login\`) or re-bind the session ` +
            `to a healthy account. Launcher did NOT consume burst retries.`;
        } else if (accountBound) {
          exhaustionMessage =
            `Tmux launcher stopped after ${attempt} burst-load ${attempt === 1 ? "retry" : "retries"} ` +
            `on an account-bound session — auth-suspect (a revoked credential can exit before ` +
            `writing a transcript record; issue #1635). If this recurs, re-login the bound ` +
            `account; otherwise it may be transient load.`;
        } else {
          exhaustionMessage = `Tmux launcher gave up after ${attempt} burst-load ${attempt === 1 ? "retry" : "retries"} — likely sustained rate-limiting.`;
        }
        logger.warn(
          `[tmux-remote]: retry budget exhausted (${attempt}/${effectiveRetryBudget} burst-load retries; authLatched=${authLatched} accountBound=${accountBound}); session exiting without successful start`
        );
        try {
          session.client.sendSessionEvent({
            type: "message",
            message: exhaustionMessage,
          });
        } catch {
          // ignore — mirrors the catch-block sendSessionEvent guard
        }
      }

      // Non-burst-load exit OR retries exhausted — propagate to outer
      // finally via exitFuture.
      if (!exitReason) {
        exitReason = "exit";
      }
      resolveExitFuture();
    } while (retryThisAttempt);
  } catch (error) {
    // #1609: extract the message BEFORE logging — the logger serializes Error
    // objects to `{}` (the SL7 wrapper log showed `launcher error {"error":{}}`,
    // hiding which setup step threw and stalling the diagnosis).
    const message = error instanceof Error ? error.message : String(error);
    logger.debug(`[tmux-remote]: launcher error: ${message}`, { error });
    try {
      session.client.sendSessionEvent({
        type: "message",
        message: `Tmux launcher failed: ${message}`,
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
    // Issue #1653 clear-site (iii): onThinkingChange(false) also clears any
    // pending blocked-on-TUI-prompt banner on teardown (see sessionBase).
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

    session.removeSessionFoundCallback(handleSessionFound);

    unregisterActivePty(session.client.sessionId);

    if (tmuxHandle && !tmuxHandle.killed()) {
      tmuxHandle.kill();
    }

    await scanner.cleanup();

    resolveExitFuture();
  }

  return exitReason ?? "exit";
}
