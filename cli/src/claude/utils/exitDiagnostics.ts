// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Exit diagnostics for Claude Code child process.
 *
 * Captures structured diagnostic data when the child process exits
 * unexpectedly (signal kill, crash, rapid exit). Writes JSONL entries
 * to ~/.claude/logs/session-exits.jsonl for post-mortem analysis.
 *
 * Issue #795 — all functions are best-effort and never throw.
 */

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAllDescendantPids } from "@/utils/processTree";

export interface ExitDiagnosticEntry {
  timestamp: string;
  exitType: "signal" | "crash" | "rapid-exit";
  exitCode: number | null;
  signal: string | null;
  hapiSessionId: string;
  claudeSessionId: string | null;
  duration_ms: number;
  workingDirectory: string;
  ongoingToolCalls: number;
  procStatus: Record<string, string> | null;
  processTree: {
    pid: number;
    ppid: string;
    children: number[];
  } | null;
  // Issue #1239 PR D: last ~8 KB of the child's stderr stream before exit.
  // Populated by the ring buffer in query.ts for signal/crash exits when the
  // child wrote anything to stderr; null for rapid-exit (process returned
  // cleanly so stderr is uninteresting) or when stderr was empty. Closes the
  // observability gap PR A's procStatus could not — /proc/<pid>/status is
  // already reaped by the time the close handler runs for non-signal exits,
  // but the stderr stream was buffered in the parent before the child died.
  stderr_tail: string | null;
  errorDetail: string;
  version: string;
}

/**
 * Read selected fields from /proc/<pid>/status.
 * Returns null if the process is already gone or /proc is unavailable (macOS).
 */
export function readProcStatus(pid: number): Record<string, string> | null {
  try {
    const raw = readFileSync(`/proc/${pid}/status`, "utf-8");
    const fields: Record<string, string> = {};
    const wanted = new Set([
      "VmPeak",
      "VmHWM",
      "VmRSS",
      "VmSize",
      "Threads",
      "State",
      "PPid",
    ]);
    for (const line of raw.split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      if (wanted.has(key)) {
        fields[key] = line.slice(colonIdx + 1).trim();
      }
    }
    return Object.keys(fields).length > 0 ? fields : null;
  } catch {
    return null;
  }
}

/**
 * Capture process tree state: parent PID and child PIDs.
 * Returns null if the process is already gone.
 */
export function captureProcessTree(
  pid: number
): { pid: number; ppid: string; children: number[] } | null {
  try {
    let ppid = "unknown";
    try {
      const raw = readFileSync(`/proc/${pid}/status`, "utf-8");
      const match = raw.match(/^PPid:\s*(\d+)/m);
      if (match) ppid = match[1];
    } catch {
      // Process gone — PPid unavailable
    }
    const children = getAllDescendantPids(pid);
    return { pid, ppid, children };
  } catch {
    return null;
  }
}

/**
 * Write an exit diagnostic entry to the JSONL log file.
 * Follows the logDesyncEvent pattern from claudeRemote.ts — never throws.
 */
export function logExitDiagnostics(entry: ExitDiagnosticEntry): void {
  try {
    const logDir = join(process.env.HOME ?? "/tmp", ".claude", "logs");
    const logPath = join(logDir, "session-exits.jsonl");
    mkdirSync(logDir, { recursive: true });
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch {
    // Non-critical — never fail the session for diagnostics
  }
}

/**
 * Issue #1239: Retry-budget context paired with an exit diagnostic when
 * persisting to the SQLite error_logs table. The launcher tracks two
 * counters (signal-exit retries vs non-signal launch failures) and they
 * give the dashboard reader a sense of how close the wrapper was to
 * giving up when the exit fired.
 */
export interface SessionExitRetryContext {
  consecutiveLaunchFailures: number;
  consecutiveSignalFailures: number;
}

/**
 * Issue #1239: Build the `logger.reportError` payload that persists an
 * exit-diagnostics event to the SQLite error_logs table for admin-dashboard
 * visibility. Mirrors the #1078 (tool-error) and #1107 (mcp-toggle config)
 * wire-up pattern — single fixed category with the structured fields rolled
 * into the context JSON.
 *
 * Pure: no I/O, no side effects. The launcher passes the result to
 * `logger.reportError(...)` which is fire-and-forget over HTTP.
 */
export function buildSessionExitReport(
  entry: ExitDiagnosticEntry,
  retry: SessionExitRetryContext
): {
  message: string;
  category: "session-exit";
  severity: "warn" | "error";
  sessionId: string;
  context: string;
} {
  return {
    message: `Claude Code session exited (${entry.exitType}): ${entry.errorDetail}`,
    category: "session-exit",
    // rapid-exit is recoverable retry signalling, the others are real failures
    severity: entry.exitType === "rapid-exit" ? "warn" : "error",
    sessionId: entry.hapiSessionId,
    context: JSON.stringify({
      exitType: entry.exitType,
      exitCode: entry.exitCode,
      signal: entry.signal,
      duration_ms: entry.duration_ms,
      ongoingToolCalls: entry.ongoingToolCalls,
      workingDirectory: entry.workingDirectory,
      claudeSessionId: entry.claudeSessionId,
      consecutiveLaunchFailures: retry.consecutiveLaunchFailures,
      consecutiveSignalFailures: retry.consecutiveSignalFailures,
      // Issue #1239 PR D: stderr ring tail surfaced into SQLite `error_logs`
      // context. The admin dashboard can render this directly; the field is
      // null for clean rapid-exits and silent crashes.
      stderr_tail: entry.stderr_tail,
      version: entry.version,
    }),
  };
}
