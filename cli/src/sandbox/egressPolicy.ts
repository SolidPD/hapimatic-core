// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #1734 (Hapimatic OmniBox Phase 0b) — pure egress policy: a host
 * allowlist matcher + an is-global-IP classifier. No I/O.
 *
 * **Adapted from OmniBox, not ported.** Databricks Omnigent's egress proxy
 * (`omnigent/inner/egress/{proxy,rules}.py`) is a full TLS-MITM, multi-tenant
 * machine; Hapimatic Phase 0 is a no-MITM CONNECT-allowlist EXFIL control for a
 * single-tenant box. We take only the default-deny allowlist shape and the
 * `_assert_destination_allowed` IP-classification idea.
 *
 * **Why hand-rolled CIDR checks, not an npm `ip`/`private-ip` lib.** Those
 * classifiers have documented gaps (CVE-2024-29415, CVE-2025-8020) where a
 * crafted address slips past the private-range check — exactly the bypass an
 * SSRF/exfil control must not have. Explicit, audited CIDR comparisons are the
 * safer choice for a security boundary, and Hapimatic already ships one Bun
 * binary with `node:net` available.
 *
 * The classifier is applied to the **resolved-and-pinned** destination IP by the
 * broker (`egressBroker.ts`) — `net.connect` targets the validated IP, not the
 * hostname, so a DNS-rebind between the allow-check and the connect cannot
 * redirect to a private address (anti-rebind).
 */

import { isIPv4, isIPv6 } from "node:net";

/**
 * Default egress allowlist — seeded from Anthropic's published network-config
 * host list + the reference `.devcontainer/init-firewall.sh` set, plus the
 * GitHub + npm hosts the issue-workflow `gh`/`git`/plugin-install paths need.
 * Extend (never replace) via {@link resolveEgressAllowlist}.
 */
export const DEFAULT_EGRESS_ALLOWLIST: readonly string[] = [
  // Anthropic inference + console + telemetry
  "api.anthropic.com",
  "claude.ai",
  "platform.claude.com",
  "console.anthropic.com",
  "statsig.anthropic.com",
  // GitHub (gh CLI, git over HTTPS, release/raw asset downloads)
  "github.com",
  "*.github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  // npm registry (plugin / dependency installs)
  "registry.npmjs.org",
];

/**
 * DNS hostname charset (letters, digits, dot, hyphen). Anything else — embedded
 * NUL / CR / LF, whitespace, `@` userinfo smuggling, `/` path tricks — is
 * rejected BEFORE matching so a crafted CONNECT target cannot smuggle an
 * allowlisted substring past the matcher.
 */
const HOSTNAME_CHARSET = /^[A-Za-z0-9.-]+$/;

/**
 * Default-DENY host allowlist match. Supports exact hosts and a single leading
 * `*.` wildcard (`*.github.com` matches `api.github.com` and any deeper
 * subdomain, but NOT the apex `github.com` — list the apex explicitly).
 * Comparison is case-insensitive with a trailing-dot (FQDN root) stripped.
 */
export function isHostAllowed(
  host: string,
  allowlist: readonly string[]
): boolean {
  if (!host) return false;
  const h = host.replace(/\.$/, "").toLowerCase();
  if (!HOSTNAME_CHARSET.test(h)) return false;
  for (const entry of allowlist) {
    const e = entry.replace(/\.$/, "").toLowerCase();
    if (e.startsWith("*.")) {
      const suffix = e.slice(1); // "*.github.com" -> ".github.com"
      if (h.length > suffix.length && h.endsWith(suffix)) return true;
    } else if (h === e) {
      return true;
    }
  }
  return false;
}

/**
 * True iff `ip` is a globally-routable unicast address. Returns false for any
 * loopback / link-local (incl. the `169.254.169.254` cloud-metadata IP) /
 * RFC1918 / ULA / multicast / unspecified / reserved address, and for any
 * unparseable input (fail-safe). Handles IPv4, IPv6, and IPv4-mapped IPv6
 * (`::ffff:a.b.c.d`, classified by the embedded IPv4 — the bypass an IPv6-naive
 * check would miss).
 */
export function isGlobalIp(ip: string): boolean {
  if (isIPv4(ip)) return isGlobalIPv4(ip);
  if (isIPv6(ip)) return isGlobalIPv6(ip);
  return false;
}

function isGlobalIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const o: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    if (n > 255) return false;
    o.push(n);
  }
  const [a, b, c, d] = o;
  if (a === 0) return false; // 0.0.0.0/8 "this network"
  if (a === 10) return false; // 10.0.0.0/8 RFC1918
  if (a === 127) return false; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return false; // 169.254.0.0/16 link-local (incl. 169.254.169.254 IMDS)
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return false; // 192.168.0.0/16 RFC1918
  if (a === 168 && b === 63 && c === 129 && d === 16) return false; // 168.63.129.16/32 Azure WireServer
  if (a >= 224) return false; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255 broadcast
  return true;
}

/**
 * Expand an IPv6 string to its 8 hextets (each 0-65535), handling `::`
 * compression, an optional `%zone` suffix, and an embedded IPv4 tail
 * (`::ffff:1.2.3.4`). Returns null on any malformed input.
 */
function expandIPv6(ip: string): number[] | null {
  let str = ip.toLowerCase();
  const pct = str.indexOf("%");
  if (pct >= 0) str = str.slice(0, pct); // strip zone id

  // Embedded IPv4 tail -> two hextets.
  const v4 = str.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const oct = [v4[1], v4[2], v4[3], v4[4]].map(Number);
    if (oct.some(n => n > 255)) return null;
    const h1 = ((oct[0] << 8) | oct[1]).toString(16);
    const h2 = ((oct[2] << 8) | oct[3]).toString(16);
    str = str.slice(0, v4.index) + h1 + ":" + h2;
  }

  const halves = str.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const hextets: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    hextets.push(parseInt(g, 16));
  }
  return hextets;
}

function isGlobalIPv6(ip: string): boolean {
  const h = expandIPv6(ip);
  if (!h) return false;
  if (h.every(x => x === 0)) return false; // :: unspecified
  if (h.slice(0, 7).every(x => x === 0) && h[7] === 1) return false; // ::1 loopback
  // ::ffff:a.b.c.d IPv4-mapped — classify by the embedded IPv4 (anti-bypass).
  if (h.slice(0, 5).every(x => x === 0) && h[5] === 0xffff) {
    const a = (h[6] >> 8) & 0xff;
    const b = h[6] & 0xff;
    const c = (h[7] >> 8) & 0xff;
    const d = h[7] & 0xff;
    return isGlobalIPv4(`${a}.${b}.${c}.${d}`);
  }
  if ((h[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((h[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 ULA
  if ((h[0] & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  return true;
}

/**
 * Merge the default allowlist with operator overrides (pure). Overrides EXTEND
 * the default — they never replace it, because the default hosts
 * (`api.anthropic.com`, GitHub, npm) are load-bearing for the agent to function
 * at all; dropping them would break every session. Dedupes, trims, drops empty.
 *
 * @param envValue       `HAPI_EGRESS_ALLOW` — a comma-separated host list.
 * @param settingsValue  settings.json `egressAllowlist` — a string array.
 * @param harnessHosts   issue #3813: the inference/auth hosts of the jail-eligible
 *                       stock harnesses (`harnessEgressHosts()` in @hapi/protocol),
 *                       merged into the NODE-WIDE allowlist. Because the broker is
 *                       one-per-daemon with no client identity
 *                       (`egressBroker.ts`: "cannot attribute a connection to a
 *                       session"), every jailed session — INCLUDING Claude — can
 *                       reach every merged host; that is why only inference/auth
 *                       hosts of jail-eligible flavors are merged. Extends like the
 *                       env override (never replaces). This module stays PURE — the
 *                       caller (`run.ts`) passes the resolved list; no manifest import.
 */
export function resolveEgressAllowlist(
  envValue?: string,
  settingsValue?: readonly string[],
  harnessHosts: readonly string[] = []
): string[] {
  const fromEnv = (envValue ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const fromSettings = (settingsValue ?? []).map(s => s.trim()).filter(Boolean);
  const fromHarness = harnessHosts.map(s => s.trim()).filter(Boolean);
  return Array.from(
    new Set([
      ...DEFAULT_EGRESS_ALLOWLIST,
      ...fromSettings,
      ...fromEnv,
      ...fromHarness,
    ])
  );
}
