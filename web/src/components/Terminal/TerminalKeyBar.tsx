// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Paged, pointer-driven mobile key bar for the Terminal tab (#4516, Task 3).
 *
 * A 2×7 grid per page, paged by a horizontal pointer swipe (NOT native overflow
 * scrolling — `usePreventRubberBand` on the app shell cancels native horizontal
 * scroll on iOS, so paging is pointer math + a CSS translate). A pointerdown on
 * the key grid `preventDefault()`s so focus never leaves the terminal/compose
 * field (R5); the page dots below the grid are plain buttons. Arrows auto-repeat
 * on hold (R4), and a new press always stops an earlier key's repeat, so a
 * second finger can never strand one running. Ctrl/Alt are sticky with a
 * visible armed vs locked state (R3).
 *
 * Pointer handling is centralised on the viewport element: it captures the
 * pointer and resolves which key was pressed via `closest("[data-keyid]")`, so a
 * swipe that begins on any key still pages the bar.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { BareButton } from "@/components/ui/BareButton";
import { useDoubleTap } from "@/hooks/useDoubleTap";
import {
  KEY_META,
  KEY_PAGES,
  type KeyId,
  type ModifierId,
  type ModifierState,
} from "./terminalKeys";

const REPEAT_DELAY_MS = 350;
const REPEAT_INTERVAL_MS = 60;
/** Horizontal travel that reclassifies a press as a swipe. */
const SWIPE_CLASSIFY_PX = 24;
/** Horizontal travel on release that actually changes the page. */
const PAGE_CHANGE_PX = 40;

export interface TerminalKeyBarProps {
  disabled: boolean;
  modifiers: { ctrl: ModifierState; alt: ModifierState };
  onKey: (id: KeyId) => void;
  onModifierTap: (mod: ModifierId) => void;
  onModifierDoubleTap: (mod: ModifierId) => void;
  onPaste: () => void;
  onCopy: () => void;
}

interface Gesture {
  pointerId: number;
  keyId: KeyId | null;
  x0: number;
  y0: number;
  swiping: boolean;
  repeatFired: boolean;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Grid template: page 1 widens Paste/Copy and Ctrl/Alt (mockup A); others equal. */
function gridColumns(pageIndex: number): string {
  return pageIndex === 0
    ? "1.5fr 1.5fr repeat(5, minmax(0, 1fr))"
    : "repeat(7, minmax(0, 1fr))";
}

export function TerminalKeyBar(props: TerminalKeyBarProps) {
  const {
    disabled,
    modifiers,
    onKey,
    onModifierTap,
    onModifierDoubleTap,
    onPaste,
    onCopy,
  } = props;

  const [pageIndex, setPageIndex] = useState(0);
  const [dragDx, setDragDx] = useState(0);
  const gestureRef = useRef<Gesture | null>(null);
  const repeatTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const doubleTapFiredRef = useRef(false);

  const clearRepeat = useCallback(() => {
    if (repeatTimeout.current) {
      clearTimeout(repeatTimeout.current);
      repeatTimeout.current = null;
    }
    if (repeatInterval.current) {
      clearInterval(repeatInterval.current);
      repeatInterval.current = null;
    }
  }, []);

  // Double-tap detection for the two sticky modifiers (pointer-only, avoids the
  // single-tap double-fire — see useDoubleTap JSDoc). A fire flips a ref the
  // pointerup handler reads so it does NOT also emit a single tap.
  const ctrlDouble = useDoubleTap({
    disabled,
    onDoubleTap: () => {
      doubleTapFiredRef.current = true;
      onModifierDoubleTap("ctrl");
    },
  });
  const altDouble = useDoubleTap({
    disabled,
    onDoubleTap: () => {
      doubleTapFiredRef.current = true;
      onModifierDoubleTap("alt");
    },
  });

  const resetGesture = useCallback(() => {
    gestureRef.current = null;
    clearRepeat();
    setDragDx(0);
  }, [clearRepeat]);

  // Stop everything when the tab is hidden (R4) and on unmount.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") resetGesture();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearRepeat();
    };
  }, [resetGesture, clearRepeat]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      // R5: never let the press blur the terminal / compose textarea.
      e.preventDefault();
      // A second finger arrives while an arrow is held: stop that repeat first,
      // or its interval is orphaned and keeps writing to the shell forever.
      clearRepeat();
      const el = (e.target as HTMLElement).closest(
        "[data-keyid]"
      ) as HTMLElement | null;
      const keyId = (el?.dataset.keyid as KeyId | undefined) ?? null;
      if (e.pointerId != null) {
        try {
          e.currentTarget.setPointerCapture?.(e.pointerId);
        } catch {
          // jsdom / unsupported — capture is a best-effort nicety.
        }
      }
      doubleTapFiredRef.current = false;
      gestureRef.current = {
        pointerId: e.pointerId,
        keyId,
        x0: e.clientX,
        y0: e.clientY,
        swiping: false,
        repeatFired: false,
      };
      setDragDx(0);

      if (keyId === "ctrl") {
        ctrlDouble.onPointerDown(e);
      } else if (keyId === "alt") {
        altDouble.onPointerDown(e);
      } else if (keyId && KEY_META[keyId].kind === "repeat") {
        // Arrow hold-to-repeat: first emit after REPEAT_DELAY_MS, then every
        // REPEAT_INTERVAL_MS. A tap (release before the delay) emits once in
        // onPointerUp; a swipe cancels everything.
        repeatTimeout.current = setTimeout(() => {
          const g = gestureRef.current;
          if (!g || g.swiping) return;
          g.repeatFired = true;
          onKey(keyId);
          repeatInterval.current = setInterval(() => {
            onKey(keyId);
          }, REPEAT_INTERVAL_MS);
        }, REPEAT_DELAY_MS);
      }
    },
    [disabled, onKey, ctrlDouble, altDouble, clearRepeat]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const g = gestureRef.current;
      if (!g) return;
      const dx = e.clientX - g.x0;
      const dy = e.clientY - g.y0;
      if (
        !g.swiping &&
        Math.abs(dx) > SWIPE_CLASSIFY_PX &&
        Math.abs(dx) > Math.abs(dy)
      ) {
        g.swiping = true;
        clearRepeat(); // a swipe cancels any pending/active arrow repeat (R4)
      }
      if (g.swiping) setDragDx(dx);
    },
    [clearRepeat]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const g = gestureRef.current;
      gestureRef.current = null;
      if (e.pointerId != null) {
        try {
          e.currentTarget.releasePointerCapture?.(e.pointerId);
        } catch {
          // ignore
        }
      }
      clearRepeat();
      setDragDx(0);
      if (!g) return;

      const dx = e.clientX - g.x0;
      if (g.swiping) {
        if (Math.abs(dx) > PAGE_CHANGE_PX) {
          setPageIndex(p =>
            clamp(dx < 0 ? p + 1 : p - 1, 0, KEY_PAGES.length - 1)
          );
        }
        return;
      }

      const keyId = g.keyId;
      if (!keyId) return;
      if (keyId === "ctrl" || keyId === "alt") {
        if (!doubleTapFiredRef.current) onModifierTap(keyId);
        return;
      }
      const meta = KEY_META[keyId];
      if (meta.kind === "repeat") {
        if (!g.repeatFired) onKey(keyId); // a tap: the repeat timer never fired
        return;
      }
      if (keyId === "paste") {
        onPaste();
        return;
      }
      if (keyId === "copy") {
        onCopy();
        return;
      }
      onKey(keyId); // seq / char
    },
    [clearRepeat, onKey, onModifierTap, onPaste, onCopy]
  );

  const pageCount = KEY_PAGES.length;

  return (
    <div className={disabled ? "opacity-50" : undefined}>
      <div
        className="touch-none overflow-hidden"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={resetGesture}
        onLostPointerCapture={resetGesture}
      >
        <div
          className="flex"
          style={{
            transform: `translateX(calc(${-pageIndex * 100}% + ${dragDx}px))`,
            transition: dragDx === 0 ? "transform 200ms ease" : "none",
          }}
        >
          {KEY_PAGES.map((page, pi) => (
            <div key={pi} className="w-full shrink-0 px-3 py-2">
              {page.map((row, ri) => (
                <div
                  key={ri}
                  className="mb-1.5 grid gap-1.5 last:mb-0"
                  style={{ gridTemplateColumns: gridColumns(pi) }}
                >
                  {row.map((id, ci) =>
                    id === null ? (
                      <div key={ci} aria-hidden="true" />
                    ) : (
                      <KeyButton
                        key={id}
                        id={id}
                        disabled={disabled}
                        modifierState={
                          id === "ctrl"
                            ? modifiers.ctrl
                            : id === "alt"
                              ? modifiers.alt
                              : "off"
                        }
                      />
                    )
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-center gap-2 pb-1.5">
        {Array.from({ length: pageCount }, (_, i) => (
          <BareButton
            key={i}
            type="button"
            onClick={() => setPageIndex(i)}
            disabled={disabled}
            aria-label={`Go to page ${i + 1}`}
            aria-current={i === pageIndex ? "true" : undefined}
            className="touch-manipulation p-1"
          >
            <span
              className={`block h-2 w-2 rounded-full ${
                i === pageIndex
                  ? "bg-[var(--app-button)]"
                  : "bg-[var(--app-border)]"
              }`}
            />
          </BareButton>
        ))}
      </div>
    </div>
  );
}

/**
 * One key. Pointer activation is handled by the parent viewport (so a swipe from
 * any key pages the bar), so this is a styled, labelled button with a stable
 * `data-keyid` and no own pointer handlers. `title` is passed only when enabled
 * (a disabled BareButton with a truthy title takes the inert-tooltip path).
 */
function KeyButton(props: {
  id: KeyId;
  disabled: boolean;
  modifierState: ModifierState;
}) {
  const { id, disabled, modifierState } = props;
  const meta = KEY_META[id];
  const isModifier = meta.kind === "modifier";
  const isAction = meta.kind === "action";
  // Mint "primary" treatment for Paste/Copy and an armed/locked modifier.
  const primary = isAction || (isModifier && modifierState !== "off");
  const locked = isModifier && modifierState === "locked";

  const base =
    "touch-manipulation flex min-h-11 items-center justify-center rounded-md border px-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-button)] focus-visible:ring-inset disabled:cursor-not-allowed";
  const tone = primary
    ? "border-[var(--app-button)] bg-[var(--app-button)] text-[var(--app-button-text)]"
    : "border-[var(--app-border)] bg-[var(--app-secondary-bg)] text-[var(--app-fg)]";
  const lockMark = locked ? " underline underline-offset-2" : "";

  return (
    <BareButton
      type="button"
      data-keyid={id}
      // Copy reads the live selection on release, so pressing it must not
      // trigger the selection menu's outside-press dismiss (SELECTION_KEEP_SELECTOR).
      data-selkeep={id === "copy" ? "" : undefined}
      disabled={disabled}
      aria-label={meta.ariaLabel}
      aria-pressed={
        isModifier
          ? modifierState === "locked"
            ? "mixed"
            : modifierState === "armed"
              ? "true"
              : "false"
          : undefined
      }
      title={disabled ? undefined : meta.ariaLabel}
      className={`${base} ${tone}${lockMark}`}
    >
      {meta.label}
    </BareButton>
  );
}
