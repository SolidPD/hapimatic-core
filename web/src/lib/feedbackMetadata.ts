// SPDX-License-Identifier: AGPL-3.0-only
import { FeedbackSubmitterEmailSchema } from "@hapi/protocol/schemas";
import type { ApiClient } from "@/api/client";
import type { FeedbackMetadata, Session } from "@/types/api";

/**
 * The submitter email to send for a candidate identity, or `null` when the
 * candidate is not an email address (issue #2951 L3). The server refuses a
 * present malformed `submitterEmail` with 400 and the form has no email field,
 * so passing a non-email identity through would refuse the submission on every
 * retry. A Telegram login, for one, supplies a Telegram handle as its username.
 */
export function toSubmitterEmail(
  candidate: string | null | undefined
): string | null {
  if (candidate == null) return null;
  return FeedbackSubmitterEmailSchema.safeParse(candidate).success
    ? candidate
    : null;
}

/**
 * Composed feedback payload metadata + the resolved submitter email (issue
 * #2664). Composed by WHITELIST from vetted sources only — never a whole-object
 * dump. Message content, session notes, OAuth tokens, `cliApiToken`, git diffs,
 * and file contents are structurally excluded (R4); the SERVER re-validates the
 * closed `.strict()` schema and re-scrubs, so this is defense-in-depth, not the
 * sole guard.
 */
export interface ComposedFeedback {
  metadata: FeedbackMetadata;
  submitterEmail: string | null;
}

export interface ComposeFeedbackOptions {
  api: ApiClient;
  /** Current route/pathname (always recorded). */
  route: string;
  /** App version from `useVersion()` (R3). */
  appVersion?: string;
  /** The authenticated login's username. Used as the submitter email only when
   *  it is an email address; no login path issues one today (a Telegram login
   *  carries a handle; access-token and gateway sign-ins carry none), so the
   *  session's account email, read only inside a session view, is the source. */
  loginUsername?: string | null;
  /** When inside a session view, the session id — adds the session block (R3). */
  sessionId?: string | null;
  /** Injectable for tests (defaults to the live browser globals). */
  userAgent?: string;
  viewport?: string;
  /** Per-read deadline in ms (defaults to {@link FEEDBACK_DIAGNOSTICS_READ_TIMEOUT_MS}). */
  readTimeoutMs?: number;
  /** Called once per read when it settles (`ok`) or fails or times out (#6190 trace). */
  onReadSettled?: (read: FeedbackDiagnosticsRead, ok: boolean) => void;
  /** The session as the app already holds it (the query cache). Used only when
   *  the live session read fails or misses its deadline, so a slow read does not
   *  record "no active session" or lose the submitter email (#6190). */
  getCachedSession?: () => Session | null | undefined;
}

/** The three reads behind the diagnostics preview. */
export type FeedbackDiagnosticsRead = "about" | "stats" | "session";

/**
 * How long each diagnostics read may take before the composer treats it as
 * failed (#6190). The reads run in parallel, so "Composing diagnostics…"
 * settles within about this long after composing starts, even when no read
 * answers. (The RP1 hub's `/api/about` answered after 3 s during #6190; the
 * reads used to run one after another, each bounded only by `ApiClient`'s 30 s
 * request timeout.) A read that misses the deadline keeps running in the
 * background; its result is discarded and `ApiClient`'s own timeout ends it.
 */
export const FEEDBACK_DIAGNOSTICS_READ_TIMEOUT_MS = 4_000;

/** Rejects when `promise` has not settled within `ms`; clears its timer either way. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`diagnostics read timed out after ${ms} ms`)),
      ms
    );
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Compose the privacy-safe feedback metadata. The live reads go through the
 * authed `ApiClient` methods — NEVER a raw `fetch()`, since `/api/about` and
 * `/api/system-health` sit behind the `/api/*` JWT gate and a raw fetch would
 * 401 at runtime. Every external read degrades gracefully:
 *   - `/api/about` failure  → the `about` block is omitted (best-effort).
 *   - `/api/system-health` failure → `stats: "unavailable"`, never rejects (R5).
 *   - no `sessionId`        → `session: "no active session"` (R3).
 *   - session read failure → the cached session if the app holds one, else
 *     `session: "no active session"`.
 * The three reads run in parallel, each capped at
 * {@link FEEDBACK_DIAGNOSTICS_READ_TIMEOUT_MS} (#6190); a read past its deadline
 * degrades exactly like a failed one.
 */
export async function composeFeedbackMetadata(
  opts: ComposeFeedbackOptions
): Promise<ComposedFeedback> {
  const { api, route, appVersion, loginUsername, sessionId } = opts;
  const userAgent =
    opts.userAgent ??
    (typeof navigator !== "undefined" ? navigator.userAgent : undefined);
  const viewport =
    opts.viewport ??
    (typeof window !== "undefined"
      ? `${window.innerWidth}x${window.innerHeight}`
      : undefined);

  const metadata: FeedbackMetadata = { appVersion, route, userAgent, viewport };

  // #6190: start every read now, each with its own deadline, so one slow or
  // hung read neither delays the others nor holds the preview. The blocks below
  // await them in their usual order and degrade as before.
  const timeoutMs = opts.readTimeoutMs ?? FEEDBACK_DIAGNOSTICS_READ_TIMEOUT_MS;
  const startRead = <T>(
    read: FeedbackDiagnosticsRead,
    call: () => Promise<T>
  ): Promise<T> => {
    const settled = withDeadline(Promise.resolve().then(call), timeoutMs).then(
      value => {
        opts.onReadSettled?.(read, true);
        return value;
      },
      (err: unknown) => {
        opts.onReadSettled?.(read, false);
        throw err;
      }
    );
    // Awaited below, in order. A read that fails before its turn must not be
    // reported as an unhandled rejection in the meantime.
    settled.catch(() => {});
    return settled;
  };
  const aboutRead = startRead("about", () => api.getAbout());
  const healthRead = startRead("stats", () => api.getSystemHealth());
  const sessionRead = sessionId
    ? startRead("session", () => api.getSession(sessionId))
    : null;

  // Install metadata — authed ApiClient (never raw fetch).
  try {
    const about = await aboutRead;
    metadata.about = {
      osName: about.os.name,
      kernel: about.os.kernel,
      arch: about.os.arch,
      deviceModel: about.hardware.deviceModel ?? undefined,
      cpuCores: about.hardware.cpuCores,
      totalRamBytes: about.hardware.totalRamBytes,
      serverUptimeSec: about.uptime.serverProcessSec,
      systemUptimeSec: about.uptime.systemSec,
      tailnet: about.tailscale?.hostname ?? undefined,
    };
  } catch {
    // best-effort — omit the about block on failure
  }

  // Live VM stats — R5: on failure mark "unavailable" and NEVER reject.
  try {
    const h = await healthRead;
    metadata.stats = {
      // #6156: a null CPU (no sample window yet) is omitted, never sent as 0.
      cpuUsagePercent: h.cpu.usagePercent ?? undefined,
      cpuTemperatureF: h.cpu.temperatureF,
      memUsedBytes: h.memory.used,
      memTotalBytes: h.memory.total,
      memUsagePercent: h.memory.usagePercent,
      swapUsagePercent: h.swap.usagePercent,
      diskUsagePercent: h.disk.usagePercent,
      hostname: h.hostname,
      uptimeSec: h.uptime,
    };
  } catch {
    metadata.stats = "unavailable";
  }

  // Session block — ONLY inside a session view (R3).
  let submitterEmail = toSubmitterEmail(loginUsername);
  if (sessionId && sessionRead) {
    let session: Session | null | undefined;
    try {
      ({ session } = await sessionRead);
    } catch {
      // The live read failed or missed its deadline: use the copy the app
      // already holds, if any (#6190).
      session = opts.getCachedSession?.();
    }
    if (session) {
      const m = session.metadata;
      metadata.session = {
        sessionId,
        workingDir: m?.path ?? "unknown",
        flavor: m?.flavor ?? undefined,
        launcherKind: m?.launcherKind ?? undefined,
        accountEmail: m?.claudeAccount?.email ?? undefined,
        accountUuid: m?.accountUuid ?? undefined,
        safeMode: m?.safeMode,
        modelMode: m?.modelMode ?? undefined,
        activeModel:
          session.resolvedModel ??
          session.rawModel ??
          session.modelMode ??
          undefined,
        effort: m?.effort ?? undefined,
        rawModel: m?.rawModel ?? undefined,
      };
      // Enrich the submitter email from the session's bound account when it is
      // an email address.
      const accountEmail = toSubmitterEmail(m?.claudeAccount?.email);
      if (accountEmail) submitterEmail = accountEmail;
    } else {
      // The session couldn't be read — record "no active session" and continue.
      metadata.session = "no active session";
    }
  } else {
    metadata.session = "no active session";
  }

  return { metadata, submitterEmail };
}
