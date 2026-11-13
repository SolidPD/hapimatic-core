// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pin IDs (#6574): one server-owned name for every pin, so any session can refer to
 * a pin it does not own. The agent's `key` stays the pin's address inside its own
 * session; the ID is a second identity, the way a session has both a uuid and a
 * `hapi-…` tag.
 *
 * Shape (ruling D1): `pin-` and ten characters from a 31-symbol alphabet with no
 * look-alikes (no 0, 1, i, l or o), drawn from the platform CSPRNG: 31^10 ≈ 8.2 × 10^14
 * (49.5 bits), so with 1 000 000 pins the chance of any duplicate is about 6 × 10^-4.
 * The server checks every new ID against everything it ever issued
 * (`server/src/store/pinIds.ts`), so a node never issues one twice.
 */
import { z } from "zod";

export const PIN_ID_PREFIX = "pin-";
/** 31 symbols: the digits 2-9 and the lower-case letters without i, l and o. */
export const PIN_ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
export const PIN_ID_LENGTH = 10;
export const PIN_ID_PATTERN = /^pin-[2-9a-hjkmnp-z]{10}$/;

/**
 * The longest text the normalizer looks at. A pin ID is 14 characters; the
 * wrappers a paste carries (backticks, quotes, brackets, a trailing dot) add a few
 * more, and `pin_get`'s `id` is capped at the same length, so anything longer is
 * not an ID and is refused without scanning it.
 */
export const PIN_ID_INPUT_MAX_CHARS = 80;

/** Bytes 248-255 are rejected so `byte % 31` is unbiased (248 = 8 × 31). */
const PIN_ID_BYTE_LIMIT = 248;
/**
 * The most bytes one ID may draw. A real CSPRNG rejects 8 bytes in 256, so ten
 * accepted characters arrive long before this; the bound only stops an injected
 * source that returns nothing usable from spinning forever.
 */
const PIN_ID_MAX_DRAWN_BYTES = 256;

export const PinIdSchema = z
  .string()
  .regex(
    PIN_ID_PATTERN,
    "must be a pin ID: pin- and ten characters from 23456789abcdefghjkmnpqrstuvwxyz"
  );

/** Characters a paste may carry around an ID: backticks, quotes, brackets, punctuation. */
const STRIPPABLE = new Set([
  "`",
  '"',
  "'",
  "“",
  "”",
  "‘",
  "’",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "<",
  ">",
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
]);

/**
 * The pin ID a pasted text names, or null. Trims, then strips one leading and one
 * trailing wrapper character per pass (trimming again after each) until a pass
 * strips nothing, lower-cases, and returns the result only when it matches the
 * strict pattern. Every pass that continues shortens the text, so the loop ends
 * within the input's length.
 */
export function normalizePinId(input: string): string | null {
  if (typeof input !== "string") return null;
  let text = input.trim();
  if (text.length === 0 || text.length > PIN_ID_INPUT_MAX_CHARS) return null;
  for (;;) {
    let stripped = false;
    if (text.length > 0 && STRIPPABLE.has(text[0]!)) {
      text = text.slice(1);
      stripped = true;
    }
    if (text.length > 0 && STRIPPABLE.has(text[text.length - 1]!)) {
      text = text.slice(0, -1);
      stripped = true;
    }
    if (!stripped) break;
    text = text.trim();
  }
  const id = text.toLowerCase();
  return PIN_ID_PATTERN.test(id) ? id : null;
}

/** True when a text would be read as a pin ID; the key refusal uses it (#6574 R10). */
export function isPinIdShaped(text: string): boolean {
  return normalizePinId(text) !== null;
}

function cryptoBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * A new pin ID. `randomBytes` defaults to the platform CSPRNG; tests inject a source
 * to force a collision. Throws when the source yields no ten usable characters in
 * {@link PIN_ID_MAX_DRAWN_BYTES} bytes.
 */
export function generatePinId(
  randomBytes: (n: number) => Uint8Array = cryptoBytes
): string {
  let out = "";
  let drawn = 0;
  while (out.length < PIN_ID_LENGTH) {
    if (drawn >= PIN_ID_MAX_DRAWN_BYTES) {
      throw new Error(
        `generatePinId: no ${PIN_ID_LENGTH} usable characters in ${PIN_ID_MAX_DRAWN_BYTES} random bytes`
      );
    }
    const want = Math.min(
      PIN_ID_LENGTH - out.length,
      PIN_ID_MAX_DRAWN_BYTES - drawn
    );
    const bytes = randomBytes(want);
    drawn += want;
    for (let i = 0; i < want && out.length < PIN_ID_LENGTH; i++) {
      const b = bytes[i] ?? PIN_ID_BYTE_LIMIT;
      if (b < PIN_ID_BYTE_LIMIT) out += PIN_ID_ALPHABET[b % 31];
    }
  }
  return PIN_ID_PREFIX + out;
}
