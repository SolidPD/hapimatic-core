// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #1734 (Hapimatic OmniBox Phase 0b) — in-process HTTP CONNECT-allowlist
 * egress broker.
 *
 * A ~loopback-bound forward proxy the agent's traffic is routed through (via
 * `HTTPS_PROXY`/`HTTP_PROXY`, injected at spawn). It is a pure EXFIL control:
 * default-deny by host allowlist, and the **resolved-and-pinned** destination IP
 * must be globally routable (blocks cloud-metadata `169.254.169.254`, RFC1918,
 * loopback, ULA, link-local). No TLS-MITM — a CONNECT tunnel is piped opaquely,
 * so the broker can block but never read or inject. (Credential injection is out
 * of Phase-0 scope — KD-2.)
 *
 * Built on `node:http` + `node:net` + `node:dns` only — no external dependency
 * (Hapimatic ships one Bun binary). Claude Code honors `HTTPS_PROXY`/`HTTP_PROXY`
 * and speaks HTTP CONNECT (Anthropic network-config docs); SOCKS is not used.
 *
 * **Anti-DNS-rebind**: the host is resolved ONCE, every resolved IP is checked
 * against {@link isGlobalIp}, and `net.connect` targets the validated IP — not
 * the hostname — so a rebind between the allow-check and the connect cannot
 * redirect to a private address.
 */

import http from "node:http";
import net from "node:net";
import { promises as dns } from "node:dns";
import { isHostAllowed, isGlobalIp } from "./egressPolicy";
import { logger } from "@/ui/logger";

export interface EgressBrokerOptions {
  /** Host allowlist (already merged with defaults via resolveEgressAllowlist). */
  allowlist: readonly string[];
  /** Port to bind. 0 (default) = ephemeral — the daemon forwards the real port. */
  port?: number;
  /** Bind address — loopback only by default (never expose the proxy on a NIC). */
  host?: string;
  /** Invoked with (host, reason) on every refusal — for loud deny logging. */
  onDeny?: (host: string, reason: string) => void;
  /**
   * Resolve+pin override (testability DI). Defaults to {@link resolvePinnedIp}
   * (real DNS-resolve + isGlobalIp pin). Tests inject a loopback resolver to
   * exercise the tunnel against a real local upstream; the isGlobalIp
   * enforcement itself is covered via the real-resolver `localhost → 403` path.
   */
  resolveHost?: (hostname: string) => Promise<string | null>;
}

export interface EgressBrokerHandle {
  /** The actual bound port (resolved even when `port: 0` was requested). */
  port: number;
  /** The bound address (loopback by default). */
  host: string;
  /** Stop accepting connections and close the server. */
  close(): Promise<void>;
}

/** Per-connection upstream connect timeout. */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Daemon-process singleton: the active broker's port. The daemon owns ONE shared
 * broker; the spawn path (`tmuxSpawnAdapter`, same process) reads the port here
 * to inject `HTTPS_PROXY` into the agent env. `null` means the sandbox is off OR
 * the broker failed to start (fail-open — the spawn proceeds proxy-less, OR-3).
 * A loopback proxy cannot attribute a connection to a session, so a single
 * shared broker is the Phase-0 80/20 (per-session policy is out of scope).
 */
let activeEgressBrokerPort: number | null = null;

export function setActiveEgressBrokerPort(port: number | null): void {
  activeEgressBrokerPort = port;
}

export function getActiveEgressBrokerPort(): number | null {
  return activeEgressBrokerPort;
}

/**
 * Resolve `host` to a single PINNED globally-routable address (anti-rebind).
 * A bare IP literal is validated directly (no DNS). Returns the IP to connect
 * to, or null when the host does not resolve or resolves only to non-global
 * addresses.
 */
export async function resolvePinnedIp(host: string): Promise<string | null> {
  if (net.isIP(host)) {
    return isGlobalIp(host) ? host : null;
  }
  let addrs: string[];
  try {
    addrs = await dns.resolve4(host);
  } catch {
    return null;
  }
  for (const ip of addrs) {
    if (isGlobalIp(ip)) return ip;
  }
  return null;
}

/**
 * Parse a CONNECT target (`host:port`, or `[v6]:port`) into its parts. Returns
 * null on malformed input.
 */
export function parseConnectTarget(
  url: string | undefined
): { hostname: string; port: number } | null {
  if (!url) return null;
  const v6 = url.match(/^\[(.+)\]:(\d+)$/);
  if (v6) {
    const port = Number(v6[2]);
    return port >= 1 && port <= 65535 ? { hostname: v6[1], port } : null;
  }
  const idx = url.lastIndexOf(":");
  if (idx <= 0) return null;
  const hostname = url.slice(0, idx);
  const port = Number(url.slice(idx + 1));
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return { hostname, port };
}

export function startEgressBroker(
  opts: EgressBrokerOptions
): Promise<EgressBrokerHandle> {
  const bindHost = opts.host ?? "127.0.0.1";
  const resolveHost = opts.resolveHost ?? resolvePinnedIp;
  const deny = (host: string, reason: string) => {
    opts.onDeny?.(host, reason);
    logger.warn(`[egress-broker] DENY ${host} (${reason})`);
  };

  const server = http.createServer((req, res) => {
    // Plain (non-CONNECT) HTTP. Claude/gh/git use HTTPS, but honor http for
    // package downloads etc. Same default-deny host + global-IP policy.
    const parsed = parsePlainHttpTarget(req);
    if (!parsed) {
      res.writeHead(400).end("egress-broker: bad request\n");
      return;
    }
    if (!isHostAllowed(parsed.hostname, opts.allowlist)) {
      deny(parsed.hostname, "host-not-allowlisted");
      res.writeHead(403).end("egress-broker: host not allowlisted\n");
      return;
    }
    resolveHost(parsed.hostname)
      .then(ip => {
        if (!ip) {
          deny(parsed.hostname, "no-global-ip");
          res.writeHead(403).end("egress-broker: destination not allowed\n");
          return;
        }
        const proxyReq = http.request(
          {
            host: ip,
            port: parsed.port,
            method: req.method,
            path: parsed.path,
            headers: { ...req.headers, host: parsed.hostHeader },
          },
          proxyRes => {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(res);
          }
        );
        proxyReq.on("error", () => {
          if (!res.headersSent)
            res.writeHead(502).end("egress-broker: upstream error\n");
          else res.destroy();
        });
        req.pipe(proxyReq);
      })
      .catch(() => {
        if (!res.headersSent)
          res.writeHead(502).end("egress-broker: upstream error\n");
      });
  });

  // HTTPS (and any TLS) traffic arrives as a CONNECT tunnel request.
  server.on("connect", (req, clientSocket, head) => {
    clientSocket.on("error", () => {});
    const target = parseConnectTarget(req.url);
    if (!target) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    if (!isHostAllowed(target.hostname, opts.allowlist)) {
      deny(target.hostname, "host-not-allowlisted");
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    resolveHost(target.hostname)
      .then(ip => {
        if (!ip) {
          deny(target.hostname, "no-global-ip");
          clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
          return;
        }
        // net.connect targets the PINNED ip, not the hostname (anti-rebind).
        const upstream = net.connect(target.port, ip, () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head && head.length) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy());
        upstream.on("error", () => {
          if (!clientSocket.destroyed) {
            clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          }
        });
        clientSocket.on("error", () => upstream.destroy());
        clientSocket.on("close", () => upstream.destroy());
      })
      .catch(() => {
        if (!clientSocket.destroyed) {
          clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        }
      });
  });

  return new Promise<EgressBrokerHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, bindHost, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      logger.info(`[egress-broker] listening on ${bindHost}:${port}`);
      resolve({
        port,
        host: bindHost,
        close: () =>
          new Promise<void>(res => {
            server.close(() => res());
          }),
      });
    });
  });
}

/**
 * Extract the {hostname, port, path, hostHeader} for a plain-HTTP proxied
 * request. Handles both an absolute-form request URL (`http://host/path`, sent
 * by a proxy-aware client) and the Host header.
 */
function parsePlainHttpTarget(req: http.IncomingMessage): {
  hostname: string;
  port: number;
  path: string;
  hostHeader: string;
} | null {
  const hostHeader = req.headers.host;
  let urlStr = req.url ?? "";
  try {
    if (/^https?:\/\//i.test(urlStr)) {
      const u = new URL(urlStr);
      return {
        hostname: u.hostname,
        port: u.port ? Number(u.port) : 80,
        path: u.pathname + u.search,
        hostHeader: u.host,
      };
    }
    if (hostHeader) {
      const [h, p] = hostHeader.split(":");
      return {
        hostname: h,
        port: p ? Number(p) : 80,
        path: urlStr || "/",
        hostHeader,
      };
    }
  } catch {
    return null;
  }
  return null;
}
