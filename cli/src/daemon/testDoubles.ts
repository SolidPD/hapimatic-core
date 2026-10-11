// SPDX-License-Identifier: MIT
/**
 * Test doubles for the `startDaemon` characterization tests (issue #2079,
 * Epic #2077 Sub-Issue B). These are fake adapters + fixture builders + process
 * spies used by `run.test.ts` to drive the daemon lifecycle IN-PROCESS with all
 * real I/O faked — the complement to the out-of-process, env-gated
 * `daemon.integration.test.ts`.
 *
 * Design: the heavy module mocks (`vi.mock(...)`) live in `run.test.ts` (they
 * must be hoisted above the `run.ts` import). This module holds the reusable
 * builders that the test BODY / `beforeEach` composes — fixtures, a fake
 * `TmuxManager`, a fake API client, `process.exit`/`process.on` spies, and a
 * controllable clock for the `SupervisedLoop` seam. No production code path
 * imports this file.
 */
import { vi } from "vitest";
import type { RecoveredSessionInfo } from "./recoveryIntegration";
import type { SpawnSessionOptions } from "@/modules/common/rpcTypes";
import type { Metadata } from "@/api/types";

// --- Fixture builders --------------------------------------------------------

/** A genuinely-recovered session (`needsReconnect:false`) unless overridden. */
export function makeRecoveredSession(
  overrides: Partial<RecoveredSessionInfo> = {}
): RecoveredSessionInfo {
  return {
    hapiSessionId: "sess-recovered",
    tmuxWindow: "win-recovered",
    tmuxWindowIndex: 0,
    needsReconnect: false,
    ...overrides,
  };
}

/** Minimal valid spawn options (a real, non-blocked absolute directory). */
export function makeSpawnOptions(
  overrides: Partial<SpawnSessionOptions> = {}
): SpawnSessionOptions {
  return { directory: "/home/tester/project", ...overrides };
}

/** Minimal session-webhook metadata (only `hostPid` is load-bearing here). */
export function makeMetadata(overrides: Partial<Metadata> = {}): Metadata {
  return { hostPid: 4242, ...overrides } as unknown as Metadata;
}

// --- process.exit / process.on spies ----------------------------------------

export interface ProcessSpies {
  exit: ReturnType<typeof vi.spyOn>;
  on: ReturnType<typeof vi.spyOn>;
  kill: ReturnType<typeof vi.spyOn>;
  /** Retrieve a captured signal/event handler (e.g. `"SIGTERM"`). */
  getHandler: (event: string) => ((...args: unknown[]) => unknown) | undefined;
  restore: () => void;
}

/**
 * Spy `process.exit` (no-op — so the daemon's fast-path/cleanup exits don't kill
 * the test runner), `process.on` (capture the signal handlers so tests can fire
 * SIGTERM/uncaughtException by hand), and `process.kill` (no-op — CRITICAL: the
 * maintenance tick's MCP-orphan reaper calls the RAW `process.kill` on pids from
 * a real `pgrep`; without this spy a test could SIGTERM real MCP servers on the
 * machine). Returns the spies + a `getHandler` accessor + a `restore()`.
 */
export function installProcessSpies(): ProcessSpies {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const on = vi.spyOn(process, "on").mockImplementation(((
    event: string,
    handler: (...args: unknown[]) => unknown
  ) => {
    handlers.set(event, handler);
    return process;
  }) as never);
  const kill = vi
    .spyOn(process, "kill")
    .mockImplementation((() => true) as never);
  return {
    exit,
    on,
    kill,
    getHandler: event => handlers.get(event),
    restore: () => {
      exit.mockRestore();
      on.mockRestore();
      kill.mockRestore();
    },
  };
}

// --- Fake TmuxManager --------------------------------------------------------

export interface FakeTmuxConfig {
  /** `getWindowPid(name)` lookup — omit or null ⇒ window has no pid. */
  windowPids?: Record<string, number | null>;
  /** `listWindows()` return (drives `computeEffectiveCount` + orphan sweep). */
  windows?: Array<{ name: string; panePid?: number; paneDead?: boolean }>;
  /** `hasActiveChildren(pid)` predicate (default: false). */
  activeChildren?: (pid: number) => boolean | Promise<boolean>;
}

/** A configurable fake of `@/tmux`'s `TmuxManager` (only the methods run.ts calls). */
export function makeFakeTmuxManager(config: FakeTmuxConfig = {}) {
  return {
    getWindowPid: vi.fn(
      async (name: string) => config.windowPids?.[name] ?? null
    ),
    listWindows: vi.fn(async () => config.windows ?? []),
    hasActiveChildren: vi.fn(async (pid: number) =>
      config.activeChildren ? config.activeChildren(pid) : false
    ),
    getWindowNameByIndex: vi.fn(async () => ({
      ok: true as const,
      name: null,
    })),
    isPaneDead: vi.fn(async () => false),
    windowExists: vi.fn(async () => false),
    killWindow: vi.fn(async () => undefined),
  };
}

// --- Fake API client + machine-sync client -----------------------------------

export interface FakeApiMachine {
  setRPCHandlers: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
  updateDaemonState: ReturnType<typeof vi.fn>;
}

export function makeFakeApiMachine(): FakeApiMachine {
  return {
    setRPCHandlers: vi.fn(),
    connect: vi.fn(),
    shutdown: vi.fn(),
    updateDaemonState: vi.fn(async () => undefined),
  };
}

/** A fake `ApiClient` instance whose `machineSyncClient()` returns `apiMachine`. */
export function makeFakeApi(apiMachine: FakeApiMachine) {
  return {
    getOrCreateMachine: vi.fn(async () => ({ id: "machine-1" })),
    machineSyncClient: vi.fn(() => apiMachine),
    reportAccountCaptured: vi.fn(async () => undefined),
    updateMcpStatus: vi.fn(async () => undefined),
  };
}

// --- Controllable clock (SupervisedLoop seam) --------------------------------

export interface ControllableClock {
  now: () => number;
  setTimeoutFn: (
    handler: () => void,
    ms: number
  ) => ReturnType<typeof setTimeout>;
  clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void;
  /** Advance virtual time by `ms`, firing any timers whose deadline has passed. */
  advance: (ms: number) => void;
}

/**
 * A hermetic virtual clock for the two `SupervisedLoop` constructors (threaded
 * via `testSeams.now` / `setTimeoutFn` / `clearTimeoutFn`). Lets a test advance
 * time deterministically without global fake timers. The heartbeat tests prefer
 * `maintenanceLoop.triggerNow()` (exposed via the `onReady` handles); this clock
 * is the fallback for actions gated behind an interval counter.
 */
export function makeControllableClock(startMs = 0): ControllableClock {
  let current = startMs;
  let seq = 0;
  const pending = new Map<number, { deadline: number; handler: () => void }>();
  return {
    now: () => current,
    setTimeoutFn: (handler, ms) => {
      const id = ++seq;
      pending.set(id, { deadline: current + ms, handler });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: handle => {
      pending.delete(handle as unknown as number);
    },
    advance: ms => {
      current += ms;
      for (const [id, timer] of Array.from(pending.entries())) {
        if (timer.deadline <= current) {
          pending.delete(id);
          timer.handler();
        }
      }
    },
  };
}
