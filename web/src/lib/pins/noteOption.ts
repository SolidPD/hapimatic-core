// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "in the note", "in my note" or "in a note", as whole words, any case: an
 * option worded that way says the answer is in the operator's note.
 */
const POINTS_TO_NOTE = /\bin (?:the|my|a) note\b/i;

/**
 * #6768 (ruling 2A): true for an option whose answer is the operator's note,
 * so a Submit holds it while the note is empty (R7): the option id `note`, or a
 * label saying "in the note", "in my note" or "in a note". A heuristic: an
 * option worded otherwise escapes it; #6803's write-in answer is the lasting
 * answer. Zod-free, like `staging.ts`.
 */
export function optionPointsToNote(option: {
  id: string;
  label?: string;
}): boolean {
  if (option.id.trim().toLowerCase() === "note") return true;
  return option.label !== undefined && POINTS_TO_NOTE.test(option.label);
}
