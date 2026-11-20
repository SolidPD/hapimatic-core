// SPDX-License-Identifier: AGPL-3.0-only

/**
 * #6662: a copy made from inside a Pins answers message puts the whole message
 * on the clipboard, marker included, whatever part was selected.
 *
 * The chat shows a Pins answers message compactly (`PinAnswersBody`): its
 * heading line and closed "Answers" and "Raw block" disclosures. A browser copy
 * of a selection there carries the heading and the visible entries but not the
 * `hapi_pin_answers` fence, and the fence is what tells the approval hooks the
 * text is machine text (Matt's NOTE1). Pasted into a prompt, such a selection
 * read as the operator's own typing. So a copy that touches a registered
 * message carries that message's "Copy message" text instead.
 *
 * Why a document-level listener that reads the selection, not an `onCopy` on
 * the message: Chromium fires `copy` on the element where the selection
 * STARTS, so a selection that starts in the agent message above never reaches
 * a handler on the Pins message (measured in #6662's research).
 *
 * Rules (R1-R4, R7):
 * - A selection wholly inside one message copies exactly its text.
 * - A selection that also covers other chat text keeps the browser's text for
 *   those parts and puts each touched message in place, whole, set off by
 *   blank lines, so its heading always starts a line (the layout the hooks'
 *   preface reader needs).
 * - A copy that touches no registered message is left alone. A message is
 *   touched only when the selection holds at least one non-blank character
 *   of it; meeting its edge is not enough.
 * - A copy from an input, a textarea or an editable element is never touched:
 *   the composer, and the hidden textarea every copy button focuses on iOS
 *   (`legacyExecCopy` in `./clipboard`), copy exactly what they copy today.
 * - Cut and drag are not handled (cut on read-only chat text changes nothing,
 *   and the composer cancels every drop).
 *
 * Only `text/plain` is set: the message is plain text, and the browser's
 * `text/html` flavour carries no fence. On iOS a `setData` can attach a URL
 * representation when the text parses as a URL (#5313, see `./clipboard`); no
 * Pins message does, and the composer's paste defence covers a mixed copy
 * that starts on scheme-shaped agent text.
 *
 * The hooks stay the line that refuses (rp1-home#3226, #3233). This is a
 * convenience and a second line of defence: a copy made in another browser, an
 * older client or from a screenshot never passes through it.
 */

/** Each rendered Pins answers message, with the text its "Copy message" copies. */
const copyTexts = new Map<Element, string>();

/** Where a copy is the user's own text and is never intercepted (R4). */
const EDITABLE =
  'input, textarea, [contenteditable]:not([contenteditable="false"])';

/**
 * Register a rendered Pins answers message and the text a copy from inside it
 * carries. Returns the cleanup, in the form a React 19 ref callback returns.
 * The one capture-phase listener is installed while anything is registered; a
 * map entry (not a count) keeps StrictMode's attach, cleanup, attach correct.
 */
export function registerPinAnswersCopyText(
  el: Element,
  text: string
): () => void {
  copyTexts.set(el, text);
  // Adding the same listener twice is a no-op, so this needs no guard.
  document.addEventListener("copy", onCopy, true);
  return () => {
    copyTexts.delete(el);
    if (copyTexts.size === 0) {
      document.removeEventListener("copy", onCopy, true);
    }
  };
}

/**
 * The text a copy of `selection` carries, or `null` when the selection touches
 * no registered message and the browser's own copy should run.
 */
export function composePinAnswersCopy(
  selection: Selection | null,
  texts: ReadonlyMap<Element, string>,
  doc: Document
): string | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  // Firefox can hold several ranges; the others hold one.
  const ranges: Range[] = [];
  for (let i = 0; i < selection.rangeCount; i++) {
    ranges.push(selection.getRangeAt(i));
  }
  const hits = [...texts.keys()]
    .filter(el => el.isConnected && ranges.some(r => selectsTextIn(r, el)))
    .sort(documentOrder);
  if (hits.length === 0) return null;

  const only = hits.length === 1 ? hits[0] : undefined;
  if (only && ranges.every(r => only.contains(r.commonAncestorContainer))) {
    return texts.get(only) ?? null;
  }

  const parts: string[] = [];
  const pushOutside = (range: Range): void => {
    const text = serializeRange(range, doc).trim();
    if (text) parts.push(text);
  };
  // Each message goes in once, even when several ranges (Firefox) select it.
  const placed = new Set<Element>();
  for (const range of ranges) {
    const current = range.cloneRange();
    for (const hit of hits) {
      if (!selectsTextIn(range, hit)) continue;
      const text = texts.get(hit);
      if (text === undefined) continue;
      // The text between the current start and this message, unless the
      // selection starts inside it.
      if (!hit.contains(current.startContainer)) {
        const before = doc.createRange();
        before.setStart(current.startContainer, current.startOffset);
        before.setEndBefore(hit);
        pushOutside(before);
      }
      if (!placed.has(hit)) parts.push(text);
      placed.add(hit);
      // Go on after the message when the range runs past it, else stop at the
      // range's end (it ends inside the message).
      const parent = hit.parentNode;
      if (parent && range.comparePoint(parent, childIndex(hit) + 1) === 0) {
        current.setStartAfter(hit);
      } else {
        current.setStart(range.endContainer, range.endOffset);
      }
    }
    pushOutside(current);
  }
  return parts.join("\n\n");
}

/**
 * The text a browser copy of `range` gives, from an offscreen copy of its
 * content. Never by moving the user's selection to the range and reading
 * `toString()`: inside a copy handler that returned the text of closed
 * `<details>` (#6662 research, premise P4). Elements styled
 * `user-select: none` (the chat's "Hidden context" and "Stop hook feedback"
 * chips) are dropped first, because a browser copy leaves them out and
 * `innerText` does not (#6662 closer review, F2). jsdom has no `innerText`, so
 * tests get the box's `textContent`.
 */
export function serializeRange(range: Range, doc: Document): string {
  if (range.collapsed) return "";
  const box = doc.createElement("div");
  box.setAttribute("aria-hidden", "true");
  box.style.cssText = "position:absolute;left:-99999px;top:0";
  box.appendChild(range.cloneContents());
  doc.body.appendChild(box);
  try {
    dropUnselectable(box, doc);
    const text: unknown = box.innerText;
    return typeof text === "string" ? text : (box.textContent ?? "");
  } finally {
    box.remove();
  }
}

/**
 * Remove the box's `user-select: none` elements, subtree and all. Every
 * element's style is read first, while the box is in the document (so class
 * rules apply to the copy), and the unselectable ones are removed after: a
 * removal between two reads would make the browser recompute styles for each
 * one, which slowed a select-all copy of a long chat several times over
 * (#6662 closer review, R2-1). Every style is read against the unaltered copy,
 * as the live page computes it: removing as found changed sibling positions
 * before later reads, which a structural selector setting `user-select` (`+`,
 * `:first-child`, `:has()`) would see. The app ships no such rule, so the text
 * is the same as before. Removing an element whose ancestor is already gone
 * changes nothing.
 * Limit: a selectable element nested inside an unselectable one goes too.
 */
function dropUnselectable(box: HTMLElement, doc: Document): void {
  const view = doc.defaultView;
  if (!view) return;
  const unselectable = Array.from(box.querySelectorAll("*")).filter(el => {
    const style = view.getComputedStyle(el);
    const value =
      style.getPropertyValue("user-select") ||
      style.getPropertyValue("-webkit-user-select");
    return value === "none";
  });
  for (const el of unselectable) el.remove();
}

function onCopy(event: ClipboardEvent): void {
  if (
    isEditable(event.target) ||
    isEditable(document.activeElement) ||
    !event.clipboardData
  ) {
    return;
  }
  try {
    const text = composePinAnswersCopy(
      document.getSelection(),
      copyTexts,
      document
    );
    if (text === null) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
  } catch {
    // Not cancelled, so the browser's own copy goes through; the hooks remain
    // the line that refuses fence-less Pins text.
  }
}

/**
 * Whether `range` selects at least one character of `el` that is not blank
 * and that a reader can see. A range that only meets a message's edge does
 * not take it: a triple-click on the paragraph above can end at offset 0 of
 * the message's first text, and a drag can stop just before its heading, with
 * nothing of it selected. Text inside a closed `<details>`, outside its
 * summary, does not count either: a drag that starts at the end of a
 * collapsed message's "Answers (N)" line covers that hidden text in the DOM
 * while nothing of the message is visibly selected (#6662 closer review, F1).
 *
 * `Range.intersectsNode`, not `Selection.containsNode(el, true)`: they agree
 * in a browser that follows the spec, but jsdom 26 answers the latter with
 * "starts before the node OR ends after it".
 */
function selectsTextIn(range: Range, el: Element): boolean {
  if (!range.intersectsNode(el)) return false;
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node) || hiddenInClosedDetails(node)) continue;
    const text = node.textContent ?? "";
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : text.length;
    if (text.slice(start, end).trim() !== "") return true;
  }
  return false;
}

/** Whether a closed `<details>` hides `node`: it is inside one, not in its summary. */
function hiddenInClosedDetails(node: Node): boolean {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (el.localName !== "details" || el.hasAttribute("open")) continue;
    const summary = Array.from(el.children).find(
      child => child.localName === "summary"
    );
    if (!summary?.contains(node)) return true;
  }
  return false;
}

function isEditable(target: EventTarget | null): boolean {
  if (!target || typeof (target as Node).nodeType !== "number") return false;
  const node = target as Node;
  const el =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  return el?.closest(EDITABLE) != null;
}

function documentOrder(a: Element, b: Element): number {
  if (a === b) return 0;
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
    ? -1
    : 1;
}

function childIndex(node: Node): number {
  return Array.prototype.indexOf.call(node.parentNode?.childNodes ?? [], node);
}
