// SPDX-License-Identifier: AGPL-3.0-only
import { FeedbackSubmitterEmailSchema } from "@hapi/protocol/schemas";
import type { ApiClient } from "@/api/client";
import type { FeedbackMetadata } from "@/types/api";

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
}

/**
 * Compose the privacy-safe feedback metadata. Both live reads go through the
 * authed `ApiClient` methods — NEVER a raw `fetch()`, since `/api/about` and
 * `/api/system-health` sit behind the `/api/*` JWT gate and a raw fetch would
 * 401 at runtime. Every external read degrades gracefully:
 *   - `/api/about` failure  → the `about` block is omitted (best-effort).
 *   - `/api/system-health` failure → `stats: "unavailable"`, never rejects (R5).
 *   - no `sessionId`        → `session: "no active session"` (R3).
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

  // Install metadata — authed ApiClient (never raw fetch).
  try {
    const about = await api.getAbout();
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
    const h = await api.getSystemHealth();
    metadata.stats = {
      cpuUsagePercent: h.cpu.usagePercent,
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
  if (sessionId) {
    try {
      const { session } = await api.getSession(sessionId);
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
    } catch {
      // The session couldn't be read — record "no active session" and continue.
      metadata.session = "no active session";
    }
  } else {
    metadata.session = "no active session";
  }

  return { metadata, submitterEmail };
}
