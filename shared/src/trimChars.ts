// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Linear-time character trimming — the replacement for `s.replace(/x+$/, "")`
 * style regexes.
 *
 * A trailing-run regex such as `/\/+$/` is quadratic on a long run of the
 * character that does NOT end the string: the engine consumes the whole run,
 * fails at `$`, then re-tries from every later start position. Measured in Bun
 * on 2026-10-18: 10 000 slashes + `x` took 126 ms, 100 000 took 13 s — all of
 * it blocking the single-threaded server. CodeQL reports the pattern on the
 * public core as `js/polynomial-redos`, and `regexp/no-super-linear-move` in
 * `eslint.config.mjs` keeps it from coming back.
 *
 * These helpers walk inward from the ends only, so the cost is proportional to
 * the number of characters removed.
 */

/** Remove every trailing character that appears in `chars`. */
export function trimTrailingChars(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1]!)) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** Remove every leading character that appears in `chars`. */
export function trimLeadingChars(s: string, chars: string): string {
  let start = 0;
  while (start < s.length && chars.includes(s[start]!)) start++;
  return start === 0 ? s : s.slice(start);
}

/** Remove every leading and trailing character that appears in `chars`. */
export function trimChars(s: string, chars: string): string {
  return trimLeadingChars(trimTrailingChars(s, chars), chars);
}
