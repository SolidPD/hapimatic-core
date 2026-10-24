// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Path-segment predicates for the generic REST invoker's dispatch-agreement rules
 * (issue #4316 — TRUST-CRITICAL, the `hapi_call` dot-segment bypass).
 *
 * The invoker (`server/src/web/routes/capabilityCall.ts`) gates the RAW request
 * path but dispatches `new URL(path).pathname`, which collapses `.`/`..` segments
 * (including `.%2e` and `%2e.`). These predicates are homed here, in
 * `@hapi/protocol`, so the server rule and the client-side typed tools (#3842)
 * share ONE definition instead of drifting apart. Both are pure and `URL`-free;
 * they ship in the pre-auth web bundle like `promoted.ts` and disclose nothing.
 */

/** A deliberately strict subset of the characters a URL parser leaves unchanged
 *  in a path segment (#4316 E2): RFC 3986 `pchar` minus `%` (percent-encoding is
 *  refused outright). Parsers also pass `[`, `]` and `|` through, but they are
 *  excluded so this set holds on every engine. */
const SAFE_SEGMENT = /^[A-Za-z0-9\-._~!$&'()*+,;=:@]+$/;

/**
 * True for a literal dot segment (`.` or `..`). Only the literal forms: the
 * `%2e` forms are refused by the invoker's separate `%` rule, so each server rule
 * keeps its own negative control (#4316 E5).
 */
export function isDotSegment(segment: string): boolean {
  return segment === "." || segment === "..";
}

/**
 * True when an agent-supplied id segment cannot be passed through `hapi_call`
 * unchanged: empty, a dot segment, containing `..`, or carrying any character
 * outside the set the URL parser leaves alone. Its refusal set is a superset of
 * the server's (`isRejectedPath` + `dispatchPathDiverges`), so a segment this
 * accepts is dispatched byte for byte. The CLIENT-side mirror for #3842's typed
 * tools (a field-named error before the server's no-oracle refusal); the server
 * itself uses only `isDotSegment`.
 */
export function isUnsafePathSegment(segment: string): boolean {
  if (segment.length === 0) return true;
  if (isDotSegment(segment)) return true;
  if (segment.includes("..")) return true;
  return !SAFE_SEGMENT.test(segment);
}
