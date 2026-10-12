// SPDX-License-Identifier: MIT
/**
 * `healthScheduler` — the daemon's heartbeat / maintenance loop, extracted from
 * `run.ts`'s `startDaemon` closure (issue #2081, Epic #2077 Sub-Issue D).
 *
 * Owns the `maintenanceTick` body (stale-session prune, dead-pane/orphan-MCP
 * reaping, stale-socket cleanup, MCP status poll, rotation-lease heartbeat,
 * idle-refresh backstop, version check) + its MCP-poll failure/backoff state,
 * and builds + starts the `daemon-maintenance` `SupervisedLoop`.
 * `createHealthScheduler(ctx, clockSeams)` reads the shared state it needs from
 * the injected {@link DaemonContext}, threads the #2079 {@link ClockSeams} into
 * the loop, and RETURNS the constructed `maintenanceLoop` so `run.ts` can wire
 * it into the `onReady` handles and stop it in `cleanupAndShutdown`. Body moved
 * VERBATIM (referee'd by `run.test.ts`, the #2079 suite) — the only edit is
 * `testSeams.` → `clockSeams.` at the loop's three clock fields.
 *
 * The `daemonJobWatchdog` loop stays in `run.ts` (it also consumes the seams and
 * is assembled into the same `onReady` handles; #2081 KD4).
 */
import { logger } from "@/ui/logger";
import { configuration } from "@/configuration";
import packageJson from "../../package.json";
import { type DaemonLocallyPersistedState } from "@/persistence";
import { SupervisedLoop } from "@hapi/protocol";
import { isProcessAlive } from "@/utils/process";
import { getInstalledCliMtimeMs } from "./controlClient";
import { pollMcpStatus } from "./mcpStatusPoller";
import { dirsNeedingProjectPoll } from "./mcpPollStrategy";
import {
  decideOrphanAction,
  type OrphanCheckResult,
  type OrphanIdCheckResult,
  type OrphanDecision,
} from "./orphanCheckDecision";
import {
  reapOrphanMcpProcesses,
  type OrphanMcpDebounce,
} from "./orphanMcpReaper";
import { sweepStaleSockets } from "./staleSocketSweep";
import { isTmuxPersistenceEnabled } from "./recoveryIntegration";
import {
  detectTmuxNameChanges,
  reapDeadPaneWindow,
  reconcileOrphanWindows,
} from "./tmuxSpawnAdapter";
import { rotationLeaseManager } from "@/accounts/rotationLeaseManager";
import { TmuxManager } from "@/tmux";
import {
  describeOwnershipFailure,
  resolveOwnedWindow,
} from "@/tmux/windowOwnership";
import type { DaemonContext, ClockSeams } from "./daemonContext";

/**
 * Build + start the daemon-maintenance `SupervisedLoop` bound to `ctx`. Call
 * once during daemon init after `api` / `tokenRefreshService` / the job registry
 * exist in `ctx`; the returned `maintenanceLoop` is wired into the `onReady`
 * handles and stopped by `cleanupAndShutdown`.
 */
export function createHealthScheduler(
  ctx: DaemonContext,
  clockSeams: ClockSeams
): { maintenanceLoop: SupervisedLoop } {
  const {
    api,
    tokenRefreshService,
    pidToTrackedSession,
    shellPidToTrackedSession,
    controlToken,
    daemonJobNode,
    daemonJobRegistry,
    controlPort,
    startedWithCliMtimeMs,
    fileState,
    isShutdownRequested,
    ownStateWriter,
  } = ctx;

  const heartbeatIntervalMs = parseInt(
    process.env.HAPI_DAEMON_HEARTBEAT_INTERVAL || "60000"
  );
  let mcpPollCounter = 0;
  let mcpPollInProgress = false;
  // Issue #1069: default raised from 5 (5 min) to 30 (30 min) to reduce
  // stdio MCP server respawn churn. Combined with the two-phase polling
  // change below, this drops serena spawn rate from ~1500/day to ~50/day.
  // Issue #1214: default raised again from 30 (30 min) to 60 (60 min) to
  // reduce idle-baseline CPU on resource-constrained hosts (Pi 5).
  // Override with HAPI_MCP_POLL_INTERVAL_HEARTBEATS for fresher status.
  const MCP_POLL_EVERY_N_HEARTBEATS = parseInt(
    process.env.HAPI_MCP_POLL_INTERVAL_HEARTBEATS || "60",
    10
  );
  // Hardening (#1078 follow-up): per-project consecutive-failure tracking.
  // A repeatedly-failing poll for one project (e.g. corrupt .mcp.json) used
  // to be logged at debug only; the modal stayed stale forever and the user
  // never learned why. Now we escalate to error_logs once after N consecutive
  // failures so the failure surfaces. Counter resets on next successful poll.
  const MCP_POLL_FAILURE_GLOBAL_KEY = "__global__";
  const MCP_POLL_ESCALATE_AFTER = parseInt(
    process.env.HAPI_MCP_POLL_ESCALATE_AFTER || "3",
    10
  );
  // Fix C2 (silent-failure-hunter review of v1.0.373 merge): re-fire
  // escalation every BACKOFF failures beyond the initial threshold so
  // a persistently broken poller stays visible in Sentry. Strict
  // equality (next === MCP_POLL_ESCALATE_AFTER) had us emit exactly
  // once at #3 and then go silent forever even if failures continued
  // for hours.
  const MCP_POLL_ESCALATE_BACKOFF = parseInt(
    process.env.HAPI_MCP_POLL_ESCALATE_BACKOFF || "10",
    10
  );
  const mcpPollFailureCounts = new Map<string, number>();
  // Issue #2683: per-window consecutive death-orphan observation count for the
  // orphan reconciliation reaper's debounce (see reconcileOrphanWindows). Held
  // in the closure so it persists across maintenance-loop ticks.
  const orphanReapDebounce = new Map<number, number>(); // #3734: keyed by window index
  // Issue #4065: consecutive-tick observations for the orphan-MCP reaper, keyed
  // by pid and pinned by /proc starttime (PID-reuse guard). Held in the closure
  // so it persists across maintenance-loop ticks.
  const orphanMcpReapDebounce: OrphanMcpDebounce = new Map();
  const recordMcpPollSuccess = (key: string): void => {
    mcpPollFailureCounts.delete(key);
  };
  const recordMcpPollFailure = (key: string, err: unknown): void => {
    const next = (mcpPollFailureCounts.get(key) ?? 0) + 1;
    mcpPollFailureCounts.set(key, next);
    // Fires at: #3 (overshoot=0), #13 (overshoot=10), #23, #33, ...
    const overshoot = next - MCP_POLL_ESCALATE_AFTER;
    if (overshoot >= 0 && overshoot % MCP_POLL_ESCALATE_BACKOFF === 0) {
      logger.reportError({
        message:
          key === MCP_POLL_FAILURE_GLOBAL_KEY
            ? `MCP global poll failed ${next} times in a row`
            : `MCP poll failed ${next} times in a row for project ${key}`,
        category: "mcp-poll-failure",
        severity: "warn",
        context: JSON.stringify({
          scope: key === MCP_POLL_FAILURE_GLOBAL_KEY ? "global" : "project",
          projectDir: key === MCP_POLL_FAILURE_GLOBAL_KEY ? null : key,
          consecutiveFailures: next,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : null,
        }),
      });
    }
  };
  // #1964 (Sub-D): the daemon-maintenance loop runs under a SupervisedLoop —
  // its generation guard replaces the former heartbeatRunning reentrancy flag,
  // and it self-heals + reports status into the daemon job registry (visible in
  // the System Jobs portal). The maintenance body below is unchanged.
  const maintenanceTick = async () => {
    try {
      // Issue #4155 (R3/R4): a daemon that is shutting down, or that another LIVE
      // daemon has replaced, does no maintenance. Its tracked-session and
      // in-flight-spawn state no longer describes this HAPI_HOME, so the reaper,
      // the tmux-socket sweep and the heartbeat must not act on it.
      if (isShutdownRequested()) return;
      if (!ownStateWriter.stillOwner()) return;

      if (process.env.DEBUG) {
        logger.debug(
          `[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`
        );
      }

      // Prune stale sessions (process no longer alive)
      for (const [pid, _] of pidToTrackedSession.entries()) {
        if (!isProcessAlive(pid)) {
          logger.debug(
            `[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`
          );
          pidToTrackedSession.delete(pid);
        }
      }

      // Prune orphaned and disconnected tmux sessions (Issue #603 + #633)
      if (isTmuxPersistenceEnabled()) {
        try {
          const tmux = new TmuxManager({
            sessionName: configuration.tmuxSessionName,
            socketName: configuration.tmuxSessionName,
          });
          const windows = await tmux.listWindows();
          const windowNames = new Set(windows.map(w => w.name));

          for (const [pid, session] of pidToTrackedSession.entries()) {
            // The TRACKED hapi tag (#4080 4080-1) — the value stamped as the
            // window's @hapi_identity at spawn. Never an RPC session id.
            const tag =
              session.tmuxSessionId ?? session.persistedHapiSessionId ?? null;

            // Orphan check. Three window keys (#4218): the NAME is display
            // only (Hapimatic renames change it, and the in-memory tracked
            // name is NOT updated by a rename — comparing it deregisters a
            // live renamed session); the `@N` is an address within ONE
            // tmux-server lifetime; `@hapi_identity` proves ownership.
            //  - A session with a persisted `@N` is checked by ID: owned →
            //    retain; gone, or a recycled `@N` now held by another session
            //    → deregister; a tmux fault → skip this tick (#1329). It
            //    probes `display-message -t @N`, not `list-windows`, so it is
            //    not vacuous on tmux 3.4 (#1841).
            //  - A legacy session with only an index keeps the name compare at
            //    that index (#1316 — list-windows is stale on tmux 3.4+).
            //  - A legacy session with only a name keeps the listing check.
            let decision: OrphanDecision | null = null;
            if (session.tmuxWindowId && tag) {
              const owned = await resolveOwnedWindow(
                tmux,
                session.tmuxWindowId,
                tag
              );
              const result: OrphanIdCheckResult =
                owned.kind === "owned"
                  ? { ok: true, owned: true }
                  : owned.kind === "not-owned"
                    ? {
                        ok: true,
                        owned: false,
                        reason: describeOwnershipFailure(owned),
                      }
                    : {
                        ok: false,
                        error:
                          owned.error instanceof Error
                            ? owned.error
                            : new Error(String(owned.error)),
                      };
              decision = decideOrphanAction(
                result,
                { name: session.tmuxWindow ?? "", id: session.tmuxWindowId },
                pid,
                session.tmuxWindowIndex ?? -1
              );
            } else if (
              typeof session.tmuxWindowIndex === "number" &&
              session.tmuxWindow
            ) {
              // #1329: getWindowNameByIndex returns a discriminated union —
              // distinguish a transient tmux fault (skip this tick) from a
              // legitimate orphan (name mismatch).
              const result: OrphanCheckResult = await tmux.getWindowNameByIndex(
                session.tmuxWindowIndex
              );
              decision = decideOrphanAction(
                result,
                { name: session.tmuxWindow },
                pid,
                session.tmuxWindowIndex
              );
            } else if (session.tmuxWindow && windows.length === 0) {
              // #4218 N3 (#1841): an EMPTY listing while sessions are tracked
              // is a probe failure (tmux 3.4 can return none), never proof
              // that every window is gone.
              decision = {
                action: "skip",
                reason: "the window listing came back empty",
              };
            } else if (
              session.tmuxWindow &&
              !windowNames.has(session.tmuxWindow)
            ) {
              // Legacy session (persisted pre-#1316) — name-based check preserved.
              decision = {
                action: "deregister",
                reason: `tmux window '${session.tmuxWindow}' no longer exists`,
              };
            }

            if (decision?.action === "skip") {
              // Transient tmux fault — preserve the session in
              // pidToTrackedSession and defer to the next heartbeat. Skip
              // downstream tmux checks too (isPaneDead / hasActiveChildren),
              // since they'd likely fail with the same cascading fault.
              logger.error(
                `[DAEMON RUN] Skipping orphan-check for PID ${pid}: ${decision.reason}`
              );
              continue;
            }
            if (decision?.action === "deregister") {
              logger.warn(
                `[DAEMON RUN] Removing orphaned session PID ${pid}: ${decision.reason}`
              );
              pidToTrackedSession.delete(pid);
              continue;
            }
            // retain (or no check applied) — fall through to dead-pane check

            // Dead-pane check: window exists but pane process exited (Issue #633)
            if (session.tmuxWindow) {
              // #3734 Task 2(c): probe by the persisted @N when present (a
              // READ — falls back to the name for a legacy tracked session).
              const probeTarget = session.tmuxWindowId ?? session.tmuxWindow;
              const paneDead = await tmux.isPaneDead(probeTarget);
              if (paneDead) {
                // Issue #1731: reap the genuinely-dead window for tmux-inventory
                // hygiene. SAFE-BY-SCOPE (KD2) — this branch is paneDead-only, so
                // it never touches a live-child window (R2) or an idle-shell
                // archive-for-reconnect window (R3, handled by the idle-shell
                // branch below). #4218 R13: a persisted `@N` can name ANOTHER
                // session's window after a tmux-server restart, so reap only a
                // window this session owns. A dead pane has no process to carry
                // HAPI_SESSION_ID, so an identity-less dead window (or one whose
                // read faulted) is NOT reaped here — and no other reaper takes it
                // (reconcileOrphanWindows skips dead panes): tmux clutter only,
                // dead panes are not counted by effectiveCount (#4453).
                // reapDeadPaneWindow never throws.
                pidToTrackedSession.delete(pid);
                const owned = tag
                  ? await resolveOwnedWindow(tmux, probeTarget, tag)
                  : null;
                if (owned?.kind === "owned") {
                  logger.debug(
                    `[DAEMON RUN] Removing dead-pane session PID ${pid}: tmux window '${session.tmuxWindow}' pane is dead — reaping window`
                  );
                  await reapDeadPaneWindow(tmux, owned.target);
                } else {
                  const why =
                    owned === null ? "no tag" : describeOwnershipFailure(owned);
                  logger.debug(
                    `[DAEMON RUN] Removing dead-pane session PID ${pid}: window ${probeTarget} is not provably this session's (${why}) — not reaping`
                  );
                }
                continue;
              }

              // Idle-shell check: pane alive but no active child processes (Issue #633)
              const windowPid = await tmux.getWindowPid(probeTarget);
              if (windowPid && !(await tmux.hasActiveChildren(windowPid))) {
                logger.debug(
                  `[DAEMON RUN] Removing idle session PID ${pid}: tmux window '${session.tmuxWindow}' has no active child processes`
                );
                pidToTrackedSession.delete(pid);
              }
            }
          }

          // Issue #2683 (LEAK FIX): reconcile the FULL tmux inventory against
          // active tracked windows + the @hapi_archive tag. The tracked-session
          // loop above walks only pidToTrackedSession, so it can NEVER see a
          // window whose session was already untracked by the idle-shell branch
          // WITHOUT being reaped, or leaked by a failed cleanup-tmux-session
          // delete — exactly the accumulating death-orphans (#2683 findings 1/6).
          // reconcileOrphanWindows reaps them; its safety contract
          // (idle-shell-only, hapi-spawn-scoped, tag-aware, debounced, and the
          // #2646 hasActiveChildren invariant) is documented at its definition.
          // #3734 Task 2(d): key the preserve-set by INDEX, not name. A leaked
          // duplicate that shares a tracked session's name has a different
          // index, so name-keying would wrongly spare it. `tmuxWindowIndex` is
          // the captured, stable per-window index; a legacy tracked session
          // without one simply isn't in the preserve-set (its window is still
          // guarded by the archive-tag / live-child / debounce gates).
          const activeWindowIndexes = new Set<number>();
          for (const s of pidToTrackedSession.values()) {
            if (typeof s.tmuxWindowIndex === "number") {
              activeWindowIndexes.add(s.tmuxWindowIndex);
            }
          }
          // Re-read fresh: the tracked-session loop above may have reaped
          // paneDead windows, so the initial `windows` snapshot is stale.
          const currentWindows = await tmux.listWindows();
          const reapedOrphans = await reconcileOrphanWindows(
            tmux,
            currentWindows,
            activeWindowIndexes,
            orphanReapDebounce
          );
          if (reapedOrphans.length > 0) {
            logger.info(
              `[DAEMON RUN] #2683 orphan reconciliation reaped ${reapedOrphans.length} leaked idle-shell window(s): ${reapedOrphans.join(", ")}`
            );
          }
        } catch (error) {
          logger.debug(
            "[DAEMON RUN] Failed to check tmux windows for orphan cleanup",
            error
          );
          logger.reportCaught(error, {
            category: "daemon-orphan-tmux-check",
            severity: "warn",
          });
        }
      }

      // Orphan MCP process reaper (Issue #849)
      // Kill MCP server processes whose parent session died (OOM kill, SIGKILL).
      // Issue #4065: scoped to THIS instance (HAPI_HOME ownership) and anchored to
      // the MCP server's identity — never another instance's live servers, never
      // a process whose argv merely mentions an MCP name. Orphanhood is read from
      // /proc (the parent chain must reach init through wrappers only), so a live
      // session this map does not hold (tmux launcher, a detached spawn after a
      // restart) is never mistaken for dead. The live set below is an extra
      // guard: in-flight tmux spawns (webhook pending, up to 60s) and the daemon
      // itself (its `claude mcp list` poll children). See orphanMcpReaper.ts.
      try {
        const livePids = new Set<number>([
          ...pidToTrackedSession.keys(),
          ...shellPidToTrackedSession.keys(),
          process.pid,
        ]);
        const mcpReap = reapOrphanMcpProcesses({
          ownHome: configuration.happyHomeDir,
          livePids,
          debounce: orphanMcpReapDebounce,
        });
        if (mcpReap.reaped.length > 0) {
          logger.info(
            `[DAEMON RUN] Reaped ${mcpReap.reaped.length} orphaned MCP processes: ${mcpReap.reaped.map(r => `${r.pid}(${r.identity})`).join(", ")}`
          );
        }
        if (process.env.DEBUG) {
          logger.debug(
            `[DAEMON RUN] MCP orphan reaper: pending=${mcpReap.pending} live=${mcpReap.liveSkipped} foreign=${mcpReap.foreignSkipped} unknown=${mcpReap.unknownSkipped}`
          );
        }
      } catch (error) {
        logger.debug("[DAEMON RUN] MCP orphan reaper error:", error);
        logger.reportCaught(error, {
          category: "daemon-mcp-orphan-reaper",
          severity: "warn",
        });
      }

      // Stale tmux socket cleanup (issue #849; rewritten for #4204 PR-1).
      // The sweep now lives in ./staleSocketSweep and probes each hapimatic-*
      // socket with a bounded async net.connect, unlinking ONLY on ECONNREFUSED
      // (a socket file with no listener) — never on a list-sessions timeout,
      // which used to delete LIVE sockets under load (the #4204 root cause).
      // Async I/O only: it never blocks the event loop. Per-socket logging
      // (the unlink info line with path + reason) lives inside the module.
      try {
        const staleSweep = await sweepStaleSockets();
        if (staleSweep.unlinked.length > 0 || process.env.DEBUG) {
          logger.debug(
            `[DAEMON RUN] stale-socket sweep: unlinked=${staleSweep.unlinked.length} liveKept=${staleSweep.liveKept} errorKept=${staleSweep.errorKept} absent=${staleSweep.absent} scanned=${staleSweep.scanned}`
          );
        }
      } catch (error) {
        // sweepStaleSockets is designed never to throw; this outer guard is
        // defence-in-depth so a future sweep bug can never abort the whole
        // maintenance tick (Fallback Preservation Rule).
        logger.debug("[DAEMON RUN] stale tmux socket sweep error:", error);
        logger.reportCaught(error, {
          category: "daemon-stale-socket-cleanup",
          severity: "warn",
        });
      }

      // Check if daemon binary has been updated (e.g., during deployment)
      // Under systemd supervision, we exit with code 1 so systemd restarts us
      // with the new binary automatically. No need to self-spawn a replacement.
      // Primary: version string comparison (stable across rebuilds/copies)
      const currentVersion = packageJson.version;
      if (
        currentVersion &&
        fileState.startedWithCliVersion &&
        currentVersion !== fileState.startedWithCliVersion
      ) {
        logger.debug(
          `[DAEMON RUN] CLI version changed (${fileState.startedWithCliVersion} → ${currentVersion}), exiting so systemd restarts daemon`
        );
        maintenanceLoop.stop();
        process.exit(1);
      }
      // Fallback: mtime comparison (when version string is unavailable)
      const installedCliMtimeMs = getInstalledCliMtimeMs();
      if (
        !currentVersion &&
        typeof installedCliMtimeMs === "number" &&
        typeof startedWithCliMtimeMs === "number" &&
        installedCliMtimeMs !== startedWithCliMtimeMs
      ) {
        logger.debug(
          "[DAEMON RUN] Binary mtime changed (version unavailable), exiting so systemd restarts daemon"
        );
        maintenanceLoop.stop();
        process.exit(1);
      }

      // Heartbeat
      try {
        // Issue #4153: a SPREAD of the daemon's record, so every field the boot
        // write set — the #3731 socket name and token disposition, the #4153
        // socket path / accounts dir / epochs — rides every heartbeat. The
        // explicit-list form lost each new field in turn (#1738 OR-1, #3731 F1/F2).
        // The identity fields stay explicit: they are what the compare-and-write
        // below matches against, and the control token must survive every
        // heartbeat or the client 401s mid-run (#1738 OR-1).
        const updatedState: DaemonLocallyPersistedState = {
          ...fileState,
          pid: process.pid,
          httpPort: controlPort,
          controlToken,
          startedWithCliVersion: packageJson.version,
          startedWithCliMtimeMs,
          lastHeartbeat: new Date().toLocaleString(),
          lastHeartbeatAt: Date.now(),
        };
        // Issue #4155 (R3/R11): compare-and-write — re-checks the shutdown latch
        // and ownership SYNCHRONOUSLY right before writing. A tick in flight when
        // shutdown began, or overlapping a watchdog restart, cannot resurrect or
        // overwrite the file; on replacement it requests shutdown and ends the tick.
        if (!ownStateWriter.persist(updatedState)) return;
        // #4153: keep the heartbeat on the shared record, so a later disposition
        // write (which persists `fileState`) never erases it.
        fileState.lastHeartbeat = updatedState.lastHeartbeat;
        fileState.lastHeartbeatAt = updatedState.lastHeartbeatAt;
        if (process.env.DEBUG) {
          logger.debug(
            `[DAEMON RUN] Health check completed at ${updatedState.lastHeartbeat}`
          );
        }
      } catch (error) {
        logger.debug("[DAEMON RUN] Failed to write heartbeat", error);
        logger.reportCaught(error, {
          category: "daemon-heartbeat-write",
          severity: "warn",
        });
      }

      // Phase 2: Bi-directional sync - detect tmux window name changes
      // This runs every heartbeat interval (60s) to catch when users rename via tmux CLI
      if (isTmuxPersistenceEnabled()) {
        try {
          // First, fetch all sessions from server to validate local store
          const lookupUrl = `${configuration.serverUrl}/cli/sessions`;
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          if (configuration.cliApiToken) {
            headers["Authorization"] = `Bearer ${configuration.cliApiToken}`;
          }

          const lookupResponse = await fetch(lookupUrl, { headers });
          if (!lookupResponse.ok) {
            logger.debug(
              `[DAEMON RUN] Failed to lookup sessions for tmux sync: ${lookupResponse.status}`
            );
          } else {
            // Sessions have a 'tag' field which is the hapiSessionId
            const { sessions: serverSessions } =
              (await lookupResponse.json()) as {
                sessions: Array<{ id: string; tag: string }>;
              };

            // Build a set of server session tags and a map for lookup
            const serverSessionTags = new Set(serverSessions.map(s => s.tag));
            const serverSessionsByTag = new Map(
              serverSessions.map(s => [s.tag, s])
            );

            // Detect changes (this also cleans up stale local sessions)
            const changes = await detectTmuxNameChanges(serverSessionTags);

            for (const change of changes) {
              logger.info(
                `[DAEMON RUN] Syncing tmux rename to server for session ${change.hapiSessionId}: ${change.oldName} → ${change.newName}`
              );

              // Find the server session for this hapiSessionId
              const session = serverSessionsByTag.get(change.hapiSessionId);

              if (!session) {
                logger.debug(
                  `[DAEMON RUN] Could not find server session for tmux window rename: hapiSessionId=${change.hapiSessionId}`
                );
                continue;
              }

              // Call the CLI rename API
              // Pass skipTmuxSync: true to prevent server from syncing back to tmux (infinite loop)
              try {
                const renameUrl = `${configuration.serverUrl}/cli/sessions/${session.id}`;
                const renameResponse = await fetch(renameUrl, {
                  method: "PATCH",
                  headers,
                  body: JSON.stringify({
                    name: change.newName,
                    skipTmuxSync: true,
                  }),
                });

                if (renameResponse.ok) {
                  logger.info(
                    `[DAEMON RUN] Successfully synced tmux rename to server for session ${session.id}`
                  );
                } else {
                  const errorBody = await renameResponse.text();
                  logger.debug(
                    `[DAEMON RUN] Server rename failed: ${renameResponse.status} - ${errorBody}`
                  );
                }
              } catch (syncError) {
                logger.debug(
                  `[DAEMON RUN] Error syncing tmux rename to server:`,
                  syncError
                );
                logger.reportCaught(syncError, {
                  category: "daemon-tmux-rename-sync",
                  severity: "warn",
                });
              }
            }
          }
        } catch (error) {
          logger.debug(
            "[DAEMON RUN] Error detecting tmux name changes:",
            error
          );
          logger.reportCaught(error, {
            category: "daemon-tmux-rename-detect",
            severity: "warn",
          });
        }
      }

      // MCP status polling (every N heartbeats — issue #1069)
      // Two-phase polling: ONE global `claude mcp list` per cycle covers all
      // user/global/plugin MCPs. Project-scoped MCPs (in `.mcp.json`) get an
      // additional per-project poll only for dirs that have one. The server
      // applies per-project disabledMcpServers filter in the GET handler, so
      // we don't need a per-project poll just for the filter.
      mcpPollCounter++;
      if (mcpPollCounter >= MCP_POLL_EVERY_N_HEARTBEATS) {
        mcpPollCounter = 0;
        if (mcpPollInProgress) {
          logger.debug(
            "[DAEMON RUN] MCP poll still in progress, skipping this cycle"
          );
        } else {
          // Collect unique project directories from tracked sessions
          const uniqueProjectDirs = new Set<string>();
          for (const [, session] of pidToTrackedSession.entries()) {
            const path = session.happySessionMetadataFromLocalWebhook?.path;
            if (path) uniqueProjectDirs.add(path);
          }

          // Fire-and-forget async IIFE with concurrency guard
          (async () => {
            mcpPollInProgress = true;
            try {
              // Phase A — Global poll (always runs)
              try {
                const status = await pollMcpStatus();
                if (status) {
                  await api.updateMcpStatus(status);
                }
                recordMcpPollSuccess(MCP_POLL_FAILURE_GLOBAL_KEY);
              } catch (err) {
                // R2: warn so per-cycle failures surface in journalctl. The
                // existing recordMcpPollFailure call owns the 3-strikes Sentry
                // escalation — these two channels are complementary.
                logger.warn("[DAEMON RUN] MCP global poll failed", err);
                recordMcpPollFailure(MCP_POLL_FAILURE_GLOBAL_KEY, err);
              }

              // Phase B — Per-project overlay polls (only for dirs with .mcp.json)
              const projectScopedDirs =
                dirsNeedingProjectPoll(uniqueProjectDirs);
              for (const projectDir of projectScopedDirs) {
                try {
                  const status = await pollMcpStatus(projectDir);
                  if (status) {
                    await api.updateMcpStatus(status);
                  }
                  recordMcpPollSuccess(projectDir);
                } catch (err) {
                  logger.debug(
                    `[DAEMON RUN] MCP status poll failed for ${projectDir}`,
                    err
                  );
                  recordMcpPollFailure(projectDir, err);
                }
              }
              // Garbage-collect failure counters for project dirs that are no
              // longer in the active set (session ended, dir gone). Avoids
              // unbounded growth across long-running daemons.
              for (const key of Array.from(mcpPollFailureCounts.keys())) {
                if (
                  key !== MCP_POLL_FAILURE_GLOBAL_KEY &&
                  !projectScopedDirs.includes(key)
                ) {
                  mcpPollFailureCounts.delete(key);
                }
              }
            } catch (err) {
              // R5: This outer catch is for genuinely unexpected errors that
              // escape both Phase A and Phase B per-iteration guards (e.g. a
              // bug in the GC loop, or a throw from dirsNeedingProjectPoll
              // itself). It bypasses the recordMcpPollFailure escalation
              // counter, so route directly to error_logs/Sentry via
              // reportCaught alongside the journalctl warn.
              logger.warn("[DAEMON RUN] MCP status poll/send failed", err);
              logger.reportCaught(err, {
                category: "mcp-poll-failure",
                severity: "error",
              });
            } finally {
              mcpPollInProgress = false;
            }
          })();
        }
      }

      // Issue #1644: heartbeat every cross-machine rotation lease this node
      // holds (R4). Since #5021 the rotation sites release their lease when the
      // rotation finishes, so this only extends a lease held across a loop
      // iteration; with HAPI_ROTATION_LEASE_RELEASE_AFTER_ROTATION=off it keeps
      // this node the standing family owner (KD-D). Never throws (the client
      // fail-opens); a no-op when the gate is off or nothing is held.
      try {
        await rotationLeaseManager.heartbeatHeld();
      } catch (err) {
        logger.warn(
          `[DAEMON RUN] rotation-lease heartbeat failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Issue #1806: idle-refresh backstop — keep idle non-host isolated accounts
      // warm so they don't decay to ~8h expiry (the scheduler defers them to
      // native, which only rotates while a live session runs). Issue #4423: gated
      // on the machine-rotator role (one proactive rotator per machine; never a
      // worktree daemon; a dev daemon opts out with HAPI_IDLE_REFRESH=off), so a
      // non-rotator never enters the rotating pass and never takes or renews a
      // rotation lease through it. The method never throws; wrap defensively.
      if (ctx.machineRotator) {
        try {
          await tokenRefreshService.refreshIdleIsolatedAccounts();
        } catch (err) {
          logger.warn(
            `[DAEMON RUN] idle-refresh backstop failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // Issue #4423 (Task 6): the stale-flag clear runs on EVERY daemon, every
      // tick — NOT under the backstop gate above. The server refuses spawns on a
      // flagged record even when the shared file is healthy, so a daemon whose
      // backstop is off (dev, every worktree) must still clear its own store.
      // Runs AFTER the backstop, so a just-cleared account rotates next pass.
      // Takes no lease, queries no sessions, never rotates, never throws.
      try {
        await tokenRefreshService.clearStaleUnrefreshableFlags();
      } catch (err) {
        logger.warn(
          `[DAEMON RUN] stale-flag clear failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Issue #5020 (R3, R4): mirror each isolated credentials file into this
      // instance's store — a pair native Claude Code saved, the file lineage
      // spawn-time recovery checks, and a native wipe (flagged + error_logs).
      // On EVERY daemon (each instance has its own store), after the flag clear
      // so a just-cleared account is mirrored this tick. Never writes the file,
      // never calls OAuth, never throws.
      try {
        await tokenRefreshService.mirrorIsolatedCredentials();
      } catch (err) {
        logger.warn(
          `[DAEMON RUN] isolated-credentials mirror failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } finally {
      // SupervisedLoop owns reentrancy + rescheduling; nothing to release.
    }
  };
  const maintenanceLoop = new SupervisedLoop({
    name: "daemon-maintenance",
    node: daemonJobNode,
    intervalMs: heartbeatIntervalMs,
    registry: daemonJobRegistry,
    // Issue #2079: optional test clock seams — undefined in production, so
    // SupervisedLoop falls back to the globals (its own `?? Date.now`).
    now: clockSeams.now,
    setTimeoutFn: clockSeams.setTimeoutFn,
    clearTimeoutFn: clockSeams.clearTimeoutFn,
    tick: maintenanceTick,
  });
  maintenanceLoop.start(); // Every 60 seconds in production

  return { maintenanceLoop };
}
