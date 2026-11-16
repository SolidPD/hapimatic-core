// SPDX-License-Identifier: AGPL-3.0-only
import { RUNNER_IDENTITY_MODES, type RunnerIdentityMode } from "@hapi/protocol";

import type { BillableMode } from "../billable/mode";

/**
 * `HAPI_RUNNER_IDENTITY` resolution (issue #6647, R9).
 *
 * - `observe` (the default, for an unset or empty value on every host): the hub
 *   records and counts what `enforce` would decide, and acts on nothing.
 * - `off`: only when the setting says so; nothing is recorded or counted.
 * - `enforce`: acts. Only a build whose `RUNNER_IDENTITY_ENFORCE_AVAILABLE` is
 *   true can enforce; elsewhere `enforce` is reported as rejected ("not in
 *   this build") and the hub runs `observe`.
 *
 * Any other value resolves to `observe` and is reported as rejected. No default
 * selects `off`, and the function reads no host, operator or tenant flag: `raw`
 * is the one input a later per-client switch feeds (#6676).
 *
 * Pure: never throws and never logs. The server entry point calls it once at
 * boot with `process.env.HAPI_RUNNER_IDENTITY`; no other module reads the
 * variable.
 */

/**
 * Whether this build can enforce. PR1 shipped it false; PR2 (Task 12) sets it
 * true, so `HAPI_RUNNER_IDENTITY=enforce` now resolves to `enforce`. No default
 * selects it: an unset value is still `observe` on every host.
 */
export const RUNNER_IDENTITY_ENFORCE_AVAILABLE = true;

export type RunnerIdentityRejectedReason = "not in this build" | "unrecognized";

export interface ResolvedRunnerIdentityMode {
  mode: RunnerIdentityMode;
  source: "env" | "default";
  /** The trimmed configured value, when it was not accepted. */
  rejectedValue?: string;
  rejectedReason?: RunnerIdentityRejectedReason;
}

function isRunnerIdentityMode(value: string): value is RunnerIdentityMode {
  return (RUNNER_IDENTITY_MODES as readonly string[]).includes(value);
}

export function resolveRunnerIdentityMode(
  raw: string | undefined,
  build: { enforceAvailable: boolean }
): ResolvedRunnerIdentityMode {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return { mode: "observe", source: "default" };
  const lowered = trimmed.toLowerCase();
  if (!isRunnerIdentityMode(lowered)) {
    return {
      mode: "observe",
      source: "default",
      rejectedValue: trimmed,
      rejectedReason: "unrecognized",
    };
  }
  if (lowered === "enforce" && !build.enforceAvailable) {
    return {
      mode: "observe",
      source: "default",
      rejectedValue: trimmed,
      rejectedReason: "not in this build",
    };
  }
  return { mode: lowered, source: "env" };
}

/** The boot line, printed beside the billable mode's. */
export function describeRunnerIdentityMode(
  resolved: ResolvedRunnerIdentityMode
): string {
  return (
    `[Server] runner identity mode=${resolved.mode} source=${resolved.source}` +
    (resolved.rejectedValue !== undefined
      ? ` rejected=${resolved.rejectedValue} (${resolved.rejectedReason})`
      : "")
  );
}

/**
 * The persisted start-up warning when billable time is `on` and the identity
 * mode is not `enforce` (the independent check's M4): a typo in the drop-in, a
 * removed drop-in or a revert of PR2 alone then shows on the Error Log page at
 * the next start. Returns the message, or null when the pair is consistent.
 */
export function pairWarning(
  billableMode: BillableMode,
  identityMode: RunnerIdentityMode
): string | null {
  if (billableMode !== "on" || identityMode === "enforce") return null;
  return (
    `billable intervals mode=on with runner identity mode=${identityMode}: ` +
    "a second process on a session can bill a live wait for a leftover " +
    "until runner identity is enforce (#6647)"
  );
}
