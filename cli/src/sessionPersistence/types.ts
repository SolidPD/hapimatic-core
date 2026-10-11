// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session Persistence Types
 *
 * These types define the structure for persisting session state across
 * server restarts and system reboots.
 */

export interface PersistedSession {
  /** Hapimatic's internal session ID */
  hapiSessionId: string;

  /** Claude Code's session ID (for --resume flag) */
  claudeSessionId: string | null;

  /**
   * Agent flavor for this session (#1082). Optional for backward compat —
   * legacy records persisted before this field was added are absent it and
   * default to "claude" on read (see RecoveryService). Both this and
   * codexSessionId are optional, so no CURRENT_SCHEMA_VERSION bump is needed.
   */
  agent?: "claude" | "codex";

  /**
   * Codex's session ID (#1082), mirroring claudeSessionId. Used for remote-mode
   * resume: the daemon threads it into the respawned wrapper as
   * --hapi-codex-resume, and codexRemoteLauncher resolves it via
   * findCodexResumeFile(session.sessionId). Null until codex reports its id.
   */
  codexSessionId?: string | null;

  /**
   * Durable session-scoped CODEX_HOME dir for a tmux-persisted codex session
   * (#1082, ruling D4). Holds auth.json / config.toml and the sessions/ resume
   * JSONL. Tied to the SESSION lifetime (survives child exit + daemon restart);
   * removed on session delete and orphan-GC'd by recovery. Absent for claude
   * and for codex sessions on the direct-spawn path.
   */
  codexHome?: string;

  /** Working directory for the session */
  cwd: string;

  /** tmux window name (e.g., "hapi-abc123") */
  tmuxWindow: string;

  /**
   * tmux window index captured at spawn time (e.g., 7 for window "hapimatic:7").
   * Set by tmuxSpawnAdapter from TmuxSpawnResult.tmuxWindowIndex on fresh spawns.
   * Null/absent for legacy sessions persisted before this field was added — the
   * heartbeat orphan-check falls back to name-based lookup in that case. (#1316)
   */
  tmuxWindowIndex?: number | null;

  /**
   * tmux window id (`@N`, e.g. `@7`) captured race-free at spawn from
   * `new-window -P -F '#{window_index} #{window_id}'` (#3734). Unlike
   * `tmuxWindow` (the NAME, shared by two same-issue sessions) the `@N` is
   * globally unambiguous within the tmux server and never recycled, so it is
   * THE 1:1 lifecycle key — every kill/probe/recovery op targets it, and a
   * stale id fails SAFE (tmux exits 1) rather than resolving to another
   * session's same-named window. Optional/nullable: absent for legacy records
   * persisted before this field AND for terminal-started sessions that never
   * ran `createWindow`; those fall back to the `@hapi_identity` query, then the
   * name. No CURRENT_SCHEMA_VERSION bump (the `tmuxWindowIndex?` / #2245
   * `archived?` precedent).
   */
  tmuxWindowId?: string | null;

  /** ISO timestamp when session was created */
  createdAt: string;

  /** Claude CLI arguments (e.g., ["--dangerously-skip-permissions"]) */
  claudeArgs: string[];

  /** Current session status */
  status: SessionStatus;

  /** Namespace for multi-tenant support */
  namespace: string;
}

export type SessionStatus =
  | "active"
  | "recovering"
  | "offline"
  | "error"
  | "needs-reconnect";

export interface SessionStoreData {
  /** Schema version for future migrations */
  version: number;

  /** Last updated timestamp */
  updatedAt: string;

  /** All persisted sessions */
  sessions: PersistedSession[];
}

export interface SessionStoreOptions {
  /** Path to the JSON state file */
  storePath: string;

  /** Whether to create the file if it doesn't exist */
  createIfMissing?: boolean;
}

export const CURRENT_SCHEMA_VERSION = 1;

export const DEFAULT_STORE_DATA: SessionStoreData = {
  version: CURRENT_SCHEMA_VERSION,
  updatedAt: new Date().toISOString(),
  sessions: [],
};
