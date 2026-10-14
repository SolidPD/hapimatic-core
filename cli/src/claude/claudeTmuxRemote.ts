// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `claudeTmuxRemote` — backup remote launcher that spawns `claude` inside a
 * dedicated tmux window and streams its terminal output over a FIFO to the
 * web client. Sibling of `claudePty.ts` (PTY-direct primary launcher).
 *
 * Activated via `HAPI_CLAUDE_LAUNCHER=tmux`. The dispatch lives in
 * `launcherDispatch.ts`. Issue #1310.
 *
 * Architecture:
 * - tmux window owned by a SEPARATE session (`hapimatic-remote`) — isolated
 *   from the local-mode persistence session (`hapimatic`) so orphan scans
 *   in either launcher cannot touch the other.
 * - Output stream: `tmux pipe-pane` writes pane output to a per-session FIFO
 *   at `/tmp/hapi-tmux-pipe-<hapiSessionId>` (matches the reaper detection
 *   pattern for the deferred sibling sub-issue). A Node `createReadStream`
 *   on the FIFO decodes bytes and pushes them to the launcher's
 *   `onTmuxOutput` callback.
 * - Input stream: `tmux send-keys -t <window> <text>` injects user messages
 *   (text + Enter) into the running `claude` process unchanged.
 * - Exit detection: polls `TmuxManager.isWindowAlive()` at 1Hz (the window
 *   is preserved via `remain-on-exit` so we can detect a "pane dead"
 *   transition without losing the window).
 *
 * Critical hazards & how this code addresses them:
 * - **Tmux drops bytes if the FIFO consumer is unreadable** (per `man tmux`):
 *   the FIFO reader is opened BEFORE `pipe-pane -O` so output begins
 *   flowing into a draining sink. Reader stays open for the launcher's
 *   entire lifetime (per the directive's "FIFO reader MUST be persistent"
 *   constraint from claude-i §8).
 * - **Cleanup stack** (push during setup, unwind in `finally` on success
 *   path or in the catch on error path): every async setup step that
 *   allocates an FD or external resource pushes a cleanup callback. Mirrors
 *   `claudePty.ts`'s `cleanupMcpConfig?.()` pattern but with multiple
 *   registered cleanups for FIFO + readStream + pipe-pane-off + kill-window.
 * - **R11 HARD FAIL on missing tmux**: if `tmux -V` cannot run, the
 *   launcher throws — no silent fallback to SDK (silent fallback would risk the
 *   ~100× billing surprise the paused 2026-06-15 per-token change would introduce
 *   if Anthropic reinstates it).
 * - **Env scrub via `buildLauncherEnv`**: same SDK_SIGNAL_ENV_VARS strip as
 *   the PTY launcher (R2). The shell prefix used to launch `claude` is
 *   built from the SCRUBBED env, so no signal var can leak through.
 */

import {
  mkdirSync,
  createReadStream,
  ReadStream,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { logger } from "@/ui/logger";
import { configuration } from "@/configuration";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { getProjectPath } from "./utils/path";
import { appendMcpConfigArg } from "./utils/mcpConfig";
import { buildSystemPrompt } from "./utils/systemPrompt";
import { getDefaultClaudeCodePath } from "./sdk/utils";
import { applyPreTrustShim } from "./utils/projectMcpConfig";
import {
  FORBIDDEN_CLAUDE_ARGS,
  buildLauncherEnv,
  buildTmuxEnvFileCommand,
  resolveRemoteSessionDisplayName,
} from "./launcherShared";
import { shellEscape, assertSpawnCommandLength } from "@/utils/shellEscape";
import { TmuxManager } from "@/tmux/TmuxManager";
import { remoteLauncherWindowTarget } from "@/tmux/windowOwnership";
import type { OwnedWindowTarget } from "@/tmux/windowOwnership";
import {
  TMUX_REMOTE_WINDOW_PREFIX,
  type CreateWindowResult,
} from "@/tmux/types";
import type { ClaudeRawOutputCallback } from "./launcherDispatch";

const EXIT_POLL_INTERVAL_MS = 1000;
const OUTPUT_BUFFER_HIGH_WATER = 1024 * 1024; // 1 MiB ring-buffer cap

/**
 * Resolve the delay (ms) between sending a user-message body and sending the
 * SEPARATE submit Enter. Overridable via HAPI_TMUX_SUBMIT_DELAY_MS for live
 * tuning without a rebuild — parity with HAPI_PTY_SUBMIT_DELAY_MS (#1599).
 * Defaults to 250ms. Exported for unit testing.
 */
export function resolveTmuxSubmitDelayMs(): number {
  const raw = process.env.HAPI_TMUX_SUBMIT_DELAY_MS;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 250;
}

/**
 * Delay (ms) between the user-message body send-keys and the submit-Enter
 * send-keys.
 *
 * Issue #1599 (the tmux twin of #1459): claude's Ink TUI absorbs an Enter that
 * arrives fused to the preceding pasted text (`tmux send-keys "<body>" Enter`
 * is a single pane write), treating it as paste content rather than a submit.
 * The Enter must therefore land as a SEPARATE `tmux send-keys Enter` after the
 * paste-completion debounce has flushed. claude's paste-completion timeout was
 * ~100ms in the v1.0.x source; 250ms is a safety margin (the same value the PTY
 * launcher proved out for #1459).
 */
const TMUX_SUBMIT_DELAY_MS = resolveTmuxSubmitDelayMs();

export interface TmuxSubmitDelivery {
  /** Send the body now, then schedule the SEPARATE submit Enter. */
  deliver: (message: string) => void;
  /** Cancel all pending submit timers (call on teardown/abort/exit). */
  clearPending: () => void;
}

/**
 * Sequence a user message as TWO separate tmux send-keys writes:
 *   1. the body (sent literally via `-l`, no Enter) — written now;
 *   2. the submit Enter (a real `Enter` keypress) — sent after `submitDelayMs`,
 *      in its OWN send-keys call, so claude's Ink paste debounce has flushed and
 *      the Enter registers as a submit rather than being absorbed into the paste.
 *
 * Mirrors `createPtySubmitDelivery` (claudePtyLauncher.ts) adapted for the
 * send-keys channel — the tmux submit signal is the `Enter` KEY (not a `\r`
 * byte), and no bracketed-paste wrapping is needed (the non-bracketed body
 * already reaches claude's input box; only the fused Enter was the bug — #1599).
 *
 * `deliver` is synchronous (fire-and-forget sends) so the timing logic is
 * fake-timer testable exactly like the PTY helper; the submitDelayMs gap
 * guarantees body-before-Enter ordering despite send-keys being async (tmux
 * command latency is far below the debounce).
 *
 * Exported for unit testing.
 */
export function createTmuxSubmitDelivery(opts: {
  /** Send the message body (fire-and-forget): `tmux send-keys -l <body>`. */
  sendBody: (message: string) => void;
  /** Send a real Enter keypress (fire-and-forget): `tmux send-keys Enter`. */
  sendEnter: () => void;
  isAlive: () => boolean;
  submitDelayMs: number;
  /**
   * Invoked when a body was sent but its submit Enter was abandoned — either
   * because the window died before the debounce fired (isAlive() false at
   * fire-time) or because clearPending cancelled it on teardown. Surfaces the
   * dropped submit instead of swallowing it silently (the #1488-Gap3 concern,
   * ported for tmux — #1599).
   */
  onSubmitDropped?: (message: string) => void;
}): TmuxSubmitDelivery {
  // Map timer → the body it would submit, so a drop can report WHAT was
  // abandoned. A submit that fires normally deletes its entry first, so only
  // bodies caught mid-window by teardown surface a signal.
  const pendingSubmits = new Map<ReturnType<typeof setTimeout>, string>();
  return {
    deliver: (message: string) => {
      opts.sendBody(message);
      const timer = setTimeout(() => {
        pendingSubmits.delete(timer);
        if (!opts.isAlive()) {
          opts.onSubmitDropped?.(message);
          return;
        }
        opts.sendEnter();
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
  };
}

export interface ReadinessGate {
  /** Call from the queue's setOnMessage handler (item is already enqueued). */
  onMessage: () => void;
  /** Call when the TUI signals ready (handleSessionFound / SessionStart). */
  markReady: () => void;
}

/**
 * #1701: Hold queued messages until Claude's Ink TUI is interactive, then flush
 * them exactly once. Before `markReady()`, `onMessage()` is a no-op — the item
 * stays in the queue (retrievable via `drainPending`) instead of being typed
 * into a not-yet-ready pane and lost. On `markReady()` — and on every
 * `onMessage()` thereafter — the gate drains all pending items and submits each,
 * in FIFO order, only while the pane `isAlive()`; a message that cannot be
 * delivered (pane dead) is surfaced via `onDropped` rather than silently lost.
 * `markReady()` is idempotent (only the first call transitions to ready).
 *
 * Pure + closure-based (mirrors `createTmuxSubmitDelivery`) so it unit-tests in
 * isolation and is reusable by the PTY launcher. The caller wires `drainPending`
 * to `session.queue.drainAll()` (which also catches items pushed before the
 * setOnMessage listener attached) and `submit` to the handle's `submitMessage`
 * (the #1599 split-Enter primitive).
 *
 * Exported for unit testing.
 */
export function createReadinessGate(opts: {
  submit: (message: string) => void;
  isAlive: () => boolean;
  drainPending: () => string[];
  onDropped?: (message: string) => void;
}): ReadinessGate {
  let ready = false;
  const flush = () => {
    for (const message of opts.drainPending()) {
      if (opts.isAlive()) {
        opts.submit(message);
      } else {
        opts.onDropped?.(message);
      }
    }
  };
  return {
    onMessage: () => {
      if (ready) {
        flush();
      }
      // else: held — the item stays in the queue and is flushed on markReady().
    },
    markReady: () => {
      if (ready) {
        return;
      }
      ready = true;
      flush();
    },
  };
}

export interface ClaudeTmuxRemoteOptions {
  /** Working directory for `claude` (the project being worked on). */
  path: string;
  /** Resume target — `claude` session ID, or null for a fresh session. */
  sessionId: string | null;
  /** Abort signal — when triggered, the tmux window is killed. */
  abort: AbortSignal;
  /**
   * Hapimatic session ID — used to name the FIFO path and tmux window.
   * Must be unique per concurrent launcher invocation on the host.
   */
  hapiSessionId: string;
  claudeEnvVars?: Record<string, string>;
  claudeArgs?: string[];
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  hookSettingsPath: string;
  initialCols?: number;
  initialRows?: number;
  /** Per-byte callback for terminal output from the tmux pane. */
  onTmuxOutput?: ClaudeRawOutputCallback;
  /**
   * Called once when the tmux window's pane process exits. R14 (#1429)
   * threads `elapsedMs` (milliseconds between spawn and observed exit) so
   * the wrapper can apply its burst-load classifier without the spawn
   * primitive needing to know the policy.
   */
  onExit: (
    code: number | null,
    signal: string | null,
    elapsedMs?: number
  ) => void;
  /**
   * Per-attempt suffix appended to both the tmux window name and the FIFO
   * path. Set by the launcher wrapper on retry attempts (R14 #1429); the
   * first attempt MUST omit this so the default behavior is byte-identical
   * to the pre-R14 codepath.
   */
  attemptId?: string;
}

export interface ClaudeTmuxRemoteHandle {
  /**
   * Raw passthrough write to the pane (`tmux send-keys ... Enter`). Used for
   * ANSI capability-query replies and web-terminal keystroke passthrough —
   * NOT for submitting user messages (use `submitMessage` for that). #1599.
   */
  write: (data: string) => void;
  /**
   * Submit a user message: send the body, then a SEPARATE delayed Enter so
   * claude's Ink TUI registers a submit rather than absorbing a fused Enter
   * (#1599 — the tmux port of the #1459 split-Enter fix). Distinct from
   * `write`, the raw passthrough that must NOT auto-submit.
   */
  submitMessage: (message: string) => void;
  /**
   * Send the TUI's native turn interrupt — a single Escape keypress — without
   * touching the window or process. Fire-and-forget (#1599 discipline: errors
   * are logged, never thrown); dropped after exit. Used by the launcher's
   * abort→interrupt re-map (#1654).
   */
  interruptTurn: () => void;
  /** Resize the tmux window to the given dimensions. */
  resize: (cols: number, rows: number) => void;
  /** Kill the tmux window (and the `claude` process inside it). */
  kill: () => void;
  /** True once the pane process has exited. */
  killed: () => boolean;
  /**
   * Read the pane's current foreground command (`#{pane_current_command}`)
   * via the race-free window index captured at spawn (#1741). Returns null
   * after exit, or on any tmux fault. Used by the launcher's readiness
   * watchdog to detect a lost `exec claude` (pane still a login shell).
   */
  paneCurrentCommand: () => Promise<string | null>;
}

// Consolidated single-quote escaper (issue #3748, Sub H). Local alias of the
// shared @/utils/shellEscape keeps the two call sites in
// buildTmuxRemoteSpawnCommand unchanged. This launcher ships its ENTIRE spawn
// command through a single `tmux send-keys` (no `-l`, no temp-script), so it is
// also the one that enforces the send-keys length ceiling below.
const shellQuote = shellEscape;

/**
 * Build the tmux send-keys command and the matching 0600 env-file body for a
 * remote-launcher spawn. Pure + exported for unit testing (issue #1505).
 *
 * The returned `fullCommand` MUST NOT contain any launcher env VALUE — the
 * secret-bearing CLAUDE_CODE_OAUTH_TOKEN (injected under multi-account binding,
 * #1446) included. The env is delivered out-of-band: the caller writes
 * `envFileBody` to a 0600 temp file at `envFilePath`, and the launched shell
 * sources then `rm`s that file before `exec`-ing claude. The token therefore
 * never lands on the launched shell's command line (`ps auxww` /
 * `/proc/<pid>/cmdline`) nor in the tmux pane scrollback — parity with the
 * pty/sdk launchers' `Bun.spawn({ env })` channel (see claudePty.ts).
 */
export function buildTmuxRemoteSpawnCommand(opts: {
  launcherEnv: Record<string, string>;
  claudePath: string;
  cwd: string;
  args: string[];
  envFilePath: string;
}): { fullCommand: string; envFileBody: string } {
  // Delegate the security-critical env-file skeleton (body + cd/source/rm) to
  // the shared helper so it cannot drift from the local/daemon launcher
  // (claudeTmuxLauncher.ts). This launcher's spawn command `exec`s the resolved
  // claudePath so the pane pid tracks claude directly.
  const spawnCommand = `exec ${shellQuote(opts.claudePath)} ${opts.args
    .map(shellQuote)
    .join(" ")}`;
  const result = buildTmuxEnvFileCommand({
    launcherEnv: opts.launcherEnv,
    cwd: opts.cwd,
    spawnCommand,
    envFilePath: opts.envFilePath,
    // #4884 (PM ruling): this pane execs a subscription session's claude (the
    // tmux launcher refuses key sessions, #4568), so it also clears an inherited
    // ANTHROPIC_BASE_URL.
    subscriptionClaudePane: true,
  });
  // #3748 (Sub H): this launcher hands `fullCommand` to `tmux send-keys` as a
  // single literal (no `-l`, no temp-script mitigation), so an over-long command
  // is rejected by tmux ("command too long") and the session silently fails to
  // start. Fail loudly BEFORE spawn when Tier-0 injection pushes it past the
  // ceiling; the HAPI_CAPABILITY_TIER0=0 kill-switch is the recovery path.
  assertSpawnCommandLength(result.fullCommand);
  return result;
}

/**
 * Best-effort mkfifo using the system `mkfifo` binary. Errors are surfaced
 * with the original stderr text so callers can diagnose permission/path
 * issues quickly. Returns a promise that resolves when the FIFO exists.
 */
function makeFifo(fifoPath: string, mode: string = "600"): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("mkfifo", ["-m", mode, fifoPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve();
      else
        reject(new Error(`mkfifo exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Create the launcher's tmux window, deterministically replacing a stale
 * pre-existing window of the same name if one survives from a prior claude
 * (#1581 — the launcher-layer twin of #1572).
 *
 * The tmux launcher runs claude in the `hapimatic-remote` session in a window
 * named deterministically (`hapi-remote-<sessionId>`, no suffix on attempt 0)
 * with `remain-on-exit` ON — so the window outlives the old claude's death.
 * On an account-switch / token-refresh respawn, `switchAccount → archiveSession
 * → killSession` is fire-and-forget (`void killThisHappy()`), and the fast
 * (`awaitWebhook:false`) respawn reaches `createWindow` before the old worker's
 * cleanup `killWindow` has run. `createWindow`'s pre-flight then sees the
 * surviving window and refuses (`created:false`), which used to throw
 * `Failed to create tmux window` with no retry (the burst-load retry loop only
 * retries process EXITS, not setup throws) — leaving the session `active:false`.
 *
 * This helper deterministically replaces the stale window (mirrors #1572's
 * "replace WHATEVER occupies the pane" fix for the daemon-persistence layer):
 * kill the surviving window, confirm it is gone, then recreate. Killing is safe
 * even in the rare race where the old claude is still alive in the window — a
 * switch respawn intends to REPLACE the old account's claude. The hard-fail
 * throw is PRESERVED (Fallback Preservation Rule): a genuine, unrecoverable
 * creation failure still throws.
 */
export async function createOrReplaceRemoteWindow(
  tmux: TmuxManager,
  windowName: string,
  cwd: string
): Promise<CreateWindowResult> {
  // #1585: the kill-stale-then-recreate logic now lives in
  // TmuxManager.createOrReplaceWindow (the single shared primitive behind all
  // three window-creation sites). This thin wrapper delegates so the remote
  // launcher's call site AND its real-tmux regression test
  // (claudeTmuxRemote.spawn.test.ts) remain unchanged.
  // #1609: the CreateWindowResult is returned (no longer discarded) so the
  // caller can use the race-free window index for all post-create operations,
  // bypassing the name-based list-windows path that is stale on tmux 3.4+.
  return tmux.createOrReplaceWindow({ name: windowName, cwd });
}

/**
 * Pick the post-create tmux target for the per-session window (#1609).
 *
 * Prefers the index captured race-free from `new-window -P -F` (bypasses the
 * list-windows name-lookup path that returns stale data on tmux 3.4+ — the
 * #1315 root cause recurring on SL7/WSL2); falls back to the window NAME when
 * the index capture failed (Fallback Preservation Rule).
 *
 * Uses `??` deliberately — index 0 is a VALID window index and must be
 * preferred; `||` would discard it. Pure + exported for unit testing.
 */
export function resolveWindowTargetPreference(
  index: number | null,
  windowName: string
): string | number {
  return index ?? windowName;
}

export async function claudeTmuxRemote(
  opts: ClaudeTmuxRemoteOptions
): Promise<ClaudeTmuxRemoteHandle> {
  const tmux = new TmuxManager({
    sessionName: configuration.tmuxRemoteSessionName,
    socketName: configuration.tmuxRemoteSessionName,
    defaultCwd: opts.path,
  });

  // R11 — HARD FAIL when tmux is not on PATH. Architect Q8: no silent
  // fallback to SDK. The PTY launcher is the silent-fallback target if the
  // operator wants one (HAPI_CLAUDE_LAUNCHER=pty); the tmux launcher means
  // tmux specifically.
  if (!(await tmux.isTmuxAvailable())) {
    throw new Error(
      "HAPI_CLAUDE_LAUNCHER=tmux but tmux is not on PATH. " +
        "Install tmux (apt install tmux / brew install tmux) or unset " +
        "HAPI_CLAUDE_LAUNCHER to fall back to the SDK launcher."
    );
  }

  // Forbidden-args check mirrors `claudePty.ts`. Flags like `-p` /
  // `--print` cause `claude` to set CLAUDE_CODE_ENTRYPOINT=sdk-cli
  // internally, bypassing our env-scrub.
  if (opts.claudeArgs) {
    const violations = opts.claudeArgs.filter(a =>
      FORBIDDEN_CLAUDE_ARGS.has(a)
    );
    if (violations.length > 0) {
      throw new Error(
        `claudeTmuxRemote refuses SDK-classifying flags: ${violations.join(", ")}. ` +
          "These flags set CLAUDE_CODE_ENTRYPOINT=sdk-cli (the Agent SDK entrypoint; its 2026-06-15 per-token billing change is currently paused)."
      );
    }
  }

  const projectDir = getProjectPath(opts.path);
  mkdirSync(projectDir, { recursive: true });

  // R8/R9/R10 — pre-trust shim. Surgical alternative to
  // --dangerously-skip-permissions, scoped to the cwd. Fast path returns in
  // <2ms for warm cwds.
  await applyPreTrustShim(opts.path);

  // Build claude args — mirrors the construction logic in `claudePty.ts`
  // so the user-visible behavior is identical regardless of launcher.
  const args: string[] = [];
  const hasContinueFlag = opts.claudeArgs?.includes("--continue");
  const hasResumeFlag = opts.claudeArgs?.includes("--resume");
  const hasUserSessionControl = Boolean(hasContinueFlag || hasResumeFlag);
  let startFrom = opts.sessionId;
  if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
    startFrom = null;
  }
  if (startFrom && !hasUserSessionControl) {
    args.push("--resume", startFrom);
  }
  // Issue #1633: a --safe-mode spawn suppresses Hapimatic's own injections.
  // Empirically (v2.1.170) --safe-mode disables CLI-arg --mcp-config servers
  // and --settings hooks anyway, while --append-system-prompt SURVIVES — so
  // without suppression every safe-mode session starts with a system prompt
  // instructing calls to hapi MCP tools that do not exist. Omitting all four
  // injections keeps the preamble minimal (the feature's purpose). Expected
  // degradations: no change_title/image_fetch, no hook-driven thinking-state.
  const safeMode = opts.claudeArgs?.includes("--safe-mode") ?? false;
  if (!safeMode) {
    args.push("--append-system-prompt", buildSystemPrompt(opts.path));
  }
  const cleanupMcpConfig = safeMode
    ? null
    : appendMcpConfigArg(args, opts.mcpServers, {
        baseDir: projectDir,
      });
  if (!safeMode && opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowedTools", opts.allowedTools.join(","));
  }
  if (opts.claudeArgs) {
    args.push(...opts.claudeArgs);
  }
  if (!safeMode) {
    args.push("--settings", opts.hookSettingsPath);
  }

  // R2 — env build via the scrubbed buildLauncherEnv. The shell-command
  // prefix below is built from this env, so SDK_SIGNAL_ENV_VARS cannot
  // leak through. Local-mode `claudeTmuxLauncher.ts` Task 11 fix mirrors
  // this pattern.
  const launcherEnv = buildLauncherEnv(opts.claudeEnvVars);

  // R14 (#1429): per-attempt suffix varies the window name, FIFO path, AND the
  // env-file path so a retry after a burst-load exit doesn't collide with the
  // prior attempt's unreaped tmux window or stale temp files. First attempt
  // omits the suffix (byte-identical to pre-R14 behavior for backward compat).
  const attemptSuffix = opts.attemptId ? `-${opts.attemptId}` : "";
  const windowName = `${TMUX_REMOTE_WINDOW_PREFIX}${opts.hapiSessionId}${attemptSuffix}`;
  const fifoPath = `/tmp/hapi-tmux-pipe-${opts.hapiSessionId}${attemptSuffix}`;

  // #1609: dual-type window target for all post-create tmux operations.
  // Starts as the window NAME; reassigned to the index captured race-free
  // from `new-window -P -F` once the window exists (setup step 4). Index
  // targeting bypasses the name-based resolveWindowTarget() → list-windows
  // path, which returns stale data on tmux 3.4+ (the #1315 root cause —
  // recurring here as the SL7/WSL2 spawn failure). Closures created below
  // (submit delivery, killWindowInternal, exit poll) read this binding at
  // CALL time, so they upgrade to index targeting automatically after setup.
  // #4218: an OwnedWindowTarget minted by remoteLauncherWindowTarget — this
  // launcher only ever touches the `hapimatic-remote` window it created
  // (`@hapi_identity` there is a display name, never a K1 ownership tag).
  let windowTarget: OwnedWindowTarget = remoteLauncherWindowTarget(
    tmux,
    windowName
  );

  // #1652: refresh the window's `@hapi_identity` user option from the session
  // store's human name (`PersistedSession.tmuxWindow`), falling back to the hapi
  // tag before the session is named. Reads `windowTarget` at CALL time so it
  // upgrades to index targeting after setup step 4 (same convention as the
  // submit/exit closures above). Best-effort: `setWindowIdentity` returns false
  // (never throws) and this closure swallows any resolution error — a failed
  // identity refresh MUST NOT affect the spawn or a message submit (R6).
  const refreshWindowIdentity = async (): Promise<void> => {
    try {
      const displayName = await resolveRemoteSessionDisplayName(
        opts.hapiSessionId
      );
      await tmux.setWindowIdentity(
        windowTarget,
        displayName ?? opts.hapiSessionId
      );
    } catch (err) {
      logger.warn("[claudeTmuxRemote] refreshWindowIdentity error", { err });
    }
  };

  // Issue #1505 — out-of-band env channel. The launcher env (which includes
  // CLAUDE_CODE_OAUTH_TOKEN under multi-account binding, #1446) MUST NOT be
  // interpolated into the `tmux send-keys` command string: that would leak the
  // token via `ps auxww` / `/proc/<pid>/cmdline` of the launched shell AND into
  // the tmux pane scrollback. Instead we write the env to a 0600 temp file that
  // the launched shell sources then unlinks before `exec`-ing claude — parity
  // with the pty/sdk launchers' `Bun.spawn({ env })` channel (see claudePty.ts).
  const envFilePath = `/tmp/hapi-tmux-env-${opts.hapiSessionId}${attemptSuffix}`;
  const claudePath = getDefaultClaudeCodePath();
  const { fullCommand, envFileBody } = buildTmuxRemoteSpawnCommand({
    launcherEnv,
    claudePath,
    cwd: opts.path,
    args,
    envFilePath,
  });

  logger.debug(
    `[claudeTmuxRemote] window=${windowName} fifo=${fifoPath} argv=${JSON.stringify(args)}`
  );

  // Cleanup stack — every async setup step that allocates a resource
  // pushes a cleanup callback. Stack is unwound in LIFO order whether
  // setup succeeds (via the handle.kill / onExit paths) or fails (via the
  // try/catch below).
  const cleanups: Array<() => void | Promise<void>> = [];
  let cleanupRan = false;
  const runCleanup = async (reason: string) => {
    if (cleanupRan) return;
    cleanupRan = true;
    logger.debug(`[claudeTmuxRemote] cleanup begin (${reason})`);
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (!fn) continue;
      try {
        await fn();
      } catch (err) {
        logger.debug("[claudeTmuxRemote] cleanup step failed", { err });
      }
    }
    logger.debug(`[claudeTmuxRemote] cleanup end (${reason})`);
  };

  let exited = false;
  let exitPollHandle: NodeJS.Timeout | null = null;
  let readStream: ReadStream | null = null;
  // Bounded ring-buffer accounting (per perf review) — we drain inline to
  // onTmuxOutput, but if the consumer cannot keep up we drop bytes and
  // emit an ANSI screen-clear marker so the renderer doesn't show stale
  // mid-frame state.
  let bufferedBytes = 0;
  const decoder = new TextDecoder();

  // #1599: split-Enter submit delivery for user messages. The body is sent
  // literally (no Enter); a SEPARATE Enter keypress follows after the debounce
  // so claude's Ink TUI registers a submit. isAlive (=!exited) + clearPending
  // (pushed onto the cleanup stack below) guarantee a delayed Enter is never
  // written to a dead window (the #1488-Gap3 guard, ported for tmux).
  const submitDelivery = createTmuxSubmitDelivery({
    sendBody: message => {
      void tmux
        .sendKeys({
          target: windowTarget,
          keys: message,
          enter: false,
          literal: true,
        })
        .catch(err => {
          logger.warn("[claudeTmuxRemote] sendKeys (submit body) error", {
            err,
          });
        });
    },
    sendEnter: () => {
      void tmux
        .sendKeys({ target: windowTarget, keys: "Enter", enter: false })
        .catch(err => {
          logger.warn("[claudeTmuxRemote] sendKeys (submit Enter) error", {
            err,
          });
        });
    },
    isAlive: () => !exited,
    submitDelayMs: TMUX_SUBMIT_DELAY_MS,
    onSubmitDropped: message => {
      logger.warn(
        "[claudeTmuxRemote] submit Enter dropped — window torn down during debounce; body left unsubmitted",
        { bytes: message.length }
      );
    },
  });
  cleanups.push(() => submitDelivery.clearPending());

  // Register the abort listener BEFORE setup — if setup throws, the
  // listener is detached in the catch.
  let abortListenerDetached = false;
  const abortListener = () => {
    if (exited) return;
    logger.debug("[claudeTmuxRemote] abort signal received");
    void killWindowInternal();
  };
  const detachAbortListener = () => {
    if (abortListenerDetached) return;
    abortListenerDetached = true;
    try {
      opts.abort.removeEventListener("abort", abortListener);
    } catch (err) {
      logger.debug("[claudeTmuxRemote] removeEventListener error", { err });
    }
  };
  opts.abort.addEventListener("abort", abortListener);
  cleanups.push(detachAbortListener);

  const killWindowInternal = async () => {
    try {
      await tmux.killWindow(windowTarget);
    } catch (err) {
      logger.debug("[claudeTmuxRemote] killWindow error", { err });
    }
  };

  // Setup begins — every successful step pushes its own cleanup.
  try {
    // 0) Write the launcher env to a 0600 temp file (issue #1505). The launched
    //    shell sources + unlinks it before exec'ing claude, so no env value
    //    (esp. CLAUDE_CODE_OAUTH_TOKEN) appears on any command line or in the
    //    tmux pane scrollback. `flag: "wx"` (O_EXCL) refuses to follow a
    //    pre-existing symlink — a symlink-redirect attack fails closed. A stale
    //    file from a crashed prior run is unlinked first, mirroring the FIFO
    //    stale-cleanup in step 1 below.
    try {
      const s = await stat(envFilePath);
      if (s.isFile()) {
        unlinkSync(envFilePath);
        logger.debug(
          `[claudeTmuxRemote] removed stale env file at ${envFilePath} from prior run`
        );
      }
    } catch {
      // ENOENT is the happy path here.
    }
    writeFileSync(envFilePath, envFileBody, { mode: 0o600, flag: "wx" });
    cleanups.push(() => {
      try {
        unlinkSync(envFilePath);
      } catch {
        // Already removed (shell rm -f'd it, or never created) — ignore.
      }
    });

    // 1) Pre-existing FIFO leftover (from a crashed prior run) — unlink so
    //    mkfifo doesn't EEXIST. Failures here are non-fatal; if the path
    //    is a regular file, mkfifo will error and we'll bubble that up.
    try {
      const s = await stat(fifoPath);
      if (s.isFIFO()) {
        unlinkSync(fifoPath);
        logger.debug(
          `[claudeTmuxRemote] removed stale FIFO at ${fifoPath} from prior run`
        );
      }
    } catch {
      // ENOENT is the happy path here.
    }

    // 2) Create the FIFO with 0o600.
    await makeFifo(fifoPath, "600");
    cleanups.push(() => {
      try {
        unlinkSync(fifoPath);
      } catch {
        // Already removed — ignore.
      }
    });

    // 3) Open the FIFO reader BEFORE tmux pipe-pane starts writing (per
    //    the directive's "FIFO reader MUST be persistent" constraint). We
    //    open with the `O_RDWR` semantics that createReadStream gets from
    //    `flags: "r+"` so the reader doesn't immediately EOF if no writer
    //    has connected yet.
    readStream = createReadStream(fifoPath, {
      flags: "r+",
      highWaterMark: 65536,
    });
    cleanups.push(() => {
      try {
        readStream?.close();
      } catch (err) {
        logger.debug("[claudeTmuxRemote] readStream.close error", { err });
      }
    });

    const onTmuxOutput = opts.onTmuxOutput;
    readStream.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bufferedBytes += buf.length;
      if (bufferedBytes > OUTPUT_BUFFER_HIGH_WATER) {
        // Ring-buffer overflow — drop accumulated bytes and emit a
        // screen-clear so the renderer doesn't show a mid-frame state.
        logger.warn(
          `[claudeTmuxRemote] output buffer overflow (${bufferedBytes} bytes); dropping with screen-clear marker`
        );
        bufferedBytes = 0;
        onTmuxOutput?.("\x1b[2J\x1b[H");
        return;
      }
      if (!onTmuxOutput) {
        // R20 (#1429): no consumer — release the bytes immediately so the
        // counter doesn't grow with every chunk that lands before the
        // launcher registers its onTmuxOutput callback.
        bufferedBytes = Math.max(0, bufferedBytes - buf.length);
        return;
      }
      const text = decoder.decode(buf, { stream: true });
      // R20 (#1429): release the bytes UNCONDITIONALLY — a UTF-8 partial
      // multi-byte sequence at a chunk boundary causes `decoder.decode`
      // to return "" (empty), which previously skipped the decrement and
      // drifted `bufferedBytes` permanently high. Symmetric add/subtract
      // closes the leak.
      bufferedBytes = Math.max(0, bufferedBytes - buf.length);
      if (text) {
        onTmuxOutput(text);
      }
    });
    readStream.on("error", err => {
      logger.warn("[claudeTmuxRemote] readStream error", { err });
    });

    // 4) Ensure session + create window. The session is detached and
    //    persists across windows (exit-empty off, set by ensureSession).
    await tmux.ensureSession();
    // #1652: apply the remote session's identity DISPLAY formats once
    // (pane-border + status-line rendering `#{@hapi_identity}`). Scoped to THIS
    // instance's isolated `-L` socket, so it never affects wrapper sockets or the
    // host's tmux. Fire-and-forget — idempotent and best-effort; a tmux failure
    // here must not fail the spawn (R6).
    void tmux.applyRemoteIdentityDisplayFormats().catch(err => {
      logger.warn(
        "[claudeTmuxRemote] applyRemoteIdentityDisplayFormats error",
        { err }
      );
    });
    // #1581: create the window, replacing a stale same-named window if one
    // survives from a prior claude's remain-on-exit window (account-switch /
    // token-refresh respawn races the fire-and-forget killSession teardown).
    // Throws on a genuine, unrecoverable creation failure (fallback preserved).
    // #1609: capture the race-free window index and upgrade windowTarget so
    // every subsequent operation bypasses the tmux-3.4+-stale name lookup.
    const createResult = await createOrReplaceRemoteWindow(
      tmux,
      windowName,
      opts.path
    );
    windowTarget = remoteLauncherWindowTarget(
      tmux,
      resolveWindowTargetPreference(createResult.index, windowName)
    );
    if (createResult.index === null) {
      logger.warn(
        `[claudeTmuxRemote] window index unavailable from new-window -P -F; ` +
          `falling back to name-based targeting for ${windowName} ` +
          `(lookups may be stale on tmux 3.4+ — #1609)`
      );
    }
    cleanups.push(async () => {
      try {
        await tmux.killWindow(windowTarget);
      } catch (err) {
        logger.debug("[claudeTmuxRemote] cleanup killWindow error", { err });
      }
    });

    // #1652: set the window's initial `@hapi_identity` now that windowTarget
    // holds the captured index. Resolves to the human name if the session is
    // already named (resume/respawn), else the hapi tag — the submitMessage
    // re-set below upgrades it to the human name after the first message.
    void refreshWindowIdentity();

    // 5) Initial resize if dimensions were requested. tmux defaults to
    //    the session's client-attach dimensions otherwise, which can be
    //    surprising for headless launchers.
    if (opts.initialCols && opts.initialRows) {
      await tmux.resizeWindow(windowTarget, opts.initialCols, opts.initialRows);
    }

    // 6) Start pipe-pane BEFORE send-keys so we capture the spawned
    //    claude's startup output. Critical per `man tmux`: bytes between
    //    a pipe-close and a subsequent pipe-open are LOST.
    const pipeOk = await tmux.pipePaneToFile(windowTarget, fifoPath, {
      enabled: true,
    });
    if (!pipeOk) {
      throw new Error(`Failed to start pipe-pane for window ${windowName}`);
    }
    cleanups.push(async () => {
      try {
        await tmux.pipePaneToFile(windowTarget, fifoPath, { enabled: false });
      } catch (err) {
        logger.debug("[claudeTmuxRemote] cleanup pipePaneToFile-off error", {
          err,
        });
      }
    });

    // 7) Send-keys the full claude command + Enter. The `exec` prefix in
    //    fullCommand replaces the shell with the claude process so the
    //    pane's pid (used by isWindowAlive) tracks claude directly, not
    //    the parent shell.
    const sentOk = await tmux.sendKeys({
      target: windowTarget,
      keys: fullCommand,
      enter: true,
    });
    if (!sentOk) {
      throw new Error(`Failed to send claude command to ${windowName}`);
    }

    // 8) MCP-config cleanup runs when the launcher tears down. Pushed
    //    LAST so it runs FIRST in LIFO order — same convention as
    //    `claudePty.ts:onExit cleanupMcpConfig?.()`.
    if (cleanupMcpConfig) {
      cleanups.push(() => cleanupMcpConfig());
    }
  } catch (err) {
    // Setup failed — unwind cleanup stack and rethrow. The abort
    // listener is in the stack already.
    await runCleanup("setup-error");
    throw err;
  }

  // R14 (#1429): capture spawn timestamp just before exit-poll setup so
  // the elapsedMs we report to onExit is a faithful measurement of "time
  // from window-spawn-success to window-dead." The launcher wrapper uses
  // this to classify burst-load exits (fast, non-clean exit within 5s).
  const spawnTimestamp = Date.now();

  // Exit detection — poll isWindowAlive. The window is preserved via
  // remain-on-exit (ensureSession sets this), so a "pane dead" transition
  // doesn't destroy the window. We detect it via pane_pid going away.
  exitPollHandle = setInterval(async () => {
    if (exited) return;
    try {
      const alive = await tmux.isWindowAlive(windowTarget);
      if (!alive) {
        exited = true;
        if (exitPollHandle) {
          clearInterval(exitPollHandle);
          exitPollHandle = null;
        }
        logger.debug(
          `[claudeTmuxRemote] window ${windowName} no longer alive; firing onExit`
        );
        await runCleanup("window-exit");
        // tmux doesn't expose the exited process's signal/code via
        // display-message in a portable way; report null/null so the
        // launcher signals "exited without a clean code". R14 (#1429):
        // pass elapsedMs so the wrapper can apply its burst-load
        // classifier without coupling spawn primitive to retry policy.
        const elapsedMs = Date.now() - spawnTimestamp;
        try {
          opts.onExit(null, null, elapsedMs);
        } catch (err) {
          logger.warn("[claudeTmuxRemote] onExit handler threw", { err });
        }
      }
    } catch (err) {
      logger.debug("[claudeTmuxRemote] isWindowAlive poll error", { err });
    }
  }, EXIT_POLL_INTERVAL_MS);
  cleanups.push(() => {
    if (exitPollHandle) {
      clearInterval(exitPollHandle);
      exitPollHandle = null;
    }
  });

  return {
    write: (data: string) => {
      if (exited) {
        logger.debug("[claudeTmuxRemote] write after exit; dropping bytes");
        return;
      }
      // #1651 check (e) / #1654: the raw passthrough carries protocol bytes
      // (ANSI capability replies, keystroke passthrough) — never user
      // messages (#1599: those go through submitMessage). No Enter is
      // appended: a stray Enter here would submit whatever text is sitting
      // un-submitted in the TUI input box.
      void tmux
        .sendKeys({ target: windowTarget, keys: data, enter: false })
        .catch(err => {
          logger.warn("[claudeTmuxRemote] sendKeys (write) error", { err });
        });
    },
    submitMessage: (message: string) => {
      if (exited) {
        logger.debug(
          "[claudeTmuxRemote] submitMessage after exit; dropping message"
        );
        return;
      }
      submitDelivery.deliver(message);
      // #1652: re-sync the window identity from the (possibly now-named) session
      // store on each submit, so the human `#NNNN <title>` appears once the
      // session has been named. Fire-and-forget — never blocks or fails a submit.
      void refreshWindowIdentity();
    },
    interruptTurn: () => {
      if (exited) {
        logger.debug(
          "[claudeTmuxRemote] interruptTurn after exit; dropping interrupt"
        );
        return;
      }
      // Named-key form, same mechanism as the split-submit Enter above —
      // keyboard-indistinguishable to claude's Ink TUI (#1654).
      void tmux
        .sendKeys({ target: windowTarget, keys: "Escape", enter: false })
        .catch(err => {
          logger.warn("[claudeTmuxRemote] sendKeys (interrupt Escape) error", {
            err,
          });
        });
    },
    resize: (cols: number, rows: number) => {
      if (exited) return;
      void tmux.resizeWindow(windowTarget, cols, rows).catch(err => {
        logger.warn("[claudeTmuxRemote] resizeWindow error", { err });
      });
    },
    kill: () => {
      if (exited) {
        // Defense-in-depth: detach abort listener even on no-op kill.
        // Mirrors claudePty.ts post-exit kill path.
        detachAbortListener();
        return;
      }
      void killWindowInternal();
      // Don't mark exited=true here — the poll loop will detect the
      // window's death and run cleanup + onExit in one path. Two-phase
      // exit prevents leaking cleanup across the kill/exit boundary.
    },
    killed: () => exited,
    paneCurrentCommand: async () => {
      // Issue #1741: read the pane's foreground command via the race-free
      // window index captured at setup (windowTarget upgrades to the index
      // after step 4). Returns null after exit so the launcher's deaf-launch
      // probe treats a torn-down attempt as "no signal", not a false deaf.
      if (exited) return null;
      return tmux.getPaneCurrentCommand(windowTarget);
    },
  };
}
