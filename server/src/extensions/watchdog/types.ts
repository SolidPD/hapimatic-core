// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stall Watchdog Types
 *
 * Type definitions for the external stall detection service that
 * monitors Claude Code sessions for activity stalls using a
 * dual-signal approach: seq progression + thinking state.
 */

/** Stall watchdog configuration stored in settings.json under "stallWatchdog" */
export interface StallWatchdogConfig {
  /** Whether the watchdog is enabled. Default: true */
  enabled: boolean;
  /** Polling interval in milliseconds. Default: 30000 (30s) */
  pollIntervalMs: number;
  /** How long thinking must persist before starting detection. Default: 300000 (5 min) */
  thinkingThresholdMs: number;
  /** Additional time after detection to confirm via seq check. Default: 60000 (1 min) */
  confirmationWindowMs: number;
  /** Minimum time between notifications for the same session. Default: 600000 (10 min) */
  cooldownMs: number;
  /** Whether to send a nudge message into the stalled session. Default: false */
  nudgeEnabled: boolean;
  /** Message text for nudge. Default: "[WATCHDOG] Session appears stalled. Are you stuck?" */
  nudgeMessage: string;
}

/** A session that has exceeded the thinking threshold and is under observation */
export interface StallCandidate {
  sessionId: string;
  namespace: string;
  /** When the thinking threshold was first exceeded */
  detectedAt: number;
  /** The seq value at detection time — used for confirmation */
  seqAtDetection: number;
  /** The thinkingAt timestamp from the session */
  thinkingAt: number;
}

/** A confirmed stall event */
export interface StallEvent {
  sessionId: string;
  namespace: string;
  detectedAt: number;
  confirmedAt: number;
  /** How long the session was in thinking state */
  thinkingDurationMs: number;
  seqAtDetection: number;
  seqAtConfirmation: number;
  notified: boolean;
  nudged: boolean;
}

/** Runtime status of the stall watchdog service */
export interface StallWatchdogStatus {
  enabled: boolean;
  running: boolean;
  pollIntervalMs: number;
  thinkingThresholdMs: number;
  activeCandidates: number;
  totalEventsDetected: number;
  recentEvents: StallEvent[];
  lastPollAt: number | null;
}
