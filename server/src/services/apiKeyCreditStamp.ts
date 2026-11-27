// SPDX-License-Identifier: AGPL-3.0-only
import { maskApiKey, type StoredApiKey } from "@hapi/protocol/schemas";
import { updateSettings } from "../config/settings";
import { computeApiKeyBudget } from "./apiKeyBudget";

/**
 * Issue #6978: the ONE write path for a key's out-of-credit stamp, used by the
 * local observer (a session on this node) and by the home receiver
 * `POST /api/federation/api-keys/out-of-credit` (a session on another node).
 *
 * The stamp is superseded at read time by later spend, a budget edit or a
 * top-up (`computeApiKeyBudget` in `apiKeyBudget.ts`), so nothing here clears
 * it. A stamp is written at most once per {@link API_KEY_CREDIT_RESTAMP_WINDOW_MS}
 * while it still stands.
 */

/** A key is re-stamped at most this often while its sessions keep failing. */
export const API_KEY_CREDIT_RESTAMP_WINDOW_MS = 60_000;

export type ApiKeyCreditStampResult =
  | "stamped"
  | "recent"
  | "not_found"
  | "not_shared"
  | "changed";

export type ApiKeyCreditStampOutcome = {
  result: ApiKeyCreditStampResult;
  /** The vault's stamp after the call: the new one on `stamped`, the standing
   *  one on `recent`. Absent on every refusal. */
  stampedAt?: string;
};

export type ApiKeyCreditStampGuard = {
  /** Refuse (`not_shared`) a key that is not shared across nodes. */
  requireShared?: boolean;
  /** Refuse (`changed`) a key whose masked form is not this one. */
  expectedMasked?: string;
};

/**
 * Stamp `outOfCreditAt` on the vault key `keyId` at `atMs`, the caller's clock
 * (the home's, for a received report). Every check is made on the settings read
 * inside the write chain, so a key replaced or unshared since the caller looked
 * is refused, not stamped. Only `stamped` writes; every other result leaves the
 * file byte-identical. A {@link SettingsUnreadableError} propagates.
 */
export async function stampOutOfCredit(
  settingsFile: string,
  keyId: string,
  atMs: number,
  guard: ApiKeyCreditStampGuard = {}
): Promise<ApiKeyCreditStampOutcome> {
  let outcome: ApiKeyCreditStampOutcome = { result: "not_found" };
  await updateSettings(settingsFile, fresh => {
    const entries = Array.isArray(fresh.apiKeys) ? fresh.apiKeys : [];
    const idx = entries.findIndex(e => e?.id === keyId);
    const entry = idx === -1 ? undefined : entries[idx];
    // As the receiver's `checkKey` answers it: a missing or non-Anthropic entry,
    // or one whose secret is not a string, is not a key this node can stamp.
    if (
      !entry ||
      entry.provider !== "anthropic" ||
      typeof entry.key !== "string"
    ) {
      outcome = { result: "not_found" };
      return fresh;
    }
    if (guard.requireShared && entry.shareAcrossNodes !== true) {
      outcome = { result: "not_shared" };
      return fresh;
    }
    if (
      guard.expectedMasked !== undefined &&
      maskApiKey(entry.key) !== guard.expectedMasked
    ) {
      outcome = { result: "changed" };
      return fresh;
    }
    const standing = standingRecentStamp(entry, atMs);
    if (standing !== null) {
      outcome = { result: "recent", stampedAt: standing };
      return fresh;
    }
    const stampedAt = new Date(atMs).toISOString();
    outcome = { result: "stamped", stampedAt };
    return {
      ...fresh,
      apiKeys: entries.map((e, i) =>
        i === idx ? { ...e, outOfCreditAt: stampedAt } : e
      ),
    };
  });
  return outcome;
}

/**
 * The entry's stamp when it is recent enough to stand in for a new one: it
 * parses, is at or before `atMs`, lies within the window, and still stands on
 * the read-time checks that need no spend: no budget set after it and no top-up
 * after it (`computeApiKeyBudget` with no spend, as the viewer's `noReading`
 * asks it). A stamp a budget edit or a top-up has superseded is not recent, so
 * a refusal after it is recorded afresh. Spend since the stamp is not read here
 * (the write chain does no I/O). Null otherwise.
 */
function standingRecentStamp(entry: StoredApiKey, atMs: number): string | null {
  const raw = entry.outOfCreditAt;
  if (typeof raw !== "string") return null;
  const outAt = Date.parse(raw);
  if (!Number.isFinite(outAt) || outAt > atMs) return null;
  if (atMs - outAt >= API_KEY_CREDIT_RESTAMP_WINDOW_MS) return null;
  try {
    const { outOfCredit } = computeApiKeyBudget({
      budget: entry.budget,
      recurrence: entry.budgetRecurrence,
      outOfCreditAt: raw,
      nowMs: atMs,
      spend: () => 0,
    });
    return outOfCredit ? raw : null;
  } catch {
    // An unreadable budget or top-up: record the new refusal.
    return null;
  }
}
