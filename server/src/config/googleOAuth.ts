// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Google OAuth configuration helpers (issue #1003).
 *
 * Server-only. Parses the comma-separated allowlist env vars into the
 * `Allowlist` shape consumed by `utils/userAllowlist.ts`. The gateway has its
 * own copy of this logic (its config module reads its own env vars).
 */

import type { Allowlist } from "../utils/userAllowlist";

/**
 * Parse comma-separated allowlist env values into a normalized `Allowlist`.
 * Trims, lowercases, and drops empty entries. Absent values yield an empty list.
 *
 * Env vars (read by `Configuration.create()`):
 * - HAPI_GOOGLE_ALLOWLIST_EMAILS   e.g. "matt.bell@example.com, ops@example.com"
 * - HAPI_GOOGLE_ALLOWLIST_DOMAINS  e.g. "example.com" (or "*" for any domain)
 */
export function parseAllowlist(env: {
  emails?: string;
  domains?: string;
}): Allowlist {
  const split = (value: string | undefined): string[] =>
    (value ?? "")
      .split(",")
      .map(entry => entry.trim().toLowerCase())
      .filter(Boolean);

  return {
    emails: split(env.emails),
    domains: split(env.domains),
  };
}

/**
 * Guard the `*` (any-domain) allowlist for internet-exposed cloud instances (#2280 R2).
 *
 * A `*` allowlist means "any shape-valid Google email is allowlisted". On a
 * gateway-managed cloud deployment that is the exposure #2280 fixes — combined with the
 * `email_verified` bypass, any email obtained the instance's `cliApiToken`. The presence
 * of `HAPI_GOOGLE_HANDOFF_SECRET` is the gateway-managed-deployment signal (no explicit
 * "cloud / internet-exposed" flag exists anywhere in the tree — ruling D3-A, 2026-08-01).
 *
 * Returns a warning message when a `*` domain is configured AND a handoff secret is set;
 * returns null otherwise. This is PURE — the caller decides how to act. The server-side
 * caller only WARNS (never refuses): the handoff-secret signal is IMPLICIT, so a
 * self-hoster who set a handoff secret manually would be a false positive, and warning
 * (not throwing) keeps that deployment running. A self-hosted deployment WITHOUT a
 * handoff secret keeps `*` fully unchanged (R3 — no single-tenant regression). The
 * gateway, which is internet-exposed by definition, refuses `*` unconditionally instead
 * (see `gateway/src/config.ts` `assertNoWildcardAllowlistDomain`).
 */
export function wildcardAllowlistWarning(
  domains: string[],
  handoffSecretPresent: boolean
): string | null {
  if (handoffSecretPresent && domains.includes("*")) {
    return (
      "[security] #2280: HAPI_GOOGLE_ALLOWLIST_DOMAINS contains '*' (any domain) on a " +
      "gateway-managed deployment (HAPI_GOOGLE_HANDOFF_SECRET is set). A wildcard " +
      "allowlist lets any shape-valid Google email obtain this instance's cliApiToken. " +
      "Internet-exposed cloud instances MUST use explicit HAPI_GOOGLE_ALLOWLIST_EMAILS " +
      "entries instead of '*'."
    );
  }
  return null;
}
