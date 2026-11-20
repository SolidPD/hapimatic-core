// SPDX-License-Identifier: AGPL-3.0-only
import type { SiblingBindingScan } from "@/accounts/machineRotator";
import type {
  ForceRefreshOutcome,
  TokenRefreshAccountStore,
} from "@/accounts/tokenRefreshService";
import type {
  ForceRefreshReport,
  ForceRefreshStep,
  RestartSummary,
} from "@/modules/common/rpcTypes";

/**
 * On-demand force-refresh harness orchestrator (issue #1547).
 *
 * Runs INSIDE the daemon (so it reuses the live `TokenRefreshService` instance and
 * the daemon's `restartBoundSessions` closure) and assembles a per-step PASS/FAIL
 * {@link ForceRefreshReport} asserting the full chain:
 *   1. OAuth fetch result        (via injected `forceRefresh`)
 *   2. store delta               (accessToken changed, expiresAt advanced, lastRefreshedAt updated)
 *   3. restartBoundSessions fired
 *   4. bound-session respawn
 *
 * Issue #6847: before step 1, a sibling-instance guard refuses (`overall:
 * "skipped"`) an account a session of another Hapimatic instance on this machine
 * holds, because step 3 restarts only this instance's sessions.
 *
 * Pure + dependency-injected (mirrors `tokenRefreshService.test.ts` style) so it is
 * unit-testable without the network, the daemon, or the real account store.
 *
 * Issue #1551 (KD-3 Option A): this harness is the acceptance instrument for the
 * per-account credential-isolation fix. For a NON-host account with an isolated
 * config dir, the injected `forceRefresh` rotates the token IN the isolated dir
 * (the source of truth) and mirrors it into the store — so the store-delta
 * assertions (step 2) pass unchanged, and the harness reports PASS where #1546
 * showed FAIL(invalid_grant). No harness-logic change was needed: `forceRefresh`'s
 * isolated branching is transparent here (the {@link ForceRefreshOutcome} kinds
 * are identical), and the restart step (3/4) re-syncs native to the rotated token.
 */
export interface ForceRefreshHarnessDeps {
  /** Read the account record before + after the refresh (for the store delta). */
  accountStore: Pick<TokenRefreshAccountStore, "get">;
  /** The live service's force-refresh primitive. Drives step 1. */
  forceRefresh: (accountUuid: string) => Promise<ForceRefreshOutcome>;
  /** The daemon's restartBoundSessions closure. Drives steps 3/4. */
  restartBoundSessions: (accountUuid: string) => Promise<RestartSummary>;
  /** Clock seam (default `Date.now`) — for `durationMs`. DI for tests. */
  now?: () => number;
  /**
   * Issue #6837 (R4): whether the account's token lives in its machine-global
   * folder. The daemon passes `isIsolatedAccountAnywhere`, the predicate
   * `TokenRefreshService.forceRefresh` routes on. Absent, or a throw, reads as
   * non-isolated, which keeps the stale-copy warning.
   */
  isIsolatedAccount?: (accountUuid: string) => Promise<boolean>;
  /**
   * Issue #6837 (R4): `configuration.accountConfigsShared`. With the
   * `HAPI_ACCOUNT_CONFIG_SHARED=0` switch each instance has its own folder, so
   * nothing copies the new token to the others. Absent reads as `true`.
   */
  accountConfigsShared?: boolean;
  /**
   * Issue #6847: the accounts bound by a live session of ANOTHER Hapimatic
   * instance on this machine — the same view the idle backstop skips on
   * (`tokenRefreshService.ts` `refreshIdleIsolatedAccounts`, #4423 R5). The
   * daemon passes the one closure it also gives the service. A sibling-bound
   * account is refused before any OAuth call, because the restart step reaches
   * only this instance's sessions; a degraded view (or a throw) refuses too.
   * The scan reads `/proc`, so off Linux it is empty and nothing is refused, as
   * for the idle backstop. Absent: no guard (unit tests that do not exercise it).
   */
  getSiblingBoundAccounts?: () => Promise<SiblingBindingScan>;
}

/**
 * Issue #6837 (R4): the line a successful force-refresh of an isolated account
 * reports. Every running non-tenant daemon's maintenance tick mirrors a newer
 * folder pair into its own store (`isolatedCredentialsMirror.ts`). Issue #6847:
 * on Linux a session of the account already running in another instance on this
 * machine refuses the run (SKIPPED) before the rotation. Off Linux the sibling
 * scan sees nothing, so such a session, like one that starts while the rotation
 * runs, is not restarted. It stays in `warnings[]`, so it prints under
 * "Warnings".
 */
export const ISOLATED_RESYNC_NOTE =
  "The account's folder holds the new token; each running Hapimatic instance on this machine that holds this account copies it into its store on its next maintenance tick (about a minute), and a stopped one on its first tick after it starts. On Linux a session of this account in another instance on this machine stops the rotation (the run reports SKIPPED); on other systems, or when it starts while the rotation runs, that session is not restarted and may need a restart.";

/** Issue #6847: the guard step's name in a report. */
export const SIBLING_GUARD_STEP = "sibling-instance guard";

/**
 * Issue #6847 (R1-R3): the report for a run the sibling guard refused. No OAuth
 * call was made and nothing was written or restarted, so the later steps are
 * `skipped` and the report carries no `tokenRotated` and no stale-copy warning.
 */
function siblingRefusalReport(
  accountUuid: string,
  emailAddress: string | undefined,
  durationMs: number,
  scan: SiblingBindingScan,
  reason: "sibling-bound" | "sibling-view-degraded"
): ForceRefreshReport {
  // One entry per session: a session's native `claude` child inherits the
  // wrapper's HAPI_SESSION_ID, so the scan lists both under one tag. The first
  // process seen for a tag stands for it; an untagged process is kept by pid.
  const seenTags = new Set<string>();
  const holders = (
    reason === "sibling-bound" ? (scan.holders?.get(accountUuid) ?? []) : []
  )
    .filter(h => {
      if (h.sessionTag === null) return true;
      if (seenTags.has(h.sessionTag)) return false;
      seenTags.add(h.sessionTag);
      return true;
    })
    .map(h => ({ pid: h.pid, hapiHome: h.hapiHome, sessionTag: h.sessionTag }));
  let detail: string;
  if (reason === "sibling-bound") {
    const named =
      holders.length > 0
        ? holders
            .map(h => {
              const home = h.hapiHome ?? "unknown";
              return h.sessionTag === null
                ? `pid ${h.pid} (instance ${home})`
                : `${h.sessionTag} (instance ${home}, pid ${h.pid})`;
            })
            .join("; ")
        : "its process could not be named";
    detail = `a session of this account is running under another Hapimatic instance on this machine: ${named}. Rotating the login would end that session's access, and only this instance's sessions are restarted. Stop that session, or run \`hapi accounts force-refresh ${accountUuid}\` from that instance.`;
  } else {
    detail =
      "cannot list this machine's processes (/proc), so a session of this account under another Hapimatic instance cannot be ruled out; not rotated (fail-safe). Retry, or run it from the instance whose session uses this account.";
  }
  const notRun = "not run: sibling-instance guard";
  return {
    accountUuid,
    emailAddress,
    overall: "skipped",
    durationMs,
    steps: [
      { name: SIBLING_GUARD_STEP, status: "skipped", detail },
      { name: "OAuth fetch", status: "skipped", detail: notRun },
      { name: "store delta", status: "skipped", detail: notRun },
      { name: "restartBoundSessions", status: "skipped", detail: notRun },
    ],
    tokenRotated: false,
    crossInstanceResyncNeeded: false,
    warnings: [],
    skip: { reason, holders },
  };
}

/** The line for a non-isolated account, whose other store copies nothing re-syncs. */
export const STALE_COPY_WARNING =
  "Token rotated — if this account exists in another Hapimatic instance's store, that copy is now STALE and must be re-synced (no store copy is re-synced automatically).";

/**
 * Redacted fingerprint of an access token for delta comparison. NEVER returns the
 * raw token — only a short suffix + length, enough to assert "it changed".
 */
function tokenFingerprint(token: string): string {
  if (!token) return "(empty)";
  return `…${token.slice(-6)} (len ${token.length})`;
}

export async function runForceRefreshHarness(
  accountUuid: string,
  deps: ForceRefreshHarnessDeps
): Promise<ForceRefreshReport> {
  const now = deps.now ?? Date.now;
  const start = now();
  const steps: ForceRefreshStep[] = [];
  const warnings: string[] = [];

  // --- Snapshot BEFORE ----------------------------------------------------------
  const before = await deps.accountStore.get(accountUuid);
  if (!before || !before.ok) {
    return {
      accountUuid,
      overall: "not-found",
      durationMs: now() - start,
      steps: [
        {
          name: "account lookup",
          status: "fail",
          detail: before
            ? "account record is malformed"
            : "account not found in store",
        },
      ],
      warnings,
    };
  }
  const beforeAccount = before.account;
  const emailAddress = beforeAccount.emailAddress;
  const beforeFp = tokenFingerprint(beforeAccount.accessToken);
  const beforeExpiresAt = beforeAccount.expiresAt;
  const beforeLastRefreshed = beforeAccount.lastRefreshedAt;

  // Issue #6847: refuse an account a session of a SIBLING instance on this machine
  // holds, before any OAuth call — the idle backstop's guard (#4423 R5). Read the
  // view fresh, right before the rotation, to keep the race window narrow; a
  // throwing scan fails safe as degraded, as the idle backstop's does.
  if (deps.getSiblingBoundAccounts) {
    const scan: SiblingBindingScan = await deps
      .getSiblingBoundAccounts()
      .catch(() => ({ uuids: new Set<string>(), degraded: true }));
    if (scan.uuids.has(accountUuid)) {
      return siblingRefusalReport(
        accountUuid,
        emailAddress,
        now() - start,
        scan,
        "sibling-bound"
      );
    }
    if (scan.degraded) {
      return siblingRefusalReport(
        accountUuid,
        emailAddress,
        now() - start,
        scan,
        "sibling-view-degraded"
      );
    }
  }

  // Issue #6837 (R4): read ONCE, before the refresh, so the message describes the
  // path forceRefresh takes (it routes on the same predicate).
  let isolated = false;
  if (deps.accountConfigsShared !== false && deps.isIsolatedAccount) {
    try {
      isolated = await deps.isIsolatedAccount(accountUuid);
    } catch {
      isolated = false;
    }
  }

  // --- Force the refresh (step 1) ----------------------------------------------
  const outcome = await deps.forceRefresh(accountUuid);

  if (outcome.kind === "not-found") {
    // Race: the account vanished between the snapshot and the refresh.
    return {
      accountUuid,
      emailAddress,
      overall: "not-found",
      durationMs: now() - start,
      steps: [
        {
          name: "OAuth fetch",
          status: "fail",
          detail: "account not found at refresh time",
        },
      ],
      warnings,
    };
  }

  if (outcome.kind === "permanent" || outcome.kind === "transient") {
    // R4: surface the OAuth error code (e.g. invalid_grant) and name the step.
    steps.push({
      name: "OAuth fetch",
      status: "fail",
      detail: `${outcome.kind} failure: ${outcome.detail}`,
    });
    steps.push({
      name: "store delta",
      status: "skipped",
      detail: "OAuth fetch failed — no delta to assert",
    });
    steps.push({
      name: "restartBoundSessions",
      status: "skipped",
      detail: "OAuth fetch failed — bound sessions not restarted",
    });
    return {
      accountUuid,
      emailAddress,
      overall: "fail",
      durationMs: now() - start,
      steps,
      warnings,
    };
  }

  // --- outcome.kind === "success" ----------------------------------------------
  steps.push({
    name: "OAuth fetch",
    status: "pass",
    detail: "refresh succeeded",
  });

  // --- Snapshot AFTER + compute store delta (step 2) ---------------------------
  const after = await deps.accountStore.get(accountUuid);
  if (!after || !after.ok) {
    steps.push({
      name: "store delta",
      status: "fail",
      detail: "could not re-read account record after refresh",
    });
    return {
      accountUuid,
      emailAddress,
      overall: "fail",
      durationMs: now() - start,
      steps,
      warnings,
    };
  }
  const afterAccount = after.account;
  const accessTokenChanged =
    afterAccount.accessToken !== beforeAccount.accessToken;
  const expiresAtAdvanced = afterAccount.expiresAt > beforeExpiresAt;
  const lastRefreshedUpdated =
    afterAccount.lastRefreshedAt > beforeLastRefreshed;

  steps.push({
    name: "store delta: accessToken changed",
    status: accessTokenChanged ? "pass" : "fail",
    detail: `${beforeFp} → ${tokenFingerprint(afterAccount.accessToken)}`,
  });
  steps.push({
    name: "store delta: expiresAt advanced",
    status: expiresAtAdvanced ? "pass" : "fail",
    detail: `${new Date(beforeExpiresAt).toISOString()} → ${new Date(afterAccount.expiresAt).toISOString()}`,
  });
  steps.push({
    name: "store delta: lastRefreshedAt updated",
    status: lastRefreshedUpdated ? "pass" : "fail",
    detail: `${beforeLastRefreshed} → ${afterAccount.lastRefreshedAt}`,
  });

  // --- Steps 3/4: restart bound sessions ---------------------------------------
  const restart = await deps.restartBoundSessions(accountUuid);
  let restartFailed = false;
  if (restart.skipped) {
    steps.push({
      name: "restartBoundSessions fired",
      status: "pass",
      detail:
        "a restart for this account was already in progress (e.g. the scheduler's onSuccessfulRefresh) — restart fired there",
    });
    steps.push({
      name: "bound-session respawn",
      status: "skipped",
      detail: "restart driven by a concurrent pass; see daemon logs",
    });
  } else {
    steps.push({
      name: "restartBoundSessions fired",
      status: "pass",
      detail: `queried bound sessions: ${restart.boundCount}`,
    });
    restartFailed = restart.boundCount > 0 && restart.failed > 0;
    steps.push({
      name: "bound-session respawn",
      status: restartFailed ? "fail" : "pass",
      detail:
        restart.boundCount === 0
          ? "no bound sessions to restart"
          : `restarted ${restart.restarted}, busy ${restart.busy} (background retry), failed ${restart.failed}`,
    });
    for (const e of restart.errors) {
      warnings.push(`restart: ${e}`);
    }
  }

  // Issue #6837 (R4): an isolated account's other store copies are re-synced by
  // each running daemon's mirror on its next tick; a non-isolated account's (or
  // any account's with HAPI_ACCOUNT_CONFIG_SHARED=0) are not. Beside a sibling
  // instance on a build before #5020 (no mirror), the isolated line overstates.
  warnings.push(isolated ? ISOLATED_RESYNC_NOTE : STALE_COPY_WARNING);

  const deltaPass =
    accessTokenChanged && expiresAtAdvanced && lastRefreshedUpdated;
  const overall: ForceRefreshReport["overall"] =
    deltaPass && !restartFailed ? "pass" : "fail";

  return {
    accountUuid,
    emailAddress,
    overall,
    durationMs: now() - start,
    steps,
    tokenRotated: true,
    // Issue #6837 (R4): false for an isolated account, whose live token is in the
    // one machine-global folder that each instance's mirror copies from (#1643,
    // #5020); true for a non-isolated account or with per-instance folders.
    crossInstanceResyncNeeded: !isolated,
    warnings,
  };
}
