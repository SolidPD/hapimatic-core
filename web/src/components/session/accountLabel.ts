// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure helpers for the Account Chip label (epic #3285 correction pass 1). Kept
 * hook-free so `AccountChip`, `useAccountLabels`, and the tests can share them
 * without pulling React Query into a presentational import graph.
 */

/**
 * The nickname's own length budget (the editor's input `maxLength`). The
 * Accounts card's Row-2 chip passes this as `maxChars` so the nickname renders
 * UNTRUNCATED there — that chip is the "what the chip looks like fully
 * populated" preview, not a width-bounded list cell.
 */
export const ACCOUNT_NICKNAME_MAX_CHARS = 64;

/** The email's local part (`work@x.com` → `work`) — the last-resort label. */
export function accountShortName(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

/**
 * The chip label, trimmed. #6449: no character cut by default — full account
 * nicknames everywhere, replacing the 10-character cap (Matt's ruling,
 * 2026-11-06, Pins brief round 4); a chip ellipsizes by width only, when its
 * container has no room. An explicit `maxChars` still cuts to `max − 1`
 * characters plus a single-character ellipsis.
 */
export function truncateAccountLabel(label: string, maxChars?: number): string {
  const trimmed = label.trim();
  if (maxChars === undefined) return trimmed;
  if (maxChars < 2 || trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1).trimEnd()}…`;
}

/** The monogram letter: the label's first character, upper-cased. */
export function accountMonogram(label: string): string {
  const first = label.trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}
