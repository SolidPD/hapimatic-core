// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useHappyChatContext } from "@/components/AssistantChat/context";
import { usePlatform } from "@/hooks/usePlatform";
import { useDoubleTap } from "@/hooks/useDoubleTap";
import { useLongPress } from "@/hooks/useLongPress";
import {
  bookmarkSpotOffsetPx,
  resolveBookmarkAnchor,
} from "@/hooks/useBookmarkNavigation";
import { BookmarkIcon } from "@/components/icons";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/**
 * Left-gutter bookmark target for a chat message (issue #983; server-backed +
 * arbitrary-row anchoring #3115; arbitrary SCROLL-POSITION anchoring #3146).
 *
 * A narrow (24px) full-height strip to the LEFT of the message body. Double-tap
 * (mobile) / double-click (desktop) within the strip bookmarks the exact tapped
 * vertical spot; a muted-yellow bookmark icon renders AT each tapped spot while
 * the message holds a bookmark there. The double-tap lives only on this strip
 * (never the message bubble), so it does not interfere with text selection, link
 * clicks, or the copy button. `touch-manipulation` is the reliable iOS
 * double-tap-zoom suppression. `data-bookmark-message` marks the message strip so
 * `useBookmarkNavigation` can anchor a whole-turn (null-blockId) jump.
 *
 * ## #3146 — arbitrary SCROLL-POSITION anchoring (the operator's binding spec)
 *
 * A bookmark is a POSITION in the scrollable area — the vertical spot the user
 * double-tapped. Messages and blocks have ZERO visible standing: the tap does NOT
 * snap to a message/block start, the icon renders AT the tapped Y (not the
 * message top), and there is no per-block visual treatment. The tap resolves to a
 * nearest STABLE element (the block that CONTAINS the tap, via
 * `[data-bookmark-anchor]`, or the message root when none) PLUS a pixel offset of
 * the tap within that element — the anchor representation that reproduces the
 * exact spot AND survives a streaming re-render / cross-device (block ids are
 * stable). One message/block can hold MULTIPLE bookmarks at distinct spots; a
 * double-tap within `TOGGLE_TOLERANCE_PX` of an existing bookmark removes it.
 *
 * #983 feedback preserved: hover ghost (a dimmed bookmark tracking the cursor)
 * and the long-press menu (whole-turn toggle + Clear all).
 */

/**
 * Resolve the double-tap's vertical position to a nearest-stable-element anchor
 * plus a pixel offset within it. Finds the block anchor (`[data-bookmark-anchor]`)
 * whose rect CONTAINS the tap Y and returns `{ blockId, offsetPx }` with the
 * offset measured from that block's top. When no block contains the tap (a tap in
 * inter-block padding, or a message with no block anchors), it anchors to the
 * message root with the offset measured from the strip's top (the strip spans the
 * message). NEVER snaps to a block start (issue #3146).
 *
 * Also returns `anchorHeightPx` — the rendered height of the element the offset
 * was measured from (the block — `BlockAnchor` wraps the block content, so its
 * rect IS the block — or the strip), so navigation and the icon can scale the
 * offset when that element later re-lays out (issue #3878, ruling A1′).
 */
function resolveAnchor(
  strip: HTMLElement | null,
  pressClientY: number
): { blockId: string | null; offsetPx: number; anchorHeightPx: number | null } {
  const root = strip?.parentElement; // MessagePrimitive.Root
  if (!strip || !root)
    return { blockId: null, offsetPx: 0, anchorHeightPx: null };
  const stripRect = strip.getBoundingClientRect();
  const stripTop = stripRect.top;
  const anchors = Array.from(
    root.querySelectorAll<HTMLElement>("[data-bookmark-anchor]")
  )
    .map(el => ({ el, rect: el.getBoundingClientRect() }))
    .filter(a => a.rect.height > 1); // skip collapsed / zero-height blocks

  const containing = anchors.find(
    a => pressClientY >= a.rect.top && pressClientY <= a.rect.bottom
  );
  if (containing) {
    return {
      blockId: containing.el.getAttribute("data-bookmark-anchor"),
      offsetPx: Math.max(0, Math.round(pressClientY - containing.rect.top)),
      anchorHeightPx: Math.round(containing.rect.height),
    };
  }
  // No block contains the tap — anchor to the message root (whole turn).
  return {
    blockId: null,
    offsetPx: Math.max(0, Math.round(pressClientY - stripTop)),
    anchorHeightPx: Math.round(stripRect.height),
  };
}

export function BookmarkGutter({ messageId }: { messageId: string }) {
  const { bookmarks } = useHappyChatContext();
  const { haptic } = usePlatform();

  const stripRef = useRef<HTMLDivElement>(null);
  // Last pointer position, captured on press-start: used for the anchor resolver
  // (double-tap) and to open the long-press menu where the finger/cursor is
  // (useLongPress's callback carries no event).
  const lastPointRef = useRef({ x: 0, y: 0 });

  const doubleTap = useDoubleTap({
    onDoubleTap: () => {
      const { blockId, offsetPx, anchorHeightPx } = resolveAnchor(
        stripRef.current,
        lastPointRef.current.y
      );
      bookmarks.toggleBookmark(messageId, blockId, offsetPx, anchorHeightPx);
      haptic.impact("light");
    },
  });

  // This message's bookmarks (0..N at distinct spots). Kept in a ref so the
  // position-measuring layout effect can read the current list without adding an
  // unstable array to its dep list; the effect re-runs on the serialized key.
  const messageBookmarks = bookmarks.bookmarks.filter(
    b => b.messageId === messageId
  );
  const messageBookmarksRef = useRef(messageBookmarks);
  messageBookmarksRef.current = messageBookmarks;
  const bmKey = messageBookmarks
    .map(
      b => `${b.id}:${b.blockId ?? ""}:${b.offsetPx}:${b.anchorHeightPx ?? ""}`
    )
    .join("|");
  const isBookmarked = messageBookmarks.length > 0;

  // Icon Y positions within the strip: for each bookmark, the tapped spot's offset
  // relative to the strip top = (anchorEl.top - stripTop) + spot offset. The
  // anchor resolves through the SAME resolver + offset as Previous/Next
  // navigation (#3878 root cause B), so an icon is never left without a jump
  // target. Recomputed on the message's bookmark set changing and on layout
  // reflow (ResizeObserver).
  const [iconTops, setIconTops] = useState<Array<{ id: string; top: number }>>(
    []
  );
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const root = strip?.parentElement;
    if (!strip || !root) {
      setIconTops([]);
      return;
    }
    const compute = () => {
      const stripTop = strip.getBoundingClientRect().top;
      const tops = messageBookmarksRef.current.flatMap(bm => {
        const resolved = resolveBookmarkAnchor(root, bm, strip);
        if (!resolved) return [];
        const top =
          resolved.anchorEl.getBoundingClientRect().top -
          stripTop +
          bookmarkSpotOffsetPx(bm, resolved);
        return [{ id: bm.id, top: Math.max(0, top) }];
      });
      setIconTops(tops);
    };
    compute();
    const ro = new ResizeObserver(() => compute());
    ro.observe(root);
    return () => ro.disconnect();
  }, [bmKey]);

  // Hover-capability is stable for the life of the page — sample once.
  const [hoverCapable] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: hover) and (pointer: fine)").matches
  );
  const [ghostY, setGhostY] = useState<number | null>(null);

  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  // #3157 (B5-3): Clear-all requires a confirmation dialog so a slipped finger
  // cannot wipe a session's bookmarks. The menu closes and this opens; confirming
  // runs the (optimistic, fire-and-forget) clearAll().
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const openMenu = useCallback(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setMenuPos({
      x: Math.min(lastPointRef.current.x, vw - 200),
      y: Math.min(lastPointRef.current.y, vh - 96),
    });
    haptic.impact("medium");
  }, [haptic]);
  const longPress = useLongPress({ onLongPress: openMenu });

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!hoverCapable) return;
      const rect = stripRef.current?.getBoundingClientRect();
      if (rect) setGhostY(e.clientY - rect.top);
    },
    [hoverCapable]
  );

  return (
    <div
      ref={stripRef}
      // #3157 (round-6 feedback) → epic #3285 round 13 (operator, 2026-09-07:
      // "reduce the size of the gutter so that it's closer to the size of the
      // bookmark icon"): the VISIBLE gutter is the bookmark icon (now h-3 w-3 =
      // 12px, #3273) inside the unchanged w-5 (20px) strip. Round 6 had settled on w-6 (24px, ~4px each
      // side); 2px is the minimum that keeps the icon off the message's colored
      // border line. The touch target is enlarged NOT by widening this visible
      // strip (the w-10 regression, which left ~12px of dead space on each side of
      // the icon) but by the invisible hit-bridge below (left-full), which extends
      // taps rightward over the message's colored category border + left padding —
      // so "tapping the border color area registers" while the gutter stays
      // visually tight. The text-size label (SessionChat → TextScaleControl) is
      // sized to this SAME column: thread pl-1 (4px) + this strip (20px) = 24px, so
      // a change here must be mirrored there. select-none +
      // -webkit-touch-callout:none suppress the iOS long-press text-selection
      // gesture on the strip (B5-1). The centered icons and rect-based anchor math
      // are width-agnostic, so double-tap placement (#3146) is unaffected.
      className="relative w-5 shrink-0 touch-manipulation select-none [-webkit-touch-callout:none]"
      data-bookmark-message={messageId}
      onPointerDown={e => {
        lastPointRef.current = { x: e.clientX, y: e.clientY };
        doubleTap.onPointerDown(e);
      }}
      onMouseDown={longPress.onMouseDown}
      onMouseUp={longPress.onMouseUp}
      onMouseLeave={e => {
        setGhostY(null);
        longPress.onMouseLeave(e);
      }}
      onMouseMove={handleMouseMove}
      onTouchStart={longPress.onTouchStart}
      onTouchEnd={longPress.onTouchEnd}
      onTouchMove={longPress.onTouchMove}
      onContextMenu={longPress.onContextMenu}
      title={
        isBookmarked
          ? "Bookmarked (double-tap a bookmark to remove — hold for options)"
          : "Double-tap to bookmark this spot — hold for options"
      }
      aria-label={isBookmarked ? "Bookmarked message" : undefined}
    >
      {/* #3157 (B5-2, OQ1=hit-bridge): a transparent strip extending the touch
          target rightward over the message's colored category border + left
          padding (the ~10px dead zone right of the gutter: border-left 2px +
          padding-left 0.5rem — see index.css [data-cat]). It is a descendant of
          the gutter, so taps bubble to the strip's double-tap / long-press
          handlers, making the operator's "purple border" of a left-aligned
          system/agent message a valid bookmark target (case-blocked screen edge
          stays reachable). It overlays ONLY the border/padding gap — never
          message text — so text selection and link taps are unaffected. Chosen
          over relocating the border onto the gutter because that would thread the
          message category into every renderer and rewrite the shared [data-cat]
          CSS; this is contained to BookmarkGutter and fully reversible. On
          right-aligned user rows the adjacent left space is empty (border is on
          the far edge, OQ2), so this is a harmless slightly-wider target there. */}
      <span aria-hidden="true" className="absolute inset-y-0 left-full w-2.5" />
      {/* One icon per bookmark, positioned AT the tapped spot (#3146).
          pointer-events-none so it never intercepts the strip's double-tap —
          a double-tap within tolerance of an icon still resolves to that spot and
          toggles it off. */}
      {iconTops.map(({ id, top }) => (
        <span
          key={id}
          className="pointer-events-none absolute left-1/2 -translate-x-1/2"
          style={{ top }}
        >
          <BookmarkIcon
            filled
            className="h-3 w-3 text-[var(--app-bookmark)] opacity-60"
          />
        </span>
      ))}
      {/* Discoverability ghost (#983 feedback): dimmed bookmark tracking the
          cursor. pointer-events-none so it never intercepts the double-click. */}
      {hoverCapable && ghostY !== null && menuPos === null ? (
        <span
          className="pointer-events-none absolute left-1/2 -translate-x-1/2"
          style={{ top: Math.max(0, ghostY - 6) }}
        >
          <BookmarkIcon className="h-3 w-3 text-[var(--app-bookmark)] opacity-30" />
        </span>
      ) : null}
      {menuPos
        ? createPortal(
            <div
              className="fixed inset-0 z-[70] select-none [-webkit-touch-callout:none]"
              onClick={() => setMenuPos(null)}
              onContextMenu={e => {
                e.preventDefault();
                setMenuPos(null);
              }}
            >
              <div
                role="menu"
                aria-label="Bookmark options"
                className="absolute min-w-[180px] select-none rounded-lg border border-[var(--app-divider)] bg-[var(--app-secondary-bg)] py-1 text-sm text-[var(--app-fg)] shadow-2xl [-webkit-touch-callout:none]"
                style={{ top: menuPos.y, left: menuPos.x }}
                onClick={e => e.stopPropagation()}
              >
                <button /* design-tokens-allow: full-width left-aligned menu-item row - D2 E3 exception (#3357) */
                  type="button"
                  role="menuitem"
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--app-hover)]"
                  onClick={() => {
                    // Whole-turn toggle at the message top (offset 0) — the
                    // precise per-spot placement lives on the double-tap.
                    bookmarks.toggleBookmark(messageId, null, 0);
                    haptic.impact("light");
                    setMenuPos(null);
                  }}
                >
                  {bookmarks.isBookmarked(messageId, null)
                    ? "Remove top bookmark"
                    : "Bookmark top of message"}
                </button>
                <button /* design-tokens-allow: full-width left-aligned menu-item row - D2 E3 exception (#3357) */
                  type="button"
                  role="menuitem"
                  className="block w-full px-3 py-1.5 text-left text-red-400 hover:bg-[var(--app-hover)]"
                  onClick={() => {
                    // #3157 (B5-3): confirm before clearing — the menu closes and
                    // the confirmation dialog opens; the actual clearAll() runs on
                    // confirm (see the ConfirmDialog below).
                    setMenuPos(null);
                    setShowClearConfirm(true);
                  }}
                >
                  Clear all bookmarks
                </button>
              </div>
            </div>,
            document.body
          )
        : null}
      {/* #3157 (B5-3): Clear-all confirmation. Rendered outside the menu portal so
          it survives the menu closing. Modeled on QueueManagementModal's clear-all
          confirm — clearAll() is optimistic + fire-and-forget, so isPending={false}
          and a sync call inside the async onConfirm. */}
      <ConfirmDialog
        isOpen={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        title="Clear all bookmarks"
        description="This will remove all bookmarks in this session. This cannot be undone."
        confirmLabel="Clear All"
        confirmingLabel="Clearing..."
        onConfirm={async () => {
          bookmarks.clearAll();
          haptic.impact("light");
        }}
        isPending={false}
        destructive
      />
    </div>
  );
}
