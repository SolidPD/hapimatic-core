// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #4497: a random RFC 4122 version-4 UUID on any origin.
 *
 * `crypto.randomUUID()` exists only in a secure context (HTTPS or localhost),
 * and the hub is often opened over plain HTTP at a Tailscale IP, where calling
 * it throws. `crypto.getRandomValues()` exists in every context, so the
 * fallback builds the same v4 layout from it. The result must stay a real
 * UUID: the federation spawn route validates `spawnCorrelationId` with
 * `z.string().uuid()`.
 */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
