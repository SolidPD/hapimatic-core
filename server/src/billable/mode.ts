// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `HAPI_BILLABLE_INTERVALS` resolution (issue #6586, ruling D1-A).
 *
 * - `shadow` (the default, also for an unset, empty or unrecognized value): today's
 *   timer code runs unchanged and thinking intervals are recorded beside it.
 * - `on`: the session timer and `thinkingStartedAt` are derived from intervals.
 * - `off`: today's accumulation, nothing recorded.
 *
 * A typo resolves to `shadow`, because it must neither change what the timer
 * counts (`on`) nor stop recording (`off`); the rejected value is reported, as an
 * invalid `HAPI_CLAUDE_LAUNCHER` is (`shared/src/launcherResolver.ts`).
 *
 * Pure: never throws and never logs. The entry point calls it once at boot and logs
 * the result; no other module reads `HAPI_BILLABLE_INTERVALS`.
 */
export const BILLABLE_MODES = ["on", "shadow", "off"] as const;
export type BillableMode = (typeof BILLABLE_MODES)[number];

export interface ResolvedBillableMode {
  mode: BillableMode;
  source: "env" | "default";
  /** The trimmed configured value, when it was not a known mode. */
  rejectedValue?: string;
}

function isBillableMode(value: string): value is BillableMode {
  return (BILLABLE_MODES as readonly string[]).includes(value);
}

export function resolveBillableMode(
  raw: string | undefined = process.env.HAPI_BILLABLE_INTERVALS
): ResolvedBillableMode {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return { mode: "shadow", source: "default" };
  const lowered = trimmed.toLowerCase();
  if (isBillableMode(lowered)) return { mode: lowered, source: "env" };
  return { mode: "shadow", source: "default", rejectedValue: trimmed };
}
