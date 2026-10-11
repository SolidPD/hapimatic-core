// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Line-move utilities for text editing toolbars.
 *
 * A "line" is all text between newline (\n) characters.
 * These functions swap the current line (determined by cursor position)
 * with an adjacent line, preserving the cursor's offset within the line.
 */

/** Find the start index of the line containing `pos`. */
function lineStart(text: string, pos: number): number {
  const idx = text.lastIndexOf("\n", pos - 1);
  return idx === -1 ? 0 : idx + 1;
}

/** Find the end index (exclusive, points at \n or text.length) of the line containing `pos`. */
function lineEnd(text: string, pos: number): number {
  const idx = text.indexOf("\n", pos);
  return idx === -1 ? text.length : idx;
}

/** True when the cursor is on the first line (no \n before pos). */
export function isFirstLine(text: string, pos: number): boolean {
  return text.lastIndexOf("\n", pos - 1) === -1;
}

/** True when the cursor is on the last line (no \n at or after pos). */
export function isLastLine(text: string, pos: number): boolean {
  const end = lineEnd(text, pos);
  return end === text.length;
}

export type MoveResult = { text: string; cursorPos: number };

/**
 * Move the line containing `cursorPos` up by one position.
 * Returns null if the cursor is on the first line or text is empty.
 */
export function moveLineUp(text: string, cursorPos: number): MoveResult | null {
  if (!text || isFirstLine(text, cursorPos)) return null;

  const curStart = lineStart(text, cursorPos);
  const curEnd = lineEnd(text, cursorPos);
  const prevStart = lineStart(text, curStart - 1);
  // prevEnd is curStart - 1 (the \n between the two lines)

  const prevLine = text.slice(prevStart, curStart - 1);
  const curLine = text.slice(curStart, curEnd);

  const before = text.slice(0, prevStart);
  const after = text.slice(curEnd);

  const newText = before + curLine + "\n" + prevLine + after;

  // Cursor offset within the current line stays the same
  const offsetInLine = cursorPos - curStart;
  const newCursorPos = prevStart + offsetInLine;

  return { text: newText, cursorPos: newCursorPos };
}

/**
 * Move the line containing `cursorPos` down by one position.
 * Returns null if the cursor is on the last line or text is empty.
 */
export function moveLineDown(
  text: string,
  cursorPos: number
): MoveResult | null {
  if (!text || isLastLine(text, cursorPos)) return null;

  const curStart = lineStart(text, cursorPos);
  const curEnd = lineEnd(text, cursorPos);
  const nextStart = curEnd + 1; // skip the \n
  const nextEnd = lineEnd(text, nextStart);

  const curLine = text.slice(curStart, curEnd);
  const nextLine = text.slice(nextStart, nextEnd);

  const before = text.slice(0, curStart);
  const after = text.slice(nextEnd);

  const newText = before + nextLine + "\n" + curLine + after;

  // Cursor moves down by the length of the next line + 1 (for \n)
  const offsetInLine = cursorPos - curStart;
  const newCursorPos = curStart + nextLine.length + 1 + offsetInLine;

  return { text: newText, cursorPos: newCursorPos };
}
