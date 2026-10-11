// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session relaunch delegate (issue #2149) — the ONLY teardown+respawn path for
 * the spawn-frozen params that have no live-mutation plane: **launcher** and
 * **safeMode** (R3). It reuses the proven archive → respawn → rollback skeleton
 * (identical in shape to `SessionLifecycleOps.sessionConfigRestart` and
 * `AccountRestart.switchAccount`) and funnels through the universal `spawnSession`
 * choke point — honoring the issue's "no parallel respawn path" constraint by
 * DE-DUPLICATING (shared `buildRespawnBase` + the `spawnSession` facade), NOT by
 * hand-rolling teardown at the route layer (KD-1).
 *
 * KD-2 / R2: model / permission-mode / MCP / effort / rawModel are NOT relaunch
 * fields — they apply live via their own routes. This path is ONLY for launcher /
 * safeMode (R3), which are frozen at spawn (`session.metadata.launcherKind /
 * safeMode`). `archiveSession` + `spawnSession` are injected as SyncEngine facade
 * callbacks (mirrors AccountRestart) so test spies still apply.
 */
import type { ClaudeRemoteLauncherKind } from "@hapi/protocol/launcherResolver";
import type { SpawnSessionOptions } from "./syncEngine";
import type { SessionCache } from "./sessionCache";
import type { RpcGateway } from "./rpcGateway";
import type { TurnLifecycle } from "./turnLifecycle";
import type { ErrorLogger } from "../logging/errorLogger";
import { buildRespawnBase } from "./respawnBase";
import { gracefulTurnInterruptBeforeKill } from "./gracefulTurnInterrupt";

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

/** The v1 spawn-frozen overrides a relaunch can apply (R3). */
export type RelaunchOverrides = {
  launcher?: ClaudeRemoteLauncherKind;
  safeMode?: boolean;
};

export type RelaunchResult =
  | { type: "success" }
  | { type: "error"; message: string; code?: string };

export interface SessionRelaunchDeps {
  sessionCache: SessionCache;
  rpcGateway: RpcGateway;
  errorLogger?: ErrorLogger | null;
  /** The SyncEngine facade's archiveSession (clean kill, keeps the tmux window). */
  archiveSession: ArchiveSessionFn;
  /** The SyncEngine facade's spawnSession (universal spawn choke point). */
  spawnSession: SpawnSessionFn;
  /** Lazy read — TurnLifecycle is injected into SyncEngine post-construction. */
  getTurnLifecycle: () => TurnLifecycle | null;
}

export class SessionRelaunch {
  private readonly sessionCache: SessionCache;
  private readonly rpcGateway: RpcGateway;
  private readonly errorLogger?: ErrorLogger | null;
  private readonly archiveSession: ArchiveSessionFn;
  private readonly spawnSession: SpawnSessionFn;
  private readonly getTurnLifecycle: () => TurnLifecycle | null;

  constructor(deps: SessionRelaunchDeps) {
    this.sessionCache = deps.sessionCache;
    this.rpcGateway = deps.rpcGateway;
    this.errorLogger = deps.errorLogger ?? null;
    this.archiveSession = deps.archiveSession;
    this.spawnSession = deps.spawnSession;
    this.getTurnLifecycle = deps.getTurnLifecycle;
  }

  /**
   * #3087: thin delegate to the SHARED gracefulTurnInterruptBeforeKill free
   * function (extracted from the byte-identical AccountRestart copy). Passes the
   * "relaunch" log label; any failure is swallowed and the caller proceeds to the
   * hard kill (Fallback Preservation Rule).
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
      "relaunch"
    );
  }

  /**
   * Relaunch an ACTIVE session with new spawn-frozen params (launcher / safeMode)
   * via teardown + `--resume` respawn through the `spawnSession` choke point:
   *   validate → recover + stale-guard claudeSessionId → graceful interrupt →
   *   archive (keep the tmux window) → orphan-turn backstop → respawn with the
   *   override(s) → on failure, roll back to the PREVIOUS params (all-or-nothing).
   */
  async relaunchSession(
    sessionId: string,
    overrides: RelaunchOverrides
  ): Promise<RelaunchResult> {
    const session = this.sessionCache.getSession(sessionId);
    if (!session) {
      return { type: "error", message: "Session not found", code: "not_found" };
    }
    if (!session.active) {
      return {
        type: "error",
        message: "Session is not active",
        code: "not_active",
      };
    }

    const cwd = session.metadata?.path;
    const machineId = session.metadata?.machineId;
    const sessionTag = this.sessionCache.getSessionTag(sessionId);
    if (!cwd || !machineId || !sessionTag) {
      return {
        type: "error",
        message: "Session lacks path/machine/tag metadata — cannot relaunch",
        code: "missing_metadata",
      };
    }
    if ((session.metadata?.flavor ?? "claude") !== "claude") {
      return {
        type: "error",
        message: "Relaunch is Claude-only",
        code: "not_claude",
      };
    }
    // Issue #4568 (SF-3, D-4568-2 A): an API-key session runs on the SDK launcher
    // only. Refuse a non-SDK relaunch here, before any teardown, rather than let
    // the daemon force SDK (a daemon-log warning only) while the relaunch reports
    // success.
    if (
      session.metadata?.apiKeyId &&
      overrides.launcher !== undefined &&
      overrides.launcher !== "sdk"
    ) {
      return {
        type: "error",
        message: `API-key sessions run on the SDK launcher (requested: ${overrides.launcher})`,
        code: "api_key_launcher_unsupported",
      };
    }

    // claudeSessionId recovery + stale-id guard — the null-tolerant chain
    // switchAccount / sessionConfigRestart / reconnectSession use (#370/#494/#1396).
    let claudeSessionId = session.metadata?.claudeSessionId;
    if (!claudeSessionId) {
      const recovered = await this.rpcGateway.getSessionClaudeId(
        machineId,
        sessionTag
      );
      if (recovered) claudeSessionId = recovered;
    }
    if (claudeSessionId) {
      const exists = await this.rpcGateway.hasClaudeConversation(
        machineId,
        cwd,
        claudeSessionId
      );
      if (exists === false) claudeSessionId = undefined;
    }

    // R5: bounded graceful interrupt → clean kill (keeps the tmux window for the
    // same-tag respawn, #1581/#1585) → orphan-turn backstop (#2002).
    await this.gracefulTurnInterruptBeforeKill(sessionId);
    await this.archiveSession(sessionId, { isRespawn: true });
    this.getTurnLifecycle()?.orphanTrackedTurnsForSession(sessionId);

    const respawnBase = buildRespawnBase(session, {
      machineId,
      directory: cwd,
      sessionTag,
      claudeSessionId,
    });
    // Apply ONLY the requested spawn-frozen overrides; everything else preserved.
    // `?? base` (not `||`) so an explicit `safeMode: false` turns it OFF.
    const spawnResult = await this.spawnSession({
      ...respawnBase,
      launcher: overrides.launcher ?? respawnBase.launcher,
      safeMode: overrides.safeMode ?? respawnBase.safeMode,
    });
    if (spawnResult.type === "success") {
      return { type: "success" };
    }

    // R4 rollback: respawn with the PREVIOUS params (bare base) so the session
    // stays alive. Fallback Preservation Rule — mirrors sessionConfigRestart.
    this.errorLogger?.warn(
      `relaunchSession ${sessionId}: respawn with launcher=${
        overrides.launcher ?? respawnBase.launcher ?? "default"
      }, safeMode=${
        overrides.safeMode ?? respawnBase.safeMode
      } failed (${spawnResult.message}); rolling back to previous params`,
      { category: "sync", sessionId }
    );
    const rollback = await this.spawnSession(respawnBase);
    if (rollback.type === "success") {
      return {
        type: "error",
        message: `Relaunch failed (${spawnResult.message}); the session was restored on its previous parameters.`,
        code: "relaunch_failed_rolled_back",
      };
    }
    this.errorLogger?.error(
      `relaunchSession ${sessionId}: rollback respawn ALSO failed (${rollback.message}); session left disconnected (reconnectable)`,
      { category: "sync", sessionId }
    );
    return {
      type: "error",
      message: `Relaunch failed and rollback failed (${rollback.message}); the session is disconnected but can be reconnected.`,
      code: "relaunch_and_rollback_failed",
    };
  }
}
