// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Account-keyed session restart delegate (issue #2080 — extracted from syncEngine.ts).
 *
 * Owns the two "validate account → kill active session → respawn" flows —
 * `switchAccount` (bind an ACTIVE session to a DIFFERENT account, with R4
 * rollback to the original on failure) and `tokenRefreshRestart` (restart a
 * bound session under the SAME account with a freshly-refreshed token, with a
 * mid-inference `deferred` guard and a single-retry rollback). Refs #1456/#1507/
 * #1517/#1532/#1551/#1555/#1570/#1633/#1248/#1425.
 *
 * These flows DIVERGE from the reconnect/branch metadata prelude
 * (`sessionRespawn.resolveRespawnContext`): they carry account-specific error
 * `code`s, require `session.active` (the inverse of reconnect), and gate on
 * `session.thinking`. Per the #2080 directive ("do NOT force-fit if the account
 * path diverges") the metadata extraction is kept verbatim here rather than reused.
 *
 * Behaviour-preserving move: bodies are byte-identical to the pre-extraction
 * `SyncEngine` methods, except `this.accountService` reads route through the
 * `getAccountService()` lazy getter (AccountService is injected post-construction).
 * `archiveSession` and `spawnSession` stay `SyncEngine` facade methods and are
 * injected here as lazy callbacks so test spies on `engine.archiveSession` /
 * `engine.rpcGateway.spawnSession` still apply.
 */

import { claudeAccountInfoFromStored } from "@hapi/protocol";
import { buildRespawnBase } from "./respawnBase";
import { gracefulTurnInterruptBeforeKill } from "./gracefulTurnInterrupt";
import type {
  AuthBinding,
  ClaudeAccountInfo,
  RedactedApiKey,
} from "@hapi/protocol/schemas";
import type { Session } from "@hapi/protocol/types";
import type { SpawnSessionOptions, AccountValidator } from "./syncEngine";
import type { SessionCache, SessionBindingSnapshot } from "./sessionCache";
import type { RpcGateway } from "./rpcGateway";
// Issue #2301 (Task 2/3): the shared bounded-retry helper + the short post-kill
// capacity-tail budget. Value imports (functions/const) — rpcGateway imports
// neither call-site module, so this edge stays acyclic.
import { spawnWithRetry, CAPACITY_TAIL_DEADLINE_MS } from "./rpcGateway";
import type { EventPublisher } from "./eventPublisher";
import type { TurnLifecycle } from "./turnLifecycle";
import type { ErrorLogger } from "../logging/errorLogger";

type SpawnSessionResult =
  | { type: "success"; sessionId: string; resolvedName?: string }
  | { type: "error"; message: string; code?: string };

type SpawnSessionFn = (
  opts: SpawnSessionOptions
) => Promise<SpawnSessionResult>;

type ArchiveSessionFn = (
  sessionId: string,
  opts?: { reapRemoteWindow?: boolean; isRespawn?: boolean }
) => Promise<void>;

/**
 * Issue #2299 (Task 4): the bound on switchAccount's PRE-KILL wait-for-slot loop.
 * The switch keeps the session RUNNING while it polls the daemon capacity probe;
 * if no slot frees (and the session's own slot is not creditable) within this
 * window it returns `at_capacity` WITHOUT killing. Shared with #2301's post-kill
 * bounded retry so both halves of the switch-resilience chain use one deadline
 * (import this constant there rather than redeclaring it). Env-overridable for the
 * live capacity test + operator tuning; 30–60s per the 2026-08-17 expert ruling.
 */
export const ACCOUNT_SWITCH_SLOT_WAIT_DEADLINE_MS = (() => {
  const raw = parseInt(
    process.env.HAPI_ACCOUNT_SWITCH_SLOT_WAIT_MS || "45000",
    10
  );
  // Clamp to the expert-ruled 30–60s band; a bad env value degrades to 45s.
  if (!Number.isFinite(raw)) return 45_000;
  return Math.max(30_000, Math.min(60_000, raw));
})();

export interface AccountRestartDeps {
  sessionCache: SessionCache;
  rpcGateway: RpcGateway;
  eventPublisher: EventPublisher;
  errorLogger?: ErrorLogger | null;
  /** Lazy read — AccountService is injected into SyncEngine post-construction. */
  getAccountService: () => AccountValidator | null;
  /** The SyncEngine facade's archiveSession (clean kill, keeps the tmux window). */
  archiveSession: ArchiveSessionFn;
  /** The SyncEngine facade's spawnSession (universal spawn choke point). */
  spawnSession: SpawnSessionFn;
  /**
   * Lazy read — TurnLifecycle is injected into SyncEngine post-construction
   * (mirrors SessionRespawn's getTurnLifecycle). Issue #2002: switchAccount /
   * tokenRefreshRestart hard-kill a mid-turn session via killSession, which emits
   * NO turn:finalize — so the open turn row is closed here instead of lingering.
   * Null-tolerant: turn telemetry is best-effort and NEVER blocks a restart.
   */
  getTurnLifecycle: () => TurnLifecycle | null;
  /**
   * Issue #4823: read ONE node-vault entry by id, REDACTED (id / provider / label
   * / maskedKey — never the key). A payment-method switch validates its key
   * target with it BEFORE the kill. Optional: absent ⇒ every key target fails
   * closed with `api_key_not_found`, so an un-wired engine can never bind a key
   * it could not check.
   */
  getApiKeyById?: (id: string) => Promise<RedactedApiKey | null>;
}

/**
 * Issue #4823: what a session is switched ONTO — a subscription account or a
 * node-vault Anthropic API key (by vault id; never key material).
 */
export type PaymentMethodTarget =
  | { kind: "account"; accountUuid: string }
  | { kind: "api-key"; apiKeyId: string };

type SwitchError = { type: "error"; message: string; code?: string };

type AccountSwitchSuccess = {
  type: "success";
  paymentMethod: "account";
  newSessionId: string;
  accountEmail: string;
  accountUuid: string;
  claudeAccount: ClaudeAccountInfo;
  authBinding: AuthBinding;
};

type ApiKeySwitchSuccess = {
  type: "success";
  paymentMethod: "api-key";
  newSessionId: string;
  apiKeyId: string;
  /** The key's display name (vault label, else masked) — never key material. */
  apiKeyLabel: string;
  authBinding: AuthBinding;
};

export type PaymentMethodSwitchResult =
  | AccountSwitchSuccess
  | ApiKeySwitchSuccess
  | SwitchError;

export type PaymentMethodStageResult =
  | (AccountSwitchSuccess & { staged: true })
  | (ApiKeySwitchSuccess & { staged: true })
  | SwitchError;

/** A validated switch target, resolved before anything is killed or written. */
type ResolvedTarget =
  | {
      kind: "account";
      accountUuid: string;
      accountEmail: string;
      claudeAccount: ClaudeAccountInfo;
    }
  | {
      kind: "api-key";
      apiKeyId: string;
      apiKeyMasked: string;
      displayIdentity: string;
    };

/**
 * Issue #4823: the success result for a resolved target — ONE builder for the
 * live switch and the staged path, so both report the same binding.
 */
function switchSuccess(
  sessionId: string,
  resolved: ResolvedTarget
): AccountSwitchSuccess | ApiKeySwitchSuccess {
  return resolved.kind === "account"
    ? {
        type: "success",
        paymentMethod: "account",
        newSessionId: sessionId,
        accountEmail: resolved.accountEmail,
        accountUuid: resolved.accountUuid,
        claudeAccount: resolved.claudeAccount,
        authBinding: {
          kind: "subscription-account",
          displayIdentity: resolved.claudeAccount.email ?? "",
          providerId: "anthropic",
        },
      }
    : {
        type: "success",
        paymentMethod: "api-key",
        newSessionId: sessionId,
        apiKeyId: resolved.apiKeyId,
        apiKeyLabel: resolved.displayIdentity,
        authBinding: {
          kind: "api-key",
          displayIdentity: resolved.displayIdentity,
          providerId: "anthropic",
        },
      };
}

export class AccountRestart {
  private readonly sessionCache: SessionCache;
  private readonly rpcGateway: RpcGateway;
  private readonly eventPublisher: EventPublisher;
  private readonly errorLogger?: ErrorLogger | null;
  private readonly getAccountService: () => AccountValidator | null;
  private readonly archiveSession: ArchiveSessionFn;
  private readonly spawnSession: SpawnSessionFn;
  private readonly getTurnLifecycle: () => TurnLifecycle | null;
  private readonly getApiKeyById: (
    id: string
  ) => Promise<RedactedApiKey | null>;

  constructor(deps: AccountRestartDeps) {
    this.sessionCache = deps.sessionCache;
    this.rpcGateway = deps.rpcGateway;
    this.eventPublisher = deps.eventPublisher;
    this.errorLogger = deps.errorLogger ?? null;
    this.getAccountService = deps.getAccountService;
    this.archiveSession = deps.archiveSession;
    this.spawnSession = deps.spawnSession;
    this.getTurnLifecycle = deps.getTurnLifecycle;
    // Issue #4823: fail closed when no vault reader was wired.
    this.getApiKeyById = deps.getApiKeyById ?? (async () => null);
  }

  /**
   * #3087 (deferred OOS-1 from #2149): thin delegate to the SHARED
   * {@link gracefulTurnInterruptBeforeKill} free function — the #2002 rationale
   * (terminally close a mid-turn session's open telemetry turn around a hard-kill
   * restart, keyed off turn-lifecycle state, 1500 ms bounded race, swallow → hard
   * kill) now lives in `./gracefulTurnInterrupt`. Kept as a private wrapper so the
   * two call sites (`this.gracefulTurnInterruptBeforeKill(...)`) stay byte-identical.
   */
  private async gracefulTurnInterruptBeforeKill(
    sessionId: string
  ): Promise<void> {
    return gracefulTurnInterruptBeforeKill(
      sessionId,
      {
        getTurnLifecycle: this.getTurnLifecycle,
        rpcGateway: this.rpcGateway,
        errorLogger: this.errorLogger,
      },
      "restart"
    );
  }

  /**
   * Issue #2299 (Task 4 — E's pre-check, R1/R6): a bounded PRE-KILL wait-for-slot
   * loop. Polls the owning daemon's read-only capacity probe (the SAME credited
   * count the spawn gate uses) until it reports the session's own reused-window
   * respawn WOULD be admitted, the deadline expires, or the request aborts — with
   * the session still RUNNING throughout (nothing is killed here, so the no-worse
   * guarantee holds by construction).
   *
   * Returns:
   *   "admit"       — proceed to the kill + respawn (immediately, or after a slot
   *                   freed mid-wait).
   *   "at_capacity" — deadline expired or the request aborted with wouldAdmit
   *                   still false → the caller returns `at_capacity` WITHOUT killing.
   *
   * A `null` probe is UNCERTAIN (RPC error / daemon offline / malformed) and
   * returns "admit" — an unverifiable capacity must NEVER strand a live session
   * behind an at_capacity it cannot confirm (Fallback Preservation Rule; the
   * existing kill+respawn + R4 rollback still guard a genuine failure, and the
   * daemon-side own-slot credit already makes a counted session's own respawn
   * admissible). Because a currently-counted session is always self-creditable
   * (KD-3), the COMMON switch-at-capacity case returns "admit" on the first probe
   * and never actually waits; the loop only engages in the rare genuinely-
   * un-creditable edge.
   */
  private async waitForCapacityBeforeKill(
    machineId: string,
    creditHapiSessionId: string,
    signal?: AbortSignal,
    // Issue #2301 (Task 5, R4): invoked ONCE when the pre-kill wait actually
    // begins, so switchAccount can surface the shared "waiting for a slot…" status
    // (this is the PRIMARY capacity wait for a switch — session still running).
    onWaitingForSlot?: () => void
  ): Promise<"admit" | "at_capacity"> {
    const deadline = Date.now() + ACCOUNT_SWITCH_SLOT_WAIT_DEADLINE_MS;
    let waited = false;
    for (;;) {
      if (signal?.aborted) return "at_capacity";
      const probe = await this.rpcGateway.probeCapacity(
        machineId,
        creditHapiSessionId
      );
      if (probe === null || probe.wouldAdmit) {
        if (waited) {
          this.errorLogger?.warn(
            `switchAccount ${creditHapiSessionId}: capacity freed after a pre-kill wait (${probe === null ? "probe uncertain — proceeding" : "wouldAdmit"}); proceeding with the switch`,
            { category: "sync" }
          );
        }
        return "admit";
      }
      if (Date.now() >= deadline) return "at_capacity";
      if (!waited) {
        waited = true;
        // #2301 (Task 5, R4): surface the client-facing "waiting for a slot…"
        // status (the shared #1531 SSE toast) in addition to the server log, so a
        // capacity-throttled switch reads as in-progress rather than a silent stall.
        onWaitingForSlot?.();
        this.errorLogger?.info(
          `switchAccount ${creditHapiSessionId}: at capacity and own slot not creditable — waiting up to ${ACCOUNT_SWITCH_SLOT_WAIT_DEADLINE_MS}ms for a slot before killing (session stays running)`,
          { category: "sync" }
        );
      }
      // Poll every ~2.5–4s (jitter), clamped so we never sleep past the deadline.
      const remaining = deadline - Date.now();
      const waitMs = Math.max(
        0,
        Math.min(2_500 + Math.floor(Math.random() * 1_500), remaining)
      );
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, waitMs);
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  /**
   * Switch the Anthropic account bound to an ACTIVE session (issue #1456,
   * Sub-Issue J). Mechanism: validate the target account -> disconnect the
   * current claude process (archiveSession, which keeps the tmux window) ->
   * respawn with --resume AND the new accountUuid threaded through
   * spawnSession, so the daemon sets HAPI_ACCOUNT_UUID and D's launcher
   * injection (cli/src/claude/accountTokenInjection.ts) resolves the new
   * account's token.
   *
   * Conversation history is preserved via the same --resume + spawn-fresh
   * fallback chain reconnectSession uses (#293/#370/#494/#1396) — the
   * claudeSessionId recovery + stale-id guard below are copied from it; do NOT
   * fail-hard when conversation-file validation is uncertain.
   *
   * On respawn failure, rolls back to the original account (R4). This is the
   * single authoritative validation + orchestration point: both the client
   * route (POST /sessions/:id/account) and the federation receiver
   * (POST /federation/sessions/:id/account) funnel through here.
   */
  async switchAccount(
    sessionId: string,
    accountUuid: string,
    // Issue #2299 (Task 4): the route's abort signal (`c.req.raw.signal`), threaded
    // through SessionService → SyncEngine so a client disconnect cancels the
    // bounded pre-kill wait. Optional + only the LOCAL path threads it (a proxied
    // federated switch re-derives its own signal on the owning node).
    signal?: AbortSignal
  ): Promise<AccountSwitchSuccess | SwitchError> {
    // Issue #4823: the account-only entry point, kept for every existing caller.
    const result = await this.switchPaymentMethod(
      sessionId,
      { kind: "account", accountUuid },
      signal
    );
    if (result.type === "success" && result.paymentMethod !== "account") {
      // Unreachable: an account target only ever produces an account success.
      return {
        type: "error",
        message: "Unexpected switch result",
        code: "unknown",
      };
    }
    return result;
  }

  /**
   * Issue #4823: validate a switch target WITHOUT touching the session — shared
   * by the live switch and the staged (disconnected) path so both refuse the
   * same targets. An account target keeps #1456's checks. A key target must be a
   * Claude session on the SDK launcher (a missing `launcherKind` is refused: the
   * respawn would run on the node's default launcher, which may be PTY/tmux and
   * would strip the key — D-4568-2 A), not in local mode (live switch only — the
   * terminal owns a local-mode session's process), and an `anthropic` entry in
   * this node's vault. Returns the redacted values the binding writer needs;
   * never key material.
   */
  private async resolveSwitchTarget(
    session: {
      metadata?: Session["metadata"];
      agentState?: Session["agentState"];
    },
    target: PaymentMethodTarget,
    opts: { liveSwitch: boolean }
  ): Promise<ResolvedTarget | SwitchError> {
    if (target.kind === "account") {
      // R1: validate the target account BEFORE killing anything. Fail-closed if
      // the validator was never injected (production wires it in web/server.ts).
      const accountService = this.getAccountService();
      if (!accountService) {
        return {
          type: "error",
          message: "Account service unavailable",
          code: "unknown",
        };
      }
      const account = accountService.getRaw(target.accountUuid);
      if (!account) {
        return {
          type: "error",
          message: "Account not found",
          code: "account_not_found",
        };
      }
      if (account.unrefreshable) {
        return {
          type: "error",
          message: `Account ${account.emailAddress} is unrefreshable — user must re-login before it can be used`,
          code: "account_unrefreshable",
        };
      }
      return {
        kind: "account",
        accountUuid: target.accountUuid,
        accountEmail: account.emailAddress,
        claudeAccount: claudeAccountInfoFromStored(account),
      };
    }

    if ((session.metadata?.flavor ?? "claude") !== "claude") {
      return {
        type: "error",
        message: "API-key billing is available for Claude Code sessions only",
        code: "api_key_agent_unsupported",
      };
    }
    const launcherKind = session.metadata?.launcherKind;
    if (launcherKind !== "sdk") {
      return {
        type: "error",
        message: `API-key sessions run on the SDK launcher (this session: ${launcherKind ?? "unrecorded"}) — start a new session on an API key`,
        code: "api_key_launcher_unsupported",
      };
    }
    if (opts.liveSwitch && session.agentState?.controlledByUser === true) {
      return {
        type: "error",
        message:
          "This session is in local mode — return it to remote mode to switch to an API key",
        code: "api_key_local_mode_unsupported",
      };
    }
    const key = await this.getApiKeyById(target.apiKeyId);
    if (!key || key.provider !== "anthropic") {
      return {
        type: "error",
        message: "No Anthropic API key with that id in this node's vault",
        code: "api_key_not_found",
      };
    }
    return {
      kind: "api-key",
      apiKeyId: key.id,
      apiKeyMasked: key.maskedKey,
      // The daemon's spawn-time label rule (resolveApiKeyDisplayLabelById).
      displayIdentity: key.label?.trim() || key.maskedKey,
    };
  }

  /**
   * Issue #4823: switch an ACTIVE session's payment method — onto a subscription
   * account (the #1456 account switch) or onto a node-vault Anthropic API key —
   * through ONE validate → capacity gate → interrupt → archive → persist the new
   * binding → respawn `--resume` → R4 rollback body. The new binding is written to
   * the record BEFORE the respawn (R4 of #4823): the turns ledger stamps a turn's
   * identity from the record when the turn opens, so a write after the respawn
   * would leave the first post-switch turn attributed to the old binding.
   */
  async switchPaymentMethod(
    sessionId: string,
    target: PaymentMethodTarget,
    signal?: AbortSignal
  ): Promise<PaymentMethodSwitchResult> {
    const session = this.sessionCache.getSession(sessionId);
    if (!session) {
      return {
        type: "error",
        message: "Session not found",
        code: "session_not_found",
      };
    }
    if (!session.active) {
      return {
        type: "error",
        message: "Session is not active; use reconnect instead",
        code: "not_active",
      };
    }

    const resolved = await this.resolveSwitchTarget(session, target, {
      liveSwitch: true,
    });
    if ("type" in resolved) {
      return resolved;
    }
    if (this.isCurrentBinding(session, resolved)) {
      return {
        type: "error",
        message:
          resolved.kind === "account"
            ? "Session is already bound to this account"
            : "Session is already billed to this API key",
        code: "no_change",
      };
    }
    // The label the switch logs/messages use — an email or a key label, never a key.
    const targetLabel =
      resolved.kind === "account"
        ? resolved.accountEmail
        : `API key "${resolved.displayIdentity}"`;

    // Metadata extraction (mirrors reconnectSession).
    const cwd = session.metadata?.path;
    if (!cwd) {
      return {
        type: "error",
        message: "Session does not have a working directory",
        code: "unknown",
      };
    }
    const machineId = session.metadata?.machineId;
    if (!machineId) {
      return {
        type: "error",
        message: "Session does not have a machine ID",
        code: "unknown",
      };
    }
    const agent = session.metadata?.flavor ?? "claude";
    if (
      agent !== "claude" &&
      agent !== "codex" &&
      agent !== "gemini" &&
      agent !== "opencode"
    ) {
      return {
        type: "error",
        message: `Unsupported agent type: ${agent}`,
        code: "unknown",
      };
    }
    const sessionTag = this.sessionCache.getSessionTag(sessionId);
    if (!sessionTag) {
      return {
        type: "error",
        message: "Session does not have a tag - cannot reuse",
        code: "unknown",
      };
    }
    // claudeSessionId recovery + stale-id guard — copied from reconnectSession
    // (#370/#494/#1396 null-tolerance). Captured BEFORE archive while the
    // session is still active.
    let claudeSessionId = session.metadata?.claudeSessionId;
    if (!claudeSessionId) {
      const recovered = await this.rpcGateway.getSessionClaudeId(
        machineId,
        sessionTag
      );
      if (recovered) {
        claudeSessionId = recovered;
      }
    }
    if (claudeSessionId) {
      const exists = await this.rpcGateway.hasClaudeConversation(
        machineId,
        cwd,
        claudeSessionId
      );
      // exists === false: stale id -> clear so respawn starts fresh (history
      // may be lost but the session stays alive on the new account).
      // exists === null: uncertain -> proceed with --resume unchanged (#1396).
      if (exists === false) {
        claudeSessionId = undefined;
      }
    }

    // #2002 (R2): capture the rate-limited state BEFORE the archive clears it
    // (sessionCache.handleSessionEnd nulls session.rateLimited on the kill). If a
    // 429 was active as we switch, we re-surface it after a successful respawn so
    // the switch does not present as a silent stall.
    const preSwitchRateLimited = session.rateLimited ?? null;

    // Issue #2299 (Task 4 — E's pre-check, R1/R6): verify the daemon would admit
    // this session's OWN reused-window respawn BEFORE killing it. A currently-
    // counted session is self-creditable (KD-3), so this returns "admit" on the
    // first probe in the common switch-at-capacity case; only a genuinely
    // un-creditable slot triggers the bounded wait, and a deadline/abort there
    // returns at_capacity WITHOUT killing — the session stays running and
    // connected (the no-worse guarantee). This is the fail-safe atop the
    // daemon-side own-slot credit (Tasks 1-2). The graceful-interrupt, archive,
    // respawn, and R4 rollback below are untouched (Fallback Preservation Rule).
    const capacityGate = await this.waitForCapacityBeforeKill(
      machineId,
      sessionTag,
      signal,
      // #2301 (Task 5, R4): emit the shared "waiting for a slot…" status keyed by
      // the session UUID (waitForCapacityBeforeKill only holds the tag).
      () =>
        this.eventPublisher.emit({
          type: "waiting-for-slot",
          sessionId,
          context: "account-switch",
          deadlineMs: ACCOUNT_SWITCH_SLOT_WAIT_DEADLINE_MS,
        })
    );
    if (capacityGate === "at_capacity") {
      this.errorLogger?.warn(
        `switchAccount ${sessionId}: instance at capacity and this session's slot is not creditable within the wait deadline; switch not attempted, session left running`,
        { category: "sync", sessionId }
      );
      return {
        type: "error",
        message:
          "Instance is at capacity and this session's slot cannot be credited; the switch was not attempted and the session is still running.",
        code: "at_capacity",
      };
    }

    // #2002 (R1a-opt): bounded graceful turn interrupt before the hard kill, so a
    // mid-turn Claude can close its turn (clean transcript boundary + `interrupted`
    // telemetry) rather than being killed mid-record. Falls through on timeout.
    await this.gracefulTurnInterruptBeforeKill(sessionId);

    // Disconnect the current process (keeps the tmux window) — the clean kill.
    // #2453 (Task 7): a respawn — do NOT auto-pause the session's loops (same
    // uuid respawns immediately; reconnectSession is never reached).
    await this.archiveSession(sessionId, { isRespawn: true });

    // #2002 (R1a): killSession emits no turn:finalize — terminally orphan any turn
    // still tracked open for this session (backstop for the interrupt above;
    // idempotent — a completed interrupt already untracked it). Best-effort telemetry.
    this.getTurnLifecycle()?.orphanTrackedTurnsForSession(sessionId);

    // Issue #4823 (R5): the ORIGINAL credential binding — restored verbatim if
    // the switch fails. Captured before any write; an absent field was absent.
    const originalBinding: SessionBindingSnapshot = {
      accountUuid: session.metadata?.accountUuid,
      claudeAccount: session.metadata?.claudeAccount,
      authBinding: session.metadata?.authBinding,
      apiKeyId: session.metadata?.apiKeyId,
      apiKeyMasked: session.metadata?.apiKeyMasked,
    };

    // #3087: build the shared respawn base ONCE (post-archive; handleSessionEnd
    // never mutates session.metadata). buildRespawnBase is the tested preserved-
    // field superset; it ALSO restores outputStyle / effort / rawModel, which the
    // old hand-rolled payload dropped (R3). Overrides over the base: agent (the
    // base hard-codes "claude"; keep the session validated flavor, R4) and the
    // credential binding (the base reads the ORIGINAL binding; the switch targets
    // the new one). sessionType:"simple" (from the base) is MANDATORY
    // (#1248/#1425): a reconnect-style respawn must NEVER create a worktree.
    // Issue #4823: built BEFORE the binding write below, so the bare base keeps the
    // ORIGINAL single credential for the R4 rollback respawn.
    const respawnBase = buildRespawnBase(session, {
      machineId,
      directory: cwd,
      sessionTag,
      claudeSessionId,
    });

    // Issue #4823 (R4): persist the NEW binding before the respawn, so the child's
    // first turn is stamped with it (the turns ledger reads the record at turn
    // open). The reconnect-by-tag path discards the respawned CLI's own metadata,
    // so this record write is what persists the switch (#1517). Each writer drops
    // the other kind's fields: a record holding an account AND a key makes every
    // later respawn refuse (`api_key_with_account`).
    const persisted = await this.persistBinding(sessionId, resolved);
    if (!persisted) {
      // The write did not land, so the record still names the ORIGINAL binding —
      // the session was already interrupted and archived, so respawn it under
      // that binding (the bare base) rather than leave it down.
      this.errorLogger?.warn(
        `switchAccount ${sessionId}: the new binding (${targetLabel}) did not persist within the retry budget; respawning under the original binding`,
        { category: "sync", sessionId }
      );
      return this.respawnUnderOriginal(
        sessionId,
        respawnBase,
        agent,
        "the new binding could not be saved on the session"
      );
    }

    // #2301 (Task 3, R1/R6, KD-3): the spawnWithRetry wrapper (transient-RPC + a
    // SHORT capacity TAIL) is preserved verbatim; only the inner payload is routed
    // through buildRespawnBase (#3087). The primary capacity wait is #2299's
    // PRE-kill waitForCapacityBeforeKill (session still running); this POST-kill
    // respawn just absorbs transient RPC faults and the residual slot-steal race,
    // so a long wait here can't widen the disconnected window (R6). The two-tier
    // --resume/spawn-fresh fallback and the R4 rollback below are preserved.
    const spawnResult = await spawnWithRetry(
      () =>
        this.spawnSession({
          ...respawnBase,
          agent,
          // Issue #4568/#4823: the switch TARGET replaces the binding the base
          // re-threads from metadata. All three fields are set explicitly on every
          // switch spawn so the respawn carries exactly ONE credential.
          accountUuid:
            resolved.kind === "account" ? resolved.accountUuid : undefined,
          apiKeyId: resolved.kind === "api-key" ? resolved.apiKeyId : undefined,
          apiKeyMasked:
            resolved.kind === "api-key" ? resolved.apiKeyMasked : undefined,
        }),
      {
        capacityMode: "tail",
        signal,
        onWaitingForSlot: () =>
          this.eventPublisher.emit({
            type: "waiting-for-slot",
            sessionId,
            context: "account-switch",
            deadlineMs: CAPACITY_TAIL_DEADLINE_MS,
          }),
      }
    );

    if (spawnResult.type === "success") {
      // R5: announce the live account switch (H's modal dismisses its overlay).
      // Issue #4823 (ruling R1): a key target emits NO `account-switched` — its
      // schema requires an account, and the binding writer's `session-updated`
      // already refreshes every client.
      if (resolved.kind === "account") {
        this.eventPublisher.emit({
          type: "account-switched",
          sessionId,
          accountUuid: resolved.accountUuid,
          accountEmail: resolved.accountEmail,
        });
      }
      // #2002 (R2): if a 429 was active as we switched, tell the client so the
      // now-cleared rate-limit doesn't present as a silent stall. One-time
      // informational — NOT a persisted chip (this switch may target a different,
      // non-limited account).
      if (preSwitchRateLimited) {
        this.eventPublisher.emit({
          type: "rate-limited-during-switch",
          sessionId,
          resetText: preSwitchRateLimited.resetText,
          resetAt: preSwitchRateLimited.resetAt,
        });
      }
      // Reconnect-style respawn returns the SAME session id (tag reused).
      // accountUuid + claudeAccount are returned so the federation receiver
      // (POST /federation/sessions/:id/account) and SessionService can update
      // the hub's NodeRegistry cache for a peer-owned session (R6).
      return switchSuccess(sessionId, resolved);
    }

    // R4: respawn under the new binding failed — roll back to the original so the
    // session stays alive. Issue #4823 (R5): restore the ORIGINAL binding on the
    // record FIRST. If that write fails, do NOT respawn: the child would run the
    // original credential under a record naming the target — the record/process
    // mismatch a switch must never leave behind.
    this.errorLogger?.warn(
      `switchAccount ${sessionId}: respawn under ${targetLabel} failed (${spawnResult.message}); rolling back to the original binding`,
      { category: "sync", sessionId }
    );
    const restored = await this.sessionCache.restoreSessionBinding(
      sessionId,
      originalBinding
    );
    if (!restored) {
      this.errorLogger?.error(
        `switchAccount ${sessionId}: rollback could not restore the original binding on the session record; NOT respawning (session left disconnected, reconnectable)`,
        { category: "sync", sessionId }
      );
      return {
        type: "error",
        message: `Switch failed (${spawnResult.message}) and the original binding could not be restored; the session is disconnected but can be reconnected.`,
        code: "switch_failed_rollback_failed",
      };
    }
    return this.respawnUnderOriginal(
      sessionId,
      respawnBase,
      agent,
      spawnResult.message
    );
  }

  /** Issue #4823: does the session record already hold this resolved binding? */
  private isCurrentBinding(
    session: { metadata?: Session["metadata"] },
    resolved: ResolvedTarget
  ): boolean {
    return resolved.kind === "account"
      ? session.metadata?.accountUuid === resolved.accountUuid
      : session.metadata?.apiKeyId === resolved.apiKeyId;
  }

  /**
   * Issue #4823: write a resolved binding to the session record through its
   * kind's version-checked writer. Each writer drops the other kind's fields, so
   * the record never holds both an account and a key.
   */
  private persistBinding(
    sessionId: string,
    resolved: ResolvedTarget
  ): Promise<boolean> {
    return resolved.kind === "account"
      ? this.sessionCache.updateSessionAccount(
          sessionId,
          resolved.accountUuid,
          resolved.claudeAccount
        )
      : this.sessionCache.updateSessionApiKeyBinding(sessionId, {
          apiKeyId: resolved.apiKeyId,
          apiKeyMasked: resolved.apiKeyMasked,
          displayIdentity: resolved.displayIdentity,
        });
  }

  /**
   * #3087/#4823: the R4 rollback respawn — the BARE respawn base, which carries
   * the session's ORIGINAL single credential (it was built before any binding
   * write). #2301's transient-only retry wrapper (capacityMode none: a rollback
   * must FAIL FAST on capacity and is NOT abortable) is preserved verbatim.
   */
  private async respawnUnderOriginal(
    sessionId: string,
    respawnBase: ReturnType<typeof buildRespawnBase>,
    agent: SpawnSessionOptions["agent"],
    reason: string
  ): Promise<SwitchError> {
    const rollback = await spawnWithRetry(
      () =>
        this.spawnSession({
          ...respawnBase,
          agent,
        }),
      {
        capacityMode: "none",
      }
    );
    if (rollback.type === "success") {
      return {
        type: "error",
        message: `Switch failed (${reason}); rolled back to the original account or key.`,
        code: "switch_failed_rolled_back",
      };
    }
    // R4 edge: rollback respawn ALSO failed. Session is disconnected but
    // reconnectable (not data-loss) — surface a loud error.
    this.errorLogger?.error(
      `switchAccount ${sessionId}: rollback respawn ALSO failed (${rollback.message}); session left disconnected (reconnectable)`,
      { category: "sync", sessionId }
    );
    return {
      type: "error",
      message: `Switch failed and rollback failed (${rollback.message}); the session is disconnected but can be reconnected.`,
      code: "switch_failed_rollback_failed",
    };
  }

  /**
   * Issue #3633: stage the account PAIR on a DISCONNECTED session WITHOUT
   * relaunching it. The disconnected Session Configuration "Save changes" sends
   * model / rawModel / effort / permissionMode / MCP first (all already staged
   * by #3285 round 11) and the account LAST; that trailing account call used to
   * hit switchAccount's `!active` guard (`not_active` -> 409). This method is the
   * staged counterpart: it runs switchAccount's up-front validation MINUS the
   * `!active` guard, then persists the `{accountUuid, claudeAccount}` pair via
   * `sessionCache.updateSessionAccount` — no archive, no spawn.
   *
   * The PAIR is written together (never uuid alone): every account surface reads
   * `claudeAccount.email` (`useSessionAccountEmail`) and nothing on the reconnect
   * path repairs a stale `claudeAccount`, so writing only `accountUuid` would
   * leave the OLD email showing after Save and after reconnect.
   *
   * `reconnectSession` threads `metadata.accountUuid` into the spawn
   * (`HAPI_ACCOUNT_UUID`, `sessionRespawn.ts`), so the session comes back bound to
   * the staged account. Same-account is an idempotent success (D1-A), NOT the live
   * switch's `no_change` 409 — a disconnected re-Save is benign.
   *
   * Reached only via the `!active` branch in the `SyncEngine.switchAccount`
   * facade (the round-11 `applySessionConfig` idiom: `!active` is decided in the
   * ENGINE op, so the route/receiver carry no `!active` guard). `switchAccount`
   * itself stays byte-stable and keeps `not_active` as a defensive backstop.
   */
  async stageAccount(
    sessionId: string,
    accountUuid: string
  ): Promise<(AccountSwitchSuccess & { staged: true }) | SwitchError> {
    // Issue #4823: the account-only entry point, kept for every existing caller.
    const result = await this.stagePaymentMethod(sessionId, {
      kind: "account",
      accountUuid,
    });
    if (result.type === "success" && result.paymentMethod !== "account") {
      // Unreachable: an account target only ever produces an account success.
      return {
        type: "error",
        message: "Unexpected stage result",
        code: "unknown",
      };
    }
    return result;
  }

  /**
   * Issue #4823 (R7): stage a payment-method target — an account (#3633) or a
   * node-vault Anthropic API key — on a DISCONNECTED session without relaunching
   * it. Same validation as the live switch (minus local mode: a stopped session
   * has no controlling terminal), then the same binding writer, so the next
   * reconnect (`sessionRespawn.ts` threads `accountUuid` / `apiKeyId` +
   * `apiKeyMasked` from the record) starts on the staged binding. Re-staging the
   * binding the session already holds is an idempotent success (D1-A).
   */
  async stagePaymentMethod(
    sessionId: string,
    target: PaymentMethodTarget
  ): Promise<PaymentMethodStageResult> {
    const session = this.sessionCache.getSession(sessionId);
    if (!session) {
      return {
        type: "error",
        message: "Session not found",
        code: "session_not_found",
      };
    }
    // No `!active` guard here — staging IS the disconnected path (#3633). The
    // live switchAccount keeps the `not_active` backstop for active-only callers.

    // Validate the target BEFORE writing anything (mirrors the live switch, so a
    // deleted/unrefreshable account or a missing key fails at Save time, not late
    // inside the launcher at reconnect).
    const resolved = await this.resolveSwitchTarget(session, target, {
      liveSwitch: false,
    });
    if ("type" in resolved) {
      return resolved;
    }

    const success: PaymentMethodStageResult = {
      ...switchSuccess(sessionId, resolved),
      staged: true,
    };

    // Idempotent success (D1-A): staging the binding the session already holds is
    // a no-op success, NOT the live switch's no_change 409.
    if (this.isCurrentBinding(session, resolved)) {
      return success;
    }

    // Persist via the same targeted, version-checked writers the live switch
    // uses. They emit `session-updated`, so the Account Chip / header badge
    // refresh after Save without waiting for the next poll (R5). Neither touches
    // `active`. The account PAIR is written together (never uuid alone — every
    // account surface reads `claudeAccount.email`); each writer drops the other
    // kind's fields so the record never holds both an account and a key.
    const persisted = await this.persistBinding(sessionId, resolved);
    if (!persisted) {
      return {
        type: "error",
        message:
          resolved.kind === "account"
            ? "Account staging did not persist within the retry budget"
            : "API-key staging did not persist within the retry budget",
        code: "stage_failed",
      };
    }
    return success;
  }

  /**
   * Issue #1507: restart a bound session with a freshly refreshed token.
   *
   * Called by the daemon's TokenRefreshService.onSuccessfulRefresh callback
   * (via POST /cli/sessions/:id/token-refresh) after a proactive or reactive
   * refresh succeeds for the session's bound account. Unlike switchAccount():
   *  - it is SAME-account, so it skips the "no_change" guard;
   *  - it does NOT persist the account (updateSessionAccount, #1517) because the
   *    account is unchanged — the persisted accountUuid is already correct;
   *  - it skips the up-front AccountService validation switchAccount does for a
   *    user-chosen target, but still re-checks `unrefreshable` (R3) before
   *    killing the process, so a revoked account surfaces a re-login state
   *    rather than spawn-failing opaquely.
   *
   * R6: a mid-inference session (thinking=true) is NOT interrupted — returns
   * {type:"deferred"} so the daemon can retry within the proactive buffer window.
   * R4 (no restart storms) is enforced at the daemon layer via the per-account
   * in-flight guard in restartBoundSessions().
   */
  async tokenRefreshRestart(
    sessionId: string,
    accountUuid: string
  ): Promise<
    | { type: "success" }
    | { type: "deferred"; reason: string }
    | { type: "error"; message: string; code?: string }
  > {
    const session = this.sessionCache.getSession(sessionId);
    if (!session) {
      return {
        type: "error",
        message: "Session not found",
        code: "session_not_found",
      };
    }
    if (!session.active) {
      return {
        type: "error",
        message: "Session not active",
        code: "not_active",
      };
    }
    // Issue #4823 (R8): a session billed to an API key has no account token to
    // refresh. This arises when a refresh restart queued for the session's OLD
    // account lands after a switch onto a key: respawning would carry the key
    // (re-threaded by the respawn base) AND the account, which `spawnSession`
    // refuses (`api_key_with_account`) — after the kill. Refuse BEFORE anything
    // is killed; the key session keeps running untouched.
    if (
      session.metadata?.apiKeyId ||
      session.metadata?.authBinding?.kind === "api-key"
    ) {
      return {
        type: "error",
        message:
          "Session bills an API key — no account token to refresh; restart skipped",
        code: "api_key_session",
      };
    }
    // R6: never interrupt a mid-inference session. The daemon retries.
    if (session.thinking) {
      return { type: "deferred", reason: "session is mid-inference" };
    }

    // R3: re-check the account is still refreshable before killing the process.
    // AccountService.getRaw() is synchronous (plain file read). If the account
    // was revoked between the daemon's refresh and this restart, emit a
    // session-scoped account-unrefreshable event so the UI shows "re-login
    // required" rather than letting the respawn fail opaquely.
    const acc = this.getAccountService()?.getRaw(accountUuid);
    if (acc?.unrefreshable) {
      this.eventPublisher.emit({
        type: "account-unrefreshable",
        sessionId,
        accountUuid,
      });
      return {
        type: "error",
        message: "Account became unrefreshable before restart",
        code: "account_unrefreshable",
      };
    }

    // Extract spawn parameters (mirrors switchAccount's reconnect-style respawn).
    const cwd = session.metadata?.path;
    const machineId = session.metadata?.machineId;
    const agent = session.metadata?.flavor ?? "claude";
    const sessionTag = this.sessionCache.getSessionTag(sessionId);
    if (!cwd || !machineId || !sessionTag) {
      return {
        type: "error",
        message: "Session missing required metadata",
        code: "unknown",
      };
    }
    if (
      agent !== "claude" &&
      agent !== "codex" &&
      agent !== "gemini" &&
      agent !== "opencode"
    ) {
      return {
        type: "error",
        message: `Unsupported agent type: ${agent}`,
        code: "unknown",
      };
    }

    // claudeSessionId recovery + stale-id guard (copied from switchAccount).
    let claudeSessionId = session.metadata?.claudeSessionId;
    if (!claudeSessionId) {
      const recovered = await this.rpcGateway.getSessionClaudeId(
        machineId,
        sessionTag
      );
      if (recovered) {
        claudeSessionId = recovered;
      }
    }
    if (claudeSessionId) {
      const exists = await this.rpcGateway.hasClaudeConversation(
        machineId,
        cwd,
        claudeSessionId
      );
      if (exists === false) {
        claudeSessionId = undefined;
      }
    }

    // #2002 (R2): capture rate-limited state before the archive clears it. The R6
    // thinking-guard above does NOT catch a rate-limited turn — setRateLimited stales
    // thinking to false the instant the 429 lands (#2002 Finding B) — so a 429 during a
    // token-refresh restart reaches this hard kill and would otherwise stall silently.
    const preRestartRateLimited = session.rateLimited ?? null;

    // #3641: pre-kill capacity pre-check — the THIRD kill-site. #2299 wired this
    // gate into switchAccount; tokenRefreshRestart (automatic, no user in the loop)
    // was the uncovered third site (directive OR-4). Probe ONCE for the respawn's
    // OWN slot — credited by `hapiSessionId: sessionTag`, the same id threaded to
    // spawnSession below — so the probe measures exactly the reused-window slot the
    // respawn will credit, not an under-count that would defer spuriously.
    //
    // The fail-safe is probe-once -> DEFER, NOT switchAccount's bounded wait: this
    // path is automatic and already returns {type:"deferred"} for a mid-inference
    // session (above), and the daemon's TokenRefreshService retries a deferred
    // within its proactive-buffer window. So if the respawn is not admittable, do
    // NOT kill — return deferred and let the daemon retry; never block on a slot loop.
    //
    // probe === null (RPC error / daemon offline / uncertain) OR wouldAdmit ⇒ proceed
    // exactly as today (R3, no regression on the normal-load path) — mirrors
    // waitForCapacityBeforeKill's `probe === null || probe.wouldAdmit` admit test.
    // Ordered AFTER the mid-inference guard (a thinking session defers for THAT
    // reason) and BEFORE gracefulTurnInterruptBeforeKill so a deferral leaves the
    // session fully untouched — no turn interrupt, no kill.
    const capacityProbe = await this.rpcGateway.probeCapacity(
      machineId,
      sessionTag
    );
    if (capacityProbe !== null && !capacityProbe.wouldAdmit) {
      this.errorLogger?.info(
        `tokenRefreshRestart ${sessionTag}: instance at capacity and own slot not creditable — deferring the refresh restart (session left running); the daemon retries within its proactive-buffer window`,
        { category: "sync" }
      );
      return {
        type: "deferred",
        reason: "instance at capacity — token-refresh restart deferred",
      };
    }

    // #2002 (R1a-opt): bounded graceful turn interrupt before the hard kill.
    await this.gracefulTurnInterruptBeforeKill(sessionId);

    // Clean kill, then respawn with --resume + the SAME account. sessionType
    // "simple" is MANDATORY (#1248/#1425): a reconnect-style respawn must NEVER
    // create a worktree. accountUuid -> HAPI_ACCOUNT_UUID -> D's token injection
    // picks up the freshly-refreshed stored token.
    // #2453 (Task 7): a respawn — do NOT auto-pause the session's loops.
    await this.archiveSession(sessionId, { isRespawn: true });

    // #2002 (R1a): backstop — orphan any turn still tracked open after the kill
    // (killSession emits no turn:finalize). Best-effort telemetry.
    this.getTurnLifecycle()?.orphanTrackedTurnsForSession(sessionId);

    // #3087: shared respawn base (post-archive; the kill does not mutate
    // session.metadata). Restores outputStyle / effort / rawModel dropped by the
    // old hand-rolled payload (R3). Overrides: agent (the session validated flavor,
    // not the base "claude", R4) and accountUuid (same bound account; explicit for
    // parity with switchAccount and independence from metadata-mutation timing).
    const respawnBase = buildRespawnBase(session, {
      machineId,
      directory: cwd,
      sessionTag,
      claudeSessionId,
    });

    const result = await this.spawnSession({
      ...respawnBase,
      agent,
      accountUuid,
    });

    if (result.type === "success") {
      // Announce the live restart so clients refetch fresh session state.
      // Reuses the account-switched event (same-account); accountEmail is the
      // real bound email when available.
      this.eventPublisher.emit({
        type: "account-switched",
        sessionId,
        accountUuid,
        accountEmail: acc?.emailAddress ?? "",
      });
      // #2002 (R2): re-surface a rate-limit that was active as the token-refresh
      // restart killed the session, so it does not present as a silent stall.
      if (preRestartRateLimited) {
        this.eventPublisher.emit({
          type: "rate-limited-during-switch",
          sessionId,
          resetText: preRestartRateLimited.resetText,
          resetAt: preRestartRateLimited.resetAt,
        });
      }
      return { type: "success" };
    }

    // #1532 (Fallback Preservation Rule): the respawn failed. Mirror
    // switchAccount's R4 rollback — but with two deliberate differences:
    //   (1) the rollback respawns under the SAME account, because the refresh
    //       succeeded so the stored token is valid and the failure was likely
    //       transient (tmux/port/daemon hiccup) — making this a single retry;
    //   (2) a successful retry returns success (the goal — session alive with
    //       the fresh token — was met), unlike switchAccount whose rollback runs
    //       on the ORIGINAL account and therefore returns an error.
    // No second archiveSession: the first spawn returned non-success (no live
    // process), so the rollback respawns over the already-archived session.
    this.errorLogger?.warn(
      `tokenRefreshRestart ${sessionId}: respawn under ${accountUuid} failed (${result.message}); retrying once (rollback)`,
      { category: "sync", sessionId, context: { accountUuid } }
    );
    // #1532 retry: bare base + overrides, SAME account, single retry over the
    // already-archived session (Fallback Preservation Rule).
    const rollback = await this.spawnSession({
      ...respawnBase,
      agent,
      accountUuid,
    });
    if (rollback.type === "success") {
      this.eventPublisher.emit({
        type: "account-switched",
        sessionId,
        accountUuid,
        accountEmail: acc?.emailAddress ?? "",
      });
      return { type: "success" };
    }

    // R4 edge: both the respawn and the rollback failed. The session is
    // disconnected but reconnectable (the tmux window + session record survive)
    // — NOT data loss. The daemon's TokenRefreshService callback invoked us
    // fire-and-forget, so there is no synchronous channel back to the client;
    // emit a session-scoped session-restart-failed event so the UI can show a
    // "reconnect required" state instead of a silently-dead session. (Distinct
    // from account-unrefreshable / #1531, which means "re-login required" — here
    // the account is healthy; the session just needs a reconnect.)
    this.errorLogger?.error(
      `tokenRefreshRestart ${sessionId}: rollback respawn ALSO failed (${rollback.message}); session left disconnected (reconnectable)`,
      { category: "sync", sessionId, context: { accountUuid } }
    );
    this.eventPublisher.emit({
      type: "session-restart-failed",
      sessionId,
      accountUuid,
      error: rollback.message,
    });
    return {
      type: "error",
      message: rollback.message,
      code: "spawn_failed_rollback_failed",
    };
  }
}
