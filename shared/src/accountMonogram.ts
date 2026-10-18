// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-account monogram override (issue #3621).
 *
 * A node-local, operator-set override for the Account Chip's monogram — the
 * displayed **letter** and its **color** — persisted in a sidecar store
 * (`MonogramStore` → `<dataDir>/account-monograms.json`), NEVER the token-bearing
 * credentials record. Mirrors the nickname override's sidecar design.
 *
 * The store persists color **ids** (not Tailwind class strings): a node-local
 * JSON file must not be coupled to the web layer's Tailwind naming. `AccountChip`
 * maps each id to its literal Tailwind class.
 */
import { z } from "zod";

/**
 * The six monogram color ids — 1:1 (same order) with `AccountChip`'s
 * `ACCOUNT_MONO_COLORS` hash palette, so the id list drives both the per-email
 * hash color and the operator swatch picker.
 */
export const ACCOUNT_MONO_COLOR_IDS = [
  "blue",
  "violet",
  "cyan",
  "teal",
  "pink",
  "amber",
] as const;

export type AccountMonoColorId = (typeof ACCOUNT_MONO_COLOR_IDS)[number];

/**
 * The pinned monogram's length budget: one OR two characters (code units).
 * Two letters ("NF", "MG") make chips far more distinguishable than a single
 * initial; the chip's monogram bubble widens into a pill for the second glyph.
 * ONE declaration — the shared validator, the editor's input `maxLength`, and
 * the chip's defensive slice all read it.
 */
export const ACCOUNT_MONO_MAX_CHARS = 2;

/** Runtime guard: is `v` one of the six known color ids? */
export function isAccountMonoColorId(v: unknown): v is AccountMonoColorId {
  return (
    typeof v === "string" &&
    (ACCOUNT_MONO_COLOR_IDS as readonly string[]).includes(v)
  );
}

/**
 * A per-account monogram override.
 *
 * - `letter` — one or two trimmed code units (`ACCOUNT_MONO_MAX_CHARS`),
 *   upper-cased. **Present ⇒ the letter is pinned** and survives later nickname
 *   edits; **absent ⇒ auto** (the chip derives a single initial from the label,
 *   exactly as `accountMonogram()` renders). There is deliberately no separate
 *   `letterPinned` flag — presence is the pin (a flag admitted contradictory
 *   states).
 * - `color` — one of the six `AccountMonoColorId`s; absent ⇒ the chip's per-email
 *   hash color (the pre-override default).
 *
 * An empty object `{}` (both fields absent) means "no override" and clears the
 * stored entry.
 */
export type AccountMonogram = {
  letter?: string;
  color?: AccountMonoColorId;
};

/**
 * The wire schema of an {@link AccountMonogram} (issue #4461; shared with #4463 —
 * whichever lands second imports it). A plain whitelist `z.object()`: an unknown
 * key is stripped on parse, and the letter budget is the same
 * `ACCOUNT_MONO_MAX_CHARS` the normalizer enforces.
 */
export const AccountMonogramSchema = z.object({
  letter: z.string().min(1).max(ACCOUNT_MONO_MAX_CHARS).optional(),
  color: z.enum(ACCOUNT_MONO_COLOR_IDS).optional(),
});

/**
 * Normalize a raw monogram input into a valid, stored-shape `AccountMonogram`, or
 * return an error string. Shared by the server route (request validation) and the
 * store, so both enforce the identical contract:
 *
 * - `letter`: trimmed; a blank/absent letter is dropped (⇒ auto). A non-blank
 *   letter MUST be one or two code units after trimming
 *   (`ACCOUNT_MONO_MAX_CHARS`), then it is upper-cased.
 * - `color`: MUST be one of `ACCOUNT_MONO_COLOR_IDS`; a blank/absent color is
 *   dropped (⇒ hash color).
 * - Unknown keys are ignored.
 *
 * The result carries only the present, valid fields, so `{}` (or an all-absent
 * input) is the "clear" sentinel.
 */
export function normalizeAccountMonogram(
  input: unknown
): { ok: true; value: AccountMonogram } | { ok: false; error: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "monogram must be an object" };
  }
  const raw = input as { letter?: unknown; color?: unknown };
  const value: AccountMonogram = {};

  if (raw.letter !== undefined && raw.letter !== null) {
    if (typeof raw.letter !== "string") {
      return { ok: false, error: "letter must be a string" };
    }
    const trimmed = raw.letter.trim();
    if (trimmed !== "") {
      // One or two code units — a pinned two-letter monogram ("NF") is the
      // whole point of the override; anything longer would not fit the bubble.
      if (trimmed.length > ACCOUNT_MONO_MAX_CHARS) {
        return {
          ok: false,
          error: `letter must be at most ${ACCOUNT_MONO_MAX_CHARS} characters`,
        };
      }
      value.letter = trimmed.toUpperCase();
    }
    // a blank letter is dropped ⇒ auto (unpinned)
  }

  if (raw.color !== undefined && raw.color !== null && raw.color !== "") {
    if (!isAccountMonoColorId(raw.color)) {
      return {
        ok: false,
        error: `color must be one of: ${ACCOUNT_MONO_COLOR_IDS.join(", ")}`,
      };
    }
    value.color = raw.color;
  }

  return { ok: true, value };
}
