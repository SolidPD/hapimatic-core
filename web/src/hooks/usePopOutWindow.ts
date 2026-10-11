// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useCallback, useEffect, useRef } from "react";

type UsePopOutWindowOptions = {
  width?: number;
  height?: number;
  /**
   * When true, open() requests a near-full-height window (screen.availHeight)
   * instead of the fixed `height` default. Resolved inside open() so it never
   * reads `screen` at render time (SSR-unsafe) or churns open()'s identity.
   */
  fullHeight?: boolean;
  /** Title for the pop-out's document, shown in the window's title bar. */
  title?: string;
  onClose?: () => void;
};

export type UsePopOutWindowReturn = {
  isSupported: boolean;
  isOpen: boolean;
  container: HTMLDivElement | null;
  /**
   * Opens the pop-out. Returns `true` once the window is open and `false` when
   * the browser blocked it, so a host only collapses its inline editor for a
   * window that actually exists. Synchronous on purpose: `window.open` is only
   * allowed inside the click that triggered it, so nothing may be awaited
   * before it.
   */
  open: () => boolean;
  close: () => void;
};

/**
 * Copies all stylesheets from the current document into a pop-out window's document.
 * Handles both same-origin sheets (via cssRules) and cross-origin sheets (via link cloning).
 */
function copyStylesToWindow(popWindow: Window): void {
  // Copy stylesheets via cssRules (same-origin) or link href (cross-origin)
  for (const sheet of document.styleSheets) {
    try {
      const rules = [...sheet.cssRules].map(r => r.cssText).join("\n");
      const style = popWindow.document.createElement("style");
      style.textContent = rules;
      popWindow.document.head.appendChild(style);
    } catch (err) {
      if (err instanceof DOMException && err.name === "SecurityError") {
        // Expected: CORS-protected sheet (e.g. Google Fonts) — clone via <link>
        if (sheet.href) {
          const link = popWindow.document.createElement("link");
          link.rel = "stylesheet";
          link.href = sheet.href;
          popWindow.document.head.appendChild(link);
        }
      } else {
        console.warn("[PopOut] Unexpected error copying stylesheet:", err);
      }
    }
  }

  // Also clone any <link rel="stylesheet"> tags from <head> that may not
  // appear in document.styleSheets yet (e.g. Google Fonts preconnect chain)
  for (const el of document.querySelectorAll(
    'link[rel="stylesheet"], link[rel="preconnect"]'
  )) {
    const link = el as HTMLLinkElement;
    // Skip if already covered by the cssRules loop above
    const alreadyCopied = [
      ...popWindow.document.head.querySelectorAll("link"),
    ].some(l => l.href === link.href);
    if (!alreadyCopied) {
      popWindow.document.head.appendChild(link.cloneNode(true));
    }
  }
}

/**
 * Mirrors the theme state the app keeps on <html> at runtime, which no
 * stylesheet carries: the CSS custom properties set there (the accent palette,
 * row density) and the `data-theme` attribute. Without it a pop-out renders
 * the default accent whatever theme the user picked. Only custom properties
 * are copied — <html>'s own layout styles belong to the opener's shell.
 */
function copyRootThemeToWindow(popWindow: Window): void {
  const from = document.documentElement;
  const to = popWindow.document.documentElement;
  for (const name of Array.from(from.style)) {
    if (name.startsWith("--")) {
      to.style.setProperty(name, from.style.getPropertyValue(name));
    }
  }
  const theme = from.getAttribute("data-theme");
  if (theme !== null) to.setAttribute("data-theme", theme);
}

/**
 * usePopOutWindow — hosts an editor in its own browser window.
 *
 * The pop-out is a regular browser window (`window.open`), not a Document
 * Picture-in-Picture window: a PiP window is limited to one per tab, is
 * size-capped by the browser and can never be maximized, which rules out
 * working with the prompt, the notes and the thread on three screens. A
 * regular window can be maximized, snapped and moved to another monitor, and
 * each instance of this hook opens its own — so several editors stay popped
 * out side by side. The trade-off is that it does not float above other
 * windows.
 *
 * The caller portals its editor into `container` (created IN the pop-out's
 * document) while `isOpen`.
 */
export function usePopOutWindow(
  options: UsePopOutWindowOptions = {}
): UsePopOutWindowReturn {
  const {
    width = 640,
    height = 800,
    fullHeight = false,
    title = "",
    onClose,
  } = options;
  const [popWindow, setPopWindow] = useState<Window | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Instance-scoped ownership (R9): the specific window THIS hook instance
  // opened. Every close this hook performs goes through this ref, so it never
  // touches a window a sibling instance opened.
  const ownWindowRef = useRef<Window | null>(null);

  const isSupported =
    typeof window !== "undefined" && typeof window.open === "function";

  const isOpen = popWindow !== null;

  const open = useCallback((): boolean => {
    // R3 (full-height): resolve the requested height at open() time, not at
    // render. `fullHeight` yields a near-full-height window; the browser clamps
    // oversized values to a sane size. `||` not `??` — jsdom reports
    // screen.availHeight as 0, which we must reject in favor of the fallback.
    const requestedHeight = fullHeight
      ? window.screen?.availHeight || 900
      : height;

    // Re-opening while our own pop-out is still up: replace it.
    ownWindowRef.current?.close();

    const win = window.open(
      "",
      "",
      `popup=yes,width=${width},height=${requestedHeight}`
    );
    if (!win) {
      console.error("[PopOut] Pop-out window was blocked by the browser");
      ownWindowRef.current = null;
      setPopWindow(null);
      setContainer(null);
      return false;
    }

    // A blank window opens in quirks mode. Write a doctype so it lays out in
    // standards mode, like the app whose stylesheet it is about to receive.
    // document.write is the only synchronous way to do that (the mode is fixed
    // at parse time), and what it writes is a constant: no caller data goes
    // through it — the title is assigned as text below.
    win.document.open();
    win.document.write(
      "<!doctype html><html><head><title></title></head><body></body></html>"
    );
    win.document.close();
    win.document.title = title;

    // Copy styles + the runtime theme into the pop-out document
    copyStylesToWindow(win);
    copyRootThemeToWindow(win);

    // Create the portal container IN the pop-out document (React #12355 — must
    // be created here, not moved from parent, so event delegation works)
    const root = win.document.createElement("div");
    root.id = "pop-out-root";
    root.style.height = "100%";
    win.document.body.appendChild(root);

    // Give the pop-out a definite height chain: html → body → root. The copied
    // app stylesheet sets only a MIN-height on <html>, and a percentage height
    // resolves to `auto` against an indefinite parent — without the <html> rule
    // the root collapses to its content and the editor's textarea (a flex-1
    // child) never grows past its two default rows.
    win.document.documentElement.style.height = "100%";
    win.document.body.style.margin = "0";
    win.document.body.style.height = "100%";
    win.document.body.style.overflow = "hidden";

    // The window closing — the user's title-bar close, or our own close() —
    // reaches the consumer through this listener.
    win.addEventListener("pagehide", () => {
      // A window this instance has already replaced (re-open) must not tear
      // down the state of the window that replaced it.
      if (ownWindowRef.current !== null && ownWindowRef.current !== win) return;
      ownWindowRef.current = null;
      setPopWindow(null);
      setContainer(null);
      onCloseRef.current?.();
    });

    ownWindowRef.current = win;
    setPopWindow(win);
    setContainer(root);
    return true;
  }, [width, height, fullHeight, title]);

  // Keep the window's title current while it is open (a session rename).
  useEffect(() => {
    if (popWindow) popWindow.document.title = title;
  }, [popWindow, title]);

  const close = useCallback(() => {
    popWindow?.close();
    ownWindowRef.current = null;
    setPopWindow(null);
    setContainer(null);
  }, [popWindow]);

  // Cleanup on unmount — close ONLY the window this instance opened (R9). The
  // opener's own `pagehide` closes it too: the browser does not close a window
  // with the tab that opened it, and it would be left showing a dead editor.
  useEffect(() => {
    const closeOwn = () => ownWindowRef.current?.close();
    window.addEventListener("pagehide", closeOwn);
    return () => {
      window.removeEventListener("pagehide", closeOwn);
      closeOwn();
    };
  }, []);

  return { isSupported, isOpen, container, open, close };
}
