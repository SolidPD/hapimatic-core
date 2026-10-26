// SPDX-License-Identifier: AGPL-3.0-only
import { isIP } from "node:net";
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import type { WebAppEnv } from "./middleware/auth";

/**
 * Client address for rate-limit keys on unauthenticated routes (issue #5170).
 *
 * The key is the connection's PEER address. A forwarded header is trusted only
 * when the peer is loopback, because every documented deployment puts its
 * reverse proxy on the same host: Caddy `reverse_proxy localhost:3008` on cloud
 * VMs (`infrastructure/cloud-vm/Caddyfile.example`), Tailscale Serve on RP1, and
 * the proxies in `docs/guide/installation.md`. From any other peer,
 * `x-forwarded-for` is whatever the client chose to send, so it is ignored, and
 * `x-real-ip` is never read. Behind a loopback proxy the RIGHTMOST
 * `x-forwarded-for` entry is the one that proxy appended, so a client-supplied
 * prefix cannot steer the key.
 *
 * Same rule as the gateway (`gateway/src/lib/talkStage.ts`), which has no
 * package in common with the server. Two known limits, documented in
 * `docs/internal/architecture/auth.md`: a raw TCP forwarder on loopback
 * (`ssh -L`, `socat`, `tailscale serve --tcp`) passes a client's header
 * through, and a proxy on a non-loopback address puts every client in one
 * bucket.
 */

/** An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`), as Bun reports IPv4 peers on a dual-stack socket. */
const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** True for `127.0.0.0/8`, its IPv4-mapped form, and `::1`. */
export function isLoopback(address: string): boolean {
  const mapped = MAPPED_IPV4.exec(address);
  const v4 = mapped?.[1] ?? address;
  if (isIP(v4) === 4) return v4.startsWith("127.");
  return address === "::1" || address === "0:0:0:0:0:0:0:1";
}

/**
 * The client address behind `peer`: the last parseable `x-forwarded-for` entry
 * when the peer is loopback (the instance's own proxy), otherwise the peer
 * itself. `"unknown"` when there is no peer (an in-process request).
 */
export function clientAddress(
  peer: string | null | undefined,
  forwardedFor: string | null | undefined
): string {
  if (!peer) return "unknown";
  if (isLoopback(peer)) {
    const last = (forwardedFor ?? "")
      .split(",")
      .map(part => part.trim())
      .filter(Boolean)
      .pop();
    if (last && isIP(last) !== 0) return last;
  }
  return peer;
}

/** The eight 16-bit groups of an IPv6 address, or `null` when it does not expand.
 *  Also used by `federation/secretTransport.ts` (#5127) for the tailnet range. */
export function ipv6Groups(address: string): string[] | null {
  const bare = address.split("%")[0] ?? address;
  const [head = "", tail] = bare.split("::");
  const headGroups = head ? head.split(":") : [];
  if (tail === undefined) return headGroups.length === 8 ? headGroups : null;
  const tailGroups = tail ? tail.split(":") : [];
  const fill = 8 - headGroups.length - tailGroups.length;
  if (fill < 0) return null;
  return [...headGroups, ...Array<string>(fill).fill("0"), ...tailGroups];
}

/**
 * The rate-limit key for an address. A global-unicast IPv6 address (`2000::/3`)
 * is reduced to its /64, one subscriber's usual allocation, so cycling
 * addresses inside it buys no extra buckets. Everything else is kept whole:
 * IPv4, IPv4-mapped (a /64 mask would merge every IPv4 client), and
 * non-global IPv6 such as Tailscale's ULA range, where every peer of a tailnet
 * shares one /64.
 */
export function rateLimitKeyFor(address: string): string {
  if (isIP(address) !== 6 || MAPPED_IPV4.test(address)) return address;
  const groups = ipv6Groups(address);
  if (!groups) return address;
  const first = parseInt(groups[0] ?? "0", 16) || 0;
  if (first < 0x2000 || first > 0x3fff) return address;
  return `${groups
    .slice(0, 4)
    .map(g => (parseInt(g, 16) || 0).toString(16))
    .join(":")}::/64`;
}

/**
 * Rate-limit `keyFn` for unauthenticated routes. Reads the peer from the Bun
 * server, which `web/server.ts` passes to Hono as its env. `getConnInfo` throws
 * when there is no env (`app.request()` in tests, the in-process re-entry in
 * `routes/capabilityCall.ts`), and those requests key as `"unknown"`.
 */
export function clientAddrKey(c: Context<WebAppEnv>): string {
  let peer: string | undefined;
  try {
    peer = getConnInfo(c).remote.address;
  } catch {
    // No Bun server behind this request.
  }
  return rateLimitKeyFor(clientAddress(peer, c.req.header("x-forwarded-for")));
}
