// SPDX-License-Identifier: MIT AND AGPL-3.0-only
/**
 * Daemon-specific types (not related to API/server communication)
 */

import { Metadata } from "@/api/types";
import { ChildProcess } from "child_process";

/**
 * Session tracking for daemon
 */
export interface TrackedSession {
  startedBy: "daemon" | string;
  happySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  pid: number;
  childProcess?: ChildProcess;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
  // tmux persistence fields
  tmuxSessionId?: string; // The HAPI session ID used for tmux window naming
  tmuxWindow?: string; // The tmux window identifier (e.g., "hapimatic:session_abc123")
  tmuxWindowIndex?: number | null; // tmux window index for stale-list-windows-resistant lookups (#1316)
  tmuxWindowId?: string | null; // #3734: persisted tmux #{window_id} (@N) — the collision-safe 1:1 lifecycle key
  persistedHapiSessionId?: string; // The hapiSessionId used in sessions-state.json for recovery
}
