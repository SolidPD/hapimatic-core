// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The chat thread's continuous reading anchor (issue #6122).
 *
 * While the user is scrolled up, the thread holds what they are reading. Whenever content above
 * it changes height (a load-older page mounting, a reasoning block opening, an image loading, a
 * row re-rendering), the viewport scrolls by exactly that change, so the text under the reader
 * stays where it was. Content that changes below it (a tool row the user opens on screen, an
 * image decoding in view) moves nothing, as with the browser's own scroll anchoring.
 *
 * Two elements are held. The line element is the one at the reading line (the first content
 * visible below the viewport's top edge), found by hit-testing; it decides. The candidate is the
 * first block or user message (a bookmark strip only in a thread with neither) at or below the
 * top edge, held by id because a
 * re-rendered row can reuse a DOM node for another message; it decides when the line element is
 * gone or the browser cannot hit-test (jsdom).
 *
 * Both are measured from the content column's top, not the viewport's. A user scroll moves an
 * element and the column together, so it never registers as a change; only content above does.
 *
 * The arithmetic lives in `lib/scroll-anchor.ts`; HappyThread owns when this runs (its content
 * ResizeObserver, its scroll handler, load start, and the end of a claim or text-size window).
 * Ownership rules: docs/internal/architecture/chat-thread-scroll.md.
 */
import { useCallback, useRef } from "react";
import {
  computeContentOffsetDelta,
  pickReadingAnchorIndex,
} from "@/lib/scroll-anchor";
import { recordEvent, recordScrollWrite } from "@/lib/scrollCauseRecorder";

/**
 * The attributes that identify a candidate, in the order an element's identity is taken from:
 * a block (BlockAnchor.tsx), a user message root (UserMessage.tsx), a message's bookmark strip
 * (BookmarkGutter.tsx).
 *
 * A strip is a candidate only in a thread with neither of the others. Its id is the thread
 * message's, and an assistant turn's id is its FIRST block's (`assistant-runtime.ts`, joined
 * by assistant-ui), so when a load-older brings in the older blocks of the turn cut by the page
 * boundary, that turn is re-keyed and remounted: its strip id disappears, and so does any
 * element inside it. Block ids (`block.id`) and user message ids survive the prepend.
 */
export const READING_ANCHOR_ATTRS = [
  "data-bookmark-anchor",
  "data-message-id",
  "data-bookmark-message",
] as const;
export type ReadingAnchorAttr = (typeof READING_ANCHOR_ATTRS)[number];
const STABLE_CANDIDATE_SELECTOR = "[data-bookmark-anchor], [data-message-id]";
const STRIP_SELECTOR = "[data-bookmark-message]";

/**
 * Marks a container whose content is laid out but clipped (the closed reasoning body,
 * `reasoning.tsx`). Anchors inside it sit out of document order on screen, so they are never
 * candidates.
 */
export const READING_ANCHOR_SKIP_ATTR = "data-scroll-anchor-skip";

/**
 * Marks the thread's message list (HappyThread). The reading-line element must be inside it:
 * the status rows above it ("Load older", the reconnecting notice) never move when older rows
 * are inserted into the list, so holding one of them would leave a prepend uncompensated.
 */
export const READING_ANCHOR_LIST_ATTR = "data-thread-message-list";

// The candidate list is rebuilt at once when rows were added or removed or the anchor was
// lost, and is at most this old when a pick uses it, so a block streamed into the last message
// becomes pickable without a rebuild every frame.
const CANDIDATES_MAX_AGE_MS = 1000;
// After a compensation (a change above the anchor, which may have added candidates) the list
// is rebuilt once it is this old, so a height animation above the reader (the 200 ms reasoning
// transition corrects every frame) costs a few rebuilds rather than one per frame. Positions
// are read live, so a height change alone never makes the list wrong.
const CANDIDATES_DIRTY_MIN_AGE_MS = 100;

/** What a scrolled-up reader is reading. */
export interface ReadingAnchor {
  /** The candidate's identity attribute and id; null holds `el` by identity alone. */
  attr: ReadingAnchorAttr | null;
  id: string;
  el: HTMLElement;
  /**
   * The element's top minus the content column's top when last observed. A user scroll never
   * changes it; only content above the element does.
   */
  baseline: number;
  /** The element at the reading line, which decides while it is still in the thread. */
  line: { el: HTMLElement; baseline: number } | null;
}

/** A short label for the scroll recorder: the element's block or message id. */
export function anchorLabel(el: HTMLElement): string {
  const id =
    el.getAttribute("data-bookmark-anchor") ||
    el.getAttribute("data-message-id") ||
    el.tagName.toLowerCase();
  return id.slice(-8);
}

export function readingAnchorIdentity(el: HTMLElement): {
  attr: ReadingAnchorAttr;
  id: string;
} {
  for (const attr of READING_ANCHOR_ATTRS) {
    const id = el.getAttribute(attr);
    if (id !== null) return { attr, id };
  }
  return { attr: "data-bookmark-anchor", id: "" };
}

const SKIP_SELECTOR = `[${READING_ANCHOR_SKIP_ATTR}]`;
// Candidates inside (or on) a skip container, in one query instead of a closest() walk per
// candidate.
const SKIPPED_CANDIDATE_SELECTOR = READING_ANCHOR_ATTRS.flatMap(attr => [
  `${SKIP_SELECTOR}[${attr}]`,
  `${SKIP_SELECTOR} [${attr}]`,
]).join(", ");

/** Every candidate in document order, which in the thread's one column is top-to-bottom. */
export function collectReadingAnchorCandidates(
  content: HTMLElement
): HTMLElement[] {
  let all = Array.from(
    content.querySelectorAll<HTMLElement>(STABLE_CANDIDATE_SELECTOR)
  );
  if (all.length === 0) {
    all = Array.from(content.querySelectorAll<HTMLElement>(STRIP_SELECTOR));
  }
  if (content.querySelector(SKIP_SELECTOR) === null) return all;
  const skipped = new Set(
    content.querySelectorAll<HTMLElement>(SKIPPED_CANDIDATE_SELECTOR)
  );
  return all.filter(el => !skipped.has(el));
}

/**
 * The anchor's element now. The held element is trusted only while it still carries the
 * anchor's id; otherwise it is found again by id. An anchor with an empty id can only be the
 * held element itself.
 */
export function resolveReadingAnchor(
  content: HTMLElement,
  anchor: ReadingAnchor
): HTMLElement | null {
  const held = anchor.el;
  const inThread = held.isConnected && content.contains(held);
  if (anchor.attr === null) return inThread ? held : null;
  if (inThread && held.getAttribute(anchor.attr) === anchor.id) return held;
  if (anchor.id === "") return null;
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(anchor.id)
      : anchor.id.replace(/["\\]/g, "\\$&");
  return content.querySelector<HTMLElement>(`[${anchor.attr}="${escaped}"]`);
}

// The reading line is probed from just below the viewport's top edge downward, so an overlay
// over the top of the thread (an info bar, the text-size control) is looked past.
const READING_LINE_PROBE_STEP_PX = 24;
const READING_LINE_PROBE_MAX_PX = 240;

function isLiveLineElement(content: HTMLElement, el: HTMLElement): boolean {
  return (
    el.isConnected && content.contains(el) && el.closest(SKIP_SELECTOR) === null
  );
}

/**
 * The element at the reading line: the first content the browser hit-tests below the
 * viewport's top edge, at two points across the column (clear of the bookmark gutter on the
 * left and the position rail on the right). Only hits inside the message list count: one
 * outside the content column is an overlay, and a status row above the list does not move when
 * older rows are inserted into it. Clipped content is skipped, as is any container around
 * `wrapped` (a message's column): content inside such a container could change above the line
 * without moving it. Null when nothing qualifies, or where the browser cannot hit-test.
 */
export function findReadingLineElement(
  viewport: HTMLElement,
  content: HTMLElement,
  wrapped: ReadonlyArray<HTMLElement | null>
): HTMLElement | null {
  if (typeof document.elementFromPoint !== "function") return null;
  const v = viewport.getBoundingClientRect();
  const c = content.getBoundingClientRect();
  const left = Math.max(v.left, c.left);
  const right = Math.min(v.right, c.right);
  if (right - left < 4 || v.height <= 0) return null;
  const xs = [left + (right - left) * 0.4, left + (right - left) * 0.75];
  const list =
    content.querySelector<HTMLElement>(`[${READING_ANCHOR_LIST_ATTR}]`) ??
    content;
  const end = v.top + Math.min(v.height / 3, READING_LINE_PROBE_MAX_PX);
  for (
    let y = Math.max(v.top, c.top) + 2;
    y <= end;
    y += READING_LINE_PROBE_STEP_PX
  ) {
    for (const x of xs) {
      const hit = document.elementFromPoint(x, y);
      if (!(hit instanceof HTMLElement) || hit === content || hit === list) {
        continue;
      }
      if (!list.contains(hit) || !isLiveLineElement(content, hit)) continue;
      if (wrapped.some(el => el !== null && el !== hit && hit.contains(el))) {
        continue;
      }
      return hit;
    }
  }
  return null;
}

type MutableRef<T> = { current: T };

export interface ReadingAnchorOptions {
  viewportRef: MutableRef<HTMLElement | null>;
  contentRef: MutableRef<HTMLElement | null>;
  /** True while the thread follows new content to the bottom; there is no anchor then. */
  followingRef: MutableRef<boolean>;
  /** The thread's programmatic-scroll guard, set for a compensation and cleared next frame. */
  programmaticScrollRef: MutableRef<boolean>;
  /** The scroll handler's direction baseline (the last scrollTop it saw). */
  directionBaselineRef: MutableRef<number>;
  /**
   * True while another writer owns the viewport (a restore, or a thread-scroll claim: a
   * navigator's correction, jump-to-top's smooth scroll). The anchor then keeps measuring but
   * does not scroll, so it is current when the window ends.
   */
  isPaused: () => boolean;
}

export interface ReadingAnchorControls {
  readingAnchorRef: MutableRef<ReadingAnchor | null>;
  /** Step (a): compensate any change above the anchor. Returns the distance scrolled. */
  compensate: (reason: string) => number;
  /** Step (b): pick the block the reader is reading now and record its offset. */
  pick: (reason: string) => void;
  /**
   * Both steps, compensate first. Whichever of the content resize and the scroll event first
   * sees a new layout compensates it; the other then measures no change. Re-picking without
   * compensating first would adopt the shifted layout as the baseline and lose the correction.
   * Clears the anchor while following. Returns the distance compensated.
   */
  sync: (reason: string) => number;
  /** Drop the anchor (a jump, or follow resuming). */
  clear: () => void;
  /** Rebuild the candidate list before the next pick (rows were added or removed). */
  invalidateCandidates: () => void;
}

export function useReadingAnchor(
  options: ReadingAnchorOptions
): ReadingAnchorControls {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const readingAnchorRef = useRef<ReadingAnchor | null>(null);
  const candidatesRef = useRef<HTMLElement[] | null>(null);
  const candidatesBuiltAtRef = useRef(0);
  const candidatesDirtyRef = useRef(false);
  // A change under a pixel is not written. Its deciding baseline is kept for the re-pick
  // that follows the compensation, so slow sub-pixel drift adds up to a correction.
  const subPixelCarryRef = useRef<{ el: HTMLElement; baseline: number } | null>(
    null
  );

  const compensate = useCallback((reason: string): number => {
    subPixelCarryRef.current = null;
    const {
      viewportRef,
      contentRef,
      followingRef,
      programmaticScrollRef,
      directionBaselineRef,
      isPaused,
    } = optionsRef.current;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const anchor = readingAnchorRef.current;
    if (!viewport || !content || !anchor) return 0;
    // Following: new content is followed to the bottom, never compensated.
    if (followingRef.current) return 0;
    const el = resolveReadingAnchor(content, anchor);
    const line =
      anchor.line && isLiveLineElement(content, anchor.line.el)
        ? anchor.line
        : null;
    if (!el && !line) {
      recordEvent(
        "anchor-lost",
        `${anchor.attr ?? "el"}=${anchor.id.slice(-8)} reason=${reason}`,
        viewport
      );
      readingAnchorRef.current = null;
      candidatesRef.current = null;
      return 0;
    }
    const contentTop = content.getBoundingClientRect().top;
    const offsetNow = el ? el.getBoundingClientRect().top - contentTop : null;
    const lineNow = line
      ? line.el.getBoundingClientRect().top - contentTop
      : null;
    // Re-base what did not decide: the candidate below the line moves with on-screen changes
    // the line element ignores, and a later fallback to it must not replay them.
    if (el) anchor.el = el;
    anchor.line = line;
    const rebase = () => {
      if (offsetNow !== null) anchor.baseline = offsetNow;
      if (line && lineNow !== null) line.baseline = lineNow;
    };
    if (isPaused()) {
      rebase();
      return 0;
    }
    const delta =
      line && lineNow !== null
        ? computeContentOffsetDelta(lineNow, line.baseline)
        : computeContentOffsetDelta(
            offsetNow ?? anchor.baseline,
            anchor.baseline
          );
    // Under a pixel: no write. The deciding baseline carries into the re-pick that follows
    // (`subPixelCarryRef`), so slow sub-pixel drift still adds up to a correction.
    if (Math.abs(delta) < 1) {
      if (line && offsetNow !== null) anchor.baseline = offsetNow;
      subPixelCarryRef.current = line
        ? { el: line.el, baseline: line.baseline }
        : { el: el ?? anchor.el, baseline: anchor.baseline };
      return 0;
    }
    programmaticScrollRef.current = true;
    const before = viewport.scrollTop;
    viewport.scrollTop = before + delta;
    recordScrollWrite(
      "reading-anchor-compensation",
      viewport,
      before,
      viewport.scrollTop,
      `delta=${Math.round(delta)} anchor=${line ? `line:${line.el.tagName.toLowerCase()}` : anchorLabel(el ?? anchor.el)} reason=${reason}`
    );
    // The single-frame guard does not cover a write made inside a scroll handler: that
    // frame's rAF clears it before the write's own scroll event arrives. Moving the direction
    // baseline makes that echo read as no movement, never as a scroll down.
    directionBaselineRef.current = viewport.scrollTop;
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
    rebase();
    // Something above the anchor changed, so the candidate list may have too.
    candidatesDirtyRef.current = true;
    return delta;
  }, []);

  const pick = useCallback((reason: string) => {
    const { viewportRef, contentRef } = optionsRef.current;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const now = performance.now();
    let candidates = candidatesRef.current;
    const age = now - candidatesBuiltAtRef.current;
    if (
      !candidates ||
      age > CANDIDATES_MAX_AGE_MS ||
      (candidatesDirtyRef.current && age > CANDIDATES_DIRTY_MIN_AGE_MS)
    ) {
      candidates = collectReadingAnchorCandidates(content);
      candidatesRef.current = candidates;
      candidatesBuiltAtRef.current = now;
      candidatesDirtyRef.current = false;
      recordEvent(
        "anchor-candidates",
        `n=${candidates.length} ms=${(performance.now() - now).toFixed(2)} reason=${reason}`,
        viewport
      );
    }
    const list = candidates;
    // About log2(n) rect reads: the tops are read lazily inside the binary search.
    const index = pickReadingAnchorIndex(
      list.length,
      i => list[i].getBoundingClientRect().top,
      viewport.getBoundingClientRect().top
    );
    const picked = index >= 0 ? list[index] : null;
    // The cached list went stale: rebuild before the next pick.
    if (picked && !picked.isConnected) candidatesRef.current = null;
    const el = picked && picked.isConnected ? picked : null;
    // The candidate across the top edge, when the pick lies below it: a container around
    // either one is no reading-line element.
    const straddler =
      el && index > 0 && list[index - 1].isConnected ? list[index - 1] : null;
    const lineEl = findReadingLineElement(viewport, content, [el, straddler]);
    const contentTop = content.getBoundingClientRect().top;
    // The compensation just before this pick skipped a sub-pixel change: re-picking the
    // element that decided keeps its baseline, so the change is not absorbed.
    const carry = subPixelCarryRef.current;
    subPixelCarryRef.current = null;
    const baselineOf = (target: HTMLElement): number =>
      carry && carry.el === target
        ? carry.baseline
        : target.getBoundingClientRect().top - contentTop;
    const line = lineEl ? { el: lineEl, baseline: baselineOf(lineEl) } : null;
    if (el) {
      readingAnchorRef.current = {
        ...readingAnchorIdentity(el),
        el,
        baseline: line
          ? el.getBoundingClientRect().top - contentTop
          : baselineOf(el),
        line,
      };
    } else if (line) {
      // No candidates (a thread with none rendered yet): hold the line element alone.
      readingAnchorRef.current = {
        attr: null,
        id: "",
        el: line.el,
        baseline: line.baseline,
        line,
      };
    } else {
      readingAnchorRef.current = null;
    }
  }, []);

  const sync = useCallback(
    (reason: string): number => {
      if (optionsRef.current.followingRef.current) {
        readingAnchorRef.current = null;
        return 0;
      }
      const compensated = compensate(reason);
      pick(reason);
      return compensated;
    },
    [compensate, pick]
  );

  const clear = useCallback(() => {
    readingAnchorRef.current = null;
    subPixelCarryRef.current = null;
  }, []);

  const invalidateCandidates = useCallback(() => {
    candidatesRef.current = null;
  }, []);

  return {
    readingAnchorRef,
    compensate,
    pick,
    sync,
    clear,
    invalidateCandidates,
  };
}
