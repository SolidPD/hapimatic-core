// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { StoredAccountSchema } from "@hapi/protocol";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  fetchOauthProfile,
  generatePkce,
  OauthLoginError,
  type FetchLike,
} from "./anthropicOauthLoginClient";
import {
  toRedactedAccount,
  type AccountService,
  type RedactedAccount,
} from "./accountService";
import {
  syncIsolatedCredentials,
  type FreshOauthToken,
  type IsolatedCredentialsSyncOptions,
} from "./isolatedCredentialsSync";

/**
 * Server-side orchestrator for web-initiated OAuth login (issue #1263).
 *
 * Holds the short-lived PKCE state across the two-step flow (`start` → user
 * authenticates in a browser → `complete`), exchanges the pasted code for
 * tokens, resolves identity, and persists a new `StoredAccount` via
 * `AccountService.add()`. The PKCE `code_verifier` NEVER leaves this process and
 * NEVER appears in a response.
 *
 * Option B (see issue #1263 directive KD2): the flow + persist run server-side
 * and the persist mirrors the shipped `AccountService.delete()` lockless-index
 * tradeoff. (A daemon-control bridge DOES exist since #1805 —
 * `server/src/utils/daemonControlClient.ts` reads `<HAPI_HOME>/daemon.state.json`
 * for `httpPort`/`controlToken` and POSTs to `127.0.0.1:<httpPort>` — so do not
 * rule out a daemon bridge on this comment's former "no bridge" authority; it is
 * simply not needed for this server-side login flow. Rewritten by #3806,
 * [ER 2026-09-19: NEW-3806-13].) The
 * per-account file is the source of truth; a rare index write-race only delays
 * the cli `TokenRefreshService`'s PROACTIVE refresh of the new account — binding
 * it (which reads the per-account file directly) repairs the index via the
 * reactive refresh path.
 */

/** In-flight login state. Never leaves the server process. */
interface PendingLogin {
  state: string;
  verifier: string;
  /** Unix epoch ms. */
  expiresAt: number;
}

/**
 * Shown when the pasted value cannot be an Anthropic authorization code
 * (#3452). A digits-only value is the shape of the 6-digit sign-in code
 * claude.com emails during login, which belongs on the claude.com page — the
 * authorization code Anthropic shows AFTER approval is a long opaque string
 * (conventionally `<code>#<state>`).
 */
export const NOT_AN_AUTHORIZATION_CODE_MSG =
  "That is not an Anthropic authorization code. It looks like the 6-digit " +
  "sign-in code claude.com emailed you — enter that on the claude.com sign-in " +
  "page, approve access, then paste the long authorization code Anthropic shows " +
  "afterwards (copy the whole thing, including the part after #).";

/** RR4: 5-minute single-use window for a login attempt. */
const LOGIN_TTL_MS = 5 * 60 * 1000;

export type LoginStartResult = { loginToken: string; authorizeUrl: string };

export type LoginCompleteFailureCode =
  | "expired_state"
  | "csrf"
  | "exchange_failed"
  | "profile_failed"
  | "invalid_request"
  | "invalid_code";

export type LoginCompleteResult =
  | { ok: true; account: RedactedAccount }
  | { ok: false; code: LoginCompleteFailureCode; error: string };

export class AccountLoginService {
  private readonly pending = new Map<string, PendingLogin>();
  private readonly fetchImpl?: FetchLike;
  private readonly now: () => number;
  private readonly isolatedSyncOptions: IsolatedCredentialsSyncOptions;
  private readonly syncIsolated: (
    accountUuid: string,
    token: FreshOauthToken,
    opts: IsolatedCredentialsSyncOptions
  ) => string[];

  constructor(
    private readonly accountService: AccountService,
    opts: {
      fetchImpl?: FetchLike;
      now?: () => number;
      /**
       * Isolated-dir locations for the post-login write-through. Pass at least
       * `dataDir` in production so the per-instance kill-switch layout is
       * covered as well as the machine-global one.
       */
      isolatedSyncOptions?: IsolatedCredentialsSyncOptions;
      /** Injectable seam for tests; defaults to the real filesystem write. */
      syncIsolated?: (
        accountUuid: string,
        token: FreshOauthToken,
        opts: IsolatedCredentialsSyncOptions
      ) => string[];
    } = {}
  ) {
    this.fetchImpl = opts.fetchImpl;
    this.now = opts.now ?? Date.now;
    this.isolatedSyncOptions = opts.isolatedSyncOptions ?? {};
    this.syncIsolated = opts.syncIsolated ?? syncIsolatedCredentials;
  }

  /** Number of in-flight login attempts (test/diagnostic visibility). */
  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * RR1: begin a PKCE login. Returns the Anthropic authorize URL plus an opaque
   * `loginToken` the client echoes back to `complete`. The `state`/`verifier`
   * stay server-side.
   */
  start(): LoginStartResult {
    this.sweepExpired();
    const { verifier, challenge, state } = generatePkce();
    const loginToken = randomUUID();
    this.pending.set(loginToken, {
      state,
      verifier,
      expiresAt: this.now() + LOGIN_TTL_MS,
    });
    return {
      loginToken,
      authorizeUrl: buildAuthorizeUrl({ challenge, state }),
    };
  }

  /**
   * RR2/RR3/RR4: complete the login. Validates the `loginToken` (single-use,
   * TTL) and `state` (CSRF), exchanges the code, resolves identity, persists a
   * new `StoredAccount`, and returns the redacted account.
   *
   * The Anthropic paste-back page presents the value as `<code>#<state>`; we
   * accept either a combined value (split on `#`) or the already-split `code`
   * with an optional explicit `state`.
   */
  async complete(args: {
    loginToken: string;
    code: string;
    state?: string;
  }): Promise<LoginCompleteResult> {
    this.sweepExpired();

    const rawCode = (args.code ?? "").trim();
    if (!args.loginToken || !rawCode) {
      return {
        ok: false,
        code: "invalid_request",
        error: "loginToken and code are required.",
      };
    }

    // Accept the conventional `<code>#<state>` paste-back form: split off the
    // state fragment if present, preferring an explicit `args.state`.
    let code = rawCode;
    let pastedState = args.state?.trim() || undefined;
    const hashIdx = rawCode.indexOf("#");
    if (hashIdx >= 0) {
      code = rawCode.slice(0, hashIdx);
      if (!pastedState) {
        const frag = rawCode.slice(hashIdx + 1).trim();
        if (frag) pastedState = frag;
      }
    }
    if (!code) {
      return {
        ok: false,
        code: "invalid_request",
        error: "Authorization code is empty.",
      };
    }

    // #3452: refuse an obviously-wrong paste BEFORE consuming the single-use
    // loginToken, so the user can paste the real code without starting over.
    if (/^\d+$/.test(code)) {
      return {
        ok: false,
        code: "invalid_code",
        error: NOT_AN_AUTHORIZATION_CODE_MSG,
      };
    }

    const entry = this.pending.get(args.loginToken);
    if (!entry || this.now() > entry.expiresAt) {
      this.pending.delete(args.loginToken);
      return {
        ok: false,
        code: "expired_state",
        error: "Login session expired or unknown. Start over.",
      };
    }
    // Single-use: consume immediately so a replay cannot reuse the token.
    this.pending.delete(args.loginToken);

    // CSRF: if the page returned a state fragment, it MUST match ours.
    if (pastedState && pastedState !== entry.state) {
      return {
        ok: false,
        code: "csrf",
        error: "OAuth state mismatch — possible CSRF. Start over.",
      };
    }

    let tokens;
    try {
      tokens = await exchangeCodeForTokens(
        { code, verifier: entry.verifier, state: entry.state },
        { fetchImpl: this.fetchImpl, now: this.now }
      );
    } catch (err) {
      const detail =
        err instanceof OauthLoginError ? err.message : "Token exchange failed.";
      // #3452: Anthropic answered 400/401 — the code itself was rejected
      // (wrong value, already used, or expired). Say so in plain words; the
      // wire detail stays for diagnosis.
      const rejectedCode =
        err instanceof OauthLoginError && err.code === "invalid_code";
      return {
        ok: false,
        code: "exchange_failed",
        error: rejectedCode
          ? `Anthropic rejected that code (${detail}). Authorization codes work only once and expire within a few minutes. Start over to get a fresh sign-in link, approve access again, and paste the full code from the platform.claude.com page.`
          : detail,
      };
    }

    const profile = await fetchOauthProfile(tokens.accessToken, {
      fetchImpl: this.fetchImpl,
    });
    const accountUuid = profile?.accountUuid ?? tokens.accountUuid;
    const emailAddress = profile?.emailAddress ?? tokens.emailAddress;

    if (!accountUuid) {
      return {
        ok: false,
        code: "profile_failed",
        error: "Could not resolve the account identity (no accountUuid).",
      };
    }
    if (!tokens.refreshToken) {
      return {
        ok: false,
        code: "exchange_failed",
        error: "Token exchange returned no refresh token.",
      };
    }

    const nowMs = this.now();
    const candidate = {
      schema_version: 1 as const,
      accountUuid,
      emailAddress: emailAddress ?? "",
      organizationUuid: profile?.organizationUuid ?? "",
      organizationName: profile?.organizationName ?? "",
      displayName: profile?.displayName ?? "",
      billingType: "",
      // subscriptionType/rateLimitTier are display-only (plan badge) and are NOT
      // part of the token/profile contract Hapimatic captures — they populate on
      // the next token refresh. Default "" (matches AccountStore migration).
      subscriptionType: "",
      rateLimitTier: "",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      capturedAt: nowMs,
      lastUsedAt: 0,
      lastRefreshedAt: 0,
      unrefreshable: false,
    };

    const parsed = StoredAccountSchema.safeParse(candidate);
    if (!parsed.success) {
      return {
        ok: false,
        code: "exchange_failed",
        error: `Built account failed validation: ${parsed.error.message}`,
      };
    }

    this.accountService.add(parsed.data);
    // Write the fresh token THROUGH to any existing isolated credentials file.
    // Every token reader resolves the isolated dir before the store, so without
    // this a successful re-login stays invisible to `UsageService` and to the
    // cli spawn path — they keep serving the dead token and the account still
    // reads "Re-login required". Update-only, never create: see the invariant
    // note in `isolatedCredentialsSync.ts` (creating a dir would remove the
    // account from proactive refresh coverage, #3541). Best-effort by
    // contract — it never throws, so it cannot fail an otherwise-good login.
    try {
      this.syncIsolated(
        accountUuid,
        {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          scopes: tokens.scopes,
        },
        this.isolatedSyncOptions
      );
    } catch {
      // The store write already succeeded and is authoritative for a
      // non-isolated account, so a secondary-cache failure must never turn a
      // working login into a reported failure. `syncIsolatedCredentials` does
      // not throw by construction; this guard makes that guarantee independent
      // of the injected seam rather than dependent on the callee's discipline.
    }
    return { ok: true, account: toRedactedAccount(parsed.data) };
  }

  private sweepExpired(): void {
    const t = this.now();
    for (const [k, v] of this.pending) {
      if (t > v.expiresAt) this.pending.delete(k);
    }
  }
}
