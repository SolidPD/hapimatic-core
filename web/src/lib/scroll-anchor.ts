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
 *
 * Issue #6122 adds the continuous reading anchor: `pickReadingAnchorIndex` chooses the block
 * to hold while the user is scrolled up, and `computeContentOffsetDelta` measures how far
 * content above it moved it.
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

/**
 * Index of the reading anchor among the thread's anchor candidates (issue #6122): the first
 * candidate whose top is at or below the viewport's top edge, else the last one above it,
 * else -1 when there are none.
 *
 * Candidates are in document order. In the thread's single flex column their tops never
 * decrease (a nested block sits at or below its message's top), so a binary search finds the
 * answer with about log2(count) reads; `topAt` is called lazily, so a caller can pass live
 * `getBoundingClientRect().top` reads without measuring every candidate.
 *
 * Preferring a candidate fully below the top edge means growth inside a block that straddles
 * the edge (above the reading line) still counts as growth above the anchor and is
 * compensated, the same preference the browser's own scroll anchoring has.
 */
export function pickReadingAnchorIndex(
  count: number,
  topAt: (index: number) => number,
  viewportTop: number
): number {
  if (count <= 0) return -1;
  let lo = 0;
  let hi = count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (topAt(mid) >= viewportTop - 0.5) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found === -1 ? count - 1 : found;
}

/**
 * How far content above an anchor moved it (issue #6122), from two content-relative offsets:
 * the anchor's top minus the content column's top, now and when it was last observed.
 *
 * Content-relative is the point. The user's own scrolling moves the anchor and the content
 * column together, so it never shows up here. The viewport-relative form cannot tell a user
 * scroll from a prepend, which is how the old load-older compensation undid scrolls made
 * while a page was loading. A positive result means content above grew; scrolling down by it
 * keeps the anchor where it was on screen.
 */
export function computeContentOffsetDelta(
  offsetNow: number,
  offsetAtBaseline: number
): number {
  return offsetNow - offsetAtBaseline;
}
