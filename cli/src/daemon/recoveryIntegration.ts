// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Recovery Integration for Daemon
 *
 * Integrates the RecoveryService with the daemon lifecycle.
 * Handles initialization on startup and provides session recovery.
 */

import { configuration } from "@/configuration";
import { RecoveryService, createRecoveryService } from "@/recovery";
import { createSessionStore } from "@/sessionPersistence";
import type { PersistedSession } from "@/sessionPersistence";
import { TmuxManager } from "@/tmux";
import {
  describeOwnershipFailure,
  resolveOwnedWindow,
} from "@/tmux/windowOwnership";
import type { OwnershipResult } from "@/tmux/windowOwnership";
import { logger } from "@/ui/logger";
import { existsSync, readFileSync } from "node:fs";
import { cleanupGhostWindows } from "./tmuxSpawnAdapter";

let recoveryService: RecoveryService | null = null;

interface ServerSession {
  id: string;
  tag: string;
  metadata?: {
    name?: string;
  };
}

/**
 * Fetch server sessions for validation and name comparison.
 * Returns both a Set of valid tags and a Map for looking up session details.
 */
async function fetchServerSessions(): Promise<
  | {
      tags: Set<string>;
      sessionsMap: Map<string, ServerSession>;
    }
  | undefined
> {
  try {
    const lookupUrl = `${configuration.serverUrl}/cli/sessions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (configuration.cliApiToken) {
      headers["Authorization"] = `Bearer ${configuration.cliApiToken}`;
    }

    const response = await fetch(lookupUrl, {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      logger.debug(
        `[RecoveryIntegration] Failed to fetch server sessions for validation: ${response.status}`
      );
      return undefined;
    }

    const { sessions } = (await response.json()) as {
      sessions: ServerSession[];
    };
    const tags = new Set(sessions.map(s => s.tag));
    const sessionsMap = new Map(sessions.map(s => [s.tag, s]));
    logger.debug(
      `[RecoveryIntegration] Fetched ${tags.size} valid session tags from server`
    );
    return { tags, sessionsMap };
  } catch (error) {
    logger.debug(
      `[RecoveryIntegration] Error fetching server sessions for validation:`,
      error
    );
    return undefined;
  }
}

/**
 * Sync local session names to server when they differ.
 * This handles cases where recovery detected a renamed tmux window.
 */
async function syncRecoveredSessionNames(
  sessionsMap: Map<string, ServerSession>
): Promise<void> {
  const store = createSessionStore(configuration.happyHomeDir);
  const localSessions = await store.getAll();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (configuration.cliApiToken) {
    headers["Authorization"] = `Bearer ${configuration.cliApiToken}`;
  }

  for (const localSession of localSessions) {
    if (localSession.status !== "active") continue;

    const serverSession = sessionsMap.get(localSession.hapiSessionId);
    if (!serverSession) continue;

    const localName = localSession.tmuxWindow;
    const serverName = serverSession.metadata?.name;

    // Skip sync if the local tmux window name is a hapiSessionId
    // (format: hapi-<10-digit-timestamp>-<8-char-random>, e.g. hapi-1773248478-cysq6z4z)
    // These are technical IDs, not user-set display names — syncing them
    // would overwrite the user's chosen session name with a technical ID.
    const isHapiSessionId = /^hapi-\d+-[a-z0-9]+$/.test(localName ?? "");

    // If names differ, sync local → server (only for user-set names)
    if (
      localName &&
      serverName &&
      localName !== serverName &&
      !isHapiSessionId
    ) {
      logger.info(
        `[RecoveryIntegration] Syncing recovered session name to server: "${serverName}" → "${localName}" for ${localSession.hapiSessionId}`
      );

      try {
        const renameUrl = `${configuration.serverUrl}/cli/sessions/${serverSession.id}`;
        const renameResponse = await fetch(renameUrl, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ name: localName, skipTmuxSync: true }),
        });

        if (renameResponse.ok) {
          logger.info(
            `[RecoveryIntegration] Successfully synced session name to server for ${serverSession.id}`
          );
        } else {
          const errorBody = await renameResponse.text();
          logger.debug(
            `[RecoveryIntegration] Server rename failed: ${renameResponse.status} - ${errorBody}`
          );
        }
      } catch (error) {
        logger.debug(
          `[RecoveryIntegration] Error syncing session name to server:`,
          error
        );
      }
    }
  }
}

/**
 * #2245 [2245-1] belt-and-braces: partition candidate zombie sessions into those
 * whose tmux window is deliberately archive-tagged (`@hapi_archive`, #2683) and
 * the rest. Pure so it is unit-testable without tmux/config. The RecoveryService
 * guard already routes an archived session to "offline" (never "needs-reconnect"),
 * so `archived` here should normally be empty — this is the second line of defense
 * that guarantees `autoReconnectZombieSessions` NEVER kills or reconnects an
 * archive-for-reconnect window even if a future refactor regresses that ordering.
 *
 * #4218: keyed by SESSION, not window name — the caller reads the tag on each
 * session's own window (`isArchiveTagged(@N)`), because a name is shared by
 * same-titled sessions and cross-written by the rename detector.
 */
export function partitionArchivedSessions(
  sessions: PersistedSession[],
  archivedSessionIds: ReadonlySet<string>
): { toReconnect: PersistedSession[]; archived: PersistedSession[] } {
  const toReconnect: PersistedSession[] = [];
  const archived: PersistedSession[] = [];
  for (const session of sessions) {
    if (archivedSessionIds.has(session.hapiSessionId)) {
      archived.push(session);
    } else {
      toReconnect.push(session);
    }
  }
  return { toReconnect, archived };
}

/**
 * #4218: resolve a zombie session's OWN window — its persisted `@N`, else the
 * `@hapi_identity === tag` row — through `resolveOwnedWindow`. Null when the
 * record has neither (a legacy window that cannot prove ownership). Never by
 * name, and never the raw persisted id: after a tmux-server restart that id
 * can name another session's live window. The identity listing is the
 * fault-discriminating `listWindowsWithIdentity` — a tmux fault there is a
 * `fault` result, never "no row" (a fault must not read as "no window").
 */
export async function resolveZombieWindow(
  tmux: Pick<
    TmuxManager,
    | "probeWindowIdentity"
    | "probeWindowHapiSessionId"
    | "listWindowsWithIdentity"
    | "socket"
  >,
  session: PersistedSession
): Promise<OwnershipResult | null> {
  if (session.tmuxWindowId) {
    return resolveOwnedWindow(
      tmux,
      session.tmuxWindowId,
      session.hapiSessionId
    );
  }
  let rows: Awaited<ReturnType<TmuxManager["listWindowsWithIdentity"]>>;
  try {
    rows = await tmux.listWindowsWithIdentity();
  } catch (error) {
    return { kind: "fault", error };
  }
  const row = rows.find(r => r.identity === session.hapiSessionId && r.id);
  return row?.id
    ? resolveOwnedWindow(tmux, row.id, session.hapiSessionId)
    : null;
}

/**
 * #2245/#4218: decide, per zombie candidate, whether its window is deliberately
 * archive-tagged (`@hapi_archive`) — never killed, never reconnected — reading
 * the tag on the session's OWN window by its `@N`. A record whose window cannot
 * be resolved by id or identity falls back to the name-matched `listWindows()`
 * tag (conservative: any same-named archived window keeps it archived).
 *
 * Fails CLOSED: a tmux fault on the ownership read, the identity listing, the
 * tag read on the owned `@N`, or the name-fallback listing (`listWindows`
 * strict) puts the session in `heldBack` — kept offline this pass and retried
 * on the next daemon start — because a fault read as "not archived" would send
 * an archive-tagged window to the reconnect loop's kill, or resurrect it.
 */
export async function classifyArchivedZombies(
  tmux: Pick<
    TmuxManager,
    | "probeWindowIdentity"
    | "probeWindowHapiSessionId"
    | "listWindowsWithIdentity"
    | "isArchiveTagged"
    | "listWindows"
    | "socket"
  >,
  sessions: PersistedSession[]
): Promise<{ archived: Set<string>; heldBack: Set<string> }> {
  const archived = new Set<string>();
  const heldBack = new Set<string>();
  let archivedNames: Set<string> | null = null;
  // Set when the name-fallback listing faulted: every later session that
  // needs the fallback is held back too (never read as "not archived").
  let nameListingFault: string | null = null;
  for (const session of sessions) {
    const own = await resolveZombieWindow(tmux, session);
    if (own?.kind === "fault") {
      heldBack.add(session.hapiSessionId);
      logger.warn(
        `[RecoveryIntegration] #4218: could not resolve zombie ${session.hapiSessionId}'s window (${describeOwnershipFailure(own)}) — holding it back this pass (offline; retried on the next daemon start)`
      );
      continue;
    }
    if (own?.kind === "owned") {
      try {
        if (await tmux.isArchiveTagged(String(own.target), true)) {
          archived.add(session.hapiSessionId);
        }
      } catch (error) {
        heldBack.add(session.hapiSessionId);
        logger.warn(
          `[RecoveryIntegration] #4218: could not read the archive tag on zombie ${session.hapiSessionId}'s window ${String(own.target)} (tmux fault: ${error instanceof Error ? error.message : String(error)}) — holding it back this pass (offline; retried on the next daemon start)`
        );
      }
      continue;
    }
    if (own === null) {
      if (archivedNames === null && nameListingFault === null) {
        try {
          archivedNames = new Set(
            (await tmux.listWindows(true))
              .filter(w => w.archiveTag === true)
              .map(w => w.name)
          );
        } catch (error) {
          nameListingFault =
            error instanceof Error ? error.message : String(error);
        }
      }
      if (nameListingFault !== null || archivedNames === null) {
        heldBack.add(session.hapiSessionId);
        logger.warn(
          `[RecoveryIntegration] #4218: could not list windows for zombie ${session.hapiSessionId}'s name-matched archive tag (tmux fault: ${nameListingFault ?? "unknown"}) — holding it back this pass (offline; retried on the next daemon start)`
        );
        continue;
      }
      if (archivedNames.has(session.tmuxWindow)) {
        archived.add(session.hapiSessionId);
      }
    }
  }
  return { archived, heldBack };
}

/**
 * Auto-reconnect sessions whose tmux windows have zombie shells (e.g. from
 * tmux-resurrect) instead of real HAPI processes. For each such session:
 *   1. Kill the zombie tmux window
 *   2. Call the local server's reconnect API to spawn a real `hapi claude --resume`
 *
 * Rate-limited to 3 concurrent reconnects with 2-second spacing.
 */
async function autoReconnectZombieSessions(
  sessions: PersistedSession[],
  sessionsMap: Map<string, ServerSession>
): Promise<void> {
  if (sessions.length === 0) return;

  const tmux = new TmuxManager({
    sessionName: configuration.tmuxSessionName,
    socketName: configuration.tmuxSessionName,
  });

  const store = createSessionStore(configuration.happyHomeDir);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (configuration.cliApiToken) {
    headers["Authorization"] = `Bearer ${configuration.cliApiToken}`;
  }

  // #2245 belt-and-braces: never kill/reconnect a window deliberately tagged
  // `@hapi_archive`, and never act on a session whose window read faulted
  // (#4218). Both are gated out of the reconnect loop and left "offline"
  // (preserved, reconnectable), matching the RecoveryService guard.
  const { archived: archivedIds, heldBack } = await classifyArchivedZombies(
    tmux,
    sessions
  );
  const { toReconnect, archived } = partitionArchivedSessions(
    sessions,
    new Set([...archivedIds, ...heldBack])
  );
  for (const session of archived) {
    if (!heldBack.has(session.hapiSessionId)) {
      logger.info(
        `[RecoveryIntegration] #2245 belt-and-braces skip: window "${session.tmuxWindow}" is archive-tagged (@hapi_archive) — NOT killing/reconnecting ${session.hapiSessionId}; keeping archived (offline)`
      );
    }
    await store.updateStatus(session.hapiSessionId, "offline");
  }

  if (toReconnect.length === 0) return;

  logger.info(
    `[RecoveryIntegration] Auto-reconnecting ${toReconnect.length} zombie session(s)...`
  );

  let reconnected = 0;
  let failed = 0;

  for (const session of toReconnect) {
    // Rate limit: 2-second spacing between reconnects
    if (reconnected > 0) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    try {
      // Kill the zombie tmux window (fresh shell from tmux-resurrect).
      // #3734/#4218: kill ONLY this session's own window, minted right here by
      // resolveOwnedWindow — never by name, never the raw persisted id (after
      // a tmux-server restart it can name another session's live window).
      // (The #2245 archive-tagged partition above already spared
      // deliberately-archived windows from ever reaching this loop.)
      const zombie = await resolveZombieWindow(tmux, session);
      if (zombie?.kind === "owned") {
        await tmux.killWindow(zombie.target);
        logger.info(
          `[RecoveryIntegration] Killed zombie tmux window "${session.tmuxWindow}" (${zombie.target}) for ${session.hapiSessionId}`
        );
      } else {
        const why =
          zombie === null
            ? "no window id or identity row"
            : describeOwnershipFailure(zombie);
        logger.warn(
          `[RecoveryIntegration] #4218: not killing a window for zombie ${session.hapiSessionId} (${why}) — reconnecting without it`
        );
      }

      // Find the server-side session to get the UUID (not the tag)
      const serverSession = sessionsMap.get(session.hapiSessionId);
      if (!serverSession) {
        logger.warn(
          `[RecoveryIntegration] Session ${session.hapiSessionId} not found on server — skipping reconnect`
        );
        await store.updateStatus(session.hapiSessionId, "error");
        failed++;
        continue;
      }

      // Call the server's reconnect API with retry
      let reconnectOk = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const reconnectUrl = `${configuration.serverUrl}/api/sessions/${serverSession.id}/reconnect`;
          const resp = await fetch(reconnectUrl, {
            method: "POST",
            headers,
            signal: AbortSignal.timeout(15_000),
          });

          if (resp.ok) {
            reconnectOk = true;
            break;
          }

          // 503 = server not ready yet — retry with backoff
          if (resp.status === 503 && attempt < 3) {
            logger.debug(
              `[RecoveryIntegration] Server not ready (503), retrying in ${attempt * 5}s...`
            );
            await new Promise(resolve => setTimeout(resolve, attempt * 5000));
            continue;
          }

          const body = await resp.text().catch(() => "");
          logger.warn(
            `[RecoveryIntegration] Reconnect failed for ${session.hapiSessionId}: HTTP ${resp.status} — ${body}`
          );
          break;
        } catch (err) {
          if (attempt < 3) {
            logger.debug(
              `[RecoveryIntegration] Reconnect attempt ${attempt} failed, retrying...`,
              err
            );
            await new Promise(resolve => setTimeout(resolve, attempt * 5000));
          } else {
            logger.warn(
              `[RecoveryIntegration] Reconnect failed for ${session.hapiSessionId} after 3 attempts:`,
              err
            );
          }
        }
      }

      if (reconnectOk) {
        await store.updateStatus(session.hapiSessionId, "recovering");
        reconnected++;
        logger.info(
          `[RecoveryIntegration] Triggered reconnect for ${session.hapiSessionId}`
        );
      } else {
        await store.updateStatus(session.hapiSessionId, "error");
        failed++;
      }
    } catch (err) {
      logger.warn(
        `[RecoveryIntegration] Auto-reconnect error for ${session.hapiSessionId}:`,
        err
      );
      await store.updateStatus(session.hapiSessionId, "error");
      failed++;
    }
  }

  logger.info(
    `[RecoveryIntegration] Auto-reconnect complete: ${reconnected} triggered, ${failed} failed`
  );
}

/** Data about a recovered session, for populating the daemon tracking map. */
export interface RecoveredSessionInfo {
  hapiSessionId: string;
  tmuxWindow: string;
  /** tmux window index captured at original spawn time. Undefined for
   *  legacy sessions persisted before the field was added (#1316). The
   *  heartbeat orphan-check falls back to name-based lookup in that case. */
  tmuxWindowIndex?: number | null;
  /** #3734: persisted tmux #{window_id} (@N). Threaded so run.ts seeds
   *  pidToTrackedSession by the collision-safe @N (the V2 cross-adoption fix).
   *  Undefined for legacy/terminal-started records with no captured id. */
  tmuxWindowId?: string | null;
  /** True if the window has a zombie shell that needs auto-reconnect.
   *  The daemon should NOT add these to pidToTrackedSession — they'll
   *  register via the normal webhook flow after the server spawns them. */
  needsReconnect: boolean;
}

/**
 * Initialize the recovery service.
 * Should be called on daemon startup.
 *
 * Returns a list of successfully recovered sessions so the daemon can
 * populate its in-memory tracking map (pidToTrackedSession) with pre-existing
 * sessions. This ensures MAX_CONCURRENT_SESSIONS counts recovered sessions
 * even after daemon restarts. (Issue #603)
 */
export async function initializeRecovery(): Promise<RecoveredSessionInfo[]> {
  if (!isTmuxPersistenceEnabled()) {
    logger.debug(
      "[RecoveryIntegration] tmux persistence disabled, skipping recovery initialization"
    );
    return [];
  }

  logger.info("[RecoveryIntegration] Initializing recovery service...");

  // #4743: move an already-running tmux server (one started before session
  // containment shipped, or by RP1's desktop launcher) into the sessions slice
  // at daemon start, so the next pane it forks is contained without waiting for
  // a spawn. Never starts a server; never throws.
  const containment = await new TmuxManager({
    sessionName: configuration.tmuxSessionName,
    socketName: configuration.tmuxSessionName,
  }).ensureServerContained();
  logger.debug(
    `[RecoveryIntegration] tmux server containment at start: ${containment}`
  );

  // Fetch valid server sessions FIRST to prevent stale local sessions from
  // claiming tmux windows during recovery
  const serverData = await fetchServerSessions();
  const serverSessionTags = serverData?.tags;

  recoveryService = createRecoveryService(
    configuration.happyHomeDir,
    configuration.tmuxSessionName
  );
  await recoveryService.initialize(serverSessionTags);

  const status = recoveryService.getStatus();
  logger.info(
    `[RecoveryIntegration] Recovery complete: ${status.recovered} recovered, ${status.failed} failed`
  );

  // Clean up ghost tmux windows (e.g. from tmux-resurrect) that don't belong
  // to any known session — prevents false rename detections
  try {
    const ghostsCleaned = await cleanupGhostWindows();
    if (ghostsCleaned > 0) {
      logger.info(
        `[RecoveryIntegration] Cleaned up ${ghostsCleaned} ghost tmux window(s)`
      );
    }
  } catch (error) {
    logger.debug(`[RecoveryIntegration] Ghost window cleanup failed:`, error);
  }

  // After recovery, sync any detected renames to the server
  // This handles cases where tmux window was renamed while daemon was stopped
  if (serverData?.sessionsMap) {
    await syncRecoveredSessionNames(serverData.sessionsMap);
  }

  // Auto-reconnect zombie sessions (tmux windows with shells, not HAPI processes)
  const needsReconnectSessions =
    await recoveryService.getNeedsReconnectSessions();
  if (needsReconnectSessions.length > 0 && serverData?.sessionsMap) {
    await autoReconnectZombieSessions(
      needsReconnectSessions,
      serverData.sessionsMap
    );
  }

  // Return recovered session info so the daemon can populate its tracking map.
  // Only include genuinely active sessions (not needs-reconnect — those will
  // register via the normal webhook flow after the server spawns them).
  const activeSessions = await recoveryService.getActiveSessions();
  const reconnectingSessions =
    await recoveryService.getNeedsReconnectSessions();

  return [
    ...activeSessions.map(s => ({
      hapiSessionId: s.hapiSessionId,
      tmuxWindow: s.tmuxWindow,
      tmuxWindowIndex: s.tmuxWindowIndex, // #1316
      tmuxWindowId: s.tmuxWindowId, // #3734
      needsReconnect: false,
    })),
    ...reconnectingSessions.map(s => ({
      hapiSessionId: s.hapiSessionId,
      tmuxWindow: s.tmuxWindow,
      tmuxWindowIndex: s.tmuxWindowIndex, // #1316
      tmuxWindowId: s.tmuxWindowId, // #3734
      needsReconnect: true,
    })),
  ];
}

/**
 * Get the recovery service instance
 * Returns null if not initialized or disabled
 */
export function getRecoveryService(): RecoveryService | null {
  return recoveryService;
}

// Cached resolved value — once resolved, stays consistent for the daemon's lifetime
let resolvedTmuxPersistence: boolean | null = null;

/**
 * Check if tmux persistence is enabled.
 * Priority: env var (via configuration) > settings.json > default (false)
 */
export function isTmuxPersistenceEnabled(): boolean {
  if (resolvedTmuxPersistence !== null) {
    return resolvedTmuxPersistence;
  }

  // If env var was set, configuration has it
  if (configuration.tmuxPersistenceEnabled) {
    resolvedTmuxPersistence = true;
    return true;
  }

  // Fallback: check settings.json (synchronous read for consistency)
  try {
    if (existsSync(configuration.settingsFile)) {
      const content = readFileSync(configuration.settingsFile, "utf8");
      const settings = JSON.parse(content);
      if (settings.tmuxPersistenceEnabled === true) {
        resolvedTmuxPersistence = true;
        logger.debug(
          "[RecoveryIntegration] tmux persistence enabled via settings.json fallback"
        );
        return true;
      }
    }
  } catch {
    // Settings file unreadable, fall through to default
  }

  resolvedTmuxPersistence = false;
  return false;
}
