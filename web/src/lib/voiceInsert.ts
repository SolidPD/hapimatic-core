// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Insert a voice transcript into the composer text at the cursor (issue #4707).
 *
 * Replaces the current selection when there is one, and adds a single space on
 * either side only where the neighbouring character is not already whitespace.
 * The transcript is never sent — the caller only updates the composer text.
 */
export interface TextSelection {
  start: number;
  end: number;
}

export function insertTranscript(
  text: string,
  selection: TextSelection,
  transcript: string
): { text: string; cursor: number } {
  const clean = transcript.trim();
  const start = Math.max(0, Math.min(selection.start, text.length));
  const end = Math.max(start, Math.min(selection.end, text.length));
  if (!clean) return { text, cursor: end };
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trail = after.length > 0 && !/^\s/.test(after) ? " " : "";
  const inserted = `${lead}${clean}${trail}`;
  return {
    text: `${before}${inserted}${after}`,
    cursor: before.length + lead.length + clean.length,
  };
}
