// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Touch selection for the Terminal tab (#4516, Task 5; extended per operator
 * ruling R2-4 with iOS-style double-tap-word selection + drag handles).
 *
 * xterm has no touch selection (xtermjs/xterm.js#5377 is still open), so the app
 * drives it through xterm's PUBLIC selection API only (never `_core`):
 *  - a ~500 ms long-press selects the logical line under the finger (joining
 *    wrapped rows), and dragging extends it;
 *  - a double-tap selects the WORD under the finger (iOS-style);
 *  - two drag handles (rendered by the page from `handles`) extend either end,
 *    and follow the finger while dragged;
 *  - release opens a floating menu, and that touch's touchend is cancelled so
 *    the browser's compatibility mousedown cannot reach xterm and clear the
 *    selection.
 * The mouse keeps xterm's own drag selection and the browser's right-click menu
 * — the pointer listeners act on `touch`/`pen` only, and `contextmenu` is
 * cancelled only while a touch gesture is in progress (the long-press callout).
 * Presses inside the menu (`SELECTION_MENU_SELECTOR`) are the menu's own.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { SELECTION_MENU_SELECTOR } from "./TerminalSelectionMenu";

const LONG_PRESS_MS = 500;
/** Movement before the long-press fires that reclassifies the gesture as scroll. */
const MOVE_CANCEL_PX = 8;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DIST_PX = 24;

export interface TouchSelectionMenu {
  x: number;
  y: number;
}

/** Container-relative pixel positions of the selection's two drag handles. */
export interface TouchSelectionHandles {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface UseTerminalTouchSelectionOptions {
  terminalRef: React.RefObject<Terminal | null>;
  containerRef: React.RefObject<HTMLElement | null>;
  enabled: boolean;
}

export interface UseTerminalTouchSelectionResult {
  /** Container-relative pixel position of the floating menu, or null when closed. */
  menu: TouchSelectionMenu | null;
  /** Drag-handle positions for the active selection, or null when none. */
  handles: TouchSelectionHandles | null;
  /** Close the menu and clear the xterm selection (also called on #4517 re-attach). */
  dismiss: () => void;
  /** Open the menu + handles at the current selection (used by Copy's select-all path). */
  openAtSelection: () => void;
}

type GestureMode = "none" | "longpress" | "word" | "handle";

interface GestureState {
  active: boolean;
  dragging: boolean; // actively extending the selection
  mode: GestureMode;
  x0: number;
  y0: number;
  anchorRow: number;
  anchorCol: number;
  timer: ReturnType<typeof setTimeout> | null;
  lastTapT: number;
  lastTapX: number;
  lastTapY: number;
  // Set when a gesture ends by opening the menu: the matching touchend is
  // cancelled so the browser emits no compatibility mousedown/click for it.
  suppressMouse: boolean;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function isSpace(ch: string): boolean {
  return ch === "" || ch === " " || ch === "\t" || ch === " ";
}

export function useTerminalTouchSelection(
  options: UseTerminalTouchSelectionOptions
): UseTerminalTouchSelectionResult {
  const { terminalRef, containerRef, enabled } = options;
  const [menu, setMenuState] = useState<TouchSelectionMenu | null>(null);
  const [handles, setHandles] = useState<TouchSelectionHandles | null>(null);
  // The listener effect reads the menu through this ref, never through `menu`:
  // with `menu` in the effect's dependencies, closing the menu on a pointerdown
  // re-ran the effect, whose cleanup cancelled the long-press timer the same
  // pointerdown had just armed. The ref is the authority; the state renders it.
  const menuRef = useRef<TouchSelectionMenu | null>(null);
  const setMenu = useCallback((next: TouchSelectionMenu | null) => {
    menuRef.current = next;
    setMenuState(next);
  }, []);
  const gesture = useRef<GestureState>({
    active: false,
    dragging: false,
    mode: "none",
    x0: 0,
    y0: 0,
    anchorRow: 0,
    anchorCol: 0,
    timer: null,
    lastTapT: 0,
    lastTapX: 0,
    lastTapY: 0,
    suppressMouse: false,
  });

  const clearTimer = useCallback(() => {
    const g = gesture.current;
    if (g.timer) {
      clearTimeout(g.timer);
      g.timer = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    setMenu(null);
    setHandles(null);
    try {
      terminalRef.current?.clearSelection();
    } catch {
      // terminal gone — nothing to clear.
    }
  }, [terminalRef, setMenu]);

  // Map a client (x, y) to an absolute buffer cell using the .xterm-screen rect.
  const toCell = useCallback(
    (clientX: number, clientY: number): { col: number; row: number } | null => {
      const terminal = terminalRef.current;
      const screen = terminal?.element?.querySelector(
        ".xterm-screen"
      ) as HTMLElement | null;
      if (!terminal || !screen) return null;
      const rect = screen.getBoundingClientRect();
      const cols = terminal.cols || 1;
      const rows = terminal.rows || 1;
      const cellW = rect.width / cols;
      const cellH = rect.height / rows;
      if (!cellW || !cellH) return null;
      const col = clamp(Math.floor((clientX - rect.left) / cellW), 0, cols - 1);
      const viewRow = clamp(
        Math.floor((clientY - rect.top) / cellH),
        0,
        rows - 1
      );
      const viewportY = terminal.buffer.active.viewportY;
      return { col, row: viewRow + viewportY };
    },
    [terminalRef]
  );

  // Convert the current xterm selection's endpoints from buffer cells to
  // container-relative pixels. No clamping here — the menu component does its
  // own edge-clamp. Returns null when there is no selection (or no layout yet).
  const selectionAnchors = useCallback((): TouchSelectionHandles | null => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    if (!terminal || !container) return null;
    const pos = terminal.getSelectionPosition();
    const screen = terminal.element?.querySelector(
      ".xterm-screen"
    ) as HTMLElement | null;
    if (!pos || !screen) return null;
    const rect = screen.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();
    const cellW = rect.width / (terminal.cols || 1);
    const cellH = rect.height / (terminal.rows || 1);
    const viewportY = terminal.buffer.active.viewportY;
    const toPx = (col: number, row: number, bottom: boolean) => ({
      x: rect.left + col * cellW - cRect.left,
      y:
        rect.top + (row - viewportY) * cellH + (bottom ? cellH : 0) - cRect.top,
    });
    return {
      start: toPx(pos.start.x, pos.start.y, false),
      end: toPx(pos.end.x, pos.end.y, true),
    };
  }, [terminalRef, containerRef]);

  // Open the menu + handles at the current selection, or close both if there is
  // none.
  const openAtSelection = useCallback(() => {
    try {
      const anchors = selectionAnchors();
      setMenu(anchors ? { x: anchors.end.x, y: anchors.end.y } : null);
      setHandles(anchors);
    } catch {
      // getSelectionPosition unavailable — close rather than show stale anchors.
      setMenu(null);
      setHandles(null);
    }
  }, [selectionAnchors, setMenu]);

  // Move the handles to the selection while one is dragged (the menu stays
  // closed until release).
  const syncHandles = useCallback(() => {
    try {
      setHandles(selectionAnchors());
    } catch {
      // getSelectionPosition unavailable — keep the handles where they are.
    }
  }, [selectionAnchors]);

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;

    container.style.setProperty("-webkit-touch-callout", "none");

    const extendTo = (col: number, row: number) => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      const g = gesture.current;
      const cols = terminal.cols || 1;
      const anchorLinear = g.anchorRow * cols + g.anchorCol;
      const curLinear = row * cols + col;
      if (curLinear >= anchorLinear) {
        terminal.select(g.anchorCol, g.anchorRow, curLinear - anchorLinear + 1);
      } else {
        terminal.select(col, row, anchorLinear - curLinear + 1);
      }
    };

    const beginLineSelection = () => {
      const terminal = terminalRef.current;
      const g = gesture.current;
      if (!terminal) return;
      const cell = toCell(g.x0, g.y0);
      if (!cell) return;
      const buffer = terminal.buffer.active;
      let top = cell.row;
      while (top > 0 && buffer.getLine(top)?.isWrapped) top--;
      let bottom = cell.row;
      while (buffer.getLine(bottom + 1)?.isWrapped) bottom++;
      terminal.selectLines(top, bottom);
      g.dragging = true;
      g.anchorRow = top;
      g.anchorCol = 0;
    };

    const selectWord = (col: number, row: number) => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      const line = terminal.buffer.active.getLine(row);
      const text = line?.translateToString(false) ?? "";
      if (!text || isSpace(text[col] ?? "")) return;
      let start = col;
      while (start > 0 && !isSpace(text[start - 1])) start--;
      let end = col;
      while (end < text.length - 1 && !isSpace(text[end + 1])) end++;
      terminal.select(start, row, end - start + 1);
      const g = gesture.current;
      g.anchorRow = row;
      g.anchorCol = start;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
      const g = gesture.current;
      g.suppressMouse = false; // a stale flag from a touch with no touchend
      const target = e.target instanceof Element ? e.target : null;

      // A tap on the menu belongs to the menu (Copy / Select all / Paste). The
      // menu is rendered inside this container, so without this check the tap
      // counted as a new terminal tap and dismissed the selection first.
      if (target?.closest(SELECTION_MENU_SELECTOR)) return;

      // Grabbing a drag handle: extend from the OPPOSITE endpoint. The menu
      // hides while the handle is dragged and reopens at the new end on release.
      const handleEl = target?.closest<HTMLElement>("[data-selhandle]") ?? null;
      if (handleEl) {
        const terminal = terminalRef.current;
        const pos = terminal?.getSelectionPosition();
        if (pos) {
          const which = handleEl.dataset.selhandle;
          g.active = true;
          g.dragging = true;
          g.mode = "handle";
          g.anchorRow = which === "start" ? pos.end.y : pos.start.y;
          g.anchorCol = which === "start" ? pos.end.x : pos.start.x;
          setMenu(null);
          e.preventDefault();
        }
        return;
      }

      // Double-tap → word selection.
      const now = Date.now();
      const near =
        Math.abs(e.clientX - g.lastTapX) < DOUBLE_TAP_DIST_PX &&
        Math.abs(e.clientY - g.lastTapY) < DOUBLE_TAP_DIST_PX;
      if (g.lastTapT !== 0 && now - g.lastTapT < DOUBLE_TAP_MS && near) {
        g.lastTapT = 0;
        if (menuRef.current) setMenu(null);
        const cell = toCell(e.clientX, e.clientY);
        if (cell) selectWord(cell.col, cell.row);
        g.active = true;
        g.dragging = false;
        g.mode = "word";
        return;
      }

      // Single tap / long-press start.
      g.lastTapT = now;
      g.lastTapX = e.clientX;
      g.lastTapY = e.clientY;
      if (menuRef.current) dismiss();
      clearTimer();
      g.active = true;
      g.dragging = false;
      g.mode = "longpress";
      g.x0 = e.clientX;
      g.y0 = e.clientY;
      g.timer = setTimeout(beginLineSelection, LONG_PRESS_MS);
    };

    const onPointerMove = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g.active) return;
      if (g.dragging) {
        const cell = toCell(e.clientX, e.clientY);
        if (cell) extendTo(cell.col, cell.row);
        if (g.mode === "handle") syncHandles();
        return;
      }
      if (g.mode === "longpress") {
        const dx = e.clientX - g.x0;
        const dy = e.clientY - g.y0;
        if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) clearTimer(); // a scroll, not a hold
      }
    };

    const endGesture = () => {
      const terminal = terminalRef.current;
      const g = gesture.current;
      clearTimer();
      let hadSelection = false;
      try {
        hadSelection = !!terminal?.hasSelection();
      } catch {
        hadSelection = false;
      }
      if (
        (g.dragging || g.mode === "word" || g.mode === "handle") &&
        hadSelection
      ) {
        openAtSelection();
        g.suppressMouse = true;
      }
      g.active = false;
      g.dragging = false;
      g.mode = "none";
    };

    // Non-passive touchmove: block xterm viewport scroll while extending.
    const onTouchMove = (e: TouchEvent) => {
      if (gesture.current.dragging) e.preventDefault();
    };
    // After a touch ends a selection gesture, the browser would follow its
    // touchend with compatibility mousedown/mouseup/click. xterm takes that
    // mousedown as a fresh click and clears the selection the menu was just
    // opened for. Cancelling this one touchend suppresses them; plain taps
    // (tap-to-focus) keep their mouse events.
    const onTouchEnd = (e: TouchEvent) => {
      const g = gesture.current;
      if (!g.suppressMouse) return;
      g.suppressMouse = false;
      if (e.cancelable) e.preventDefault();
    };
    // Cancel the long-press callout / context menu only for touch and pen. A
    // mouse right-click keeps the browser menu (xterm's right-click Copy/Paste).
    const onContextMenu = (e: Event) => {
      const pointerType = (e as PointerEvent).pointerType;
      if (
        gesture.current.active ||
        pointerType === "touch" ||
        pointerType === "pen"
      ) {
        e.preventDefault();
      }
    };

    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", endGesture);
    container.addEventListener("pointercancel", endGesture);
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd, { passive: false });
    container.addEventListener("contextmenu", onContextMenu);

    return () => {
      clearTimer();
      container.style.removeProperty("-webkit-touch-callout");
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", endGesture);
      container.removeEventListener("pointercancel", endGesture);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("contextmenu", onContextMenu);
    };
  }, [
    enabled,
    containerRef,
    terminalRef,
    toCell,
    clearTimer,
    dismiss,
    openAtSelection,
    syncHandles,
    setMenu,
  ]);

  return { menu, handles, dismiss, openAtSelection };
}
