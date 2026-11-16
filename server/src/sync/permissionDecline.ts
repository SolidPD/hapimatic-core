// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A declined answer set (#6606 round 9, F4). When the Codex CLI declines an
 * approval's answer set (R13), its "permission" RPC replies
 * `{declined: true, reason}`; any other reply means nothing was declined.
 * Kept out of `rpcGateway.ts`, which is at its 1,500-line cap (#2077).
 */
export type PermissionDeclined = { reason: string };

/** The CLI's reply to a "permission" RPC: its decline, or null. */
export function readPermissionDecline(
  reply: unknown
): PermissionDeclined | null {
  if (typeof reply !== "object" || reply === null) return null;
  const { declined, reason } = reply as {
    declined?: unknown;
    reason?: unknown;
  };
  return declined === true && typeof reason === "string" ? { reason } : null;
}
