// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, type RefObject } from "react";

/**
 * Keyboard-aware focus positioning for the Create form (mobile/PWA).
 *
 * ONE deterministic rule for where a tapped field lands, replacing the seven
 * per-component `scrollIntoView` focus handlers that previously coexisted
 * (LinkIssueField, IntervalPicker, SessionIdentitySection, PromptTextarea,
 * InstructionsTextarea, ExclusionListEditor, ScheduleLifetimePicker,
 * EventTimingSection). Those all centered in the LAYOUT viewport, which
 * ignores the keyboard — with the keyboard up, "center" is at/under the
 * keyboard edge, so the cursor landed somewhere different per field.
 *
 * The rule, applied via a single `focusin` listener on the scrollable
 * section stack:
 * - Text-entry fields (inputs/textareas) → centered in the VISIBLE area
 *   (the visualViewport: the space remaining above the virtual keyboard).
 * - Selects → biased to the upper third, leaving room BELOW the field for
 *   the picker/dropdown to open (no keyboard appears for these).
 *
 * Timing: text fields wait for the keyboard to settle (a visualViewport
 * `resize` + debounce), with a timer fallback for desktop/hardware-keyboard
 * cases where no resize ever fires. Selects position promptly.
 */

/** Fraction of the visible height where a text field's center lands. */
export const TEXT_FIELD_BIAS = 0.5;
/** Selects sit higher so their dropdown has room to render below. */
export const SELECT_FIELD_BIAS = 0.3;

/** Input types that never summon a keyboard/picker worth repositioning for. */
const EXCLUDED_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "range",
  "file",
  "color",
  "hidden",
]);

/**
 * Scroll delta (px) that moves a field's center to `bias` of the visible
 * area. Pure — exported for unit tests. Rects are layout-viewport-relative;
 * the visible area starts at `vvTop` (visualViewport.offsetTop — iOS pans
 * the layout viewport when the keyboard opens, so 0 must not be assumed).
 */
export function computeFocusScrollDelta(args: {
  fieldTop: number;
  fieldHeight: number;
  vvTop: number;
  vvHeight: number;
  bias: number;
}): number {
  const fieldCenter = args.fieldTop + args.fieldHeight / 2;
  const target = args.vvTop + args.vvHeight * args.bias;
  return Math.round(fieldCenter - target);
}

export function useKeyboardAwareFieldFocus(
  containerRef: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let vvHandler: (() => void) | null = null;

    const clearPending = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (vvHandler) {
        window.visualViewport?.removeEventListener("resize", vvHandler);
        vvHandler = null;
      }
    };

    const onFocusIn = (e: Event) => {
      const el = e.target;
      const isSelect = el instanceof HTMLSelectElement;
      const isText =
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLInputElement && !EXCLUDED_INPUT_TYPES.has(el.type));
      if (!isSelect && !isText) return;

      const scrollToTarget = () => {
        clearPending();
        if (!el.isConnected) return;
        const vv = window.visualViewport;
        const rect = el.getBoundingClientRect();
        const delta = computeFocusScrollDelta({
          fieldTop: rect.top,
          fieldHeight: rect.height,
          vvTop: vv?.offsetTop ?? 0,
          vvHeight: vv?.height ?? window.innerHeight,
          bias: isSelect ? SELECT_FIELD_BIAS : TEXT_FIELD_BIAS,
        });
        if (Math.abs(delta) > 4) {
          container.scrollBy({ top: delta, behavior: "smooth" });
        }
      };

      clearPending();
      if (isSelect) {
        timer = setTimeout(scrollToTarget, 50);
        return;
      }
      // Text entry: reposition once the keyboard settles. Each keyboard
      // animation frame fires a visualViewport resize; debounce past the
      // last one. The 400ms timer is the no-resize fallback AND the upper
      // bound when resizes do fire (the debounce replaces it).
      const vv = window.visualViewport;
      if (vv) {
        vvHandler = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(scrollToTarget, 80);
        };
        vv.addEventListener("resize", vvHandler);
      }
      timer = setTimeout(scrollToTarget, 400);
    };

    container.addEventListener("focusin", onFocusIn);
    return () => {
      clearPending();
      container.removeEventListener("focusin", onFocusIn);
    };
  }, [containerRef]);
}
