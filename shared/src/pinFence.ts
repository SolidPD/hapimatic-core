// SPDX-License-Identifier: AGPL-3.0-only
// The `hapi_pin` fenced block: how an agent with no MCP posts a pin (issue #6448,
// epic #6446). The server reads each block into the same record `pin_post` writes
// (server/src/sync/pinFenceIngest.ts); the web renders the block (#6450). This
// module is the one language rule both sides use, and the scanner that finds the
// blocks. It is pure and dependency-free so it stays browser-safe.
//
// ## The rules
// A fence opens on a line with at most 3 spaces of indent, then 3 or more
// backticks or tildes, then an info string; a backtick fence's info string may not
// contain a backtick. It closes on a line of at most 3 spaces, the same character,
// at least as many of them, and nothing but whitespace after. Every fence is
// tracked whatever its language, so a `hapi_pin` fence inside a 4-backtick
// `markdown` fence is content, not a pin: that is how an agent shows the format
// as an example. A `hapi_pin` fence still open at the end of the text is reported
// as `unclosed` and never read. An HTML comment (`<!--` to `-->`) or a `<pre>`,
// `<script>`, `<style>` or `<textarea>` block (CommonMark HTML block types 1 and
// 2) is HTML, not markdown, so a fence inside it is not read either: an agent
// that comments a draft pin out does not post it.
//
// ## List items
// A fence a list item opens on its marker line (`- ```lang`, `1. ```lang`) is
// tracked like any other, so a `hapi_pin` example nested inside it stays content
// and its closing line is not mistaken for a new fence. It is never read as a pin
// itself. It ends at its own closing fence, indented to the item's content, or at
// the first non-blank line indented less than that content, where the list item
// ends (CommonMark closes an open code block with its container). Indent is
// counted in columns, a tab advancing to the next multiple of 4.
//
// ## Where this differs from CommonMark
// A fence inside a blockquote (`> `), in a list item indented 4 or more spaces,
// or opened on a list item's marker line is not read as a pin, although
// CommonMark renders each as a code block. A `<pre>`, `<script>`, `<style>` or
// `<textarea>` block ends only at its own closing tag here, where CommonMark ends
// it at any of the four. These differences miss a pin rather than invent one.
// The other HTML block types (a `<div>` and the like, which end at a blank line)
// are not tracked, so a fence written straight under such a tag with no blank
// line between is read where CommonMark would show it as HTML. The turn-end
// detector (#6456) is the backstop for a decision that went unpinned. The
// porter's include scanner (server/src/porter/claudeMdIncludes.ts) uses the same
// fence open and close rules and the same anchored `FENCE` pattern, but tracks
// neither HTML blocks nor list items.

/** The fence language that carries a pin. */
export const PIN_FENCE_LANGUAGE = "hapi_pin";

/**
 * A fence line's start: up to 3 spaces, then 3+ backticks or tildes. Nothing
 * follows the run in the pattern, so a failed match cannot backtrack through it.
 * A `(.*)$` tail did in the porter scanner: a long run followed by a mid-line
 * `\r` took seconds, and this scanner runs on the server's event loop.
 */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * A fence opening on a list item's marker line: up to 3 spaces, a bullet
 * (`-`, `+`, `*`) or an ordered marker (`1.`, `1)`, up to 9 digits), 1 to 4
 * spaces, then the fence run. Every part is bounded and nothing follows the run,
 * so a failed match cannot backtrack.
 */
const LIST_ITEM_FENCE = /^ {0,3}(?:[-+*]|\d{1,9}[.)]) {1,4}(`{3,}|~{3,})/;

/**
 * The start of an HTML block of CommonMark type 1 (`<pre`, `<script`, `<style`,
 * `<textarea`, then whitespace, `>` or the line end) or type 2 (`<!--`).
 */
const HTML_BLOCK_START =
  /^ {0,3}<(?:(!--)|(pre|script|style|textarea)(?=[\s>]|$))/i;

/**
 * A fence's language as the web reads it: the first word of the info string,
 * then its leading `\w+`. assistant-ui takes the language from the code block's
 * `language-…` class with `/language-(\w+)/`, so `hapi-pin` reads as `hapi` and
 * `hapi_pin.v2` as `hapi_pin`. Matching that keeps the server and the web
 * agreeing on which blocks are pins.
 */
export function fenceLanguageOf(info: string): string {
  const firstWord = info.trim().split(/\s/, 1)[0] ?? "";
  return /^\w+/.exec(firstWord)?.[0] ?? "";
}

/**
 * {@link fenceLanguageOf} `=== language` without its allocations: the trimmed
 * info string starts with `language` (`hapi_pin` unless the caller asks for
 * another) and the next character, if any, is not a word character. The scanner runs this on every fence line it meets, so a
 * fence-dense text costs a prefix test per line rather than a split and a regex.
 */
function isPinInfo(info: string, language: string): boolean {
  const trimmed = info.trimStart();
  if (!trimmed.startsWith(language)) return false;
  const next = trimmed.charAt(language.length);
  return next === "" || !/\w/.test(next);
}

export type PinFenceBlock = {
  /** The lines between the fences, joined with `\n`, each without a trailing `\r`. */
  body: string;
  /** The opening fence line's character offset in the text. */
  start: number;
};

export type PinFenceScan = {
  /** Every closed `hapi_pin` block, in order. */
  blocks: PinFenceBlock[];
  /** A `hapi_pin` fence still open at the end of the text, or null. */
  unclosed: { start: number } | null;
  /** True when the scan stopped at `maxBlocks` with another block after them. */
  truncated: boolean;
};

/**
 * Find the closed `hapi_pin` blocks in one text, and a trailing unclosed one.
 * With `maxBlocks`, the scan stops at the first closed block past that many and
 * reports `truncated`, so a text full of blocks is not read to its end only for
 * the extra blocks to be thrown away.
 *
 * `language` (default `hapi_pin`) picks the blocks to return, under the same
 * nesting rules, so the `hapi_pin_answers` parser (#6450) reads its block the way
 * the server reads pins.
 */
export function scanPinFences(
  text: string,
  options: { maxBlocks?: number; language?: string } = {}
): PinFenceScan {
  const maxBlocks = options.maxBlocks ?? Number.POSITIVE_INFINITY;
  const language = options.language ?? PIN_FENCE_LANGUAGE;
  const blocks: PinFenceBlock[] = [];
  // The open fence, as plain values: one object per fence made a text dense with
  // fences allocate on every line, and this runs on the server's event loop.
  let openRun = "";
  let openIsPin = false;
  let openStart = 0;
  let bodyStart = 0;
  let lineStart = 0;
  // The end marker of the HTML block the scan is inside, or "" outside one.
  let htmlEnd = "";
  // The content indent of the list item whose marker line opened the open
  // fence, or 0 when the open fence (if any) is not a list item's.
  let openItemIndent = 0;

  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const nextStart = lineEnd + 1;
    if (htmlEnd !== "") {
      // Inside an HTML block every line is HTML, up to the line holding its end.
      const raw = text.slice(lineStart, lineEnd);
      if ((htmlEnd === "-->" ? raw : raw.toLowerCase()).includes(htmlEnd)) {
        htmlEnd = "";
      }
      lineStart = nextStart;
      continue;
    }
    if (openItemIndent > 0) {
      // Inside a fence a list item opened on its marker line. The indent is
      // counted in columns, a tab advancing to the next multiple of 4.
      let column = 0;
      let at = lineStart;
      while (column < openItemIndent && at < lineEnd) {
        const c = text.charCodeAt(at);
        if (c === 32) column += 1;
        else if (c === 9) column += 4 - (column % 4);
        else break;
        at++;
      }
      if (column >= openItemIndent) {
        // The item's content: only its closing fence matters. A tab that ran
        // past the content indent leaves its extra columns as indent.
        let inner = text.slice(at, lineEnd);
        if (inner.endsWith("\r")) inner = inner.slice(0, -1);
        if (column > openItemIndent) {
          inner = " ".repeat(column - openItemIndent) + inner;
        }
        const fence = FENCE.exec(inner);
        const run = fence?.[1] ?? "";
        if (
          fence &&
          run[0] === openRun[0] &&
          run.length >= openRun.length &&
          inner.slice(fence[0].length).trim() === ""
        ) {
          openRun = "";
          openItemIndent = 0;
        }
        lineStart = nextStart;
        continue;
      }
      if (text.slice(lineStart, lineEnd).trim() === "") {
        // A blank line stays inside the item.
        lineStart = nextStart;
        continue;
      }
      // A line indented less than the item's content ends the item, and the
      // fence with it; the line itself is read as the text after the item.
      openRun = "";
      openItemIndent = 0;
    }
    // Only a line starting with a space, a backtick, a tilde or `<`, or, with no
    // fence open, a list marker, can open or close anything this scanner tracks.
    const first = text.charCodeAt(lineStart);
    if (
      first !== 32 &&
      first !== 96 &&
      first !== 126 &&
      first !== 60 &&
      !(
        openRun === "" &&
        (first === 45 ||
          first === 43 ||
          first === 42 ||
          (first >= 48 && first <= 57))
      )
    ) {
      lineStart = nextStart;
      continue;
    }
    let line = text.slice(lineStart, lineEnd);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    // The HTML check only runs on a line whose first non-space character is `<`,
    // so a text dense with fence lines pays nothing for it.
    if (
      openRun === "" &&
      (first === 60 || (first === 32 && line.trimStart().charCodeAt(0) === 60))
    ) {
      const html = HTML_BLOCK_START.exec(line);
      if (html) {
        const end = html[1] ? "-->" : `</${(html[2] ?? "").toLowerCase()}>`;
        const after = line.slice(html[0].length);
        // A block whose end sits on its own first line is just that line.
        if (!(end === "-->" ? after : after.toLowerCase()).includes(end)) {
          htmlEnd = end;
        }
        lineStart = nextStart;
        continue;
      }
    }
    const fence = FENCE.exec(line);
    if (!fence) {
      const item = openRun === "" ? LIST_ITEM_FENCE.exec(line) : null;
      if (item) {
        const run = item[1] ?? "";
        // Tracked so its contents stay content; never read as a pin.
        if (!(run[0] === "`" && line.slice(item[0].length).includes("`"))) {
          openRun = run;
          openIsPin = false;
          openItemIndent = item[0].length - run.length;
          openStart = lineStart;
          bodyStart = nextStart;
        }
      }
      lineStart = nextStart;
      continue;
    }
    const run = fence[1] ?? "";
    const rest = line.slice(fence[0].length);

    if (openRun !== "") {
      const closes =
        run[0] === openRun[0] &&
        run.length >= openRun.length &&
        rest.trim() === "";
      if (closes) {
        if (openIsPin) {
          if (blocks.length >= maxBlocks) {
            return { blocks, unclosed: null, truncated: true };
          }
          let body = text.slice(bodyStart, Math.max(bodyStart, lineStart - 1));
          if (body.includes("\r")) body = body.replace(/\r(?=\n|$)/g, "");
          blocks.push({ body, start: openStart });
        }
        openRun = "";
      }
      lineStart = nextStart;
      continue;
    }

    // A backtick fence's info string has no backtick (CommonMark).
    if (!(run[0] === "`" && rest.includes("`"))) {
      openRun = run;
      openIsPin = isPinInfo(rest, language);
      openStart = lineStart;
      bodyStart = nextStart;
    }
    lineStart = nextStart;
  }

  return {
    blocks,
    unclosed: openRun !== "" && openIsPin ? { start: openStart } : null,
    truncated: false,
  };
}
