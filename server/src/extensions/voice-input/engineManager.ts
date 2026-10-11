// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Transcription engines for voice input (issue #4707).
 *
 * `TranscriptionEngine` is the adapter seam: Sub-Issue B (#4708) adds
 * OpenAI-format providers behind the same `/api/voice/transcribe` route.
 *
 * `LocalParakeetEngine` runs `hapi voice-engine` as a CHILD process:
 *  - started on demand (first request or a warm-up), one request at a time;
 *  - killed after `idleUnloadSeconds` without a request, which returns all of
 *    its ~1.1 GB to the OS (an in-process unload measurably does not);
 *  - refuses to start when MemAvailable is below MIN_AVAILABLE_MB;
 *  - a crash fails the in-flight request and the next request starts fresh
 *    (one automatic retry for a request whose child died before answering).
 */
import { readFileSync } from "node:fs";
import { freemem } from "node:os";
import {
  parseVoiceWorkerLine,
  type VoiceErrorCode,
  type VoiceTranscribeResponse,
  type VoiceWorkerMessage,
} from "@hapi/protocol/voice";

export const MIN_AVAILABLE_MB = 1536;
export const MAX_WAITING_REQUESTS = 3;
export const READY_TIMEOUT_MS = 60_000;

export class VoiceEngineError extends Error {
  constructor(
    readonly code: VoiceErrorCode,
    message: string,
    readonly status: 400 | 409 | 413 | 429 | 500 | 503 = 503
  ) {
    super(message);
  }
}

export type EngineRuntimeState = "idle" | "loading" | "loaded" | "error";

export interface TranscriptionEngine {
  readonly id: string;
  runtimeState(): EngineRuntimeState;
  lastError(): string | null;
  warm(): Promise<void>;
  transcribe(
    wav: Uint8Array,
    audioSeconds: number
  ): Promise<VoiceTranscribeResponse>;
  unload(): Promise<void>;
}

/** Minimal child-process surface, so tests can supply a fake. */
export interface EngineChild {
  write(line: string): void;
  lines: AsyncIterable<string>;
  stderrTail(): string;
  exited: Promise<number>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export type SpawnEngine = (argv: string[]) => EngineChild;

export interface LocalEngineDeps {
  /** argv for the worker, or a VoiceEngineError explaining why it cannot run. */
  launchArgv: () => string[];
  spawn?: SpawnEngine;
  memAvailableMb?: () => number;
  idleUnloadMs: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

interface Pending {
  resolve: (msg: VoiceWorkerMessage) => void;
  reject: (err: Error) => void;
  timer: unknown;
}

interface Running {
  child: EngineChild;
  ready: Promise<void>;
  pending: Map<number, Pending>;
  stopping: boolean;
}

export function readMemAvailableMb(): number {
  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(
      readFileSync("/proc/meminfo", "utf8")
    );
    if (match) return Math.floor(Number(match[1]) / 1024);
  } catch {
    // fall through
  }
  return Math.floor(freemem() / 1024 / 1024);
}

/** Bun.spawn-backed child with NDJSON stdout lines and a bounded stderr tail. */
export function spawnBunEngine(argv: string[]): EngineChild {
  const proc = Bun.spawn(argv, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let tail = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
      tail = (tail + decoder.decode(chunk)).slice(-2048);
    }
  })().catch(() => {});
  async function* lines(): AsyncIterable<string> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        yield buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer) yield buffer;
  }
  return {
    write(line) {
      // A child that exits mid-request makes the pending flush reject with
      // EPIPE. Swallow it: the exited handler fails the pending request, and
      // an unhandled rejection would take the whole server down.
      try {
        proc.stdin.write(`${line}\n`);
        void Promise.resolve(proc.stdin.flush()).catch(() => {});
      } catch {
        // the child is already gone; same as above
      }
    },
    lines: lines(),
    stderrTail: () => tail,
    exited: proc.exited,
    kill(signal) {
      try {
        proc.kill(signal);
      } catch {
        // already exited
      }
    },
  };
}

export class LocalParakeetEngine implements TranscriptionEngine {
  readonly id = "parakeet-local";
  private running: Running | null = null;
  private state: EngineRuntimeState = "idle";
  private error: string | null = null;
  private nextId = 1;
  private chain: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private idleTimer: unknown = null;
  private readonly spawn: SpawnEngine;
  private readonly memAvailableMb: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly now: () => number;

  constructor(private readonly deps: LocalEngineDeps) {
    this.spawn = deps.spawn ?? spawnBunEngine;
    this.memAvailableMb = deps.memAvailableMb ?? readMemAvailableMb;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      deps.clearTimer ??
      (h => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.now = deps.now ?? (() => performance.now());
  }

  runtimeState(): EngineRuntimeState {
    return this.state;
  }

  lastError(): string | null {
    return this.error;
  }

  async warm(): Promise<void> {
    await this.start();
    this.armIdle();
  }

  transcribe(
    wav: Uint8Array,
    audioSeconds: number
  ): Promise<VoiceTranscribeResponse> {
    if (this.waiting >= MAX_WAITING_REQUESTS + 1) {
      return Promise.reject(
        new VoiceEngineError(
          "engine_busy",
          "voice engine is busy; try again shortly",
          429
        )
      );
    }
    this.waiting++;
    const run = this.chain.then(() => this.runOne(wav, audioSeconds));
    this.chain = run.catch(() => {});
    return run.finally(() => {
      this.waiting--;
      this.armIdle();
    });
  }

  async unload(): Promise<void> {
    this.disarmIdle();
    const running = this.running;
    if (!running) return;
    running.stopping = true;
    this.running = null;
    this.state = "idle";
    running.child.kill("SIGTERM");
    const killTimer = this.setTimer(() => running.child.kill("SIGKILL"), 5000);
    await running.child.exited.catch(() => 0);
    this.clearTimer(killTimer);
  }

  private async runOne(
    wav: Uint8Array,
    audioSeconds: number
  ): Promise<VoiceTranscribeResponse> {
    this.disarmIdle();
    for (let attempt = 0; ; attempt++) {
      const running = await this.start();
      const started = this.now();
      try {
        const msg = await this.request(running, wav, audioSeconds);
        if ("ok" in msg && msg.ok) {
          return {
            text: msg.text,
            audioSeconds: msg.audioSeconds,
            decodeMs: msg.decodeMs ?? Math.round(this.now() - started),
          };
        }
        const error = "error" in msg ? msg.error : "transcription failed";
        const invalidAudio = error.startsWith("invalid audio");
        throw new VoiceEngineError(
          invalidAudio ? "invalid_audio" : "engine_unavailable",
          error,
          invalidAudio ? 400 : 503
        );
      } catch (error) {
        const crashed = error instanceof ChildExitedError;
        if (crashed && attempt === 0) continue; // fresh child, one retry
        throw error instanceof VoiceEngineError
          ? error
          : new VoiceEngineError(
              "engine_unavailable",
              error instanceof Error ? error.message : String(error)
            );
      }
    }
  }

  private request(
    running: Running,
    wav: Uint8Array,
    audioSeconds: number
  ): Promise<VoiceWorkerMessage> {
    const id = this.nextId++;
    return new Promise<VoiceWorkerMessage>((resolve, reject) => {
      const timeoutMs = 30_000 + Math.ceil(audioSeconds * 500);
      const timer = this.setTimer(() => {
        running.pending.delete(id);
        reject(
          new VoiceEngineError(
            "engine_unavailable",
            `transcription timed out after ${Math.round(timeoutMs / 1000)} s`
          )
        );
        // A hung decode leaves the child unusable; restart it next time.
        void this.unload();
      }, timeoutMs);
      running.pending.set(id, { resolve, reject, timer });
      running.child.write(
        JSON.stringify({
          id,
          type: "transcribe",
          wavB64: Buffer.from(wav).toString("base64"),
        })
      );
    });
  }

  private async start(): Promise<Running> {
    if (this.running) {
      await this.running.ready;
      return this.running;
    }
    const argv = this.deps.launchArgv();
    const available = this.memAvailableMb();
    if (available < MIN_AVAILABLE_MB) {
      throw new VoiceEngineError(
        "insufficient_memory",
        `not enough free memory to load the speech engine (${available} MB available, ${MIN_AVAILABLE_MB} MB needed)`
      );
    }
    this.state = "loading";
    this.error = null;
    const child = this.spawn(argv);
    let markReady: () => void = () => {};
    let failReady: (e: Error) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    const running: Running = {
      child,
      ready,
      pending: new Map(),
      stopping: false,
    };
    this.running = running;
    const readyTimer = this.setTimer(() => {
      failReady(
        new VoiceEngineError(
          "engine_unavailable",
          "speech engine did not start within 60 s"
        )
      );
      void this.unload();
    }, READY_TIMEOUT_MS);

    void (async () => {
      for await (const line of child.lines) {
        const msg = parseVoiceWorkerLine(line);
        if (!msg) continue;
        if ("type" in msg) {
          this.clearTimer(readyTimer);
          if (this.running === running) this.state = "loaded";
          markReady();
          continue;
        }
        const pending = running.pending.get(msg.id);
        if (pending) {
          running.pending.delete(msg.id);
          this.clearTimer(pending.timer);
          pending.resolve(msg);
        } else if (msg.id === -1 && !msg.ok) {
          // An unparseable request; fail the oldest pending one.
          const first = running.pending.entries().next();
          if (!first.done) {
            const [pid, p] = first.value;
            running.pending.delete(pid);
            this.clearTimer(p.timer);
            p.resolve(msg);
          }
        }
      }
    })().catch(() => {});

    void child.exited.then(code => {
      this.clearTimer(readyTimer);
      const err = new ChildExitedError(
        `speech engine exited (code ${code})${child.stderrTail() ? `: ${child.stderrTail().trim().split("\n").slice(-2).join(" | ")}` : ""}`
      );
      failReady(err);
      for (const [, p] of running.pending) {
        this.clearTimer(p.timer);
        p.reject(err);
      }
      running.pending.clear();
      if (this.running === running) {
        this.running = null;
        if (!running.stopping) {
          this.state = "error";
          this.error = err.message;
        } else {
          this.state = "idle";
        }
      }
    });

    try {
      await ready;
    } catch (error) {
      throw error instanceof VoiceEngineError
        ? error
        : new VoiceEngineError(
            "engine_unavailable",
            error instanceof Error ? error.message : String(error)
          );
    }
    return running;
  }

  private armIdle(): void {
    this.disarmIdle();
    if (!this.running || this.waiting > 0) return;
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = null;
      if (this.waiting === 0) void this.unload();
    }, this.deps.idleUnloadMs());
  }

  private disarmIdle(): void {
    if (this.idleTimer !== null) {
      this.clearTimer(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

class ChildExitedError extends Error {}
