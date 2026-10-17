// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `DaemonContext` — the dependency-injection struct that replaces the implicit
 * closure capture inside `startDaemon` (issue #2081, Epic #2077 Sub-Issue D).
 *
 * Before the decomposition, `run.ts`'s `startDaemon` held every piece of shared
 * daemon state (tracked-session maps, API clients, background services, the
 * shutdown handle) as `const`/`let` bindings inside one 3,600-line function, and
 * the nested helpers captured them by closure. The extracted modules
 * (`sessionTracker`, `sessionSpawner`, `healthScheduler`) can no longer close
 * over those bindings, so they receive this struct instead — a mutable object
 * assembled incrementally in `run.ts`'s init sequence (members are created at
 * different lifecycle points, so the struct is populated field-by-field as init
 * proceeds, NOT constructed all at once).
 *
 * The tracked-session `Map`s are created once and never reassigned — only
 * mutated via `.set()`/`.delete()` — so a module that destructures them from
 * `ctx` shares the exact same object reference (identical to the prior closure
 * capture). Late-assigned clients/services (`api`, `apiMachine`,
 * `tokenRefreshService`, …) are read from `ctx` at call time by the extracted
 * functions, so their forward-reference-via-closure semantics are preserved:
 * every extracted function is only ever invoked (via the control-server RPC
 * handlers, the maintenance loop, or the `onReady` handles) after full daemon
 * startup, by which point every member is assigned.
 *
 * `machine` and `daemonLockHandle` are deliberately NOT members: they are used
 * only by `run.ts`'s own lifecycle (machine creation, `cleanupAndShutdown` lock
 * release), never by an extracted module.
 */
import type { ApiClient } from "@/api/api";
import type { TokenRefreshService } from "@/accounts/tokenRefreshService";
import type { JobRegistry } from "@hapi/protocol";
import type { TrackedSession } from "./types";
import type { DaemonLocallyPersistedState } from "@/persistence";
import type { OwnStateWriter } from "./daemonStateOwnership";

/** Source of a daemon shutdown request (matches `startDaemon`'s union). */
export type ShutdownSource =
  | "hapi-app"
  | "hapi-cli"
  | "os-signal"
  | "exception";

/** The shutdown-request callback assigned inside `startDaemon`'s shutdown promise. */
export type RequestShutdownFn = (
  source: ShutdownSource,
  errorMessage?: string
) => void;

/**
 * Injectable clock seams for the daemon's `SupervisedLoop`s (#2079). Every field
 * is optional; `undefined` in production ⇒ `SupervisedLoop` uses the globals
 * (`?? Date.now`, etc.). A structural subset of `StartDaemonTestSeams`, so
 * `run.ts` can pass its `testSeams` directly to `createHealthScheduler`.
 */
export interface ClockSeams {
  now?: () => number;
  setTimeoutFn?: (
    handler: () => void,
    ms: number
  ) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Shared daemon state, injected into the extracted daemon modules in place of
 * closure capture. Assembled incrementally in `run.ts` — some fields are
 * assigned after the struct is first created (see the module-level doc comment).
 */
export interface DaemonContext {
  // --- Tracked-session state maps (created early; stable references) --------
  /** Live tracked sessions keyed by PID. */
  pidToTrackedSession: Map<number, TrackedSession>;
  /** Spawn awaiters keyed by shell/host PID (resolved by the session webhook). */
  pidToAwaiter: Map<number, (session: TrackedSession) => void>;
  /** tmux shell PID → the session awaiting descendant-PID population. */
  shellPidToTrackedSession: Map<number, TrackedSession>;

  // --- Infra clients / services (assigned incrementally during init) -------
  /** The HTTP API client. */
  api: ApiClient;
  /** This daemon process's job registry (supervised loops register here). */
  daemonJobRegistry: JobRegistry;
  /** The job-registry node label (`machineId ?? "standalone"`). */
  daemonJobNode: string;
  /** Proactive OAuth token-refresh scheduler. */
  tokenRefreshService: TokenRefreshService;
  /**
   * Issue #4423: this daemon is the machine rotator — the only daemon on the
   * machine whose idle backstop proactively rotates the shared isolated
   * credentials (not a worktree-instance daemon, and HAPI_IDLE_REFRESH on).
   * Evaluated once at daemon start (`resolveMachineRotatorRole`); the
   * maintenance tick gates `refreshIdleIsolatedAccounts` on it. The stale-flag
   * clear and spawn-time recovery are NOT gated by it.
   */
  machineRotator: boolean;
  /**
   * Issue #4349 (R3): this daemon runs on a TENANT VM (`isTenantVm()`, evaluated once at boot).
   * The maintenance tick and the spawn path skip every Hapimatic-driven provider-credential step
   * (refresh, flag clear, store mirror, instance-token delivery). Optional so a context built
   * without it (tests, pre-#4349 callers) reads as not-a-tenant.
   */
  tenantVm?: boolean;
  /** The daemon control server's bearer token (spawned children call back with it). */
  controlToken: string;
  /** The daemon control server's bound port. */
  controlPort: number;
  /** The installed-CLI mtime captured at daemon start; recorded in daemon.state.json, acted on by no code since #4590. */
  startedWithCliMtimeMs: number | undefined;
  /** The daemon's locally-persisted state record. */
  fileState: DaemonLocallyPersistedState;
  /**
   * Issue #3731 (R0/R0b): the node's instance credential — the onboarding
   * `CLAUDE_CODE_OAUTH_TOKEN` the daemon captured from its service env at boot.
   * The daemon deletes the AMBIENT copy from `process.env` once the account store
   * can serve the primary account, so no tmux server or child inherits it; this
   * held copy is delivered EXPLICITLY (tmux arm: the 0600 spawn env file; direct
   * arm: the child's spawn env) to strictly unbound claude spawns only — never to a
   * bound or host-default spawn, and never over a token passed with the request. Absent on
   * nodes without an onboarding token (e.g. RP1). Never logged.
   */
  instanceOAuthToken?: string;
  /**
   * Issue #3731 (R4, F3): set once a bound tmux spawn's global-table probe makes a
   * SUCCESSFUL read that finds no token — including a "no server" answer, which on
   * the daemon's OWN socket means there is no table yet (`classifyTableProbe`
   * reads it as clean). A failed or timed-out read never sets it. It stops the
   * probe costing a tmux round-trip per spawn. A stale entry
   * lives only in a server that survived the deploy (the next `createWindow`
   * scrubs it), and the daemon is the only creator of its socket's server; a
   * token the daemon never released is still reported by the daemon-env check.
   */
  ambientTokenTableProbeClean?: boolean;
  /**
   * Issue #4153 (A4): the failure reasons the spawn-time table probe has already
   * logged, so each distinct reason is logged once rather than on every bound
   * spawn. Reasons are value-free (`GlobalEnvRead.error`).
   */
  ambientTokenProbeFailuresLogged?: Set<string>;

  // --- Shutdown ------------------------------------------------------------
  /** Requests a graceful daemon shutdown (assigned in the shutdown promise). */
  requestShutdown: RequestShutdownFn;
  /**
   * Issue #4155 (R3): true once ANY shutdown was requested (signal, `/stop`,
   * exception, replacement). A function — not a boolean — because modules
   * destructure `ctx` once at construction. The daemon never writes
   * daemon.state.json after this turns true.
   */
  isShutdownRequested: () => boolean;
  /**
   * Issue #4155 (R11): the single compare-and-write path for every post-boot
   * write of daemon.state.json (heartbeat + onboarding-token disposition).
   */
  ownStateWriter: OwnStateWriter;
}
