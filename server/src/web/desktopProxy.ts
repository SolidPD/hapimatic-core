// SPDX-License-Identifier: AGPL-3.0-only
// Web-based desktop mode — per-VM WebSocket proxy (issue #2693).
//
// ARCHITECTURE (re-derived per #2519's verdict + sweep ruling D3; the prior
// directive's gateway placement was refuted — the gateway is a separate SSO VM
// that cannot reach a user VM's loopback websockify). This proxy runs on the
// PER-VM Hapimatic server (the same box as Xvnc/websockify), reachable through
// the VM's own Caddy 443 front door:
//
//   Browser <DesktopView> noVNC RFB client
//     ── wss ──►  VM Caddy 443 → localhost:3008 (this server)
//                   /api/sessions/:id/desktop  (JWT-authenticated raw-WS upgrade)
//     ── ws  ──►  127.0.0.1:6080  websockify (WS↔TCP bridge, loopback-only)
//     ── tcp ──►  127.0.0.1:5901  Xvnc + XFCE
//
// The transport is a NEW raw binary WebSocket (a sibling of the federation
// terminal raw-WS upgrade in server.ts) — NOT the Socket.IO terminal path, which
// carries UTF-8 text only and cannot relay an RFB binary stream (finding 2693-5).
// The server relays browser-WS ↔ websockify-WS frames verbatim; websockify (the
// #2519-validated reference bridge) owns the RFB↔TCP translation.
//
// READINESS (#6214): the unit is Type=simple, so `systemctl start` returns seconds
// before websockify listens. The proxy dials the backend through `dialUntilReady`
// (desktopReadiness.ts) until it opens, under one deadline that also bounds the
// start, and closes the browser socket with DESKTOP_CLOSE_START_FAILED when the
// desktop genuinely cannot start.
//
// SECURITY (R2): the desktop is reachable ONLY through this JWT-gated proxy;
// websockify + Xvnc bind 127.0.0.1 only (desktop-session.sh). The auth boundary
// is: a valid HS256 {uid,ns} JWT for a session in the token's namespace, on a
// desktop-eligible tier (Decision A = Pro-and-up).

import { jwtVerify } from "jose";
import { z } from "zod";
import { DESKTOP_CLOSE_START_FAILED } from "@hapi/protocol";
import { readVmTier } from "@hapi/protocol/tenantMode";
import type { ServerWebSocket } from "bun";
import type { Store } from "../store";
import {
  dialUntilReady,
  type DesktopReadinessOptions,
} from "./desktopReadiness";

/**
 * Discriminated WS-data variant for a desktop connection — mirrors
 * FederationTerminalWsData in server.ts so the composite websocket handler can
 * multiplex it. Carries the AUTHENTICATED identity (set at upgrade time), so the
 * handler never re-derives trust from the raw socket.
 */
export type DesktopWsData = {
  type: "desktop";
  sessionId: string;
  userId: number;
  namespace: string;
};

const jwtPayloadSchema = z.object({ uid: z.number(), ns: z.string() });

/**
 * Desktop-eligible tiers — Decision A (epic #2749): Pro-and-up. This MIRRORS the
 * bash `DESKTOP_TIER_ALLOWLIST` in scripts/lib/provision-helpers.sh; keep the two
 * in sync (widen BOTH together if the operator relaxes the gate to include
 * "standard"). Env override for tests / dev instances.
 */
const DESKTOP_TIER_ALLOWLIST = (
  process.env.HAPI_DESKTOP_TIER_ALLOWLIST ?? "pro ultra"
)
  .toLowerCase()
  .split(/\s+/)
  .filter(Boolean);

/** Loopback websockify endpoint the desktop stack exposes (desktop-session.sh
 * binds 127.0.0.1:6080). Overridable for tests. */
const WEBSOCKIFY_URL =
  process.env.HAPI_DESKTOP_WEBSOCKIFY_URL ?? "ws://127.0.0.1:6080/websockify";

/** One deadline for the whole start — `systemctl start` plus the wait for the
 * backend (#6214). desktop-session.sh reaches websockify within ~17 s at worst, or
 * exits 1, which the liveness check reports long before this. */
const DESKTOP_READY_TIMEOUT_MS = 30_000;

/** Browser frames held while the backend is not yet open. noVNC sends nothing
 * before the server's RFB greeting, so a real client queues 0 bytes. */
const DESKTOP_MAX_QUEUED_BYTES = 256 * 1024;

/**
 * Read the VM's persisted tier (written by provision.sh Phase 9.7 to
 * ~/.config/hapimatic/vm-tier). Env `HAPI_VM_TIER` overrides (tests / dev). A
 * missing marker → undefined (treated as not-eligible: dev/worktree instances and
 * non-cloud hosts have no VM tier, so the desktop toggle stays hidden there).
 * `markerPath` is a test seam (#4954). #4349: the one implementation lives in
 * `@hapi/protocol/tenantMode` (shared with the cli's tenant predicate); this
 * re-export keeps every existing importer unchanged.
 */
export { readVmTier };

/** True iff this VM's tier is desktop-eligible. Fail-closed: an unknown/absent
 * tier is never allowed. */
export function desktopTierAllowed(tier: string | undefined): boolean {
  return !!tier && DESKTOP_TIER_ALLOWLIST.includes(tier);
}

export type DesktopAuthResult =
  | { ok: true; data: DesktopWsData }
  | { ok: false; status: number; reason: string };

const SESSION_DESKTOP_PATH = /^\/api\/sessions\/([^/]+)\/desktop$/;

/** Does this URL name the desktop upgrade endpoint? (cheap pre-check for the
 * server.ts fetch handler before doing any auth work). */
export function isDesktopUpgradePath(pathname: string): boolean {
  return SESSION_DESKTOP_PATH.test(pathname);
}

function extractDesktopToken(req: Request, url: URL): string | null {
  // Preferred: the token rides the Sec-WebSocket-Protocol header as
  // "hapi-desktop-auth.<token>" (a browser WS cannot set an Authorization
  // header; the subprotocol avoids leaking the token in URLs/access logs —
  // mirrors the federation "hapi-fed-auth.<token>" convention). Fallback:
  // ?token= query param.
  const protocolHeader = req.headers.get("sec-websocket-protocol") ?? "";
  const protocols = protocolHeader.split(",").map(p => p.trim());
  const authProtocol = protocols.find(p => p.startsWith("hapi-desktop-auth."));
  if (authProtocol) {
    const t = authProtocol.slice("hapi-desktop-auth.".length);
    if (t) return t;
  }
  return url.searchParams.get("token");
}

/**
 * Authenticate + authorize a /api/sessions/:id/desktop upgrade BEFORE
 * server.upgrade() runs (mirrors checkFederationWsToken's fail-closed shape). All
 * four checks must pass: eligible tier, present token, valid HS256 {uid,ns}, and
 * a same-namespace session. Returns the DesktopWsData to attach on success.
 */
export async function authenticateDesktopUpgrade(opts: {
  req: Request;
  url: URL;
  jwtSecret: Uint8Array;
  store: Store;
}): Promise<DesktopAuthResult> {
  const { req, url, jwtSecret, store } = opts;
  const m = url.pathname.match(SESSION_DESKTOP_PATH);
  if (!m) return { ok: false, status: 404, reason: "not_a_desktop_path" };
  const sessionId = decodeURIComponent(m[1]);

  // 1. Tier gate — early reject + drives UI toggle visibility. Fail-closed.
  const tier = readVmTier();
  if (!desktopTierAllowed(tier)) {
    return { ok: false, status: 403, reason: "desktop_not_available_for_tier" };
  }

  // 2. Token presence.
  const token = extractDesktopToken(req, url);
  if (!token) return { ok: false, status: 401, reason: "missing_token" };

  // 3. Verify HS256 {uid, ns} (same secret + payload shape as the HTTP + socket
  // middleware — server/src/web/middleware/auth.ts, server/src/socket/server.ts).
  let payload: z.infer<typeof jwtPayloadSchema>;
  try {
    const verified = await jwtVerify(token, jwtSecret, {
      algorithms: ["HS256"],
    });
    const parsed = jwtPayloadSchema.safeParse(verified.payload);
    if (!parsed.success) {
      return { ok: false, status: 401, reason: "invalid_token_payload" };
    }
    payload = parsed.data;
  } catch {
    return { ok: false, status: 401, reason: "invalid_token" };
  }

  // 4. Tenancy — the session must exist and belong to the token's namespace
  // (mirrors the terminal handler's session.namespace === namespace guard).
  const session = store.sessions.getSession(sessionId);
  if (!session || session.namespace !== payload.ns) {
    return { ok: false, status: 403, reason: "session_namespace_mismatch" };
  }

  return {
    ok: true,
    data: {
      type: "desktop",
      sessionId,
      userId: payload.uid,
      namespace: payload.ns,
    },
  };
}

/**
 * On-demand lifecycle for the desktop stack (R4). The systemd --user unit
 * hapimatic-desktop is install-but-NOT-enabled (see hapimatic-desktop.service);
 * this starts it on the first desktop connection and stops it after the last one
 * disconnects + an idle grace period, so an idle VM carries none of the ~½ GB.
 * `systemctl --user` control mirrors server/src/systemJobs/reconciler.ts.
 *
 * `ensureStarted` resolving does NOT mean the backend is listening: the unit is
 * Type=simple, so it reads `active` the moment the script forks. The proxy waits
 * for the backend itself (#6214) and uses `isActive` to fail fast if the unit stops.
 */
export class DesktopLifecycle {
  private readonly unit: string;
  private readonly idleMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private starting: Promise<void> | null = null;
  /** Test seam — defaults to the real `systemctl --user` runner. */
  private readonly run: (
    args: string[]
  ) => Promise<{ code: number; stderr: string }>;

  constructor(opts?: {
    unit?: string;
    idleMs?: number;
    run?: (args: string[]) => Promise<{ code: number; stderr: string }>;
  }) {
    this.unit = opts?.unit ?? "hapimatic-desktop";
    this.idleMs =
      opts?.idleMs ?? Number(process.env.HAPI_DESKTOP_IDLE_MS ?? 5 * 60_000);
    this.run = opts?.run ?? DesktopLifecycle.systemctlUser;
  }

  /** Ensure the desktop unit is active (start it if not). Cancels any pending
   * idle-stop. Coalesces concurrent starts. */
  async ensureStarted(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (await this.isActive()) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Called on each desktop disconnect with the count of REMAINING connections.
   * When it reaches zero, schedule an idle stop to reclaim the RAM. */
  noteClosed(remaining: number): void {
    if (remaining > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.stop();
    }, this.idleMs);
    // Do not keep the event loop alive solely for the idle-stop timer.
    if (typeof this.idleTimer === "object" && "unref" in this.idleTimer) {
      (this.idleTimer as { unref: () => void }).unref();
    }
  }

  /** Is the unit running? After a successful `systemctl start` the start job has
   * completed, so the unit reads `active` (Type=simple) or has already failed. A
   * false here can also be another instance's idle stop of the same unit on this
   * VM, which the viewer then shows as "could not start". */
  async isActive(): Promise<boolean> {
    const r = await this.run(["is-active", "--quiet", this.unit]);
    return r.code === 0;
  }

  private async start(): Promise<void> {
    // daemon-reload picks up a unit that provision.sh just installed but whose
    // user manager had not yet reloaded (install-desktop.sh best-effort reload).
    await this.run(["daemon-reload"]);
    const r = await this.run(["start", this.unit]);
    if (r.code !== 0) {
      throw new Error(
        `systemctl --user start ${this.unit} failed (code ${r.code}): ${r.stderr.trim()}`
      );
    }
  }

  private async stop(): Promise<void> {
    await this.run(["stop", this.unit]);
  }

  private static async systemctlUser(
    args: string[]
  ): Promise<{ code: number; stderr: string }> {
    const proc = Bun.spawn(["systemctl", "--user", ...args], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { code, stderr };
  }
}

type DesktopConn = {
  backend: WebSocket | null;
  queue: (string | Buffer)[];
  queuedBytes: number;
  /** The backend is open and the relay is wired. */
  ready: boolean;
  closed: boolean;
  /** Aborted when the connection ends, which stops the readiness wait. */
  abort: AbortController;
};

/** Close a socket, ignoring one that is already closing. */
function closeQuietly(sock: WebSocket): void {
  try {
    sock.close();
  } catch {
    /* already closing */
  }
}

/**
 * Open one WebSocket to the backend: resolve once it is open, reject if it fails
 * first or `signal` aborts. Its listeners are removed on open, so a later abort of
 * `signal` (the attempt timeout and the 30 s deadline keep running after the
 * backend opens) never touches a live backend.
 */
function dialWebSocket(url: string, signal: AbortSignal): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const sock = new WebSocket(url);
    sock.binaryType = "arraybuffer";
    const cleanup = (): void => {
      sock.removeEventListener("open", onOpen);
      sock.removeEventListener("close", onFail);
      sock.removeEventListener("error", onFail);
      signal.removeEventListener("abort", onAbort);
    };
    const onOpen = (): void => {
      cleanup();
      resolve(sock);
    };
    // A refused connect fires `error` then `close`; either one ends the attempt.
    const onFail = (): void => {
      cleanup();
      closeQuietly(sock);
      reject(new Error("backend connection failed before it opened"));
    };
    const onAbort = (): void => {
      cleanup();
      closeQuietly(sock);
      reject(signal.reason);
    };
    sock.addEventListener("open", onOpen);
    sock.addEventListener("close", onFail);
    sock.addEventListener("error", onFail);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The raw-WS relay. Handed the authenticated browser ServerWebSocket by the
 * composite websocket handler (server.ts), it opens a loopback WebSocket to
 * websockify and relays frames verbatim in both directions — WITHOUT the
 * JSON/.toString() step the federation node handler applies, so binary RFB frames
 * pass through intact (the critical difference from the terminal path).
 */
export class DesktopProxyHandler {
  private readonly conns = new Map<
    ServerWebSocket<DesktopWsData>,
    DesktopConn
  >();
  private readonly lifecycle: DesktopLifecycle;
  private readonly backendUrl: string;
  private readonly readyTimeoutMs: number;
  private readonly readiness: DesktopReadinessOptions;

  constructor(opts?: {
    lifecycle?: DesktopLifecycle;
    backendUrl?: string;
    /** Test seam: the deadline for the whole start (default 30 s). */
    readyTimeoutMs?: number;
    /** Test seam: backoff, attempt timeout and liveness interval. */
    readiness?: DesktopReadinessOptions;
  }) {
    this.lifecycle = opts?.lifecycle ?? new DesktopLifecycle();
    this.backendUrl = opts?.backendUrl ?? WEBSOCKIFY_URL;
    this.readyTimeoutMs = opts?.readyTimeoutMs ?? DESKTOP_READY_TIMEOUT_MS;
    this.readiness = opts?.readiness ?? {};
  }

  /** Live desktop connection count (for tests + observability). */
  get connectionCount(): number {
    return this.conns.size;
  }

  handleOpen(ws: ServerWebSocket<DesktopWsData>): void {
    const conn: DesktopConn = {
      backend: null,
      queue: [],
      queuedBytes: 0,
      ready: false,
      closed: false,
      abort: new AbortController(),
    };
    this.conns.set(ws, conn);
    // One deadline covers the start AND the wait for the backend (#6214). It fires
    // even when an attempt hangs without any socket event.
    const signal = AbortSignal.any([
      conn.abort.signal,
      AbortSignal.timeout(this.readyTimeoutMs),
    ]);
    signal.addEventListener(
      "abort",
      () => {
        if (conn.ready || conn.closed) return;
        this.failStart(
          ws,
          conn,
          "desktop_start_timeout",
          `the desktop backend did not open within ${this.readyTimeoutMs} ms`
        );
      },
      { once: true }
    );
    // Fire-and-forget: the browser socket is already open; early browser frames
    // queue until the backend connects. `start` never rejects; the catch is the
    // last line so nothing can escape as an unhandled rejection (#4051).
    void this.start(ws, conn, signal).catch((err: unknown) => {
      this.failStart(ws, conn, "desktop_start_failed", String(err));
    });
  }

  handleMessage(
    ws: ServerWebSocket<DesktopWsData>,
    message: string | Buffer
  ): void {
    const conn = this.conns.get(ws);
    if (!conn) return;
    const backend = conn.backend;
    if (backend && backend.readyState === WebSocket.OPEN) {
      // Verbatim relay browser → websockify (binary RFB preserved). `message` is
      // string | Buffer; Buffer is an ArrayBufferView, so no cast is needed.
      backend.send(message);
      return;
    }
    conn.queuedBytes +=
      typeof message === "string"
        ? Buffer.byteLength(message)
        : message.byteLength;
    if (conn.queuedBytes > DESKTOP_MAX_QUEUED_BYTES) {
      this.closeBoth(ws, conn, 1009, "desktop_queue_overflow");
      return;
    }
    conn.queue.push(message);
  }

  handleWsClose(ws: ServerWebSocket<DesktopWsData>): void {
    const conn = this.conns.get(ws);
    if (!conn) return;
    this.endConn(conn, "browser_closed");
    this.release(ws);
  }

  /** Start the unit, wait for the backend, then wire the relay. Never rejects. */
  private async start(
    ws: ServerWebSocket<DesktopWsData>,
    conn: DesktopConn,
    signal: AbortSignal
  ): Promise<void> {
    try {
      await this.lifecycle.ensureStarted();
    } catch (err) {
      this.failStart(ws, conn, "desktop_start_failed", String(err));
      return;
    }
    if (conn.closed || signal.aborted) return;

    let livenessErrorLogged = false;
    const outcome = await dialUntilReady({
      ...this.readiness,
      dial: s => dialWebSocket(this.backendUrl, s),
      release: closeQuietly,
      isAlive: () => this.lifecycle.isActive(),
      onLivenessError: err => {
        if (livenessErrorLogged) return;
        livenessErrorLogged = true;
        console.error(
          `[desktop] could not check the desktop unit for session ${ws.data.sessionId}: ${String(err)}`
        );
      },
      signal,
    });

    switch (outcome.kind) {
      case "ready":
        this.attachBackend(ws, conn, outcome.backend);
        if (outcome.attempts > 1) {
          console.log(
            `[desktop] backend ready for session ${ws.data.sessionId} after ${outcome.elapsedMs} ms (${outcome.attempts} attempts)`
          );
        }
        return;
      case "unit_inactive":
        this.failStart(
          ws,
          conn,
          "desktop_start_failed",
          "the desktop unit stopped while the backend was starting"
        );
        return;
      case "aborted":
        // Whoever aborted (browser close, deadline, queue overflow) already closed.
        return;
      default: {
        const unhandled: never = outcome;
        return unhandled;
      }
    }
  }

  private attachBackend(
    ws: ServerWebSocket<DesktopWsData>,
    conn: DesktopConn,
    backend: WebSocket
  ): void {
    if (conn.closed) {
      closeQuietly(backend);
      return;
    }
    conn.backend = backend;
    conn.ready = true;
    backend.addEventListener("message", (ev: MessageEvent) => {
      // websockify → browser, verbatim (binary RFB frames). ev.data is `any`
      // (arraybuffer for binary frames per binaryType in dialWebSocket).
      try {
        ws.send(ev.data);
      } catch {
        /* browser socket gone */
      }
    });
    backend.addEventListener("close", () => {
      this.closeBoth(ws, conn, 1000, "backend_closed");
    });
    backend.addEventListener("error", () => {
      this.closeBoth(ws, conn, 1011, "backend_error");
    });
    for (const frame of conn.queue) {
      backend.send(frame);
    }
    conn.queue = [];
    conn.queuedBytes = 0;
    if (backend.readyState !== WebSocket.OPEN) {
      this.closeBoth(ws, conn, 1000, "backend_closed");
    }
  }

  /** The desktop could not start: log the cause and tell the browser (4001). */
  private failStart(
    ws: ServerWebSocket<DesktopWsData>,
    conn: DesktopConn,
    reason: "desktop_start_failed" | "desktop_start_timeout",
    detail: string
  ): void {
    if (conn.closed) return;
    console.error(
      `[desktop] could not start the desktop for session ${ws.data.sessionId} (${reason}): ${detail}`
    );
    this.closeBoth(ws, conn, DESKTOP_CLOSE_START_FAILED, reason);
  }

  private closeBoth(
    ws: ServerWebSocket<DesktopWsData>,
    conn: DesktopConn,
    code: number,
    reason: string
  ): void {
    if (conn.closed) return;
    this.endConn(conn, reason);
    try {
      ws.close(code, reason);
    } catch {
      /* noop */
    }
    this.release(ws);
  }

  /** End a connection: stop the readiness wait, drop queued frames, and close
   * the backend. Shared by both teardown paths (browser close and closeBoth). */
  private endConn(conn: DesktopConn, reason: string): void {
    conn.closed = true;
    conn.abort.abort(reason);
    conn.queue = [];
    conn.queuedBytes = 0;
    if (conn.backend) closeQuietly(conn.backend);
  }

  /** Forget the connection and let the lifecycle schedule its idle stop. The
   * delete makes this run at most once per connection. */
  private release(ws: ServerWebSocket<DesktopWsData>): void {
    if (this.conns.delete(ws)) {
      this.lifecycle.noteClosed(this.conns.size);
    }
  }
}
