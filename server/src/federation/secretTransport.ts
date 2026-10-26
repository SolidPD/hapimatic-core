// SPDX-License-Identifier: AGPL-3.0-only
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ipv6Groups, isLoopback } from "../web/clientAddress";

/**
 * Transport rules for a shared API key's secret (issue #5127, D18).
 *
 * A home node releases a key only to a request that arrived over Tailscale, or
 * straight from the same host. A requesting node contacts a home only at a
 * Tailscale or loopback address. Together they keep a key off every public
 * route: a cloud VM's Caddy front door (`<fqdn> → localhost:3008`) connects from
 * loopback but adds forwarding headers, so it is refused; and a peer URL that an
 * announcement rewrote to a public host is never contacted.
 *
 * Tailscale assigns IPv4 addresses from the CGNAT range `100.64.0.0/10` and IPv6
 * addresses from `fd7a:115c:a1e0::/48`. A raw TCP forwarder on loopback
 * (`ssh -L`, `socat`) adds no header and passes as same-host; that is the same
 * known limit `web/clientAddress.ts` documents for its rate-limit key.
 */

/** Request headers a reverse proxy adds. Any one marks a proxied request. */
export const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "forwarded",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
  "via",
] as const;

const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** True for an address in Tailscale's ranges: `100.64.0.0/10` (also in its
 *  IPv4-mapped form) and `fd7a:115c:a1e0::/48`. */
export function isTailnetAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const mapped = address.match(MAPPED_IPV4);
  const candidate = mapped?.[1] ?? address;
  if (isIP(candidate) === 4) {
    const parts = candidate.split(".").map(Number);
    if (
      parts.length !== 4 ||
      parts.some(p => !Number.isInteger(p) || p > 255)
    ) {
      return false;
    }
    const [a, b] = parts as [number, number, number, number];
    return a === 100 && b >= 64 && b <= 127;
  }
  if (isIP(candidate) === 6) {
    const groups = ipv6Groups(candidate);
    if (!groups) return false;
    const norm = groups
      .slice(0, 3)
      .map(g => g.toLowerCase().replace(/^0+(?=.)/, ""));
    return norm[0] === "fd7a" && norm[1] === "115c" && norm[2] === "a1e0";
  }
  return false;
}

/** A minimal header reader, so a Hono request or a plain Headers both fit. */
export interface HeaderSource {
  get(name: string): string | null | undefined;
}

/** True when the request carries any reverse-proxy header. */
export function hasForwardingHeaders(headers: HeaderSource): boolean {
  return FORWARDING_HEADERS.some(name => {
    const value = headers.get(name);
    return value !== null && value !== undefined && value !== "";
  });
}

/** True for a request from this host that no reverse proxy relayed. */
export function isDirectLoopbackRequest(
  peer: string | null | undefined,
  headers: HeaderSource
): boolean {
  if (!peer || !isLoopback(peer)) return false;
  return !hasForwardingHeaders(headers);
}

/**
 * The home side of D18: release a key only to a tailnet peer that no proxy
 * relayed, or to a direct same-host request.
 */
export function homePeerAllowed(
  peer: string | null | undefined,
  headers: HeaderSource
): boolean {
  if (hasForwardingHeaders(headers)) return false;
  if (!peer) return false;
  return isTailnetAddress(peer) || isLoopback(peer);
}

/** `dns.lookup` in its `{ all: true }` shape, injectable for tests. */
export type LookupAll = (
  host: string
) => Promise<Array<{ address: string; family: number }>>;

/** A lookup that has not answered in this long is a refusal (perf review L4):
 *  the resolver's own timeout can exceed the callers' budgets. */
const LOOKUP_TIMEOUT_MS = 3_000;

const defaultLookup: LookupAll = host => dnsLookup(host, { all: true });

const HOST_CACHE_TTL_MS = 60_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("lookup timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The requester side of D18: true when every address `url` resolves to is a
 * loopback or tailnet address. Any public, unresolvable or malformed host is
 * refused, before a single byte is sent; so is a host whose lookup takes more
 * than 3 s. Results are cached for 60 s.
 */
export function createHomeUrlGuard(
  opts: { lookup?: LookupAll; now?: () => number } = {}
): (url: string) => Promise<boolean> {
  const lookup = opts.lookup ?? defaultLookup;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { allowed: boolean; at: number }>();

  return async (url: string): Promise<boolean> => {
    let host: string;
    try {
      host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    } catch {
      return false;
    }
    if (!host) return false;
    if (isIP(host) !== 0) return isLoopback(host) || isTailnetAddress(host);

    const hit = cache.get(host);
    if (hit && now() - hit.at < HOST_CACHE_TTL_MS) return hit.allowed;

    let allowed = false;
    try {
      const addresses = await withTimeout(lookup(host), LOOKUP_TIMEOUT_MS);
      allowed =
        addresses.length > 0 &&
        addresses.every(
          a => isLoopback(a.address) || isTailnetAddress(a.address)
        );
    } catch {
      allowed = false;
    }
    cache.set(host, { allowed, at: now() });
    return allowed;
  };
}
