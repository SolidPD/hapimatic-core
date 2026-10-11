// SPDX-License-Identifier: AGPL-3.0-only
/**
 * User allowlist matching (issue #1003 — Google SSO gateway).
 *
 * Pure module — no I/O, no env reads. Callers parse env vars (or gateway config)
 * and pass the allowlist in. Shared in spirit by the Hapimatic server route and
 * the gateway (the gateway keeps its own copy of the same matching logic).
 *
 * Fail-closed: an empty allowlist ({ emails: [], domains: [] }) denies everyone.
 * A "*" entry in `domains` is the explicit opt-in for "any domain".
 */

export interface Allowlist {
  emails: string[];
  domains: string[];
}

/**
 * Return true iff `email` is permitted by `allowlist`.
 *
 * - Case-insensitive on both the email and the allowlist entries.
 * - Domain match strips everything up to and including "@".
 * - Malformed emails ("", "foo", "foo@", "@bar", "a@b@c") always deny.
 * - Empty emails AND empty domains -> denies everyone (fail-closed).
 * - "*" in `domains` -> any well-formed email is allowed.
 */
export function isEmailAllowed(email: string, allowlist: Allowlist): boolean {
  const normalized = email.trim().toLowerCase();

  // Shape validation: exactly one "@" with a non-empty local part and domain.
  const atIndex = normalized.indexOf("@");
  if (
    atIndex <= 0 ||
    atIndex !== normalized.lastIndexOf("@") ||
    atIndex === normalized.length - 1
  ) {
    return false;
  }

  const domain = normalized.slice(atIndex + 1);

  // Wildcard domain opt-in.
  if (allowlist.domains.some(d => d.trim().toLowerCase() === "*")) {
    return true;
  }

  // Exact email match (defensively lowercased in case the caller did not).
  if (allowlist.emails.some(e => e.trim().toLowerCase() === normalized)) {
    return true;
  }

  // Domain match.
  if (allowlist.domains.some(d => d.trim().toLowerCase() === domain)) {
    return true;
  }

  return false;
}
