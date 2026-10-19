// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session ID generation — shared so the daemon (which generates the id at spawn)
 * and the server (which pre-generates it for the issue #1565 early-return path)
 * produce IDENTICAL `hapi-<timestamp>-<random>` ids from one definition.
 *
 * Previously lived in `cli/src/utils/id.ts`; moved here (re-exported from there
 * for backward-compat) so the early-return spawn route can mint a daemon-accepted
 * `hapiSessionId` server-side without a cli→server import.
 *
 * The random part comes from `crypto.getRandomValues` rather than
 * `Math.random()`. A session id is not a secret (every route that accepts one
 * also requires a login token, and the id appears in window titles and logs),
 * but the CSPRNG costs nothing, removes any collision argument, and clears the
 * five `js/insecure-randomness` alerts CodeQL raised on the public core
 * (hapimatic-core #10–#14, 2026-10-18).
 */

const BASE36_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * `length` characters drawn uniformly from `[0-9a-z]` using the platform
 * CSPRNG (`globalThis.crypto` exists in Bun, Node ≥ 19 and every browser).
 * Bytes ≥ 252 are rejected so `byte % 36` is unbiased (252 = 7 × 36).
 */
export function randomBase36(length: number): string {
  let out = "";
  while (out.length < length) {
    const bytes = new Uint8Array(length - out.length);
    globalThis.crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < 252 && out.length < length) out += BASE36_ALPHABET[b % 36];
    }
  }
  return out;
}

/**
 * Generate a unique session ID.
 * Format: `hapi-<timestamp>-<random>` — eight `[0-9a-z]` characters, the same
 * shape `Math.random().toString(36).slice(2, 10)` produced before.
 */
export function generateSessionId(): string {
  const timestamp = Date.now();
  return `hapi-${timestamp}-${randomBase36(8)}`;
}
