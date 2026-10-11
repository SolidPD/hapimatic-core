// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Standard Markdown collapses multiple blank lines into a single paragraph
 * break. This pre-processor preserves extra blank lines by inserting
 * non-breaking space (\u00A0) placeholder paragraphs so the rendered output
 * matches what the user typed in the textarea.
 *
 *   \n\n   → 1 paragraph break (standard behavior)
 *   \n\n\n → 1 paragraph break + 1 empty-looking paragraph (2 visual gaps)
 */
export function preserveBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, match => {
    const extra = match.length - 2;
    return "\n\n" + "\u00a0\n\n".repeat(extra);
  });
}
