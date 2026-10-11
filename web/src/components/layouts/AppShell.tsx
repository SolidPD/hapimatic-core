// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, type ReactNode } from "react";
import { usePreventRubberBand } from "@/hooks/usePreventRubberBand";
import { useKeyboardPadding } from "@/hooks/useKeyboardPadding";

export interface AppShellProps {
  /**
   * Header region — rendered inside the safe-area-top wrapper (`flex-shrink-0`,
   * handles `env(safe-area-inset-top)`). Omitted entirely when null.
   */
  header?: ReactNode;
  /**
   * A full-width row rendered between the header and the content region
   * (e.g. an update bar). Not wrapped — the caller owns its box.
   */
  belowHeader?: ReactNode;
  /**
   * Content region children. The `.content-area` is `overflow-hidden`, so the
   * content region has exactly ONE scroll owner: a child scroll container the
   * children provide. The shell never scrolls.
   */
  children: ReactNode;
  /**
   * Footer region — rendered inside the `.version-footer` container
   * (`flex-shrink-0`, handles `env(safe-area-inset-bottom)`). The whole footer
   * container is omitted when null (matching "no footer content, no footer box").
   */
  footer?: ReactNode;
  /**
   * SPATIAL toggle: when true the content region fills the full width; otherwise
   * it is clamped to the readable content column (`max-w-content`) and centered.
   * Driven by the split-pane state (`useSplitView`) — a two-pane layout needs full
   * width. This is a WIDTH/spatial signal only, never an interaction or device
   * signal (see `docs/design/design-system/decision-layout-adaptation.md`, L-2).
   */
  fullWidthContent?: boolean;
  /**
   * Extra nodes rendered inside the shell root but outside the layout flow
   * (e.g. modals mounted alongside the shell). Kept last so it matches the
   * original DOM order.
   */
  overlays?: ReactNode;
}

/**
 * AppShell — the app-shell layout template (Interface Design System Sub-Issue E,
 * epic #3028). Extracted from `BrandedFrame` as a PURE, behavior-preserving shell:
 * `BrandedFrame` composes it, passing its branded header, version/feedback footer,
 * and the FeedbackModal as slots.
 *
 * Regions (top → bottom): header · below-header row · content · footer. The
 * one-scroll-owner-per-region invariant (#2830, generalized) holds here because the
 * `.content-area` is `overflow-hidden` — content children own their single scroll
 * container, and header/footer never scroll.
 *
 * 🔴 The behavior contract is NOT confined to the JSX. `web/src/index.css` keys the
 * iOS/PWA layout + keyboard-gap behavior to the LITERAL global class names
 * `.app-shell`, `.content-wrapper`, `.content-area`, `.version-footer` via
 * `html.standalone-touch:has(...)` rules, and `100dvh` lives on html/body while this
 * shell overrides its height inline from `keyboard.viewportHeight`. This component
 * MUST keep emitting those exact class names on the same elements, keep the
 * `standalone-touch` registration, the `usePreventRubberBand` wiring, and the
 * `env(safe-area-inset-*)` handling. At-rest screenshots cannot detect a break here;
 * `AppShell.test.tsx` asserts the class-name + registration contract directly.
 *
 * Adaptation is capability + window-dimension only (never device categories):
 * `useKeyboardPadding` (virtual-keyboard state), `env(safe-area-inset-*)` (safe area),
 * and the `fullWidthContent` spatial toggle. See the layout catalog at
 * `docs/design/design-system/layouts.md`.
 */
export function AppShell({
  header,
  belowHeader,
  children,
  footer,
  fullWidthContent = false,
  overlays,
}: AppShellProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const keyboard = useKeyboardPadding();

  // iOS PWA keyboard gap fix: Change body/html/app-shell background to match
  // app content when keyboard is visible. iOS pans the viewport up, revealing
  // the area below the app content. This makes that area blend seamlessly.
  // This is a React backup for the CSS :has() rules in index.css.
  useEffect(() => {
    const appBg =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--app-bg")
        .trim() || "#ffffff"; // design-tokens-allow: JS-read token empty-fallback for the keyboard-gap body background; a concrete hex is required, not a var()
    const primary =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--brand-primary")
        .trim() || "#1E0A3E"; // design-tokens-allow: JS-read token empty-fallback for the safe-area brand background; a concrete hex is required, not a var()
    const bg = keyboard.isOpen ? appBg : primary;
    document.body.style.background = bg;
    document.documentElement.style.background = bg;
    // Also update the app-shell element
    if (shellRef.current) {
      shellRef.current.style.background = keyboard.isOpen ? appBg : "";
    }
  }, [keyboard.isOpen]);

  // Prevent iOS rubber-banding via touch event interception
  usePreventRubberBand(shellRef);

  // Add standalone-touch class to <html> for CSS :has() keyboard gap rules (#739).
  // Scopes the instant CSS-based background changes to iOS/Android PWA only,
  // preventing the purple brand frame from disappearing on desktop focus.
  useEffect(() => {
    const isStandalone = window.matchMedia(
      "(display-mode: standalone)"
    ).matches;
    const isTouch = window.matchMedia("(pointer: coarse)").matches;
    if (isStandalone && isTouch) {
      document.documentElement.classList.add("standalone-touch");
    }
    return () => {
      document.documentElement.classList.remove("standalone-touch");
    };
  }, []);

  return (
    <div
      ref={shellRef}
      className="app-shell bg-[var(--brand-primary)]"
      style={
        keyboard.viewportHeight
          ? {
              // Extend 18px past visualViewport so the compact version footer
              // (18px when keyboard CSS rules active) sits behind the translucent
              // iOS keyboard accessory bar, reclaiming that space for content.
              height: `${keyboard.viewportHeight + 18}px`,
              maxHeight: `${keyboard.viewportHeight + 18}px`,
              overflow: "visible",
            }
          : undefined
      }
    >
      {/* Header region - handles safe area for iOS status bar */}
      {header != null && (
        <div className="pt-[env(safe-area-inset-top)] flex-shrink-0 bg-[var(--brand-primary)]">
          {header}
        </div>
      )}

      {/* Full-width row between header and content (e.g. the update bar). */}
      {belowHeader}

      {/* Content wrapper - thin border on sides.
          Background changes handled by BOTH:
          1. CSS :has() in index.css (instantaneous, no render delay)
          2. React class toggle (backup) */}
      <div
        className={`content-wrapper flex-1 min-h-0 flex flex-col px-1 pt-0.5 transition-colors duration-150 ${
          keyboard.isOpen ? "bg-[var(--app-bg)]" : "bg-[var(--brand-primary)]"
        }`}
      >
        {/* Content area with rounded corners.
            On wide viewports the dark rounded workspace is clamped to the content
            max-width (max-w-content) and centered, so the --brand-primary
            content-wrapper shows as a letterbox on both sides. Gated on
            !fullWidthContent because split view's two panes legitimately need full
            width; narrow (< max-w-content) viewports are unaffected (w-full fills
            below the cap).
            Corner radius: `rounded-lg` (the 8px --radius-lg token), not the old
            16px `rounded-2xl` — epic #3285 round 12 (2026-09-07). The E9 frame
            is 10px, and the session view's folder tabs sit flush on this
            panel's left edge inside its overflow clip, so the clip-free gap
            above the tabs is ≈ this radius − 2px (see ViewPicker). 16px cost a
            14px band the operator asked to reclaim; 8px lets it be 6px. */}
        <div
          className={`content-area flex-1 min-h-0 flex flex-col bg-[var(--app-bg)] overflow-hidden ${
            keyboard.isOpen ? "rounded-none" : "rounded-lg"
          } ${fullWidthContent ? "" : "mx-auto w-full max-w-content"}`}
        >
          {children}
        </div>
      </div>

      {/* Footer region - always in DOM (when present) to prevent layout shift on
          blur (#273). When keyboard is open, CSS :has() rules in index.css strip
          padding and match background to minimize footprint while keeping the
          element in flow. */}
      {footer != null && (
        <div
          className={
            /* design-tokens-allow: 3px footer padding, off the 4px spacing scale */ "version-footer px-1 py-[3px] flex-shrink-0"
          }
          style={{
            paddingBottom: "calc(3px + env(safe-area-inset-bottom, 0px))",
          }}
        >
          {footer}
        </div>
      )}

      {overlays}
    </div>
  );
}
