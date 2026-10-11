// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-OS tab contract for the one-liner export card (issue #3447 Sub B, K8).
 *
 * This is the SINGLE OS source the porter one-liner card and its children read.
 * B (#3447) introduces the state (`detectOsTab(navigator.userAgent)` seeds it,
 * an `os` prop overrides it) and renders Linux / macOS / Windows tabs; D (#3449)
 * later consumes the SAME selected value to show per-OS guidance — so there is
 * exactly one OS detector, no `useOsTab` hook, no second detection site [K8, 1B#27].
 */

/** The three command flavours the one-liner card offers. */
export type OsTab = "linux" | "macos" | "windows";

/**
 * Pick the default OS tab from a User-Agent string. Pure — takes the UA as an
 * argument (tests pass it, and the component seeds it from
 * `navigator.userAgent`) rather than reading a global.
 *
 * - `Windows NT`  → `windows` (the `irm | iex` PowerShell one-liner)
 * - `Macintosh`   → `macos`   (iPadOS 13+ also reports `Macintosh` — acceptable,
 *                              the macOS `curl | bash` line works there too)
 * - anything else → `linux`   (the default `curl | bash` line)
 */
export function detectOsTab(ua: string): OsTab {
  if (/Windows NT/.test(ua)) return "windows";
  if (/Macintosh/.test(ua)) return "macos";
  return "linux";
}
