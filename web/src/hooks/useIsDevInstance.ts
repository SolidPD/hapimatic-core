// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Detects whether the app is running on the DEV Hapimatic instance based on
 * hostname or port.
 *
 * Extracted from `BrandedFrame` (issue #1983 B2 — About page) so both the branded
 * shell AND the Admin Drawer About page's "Instance" row can read it without
 * pulling the whole shell component into their module graphs.
 *
 * Dev instance: hostname contains `hapi-dev` (Tailscale Services) OR port 3009
 * (direct) or 8443 (legacy Tailscale serve). Production: everything else. (A
 * worktree test instance on 3010–3019 reads as non-dev — expected; it is not the
 * dev integration instance.)
 */
export function useIsDevInstance(): boolean {
  if (typeof window === "undefined") return false;
  const hostname = window.location.hostname;
  const port = window.location.port;
  // Check hostname first (Tailscale Services), then fall back to port detection.
  return hostname.includes("hapi-dev") || port === "3009" || port === "8443";
}
