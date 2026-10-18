// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Abort signal for the hub's READ-ONLY per-session proxy fetches (issue #5375).
 *
 * None of the hub's per-session proxy `fetch` calls carried a signal, so a peer
 * that accepts a connection but never answers (a Tailscale host mid-reboot, a
 * partition) held the hub request open up to Bun's 300 s default while the
 * browser gave up at 30 s with a raw timeout error. A bounded timeout turns that
 * into a fast transport failure the route's existing `catch` maps to a 502,
 * which the remote-session availability guard then normalizes to
 * `node_unreachable`.
 *
 * READ-ONLY GETs ONLY. A timed-out MUTATION may already have been applied on the
 * peer, so a retry or resend could duplicate it — mutation-proxy timeouts need a
 * per-route timeout value and an idempotency decision, tracked in #3627.
 *
 * On Bun 1.4 a timeout rejects with `name === "TimeoutError"` and a client
 * disconnect (the request signal) with `name === "AbortError"`; neither is a
 * `TypeError`. `isFetchTransportError` is the one definition of "the peer could
 * not be reached" shared by the proxy routes and the remote-session guard
 * (#5404): a network TypeError or an abort/timeout, never a URL or argument
 * validation error.
 */

/**
 * Budget for one proxied read. It sits above the peer's own command limits (a
 * git command gets 10 s, `cli/src/modules/common/handlers/git.ts`
 * `runGitCommand`) so a slow but successful read is not cut off, and below the
 * browser's 30 s request timeout (`web/src/api/client.ts`) so a hung peer still
 * gets a labelled error before the browser's own raw one.
 */
export const FEDERATION_READ_TIMEOUT_MS = 25_000;

/**
 * Signal for a read-only proxy fetch: aborts on timeout, and also when the
 * inbound request is cancelled (the browser navigated away), so the hub stops
 * waiting on the peer for a client that is gone.
 */
export function federationReadSignal(
  requestSignal?: AbortSignal,
  timeoutMs: number = FEDERATION_READ_TIMEOUT_MS
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
}

/** True for a fetch or body read cut off by an abort signal (timeout or disconnect). */
export function isAbortError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * True for a genuine hub→peer transport failure: a Bun fetch network error (a
 * TypeError with a string `code` such as "ConnectionRefused" or "ENOTFOUND") or
 * an abort/timeout. URL and argument validation errors also carry a string code
 * (`ERR_INVALID_URL` for a malformed node URL) — those are hub bugs and must
 * surface as 500, never as an unreachable node (#5404).
 */
export function isFetchTransportError(error: unknown): boolean {
  if (isAbortError(error)) return true;
  if (!(error instanceof TypeError)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && !code.startsWith("ERR_INVALID_");
}

/**
 * Read a proxied JSON body. An empty or malformed body reads as null, so callers
 * keep their existing fallback. A read cut off by the abort signal rethrows: the
 * signal also bounds the body, and swallowing that would turn a timed-out read
 * into an empty success instead of the route's transport-failure 502.
 */
export async function readProxyJson(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }
}
