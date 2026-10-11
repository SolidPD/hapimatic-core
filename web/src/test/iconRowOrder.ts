// SPDX-License-Identifier: AGPL-3.0-only
// Shared guard for the `.icon-col-N` document-order invariant (#2377).
//
// `.icon-col-N` is `position: absolute` with `right: calc(var(--icon-slot) * (N-1))`
// (`web/src/index.css:429-462`), so a HIGHER N paints FURTHER LEFT. A row therefore
// traverses left-to-right under Tab only when its slots are emitted in DESCENDING N.
// `index.css:416-419` documents that convention with a worked example — but nothing
// enforced it, and two of the five `icon-row` consumers had silently diverged, which
// is a WCAG 2.4.3 Focus Order (Level A) failure, not a cosmetic one.
//
// The defect is invisible to every existing tier because it lives in the RELATIONSHIP
// between document order and paint order, and nothing observed both at once: a reviewer
// reading JSX sees `col-1, col-4, col-3, col-2` with no visual cue; a screenshot shows
// four correctly-spaced buttons with no DOM cue; the type checker and linter see
// `string`; and jsdom has no layout engine.
//
// Document order, however, is exactly what jsdom models perfectly — which is why this
// small reader is a complete guard and no browser or layout engine is required.
//
// SIBLING GUARD — `scripts/check-icon-col-registry.ts` (#2366) covers the ADJACENT
// half of this invariant: whether an `icon-col-N` class referenced in source has a
// matching rule in `index.css` AT ALL. That check is static, so it reaches all five
// `icon-row` consumers — including `router.tsx`, which has no colocated test file to
// host an assertion like this one. This module covers rendered order and uniqueness,
// but only for the four rows that do. Neither guard subsumes the other.
//
// That script does NOT import this module — it runs under Bun with no `vitest` and no
// `HTMLElement` — but it deliberately mirrors the slot-parsing semantics below. Keep
// the two patterns in step if either changes.

import { expect } from "vitest";

// Anchored so the SUBSTRING selector below cannot capture a bogus slot, and `\d+` so a
// hypothetical 10th slot is not silently truncated to `1`.
const ICON_COL_CLASS = /(?:^|\s)icon-col-(\d+)(?:\s|$)/;

/**
 * Read the `.icon-col-N` slot numbers of an icon row in DOM (document) order.
 *
 * Hardening notes:
 * - The `[class*="icon-col-"]` selector is a SUBSTRING match and real slots are
 *   multi-class (`"icon-col-1 relative group/notes"`), so the pattern is
 *   word-boundary-anchored — a future `icon-col-wrapper`-style class is not a slot.
 * - `getAttribute("class")` rather than `.className` — on an SVG element `.className`
 *   is an `SVGAnimatedString`, not a string.
 * - `flatMap` with a guarded match rather than a `!` non-null assertion — non-matches
 *   are dropped instead of throwing.
 */
export function iconColOrder(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll('[class*="icon-col-"]')).flatMap(
    el => {
      const m = (el.getAttribute("class") ?? "").match(ICON_COL_CLASS);
      return m ? [Number(m[1])] : [];
    }
  );
}

/**
 * Assert that an icon row emits its slots in strictly descending N, so that keyboard
 * focus traverses the row in painted left-to-right order.
 *
 * @param expectedSlotCount When given, asserts the row rendered exactly this many
 *   slots. Pass it whenever a row's defect only manifests in one configuration — e.g.
 *   `SessionHeader` is already correct in its 4- and 5-slot shapes and only diverges
 *   at 6 slots, so an assertion that does not pin the count can pass before AND after
 *   the fix and guard nothing. Omitted, only the anti-vacuity floor below applies.
 */
export function expectDescendingIconCols(
  container: HTMLElement,
  expectedSlotCount?: number
): void {
  const cols = iconColOrder(container);

  // Anti-vacuity: a 0- or 1-element array is trivially sorted, so a render that
  // produced no icons at all (a stubbed-out child, a collapsed branch) would pass
  // the ordering assertion silently.
  expect(cols.length).toBeGreaterThan(1);
  if (expectedSlotCount !== undefined) {
    expect(cols).toHaveLength(expectedSlotCount);
  }

  // No duplicate N. A repeated slot number is not a harmless tie: both slots resolve
  // to the same `right: calc(var(--icon-slot) * (N-1))` and paint at the SAME offset,
  // stacking one icon on top of the other and leaving the lower one unclickable —
  // the #2366 failure mode, reached by exactly the mistake that caused #2377 (copy a
  // slot block, forget to renumber). Asserted separately from the ordering check
  // below so a failure names the actual fault instead of reporting a sort mismatch.
  expect(new Set(cols).size).toBe(cols.length);

  // STRICTLY descending. Note the two assertions are jointly necessary: plain
  // sort-equality alone treats [4, 4, 3] as correctly sorted, so without the
  // uniqueness check above this would be a non-increasing check wearing a strictly-
  // descending label.
  expect(cols).toEqual([...cols].sort((a, b) => b - a));
}
