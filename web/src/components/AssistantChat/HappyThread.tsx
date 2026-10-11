// SPDX-License-Identifier: AGPL-3.0-only
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ThreadPrimitive, useThreadViewport } from "@assistant-ui/react";
import { applyThreadFade, computeThreadFade } from "@/lib/threadFade";
import type { ApiClient } from "@/api/client";
import type { SessionMetadataSummary } from "@/types/api";
import type { UseBookmarksResult } from "@/hooks/useBookmarks";
import { HappyChatProvider } from "@/components/AssistantChat/context";
import { useChatSectionPrefs } from "@/hooks/useChatSectionPrefs";
import { HappyAssistantMessage } from "@/components/AssistantChat/messages/AssistantMessage";
import { HappyUserMessage } from "@/components/AssistantChat/messages/UserMessage";
import { HappySystemMessage } from "@/components/AssistantChat/messages/SystemMessage";
import { Button } from "@/components/ui/button";
import { ScrollPositionRail } from "@/components/ui/ScrollPositionRail";
import { Spinner } from "@/components/Spinner";
import { useToast } from "@/components/Toast";
import {
  saveScrollPosition,
  getScrollPosition,
  clearScrollPosition,
} from "@/lib/scroll-position-cache";
import { computeAnchorRestoreDelta } from "@/lib/scroll-anchor";

// Exported for use in SessionChat
export interface ScrollState {
  showJumpButton: boolean;
  newMessageCount: number;
  scrollToBottom: () => void;
  scrollToTop: () => void;
  viewportRef: React.RefObject<HTMLDivElement | null>;
}

function MessageSkeleton() {
  const rows = [
    { align: "end", width: "w-2/3", height: "h-10" },
    { align: "start", width: "w-3/4", height: "h-12" },
    { align: "end", width: "w-1/2", height: "h-9" },
    { align: "start", width: "w-5/6", height: "h-14" },
  ];

  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading messages…</span>
      <div className="space-y-3 animate-pulse">
        {rows.map((row, index) => (
          <div
            key={`skeleton-${index}`}
            className={
              row.align === "end" ? "flex justify-end" : "flex justify-start"
            }
          >
            <div
              className={`${row.height} ${row.width} rounded-xl bg-[var(--app-subtle-bg)]`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

const THREAD_MESSAGE_COMPONENTS = {
  UserMessage: HappyUserMessage,
  AssistantMessage: HappyAssistantMessage,
  SystemMessage: HappySystemMessage,
} as const;

export function HappyThread(props: {
  api: ApiClient;
  sessionId: string;
  metadata: SessionMetadataSummary | null;
  disabled: boolean;
  onRefresh: () => void;
  onRetryMessage?: (localId: string) => void;
  // #3333: prefill+focus the composer without sending (the approval card's
  // Decline seam); threaded into the HappyChatContext value below.
  prefillComposer?: (text: string) => void;
  isLoadingMessages: boolean;
  messagesWarning: string | null;
  hasMoreMessages: boolean;
  isLoadingMoreMessages: boolean;
  onLoadMore: () => Promise<unknown>;
  rawMessagesCount: number;
  normalizedMessagesCount: number;
  renderedMessagesCount: number;
  onScrollStateChange?: (state: ScrollState) => void;
  textScale?: number;
  // #3158: registers an imperative "capture the current top-visible anchor"
  // callback with the parent (SessionChat), which fires it synchronously BEFORE
  // a text-size change so the anchor is measured against the pre-relayout DOM.
  onCaptureTopAnchorRef?: (fn: () => void) => void;
  // #983: the single per-session bookmarks instance (owned by SessionChat),
  // provided to the message renderers via HappyChatContext.
  bookmarks: UseBookmarksResult;
}) {
  // Chat sections matrix (#2988, epic #2987 Sub-Issue S1). Sourced ONCE here
  // from the server-authoritative hook and threaded into the chat context, so a
  // preference change re-renders an open thread live (no reload). The thread
  // only needs the effective matrix (`prefs`).
  const { prefs: chatSections } = useChatSectionPrefs(props.api);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const loadLockRef = useRef(false);
  const pendingScrollRef = useRef<{
    // #3768 (Option C, expert-review D14): element-anchored load-older restore.
    // anchorEl is the top-visible block at load-start; anchorTop is its
    // viewport-relative offset. Compensation shifts the viewport so anchorEl
    // returns to anchorTop — driven ONLY by content inserted ABOVE it, so a
    // streaming token / #3177 tail placeholder growing the column during the load
    // moves nothing and is ignored (dissolves the scrollHeight-delta blind spot,
    // finding 3768-5).
    anchorEl: HTMLElement;
    anchorTop: number;
    // rawMessagesCount at capture, so the settle-effect can release immediately
    // on a zero-new-row page (the ResizeObserver would never fire).
    count: number;
  } | null>(null);
  // #3768: hard-cap timer id — armed when a load-older page arrives (count grew)
  // and cleared by the ResizeObserver on compensation. A page that grows the
  // count but renders NO rows (all normalized away, or ResizeObserver absent)
  // would otherwise leave the anchor stuck and wedge bottom-follow + the load
  // lock (finding 3768-3); the timer is the fallback release.
  const loadHardCapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const prevLoadingMoreRef = useRef(false);
  const loadStartedRef = useRef(false);
  const isLoadingMoreRef = useRef(props.isLoadingMoreMessages);

  // #3158: text-size anchoring. pendingTextScaleAnchorRef holds the top-visible
  // content element + its viewport-relative offset, captured just BEFORE a
  // text-size change; the useLayoutEffect keyed on props.textScale restores it
  // after the font re-lays out. prevTextScaleRef distinguishes a real scale
  // change from the initial mount / unrelated re-renders.
  const pendingTextScaleAnchorRef = useRef<{
    el: HTMLElement;
    targetOffset: number;
    height: number;
  } | null>(null);
  const prevTextScaleRef = useRef(props.textScale ?? 1.0);

  // assistant-ui at-bottom signal — READ-ONLY. #2858 single-ownership: we no
  // longer bind assistant-ui's scrollToBottom; all its scroll machinery is
  // rendered inert on the Viewport (below). auiIsAtBottom stays a passive read
  // for the #1298 safety net (it issues no scroll of its own).
  const auiIsAtBottom = useThreadViewport(vp => vp.isAtBottom);

  // Guard ref: suppresses scroll handler during programmatic scroll-to-bottom
  const isScrollingToBottomRef = useRef(false);

  // Track user-initiated scroll direction so the safety-net effect below doesn't
  // hijack a user-initiated scroll-up during high-message-rate streaming (#1298 Concern 4).
  // null = no recent user-initiated scroll; "up"/"down" = direction of last delta.
  // Cleared when the user reaches the bottom or explicitly jumps to bottom.
  const userScrollDirectionRef = useRef<"up" | "down" | null>(null);
  const lastScrollTopForDirRef = useRef<number>(0);

  // Scroll position restore state (#833): tracks whether we're restoring a
  // cached position so we can suppress assistant-ui's scrollToBottomOnInitialize.
  const isRestoringRef = useRef(getScrollPosition(props.sessionId) !== null);
  const didRestoreRef = useRef(false);

  // Smart scroll state: autoScroll enabled when user is near bottom.
  // If a cached scroll position exists for this session, start with autoScroll
  // disabled so the restored position isn't overridden (#833).
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(
    () => getScrollPosition(props.sessionId) === null
  );
  const [newMessageCount, setNewMessageCount] = useState(0);
  const prevRenderedCountRef = useRef(props.renderedMessagesCount);
  const autoScrollEnabledRef = useRef(autoScrollEnabled);
  const newMessageCountRef = useRef(newMessageCount);
  const hasBootstrappedRef = useRef(false);
  const { showToast } = useToast();

  // Keep refs in sync with state
  useEffect(() => {
    autoScrollEnabledRef.current = autoScrollEnabled;
  }, [autoScrollEnabled]);
  useEffect(() => {
    newMessageCountRef.current = newMessageCount;
  }, [newMessageCount]);

  // Safety net: sync autoScrollEnabled with assistant-ui's isAtBottom.
  // Catches edge cases where assistant-ui keeps viewport at bottom
  // but the scroll handler hasn't caught up (e.g., after content resize).
  // One-way sync: assistant-ui → HappyThread only.
  //
  // Gated on userScrollDirectionRef: if the user is mid-scroll-up, do NOT
  // re-engage autoScrollEnabled. This prevents the mousewheel-stutter cycle
  // documented in #1298 Concern 4, where assistant-ui's content-resize
  // snap-back during streaming would flip isAtBottom true → safety-net would
  // re-engage autoScrollEnabled → undo the user's scroll-up intent.
  useEffect(() => {
    if (isRestoringRef.current) return; // Don't fight scroll restore (#833)
    if (userScrollDirectionRef.current === "up") return; // #1298 Concern 4 gate
    if (auiIsAtBottom && !autoScrollEnabled) {
      setAutoScrollEnabled(true);
      setNewMessageCount(0);
    }
  }, [auiIsAtBottom, autoScrollEnabled]);

  // Track scroll position to toggle autoScroll (stable listener using refs)
  // Uses two-tier threshold: "exact bottom" (< 5px) forces re-enable, "near bottom" (< 120px) enables if not already
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const NEAR_BOTTOM_THRESHOLD_PX = 120;
    const EXACT_BOTTOM_THRESHOLD_PX = 5;

    const SCROLL_DIRECTION_HYSTERESIS_PX = 2;

    const handleScroll = () => {
      // Skip during programmatic scroll-to-bottom to avoid fighting
      // assistant-ui's animation or instant scroll
      if (isScrollingToBottomRef.current) return;

      const currentTop = viewport.scrollTop;
      // Track user-initiated scroll direction for #1298 Concern 4 safety-net gating.
      // 2px hysteresis avoids spurious flips on float-rounded scroll events.
      if (
        currentTop <
        lastScrollTopForDirRef.current - SCROLL_DIRECTION_HYSTERESIS_PX
      ) {
        userScrollDirectionRef.current = "up";
      } else if (
        currentTop >
        lastScrollTopForDirRef.current + SCROLL_DIRECTION_HYSTERESIS_PX
      ) {
        userScrollDirectionRef.current = "down";
      }
      lastScrollTopForDirRef.current = currentTop;

      const distanceFromBottom =
        viewport.scrollHeight - currentTop - viewport.clientHeight;

      if (distanceFromBottom < EXACT_BOTTOM_THRESHOLD_PX) {
        // User is at exact bottom - force enable auto-scroll (user clearly wants
        // to follow) and clear the scroll-up gate so the safety-net resumes
        // normal operation. Gated on userScrollDirectionRef (#2414): a genuine
        // scroll-down to bottom sets direction "down" above (scrollTop rising),
        // so this passes for real intent; a programmatic snap landing at bottom
        // while the user means to stay scrolled up ("up") is NOT treated as a
        // follow request, so it can't clear the gate or re-arm follow.
        if (userScrollDirectionRef.current !== "up") {
          userScrollDirectionRef.current = null;
          if (!autoScrollEnabledRef.current) setAutoScrollEnabled(true);
          if (newMessageCountRef.current > 0) setNewMessageCount(0);
        }
      } else if (distanceFromBottom < NEAR_BOTTOM_THRESHOLD_PX) {
        // User is near bottom - enable if not already. Same #2414 gate: without
        // it, a programmatic snap landing near (not at) bottom, or the trailing
        // scroll event of a single ~100px wheel-up notch (< 120px), would undo
        // the wheel-up disable that the user-intent listener just set.
        if (userScrollDirectionRef.current !== "up") {
          if (!autoScrollEnabledRef.current) setAutoScrollEnabled(true);
          if (newMessageCountRef.current > 0) setNewMessageCount(0);
        }
      } else {
        // User scrolled away from bottom - disable auto-scroll
        if (autoScrollEnabledRef.current) setAutoScrollEnabled(false);
      }
    };

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, []); // Stable: no dependencies, reads from refs

  // User-intent scroll listeners (#2414): native wheel-up / upward touch-drag
  // are the reliable user-vs-programmatic discriminator the distance heuristic
  // lacks — scrollTo() cannot synthesize a wheel or touchmove event. An upward
  // user gesture immediately marks intent ("up") and disables auto-follow, so a
  // later programmatic snap (or the trailing scroll event of a sub-120px wheel
  // notch) can't silently re-arm follow. This AUGMENTS the distance-threshold
  // logic per the repo Fallback-Preservation Rule — it does not replace it. The
  // "up" intent is cleared at the existing clear points (reach exact bottom in
  // the scroll handler above, or tap jump-to-bottom in scrollToBottom below).
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    // Mark deliberate user scroll-up intent and stop following. Reading
    // autoScrollEnabledRef first avoids a redundant state write when already off.
    const markUserScrollUp = () => {
      userScrollDirectionRef.current = "up";
      if (autoScrollEnabledRef.current) setAutoScrollEnabled(false);
    };

    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) markUserScrollUp();
    };

    let touchStartY: number | null = null;
    const handleTouchStart = (event: TouchEvent) => {
      touchStartY = event.touches[0]?.clientY ?? null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (touchStartY === null) return;
      const currentY = event.touches[0]?.clientY ?? null;
      if (currentY === null) return;
      // Finger dragging DOWN (clientY increasing) scrolls content UP.
      if (currentY > touchStartY) markUserScrollUp();
      touchStartY = currentY;
    };

    // Passive: these handlers never preventDefault (they only read deltas and
    // set refs/state), so passive registration keeps the highest-frequency
    // streaming events non-blocking. assistant-ui 0.11.53 attaches no competing
    // wheel/touch listeners on the viewport (only a scroll listener + ResizeObserver).
    viewport.addEventListener("wheel", handleWheel, { passive: true });
    viewport.addEventListener("touchstart", handleTouchStart, {
      passive: true,
    });
    viewport.addEventListener("touchmove", handleTouchMove, { passive: true });
    return () => {
      viewport.removeEventListener("wheel", handleWheel);
      viewport.removeEventListener("touchstart", handleTouchStart);
      viewport.removeEventListener("touchmove", handleTouchMove);
    };
  }, []); // Stable: attaches once, reads/writes refs + setAutoScrollEnabled

  // #2858 single-ownership follow-mode: with assistant-ui's autoScroll now off
  // (the Viewport renders all four arming sites false), WE own stick-to-bottom
  // during streaming. Observe the content column; whenever it grows while follow
  // is engaged, snap the viewport to the bottom UNDER the isScrollingToBottomRef
  // guard (single-rAF clear) so the follow-scroll's own scroll event is ignored
  // by the handler and can never masquerade as user intent. Replaces
  // assistant-ui's resize-driven auto-follow (Defect 2) with a scroll we own.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      // #3768 (Option C, expert-review D14): element-anchored load-older
      // compensation. The prepended rows mount one commit AFTER the count bump
      // (assistant-ui's passive setAdapter re-render); this observer fires then,
      // when the column has grown. This check runs BEFORE the autoScroll/#833
      // guards because a load-older happens while the user is scrolled UP
      // (autoScroll off), so gating it on autoScroll would make it dead code.
      // Return in BOTH the compensated and still-pending sub-cases so bottom-follow
      // never runs while a load-older anchor is pending.
      const pending = pendingScrollRef.current;
      if (pending) {
        // How far the captured top-visible block MOVED. Only content inserted
        // ABOVE it moves it, so a tail/streaming growth yields moved === 0 and is
        // ignored (the anchor is retained for the real prepend). A prepend moves
        // it down → compensate by exactly that delta.
        const moved = computeAnchorRestoreDelta({
          anchorTopNow: pending.anchorEl.getBoundingClientRect().top,
          viewportTopNow: viewport.getBoundingClientRect().top,
          targetOffset: pending.anchorTop,
        });
        if (moved !== 0) {
          isScrollingToBottomRef.current = true;
          viewport.scrollTop += moved;
          requestAnimationFrame(() => {
            isScrollingToBottomRef.current = false;
          });
          pendingScrollRef.current = null;
          if (loadHardCapTimerRef.current !== null) {
            clearTimeout(loadHardCapTimerRef.current);
            loadHardCapTimerRef.current = null;
          }
          // Debounce the load-lock release so the top-sentinel IntersectionObserver
          // doesn't immediately re-fire while it is still in view after the shift.
          setTimeout(() => {
            loadLockRef.current = false;
          }, 100);
        }
        return;
      }
      if (!autoScrollEnabledRef.current) return; // user off-bottom; don't follow
      if (isRestoringRef.current) return; // don't fight #833 restore
      isScrollingToBottomRef.current = true;
      viewport.scrollTop = viewport.scrollHeight;
      requestAnimationFrame(() => {
        isScrollingToBottomRef.current = false;
      });
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      // #3768: cancel any in-flight load-older hard-cap timer on unmount.
      if (loadHardCapTimerRef.current !== null) {
        clearTimeout(loadHardCapTimerRef.current);
        loadHardCapTimerRef.current = null;
      }
    };
  }, []); // Stable: observes once, reads refs only

  // Track new messages when autoScroll is disabled
  const wasLoadingMoreRef = useRef(props.isLoadingMoreMessages);
  useEffect(() => {
    const prevCount = prevRenderedCountRef.current;
    const currentCount = props.renderedMessagesCount;
    const wasLoadingMore = wasLoadingMoreRef.current;
    wasLoadingMoreRef.current = props.isLoadingMoreMessages;

    if (props.isLoadingMessages) {
      prevRenderedCountRef.current = currentCount;
      return;
    }

    if (!hasBootstrappedRef.current) {
      hasBootstrappedRef.current = true;
      prevRenderedCountRef.current = currentCount;
      return;
    }

    prevRenderedCountRef.current = currentCount;

    // Skip during loading states
    if (props.isLoadingMoreMessages) {
      return;
    }

    // Skip if load-more just finished (older messages, not new ones)
    if (wasLoadingMore) {
      return;
    }

    const newCount = currentCount - prevCount;
    if (newCount > 0 && !autoScrollEnabled) {
      setNewMessageCount(prev => prev + newCount);
    }
  }, [
    props.renderedMessagesCount,
    props.isLoadingMoreMessages,
    props.isLoadingMessages,
    autoScrollEnabled,
  ]);

  // Scroll-to-bottom handler for the jump-to-bottom button, initial position,
  // and the send-time scroll. #2858: HappyThread is the SOLE issuer of
  // programmatic scrolls, so this drives the viewport directly (not assistant-ui)
  // under the isScrollingToBottomRef guard.
  const scrollToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    isScrollingToBottomRef.current = true;
    // Clear user-scroll-up gate: clicking Jump-to-Bottom is an explicit intent
    // to follow streaming again (#1298 Concern 4).
    userScrollDirectionRef.current = null;
    // #2858: own the scroll (auiScrollToBottom is no longer bound). Mirrors the
    // scrollToTop viewport.scrollTo pattern below.
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
    setAutoScrollEnabled(true);
    setNewMessageCount(0);
    // Clear the guard after a SINGLE frame (#2858): the instant scroll completes
    // synchronously but its scroll event fires asynchronously. Never a timer or a
    // multi-frame hold — widening the guard's duty cycle lets it blanket a real
    // scrollbar drag's scroll event (whose ONLY signal is `scroll`), the exact
    // masking that let #710 → #1298 → #2414 swallow user intent.
    requestAnimationFrame(() => {
      isScrollingToBottomRef.current = false;
    });
  }, []);

  // Scroll to top handler
  const scrollToTop = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollTo({ top: 0, behavior: "smooth" });
    }
    setAutoScrollEnabled(false);
  }, []);

  // #3158: capture the top-visible content element + its viewport-relative
  // offset. SessionChat's text-size handlers call this synchronously BEFORE the
  // scale state changes, so the measurement reflects the PRE-relayout DOM.
  // Skipped while following the bottom — a size change there stays pinned to the
  // bottom via the follow-mode ResizeObserver, so there is no top line to hold.
  const captureTopAnchor = useCallback(() => {
    if (autoScrollEnabledRef.current) {
      pendingTextScaleAnchorRef.current = null;
      return;
    }
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) {
      pendingTextScaleAnchorRef.current = null;
      return;
    }
    const viewportTop = viewport.getBoundingClientRect().top;
    // The top-most block still (partly) visible: the first block whose bottom is
    // at/below the viewport top. Blocks carry data-bookmark-anchor
    // (BlockAnchor.tsx, #3146) — the finest-grained stable anchors in the DOM.
    const anchorEls = Array.from(
      content.querySelectorAll<HTMLElement>("[data-bookmark-anchor]")
    );
    const chosen =
      anchorEls.find(
        el => el.getBoundingClientRect().bottom > viewportTop + 1
      ) ?? null;
    // Fall back to the content column itself when no block anchor qualifies
    // (empty thread, streaming gap, or no rendered blocks yet).
    const anchorEl: HTMLElement = chosen ?? content;
    const anchorRect = anchorEl.getBoundingClientRect();
    pendingTextScaleAnchorRef.current = {
      el: anchorEl,
      targetOffset: anchorRect.top - viewportTop,
      // Captured height lets the restore scale the offset by the block's
      // height change (fractional anchoring), so a deep cut into a tall block
      // preserves the reader's LINE — not a raw pixel depth that would push a
      // shrunk block off-screen (#3158, Playwright scenario C).
      height: anchorRect.height,
    };
  }, []);

  // #3158: register captureTopAnchor with the parent so its text-size control
  // can fire it before changing the scale.
  useEffect(() => {
    props.onCaptureTopAnchorRef?.(captureTopAnchor);
  }, [captureTopAnchor, props.onCaptureTopAnchorRef]);

  // Notify parent of scroll state changes
  useEffect(() => {
    props.onScrollStateChange?.({
      showJumpButton: !autoScrollEnabled,
      newMessageCount,
      scrollToBottom,
      scrollToTop,
      viewportRef,
    });
  }, [
    autoScrollEnabled,
    newMessageCount,
    scrollToBottom,
    scrollToTop,
    props.onScrollStateChange,
    viewportRef,
  ]);

  // Save scroll position on unmount so it can be restored on re-entry (#833).
  // Epic #3285 round 16: ambient thread fade. The viewport carries the
  // `.thread-fade` mask (index.css); its two soft edges are CSS variables this
  // effect writes straight onto the element on scroll / resize — no React
  // re-render per scroll frame, and no interaction with the follow-mode logic
  // above (this listener only READS metrics). Top edge: 0 at the very top so
  // the first line is never dimmed; bottom edge: 0 at the very bottom so the
  // newest line is never dimmed (see lib/threadFade.ts). useLayoutEffect for
  // the same composed-ref reason as the effects below.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => applyThreadFade(viewport, computeThreadFade(viewport));
    update();
    viewport.addEventListener("scroll", update, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(viewport);
    if (contentRef.current) observer?.observe(contentRef.current);
    return () => {
      viewport.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [props.sessionId]);

  // Must be useLayoutEffect (not useEffect) because ThreadPrimitive.Viewport's
  // composed refs clear viewportRef.current before useEffect cleanup runs.
  useLayoutEffect(() => {
    return () => {
      const viewport = viewportRef.current;
      if (viewport) {
        saveScrollPosition(props.sessionId, viewport.scrollTop);
      }
    };
  }, [props.sessionId]);

  // Restore cached scroll position after messages finish loading (#833).
  // Uses useLayoutEffect to set scrollTop before the browser paints,
  // avoiding a flash of the wrong position.
  useLayoutEffect(() => {
    if (didRestoreRef.current) return;
    if (props.isLoadingMessages) return;

    const cached = getScrollPosition(props.sessionId);
    if (cached !== null && cached > 0) {
      const viewport = viewportRef.current;
      if (viewport) {
        viewport.scrollTop = cached;
        didRestoreRef.current = true;
        clearScrollPosition(props.sessionId);
        requestAnimationFrame(() => {
          isRestoringRef.current = false;
        });
      }
    } else {
      // No cached position — fresh open. #2858: assistant-ui's
      // scrollToBottomOnInitialize is now off, so WE own the initial position.
      // Land at the bottom (latest messages) under the programmatic-scroll guard,
      // mirroring scrollToBottom's single-rAF clear.
      const viewport = viewportRef.current;
      if (viewport) {
        isScrollingToBottomRef.current = true;
        viewport.scrollTop = viewport.scrollHeight;
        requestAnimationFrame(() => {
          isScrollingToBottomRef.current = false;
        });
      }
      didRestoreRef.current = true;
      isRestoringRef.current = false;
    }
  }, [props.isLoadingMessages, props.sessionId]);

  // Reset state when session changes
  useEffect(() => {
    if (!isRestoringRef.current) {
      setAutoScrollEnabled(true);
    }
    setNewMessageCount(0);
    prevRenderedCountRef.current = 0;
    hasBootstrappedRef.current = false;
  }, [props.sessionId]);

  const handleLoadMore = useCallback(() => {
    if (
      props.isLoadingMessages ||
      !props.hasMoreMessages ||
      props.isLoadingMoreMessages ||
      loadLockRef.current
    ) {
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    // #3768 (Option C): anchor to the top-visible block (data-bookmark-anchor,
    // #3146), fallback the content column. Compensation later restores THIS
    // element's viewport-relative offset, so only content inserted above it
    // counts — tail/streaming growth during the load is ignored.
    const viewportTop = viewport.getBoundingClientRect().top;
    const contentEl = contentRef.current;
    const anchorEls = contentEl
      ? Array.from(
          contentEl.querySelectorAll<HTMLElement>("[data-bookmark-anchor]")
        )
      : [];
    const anchorEl =
      anchorEls.find(
        el => el.getBoundingClientRect().bottom > viewportTop + 1
      ) ??
      contentEl ??
      viewport;
    pendingScrollRef.current = {
      anchorEl,
      anchorTop: anchorEl.getBoundingClientRect().top - viewportTop,
      count: props.rawMessagesCount, // #3768: baseline to detect a no-op page
    };
    loadLockRef.current = true;
    loadStartedRef.current = false;
    let loadPromise: Promise<unknown>;
    try {
      loadPromise = props.onLoadMore();
    } catch (error) {
      pendingScrollRef.current = null;
      loadLockRef.current = false;
      throw error;
    }
    void loadPromise
      .catch(error => {
        pendingScrollRef.current = null;
        loadLockRef.current = false;
        console.error("Failed to load older messages:", error);
        showToast("Failed to load older messages", { type: "error" });
      })
      .finally(() => {
        if (
          !loadStartedRef.current &&
          !isLoadingMoreRef.current &&
          pendingScrollRef.current
        ) {
          pendingScrollRef.current = null;
          loadLockRef.current = false;
        }
      });
  }, [
    props.hasMoreMessages,
    props.isLoadingMoreMessages,
    props.isLoadingMessages,
    props.onLoadMore,
    props.rawMessagesCount,
  ]);

  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const viewport = viewportRef.current;
    if (
      !sentinel ||
      !viewport ||
      !props.hasMoreMessages ||
      props.isLoadingMessages
    ) {
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      return;
    }

    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            handleLoadMore();
          }
        }
      },
      {
        root: viewport,
        rootMargin: "200px 0px 0px 0px",
      }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [handleLoadMore, props.hasMoreMessages, props.isLoadingMessages]);

  // #3768: the load-older scroll compensation formerly lived here in a
  // useLayoutEffect keyed on props.rawMessagesCount. It fired at the count bump
  // (one commit BEFORE assistant-ui mounts the prepended rows), so scrollHeight
  // was still the old height → delta ≈ 0 and the pending anchor was discarded
  // prematurely, leaving the viewport at the absolute top of the fresh batch. The
  // compensation now lives in the contentRef ResizeObserver above, which fires
  // when the rows actually mount and scrollHeight has grown (R1/R2).

  // #3158: text-size anchoring restore. When props.textScale changes and the
  // user is NOT following the bottom, restore the top-visible element captured
  // (in captureTopAnchor) just before the change to the same viewport-relative
  // offset, so the reader stays anchored on the same line as the font re-lays
  // out above and below. Runs under the isScrollingToBottomRef guard so the
  // restore's own scroll event is not misread as user intent (#2858). Following
  // the bottom is left to the follow-mode ResizeObserver above (no top line to
  // hold).
  //
  // #3158 regression fix: the original implementation re-applied the restore on
  // a 50ms x 10 setInterval "settle pass", so a single size change issued 4-6
  // separate programmatic scrolls over ~400ms. In Chromium that was invisible
  // (the immediate restore did ~99% of the move; the rest were 1-6px touch-ups),
  // but on iOS WebKit that stream of small scrolls — issued while layout is
  // still reflowing and touch momentum may be live — painted as WILD FLICKER and
  // left the viewport far from the target (WebKit clamps/defers programmatic
  // scrolls in that window). It is replaced by ONE authoritative synchronous
  // restore plus AT MOST ONE deferred correction, fired only once the content
  // has actually stopped resizing (a debounced ResizeObserver, hard-capped) —
  // never a repeating poll. The scroll is an ABSOLUTE `scrollTop` assignment,
  // not a relative `scrollBy`, so a second application is idempotent and cannot
  // compound error the way repeated deltas against a mid-reflow measurement can.
  useLayoutEffect(() => {
    const prev = prevTextScaleRef.current;
    const next = props.textScale ?? 1.0;
    if (prev === next) return; // initial mount / not a scale change
    prevTextScaleRef.current = next;

    const pending = pendingTextScaleAnchorRef.current;
    pendingTextScaleAnchorRef.current = null;
    if (!pending) return; // nothing captured (was following bottom, or no viewport)
    if (autoScrollEnabledRef.current) return; // bottom-follow owns this case

    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport) return;

    // Move the viewport so the captured anchor returns to its recorded
    // viewport-relative offset. Absolute `scrollTop` assignment (not `scrollBy`)
    // so the deferred re-application below is idempotent rather than additive.
    const restore = () => {
      if (!pending.el.isConnected) return;
      const rect = pending.el.getBoundingClientRect();
      const delta = computeAnchorRestoreDelta({
        anchorTopNow: rect.top,
        viewportTopNow: viewport.getBoundingClientRect().top,
        targetOffset: pending.targetOffset,
        anchorHeightCaptured: pending.height,
        anchorHeightNow: rect.height,
      });
      if (Math.abs(delta) < 1) return; // already anchored (sub-pixel)
      isScrollingToBottomRef.current = true;
      viewport.scrollTop = viewport.scrollTop + delta;
      requestAnimationFrame(() => {
        isScrollingToBottomRef.current = false;
      });
    };

    // 1. Immediate, synchronous restore — before the browser paints the new
    //    layout. This alone accounts for ~99% of the correction.
    restore();

    // 2. AT MOST ONE deferred correction, applied only once the content column
    //    has stopped resizing (images / tool-cards / async highlight above the
    //    anchor can reflow after the font change) or a hard cap elapses — never a
    //    repeating poll, so it cannot flicker. Aborts (without correcting) the
    //    instant the user scrolls.
    if (typeof ResizeObserver === "undefined" || !content) return;

    const SETTLE_QUIET_MS = 80; // no resize for this long ⇒ layout settled
    const SETTLE_MAX_WAIT_MS = 500; // hard cap even if resizes keep dribbling in
    let done = false;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let hardCap: ReturnType<typeof setTimeout> | null = null;
    const abort = new AbortController();
    const observer = new ResizeObserver(() => {
      if (done) return;
      if (quietTimer !== null) clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, SETTLE_QUIET_MS);
    });
    // teardown once; apply the single final correction only on a settle finish,
    // never on a user-scroll abort or effect cleanup.
    const teardown = (applyFinal: boolean) => {
      if (done) return;
      done = true;
      if (quietTimer !== null) clearTimeout(quietTimer);
      if (hardCap !== null) clearTimeout(hardCap);
      abort.abort();
      observer.disconnect();
      if (applyFinal) restore();
    };
    function finish() {
      teardown(true);
    }
    const stop = () => teardown(false);

    hardCap = setTimeout(finish, SETTLE_MAX_WAIT_MS);
    observer.observe(content);
    // A user who scrolls during the settle window wins — wheel/touchmove are not
    // synthesised by our programmatic scroll, so the abort never self-triggers.
    viewport.addEventListener("wheel", stop, {
      passive: true,
      signal: abort.signal,
    });
    viewport.addEventListener("touchmove", stop, {
      passive: true,
      signal: abort.signal,
    });

    return () => teardown(false);
  }, [props.textScale]);

  useEffect(() => {
    isLoadingMoreRef.current = props.isLoadingMoreMessages;
    if (props.isLoadingMoreMessages) {
      loadStartedRef.current = true;
    }
    if (
      prevLoadingMoreRef.current &&
      !props.isLoadingMoreMessages &&
      pendingScrollRef.current
    ) {
      // #3768: a load-older finished. The prepended rows mount in a LATER commit
      // (assistant-ui's passive setAdapter), so the contentRef ResizeObserver has
      // not compensated yet at this isLoadingMoreMessages true→false transition.
      // Do NOT null the anchor here — that discarded it one commit early (the
      // jump-to-top bug this issue fixes).
      if (props.rawMessagesCount <= pendingScrollRef.current.count) {
        // Zero NEW raw messages: an empty/duplicate page. No rows will mount, so
        // the ResizeObserver would never fire → release the anchor now.
        pendingScrollRef.current = null;
        loadLockRef.current = false;
      } else if (loadHardCapTimerRef.current === null) {
        // Real page (count grew): leave the anchor for the ResizeObserver, but
        // arm a ~1s hard cap so a page that grows the count yet renders NO rows
        // (all normalized away, or ResizeObserver absent) cannot leave the anchor
        // stuck and wedge bottom-follow + the load lock (finding 3768-3).
        loadHardCapTimerRef.current = setTimeout(() => {
          loadHardCapTimerRef.current = null;
          if (pendingScrollRef.current) {
            pendingScrollRef.current = null;
            loadLockRef.current = false;
          }
        }, 1000);
      }
    }
    prevLoadingMoreRef.current = props.isLoadingMoreMessages;
  }, [props.isLoadingMoreMessages, props.rawMessagesCount]);

  return (
    <HappyChatProvider
      value={{
        api: props.api,
        sessionId: props.sessionId,
        metadata: props.metadata,
        disabled: props.disabled,
        onRefresh: props.onRefresh,
        onRetryMessage: props.onRetryMessage,
        chatSections,
        bookmarks: props.bookmarks,
        prefillComposer: props.prefillComposer,
      }}
    >
      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col relative">
        <ThreadPrimitive.Viewport
          asChild
          // #2858 single-ownership: render assistant-ui's scroll machinery fully
          // inert. All FOUR arming sites of its scrollingToBottomBehaviorRef are
          // off, and auiScrollToBottom is never called, so assistant-ui can never
          // scroll the viewport. HappyThread is the SOLE issuer of programmatic
          // scrolls (jump-to-bottom, follow-mode via our ResizeObserver, #833
          // restore, load-older anchor, initial position). This kills the
          // snap-vs-drag fight STRUCTURALLY: a scrollbar drag emits a scroll event
          // byte-identical to scrollTo(), so intent inference was unwinnable
          // (3rd recurrence, #710 → #1298 → #2414). Verified against 0.11.53:
          // autoScroll + scrollToBottomOn{Initialize,ThreadSwitch,RunStart} are the
          // only sites that arm the sticky ref (useThreadViewportAutoScroll.js); the
          // one legitimate send-time scroll is restored via SessionChat onUserSend.
          autoScroll={false}
          scrollToBottomOnInitialize={false}
          scrollToBottomOnThreadSwitch={false}
          scrollToBottomOnRunStart={false}
        >
          <div
            ref={viewportRef}
            // Epic #3285 round 14 (item 1 / option B): native scrollbar hidden
            // (no reserved width); position feedback is the ScrollPositionRail
            // sibling below, a read-only overlay that never scrolls this element.
            // Epic #3285 round 16: `thread-fade` = the scroll-linked mask whose
            // edges lib/threadFade.ts writes as CSS variables (see the effect
            // above). The mask sits on THIS element — the clipping viewport —
            // so the content fades where it slides behind the info bar / dock;
            // the text-size control and the position rail are siblings and
            // stay crisp.
            className="thread-fade min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-none"
            style={{ overflowAnchor: "none" }}
          >
            <div
              ref={contentRef}
              // #983 round-3 feedback: asymmetric padding — the LEFT side is
              // trimmed to 4px so the bookmark gutter hugs the screen edge
              // (bookmark + a little padding, no dead column); the right/top/
              // bottom keep the original 12px.
              className="mx-auto w-full max-w-content min-w-0 py-3 pr-3 pl-1 chat-thread-content"
              style={{ fontSize: `${14 * (props.textScale ?? 1.0)}px` }}
            >
              <div
                ref={topSentinelRef}
                className="h-px w-full"
                aria-hidden="true"
              />
              {props.isLoadingMessages ? (
                <MessageSkeleton />
              ) : (
                <>
                  {props.messagesWarning ? (
                    <div className="mb-3 rounded-md bg-amber-500/10 p-2 text-xs">
                      {props.messagesWarning}
                    </div>
                  ) : null}

                  {props.hasMoreMessages && !props.isLoadingMessages ? (
                    <div className="py-1 mb-2">
                      <div className="mx-auto w-fit">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleLoadMore}
                          disabled={
                            props.isLoadingMoreMessages ||
                            props.isLoadingMessages
                          }
                          aria-busy={props.isLoadingMoreMessages}
                          className="gap-1.5 text-xs opacity-80 hover:opacity-100"
                        >
                          {props.isLoadingMoreMessages ? (
                            <>
                              <Spinner
                                size="sm"
                                label={null}
                                className="text-current"
                              />
                              Loading…
                            </>
                          ) : (
                            <>
                              <span aria-hidden="true">↑</span>
                              Load older
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {import.meta.env.DEV &&
                  props.normalizedMessagesCount === 0 &&
                  props.rawMessagesCount > 0 ? (
                    <div className="mb-2 rounded-md bg-amber-500/10 p-2 text-xs">
                      Message normalization returned 0 items for{" "}
                      {props.rawMessagesCount} messages (see
                      `web/src/chat/normalize.ts`).
                    </div>
                  ) : null}
                </>
              )}
              <div className="flex flex-col gap-3">
                <ThreadPrimitive.Messages
                  components={THREAD_MESSAGE_COMPONENTS}
                />
              </div>
            </div>
          </div>
        </ThreadPrimitive.Viewport>
        <ScrollPositionRail scrollRef={viewportRef} />
      </ThreadPrimitive.Root>
    </HappyChatProvider>
  );
}
