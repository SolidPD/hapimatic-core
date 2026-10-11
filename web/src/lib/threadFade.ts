// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Ambient thread fade (epic #3285 round 16).
 *
 * The chat thread's scroll viewport carries a CSS `mask-image` (`.thread-fade`
 * in `index.css`) whose two soft edges are driven by CSS variables so the
 * content itself fades where it slides behind the session-info bar above and
 * the dock (prompt heading) below — no divider line, no background color to
 * match, theme-proof. The edges are SCROLL-LINKED, not constant:
 *
 *  - top   = min(scrollTop, MAX)               — 0 at the very top (nothing is
 *            hidden behind the bar, so the first line stays fully legible) and
 *            full weight after the first MAX px of scrolling;
 *  - bottom = min(distanceFromBottom, MAX)     — 0 at the very bottom (the
 *            newest line is never dimmed) and full weight once content sits
 *            below the fold.
 *
 * Both are additionally capped by the total overflow, so a thread that barely
 * overflows never fades more than it can scroll. The mask must sit on the
 * scroll VIEWPORT (the clipping element), not the scrolled content — a mask on
 * the content rides along with it and the fade leaves the screen (the first
 * r16 mockup render showed exactly that). Overlays that must stay crisp (the
 * text-size control, the scroll-position rail) live outside the viewport.
 */

/** Operator ruling 2026-09-09 (M1): 18 px. */
export const THREAD_FADE_MAX_PX = 18;

export type ThreadFade = { top: number; bottom: number };

export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function computeThreadFade(
  m: ScrollMetrics,
  max: number = THREAD_FADE_MAX_PX
): ThreadFade {
  const overflow = Math.max(0, m.scrollHeight - m.clientHeight);
  const cap = Math.min(max, overflow);
  const top = clamp(Math.round(m.scrollTop), 0, cap);
  const bottom = clamp(Math.round(overflow - m.scrollTop), 0, cap);
  return { top, bottom };
}

export const THREAD_FADE_TOP_VAR = "--thread-fade-top";
export const THREAD_FADE_BOTTOM_VAR = "--thread-fade-bottom";

/** Write the fade edges onto the viewport as CSS variables (no re-render). */
export function applyThreadFade(el: HTMLElement, fade: ThreadFade): void {
  el.style.setProperty(THREAD_FADE_TOP_VAR, `${fade.top}px`);
  el.style.setProperty(THREAD_FADE_BOTTOM_VAR, `${fade.bottom}px`);
}
