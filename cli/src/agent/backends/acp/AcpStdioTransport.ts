// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { logger } from "@/ui/logger";
import { killProcessByChildProcess } from "@/utils/process";
import { isObject } from "@/agent/utils";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type RequestHandler = (
  params: unknown,
  requestId: string | number | null
) => Promise<unknown>;

/**
 * The JSON-RPC transport contract the ACP backend depends on (issue #3127).
 *
 * `AcpSdkBackend` talks to its transport through exactly these five methods, so
 * this interface is the seam that lets the backend accept a fake transport in
 * tests (the ACP handshake/round-trip is otherwise only observable by spawning a
 * real CLI subprocess, which CI cannot do). {@link AcpStdioTransport} is the
 * production implementation (spawns the real subprocess); a test transport
 * captures the exact wire payloads. This is deliberately the transport SHARED
 * with the ACP ingress path (#1906) — keep it a behavior-preserving structural
 * contract, not a framing change.
 */
export interface AcpTransport {
  onNotification(
    handler: ((method: string, params: unknown) => void) | null
  ): void;
  registerRequestHandler(method: string, handler: RequestHandler): void;
  sendRequest(method: string, params?: unknown): Promise<unknown>;
  sendNotification(method: string, params?: unknown): void;
  close(): Promise<void>;
}

/**
 * Spawn-mode construction options (existing behavior — the client egress path
 * `AcpSdkBackend` uses). Unchanged by issue #1906.
 */
export interface AcpStdioSpawnOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Streams-mode construction options (issue #1906 — ACP ingress). Binds the
 * JSON-RPC framing to caller-supplied streams (e.g. the agent's own
 * `process.stdin`/`process.stdout`) instead of a spawned child's stdio.
 * `onDisconnect` fires when the input stream ends/closes — the streams-mode
 * analog of spawn mode's child-exit handler, which is otherwise the ONLY
 * disconnect detector the framing has.
 */
export interface AcpStdioStreamsOptions {
  input: Readable;
  output: Writable;
  onDisconnect?: () => void;
}

/**
 * Max un-terminated (no `\n` yet) receive-buffer length, in UTF-16 code units
 * (`this.buffer` is a JS string, not a byte buffer). ~10M chars ≈ 20MB RAM — a
 * generous ceiling for a large pasted prompt while bounding an unbounded-growth
 * OOM from a client that never sends a newline (issue #3260, R2). Tunable; the
 * exact number is not load-bearing.
 */
const MAX_FRAME_CHARS = 10 * 1024 * 1024;

export class AcpStdioTransport implements AcpTransport {
  /** The spawned child in spawn mode; `null` in streams mode (#1906). */
  private readonly childProcess: ChildProcessWithoutNullStreams | null;
  /** Stream the framing READS JSON-RPC lines from (child stdout / injected input). */
  private readonly input: Readable;
  /** Stream the framing WRITES JSON-RPC lines to (child stdin / injected output). */
  private readonly output: Writable;
  /** Streams-mode disconnect callback (input end/close, or fail-shut). */
  private readonly onDisconnect: (() => void) | null;
  private readonly pending = new Map<
    string | number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private notificationHandler:
    | ((method: string, params: unknown) => void)
    | null = null;
  private buffer = "";
  private nextId = 1;
  private protocolError: Error | null = null;
  /**
   * Separate from {@link protocolError} (the INBOUND gate): a write failure
   * says nothing about whether the peer's inbound frames are still parseable,
   * so reusing `protocolError` for an output fault would silently fail-shut the
   * inbound channel too (issue #3260, R3). Latches `handleOutputError` against
   * re-entrancy and makes subsequent `writePayload` calls a no-op.
   */
  private outputBroken = false;

  constructor(options: AcpStdioSpawnOptions | AcpStdioStreamsOptions) {
    if ("command" in options) {
      // Spawn mode — UNCHANGED behavior for the client egress path
      // (AcpSdkBackend). All I/O routes through `input`/`output` below, which
      // point at the child's stdout/stdin, so the wire behavior is identical.
      const child = spawn(options.command, options.args ?? [], {
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.childProcess = child;
      this.input = child.stdout;
      this.output = child.stdin;
      this.onDisconnect = null;

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => this.handleStdout(chunk));
      // R3 (input side, issue #3260): an `'error'` on the child's stdout
      // (ECONNRESET/EIO) is the same fatal class as an output-side EPIPE under
      // this transport's "no global net" framing — reject pending rather than
      // letting it become an unhandled stream error.
      child.stdout.on("error", error => {
        logger.debug("[ACP] Child stdout stream error", error);
        this.rejectAllPending(
          error instanceof Error ? error : new Error(String(error))
        );
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => {
        logger.debug(`[ACP][stderr] ${chunk.toString().trim()}`);
      });

      child.on("exit", (code, signal) => {
        const message = `ACP process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
        logger.debug(message);
        this.rejectAllPending(new Error(message));
      });

      child.on("error", error => {
        logger.debug("[ACP] Process error", error);
        const message = error instanceof Error ? error.message : String(error);
        this.rejectAllPending(
          new Error(
            `Failed to spawn ${options.command}: ${message}. Is it installed and on PATH?`,
            { cause: error }
          )
        );
      });
    } else {
      // Streams mode (#1906 ingress) — no child process; bind to injected streams.
      this.childProcess = null;
      this.input = options.input;
      this.output = options.output;
      this.onDisconnect = options.onDisconnect ?? null;

      this.input.setEncoding("utf8");
      this.input.on("data", chunk => this.handleStdout(chunk));

      // The input end/close IS the disconnect detector in streams mode (spawn
      // mode uses the child-exit handler above). Tear down pending requests and
      // notify the owner so it can close sessions / in-flight turns.
      const handleInputEnd = (): void => {
        logger.debug("[ACP] Input stream ended (client disconnect)");
        this.rejectAllPending(new Error("ACP input stream ended"));
        this.onDisconnect?.();
      };
      this.input.on("end", handleInputEnd);
      this.input.on("close", handleInputEnd);
      // R3 (input side, issue #3260): an `'error'` on the input stream
      // (ECONNRESET/EIO on a dying editor pty) is the same fatal class as an
      // output-side EPIPE — reuse the existing disconnect path.
      this.input.on("error", error => {
        logger.debug("[ACP] Input stream error", error);
        handleInputEnd();
      });
    }

    // R3 (issue #3260): a single output-error listener covers both modes —
    // `this.output` is assigned in both branches above before this line runs.
    this.output.on("error", error => this.handleOutputError(error));
  }

  /**
   * Streams-mode factory (issue #1906 — ACP ingress). Binds the JSON-RPC framing
   * to caller-supplied streams (the agent's own stdio) rather than a spawned
   * child. The spawn-mode constructor is unchanged; egress callers are untouched.
   */
  static fromStreams(options: AcpStdioStreamsOptions): AcpStdioTransport {
    return new AcpStdioTransport(options);
  }

  onNotification(
    handler: ((method: string, params: unknown) => void) | null
  ): void {
    this.notificationHandler = handler;
  }

  registerRequestHandler(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  async sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writePayload(payload);
    });
  }

  sendNotification(method: string, params?: unknown): void {
    const payload: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.writePayload(payload);
  }

  async close(): Promise<void> {
    if (this.childProcess) {
      this.output.end();
      await killProcessByChildProcess(this.childProcess);
      this.rejectAllPending(new Error("ACP transport closed"));
    } else {
      // Streams mode (#1906): no child to kill. Reject pending and end our
      // output channel (the agent is shutting down). The owner controls the
      // input stream / process lifecycle.
      this.rejectAllPending(new Error("ACP transport closed"));
      this.output.end();
    }
  }

  private handleStdout(chunk: string): void {
    // Latch coherence (issue #3260): `handleLine` is gated on `protocolError`
    // but `handleStdout` was not — stop accumulating for this connection at
    // the chunk boundary too, so a peer that keeps sending after a fail-shut
    // can't keep growing (then discarding) the buffer.
    if (this.protocolError) {
      this.buffer = "";
      return;
    }
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");

    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        this.handleLine(line);
      }

      newlineIndex = this.buffer.indexOf("\n");
    }

    // R2: bound the un-terminated (no `\n` yet) residual buffer. Checked AFTER
    // the drain loop, on the residual only — checking before draining would
    // false-positive on a burst of many small complete frames whose transient
    // concatenation momentarily exceeds the cap.
    if (this.buffer.length > MAX_FRAME_CHARS) {
      this.failProtocol(
        new Error(
          `ACP frame exceeded ${MAX_FRAME_CHARS} chars without a newline`
        )
      );
    }
  }

  private handleLine(line: string): void {
    if (this.protocolError) {
      return;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      logger.debug("[ACP] Failed to parse JSON-RPC line", { line, error });
      this.failProtocol(new Error("Failed to parse JSON-RPC from ACP agent"));
      return;
    }

    if (!isObject(parsed)) {
      // R1: a frame that parsed to a JSON primitive (`1`, `true`, `"hi"`) or an
      // array is not a JSON-RPC message. Drop it and keep the connection alive
      // (KD-7: unlike an unparseable line, this is a complete, aligned frame —
      // tearing down every multiplexed session over a stray `42` would be
      // wildly disproportionate). `isObject([]) === true`, so an array frame
      // passes this gate and is silently dropped by the method/id checks below.
      logger.debug("[ACP] Ignoring non-object JSON-RPC frame", { line });
      return;
    }
    // `parsed` is narrowed to `Record<string, unknown>` by `isObject`, which
    // doesn't "sufficiently overlap" the JSON-RPC interfaces for a single-step
    // assertion (OR-1) — go through `unknown` to assert the union.
    const message = parsed as unknown as
      | JsonRpcRequest
      | JsonRpcResponse
      | JsonRpcNotification;

    if (message && "method" in message) {
      if ("id" in message && message.id !== undefined) {
        this.handleIncomingRequest(message as JsonRpcRequest).catch(error => {
          logger.debug("[ACP] Error handling request", error);
        });
        return;
      }
      this.notificationHandler?.(message.method, message.params ?? null);
      return;
    }

    if (message && "id" in message) {
      this.handleResponse(message as JsonRpcResponse);
    }
  }

  private async handleIncomingRequest(request: JsonRpcRequest): Promise<void> {
    const handler = this.requestHandlers.get(request.method);
    if (!handler) {
      this.writePayload({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32601,
          message: `Method not found: ${request.method}`,
        },
      } satisfies JsonRpcResponse);
      return;
    }

    try {
      const result = await handler(request.params ?? null, request.id ?? null);
      this.writePayload({
        jsonrpc: "2.0",
        id: request.id,
        result,
      } satisfies JsonRpcResponse);
    } catch (error) {
      this.writePayload({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal error",
        },
      } satisfies JsonRpcResponse);
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    if (response.id === null || response.id === undefined) {
      logger.debug("[ACP] Received response without id");
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      logger.debug(
        "[ACP] Received response with no pending request",
        response.id
      );
      return;
    }

    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(new Error(response.error.message));
      return;
    }

    pending.resolve(response.result);
  }

  private writePayload(
    payload: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse
  ): void {
    if (this.outputBroken) return; // no-op once the output is known dead
    const serialized = JSON.stringify(payload);
    try {
      this.output.write(`${serialized}\n`);
    } catch (error) {
      // R3: catches exactly ONE thing — a wrapping `Writable` whose own
      // `write()` implementation throws synchronously. EPIPE / write-after-end
      // are reported asynchronously via the `'error'` listener below, not here.
      logger.debug("[ACP] output.write threw", error);
      this.handleOutputError(error);
    }
  }

  /**
   * R3: handle a write failure on the output stream — a synchronous throw from
   * `writePayload` above, or an asynchronous `'error'` event (EPIPE on a dead
   * peer, `ERR_STREAM_WRITE_AFTER_END`, `ERR_STREAM_DESTROYED`). Treated as a
   * disconnect, not a crash. `sendRequest` registers its promise in
   * `this.pending` BEFORE calling `writePayload`, so this MUST actively reject
   * pending requests — otherwise a permission-bridge `sendRequest` on a
   * demonstrably-dead pipe hangs its full timeout instead of failing fast.
   */
  private handleOutputError(error: unknown): void {
    if (this.outputBroken) return;
    this.outputBroken = true;
    const err = error instanceof Error ? error : new Error(String(error));
    logger.debug("[ACP] Output stream error", err);
    this.rejectAllPending(err);
    if (this.childProcess) {
      // Spawn mode (ruling D6, issue #3260): an output error is not proof the
      // child is dead — the existing `child.on("exit")` handler already
      // rejects pending on real child death, and killing here would change
      // spawn-path behavior. A wedged-but-alive child lingers until close().
      logger.debug(
        "[ACP] Output error in spawn mode — not killing child (ruling D6)"
      );
    } else {
      this.onDisconnect?.();
    }
  }

  /**
   * Fail-shut the whole connection: latch {@link protocolError}, release the
   * buffer, reject every pending request, and tear down (spawn: end the
   * output + kill the child; streams: notify the owner to disconnect).
   * Idempotent — a second call while already latched is a no-op (issue #3260,
   * R2: a peer that keeps sending past the cap needs another full cap's worth
   * of un-newlined data to re-cross it, and every consequence here is already
   * idempotent, so this guard just keeps a re-fire cheap and side-effect-free).
   */
  private failProtocol(error: Error): void {
    if (this.protocolError) return;
    this.protocolError = error;
    logger.debug("[ACP] Protocol failure — tearing down connection", error);
    this.buffer = "";
    this.rejectAllPending(error);
    if (this.childProcess) {
      this.output.end();
      void killProcessByChildProcess(this.childProcess);
    } else {
      // Streams mode (#1906): no child to kill, and no request id to answer
      // with -32700. The `protocolError` latch already fail-shuts every
      // subsequent line; notify the owner to tear down the now-corrupt session.
      this.onDisconnect?.();
    }
  }

  private rejectAllPending(error: Error): void {
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  }
}
