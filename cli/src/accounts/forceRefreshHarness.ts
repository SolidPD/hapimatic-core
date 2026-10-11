// SPDX-License-Identifier: AGPL-3.0-only
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
}

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

  // --- Force the refresh (step 1) ----------------------------------------------
  const outcome = await deps.forceRefresh(accountUuid);

  if (outcome.kind === "host-default-deferred") {
    // R3: expected outcome, NOT a failure.
    steps.push({
      name: "OAuth fetch",
      status: "skipped",
      detail:
        "deferred to native — host-default account is not refreshable by Hapimatic (#1520)",
    });
    steps.push({
      name: "store delta",
      status: "skipped",
      detail: "no refresh attempted (host-default deferral)",
    });
    steps.push({
      name: "restartBoundSessions",
      status: "skipped",
      detail: "no refresh attempted (host-default deferral)",
    });
    return {
      accountUuid,
      emailAddress: outcome.emailAddress,
      overall: "deferred",
      durationMs: now() - start,
      steps,
      warnings,
    };
  }

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

  // R6: a successful refresh of a non-host account rotates the token and stales the
  // same account's stored copy in every OTHER Hapimatic instance (prod/dev/other
  // worktrees). forceRefresh already deferred the host-default account, so reaching
  // here means this IS a non-host account → the rotation always needs a re-sync flag.
  warnings.push(
    "Token rotated — if this account exists in another Hapimatic instance's store, that copy is now STALE and must be re-synced (only the host-default account is auto-synced by the CredentialsWatcher)."
  );

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
    // Issue #1643: with the machine-global SHARED isolated dir, the live token
    // for an isolated account lives in the ONE shared dir all instances read —
    // so a force-refresh no longer staleing per-instance store TOKEN copies is no
    // longer a cross-instance hazard for isolated accounts (the store token is
    // advisory cache; the shared dir is token-authoritative, R8). Left `true`
    // conservatively (NOT a behavior change): the per-instance store mirror still
    // exists for the UI badge, and the host-default / non-isolated paths still
    // genuinely need the operator to re-sync. Narrowing this to a per-account
    // conditional is post-Task-9-sweep cleanup, not this PR.
    crossInstanceResyncNeeded: true,
    warnings,
  };
}
