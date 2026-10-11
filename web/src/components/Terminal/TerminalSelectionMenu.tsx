// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Floating selection menu for the Terminal tab (#4516, Task 5).
 *
 * An absolutely-positioned pill rendered inside the terminal's `relative`
 * wrapper. Copy is the mint primary; Select all and Paste are secondary. Every
 * button `preventDefault()`s on pointerdown so the press never blurs the
 * terminal (R5). A pointerdown outside the pill dismisses it, except on an
 * element matching `SELECTION_KEEP_SELECTOR` — the drag handles and the key
 * bar's Copy key, which both act on the live selection and would find it
 * cleared. Paste is disabled while the terminal cannot take input.
 *
 * Edge bounding (operator feedback): the pill is clamped to stay fully inside
 * the container on all four edges — it never clips at the left/right/top. It
 * floats above the (x, y) anchor by default and flips BELOW the anchor when
 * there is no room above.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BareButton } from "@/components/ui/BareButton";

/** Marks the menu root; the touch-selection hook ignores presses inside it. */
export const SELECTION_MENU_SELECTOR = "[data-selmenu]";

/**
 * Elements outside the menu whose press must NOT dismiss it: the drag handles
 * (a grab extends the selection) and the key bar's Copy key (it copies the
 * selection on release). Dismissing clears the xterm selection immediately.
 */
export const SELECTION_KEEP_SELECTOR = "[data-selhandle], [data-selkeep]";

export interface TerminalSelectionMenuProps {
  x: number;
  y: number;
  onCopy: () => void;
  onSelectAll: () => void;
  onPaste: () => void;
  onDismiss: () => void;
  /** Disable Paste while the terminal cannot take input (detached / offline). */
  pasteDisabled?: boolean;
}

const EDGE_GAP = 8;

function clamp(n: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.max(lo, Math.min(hi, n));
}

export function TerminalSelectionMenu(props: TerminalSelectionMenuProps) {
  const { x, y, onCopy, onSelectAll, onPaste, onDismiss, pasteDisabled } =
    props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Resolved container-relative position after edge-clamping; null until measured.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // A pointerdown outside the pill dismisses it (R9). Capture phase so it runs
  // before the terminal's own handlers. Presses on SELECTION_KEEP_SELECTOR
  // targets are left to their own handlers, which need the selection intact.
  useEffect(() => {
    const onDocDown = (e: PointerEvent) => {
      const root = rootRef.current;
      const target = e.target instanceof Element ? e.target : null;
      if (!root || (target && root.contains(target))) return;
      if (target?.closest(SELECTION_KEEP_SELECTOR)) return;
      onDismiss();
    };
    document.addEventListener("pointerdown", onDocDown, true);
    return () => document.removeEventListener("pointerdown", onDocDown, true);
  }, [onDismiss]);

  // Clamp the pill inside its offset parent (the terminal container) on every
  // (x, y) change. Guarded so jsdom (zero-size rects) is a no-op.
  useLayoutEffect(() => {
    const el = rootRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return;
    const menu = el.getBoundingClientRect();
    const box = parent.getBoundingClientRect();
    if (!menu.width || !box.width) return;
    const maxLeft = box.width - menu.width - EDGE_GAP;
    const maxTop = box.height - menu.height - EDGE_GAP;
    // Centre horizontally on x; float above y, else flip below.
    let top = y - menu.height - EDGE_GAP;
    if (top < EDGE_GAP) top = y + EDGE_GAP;
    setPos({
      left: clamp(x - menu.width / 2, EDGE_GAP, maxLeft),
      top: clamp(top, EDGE_GAP, maxTop),
    });
  }, [x, y]);

  const pill =
    "touch-manipulation min-h-11 rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-button)] focus-visible:ring-inset";

  // Pre-measure: render at the raw anchor (translated) and hidden, so the
  // layout effect can measure it; post-measure: the clamped left/top.
  const style: React.CSSProperties = pos
    ? { left: `${pos.left}px`, top: `${pos.top}px` }
    : {
        left: `${x}px`,
        top: `${y}px`,
        transform: "translate(-50%, calc(-100% - 8px))",
        visibility: "hidden",
      };

  return (
    <div
      ref={rootRef}
      data-selmenu=""
      role="menu"
      aria-label="Selection actions"
      className="absolute z-20 flex items-center gap-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-1 shadow-lg"
      style={style}
    >
      <BareButton
        type="button"
        onPointerDown={e => e.preventDefault()}
        onClick={onCopy}
        aria-label="Copy"
        className={`${pill} border border-[var(--app-button)] bg-[var(--app-button)] text-[var(--app-button-text)]`}
      >
        Copy
      </BareButton>
      <BareButton
        type="button"
        onPointerDown={e => e.preventDefault()}
        onClick={onSelectAll}
        aria-label="Select all"
        className={`${pill} text-[var(--app-fg)]`}
      >
        Select all
      </BareButton>
      <BareButton
        type="button"
        onPointerDown={e => e.preventDefault()}
        onClick={onPaste}
        disabled={pasteDisabled}
        aria-label="Paste"
        className={`${pill} text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-50`}
      >
        Paste
      </BareButton>
    </div>
  );
}
