// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ErrorLogger } from "../logging/errorLogger";
import { SESSION_FATAL_ESCALATION_CATEGORY } from "./sessionFatalEscalation";

/**
 * Issue #1883 — the out-of-band escalation surface (G3). A `Notifier` delivers a
 * `(subject, body)` to the user through a channel that is INDEPENDENT of the
 * impaired session's own ability to relay messages. The default implementation
 * shells out to `notify-pm.sh` (the Telegram → AgentMail → gmail cascade).
 *
 * Injected into `SyncEngine` via `setNotifier` (never constructed there) so the
 * escalation degrades to G1 (error_logs) + G2 (in-session notice) when unset
 * (Fallback Preservation Rule).
 */
export interface Notifier {
  /**
   * Deliver an out-of-band notification. Resolves `{ delivered: true }` when at
   * least one tier accepted the message, `{ delivered: false }` otherwise. MUST
   * NOT reject — a delivery failure is a value, never a throw (R4 fail-open).
   */
  notify(subject: string, body: string): Promise<{ delivered: boolean }>;
}

/** Default hard cap on the notify-pm shell-out (matches the script's own tiers). */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Resolve the notify-pm.sh path. `HAPI_NOTIFY_PM_PATH` (env) wins — it is the
 * seam the unit test + the live worktree verification (V7) point at a STUB so
 * the real operator-paging cascade never fires under test. Otherwise the
 * canonical `~/.claude/scripts/notify-pm.sh` (mirror of `findClaudePath()` in
 * `server/src/utils/mcpPoller.ts`, and of `JobAlertRouter`'s default path).
 */
export function resolveNotifyPmPath(): string {
  return (
    process.env.HAPI_NOTIFY_PM_PATH ??
    join(homedir(), ".claude", "scripts", "notify-pm.sh")
  );
}

/**
 * Real `Notifier` — shells out to notify-pm.sh via async `execFile`.
 *
 * `execFile` (NOT a detached `spawn`) is deliberate: `JobAlertRouter`
 * (`server/src/systemJobs/jobAlertRouter.ts`) fires a detached fire-and-forget
 * `spawn` that captures NO exit code, but R4 requires the total-tier-failure
 * signal (non-zero exit → `{ delivered: false }` → error_logs). We keep a
 * SEPARATE implementation and adopt only the router's `[subject, body]` argv
 * contract so both callers invoke the script identically.
 */
export class NotifyPmNotifier implements Notifier {
  private readonly errorLogger: ErrorLogger | null;
  private readonly scriptPath: string;
  private readonly timeoutMs: number;

  constructor(opts?: {
    errorLogger?: ErrorLogger | null;
    /** Override the resolved script path (tests point this at a stub). */
    scriptPath?: string;
    timeoutMs?: number;
  }) {
    this.errorLogger = opts?.errorLogger ?? null;
    this.scriptPath = opts?.scriptPath ?? resolveNotifyPmPath();
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  notify(subject: string, body: string): Promise<{ delivered: boolean }> {
    const scriptPath = this.scriptPath;

    // Absent script → fail-open, no throw (R4). The feature is an operational
    // dependency, not a code blocker.
    if (!existsSync(scriptPath)) {
      this.errorLogger?.warn(
        `notify-pm escalation script not found at ${scriptPath} — G3 not delivered (fail-open).`,
        {
          category: SESSION_FATAL_ESCALATION_CATEGORY,
          context: { scriptPath, delivered: false },
        }
      );
      return Promise.resolve({ delivered: false });
    }

    return new Promise<{ delivered: boolean }>(resolve => {
      // Single-shot guard (mirror mcpPoller's `resolved` flag): execFile's
      // callback and the `error` event can both fire for a spawn failure.
      let settled = false;
      const safeResolve = (delivered: boolean, warnMsg?: string): void => {
        if (settled) return;
        settled = true;
        if (warnMsg) {
          this.errorLogger?.warn(warnMsg, {
            category: SESSION_FATAL_ESCALATION_CATEGORY,
            context: { delivered: false },
          });
        }
        resolve({ delivered });
      };

      // Pass subject/body as an argv ARRAY — session-derived content must never
      // be interpolated into a shell string. Forward the server's env (spread)
      // so delivery does not depend solely on the script's hardcoded
      // /home/matt/.bashrc.d secrets-source path (mis-resolves under a non-matt
      // user — see the issue-1883 directive Open Risks).
      const child = execFile(
        scriptPath,
        [subject, body],
        {
          timeout: this.timeoutMs,
          encoding: "utf-8",
          env: { ...process.env },
        },
        error => {
          if (error) {
            // Non-zero exit (1 = all tiers failed, 2 = usage), timeout, or a
            // spawn error surfaced here → not delivered.
            safeResolve(
              false,
              `notify-pm escalation did not deliver (${error.message}) — all tiers failed or timed out (fail-open).`
            );
            return;
          }
          // Exit 0 → at least one tier delivered.
          safeResolve(true);
        }
      );

      child.on("error", err => {
        safeResolve(
          false,
          `notify-pm escalation spawn failed (${err.message}) — not delivered (fail-open).`
        );
      });
    });
  }
}
