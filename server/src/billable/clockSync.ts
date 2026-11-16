// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";

/**
 * Whether the system clock was synchronized at this boot (issue #6651, the
 * cap's record `clockSynced`). A carried row written with a clock that runs
 * behind can fall outside the cap's window, so every carried row records what
 * the system said when it was written; the procedure after a restore reads it.
 * It is a record, not a gate: the server never waits beyond the bound and never
 * refuses to start on it.
 */
export type ClockSynced = "yes" | "no" | "unknown";

/** What the check needs from one run of the command. */
export interface ClockSyncRunResult {
  status: number | null;
  stdout: string | null;
  error?: Error;
}

function defaultRun(timeoutMs: number): ClockSyncRunResult {
  const r = spawnSync(
    "timedatectl",
    ["show", "-p", "NTPSynchronized", "--value"],
    {
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }
  );
  return { status: r.status, stdout: r.stdout, error: r.error };
}

/**
 * `timedatectl show -p NTPSynchronized --value`, bounded to `timeoutMs`: its
 * trimmed answer `yes` or `no` with exit 0 is returned as is; anything else (no
 * such command, the bound reached, a non-zero exit, other output, a throw) is
 * `unknown`. Never throws.
 */
export function readClockSynced(
  run: (timeoutMs: number) => ClockSyncRunResult = defaultRun,
  timeoutMs = 1_000
): ClockSynced {
  try {
    const r = run(timeoutMs);
    if (r.error || r.status !== 0) return "unknown";
    const answer = (r.stdout ?? "").trim();
    return answer === "yes" || answer === "no" ? answer : "unknown";
  } catch {
    return "unknown";
  }
}
