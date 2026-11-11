// SPDX-License-Identifier: AGPL-3.0-only
// Ported from tiann/hapi@34f931ef5 (cli/src/codex/codexAppServerClient.ts), AGPL-3.0-only, with changes.
// The stdin error handler, the stale-child guards on the exit and error
// handlers, and the write guard follow tiann/hapi@2161a9ff
// (cli/src/codex/codexAppServerClient.ts:276-308, :898).
/**
 * A newline-delimited JSON-RPC client for `codex app-server` over stdio
 * (#6263). `connect()` spawns the child and resolves only after `initialize`
 * succeeds, so a missing or broken binary fails inside `connect()` with a
 * typed {@link CodexStartError}.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";
import { logger } from "@/ui/logger";
import { buildHarnessChildEnv } from "@/sandbox/secretEnvVars";
import {
  CodexStartError,
  appendStderrTail,
  stderrCause,
  type CodexStartErrorKind,
} from "../types";
import type {
  ConfigReadParams,
  ConfigReadResponse,
  InitializeParams,
  InitializeResponse,
  ThreadResponse,
  ThreadResumeParams,
  ThreadStartParams,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResponse,
} from "./appServerTypes";

type JsonRpcId = number | string;

type JsonRpcResponse = {
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code?: number; message: string; data?: unknown };
};

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
type NotificationHandler = (method: string, params: unknown) => void;
export type AppServerExitHandler = (exit: AppServerExit) => void;

export interface AppServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string[];
}

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

/** A JSON-RPC error answer from the app-server (e.g. `-32600` for an unknown thread). */
export class AppServerRpcError extends Error {
  readonly method: string;
  readonly code: number | undefined;
  readonly data: unknown;

  constructor(
    method: string,
    error: { code?: number; message: string; data?: unknown }
  ) {
    super(
      `${method} failed${error.code !== undefined ? ` (${error.code})` : ""}: ${error.message}`
    );
    this.name = "AppServerRpcError";
    this.method = method;
    this.code = error.code;
    this.data = error.data;
  }
}

export interface CodexAppServerClientOptions {
  /** The Codex executable (`resolveCodexBin`). */
  bin: string;
  /** The probed Codex version, for the start error. */
  version: string | null;
  /** Hapimatic's version, sent as `clientInfo.version`. */
  clientVersion: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  initializeTimeoutMs?: number;
  /** Test seam: how long turn/interrupt waits for its reply. */
  interruptTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const INITIALIZE_TIMEOUT_MS = 30_000;
const INTERRUPT_TIMEOUT_MS = 30_000;
/** How long an exit waits for the last stderr lines before it is reported. */
const EXIT_STDERR_GRACE_MS = 100;
const KILL_GRACE_MS = 2_000;
/** How long a failed start waits for the child's error or exit event. */
const CHILD_FATE_WAIT_MS = 500;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function createAbortError(): Error {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

/** "exited with code N" / "killed by SIGNAL" — matched by enrichWithSignalContext. */
export function describeAppServerExit(exit: {
  code: number | null;
  signal: NodeJS.Signals | null;
}): string {
  if (exit.signal) return `Codex app-server killed by ${exit.signal}`;
  return `Codex app-server exited with code ${exit.code ?? "unknown"}`;
}

function waitForEnd(stream: Readable, ms: number): Promise<void> {
  return new Promise(resolve => {
    if (stream.readableEnded || stream.destroyed) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done(): void {
      clearTimeout(timer);
      stream.off("end", done);
      stream.off("close", done);
      resolve();
    }
    stream.once("end", done);
    stream.once("close", done);
  });
}

function processEnvRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private connected = false;
  private buffer = "";
  /** Complete stdout lines not handled yet, in arrival order. */
  private readonly pendingLines: string[] = [];
  /** A drain is running or scheduled; new lines wait for it. */
  private draining = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private notificationHandler: NotificationHandler | null = null;
  private exitHandler: AppServerExitHandler | null = null;
  private stderrTail: string[] = [];
  private spawnError: NodeJS.ErrnoException | null = null;
  private lastExit: AppServerExit | null = null;
  /** Wakes a start-failure classification waiting for the child's fate. */
  private childGoneWaiter: (() => void) | null = null;

  constructor(private readonly options: CodexAppServerClientOptions) {}

  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  setNotificationHandler(handler: NotificationHandler | null): void {
    this.notificationHandler = handler;
  }

  /** Called when the child exits on its own after `connect()` resolved. */
  setExitHandler(handler: AppServerExitHandler | null): void {
    this.exitHandler = handler;
  }

  registerRequestHandler(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    this.resetForSpawn();
    const env = buildHarnessChildEnv(
      "codex",
      processEnvRecord(this.options.env ?? process.env)
    );
    logger.debug(`[CodexAppServer] Starting ${this.options.bin} app-server`);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.bin, ["app-server"], {
        cwd: this.options.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
    } catch (error) {
      throw this.startError(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "not-installed"
          : "exited-at-startup",
        error instanceof Error ? error.message : String(error),
        error
      );
    }
    this.process = child;
    this.attachChild(child);

    try {
      await this.sendRequest<InitializeResponse>(
        "initialize",
        {
          clientInfo: {
            name: "hapimatic-codex-client",
            version: this.options.clientVersion,
          },
          capabilities: { experimentalApi: true },
        } satisfies InitializeParams,
        { timeoutMs: this.options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS }
      );
    } catch (error) {
      await this.waitForChildFate();
      const failure = await this.classifyStartFailure(error);
      await this.stopChild();
      throw failure;
    }

    this.sendNotification("initialized");
    this.connected = true;
    logger.debug("[CodexAppServer] Connected");
  }

  async startThread(
    params: ThreadStartParams,
    options?: { signal?: AbortSignal }
  ): Promise<ThreadResponse> {
    return this.request<ThreadResponse>("thread/start", params, options);
  }

  async resumeThread(
    params: ThreadResumeParams,
    options?: { signal?: AbortSignal }
  ): Promise<ThreadResponse> {
    return this.request<ThreadResponse>("thread/resume", params, options);
  }

  async startTurn(
    params: TurnStartParams,
    options?: { signal?: AbortSignal }
  ): Promise<TurnStartResponse> {
    return this.request<TurnStartResponse>("turn/start", params, options);
  }

  async readConfig(
    params: ConfigReadParams,
    options?: { signal?: AbortSignal }
  ): Promise<ConfigReadResponse> {
    return this.request<ConfigReadResponse>("config/read", params, options);
  }

  async interruptTurn(params: TurnInterruptParams): Promise<unknown> {
    return this.request("turn/interrupt", params, {
      timeoutMs: this.options.interruptTimeoutMs ?? INTERRUPT_TIMEOUT_MS,
    });
  }

  /** Send a request on a connected client. */
  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<T> {
    if (!this.connected) {
      throw new Error(`Codex app-server is not connected (${method})`);
    }
    return this.sendRequest<T>(method, params, options);
  }

  async disconnect(): Promise<void> {
    const child = this.process;
    this.connected = false;
    // Detach first: the stale-child guards then ignore this child's exit, so an
    // intentional stop never reaches the exit handler.
    this.process = null;
    this.rejectAllPending(new Error("Codex app-server disconnected"));
    this.buffer = "";
    this.pendingLines.length = 0;
    if (child) await this.terminate(child);
    logger.debug("[CodexAppServer] Disconnected");
  }

  private resetForSpawn(): void {
    this.buffer = "";
    this.pendingLines.length = 0;
    this.stderrTail = [];
    this.spawnError = null;
    this.lastExit = null;
  }

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    child.stdin.on("error", error => {
      if (this.process !== child) return;
      logger.debug("[CodexAppServer] stdin error", error);
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.process === child) this.handleStdout(chunk);
    });
    // An unhandled stream 'error' would throw and end the wrapper.
    child.stdout.on("error", error => {
      logger.debug("[CodexAppServer] stdout error", error);
    });
    child.stderr.on("error", error => {
      logger.debug("[CodexAppServer] stderr error", error);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const text of appendStderrTail(this.stderrTail, chunk)) {
        logger.debug(`[CodexAppServer][stderr] ${text}`);
      }
    });

    child.on("error", error => {
      if (this.process !== child) return;
      logger.debug("[CodexAppServer] Process error", error);
      this.spawnError = error as NodeJS.ErrnoException;
      this.childGoneWaiter?.();
      this.handleChildGone(
        child,
        {
          code: null,
          signal: null,
          stderrTail: [...this.stderrTail],
        },
        `Failed to spawn ${this.options.bin} app-server: ${error.message}`
      );
    });

    child.on("exit", (code, signal) => {
      if (this.process !== child) return;
      // Give the last stderr lines a moment to arrive, bounded: a grandchild
      // holding the pipe open must not delay the report.
      void waitForEnd(child.stderr, EXIT_STDERR_GRACE_MS).then(() => {
        if (this.process !== child) return;
        const exit: AppServerExit = {
          code,
          signal,
          stderrTail: [...this.stderrTail],
        };
        const lastLine = exit.stderrTail[exit.stderrTail.length - 1];
        const message =
          describeAppServerExit(exit) + (lastLine ? ` (${lastLine})` : "");
        logger.debug(`[CodexAppServer] ${message}`);
        this.handleChildGone(child, exit, message);
      });
    });
  }

  private handleChildGone(
    child: ChildProcessWithoutNullStreams,
    exit: AppServerExit,
    message: string
  ): void {
    if (this.process !== child) return;
    const wasConnected = this.connected;
    this.lastExit = exit;
    this.childGoneWaiter?.();
    // Lines the child wrote before it exited are handled before the exit.
    this.flushLines();
    this.process = null;
    this.connected = false;
    this.buffer = "";
    this.rejectAllPending(new Error(message));
    if (!wasConnected) return;
    try {
      this.exitHandler?.(exit);
    } catch (error) {
      logger.debug("[CodexAppServer] exit handler threw", error);
      logger.reportCaught(error, {
        category: "codex-appserver-exit",
        severity: "warn",
      });
    }
  }

  /**
   * Under Bun, spawning a missing binary leaves stdin unwritable at once while
   * the ENOENT 'error' event comes a tick later, so `initialize` can fail
   * before the cause is known. Wait (bounded) for the child's error or exit
   * before classifying, so a missing binary reads as `not-installed`.
   */
  private async waitForChildFate(): Promise<void> {
    if (this.spawnError || this.lastExit) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>(resolve => {
      this.childGoneWaiter = resolve;
      timer = setTimeout(resolve, CHILD_FATE_WAIT_MS);
      timer.unref?.();
    });
    if (timer) clearTimeout(timer);
    this.childGoneWaiter = null;
  }

  private async classifyStartFailure(error: unknown): Promise<CodexStartError> {
    const message = error instanceof Error ? error.message : String(error);
    if (this.spawnError) {
      return this.startError(
        this.spawnError.code === "ENOENT"
          ? "not-installed"
          : "exited-at-startup",
        this.spawnError.message,
        this.spawnError
      );
    }
    if (this.lastExit) {
      const detail =
        stderrCause(this.lastExit.stderrTail) ??
        describeAppServerExit(this.lastExit);
      return this.startError("exited-at-startup", detail, error);
    }
    return this.startError("initialize-failed", message, error);
  }

  private startError(
    kind: CodexStartErrorKind,
    detail: string,
    cause: unknown
  ): CodexStartError {
    return new CodexStartError({
      kind,
      transport: "app-server",
      codexVersion: this.options.version,
      codexBin: this.options.bin,
      detail,
      cause,
    });
  }

  private async stopChild(): Promise<void> {
    const child = this.process;
    this.process = null;
    this.connected = false;
    this.rejectAllPending(new Error("Codex app-server stopped"));
    if (child) await this.terminate(child);
  }

  /** SIGTERM, then SIGKILL after a grace period. Never throws. */
  private async terminate(
    child: ChildProcessWithoutNullStreams
  ): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => {
      child.once("exit", () => resolve());
    });
    try {
      child.stdin.end();
    } catch {
      // expected: stdin may already be closed.
    }
    try {
      child.kill("SIGTERM");
    } catch (error) {
      logger.debug("[CodexAppServer] SIGTERM failed", error);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(true), KILL_GRACE_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch (error) {
        logger.debug("[CodexAppServer] SIGKILL failed", error);
      }
    }
  }

  private sendRequest<T>(
    method: string,
    params: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<T> {
    const id = this.nextId++;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const target = this.process;

    return new Promise<T>((resolve, reject) => {
      if (!target) {
        reject(new Error(`Codex app-server is not running (${method})`));
        return;
      }
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const signal = options?.signal;

      const cleanup = (): void => {
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        if (!this.pending.delete(id)) return;
        cleanup();
        reject(createAbortError());
      };

      this.pending.set(id, {
        method,
        resolve: value => {
          cleanup();
          resolve(value as T);
        },
        reject: error => {
          cleanup();
          reject(error);
        },
        cleanup,
      });

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      if (Number.isFinite(timeoutMs)) {
        timeout = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          cleanup();
          reject(
            new Error(
              `Codex app-server request '${method}' timed out after ${timeoutMs}ms`
            )
          );
        }, timeoutMs);
        timeout.unref?.();
      }

      if (!this.writePayload({ id, method, params }, target)) {
        if (this.pending.delete(id)) {
          cleanup();
          reject(
            new Error(`Codex app-server stdin is closed (${method} not sent)`)
          );
        }
      }
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    if (
      !this.writePayload(params === undefined ? { method } : { method, params })
    ) {
      logger.warn(`[CodexAppServer] Could not send notification ${method}`);
    }
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) this.pendingLines.push(line);
      newlineIndex = this.buffer.indexOf("\n");
    }
    this.drainLines();
  }

  /**
   * Handle queued lines in order. After a line that settles a request, the
   * rest of the read waits one macrotask, so the request's caller finishes
   * first: a turn/start reply records its turn id before a turn/completed in
   * the same read is routed, which otherwise drops the end of a re-adopted
   * turn and hangs the session (#6263).
   */
  private drainLines(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pendingLines.length > 0) {
        const settled = this.handleLine(this.pendingLines.shift() as string);
        if (settled && this.pendingLines.length > 0) {
          setImmediate(() => {
            this.draining = false;
            this.drainLines();
          });
          return;
        }
      }
      this.draining = false;
    } catch (error) {
      this.draining = false;
      throw error;
    }
  }

  /** Handle every queued line now, without yielding (before an exit). */
  private flushLines(): void {
    while (this.pendingLines.length > 0) {
      this.handleLine(this.pendingLines.shift() as string);
    }
  }

  /** Handle one line; true when it settled a pending request. */
  private handleLine(line: string): boolean {
    let message: Record<string, unknown> | null;
    try {
      message = asRecord(JSON.parse(line));
    } catch {
      logger.warn(
        `[CodexAppServer] Ignoring a non-JSON stdout line: ${line.slice(0, 200)}`
      );
      return false;
    }
    if (!message) return false;

    if (typeof message.method === "string") {
      const params = "params" in message ? message.params : null;
      if ("id" in message && message.id !== undefined && message.id !== null) {
        void this.handleIncomingRequest(
          message.id as JsonRpcId,
          message.method,
          params
        );
        return false;
      }
      try {
        this.notificationHandler?.(message.method, params ?? null);
      } catch (error) {
        logger.debug("[CodexAppServer] Notification handler threw", error);
        logger.reportCaught(error, {
          category: "codex-appserver-notification",
          severity: "warn",
        });
      }
      return false;
    }

    return "id" in message && this.handleResponse(message as JsonRpcResponse);
  }

  private async handleIncomingRequest(
    id: JsonRpcId,
    method: string,
    params: unknown
  ): Promise<void> {
    const target = this.process;
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      logger.debug(`[CodexAppServer] No handler for server request ${method}`);
      this.reply(
        { id, error: { code: -32601, message: `Method not found: ${method}` } },
        target,
        method
      );
      return;
    }
    try {
      const result = await handler(params ?? null);
      this.reply({ id, result }, target, method);
    } catch (error) {
      this.reply(
        {
          id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal error",
          },
        },
        target,
        method
      );
    }
  }

  /** A reply to a server request; a dropped one leaves Codex waiting, so say so. */
  private reply(
    payload: Record<string, unknown>,
    target: ChildProcessWithoutNullStreams | null,
    method: string
  ): void {
    if (!this.writePayload(payload, target)) {
      logger.warn(
        `[CodexAppServer] Reply to ${method} not delivered (the app-server is gone)`
      );
    }
  }

  /** Settle the matching request; true when one was pending. */
  private handleResponse(response: JsonRpcResponse): boolean {
    if (typeof response.id !== "number") {
      logger.debug(
        "[CodexAppServer] Response with a non-numeric id",
        response.id
      );
      return false;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return false;
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new AppServerRpcError(pending.method, response.error));
      return true;
    }
    pending.resolve(response.result);
    return true;
  }

  /**
   * Write one JSON line; false when it was not written. Dropped when the child
   * is gone or replaced: a late reply to a dead child must not crash the
   * wrapper.
   */
  private writePayload(
    payload: Record<string, unknown>,
    target: ChildProcessWithoutNullStreams | null = this.process
  ): boolean {
    if (!target || target !== this.process) return false;
    const stdin = target.stdin;
    if (stdin.destroyed || stdin.writableEnded || stdin.writable === false) {
      logger.debug("[CodexAppServer] stdin is closed; dropping a write");
      return false;
    }
    let line: string;
    try {
      line = `${JSON.stringify(payload)}\n`;
    } catch (error) {
      logger.warn("[CodexAppServer] Could not serialize a message", error);
      return false;
    }
    try {
      stdin.write(line);
      return true;
    } catch (error) {
      logger.debug("[CodexAppServer] Write failed after shutdown", error);
      return false;
    }
  }

  private rejectAllPending(error: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.reject(error);
  }
}
