// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session ID generation — shared so the daemon (which generates the id at spawn)
 * and the server (which pre-generates it for the issue #1565 early-return path)
 * produce IDENTICAL `hapi-<timestamp>-<random>` ids from one definition.
 *
 * Previously lived in `cli/src/utils/id.ts`; moved here (re-exported from there
 * for backward-compat) so the early-return spawn route can mint a daemon-accepted
 * `hapiSessionId` server-side without a cli→server import.
 */

/**
 * Generate a unique session ID.
 * Format: `hapi-<timestamp>-<random>`
 */
export function generateSessionId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 10);
  return `hapi-${timestamp}-${random}`;
}
