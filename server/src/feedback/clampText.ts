// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cut `value` to at most `max` UTF-16 units without splitting a surrogate pair.
 * Non-strings pass through, so a schema downstream still rejects a malformed row.
 *
 * Shared by the two outbound feedback paths (issue #5744): the central sink
 * forwarder (`sinkForward.ts`, #2911) and the AgentMail relay sender
 * (`relayTransport.ts`, #2667). Both send text the feedback route scrubbed AFTER
 * its own length cap, and the redaction marker can lengthen it ("Bearer abc"
 * becomes "Bearer [REDACTED]"), so each path clamps to its receiver's cap rather
 * than having the row rejected for good. Clamping only removes characters from
 * already-scrubbed text, so it never re-exposes a secret.
 */
export function clampText(value: string, max: number): string;
export function clampText(value: unknown, max: number): unknown;
export function clampText(value: unknown, max: number): unknown {
  if (typeof value !== "string" || value.length <= max) return value;
  const last = value.charCodeAt(max - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff; // a high surrogate
  return value.slice(0, splitsPair ? max - 1 : max);
}
