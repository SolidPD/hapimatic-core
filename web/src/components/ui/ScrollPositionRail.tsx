// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState, type RefObject } from "react";
import { cn } from "@/lib/utils";

/** How long after the last USER scroll gesture the rail stays visible. */
export const SCROLL_RAIL_IDLE_HIDE_MS = 900;
/** Floor for the thumb so a very long document still shows a visible marker. */
export const SCROLL_RAIL_MIN_THUMB_PX = 24;
/** Rail width (the approved option-B mockup: a 3px hairline rail). */
export const SCROLL_RAIL_WIDTH_PX = 3;

type RailGeometry = {
  /** Rail box in the offsetParent's coordinate space — flush with the scroll
   *  element's RIGHT edge, so it also works for a pane that does not span its
   *  positioned ancestor (split-view panes A / B). */
  top: number;
  left: number;
  height: number;
  thumbTop: number;
  thumbHeight: number;
  overflow: boolean;
};

function measure(el: HTMLElement): RailGeometry {
  const {
    scrollTop,
    scrollHeight,
    clientHeight,
    offsetTop,
    offsetLeft,
    offsetWidth,
    offsetHeight,
  } = el;
  const overflow = scrollHeight > clientHeight + 1;
  const track = offsetHeight;
  const thumbHeight = overflow
    ? Math.min(
        track,
        Math.max(
          SCROLL_RAIL_MIN_THUMB_PX,
          (clientHeight / scrollHeight) * track
        )
      )
    : 0;
  const maxScroll = scrollHeight - clientHeight;
  const thumbTop =
    overflow && maxScroll > 0
      ? (Math.min(scrollTop, maxScroll) / maxScroll) * (track - thumbHeight)
      : 0;
  return {
    top: offsetTop,
    left: offsetLeft + offsetWidth - SCROLL_RAIL_WIDTH_PX,
    height: track,
    thumbTop,
    thumbHeight,
    overflow,
  };
}

/**
 * ScrollPositionRail (epic #3285 round 14, item 1 / option B) — a 3px accent
 * position rail overlaid on the right edge of a scroll container whose native
 * scrollbar is hidden (`.scrollbar-none`, index.css).
 *
 * - **Read-only.** It observes `scroll` + size changes and never scrolls the
 *   element, so it cannot join the snap-vs-drag fight HappyThread settled
 *   (#710 → #1298 → #2414) — programmatic follow-mode scrolls update the thumb
 *   silently; only a USER gesture (wheel / touch / pointer / keyboard) reveals it.
 * - **Zero layout cost.** Absolutely positioned + `pointer-events-none`; it
 *   places itself over the scroll element's box (offsetTop/offsetHeight against
 *   the nearest positioned ancestor), so it can sit as any sibling under a
 *   `relative` parent. Renders nothing when the content does not overflow.
 * - **Why not the Radix `ScrollArea` primitive:** the chat thread's scroll owner
 *   is assistant-ui's `ThreadPrimitive.Viewport`, which cannot be re-parented
 *   into `ScrollArea.Viewport` without handing assistant-ui a second scroll
 *   element; the session list uses this same rail so both surfaces share one
 *   look. Tokens only (`--app-accent`), no hex.
 */
export function ScrollPositionRail({
  scrollRef,
  className,
}: {
  /** The scroll container (the element that actually overflows). */
  scrollRef: RefObject<HTMLElement | null>;
  className?: string;
}) {
  const [geom, setGeom] = useState<RailGeometry | null>(null);
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<number | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const run = () => {
      raf = 0;
      setGeom(measure(el));
    };
    const schedule = () => {
      if (raf) return;
      if (typeof requestAnimationFrame === "function") {
        raf = requestAnimationFrame(run);
      } else {
        run();
      }
    };
    const reveal = () => {
      setVisible(true);
      if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(
        () => setVisible(false),
        SCROLL_RAIL_IDLE_HIDE_MS
      );
    };
    // Geometry follows EVERY scroll (incl. programmatic); visibility follows
    // only user gestures — see the docstring.
    const opts: AddEventListenerOptions = { passive: true };
    el.addEventListener("scroll", schedule, opts);
    el.addEventListener("wheel", reveal, opts);
    el.addEventListener("touchmove", reveal, opts);
    el.addEventListener("pointerdown", reveal, opts);
    el.addEventListener("keydown", reveal, opts);
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(schedule)
        : null;
    ro?.observe(el);
    // Content growth changes scrollHeight without resizing `el` itself.
    const content = el.firstElementChild;
    if (content && ro) ro.observe(content);
    run();
    return () => {
      el.removeEventListener("scroll", schedule);
      el.removeEventListener("wheel", reveal);
      el.removeEventListener("touchmove", reveal);
      el.removeEventListener("pointerdown", reveal);
      el.removeEventListener("keydown", reveal);
      ro?.disconnect();
      if (raf && typeof cancelAnimationFrame === "function")
        cancelAnimationFrame(raf);
      if (hideTimer.current != null) window.clearTimeout(hideTimer.current);
    };
  }, [scrollRef]);

  if (!geom || !geom.overflow) return null;

  return (
    <div
      aria-hidden="true"
      data-testid="scroll-position-rail"
      data-visible={visible ? "true" : "false"}
      className={cn(
        "pointer-events-none absolute z-20 transition-opacity duration-300 motion-reduce:transition-none",
        visible ? "opacity-100" : "opacity-0",
        className
      )}
      // Geometry is measured, so it lives in inline style (not arbitrary
      // Tailwind px classes — the design-token gate, and the rail must follow
      // whichever box it overlays).
      style={{
        top: geom.top,
        left: geom.left,
        width: SCROLL_RAIL_WIDTH_PX,
        height: geom.height,
      }}
    >
      <div
        data-testid="scroll-position-rail-thumb"
        className="w-full rounded-full bg-[var(--app-accent)] opacity-60"
        style={{
          height: geom.thumbHeight,
          transform: `translateY(${geom.thumbTop}px)`,
        }}
      />
    </div>
  );
}
