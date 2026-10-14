// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stale tmux-socket sweep (issue #4204, PR-1 / Task 1 — the urgent fix for the
 * root cause of #4204).
 *
 * Every instance daemon on a host (prod, dev, each worktree instance) runs this
 * sweep on its 60 s maintenance tick to clean up leftover tmux socket FILES
 * whose server has genuinely exited (e.g. a `hapimatic-<test>-<ts>` socket left
 * behind by a local vitest run after `kill -9`). tmux does not remove its socket
 * file on an abnormal exit, so without a sweep those files accumulate.
 *
 * 🔴 ROOT-CAUSE HISTORY: the pre-#4204 sweep (extracted from
 * `healthScheduler.ts`, #849) ran a SYNCHRONOUS `execFileSync("tmux", ["-S",
 * path, "list-sessions"], {timeout: 2000})` per socket and **unlinked the socket
 * on ANY failure** — a 2 s timeout under load included. A live tmux server keeps
 * its listening fd but becomes slow to answer `list-sessions` under load, so the
 * sweep deleted LIVE sockets across instances (a worktree daemon deleted prod's
 * `hapimatic-private` socket; N=3 in 4 days). The next spawn then forked a SECOND
 * server on the same path and the daemon lost sight of the first server's
 * sessions. See #4204 for the full evidence chain.
 *
 * THE FIX: probe with a bounded async `net.connect(path)` instead of
 * `list-sessions`. A Unix-domain socket's `connect()` completes at the KERNEL
 * level (the connection lands in the listen backlog) whenever a listener is
 * bound — it does NOT require the server PROCESS to be scheduled. So:
 *   - a live-but-frozen/overloaded server (even SIGSTOPped) still answers
 *     `connect()` → we KEEP its socket (the old timeout path would have deleted
 *     it);
 *   - a socket file whose server has truly exited answers `ECONNREFUSED`
 *     (nobody bound) → the ONLY case in which we unlink;
 *   - `ENOENT` → the file is already gone;
 *   - anything else (EACCES, a connect timeout, …) → we KEEP it and log the code
 *     at debug — an unlink is never triggered by an ambiguous error.
 * Every unlink logs its path + reason. The sweep uses async I/O only (no
 * `execFileSync`) so it never blocks the daemon event loop, and each probe is
 * bounded by `connectTimeoutMs`, so the sweep's total wall time is ≈ that bound
 * regardless of how many sockets are present (probes run concurrently).
 *
 * The `{ readdir, lstat, connect, unlink, tmuxDir }` seam is injectable so
 * `healthScheduler.test.ts` can stub the whole module (mirroring the
 * `./orphanMcpReaper` stub) and keep its H-tests hermetic — a real `net.connect`
 * + `readdir` sweep would otherwise escape that suite's `child_process` mock and
 * probe (and could unlink) the developer's real `hapimatic-*` sockets.
 */
import { readdirSync, lstatSync, unlinkSync } from "fs";
import net from "net";
import { join } from "path";
import { logger } from "@/ui/logger";

/** Only alphanumerics, hyphens and underscores after the `hapimatic-` prefix. */
const HAPIMATIC_SOCKET = /^hapimatic-[a-zA-Z0-9_-]+$/;

/** Per-probe `net.connect` timeout. A `connect` to a bound Unix socket returns
 * immediately (kernel-level), so this only bounds the pathological hang case; it
 * is generous so a heavily-loaded but live server is never misread as a timeout
 * and (per this module's rules) a timeout never triggers an unlink anyway. */
const DEFAULT_CONNECT_TIMEOUT_MS = 1000;

/** The classification of a single `net.connect` probe against a socket file. */
export type ConnectProbeResult =
  | { status: "live" } // a listener is bound (connect succeeded)
  | { status: "refused" } // ECONNREFUSED — the file exists but nobody is listening
  | { status: "absent" } // ENOENT — the file is already gone
  | { status: "error"; code?: string }; // EACCES / ETIMEDOUT / anything else

/** Injectable I/O seam (production defaults applied via `?? default`). */
export type StaleSocketSweepSeam = {
  /** List a directory's entries (default: `readdirSync`). */
  readdir: (dir: string) => string[];
  /** `lstat` an entry — NOT `stat`, so a symlink is reported as a symlink and
   * never followed to (and unlinked in place of) its target. */
  lstat: (path: string) => { isSocket(): boolean };
  /** Bounded async reachability probe against a socket path. */
  connect: (socketPath: string) => Promise<ConnectProbeResult>;
  /** Remove a socket file (default: `unlinkSync`). */
  unlink: (path: string) => void;
  /** The tmux socket directory to sweep. When omitted, resolved from
   * `${TMUX_TMPDIR:-/tmp}/tmux-<uid>`; `null` disables the sweep. */
  tmuxDir: string | null;
};

export type StaleSocketSweepOptions = Partial<StaleSocketSweepSeam> & {
  /** Per-probe timeout for the default `connect` (ignored if `connect` is injected). */
  connectTimeoutMs?: number;
};

export type StaleSocketSweepResult = {
  /** Socket paths unlinked this sweep (ECONNREFUSED — no listener). */
  unlinked: string[];
  /** Live sockets kept (a listener is bound). */
  liveKept: number;
  /** Sockets kept because the probe returned a non-refused error (EACCES, timeout, …). */
  errorKept: number;
  /** Sockets found already gone (ENOENT) during the probe. */
  absent: number;
  /** Allowlisted socket entries examined (after the `lstat`/`isSocket` filter). */
  scanned: number;
};

/**
 * Resolve the tmux socket directory the way tmux itself does:
 * `${TMUX_TMPDIR:-/tmp}/tmux-<uid>`. Returns `null` when the uid is unavailable
 * (non-POSIX), which disables the sweep.
 */
export function resolveTmuxDir(
  uid: number | undefined = process.getuid?.()
): string | null {
  if (uid === undefined) return null;
  const base = process.env.TMUX_TMPDIR || "/tmp";
  return join(base, `tmux-${uid}`);
}

/** Default bounded `net.connect` probe. Never throws; always resolves. */
function defaultConnect(
  socketPath: string,
  timeoutMs: number
): Promise<ConnectProbeResult> {
  return new Promise<ConnectProbeResult>(resolve => {
    let settled = false;
    const socket = net.connect(socketPath);
    const done = (result: ConnectProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(
      () => done({ status: "error", code: "ETIMEDOUT" }),
      timeoutMs
    );
    socket.once("connect", () => done({ status: "live" }));
    // `on` (not `once`) so a post-settle error from destroy() is absorbed rather
    // than thrown as an unhandled 'error' event; `done` is a no-op after settle.
    socket.on("error", (err: NodeJS.ErrnoException) => {
      const code = err.code;
      if (code === "ECONNREFUSED") done({ status: "refused" });
      else if (code === "ENOENT") done({ status: "absent" });
      else done({ status: "error", code });
    });
  });
}

/**
 * One sweep pass. Enumerates `tmuxDir`, and for each `hapimatic-*` socket FILE
 * (via `lstat().isSocket()`, so symlinks and plain files are skipped) probes
 * reachability with a bounded async `net.connect` and unlinks ONLY on
 * ECONNREFUSED. Never throws — every failure resolves to "keep". Returns a
 * summary for the caller's debug log.
 */
export async function sweepStaleSockets(
  options: StaleSocketSweepOptions = {}
): Promise<StaleSocketSweepResult> {
  const result: StaleSocketSweepResult = {
    unlinked: [],
    liveKept: 0,
    errorKept: 0,
    absent: 0,
    scanned: 0,
  };

  const tmuxDir =
    options.tmuxDir !== undefined ? options.tmuxDir : resolveTmuxDir();
  if (tmuxDir === null) return result;

  const readdir = options.readdir ?? ((dir: string) => readdirSync(dir));
  const lstat = options.lstat ?? ((path: string) => lstatSync(path));
  const unlink = options.unlink ?? ((path: string) => unlinkSync(path));
  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const connect =
    options.connect ??
    ((socketPath: string) => defaultConnect(socketPath, connectTimeoutMs));

  let entries: string[];
  try {
    entries = readdir(tmuxDir);
  } catch {
    // The tmux dir doesn't exist yet (no tmux server has ever run) — nothing to sweep.
    return result;
  }

  // Filter to allowlisted socket FILES up front (skip symlinks / non-sockets via
  // lstat), then probe the survivors concurrently so total wall time ≈ one probe.
  const socketPaths: string[] = [];
  for (const entry of entries) {
    if (!HAPIMATIC_SOCKET.test(entry)) continue;
    const socketPath = join(tmuxDir, entry);
    try {
      if (!lstat(socketPath).isSocket()) continue; // symlink / plain file → skip
    } catch {
      continue; // vanished (ENOENT) or unreadable between readdir and lstat
    }
    socketPaths.push(socketPath);
  }
  result.scanned = socketPaths.length;

  await Promise.all(
    socketPaths.map(async socketPath => {
      let probe: ConnectProbeResult;
      try {
        probe = await connect(socketPath);
      } catch (err) {
        // A rejecting injected `connect` must not abort the sweep — keep the socket.
        result.errorKept += 1;
        logger.debug(
          `[DAEMON RUN] stale-socket probe threw for ${socketPath}; keeping`,
          err
        );
        return;
      }

      switch (probe.status) {
        case "live":
          result.liveKept += 1;
          return;
        case "absent":
          result.absent += 1;
          return;
        case "error":
          result.errorKept += 1;
          logger.debug(
            `[DAEMON RUN] stale-socket probe inconclusive for ${socketPath} (code=${probe.code ?? "unknown"}); keeping`
          );
          return;
        case "refused":
          break; // the only unlink case — fall through
      }

      try {
        unlink(socketPath);
        result.unlinked.push(socketPath);
        logger.info(
          `[DAEMON RUN] removed stale tmux socket ${socketPath} (ECONNREFUSED — socket file with no listener)`
        );
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          // Already gone (another actor removed it between the probe and here).
          result.absent += 1;
        } else if (code === "EACCES") {
          logger.warn(
            `[DAEMON RUN] permission denied removing stale tmux socket ${socketPath}`
          );
          logger.reportCaught(err, {
            category: "daemon-stale-socket-unlink",
            severity: "warn",
            context: JSON.stringify({ socketPath }),
          });
        } else {
          logger.debug(
            `[DAEMON RUN] could not remove stale tmux socket ${socketPath}:`,
            err
          );
        }
      }
    })
  );

  return result;
}
