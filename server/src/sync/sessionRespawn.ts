// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session respawn delegate (issue #2080 — extracted from syncEngine.ts).
 *
 * Owns the two "respawn an existing session" flows — `reconnectSession` (reuse
 * the same HAPI session with `--resume`) and `branchSession` (fork a NEW HAPI
 * session with `--resume --fork-session`). Refs #1664/#1661/#1778/#1396/#1401/
 * #370/#494/#1698/#1248/#1238.
 *
 * Issue #966 consolidation: the metadata prelude that both flows shared —
 * session lookup → claudeSessionId → cwd (+ #1778 cwd-gone probe) → machineId →
 * agent validation → sessionTag — is unified into `resolveRespawnContext`. The
 * #1778 `fsAccess` probe is PARAMETERIZED to reconnect ONLY: branchSession has no
 * cwd-gone probe and its error shape has no `code` field, so enabling it there
 * would change its return contract. The reconnect-only `session.active` guard and
 * the #1664 orphan sweep are likewise gated by parameters so both flows keep
 * their exact pre-extraction behavior (error priority + side-effect ordering).
 *
 * Behaviour-preserving move: the post-prelude bodies are byte-identical to the
 * pre-extraction `SyncEngine` methods. `spawnSession` stays a `SyncEngine` facade
 * method (the universal spawn choke point + account-health gate #1698) and is
 * injected here as a callback; `turnLifecycle` (set post-construction) is read via
 * a lazy getter.
 */

import { access as fsAccess } from "node:fs/promises";
import type { Session } from "@hapi/protocol/types";
import { isYoloEquivalentMode } from "@hapi/protocol";
import type { SpawnSessionOptions } from "./syncEngine";
import type { SessionCache } from "./sessionCache";
import type { RpcGateway } from "./rpcGateway";
import type { EventPublisher } from "./eventPublisher";
import type { TurnLifecycle } from "./turnLifecycle";
import type { ErrorLogger } from "../logging/errorLogger";
import type { LoopCronLifecycleCoupler } from "./loopCronLifecycle";
// Issue #2301 (Task 4): the shared bounded-retry helper (rpcGateway imports no
// call-site module → acyclic) + the shared capacity deadline (D1/OR-2 — one
// deadline for the pre-kill wait, the switch tail, and this reconnect poll).
import { spawnWithRetry } from "./rpcGateway";
import { ACCOUNT_SWITCH_SLOT_WAIT_DEADLINE_MS } from "./accountRestart";

type SpawnSessionResult =
  | { type: "success"; sessionId: string; resolvedName?: string }
  | { type: "error"; message: string; code?: string };

type SpawnSessionFn = (
  opts: SpawnSessionOptions
) => Promise<SpawnSessionResult>;

type RespawnAgent = "claude" | "codex" | "gemini" | "opencode";

type RespawnContextResult =
  | {
      ok: true;
      session: Session;
      claudeSessionId: string | undefined;
      /** Issue #1082: codex resume id (mirror of claudeSessionId). Populated by
       *  onSessionFound → server metadata; the reconnect path threads it into
       *  the respawn resume id for codex sessions (ruling D5). */
      codexSessionId: string | undefined;
      cwd: string;
      machineId: string;
      agent: RespawnAgent;
      sessionTag: string | null;
    }
  | { ok: false; error: string; code?: string };

export interface SessionRespawnDeps {
  sessionCache: SessionCache;
  rpcGateway: RpcGateway;
  eventPublisher: EventPublisher;
  errorLogger?: ErrorLogger | null;
  /** Lazy read — TurnLifecycle is injected into SyncEngine post-construction. */
  getTurnLifecycle: () => TurnLifecycle | null;
  /** The SyncEngine facade's spawnSession (universal spawn choke point). */
  spawnSession: SpawnSessionFn;
  /**
   * Issue #2453 (Task 7): lazy read — the loop-cron lifecycle coupler, wired
   * post-construction. `reconnectSession` (NOT branchSession) calls its
   * onReconnect at each success exit to auto-resume the session's ledgered loops.
   */
  getLoopCronCoupler?: () => LoopCronLifecycleCoupler | null;
}

export class SessionRespawn {
  private readonly sessionCache: SessionCache;
  private readonly rpcGateway: RpcGateway;
  private readonly eventPublisher: EventPublisher;
  private readonly errorLogger?: ErrorLogger | null;
  private readonly getTurnLifecycle: () => TurnLifecycle | null;
  private readonly spawnSession: SpawnSessionFn;
  private readonly getLoopCronCoupler: () => LoopCronLifecycleCoupler | null;

  constructor(deps: SessionRespawnDeps) {
    this.sessionCache = deps.sessionCache;
    this.rpcGateway = deps.rpcGateway;
    this.eventPublisher = deps.eventPublisher;
    this.errorLogger = deps.errorLogger ?? null;
    this.getTurnLifecycle = deps.getTurnLifecycle;
    this.spawnSession = deps.spawnSession;
    this.getLoopCronCoupler = deps.getLoopCronCoupler ?? (() => null);
  }

  /**
   * Issue #966 consolidation: the shared respawn metadata prelude used by both
   * `reconnectSession` and `branchSession`. Resolves session → claudeSessionId →
   * cwd (+ the #1778 cwd-gone probe when enabled) → machineId → agent → sessionTag,
   * returning either the resolved context or a structured error.
   *
   * Parameterized so both flows keep their exact pre-extraction behavior:
   *   - `rejectIfActive`  — reconnect refuses an already-active session (branch does not).
   *   - `sweepOrphans`    — reconnect fires the #1664 resume orphan sweep at ENTRY.
   *   - `checkCwdExists`  — reconnect runs the #1778 cwd-gone probe (returns
   *                          code `cwd_missing`); branch has no probe and no `code`
   *                          field, so this MUST stay reconnect-only (R4).
   */
  private async resolveRespawnContext(
    sessionId: string,
    opts: {
      logLabel: string;
      rejectIfActive: boolean;
      sweepOrphans: boolean;
      checkCwdExists: boolean;
    }
  ): Promise<RespawnContextResult> {
    // Get the existing session to extract its metadata
    const session = this.sessionCache.getSession(sessionId);
    if (!session) {
      return { ok: false, error: "Session not found" };
    }

    if (opts.rejectIfActive && session.active) {
      return { ok: false, error: "Session is already active" };
    }

    if (opts.sweepOrphans) {
      // Issue #1664 (epic #1662, Sub B): resume orphan sweep (R5). A session
      // killed mid-turn (#1661) left its turn row status='open'; orphan any
      // stale-open turn for THIS session that the current process is not actively
      // tracking. Placed at the reconnect ENTRY so the #1661 alive===true
      // re-attach early-return below cannot skip it (D4a). Fail-open: a
      // genuinely-open turn this process tracks is guarded out, and a late
      // finalize self-corrects a premature orphan (the UPDATE is keyed by
      // (hapi_session_id, seq), status-agnostic).
      this.getTurnLifecycle()?.sweepOrphans({ hapiSessionId: sessionId });
    }

    // Get the Claude session ID from metadata (needed for --resume)
    const claudeSessionId = session.metadata?.claudeSessionId;
    // Issue #1082 (ruling D5): the codex resume id, mirror of claudeSessionId.
    // Populated server-side by onSessionFound (codex/session.ts). The reconnect
    // path threads it into the respawn resume id for codex sessions.
    const codexSessionId = session.metadata?.codexSessionId;
    this.errorLogger?.debug(
      `${opts.logLabel} session ${sessionId}: claudeSessionId = ${claudeSessionId ?? "MISSING"}`,
      { category: "sync", sessionId }
    );

    // Get the working directory from metadata (stored as 'path')
    const cwd = session.metadata?.path;
    if (!cwd) {
      return {
        ok: false,
        error: "Session does not have a working directory",
      };
    }

    if (opts.checkCwdExists) {
      // #1778: PROACTIVE CWD-gone check (mirrors the #1364 archiveSession guard).
      //
      // If the session's working directory no longer exists on disk (e.g. an
      // external stale-worktree cleanup tool ran `git worktree remove`), the
      // respawn below can NEVER succeed — the daemon's RecoveryService detects the
      // missing cwd and marks the session "error", but on the FEDERATED path that
      // terminal failure was previously swallowed by a fire-and-forget call (the
      // reconnect spinner that never resolves). Detecting it here returns a
      // structured terminal error (code "cwd_missing") that BOTH the local route
      // (sessions.ts → 502) and the node-to-node federated endpoint
      // (sessionLifecycle.ts pre-check) surface to the client. This is purely
      // additive — it short-circuits a case that already failed terminally; the
      // spawn-fresh / fire-and-forget fallbacks below are untouched (Fallback
      // Preservation Rule). markOrphaned silences the inactivity watchdog's 5-min
      // archive spam, same as #1364.
      try {
        await fsAccess(cwd);
      } catch {
        this.sessionCache.markOrphaned(sessionId, "cwd-missing");
        this.errorLogger?.warn(
          `${opts.logLabel} refused for ${sessionId}: CWD ${cwd} no longer exists — terminal (cwd_missing)`,
          { category: "sync", sessionId, context: { cwd } }
        );
        return {
          ok: false,
          code: "cwd_missing",
          error: `Session working directory no longer exists: ${cwd}`,
        };
      }
    }

    // Get the machine ID from session metadata
    const machineId = session.metadata?.machineId;
    if (!machineId) {
      return { ok: false, error: "Session does not have a machine ID" };
    }

    // Get agent type (default to claude)
    const agent = session.metadata?.flavor ?? "claude";
    if (
      agent !== "claude" &&
      agent !== "codex" &&
      agent !== "gemini" &&
      agent !== "opencode"
    ) {
      return { ok: false, error: `Unsupported agent type: ${agent}` };
    }

    // Get the original session's tag from the database
    // This is critical: getOrCreateSession looks up by tag, not by id
    // So we must pass the same tag that was used when the session was created
    const sessionTag = this.sessionCache.getSessionTag(sessionId);

    return {
      ok: true,
      session,
      claudeSessionId,
      codexSessionId,
      cwd,
      machineId,
      agent,
      sessionTag,
    };
  }

  /**
   * Reconnect to an existing (disconnected) session by spawning a new process
   * with the --resume flag to continue the Claude conversation.
   */
  async reconnectSession(
    sessionId: string,
    // Issue #2301 (Task 4, R3): the route's abort signal (`c.req.raw.signal`), so a
    // client disconnect cancels the bounded wait-for-slot poll. Optional — a
    // federated / signal-less caller degrades to the deadline-only bound.
    signal?: AbortSignal
  ): Promise<
    | { type: "success"; newSessionId: string }
    | { type: "error"; message: string; code?: string }
  > {
    const ctx = await this.resolveRespawnContext(sessionId, {
      logLabel: "Reconnect",
      rejectIfActive: true,
      sweepOrphans: true,
      checkCwdExists: true,
    });
    if (!ctx.ok) {
      return { type: "error", message: ctx.error, code: ctx.code };
    }
    const { session, cwd, machineId, agent, sessionTag } = ctx;
    let claudeSessionId = ctx.claudeSessionId;
    // Issue #1082 (ruling D5): codex resume id. No stale-guard for codex — a
    // stale id simply fails findCodexResumeFile and codex starts fresh (#1082
    // R14: acceptable, no codex conversation-store validator is built).
    const codexSessionId = ctx.codexSessionId;

    this.errorLogger?.debug(
      `Reconnect session ${sessionId}: tag = ${sessionTag ?? "NULL"}`,
      { category: "sync", sessionId }
    );
    if (!sessionTag) {
      return {
        type: "error",
        message: "Session does not have a tag - cannot reuse",
      };
    }

    // ⚠️ ISSUE #1661 RE-ATTACH FAST PATH — DO NOT REMOVE
    //
    // BEFORE any respawn, ask the daemon whether this session's launcher wrapper
    // + tmux pane are actually alive. The web client offered "Reconnect" only
    // because the session was flagged active=false — but a loaded / long-silent-
    // turn tmux-launcher session routinely misses the 10s `expireInactive`
    // trip-wire while genuinely alive. Respawning it would `respawn-pane -k`
    // (SIGTERM 143) the in-flight Claude mid-turn → the stuck-"Thinking" zombie
    // this issue fixes.
    //
    //   - alive === true  → the wrapper is live and still relaying pane output
    //     via its FIFO; SSE is decoupled from respawn, so just re-mark the
    //     session active and return success WITHOUT spawning. The re-subscribing
    //     client resumes the in-flight stream. (R1)
    //   - alive === false → the daemon authoritatively reports it dead. Fall
    //     through to the spawn path with killLivePane:true — a dead session's
    //     pane usually holds a live `; exec bash` shell, so the pane MUST be
    //     respawn-killed. (R2)
    //   - alive === null  → liveness UNCERTAIN (RPC fault / daemon offline). Fall
    //     through with killLivePane:false — never force-kill a possibly-live pane
    //     on uncertainty; the daemon-side adapter does a fresh local re-check and
    //     re-attaches if alive, else respawns (Fallback Preservation Rule). (R2)
    //
    // SDK-launcher sessions are unaffected: they never go through the tmux
    // reused-window respawn, and a live SDK session is not flagged inactive in
    // the first place. (R6)
    const aliveness = await this.rpcGateway.isSessionAlive(
      machineId,
      sessionTag
    );
    if (aliveness === true) {
      this.sessionCache.reactivate(sessionId);
      this.errorLogger?.debug(
        `Reconnect session ${sessionId}: daemon reports wrapper+pane ALIVE — re-attaching (no respawn) (issue #1661)`,
        { category: "sync", sessionId }
      );
      // #2453 (Task 7): auto-resume this session's ledgered loops (the #1661
      // alive-fast-path IS a genuine reconnect success — reactivate, no spawn).
      void this.getLoopCronCoupler()?.onReconnect(sessionId);
      return { type: "success", newSessionId: sessionId };
    }
    // alive===false → killLivePane:true (respawn the dead/bash-occupied pane);
    // alive===null → killLivePane:false (uncertain — the daemon adapter re-checks
    // liveness before any kill, re-attaching if the wrapper is in fact alive).
    const killLivePane = aliveness === false;

    // ⚠️ CRITICAL FALLBACK — DO NOT REMOVE OR REPLACE WITH AN ERROR
    //
    // Reconnect must follow a two-tier pattern:
    //   1. Fast path: recover claudeSessionId via daemon RPC → --resume
    //   2. Slow path: if recovery fails, fall through and spawn fresh
    //      (no --resume) — the session continues in its existing tmux
    //      window, preserving HAPI identity but losing Claude history.
    //
    // Only if BOTH paths fail should reconnect return an error.
    //
    // History (do not un-learn these lessons):
    //   - #293 (Feb 2026) added the spawn-fresh fallback. Unmessaged
    //     sessions legitimately have no claudeSessionId anywhere — the
    //     fallback is the only way they can reconnect.
    //   - #370 (Mar 2026) added the RPC fast path but mistakenly
    //     REPLACED the fallback with a hard error when recovery missed.
    //   - #494 (Mar 2026) surfaced the regression: unmessaged sessions
    //     hit the hard error → 500 → spinner forever.
    //   - #1396 (May 2026) added a stale-ID guard for STALE-BUT-PRESENT
    //     claudeSessionIds (the gate below only handles ABSENT IDs).
    //     A stored UUID whose JSONL no longer exists in Claude Code's
    //     per-cwd conversation store crashed the SDK with "No conversation
    //     found with session ID: <uuid>" on stderr → exit code 1 → the
    //     wrapper emitted `exitType=crash` with no recovery path. The
    //     fix calls `hasClaudeConversation` BEFORE `--resume` and, on a
    //     definitive `false`, clears claudeSessionId so the existing
    //     spawn-fresh fall-through fires naturally.
    //
    //     IMPORTANT: the #1396 guard AUGMENTS the fast path (matches the
    //     "Fallback Preservation Rule" in CLAUDE.md). The check is
    //     null-tolerant: when RpcGateway returns null (RPC unavailable,
    //     daemon offline, malformed response) we PROCEED with --resume
    //     unchanged — same #370-class reasoning as above. DO NOT remove
    //     the null-tolerant branch: when validation is uncertain, prefer
    //     "try to resume" over "fail hard".
    //
    // See CLAUDE.md § "Fallback Preservation Rule" for the general
    // principle. If you're optimizing this path, AUGMENT the fast path;
    // do not delete the slow one.
    if (!claudeSessionId) {
      this.errorLogger?.debug(
        `Reconnect session ${sessionId}: attempting claudeSessionId recovery from daemon store`,
        { category: "sync", sessionId }
      );
      const recovered = await this.rpcGateway.getSessionClaudeId(
        machineId,
        sessionTag
      );
      if (recovered) {
        this.errorLogger?.debug(
          `Reconnect session ${sessionId}: recovered claudeSessionId = ${recovered}`,
          { category: "sync", sessionId }
        );
        claudeSessionId = recovered;
      } else {
        this.errorLogger?.warn(
          `Reconnect session ${sessionId}: claudeSessionId not found — will start fresh session (no --resume)`,
          { category: "sync", sessionId }
        );
        // ⚠️ DO NOT replace this fall-through with `return { type: "error", ... }`.
        // That was the #370 regression that broke unmessaged sessions (#494).
        // The session starts fresh in the existing tmux window, preserving
        // the HAPI session identity but without Claude conversation history.
      }
    }

    // Issue #1396: stale-claudeSessionId guard.
    //
    // The gate above only fires when claudeSessionId is ABSENT. A
    // stale-but-present ID — one that exists in Hapimatic's metadata but
    // whose JSONL no longer exists in Claude Code's per-cwd conversation
    // store — would otherwise be passed straight to `--resume` and crash
    // the SDK ("No conversation found with session ID: <uuid>"). Validate
    // the ID against the conversation store BEFORE invoking --resume.
    //
    // Null-tolerance: when the RPC returns null (daemon offline, malformed
    // response), we PROCEED with --resume unchanged — see the CRITICAL
    // block above for the #370/#494/#1396 rationale.
    if (claudeSessionId) {
      const exists = await this.rpcGateway.hasClaudeConversation(
        machineId,
        cwd,
        claudeSessionId
      );
      if (exists === false) {
        this.errorLogger?.warn(
          `Reconnect session ${sessionId}: claudeSessionId ${claudeSessionId} is stale (no conversation file in cwd) — clearing and spawning fresh (issue #1396)`,
          { category: "sync", sessionId }
        );
        claudeSessionId = undefined;
      } else if (exists === null) {
        this.errorLogger?.debug(
          `Reconnect session ${sessionId}: hasClaudeConversation returned null — proceeding with --resume ${claudeSessionId} (uncertain validation)`,
          { category: "sync", sessionId }
        );
      }
      // exists === true → proceed silently (no log noise on the happy path)
    }

    // Spawn a session that reuses the existing HAPI session.
    // If claudeSessionId is available, uses --resume for conversation continuity.
    // If not (e.g. session was disconnected before first message), starts fresh.
    //
    // Issue #1262: explicit `claimPort: true` preserves pre-gate behavior for
    // reconnect — if the spawn ends up creating a worktree, the port is
    // claimed at spawn-time just as before.
    const sessionName = session.metadata?.name;
    // Issue #1248: Reconnect must NEVER create a new worktree. The session
    // is being resumed in its existing tmux window using the same cwd.
    // Without this explicit "simple", the daemon defaults to "worktree"
    // (cli/src/daemon/run.ts:704, issue #1095) and createWorktree could
    // run against an already-managed worktree directory (the parent's cwd
    // when it lives inside an existing worktree). Same omission pattern
    // fixed for branchSession in #1238.
    const result = await spawnWithRetry(
      () =>
        this.spawnSession({
          machineId,
          directory: cwd,
          agent,
          // Round 11 (epic #3285): a SAVED permission posture
          // (metadata.permissionMode — stamped by the CLI on a live mode change, or
          // staged by the disconnected Session Configuration save) decides the
          // respawn's --yolo. Absent → the pre-existing always-bypass reconnect.
          yolo: session.metadata?.permissionMode
            ? isYoloEquivalentMode(session.metadata.permissionMode)
            : true,
          claimPort: true,
          // Issue #1082 (ruling D5): codex threads its own resume id (→ the
          // daemon's tmux path → buildCodexCommand --hapi-codex-resume →
          // findCodexResumeFile), NOT claudeSessionId (which codex never sets).
          resumeSessionId:
            agent === "codex"
              ? (codexSessionId ?? undefined)
              : (claudeSessionId ?? undefined),
          hapiSessionId: sessionTag,
          name: sessionName,
          sessionType: "simple",
          // Account-binding parity with switchAccount / tokenRefreshRestart: a
          // reconnect-style respawn MUST thread the session's bound account, or the
          // daemon spawns with no HAPI_ACCOUNT_UUID and the launcher applies no
          // per-account CLAUDE_CONFIG_DIR — silently reverting an account-bound
          // session to the host-default login (observed as rate-limited-account
          // drift after a user disconnect/reconnect). `undefined` => host-credential
          // session, handled by the daemon's `accountUuid && !shouldSkipBinding`
          // guard (cli/src/daemon/run.ts).
          accountUuid: session.metadata?.accountUuid,
          // Issue #4568 (R6): the same parity for an API-key binding — without it a
          // reconnect respawns the key session on the node-default subscription.
          apiKeyId: session.metadata?.apiKeyId,
          apiKeyMasked: session.metadata?.apiKeyMasked,
          // Issue #1633: preserve Safe Mode across the respawn.
          safeMode: session.metadata?.safeMode === true,
          // Issue #1660: preserve the per-session launcher across the respawn
          // (mirrors safeMode). metadata.launcherKind is the resolved kind frozen
          // at spawn by runClaude (#1613); undefined for legacy sessions → omitted.
          launcher: session.metadata?.launcherKind,
          // Issue #2155: preserve the role-scoped profile across the respawn
          // (mirrors safeMode/launcherKind) — else a respawn silently reverts to
          // the FULL stack (OR-4). Undefined for legacy/interactive sessions.
          sessionRole: session.metadata?.sessionRole,
          // Issue #2434: preserve the model pin across the reconnect respawn
          // (mirrors safeMode/launcherKind/sessionRole). This is the resume
          // boundary #2092 reports: without it, a pinned session that reconnects
          // after an idle gap silently comes back on the default model.
          modelMode: session.metadata?.modelMode,
          // Round 11 (epic #3285): thread the OTHER durable pins too. The CLI stamps
          // metadata.effort / metadata.rawModel on a live change (#2456) and the
          // disconnected Session Configuration save stages them, but reconnect only
          // re-sourced modelMode — a pinned effort or specific model silently
          // reverted on every reconnect.
          effort: session.metadata?.effort,
          rawModel: session.metadata?.rawModel,
          // Issue #1661: kill-vs-reattach intent for the reused-window path. true
          // when the daemon reported the session dead (respawn the bash-occupied
          // pane); false when liveness was uncertain (the daemon re-checks locally
          // and re-attaches a live wrapper rather than SIGTERM-killing it).
          killLivePane,
        }),
      {
        // #2301 (Task 4, R1/R3/R4): the reconnect session is ALREADY disconnected,
        // so the full poll-until-slot regime is safe (no disconnected-window concern
        // like the switch has). Shares the ONE deadline (D1) + the SAME probeCapacity
        // truth (OR-2). The #1661 re-attach fast path above short-circuits before this
        // (it needs no spawn), so it is untouched (Fallback Preservation Rule).
        capacityMode: "full",
        capacityDeadlineMs: ACCOUNT_SWITCH_SLOT_WAIT_DEADLINE_MS,
        signal,
        onWaitingForSlot: () =>
          this.eventPublisher.emit({
            type: "waiting-for-slot",
            sessionId,
            context: "reconnect",
            deadlineMs: ACCOUNT_SWITCH_SLOT_WAIT_DEADLINE_MS,
          }),
      }
    );

    if (result.type === "success") {
      // On reconnect, we return the SAME session ID since we're reusing it
      // #2453 (Task 7): auto-resume this session's ledgered loops (post-spawn
      // reconnect success). branchSession returns result.sessionId (a NEW id)
      // and is deliberately NOT hooked — a fork must not un-pause the parent.
      void this.getLoopCronCoupler()?.onReconnect(sessionId);
      return { type: "success", newSessionId: sessionId };
    }

    // Issue #1698 (G3-b, R4): if the reconnect respawn was refused by the
    // pre-spawn account-health gate in spawnSession (code account_unrefreshable),
    // emit the session-scoped account-unrefreshable event so the UI surfaces the
    // existing #1531 "re-login required" toast instead of looping back to an
    // offline respawn. A reconnect has a real sessionId (unlike a fresh create),
    // so the SSE event is the correct surface here. The healthy-account
    // start-fresh fallback above (#370/#494) is UNTOUCHED — the gate only fires
    // on unrefreshable===true, so a healthy account with a missing
    // claudeSessionId still falls through to start-fresh.
    if (result.code === "account_unrefreshable") {
      const accountUuid = session.metadata?.accountUuid;
      if (accountUuid) {
        this.eventPublisher.emit({
          type: "account-unrefreshable",
          sessionId,
          accountUuid,
        });
      }
      return { type: "error", message: result.message, code: result.code };
    }

    // Issue #2300 (Task 2, R2): preserve the spawn-result `code` on the generic
    // reconnect-failure return. The daemon capacity gate mints code "at_capacity"
    // (#1772) and it flows through syncEngine.spawnSession unchanged; dropping it
    // here (as before) forced the route's generic 500 and left the UI spinning.
    // account_unrefreshable keeps its dedicated branch above (the SSE re-login
    // event); every other code — at_capacity included — rides this return.
    return { type: "error", message: result.message, code: result.code };
  }

  /**
   * Branch a session: create a new session that inherits the full conversation
   * history from the parent session via Claude's --fork-session flag.
   *
   * Unlike reconnect (which reuses the same HAPI session), branching creates
   * a NEW HAPI session with a new tag and a new Claude session ID that has
   * the full conversation context copied from the parent.
   */
  async branchSession(
    sessionId: string,
    branchLabel?: string
  ): Promise<
    | { type: "success"; newSessionId: string }
    | { type: "error"; message: string }
  > {
    const ctx = await this.resolveRespawnContext(sessionId, {
      logLabel: "Branch",
      rejectIfActive: false,
      sweepOrphans: false,
      checkCwdExists: false,
    });
    if (!ctx.ok) {
      return { type: "error", message: ctx.error };
    }
    const { session, cwd, machineId, agent, sessionTag } = ctx;
    let claudeSessionId = ctx.claudeSessionId;

    // If claudeSessionId is missing from server metadata, attempt recovery
    if (!claudeSessionId && sessionTag) {
      this.errorLogger?.debug(
        `Branch session ${sessionId}: attempting claudeSessionId recovery from daemon store`,
        { category: "sync", sessionId }
      );
      const recovered = await this.rpcGateway.getSessionClaudeId(
        machineId,
        sessionTag
      );
      if (recovered) {
        claudeSessionId = recovered;
      }
    }

    if (!claudeSessionId) {
      return {
        type: "error",
        message:
          "Cannot branch session — Claude session ID not found. The original Claude process may have ended before reporting its session ID.",
      };
    }

    // Issue #1401: stale-claudeSessionId guard (companion to #1396).
    //
    // The hard-error gate above only fires when claudeSessionId is ABSENT. A
    // stale-but-present ID — one that exists in Hapimatic's metadata but whose
    // JSONL no longer exists in Claude Code's per-cwd conversation store —
    // would otherwise be passed straight to `--resume` and crash the SDK
    // ("No conversation found with session ID: <uuid>") → exit code 1 →
    // unrecoverable branched session.
    //
    // Recovery model DIFFERS from reconnect: reconnect can spawn-fresh (losing
    // Claude history but preserving HAPI identity), but branch CANNOT —
    // branching is a conversation-fork operation that requires the parent
    // conversation to exist. On a definitive `false`, return a clear error
    // message.
    //
    // Null-tolerance: when the RPC returns null (daemon offline, malformed
    // response), PROCEED with `--resume` unchanged — same #370/#494/#1396
    // principle: when state is uncertain, prefer "try to resume" over
    // "fail hard".
    if (claudeSessionId) {
      const exists = await this.rpcGateway.hasClaudeConversation(
        machineId,
        cwd,
        claudeSessionId
      );
      if (exists === false) {
        this.errorLogger?.warn(
          `Branch session ${sessionId}: claudeSessionId ${claudeSessionId} is stale (no conversation file in cwd) — cannot branch (issue #1401)`,
          { category: "sync", sessionId }
        );
        return {
          type: "error",
          message:
            "Cannot branch session — the parent Claude conversation no longer exists in Claude Code's store (the session ID is stale). Branching requires an existing parent conversation to fork from.",
        };
      } else if (exists === null) {
        this.errorLogger?.debug(
          `Branch session ${sessionId}: hasClaudeConversation returned null — proceeding with --resume ${claudeSessionId} (uncertain validation)`,
          { category: "sync", sessionId }
        );
      }
      // exists === true → proceed silently (no log noise on the happy path)
    }

    // Spawn a NEW session with --resume + --fork-session
    // Key difference from reconnect: do NOT pass hapiSessionId — let the daemon
    // generate a new tag, creating a brand new HAPI session
    //
    // Issue #1238: Branch must NEVER create a new worktree. The intent of
    // "branch conversation" is to fork conversation context, not filesystem
    // context — the child shares the parent's cwd byte-for-byte so it sees
    // the parent's exact uncommitted state. Without this explicit "simple",
    // the daemon defaults to "worktree" (cli/src/daemon/run.ts:704, issue
    // #1095) and createWorktree runs against the parent's cwd, producing
    // either a nested worktree (pre-#1219) or a sibling worktree (post-#1219)
    // — both wrong for branch.
    // Issue #1262: `claimPort: true` is a no-op for `sessionType: "simple"`
    // (the daemon's port-claim block only fires for "worktree") but the
    // explicit field documents intent and preserves call-site uniformity.
    //
    // Issue #1401: stale-claudeSessionId guard is now implemented above
    // (see "Issue #1401: stale-claudeSessionId guard" block).
    const result = await this.spawnSession({
      machineId,
      directory: cwd,
      agent,
      yolo: true,
      claimPort: true,
      resumeSessionId: claudeSessionId,
      name: branchLabel ?? undefined,
      forkSession: true,
      parentSessionId: sessionId,
      // #2479: stamp the discriminator so a branched child reads as "branch".
      // (The branch persistence itself is updateSessionBranchInfo below, which
      // also writes parent_relationship='branch'; this makes intent explicit and
      // lets the spawn choke point skip the branch — it only writes "spawn".)
      parentRelationship: "branch",
      sessionType: "simple",
      // Inherit the parent's bound account (same parity fix as
      // reconnectSession): a branched child must spawn under the parent's
      // account or it reverts to the host-default login. `undefined` =>
      // host-credential parent, handled by the daemon's
      // `accountUuid && !shouldSkipBinding` guard.
      accountUuid: session.metadata?.accountUuid,
      // Issue #4568 (R6): a branch of an API-key session bills the SAME key (the
      // daemon forces the SDK launcher for it); absent for a subscription parent.
      apiKeyId: session.metadata?.apiKeyId,
      apiKeyMasked: session.metadata?.apiKeyMasked,
    });

    if (result.type === "success") {
      // Update the new session's branch metadata
      try {
        await this.sessionCache.updateSessionBranchInfo(
          result.sessionId,
          sessionId,
          branchLabel ?? null
        );
      } catch (err) {
        // Non-fatal: session was spawned but branch metadata wasn't stored.
        // The session is still usable.
        this.errorLogger?.warn(
          `Branch session: spawned ${result.sessionId} but failed to store branch info: ${err}`,
          { category: "sync", sessionId }
        );
      }

      return { type: "success", newSessionId: result.sessionId };
    }

    return { type: "error", message: result.message };
  }
}
