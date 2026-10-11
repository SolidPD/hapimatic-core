// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, type ReactNode, type ButtonHTMLAttributes } from "react";

type TouchButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick"
> & {
  /** The action to perform when tapped/clicked */
  onAction?: () => void;
  children: ReactNode;
};

/**
 * Button that fires on touchend (before iOS keyboard dismiss / layout shift).
 *
 * On iOS PWA, tapping a button while a keyboard is visible causes:
 *   touchstart → keyboard starts dismissing → layout shifts → click misses.
 *
 * TouchButton fires the action on touchend (which precedes the layout shift),
 * then calls preventDefault() to suppress the subsequent click event.
 * On desktop, the regular click path is used as fallback.
 *
 * Gesture detection (dx/dy < 10px) distinguishes taps from scrolls.
 */
export function TouchButton({
  onAction,
  children,
  disabled,
  type = "button",
  ...rest
}: TouchButtonProps) {
  const touchRef = useRef<{ x: number; y: number } | null>(null);
  const handledRef = useRef(false);

  return (
    <button
      {...rest}
      type={type}
      disabled={disabled}
      onTouchStart={e => {
        touchRef.current = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
        };
        handledRef.current = false;
      }}
      onTouchEnd={e => {
        if (!touchRef.current || disabled || !onAction) return;
        const t = e.changedTouches[0];
        const dx = Math.abs(t.clientX - touchRef.current.x);
        const dy = Math.abs(t.clientY - touchRef.current.y);
        touchRef.current = null;
        if (dx < 10 && dy < 10) {
          e.preventDefault();
          handledRef.current = true;
          onAction();
        }
      }}
      onClick={() => {
        if (handledRef.current) {
          handledRef.current = false;
          return;
        }
        if (!disabled) onAction?.();
      }}
    >
      {children}
    </button>
  );
}
