// SPDX-License-Identifier: AGPL-3.0-only
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const NONE: ReadonlySet<string> = new Set();

/**
 * #6449 (D12): which rows have come near the screen, so they render their
 * tooltips. One `IntersectionObserver` for the whole list (the
 * `hasBeenVisible` pattern of `LazyRainbowText.tsx`, with one observer
 * instead of one per row), a margin of about one screen height. Rows do not
 * arm on pointer-enter or focus: arming swaps the element, so the first tap
 * would be lost.
 *
 * `reset()` (#6451) disarms every row and observes them again, so only the rows
 * within about a screen re-arm. `PinsList` calls it when its `layoutKey` (the
 * facets, the search and the grouping) changes: those remount rows in bulk,
 * and a remounted row that was already armed would mount all its tooltips at
 * once (the 159-914 ms #6449 measured for 100-500 rows). Call it during the
 * render that changes the list (it only sets state), so no row mounts armed
 * in between.
 */
export function useArmedRows(
  /** The list's scroll box; null measures against the viewport. */
  root: Element | null = null,
  rootMargin: string = "100% 0px"
): {
  armed: ReadonlySet<string>;
  observe: (key: string, element: Element | null) => void;
  reset: () => void;
} {
  const [armed, setArmed] = useState<ReadonlySet<string>>(() => new Set());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const observerRoot = useRef<Element | null>(null);
  // The rows still waiting to arm, by element.
  const keysByElement = useRef(new Map<Element, string>());
  // Every mounted row, armed or not, so a reset can observe it again.
  const elementsByKey = useRef(new Map<string, Element>());
  const [generation, setGeneration] = useState(0);

  const arm = useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    setArmed(prev => {
      if (keys.every(key => prev.has(key))) return prev;
      const next = new Set(prev);
      for (const key of keys) next.add(key);
      return next;
    });
  }, []);

  const observer = useCallback((): IntersectionObserver | null => {
    if (observerRef.current) return observerRef.current;
    if (typeof IntersectionObserver === "undefined") return null;
    observerRoot.current = root;
    observerRef.current = new IntersectionObserver(
      entries => {
        const keys: string[] = [];
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const key = keysByElement.current.get(entry.target);
          if (key === undefined) continue;
          keys.push(key);
          observerRef.current?.unobserve(entry.target);
          keysByElement.current.delete(entry.target);
        }
        arm(keys);
      },
      // The rows scroll inside the page's own box, not the viewport: measured
      // against the viewport, the margin would never arm a row ahead of view.
      { root, rootMargin }
    );
    return observerRef.current;
  }, [arm, root, rootMargin]);

  // A new scroll box (it mounts after the rows register): move every
  // unarmed row onto an observer rooted in it.
  useEffect(() => {
    if (!observerRef.current || observerRoot.current === root) return;
    observerRef.current.disconnect();
    observerRef.current = null;
    const io = observer();
    if (!io) return;
    for (const element of keysByElement.current.keys()) io.observe(element);
  }, [observer, root]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  const observe = useCallback(
    (key: string, element: Element | null) => {
      const io = observer();
      const previous = elementsByKey.current.get(key);
      if (previous && previous !== element) {
        io?.unobserve(previous);
        keysByElement.current.delete(previous);
        elementsByKey.current.delete(key);
      }
      if (!element) return;
      elementsByKey.current.set(key, element);
      if (!io) {
        // No IntersectionObserver: every row gets its tooltips at once.
        arm([key]);
        return;
      }
      keysByElement.current.set(element, key);
      io.observe(element);
    },
    [arm, observer]
  );

  const reset = useCallback(() => {
    setArmed(prev => (prev.size === 0 ? prev : NONE));
    setGeneration(n => n + 1);
  }, []);

  // After a reset commits: a fresh observer for every registered row. The
  // Ledger's rows drop their ref once armed and register again when the reset
  // disarms them; a row that keeps its ref is observed again here.
  useLayoutEffect(() => {
    if (generation === 0) return;
    observerRef.current?.disconnect();
    observerRef.current = null;
    keysByElement.current.clear();
    const io = observer();
    if (!io) {
      arm([...elementsByKey.current.keys()]);
      return;
    }
    for (const [key, element] of elementsByKey.current) {
      keysByElement.current.set(element, key);
      io.observe(element);
    }
  }, [arm, generation, observer]);

  return { armed, observe, reset };
}
