// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure decision helper: should the MCP status modal trigger a refresh?
 *
 * Used to debounce open/close cycles of the MCP status modal — each refresh
 * spawns `claude mcp list` server-side, which restarts every stdio MCP, so
 * rapid re-open without debounce contributed to the restart storm fixed by
 * issue #1069.
 *
 * Boundary: strict `>` — at exactly `staleMs` of age the cache is considered
 * fresh and refresh is suppressed. Mirrors the inline condition at
 * `StatusBar.tsx` that this helper replaces.
 *
 * `checkedAt` is expected to be a UTC-suffixed ISO 8601 string from the server
 * (e.g. "2026-04-25T20:00:00Z"). Malformed or non-finite values fall through
 * to "refresh-on-open" — preferring a redundant refresh over a frozen UI.
 */
export function shouldRefreshMcpStatus(
  checkedAt: string | null,
  nowMs: number = Date.now(),
  staleMs: number = 60_000
): boolean {
  if (checkedAt === null) return true;
  const checkedAtMs = new Date(checkedAt).getTime();
  const ageMs = nowMs - checkedAtMs;
  return !Number.isFinite(ageMs) || ageMs > staleMs;
}
