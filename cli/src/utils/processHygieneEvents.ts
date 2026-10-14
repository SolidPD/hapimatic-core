// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cross-layer observability for process-hygiene cleanup (issue #1031).
 *
 * Three components emit to the same JSONL file for correlation:
 *   - CLI daemon:     cli/src/daemon/worktree.ts (this file)
 *   - systemd timer:  scripts/lsp-reaper.sh
 *   - Claude hook:    ~/.claude/hooks/vitest-watchdog.py
 *
 * All three write one JSON object per line to
 * `~/.claude/logs/process-hygiene.jsonl`. The schema is intentionally loose
 * (source-specific extras allowed) — only `timestamp` and `source` are required
 * so cross-source queries work.
 *
 * Pattern mirrors `logExitDiagnostics` in `cli/src/claude/utils/exitDiagnostics.ts`.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type ProcessHygieneSource =
  | "cli-worktree"
  | "systemd-lsp-reaper"
  | "claude-hook-vitest";

export interface ProcessHygieneEvent {
  source: ProcessHygieneSource;
  action: "scan" | "kill" | "skip" | "error";
  /** Target path whose processes were scanned (worktree path, tsserver cwd, etc.). */
  path?: string;
  /** Hapimatic session ID when the event is session-scoped. */
  sessionId?: string;
  /** PIDs that exited on SIGTERM without requiring SIGKILL. */
  pidsTerminated?: number[];
  /** PIDs that required SIGKILL after SIGTERM timeout. */
  pidsKilled?: number[];
  /** Short human-readable reason (e.g. "soft-delete", "purge-expired", "hysteresis-skip"). */
  reason?: string;
  /** Non-fatal errors surfaced from a best-effort cleanup. */
  errors?: string[];
  /** Source-specific extras (kept loose on purpose). */
  [extra: string]: unknown;
}

function resolveLogPath(): string {
  const home = process.env.HOME ?? "/tmp";
  return join(home, ".claude", "logs", "process-hygiene.jsonl");
}

/**
 * Append a process-hygiene event as one JSON line.
 *
 * Best-effort: never throws. Cleanup paths must not be disrupted by an
 * observability failure. Mirrors the `logExitDiagnostics` contract.
 */
export function logProcessHygieneEvent(event: ProcessHygieneEvent): void {
  try {
    const logPath = resolveLogPath();
    mkdirSync(join(logPath, ".."), { recursive: true });
    const entry = {
      timestamp: new Date().toISOString(),
      ...event,
    };
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch {
    // intentional: observability must never block cleanup
  }
}
