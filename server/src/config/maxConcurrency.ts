// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server-side persistence + validation for the user-settable spawn-concurrency
 * cap (issue #1805).
 *
 * The SERVER is the sole writer of the `maxConcurrentSessions` settings.json
 * key; the daemon only READS it at the spawn gate (KD-2 — this sidesteps the
 * pre-existing CLI-locked vs server-unlocked settings.json write race). The
 * clamp here mirrors the daemon-side clamp (`cli/src/daemon/sessionTracker.ts`
 * `clampMaxConcurrent`) so a value written through this path is already in range;
 * the daemon re-clamps regardless — the daemon clamp, not this one, is the real
 * OOM safety boundary (R9).
 *
 * #4417 (Task 6): a `null` value CLEARS the key (back to the daemon's automatic
 * tier/derived/default resolution), so a node that once had an explicit cap can
 * reach the new layers again without a hand edit of its settings file.
 */

import {
  MAX_CONCURRENCY_FLOOR,
  MAX_CONCURRENCY_HARD_CEILING,
  MaxConcurrencyPreferenceSchema,
} from "@hapi/protocol/schemas";
import { readSettings, writeSettings } from "./settings";

/**
 * Clamp a value to `[floor, ceiling]`. Same shape as the daemon resolver's
 * clamp (R9) — defense-in-depth after schema validation.
 */
export function clampMaxConcurrency(value: number): number {
  return Math.min(
    MAX_CONCURRENCY_HARD_CEILING,
    Math.max(MAX_CONCURRENCY_FLOOR, Math.floor(value))
  );
}

/**
 * Read the persisted cap for this node. Returns `undefined` when the key is
 * unset (the daemon then falls back to env/default) or when settings.json is
 * unreadable.
 */
export async function readMaxConcurrency(
  settingsFile: string
): Promise<number | undefined> {
  const settings = await readSettings(settingsFile);
  if (!settings) return undefined;
  return settings.maxConcurrentSessions;
}

/**
 * Validate + persist the cap (read-merge-write). Rejects out-of-range values
 * via `MaxConcurrencyPreferenceSchema` (R10 — the route maps the thrown error
 * to HTTP 400). A `null` value CLEARS the key (back to automatic, #4417 Task 6).
 * Returns the persisted (clamped) value, or `null` when the key was cleared.
 * Throws when settings.json exists but cannot be parsed (do NOT overwrite —
 * avoid data loss), the same guard for both the set and clear paths.
 */
export async function writeMaxConcurrency(
  settingsFile: string,
  value: number | null
): Promise<number | null> {
  // Validate floor/ceiling (or accept null). Throws ZodError on out-of-range → route → 400.
  const parsed = MaxConcurrencyPreferenceSchema.parse({ value });

  const settings = await readSettings(settingsFile);
  if (settings === null) {
    throw new Error(
      `Cannot read ${settingsFile} to persist max-concurrency (parse error).`
    );
  }

  if (parsed.value === null) {
    // Clear to automatic: delete the key so the daemon resolver falls through to
    // its tier/derived/default layers. Same read-merge-write + parse-error guard.
    const next = { ...settings };
    delete next.maxConcurrentSessions;
    await writeSettings(settingsFile, next);
    return null;
  }

  const clamped = clampMaxConcurrency(parsed.value);
  await writeSettings(settingsFile, {
    ...settings,
    maxConcurrentSessions: clamped,
  });
  return clamped;
}
