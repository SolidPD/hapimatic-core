// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A claim on a chat thread's scroll position (issue #6122).
 *
 * The thread's reading anchor (HappyThread) keeps the text under a scrolled-up reader in
 * place when content above it changes height. The message and bookmark navigators run their
 * own short post-snap correction (`startPostSnapCorrection`, at most 4 s) that holds a
 * centred target instead, and jump-to-top runs a smooth scroll that a write would cut short.
 * If both wrote during that window they would fight, and the navigator would mistake the
 * anchor's write for a user scroll and stop early. While a claim is held, the reading anchor
 * stays passive (it keeps re-measuring, so it is current when the claim ends).
 *
 * A claim names the viewport it holds, so in split view a navigator in one pane does not
 * pause the other pane's anchor; a claim with no viewport holds every thread.
 *
 * Every claim is released by its owner's teardown, which always runs (each owner's window has
 * a hard cap), so a claim cannot strand the anchor off.
 */

// The key for claims that hold every thread: an object, so it can never equal a viewport.
const ALL_THREADS_KEY: object = {};
const holders = new Map<object, number>();

/** Take a claim on `viewport` (every thread when omitted). The returned release is idempotent. */
export function claimThreadScroll(viewport: Element | null = null): () => void {
  const key: object = viewport ?? ALL_THREADS_KEY;
  holders.set(key, (holders.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (holders.get(key) ?? 0) - 1;
    if (left > 0) holders.set(key, left);
    else holders.delete(key);
  };
}

/**
 * True while a claim holds `viewport`: one taken for it or one for every thread. With no
 * viewport, true while any claim is held anywhere.
 */
export function isThreadScrollClaimed(
  viewport: Element | null = null
): boolean {
  if (viewport === null) return holders.size > 0;
  return holders.has(ALL_THREADS_KEY) || holders.has(viewport);
}

const followOffListeners = new Map<Element, Set<() => void>>();

/**
 * #6453: ask the thread on `viewport` to stop following the bottom, as a user scroll up would.
 * A navigator that lands the view on a chosen spot (the `?at=` chat jump) calls it first: on a
 * cold load its scroll event can arrive inside follow's one-frame write guard and be ignored, and
 * follow would then pin the next content resize back to the bottom. The thread treats it as user
 * intent (`useFollowOffRequests`), so the at-bottom safety net cannot turn follow back on.
 */
export function requestFollowOff(viewport: Element): void {
  for (const listener of [...(followOffListeners.get(viewport) ?? [])]) {
    listener();
  }
}

/** The thread's side of `requestFollowOff`. Returns the unsubscribe. */
export function onFollowOffRequest(
  viewport: Element,
  listener: () => void
): () => void {
  let set = followOffListeners.get(viewport);
  if (!set) followOffListeners.set(viewport, (set = new Set()));
  set.add(listener);
  return () => {
    const current = followOffListeners.get(viewport);
    current?.delete(listener);
    if (current?.size === 0) followOffListeners.delete(viewport);
  };
}

/** Test-only: drop every claim and follow-off listener. */
export function resetThreadScrollClaimsForTests(): void {
  holders.clear();
  followOffListeners.clear();
}
