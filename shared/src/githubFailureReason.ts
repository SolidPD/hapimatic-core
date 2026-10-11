// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The single source of truth for GitHub resolution failure reasons (issue #2391).
 *
 * 🔴 WHY THIS FILE EXISTS: the reason enum and its human-readable text used to
 * live in three places with asymmetric type safety —
 *
 * | Definition            | Home                                    | Exhaustive? |
 * |-----------------------|-----------------------------------------|-------------|
 * | `GitHubFailureReason` | `server/src/utils/githubCli.ts`          | n/a (the union) |
 * | `GITHUB_REASON_MESSAGE` | `server/src/extensions/github-issues/routes.ts` | YES — `Record<GitHubFailureReason, string>` |
 * | `REASON_TEXT`         | `web/.../GitHubAccountRepoSelector.tsx`  | **NO** — `Record<string, string>` |
 *
 * The two maps carried the same six keys, so nothing was visibly broken. But the
 * server map was type-enforced and the client map was not: adding a reason failed
 * the server build (good) while silently degrading every client to the generic
 * "resolution failed" copy (bad). That is a latent drift pair — two constants that
 * must agree, with nothing enforcing agreement — surfaced by the #2327
 * refactor-reflector as an out-of-scope finding and orphaned until #2391.
 *
 * Adding `rate_limited` / `forbidden` for the #2384 403-misdiagnosis fix is exactly
 * the event that would have made the drift live, which is why the extraction landed
 * FIRST and the transport fixes second.
 *
 * 🔴 TWO MAPS, ONE SOURCE — DELIBERATE. The audiences genuinely differ:
 *   - {@link GITHUB_REASON_MESSAGE} is the server's standalone `error` string.
 *   - {@link GITHUB_REASON_DISPLAY_TEXT} is a sentence FRAGMENT the client
 *     interpolates into `GitHub unavailable — {text}`.
 * Merging them would render "GitHub unavailable — GitHub rejected the configured
 * token". One module, one enum, two exhaustively-typed maps satisfies "derive from
 * one source" without flattening the audience boundary.
 */

/**
 * Every failure reason, as one literal list.
 *
 * 🔴 This array is THE list. {@link GitHubFailureReason} is derived from it, and
 * both text maps are keyed by that derived type — so adding an entry here is a
 * compile-time error in the server AND the web client until both texts exist.
 * Declaring the union separately would recreate the very drift pair this module
 * was written to remove.
 */
export const GITHUB_FAILURE_REASONS = [
  "gh_missing",
  "gh_unauthenticated",
  "no_token",
  "token_rejected",
  "rate_limited",
  "forbidden",
  "network",
  "broker_unavailable",
  "unknown",
] as const;

/**
 * Why GitHub account/repo/issue resolution failed.
 *
 * Each value maps to a DISTINCT operator action, so they are deliberately never
 * collapsed into a generic failure — `no_token` (install a token) and
 * `token_rejected` (replace a bad one) call for opposite responses, as do
 * `rate_limited` (wait) and `forbidden` (authorize the token for the org).
 */
export type GitHubFailureReason = (typeof GITHUB_FAILURE_REASONS)[number];

/**
 * Server-side prose for each reason — a standalone sentence surfaced as the
 * `error` field of a failed `/github/*` response.
 *
 * Typed `Record<GitHubFailureReason, string>` so a new reason cannot ship without
 * its text.
 */
export const GITHUB_REASON_MESSAGE: Record<GitHubFailureReason, string> = {
  gh_missing: "GitHub CLI unavailable on this instance",
  gh_unauthenticated: "GitHub CLI is not authenticated",
  no_token: "No GitHub token configured on this instance",
  token_rejected: "GitHub rejected the configured token",
  rate_limited: "GitHub rate limit reached — retry shortly",
  forbidden: "GitHub denied access to this resource",
  network: "Could not reach GitHub",
  // #3013: a token-banned VM reached the gateway read broker but it was
  // unreachable/misconfigured. Deliberately NOT "install a token" copy — the VM
  // is not supposed to have a token (that is the #2672 property), so `no_token`
  // would render actively wrong guidance (finding 3013-7).
  broker_unavailable: "GitHub read broker unavailable — retry shortly",
  unknown: "GitHub resolution failed",
};

/**
 * Client-side display copy for each reason — a sentence FRAGMENT interpolated into
 * `GitHub unavailable — {text}`.
 *
 * These MUST stay distinct from the genuinely-empty copy ("No GitHub account
 * connected"): the whole point of #2327 was that a user can tell "we could not
 * resolve your account" from "you have no account" without reading logs.
 *
 * Typed `Record<GitHubFailureReason, string>` — the half that was previously
 * `Record<string, string>` and therefore silently driftable.
 */
export const GITHUB_REASON_DISPLAY_TEXT: Record<GitHubFailureReason, string> = {
  gh_missing: "GitHub CLI unavailable",
  gh_unauthenticated: "GitHub CLI unavailable",
  no_token: "no GitHub token on this instance",
  token_rejected: "token rejected by GitHub",
  rate_limited: "GitHub rate limit reached",
  forbidden: "access denied by GitHub",
  network: "could not reach GitHub",
  // #3013: broker-outage fragment — NOT "no GitHub token" (finding 3013-7).
  broker_unavailable: "read broker unavailable",
  unknown: "resolution failed",
};

/**
 * Resolve display copy for a reason that arrived over the wire.
 *
 * 🔴 THE `string` PARAMETER IS DELIBERATE, NOT LAZINESS. On the federation path a
 * peer node forwards its own reason enum as an opaque string
 * (`server/src/web/routes/federation/infrastructure.ts` → `{type:"error",
 * message: result.reason}`), so a node running an older binary can hand this
 * client a value it has never heard of. Narrowing the parameter to
 * {@link GitHubFailureReason} would be a type lie about data this process does not
 * control. The MAP is exhaustive; the LOOKUP is tolerant — that split is the
 * correctness mechanism, and it degrades an unrecognized reason to the generic
 * copy instead of rendering `undefined`.
 *
 * 🔴 OWN-PROPERTY CHECK, NOT `?? fallback`. The obvious `MAP[reason] ?? MAP.unknown`
 * (which the superseded client-side `REASON_TEXT` used) walks the prototype chain:
 * a peer sending `"constructor"`, `"toString"`, or `"valueOf"` resolves to an
 * inherited FUNCTION, which `??` does not catch because it is not null/undefined —
 * so the UI would render a stringified function instead of the fallback copy.
 * Since this input is attacker-influencable over the federation boundary, the
 * lookup is restricted to own properties.
 */
export function reasonDisplayText(reason: string | null | undefined): string {
  if (!reason) return GITHUB_REASON_DISPLAY_TEXT.unknown;
  if (
    !Object.prototype.hasOwnProperty.call(GITHUB_REASON_DISPLAY_TEXT, reason)
  ) {
    return GITHUB_REASON_DISPLAY_TEXT.unknown;
  }
  return GITHUB_REASON_DISPLAY_TEXT[reason as GitHubFailureReason];
}
