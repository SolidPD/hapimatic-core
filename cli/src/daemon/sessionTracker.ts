// SPDX-License-Identifier: MIT
/**
 * `sessionTracker` — the daemon's tracked-session bookkeeping, extracted from
 * `run.ts`'s `startDaemon` closure (issue #2081, Epic #2077 Sub-Issue D).
 *
 * Holds the find/get/effective-count/webhook/stop/child-exit helpers that read
 * and mutate the shared tracked-session `Map`s. `createSessionTracker(ctx)`
 * destructures those maps from the injected {@link DaemonContext} once (the maps
 * are created early and never reassigned, so the reference is stable — identical
 * to the prior closure capture) and returns the helper set. The bodies are moved
 * VERBATIM from `run.ts` — this is a pure mechanical extraction, no behavior
 * change (referee'd by `run.test.ts`, the #2079 characterization suite).
 *
 * The concurrency-cap resolver (`resolveMaxConcurrent` + its clamp/ceiling
 * helpers) also lives here because `computeEffectiveCount` is its primary caller
 * (#2081 KD3); `run.ts` imports `resolveMaxConcurrent` back for its recovery log.
 */
import { logger } from "@/ui/logger";
import { TmuxManager } from "@/tmux";
import { configuration } from "@/configuration";
import { isTmuxPersistenceEnabled } from "./recoveryIntegration";
import { isPidDescendantOf, killProcessTree } from "@/utils/processTree";
import { killProcess, killProcessByChildProcess } from "@/utils/process";
import { stopTmuxSession, decideWrapperAlive } from "./tmuxSpawnAdapter";
import { createSessionStore } from "@/sessionPersistence";
import { generateSessionId } from "@/utils/id";
import { readSettings } from "@/persistence";
import { MAX_CONCURRENCY_DEFAULT } from "@hapi/protocol/schemas";
import {
  resolveCeiling,
  resolveDerivedCapacity,
  type CapSource,
} from "./sessionCapacity";
import type { Metadata } from "@/api/types";
import type { TrackedSession } from "./types";
import type { PersistedSession } from "@/sessionPersistence";
import type { DaemonContext } from "./daemonContext";

/**
 * Clamp any resolved/persisted/env cap to `[1, ceiling]`. A value of 0 would
 * lock out ALL spawning; an absurd value would over-spawn → OOM. NaN/Infinity
 * fall back to the default. (#1805 R9)
 *
 * The hard ceiling (#1805 KD-3 / R9) is env-overridable (`HAPI_MAX_CONCURRENT_CEILING`)
 * so a beefier host (e.g. SL7-class) is not wrongly limited by a Pi-sized number. This
 * clamp — NOT any UI/server-route validation — is the real OOM safety boundary on a
 * resource-constrained host. The variable is parsed by `resolveCeiling()`, the same
 * parser the tier/derived layer uses: a non-numeric value or one below 1 is invalid and
 * means 50. A module-load `parseInt` without that guard turned `unlimited` into `NaN`, and
 * the spawn gate's `effectiveCount >= NaN` never refused (#4754).
 */
const clampMaxConcurrent = (n: number): number =>
  Math.min(
    Math.max(1, resolveCeiling()),
    Math.max(1, Math.floor(Number.isFinite(n) ? n : MAX_CONCURRENCY_DEFAULT))
  );

/** A fully-resolved capacity: the enforced `max`, the `recommended` warn-at count,
 *  and which resolver layer decided it (#4417). */
export interface ResolvedCapacity {
  max: number;
  recommended: number;
  source: CapSource;
}

/** Recommended count for an explicit (env/settings) `max`: prefer a tier/derived
 *  recommendation, else fall back to `max`, and NEVER exceed `max` (directive 4417 R4:
 *  "min(recommended, max) when env/settings set max"). */
const recommendedForExplicitMax = (
  max: number,
  derivedRecommended: number | null
): number => {
  const base =
    derivedRecommended != null ? clampMaxConcurrent(derivedRecommended) : max;
  return Math.min(base, max);
};

/**
 * Resolve the LIVE spawn capacity. Priority (#4417, Task 4):
 *   env override > persisted setting > tier (vm-tier marker) > derived (RAM/CPU) > default(10)
 * A layer that yields `null` is SKIPPED. Since phase 2 every tier row carries measured
 * session counts and the derived coefficients are filled, so a node without an explicit
 * env/settings cap resolves through the tier (marker) or derived (RAM/CPU) layer; the
 * default (10) remains only without coefficients, for an unknown memory input, or when the
 * settings cannot be read (#4754). An explicit env/settings cap
 * keeps `max` and takes `recommended = min(derived recommendation, max)`. All counts are
 * clamped to `[1, ceiling]`.
 *
 * This resolver is the SINGLE source of the cap. `computeEffectiveCount()` stamps `max`,
 * `recommended` and `source` from the SAME call, and the spawn gate compares against that
 * same `max` — so the meter's reported `max`/`recommended` can never diverge from the
 * gate's enforced threshold (the #1477 single-closure principle). Reading the persisted
 * value at gate-time (not at module load) is what keeps the cap live-reloadable with NO
 * daemon restart (KD-2). The server is the sole writer of `maxConcurrentSessions`.
 *
 * Fallback Preservation: any settings read/parse error resolves to the default (10),
 * never 0 (lockout) and never Infinity (OOM).
 */
export const resolveCapacity = async (): Promise<ResolvedCapacity> => {
  // The tier/derived layer is evaluated once; its recommendation also informs an
  // explicit env/settings cap's recommended value (clamped to that cap).
  const tierOrDerived = resolveDerivedCapacity();
  const derivedRecommended = tierOrDerived
    ? tierOrDerived.counts.recommended
    : null;

  const envOverride = process.env.HAPI_MAX_CONCURRENT_SESSIONS;
  if (envOverride) {
    const max = clampMaxConcurrent(
      parseInt(envOverride, 10) || MAX_CONCURRENCY_DEFAULT
    );
    return {
      max,
      recommended: recommendedForExplicitMax(max, derivedRecommended),
      source: "env",
    };
  }

  let settingsMax: number | undefined;
  try {
    const settings = await readSettings();
    settingsMax = settings.maxConcurrentSessions ?? undefined;
  } catch {
    // Read/parse error → default (never lockout, never OOM).
    return {
      max: MAX_CONCURRENCY_DEFAULT,
      recommended: MAX_CONCURRENCY_DEFAULT,
      source: "default",
    };
  }
  if (settingsMax != null) {
    const max = clampMaxConcurrent(settingsMax);
    return {
      max,
      recommended: recommendedForExplicitMax(max, derivedRecommended),
      source: "settings",
    };
  }

  // No env, no setting → tier (marker) > derived > default. tierOrDerived is null only
  // when there are no coefficients or the memory input is unknown (the default then keeps
  // the node at 10); a machine below the reserve resolves to one session (#4754).
  if (tierOrDerived) {
    const max = clampMaxConcurrent(tierOrDerived.counts.max);
    const recommended = Math.min(
      clampMaxConcurrent(tierOrDerived.counts.recommended),
      max
    );
    return { max, recommended, source: tierOrDerived.source };
  }
  return {
    max: MAX_CONCURRENCY_DEFAULT,
    recommended: MAX_CONCURRENCY_DEFAULT,
    source: "default",
  };
};

/** Thin wrapper preserved for `run.ts`'s recovery log: the resolved `max` only. */
export const resolveMaxConcurrent = async (): Promise<number> =>
  (await resolveCapacity()).max;

/** The daemon's effective-count snapshot — the SAME shape the spawn gate and the
 *  `/effective-count` control endpoint consume (#1477). `recommended` + `source`
 *  (#4417) travel from the SAME `resolveCapacity()` call as `max`. */
export interface EffectiveCountResult {
  effectiveCount: number;
  trackedPids: number;
  activeTmuxWindows: number;
  max: number;
  /** Warn-at count (≤ max): the tier/derived recommendation, or `max` under the default. */
  recommended: number;
  /** Which resolver layer decided the cap. */
  source: CapSource;
}

/**
 * Build the tracked-session helper set bound to `ctx`'s shared maps. Call once
 * during daemon init after the maps exist in `ctx`; the returned helpers are
 * wired into the control server, RPC handlers, spawner, and `onReady` handles.
 */
export function createSessionTracker(ctx: DaemonContext) {
  const { pidToTrackedSession, pidToAwaiter, shellPidToTrackedSession } = ctx;

  // Helper functions
  const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

  /**
   * Compute the daemon's effective active-session count — the SAME number the
   * spawn gate uses to accept/reject spawns (issue #1477). Shared by the spawn
   * gate and the `/effective-count` control endpoint so the two cannot diverge
   * (the count was previously inlined at the spawn gate and unexposed, so every
   * other surface reported a different, inflated number).
   *
   * effectiveCount = max(in-memory tracked PIDs, active tmux windows).
   * The tmux window count is ground truth — it survives daemon restarts even if
   * the in-memory map fails to repopulate (#603). Only windows with active child
   * processes count; dead panes and idle shells are excluded (#633).
   */
  const computeEffectiveCount = async (
    // Issue #2299 (Task 1 — F(a) daemon-side own-slot credit): when a reused-window
    // respawn (e.g. switchAccount's kill+respawn, same hapiSessionId) asks the gate
    // whether it would be admitted, its OWN currently-counted slot must not count
    // against it. Otherwise the teardown race in Math.max(trackedPids,
    // activeTmuxWindows) still sees the dying session and rejects the session's own
    // respawn at the cap (the #2299 bug). When set AND the named session is currently
    // counted, subtract exactly 1 from each term that counts it (clamped >=0),
    // crediting the slot as freed. Default undefined => byte-identical to every
    // existing caller (KD-2: the hard cap is untouched for genuinely-new spawns,
    // whose fresh hapiSessionId never matches a counted slot).
    creditHapiSessionId?: string
  ): Promise<EffectiveCountResult> => {
    let trackedPids = pidToTrackedSession.size;

    // Issue #2299: resolve whether creditHapiSessionId currently occupies a counted
    // slot. The PID-term match mirrors the isSessionAlive tag-resolution idiom
    // (run.ts): a TrackedSession whose tmuxSessionId / persistedHapiSessionId /
    // happySessionId equals the id. Also resolve which window name to credit in the
    // tmux term below (the reused window the respawn re-attaches to; fall back to
    // the id itself, which is the new-window default name — tmuxSpawnAdapter).
    let creditWindowName: string | undefined;
    if (creditHapiSessionId) {
      const tracked = Array.from(pidToTrackedSession.values()).find(
        s =>
          s.tmuxSessionId === creditHapiSessionId ||
          s.persistedHapiSessionId === creditHapiSessionId ||
          s.happySessionId === creditHapiSessionId
      );
      if (tracked) {
        // Holds a tracked PID slot — credit it (clamped >=0, OR-2 guard).
        trackedPids = Math.max(0, trackedPids - 1);
        creditWindowName = tracked.tmuxWindow ?? creditHapiSessionId;
      } else {
        // Not in the PID map (already gone), but its reused window may still be
        // counted below — match by the id as the window name.
        creditWindowName = creditHapiSessionId;
      }
    }

    let activeTmuxWindows = 0;
    if (isTmuxPersistenceEnabled()) {
      try {
        const tmux = new TmuxManager({
          sessionName: configuration.tmuxSessionName,
          socketName: configuration.tmuxSessionName,
        });
        const windows = await tmux.listWindows();
        // Count only windows with active processes (not dead panes, not idle shells)
        let activeWindowCount = 0;
        let creditedWindowSeen = false;
        for (const w of windows) {
          if (w.name === "control") continue;
          if (w.paneDead) continue;
          if (w.panePid && !(await tmux.hasActiveChildren(w.panePid))) continue;
          // Issue #2299: credit the caller's OWN active window exactly once. Placed
          // AFTER the dead/idle skips so we only ever decline-to-count a window that
          // WOULD have counted — an already-uncounted window is never over-credited
          // (OR-2: the cap can never be exceeded by crediting a slot that was not held).
          if (
            creditWindowName !== undefined &&
            !creditedWindowSeen &&
            w.name === creditWindowName
          ) {
            creditedWindowSeen = true;
            continue;
          }
          activeWindowCount++;
        }
        activeTmuxWindows = activeWindowCount;
      } catch (err) {
        logger.warn(
          `[DAEMON RUN] Tmux window count cross-check failed, relying on in-memory map only: ${err instanceof Error ? err.message : String(err)}`
        );
        logger.reportCaught(err, {
          category: "daemon-tmux-window-count",
          severity: "warn",
        });
      }
    }
    // #1805 R8 / #4417: the cap is resolved LIVE here from ONE resolveCapacity() call,
    // so `max`, `recommended` and `source` share a single source and cannot diverge from
    // each other or from the gate (which compares effectiveCount against this same `max`).
    const cap = await resolveCapacity();
    return {
      effectiveCount: Math.max(trackedPids, activeTmuxWindows),
      trackedPids,
      activeTmuxWindows,
      max: cap.max,
      recommended: cap.recommended,
      source: cap.source,
    };
  };

  /**
   * Find a tracked session by checking if the reporting PID is a descendant
   * of any tracked tmux shell PID.
   */
  const findSessionByDescendantPid = (
    reportingPid: number
  ): { session: TrackedSession; shellPid: number } | null => {
    for (const [shellPid, session] of shellPidToTrackedSession.entries()) {
      if (isPidDescendantOf(reportingPid, shellPid)) {
        logger.debug(
          `[DAEMON RUN] Found session via descendant match: PID ${reportingPid} is descendant of shell ${shellPid}`
        );
        return { session, shellPid };
      }
    }
    return null;
  };

  // Handle webhook from HAPI session reporting itself
  const onHappySessionWebhook = (
    sessionId: string,
    sessionMetadata: Metadata
  ) => {
    logger.debugLargeJson(`[DAEMON RUN] Session reported`, sessionMetadata);

    const pid = sessionMetadata.hostPid;
    if (!pid) {
      logger.debug(
        `[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`
      );
      return;
    }

    logger.debug(
      `[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || "unknown"}`
    );
    logger.debug(
      `[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(", ")}`
    );
    logger.debug(
      `[DAEMON RUN] Current tracked shell PIDs: ${Array.from(shellPidToTrackedSession.keys()).join(", ")}`
    );

    // Check if we already have this exact PID (daemon-spawned non-tmux sessions)
    let existingSession = pidToTrackedSession.get(pid);
    let shellPid: number | null = null;

    // If not found by exact match, check if this PID is a descendant of a tracked tmux shell
    if (!existingSession) {
      const descendantMatch = findSessionByDescendantPid(pid);
      if (descendantMatch) {
        existingSession = descendantMatch.session;
        shellPid = descendantMatch.shellPid;
      }
    }

    if (existingSession && existingSession.startedBy === "daemon") {
      // Update daemon-spawned session with reported data
      existingSession.happySessionId = sessionId;
      existingSession.happySessionMetadataFromLocalWebhook = sessionMetadata;
      // Also update the tracked PID to the actual reporting PID
      existingSession.pid = pid;
      logger.debug(
        `[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`
      );

      // Resolve any awaiter - check both the exact PID and shell PID
      const awaiterPid = shellPid ?? pid;
      const awaiter = pidToAwaiter.get(awaiterPid);
      if (awaiter) {
        pidToAwaiter.delete(awaiterPid);
        // Clean up shell PID tracking if this was a tmux session
        if (shellPid) {
          shellPidToTrackedSession.delete(shellPid);
        }
        awaiter(existingSession);
        logger.debug(
          `[DAEMON RUN] Resolved session awaiter for PID ${awaiterPid}`
        );
      }

      // Also track by the actual reporting PID now
      if (!pidToTrackedSession.has(pid)) {
        pidToTrackedSession.set(pid, existingSession);
      }

      // Issue #1082: best-effort id-delivery for daemon-started codex tmux
      // sessions. The bootstrap webhook fires once BEFORE codex reports its id,
      // so this normally only catches a RESPAWN whose bootstrap metadata already
      // carries codexSessionId (the D5 resume path threads it via server
      // metadata). It is NOT the authoritative resume source — sessionRespawn.ts
      // reads metadata.codexSessionId server-side — but populating the daemon
      // store keeps RecoveryService's local view consistent. Mirrors the
      // terminal-session claudeSessionId late-arrival persistence below.
      if (
        sessionMetadata.flavor === "codex" &&
        sessionMetadata.codexSessionId &&
        isTmuxPersistenceEnabled()
      ) {
        const codexSessionId = sessionMetadata.codexSessionId;
        const persistedTag = sessionMetadata.hapiSessionTag;
        if (persistedTag) {
          const store = createSessionStore(configuration.happyHomeDir);
          store
            .get(persistedTag)
            .then(async persisted => {
              if (persisted && persisted.codexSessionId !== codexSessionId) {
                await store.updateCodexSessionId(persistedTag, codexSessionId);
              }
            })
            .catch(error => {
              logger.warn(
                `[DAEMON RUN] Failed to persist codexSessionId for ${persistedTag}: ${error}`
              );
              logger.reportCaught(error, {
                category: "daemon-update-codex-session-id",
                severity: "warn",
              });
            });
        }
      }
    } else if (!existingSession) {
      // New session started externally
      const trackedSession: TrackedSession = {
        startedBy: "hapi directly - likely by user from terminal",
        happySessionId: sessionId,
        happySessionMetadataFromLocalWebhook: sessionMetadata,
        pid,
      };
      pidToTrackedSession.set(pid, trackedSession);
      logger.debug(
        `[DAEMON RUN] Registered externally-started session ${sessionId}`
      );

      // Persist terminal-started sessions for recovery after reboot
      if (
        sessionMetadata.startedBy === "terminal" &&
        isTmuxPersistenceEnabled()
      ) {
        const store = createSessionStore(configuration.happyHomeDir);
        // Use the session's hapiSessionTag (the tag it registered with on the server) for correlation
        // This ensures bi-directional sync works - the local store ID matches the server's tag
        const hapiSessionId =
          sessionMetadata.hapiSessionTag ?? generateSessionId();
        const tmuxWindow = sessionMetadata.name ?? hapiSessionId;

        const persistedSession: PersistedSession = {
          hapiSessionId,
          claudeSessionId: sessionMetadata.claudeSessionId ?? null,
          cwd: sessionMetadata.path,
          tmuxWindow,
          createdAt: new Date().toISOString(),
          claudeArgs: [
            "--hapi-starting-mode",
            "terminal",
            "--started-by",
            "terminal",
          ],
          status: "active",
          namespace: "default",
        };

        // Store the hapiSessionId so we can update the persisted session later
        trackedSession.persistedHapiSessionId = hapiSessionId;

        store
          .save(persistedSession)
          .then(() => {
            logger.info(
              `[DAEMON RUN] Persisted terminal-started session ${hapiSessionId} for recovery`
            );
          })
          .catch(error => {
            logger.warn(
              `[DAEMON RUN] Failed to persist terminal-started session: ${error}`
            );
            logger.reportCaught(error, {
              category: "daemon-persist-terminal-session",
              severity: "warn",
            });
          });
      }
    } else if (existingSession && existingSession.startedBy !== "daemon") {
      // Existing terminal session - update metadata and check if claudeSessionId is now available
      existingSession.happySessionMetadataFromLocalWebhook = sessionMetadata;
      logger.debug(
        `[DAEMON RUN] Updated terminal session ${sessionId} with metadata`
      );

      // Update persisted session with claudeSessionId if it became available
      if (
        existingSession.persistedHapiSessionId &&
        sessionMetadata.claudeSessionId &&
        isTmuxPersistenceEnabled()
      ) {
        const store = createSessionStore(configuration.happyHomeDir);
        store
          .getAll()
          .then(async sessions => {
            const persisted = sessions.find(
              s => s.hapiSessionId === existingSession.persistedHapiSessionId
            );
            if (persisted && !persisted.claudeSessionId) {
              persisted.claudeSessionId =
                sessionMetadata.claudeSessionId ?? null;
              await store.save(persisted);
              logger.info(
                `[DAEMON RUN] Updated persisted session ${existingSession.persistedHapiSessionId} with claudeSessionId`
              );
            }
          })
          .catch(error => {
            logger.warn(
              `[DAEMON RUN] Failed to update persisted session with claudeSessionId: ${error}`
            );
            logger.reportCaught(error, {
              category: "daemon-update-claude-session-id",
              severity: "warn",
            });
          });
      }
    }
  };

  // Issue #1661: daemon-local liveness predicate over the live
  // `pidToTrackedSession` map. A tmux window's wrapper is "alive" iff some
  // tracked session owns that window AND the window's pane is not dead.
  //
  // 🔴 `pidToTrackedSession` membership — NOT `isPaneDead` alone — is the
  // positive Claude-liveness signal: the launch command ends in `; exec bash`
  // (tmuxSpawnAdapter.ts), so after Claude exits the pane holds a live bash
  // shell and `pane_dead` stays 0. The daemon's orphan-cleanup heartbeat
  // removes dead-Claude sessions from this map (idle-shell `hasActiveChildren`
  // check), so map-membership is what tells "Claude is actually running".
  //
  // Shared by the `is-session-alive` RPC (keyed by session tag) and the
  // tmuxSpawnAdapter re-attach guard (keyed by window name). Tmux faults are
  // swallowed by `isPaneDead` (returns false → treated as not-dead), matching
  // the existing orphan-cleanup convention; each caller layers its own
  // null/false fault contract on top.
  const isTmuxWindowWrapperAlive = async (
    windowTarget: string
  ): Promise<boolean> => {
    // #3734 Task 2(b): the caller passes the window's @N (id-safe) when known —
    // or the name for a legacy session. Match a tracked session by id-or-name,
    // then probe the SAME target, so a same-title collision can never report on
    // (or reuse) another session's window (the #3734 false-success class behind
    // the is-session-alive RPC + the reconnect re-attach guard).
    const tracked = Array.from(pidToTrackedSession.values()).some(
      s =>
        (s.tmuxWindowId != null && s.tmuxWindowId === windowTarget) ||
        s.tmuxWindow === windowTarget
    );
    if (!tracked) return false;
    const tmux = new TmuxManager({
      sessionName: configuration.tmuxSessionName,
      socketName: configuration.tmuxSessionName,
    });
    const paneDead = await tmux.isPaneDead(windowTarget);
    // #1682: tighten liveness with an active-children probe so a just-dead
    // Claude (idle `exec bash` pane, pane_dead=0) reports not-alive
    // immediately rather than on the 60s orphan-cleanup cadence. Only probe
    // children when the pane isn't already dead (saves a round-trip on the
    // dead path; matches the orphan-cleanup ordering at run.ts:2406). A null
    // windowPid (tmux fault) preserves the prior !paneDead verdict, so a
    // transient fault on a LIVE Claude is never misread as dead (#1661 class).
    const windowPid = paneDead ? null : await tmux.getWindowPid(windowTarget);
    const hasChildren =
      windowPid != null ? await tmux.hasActiveChildren(windowPid) : false;
    return decideWrapperAlive(tracked, paneDead, windowPid, hasChildren);
  };

  // Stop a session by sessionId or PID fallback
  const stopSession = (sessionId: string): boolean => {
    logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

    // Try to find by sessionId first
    for (const [pid, session] of pidToTrackedSession.entries()) {
      if (
        session.happySessionId === sessionId ||
        session.tmuxSessionId === sessionId ||
        (sessionId.startsWith("PID-") &&
          pid === parseInt(sessionId.replace("PID-", "")))
      ) {
        // Handle tmux-backed sessions
        if (session.tmuxSessionId) {
          logger.debug(
            `[DAEMON RUN] Stopping tmux-backed session ${session.tmuxSessionId}`
          );
          // Use async IIFE since stopSession is sync
          void (async () => {
            try {
              const stopped = await stopTmuxSession(session.tmuxSessionId!);
              if (stopped) {
                logger.debug(
                  `[DAEMON RUN] Successfully stopped tmux session ${session.tmuxSessionId}`
                );
              } else {
                logger.debug(
                  `[DAEMON RUN] Tmux session ${session.tmuxSessionId} may have already exited`
                );
              }
            } catch (error) {
              logger.warn(`[DAEMON RUN] Error stopping tmux session:`, error);
              logger.reportCaught(error, {
                category: "daemon-stop-tmux-session",
                severity: "warn",
                sessionId,
              });
            }
          })();
        } else if (session.startedBy === "daemon" && session.childProcess) {
          // Kill the entire process tree before killing the child process.
          // Without this, MCP servers spawned by Claude survive as orphans. (Issue #849)
          const childPid = session.childProcess.pid;
          if (childPid) {
            void killProcessTree(childPid).then(result => {
              if (result.killed.length > 0) {
                logger.info(
                  `[DAEMON RUN] Killed ${result.killed.length} descendants of session ${sessionId}`
                );
              }
            });
          }
          try {
            void killProcessByChildProcess(session.childProcess);
            logger.debug(
              `[DAEMON RUN] Requested termination for daemon-spawned session ${sessionId}`
            );
          } catch (error) {
            logger.debug(
              `[DAEMON RUN] Failed to kill session ${sessionId}:`,
              error
            );
            logger.reportCaught(error, {
              category: "daemon-kill-session",
              severity: "warn",
              sessionId,
            });
          }
        } else {
          // For externally started sessions, kill process tree then the PID. (Issue #849)
          void killProcessTree(pid).then(result => {
            if (result.killed.length > 0) {
              logger.info(
                `[DAEMON RUN] Killed ${result.killed.length} descendants of external PID ${pid}`
              );
            }
          });
          try {
            void killProcess(pid);
            logger.debug(
              `[DAEMON RUN] Requested termination for external session PID ${pid}`
            );
          } catch (error) {
            logger.warn(
              `[DAEMON RUN] Failed to kill external session PID ${pid}:`,
              error
            );
            logger.reportCaught(error, {
              category: "daemon-kill-external-session",
              severity: "warn",
              sessionId,
            });
          }
        }

        pidToTrackedSession.delete(pid);
        logger.debug(`[DAEMON RUN] Removed session ${sessionId} from tracking`);
        return true;
      }
    }

    logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
    return false;
  };

  // Handle child process exit
  const onChildExited = (pid: number) => {
    logger.debug(
      `[DAEMON RUN] Removing exited process PID ${pid} from tracking`
    );
    pidToTrackedSession.delete(pid);
  };

  return {
    getCurrentChildren,
    computeEffectiveCount,
    findSessionByDescendantPid,
    onHappySessionWebhook,
    isTmuxWindowWrapperAlive,
    stopSession,
    onChildExited,
  };
}

export type SessionTracker = ReturnType<typeof createSessionTracker>;
