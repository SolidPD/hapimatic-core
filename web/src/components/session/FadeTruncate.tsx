// SPDX-License-Identifier: AGPL-3.0-only
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * FadeTruncate — single-line text that, when it overflows, is CLIPPED at its
 * box edge under a short right-hand fade instead of ellipsized.
 *
 * Why not `text-overflow: ellipsis` (operator round 10, 2026-09-07 — the
 * Session Name on the Session Basic Info Bar): the ellipsis costs the line
 * twice. (1) The `…` glyph itself (~11px at the label size) buys no text.
 * (2) CSS truncates at CHARACTER granularity — the `…` is drawn after the
 * last glyph that fits whole, so up to one hidden glyph's width of the box
 * (measured 0–9px on "refactor-reflected") is left EMPTY after the `…`, with
 * the pencil sitting a further row-gap beyond that. Together that is 11–20px
 * of a 200px name column showing nothing. Safari/Chromium do not support
 * `text-overflow: <string>`, so a narrower single-character signifier is not
 * available in CSS. A fade signifies "there is more" with ZERO characters and
 * lets the text run to the last pixel of the box, so the pencil (or any
 * sibling) hugs the actual end of the visible text.
 *
 * The fade is applied ONLY while the text really overflows (measured with a
 * ResizeObserver on the box), so a name that fits renders completely
 * unmasked. When truncated, the full text is exposed via `title`.
 *
 * Fade shape (operator round 12, 2026-09-07 — "I should be able to see at
 * least 1 more character before it fades completely away"): the band is 12px
 * wide and bottoms out at `FADE_FLOOR_ALPHA` (30% ink) instead of fully
 * transparent, so the last glyph in the band is a visibly PARTIAL character —
 * still legible as "there is more" — rather than a blank strip before the
 * pencil. Round 10's 14px band fading to 0 left ~half a character's width
 * showing nothing.
 */
export const FADE_FLOOR_ALPHA = 0.3;

export function FadeTruncate({
  children,
  className,
  fadePx = 12,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  /** Width of the fade band at the right edge, in px. */
  fadePx?: number;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, "children" | "className">) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // +1 tolerates sub-pixel rounding (the same guard SessionConfigCluster's
      // overflow ladder uses).
      setOverflowing(el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [children]);

  const mask = overflowing
    ? `linear-gradient(to right, black calc(100% - ${fadePx}px), rgba(0, 0, 0, ${FADE_FLOOR_ALPHA}))`
    : undefined;
  const text = typeof children === "string" ? children : undefined;

  return (
    <span
      ref={ref}
      {...rest}
      data-truncated={overflowing ? "true" : undefined}
      title={overflowing ? text : undefined}
      className={cn("min-w-0 overflow-hidden whitespace-nowrap", className)}
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
    >
      {children}
    </span>
  );
}
