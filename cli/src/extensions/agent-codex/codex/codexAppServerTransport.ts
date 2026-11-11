// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The `codex app-server` transport (#6263): the launcher's ten-method
 * CodexTransport surface over the app-server's thread and turn API.
 *
 * The app-server holds per-thread state the MCP transport never had: a loaded
 * thread's approval policy and sandbox are fixed at load time, the request
 * `config` (the `hapi` MCP server) is not stored with the thread, and a
 * `turn/start` during a running turn folds into it. So this transport:
 * - caches the thread parameters and replays them on every reconnect resume
 *   and fallback start;
 * - sends the posture (`approvalPolicy`, `sandboxPolicy`, `model`) on EVERY
 *   `turn/start`, a workspace-write `sandboxPolicy` with the thread's own
 *   config.toml settings (a bare one would replace them with Codex's
 *   defaults);
 * - never starts a turn while one is unsettled, and re-adopts a turn whose id
 *   a later `turn/start` returns.
 *
 * Patterns from tiann/hapi@34f931ef5 (cli/src/codex/codexRemoteLauncher.ts:
 * abort :45-75, terminal-event gating :226-335, turn loop :570-700), adapted
 * to this repo's launcher, which needs `startSession` to resolve at the end
 * of the turn.
 */

import { CLI_VERSION } from "@/version";
import { logger } from "@/ui/logger";
import {
  AppServerRpcError,
  CodexAppServerClient,
  describeAppServerExit,
  type AppServerExit,
  type CodexAppServerClientOptions,
} from "./appServer/codexAppServerClient";
import {
  AppServerEventConverter,
  TERMINAL_EVENT_TYPES,
  type ScopedCodexEvent,
} from "./appServer/appServerEventConverter";
import { AppServerPermissionAdapter } from "./appServer/appServerPermissionAdapter";
import { shouldIgnoreTerminalEvent } from "./appServer/terminalEventGuard";
import {
  sandboxPolicyFor,
  workspaceWritePolicyFromConfig,
  workspaceWritePolicyFromThread,
  type ApprovalPolicy,
  type SandboxMode,
  type SandboxPolicy,
  type ThreadResponse,
  type ThreadStartParams,
  type WorkspaceWritePolicy,
} from "./appServer/appServerTypes";
import { warnIfUnverifiedCodexVersion } from "./codexVersion";
import type {
  CodexStartOptions,
  CodexTransport,
  CodexTurnOptions,
} from "./codexTransport";
import type { CodexEvent, CodexSessionConfig } from "./types";
import type { CodexPermissionHandler } from "./utils/permissionHandler";

/** How long a new turn waits for an interrupted turn's terminal event. */
export const INTERRUPTED_TURN_WAIT_MS = 10_000;

/** (a) The thread parameters, replaced on every startSession. */
interface CachedThreadParams {
  cwd: string;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  config: Record<string, unknown>;
  /** For thread/start: the system prompt, with any transcript summary. */
  startDeveloperInstructions?: string;
  /** For thread/resume: the system prompt without the transcript summary. */
  resumeDeveloperInstructions?: string;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The caller may never await a settled-by-abort promise; never let it
  // become an unhandled rejection (runnerLifecycle treats one as a crash).
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function createAbortError(): Error {
  const error = new Error("Aborted by user");
  error.name = "AbortError";
  return error;
}

interface ActiveTurn {
  prompt: string;
  turnId: string | null;
  deferred: Deferred;
  settled: boolean;
  abortRequested: boolean;
  /** turn/start returned the id of a turn interrupted earlier (folded in). */
  readopted: boolean;
  /** The input was sent a second time after a re-adopted turn ended interrupted. */
  resent: boolean;
  /** A turn/start request for this turn is awaiting its reply. */
  startInFlight: boolean;
}

export interface CodexAppServerTransportOptions {
  bin: string;
  version: string | null;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  interruptedTurnWaitMs?: number;
  /** Test seam: the client options' initialize timeout. */
  initializeTimeoutMs?: number;
  /** Test seam: the client options' turn/interrupt timeout. */
  interruptTimeoutMs?: number;
}

export class CodexAppServerTransport implements CodexTransport {
  readonly kind = "app-server" as const;
  private readonly client: CodexAppServerClient;
  private readonly converter = new AppServerEventConverter();
  private handler: ((event: CodexEvent) => void) | null = null;
  private permissionHandler: CodexPermissionHandler | null = null;
  private readonly cwd: string;
  private readonly interruptedTurnWaitMs: number;

  private params: CachedThreadParams | null = null;
  /** The session's thread id; survives child exits (resume target). */
  private threadId: string | null = null;
  /** (b) The thread loaded in the current app-server process. */
  private loadedThreadId: string | null = null;
  /** (c) Whether the loaded thread has completed a turn (it has a rollout). */
  private threadHasCompletedTurn = false;
  /** A thread that entered systemError; never resumed. */
  private invalidThreadId: string | null = null;
  /**
   * The loaded thread's full workspace-write policy (config.toml's
   * `[sandbox_workspace_write]` settings), sent on a workspace-write
   * turn/start; replaced on every thread load, null while none is loaded.
   */
  private workspaceWritePolicy: WorkspaceWritePolicy | null = null;

  private activeTurn: ActiveTurn | null = null;
  /** Aborted turns whose events are dropped until a turn/start re-adopts them. */
  private readonly droppedTurnIds = new Set<string>();
  /** Interrupted turns still running, keyed by id, settled by their terminal event. */
  private readonly interruptedTurns = new Map<string, Deferred>();
  /**
   * A turn aborted while its turn/start awaited the reply: events of a turn
   * that is not the active one are that turn's, and are dropped.
   */
  private abortedTurnAwaitingId: ActiveTurn | null = null;
  /**
   * Interrupted turns already ended (never tracked again), with the terminal
   * event type each ended on: only turn_aborted means a stop took effect.
   */
  private readonly endedTurnIds = new Map<string, string>();
  /** Why the last thread/resume failed, for the notice. */
  private lastResumeError = "";

  constructor(private readonly options: CodexAppServerTransportOptions) {
    this.cwd = options.cwd ?? process.cwd();
    this.interruptedTurnWaitMs =
      options.interruptedTurnWaitMs ?? INTERRUPTED_TURN_WAIT_MS;
    const clientOptions: CodexAppServerClientOptions = {
      bin: options.bin,
      version: options.version,
      clientVersion: CLI_VERSION,
      cwd: this.cwd,
      env: options.env,
    };
    if (options.initializeTimeoutMs !== undefined) {
      clientOptions.initializeTimeoutMs = options.initializeTimeoutMs;
    }
    if (options.interruptTimeoutMs !== undefined) {
      clientOptions.interruptTimeoutMs = options.interruptTimeoutMs;
    }
    this.client = new CodexAppServerClient(clientOptions);
    this.client.setNotificationHandler((method, params) =>
      this.handleNotification(method, params)
    );
    this.client.setExitHandler(exit => this.handleChildExit(exit));
    new AppServerPermissionAdapter({
      registerRequestHandler: (method, handler) =>
        this.client.registerRequestHandler(method, handler),
      getPermissionHandler: () => this.permissionHandler,
      isTurnLive: turnId => this.isTurnLive(turnId),
      getFileChanges: itemId => this.converter.getFileChanges(itemId),
      isYolo: () =>
        this.params?.approvalPolicy === "never" &&
        this.params?.sandbox === "danger-full-access",
    }).register();
  }

  setPermissionHandler(handler: CodexPermissionHandler): void {
    this.permissionHandler = handler;
  }

  setHandler(handler: ((event: CodexEvent) => void) | null): void {
    this.handler = handler;
  }

  async connect(): Promise<void> {
    if (this.client.isConnected()) return;
    warnIfUnverifiedCodexVersion(this.options.version, "app-server");
    await this.client.connect();
    logger.debug(
      `[codex] app-server connected (codex ${this.options.version ?? "unknown"})`
    );
  }

  async startSession(
    config: CodexSessionConfig,
    options?: CodexStartOptions
  ): Promise<void> {
    this.cacheThreadParams(
      config,
      options?.nativeResume?.developerInstructions
    );
    await this.ensureConnected();
    await this.waitForInterruptedTurns();

    const signal = options?.signal;
    const resume = options?.nativeResume;
    if (resume && resume.threadId === this.loadedThreadId) {
      // Step 2: same process, thread loaded. A same-process thread/resume
      // keeps the old posture (measured); the new one goes on turn/start.
      logger.debug(`[codex] keeping loaded thread ${resume.threadId}`);
      this.threadId = resume.threadId;
    } else if (resume && (await this.resumeThread(resume.threadId, signal))) {
      // Step 2a: fresh process, resumed natively.
    } else {
      // Step 3: a new thread (with the transcript summary when resuming).
      if (resume) {
        this.notice(
          `Codex could not resume the previous thread natively ` +
            `(${this.lastResumeError}); continuing from a transcript summary.`
        );
      }
      await this.startThread(signal);
    }
    await this.runTurn(config.prompt, signal);
  }

  async continueSession(
    prompt: string,
    options?: CodexTurnOptions
  ): Promise<void> {
    if (!this.threadId) {
      throw new Error("No active session. Call startSession first.");
    }
    await this.ensureConnected();
    await this.waitForInterruptedTurns();

    const signal = options?.signal;
    if (this.loadedThreadId !== this.threadId) {
      // After a child exit the thread is no longer loaded: resume it with the
      // cached parameters (the hapi MCP server, the posture), else start a
      // fresh thread with them. A thread with no completed turn has no
      // rollout to resume (measured), and nothing to lose.
      const threadId = this.threadId;
      const invalid = threadId === this.invalidThreadId;
      const canResume = !invalid && this.threadHasCompletedTurn;
      const resumed = canResume && (await this.resumeThread(threadId, signal));
      if (!resumed) {
        if (invalid) {
          this.notice(
            `Codex thread ${threadId} hit a system error; started a new ` +
              `thread without the earlier conversation.`
          );
        } else if (canResume) {
          this.notice(
            `Codex could not resume the conversation after the app-server ` +
              `restarted (${this.lastResumeError}); started a new thread ` +
              `without it.`
          );
        }
        await this.startThread(signal);
      }
    }
    await this.runTurn(prompt, signal);
  }

  getSessionId(): string | null {
    return this.threadId;
  }

  hasActiveSession(): boolean {
    return this.threadId !== null;
  }

  storeSessionForResume(): string | null {
    logger.debug(
      "[codex] Storing app-server thread for resume:",
      this.threadId
    );
    return this.threadId;
  }

  /**
   * Forget the session id only. The cached parameters and the loaded-thread
   * marker stay: the launcher's mode change calls clearSession() and then
   * startSession with nativeResume naming the loaded thread (step 2).
   */
  clearSession(): void {
    logger.debug(
      "[codex] app-server session cleared, previous:",
      this.threadId
    );
    this.threadId = null;
  }

  /**
   * Stop the running turn (the launcher's abort). `leaving` (exit or switch to
   * local) settles it at once: the session then disconnects, which stops the
   * child, so it never waits on a Codex that may not answer the interrupt.
   */
  stopActiveTurn(options?: { leaving?: boolean }): void {
    const turn = this.activeTurn;
    if (turn) this.abortTurn(turn, options?.leaving === true);
  }

  async disconnect(): Promise<void> {
    const turn = this.activeTurn;
    this.activeTurn = null;
    if (turn && !turn.settled) {
      turn.settled = true;
      turn.deferred.reject(new Error("Codex app-server disconnected"));
    }
    this.settleInterruptedTurns();
    this.loadedThreadId = null;
    this.workspaceWritePolicy = null;
    this.threadId = null;
    this.converter.reset();
    await this.client.disconnect();
  }

  // --- threads -------------------------------------------------------------

  private cacheThreadParams(
    config: CodexSessionConfig,
    resumeDeveloperInstructions: string | undefined
  ): void {
    const raw = { ...(config.config ?? {}) };
    const startDeveloperInstructions =
      typeof raw.developer_instructions === "string"
        ? raw.developer_instructions
        : undefined;
    // Sent as the developerInstructions field instead: a config key would
    // override the resume prompt with the transcript-summary one.
    delete raw.developer_instructions;
    delete raw.experimental_resume;
    const params: CachedThreadParams = {
      cwd: this.cwd,
      config: raw,
      startDeveloperInstructions,
      resumeDeveloperInstructions:
        resumeDeveloperInstructions ?? startDeveloperInstructions,
    };
    if (config.model) params.model = config.model;
    if (config["approval-policy"]) {
      params.approvalPolicy = config["approval-policy"];
    }
    if (config.sandbox) params.sandbox = config.sandbox;
    this.params = params;
  }

  private threadParams(developerInstructions?: string): ThreadStartParams {
    const p = this.requireParams();
    const out: ThreadStartParams = { cwd: p.cwd, config: p.config };
    if (p.model) out.model = p.model;
    if (p.approvalPolicy) out.approvalPolicy = p.approvalPolicy;
    if (p.sandbox) out.sandbox = p.sandbox;
    if (developerInstructions)
      out.developerInstructions = developerInstructions;
    // No baseInstructions: it would replace Codex's own base instructions,
    // which the MCP transport never did.
    return out;
  }

  private requireParams(): CachedThreadParams {
    if (!this.params) {
      throw new Error("No thread parameters. Call startSession first.");
    }
    return this.params;
  }

  private async startThread(signal?: AbortSignal): Promise<void> {
    const params = this.threadParams(
      this.requireParams().startDeveloperInstructions
    );
    const response = await this.client.startThread(params, { signal });
    this.adoptThread(response, "started");
    this.threadHasCompletedTurn = false;
    await this.loadWorkspaceWritePolicy(response, signal);
  }

  /**
   * Step 2a. False on any error but an abort or a lost connection (an unknown
   * id answers -32600); `lastResumeError` says why.
   */
  private async resumeThread(
    threadId: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    const params = {
      ...this.threadParams(this.requireParams().resumeDeveloperInstructions),
      threadId,
    };
    try {
      const response = await this.client.resumeThread(params, { signal });
      this.adoptThread(response, "resumed");
      this.threadHasCompletedTurn = true;
      this.warnIfPostureDiffers(params, response);
      // A reconnect reads the new process's settings, never the old ones.
      await this.loadWorkspaceWritePolicy(response, signal);
      return true;
    } catch (error) {
      if ((error as Error | null)?.name === "AbortError") throw error;
      if (!this.client.isConnected()) throw error;
      this.lastResumeError =
        error instanceof AppServerRpcError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      logger.warn(
        `[codex] thread/resume ${threadId} failed: ${this.lastResumeError}; starting a new thread`
      );
      return false;
    }
  }

  private adoptThread(response: ThreadResponse, how: string): void {
    const id = response?.thread?.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`Codex app-server thread/${how} returned no thread id`);
    }
    this.threadId = id;
    this.loadedThreadId = id;
    if (this.invalidThreadId === id) this.invalidThreadId = null;
    logger.debug(`[codex] thread ${how}: ${id}`);
  }

  private warnIfPostureDiffers(
    requested: ThreadStartParams,
    response: ThreadResponse
  ): void {
    const gotPolicy = response.approvalPolicy;
    const gotSandbox = (response.sandbox as { type?: unknown } | undefined)
      ?.type;
    const wantSandbox = sandboxPolicyFor(requested.sandbox).type;
    const policyDiffers =
      requested.approvalPolicy !== undefined &&
      typeof gotPolicy === "string" &&
      gotPolicy !== requested.approvalPolicy;
    const sandboxDiffers =
      requested.sandbox !== undefined &&
      typeof gotSandbox === "string" &&
      gotSandbox !== wantSandbox;
    if (policyDiffers || sandboxDiffers) {
      logger.warn(
        `[codex] thread/resume posture differs: requested approvalPolicy=` +
          `${requested.approvalPolicy ?? "-"} sandbox=${wantSandbox}, got ` +
          `approvalPolicy=${String(gotPolicy)} sandbox=${String(gotSandbox)}`
      );
    }
  }

  /**
   * Keep the loaded thread's full workspace-write policy for turn/start: from
   * the thread/start or thread/resume reply when the thread loaded in
   * workspace-write, else from config/read (a thread loaded in YOLO or
   * read-only that later moves to workspace-write). Runs on every load, so a
   * reconnect never keeps the old process's settings. Without a policy, a
   * workspace-write turn falls back to the bare object, and the log says so.
   */
  private async loadWorkspaceWritePolicy(
    response: ThreadResponse,
    signal?: AbortSignal
  ): Promise<void> {
    this.workspaceWritePolicy = workspaceWritePolicyFromThread(
      response?.sandbox
    );
    if (this.workspaceWritePolicy) return;
    let reason: string;
    try {
      const result = await this.client.readConfig(
        { cwd: this.requireParams().cwd },
        { signal }
      );
      this.workspaceWritePolicy = workspaceWritePolicyFromConfig(
        result?.config
      );
      if (this.workspaceWritePolicy) return;
      reason = "config/read returned no config object";
    } catch (error) {
      if (
        (error as Error | null)?.name === "AbortError" ||
        !this.client.isConnected()
      ) {
        // Unload, so the next call reloads the thread (and its policy) rather
        // than keeping it with no policy (#6263 review round 1, delta).
        this.loadedThreadId = null;
        throw error;
      }
      reason = `config/read failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    logger.warn(
      `[codex] ${reason}; a workspace-write turn on thread ` +
        `${this.loadedThreadId} will use Codex's default workspace-write ` +
        `sandbox, without config.toml's [sandbox_workspace_write] settings`
    );
  }

  /**
   * The turn/start sandbox. YOLO and read-only send their own policy, so
   * nothing from config.toml's workspace-write section widens read-only;
   * workspace-write sends the thread's full policy, so the user's settings
   * survive the turn.
   */
  private turnSandboxPolicy(mode: SandboxMode | undefined): SandboxPolicy {
    const policy = sandboxPolicyFor(mode);
    if (policy.type !== "workspaceWrite") return policy;
    return this.workspaceWritePolicy ?? policy;
  }

  private async ensureConnected(): Promise<void> {
    if (!this.client.isConnected()) await this.connect();
  }

  // --- turns ---------------------------------------------------------------

  private async waitForInterruptedTurns(): Promise<void> {
    if (this.interruptedTurns.size === 0) return;
    const pending = [...this.interruptedTurns.values()].map(d => d.promise);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      Promise.allSettled(pending).then(() => false),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(true), this.interruptedTurnWaitMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      logger.debug(
        `[codex] interrupted turn(s) ${[...this.interruptedTurns.keys()].join(",")} ` +
          `not ended after ${this.interruptedTurnWaitMs}ms; starting the next turn`
      );
      // Wait once per interrupted turn, not before every later turn. Their
      // events stay dropped unless a turn/start re-adopts them.
      this.settleInterruptedTurns();
    }
  }

  private async runTurn(prompt: string, signal?: AbortSignal): Promise<void> {
    if (this.activeTurn && !this.activeTurn.settled) {
      throw new Error("A Codex turn is already running");
    }
    const turn: ActiveTurn = {
      prompt,
      turnId: null,
      deferred: createDeferred(),
      settled: false,
      abortRequested: false,
      readopted: false,
      resent: false,
      startInFlight: false,
    };
    this.activeTurn = turn;

    const onAbort = (): void => this.abortTurn(turn);
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {
      // turn/start runs beside the turn promise, so an abort settles the call
      // at once even when the reply never comes.
      if (!turn.settled) {
        void this.sendTurnStart(turn).catch(error =>
          this.failTurn(turn, error)
        );
      }
      await turn.deferred.promise;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (this.activeTurn === turn) this.activeTurn = null;
    }
  }

  /**
   * Send turn/start with the posture and record the id. The abort signal is
   * deliberately not passed to the request: an abort before the reply must
   * still learn the id, to interrupt that turn.
   */
  private async sendTurnStart(turn: ActiveTurn): Promise<void> {
    const p = this.requireParams();
    const threadId = this.loadedThreadId;
    if (!threadId) throw new Error("No Codex thread is loaded");
    let response;
    turn.startInFlight = true;
    try {
      response = await this.client.startTurn({
        threadId,
        input: [{ type: "text", text: turn.prompt }],
        approvalPolicy: p.approvalPolicy,
        sandboxPolicy: this.turnSandboxPolicy(p.sandbox),
        ...(p.model ? { model: p.model } : {}),
      });
    } catch (error) {
      if (turn.settled) return; // aborted, or the child exited
      throw error;
    } finally {
      turn.startInFlight = false;
      if (this.abortedTurnAwaitingId === turn) {
        // Cleared after the reply's id (if any) was handled below; an error
        // or a missing id ends the wait too.
        queueMicrotask(() => {
          if (this.abortedTurnAwaitingId === turn) {
            this.abortedTurnAwaitingId = null;
          }
        });
      }
    }
    const turnId = response?.turn?.id;
    if (typeof turnId !== "string" || turnId.length === 0) {
      if (!turn.settled) {
        throw new Error("Codex app-server turn/start returned no turn id");
      }
      return;
    }
    this.recordTurnId(turn, turnId);
  }

  private recordTurnId(turn: ActiveTurn, turnId: string): void {
    // A turn settled at its abort is interrupted here once its id is known.
    // That is a turn stopped before any id, or an early-id turn (turn/started
    // before the reply) that settled before the reply came: its stop confirmed
    // by stopRunningTurn; its end arriving during that wait (interruptTurn
    // then returns early); or a stop for exit or switch, where a second
    // turn/interrupt goes out if the reply lands before the disconnect, and
    // the disconnect rejects it. An unsettled turn is owned by stopRunningTurn
    // (#6263 rounds 3 to 5).
    if (turn.abortRequested && turn.settled) {
      // Aborted before the reply: interrupt the turn now that its id is known.
      if (this.abortedTurnAwaitingId === turn)
        this.abortedTurnAwaitingId = null;
      this.interruptTurn(turnId);
      return;
    }
    turn.turnId = turnId;
    if (this.droppedTurnIds.has(turnId)) {
      // Codex folded this input into a turn interrupted earlier that had not
      // ended: re-adopt it, forward its events from here on.
      logger.debug(`[codex] turn/start re-adopted interrupted turn ${turnId}`);
      this.droppedTurnIds.delete(turnId);
      this.interruptedTurns.get(turnId)?.resolve();
      this.interruptedTurns.delete(turnId);
      turn.readopted = true;
      this.emit({ type: "task_started", turn_id: turnId });
    }
  }

  /**
   * Stop the turn. With its id known, the turn settles as aborted only once
   * Codex confirms the stop (the interrupt reply or the turn's end); a failed
   * or timed-out turn/interrupt leaves it running and visible, says so, and a
   * second stop tries again (#6263). Before the turn/start reply it settles at
   * once, so an abort never waits on a reply that may not come.
   */
  private abortTurn(turn: ActiveTurn, leaving = false): void {
    if (turn.settled) return;
    if (turn.abortRequested && !leaving) return;
    const firstStop = !turn.abortRequested;
    turn.abortRequested = true;
    if (turn.turnId && !leaving) {
      void this.stopRunningTurn(turn, turn.turnId);
      return;
    }
    if (turn.turnId) {
      // Leaving: ask Codex to stop, but settle now (#6263 round 3).
      const turnId = turn.turnId;
      const threadId = this.loadedThreadId;
      if (firstStop && threadId) {
        this.client.interruptTurn({ threadId, turnId }).catch(error => {
          logger.debug(
            `[codex] turn/interrupt ${turnId} on leave failed`,
            error
          );
        });
      }
      this.trackInterruptedTurn(turnId);
      turn.settled = true;
      turn.deferred.reject(createAbortError());
      return;
    }
    turn.settled = true;
    if (turn.startInFlight) this.abortedTurnAwaitingId = turn;
    turn.deferred.reject(createAbortError());
  }

  private async stopRunningTurn(
    turn: ActiveTurn,
    turnId: string
  ): Promise<void> {
    const threadId = this.loadedThreadId;
    if (threadId) {
      try {
        await this.client.interruptTurn({ threadId, turnId });
      } catch (error) {
        // The turn ended, the child exited, or the session is leaving.
        if (turn.settled || !this.client.isConnected()) return;
        turn.abortRequested = false;
        this.notice(
          `Codex did not confirm the stop (turn/interrupt failed: ` +
            `${error instanceof Error ? error.message : String(error)}). ` +
            `The turn may still be running; its output stays visible. ` +
            `Press stop again to retry.`
        );
        return;
      }
    }
    if (turn.settled) return;
    this.trackInterruptedTurn(turnId);
    turn.settled = true;
    turn.deferred.reject(createAbortError());
  }

  /** Drop the turn's later events until re-adopted; wait once for its end. */
  private trackInterruptedTurn(turnId: string): void {
    this.droppedTurnIds.add(turnId);
    // Its terminal event may have come first.
    if (this.endedTurnIds.has(turnId)) return;
    if (!this.interruptedTurns.has(turnId)) {
      this.interruptedTurns.set(turnId, createDeferred());
    }
  }

  /**
   * Interrupt a turn aborted before its turn/start reply (already settled),
   * dropping its later events until re-adopted.
   */
  private interruptTurn(turnId: string): void {
    const threadId = this.loadedThreadId;
    this.trackInterruptedTurn(turnId);
    if (this.endedTurnIds.has(turnId) || !threadId) return;
    this.client.interruptTurn({ threadId, turnId }).catch(error => {
      // Do not hold the next turn for a turn that may never report its end,
      // and show its output rather than hide a turn that may still run.
      this.interruptedTurns.get(turnId)?.resolve();
      this.interruptedTurns.delete(turnId);
      if (!this.client.isConnected()) return; // the session is leaving
      const endedAs = this.endedTurnIds.get(turnId);
      if (endedAs === "turn_aborted") return; // it ended interrupted: the stop held
      if (endedAs !== undefined) {
        // It ended on its own while the stop waited. Only a turn still dropped
        // had its output hidden; a re-adopted turn's end was shown.
        if (this.droppedTurnIds.has(turnId))
          this.notice(
            `Codex ${endedAs === "task_failed" ? "ended the turn with a failure" : "finished the turn"} ` +
              `before the stop took effect (turn/interrupt failed: ` +
              `${error instanceof Error ? error.message : String(error)}). ` +
              `Its output was not shown.`
          );
        return;
      }
      this.droppedTurnIds.delete(turnId);
      this.notice(
        `Codex did not confirm the stop (turn/interrupt failed: ` +
          `${error instanceof Error ? error.message : String(error)}). ` +
          `The turn may still be running; its output stays visible.`
      );
    });
  }

  private markEnded(turnId: string, type: string): void {
    if (this.endedTurnIds.size >= 64) this.endedTurnIds.clear();
    this.endedTurnIds.set(turnId, type);
  }

  /** A transport decision the user should see (#6263 review): log and show it. */
  private notice(message: string): void {
    logger.warn(`[codex] ${message}`);
    this.emit({ type: "hapi_notice", message });
  }

  private settleInterruptedTurns(): void {
    for (const deferred of this.interruptedTurns.values()) deferred.resolve();
    this.interruptedTurns.clear();
  }

  private isTurnLive(turnId: string | null): boolean {
    const turn = this.activeTurn;
    if (!turn || turn.settled) return false;
    if (turnId === null) return true;
    if (this.droppedTurnIds.has(turnId)) return false;
    return turn.turnId === null || turn.turnId === turnId;
  }

  // --- events --------------------------------------------------------------

  private emit(event: CodexEvent): void {
    try {
      this.handler?.(event);
    } catch (error) {
      logger.debug("[codex] event handler threw", error);
      logger.reportCaught(error, {
        category: "codex-appserver-event",
        severity: "warn",
      });
    }
  }

  private handleNotification(method: string, params: unknown): void {
    for (const scoped of this.converter.handleNotification(method, params)) {
      this.routeEvent(scoped);
    }
  }

  private routeEvent({ event, turnId, threadId }: ScopedCodexEvent): void {
    const type = event.type ?? "";
    const terminal = TERMINAL_EVENT_TYPES.has(type);

    if (
      turnId &&
      this.abortedTurnAwaitingId !== null &&
      !this.droppedTurnIds.has(turnId) &&
      (!this.activeTurn ||
        this.activeTurn.settled ||
        (this.activeTurn.turnId !== null && this.activeTurn.turnId !== turnId))
    ) {
      // The aborted turn's events, ahead of its turn/start reply.
      this.droppedTurnIds.add(turnId);
      if (!this.interruptedTurns.has(turnId)) {
        this.interruptedTurns.set(turnId, createDeferred());
      }
    }

    if (turnId && this.droppedTurnIds.has(turnId)) {
      if (terminal) {
        this.markEnded(turnId, type);
        this.interruptedTurns.get(turnId)?.resolve();
        this.interruptedTurns.delete(turnId);
      }
      return;
    }

    if (!terminal) {
      this.emit(event);
      if (
        type === "task_started" &&
        turnId &&
        this.activeTurn?.turnId === null
      ) {
        // The event beat the turn/start reply; the reply sets the same id.
        this.activeTurn.turnId = turnId;
      }
      return;
    }

    const turn = this.activeTurn;
    const threadStatusFailure = event.terminal_source === "thread_status";
    if (threadStatusFailure) {
      if (threadId && threadId !== this.loadedThreadId) return;
      this.invalidThreadId = this.loadedThreadId;
      this.loadedThreadId = null;
      this.workspaceWritePolicy = null;
    }
    if (
      !turn ||
      turn.settled ||
      shouldIgnoreTerminalEvent({
        eventTurnId: turnId,
        currentTurnId: turn.turnId,
        turnInFlight: true,
        eventThreadId: threadId,
        currentThreadId: this.loadedThreadId ?? this.invalidThreadId,
        allowMatchingThreadIdTerminalEvent: threadStatusFailure,
      })
    ) {
      logger.debug(
        `[codex] Ignoring terminal ${type} (turn ${turnId ?? "none"}, ` +
          `active ${turn?.turnId ?? "none"})`
      );
      return;
    }

    if (turn.abortRequested) {
      // The turn ended while its stop awaited Codex's reply: the stop holds.
      this.emit(event);
      if (turnId) this.markEnded(turnId, type);
      turn.settled = true;
      turn.deferred.reject(createAbortError());
      return;
    }

    if (type === "turn_aborted" && turn.readopted && !turn.resent) {
      // The earlier abort ended the turn the input was folded into, so the
      // input may not have run: report the interruption, then send it once
      // more on a fresh turn and settle from that one.
      this.emit(event);
      turn.resent = true;
      turn.turnId = null;
      turn.readopted = false;
      void this.sendTurnStart(turn).catch(error => this.failTurn(turn, error));
      return;
    }

    this.emit(event);
    if (type === "task_complete") this.threadHasCompletedTurn = true;
    turn.settled = true;
    turn.deferred.resolve();
  }

  private failTurn(turn: ActiveTurn, error: unknown): void {
    if (turn.settled) return;
    turn.settled = true;
    turn.deferred.reject(
      error instanceof Error ? error : new Error(String(error))
    );
  }

  /**
   * R12: the child exited after connect. Fail the in-flight turn with the exit
   * code or signal (worded so enrichWithSignalContext matches), keep the
   * thread id and the cached parameters, and forget the loaded thread so the
   * next call reconnects and resumes.
   */
  private handleChildExit(exit: AppServerExit): void {
    this.loadedThreadId = null;
    this.workspaceWritePolicy = null;
    this.converter.reset();
    this.settleInterruptedTurns();
    this.droppedTurnIds.clear();
    this.abortedTurnAwaitingId = null;
    this.endedTurnIds.clear();
    const lastLine = exit.stderrTail[exit.stderrTail.length - 1];
    const message =
      describeAppServerExit(exit) + (lastLine ? ` (${lastLine})` : "");
    logger.warn(`[codex] ${message}`);
    const turn = this.activeTurn;
    if (turn && !turn.settled) this.failTurn(turn, new Error(message));
  }
}

/** The app-server factory the remote launcher hands to createCodexTransport. */
export function createAppServerTransport(args: {
  bin: string;
  version: string | null;
}): CodexAppServerTransport {
  return new CodexAppServerTransport(args);
}
