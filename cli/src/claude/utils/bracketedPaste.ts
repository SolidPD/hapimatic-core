// SPDX-License-Identifier: MIT
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Wrap a message in DEC mode 2004 bracketed-paste markers (ESC[200~ … ESC[201~).
 *
 * Issue #1459: this returns the paste BODY ONLY — it deliberately does NOT append
 * a trailing CR. The submit Enter must be delivered as a SEPARATE, delayed write
 * by the launcher (see `createPtySubmitDelivery` in claudePtyLauncher.ts). A `\r`
 * riding in the same stdin chunk as the paste markers is absorbed by claude's Ink
 * paste handler (a guard against a different submit race), so the message is
 * inserted into the input box but never submitted — the round-trip bug this fixes.
 */
export function wrapBracketedPaste(message: string): string {
  return PASTE_START + message + PASTE_END;
}
