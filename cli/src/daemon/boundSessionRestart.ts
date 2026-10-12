// SPDX-License-Identifier: MIT
/**
 * Issue #1507 / #4679: restart the sessions bound to an account after its OAuth
 * token was rotated, so each running `claude` process picks up the fresh token
 * (its `CLAUDE_CODE_OAUTH_TOKEN` env is frozen at spawn).
 *
 * Extracted from the inline closure in `daemon/run.ts` (#4679) so the retry
 * behaviour is unit-testable. What changed:
 *
 *   - A busy session (the server answers HTTP 202 — mid-inference, background
 *     work running, or the instance at capacity) is retried every
 *     `retryIntervalMs` until the restart succeeds, the server returns a
 *     non-202 error, or the session is no longer active. The pre-#4679 closure
 *     gave up after three 30s retries and logged a terminal "still busy" warning,
 *     which left a session that was busy across a rotation on a revoked token
 *     until its next relaunch.
 *   - After `forceAfterMs` of continuous deferral the daemon asks the server to
 *     force the restart (`force: true`). The session's token has already been
 *     rotated, so its turn cannot complete any API call; the ceiling also covers
 *     a frozen `thinking:true` session or a stuck background-work count. The
 *     server skips only its busy guard under force. `forceAfterMs = 0` disables
 *     forcing.
 *   - At most one pending retry chain exists per session: a newer rotation for
 *     the same session replaces the older chain.
 *
 * Kept from #1507: the per-account in-flight guard (no concurrent restart
 * passes for the same account, R4) and the `RestartSummary` first-attempt tally
 * the force-refresh harness asserts on (#1547).
 */

import type { RestartSummary } from "@/modules/common/rpcTypes";

/** The logger surface the restarter writes to (the daemon passes `@/ui/logger`). */
export interface RestarterLogger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

export interface BoundSessionRestarterDeps {
  serverUrl: string;
  cliApiToken?: string;
  /** Force the restart after this long deferred (ms); 0 disables forcing. */
  forceAfterMs: number;
  /** Gap between attempts while the server defers (ms). Default 30_000. */
  retryIntervalMs?: number;
  logger: RestarterLogger;
  /** Test seams. */
  fetch?: typeof fetch;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  now?: () => number;
}

export interface BoundSessionRestarter {
  /** Restart every active session bound to `accountUuid`; see the module doc. */
  restartBoundSessions(accountUuid: string): Promise<RestartSummary>;
  /** Sessions with a retry still scheduled. */
  pendingCount(): number;
  /** Cancel every scheduled retry (daemon shutdown). */
  stop(): void;
}

/** Every Nth consecutive deferral of one session is logged at info. */
const DEFERRAL_LOG_EVERY = 10;

/** Server error codes that mean the session is gone, not that the restart failed. */
const SESSION_GONE_CODES = new Set(["not_active", "session_not_found"]);

interface PendingChain {
  accountUuid: string;
  firstDeferredAt: number;
  deferrals: number;
  /** Whether the forced-restart warning was already logged for this chain. */
  forced: boolean;
  timer: unknown;
}

export function createBoundSessionRestarter(
  deps: BoundSessionRestarterDeps
): BoundSessionRestarter {
  const doFetch = deps.fetch ?? fetch;
  const schedule =
    deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel =
    deps.clearTimeout ??
    ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = deps.now ?? Date.now;
  const retryIntervalMs = deps.retryIntervalMs ?? 30_000;
  const log = deps.logger;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (deps.cliApiToken) {
    headers["Authorization"] = `Bearer ${deps.cliApiToken}`;
  }

  const refreshingAccounts = new Set<string>();
  const pending = new Map<string, PendingChain>();

  const dropChain = (sessionId: string, chain: PendingChain): void => {
    if (pending.get(sessionId) === chain) {
      cancel(chain.timer);
      pending.delete(sessionId);
    }
  };

  /** Is `sessionId` still listed active? `null` when the list read failed. */
  const isSessionActive = async (
    sessionId: string
  ): Promise<boolean | null> => {
    try {
      const resp = await doFetch(`${deps.serverUrl}/cli/sessions`, {
        headers,
      });
      if (!resp.ok) return null;
      const { sessions } = (await resp.json()) as {
        sessions?: Array<{ id: string; active?: boolean }>;
      };
      const s = (sessions ?? []).find(x => x.id === sessionId);
      return !!s?.active;
    } catch {
      return null;
    }
  };

  type AttemptResult =
    | { kind: "restarted" }
    | { kind: "deferred"; reason: string }
    | { kind: "gone"; detail: string }
    | { kind: "failed"; detail: string }
    | { kind: "unreachable"; detail: string };

  const attempt = async (
    sessionId: string,
    accountUuid: string,
    force: boolean
  ): Promise<AttemptResult> => {
    let r: Response;
    try {
      r = await doFetch(
        `${deps.serverUrl}/cli/sessions/${sessionId}/token-refresh`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(
            force ? { accountUuid, force } : { accountUuid }
          ),
        }
      );
    } catch (e) {
      // The local server did not answer (e.g. it is restarting). Not a verdict
      // on the session: the first attempt tallies it as failed (#1547), a retry
      // keeps its chain.
      return {
        kind: "unreachable",
        detail: e instanceof Error ? e.message : String(e),
      };
    }
    if (r.status === 202) {
      const body = (await r.json().catch(() => null)) as {
        reason?: string;
      } | null;
      return { kind: "deferred", reason: body?.reason ?? "deferred" };
    }
    if (r.ok) return { kind: "restarted" };
    const text = await r.text().catch(() => "");
    let code: string | undefined;
    try {
      code = (JSON.parse(text) as { code?: string }).code;
    } catch {
      code = undefined;
    }
    const detail = `HTTP ${r.status} ${text}`.trim();
    if (code && SESSION_GONE_CODES.has(code)) return { kind: "gone", detail };
    return { kind: "failed", detail };
  };

  /** One retry of an existing chain; reschedules itself while deferred. */
  const retry = async (
    sessionId: string,
    chain: PendingChain
  ): Promise<void> => {
    if (pending.get(sessionId) !== chain) return; // superseded or stopped
    const active = await isSessionActive(sessionId);
    if (pending.get(sessionId) !== chain) return;
    if (active === false) {
      log.info(
        `[TOKEN_REFRESH] session ${sessionId} ended before its restart — dropped`
      );
      dropChain(sessionId, chain);
      return;
    }
    const force =
      deps.forceAfterMs > 0 &&
      now() - chain.firstDeferredAt >= deps.forceAfterMs;
    if (force && !chain.forced) {
      chain.forced = true;
      log.warn(
        `[TOKEN_REFRESH] session ${sessionId} still busy ${Math.round((now() - chain.firstDeferredAt) / 60_000)}m after its token was rotated — forcing the restart (its turn cannot complete on a superseded token)`
      );
    }
    const result = await attempt(sessionId, chain.accountUuid, force);
    if (pending.get(sessionId) !== chain) return;
    switch (result.kind) {
      case "restarted":
        log.info(
          `[TOKEN_REFRESH] session ${sessionId} restarted with fresh token${force ? " (forced)" : ""} after ${chain.deferrals} deferral(s)`
        );
        dropChain(sessionId, chain);
        return;
      case "gone":
        log.info(
          `[TOKEN_REFRESH] session ${sessionId} ended before its restart — dropped (${result.detail})`
        );
        dropChain(sessionId, chain);
        return;
      case "failed":
        log.warn(
          `[TOKEN_REFRESH] failed to restart session ${sessionId}: ${result.detail}`
        );
        dropChain(sessionId, chain);
        return;
      case "unreachable":
      case "deferred":
        chain.deferrals++;
        if (chain.deferrals % DEFERRAL_LOG_EVERY === 0) {
          log.info(
            `[TOKEN_REFRESH] session ${sessionId} still deferred (${result.kind === "deferred" ? result.reason : `server unreachable: ${result.detail}`}) — attempt ${chain.deferrals}, retrying every ${Math.round(retryIntervalMs / 1000)}s until it is idle`
          );
        } else {
          log.debug(
            `[TOKEN_REFRESH] session ${sessionId} deferred (${result.kind === "deferred" ? result.reason : `server unreachable: ${result.detail}`}), retrying in ${Math.round(retryIntervalMs / 1000)}s`
          );
        }
        chain.timer = schedule(
          () => void retry(sessionId, chain),
          retryIntervalMs
        );
        return;
    }
  };

  const restartBoundSessions = async (
    accountUuid: string
  ): Promise<RestartSummary> => {
    if (refreshingAccounts.has(accountUuid)) {
      log.debug(
        `[TOKEN_REFRESH] already restarting sessions for account ${accountUuid}, skipping`
      );
      return {
        skipped: true,
        boundCount: 0,
        restarted: 0,
        busy: 0,
        failed: 0,
        errors: [],
      };
    }
    refreshingAccounts.add(accountUuid);
    const summary: RestartSummary = {
      skipped: false,
      boundCount: 0,
      restarted: 0,
      busy: 0,
      failed: 0,
      errors: [],
    };
    try {
      const resp = await doFetch(`${deps.serverUrl}/cli/sessions`, {
        headers,
      });
      if (!resp.ok) {
        log.warn(
          `[TOKEN_REFRESH] failed to list sessions for restart: ${resp.status}`
        );
        summary.errors.push(`list sessions failed: HTTP ${resp.status}`);
        return summary;
      }
      const { sessions } = (await resp.json()) as {
        sessions: Array<{
          id: string;
          active?: boolean;
          metadata?: { accountUuid?: string };
        }>;
      };
      const bound = sessions.filter(
        s => s.active && s.metadata?.accountUuid === accountUuid
      );
      summary.boundCount = bound.length;
      log.info(
        `[TOKEN_REFRESH] restarting ${bound.length} session(s) bound to account ${accountUuid}`
      );
      for (const session of bound) {
        // R7: a newer rotation replaces any chain still pending for the session.
        const previous = pending.get(session.id);
        if (previous) dropChain(session.id, previous);
        // The summary tallies the FIRST attempt per session (#1547).
        const result = await attempt(session.id, accountUuid, false);
        switch (result.kind) {
          case "restarted":
            summary.restarted++;
            log.info(
              `[TOKEN_REFRESH] session ${session.id} restarted with fresh token`
            );
            break;
          case "deferred": {
            summary.busy++;
            const chain: PendingChain = {
              accountUuid,
              firstDeferredAt: now(),
              deferrals: 1,
              forced: false,
              timer: undefined,
            };
            pending.set(session.id, chain);
            log.info(
              `[TOKEN_REFRESH] session ${session.id} busy (${result.reason}) — will restart it once idle`
            );
            chain.timer = schedule(
              () => void retry(session.id, chain),
              retryIntervalMs
            );
            break;
          }
          case "gone":
          case "failed":
          case "unreachable":
            summary.failed++;
            summary.errors.push(`session ${session.id}: ${result.detail}`);
            log.warn(
              `[TOKEN_REFRESH] failed to restart session ${session.id}: ${result.detail}`
            );
            break;
        }
      }
    } catch (err) {
      log.warn(
        `[TOKEN_REFRESH] error in restartBoundSessions: ${err instanceof Error ? err.message : String(err)}`
      );
      summary.errors.push(err instanceof Error ? err.message : String(err));
    } finally {
      refreshingAccounts.delete(accountUuid);
    }
    return summary;
  };

  return {
    restartBoundSessions,
    pendingCount: () => pending.size,
    stop: () => {
      for (const [sessionId, chain] of pending) dropChain(sessionId, chain);
    },
  };
}
