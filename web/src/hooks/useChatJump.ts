// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from "react";
import type { Bookmark, DecryptedMessage } from "@hapi/protocol";
import {
  AUTO_PAGE_POLL_INTERVAL_MS,
  AUTO_PAGE_POLL_MAX_WAIT_MS,
  bookmarkSpotOffsetPx,
  resolveBookmarkAnchor,
  scrollSpotToTop,
} from "@/hooks/useBookmarkNavigation";
import {
  attachUserTakeoverListeners,
  type ResizeObserverFactory,
} from "@/hooks/useUserMessageNavigation";
import {
  pinPostingLoaded,
  pinTargetSelectors,
  type PinChatSpot,
} from "@/lib/pins/chatTarget";
import { requestFollowOff } from "@/lib/threadScrollClaim";

/**
 * Where `?at=` points (#6453, R11, R12). A pin is `undefined` while its record
 * loads and null when the session has no such pin.
 */
export type ChatJumpTarget =
  | { kind: "pin"; pin: PinChatSpot | null | undefined }
  | { kind: "bookmark"; id: string };

export interface ChatJumpOptions {
  /** One jump per value (the session and the `at` value); null: nothing to do. */
  jumpKey: string | null;
  target: ChatJumpTarget | null;
  messages: readonly DecryptedMessage[];
  bookmarks: readonly Bookmark[];
  /** True until the bookmark list has loaded; bookmarks are node-local. */
  bookmarksLoading: boolean;
  loadMore: () => Promise<unknown>;
  hasMore: boolean;
  isLoadingMore: boolean;
  /** Called once per jump when it ends, landed or not, so the caller clears `at`. */
  onDone: () => void;
  createResizeObserver?: ResizeObserverFactory;
}

/** Older pages a jump may load before it gives up. */
export const CHAT_JUMP_MAX_PAGES = 100;
/** How long the thread may take to render what the data says is loaded. */
export const CHAT_JUMP_RENDER_WAIT_MS = 1500;
/** How long a pin's own card is waited for before a block anchor is used. */
export const CHAT_JUMP_CARD_WAIT_MS = 600;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * The settle phase of each viewport's last landing. It outlives the jump's component, which
 * unmounts as soon as `at` is cleared, because the settle is what holds the spot while the
 * thread's first layout settles; it ends on its own (a user takeover, the 1 s settle, the 4 s
 * correction cap) and is cancelled by the next landing on the same viewport.
 */
const settles = new WeakMap<HTMLElement, () => void>();

/**
 * Open the chat at `?at=`: a pin's spot (KD9: its card, else the post's block
 * anchors, else the nearest earlier block) or a bookmark. It waits for the
 * viewport and the target's data, pages older messages until the spot is
 * loaded or none remain, turns the thread's follow mode off, then scrolls the
 * spot to the top through the bookmark navigation's `scrollSpotToTop`. An
 * unknown target, or a spot that never renders, leaves the chat where it is. A
 * user who scrolls while it pages stops it. It runs once per `jumpKey`.
 */
export function useChatJump(
  viewportRef: React.RefObject<HTMLElement | null>,
  options: ChatJumpOptions
): void {
  const { jumpKey, target, bookmarksLoading } = options;

  // Read inside the async run, so it sees each page as it lands.
  const live = useRef(options);
  live.current = options;

  const doneKey = useRef<string | null>(null);
  const runningKey = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // A new jump, or unmount, abandons the one in flight.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      runningKey.current = null;
    };
  }, [jumpKey]);

  useEffect(() => {
    if (!jumpKey || !target) return;
    if (doneKey.current === jumpKey || runningKey.current === jumpKey) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (target.kind === "pin" && target.pin === undefined) return;
    if (target.kind === "bookmark" && bookmarksLoading) return;

    runningKey.current = jumpKey;
    const controller = new AbortController();
    abortRef.current = controller;
    let tookOver = false;
    attachUserTakeoverListeners(viewport, controller.signal, () => {
      tookOver = true;
    });
    const stopped = () => controller.signal.aborted || tookOver;

    /** Poll `find` until it answers or `ms` pass. */
    const waitFor = async <T>(find: () => T | null, ms: number) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const found = find();
        if (found || stopped() || Date.now() >= deadline) return found;
        await sleep(AUTO_PAGE_POLL_INTERVAL_MS);
      }
    };

    /** Load one older page; false when none came. */
    const pageOnce = async (): Promise<boolean> => {
      if (!live.current.hasMore) return false;
      const before = live.current.messages.length;
      await waitFor(
        () => (live.current.isLoadingMore ? null : true),
        AUTO_PAGE_POLL_MAX_WAIT_MS
      );
      if (stopped()) return false;
      if (live.current.messages.length > before) return true;
      try {
        await live.current.loadMore();
      } catch {
        return false; // loadMore surfaced its own error
      }
      const grew = await waitFor(
        () => (live.current.messages.length > before ? true : null),
        AUTO_PAGE_POLL_MAX_WAIT_MS
      );
      return grew === true;
    };

    const land = (el: HTMLElement, offsetPx: () => number) => {
      settles.get(viewport)?.();
      // Follow off first: otherwise a content resize right after the landing can pin the
      // view back to the bottom (measured on a cold load, #6453).
      requestFollowOff(viewport);
      settles.set(
        viewport,
        scrollSpotToTop(viewport, el, offsetPx, {
          behavior: "auto",
          cause: "chat-jump",
          createResizeObserver: live.current.createResizeObserver,
        })
      );
    };

    const first = (selectors: readonly string[]): HTMLElement | null => {
      for (const selector of selectors) {
        const el = viewport.querySelector<HTMLElement>(selector);
        if (el) return el;
      }
      return null;
    };

    const jumpToPin = async (pin: PinChatSpot) => {
      for (
        let pages = 0;
        !stopped() &&
        pages < CHAT_JUMP_MAX_PAGES &&
        !pinPostingLoaded(pin, live.current.messages, live.current.hasMore);
        pages++
      ) {
        if (!(await pageOnce())) break;
      }
      if (stopped()) return;
      const selectors = () => pinTargetSelectors(pin, live.current.messages);
      const card = await waitFor(
        () => first(selectors().slice(0, 1)),
        CHAT_JUMP_CARD_WAIT_MS
      );
      const el =
        card ??
        (await waitFor(
          () => first(selectors()),
          CHAT_JUMP_RENDER_WAIT_MS - CHAT_JUMP_CARD_WAIT_MS
        ));
      if (el && !stopped()) land(el, () => 0);
    };

    const jumpToBookmark = async (id: string) => {
      const bookmark = live.current.bookmarks.find(b => b.id === id);
      if (!bookmark) return; // another node's bookmark, or deleted
      for (let pages = 0; !stopped(); pages++) {
        const resolved = await waitFor(
          () => resolveBookmarkAnchor(viewport, bookmark),
          CHAT_JUMP_RENDER_WAIT_MS
        );
        if (resolved) {
          if (!stopped()) {
            land(resolved.anchorEl, () =>
              bookmarkSpotOffsetPx(bookmark, resolved)
            );
          }
          return;
        }
        if (pages >= CHAT_JUMP_MAX_PAGES || !(await pageOnce())) return;
      }
    };

    const key = jumpKey;
    void (async () => {
      try {
        if (target.kind === "bookmark") await jumpToBookmark(target.id);
        else if (target.pin) await jumpToPin(target.pin);
      } finally {
        if (!controller.signal.aborted) {
          controller.abort(); // detaches the takeover listeners
          doneKey.current = key;
          runningKey.current = null;
          live.current.onDone();
        }
      }
    })();
  }, [jumpKey, target, bookmarksLoading, viewportRef]);
}
