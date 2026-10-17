// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Clipboard helpers — the single copy write path for every copy button in the
 * app (`useCopyToClipboard` → `safeCopyToClipboard`), plus the composer's
 * paste-side defence against iOS URL-encoded pastes.
 *
 * Why this is more than `navigator.clipboard.writeText(text)` (#5313):
 * on iOS WebKit, writing a scheme-shaped string (`Note: x`, `mem-refine: 1`,
 * `Error: …`) via the Async Clipboard API (`writeText` OR `ClipboardItem`) OR via
 * a copy-event `setData("text/plain", …)` attaches a `public.url` / `text/uri-list`
 * representation to the pasteboard item. The default paste action then prefers
 * that URL and inserts its percent-encoded form (`note:%20x%0A`). This was
 * measured directly on iOS 26.6.1 via the #5313 diagnostic:
 *
 *   writeText            → text/uri-list present → pastes ENCODED
 *   ClipboardItem(plain) → text/uri-list present → pastes ENCODED
 *   execCommand + setData→ text/uri-list present → pastes ENCODED
 *   execCommand (no JS)  → no text/uri-list      → pastes CLEAN   ← the fix
 *   native selection copy→ no text/uri-list      → pastes CLEAN
 *
 * So on iOS we copy ONLY through a hidden-textarea + `execCommand("copy")` with
 * NO copy-event interception — the browser serialises the selection as plain text
 * and never adds the URL. On other platforms the Async Clipboard API is clean and
 * preferred, so `writeText` stays the primary path there.
 *
 * The paste side (`plainTextForUrlSniffedPaste`) is the complement: when a paste
 * event's clipboard already carries a `text/uri-list` next to its text — from an
 * old build, another app, or Messages — the composer takes the clean `text/plain`
 * itself. In every ENCODED case above the event's `text/plain` was still clean.
 */

/** iPhone / iPod / iPad (incl. iPadOS 13+ which reports as Macintosh + touch). */
export function isIosWebKit(
  nav: Pick<Navigator, "userAgent" | "maxTouchPoints"> = navigator
): boolean {
  const ua = nav.userAgent ?? "";
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
}

/**
 * Copy `text` through a hidden textarea + `execCommand("copy")`, with NO copy-event
 * listener and NO `setData`. This is the ONLY path that does not attach a
 * `text/uri-list` representation on iOS WebKit (#5313), because the browser writes
 * its own plain-text serialisation of the selection. Synchronous, so it keeps the
 * user gesture that Safari requires for a clipboard write. Returns execCommand's
 * success flag.
 */
function legacyExecCopy(text: string): boolean {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  // Keep it off-screen and inert — never intercept the copy event.
  textArea.style.top = "0";
  textArea.style.left = "0";
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  textArea.setAttribute("readonly", "");
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textArea);
  }
}

export async function safeCopyToClipboard(text: string): Promise<void> {
  // iOS WebKit: go straight to the legacy path, synchronously, so no public.url
  // representation is attached and the user gesture is preserved (#5313).
  if (isIosWebKit()) {
    if (legacyExecCopy(text)) return;
    // Legacy unexpectedly failed — fall through to the async APIs as a last resort.
    console.warn("[Clipboard] iOS legacy copy failed, trying async clipboard");
  }

  // Other platforms: the Async Clipboard API is clean here and is the modern,
  // gesture-safe path. (Clean on desktop Chromium/Firefox/Safari — the uri-list
  // attachment is iOS-only.)
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (err) {
      console.warn("[Clipboard] writeText failed, trying fallback:", err);
      // Fall through to the legacy fallback.
    }
  }

  // Final fallback for older browsers or restricted contexts.
  if (legacyExecCopy(text)) return;
  throw new Error("execCommand copy failed");
}

/**
 * Paste-side defence (#5313). On iOS, WebKit's default paste reads the pasteboard
 * with `PlainTextURLReadingPolicy::AllowURL` (`Pasteboard::read(PasteboardPlainText&)`),
 * so when an item carries a `public.url` representation next to its text the field
 * receives `[NSURL absoluteString]` — `Note: x` lands as `note:%20x`. The paste
 * EVENT's `getData("text/plain")` goes through `Pasteboard::readPlatformValuesAsStrings`,
 * which reads the plain-text representation directly and was clean in every measured
 * ENCODED case. So when the clipboard advertises a URL alongside plain text, take the
 * plain text ourselves and cancel the default insertion. This handles text copied
 * from ANYWHERE (another app, Messages, an old build), not just our own copy buttons.
 *
 * Returns the text to insert, or null when the default paste should run (no
 * clipboardData, files present, no URL representation to dodge, or no plain text).
 */
export function plainTextForUrlSniffedPaste(
  cd: Pick<DataTransfer, "types" | "getData" | "files"> | null | undefined
): string | null {
  if (!cd) return null;
  if (cd.files && cd.files.length > 0) return null;
  const types = Array.from(cd.types ?? []);
  if (!types.includes("text/uri-list")) return null;
  const text = cd.getData("text/plain");
  if (!text) return null;
  return text;
}

/**
 * Insert `text` at the element's current selection the way a native paste would:
 * `execCommand("insertText")` keeps undo history and fires the `input` event React
 * listens to; the manual splice is the fallback for engines that refuse it.
 */
export function insertTextAtSelection(
  el: HTMLTextAreaElement | HTMLInputElement,
  text: string
): void {
  el.focus();
  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, text);
  } catch {
    inserted = false;
  }
  if (inserted) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const next = el.value.slice(0, start) + text + el.value.slice(end);
  // Go through the prototype setter so React's value tracker sees the change.
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, next);
  else el.value = next;
  const caret = start + text.length;
  el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
