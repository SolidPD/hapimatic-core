// SPDX-License-Identifier: AGPL-3.0-only
import { formatMessageTimestamp } from "@/utils/formatMessageTimestamp";

/**
 * Loop-cron fire-time display helpers (epic #3285 round 15). Shared by the
 * System Jobs `LoopCronCard` (where they originated, #2453) and the per-session
 * `LoopCronModal`, so both surfaces print the next firing the same way.
 */

/** ms-since-epoch → the app's absolute timestamp display, or `—` for null. */
export function formatFireTime(ms: number | null): string {
  if (ms == null) return "—";
  return formatMessageTimestamp(new Date(ms));
}

/** A coarse "in Xm" / "Ns ago" relative hint (no ticking timer). */
export function formatFireRelative(ms: number | null, now: number): string {
  if (ms == null) return "—";
  const deltaS = Math.round((ms - now) / 1000);
  const ahead = deltaS >= 0;
  const s = Math.abs(deltaS);
  const unit =
    s < 90
      ? `${s}s`
      : s < 5400
        ? `${Math.round(s / 60)}m`
        : `${Math.round(s / 3600)}h`;
  return ahead ? `in ${unit}` : `${unit} ago`;
}
