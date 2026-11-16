// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The runner identity test rig (issue #6647, Tasks 14 and 15).
 *
 * One `SyncEngine` over a file-backed store, a fake socket.io server with a
 * real `/cli` room, a fake daemon and fake timers. A runner attaches through
 * the engine's own attach step and the route's `attachOrRefuse` (so a refusal
 * is the route's 409 body), connects through the `/cli` middleware's identity
 * step and then the real connection handler, and reports through the real
 * session handlers into the engine. The registry reads the room and looks a
 * socket up the way `server/src/index.ts` and `server/src/socket/server.ts`
 * bind it in production.
 *
 * It takes the identity mode and the billable mode as arguments and reads no
 * environment variable. Every name in it is invented. `close()` puts the real
 * timers back and removes the database file.
 */
import { jest, setSystemTime } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerIdentityMode } from "@hapi/protocol";
import type { Server } from "socket.io";

import type { BillableMode } from "../billable/mode";
import type { ErrorLogOptions } from "../logging/errorLogger";
import { ClaudePtyRegistry } from "../socket/claudePtyRegistry";
import { registerCliHandlers } from "../socket/handlers/cli/index";
import { RpcRegistry } from "../socket/rpcRegistry";
import type { SocketServer, SocketWithData } from "../socket/socketTypes";
import { TerminalRegistry } from "../socket/terminalRegistry";
import type { SSEManager } from "../sse/sseManager";
import { Store } from "../store";
import { runBillableStartup } from "../store/billable/startup";
import {
  attachOrRefuse,
  runnerIdentityStatus,
} from "../web/routes/cliRunnerIdentity";
import {
  RunnerIdentity,
  runnerHandshakeStep,
  runnerKeyOf,
  type RunnerRefusedBody,
  type RunnerSocketLike,
} from "./runnerIdentity";
import {
  SyncEngine,
  type Session,
  type SpawnSessionOptions,
} from "./syncEngine";

/** The rig's clock starts here (any fixed time; the tests use offsets). */
export const RIG_START_MS = Date.UTC(2026, 10, 2, 9, 0, 0);
export const RIG_NAMESPACE = "default";
export const RIG_MACHINE_ID = "machine-rig-heron";

/** A runner: an invented name, the id it minted (null: an old binary), who started it. */
export type RigRunner = {
  name: string;
  runnerId: string | null;
  startedBy: "daemon" | "terminal";
  /** The socket auth declares it reads the stop (F1): a PR2 binary does, a PR1 one does not. */
  readsStop: boolean;
};

export function runner(
  name: string,
  startedBy: "daemon" | "terminal" = "daemon",
  options: { id?: boolean; readsStop?: boolean } = {}
): RigRunner {
  return {
    name,
    runnerId: options.id === false ? null : `runner-id-${name}`,
    startedBy,
    readsStop: options.readsStop ?? options.id !== false,
  };
}

/** The key the hub stores for a runner (null for an old binary). */
export function keyOf(r: RigRunner): string | null {
  return r.runnerId === null ? null : runnerKeyOf(r.runnerId);
}

type Listener = (...args: unknown[]) => void;

export type RigSocket = {
  id: string;
  runner: RigRunner;
  nsp: RigNamespace;
  data: RunnerSocketLike["data"];
  handshake: { auth: Record<string, unknown> };
  rooms: Set<string>;
  /** Every listener of each event, in the order registered, as socket.io keeps them. */
  listeners: Map<string, Listener[]>;
  emitted: Array<{ event: string; payload: unknown }>;
  disconnected: boolean;
  join(room: string): void;
  leave(room: string): void;
  on(event: string, fn: Listener): void;
  emit(event: string, payload?: unknown): boolean;
  to(): { emit: () => boolean };
  disconnect(close?: boolean): void;
};

type RigNamespace = {
  name: string;
  adapter: { rooms: Map<string, Set<string>> };
  sockets: Map<string, RigSocket>;
  to(): { emit: () => boolean };
  emit(): boolean;
  on(): RigNamespace;
  use(): RigNamespace;
};

function namespaceOf(name: string): RigNamespace {
  const ns: RigNamespace = {
    name,
    adapter: { rooms: new Map() },
    sockets: new Map(),
    to: () => ({ emit: () => true }),
    emit: () => true,
    on: () => ns,
    use: () => ns,
  };
  return ns;
}

function fakeSseManager(): SSEManager {
  return {
    subscribe: () => () => {},
    broadcast: () => {},
    close: () => {},
    getConnectionCount: () => 0,
  } as unknown as SSEManager;
}

export type RigAttach =
  | { ok: true; session: Session }
  | { ok: false; status: 409; body: RunnerRefusedBody };

export type RigConnect =
  | { ok: true; socket: RigSocket }
  | { ok: false; socket: RigSocket; error: Error & { data?: unknown } };

export type RigOptions = {
  identityMode: RunnerIdentityMode;
  billableMode?: BillableMode;
};

/** What a hub restart keeps: the database file. Everything else is rebuilt. */
type Hub = {
  store: Store;
  identity: RunnerIdentity;
  engine: SyncEngine;
  cli: RigNamespace;
  io: Server;
  rpcRegistry: RpcRegistry;
};

export class RunnerIdentityRig {
  readonly dir: string;
  readonly projectDir: string;
  readonly dbPath: string;
  readonly identityMode: RunnerIdentityMode;
  readonly billableMode: BillableMode;
  /** Every warning the registry wrote, newest last (all hubs). */
  readonly warnings: Array<{ message: string; options?: ErrorLogOptions }> = [];
  /** The archives the disconnect grace timer asked for. */
  readonly graceArchives: string[] = [];
  /** The engine's own archives (the watchdog's terminal archive among them). */
  readonly engineArchives: string[] = [];
  /** Every spawn the engine asked the fake daemon for. */
  readonly spawned: SpawnSessionOptions[] = [];
  /** Every session the cache re-marked active (`reactivate`). */
  readonly reactivated: string[] = [];
  /** Every heartbeat the handlers forwarded to the engine (it reached the cache). */
  readonly forwardedAlive: Array<{
    sid: string;
    time: number;
    socket: string;
  }> = [];
  /** What the fake daemon answers to "is this wrapper alive". */
  daemonAlive: boolean | null = null;
  private hub: Hub;
  private socketCount = 0;

  constructor(options: RigOptions) {
    this.identityMode = options.identityMode;
    this.billableMode = options.billableMode ?? "off";
    jest.useFakeTimers();
    setSystemTime(new Date(RIG_START_MS));
    this.dir = mkdtempSync(join(tmpdir(), "runner-identity-rig-"));
    this.projectDir = join(this.dir, "project-heron");
    mkdirSync(this.projectDir);
    this.dbPath = join(this.dir, "hub.db");
    this.hub = this.boot(true);
  }

  get store(): Store {
    return this.hub.store;
  }
  get identity(): RunnerIdentity {
    return this.hub.identity;
  }
  get engine(): SyncEngine {
    return this.hub.engine;
  }
  /** The `/cli` namespace: its room `session:<id>` is the one truth of who is connected. */
  get cli(): RigNamespace {
    return this.hub.cli;
  }

  private boot(first: boolean): Hub {
    const store = new Store(this.dbPath);
    if (first && this.billableMode !== "off") {
      runBillableStartup(store.getRawDb(), {
        nodeId: "node-rig",
        mode: this.billableMode,
        nowMs: Date.now(),
      });
    }
    const identity = new RunnerIdentity({
      store: store.sessions,
      mode: this.identityMode,
      logger: {
        warn: (message, options) => this.warnings.push({ message, options }),
      },
    });
    identity.setBillableMode(this.billableMode);
    const cli = namespaceOf("/cli");
    const others = new Map<string, RigNamespace>();
    const io = {
      of: (name: string) => {
        if (name === "/cli") return cli;
        let ns = others.get(name);
        if (ns === undefined) {
          ns = namespaceOf(name);
          others.set(name, ns);
        }
        return ns;
      },
      on: () => {},
      to: () => ({ emit: () => true }),
      emit: () => true,
    } as unknown as Server;
    // As `server/src/index.ts` binds it: the room's sockets, as `{ id, data }`.
    identity.bindLiveSockets(sessionId => {
      const out: RunnerSocketLike[] = [];
      for (const id of cli.adapter.rooms.get(`session:${sessionId}`) ?? []) {
        const socket = cli.sockets.get(id);
        if (socket) out.push({ id: socket.id, data: socket.data });
      }
      return out;
    });
    // As `server/src/socket/server.ts` binds it: the namespace's socket by id.
    identity.bindSocketLookup(id => cli.sockets.get(id));
    const rpcRegistry = new RpcRegistry();
    const engine = new SyncEngine(
      store,
      io,
      rpcRegistry,
      fakeSseManager(),
      null,
      { billableMode: this.billableMode, runnerIdentity: identity }
    );
    this.fakeDaemon(engine);
    return { store, identity, engine, cli, io, rpcRegistry };
  }

  /** The daemon side of the engine's RPC gateway, and the spies of case l. */
  private fakeDaemon(engine: SyncEngine): void {
    const internals = engine as unknown as {
      rpcGateway: Record<string, unknown>;
      sessionCache: { reactivate: (id: string) => boolean };
      archiveSession: (id: string, opts?: unknown) => Promise<void>;
    };
    const gateway = internals.rpcGateway;
    gateway.spawnSession = async (opts: SpawnSessionOptions) => {
      this.spawned.push(opts);
      return { type: "success", sessionId: "spawned-by-rig" };
    };
    gateway.isSessionAlive = async () => this.daemonAlive;
    gateway.getSessionClaudeId = async () => null;
    gateway.hasClaudeConversation = async () => null;
    const cache = internals.sessionCache;
    const reactivate = cache.reactivate.bind(cache);
    cache.reactivate = (id: string) => {
      this.reactivated.push(id);
      return reactivate(id);
    };
    internals.archiveSession = async (id: string) => {
      this.engineArchives.push(id);
    };
  }

  /** The session metadata a runner sends, as `bootstrapSession` does. */
  metadata(
    tag: string,
    r: RigRunner,
    launcherKind: "sdk" | "pty" | "tmux" = "sdk"
  ): Record<string, unknown> {
    return {
      path: this.projectDir,
      host: "host-heron",
      machineId: RIG_MACHINE_ID,
      flavor: "claude",
      name: `name-${tag}`,
      launcherKind,
      startedBy: r.startedBy,
    };
  }

  /**
   * `POST /cli/sessions` as the route runs it: the engine's attach with the
   * runner field and `startedBy` from the metadata, inside `attachOrRefuse`.
   */
  attach(
    r: RigRunner,
    tag: string,
    launcherKind: "sdk" | "pty" | "tmux" = "sdk"
  ): RigAttach {
    const attached = attachOrRefuse(() =>
      this.engine.getOrCreateSession(
        tag,
        this.metadata(tag, r, launcherKind),
        null,
        RIG_NAMESPACE,
        {
          ...(r.runnerId === null ? {} : { id: r.runnerId }),
          startedBy: r.startedBy,
        }
      )
    );
    if ("refused" in attached) {
      return { ok: false, status: 409, body: attached.refused };
    }
    return { ok: true, session: attached.session };
  }

  /** A row with no runner record: from before this build, or pre-minted (#4000). */
  seedRow(tag: string, r: RigRunner = runner("seed")): string {
    const stored = this.store.sessions.getOrCreateSession(
      tag,
      this.metadata(tag, r),
      null,
      RIG_NAMESPACE
    );
    (
      this.engine as unknown as { sessionCache: { reloadAll(): void } }
    ).sessionCache.reloadAll();
    return stored.id;
  }

  private makeSocket(r: RigRunner, sessionId: string): RigSocket {
    const cli = this.cli;
    const auth: Record<string, unknown> = { sessionId };
    if (r.runnerId !== null) auth.runnerId = r.runnerId;
    if (r.readsStop) auth.readsStop = true;
    const socket: RigSocket = {
      id: `socket-${r.name}-${(this.socketCount += 1)}`,
      runner: r,
      nsp: cli,
      // The token check of the middleware puts the namespace here.
      data: { namespace: RIG_NAMESPACE },
      handshake: { auth },
      rooms: new Set(),
      listeners: new Map(),
      emitted: [],
      disconnected: false,
      join(room: string) {
        const members = cli.adapter.rooms.get(room) ?? new Set<string>();
        members.add(socket.id);
        cli.adapter.rooms.set(room, members);
        socket.rooms.add(room);
      },
      leave(room: string) {
        cli.adapter.rooms.get(room)?.delete(socket.id);
        socket.rooms.delete(room);
      },
      on(event: string, fn: Listener) {
        socket.listeners.set(event, [
          ...(socket.listeners.get(event) ?? []),
          fn,
        ]);
      },
      emit(event: string, payload?: unknown) {
        socket.emitted.push({ event, payload });
        return true;
      },
      to: () => ({ emit: () => true }),
      // socket.io's order: leave every room and the namespace, then run the
      // socket's own `disconnect` listener, inside the caller.
      disconnect() {
        if (socket.disconnected) return;
        socket.disconnected = true;
        for (const room of [...socket.rooms]) socket.leave(room);
        cli.sockets.delete(socket.id);
        for (const fn of socket.listeners.get("disconnect") ?? []) {
          fn("server namespace disconnect");
        }
      },
    };
    return socket;
  }

  /** The connection handler with the engine's callbacks, as `createSocketServer` wires it. */
  private register(socket: RigSocket): void {
    const engine = this.engine;
    registerCliHandlers(socket as unknown as SocketWithData, {
      io: this.hub.io as unknown as SocketServer,
      store: this.store,
      rpcRegistry: this.hub.rpcRegistry,
      terminalRegistry: new TerminalRegistry({ idleTimeoutMs: 60_000 }),
      claudePtyRegistry: new ClaudePtyRegistry(),
      onSessionAlive: payload => {
        this.forwardedAlive.push({
          sid: payload.sid,
          time: payload.time,
          socket: socket.id,
        });
        engine.handleSessionAlive(payload);
      },
      onSessionEnd: payload => engine.handleSessionEnd(payload),
      onWebappEvent: event => engine.handleRealtimeEvent(event),
      onArchiveSession: sessionId => this.graceArchives.push(sessionId),
      runnerIdentity: this.identity,
    });
  }

  /**
   * A runner's socket connects: the `/cli` middleware's identity step (which
   * calls `next` once), then, only when it passed, the connection handler.
   */
  connect(r: RigRunner, sessionId: string): RigConnect {
    const socket = this.makeSocket(r, sessionId);
    const calls: Array<Error | undefined> = [];
    runnerHandshakeStep(socket, socket.handshake.auth, this.identity, err =>
      calls.push(err)
    );
    if (calls.length !== 1) throw new Error("next must be called once");
    const error = calls[0];
    if (error !== undefined) return { ok: false, socket, error };
    this.cli.sockets.set(socket.id, socket);
    this.register(socket);
    return { ok: true, socket };
  }

  /**
   * A socket whose handlers were registered before a record changed under it
   * (§4.1 point 4): the connection handler runs, the middleware does not.
   */
  adopt(r: RigRunner, sessionId: string): RigSocket {
    const socket = this.makeSocket(r, sessionId);
    socket.data.sessionId = sessionId;
    const key = keyOf(r);
    if (key !== null) socket.data.runnerKey = key;
    if (r.readsStop) socket.data.readsStop = true;
    this.cli.sockets.set(socket.id, socket);
    this.register(socket);
    return socket;
  }

  /** A report from a socket; returns the ack when the event takes one. */
  emit(socket: RigSocket, event: string, payload: unknown): unknown {
    const listeners = socket.listeners.get(event) ?? [];
    if (listeners.length === 0) throw new Error(`no listener for ${event}`);
    let ack: unknown;
    for (const fn of listeners) {
      fn(payload, (answer: unknown) => {
        ack = answer;
      });
    }
    return ack;
  }

  /** The runner's side drops its socket (a crash, a network drop). */
  disconnect(socket: RigSocket): void {
    if (socket.disconnected) return;
    socket.disconnected = true;
    for (const room of [...socket.rooms]) socket.leave(room);
    this.cli.sockets.delete(socket.id);
    for (const fn of socket.listeners.get("disconnect") ?? []) {
      fn("transport close");
    }
  }

  /** Moves the clock without running a timer. */
  jump(ms: number): void {
    setSystemTime(new Date(Date.now() + ms));
  }

  /** Moves the clock and runs every timer that falls due. */
  advance(ms: number): void {
    jest.advanceTimersByTime(ms);
  }

  /** Lets the engine's fire-and-forget promises settle (no timer runs). */
  async settle(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }

  /**
   * The cache's own watchdog: inactivity ticks every 5 s (as production) for
   * 7 minutes, so a session fires the 5-minute force-kill once, whether it was
   * inactive from the start or went inactive within a minute; then the probe's
   * promises settle.
   */
  async driveWatchdog(): Promise<void> {
    const cache = (
      this.engine as unknown as {
        sessionCache: { expireInactive(now: number): void };
      }
    ).sessionCache;
    const start = Date.now();
    for (let t = start; t <= start + 420_000; t += 5_000) {
      cache.expireInactive(t);
    }
    await this.settle();
  }

  /** The route's body, `GET /cli/runner-identity`, for the rig's namespace. */
  status(): ReturnType<typeof runnerIdentityStatus> {
    return runnerIdentityStatus(
      this.identity,
      this.engine,
      this.store,
      RIG_NAMESPACE
    );
  }

  /** The session's stored runner record (read from the row, never the cache). */
  record(sessionId: string) {
    return this.store.sessions.getRunnerRecord(sessionId, RIG_NAMESPACE);
  }

  /** The stored row, as the store holds it. */
  row(sessionId: string): Record<string, unknown> {
    return this.store
      .getRawDb()
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as Record<string, unknown>;
  }

  /** Sockets in room `session:<id>` that the namespace still holds. */
  roomOf(sessionId: string): string[] {
    const ids = [...(this.cli.adapter.rooms.get(`session:${sessionId}`) ?? [])];
    return ids.filter(id => this.cli.sockets.has(id));
  }

  /** The warnings of one category, in order. */
  warningsOf(category: string) {
    return this.warnings.filter(w => w.options?.category === category);
  }

  /**
   * The billed figure of plan §1: `SUM(duration_ms)` of the session's closed
   * intervals with `start_cause <> 'balance'`, read after the queue's flush.
   */
  billedMs(sessionId: string): number {
    (
      this.engine as unknown as { billableWrites: { flush(): void } }
    ).billableWrites.flush();
    const row = this.store
      .getRawDb()
      .prepare(
        "SELECT COALESCE(SUM(duration_ms), 0) AS n FROM thinking_intervals WHERE hapi_session_id = ? AND ended_at_ms IS NOT NULL AND start_cause <> 'balance'"
      )
      .get(sessionId) as { n: number };
    return row.n;
  }

  /**
   * A hub restart: every socket is gone, and a new store, registry and engine
   * open the same database file.
   */
  restart(): void {
    this.hub.engine.stop();
    for (const socket of [...this.hub.cli.sockets.values()]) {
      socket.disconnected = true;
    }
    this.hub = this.boot(false);
  }

  close(): void {
    try {
      this.hub.engine.stop();
    } finally {
      jest.useRealTimers();
      setSystemTime();
      rmSync(this.dir, { recursive: true, force: true });
    }
  }
}
