// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Heartbeat System Types
 *
 * Type definitions for the heartbeat service that provides
 * periodic autonomous agent execution via reconnect-on-demand sessions.
 */

/** Heartbeat configuration stored in settings.json under the "heartbeat" key */
export interface HeartbeatConfig {
  /** Whether the heartbeat system is enabled. Default: false */
  enabled: boolean;
  /** Interval between heartbeat ticks in milliseconds. Default: 1800000 (30m) */
  every: number;
  /** Active hours window — heartbeats only fire within this range */
  activeHours: {
    /** Start hour 0-23. Default: 8 */
    start: number;
    /** End hour 0-23. Default: 22 */
    end: number;
    /** IANA timezone string. Default: "America/New_York" */
    timezone: string;
  };
  /** Path to standing orders file. Default: "{dataDir}/heartbeat-instructions.md" */
  instructionsFile: string;
  /** Working directory for heartbeat session. Default: user home directory */
  sessionDirectory: string;
  /** Max characters for HEARTBEAT_OK suppression threshold. Default: 300 */
  ackMaxChars: number;
  /** Rotate session after N heartbeat ticks. Default: 48 */
  rotateAfterBeats: number;
  /** Force rotation after this many ms. Default: 86400000 (24h) */
  maxSessionAgeMs: number;
  /** Preferred machine ID for heartbeat sessions. Default: first online machine */
  machine?: string;
  /** Display name for heartbeat sessions. Default: "HEARTBEAT" */
  sessionName?: string;
  /** Emoji for heartbeat sessions. Default: "💓" */
  sessionEmoji?: string;
  /** Session type: simple or worktree. Default: "worktree" */
  sessionType?: "simple" | "worktree";
  /** Branch name when sessionType is "worktree". Default: "heartbeat" */
  worktreeBranchName?: string;
}

/** Runtime status of the heartbeat service */
export interface HeartbeatStatus {
  enabled: boolean;
  running: boolean;
  lastTickAt: number | null;
  nextTickAt: number | null;
  sessionId: string | null;
  beatsSinceRotation: number;
  consecutiveFailures: number;
  currentInterval: number;
  activeHoursActive: boolean;
}

/** Result of a single heartbeat tick */
export interface HeartbeatTickResult {
  timestamp: number;
  success: boolean;
  skipped: boolean;
  skipReason?: string;
  responseLength?: number;
  suppressed?: boolean;
  durationMs: number;
  error?: string;
}

/** Entry in the heartbeat history circular buffer */
export interface HeartbeatHistoryEntry extends HeartbeatTickResult {
  sessionId: string | null;
  beatNumber: number;
}

/** Internal state tracked by HeartbeatService */
export interface HeartbeatState {
  sessionId: string | null;
  beatsSinceRotation: number;
  lastRotationAt: number;
  consecutiveFailures: number;
  currentInterval: number;
  lastTickAt: number | null;
  tickInProgress: boolean;
}

/** System event for the cross-cutting event queue */
export interface SystemEvent {
  timestamp: number;
  /** Source of the event: cron (#310), webhook, api, or internal system */
  source: "cron" | "webhook" | "api" | "system";
  /** Human-readable description included in the heartbeat prompt */
  description: string;
  /** Optional structured metadata */
  metadata?: Record<string, unknown>;
}
