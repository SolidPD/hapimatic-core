// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure helpers for restoring a viewport's scroll position around a re-layout
 * (issue #3158).
 *
 * The chat viewport disables the browser's native scroll anchoring
 * (`overflowAnchor: "none"`) so it can own programmatic scrolling (#2858), which
 * means any layout-changing event — notably a text-size change — must re-anchor
 * explicitly. This module holds only the arithmetic, DOM-free (it takes measured
 * numbers, not elements), so it is unit-testable under jsdom, which performs no
 * layout. The DOM-touching capture/restore lives in `HappyThread.tsx`.
 */

export interface AnchorRestoreInput {
  /** The anchor element's current `getBoundingClientRect().top` (CSS px). */
  anchorTopNow: number;
  /** The viewport element's current `getBoundingClientRect().top` (CSS px). */
  viewportTopNow: number;
  /**
   * The anchor's viewport-relative offset (`anchorTop - viewportTop`) captured
   * BEFORE the layout change. May be negative when the viewport top cuts into
   * the anchor element (its top is scrolled just above the viewport top).
   */
  targetOffset: number;
  /**
   * The anchor element's height at capture (CSS px). Provide together with
   * {@link anchorHeightNow} to scale `targetOffset` by `heightNow /
   * heightCaptured`, preserving the SAME fraction of the anchor (the same visual
   * line) at the viewport top even when the anchor's own height changes with the
   * font size. This matters when the viewport top cuts deep into a TALL block: a
   * raw pixel offset would push a shrunk block off-screen (top-line miss), while
   * the scaled offset keeps the reader on the same line. Omit (or pass a
   * non-positive height) to anchor to the raw pixel offset.
   */
  anchorHeightCaptured?: number;
  /** The anchor element's height now, after the re-layout (CSS px). */
  anchorHeightNow?: number;
}

/**
 * Compute the `scrollBy({ top })` delta (CSS px) that returns a captured anchor
 * element to its recorded viewport-relative offset after a re-layout.
 *
 * A positive result scrolls the viewport down (content above the anchor grew, so
 * the anchor must move back up); a negative result scrolls up (content above the
 * anchor shrank); zero means the anchor is already at its captured offset.
 *
 * When both `anchorHeightCaptured` and `anchorHeightNow` are supplied and
 * positive, `targetOffset` is scaled by the height ratio so a deep cut into a
 * tall block preserves the reader's line rather than the raw pixel depth.
 *
 * Only relative positions matter — the result is invariant to the absolute page
 * coordinates of the anchor and viewport.
 */
export function computeAnchorRestoreDelta({
  anchorTopNow,
  viewportTopNow,
  targetOffset,
  anchorHeightCaptured,
  anchorHeightNow,
}: AnchorRestoreInput): number {
  let offset = targetOffset;
  if (
    anchorHeightCaptured !== undefined &&
    anchorHeightNow !== undefined &&
    anchorHeightCaptured > 0 &&
    anchorHeightNow > 0
  ) {
    offset = targetOffset * (anchorHeightNow / anchorHeightCaptured);
  }
  return anchorTopNow - viewportTopNow - offset;
}
