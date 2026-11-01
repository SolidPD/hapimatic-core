// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Title-bar node chip placement (issue #4468, epic #4460 Sub-Issue H).
 *
 * A pure, DOM-free function so the geometry is a unit table. Every value is in
 * viewport px, as read from `getBoundingClientRect()`.
 *
 * The rule (approved F5/F6 mockup): the chip's center sits at half the distance
 * from the screen's left edge to the wordmark's left edge. The back arrow and
 * the iPad Stage Manager inset are NOT inputs to that position; they only feed
 * the guards, applied in order:
 *   1. Nudge: while an obstacle (the back arrow's box; the iPad window-control
 *      zone while multitasking, ruling H-1 A) overlaps the chip, move the chip
 *      to `obstacle.right + gap`. Overlap is STRICT: a chip that only touches an
 *      obstacle is not nudged, because at 393px with a back arrow the slack is
 *      a pixel or two and any minimum-gap trigger would move it.
 *   2. Collapse: if the (nudged) chip's right edge would pass
 *      `wordmarkLeft - gap` (strict: ending exactly there still fits), render
 *      only the health dot.
 *   3. Hide: if even the dot's right edge would pass `wordmarkLeft - gap`,
 *      render nothing, because a dot drawn there would intrude on the
 *      wordmark's clearance gap or cover the wordmark and its Home link.
 */

/**
 * Width of the collapsed badge tile (`w-3.5`, NodeBadge `collapsed`): 14px at
 * the default 16px root font size, which the app never changes.
 */
export const CHIP_DOT_WIDTH = 14;

/** Clearance kept from an obstacle after a nudge, and from the wordmark. */
export const CHIP_GAP = 4;

export interface ChipObstacle {
  left: number;
  right: number;
}

export interface ChipPlacementInput {
  /** The wordmark `<Link>`'s left edge. */
  wordmarkLeft: number;
  /** The FULL (uncollapsed) badge width, from the hidden measurer. */
  chipWidth: number;
  /** The collapsed tile width. */
  dotWidth?: number;
  obstacles: readonly ChipObstacle[];
  gap?: number;
}

export interface ChipPlacement {
  /** Left edge of the element to render (the chip, or the dot when collapsed). */
  left: number;
  /** Center of that element. */
  center: number;
  nudged: boolean;
  collapsed: boolean;
  /** Render nothing: not even the dot fits left of the wordmark. */
  hidden: boolean;
}

function overlaps(left: number, width: number, o: ChipObstacle): boolean {
  return left < o.right && left + width > o.left;
}

export function computeChipPlacement({
  wordmarkLeft,
  chipWidth,
  dotWidth = CHIP_DOT_WIDTH,
  obstacles,
  gap = CHIP_GAP,
}: ChipPlacementInput): ChipPlacement {
  const naturalCenter = wordmarkLeft / 2;
  let left = naturalCenter - chipWidth / 2;
  let nudged = false;

  // Repeat until no obstacle overlaps: clearing the window-control zone can land
  // the chip on the back arrow. Each hit moves the chip strictly right of that
  // obstacle, so no obstacle is hit twice and the bound is never reached.
  for (let i = 0; i <= obstacles.length; i++) {
    const hit = obstacles.find(o => overlaps(left, chipWidth, o));
    if (!hit) break;
    left = hit.right + gap;
    nudged = true;
  }

  const limit = wordmarkLeft - gap;
  const collapsed = left + chipWidth > limit;
  if (collapsed && !nudged) {
    // A chip that was never nudged keeps the center rule as a dot. The dot is
    // inside the chip's old box, so it cannot meet an obstacle either.
    left = naturalCenter - dotWidth / 2;
  }
  const width = collapsed ? dotWidth : chipWidth;
  const hidden = collapsed && left + dotWidth > limit;

  return {
    left,
    center: left + width / 2,
    nudged,
    collapsed,
    hidden,
  };
}
