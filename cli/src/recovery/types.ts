// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Recovery Service Types
 */

export interface RecoveryStatus {
  /** Total sessions found in persistence */
  totalPersisted: number;

  /** Sessions that were successfully recovered (real HAPI process running) */
  recovered: number;

  /** Sessions that could not be recovered (tmux window gone, etc.) */
  failed: number;

  /** Sessions with zombie shells needing auto-reconnect */
  needsReconnect: number;

  /** Sessions currently being recovered */
  inProgress: number;

  /** Last recovery attempt timestamp */
  lastRecoveryAt: string | null;

  /** Recovery errors encountered */
  errors: RecoveryError[];
}

export interface RecoveryError {
  sessionId: string;
  error: string;
  timestamp: string;
}

export interface RecoveryResult {
  /** Session that was recovered */
  hapiSessionId: string;

  /** Whether recovery was successful */
  success: boolean;

  /** Error message if recovery failed */
  error?: string;

  /** Whether the session was found in tmux */
  tmuxWindowExists: boolean;

  /** Whether the process in the window was alive */
  processAlive: boolean;

  /** Whether the window has a live process but no HAPI_SESSION_ID in its
   *  environment — indicates a zombie shell (e.g. from tmux-resurrect)
   *  that needs to be killed and reconnected. */
  needsReconnect: boolean;

  /** Issue #1082: the durable CODEX_HOME of a recovered codex session (ruling
   *  D4), surfaced for observability. Undefined for claude and for codex
   *  sessions that use codex's default ~/.codex. */
  codexHome?: string;
}

export interface RecoveryServiceOptions {
  /** HAPI home directory */
  hapiHome: string;

  /** tmux socket/session name — pass the instance's configuration.tmuxSessionName (per-instance: hapimatic-private / hapimatic-dev / hapimatic-wt-<port>). */
  tmuxSessionName: string;

  /** Whether to auto-recover on startup */
  autoRecover?: boolean;
}
