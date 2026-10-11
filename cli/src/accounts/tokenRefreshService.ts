// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- Grandfathered god-file (Epic 0, #2077); decomposition verdict tracked in claudedocs/architecture-hotspot-review.md. Crossed 1500 adding the #3784 chain-independence seam (the feature logic itself lives in the sibling remoteChainIndependence.ts). */
import { delay, exponentialBackoffDelay } from "@/utils/time";
import { logger } from "@/ui/logger";
import type { JobHealthStatus, JobRegistry } from "@hapi/protocol";
import { readHostDefaultAccountUuid } from "@/utils/claudeCredentials";
import {
  isIsolatedAccountAnywhere,
  readIsolatedCredentials,
} from "@/accounts/accountConfigDir";
import {
  fingerprintedFlagIsStale,
  refreshTokenFingerprint,
  rotateIsolatedCredentials,
  withoutFailedTokenFingerprint,
  type SiblingBindingScan,
} from "@/accounts/machineRotator";
import {
  decideMixedBindingRotation,
  type ChainIndependence,
} from "@/accounts/remoteChainIndependence";
import type {
  AccountIndexEntry,
  StoredAccount,
  ValidateAccountResult,
} from "@hapi/protocol/accounts";
import { isEnvTokenAccount } from "@hapi/protocol/accounts";

/** Stable registry name for the daemon's token-refresh loop (#1964, Sub-D). */
const TOKEN_REFRESH_JOB_NAME = "token-refresh";

/**
 * OAuth token-refresh service for Hapimatic-managed Anthropic accounts
 * (issue #1448, sub-issue B of epic #1446).
 *
 * Why Hapimatic owns refresh: Hapimatic injects the access token into the
 * `claude` child process via an env var, which BYPASSES Claude Code's built-in
 * auto-refresh. A managed account's access token would therefore silently
 * expire. This service keeps every stored account's token fresh:
 *  - PROACTIVELY — a single cross-account scheduler refreshes ~5 min before
 *    `expiresAt` ({@link TokenRefreshService.start}).
 *  - REACTIVELY — {@link TokenRefreshService.handleAuthFailure} is the public
 *    primitive that sub-issue D's launcher / J's restart path invoke on a 401.
 *
 * The refresh wire contract is reimplemented byte-for-byte from Claude Code's
 * `services/oauth/client.ts` `refreshOAuthToken` (the source mirror is reference
 * only — a different build, not importable). See {@link refreshOAuthToken}.
 */

// --- Production constants (extracted from Claude Code source) -------------------

/** Anthropic OAuth token endpoint (`PROD_OAUTH_CONFIG.TOKEN_URL`). */
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** Public OAuth client id for Claude Code (`PROD_OAUTH_CONFIG.CLIENT_ID`). */
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** Space-joined scopes — must match Claude Code's refresh request exactly. */
const SCOPE =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
/** Refresh HTTP timeout (matches client.ts). */
const REQUEST_TIMEOUT_MS = 15_000;
/** Refresh this many ms before `expiresAt` — matches `isOAuthTokenExpired`. */
const DEFAULT_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// --- Errors ---------------------------------------------------------------------

/**
 * Permanent refresh failure — the refresh token is revoked/invalid (HTTP 4xx
 * except 429, `invalid_grant`, …). The account cannot be refreshed without a
 * fresh user login, so the service marks it `unrefreshable` and does NOT retry.
 * The message carries only an HTTP-status / OAuth-error-code — never a token.
 */
export class PermanentRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentRefreshError";
  }
}

/**
 * Transient refresh failure — network error, timeout, HTTP 5xx, or HTTP 429.
 * The credentials are presumed still valid, so a scheduled refresh retries with
 * bounded backoff and the account is NOT marked unrefreshable.
 */
export class TransientRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientRefreshError";
  }
}

// --- Refresh primitive ----------------------------------------------------------

/** The fields B needs from a successful refresh. */
export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  /** Unix epoch ms. */
  expiresAt: number;
}

/**
 * The structural slice of fetch the refresh primitive uses — a narrower type
 * than typeof fetch (no preconnect), so a test double satisfies it without a
 * cast through the full global fetch signature.
 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface RefreshOptions {
  /** Injectable `fetch` for testing the wire contract without the network. */
  fetchImpl?: FetchLike;
  /** Request timeout (ms). */
  timeoutMs?: number;
  /** Clock seam for `expiresAt = now() + expires_in*1000`. */
  now?: () => number;
}

interface RefreshTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

/**
 * Reimplements Claude Code's `refreshOAuthToken` wire contract (R7): POST the
 * stored refresh token to the Anthropic OAuth endpoint and map the response to
 * `{accessToken, refreshToken, expiresAt}`.
 *
 * The `refresh_token` MAY rotate — fall back to the old one if the response
 * omits it (exactly as client.ts does). Only `Content-Type: application/json`
 * is sent; the `oauth-2025-04-20` beta header is NOT used on refresh.
 *
 * Throws {@link PermanentRefreshError} for HTTP 4xx (except 429) and
 * {@link TransientRefreshError} for network/timeout/5xx/429.
 */
export async function refreshOAuthToken(
  refreshToken: string,
  opts: RefreshOptions = {}
): Promise<RefreshResult> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const now = opts.now ?? Date.now;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        scope: SCOPE,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    // Network failure OR abort/timeout — both transient. Report only the error
    // NAME, never the message (which could echo request data) or the token.
    clearTimeout(timer);
    throw new TransientRefreshError(
      `refresh request failed: ${err instanceof Error ? err.name : "unknown error"}`
    );
  }

  // #4423: the timer stays armed through the BODY read too. A body that stalls
  // after the headers would otherwise hang forever — and the credential lock's
  // heartbeat would keep that holder's lock alive, blocking every rotation and
  // recovery of the account. An aborted body read is transient.
  try {
    if (response.ok) {
      let data: RefreshTokenResponse;
      try {
        data = (await response.json()) as RefreshTokenResponse;
      } catch (err) {
        throw new TransientRefreshError(
          `refresh response unreadable: ${err instanceof Error ? err.name : "unknown error"}`
        );
      }
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? refreshToken,
        expiresAt: now() + data.expires_in * 1000,
      };
    }
    // Non-2xx — read the OAuth error code for diagnostics (it is NOT a secret).
    let errorCode = "";
    try {
      const errBody = (await response.json()) as { error?: string };
      errorCode = errBody?.error ?? "";
    } catch {
      // Body absent, not JSON, or aborted — the status alone classifies it.
    }
    const detail = `HTTP ${response.status}${errorCode ? ` (${errorCode})` : ""}`;
    if (response.status === 429 || response.status >= 500) {
      throw new TransientRefreshError(`refresh failed: ${detail}`);
    }
    // 4xx (400/401/403/…) — the refresh token is bad. Permanent.
    throw new PermanentRefreshError(`refresh rejected: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

// --- Service --------------------------------------------------------------------

/**
 * The minimal slice of A's `AccountStore` (#1447) that B depends on. The real
 * `AccountStore` class structurally satisfies this; tests pass an in-memory fake.
 */
export interface TokenRefreshAccountStore {
  list(): Promise<AccountIndexEntry[]>;
  get(accountUuid: string): Promise<ValidateAccountResult | null>;
  put(account: StoredAccount): Promise<void>;
  /**
   * Optional atomic read-merge-write (issue #1635, F2). The real `AccountStore`
   * implements this under a per-account-file cross-process lock; when present,
   * {@link TokenRefreshService}'s `persistPatch` routes through it so two
   * concurrent patches on the same account can never lose each other's fields
   * (the pre-#1635 get-then-put window could re-publish a revoked token).
   * Returns true when applied, false when the record is missing/malformed.
   * Test fakes may omit it — `persistPatch` falls back to get-then-put.
   */
  update?(
    accountUuid: string,
    mergeFn: (current: StoredAccount) => StoredAccount
  ): Promise<boolean>;
}

export interface TokenRefreshServiceOptions {
  accountStore: TokenRefreshAccountStore;
  /** Refresh seam (default = real {@link refreshOAuthToken}). DI for tests. */
  refreshFn?: (refreshToken: string) => Promise<RefreshResult>;
  /** Clock seam (default = `Date.now`). DI for tests. */
  now?: () => number;
  /**
   * Host-default-account resolver (issue #1520). Returns the `accountUuid` whose
   * OAuth refresh-token family is shared with native Claude Code (read fresh from
   * `~/.claude.json` `oauthAccount.accountUuid`), or `null`. Hapimatic defers that
   * account's refresh to native Claude Code instead of competing (the double-rotation
   * would produce `invalid_grant` lockouts). Default = the real
   * {@link readHostDefaultAccountUuid}; tests inject a fixed value. Read on each
   * refresh decision so the deferral target follows the current host login (dynamic
   * keying).
   */
  getHostDefaultAccountUuid?: () => Promise<string | null>;
  /**
   * Issue #1551: predicate "does this account have an isolated config dir native
   * Claude Code owns?". When true, Hapimatic DEFERS the account's refresh exactly
   * like the host-default account (#1520) — native rotates it in its own
   * CLAUDE_CONFIG_DIR, so Hapimatic must not race it. Generalizes the deferral
   * from host-default-only to every natively-owned account.
   *
   * Issue #1635 (R2): the default is the MACHINE-GLOBAL
   * {@link isIsolatedAccountAnywhere} — a sibling instance's isolated dir also
   * defers, because all instances share one refresh-token family per account
   * and a LOCAL-only check let this scheduler rotate (and server-side revoke)
   * a family another instance had isolated. Tests inject a fixed predicate.
   */
  isIsolatedAccount?: (accountUuid: string) => Promise<boolean>;
  /**
   * Issue #1507: called after each successful proactive or reactive refresh with
   * the refreshed `accountUuid`. Fires from `refreshOnceImpl` AFTER `persistPatch`
   * completes, for BOTH scheduled (`tick`) and reactive (`handleAuthFailure`)
   * refreshes. NOTE: because #1520 makes `tick`/`handleAuthFailure` early-return
   * for the host-default account BEFORE reaching `refreshOnce`, this never fires
   * for the host-default account — by design (those sessions defer to native).
   * The daemon uses this to restart any sessions bound to the refreshed account.
   *
   * Issue #3541 adds a SECOND fire site: `refreshIdleIsolatedAccounts` fires this
   * hook directly after a rotate-anyway rotation of a LOCALLY-bound account (the
   * isolated `forceRefresh` path is callback-suppressed by design, so the backstop
   * fires it explicitly). It is NOT fired for an unbound idle rotation or a
   * remote-only binding — only when the pre-rotation `live.uuids` carried the uuid.
   */
  onSuccessfulRefresh?: (accountUuid: string) => void;
  /**
   * Issue #1644: acquire the cross-machine rotation lease for `accountUuid`
   * before proactively rotating its family. Returns true ⇒ this node may rotate;
   * false ⇒ another federation node holds the lease, so defer (skip rotation,
   * mirror the isolated-account `continue`). Default `async () => true` keeps
   * `tick()` byte-equivalent to #1635 — no lease coordination (R1/R6). The daemon
   * injects the feature-gated `RotationLeaseClient.acquireRotationLease`.
   */
  acquireRotationLease?: (accountUuid: string) => Promise<boolean>;
  /**
   * Issue #1806: returns the accounts that currently have a live session bound
   * anywhere (local + every federation node), so {@link
   * TokenRefreshService.refreshIdleIsolatedAccounts} can skip them (the
   * P-REVOKE kill-vector). The daemon injects a closure that queries the local
   * `/cli/sessions` list (by `accountUuid`) and the federation
   * `/api/federation/all-sessions` view (by `claudeAccount.email`). Default
   * returns empty sets — so the backstop treats every account as idle, which is
   * only safe when no live sessions exist (tests inject explicit sets).
   */
  getLiveAccountKeys?: () => Promise<LiveAccountKeys>;
  /**
   * Issue #4423 (R5): the accounts bound by a live session of a SIBLING
   * instance on this machine, plus whether that view is degraded (the daemon
   * wires `scanSiblingBoundAccounts`). The backstop skips a sibling-bound account
   * — this daemon cannot restart another instance's session. Called at most once
   * per pass, and only once an account has passed the near-expiry gate. Default:
   * none bound, not degraded (tests / wrappers are byte-equivalent).
   */
  getSiblingBoundAccounts?: () => Promise<SiblingBindingScan>;
  /**
   * Issue #3784: `true` ⇒ in the MIXED (local AND remote) near-expiry case the
   * idle backstop may rotate this node's OWN chain + restart its OWN session
   * (instead of the unconditional P-REVOKE skip) when
   * {@link assessRemoteChainIndependence} proves this node's chain is a DISTINCT
   * grant from every remote holder's. Default **false** ⇒ byte-identical to the
   * pre-#3784 skip (ship gated; daemon reads `HAPI_IDLE_ROTATE_REMOTE_INDEPENDENT`).
   * The REMOTE-ONLY case always skips regardless.
   */
  rotateWhenRemoteIndependent?: boolean;
  /**
   * Issue #3784: the composed cross-node independence verdict for an account (see
   * {@link assessRemoteChainIndependence}). The daemon wires a closure that reads
   * THIS node's chain fingerprint and compares it against the other federation
   * nodes' fingerprints. Default always "unknown" ⇒ fail-safe skip ⇒ an unwired
   * service is byte-identical to the pre-#3784 skip even with the flag on.
   */
  assessRemoteChainIndependence?: (
    accountUuid: string
  ) => Promise<ChainIndependence>;
  /**
   * Issue #1806: returns an isolated account's current access-token expiry (ms
   * epoch) read from its isolated `.credentials.json` — the source of truth for
   * a non-host account (the store copy is advisory cache and can lag). Used by
   * the idle-refresh backstop's near-expiry gate. Default reads via
   * {@link readIsolatedCredentials}; returns null when the dir is unreadable
   * (the backstop then falls back to the store record's `expiresAt`). Injectable
   * so unit tests need no real filesystem.
   */
  getIsolatedExpiresAt?: (accountUuid: string) => Promise<number | null>;
  /**
   * Issue #3544: non-destructive validity probe for an isolated account's
   * access token — used by {@link TokenRefreshService.clearStaleUnrefreshableFlags}
   * for a LEGACY flag only (one with no failed-token fingerprint, #4423).
   * Injected (not imported) because {@link probeAccessToken} lives in
   * `isolatedSnapshotRecovery.ts`, which value-imports this class, so a direct
   * import here would be a module cycle. Returns "healthy" | "revoked" |
   * "indeterminate" and never throws. The daemon wires it to `probeAccessToken`;
   * absent (tests / no daemon) ⇒ a legacy flag never clears.
   */
  probeToken?: (
    accessToken: string
  ) => Promise<"healthy" | "revoked" | "indeterminate">;
  /**
   * Issue #3541: when true, `refreshIdleIsolatedAccounts` may rotate a
   * near-expiry isolated account that has a LOCALLY-bound, non-inferring live
   * session (then restart it via `onSuccessfulRefresh`) instead of skipping it at
   * the #1645 P-REVOKE guard. A REMOTE (federation) binding, a mid-inference
   * session (pre-expiry), and a store-cache-derived near-expiry are each still
   * skipped regardless. Default **false** so an unconfigured service (tests / no
   * daemon) is byte-equivalent to the pre-#3541 P-REVOKE skip; the daemon passes
   * `configuration.idleRotateAnywayEnabled` (default ON).
   */
  rotateBoundAtExpiry?: boolean;
  /**
   * Issue #3023: optional per-tick utilization sampler for the un-pinned spawn veto.
   * When provided, `tick()` invokes it at the LOOP-TOP with the full account list —
   * BEFORE the host-default / isolated deferral branches — so the veto's utilization
   * cache is refreshed for EVERY account, including the host-default that the refresh
   * loop defers to native (#1520). It is called best-effort and must never throw into
   * the tick (the daemon wires `createUtilizationSampler`, which swallows its own
   * errors). Default **absent** ⇒ an unconfigured service (tests / no daemon) is
   * byte-equivalent to pre-#3023 (no sampling, no network).
   */
  sampleUtilization?: (entries: readonly AccountIndexEntry[]) => Promise<void>;
  /** Refresh this many ms before expiry (default 5 min). */
  expiryBufferMs?: number;
  /** Max scheduled retry attempts on transient failure (default 3). */
  maxScheduledAttempts?: number;
  /** Backoff bounds for scheduled retries (ms). */
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** Scheduler tick clamp (ms). `maxTickMs` bounds newly-added-account latency. */
  minTickMs?: number;
  maxTickMs?: number;
  /** Max ms `stop()` waits for in-flight refreshes before returning. */
  stopTimeoutMs?: number;
  /**
   * Consecutive-tick-error threshold (issue #2035): after this many scheduler
   * ticks catch an error in a row, the `token-refresh` registry row flips to
   * `"dead"` so the server's DaemonJobsMonitor raises a durable alert on the
   * ok→dead transition. Any clean tick resets the counter. Clamped ≥ 2
   * (single-throw tolerance). Default 3.
   */
  failureThreshold?: number;
  /**
   * #1964 (Sub-D): the daemon's runtime job registry. When provided, the
   * scheduler registers a `token-refresh` row and stamps `lastTickAt`/status
   * each tick so the System Jobs portal shows liveness and the daemon
   * stall-watchdog can detect a silent stop. Omitted in tests => no-op.
   */
  jobRegistry?: JobRegistry;
  /** #1964: federation node label for the registered row. Default "standalone". */
  jobNode?: string;
}

/**
 * Internal single-attempt refresh outcome. The `detail` on the failure variants
 * carries the (non-secret) HTTP-status / OAuth-error-code string from the
 * underlying error message (e.g. `refresh rejected: HTTP 400 (invalid_grant)`) so
 * {@link TokenRefreshService.forceRefresh} can surface it to the on-demand harness
 * (issue #1547). Token values never appear in these messages — see
 * {@link refreshOAuthToken}.
 */
type RefreshOutcome =
  | { status: "success"; accessToken: string }
  | { status: "permanent"; detail?: string; rejectedTokenFingerprint?: string }
  | { status: "transient"; detail?: string }
  // Issue #4423: an isolated rotation found no readable credentials once it held
  // the machine lock. Never produced by the store-token path (refreshOnceImpl).
  | { status: "not-found" };

/**
 * Structured outcome of {@link TokenRefreshService.forceRefresh} — the on-demand
 * force-refresh harness (issue #1547). Distinguishes every terminal state the
 * harness reports per-step, including the host-default deferral (#1520) as a
 * first-class EXPECTED outcome rather than a false failure.
 */
export type ForceRefreshOutcome =
  | { kind: "success"; accessToken: string }
  // #4423: `rejectedTokenFingerprint` names the token that failed (isolated path).
  | { kind: "permanent"; detail: string; rejectedTokenFingerprint?: string }
  | { kind: "transient"; detail: string }
  | { kind: "host-default-deferred"; emailAddress: string }
  | { kind: "not-found" };

/** Map a single-attempt outcome to the force-refresh harness's shape. */
function toForceRefreshOutcome(outcome: RefreshOutcome): ForceRefreshOutcome {
  switch (outcome.status) {
    case "success":
      return { kind: "success", accessToken: outcome.accessToken };
    case "permanent":
      return {
        kind: "permanent",
        detail: outcome.detail ?? "permanent refresh failure",
        rejectedTokenFingerprint: outcome.rejectedTokenFingerprint,
      };
    case "transient":
      return {
        kind: "transient",
        detail: outcome.detail ?? "transient refresh failure",
      };
    case "not-found":
      return { kind: "not-found" };
  }
}

/**
 * Issue #1806: the set of accounts that currently have a LIVE (active) session
 * bound to them anywhere the rotation must respect. The idle-refresh backstop
 * skips any account in this set (rotating its family revokes the live session's
 * access token within <60s — the #1645 P-REVOKE kill-vector).
 *
 * Two key spaces because the live-session sources disagree on the reliable key:
 * the LOCAL session list carries `metadata.accountUuid`, while federation
 * SessionSummaries reliably carry `metadata.claudeAccount.email` (the
 * `metadata.accountUuid` field is "set by a future spawn-wiring sub-issue" — not
 * guaranteed populated on remote sessions). An account counts as in-use when its
 * `accountUuid` ∈ `uuids` OR its `emailAddress` ∈ `emails`.
 */
export interface LiveAccountKeys {
  uuids: Set<string>;
  emails: Set<string>;
  /**
   * Issue #1834: `true` ⇒ the federation `/api/federation/all-sessions` query
   * failed this pass, so `emails` is local-only-blind and remote liveness is
   * UNKNOWN — NOT proven empty. Consumers must fail SAFE (skip rotation) rather
   * than treat an account as remote-idle: rotating a family whose only live
   * session is remote revokes that session's access token within <60s (the
   * #1645 P-REVOKE kill-vector). Optional so the three construction sites stay
   * byte-compatible (the daemon closure in `run.ts`, the constructor default
   * lambda below, and the test literals); absent/false ⇒ the federation query
   * succeeded (or no daemon is wired), so `emails` is trustworthy.
   */
  federationDegraded?: boolean;
  /**
   * Issue #3640: `true` ⇒ the LOCAL `/cli/sessions` query failed this pass (a
   * non-OK response — incl. the missing-`cliApiToken` 401 — or a throw), so
   * `uuids` is incomplete and LOCAL liveness is UNKNOWN — NOT proven empty.
   * Consumers must fail SAFE (skip rotation) rather than treat an account as
   * local-idle: rotating a family whose only live session is local revokes that
   * session's access token within <60s (the #1645 P-REVOKE kill-vector, the
   * local-axis mirror of `federationDegraded`). Optional for the same
   * byte-compatibility reason as `federationDegraded` (the daemon closure in
   * `run.ts`, the constructor default lambda, and the test literals); absent/false
   * ⇒ the local query succeeded, so `uuids` is trustworthy.
   */
  localDegraded?: boolean;
  /**
   * Issue #3541: the subset of `uuids`/`emails` whose bound live session is
   * mid-inference (`Session.thinking === true`). `inferring ⊆ live` by
   * construction (populated only inside the daemon's `isSessionLiveForGuard`
   * gate). The rotate-anyway backstop DEFERS a locally-bound (`inferring.uuids`)
   * mid-turn session — rotating would revoke its in-memory access token mid-turn
   * (#1653/#1647). Optional so the pre-#3541 construction sites and test literals
   * stay byte-compatible; absent ⇒ treated as "nothing inferring" (safe: the
   * rotate-anyway path additionally requires the switch ON + a local binding, so
   * an absent `inferring` can never rotate an account the switch-off default
   * would have skipped).
   */
  inferring?: { uuids: Set<string>; emails: Set<string> };
}

export class TokenRefreshService {
  private readonly store: TokenRefreshAccountStore;
  private readonly refreshFn: (refreshToken: string) => Promise<RefreshResult>;
  private readonly now: () => number;
  private readonly getHostDefaultAccountUuid: () => Promise<string | null>;
  private readonly isIsolatedAccount: (accountUuid: string) => Promise<boolean>;
  private readonly onSuccessfulRefresh?: (accountUuid: string) => void;
  private readonly acquireRotationLease: (
    accountUuid: string
  ) => Promise<boolean>;
  private readonly getLiveAccountKeys: () => Promise<LiveAccountKeys>;
  private readonly getSiblingBoundAccounts: NonNullable<
    TokenRefreshServiceOptions["getSiblingBoundAccounts"]
  >;
  private readonly getIsolatedExpiresAt: (
    accountUuid: string
  ) => Promise<number | null>;
  /**
   * Issue #3544: injected non-destructive token-validity probe (see the option
   * doc). Undefined ⇒ a legacy (fingerprint-less) flag never clears.
   */
  private readonly probeToken?: (
    accessToken: string
  ) => Promise<"healthy" | "revoked" | "indeterminate">;
  /**
   * Issue #3544: last stale-flag probe time (ms epoch) per uuid. Bounds the
   * backstop to one probe per uuid per 10-min window so a genuinely-dead family
   * costs one network call per window, not one per 60s maintenance pass.
   */
  private readonly unrefreshableProbeAt = new Map<string, number>();
  /**
   * Issue #3541: rotate-anyway gate (see the option doc). `false` ⇒ a
   * locally-bound near-expiry account keeps the pre-#3541 P-REVOKE skip.
   */
  private readonly rotateBoundAtExpiry: boolean;
  /** #3784: mixed-case rotate-when-independent gate (default false ⇒ pre-#3784 skip). */
  private readonly rotateWhenRemoteIndependent: boolean;
  /** #3784: composed cross-node independence verdict seam (default ⇒ "unknown"). */
  private readonly assessChainIndependence: (
    accountUuid: string
  ) => Promise<ChainIndependence>;
  /** #3023: per-tick utilization sampler for the un-pinned spawn veto (see option). */
  private readonly sampleUtilization?: (
    entries: readonly AccountIndexEntry[]
  ) => Promise<void>;
  private readonly expiryBufferMs: number;
  private readonly maxScheduledAttempts: number;
  private readonly backoffMinMs: number;
  private readonly backoffMaxMs: number;
  private readonly minTickMs: number;
  private readonly maxTickMs: number;
  private readonly stopTimeoutMs: number;
  private readonly jobRegistry: JobRegistry | null;
  private readonly jobNode: string;
  private readonly failureThreshold: number;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private stopped = false;
  private consecutiveTickErrors = 0;
  /** In-flight single-attempt refreshes keyed by accountUuid (dedup). */
  private readonly inFlight = new Map<string, Promise<RefreshOutcome>>();

  constructor(options: TokenRefreshServiceOptions) {
    this.store = options.accountStore;
    this.refreshFn =
      options.refreshFn ?? (refreshToken => refreshOAuthToken(refreshToken));
    this.now = options.now ?? Date.now;
    this.getHostDefaultAccountUuid =
      options.getHostDefaultAccountUuid ?? readHostDefaultAccountUuid;
    // #1635 R2: machine-global default — see the option's doc comment. The
    // resolver's own local check (`accountTokenInjection.ts`) and the seed
    // guard (`seedAccountConfigDir` overwrite:false) deliberately stay LOCAL:
    // they ask "does THIS instance own a dir", a different question.
    //
    // #1643 (KD-6 Option A, staged): `isIsolatedAccountAnywhere` is now
    // shared-first with a transitional `~/.hapimatic-*` legacy fallback. TODO
    // (post-Task-9 migration sweep): once the sweep confirms zero legacy
    // per-instance dirs machine-wide, simplify this default to the plain
    // `hasIsolatedConfigDir` — the machine-wide scan (and its 30s
    // `instanceHomesCache`) then become dead weight. The single shared dir does
    // NOT by itself prevent a cross-instance rotation race: every instance still
    // rotates the same file (#4423). That race is bounded by the machine
    // rotator role, the compare-and-swap rotation under `.rotate.lock`
    // (`machineRotator.ts`) and the sibling-liveness scan.
    this.isIsolatedAccount =
      options.isIsolatedAccount ?? isIsolatedAccountAnywhere;
    this.onSuccessfulRefresh = options.onSuccessfulRefresh;
    // #1644: default no-op grant ⇒ byte-equivalent #1635 when no lease client is injected.
    this.acquireRotationLease =
      options.acquireRotationLease ?? (async () => true);
    // #1806: idle-refresh backstop seams. Defaults are no-op safe: empty live
    // sets (so the backstop only acts on genuinely-idle accounts once the daemon
    // wires the real query) and a direct isolated-dir expiry read.
    this.getLiveAccountKeys =
      options.getLiveAccountKeys ??
      (async () => ({ uuids: new Set<string>(), emails: new Set<string>() }));
    this.getSiblingBoundAccounts =
      options.getSiblingBoundAccounts ??
      (async () => ({ uuids: new Set<string>(), degraded: false }));
    this.getIsolatedExpiresAt =
      options.getIsolatedExpiresAt ??
      (async uuid => (await readIsolatedCredentials(uuid))?.expiresAt ?? null);
    // #3544: injected token-validity probe for the stale-flag backstop.
    this.probeToken = options.probeToken;
    // #3541: default false ⇒ byte-equivalent to the pre-#3541 P-REVOKE skip.
    this.rotateBoundAtExpiry = options.rotateBoundAtExpiry ?? false;
    // #3784: default false + always-"unknown" verdict ⇒ byte-equivalent to the
    // pre-#3784 unconditional remote-bound skip (ship gated, fail-safe).
    this.rotateWhenRemoteIndependent =
      options.rotateWhenRemoteIndependent ?? false;
    this.assessChainIndependence =
      options.assessRemoteChainIndependence ??
      (async () => "unknown" as ChainIndependence);
    // #3023: optional utilization sampler for the un-pinned spawn veto. Absent by
    // default ⇒ no sampling (tests / no daemon are byte-equivalent to pre-#3023).
    this.sampleUtilization = options.sampleUtilization;
    this.expiryBufferMs = options.expiryBufferMs ?? DEFAULT_EXPIRY_BUFFER_MS;
    this.maxScheduledAttempts = options.maxScheduledAttempts ?? 3;
    this.backoffMinMs = options.backoffMinMs ?? 1_000;
    this.backoffMaxMs = options.backoffMaxMs ?? 30_000;
    this.minTickMs = options.minTickMs ?? 1_000;
    this.maxTickMs = options.maxTickMs ?? 60_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    this.jobRegistry = options.jobRegistry ?? null;
    this.jobNode = options.jobNode ?? "standalone";
    this.failureThreshold = Math.max(2, options.failureThreshold ?? 3);
  }

  /** Begin the cross-account scheduler (R2, R8). Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.consecutiveTickErrors = 0;
    logger.info("[TOKEN_REFRESH] service started");
    // #1964 (Sub-D): register the loop so the System Jobs portal + daemon
    // stall-watchdog see it. intervalMs = maxTickMs (nominal upper bound; the
    // adaptive scheduler ticks at most this often).
    this.jobRegistry?.register({
      name: TOKEN_REFRESH_JOB_NAME,
      node: this.jobNode,
      kind: "in-process-loop",
      intervalMs: this.maxTickMs,
      lastTickAt: null,
      status: "ok",
      lastError: null,
    });
    // The first tick runs promptly so an already-near-expiry account is caught
    // at startup (the founding-spike failure mode: SL7's token had already
    // expired). Scheduled via setTimeout(0) so the loop is uniformly
    // timer-driven and deterministically testable with fake timers.
    this.timer = setTimeout(() => void this.tick(), 0);
  }

  /**
   * Stop the scheduler (R8). Clears the timer and awaits any in-flight refresh
   * within {@link TokenRefreshServiceOptions.stopTimeoutMs} so daemon shutdown
   * never hangs on a slow refresh.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.jobRegistry?.update(TOKEN_REFRESH_JOB_NAME, { status: "stopped" });
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const pending = [...this.inFlight.values()];
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending),
        delay(this.stopTimeoutMs),
      ]);
    }
    logger.info("[TOKEN_REFRESH] service stopped");
  }

  /**
   * Reactive primitive (R6): sub-issue D's launcher / J's restart path call this
   * on a 401. A SINGLE immediate refresh, no backoff loop (no retry storm).
   *
   * Hapimatic injects the token via env var and the `claude` child process makes
   * the inference calls — Hapimatic cannot intercept that internal 401
   * mid-stream. So this is a public seam the CALLER invokes; B does not detect
   * 401s itself (see the directive's Key Decision 3).
   */
  async handleAuthFailure(
    accountUuid: string
  ): Promise<{ refreshed: boolean; accessToken?: string }> {
    const res = await this.store.get(accountUuid);
    if (!res || !res.ok) {
      logger.warn(
        `[TOKEN_REFRESH] handleAuthFailure: account ${accountUuid} ${res ? "is malformed" : "not found"}`
      );
      return { refreshed: false };
    }
    // Issue #2268: env-token accounts carry no refresh token — never rotate them
    // (the bound-spawn path injects their stored token directly). Mirrors the
    // host-default / isolated deferrals below.
    if (isEnvTokenAccount(res.account)) {
      return { refreshed: false };
    }
    if (res.account.unrefreshable) {
      return { refreshed: false };
    }
    // Host-default account (issue #1520): do NOT OAuth-rotate here either — that
    // would race native Claude Code on the shared refresh-token family. Return the
    // current stored token (kept fresh by the CredentialsWatcher); the sole caller
    // (`resolveAccountTokenForSession`) then re-reads the store and checks expiry,
    // throwing only if the token is genuinely expired.
    const hostDefaultUuid = await this.getHostDefaultAccountUuid().catch(
      () => null
    );
    if (hostDefaultUuid && accountUuid === hostDefaultUuid) {
      return { refreshed: false };
    }
    // Issue #1551: an account with an isolated config dir is rotated by native
    // Claude Code in that dir — defer (never rotate here), mirroring the
    // host-default deferral. The launcher uses CLAUDE_CONFIG_DIR for these, so
    // this reactive path is rarely reached for them; defensive parity.
    if (await this.isIsolatedAccount(accountUuid).catch(() => false)) {
      return { refreshed: false };
    }
    const outcome = await this.refreshOnce(res.account);
    return outcome.status === "success"
      ? { refreshed: true, accessToken: outcome.accessToken }
      : { refreshed: false };
  }

  /**
   * On-demand force-refresh primitive (issue #1547) — the seam the
   * `hapi accounts force-refresh <uuid>` harness drives through the daemon.
   *
   * Forces a SINGLE immediate refresh and returns a STRUCTURED outcome so the
   * harness can assert per-step PASS/FAIL and surface the OAuth error code on a
   * permanent failure. Differs from {@link handleAuthFailure} in three ways the
   * harness needs:
   *  1. Returns the granular {@link ForceRefreshOutcome} (incl. `invalid_grant`
   *     detail) instead of a coarse `{refreshed}` boolean.
   *  2. Reports the host-default account (#1520) as an EXPECTED `host-default-deferred`
   *     outcome (never rotates it — the safety-critical shared-family skip lives HERE,
   *     before any OAuth attempt).
   *  3. Does NOT short-circuit on `unrefreshable` — the harness deliberately hits
   *     the endpoint to surface the live `invalid_grant` (or recover) on a
   *     previously-flagged account.
   *
   * Passes `fireCallback=false` to {@link dedupedRefresh}: on the force path the
   * daemon harness orchestrates `restartBoundSessions` EXPLICITLY (so it can
   * observe + report steps 3/4), instead of relying on the fire-and-forget
   * `onSuccessfulRefresh` callback (which would collide with the harness's own
   * awaited restart via the daemon's per-account in-flight guard). The shared
   * `inFlight` dedup still prevents a self-inflicted double-rotation race against
   * a concurrent scheduled refresh of the same account.
   */
  async forceRefresh(accountUuid: string): Promise<ForceRefreshOutcome> {
    const res = await this.store.get(accountUuid);
    if (!res || !res.ok) {
      logger.warn(
        `[TOKEN_REFRESH] forceRefresh: account ${accountUuid} ${res ? "is malformed" : "not found"}`
      );
      return { kind: "not-found" };
    }
    const account = res.account;
    // Host-default account (issue #1520): NEVER OAuth-rotate — that races native
    // Claude Code on the shared refresh-token family and causes the ~8h
    // invalid_grant lockout. Report it as an expected deferral, not a failure.
    const hostDefaultUuid = await this.getHostDefaultAccountUuid().catch(
      () => null
    );
    if (hostDefaultUuid && accountUuid === hostDefaultUuid) {
      logger.info(
        `[TOKEN_REFRESH] forceRefresh: account ${accountUuid} (${account.emailAddress}) is host-default — deferred to native Claude Code`
      );
      return {
        kind: "host-default-deferred",
        emailAddress: account.emailAddress,
      };
    }
    // Issue #1551 (Task 9, KD-3 Option A): an isolated account's live token is in
    // its CLAUDE_CONFIG_DIR (the source of truth), NOT the store. The steady-state
    // scheduler DEFERS it (native rotates it), but the force-refresh harness
    // deliberately exercises the rotation to PROVE refreshability — reporting PASS
    // where #1546 showed FAIL(invalid_grant). Read the isolated refresh token,
    // rotate it, write the rotated result BACK to the isolated dir (so native
    // re-reads it on restart — the harness's restartBoundSessions step), and mirror
    // into the store so the harness's store-delta assertions pass + the UI badge
    // stays fresh.
    if (await this.isIsolatedAccount(accountUuid).catch(() => false)) {
      return await this.forceRefreshIsolated(accountUuid);
    }
    return toForceRefreshOutcome(await this.dedupedRefresh(account, false));
  }

  /**
   * Issue #1551 (Task 9, KD-3 Option A): force-refresh an account whose live
   * token lives in its isolated CLAUDE_CONFIG_DIR. Reads the refresh token native
   * owns, rotates it once, writes the rotated result BACK to the isolated dir
   * (keeping the dir the single source of truth and re-syncing native on its next
   * read/restart), and mirrors into the store so the harness's store-delta
   * assertions pass and the UI badge stays fresh.
   *
   * Callers: the force-refresh harness, the idle backstop and spawn-time
   * recovery — on any instance, against the ONE machine-global file. Issue #4423:
   * the rotation is compare-and-swap under `.rotate.lock`
   * ({@link rotateIsolatedCredentials}), so a caller whose read was overtaken by
   * another writer adopts the on-disk head instead of presenting a consumed
   * token. A running native session still holds the pre-rotation token in
   * memory; restartBoundSessions re-points it at the dir (local instance only).
   */
  private async forceRefreshIsolated(
    accountUuid: string
  ): Promise<ForceRefreshOutcome> {
    const oauth = await readIsolatedCredentials(accountUuid);
    if (!oauth) {
      // The isolated dir is unseeded/unreadable — there is no live token to test.
      // Treat as not-found so the harness surfaces "no isolated credentials".
      logger.warn(
        `[TOKEN_REFRESH] forceRefreshIsolated: no readable isolated credentials for ${accountUuid}`
      );
      return { kind: "not-found" };
    }
    // Issue #1635 (F3): route through the shared per-uuid `inFlight` dedup —
    // the pre-#1635 direct `refreshFn` call let two concurrent isolated
    // rotations of the SAME account each present the same refresh token; the
    // second consumed a just-superseded token (the exact bug class #1635
    // fixes). Joining an in-flight entry is always an isolated rotation: the
    // scheduler defers isolated accounts, so it never registers one here.
    const existing = this.inFlight.get(accountUuid);
    let p: Promise<RefreshOutcome>;
    if (existing) {
      p = existing;
    } else {
      p = this.rotateIsolatedOnceImpl(accountUuid, oauth).finally(() => {
        this.inFlight.delete(accountUuid);
      });
      this.inFlight.set(accountUuid, p);
    }
    return toForceRefreshOutcome(await p);
  }

  /**
   * Single isolated-dir rotation attempt (the deduplicated unit for #1635 F3).
   * Issue #4423: compare-and-swap under the per-account machine lock — see
   * {@link rotateIsolatedCredentials} for the adopt / rotate / flag rules. The
   * `unrefreshable` flag still keys the "re-login required" UX of spawn-time
   * recovery and the env-token resolver.
   */
  private rotateIsolatedOnceImpl(
    accountUuid: string,
    oauth: NonNullable<Awaited<ReturnType<typeof readIsolatedCredentials>>>
  ): Promise<RefreshOutcome> {
    return rotateIsolatedCredentials({
      accountUuid,
      presentedRefreshToken: oauth.refreshToken,
      refreshFn: this.refreshFn,
      isPermanentError: err => err instanceof PermanentRefreshError,
      mergeStore: mergeFn => this.persistMerge(accountUuid, mergeFn),
      now: this.now,
      expiryBufferMs: this.expiryBufferMs,
    });
  }

  /**
   * Issue #1806: proactive idle-refresh backstop for non-host isolated accounts.
   *
   * `tick()` DEFERS every isolated account to native Claude Code (#1635 R2);
   * native rotates an account's token ONLY while a live `claude` process for it
   * is running. So an account that is isolated AND idle (no live session
   * anywhere) has NO rotator — its access token decays to ~8h expiry and the
   * account dies until a manual re-login. This method, called from the daemon's
   * 60s maintenance loop, fills that gap: it rotates idle, near-expiry, non-host
   * isolated accounts that have no live session bound on any federation node,
   * after acquiring the #1644 family lease.
   *
   * ADDITIVE — it does NOT touch `tick()`'s deferral (R6); the two paths are
   * disjoint (`tick()` proactively rotates NON-isolated accounts; this rotates
   * the isolated ones `tick()` defers). NEVER throws into the daemon loop (R7).
   *
   * Guard order (cheapest first): host-default → not-isolated → unrefreshable →
   * not-near-expiry → remote-bound-skip → local-bound-switch-off-skip →
   * federation-degraded-skip → [#3541 rotate-anyway gate: local ∧ ¬inferring ∧
   * file-authoritative near-expiry] → lease. Only an account that clears all
   * guards is rotated via {@link forceRefresh} (which routes isolated accounts to
   * {@link forceRefreshIsolated}: rotate once, write back to the isolated dir,
   * mirror the store). `forceRefresh` does NOT itself acquire the lease, so this
   * method acquires it first (R5).
   *
   * Issue #3541 SPLIT the former single "live-session-anywhere" P-REVOKE skip:
   * a REMOTE (federation) binding still always skips (no cross-node restart), but
   * a near-expiry LOCALLY-bound, non-inferring session is now ROTATED and then
   * restarted (via `onSuccessfulRefresh` → the daemon's `restartBoundSessions`)
   * when `rotateBoundAtExpiry` is on — the fix for the live-but-idle deadlock.
   */
  async refreshIdleIsolatedAccounts(): Promise<void> {
    try {
      // #3808 (R7): the token-refresh loop is Anthropic-only — OAuth refresh + the
      // isolated-dir machinery are Anthropic constructs. Filter out non-Anthropic
      // records (absent provider ⇒ anthropic) BEFORE the loop AND before the
      // utilization sampler, so a codex/gemini record is never OAuth-refreshed nor
      // probed against api.anthropic.com. `store.get()` below is also Anthropic-only
      // (defence in depth), but the sampler reads the raw entries.
      const entries = await this.listAnthropicEntries();
      // Resolve once per pass (mirrors tick()'s dynamic host-default keying).
      const hostDefaultUuid = await this.getHostDefaultAccountUuid().catch(
        () => null
      );
      const live = await this.getLiveAccountKeys().catch(() => ({
        uuids: new Set<string>(),
        emails: new Set<string>(),
        // Issue #1834: KEEP this fallback (Fallback Preservation Rule) but flip
        // it from fail-open to fail-safe. `getLiveAccountKeys` is non-throwing
        // today, but if it ever throws, an empty `{uuids,emails}` would let the
        // P-REVOKE guard skip NOTHING and rotate every idle account blind. A
        // `federationDegraded: true` result makes the degrade guard below skip
        // rotation instead (belt-and-suspenders, R5). Issue #3640: also set
        // `localDegraded: true` so a throw fails safe on BOTH axes — an empty
        // `uuids` from a throw must not be read as "no local session either".
        federationDegraded: true,
        localDegraded: true,
        // Issue #3541: complete the shape; irrelevant on this path (the
        // degrade skip below fires before the rotate-anyway gate).
        inferring: { uuids: new Set<string>(), emails: new Set<string>() },
      }));
      // Issue #4423 (R5): sibling-instance bindings — scanned lazily, at most
      // once per pass, only once an account passes the near-expiry gate. A
      // throwing scan fails safe (degraded), like getLiveAccountKeys above.
      let siblings: SiblingBindingScan | undefined;
      const siblingView = async () =>
        (siblings ??= await this.getSiblingBoundAccounts().catch(() => ({
          uuids: new Set<string>(),
          degraded: true,
        })));
      for (const entry of entries) {
        if (this.stopped) return;
        const res = await this.store.get(entry.accountUuid);
        if (!res || !res.ok) continue;
        const account = res.account;
        const uuid = account.accountUuid;
        // Issue #2268: never rotate an env-token account (no refresh token). It
        // also never owns an isolated dir, so the isolated-only gate below would
        // already `continue` — this is the explicit, kind-first guard.
        if (isEnvTokenAccount(account)) continue;
        // R2: never rotate the host-default account (native owns it).
        if (hostDefaultUuid && uuid === hostDefaultUuid) continue;
        // Only isolated accounts — tick() already proactively rotates the
        // non-isolated ones (this backstop must not double-rotate them).
        if (!(await this.isIsolatedAccount(uuid).catch(() => false))) continue;
        // R3: an `unrefreshable` account needs a re-login before it rotates
        // again. A stale flag is cleared by {@link clearStaleUnrefreshableFlags}
        // (#4423: on EVERY daemon, every tick — not only where this backstop
        // runs), which picks the account up on the next pass.
        if (account.unrefreshable) continue;
        // Near-expiry gate (KD-6): prefer the isolated dir's expiry (source of
        // truth); fall back to the store copy. Skip accounts not yet near expiry
        // so each account rotates at most once per ~8h.
        const isolatedExpiresAt = await this.getIsolatedExpiresAt(uuid).catch(
          () => null
        );
        const expiresAt = isolatedExpiresAt ?? account.expiresAt;
        if (expiresAt - this.now() > this.expiryBufferMs) continue;
        // Issue #3541: SPLIT the #1645 P-REVOKE guard (was a single skip on ANY
        // live binding). It is a two-key OR whose keys are NOT interchangeable —
        // `uuids` = a LOCAL binding this node CAN restart (`restartBoundSessions`
        // via the `onSuccessfulRefresh` hook); `emails` = a REMOTE/federation
        // binding this node has NO way to restart. So a near-expiry LOCAL binding
        // may rotate-anyway (rotate then restart), while a REMOTE binding must
        // always keep the skip.
        const boundLocally = live.uuids.has(uuid);
        const boundRemotely = !!(
          account.emailAddress && live.emails.has(account.emailAddress)
        );
        // Issue #3784: a REMOTE (federation) binding splits into two cases.
        // REMOTE-ONLY (no local session here) ALWAYS keeps the skip — nothing on
        // this node to keep alive, and rotating buys nothing (a future local
        // spawn is covered by spawn-time recovery). The MIXED (local AND remote)
        // case is delegated to {@link decideMixedBindingRotation}: when the
        // #3784 gate is ON and this node's chain is PROVEN independent of every
        // remote holder's (distinct refresh-token fingerprint), it rotates THIS
        // node's own chain and restarts THIS node's own session (falling through
        // to the #3541 path below) — the remote holder's independent chain is
        // untouched. Any doubt (gate off, shared copy, degraded view) fails SAFE
        // to the pre-#3784 skip.
        if (boundRemotely) {
          if (!boundLocally) {
            logger.info(
              `[IDLE_REFRESH] skip ${uuid} (${account.emailAddress}) — live session bound on a federation node, none local (P-REVOKE guard; no cross-node restart)`
            );
            continue;
          }
          const decision = await decideMixedBindingRotation({
            accountUuid: uuid,
            emailAddress: account.emailAddress ?? "",
            enabled: this.rotateWhenRemoteIndependent,
            assess: u => this.assessChainIndependence(u),
          });
          if (decision.action === "skip") {
            if (decision.level === "warn") logger.warn(decision.message);
            else logger.info(decision.message);
            if (decision.jobError) {
              this.jobRegistry?.update(TOKEN_REFRESH_JOB_NAME, {
                lastError: decision.jobError,
              });
            }
            continue;
          }
          // decision.action === "rotate": independent chain proven — fall through
          // to the sibling / rotate-anyway path, which rotates this node's chain
          // and restarts this node's local session (#3541).
          logger.info(decision.message);
        }
        // Issue #4423 (R5): a live session of a SIBLING instance on this machine
        // ALWAYS skips — this daemon cannot restart another instance's session,
        // and its own server cannot see it. A mixed own + sibling binding skips
        // too. Own-instance bindings keep the #3541 rules below, untouched.
        const sibling = await siblingView();
        if (sibling.uuids.has(uuid)) {
          const msg = `[IDLE_REFRESH] skip ${uuid} (${account.emailAddress}) — live session bound on a sibling instance on this machine (no cross-instance restart)`;
          if (isolatedExpiresAt !== null && isolatedExpiresAt <= this.now()) {
            logger.warn(`${msg}; the credentials file is past expiry`);
          } else {
            logger.info(msg);
          }
          continue;
        }
        // A LOCAL binding keeps the pre-#3541 P-REVOKE skip UNLESS rotate-anyway
        // is switched on (default ON in prod; OFF in tests / when the option is
        // absent ⇒ byte-equivalent to the old guard). The rotate-anyway decision
        // for a local binding is deferred to AFTER the degrade guards below.
        if (boundLocally && !this.rotateBoundAtExpiry) {
          logger.info(
            `[IDLE_REFRESH] skip ${uuid} (${account.emailAddress}) — live session bound (P-REVOKE guard)`
          );
          continue;
        }
        // Issue #1834 + #3640: session visibility was lost this pass on at least
        // one axis — the federation `/api/federation/all-sessions` query
        // (`federationDegraded`) and/or the local `/cli/sessions` query
        // (`localDegraded`). Either way we CANNOT confirm this account is idle.
        // Do NOT rotate it blind — that would revoke a live session's token (the
        // #1645 P-REVOKE kill-vector). NOTE: when `localDegraded` is set the
        // P-REVOKE guard above is UNRELIABLE (its `uuids` set is incomplete), so
        // this guard also covers the local-only-live case the P-REVOKE guard can
        // no longer see; when only `federationDegraded` is set it covers the
        // remote-only case (a local-live account was already skipped above).
        // Issue #3541: the rotate-anyway gate below is deliberately placed AFTER
        // this degrade skip — a pass blind on EITHER axis never rotates a
        // (possibly-invisible) bound account.
        // Sits after the P-REVOKE guard and before the lease guard so no degraded
        // account ever reaches `forceRefresh`.
        if (live.federationDegraded || live.localDegraded || sibling.degraded) {
          // Name the degraded axis (or axes) so the operator sees which
          // visibility was lost this pass. #4423: a machine-wide /proc scan that
          // could not list processes is a third axis (sibling liveness unknown).
          const degradedAxis = [
            live.federationDegraded && "federation",
            live.localDegraded && "local",
            sibling.degraded && "machine-wide /proc",
          ]
            .filter(Boolean)
            .join(" and ");
          // D10a bounded escalation: this guard runs AFTER the near-expiry gate
          // above, so any account reaching it was inside its expiry buffer and
          // would have been rotated this pass. Surface that one skip loudly —
          // `warn` + stamp the token-refresh job's `lastError` — so a sustained
          // outage shows red in the System Jobs portal instead of staying
          // silently green. Volume is bounded to the near-expiry population
          // (~1 account/pass). A non-near-expiry degrade-skip stays at `info`
          // per R4 — none reach here at this placement, but the branch is kept
          // explicit so the invariant survives a future guard move.
          const msg = `[IDLE_REFRESH] skip ${uuid} (${account.emailAddress}) — ${degradedAxis} visibility degraded; cannot confirm idle (fail-safe)`;
          const withinExpiryBuffer =
            expiresAt - this.now() <= this.expiryBufferMs;
          if (withinExpiryBuffer) {
            logger.warn(msg);
            this.jobRegistry?.update(TOKEN_REFRESH_JOB_NAME, {
              lastError: `[IDLE_REFRESH] ${degradedAxis} visibility degraded — skipped near-expiry ${uuid} (${account.emailAddress}) to avoid blind rotation`,
            });
          } else {
            logger.info(msg);
          }
          continue;
        }
        // Issue #3541: rotate-anyway gate for a LOCALLY-bound account. Reached
        // only when the switch is ON (a switch-OFF local binding already `continue`d
        // above) and the pass is NOT federation-degraded (so an invisible remote
        // binding is ruled out). Two remaining conditions gate the rotation:
        if (boundLocally) {
          const inferring = live.inferring ?? {
            uuids: new Set<string>(),
            emails: new Set<string>(),
          };
          const postExpiry = expiresAt - this.now() <= 0;
          // R8: NEVER restart a mid-turn session — rotating revokes its in-memory
          // access token mid-inference (and `restartBoundSessions` would then hit
          // the 202-deferral → 3×30s retry → give-up, stranding it on a dead
          // token). The ONLY exception is a POST-expiry token (nothing live is
          // left to revoke): the bounded backstop for a frozen `thinking:true`
          // tmux/pty session (#1653/#1647). No pre-expiry "last resort" — that
          // races native Claude Code's in-memory refresh token into the #1520
          // family lockout, and native self-heals a genuinely-inferring isolated
          // session today (#1551).
          if (inferring.uuids.has(uuid) && !postExpiry) {
            logger.info(
              `[IDLE_REFRESH] defer ${uuid} (${account.emailAddress}) — bound session mid-inference`
            );
            continue;
          }
          // R3: rotate-anyway requires the near-expiry judgement to come from the
          // authoritative isolated FILE (`isolatedExpiresAt !== null`), not the
          // store cache — which #3392 classifies as an advisory copy lagging up
          // to ~24h. A store-fallback near-expiry keeps the P-REVOKE skip: without
          // the shield a healthy live session would be rotated+restarted off a
          // false near-expiry.
          if (isolatedExpiresAt === null) {
            logger.info(
              `[IDLE_REFRESH] skip ${uuid} (${account.emailAddress}) — near-expiry from store cache, not the isolated file (P-REVOKE guard)`
            );
            continue;
          }
          // All four conditions hold (local ∧ ¬inferring ∧ file-authoritative ∧
          // switch-on) → fall through to the lease + rotate + bound-session restart.
        }
        // R5: acquire the cross-machine family lease before the destructive
        // rotation (single owner). A non-holder defers — mirrors tick()'s gate.
        if (!(await this.acquireRotationLease(uuid))) {
          logger.info(
            `[IDLE_REFRESH] defer ${uuid} (${account.emailAddress}) — family lease held by another node`
          );
          continue;
        }
        const outcome = await this.forceRefresh(uuid);
        // Issue #3541 (Task 3): restart the LOCALLY-bound session whose access
        // token we just revoked, via the SAME injected hook the tick() path uses
        // (run.ts wires `onSuccessfulRefresh` → `restartBoundSessions`). Fire it
        // ONLY for a locally-bound success — an UNBOUND rotation has nothing to
        // restart, a REMOTE binding already `continue`d, and firing it inside
        // `forceRefreshIsolated` is contractually forbidden (that path is
        // callback-suppressed so the `hapi accounts force-refresh` harness can
        // drive `restartBoundSessions` explicitly). `boundLocally` is the
        // pre-rotation capture of `live.uuids.has(uuid)`.
        if (boundLocally && outcome.kind === "success") {
          this.onSuccessfulRefresh?.(uuid);
        }
        logger.info(
          `[IDLE_REFRESH] ${uuid} (${account.emailAddress}) → ${outcome.kind}`
        );
      }
    } catch (err) {
      // R7: never throw into the daemon maintenance loop (fail-safe).
      logger.warn(
        `[IDLE_REFRESH] backstop pass error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Issue #4423 (Task 6, R3): clear a STALE `unrefreshable` flag on a non-host
   * isolated account. The flag is per-instance store state while the token it
   * describes is machine-global, so this instance's flag can outlive the token
   * that failed (a re-login, a sibling's successful rotation, a last-resort
   * seed). The server refuses spawns on a flagged record, so a daemon whose
   * backstop is off (dev, every worktree) must still clear its own store: this
   * runs on EVERY daemon, every maintenance tick, regardless of the
   * machine-rotator role and of HAPI_IDLE_REFRESH. It takes no lease, makes no
   * session query and never rotates. Never throws.
   *
   * The rule. A flag WITH a failed-token fingerprint clears only when the file's
   * CURRENT refresh token is a different token — no probe (a healthy ACCESS
   * token says nothing about the refresh token: dev cleared and re-rotated into
   * invalid_grant within 2 minutes on 2026-09-26). The same token stays
   * flagged. A legacy flag with no fingerprint keeps only the probe arm (one
   * probe per account per 10 min; clear on `healthy`, never on
   * `indeterminate`); if it fails once more, that flag carries a fingerprint.
   * A clear writes the file's full triple, so the store's expiry describes a
   * token the store actually holds.
   */
  async clearStaleUnrefreshableFlags(): Promise<void> {
    try {
      const entries = await this.listAnthropicEntries();
      const hostDefaultUuid = await this.getHostDefaultAccountUuid().catch(
        () => null
      );
      for (const entry of entries) {
        if (this.stopped) return;
        const res = await this.store.get(entry.accountUuid);
        if (!res || !res.ok || !res.account.unrefreshable) continue;
        const account = res.account;
        const uuid = account.accountUuid;
        // Env-token records have no refresh token (#2268); the host-default's
        // flag is cleared by tick() (#1520); a non-isolated account has no file.
        if (isEnvTokenAccount(account)) continue;
        if (hostDefaultUuid && uuid === hostDefaultUuid) continue;
        if (!(await this.isIsolatedAccount(uuid).catch(() => false))) continue;
        const oauth = await readIsolatedCredentials(uuid).catch(() => null);
        if (!oauth) continue;
        let reason: string;
        if (account.unrefreshableTokenFingerprint) {
          if (!fingerprintedFlagIsStale(account, oauth.refreshToken)) continue;
          reason = "a different refresh token is on disk";
        } else {
          if (!this.canProbeStaleFlag(uuid)) continue;
          const probe = await this.probeToken?.(oauth.accessToken);
          if (probe !== "healthy") continue;
          reason = "legacy flag; access token probed healthy";
        }
        await this.persistMerge(uuid, current => ({
          ...withoutFailedTokenFingerprint(current),
          accessToken: oauth.accessToken,
          refreshToken: oauth.refreshToken,
          expiresAt: oauth.expiresAt,
          unrefreshable: false,
        }));
        logger.info(
          `[IDLE_REFRESH] cleared stale unrefreshable ${uuid} (${account.emailAddress}) — ${reason}`
        );
      }
    } catch (err) {
      logger.warn(
        `[IDLE_REFRESH] stale-flag clear error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // --- internals ----------------------------------------------------------------

  /**
   * #3808 (R7): the store's Anthropic records only (absent provider ⇒
   * anthropic). OAuth refresh and the isolated-dir machinery are Anthropic
   * constructs, so no codex/gemini record is refreshed, probed or flag-cleared.
   */
  private async listAnthropicEntries(): Promise<AccountIndexEntry[]> {
    return (await this.store.list()).filter(
      e => (e.provider ?? "anthropic") === "anthropic"
    );
  }

  /** One scheduler pass: refresh every near-expiry account, then reschedule. */
  private async tick(): Promise<void> {
    if (this.stopped) return;
    let soonestExpiresAt: number | undefined;
    let tickError: string | null = null;
    try {
      // A's `list()` returns a lightweight index without `expiresAt`, so we
      // `get()` each full record to read expiry. The account count is small
      // (one per logged-in Anthropic account), so per-tick reads are cheap.
      // #3808 (R7): Anthropic-only — see refreshIdleIsolatedAccounts. Filter before
      // the sampler (which probes api.anthropic.com) and the refresh loop.
      const entries = await this.listAnthropicEntries();
      // #3023: refresh the un-pinned spawn veto's utilization cache for EVERY account
      // at the loop-top — BEFORE the host-default / isolated deferral `continue`s below,
      // so the host-default (which the refresh loop defers to native) is still sampled.
      // Best-effort: the injected sampler swallows its own errors, and this await is
      // additionally guarded so a sampler fault can never abort the refresh tick.
      if (this.sampleUtilization) {
        await this.sampleUtilization(entries).catch(err =>
          logger.warn(
            `[TOKEN_REFRESH] utilization sampler error (ignored): ${err instanceof Error ? err.message : String(err)}`
          )
        );
      }
      // Resolve the host-default account ONCE per tick (issue #1520). Read fresh
      // (no caching) so the deferral follows the current host login — dynamic
      // keying (R4). A read failure → null → no deferral (a missing ~/.claude.json
      // also breaks native Claude Code, so the shared-family contention is moot).
      const hostDefaultUuid = await this.getHostDefaultAccountUuid().catch(
        () => null
      );
      for (const entry of entries) {
        if (this.stopped) return;
        const res = await this.store.get(entry.accountUuid);
        if (!res || !res.ok) continue;
        const account = res.account;
        // Issue #2268: an env-token account has no refresh token and is never
        // Hapimatic-refreshed — skip it here (mirrors the host-default / isolated
        // deferrals below) so it is never rotated, never scheduled by its
        // synthesized `expiresAt`, and never marked `unrefreshable`.
        if (isEnvTokenAccount(account)) continue;
        if (hostDefaultUuid && account.accountUuid === hostDefaultUuid) {
          // Host-default account (issue #1520): defer refresh to native Claude
          // Code. Hapimatic and native share this account's OAuth refresh-token
          // family; rotating it here races native and yields invalid_grant
          // lockouts. The CredentialsWatcher syncs the host's rotated token into
          // the store from disk, so Hapimatic never needs to rotate it.
          // R7: clear a stale `unrefreshable` flag — the rotation premise that set
          // it no longer applies, and the account is now disk-sourced.
          if (account.unrefreshable) {
            await this.persistMerge(account.accountUuid, current => ({
              ...withoutFailedTokenFingerprint(current),
              unrefreshable: false,
            }));
            logger.info(
              `[TOKEN_REFRESH] cleared unrefreshable on host-default account ${account.accountUuid} (${account.emailAddress}); refresh deferred to native Claude Code`
            );
          }
          continue; // never OAuth-rotate the host-default family
        }
        // Issue #1551: native owns rotation for an account with an isolated
        // config dir (its own CLAUDE_CONFIG_DIR) — defer exactly like the
        // host-default account. Generalizes the #1520 deferral from
        // host-default-only to every natively-owned account, so the proactive
        // scheduler never races native's in-dir rotation.
        if (
          await this.isIsolatedAccount(account.accountUuid).catch(() => false)
        ) {
          continue;
        }
        if (account.unrefreshable) continue;
        if (account.expiresAt - this.now() <= this.expiryBufferMs) {
          // Issue #1644: acquire the cross-machine family lease before
          // proactively rotating. A non-holder defers — mirrors the
          // isolated-account `continue` above. Only non-deferred accounts reach
          // here (host-default + isolated already `continue`d), so this gates
          // exactly the accounts this scheduler would otherwise rotate (R1).
          if (!(await this.acquireRotationLease(account.accountUuid))) {
            logger.info(
              `[TOKEN_REFRESH] deferred rotation for ${account.accountUuid} (${account.emailAddress}) — family lease held by another node`
            );
            continue;
          }
          await this.refreshScheduled(account);
        } else if (
          soonestExpiresAt === undefined ||
          account.expiresAt < soonestExpiresAt
        ) {
          soonestExpiresAt = account.expiresAt;
        }
      }
    } catch (err) {
      tickError = err instanceof Error ? err.message : String(err);
      logger.warn(`[TOKEN_REFRESH] scheduler tick error: ${tickError}`);
    }
    // #2035: consecutive-tick-error crash-loop detection. A single (transient)
    // error is tolerated (status stays "ok"); after `failureThreshold`
    // consecutive caught errors the row flips to "dead" so the server's
    // DaemonJobsMonitor synthesizes a durable JobFailureEvent on the ok→dead
    // transition. Any clean tick resets the counter and recovers the row to
    // "ok". NOTE: `tickError` is set ONLY by this tick()'s own catch — the idle
    // backstop's federation/local-degrade lastError stamp (#1834 / #3640, a
    // different loop) and #2608's per-account 429 retries never reach it, so
    // neither trips this counter.
    if (tickError === null) {
      this.consecutiveTickErrors = 0;
    } else {
      this.consecutiveTickErrors++;
    }
    const tickStatus: JobHealthStatus =
      this.consecutiveTickErrors >= this.failureThreshold ? "dead" : "ok";
    this.jobRegistry?.update(TOKEN_REFRESH_JOB_NAME, {
      lastTickAt: this.now(),
      status: tickStatus,
      lastError: tickError,
    });
    this.scheduleNext(soonestExpiresAt);
  }

  /** Schedule the next tick: soonest-expiry minus buffer, clamped to bounds. */
  private scheduleNext(soonestExpiresAt: number | undefined): void {
    if (this.stopped) return;
    const raw =
      soonestExpiresAt === undefined
        ? this.maxTickMs
        : soonestExpiresAt - this.expiryBufferMs - this.now();
    const delayMs = Math.min(this.maxTickMs, Math.max(this.minTickMs, raw));
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  /** Scheduled refresh with bounded backoff on transient failure (R5). */
  private async refreshScheduled(account: StoredAccount): Promise<void> {
    for (let attempt = 1; attempt <= this.maxScheduledAttempts; attempt++) {
      const outcome = await this.refreshOnce(account);
      if (outcome.status === "success" || outcome.status === "permanent") {
        return;
      }
      // Transient — back off and retry. A failed refresh does NOT rotate the
      // refresh token, so reusing `account.refreshToken` for the retry is
      // correct (only a SUCCESS rotates it, and that returns above).
      if (attempt < this.maxScheduledAttempts) {
        await delay(
          exponentialBackoffDelay(
            attempt,
            this.backoffMinMs,
            this.backoffMaxMs,
            this.maxScheduledAttempts
          )
        );
      }
    }
    logger.warn(
      `[TOKEN_REFRESH] gave up refreshing account ${account.accountUuid} (${account.emailAddress}) after ${this.maxScheduledAttempts} transient failures`
    );
  }

  /**
   * A single deduplicated refresh attempt for one account. A concurrent
   * scheduled + reactive refresh of the SAME account share ONE HTTP request,
   * avoiding a self-inflicted double-refresh race.
   *
   * `fireCallback` controls whether a SUCCESSFUL refresh fires
   * {@link TokenRefreshServiceOptions.onSuccessfulRefresh}. The scheduled/reactive
   * paths pass `true`; the force-refresh harness path (#1547) passes `false` so the
   * daemon can drive (and observe) `restartBoundSessions` itself. When a force call
   * JOINS an already-in-flight scheduled promise, the CREATOR's `fireCallback` wins —
   * which is correct: the restart fires at most once, by whichever path created the
   * request, and the harness re-drives it explicitly regardless.
   */
  private dedupedRefresh(
    account: StoredAccount,
    fireCallback: boolean
  ): Promise<RefreshOutcome> {
    const existing = this.inFlight.get(account.accountUuid);
    if (existing) return existing;
    const p = this.refreshOnceImpl(account, fireCallback).finally(() => {
      this.inFlight.delete(account.accountUuid);
    });
    this.inFlight.set(account.accountUuid, p);
    return p;
  }

  /** Scheduled/reactive refresh — fires the success callback (issue #1507). */
  private refreshOnce(account: StoredAccount): Promise<RefreshOutcome> {
    return this.dedupedRefresh(account, true);
  }

  private async refreshOnceImpl(
    account: StoredAccount,
    fireCallback: boolean
  ): Promise<RefreshOutcome> {
    // Issue #2268: defensive — env-token accounts have no refresh token and are
    // skipped by every upstream caller (tick / handleAuthFailure / idle backstop).
    // If one ever reaches here (e.g. a manual `force-refresh` on an env-token
    // uuid), do NOT rotate (there is nothing to rotate) and do NOT mark it
    // `unrefreshable` — return a transient no-op. This also narrows the now-optional
    // `account.refreshToken` to a non-empty string for `refreshFn` below.
    if (isEnvTokenAccount(account) || !account.refreshToken) {
      logger.debug(
        `[TOKEN_REFRESH] skip refresh for ${account.accountUuid} — no refresh token (env-token)`
      );
      return { status: "transient", detail: "account has no refresh token" };
    }
    const refreshToken = account.refreshToken;
    try {
      const result = await this.refreshFn(refreshToken);
      await this.persistPatch(account.accountUuid, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
        lastRefreshedAt: this.now(),
      });
      logger.info(
        `[TOKEN_REFRESH] refreshed account ${account.accountUuid} (${account.emailAddress})`
      );
      // Issue #1507: notify the daemon so it can restart sessions bound to this
      // account with the fresh token. Fires for scheduled + reactive refreshes;
      // never fires for the host-default account (#1520 short-circuits before here).
      // Suppressed on the force-refresh path (#1547, fireCallback=false) — the
      // harness drives restartBoundSessions explicitly so it can observe + report it.
      if (fireCallback) {
        this.onSuccessfulRefresh?.(account.accountUuid);
      }
      return { status: "success", accessToken: result.accessToken };
    } catch (err) {
      if (err instanceof PermanentRefreshError) {
        // #4423: record WHICH token failed (a fingerprint, never the token).
        await this.persistPatch(account.accountUuid, {
          unrefreshable: true,
          unrefreshableTokenFingerprint: refreshTokenFingerprint(refreshToken),
        });
        logger.warn(
          `[TOKEN_REFRESH] account ${account.accountUuid} (${account.emailAddress}) marked unrefreshable: ${err.message}`
        );
        return { status: "permanent", detail: err.message };
      }
      // Transient (or any unexpected error) — never mark unrefreshable.
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[TOKEN_REFRESH] transient refresh failure for account ${account.accountUuid} (${account.emailAddress}): ${detail}`
      );
      return { status: "transient", detail };
    }
  }

  /**
   * Issue #3544: throttle the legacy stale-flag probe to one call per uuid per
   * 10-min window. Returns true (and records `now`) when a probe is allowed;
   * false when the last probe was within the window. The fingerprint rule
   * (#4423) is free and NOT gated by this — a flag recording a different failed
   * token clears on the very next pass regardless of throttle state.
   */
  private canProbeStaleFlag(uuid: string): boolean {
    const THROTTLE_MS = 10 * 60 * 1000;
    const last = this.unrefreshableProbeAt.get(uuid);
    const nowMs = this.now();
    if (last != null && nowMs - last < THROTTLE_MS) {
      return false;
    }
    this.unrefreshableProbeAt.set(uuid, nowMs);
    return true;
  }

  /**
   * Read-merge-write a patch onto an account record.
   *
   * Issue #1635 (F2): when the store exposes `update()` (the real
   * `AccountStore` does, under a per-account-file cross-process lock), route
   * through it — the pre-#1635 get-then-put pair let two concurrent patches
   * read the same baseline and the second `put` clobber the first's fields
   * (worst case: re-publishing a pre-rotation, server-side-revoked token to
   * the store). The get-then-put fallback remains for test fakes and any
   * store implementation without `update()`.
   */
  private persistPatch(
    accountUuid: string,
    patch: Partial<StoredAccount>
  ): Promise<void> {
    return this.persistMerge(accountUuid, current => ({
      ...current,
      ...patch,
    }));
  }

  /** {@link persistPatch} with a merge function (issue #4423: conditional clears). */
  private async persistMerge(
    accountUuid: string,
    mergeFn: (current: StoredAccount) => StoredAccount
  ): Promise<void> {
    if (typeof this.store.update === "function") {
      const applied = await this.store.update(accountUuid, mergeFn);
      if (!applied) {
        logger.warn(
          `[TOKEN_REFRESH] cannot persist refresh for account ${accountUuid}: record missing or malformed`
        );
      }
      return;
    }
    const current = await this.store.get(accountUuid);
    if (!current || !current.ok) {
      logger.warn(
        `[TOKEN_REFRESH] cannot persist refresh for account ${accountUuid}: record ${current ? "malformed" : "missing"}`
      );
      return;
    }
    await this.store.put(mergeFn(current.account));
  }
}
