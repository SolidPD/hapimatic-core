// SPDX-License-Identifier: AGPL-3.0-only
import type { RedactedApiKey } from "@hapi/protocol/schemas";

/**
 * B3 (#1956): per-key validation status → indicator color + label.
 * 🟢 valid / 🔴 invalid / 🟠 unverified / ⚪ none.
 *
 * The ONE copy (#4568, per #4466 Task 3's contract): moved verbatim from
 * `ApiKeysSection.tsx` so the Settings → Keys list and the spawn picker's
 * "API keys" rows color a key's status identically. Add no third copy.
 */
export const API_KEY_STATUS_META: Record<
  RedactedApiKey["status"],
  { label: string; color: string }
> = {
  valid: { label: "Valid", color: "var(--status-ok)" },
  invalid: { label: "Invalid", color: "var(--status-hot)" },
  unverified: { label: "Unverified", color: "var(--status-warn)" },
  none: { label: "Not validated", color: "var(--app-hint)" },
};

/**
 * Issue #4568: the ONE rule for naming a vault key on screen — its label, else
 * its masked form. The picker row, the create-page summary and the spawn
 * preview all call this, so a key reads the same on every surface (R7).
 * Label-only by construction: the redacted view carries no key material.
 */
export function apiKeyDisplayName(
  key: Pick<RedactedApiKey, "label" | "maskedKey">
): string {
  return key.label?.trim() || key.maskedKey;
}
