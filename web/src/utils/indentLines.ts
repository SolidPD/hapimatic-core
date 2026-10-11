// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Tab / Shift+Tab indent + outdent utilities for the text editors (prompt
 * composer, fullscreen prompt editor, inline notes, fullscreen notes editor).
 *
 * Sublime-Text-style semantics with a fixed two-space indentation unit (the app
 * has no tab-width setting):
 *
 * - Tab with a collapsed caret inserts the unit at the caret.
 * - Tab with a selection prepends the unit to EVERY line the selection touches
 *   and keeps the selection covering the same lines.
 * - Shift+Tab removes up to one unit of leading spaces (or one leading tab
 *   character) from every touched line; caret / selection offsets are clamped
 *   so they never go negative and never move to another line.
 *
 * A "line" is all text between newline (\n) characters, matching moveLines.ts.
 * A selection that ends at column 0 of a line does NOT touch that line (the
 * caret merely sits after the previous line's newline), which is what keeps a
 * full-line selection from also indenting the line below it.
 */

/** The fixed indentation unit. */
export const INDENT_UNIT = "  ";

export type IndentResult = {
  text: string;
  selectionStart: number;
  selectionEnd: number;
};

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

/**
 * The position that anchors the LAST touched line of a selection. When a
 * non-empty selection ends at column 0 (right after a \n), the anchor steps
 * back onto that \n so the line below is left alone.
 */
function lastLineAnchor(text: string, start: number, end: number): number {
  return end > start && text[end - 1] === "\n" ? end - 1 : end;
}

/** Number of leading characters one outdent removes from `line` (0, 1, or 2). */
function outdentWidth(line: string): number {
  if (line.startsWith("\t")) return 1;
  let n = 0;
  while (n < INDENT_UNIT.length && line[n] === " ") n++;
  return n;
}

/**
 * Indent: insert the unit at a collapsed caret, or prepend it to every line a
 * selection touches. Always produces a change.
 */
export function indentLines(
  text: string,
  selectionStart: number,
  selectionEnd: number
): IndentResult {
  const start = Math.min(selectionStart, selectionEnd);
  const end = Math.max(selectionStart, selectionEnd);

  if (start === end) {
    const caret = start + INDENT_UNIT.length;
    return {
      text: text.slice(0, start) + INDENT_UNIT + text.slice(start),
      selectionStart: caret,
      selectionEnd: caret,
    };
  }

  const firstStart = lineStart(text, start);
  const blockEnd = lineEnd(text, lastLineAnchor(text, start, end));
  const lines = text.slice(firstStart, blockEnd).split("\n");
  const indented = lines.map(line => INDENT_UNIT + line).join("\n");

  return {
    text: text.slice(0, firstStart) + indented + text.slice(blockEnd),
    // A selection anchored at column 0 grows to include the new indent (so a
    // full-line selection stays full-line); one anchored mid-line keeps
    // covering the same characters.
    selectionStart: start === firstStart ? start : start + INDENT_UNIT.length,
    // Every inserted unit sits before the selection end.
    selectionEnd: end + INDENT_UNIT.length * lines.length,
  };
}

/**
 * Outdent: strip up to one unit of leading whitespace from every line the
 * caret / selection touches. Returns the input unchanged (same text, same
 * offsets) when no touched line has anything to remove.
 */
export function outdentLines(
  text: string,
  selectionStart: number,
  selectionEnd: number
): IndentResult {
  const start = Math.min(selectionStart, selectionEnd);
  const end = Math.max(selectionStart, selectionEnd);

  const firstStart = lineStart(text, start);
  const anchor = lastLineAnchor(text, start, end);
  const lastStart = lineStart(text, anchor);
  const blockEnd = lineEnd(text, anchor);
  const lines = text.slice(firstStart, blockEnd).split("\n");
  const removed = lines.map(outdentWidth);
  const total = removed.reduce((sum, n) => sum + n, 0);

  if (total === 0) {
    return { text, selectionStart: start, selectionEnd: end };
  }

  const outdented = lines.map((line, i) => line.slice(removed[i])).join("\n");
  const newText = text.slice(0, firstStart) + outdented + text.slice(blockEnd);

  // The start stays on the first line: shift left by what that line lost, but
  // never past the line start (a caret inside the removed whitespace lands at
  // column 0).
  const removedFirst = removed[0];
  const newStart = firstStart + Math.max(0, start - firstStart - removedFirst);

  let newEnd: number;
  if (anchor !== end) {
    // The end sits at column 0 of the line below the block, so every removed
    // character is before it.
    newEnd = end - total;
  } else {
    const removedLast = removed[removed.length - 1];
    const newLastStart = lastStart - (total - removedLast);
    newEnd = newLastStart + Math.max(0, end - lastStart - removedLast);
  }

  return { text: newText, selectionStart: newStart, selectionEnd: newEnd };
}

export type IndentKeyAction = "indent" | "outdent";

/** The subset of a keyboard event the indent feature reads. */
export type IndentKeyEvent = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey"
> & { preventDefault(): void; stopPropagation(): void };

/**
 * Classify a keydown: a bare Tab indents, Shift+Tab outdents, anything else
 * (including Ctrl/Cmd/Alt+Tab, which browsers and OSes own) is not ours.
 */
export function getIndentKeyAction(
  e: Pick<IndentKeyEvent, "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">
): IndentKeyAction | null {
  if (e.key !== "Tab") return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  return e.shiftKey ? "outdent" : "indent";
}

/**
 * Shared keydown entry point for every editor surface. Reads the textarea's
 * live value + selection, and returns the new text + selection when the
 * keystroke was an indent / outdent that actually changed the text — having
 * already called `preventDefault()` and `stopPropagation()`. Returns null
 * (without touching the event) when the key is not ours or the outdent was a
 * no-op, so an unhandled Tab still moves focus for keyboard accessibility.
 *
 * Callers must apply the result themselves (each surface owns its text state)
 * and restore the selection after React re-renders the controlled textarea.
 * Callers are also responsible for the surface-level guards that run BEFORE
 * this helper: IME composition (`event.nativeEvent.isComposing`) and any
 * higher-precedence Tab consumer such as the composer's suggestion list.
 */
export function handleIndentKeyDown(
  e: IndentKeyEvent,
  ta: Pick<HTMLTextAreaElement, "value" | "selectionStart" | "selectionEnd">
): IndentResult | null {
  const action = getIndentKeyAction(e);
  if (!action) return null;

  const result =
    action === "indent"
      ? indentLines(ta.value, ta.selectionStart, ta.selectionEnd)
      : outdentLines(ta.value, ta.selectionStart, ta.selectionEnd);

  if (result.text === ta.value) return null;

  e.preventDefault();
  // Also stop propagation: the Radix Dialog focus trap (react-focus-scope
  // 1.1.7 `handleKeyDown`, mounted with `loop: true`) handles Tab in its own
  // React onKeyDown on the dialog container WITHOUT checking defaultPrevented,
  // so a handled Tab on the dialog's last tabbable element (the fullscreen
  // notes textarea) would otherwise still loop focus to the first control.
  e.stopPropagation();
  return result;
}
