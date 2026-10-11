// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Record an emoji pick in `emoji-picker-react`'s "Recently Used" row.
 *
 * The library records a pick only from its OWN grid's click handler (its
 * internal `setSuggested`, which is not exported). Since #796 a non-empty
 * search swaps that grid for our keyword-search results, so picks made from
 * search never reached the row and it froze at whatever was last clicked in
 * the library grid. `EmojiPickerPopover` calls `recordRecentEmoji` for those
 * picks, writing the library's own storage entry so its row picks them up on
 * the next open (the picker remounts on every open and re-reads storage).
 *
 * The key and entry shape are library internals (emoji-picker-react 4.x), not
 * public API. `emojiRecents.test.tsx` renders the real library against what
 * this module writes, so an upgrade that changes either one fails there.
 *
 * Pure module (no React imports).
 */

/** The library's localStorage key for its suggested row (internal, 4.x). */
export const EPR_SUGGESTED_KEY = "epr_suggested";

/** The library keeps at most this many suggested entries. */
export const EPR_SUGGESTED_MAX = 14;

type SuggestedEntry = { unified: string; original: string; count: number };

function isSuggestedEntry(value: unknown): value is SuggestedEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.unified === "string" && typeof entry.count === "number";
}

/**
 * The library's emoji key: lowercase hex code points, each padded to 4
 * digits, joined by "-" (💨 → "1f4a8", ©️ → "00a9-fe0f"). Unpadded codes are
 * silently dropped from the row, because the library cannot resolve them.
 */
export function emojiToUnified(char: string): string {
  return [...char]
    .map(c => (c.codePointAt(0) ?? 0).toString(16).padStart(4, "0"))
    .join("-");
}

function readSuggested(storage: Storage): SuggestedEntry[] {
  try {
    const parsed: unknown = JSON.parse(
      storage.getItem(EPR_SUGGESTED_KEY) ?? "[]"
    );
    return Array.isArray(parsed) ? parsed.filter(isSuggestedEntry) : [];
  } catch {
    // Corrupt JSON reads as empty, as in the library, so the next write
    // replaces it instead of leaving the row broken.
    return [];
  }
}

/**
 * Move `char` to the front of the suggested list, bumping its use count,
 * the same update the library applies to a pick from its own grid.
 */
export function recordRecentEmoji(
  char: string,
  storage: Storage | undefined = globalThis.localStorage
): void {
  if (!storage) return;
  const list = readSuggested(storage);
  const unified = emojiToUnified(char);
  const entry = list.find(e => e.unified === unified) ?? {
    unified,
    original: unified,
    count: 0,
  };
  entry.count += 1;
  const next = [entry, ...list.filter(e => e !== entry)].slice(
    0,
    EPR_SUGGESTED_MAX
  );
  try {
    storage.setItem(EPR_SUGGESTED_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: the row is a convenience and must never
    // block the pick itself.
  }
}
