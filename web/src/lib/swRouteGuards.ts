// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #4924 — let a replacement service worker take over as soon as the user taps
 * the update bar.
 *
 * When the bar's tap posts `SKIP_WAITING`, Chromium activates the waiting
 * worker only once the OUTGOING worker has no event in flight, or after five
 * minutes (`IsReadyToActivate` / `kMaxLameDuckTime` in
 * content/browser/service_worker/service_worker_registration.cc). A Workbox
 * runtime route that waits on the network (always for a NetworkFirst route
 * without a timeout, and on any cache miss) keeps its fetch event open until
 * the network answer and the cache write have settled, for as long as the
 * network takes, and a page aborting its own request does NOT end the
 * worker's fetch. On the busy prod hub that kept the outgoing worker working
 * for the full five minutes, so the bar came back after every refresh.
 *
 * Two helpers remove that work:
 *  - `unlessReplacementWaiting` makes a runtime route stop matching while a
 *    newer worker waits, so the request goes straight to the network and
 *    leaves no event open on the outgoing worker;
 *  - `boundedFetchPlugin` aborts an API route's fetch after
 *    `RUNTIME_FETCH_TIMEOUT_MS`, so a request that started before the
 *    replacement installed cannot hold the swap for longer than that. The
 *    deadline covers the whole transfer (an abort also ends the response
 *    body), so it is applied only to the API routes, whose callers give up at
 *    the same 30 s anyway — never to asset routes, where a large file on a
 *    slow link may legitimately take longer.
 *
 * The precache route is deliberately NOT guarded: it answers from Cache
 * Storage (no network wait) and it is the only place the running bundle's
 * lazily loaded chunks still exist once the server has moved on.
 *
 * Pure and window-free: this module is bundled into the service worker.
 */

/** The part of a `ServiceWorkerRegistration` the guard reads. */
export interface RegistrationLike {
  readonly waiting: unknown;
}

/**
 * How long an API-route fetch may run in the worker (asset routes are not
 * bounded). Matches
 * `ApiClient.DEFAULT_TIMEOUT_MS` (web/src/api/client.ts): the page has given up
 * by then, so a longer worker fetch serves nobody. It stays above the
 * session-detail route's 28 s `networkTimeoutSeconds`, so that route's cache
 * fallback still answers first.
 */
export const RUNTIME_FETCH_TIMEOUT_MS = 30_000;

/** True while a newer worker sits in `waiting` on this registration. */
export function isReplacementWaiting(
  reg: RegistrationLike | null | undefined
): boolean {
  return reg?.waiting != null;
}

/**
 * Wrap a Workbox route matcher so the route stops matching while a
 * replacement worker waits. The registration is read on every call because
 * `registration.waiting` changes during the worker's life.
 */
export function unlessReplacementWaiting<A>(
  match: (arg: A) => boolean,
  getRegistration: () => RegistrationLike | null | undefined
): (arg: A) => boolean {
  return arg => !isReplacementWaiting(getRegistration()) && match(arg);
}

/** The Workbox plugin hook the bound uses (structural; see the module note). */
export interface RequestWillFetchPlugin {
  requestWillFetch: (param: { request: Request }) => Promise<Request>;
}

/**
 * A Workbox plugin that gives every network fetch of a route its own abort
 * deadline. Where `AbortSignal.any` exists the deadline is combined with the
 * request's own signal rather than replacing it, so a browser that ends a
 * worker fetch when the page aborts keeps doing so; otherwise the deadline
 * replaces it. `makeSignal` is injectable for tests.
 */
export function boundedFetchPlugin(
  timeoutMs: number = RUNTIME_FETCH_TIMEOUT_MS,
  makeSignal: (ms: number) => AbortSignal = ms => AbortSignal.timeout(ms)
): RequestWillFetchPlugin {
  return {
    requestWillFetch: async ({ request }) => {
      const deadline = makeSignal(timeoutMs);
      const signal =
        typeof AbortSignal.any === "function"
          ? AbortSignal.any([request.signal, deadline])
          : deadline;
      return new Request(request, { signal });
    },
  };
}
