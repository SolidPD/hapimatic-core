// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared orphan-close watermark clamp (issue #2248).
 *
 * Given a raw last-observed-activity watermark (or null) and the turn's
 * `started_at_ms`, produce the strict-lower-bound close timestamp + its
 * provenance source. Single-sources the clamp policy for BOTH the live orphan
 * sweep (`TurnLifecycle.resolveOrphanClose`) and the historical backfill
 * (`backfillOrphanDurations`), so a change to the ceiling/floor rule touches one
 * place instead of two (previously duplicated with a "keep in sync" comment).
 *
 * - Floors to `startedAtMs` (duration 0) when the watermark is null, non-finite,
 *   or at/below the start — a strict lower bound; `source: "floor"`.
 * - Otherwise closes at the watermark, clamped to a 24h ceiling so a pathological
 *   clock/transcript cannot write a multi-day phantom (R6); `source: "transcript"`.
 */

/** Ceiling for an orphan-close estimate — mirrors the finalize-path duration
 *  clamp value, but is intentionally independent (an orphan estimate and a
 *  CLI-reported duration can be tuned separately). */
export const ORPHAN_MAX_SANE_DURATION_MS = 24 * 60 * 60 * 1000;

export function clampOrphanWatermark(
  rawWatermarkMs: number | null,
  startedAtMs: number
): { endedAtMs: number; source: "transcript" | "floor" } {
  if (
    rawWatermarkMs === null ||
    !Number.isFinite(rawWatermarkMs) ||
    rawWatermarkMs <= startedAtMs
  ) {
    return { endedAtMs: startedAtMs, source: "floor" };
  }
  return {
    endedAtMs: Math.min(
      rawWatermarkMs,
      startedAtMs + ORPHAN_MAX_SANE_DURATION_MS
    ),
    source: "transcript",
  };
}
