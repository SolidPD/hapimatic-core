// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether decoded file text is really binary, so the viewer shows it as a
 * download and never opens it in the editor.
 *
 * #6224: a NUL anywhere in the file marks it binary. That check covers the
 * WHOLE string, because a binary payload can sit past the first 8 KB behind
 * text that passes the ratio check (a self-extracting script: shell text, then
 * a gzip payload). `indexOf` is a native scan, cheap even at the 5 MB read
 * limit.
 *
 * The control-character ratio is measured on the first 8 KB only, with a plain
 * loop: the old version split the whole file into an array of characters,
 * which is slow on a phone.
 *
 * Passing this check means the file can be SHOWN as text. Whether it can be
 * EDITED is `isUtf8Text` below: text in another encoding (a Latin-1 CSV) or
 * with a short binary tail and no NUL passes here, but fails there.
 */
export const BINARY_SCAN_CHARS = 8192;

export function isBinaryContent(content: string): boolean {
  if (!content) return false;
  if (content.indexOf("\0") !== -1) return true;
  const length = Math.min(content.length, BINARY_SCAN_CHARS);
  let nonPrintable = 0;
  for (let i = 0; i < length; i += 1) {
    const code = content.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      nonPrintable += 1;
    }
  }
  return nonPrintable / length > 0.1;
}

/**
 * Whether the file's bytes are valid UTF-8, which is what the editor needs to
 * hold them without loss.
 *
 * #6224 review: the viewer decodes leniently, turning each invalid sequence
 * into U+FFFD, and the editor saves U+FFFD as the bytes EF BF BD. Editing one
 * line of a Latin-1 CSV would then rewrite every "ü" in the file. A file that
 * fails this check is still shown, read-only.
 */
export function isUtf8Text(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
