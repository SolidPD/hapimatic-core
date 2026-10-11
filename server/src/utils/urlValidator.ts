// SPDX-License-Identifier: AGPL-3.0-only
/**
 * URL validation for federation peer-announced URLs.
 * Defends against SSRF by restricting schemes and blocking private IP ranges,
 * while allowlisting the Tailscale CGNAT range used by federation peers.
 */

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Tailscale CGNAT: 100.64.0.0/10 → 100.64.0.0 – 100.127.255.255 */
const TAILSCALE_BASE = (100 << 24) | (64 << 16); // 0x64400000
const TAILSCALE_MASK = 0xffc00000; // /10

type ValidationResult = { valid: true } | { valid: false; reason: string };

/** Parse a dotted-decimal IPv4 string into a 32-bit unsigned integer, or null. */
function parseIPv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255 || part !== String(n))
      return null;
    result = (result << 8) | n;
  }
  return result >>> 0; // unsigned
}

/** Check if an IPv4 integer falls within a CIDR block. */
function inCIDR(ip: number, base: number, mask: number): boolean {
  return (ip & mask) === (base & mask);
}

/** Check if an IPv4 integer is in the Tailscale CGNAT range. */
function isTailscale(ip: number): boolean {
  return inCIDR(ip, TAILSCALE_BASE, TAILSCALE_MASK);
}

/** Check if an IPv4 integer is a private/reserved address (RFC 1918, loopback, link-local). */
function isPrivateOrReserved(ip: number): boolean {
  // 127.0.0.0/8 — loopback
  if (inCIDR(ip, 0x7f000000, 0xff000000)) return true;
  // 10.0.0.0/8 — RFC 1918
  if (inCIDR(ip, 0x0a000000, 0xff000000)) return true;
  // 172.16.0.0/12 — RFC 1918
  if (inCIDR(ip, 0xac100000, 0xfff00000)) return true;
  // 192.168.0.0/16 — RFC 1918
  if (inCIDR(ip, 0xc0a80000, 0xffff0000)) return true;
  // 169.254.0.0/16 — link-local
  if (inCIDR(ip, 0xa9fe0000, 0xffff0000)) return true;
  // 0.0.0.0/8 — "this" network
  if (inCIDR(ip, 0x00000000, 0xff000000)) return true;
  return false;
}

/**
 * Validate a peer-announced URL for federation use.
 *
 * Checks:
 * 1. URL is syntactically valid
 * 2. Scheme is http: or https: only
 * 3. If hostname is an IPv4 literal, it must not be private/reserved
 *    (unless it's in the Tailscale CGNAT range)
 * 4. Hostname "localhost" is blocked
 *
 * Note: DNS names are allowed through (no synchronous DNS resolution).
 * The Tailscale network boundary provides defense against DNS rebinding.
 */
export function isValidPeerUrl(url: string): ValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: "Malformed URL" };
  }

  // 1. Scheme check
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return {
      valid: false,
      reason: `Scheme "${parsed.protocol}" not allowed (must be http: or https:)`,
    };
  }

  // 2. Block "localhost" hostname explicitly
  if (parsed.hostname === "localhost") {
    return { valid: false, reason: "localhost is not allowed" };
  }

  // 3. Block private/loopback IPv6 addresses
  // Bun's URL parser returns IPv6 hostnames with brackets: "[::1]"
  if (parsed.hostname.includes(":")) {
    const bare = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (
      bare === "::1" ||
      bare.startsWith("fc") ||
      bare.startsWith("fd") ||
      bare.startsWith("fe80") ||
      bare.startsWith("::ffff:")
    ) {
      return {
        valid: false,
        reason: `IPv6 address "${bare}" is not allowed`,
      };
    }
  }

  // 4. IPv4 literal check
  const ip = parseIPv4(parsed.hostname);
  if (ip !== null) {
    // Tailscale allowlist takes priority over private-range block
    if (isTailscale(ip)) {
      return { valid: true };
    }
    if (isPrivateOrReserved(ip)) {
      return {
        valid: false,
        reason: `Private/reserved IP address "${parsed.hostname}" is not allowed`,
      };
    }
  }

  return { valid: true };
}
