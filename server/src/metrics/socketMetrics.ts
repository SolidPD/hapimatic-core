// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Linux-only server-socket state counter (#1032).
 *
 * Parses /proc/net/tcp and /proc/net/tcp6 once per `CACHE_MS` window so the
 * /api/health endpoint can surface the current CLOSE_WAIT count on the
 * server's listen port. CLOSE_WAIT is the canonical indicator of the
 * "clients closed, server didn't notice" failure mode that this issue
 * addresses.
 *
 * Returns `null` on non-Linux platforms (darwin/win32) rather than
 * throwing — the health endpoint degrades gracefully.
 */

import { readFile } from "node:fs/promises";

/** Cache window: short enough to be near-live, long enough to avoid I/O per health check. */
const CACHE_MS = 15_000;

/** TCP state values from include/net/tcp_states.h. */
const TCP_ESTABLISHED = 0x01;
const TCP_LISTEN = 0x0a;
const TCP_CLOSE_WAIT = 0x08;

type SocketCounts = {
  total: number;
  established: number;
  closeWait: number;
};

type CacheEntry = {
  at: number;
  value: SocketCounts | null;
};

const cache = new Map<number, CacheEntry>();

/**
 * Get current socket state counts for `listenPort`. Returns `null` if the
 * host doesn't expose /proc/net/tcp (non-Linux).
 */
export async function getSocketCounts(
  listenPort: number
): Promise<SocketCounts | null> {
  const now = Date.now();
  const cached = cache.get(listenPort);
  if (cached && now - cached.at < CACHE_MS) {
    return cached.value;
  }

  const value = await readSocketCounts(listenPort);
  cache.set(listenPort, { at: now, value });
  return value;
}

async function readSocketCounts(
  listenPort: number
): Promise<SocketCounts | null> {
  if (process.platform !== "linux") {
    return null;
  }

  const counts: SocketCounts = {
    total: 0,
    established: 0,
    closeWait: 0,
  };

  const paths = ["/proc/net/tcp", "/proc/net/tcp6"];
  let anyRead = false;

  for (const path of paths) {
    try {
      const data = await readFile(path, "utf8");
      accumulate(counts, data, listenPort);
      anyRead = true;
    } catch {
      // /proc/net/tcp6 may not exist on IPv6-disabled kernels — skip.
    }
  }

  return anyRead ? counts : null;
}

function accumulate(
  counts: SocketCounts,
  procData: string,
  listenPort: number
): void {
  const hexPort = listenPort.toString(16).toUpperCase().padStart(4, "0");
  const lines = procData.split("\n");
  // Skip header line.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // Columns (space-separated): sl local_address rem_address st tx_queue:rx_queue ...
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;

    const localAddress = parts[1];
    const state = parts[3];
    if (!localAddress || !state) continue;

    // local_address format: HEX_IP:HEX_PORT
    const colon = localAddress.lastIndexOf(":");
    if (colon === -1) continue;
    const portHex = localAddress.slice(colon + 1);
    if (portHex !== hexPort) continue;

    const stateNum = parseInt(state, 16);
    // Skip LISTEN — that's the listen socket itself, not an accepted connection.
    if (stateNum === TCP_LISTEN) continue;

    counts.total += 1;
    if (stateNum === TCP_ESTABLISHED) counts.established += 1;
    if (stateNum === TCP_CLOSE_WAIT) counts.closeWait += 1;
  }
}

/** Clear the cache. Test-only helper. */
export function resetSocketMetricsForTesting(): void {
  cache.clear();
}
