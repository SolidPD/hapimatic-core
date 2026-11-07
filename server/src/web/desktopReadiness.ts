// SPDX-License-Identifier: AGPL-3.0-only
// Readiness wait for the on-demand web desktop backend (#6214).
//
// The desktop stack is a `Type=simple` systemd --user unit, so `systemctl start`
// returns as soon as desktop-session.sh is forked, seconds before the backend
// accepts connections. A connect made at that moment is refused. This helper dials
// the backend until it opens, with bounded backoff, and stops early when the unit is
// no longer active or the caller aborts (browser closed, or the overall deadline).
//
// The policy is transport-independent on purpose: today's dial is a WebSocket to
// websockify (desktopProxy.ts). #3674 plans a `Bun.connect()` dial and #3672 plans
// to reuse it for the host `wayvnc` backend, so neither needs its own retry loop.

/** Tunables for {@link dialUntilReady}. Every field is optional. */
export type DesktopReadinessOptions = {
  /** Abandon one attempt that has neither opened nor failed after this long. */
  attemptTimeoutMs?: number;
  /** Wait after the first failed attempt; doubles per failure up to `retryMaxMs`. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Check the unit's liveness at most once per this interval. */
  livenessIntervalMs?: number;
};

export const DESKTOP_READINESS_DEFAULTS = {
  attemptTimeoutMs: 5_000,
  retryBaseMs: 100,
  retryMaxMs: 500,
  // desktop-session.sh sleeps 1 s before Xvnc even starts, so checking sooner
  // could catch little beyond an ExecStart that failed outright, at the cost of
  // a systemctl spawn per retry.
  livenessIntervalMs: 1_000,
} as const satisfies Required<DesktopReadinessOptions>;

export type ReadyOutcome<T> =
  | { kind: "ready"; backend: T; attempts: number; elapsedMs: number }
  | { kind: "unit_inactive"; attempts: number; elapsedMs: number }
  | { kind: "aborted"; reason: unknown; attempts: number; elapsedMs: number };

export type DialUntilReadyOptions<T> = DesktopReadinessOptions & {
  /** Open the backend. Resolve once it is open, reject on any earlier failure, and
   * release the half-open connection when `signal` aborts. */
  dial: (signal: AbortSignal) => Promise<T>;
  /** Close a backend whose dial resolved after the wait was abandoned. */
  release: (backend: T) => void;
  /** Is the unit still running? A throw counts as alive; the caller's deadline
   * still bounds the wait. */
  isAlive: () => Promise<boolean>;
  /** Called when `isAlive` throws, so the caller can log it. */
  onLivenessError?: (err: unknown) => void;
  /** Outer cancel: the browser closed, or the overall deadline passed. */
  signal: AbortSignal;
};

/** Settle with `p`, or reject as soon as `signal` aborts. */
function settleOrAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

/** Resolve after `ms`, or as soon as `signal` aborts. */
function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Dial the backend until it opens. Never rejects: every way out is a
 * {@link ReadyOutcome}, so the caller cannot leak an unhandled rejection (the server
 * installs no `unhandledRejection` handler and Bun exits on one, #4051).
 */
export async function dialUntilReady<T>(
  opts: DialUntilReadyOptions<T>
): Promise<ReadyOutcome<T>> {
  const attemptTimeoutMs =
    opts.attemptTimeoutMs ?? DESKTOP_READINESS_DEFAULTS.attemptTimeoutMs;
  const retryBaseMs =
    opts.retryBaseMs ?? DESKTOP_READINESS_DEFAULTS.retryBaseMs;
  const retryMaxMs = opts.retryMaxMs ?? DESKTOP_READINESS_DEFAULTS.retryMaxMs;
  const livenessIntervalMs =
    opts.livenessIntervalMs ?? DESKTOP_READINESS_DEFAULTS.livenessIntervalMs;

  const started = Date.now();
  let attempts = 0;
  let lastLivenessAt = started;
  const elapsed = (): number => Date.now() - started;
  const aborted = (): ReadyOutcome<T> => ({
    kind: "aborted",
    reason: opts.signal.reason,
    attempts,
    elapsedMs: elapsed(),
  });
  const release = (backend: T): void => {
    try {
      opts.release(backend);
    } catch {
      /* already closed */
    }
  };

  for (;;) {
    if (opts.signal.aborted) return aborted();
    attempts++;
    const attemptSignal = AbortSignal.any([
      opts.signal,
      AbortSignal.timeout(attemptTimeoutMs),
    ]);
    // Race the dial against its own signal, so a dial that ignores the signal
    // cannot hang the loop. The executor turns a dial that throws synchronously
    // into a failed attempt instead of a rejection of this function.
    const dialed = new Promise<T>(resolve => resolve(opts.dial(attemptSignal)));
    try {
      const backend = await settleOrAbort(dialed, attemptSignal);
      if (opts.signal.aborted) {
        release(backend);
        return aborted();
      }
      return { kind: "ready", backend, attempts, elapsedMs: elapsed() };
    } catch {
      // Abandoned: if the dial still resolves later, release what it opened (a
      // handler attached after settlement still runs).
      dialed.then(release, () => {});
    }

    if (opts.signal.aborted) return aborted();
    await waitOrAbort(
      Math.min(retryBaseMs * 2 ** (attempts - 1), retryMaxMs),
      opts.signal
    );
    if (opts.signal.aborted) return aborted();

    if (Date.now() - lastLivenessAt >= livenessIntervalMs) {
      lastLivenessAt = Date.now();
      let alive = true;
      try {
        // Raced against the caller's signal: a stalled systemctl must not hold
        // the wait past the deadline.
        alive = await settleOrAbort(
          new Promise<boolean>(resolve => resolve(opts.isAlive())),
          opts.signal
        );
      } catch (err) {
        if (!opts.signal.aborted) {
          try {
            opts.onLivenessError?.(err);
          } catch {
            /* a logging callback must not break the never-rejects contract */
          }
        }
      }
      if (opts.signal.aborted) return aborted();
      if (!alive) {
        return { kind: "unit_inactive", attempts, elapsedMs: elapsed() };
      }
    }
  }
}
