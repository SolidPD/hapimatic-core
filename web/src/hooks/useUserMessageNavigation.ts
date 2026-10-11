// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import { computeAnchorRestoreDelta } from "@/lib/scroll-anchor";

export interface UserMessageNavigationOptions {
  loadMore: () => Promise<unknown>;
  hasMore: boolean;
  isLoadingMore: boolean;
  totalUserMessages: number;
  /**
   * ResizeObserver factory for the post-snap correction phase (#3878). Tests
   * inject a capturing factory (the setup stub is a no-op); defaults to the
   * platform `ResizeObserver`.
   */
  createResizeObserver?: ResizeObserverFactory;
}

export type ResizeObserverFactory = (
  callback: ResizeObserverCallback
) => ResizeObserver;

export interface UserMessageNavigationState {
  hasPrevious: boolean;
  hasNext: boolean;
  goToPrevious: () => void;
  goToNext: () => void;
  currentIndex: number;
  totalCount: number;
  isAutoPaging: boolean;
  abortAutoPage: () => void;
}

const HIGHLIGHT_DURATION_MS = 800;
const SCROLL_START_DELAY_MS = 50;
const AUTO_PAGE_POLL_INTERVAL_MS = 50;
const AUTO_PAGE_POLL_MAX_WAIT_MS = 8000;

// Post-layout re-anchor (#2515). After the initial smooth scroll, poll the
// target's viewport-relative top until it stops moving (images / tool-result
// cards above it finish decoding/resizing), then snap onto the settled
// position. The interval mirrors AUTO_PAGE_POLL_INTERVAL_MS so the loop is
// drivable under vi.useFakeTimers(); the budget caps the wait if content never
// fully settles; the epsilon is the px threshold below which two samples count
// as "stable".
const SETTLE_POLL_INTERVAL_MS = 50;
const SETTLE_MAX_WAIT_MS = 1000;
export const SETTLE_STABLE_EPSILON_PX = 1;
// Post-snap correction (#3878, the #3158 K10 contract). The settle poll above
// exits on the FIRST quiet 50 ms window, so a discrete resize that lands after
// the snap (a late image decode, a tool card expanding) was never corrected —
// worst right after a session opens. After the snap a debounced ResizeObserver
// on the content column applies AT MOST ONE absolute correction per resize
// burst, hard-capped — never a repeating programmatic-scroll poll (iOS WebKit
// paints that as flicker, HappyThread.tsx #3158).
export const POST_SNAP_DEBOUNCE_MS = 100;
export const POST_SNAP_MAX_WINDOW_MS = 4000;
// Where the target lands in the viewport. "center" keeps the whole message
// visible and avoids a top-anchored message being hidden behind the floating
// nav/compose overlay (issue #2515 Key Decision 2). Change to "start" to anchor
// at the top of the viewport (add scroll-margin-top to the message root to clear
// any sticky header if you do).
const SCROLL_BLOCK: ScrollLogicalPosition = "center";

function readMessageId(el: HTMLElement | null | undefined): string | null {
  return el?.getAttribute("data-message-id") ?? null;
}

/** Keys that scroll the thread — pressing one means the user took over. */
const USER_SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
  "Spacebar",
]);

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Wire the "user takes over" cancel set shared by both chat-nav hooks (#2515
 * R3, widened by #3878). `wheel`/`touchmove` are user-intent events a layout
 * shift or a programmatic scroll cannot fire; `pointerdown` inside the viewport
 * is a tap/drag the user started; a navigation `keydown` on the document scrolls
 * the thread (keys typed into an editable field — the composer — do not). The
 * listeners detach when `signal` aborts. Scrollbar / `scroll`-only input is
 * caught separately by the post-snap phase's `scrollTop` drift check.
 */
export function attachUserTakeoverListeners(
  viewport: HTMLElement,
  signal: AbortSignal,
  onTakeover: () => void
): void {
  const passive = { passive: true, signal };
  viewport.addEventListener("wheel", onTakeover, passive);
  viewport.addEventListener("touchmove", onTakeover, passive);
  viewport.addEventListener("pointerdown", onTakeover, passive);
  const doc = viewport.ownerDocument;
  doc.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      if (!USER_SCROLL_KEYS.has(event.key)) return;
      if (isEditableTarget(event.target)) return;
      onTakeover();
    },
    { signal }
  );
}

const defaultResizeObserverFactory: ResizeObserverFactory = callback =>
  new ResizeObserver(callback);

export interface PostSnapCorrectionOptions {
  viewport: HTMLElement;
  /**
   * The target's current client top (CSS px), or null when it is gone. Read
   * once when the phase starts — immediately after the settle snap — as the
   * baseline the phase holds the target at, then on every correction.
   */
  targetTop: () => number | null;
  createResizeObserver?: ResizeObserverFactory;
  /** Called when the phase ends early because the user moved the viewport. */
  onUserScroll: () => void;
}

/**
 * The post-snap correction phase (#3878, the #3158 K10 contract). Observes the
 * content column (`viewport.firstElementChild`) and, once a resize burst has
 * gone quiet for `POST_SNAP_DEBOUNCE_MS`, applies AT MOST ONE correction — an
 * ABSOLUTE `scrollTop` assignment (idempotent, never a compounding `scrollBy`)
 * and only when the target moved by more than `SETTLE_STABLE_EPSILON_PX`. Ends
 * after `POST_SNAP_MAX_WINDOW_MS`. If `scrollTop` moved between observations by
 * anything other than this phase's own correction, the user (or HappyThread's
 * own scroll owner) took over — the phase stops and never yanks them back. The
 * thread viewport sets `overflow-anchor: none`, so the browser never moves
 * `scrollTop` on its own. Returns the teardown (idempotent).
 */
export function startPostSnapCorrection({
  viewport,
  targetTop,
  createResizeObserver = defaultResizeObserverFactory,
  onUserScroll,
}: PostSnapCorrectionOptions): () => void {
  const content = viewport.firstElementChild;
  const topAtSnap = targetTop();
  if (!content || topAtSnap === null) return () => {};
  // Hold the target where the snap put it — its measured post-snap viewport
  // offset, not a formula ideal — so a snap the browser clamped at a scroll edge
  // (or centered differently than a formula would) is never nudged by the
  // observer's initial callback right after it lands.
  const offsetAfterSnap = topAtSnap - viewport.getBoundingClientRect().top;

  let done = false;
  let debounceId: ReturnType<typeof setTimeout> | null = null;
  let expectedScrollTop = viewport.scrollTop;

  const userMoved = (): boolean =>
    Math.abs(viewport.scrollTop - expectedScrollTop) > SETTLE_STABLE_EPSILON_PX;

  const correct = () => {
    debounceId = null;
    if (done) return;
    if (userMoved()) {
      teardown();
      onUserScroll();
      return;
    }
    const topNow = targetTop();
    if (topNow === null) {
      teardown();
      return;
    }
    const delta = computeAnchorRestoreDelta({
      anchorTopNow: topNow,
      viewportTopNow: viewport.getBoundingClientRect().top,
      targetOffset: offsetAfterSnap,
    });
    if (Math.abs(delta) <= SETTLE_STABLE_EPSILON_PX) return;
    viewport.scrollTop = viewport.scrollTop + delta;
    // Read back: the browser clamps to the scroll range.
    expectedScrollTop = viewport.scrollTop;
  };

  const observer = createResizeObserver(() => {
    if (done) return;
    if (userMoved()) {
      teardown();
      onUserScroll();
      return;
    }
    if (debounceId !== null) clearTimeout(debounceId);
    debounceId = setTimeout(correct, POST_SNAP_DEBOUNCE_MS);
  });
  const capId = setTimeout(() => teardown(), POST_SNAP_MAX_WINDOW_MS);

  function teardown() {
    if (done) return;
    done = true;
    observer.disconnect();
    if (debounceId !== null) clearTimeout(debounceId);
    debounceId = null;
    clearTimeout(capId);
  }

  observer.observe(content);
  return teardown;
}

export function useUserMessageNavigation(
  viewportRef: React.RefObject<HTMLElement | null>,
  options: UserMessageNavigationOptions
): UserMessageNavigationState {
  const { loadMore, hasMore, totalUserMessages } = options;
  // Held in a ref so an inline factory never re-creates the nav callbacks.
  const createResizeObserverRef = useRef(options.createResizeObserver);
  createResizeObserverRef.current = options.createResizeObserver;

  const [cursorId, setCursorId] = useState<string | null>(null);
  const [loadedCount, setLoadedCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [isAutoPaging, setIsAutoPaging] = useState(false);

  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastUserMessageIdsRef = useRef<string[]>([]);
  // Cancels the in-flight post-layout re-anchor (#2515). Holds the current
  // settle loop's cleanup fn; null when no settle is pending.
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

  const getUserMessages = useCallback((): HTMLElement[] => {
    const viewport = viewportRef.current;
    if (!viewport) return [];
    return Array.from(
      viewport.querySelectorAll<HTMLElement>('[data-message-role="user"]')
    );
  }, [viewportRef]);

  const getUserMessageIds = useCallback((): string[] => {
    return getUserMessages()
      .map(el => readMessageId(el))
      .filter((id): id is string => id !== null && id.length > 0);
  }, [getUserMessages]);

  const findIndexById = useCallback(
    (messages: HTMLElement[], id: string | null): number => {
      if (!id) return -1;
      return messages.findIndex(el => readMessageId(el) === id);
    },
    []
  );

  const highlightMessage = useCallback(
    (element: HTMLElement) => {
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
      }
      const viewport = viewportRef.current;
      if (viewport) {
        viewport.querySelectorAll(".animate-message-highlight").forEach(el => {
          el.classList.remove("animate-message-highlight");
        });
      }
      element.classList.add("animate-message-highlight");
      highlightTimeoutRef.current = setTimeout(() => {
        element.classList.remove("animate-message-highlight");
      }, HIGHLIGHT_DURATION_MS);
    },
    [viewportRef]
  );

  // Cancel any in-flight post-layout re-anchor (#2515). Idempotent: safe to
  // call when no settle is pending.
  const cancelReanchor = useCallback(() => {
    settleCancelRef.current?.();
  }, []);

  // Post-layout re-anchor (#2515, extended by #3878). The initial smooth scroll
  // locks its destination at call time, but late-decoding images and
  // expanding/collapsing tool-result cards *above* the target shift its absolute
  // position while the ~300–500 ms animation runs, so the browser lands
  // short/long — worst right after a session opens (heights not yet settled).
  // Phase 1 polls the target's viewport-relative top until it stops moving (or a
  // budget elapses), then snaps onto the settled position with ONE instant
  // correction and re-arms the highlight. Phase 2 (#3878) catches the resizes
  // that land AFTER that first quiet window: a debounced ResizeObserver applies
  // at most one absolute correction per resize burst, hard-capped (the #3158
  // K10 contract — never a repeating programmatic-scroll poll).
  const startReanchor = useCallback(
    (element: HTMLElement) => {
      // Supersede any prior settle so an older correction can never win a race
      // against a newer navigation.
      settleCancelRef.current?.();

      const viewport = viewportRef.current;
      const deadline = Date.now() + SETTLE_MAX_WAIT_MS;
      let lastTop = element.getBoundingClientRect().top;
      let timerId: ReturnType<typeof setTimeout> | null = null;
      let stopCorrection: (() => void) | null = null;
      // Auto-removes the user-takeover listeners on abort (jsdom supports the
      // AbortSignal addEventListener option).
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
        const top = element.getBoundingClientRect().top;
        const stable = Math.abs(top - lastTop) < SETTLE_STABLE_EPSILON_PX;
        lastTop = top;
        if (stable || Date.now() >= deadline) {
          // Snap onto the settled element (instant — the smooth entry motion
          // already played) and re-arm the highlight on the corrected target.
          element.scrollIntoView({ behavior: "auto", block: SCROLL_BLOCK });
          highlightMessage(element);
          if (!viewport) {
            cleanup();
            return;
          }
          // The highlight is NOT re-armed per correction — that would flash.
          stopCorrection = startPostSnapCorrection({
            viewport,
            targetTop: () =>
              element.isConnected ? element.getBoundingClientRect().top : null,
            createResizeObserver: createResizeObserverRef.current,
            onUserScroll: cleanup,
          });
          return;
        }
        timerId = setTimeout(tick, SETTLE_POLL_INTERVAL_MS);
      };

      // A user who takes over during the settle or correction window wins —
      // never yank them back to the target (#2515 R3).
      if (viewport) {
        attachUserTakeoverListeners(viewport, listenerAbort.signal, cleanup);
      }

      settleCancelRef.current = cleanup;
      timerId = setTimeout(tick, SETTLE_POLL_INTERVAL_MS);
    },
    [viewportRef, highlightMessage]
  );

  const navigateToElement = useCallback(
    (element: HTMLElement, index: number) => {
      const targetId = readMessageId(element);
      // Update the cursor ref + currentIndex state SYNCHRONOUSLY so any
      // MutationObserver fire that lands between this point and the post-scroll
      // setCursorId reads the new cursor (not the old one). Without this,
      // smooth-scroll-triggered DOM mutations cause recomputeState to read a
      // stale cursorIdRef and reset currentIndex back to its pre-click value,
      // forcing a second click to navigate further than intended.
      if (targetId) {
        cursorIdRef.current = targetId;
      }
      // A new navigation supersedes any pending re-anchor from the previous one
      // (#2515 R3) — otherwise a stale correction could yank the freshly-chosen
      // target.
      cancelReanchor();

      // Honor prefers-reduced-motion: an instant initial scroll has no
      // animation to drift, but the re-anchor still runs to catch layout shift.
      const prefersReducedMotion =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      element.scrollIntoView({
        behavior: prefersReducedMotion ? "auto" : "smooth",
        block: SCROLL_BLOCK,
      });
      setTimeout(() => {
        highlightMessage(element);
        if (targetId) setCursorId(targetId);
        setCurrentIndex(index);
      }, SCROLL_START_DELAY_MS);
      // Re-anchor onto the target after the layout settles so images/tool-cards
      // resizing during the scroll don't leave it off-target (#2515 R1/R2).
      startReanchor(element);
    },
    [highlightMessage, cancelReanchor, startReanchor]
  );

  const recomputeState = useCallback(() => {
    const messages = getUserMessages();
    const ids = messages
      .map(el => readMessageId(el))
      .filter((id): id is string => id !== null && id.length > 0);
    const prevIds = lastUserMessageIdsRef.current;

    setLoadedCount(messages.length);

    const oldCursor = cursorIdRef.current;
    let nextCursor = oldCursor;

    if (messages.length === 0) {
      nextCursor = null;
    } else if (oldCursor === null) {
      // Initialization: anchor to the newest user message
      nextCursor = ids[ids.length - 1] ?? null;
    } else if (findIndexById(messages, oldCursor) === -1) {
      // Cursor's message no longer in DOM (e.g., session swap). Re-anchor to newest.
      nextCursor = ids[ids.length - 1] ?? null;
    } else if (ids.length > prevIds.length) {
      const grewAtEnd =
        prevIds.length > 0 &&
        ids[ids.length - 1] !== prevIds[prevIds.length - 1];
      const cursorWasAtNewest =
        prevIds.length === 0 || oldCursor === prevIds[prevIds.length - 1];

      if (grewAtEnd && cursorWasAtNewest) {
        // User sent a new message AND was anchored to the newest — advance the cursor.
        nextCursor = ids[ids.length - 1];
      }
      // Otherwise: cursor stays anchored (load-older prepend or user navigated away).
    }

    lastUserMessageIdsRef.current = ids;

    if (nextCursor !== oldCursor) {
      setCursorId(nextCursor);
      cursorIdRef.current = nextCursor;
    }
    const idx = nextCursor ? findIndexById(messages, nextCursor) : -1;
    // Only update currentIndex if it would actually change, to avoid
    // overriding navigateToElement's index during a smooth-scroll animation.
    setCurrentIndex(prev => (prev === idx ? prev : idx));
  }, [getUserMessages, findIndexById]);

  // Track DOM changes and re-anchor cursor as needed.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    recomputeState();

    const observer = new MutationObserver(() => {
      const currentIds = getUserMessageIds();
      const prevIds = lastUserMessageIdsRef.current;
      // Only recompute when the user-message list actually changed; skips text-streaming noise.
      if (
        currentIds.length !== prevIds.length ||
        (currentIds.length > 0 &&
          (currentIds[0] !== prevIds[0] ||
            currentIds[currentIds.length - 1] !== prevIds[prevIds.length - 1]))
      ) {
        recomputeState();
      }
    });
    observer.observe(viewport, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, [viewportRef, recomputeState, getUserMessageIds]);

  // Re-anchor when viewport ref changes (e.g., session swap).
  useEffect(() => {
    cursorIdRef.current = null;
    setCursorId(null);
    setCurrentIndex(-1);
    setLoadedCount(0);
    lastUserMessageIdsRef.current = [];
    recomputeState();
  }, [viewportRef, recomputeState]);

  const abortAutoPage = useCallback(() => {
    // Also cancel any pending re-anchor correction (#2515 R3).
    settleCancelRef.current?.();
    abortControllerRef.current?.abort();
  }, []);

  const goToPrevious = useCallback(() => {
    const messages = getUserMessages();
    const cursor = cursorIdRef.current;
    const idx = findIndexById(messages, cursor);

    if (idx > 0) {
      navigateToElement(messages[idx - 1], idx - 1);
      return;
    }

    if (idx === 0 && hasMoreRef.current && !isAutoPaging) {
      // At the topmost loaded user message but older pages exist — start auto-paging.
      const controller = new AbortController();
      abortControllerRef.current = controller;
      setIsAutoPaging(true);

      (async () => {
        try {
          while (!controller.signal.aborted && hasMoreRef.current) {
            const beforeIds = getUserMessageIds();
            const beforeCount = beforeIds.length;

            try {
              await loadMoreRef.current();
            } catch {
              // Underlying loadMore swallowed the error; the load-older
              // UI in HappyThread is responsible for surfacing it.
              break;
            }

            if (controller.signal.aborted) break;

            // Poll for the new page to land in the DOM. React + react-query
            // schedules a re-render after the promise settles, but it's not
            // synchronous — wait for the count to grow OR for a brief budget.
            const deadline = Date.now() + AUTO_PAGE_POLL_MAX_WAIT_MS;
            let nextIds = beforeIds;
            while (
              !controller.signal.aborted &&
              Date.now() < deadline &&
              nextIds.length <= beforeCount
            ) {
              await new Promise(r => setTimeout(r, AUTO_PAGE_POLL_INTERVAL_MS));
              nextIds = getUserMessageIds();
            }

            if (controller.signal.aborted) break;
            if (nextIds.length > beforeCount) {
              // A page landed; check if it brought new user messages BEFORE
              // the prior cursor target. The cursor target is now at the
              // same end-relative position; if nextIds is longer at the
              // start, we can navigate to the user message immediately
              // before the old top.
              const newMessages = getUserMessages();
              const oldTopId = beforeIds[0] ?? null;
              const oldTopIdx = findIndexById(newMessages, oldTopId);
              if (oldTopIdx > 0) {
                navigateToElement(newMessages[oldTopIdx - 1], oldTopIdx - 1);
                break;
              }
              // No new user messages on this page — keep paging.
              continue;
            }

            // Polling timed out without seeing new content; bail.
            break;
          }
        } finally {
          setIsAutoPaging(false);
          abortControllerRef.current = null;
        }
      })();
    }
  }, [
    getUserMessages,
    getUserMessageIds,
    findIndexById,
    navigateToElement,
    isAutoPaging,
  ]);

  const goToNext = useCallback(() => {
    const messages = getUserMessages();
    const cursor = cursorIdRef.current;
    const idx = findIndexById(messages, cursor);
    if (idx >= 0 && idx < messages.length - 1) {
      navigateToElement(messages[idx + 1], idx + 1);
    }
  }, [getUserMessages, findIndexById, navigateToElement]);

  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
      }
      // Cancel any pending re-anchor so its timer/listeners can't fire after
      // unmount (#2515 R3).
      settleCancelRef.current?.();
      abortControllerRef.current?.abort();
    };
  }, []);

  const hasPrevious =
    (currentIndex > 0 || (currentIndex === 0 && hasMore) || isAutoPaging) &&
    loadedCount > 0;
  const hasNext = currentIndex >= 0 && currentIndex < loadedCount - 1;
  const totalCount = totalUserMessages > 0 ? totalUserMessages : loadedCount;

  return {
    hasPrevious,
    hasNext,
    goToPrevious,
    goToNext,
    currentIndex,
    totalCount,
    isAutoPaging,
    abortAutoPage,
  };
}
