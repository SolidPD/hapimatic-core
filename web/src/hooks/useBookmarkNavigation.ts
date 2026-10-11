// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import type { Bookmark } from "@hapi/protocol";
import {
  attachUserTakeoverListeners,
  startPostSnapCorrection,
  type ResizeObserverFactory,
} from "./useUserMessageNavigation";

export interface BookmarkNavigationOptions {
  /**
   * The session's bookmarks, oldest-first (server-authoritative), issue #3146.
   * Each bookmark is a scroll POSITION — an anchor element (`blockId` via
   * `[data-bookmark-anchor]`, or the message strip via `[data-bookmark-message]`
   * when `blockId` is null) plus `offsetPx`, the pixel offset of the tapped spot
   * within that element. Navigation walks this ordered list and scrolls each
   * target so `anchorTop + offsetPx` lands near the top of the viewport — no
   * message/block snapping, no highlight (the operator's #3146 model).
   */
  bookmarks: Bookmark[];
  /** Load an older page of messages (for auto-paging to unloaded bookmarks). */
  loadMore: () => Promise<unknown>;
  /** Whether older pages of messages remain unloaded. */
  hasMore: boolean;
  /** Whether an older page is currently being loaded. */
  isLoadingMore: boolean;
  /**
   * ResizeObserver factory for the post-snap correction phase (#3878). Tests
   * inject a capturing factory (the setup stub is a no-op); defaults to the
   * platform `ResizeObserver`.
   */
  createResizeObserver?: ResizeObserverFactory;
}

export interface BookmarkNavigationState {
  hasPrevious: boolean;
  hasNext: boolean;
  goToPrevious: () => void;
  goToNext: () => void;
  /** Count of RENDERED bookmarks — the single visibility gate. */
  totalCount: number;
  isAutoPaging: boolean;
  abortAutoPage: () => void;
}

const SCROLL_START_DELAY_MS = 50;
const AUTO_PAGE_POLL_INTERVAL_MS = 50;
const AUTO_PAGE_POLL_MAX_WAIT_MS = 8000;

// #3146: land the tapped spot a small inset below the viewport top so it isn't
// flush against the very edge. The bookmark is an arbitrary scroll position, so
// we scroll to `anchorTop + offsetPx` (the exact tapped row), NOT an element top.
const SCROLL_INSET_PX = 8;

// Post-layout re-anchor (#2515). After the initial smooth scroll, poll the
// tapped spot's viewport-relative position until it stops moving (images /
// tool-cards above it settle), then snap onto the settled position. The
// post-snap correction phase (#3878) and its constants are shared with the
// user-message navigation (`startPostSnapCorrection`).
const SETTLE_POLL_INTERVAL_MS = 50;
const SETTLE_MAX_WAIT_MS = 1000;
const SETTLE_STABLE_EPSILON_PX = 1;

/** A bookmark's anchor element as resolved in the current DOM. */
export interface ResolvedBookmarkAnchor {
  anchorEl: HTMLElement;
  /**
   * True when `anchorEl` is the element `offsetPx` was measured from — the block
   * for a block-anchored bookmark, the message strip for a whole-turn one. False
   * on the strip FALLBACK (the block is transiently absent), where the offset is
   * applied raw: parity with the icon, not precision, until the block re-mounts.
   */
  captured: boolean;
}

/**
 * THE anchor resolver for a bookmark (#3878 root cause B) — the gutter icon and
 * the Previous/Next navigation BOTH resolve through it, so a bookmark that shows
 * an icon is always navigable and vice-versa. Block (`[data-bookmark-anchor]`)
 * first; when that is absent — streaming (`BlockAnchor` emits no id while the
 * part runtime is unavailable) or inside a collapsed section (the block is
 * unmounted) — fall back to the message strip (`strip` when the caller holds it,
 * else `[data-bookmark-message]` within `scope`). Null only when the message
 * itself is not rendered (an unloaded page), which is the correct "not
 * navigable, no icon" state.
 */
export function resolveBookmarkAnchor(
  scope: ParentNode,
  bookmark: Bookmark,
  strip?: HTMLElement | null
): ResolvedBookmarkAnchor | null {
  if (bookmark.blockId) {
    const block = scope.querySelector<HTMLElement>(
      `[data-bookmark-anchor="${CSS.escape(bookmark.blockId)}"]`
    );
    if (block) return { anchorEl: block, captured: true };
  }
  const messageStrip =
    strip ??
    scope.querySelector<HTMLElement>(
      `[data-bookmark-message="${CSS.escape(bookmark.messageId)}"]`
    );
  if (!messageStrip) return null;
  return { anchorEl: messageStrip, captured: bookmark.blockId == null };
}

/**
 * The tapped spot's offset (CSS px) below the resolved anchor's top — shared by
 * the icon placement and the jump so the two never diverge.
 *
 * Issue #3878 (ruling A1′): `offsetPx` was measured against the anchor's height
 * at creation (`anchorHeightPx`); when the anchor has since re-laid out (text
 * scale, an image or shiki fence or nested card settling inside the block) the
 * offset is scaled by `heightNow / anchorHeightPx` — the ratio rule
 * `computeAnchorRestoreDelta` applies (#3158). Only when BOTH heights are > 0
 * AND the resolved element IS the captured one: on the strip fallback
 * `heightNow` is the whole turn's height while `anchorHeightPx` is the block's,
 * so scaling there would fling the spot far past the content. A legacy row
 * (`anchorHeightPx` null — or absent from an older federation peer) uses the raw
 * offset.
 *
 * BLOCK-anchored bookmarks only (#3878 PM gate ruling 2026-09-23, option 1): a
 * whole-turn bookmark (`blockId == null`, anchored to the message strip) keeps
 * the raw offset even though its strip height is recorded. The strip spans the
 * whole turn, and a turn most often grows by APPENDING below the tapped spot
 * (a still-streaming reply — while it streams `BlockAnchor` emits no ids, so
 * every tap on it is strip-anchored); scaling would then push the spot down
 * although the content under it never moved. A block is a bounded element, so
 * its height ratio is a fair proxy for re-layout.
 */
export function bookmarkSpotOffsetPx(
  bookmark: Bookmark,
  anchor: ResolvedBookmarkAnchor
): number {
  const capturedHeight = bookmark.anchorHeightPx;
  if (
    bookmark.blockId != null &&
    anchor.captured &&
    typeof capturedHeight === "number" &&
    capturedHeight > 0
  ) {
    const heightNow = anchor.anchorEl.getBoundingClientRect().height;
    if (heightNow > 0) {
      return bookmark.offsetPx * (heightNow / capturedHeight);
    }
  }
  return bookmark.offsetPx;
}

/** One rendered bookmark: its record + the resolved anchor element in the DOM. */
interface RenderedBookmark extends ResolvedBookmarkAnchor {
  bookmark: Bookmark;
}

/**
 * Cursor-based navigation between bookmarked SCROLL POSITIONS (issue #3146,
 * replacing the pre-#3146 element-selector design). Each bookmark is an anchor
 * element + `offsetPx`; a jump scrolls the viewport so the exact tapped spot
 * (`anchorTop + offsetPx`) lands near the top of the viewport, with NO snapping
 * to a message/block start and NO highlight of any kind (the operator's binding
 * spec). The #2515 post-layout settle re-anchor is preserved, retargeted onto
 * the tapped spot. Auto-paging to unloaded bookmarks is preserved.
 *
 * The cursor initializes to `null` (conceptually "below all bookmarks, at the
 * newest position"), so the first Previous press walks up to the newest bookmark
 * — which keeps a lone off-screen bookmark reachable (review 983-5). `totalCount`
 * is the count of RENDERED bookmarks (the single overlay-visibility gate).
 */
export function useBookmarkNavigation(
  viewportRef: React.RefObject<HTMLElement | null>,
  options: BookmarkNavigationOptions
): BookmarkNavigationState {
  const { bookmarks, loadMore, hasMore } = options;
  // Held in a ref so an inline factory never re-creates the nav callbacks.
  const createResizeObserverRef = useRef(options.createResizeObserver);
  createResizeObserverRef.current = options.createResizeObserver;

  // cursorId === null means "positioned below all bookmarks" (currentIndex -1).
  // The cursor is a bookmark surrogate id (stable across renders).
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [loadedCount, setLoadedCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [isAutoPaging, setIsAutoPaging] = useState(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  // Cancels the in-flight post-layout re-anchor (#2515).
  const settleCancelRef = useRef<(() => void) | null>(null);

  const cursorIdRef = useRef<string | null>(null);
  useEffect(() => {
    cursorIdRef.current = cursorId;
  }, [cursorId]);

  const loadMoreRef = useRef(loadMore);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);

  const hasMoreRef = useRef(hasMore);
  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  // Keep the bookmark list in a ref so the element-collection callbacks stay
  // stable (the observer effect isn't torn down on every toggle); a dedicated
  // effect recomputes when the list changes.
  const bookmarksRef = useRef(bookmarks);

  /**
   * Rendered bookmarks (message present in the DOM), in bookmark-list order.
   * Resolved through the SAME resolver as the gutter icon (#3878).
   */
  const getRenderedBookmarks = useCallback((): RenderedBookmark[] => {
    const viewport = viewportRef.current;
    if (!viewport) return [];
    const out: RenderedBookmark[] = [];
    for (const bookmark of bookmarksRef.current) {
      const resolved = resolveBookmarkAnchor(viewport, bookmark);
      if (resolved) out.push({ bookmark, ...resolved });
    }
    return out;
  }, [viewportRef]);

  // Count of ALL message elements (bookmarked or not) — used to detect a page
  // render during auto-paging, since an older page may contain zero bookmarks.
  const getAllMessageCount = useCallback((): number => {
    const viewport = viewportRef.current;
    if (!viewport) return 0;
    return viewport.querySelectorAll("[data-bookmark-message]").length;
  }, [viewportRef]);

  const findIndexById = useCallback(
    (entries: RenderedBookmark[], id: string | null): number => {
      if (!id) return -1;
      return entries.findIndex(e => e.bookmark.id === id);
    },
    []
  );

  const cancelReanchor = useCallback(() => {
    settleCancelRef.current?.();
  }, []);

  /** Scroll the viewport so the tapped spot (anchorTop + offsetPx) lands at the top inset. */
  const scrollToSpot = useCallback(
    (entry: RenderedBookmark, behavior: ScrollBehavior) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const vpTop = viewport.getBoundingClientRect().top;
      const anchorTop = entry.anchorEl.getBoundingClientRect().top;
      const delta =
        anchorTop +
        bookmarkSpotOffsetPx(entry.bookmark, entry) -
        vpTop -
        SCROLL_INSET_PX;
      viewport.scrollBy({ top: delta, behavior });
    },
    [viewportRef]
  );

  // Post-layout re-anchor (#2515, extended by #3878). Phase 1 polls the tapped
  // spot's viewport-relative position until it stops moving (or a budget
  // elapses), then snaps onto the settled position with ONE instant correction.
  // Phase 2 (#3878) catches the resizes that land AFTER that first quiet window
  // (a late image decode, a load-older prepend's reflow): a debounced
  // ResizeObserver applies at most one ABSOLUTE `scrollTop` correction per resize
  // burst, hard-capped — never a repeating programmatic-scroll poll (the #3158
  // K10 contract; iOS WebKit paints that as flicker). The spot offset is
  // re-scaled against the anchor's live height on every measurement. No
  // highlight (#3146).
  const startReanchor = useCallback(
    (entry: RenderedBookmark) => {
      settleCancelRef.current?.();

      const viewport = viewportRef.current;
      const deadline = Date.now() + SETTLE_MAX_WAIT_MS;
      const spotTop = (): number =>
        entry.anchorEl.getBoundingClientRect().top +
        bookmarkSpotOffsetPx(entry.bookmark, entry);
      let lastTop = spotTop();
      let timerId: ReturnType<typeof setTimeout> | null = null;
      let stopCorrection: (() => void) | null = null;
      const listenerAbort = new AbortController();

      const cleanup = () => {
        if (timerId !== null) {
          clearTimeout(timerId);
          timerId = null;
        }
        stopCorrection?.();
        stopCorrection = null;
        listenerAbort.abort();
        if (settleCancelRef.current === cleanup) {
          settleCancelRef.current = null;
        }
      };

      const tick = () => {
        timerId = null;
        const top = spotTop();
        const stable = Math.abs(top - lastTop) < SETTLE_STABLE_EPSILON_PX;
        lastTop = top;
        if (stable || Date.now() >= deadline) {
          scrollToSpot(entry, "auto");
          if (!viewport) {
            cleanup();
            return;
          }
          // spotTop() re-scales the offset against the anchor's live height,
          // so a block that grows after the snap is followed proportionally.
          stopCorrection = startPostSnapCorrection({
            viewport,
            targetTop: () => (entry.anchorEl.isConnected ? spotTop() : null),
            createResizeObserver: createResizeObserverRef.current,
            onUserScroll: cleanup,
          });
          return;
        }
        timerId = setTimeout(tick, SETTLE_POLL_INTERVAL_MS);
      };

      // A user who takes over during the settle or correction window wins —
      // never yank them back (#2515 R3; the cancel set is widened by #3878 to
      // taps and navigation keys).
      if (viewport) {
        attachUserTakeoverListeners(viewport, listenerAbort.signal, cleanup);
      }

      settleCancelRef.current = cleanup;
      timerId = setTimeout(tick, SETTLE_POLL_INTERVAL_MS);
    },
    [viewportRef, scrollToSpot]
  );

  const navigateToEntry = useCallback(
    (entry: RenderedBookmark, index: number) => {
      const targetId = entry.bookmark.id;
      // Update the cursor ref SYNCHRONOUSLY so a MutationObserver fire between
      // here and the post-scroll setCursorId reads the new cursor (not the old
      // one) — prevents the "second click needed" stale-cursor reset.
      cursorIdRef.current = targetId;
      cancelReanchor();

      const prefersReducedMotion =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      scrollToSpot(entry, prefersReducedMotion ? "auto" : "smooth");
      setTimeout(() => {
        setCursorId(targetId);
        setCurrentIndex(index);
      }, SCROLL_START_DELAY_MS);
      startReanchor(entry);
    },
    [scrollToSpot, cancelReanchor, startReanchor]
  );

  const recomputeState = useCallback(() => {
    const entries = getRenderedBookmarks();
    setLoadedCount(entries.length);

    const cursor = cursorIdRef.current;
    if (cursor !== null && findIndexById(entries, cursor) === -1) {
      // The cursor's bookmark is no longer rendered/bookmarked (un-bookmarked or
      // scrolled out of the loaded window) — reset to "below all" so Previous is
      // available again.
      cursorIdRef.current = null;
      setCursorId(null);
      setCurrentIndex(-1);
      return;
    }
    const idx = cursor ? findIndexById(entries, cursor) : -1;
    setCurrentIndex(prev => (prev === idx ? prev : idx));
  }, [getRenderedBookmarks, findIndexById]);

  // Track DOM changes and keep loadedCount / cursor in sync.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    recomputeState();

    const observer = new MutationObserver(() => {
      recomputeState();
    });
    observer.observe(viewport, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, [viewportRef, recomputeState]);

  // Recompute when the bookmark list changes (toggle add/remove) — the icon
  // add/remove is itself a DOM mutation, but this makes the dependency explicit
  // and keeps the ref current.
  useEffect(() => {
    bookmarksRef.current = bookmarks;
    recomputeState();
  }, [bookmarks, recomputeState]);

  // Reset when the viewport ref changes (session swap).
  useEffect(() => {
    cursorIdRef.current = null;
    setCursorId(null);
    setCurrentIndex(-1);
    setLoadedCount(0);
    recomputeState();
  }, [viewportRef, recomputeState]);

  const abortAutoPage = useCallback(() => {
    settleCancelRef.current?.();
    abortControllerRef.current?.abort();
  }, []);

  const runAutoPage = useCallback(
    (oldTopBookmarkId: string | null) => {
      const controller = new AbortController();
      abortControllerRef.current = controller;
      setIsAutoPaging(true);

      (async () => {
        try {
          while (!controller.signal.aborted && hasMoreRef.current) {
            const beforeAllCount = getAllMessageCount();

            try {
              await loadMoreRef.current();
            } catch {
              // loadMore surfaced its own error via the load-older UI.
              break;
            }
            if (controller.signal.aborted) break;

            // Wait for the older page to render (total message count grows). We
            // poll the TOTAL count, not the bookmark count, because a page may
            // contain zero bookmarks yet still make paging progress.
            const deadline = Date.now() + AUTO_PAGE_POLL_MAX_WAIT_MS;
            let afterAllCount = getAllMessageCount();
            while (
              !controller.signal.aborted &&
              Date.now() < deadline &&
              afterAllCount <= beforeAllCount
            ) {
              await new Promise(r => setTimeout(r, AUTO_PAGE_POLL_INTERVAL_MS));
              afterAllCount = getAllMessageCount();
            }
            if (controller.signal.aborted) break;
            if (afterAllCount <= beforeAllCount) {
              // No page rendered within budget — stop.
              break;
            }

            // A page rendered. Did it bring a bookmark above the old top? (When
            // there were no prior bookmarks, any newly rendered bookmark
            // qualifies — land on the newest of them.)
            const afterEntries = getRenderedBookmarks();
            const oldTopIdx =
              oldTopBookmarkId !== null
                ? findIndexById(afterEntries, oldTopBookmarkId)
                : afterEntries.length;
            if (oldTopIdx > 0) {
              navigateToEntry(afterEntries[oldTopIdx - 1], oldTopIdx - 1);
              break;
            }
            // No bookmark above the old top on this page — keep paging.
          }
        } finally {
          setIsAutoPaging(false);
          abortControllerRef.current = null;
        }
      })();
    },
    [getAllMessageCount, getRenderedBookmarks, findIndexById, navigateToEntry]
  );

  const goToPrevious = useCallback(() => {
    const entries = getRenderedBookmarks();
    const cursor = cursorIdRef.current;
    const idx = cursor ? findIndexById(entries, cursor) : -1;

    if (idx === -1) {
      // "Below all" — go up to the newest (bottom-most) loaded bookmark.
      if (entries.length > 0) {
        navigateToEntry(entries[entries.length - 1], entries.length - 1);
        return;
      }
      // No loaded bookmarks; auto-page toward older bookmarks if any exist.
      if (hasMoreRef.current && !isAutoPaging) {
        runAutoPage(null);
      }
      return;
    }

    if (idx > 0) {
      navigateToEntry(entries[idx - 1], idx - 1);
      return;
    }

    // At the oldest loaded bookmark (idx 0) — auto-page toward older pages.
    if (idx === 0 && hasMoreRef.current && !isAutoPaging) {
      runAutoPage(entries[0].bookmark.id);
    }
  }, [
    getRenderedBookmarks,
    findIndexById,
    navigateToEntry,
    runAutoPage,
    isAutoPaging,
  ]);

  const goToNext = useCallback(() => {
    const entries = getRenderedBookmarks();
    const cursor = cursorIdRef.current;
    const idx = cursor ? findIndexById(entries, cursor) : -1;
    // cursor null (-1) means "below all" — nothing further down to go to.
    if (idx >= 0 && idx < entries.length - 1) {
      navigateToEntry(entries[idx + 1], idx + 1);
    }
  }, [getRenderedBookmarks, findIndexById, navigateToEntry]);

  useEffect(() => {
    return () => {
      settleCancelRef.current?.();
      abortControllerRef.current?.abort();
    };
  }, []);

  const hasPrevious =
    isAutoPaging ||
    (currentIndex === -1
      ? loadedCount > 0 || hasMore
      : currentIndex > 0 || (currentIndex === 0 && hasMore));
  const hasNext = currentIndex >= 0 && currentIndex < loadedCount - 1;
  const totalCount = loadedCount;

  return {
    hasPrevious,
    hasNext,
    goToPrevious,
    goToNext,
    totalCount,
    isAutoPaging,
    abortAutoPage,
  };
}
