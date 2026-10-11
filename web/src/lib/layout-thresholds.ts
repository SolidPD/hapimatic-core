// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Named layout thresholds — the shared width vocabulary for the layout templates
 * (`web/src/components/layouts/`), Sub-Issue E of the Interface Design System
 * (epic #3028).
 *
 * These are the ONLY two places width is a legitimate layout input, per Sub A's
 * decision record (`docs/design/design-system/decision-layout-adaptation.md`):
 *
 *   - Rule L-1 — never key on named device categories (no isPhone/isTablet/isDesktop).
 *   - Rule L-2 — never infer INTERACTION behavior from viewport width alone.
 *     Width decides SPATIAL layout only (how wide the readable column is, whether a
 *     second pane fits); interaction (target size, hover, keyboard avoidance,
 *     safe-area) is decided by measured input CAPABILITIES via the platform hooks
 *     (`usePlatform` / `useSplitView` / `useIPadMultitasking` / `useKeyboardPadding`).
 *
 * Templates reference these NAMED thresholds rather than inline literals so the
 * value lives in one place. Where a runtime authority already owns the value, this
 * module points at it rather than forking a second definition:
 *
 *   - CONTENT_MAX_WIDTH mirrors `tailwind.config.ts` `maxWidth.content` (the
 *     `max-w-content` utility) and `--content-width` (`web/src/design/tokens.css`);
 *     the Tailwind config stays authoritative for the utility.
 *   - SPLIT_MIN_WIDTH is the single source consumed by `useSplitView` (which owns
 *     the runtime `matchMedia` gating).
 */

/**
 * Readable content-column width (px). The app-wide max readable width used by
 * SessionChat, `sessions/*`, `settings/*`, and the app shell. Mirrors
 * `max-w-content` / `--content-width` (1024px; widened from 720px by #3455 so a
 * desktop window is no longer letterboxed to a narrow column).
 * `classification: design-system-precedent`.
 */
export const CONTENT_MAX_WIDTH = 1024;

/**
 * Split-view eligibility width (px). Below this the two-pane layout does not fit,
 * so split view is disabled and force-collapsed. `useSplitView` gates on this via
 * `matchMedia("(min-width: <SPLIT_MIN_WIDTH>px)")`. Raised from 786 to a round
 * 800 (operator request 2026-10-06) so the disabled title-bar toggle's tip can
 * name the exact cutoff. `classification: design-system-precedent`.
 */
export const SPLIT_MIN_WIDTH = 800;
