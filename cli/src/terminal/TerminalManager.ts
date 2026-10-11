// SPDX-License-Identifier: AGPL-3.0-only
import { logger } from "@/ui/logger";
import { SECRET_ENV_VARS } from "@/sandbox/secretEnvVars";
import { TerminalMirror } from "./TerminalMirror";
import type {
  TerminalErrorPayload,
  TerminalExitPayload,
  TerminalOutputPayload,
  TerminalReadyPayload,
  TerminalSession,
} from "./types";

type TerminalRuntime = TerminalSession & {
  proc: Bun.Subprocess;
  terminal: Bun.Terminal;
  idleTimer: ReturnType<typeof setTimeout> | null;
  // #4517: persistence. `mirror` exists only when `persistent`. During a
  // re-attach, `attaching` is true and live PTY output is queued into
  // `pendingLive` so the snapshot and the live stream never overlap or gap.
  persistent: boolean;
  mirror: TerminalMirror | null;
  attaching: boolean;
  pendingLive: string[];
};

/**
 * #4517 (R10): what is left of a persistent shell after it exits. Every later
 * open of the same id replays it (the final screen, then the exit) instead of
 * spawning a new shell, until a `fresh` open from "Start new shell".
 */
type ExitedTerminal = {
  code: number | null;
  signal: string | null;
  /** The final screen, serialized from the mirror as the shell exited. */
  snapshot: Promise<string>;
};

type TerminalManagerOptions = {
  sessionId: string;
  getSessionPath: () => string | null;
  onReady: (payload: TerminalReadyPayload) => void;
  onOutput: (payload: TerminalOutputPayload) => void;
  onExit: (payload: TerminalExitPayload) => void;
  onError: (payload: TerminalErrorPayload) => void;
  idleTimeoutMs?: number;
  maxTerminals?: number;
};

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_TERMINALS = 4;
// #1734 (OmniBox Phase 0a): derive from the canonical agent-secret set so the
// web terminal and the agent-spawn strip share ONE source of truth (no
// duplicated literals to drift). The web terminal ALSO strips ANTHROPIC_API_KEY
// — a billing-signal var the agent paths manage via SDK_SIGNAL_ENV_VARS, hence
// excluded from SECRET_ENV_VARS — added back here to preserve the pre-#1734
// web-terminal behavior exactly.
const SENSITIVE_ENV_KEYS = new Set<string>([
  ...SECRET_ENV_VARS,
  "ANTHROPIC_API_KEY",
]);

function resolveEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveShell(): string {
  if (process.env.SHELL) {
    return process.env.SHELL;
  }
  if (process.platform === "darwin") {
    return "/bin/zsh";
  }
  return "/bin/bash";
}

/**
 * Build the environment for the instance shell terminal's PTY.
 *
 * Exported for unit testing: the spawn path in `create()` needs `Bun.spawn`,
 * which is absent under the Node vitest runtime, so the env-building logic is
 * verified here in isolation.
 *
 * #2512: default `TERM`/`COLORTERM` when the daemon has none. The Hapimatic
 * daemon runs under systemd with no `TERM` (verified via `/proc/<pid>/environ`),
 * so without this the spawned bash never enables readline bracketed paste (DEC
 * private mode 2004): it never emits `ESC[?2004h`, which leaves multi-line
 * pastes auto-executing each embedded newline and any latched 2004 state
 * echoing literal `^[[200~` markers. Setting `TERM` makes bash negotiate 2004
 * end-to-end (emit `ESC[?2004h`, consume the paste guards, tear down with
 * `ESC[?2004l`, re-arm at each prompt — which also self-heals a stale latch).
 * Mirrors the Claude launcher's existing default at
 * `cli/src/claude/launcherShared.ts:140-141`. Only ADDS when absent (never
 * overrides an inherited value); the secret-stripping above is untouched.
 */
export function buildFilteredEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) {
      continue;
    }
    if (SENSITIVE_ENV_KEYS.has(key)) {
      continue;
    }
    env[key] = value;
  }
  if (!env.TERM) {
    env.TERM = "xterm-256color";
  }
  if (!env.COLORTERM) {
    env.COLORTERM = "truecolor";
  }
  return env;
}

export class TerminalManager {
  private readonly sessionId: string;
  private readonly getSessionPath: () => string | null;
  private readonly onReady: (payload: TerminalReadyPayload) => void;
  private readonly onOutput: (payload: TerminalOutputPayload) => void;
  private readonly onExit: (payload: TerminalExitPayload) => void;
  private readonly onError: (payload: TerminalErrorPayload) => void;
  private readonly idleTimeoutMs: number;
  private readonly maxTerminals: number;
  private readonly terminals: Map<string, TerminalRuntime> = new Map();
  private readonly exited: Map<string, ExitedTerminal> = new Map();
  private readonly filteredEnv: NodeJS.ProcessEnv;

  constructor(options: TerminalManagerOptions) {
    this.sessionId = options.sessionId;
    this.getSessionPath = options.getSessionPath;
    this.onReady = options.onReady;
    this.onOutput = options.onOutput;
    this.onExit = options.onExit;
    this.onError = options.onError;
    this.idleTimeoutMs =
      options.idleTimeoutMs ??
      resolveEnvNumber(
        "HAPI_TERMINAL_IDLE_TIMEOUT_MS",
        DEFAULT_IDLE_TIMEOUT_MS
      );
    this.maxTerminals =
      options.maxTerminals ??
      resolveEnvNumber("HAPI_TERMINAL_MAX_TERMINALS", DEFAULT_MAX_TERMINALS);
    this.filteredEnv = buildFilteredEnv();
  }

  create(
    terminalId: string,
    cols: number,
    rows: number,
    persistent = false,
    fresh = false
  ): void {
    if (process.platform === "win32") {
      this.emitError(terminalId, "Terminal is not supported on Windows.");
      return;
    }

    const existing = this.terminals.get(terminalId);
    if (existing) {
      // Re-attach: never spawn a new shell.
      existing.cols = cols;
      existing.rows = rows;
      existing.terminal.resize(cols, rows);
      if (existing.persistent && existing.mirror) {
        // Persistent: resize the mirror, then replay a snapshot + queued live
        // output in order (R3, R5). Runs asynchronously (the snapshot barrier
        // awaits xterm's write queue); errors surface via emitError.
        existing.mirror.resize(cols, rows);
        void this.attach(existing).catch(error => {
          logger.debug("[TERMINAL] Failed to attach persistent terminal", {
            error,
          });
          this.emitError(terminalId, "Failed to re-attach terminal.");
        });
      } else {
        // Legacy: emit ready exactly as before (no mirror, no replay).
        this.markActivity(existing);
        this.emitReady(existing);
      }
      return;
    }

    // #4517 (R10): a persistent shell that exited stays exited — the next
    // open shows its final screen and the exit, even if no client was attached
    // when it ended. Only "Start new shell" (`fresh`) spawns a new one.
    const exited = this.exited.get(terminalId);
    if (exited) {
      if (persistent && !fresh) {
        void this.replayExit(terminalId, exited);
        return;
      }
      this.exited.delete(terminalId);
    }

    if (this.terminals.size >= this.maxTerminals) {
      this.emitError(
        terminalId,
        `Too many terminals open (max ${this.maxTerminals}).`
      );
      return;
    }

    if (typeof Bun === "undefined" || typeof Bun.spawn !== "function") {
      this.emitError(terminalId, "Terminal is unavailable in this runtime.");
      return;
    }

    const sessionPath = this.getSessionPath() ?? process.cwd();
    const shell = resolveShell();
    const decoder = new TextDecoder();
    const mirror = persistent ? new TerminalMirror(cols, rows) : null;
    // #4517: the PTY `data` and process `onExit` callbacks act only while THIS
    // runtime is the one mapped to the id. With a stable id, a shell closed on
    // purpose (close, idle timeout) must not feed its late output or exit into
    // a newer shell. (The PTY `exit` callback below is not gated on this, but
    // it reports an error for legacy shells only; #4606.)
    let runtime: TerminalRuntime | null = null;
    const isCurrent = (): boolean =>
      runtime !== null && this.terminals.get(terminalId) === runtime;

    try {
      const proc = Bun.spawn([shell], {
        cwd: sessionPath,
        env: this.filteredEnv,
        terminal: {
          cols,
          rows,
          data: (terminal, data) => {
            const text = decoder.decode(data, { stream: true });
            if (!text || !runtime || !isCurrent()) {
              return;
            }
            // #4657: nothing may escape this callback. Bun routes a throw here
            // to `uncaughtException`, whose handler (runnerLifecycle.ts) runs
            // `cleanupAndExit(1)` — a terminal-feature error would end the
            // whole Claude session.
            try {
              // Feed the mirror first, every time (R3/R5 — the snapshot must
              // reflect every byte). A rejected write drops the mirror; the
              // chunk itself still routes below (#4657). Then route: during a
              // re-attach queue the chunk so it replays after the snapshot;
              // otherwise stream it live.
              if (runtime.mirror && !runtime.mirror.write(text)) {
                this.dropMirror(
                  runtime,
                  "write rejected (xterm write-buffer overflow)"
                );
              }
              if (runtime.attaching) {
                runtime.pendingLive.push(text);
              } else {
                this.onOutput({
                  sessionId: this.sessionId,
                  terminalId,
                  data: text,
                });
              }
              // markActivity() skips persistent shells (R7), so a quiet
              // `sleep 3600` in one survives.
              this.markActivity(runtime);
            } catch (error) {
              // `error` is its own argument: the logger serializes a
              // top-level Error to its stack, but a nested one to `{}`.
              logger.debug(
                "[TERMINAL] data callback error",
                { terminalId },
                error
              );
            }
          },
          exit: (terminal, exitCode) => {
            // Bun reports code 1 here on every shell exit, ahead of onExit. A
            // persistent shell's exit is reported by onExit alone (in order,
            // after any re-attach's screen): an error first would make the
            // hub proxy drop a remote re-attach as a refused create.
            if (exitCode === 1 && !persistent) {
              this.emitError(
                terminalId,
                "Terminal stream closed unexpectedly."
              );
            }
          },
        },
        onExit: (subprocess, exitCode) => {
          if (!runtime || !isCurrent()) {
            return;
          }
          const code = exitCode ?? null;
          const signal = subprocess.signalCode ?? null;
          let recorded = false;
          if (runtime.persistent && runtime.mirror) {
            // The record takes over the mirror, so cleanup() must not dispose
            // it before the final screen is serialized.
            const finalMirror = runtime.mirror;
            runtime.mirror = null;
            this.exited.set(terminalId, {
              code,
              signal,
              snapshot: finalMirror
                .snapshot()
                .catch(() => "")
                .finally(() => finalMirror.dispose()),
            });
            recorded = true;
          }
          // A re-attach in flight sends this exit itself, after its ready and
          // the final screen, so the exit cannot reach the client first.
          if (!(recorded && runtime.attaching)) {
            this.onExit({
              sessionId: this.sessionId,
              terminalId,
              code,
              signal,
            });
          }
          this.cleanup(terminalId);
        },
      });

      const terminal = proc.terminal;
      if (!terminal) {
        try {
          proc.kill();
        } catch (error) {
          logger.debug(
            "[TERMINAL] Failed to kill process after missing terminal",
            { error }
          );
        }
        mirror?.dispose();
        this.emitError(terminalId, "Failed to attach terminal.");
        return;
      }

      runtime = {
        terminalId,
        cols,
        rows,
        proc,
        terminal,
        idleTimer: null,
        persistent,
        mirror,
        attaching: false,
        pendingLive: [],
      };

      this.terminals.set(terminalId, runtime);
      this.markActivity(runtime);
      this.emitReady(runtime);
    } catch (error) {
      mirror?.dispose();
      logger.debug("[TERMINAL] Failed to spawn terminal", { error });
      this.emitError(terminalId, "Failed to spawn terminal.");
    }
  }

  /**
   * Replay a persistent terminal's state to a (re-)attaching client: a snapshot
   * of everything received before this call, then the live output that arrived
   * while the snapshot barrier was resolving — in order, with no loss or dup
   * for a single attach in flight (R3). Steps after the `await` run
   * synchronously, so no `data` callback can interleave between clearing
   * `attaching` and draining `pendingLive`. `attaching` and `pendingLive` belong
   * to the shell, not to one attach, so two overlapping attaches are not
   * guarded (a known limit of v1).
   */
  private async attach(runtime: TerminalRuntime): Promise<void> {
    const { terminalId } = runtime;
    if (!runtime.mirror) {
      this.emitReady(runtime);
      return;
    }
    runtime.attaching = true;
    runtime.pendingLive = [];
    let snapshot = "";
    let snapshotError: unknown = null;
    try {
      snapshot = await runtime.mirror.snapshot();
    } catch (error) {
      snapshotError = error;
    } finally {
      runtime.attaching = false;
    }
    if (this.terminals.get(terminalId) !== runtime) {
      // The shell exited while the snapshot was being taken. onExit held its
      // exit back for this attach, so replay the exited record: ready, the
      // final screen, then the exit. (No record: the shell was closed on
      // purpose, and nothing is owed.)
      const exited = this.exited.get(terminalId);
      if (exited) {
        await this.replayExit(terminalId, exited);
      }
      return;
    }
    if (snapshotError) {
      throw snapshotError;
    }
    this.emitReady(runtime);
    if (snapshot) {
      this.onOutput({ sessionId: this.sessionId, terminalId, data: snapshot });
    }
    const pending = runtime.pendingLive;
    runtime.pendingLive = [];
    for (const chunk of pending) {
      this.onOutput({ sessionId: this.sessionId, terminalId, data: chunk });
    }
  }

  /**
   * #4517 (R10): show an exited persistent shell to a (re-)attaching client:
   * ready, its final screen, then the exit. Skipped if "Start new shell"
   * discarded the record while the snapshot was resolving.
   */
  private async replayExit(
    terminalId: string,
    exited: ExitedTerminal
  ): Promise<void> {
    const snapshot = await exited.snapshot;
    if (this.exited.get(terminalId) !== exited) {
      return;
    }
    this.onReady({ sessionId: this.sessionId, terminalId, persistent: true });
    if (snapshot) {
      this.onOutput({ sessionId: this.sessionId, terminalId, data: snapshot });
    }
    this.onExit({
      sessionId: this.sessionId,
      terminalId,
      code: exited.code,
      signal: exited.signal,
    });
  }

  write(terminalId: string, data: string): void {
    const runtime = this.terminals.get(terminalId);
    if (!runtime) {
      this.emitError(terminalId, "Terminal not found.");
      return;
    }
    runtime.terminal.write(data);
    this.markActivity(runtime);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const runtime = this.terminals.get(terminalId);
    if (!runtime) {
      return;
    }
    runtime.cols = cols;
    runtime.rows = rows;
    runtime.terminal.resize(cols, rows);
    try {
      runtime.mirror?.resize(cols, rows);
    } catch (error) {
      this.dropMirror(
        runtime,
        `resize failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    this.markActivity(runtime);
  }

  /**
   * #4657: stop mirroring a persistent shell whose mirror can no longer be
   * trusted (a rejected write leaves its screen state incomplete). The shell
   * stays alive and persistent; a later re-attach takes `create()`'s
   * no-mirror branch (`ready`, no history replay), and an exit is sent
   * directly with no exited-record — the paths that already run when
   * `mirror` is null. An attach already awaiting this mirror's snapshot
   * still completes: the disposed mirror's snapshot resolves "". Logged once
   * per shell: file log + a `warn` report, never the console (it would
   * disturb the Claude TUI).
   */
  private dropMirror(runtime: TerminalRuntime, reason: string): void {
    const mirror = runtime.mirror;
    if (!mirror) {
      return;
    }
    runtime.mirror = null;
    try {
      mirror.dispose();
    } catch (error) {
      logger.debug("[TERMINAL] Failed to dispose dropped mirror", { error });
    }
    const { terminalId } = runtime;
    logger.debug(
      "[TERMINAL] [WARN] persistent mirror dropped — re-attach will not replay history for this shell",
      { terminalId, reason }
    );
    logger.reportError({
      message: "terminal mirror dropped",
      stack: null,
      category: "terminal-mirror",
      severity: "warn",
      context: `${terminalId}: ${reason}`,
    });
  }

  close(terminalId: string): void {
    this.exited.delete(terminalId);
    this.cleanup(terminalId);
  }

  closeAll(): void {
    this.exited.clear();
    for (const terminalId of this.terminals.keys()) {
      this.cleanup(terminalId);
    }
  }

  /**
   * Clean up only legacy (non-persistent) terminals. Called when the CLI's own
   * `/cli` socket drops (hub restart/redeploy, network blip): persistent shells
   * survive the drop (R6) and are re-attached by the browser's next
   * `terminal:create` after the CLI reconnects. Legacy terminals keep today's
   * close-on-disconnect behaviour.
   */
  closeNonPersistent(): void {
    const legacyIds: string[] = [];
    for (const [terminalId, runtime] of this.terminals) {
      if (!runtime.persistent) {
        legacyIds.push(terminalId);
      }
    }
    for (const terminalId of legacyIds) {
      this.cleanup(terminalId);
    }
  }

  private markActivity(runtime: TerminalRuntime): void {
    // #4517 (R7): the single choke point — a persistent shell is never killed
    // for inactivity, whichever path (input, resize, output) reports activity.
    // Call sites call this unconditionally and leave the rule here, so a new
    // call site cannot re-arm the timer.
    if (runtime.persistent) {
      return;
    }
    this.scheduleIdleTimer(runtime);
  }

  private scheduleIdleTimer(runtime: TerminalRuntime): void {
    if (this.idleTimeoutMs <= 0) {
      return;
    }

    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer);
    }

    runtime.idleTimer = setTimeout(() => {
      this.emitError(runtime.terminalId, "Terminal closed due to inactivity.");
      this.cleanup(runtime.terminalId);
    }, this.idleTimeoutMs);
  }

  private cleanup(terminalId: string): void {
    const runtime = this.terminals.get(terminalId);
    if (!runtime) {
      return;
    }

    this.terminals.delete(terminalId);
    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer);
    }
    runtime.mirror?.dispose();

    if (!runtime.proc.killed && runtime.proc.exitCode === null) {
      try {
        runtime.proc.kill();
      } catch (error) {
        logger.debug("[TERMINAL] Failed to kill process", { error });
      }
    }

    try {
      runtime.terminal.close();
    } catch (error) {
      logger.debug("[TERMINAL] Failed to close terminal", { error });
    }
  }

  private emitReady(runtime: TerminalRuntime): void {
    this.onReady({
      sessionId: this.sessionId,
      terminalId: runtime.terminalId,
      persistent: runtime.persistent,
    });
  }

  private emitError(terminalId: string, message: string): void {
    this.onError({ sessionId: this.sessionId, terminalId, message });
  }
}
