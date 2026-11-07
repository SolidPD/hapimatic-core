// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pinch-zoom detection for the virtual-keyboard heuristics (#6213).
 *
 * Several layout hooks estimate the on-screen keyboard as
 * `innerHeight - visualViewport.height`. That estimate is only valid at a visual
 * viewport scale of 1:
 *
 * - Browser page zoom (Ctrl/Cmd + `=` `-` `0`, mouse Ctrl+wheel) resizes the layout
 *   and visual viewports together, so `scale` stays 1 and
 *   `visualViewport.height` ≈ `innerHeight`.
 * - A pinch-zoom (trackpad pinch, which Chromium delivers as Ctrl+wheel, or a
 *   touchscreen pinch) raises `scale` and shrinks `visualViewport.height` by a
 *   factor of `scale`. With an input focused that looks exactly like an open
 *   keyboard, and the shell would clamp itself to the zoomed height.
 *
 * Callers skip their keyboard estimate while this returns true. A missing viewport
 * or a missing `scale` counts as not zoomed.
 */
export const PINCH_ZOOM_SCALE_EPSILON = 0.01;

export function isPinchZoomed(
  vv: Pick<VisualViewport, "scale"> | null | undefined
): boolean {
  return Math.abs((vv?.scale ?? 1) - 1) > PINCH_ZOOM_SCALE_EPSILON;
}
