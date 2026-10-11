// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session lifecycle-ops delegate (issue #2080 — extracted from syncEngine.ts).
 *
 * Owns three related session-lifecycle operations:
 *   - `archiveSession` — clean kill (disconnect the Claude process, keep the tmux
 *     window for reconnect); carries the #1364 CWD-gone short-circuit, the #1603
 *     terminal-archive remote-window reap, and #849 watchdog integration.
 *   - `applySessionConfig` — apply permission/model mode via RPC, with the #1633
 *     model-mode restart on the tmux/pty launchers.
 *   - `modelModeRestart` — restart a session so an explicit model-mode change
 *     reaches the claude child's argv (private; called only by applySessionConfig).
 * Refs #1364/#1443/#1603/#1628/#849/#1633/#1581/#1585/#1506/#370/#494/#1396.
 *
 * Behaviour-preserving move: bodies are byte-identical to the pre-extraction
 * `SyncEngine` methods; only the enclosing `this` changed. `handleSessionEnd`
 * (the session-end event router) and `spawnSession` (the universal spawn choke
 * point) stay `SyncEngine` facade methods and are injected here as lazy callbacks
 * so test spies on `engine.archiveSession` / `engine.rpcGateway.*` still apply.
 * `archiveSession` remains a public facade method (a thin delegator) because it
 * is called from many external sites (routes, scheduler, heartbeat, index.ts).
 */

import { access as fsAccess } from "node:fs/promises";
import type {
  EffortLevel,
  ModelMode,
  PermissionMode,
  Session,
} from "@hapi/protocol/types";
import type { SpawnSessionOptions } from "./syncEngine";
import type { SessionCache } from "./sessionCache";
import type { RpcGateway } from "./rpcGateway";
import type { ErrorLogger } from "../logging/errorLogger";

type SpawnSessionResult =
  | { type: "success"; sessionId: string; resolvedName?: string }
  | { type: "error"; message: string; code?: string };

type SpawnSessionFn = (
  opts: SpawnSessionOptions
) => Promise<SpawnSessionResult>;

type HandleSessionEndFn = (payload: {
  sid: string;
  time: number;
  archived?: boolean;
  /** #2453 (Task 7): true when this archive is part of a respawn (skip auto-pause). */
  respawn?: boolean;
}) => void;

export interface SessionLifecycleOpsDeps {
  sessionCache: SessionCache;
  rpcGateway: RpcGateway;
  errorLogger?: ErrorLogger | null;
  /** The SyncEngine facade's handleSessionEnd (session-end event router). */
  handleSessionEnd: HandleSessionEndFn;
  /** The SyncEngine facade's spawnSession (universal spawn choke point). */
  spawnSession: SpawnSessionFn;
}

export class SessionLifecycleOps {
  private readonly sessionCache: SessionCache;
  private readonly rpcGateway: RpcGateway;
  private readonly errorLogger?: ErrorLogger | null;
  private readonly handleSessionEnd: HandleSessionEndFn;
  private readonly spawnSession: SpawnSessionFn;

  constructor(deps: SessionLifecycleOpsDeps) {
    this.sessionCache = deps.sessionCache;
    this.rpcGateway = deps.rpcGateway;
    this.errorLogger = deps.errorLogger ?? null;
    this.handleSessionEnd = deps.handleSessionEnd;
    this.spawnSession = deps.spawnSession;
  }

  /**
   * Issue #2683: resilient killSession with error-SHAPE handling. Under spawn/reap
   * churn the common failure is `RPC handler not registered` / `RPC socket
   * disconnected` (the dying-pane race) — the session is ALREADY gone and the
   * kill is a no-op success, so those log at INFO with no retry (was WARN — the
   * reported journal noise). An ack-TIMEOUT is different: the handler acks
   * {success:true} optimistically BEFORE `void killThisHappy()`
   * (registerKillSessionHandler.ts), so a lost ack is safe to retry ONCE (a retry
   * either resolves fast to the already-gone case or confirms a genuine hang). A
   * persistent post-retry failure is surfaced at WARN, not swallowed. Never
   * throws — archiveSession always proceeds to handleSessionEnd.
   *
   * NOTE: this fixes the RPC journal NOISE + reliability, NOT the window leak —
   * the leak is fixed by the daemon's orphan reconciliation reaper (a failed
   * cleanup-tmux-session delete leaks window A regardless of killSession, #2683
   * finding 6). A blanket retry is deliberately avoided (#2683 finding 5):
   * retrying the terminal disconnect classes just stretches the awaited archive
   * paths — switchAccount / tokenRefreshRestart — under exactly the churn.
   */
  private async killSessionResilient(sessionId: string): Promise<void> {
    const MAX_TIMEOUT_RETRIES = 1;
    for (let attempt = 0; attempt <= MAX_TIMEOUT_RETRIES; attempt++) {
      try {
        await this.rpcGateway.killSession(sessionId);
        return;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // Terminal: the session process is already gone — the kill is a no-op.
        if (/RPC handler not registered|RPC socket disconnected/i.test(msg)) {
          this.errorLogger?.info(
            `[SyncEngine] killSession: session ${sessionId} already gone — ${msg}`,
            { category: "sync-archive-session", context: { sessionId } }
          );
          return;
        }
        // Ack timeout / transient: retry once (idempotent) before surfacing.
        if (attempt < MAX_TIMEOUT_RETRIES) continue;
        if (this.errorLogger) {
          this.errorLogger.warn(
            `[SyncEngine] killSession RPC failed for ${sessionId} after ${MAX_TIMEOUT_RETRIES} retry`,
            {
              category: "sync-archive-session",
              stack: error instanceof Error ? error.stack : null,
              context: { sessionId },
            }
          );
        } else {
          console.warn(
            `[SyncEngine] killSession RPC failed for ${sessionId} after ${MAX_TIMEOUT_RETRIES} retry:`,
            msg
          );
        }
        return;
      }
    }
  }

  async archiveSession(
    sessionId: string,
    opts?: {
      reapRemoteWindow?: boolean;
      isRespawn?: boolean;
      /**
       * #2683: this is a DELIBERATE archive-for-reconnect of a LIVE session
       * (e.g. the manual UI archive) — tag window A `@hapi_archive` so the
       * daemon's orphan reconciliation reaper preserves it. Do NOT set this for
       * terminal/watchdog archives of already-dead sessions (that would tag a
       * death-orphan and make the reaper preserve the leak — #2683 finding 2).
       */
      preserveForReconnect?: boolean;
    }
  ): Promise<void> {
    // #1364: PROACTIVE CWD-gone check.
    //
    // killSession's RPC handler always returns {success: true} after a fire-
    // and-forget (cli/src/claude/registerKillSessionHandler.ts), so the catch
    // block below would never observe a CWD-gone error string. The actual
    // unrecoverable-session pattern is: session B's worktree was destroyed by
    // session A's cleanupWorktreeAndBranch, B's reconnect path 500s, B goes
    // inactive, watchdog fires onForceKill → archiveSession every 5 min
    // forever. Detect the CWD-gone condition directly via fs.access and mark
    // the session orphaned so the watchdog skips it (Issue #849 watchdog +
    // #1364 orphaned state). Mirrors the pattern at
    // cli/src/recovery/RecoveryService.ts:222-235 (#956).
    const session = this.sessionCache.getSession(sessionId);
    const worktreePath =
      session?.metadata?.worktree?.worktreePath ?? session?.metadata?.path;
    if (worktreePath) {
      try {
        await fsAccess(worktreePath);
      } catch {
        // CWD is gone — short-circuit. Mark orphaned and skip the
        // killSession RPC (the CLI is unrecoverable). The session record
        // stays in cache until explicit deleteSession.
        this.sessionCache.markOrphaned(sessionId, "cwd-missing");
        this.errorLogger?.warn(
          `Session ${sessionId} marked orphaned: CWD ${worktreePath} no longer exists`,
          {
            category: "sync-archive-session",
            sessionId,
            context: { worktreePath },
          }
        );
        // #1443: complete the session-end transition (flip active:false) even
        // though we skip the killSession RPC. Without this the cached session
        // stays active:true forever, so the UI archive silently no-ops AND the
        // delete gates refuse with 409 — the session becomes un-archivable AND
        // un-deletable. handleSessionEnd is safe in the CWD-gone state: it does
        // no fsAccess and makes no tmux-window assumptions; it only mutates
        // in-memory state, optionally persists accumulated thinking time, and
        // emits a session-updated SSE event. Mirrors the success path below.
        this.handleSessionEnd({
          sid: sessionId,
          time: Date.now(),
          archived: true,
          respawn: opts?.isRespawn,
        });
        return;
      }
    }

    // #2683: for a DELIBERATE archive-for-reconnect of a LIVE session, tag
    // window A (`@hapi_archive`) BEFORE killSession so the daemon's orphan
    // reconciliation reaper preserves it once the pane becomes an idle shell.
    // Written pre-kill (Claude still alive, pane has children) so the tag is in
    // place before the window is ever eligible for reaping. Best-effort: a tag
    // failure degrades to reap-on-reconnect (bounded — the reconnect respawns
    // fresh via --resume; it can NOT kill a live Claude). Terminal/watchdog
    // archives of dead sessions never set preserveForReconnect (#2683 finding 2).
    if (opts?.preserveForReconnect) {
      const machineId = session?.metadata?.machineId;
      // #2245 [2245-2]: the daemon's setArchiveTag handler resolves the window
      // via the CLI persisted store keyed by TAG (sessionStore: s.hapiSessionId
      // === arg), NOT the server UUID. #2683 shipped this call with `sessionId`
      // (the server UUID), so the lookup ALWAYS missed → `@hapi_archive` was never
      // written → the deliberately-preserved window was untagged → restart
      // recovery resurrected it (the #2245 bug). Resolve the tag first, exactly
      // as the sibling reapRemoteWindow call (below) and renameTmuxWindow already
      // do. UN-inerting the tag write is what makes the #2245 recovery guard
      // effective — they land together (S-2).
      const sessionTag = this.sessionCache.getSessionTag(sessionId);
      if (machineId && sessionTag) {
        try {
          await this.rpcGateway.setArchiveTag(machineId, sessionTag);
        } catch (error) {
          this.errorLogger?.info(
            `[SyncEngine] #2683 setArchiveTag failed for ${sessionId} (non-fatal)`,
            {
              category: "sync-archive-session",
              stack: error instanceof Error ? error.stack : null,
              context: { sessionId },
            }
          );
        }
      }
    }

    // #2683: error-SHAPE handling + bounded retry (was a bare try/catch that
    // logged EVERY killSession failure at WARN — the churn journal noise).
    await this.killSessionResilient(sessionId);
    this.handleSessionEnd({
      sid: sessionId,
      time: Date.now(),
      archived: true,
      respawn: opts?.isRespawn,
    });

    // NOTE: We intentionally do NOT clean up the session's *daemon* tmux
    // window (window A) here. Archive = disconnect the Claude process but
    // keep the window alive so the user can reconnect later. Only
    // deleteSession() should destroy that window.
    //
    // #1603: BUT under HAPI_CLAUDE_LAUNCHER=tmux the real `claude` runs in a
    // SEPARATE `hapimatic-remote` window (window B) that the fire-and-forget
    // killSession above does NOT reap (it kills only the `hapi claude`
    // wrapper's process tree; window B's claude is parented by the tmux
    // server). For TERMINAL archives (idle/manual archive, scheduler reaper,
    // watchdog force-kill, federation peer-archive, CLI-disconnect-grace) the
    // caller passes { reapRemoteWindow: true } so window B + its live claude
    // are reaped now (reuses #1600's reapRemoteLauncherWindows via a daemon
    // RPC). Heartbeat rotation (#1627) also passes the flag — a third,
    // FRESH-TAG rotation class: rotate() respawns under a brand-new tag (no
    // hapiSessionId, no --resume), so reaping the OLD tag cannot match the
    // new session's window B (see heartbeat/sessionManager.ts rotate()).
    // RESPAWN archives (switchAccount / tokenRefreshRestart) intentionally
    // DO NOT set this — they rely on the fire-and-forget kill racing a same-tag
    // respawn (claudeTmuxRemote.createOrReplaceRemoteWindow, #1581/#1585), and
    // reaping by tag would race-kill the recreated window. The #1364 CWD-gone
    // branch above returns early, so a missing-CWD archive skips this reap.
    // Best-effort: a reap failure never fails the archive.
    if (opts?.reapRemoteWindow) {
      const machineId = session?.metadata?.machineId;
      const sessionTag = this.sessionCache.getSessionTag(sessionId);
      if (machineId && sessionTag) {
        try {
          // #1628: sessionId (the server UUID — embedded in the remote
          // window's NAME) enables the daemon's direct exact-name reap on
          // tmux-3.4 nodes where list-windows enumeration is blind. Covers
          // the #1627 heartbeat-rotation class safely too: rotation spawns a
          // NEW session row (new UUID), so an old-UUID exact-name kill cannot
          // race the freshly-rotated window.
          const reap = await this.rpcGateway.reapRemoteWindow(
            machineId,
            sessionTag,
            sessionId
          );
          this.errorLogger?.info(
            `#1603 terminal-archive remote-window reap for ${sessionId} (tag: ${sessionTag}): ${
              reap.success
                ? `reaped ${reap.reaped ?? 0}`
                : (reap.errorKind ?? "failed")
            }`,
            {
              category: "sync-archive-session",
              sessionId,
              context: { sessionTag },
            }
          );
        } catch (error) {
          // Best-effort — a reap failure must never fail the archive.
          this.errorLogger?.warn(
            `#1603 remote-window reap RPC threw for ${sessionId}`,
            {
              category: "sync-archive-session",
              stack: error instanceof Error ? error.stack : null,
              context: { sessionId },
            }
          );
        }
      }
    }
  }

  /**
   * Round 11 (epic #3285, 2026-09-07): SAVE a configuration change for a
   * DISCONNECTED session. There is no CLI to ask, so the change is written to
   * the session's durable metadata pins — the same `modelMode` / `rawModel` /
   * `effort` pins the CLI stamps on a live change (#2434 / #2456), plus the
   * `permissionMode` pin — and mirrored onto the live record so the header and
   * composer reflect it immediately. `reconnectSession` re-sources every pin
   * into the respawn, so the saved configuration applies automatically when
   * the session comes back. The CLI-stamp clobber race that forbids server-side
   * pin writes on a LIVE session (#2434) cannot occur while the process is dead.
   */
  private async stageSessionConfig(
    sessionId: string,
    config: {
      permissionMode?: PermissionMode;
      modelMode?: ModelMode;
      effort?: EffortLevel;
      rawModel?: string;
    }
  ): Promise<void> {
    const ok = await this.sessionCache.updateSessionMetadataFields(
      sessionId,
      current => {
        const next = { ...current };
        if (config.modelMode !== undefined) {
          // Mirrors the CLI stamp: "default" CLEARS the pin; a family pin
          // supersedes a specific raw id (the two never both persist).
          if (config.modelMode === "default") {
            delete next.modelMode;
          } else {
            next.modelMode = config.modelMode;
            delete next.rawModel;
          }
        }
        if (config.rawModel !== undefined) {
          if (config.rawModel) {
            next.rawModel = config.rawModel;
            delete next.modelMode;
          } else {
            delete next.rawModel;
          }
        }
        if (config.effort !== undefined) {
          if (config.effort) {
            next.effort = config.effort;
          } else {
            delete next.effort;
          }
        }
        if (config.permissionMode !== undefined) {
          next.permissionMode = config.permissionMode;
        }
        return next;
      }
    );
    if (!ok) {
      throw new Error(
        "Failed to save the configuration for the disconnected session"
      );
    }
    this.sessionCache.applySessionConfig(sessionId, config);
  }

  async applySessionConfig(
    sessionId: string,
    config: {
      permissionMode?: PermissionMode;
      modelMode?: ModelMode;
      effort?: EffortLevel;
      rawModel?: string;
    }
  ): Promise<{ method: "sdk" | "config" }> {
    // Round 11 (epic #3285): a disconnected session STAGES the change instead
    // of failing — see stageSessionConfig. Live sessions take the RPC path.
    const target = this.sessionCache.getSession(sessionId);
    if (target && !target.active) {
      await this.stageSessionConfig(sessionId, config);
      // Issue #3769 (Task 1d): a staged (disconnected) session has no live query
      // — the pick applies on respawn, so the method is "config".
      return { method: "config" };
    }
    const result = await this.rpcGateway.requestSessionConfig(
      sessionId,
      config
    );
    if (!result || typeof result !== "object") {
      throw new Error("Invalid response from session config RPC");
    }
    const obj = result as {
      applied?: {
        permissionMode?: Session["permissionMode"];
        modelMode?: Session["modelMode"];
        effort?: Session["effort"];
        rawModel?: Session["rawModel"];
      };
      // Issue #3769 (Task 1d): the CLI set-session-config handler reports whether
      // a model change reached the live SDK query ("sdk") or only the durable pin
      // ("config"). Additive — an old CLI omits it → treated as "config".
      method?: "sdk" | "config";
    };
    const applied = obj.applied;
    if (!applied || typeof applied !== "object") {
      throw new Error("Missing applied session config");
    }
    const method: "sdk" | "config" = obj.method === "sdk" ? "sdk" : "config";

    this.sessionCache.applySessionConfig(sessionId, applied);

    // Issue #1633: on the tmux/pty launchers a model-mode change cannot reach
    // the RUNNING claude child — the model is fixed at spawn argv, and the
    // set-session-config RPC above only updates loop state + display
    // metadata. Restart the session (switchAccount-style respawn with
    // --resume) so resolveSpawnClaudeArgs threads the explicit selection onto
    // the child's argv. The SDK launcher needs no restart — it respawns its
    // query on the next message via the mode-hash change. Legacy sessions
    // without launcherKind metadata (#1613) keep the pre-#1633 display-only
    // behavior (conservative: never kill a session we can't classify).
    // Issue #2456: an effort or specific raw-model change needs the SAME
    // tmux/pty respawn as a modelMode change — the effort/model is fixed at spawn
    // argv, so set-session-config alone only updates loop state on the SDK
    // launcher. The SDK launcher still re-queries on the next message (no restart).
    if (
      config.modelMode !== undefined ||
      config.effort !== undefined ||
      config.rawModel !== undefined
    ) {
      const launcherKind =
        this.sessionCache.getSession(sessionId)?.metadata?.launcherKind;
      if (launcherKind === "tmux" || launcherKind === "pty") {
        const restart = await this.sessionConfigRestart(sessionId, config);
        if (restart.type === "error") {
          throw new Error(
            `Session config applied, but restarting the session to activate it failed: ${restart.message}`
          );
        }
      }

      // Issue #2434: the DURABLE `metadata.modelMode` write for a mid-session
      // change ("last manual selection wins") is made CLI-side, in runClaude's
      // `set-session-config` handler — which the `requestSessionConfig` RPC
      // above just invoked. It is NOT written here, because `updateMetadata`
      // rebuilds the blob from the CLI process's locally cached metadata, so a
      // server-side write would be clobbered by the CLI's next stamp (measured
      // during #2434 verification). Keeping a single writer removes the race.
    }

    // Issue #3769 (Task 1d): surface the live-apply method the CLI reported. For
    // a tmux/pty session this is "config" (no live query) and the respawn above
    // applied the pick; for an SDK session it is "sdk" when the live switch fired.
    return { method };
  }

  /**
   * Issue #1633 / #2456: restart a session so an explicit model-mode, reasoning-
   * effort, or specific raw-model change reaches the claude child's argv (tmux/pty
   * launchers only — see the caller gate in applySessionConfig). Mechanism mirrors
   * switchAccount(): archiveSession (clean kill, keeps the tmux window) →
   * spawnSession with --resume + the same session tag + the changed field(s)
   * threaded daemon-ward as --hapi-model-mode / --hapi-effort / --hapi-raw-model,
   * which runClaude seeds its state from and the launcher turns into --model /
   * --effort argv. Safe Mode (#1633) and the account binding are preserved from
   * session metadata. Fields NOT present in `config` are preserved from metadata;
   * modelMode and rawModel are mutually exclusive (a family pick clears a specific
   * pin and vice-versa). On respawn failure, rolls back to a respawn with the
   * session's PREVIOUS state so the session stays alive.
   */
  private async sessionConfigRestart(
    sessionId: string,
    config: {
      modelMode?: ModelMode;
      effort?: EffortLevel;
      rawModel?: string;
    }
  ): Promise<{ type: "success" } | { type: "error"; message: string }> {
    const session = this.sessionCache.getSession(sessionId);
    if (!session) {
      return { type: "error", message: "Session not found" };
    }
    if (!session.active) {
      return { type: "error", message: "Session is not active" };
    }
    const cwd = session.metadata?.path;
    const machineId = session.metadata?.machineId;
    const sessionTag = this.sessionCache.getSessionTag(sessionId);
    if (!cwd || !machineId || !sessionTag) {
      return {
        type: "error",
        message: "Session lacks path/machine/tag metadata — cannot restart",
      };
    }
    if ((session.metadata?.flavor ?? "claude") !== "claude") {
      return { type: "error", message: "Model restart is Claude-only" };
    }
    const agent = "claude" as const;
    const sessionName = session.metadata?.name;

    // claudeSessionId recovery + stale-id guard — the same null-tolerant
    // chain switchAccount/reconnectSession use (#370/#494/#1396).
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

    // Clean kill (keeps the tmux window for same-tag respawn, #1581/#1585).
    // #2453 (Task 7): a respawn — must NOT auto-pause the session's loops (it
    // respawns under the same uuid and never reaches reconnectSession).
    await this.archiveSession(sessionId, { isRespawn: true });

    const respawnBase = {
      machineId,
      directory: cwd,
      agent,
      yolo: true,
      claimPort: true,
      resumeSessionId: claudeSessionId ?? undefined,
      hapiSessionId: sessionTag,
      name: sessionName,
      sessionType: "simple" as const,
      accountUuid: session.metadata?.accountUuid,
      // Issue #4568 (R6): preserve an API-key binding across the config restart
      // (mirrors buildRespawnBase — this list is the inline holdout).
      apiKeyId: session.metadata?.apiKeyId,
      apiKeyMasked: session.metadata?.apiKeyMasked,
      // Issue #1633: preserve Safe Mode across the restart.
      safeMode: session.metadata?.safeMode === true,
      // Issue #1660: preserve the per-session launcher across the respawn
      // (mirrors safeMode). metadata.launcherKind is the resolved kind frozen
      // at spawn by runClaude (#1613); undefined for legacy sessions → omitted.
      launcher: session.metadata?.launcherKind,
      // Issue #2155: preserve the role-scoped profile across the respawn
      // (mirrors safeMode/launcherKind) — else a respawn silently reverts to
      // the FULL stack (OR-4). Undefined for legacy/interactive sessions.
      sessionRole: session.metadata?.sessionRole,
      // Issue #2626: preserve the per-session output style across the respawn
      // (mirrors sessionRole) — else a respawn reverts to the machine default.
      // Undefined for legacy/default-style sessions → omitted.
      outputStyle: session.metadata?.outputStyle,
      // Issue #2434: preserve the model pin across the respawn (mirrors
      // safeMode/launcherKind/sessionRole). Load-bearing for the ROLLBACK
      // spawn below, which uses `respawnBase` bare: without this it would
      // respawn unpinned instead of restoring the session's previous model.
      // The primary spawn overrides this field with the requested mode (see
      // the spread below), so the explicit change still wins there.
      modelMode: session.metadata?.modelMode,
      // Issue #2456: preserve the effort + raw-model pins across the respawn.
      // The rollback spawn uses respawnBase bare (previous state); the primary
      // spawn overrides these with the requested change (see the spread below).
      effort: session.metadata?.effort,
      rawModel: session.metadata?.rawModel,
      // Issue #1555: return on child-start, not full cold-MCP boot.
      awaitWebhook: false,
    };

    // Issue #2456: compute the respawn's model axis + effort, applying the
    // requested change(s) over the metadata baseline. modelMode and rawModel are
    // mutually exclusive — a family pick clears any specific pin, and a specific
    // "More models" pin clears the family mode.
    let nextModelMode = session.metadata?.modelMode;
    let nextRawModel = session.metadata?.rawModel;
    if (config.modelMode !== undefined) {
      // "default" restarts WITHOUT the flag — the session then follows the
      // normal default-mode resolution (#1506 entitled pin / native default).
      nextModelMode =
        config.modelMode === "default" ? undefined : config.modelMode;
      nextRawModel = undefined;
    }
    if (config.rawModel !== undefined) {
      nextRawModel = config.rawModel.length > 0 ? config.rawModel : undefined;
      nextModelMode = undefined;
    }
    const nextEffort =
      config.effort !== undefined ? config.effort : session.metadata?.effort;

    const spawnResult = await this.spawnSession({
      ...respawnBase,
      modelMode: nextModelMode,
      effort: nextEffort,
      rawModel: nextRawModel,
    });
    if (spawnResult.type === "success") {
      return { type: "success" };
    }

    // Rollback: respawn without the model change so the session stays alive.
    this.errorLogger?.warn(
      `sessionConfigRestart ${sessionId}: respawn with modelMode=${nextModelMode ?? "default"}, rawModel=${nextRawModel ?? "none"}, effort=${nextEffort ?? "none"} failed (${spawnResult.message}); rolling back to previous config`,
      { category: "sync", sessionId }
    );
    const rollback = await this.spawnSession(respawnBase);
    if (rollback.type === "success") {
      return {
        type: "error",
        message: `Model restart failed (${spawnResult.message}); the session was restored on its previous model.`,
      };
    }
    this.errorLogger?.error(
      `sessionConfigRestart ${sessionId}: rollback respawn ALSO failed (${rollback.message}); session left disconnected (reconnectable)`,
      { category: "sync", sessionId }
    );
    return {
      type: "error",
      message: `Model restart failed and rollback failed (${rollback.message}); the session is disconnected but can be reconnected.`,
    };
  }
}
