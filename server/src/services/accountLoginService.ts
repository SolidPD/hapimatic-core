// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  NativeAnthropicStoredAccountSchema,
  StoredAccountSchema,
  isNativeAnthropicAccount,
} from "@hapi/protocol";
import { isTenantVm } from "@hapi/protocol/tenantMode";
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
import {
  NOT_AN_AUTHORIZATION_CODE_MSG,
  startClaudeNativeSignIn,
  validatePastedCode,
  type ClaudeNativeSignIn,
  type FailedNativeSignIn,
  type NetworkErrorCode,
  type StartClaudeNativeSignIn,
} from "./claudeNativeSignIn";
import { findClaudePath } from "../utils/mcpPoller";

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

/** RR4: 5-minute single-use window for a login attempt. */
const LOGIN_TTL_MS = 5 * 60 * 1000;

/**
 * #4349: the error code every Hapimatic-driven sign-in path answers on a TENANT VM — the customer
 * signs in inside the VM with the unmodified binary's own `/login` instead ({@link
 * AccountLoginService.startInVm}).
 */
export const IN_VM_SIGN_IN_REQUIRED = "in_vm_sign_in_required";

/** #4349: how long a started in-VM sign-in stays registrable (the user runs `/login` meanwhile). */
const IN_VM_LOGIN_TTL_MS = 30 * 60 * 1000;

/** #6211: how long a repeat `completeInVm` of a finished sign-in answers the same. */
const IN_VM_REPEAT_COMPLETE_WINDOW_MS = 60 * 1000;

/**
 * #6211: live paste sign-in children across this server. Past it a start gets no link, and the
 * client shows the terminal path. Each child can live 15 minutes in the server's own cgroup, outside
 * the sessions' memory slice, and the per-namespace rate limits do not bound the total.
 */
const IN_VM_MAX_LIVE_SIGN_INS = 8;

/**
 * #6211: `HAPI_TENANT_PASTE_SIGNIN=0` (or false/no/off) turns the paste sign-in off; the client then
 * shows the terminal sign-in. Read per start from the server's env, which `~/.config/hapimatic/env` sets at unit start, so a change needs a server restart.
 */
function pasteSignInEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = (env.HAPI_TENANT_PASTE_SIGNIN ?? "").toLowerCase();
  return !(flag === "0" || flag === "false" || flag === "no" || flag === "off");
}

/** #4349: an in-VM sign-in waiting for the binary to write its identity into the new dir. */
interface PendingInVmLogin {
  accountUuid: string;
  configDir: string;
  /** The namespace that started it; only that namespace resumes it. */
  owner: string;
  /** Unix epoch ms. */
  expiresAt: number;
  /** #6211: the running `claude auth login` behind the paste sign-in, when one could start. */
  signIn?: ClaudeNativeSignIn;
  /** #6211: a child on its way up, which a concurrent start joins rather than doubling. */
  signInStarting?: Promise<void>;
}

export type InVmLoginStartResult = {
  loginToken: string;
  accountUuid: string;
  configDir: string;
  /** The exact command to run in a terminal on this VM; the user then types `/login`. */
  command: string;
  /**
   * #6211: the sign-in page of the unmodified binary running for this sign-in. Absent when it could
   * not start (kill switch, binary missing, no URL parsed), and the client shows the terminal path.
   */
  authorizeUrl?: string;
};

export type InVmLoginCompleteResult =
  | { ok: true; account: RedactedAccount }
  | {
      ok: false;
      code:
        | "not_signed_in"
        | "expired_state"
        | "already_added"
        | "exchange_failed"
        | "invalid_request";
      error: string;
    };

export type InVmCodeSubmitResult =
  | { ok: true; account: RedactedAccount }
  | {
      ok: false;
      code:
        | "invalid_code"
        | "signing_in"
        | "exchange_failed"
        | "expired_state"
        | "already_added";
      error: string;
    };

export type LoginStartResult = { loginToken: string; authorizeUrl: string };

export type LoginCompleteFailureCode =
  | "expired_state"
  | "csrf"
  | "exchange_failed"
  | "profile_failed"
  | "invalid_request"
  | "invalid_code"
  // #4349: a tenant VM — Hapimatic does not run the OAuth exchange there.
  | typeof IN_VM_SIGN_IN_REQUIRED;

export type LoginCompleteResult =
  | { ok: true; account: RedactedAccount }
  | { ok: false; code: LoginCompleteFailureCode; error: string };

export class AccountLoginService {
  private readonly pending = new Map<string, PendingLogin>();
  /** #4349: in-VM sign-ins waiting for the binary's identity (never a token). */
  private readonly pendingInVm = new Map<string, PendingInVmLogin>();
  /** #6211: finished sign-ins, so a poll racing the submit reads the same answer. */
  private readonly finishedInVm = new Map<
    string,
    { result: InVmLoginCompleteResult; owner: string; at: number }
  >();
  private readonly startNativeSignIn: StartClaudeNativeSignIn;
  private readonly findClaude: () => string | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly tenantVm: () => boolean;
  private readonly accountConfigsDir: string;
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
      /** #4349: the tenant predicate (test seam; defaults to `isTenantVm`). */
      tenantVm?: () => boolean;
      /**
       * #4349: the account-configs base the in-VM sign-in creates its dir under (test seam).
       * Defaults to {@link resolveInVmAccountConfigsDir} over `isolatedSyncOptions.dataDir` — the
       * base the cli spawn path resolves `CLAUDE_CONFIG_DIR=<base>/<uuid>` from.
       */
      accountConfigsDir?: string;
      /** #6211: starts the sign-in child (test seam). */
      startNativeSignIn?: StartClaudeNativeSignIn;
      /** #6211: resolves the `claude` binary (test seam). */
      findClaude?: () => string | null;
      /** #6211: the env the kill switch is read from (test seam). */
      env?: NodeJS.ProcessEnv;
    } = {}
  ) {
    this.startNativeSignIn = opts.startNativeSignIn ?? startClaudeNativeSignIn;
    this.findClaude = opts.findClaude ?? findClaudePath;
    this.env = opts.env ?? process.env;
    this.tenantVm = opts.tenantVm ?? isTenantVm;
    this.accountConfigsDir =
      opts.accountConfigsDir ??
      resolveInVmAccountConfigsDir({
        dataDir: opts.isolatedSyncOptions?.dataDir,
      });
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
  /** #4349: true on a TENANT VM, where only {@link startInVm} signs an account in. */
  inVmSignInRequired(): boolean {
    return this.tenantVm();
  }

  start(): LoginStartResult {
    // #4349 (R3, Task 4(a)): Hapimatic never runs its own provider OAuth flow on a tenant VM.
    if (this.tenantVm()) {
      throw new Error(
        `${IN_VM_SIGN_IN_REQUIRED}: on this VM, sign in with Claude Code's own /login (#4349)`
      );
    }
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
    // #4349 (R3): never exchange a code on a tenant VM (the code is not even read).
    if (this.tenantVm()) {
      return {
        ok: false,
        code: IN_VM_SIGN_IN_REQUIRED,
        error: "On this VM, sign in with Claude Code's own /login (#4349).",
      };
    }
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

  /**
   * #4349 (Task 5): begin an in-VM sign-in. Creates a NEW, EMPTY per-account config dir
   * (`<accountConfigsDir>/<uuid>/`, mode 0700) and returns the exact command to run in a terminal
   * on this VM — the unmodified `claude` with only that `CLAUDE_CONFIG_DIR` (an inherited
   * `CLAUDE_CODE_OAUTH_TOKEN` unset, so it cannot shadow the new sign-in). The user types `/login`;
   * the binary performs its own login and writes its own credential into the dir. The terminal is
   * the VM's own, so no authorization code passes through SPD's gateway. Only on a tenant VM.
   *
   * The user has to leave the dialog to reach a terminal, so an unexpired sign-in `owner` already
   * started is resumed (same token, dir and command, expiry renewed) rather than replaced: a
   * reopened dialog then polls the dir `/login` wrote into. Only {@link cancelInVm} ends one early.
   *
   * #6211: it also starts the unmodified `claude auth login --claudeai` in that dir and adds its
   * sign-in page, so the user can sign in without a terminal. The terminal command stays in the
   * answer, because both routes sign in to the same dir and either one registers it. A resume keeps
   * the child and its link; only a child that has ended is replaced.
   */
  async startInVm(owner = ""): Promise<InVmLoginStartResult> {
    if (!this.tenantVm()) {
      throw new Error("in-VM sign-in runs only on a tenant VM (#4349)");
    }
    this.sweepExpired();
    let resumable: [string, PendingInVmLogin] | undefined;
    for (const pending of this.pendingInVm) {
      if (pending[1].owner === owner) resumable = pending; // the latest one started wins
    }
    if (resumable) {
      const [loginToken, entry] = resumable;
      entry.expiresAt = this.now() + IN_VM_LOGIN_TTL_MS;
      await this.ensureSignInChild(loginToken, entry);
      return inVmStartResult(loginToken, entry);
    }
    const accountUuid = randomUUID();
    const configDir = join(this.accountConfigsDir, accountUuid);
    mkdirSync(this.accountConfigsDir, { recursive: true, mode: 0o700 });
    // Not recursive: a fresh uuid must never name an existing dir.
    mkdirSync(configDir, { mode: 0o700 });
    const loginToken = randomUUID();
    const entry: PendingInVmLogin = {
      accountUuid,
      configDir,
      owner,
      expiresAt: this.now() + IN_VM_LOGIN_TTL_MS,
    };
    this.pendingInVm.set(loginToken, entry);
    await this.ensureSignInChild(loginToken, entry);
    return inVmStartResult(loginToken, entry);
  }

  /**
   * #6211: pass a pasted code to this sign-in's child. Only the unmodified binary exchanges it:
   * the code is written to the child's stdin and goes nowhere else. Registration stays with
   * {@link completeInVm}, which reads only the identity the binary wrote.
   */
  async submitInVmCode(
    loginToken: string,
    code: string,
    owner = ""
  ): Promise<InVmCodeSubmitResult> {
    this.sweepExpired();
    const entry = this.pendingInVm.get(loginToken);
    if (!entry || entry.owner !== owner) {
      return {
        ok: false,
        code: "expired_state",
        error: "This sign-in expired or is unknown. Start over.",
      };
    }
    if (entry.signInStarting) await entry.signInStarting;
    const signIn = entry.signIn;
    // A child that ended first never saw this code, so "not accepted" would be untrue.
    if (!signIn || signIn.endedUnsubmitted) {
      return {
        ok: false,
        code: "expired_state",
        error: "This sign-in has no link running. Open a new sign-in link.",
      };
    }
    const check = validatePastedCode(code, signIn.state);
    if (!check.ok) {
      return { ok: false, code: "invalid_code", error: check.error };
    }
    const outcome = await signIn.submit(check.code);
    if (outcome === "signing_in") {
      return { ok: false, code: "signing_in", error: "Still signing in." };
    }
    // #6275 S12: a poll that registered the account, or a cancel, settled this sign-in while the
    // code was exchanged. Stopping the child is then not a refusal, so answer what that settled.
    if (this.pendingInVm.get(loginToken) !== entry) {
      const finished = this.finishedInVm.get(loginToken);
      if (finished?.owner === owner) {
        const settled = finished.result;
        if (settled.ok) return settled;
        if (settled.code === "already_added") {
          return { ok: false, code: "already_added", error: settled.error };
        }
      }
      return {
        ok: false,
        code: "expired_state",
        error: "This sign-in was stopped. Open a new sign-in link.",
      };
    }
    if (outcome === "exchange_failed") {
      const failed = signIn.failedExchange;
      return {
        ok: false,
        code: "exchange_failed",
        error: failed
          ? inVmExchangeFailureMessage(failed)
          : IN_VM_EXCHANGE_UNREAD_MSG,
      };
    }
    const done = this.completeInVm(loginToken, owner);
    if (done.ok) return done;
    if (done.code === "already_added" || done.code === "expired_state") {
      return { ok: false, code: done.code, error: done.error };
    }
    // Exit 0 with no usable identity: nothing to register, and the flow is spent.
    // #6275 S20: the terminal guidance a poll gets here does not fit the paste dialog.
    if (done.code === "not_signed_in") {
      console.warn(
        "[accounts] paste sign-in exited 0 but left no usable account to add"
      );
      return {
        ok: false,
        code: "exchange_failed",
        error: IN_VM_NO_ACCOUNT_AFTER_SIGN_IN_MSG,
      };
    }
    return { ok: false, code: "exchange_failed", error: done.error };
  }

  /**
   * #6211: make sure a live child backs this sign-in. A failure leaves `signIn` unset, which reads
   * as "no link" and sends the client to the terminal path (never an error of its own).
   */
  private ensureSignInChild(
    loginToken: string,
    entry: PendingInVmLogin
  ): Promise<void> {
    if (entry.signInStarting) return entry.signInStarting;
    if (entry.signIn?.alive) return Promise.resolve();
    // A finished child's dir is about to register; a new child there could only get in the way.
    if (entry.signIn && readDirIdentity(entry.configDir)) {
      return Promise.resolve();
    }
    entry.signIn = undefined;
    if (!pasteSignInEnabled(this.env)) return Promise.resolve();
    let live = 0;
    for (const other of this.pendingInVm.values()) {
      if (other.signIn?.alive || other.signInStarting) live += 1;
    }
    if (live >= IN_VM_MAX_LIVE_SIGN_INS) {
      console.warn("[accounts] paste sign-in unavailable: too_many_live");
      return Promise.resolve();
    }
    const claudePath = this.findClaude();
    if (!claudePath) {
      console.warn("[accounts] paste sign-in unavailable: binary_missing");
      return Promise.resolve();
    }
    entry.signInStarting = this.startNativeSignIn({
      claudePath,
      configDir: entry.configDir,
    })
      .then(res => {
        if (!res.ok) {
          console.warn(`[accounts] paste sign-in unavailable: ${res.reason}`);
          return;
        }
        entry.signIn = res.signIn;
        // Cancelled or registered while it was starting: it must not outlive the sign-in.
        if (this.pendingInVm.get(loginToken) !== entry) res.signIn.kill();
      })
      .catch(() => {
        console.warn("[accounts] paste sign-in unavailable: start_threw");
      })
      .finally(() => {
        entry.signInStarting = undefined;
      });
    return entry.signInStarting;
  }

  /**
   * #6211: end a sign-in's child, then deal with its dir. The removal waits for the child, because
   * a child still exiting could write into the dir again. With no child this runs synchronously.
   */
  private async retireInVm(
    entry: PendingInVmLogin,
    dir: "keep" | "remove"
  ): Promise<void> {
    if (entry.signInStarting) await entry.signInStarting;
    if (entry.signIn?.alive) {
      entry.signIn.kill();
      await entry.signIn.exited;
    }
    if (dir === "remove") removeInVmDir(entry.configDir);
  }

  /**
   * #4349 (Task 5): register a started in-VM sign-in once the binary has written the account's
   * identity into its dir. Reads ONLY `<dir>/.claude.json` `oauthAccount` (email, uuids, names) —
   * never `.credentials.json` — and stores a token-less `native` record whose key is the dir's
   * uuid. `not_signed_in` until the identity appears; the pending entry survives that answer so
   * the client can check again. This is the only registration, whichever route signed in. A repeat
   * call shortly after it answers the same, because the client's poll can race a code submit.
   */
  completeInVm(loginToken: string, owner = ""): InVmLoginCompleteResult {
    this.sweepExpired();
    if (!loginToken) {
      return {
        ok: false,
        code: "invalid_request",
        error: "loginToken is required.",
      };
    }
    const entry = this.pendingInVm.get(loginToken);
    if (!entry || entry.owner !== owner) {
      const finished = this.finishedInVm.get(loginToken);
      if (finished?.owner === owner) return finished.result;
      return {
        ok: false,
        code: "expired_state",
        error: "This sign-in expired or is unknown. Start over.",
      };
    }
    const identity = readDirIdentity(entry.configDir);
    if (!identity) {
      const failed = entry.signIn?.failedExchange;
      if (failed) {
        return {
          ok: false,
          code: "exchange_failed",
          error: inVmExchangeFailureMessage(failed),
        };
      }
      return {
        ok: false,
        code: "not_signed_in",
        error:
          "No sign-in found yet. Run the command in a terminal on this VM, type /login and finish Claude's prompts.",
      };
    }
    return this.registerInVm(loginToken, entry, identity);
  }

  /** The registration itself, once the binary has written an identity into the sign-in's dir. */
  private registerInVm(
    loginToken: string,
    entry: PendingInVmLogin,
    identity: NonNullable<ReturnType<typeof readDirIdentity>>
  ): InVmLoginCompleteResult {
    const duplicate = this.accountService
      .list()
      .map(a => this.accountService.getRawAny(a.accountUuid))
      .find(
        a =>
          a !== null &&
          isNativeAnthropicAccount(a) &&
          a.identityAccountUuid === identity.accountUuid
      );
    if (duplicate) {
      this.pendingInVm.delete(loginToken);
      // #6211 R20: the new dir holds a live credential nothing references, so it goes rather than
      // lingering. The check keeps the existing account's dir safe in every case.
      const sameDir =
        isNativeAnthropicAccount(duplicate) &&
        duplicate.configDir === entry.configDir;
      void this.retireInVm(entry, sameDir ? "keep" : "remove");
      const result: InVmLoginCompleteResult = {
        ok: false,
        code: "already_added",
        error: `${identity.emailAddress} is already connected.`,
      };
      this.finishedInVm.set(loginToken, {
        result,
        owner: entry.owner,
        at: this.now(),
      });
      return result;
    }
    const now = this.now();
    const parsed = NativeAnthropicStoredAccountSchema.safeParse({
      schema_version: 1,
      authKind: "native",
      accountUuid: entry.accountUuid,
      identityAccountUuid: identity.accountUuid,
      emailAddress: identity.emailAddress,
      organizationUuid: identity.organizationUuid,
      organizationName: identity.organizationName,
      displayName: identity.displayName,
      billingType: identity.billingType,
      configDir: entry.configDir,
      capturedAt: now,
      lastUsedAt: 0,
    });
    if (!parsed.success) {
      return {
        ok: false,
        code: "not_signed_in",
        error: `The sign-in identity is incomplete: ${parsed.error.message}`,
      };
    }
    this.accountService.add(parsed.data);
    this.pendingInVm.delete(loginToken);
    void this.retireInVm(entry, "keep");
    const result: InVmLoginCompleteResult = {
      ok: true,
      account: toRedactedAccount(parsed.data),
    };
    this.finishedInVm.set(loginToken, { result, owner: entry.owner, at: now });
    return result;
  }

  /**
   * #4349: abandon a started in-VM sign-in, resolving once that is done. #6211: it leaves no live
   * credential where nothing can see or revoke it. The child stops first, because it can finish
   * writing up to the moment it exits. A sign-in that did finish then registers, which puts it on
   * Provider Accounts, and the caller gets that answer back rather than null. Anything else goes
   * with its dir, including a credential with no identity to register it under: that dir was made
   * for this sign-in, so nothing else refers to it.
   */
  async cancelInVm(
    loginToken: string,
    owner = ""
  ): Promise<InVmLoginCompleteResult | null> {
    const entry = this.pendingInVm.get(loginToken);
    if (!entry || entry.owner !== owner) {
      // A poll may have registered it just before this cancel, and its answer lost on the way.
      const finished = this.finishedInVm.get(loginToken);
      return finished?.owner === owner ? finished.result : null;
    }
    this.pendingInVm.delete(loginToken);
    await this.retireInVm(entry, "keep");
    const identity = readDirIdentity(entry.configDir);
    let result: InVmLoginCompleteResult | null = null;
    if (identity) {
      try {
        result = this.registerInVm(loginToken, entry, identity);
      } catch (err) {
        // The account store could not be written. The sign-in goes back on the list, so a second
        // cancel, a poll or the sweep can still register its credential.
        this.pendingInVm.set(loginToken, entry);
        throw err;
      }
    }
    if (result?.ok || result?.code === "already_added") return result;
    removeInVmDir(entry.configDir);
    return null;
  }

  private sweepExpired(): void {
    const t = this.now();
    for (const [k, v] of this.pending) {
      if (t > v.expiresAt) this.pending.delete(k);
    }
    for (const [k, v] of this.pendingInVm) {
      if (t <= v.expiresAt) continue;
      // #6211 R20: a terminal sign-in finished while no dialog was polling. It holds a live
      // credential, so it registers rather than sitting where nothing can see or revoke it.
      const identity = readDirIdentity(v.configDir);
      if (identity) this.registerInVm(k, v, identity);
      if (this.pendingInVm.get(k) === v) {
        this.pendingInVm.delete(k);
        // Nothing can register it after this, so a credential left here would only be stranded.
        void this.retireInVm(v, "remove");
      }
    }
    for (const [k, v] of this.finishedInVm) {
      if (t > v.at + IN_VM_REPEAT_COMPLETE_WINDOW_MS) {
        this.finishedInVm.delete(k);
      }
    }
  }
}

function inVmStartResult(
  loginToken: string,
  entry: PendingInVmLogin
): InVmLoginStartResult {
  return {
    loginToken,
    accountUuid: entry.accountUuid,
    configDir: entry.configDir,
    command: inVmSignInCommand(entry.configDir),
    ...(entry.signIn ? { authorizeUrl: entry.signIn.authorizeUrl } : {}),
  };
}

/** #6275 S12: a network error code from the child, in words. */
const NETWORK_REASONS: Record<NetworkErrorCode, string> = {
  ENOTFOUND: "its address lookup failed",
  EAI_AGAIN: "its address lookup failed",
  ECONNREFUSED: "the connection was refused",
  ECONNRESET: "the connection was dropped",
  ECONNABORTED: "the connection was dropped",
  EPIPE: "the connection was dropped",
  hangup: "the connection was dropped",
  ETIMEDOUT: "the request timed out",
  timeout: "the request timed out",
  ENETUNREACH: "the network is unreachable",
  EHOSTUNREACH: "the network is unreachable",
  ENETDOWN: "the network is unreachable",
  EPROTO: "the secure connection failed",
  tls: "the secure connection could not be verified",
};

/** #6275 S20: claude exited 0 but left no usable account behind for the paste sign-in. */
export const IN_VM_NO_ACCOUNT_AFTER_SIGN_IN_MSG =
  "Claude finished signing in, but left no account here to add. Open a new sign-in link and try again.";
/** A failed exchange whose cause could not be read (not expected; the submit just ended it). */
const IN_VM_EXCHANGE_UNREAD_MSG =
  "The sign-in did not finish. Open a new sign-in link.";

/**
 * #6275 S12, S20: what a failed paste exchange tells the user, by its cause, so a failed sign-in
 * says whether the network, a refusal in front of Anthropic, Anthropic's server or the code was
 * the problem. The server's log line for the child (`[accounts] paste sign-in ended: …`) carries
 * the exit code and signal.
 */
export function inVmExchangeFailureMessage({
  failure,
  end,
}: FailedNativeSignIn): string {
  switch (failure.cause) {
    case "code_refused":
      return "Anthropic did not accept that code. Open a new sign-in link and paste the code it shows.";
    case "denied":
      return `Anthropic's sign-in service refused the request (HTTP ${failure.status}), which is usually not about the code: something between this VM and Anthropic, such as a firewall or proxy, may be blocking it. Check this VM's network, then open a new sign-in link.`;
    case "network":
      return `This VM could not reach Anthropic to finish signing in: ${NETWORK_REASONS[failure.errorCode]}. Check its internet connection, then open a new sign-in link.`;
    case "server":
      return failure.status >= 400
        ? `Anthropic's sign-in service answered with an error (HTTP ${failure.status}). Wait a minute, then open a new sign-in link.`
        : `Anthropic's sign-in service gave an answer this sign-in could not use (HTTP ${failure.status}). Wait a minute, then open a new sign-in link.`;
    case "stopped":
      return "The sign-in stopped before it finished. Open a new sign-in link.";
    case "unknown": {
      const how = end.signal
        ? `was ended by ${end.signal}`
        : `exited with code ${end.code ?? "unknown"}`;
      return `The sign-in did not finish: claude ${how}. Open a new sign-in link.`;
    }
  }
}

function removeInVmDir(configDir: string): void {
  try {
    rmSync(configDir, { recursive: true, force: true });
  } catch {
    // Already gone, or not removable: nothing further to do with it.
  }
}

/**
 * #4349: the base the in-VM sign-in creates `<base>/<uuid>` under — the same base the cli spawn
 * path binds `CLAUDE_CONFIG_DIR` from (`resolveAccountConfigsDir` in `cli/src/configuration.ts`,
 * #1643). By default it is the machine-global `${XDG_CONFIG_HOME:-~/.config}/hapimatic/account-configs`.
 * Under the `HAPI_ACCOUNT_CONFIG_SHARED` ∈ {0,false,no,off} kill switch it is the per-instance
 * `<dataDir>/account-configs`. This reads the SERVER's env: the VM env file
 * `~/.config/hapimatic/env` feeds both the server and the daemon unit, so the switch set there
 * reaches both. Without a `dataDir` the per-instance layout cannot be named, so the shared base is
 * kept.
 */
export function resolveInVmAccountConfigsDir(opts: {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string {
  const env = opts.env ?? process.env;
  const flag = (env.HAPI_ACCOUNT_CONFIG_SHARED ?? "").toLowerCase();
  const shared = !(
    flag === "0" ||
    flag === "false" ||
    flag === "no" ||
    flag === "off"
  );
  if (!shared && opts.dataDir) return join(opts.dataDir, "account-configs");
  const xdgConfigBase =
    env.XDG_CONFIG_HOME?.trim() || join(opts.homeDir ?? homedir(), ".config");
  return join(xdgConfigBase, "hapimatic", "account-configs");
}

/**
 * #4349: the in-VM sign-in command for a fresh config dir. The dir is `<base>/<uuid>`, so it is
 * single-quoted; a quote in the base path (never produced by the default) is refused rather than
 * escaped.
 */
export function inVmSignInCommand(configDir: string): string {
  if (configDir.includes("'")) {
    throw new Error("account config dir path must not contain a single quote");
  }
  return `env -u CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR='${configDir}' claude`;
}

/** The identity fields #4349 registers from a config dir's `.claude.json` — never a credential. */
interface DirIdentity {
  accountUuid: string;
  emailAddress: string;
  organizationUuid: string;
  organizationName: string;
  displayName: string;
  billingType: string;
}

/**
 * Read `<dir>/.claude.json` `oauthAccount` (what Claude Code writes after `/login`), or null while
 * it is absent or incomplete. NEVER opens `.credentials.json`.
 */
export function readDirIdentity(configDir: string): DirIdentity | null {
  const path = join(configDir, ".claude.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      oauthAccount?: Record<string, unknown>;
    };
    const a = parsed.oauthAccount;
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    if (!a || !str(a.accountUuid) || !str(a.emailAddress)) return null;
    return {
      accountUuid: str(a.accountUuid),
      emailAddress: str(a.emailAddress),
      organizationUuid: str(a.organizationUuid),
      organizationName: str(a.organizationName),
      displayName: str(a.displayName),
      billingType: str(a.billingType),
    };
  } catch {
    return null;
  }
}
