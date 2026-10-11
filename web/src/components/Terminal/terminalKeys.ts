// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure key model for the Terminal tab's mobile key bar (#4516, Task 1).
 *
 * No React, no DOM. The navigation, function and editing keys emit the bytes
 * `@xterm/xterm@6.0.0` emits for the same physical key (including its modified
 * forms), so those bar keys match the hardware key. Two deliberate differences:
 * the fixed-sequence keys in STICKY_EXEMPT_IDS ignore the sticky modifiers, and
 * the sticky Ctrl applied to a typed character uses standard caret notation
 * rather than xterm's keyCode table. The reference is
 * `@xterm/xterm@6.0.0/src/common/input/Keyboard.ts` (cited line ranges inline).
 *
 * Layout (operator ruling R2-1): the characters already on the iOS keyboard
 * (| / ~ - _ \) are gone; Page 1 instead carries Home/End/backtick/Shift+Tab,
 * and the freed Page 2 row holds line-editing shortcuts (^U ^K ^W ⌥. ^Y) with
 * Ins/Del filling Page 3.
 *
 * Modifier math (Keyboard.ts:52, with no Shift modifier on this bar):
 *   m = 1 + (alt ? 2 : 0) + (ctrl ? 4 : 0)
 */

// #4548 (T8): the dock state has ONE default — this per-node first-paint
// fallback is the SAME shared constant the federation layer serves when no
// global value exists, so a device with no stored value and a fresh federation
// view agree. Plain value import only (keeps this module React-/DOM-free).
import { TERMINAL_KEYBOARD_EXPANDED_DEFAULT } from "@hapi/protocol/schemas";

/** Every key id that can appear on the bar. */
export type KeyId =
  // Page 1 (binding — approved layout A, relaid per R2-1)
  | "paste"
  | "copy"
  | "esc"
  | "tab"
  | "home"
  | "up"
  | "end"
  | "ctrl"
  | "alt"
  | "backtick"
  | "shift-tab"
  | "left"
  | "down"
  | "right"
  // Page 2
  | "pgup"
  | "ctrl-c"
  | "ctrl-z"
  | "ctrl-l"
  | "ctrl-r"
  | "ctrl-a"
  | "ctrl-e"
  | "pgdn"
  | "ctrl-d"
  | "ctrl-u"
  | "ctrl-k"
  | "ctrl-w"
  | "alt-dot"
  | "ctrl-y"
  // Page 3 (last)
  | "f1"
  | "f2"
  | "f3"
  | "f4"
  | "f5"
  | "f6"
  | "ins"
  | "f7"
  | "f8"
  | "f9"
  | "f10"
  | "f11"
  | "f12"
  | "del";

/** The two sticky modifiers. */
export type ModifierId = "ctrl" | "alt";

/** Active sticky-modifier flags passed into `keySequence`. */
export interface Modifiers {
  ctrl: boolean;
  alt: boolean;
}

export type KeyKind = "action" | "modifier" | "seq" | "char" | "repeat";

export interface KeyMeta {
  label: string;
  ariaLabel: string;
  kind: KeyKind;
}

/**
 * Pages → rows → keys (R2-1). `null` is a layout spacer. Contents per page are
 * binding (R12).
 */
export const KEY_PAGES: ReadonlyArray<
  ReadonlyArray<ReadonlyArray<KeyId | null>>
> = [
  // Page 1 — Paste/Copy + a Home/↑/End · ←/↓/→ nav block (R2-1)
  [
    ["paste", "copy", "esc", "tab", "home", "up", "end"],
    ["ctrl", "alt", "backtick", "shift-tab", "left", "down", "right"],
  ],
  // Page 2 — PgUp/PgDn (col 1) + ^C/^D (col 2) + line-editing shortcuts (R2-1)
  [
    ["pgup", "ctrl-c", "ctrl-z", "ctrl-l", "ctrl-r", "ctrl-a", "ctrl-e"],
    ["pgdn", "ctrl-d", "ctrl-u", "ctrl-k", "ctrl-w", "alt-dot", "ctrl-y"],
  ],
  // Page 3 — function keys (R12) + Ins/Del
  [
    ["f1", "f2", "f3", "f4", "f5", "f6", "ins"],
    ["f7", "f8", "f9", "f10", "f11", "f12", "del"],
  ],
];

/**
 * Keys whose byte sequence is FIXED and which deliberately IGNORE the sticky
 * Ctrl/Alt state (the ^X / line-editing shortcuts, ⌥., Ins, Del). The page must
 * NOT `consume()` the modifiers when one of these is tapped.
 */
export const STICKY_EXEMPT_IDS: ReadonlySet<KeyId> = new Set<KeyId>([
  "ctrl-c",
  "ctrl-d",
  "ctrl-z",
  "ctrl-l",
  "ctrl-r",
  "ctrl-a",
  "ctrl-e",
  "ctrl-u",
  "ctrl-k",
  "ctrl-w",
  "ctrl-y",
  "alt-dot",
  "ins",
  "del",
]);

/** The printable characters routed through `applyModifiers` (just backtick now). */
const CHAR_OF: Partial<Record<KeyId, string>> = {
  backtick: "`",
};

export const KEY_META: Record<KeyId, KeyMeta> = {
  paste: { label: "Paste", ariaLabel: "Paste", kind: "action" },
  copy: { label: "Copy", ariaLabel: "Copy", kind: "action" },
  esc: { label: "Esc", ariaLabel: "Escape", kind: "seq" },
  tab: { label: "Tab", ariaLabel: "Tab", kind: "seq" },
  home: { label: "Home", ariaLabel: "Home", kind: "seq" },
  up: { label: "↑", ariaLabel: "Arrow up", kind: "repeat" },
  end: { label: "End", ariaLabel: "End", kind: "seq" },
  ctrl: { label: "Ctrl", ariaLabel: "Control modifier", kind: "modifier" },
  alt: { label: "Alt", ariaLabel: "Alt modifier", kind: "modifier" },
  backtick: { label: "`", ariaLabel: "Backtick", kind: "char" },
  "shift-tab": { label: "⇧Tab", ariaLabel: "Shift Tab", kind: "seq" },
  left: { label: "←", ariaLabel: "Arrow left", kind: "repeat" },
  down: { label: "↓", ariaLabel: "Arrow down", kind: "repeat" },
  right: { label: "→", ariaLabel: "Arrow right", kind: "repeat" },
  pgup: { label: "PgUp", ariaLabel: "Page up", kind: "seq" },
  "ctrl-c": { label: "^C", ariaLabel: "Control C", kind: "seq" },
  "ctrl-z": { label: "^Z", ariaLabel: "Control Z", kind: "seq" },
  "ctrl-l": { label: "^L", ariaLabel: "Control L", kind: "seq" },
  "ctrl-r": { label: "^R", ariaLabel: "Control R", kind: "seq" },
  "ctrl-a": { label: "^A", ariaLabel: "Control A", kind: "seq" },
  "ctrl-e": { label: "^E", ariaLabel: "Control E", kind: "seq" },
  pgdn: { label: "PgDn", ariaLabel: "Page down", kind: "seq" },
  "ctrl-d": { label: "^D", ariaLabel: "Control D", kind: "seq" },
  "ctrl-u": {
    label: "^U",
    ariaLabel: "Control U — kill line before cursor",
    kind: "seq",
  },
  "ctrl-k": {
    label: "^K",
    ariaLabel: "Control K — kill line after cursor",
    kind: "seq",
  },
  "ctrl-w": {
    label: "^W",
    ariaLabel: "Control W — delete previous word",
    kind: "seq",
  },
  "alt-dot": {
    label: "⌥.",
    ariaLabel: "Alt period — insert last argument",
    kind: "seq",
  },
  "ctrl-y": { label: "^Y", ariaLabel: "Control Y — yank", kind: "seq" },
  f1: { label: "F1", ariaLabel: "F1", kind: "seq" },
  f2: { label: "F2", ariaLabel: "F2", kind: "seq" },
  f3: { label: "F3", ariaLabel: "F3", kind: "seq" },
  f4: { label: "F4", ariaLabel: "F4", kind: "seq" },
  f5: { label: "F5", ariaLabel: "F5", kind: "seq" },
  f6: { label: "F6", ariaLabel: "F6", kind: "seq" },
  ins: { label: "Ins", ariaLabel: "Insert", kind: "seq" },
  f7: { label: "F7", ariaLabel: "F7", kind: "seq" },
  f8: { label: "F8", ariaLabel: "F8", kind: "seq" },
  f9: { label: "F9", ariaLabel: "F9", kind: "seq" },
  f10: { label: "F10", ariaLabel: "F10", kind: "seq" },
  f11: { label: "F11", ariaLabel: "F11", kind: "seq" },
  f12: { label: "F12", ariaLabel: "F12", kind: "seq" },
  del: { label: "Del", ariaLabel: "Delete forward", kind: "seq" },
};

const ESC = "\x1b";

/** The modifier parameter xterm appends: `1 + 2·alt + 4·ctrl` (Keyboard.ts:52). */
function modParam(mods: Modifiers): number {
  return 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
}

/**
 * Standard caret-notation control byte for a character under Ctrl. Letters
 * collapse to 0x01–0x1a; @ [ \ ] ^ _ ? and space map per the C0 table. This is
 * caret notation, not a copy of xterm's keyCode table (Keyboard.ts:307-324 and
 * 361-367), which differs at the edges (e.g. it maps Ctrl+3..8 and not ^ / ?).
 * Returns null for any other character.
 */
function ctrlByte(ch: string): string | null {
  if (ch.length !== 1) return null;
  const c = ch.charCodeAt(0);
  if (c >= 97 && c <= 122) return String.fromCharCode(c - 96); // a–z → 0x01–0x1a
  if (c >= 65 && c <= 90) return String.fromCharCode(c - 64); // A–Z → 0x01–0x1a
  switch (ch) {
    case " ":
    case "@":
      return "\x00";
    case "[":
      return "\x1b";
    case "\\":
      return "\x1c";
    case "]":
      return "\x1d";
    case "^":
      return "\x1e";
    case "_":
      return "\x1f";
    case "?":
      return "\x7f";
    default:
      return null;
  }
}

/**
 * Apply sticky Ctrl/Alt to a single typed character: Ctrl maps it through
 * `ctrlByte` (caret notation) and leaves unmapped characters untouched; Alt
 * prefixes ESC to the result, as xterm does for Alt (Keyboard.ts:325-352).
 */
export function applyModifiers(ch: string, mods: Modifiers): string {
  let out = ch;
  if (mods.ctrl) {
    const b = ctrlByte(ch);
    if (b !== null) out = b;
  }
  if (mods.alt) out = ESC + out;
  return out;
}

/**
 * The byte sequence for a bar key, mirroring `@xterm/xterm@6.0.0`
 * `src/common/input/Keyboard.ts`. `appCursor` is the terminal's
 * application-cursor-keys mode (DECCKM), which switches unmodified
 * arrows/Home/End between the `ESC O x` and `ESC [ x` forms.
 *
 * `action` (paste/copy) and `modifier` (ctrl/alt) keys are not emitted through
 * here — they are handled by the page — and return "".
 */
export function keySequence(
  id: KeyId,
  mods: Modifiers,
  appCursor: boolean
): string {
  const m = modParam(mods);

  // Arrows (Keyboard.ts:113-164): letters up=A down=B right=C left=D.
  const arrowLetter: Partial<Record<KeyId, string>> = {
    up: "A",
    down: "B",
    right: "C",
    left: "D",
  };
  if (id in arrowLetter) {
    const letter = arrowLetter[id]!;
    if (m > 1) return `${ESC}[1;${m}${letter}`;
    return appCursor ? `${ESC}O${letter}` : `${ESC}[${letter}`;
  }

  switch (id) {
    // Home / End (Keyboard.ts:181-200)
    case "home":
    case "end": {
      const letter = id === "home" ? "H" : "F";
      if (m > 1) return `${ESC}[1;${m}${letter}`;
      return appCursor ? `${ESC}O${letter}` : `${ESC}[${letter}`;
    }

    // PgUp / PgDn (Keyboard.ts:201-220): modified form only with Ctrl.
    case "pgup":
    case "pgdn": {
      const code = id === "pgup" ? 5 : 6;
      return mods.ctrl ? `${ESC}[${code};${m}~` : `${ESC}[${code}~`;
    }

    // F1–F4 (Keyboard.ts:221-249): ESC O P|Q|R|S, modified → ESC[1;mP…
    case "f1":
    case "f2":
    case "f3":
    case "f4": {
      const letter = { f1: "P", f2: "Q", f3: "R", f4: "S" }[id]!;
      return m > 1 ? `${ESC}[1;${m}${letter}` : `${ESC}O${letter}`;
    }

    // F5–F12 (Keyboard.ts:250-305): ESC[<n>~, modified → ESC[<n>;m~
    case "f5":
    case "f6":
    case "f7":
    case "f8":
    case "f9":
    case "f10":
    case "f11":
    case "f12": {
      const code = {
        f5: 15,
        f6: 17,
        f7: 18,
        f8: 19,
        f9: 20,
        f10: 21,
        f11: 23,
        f12: 24,
      }[id]!;
      return m > 1 ? `${ESC}[${code};${m}~` : `${ESC}[${code}~`;
    }

    // Insert / Delete (Keyboard.ts:165-180): CSI 2~ / CSI 3~. Fixed by design —
    // they are in STICKY_EXEMPT_IDS, so the sticky modifiers are ignored here
    // (xterm itself sends CSI 3;m~ for a modified Delete).
    case "ins":
      return `${ESC}[2~`;
    case "del":
      return `${ESC}[3~`;

    // Esc (Keyboard.ts:105-112): ESC, ESC ESC with Alt.
    case "esc":
      return mods.alt ? `${ESC}${ESC}` : ESC;

    // Tab (Keyboard.ts:91-99): \t, modifiers ignored.
    case "tab":
      return "\t";

    // Shift+Tab
    case "shift-tab":
      return `${ESC}[Z`;

    // Alt+. — insert last argument (readline M-.); fixed ESC + ".".
    case "alt-dot":
      return `${ESC}.`;

    // Fixed control-byte shortcuts (ignore modifiers).
    case "ctrl-c":
      return "\x03";
    case "ctrl-d":
      return "\x04";
    case "ctrl-z":
      return "\x1a";
    case "ctrl-l":
      return "\x0c";
    case "ctrl-r":
      return "\x12";
    case "ctrl-a":
      return "\x01";
    case "ctrl-e":
      return "\x05";
    case "ctrl-u":
      return "\x15";
    case "ctrl-k":
      return "\x0b";
    case "ctrl-w":
      return "\x17";
    case "ctrl-y":
      return "\x19";

    default: {
      // Printable characters routed through applyModifiers; everything else
      // (paste/copy/ctrl/alt) is handled by the page and yields "".
      const ch = CHAR_OF[id];
      return ch === undefined ? "" : applyModifiers(ch, mods);
    }
  }
}

/** The sticky-modifier reducer state. */
export type ModifierState = "off" | "armed" | "locked";

/** The events that drive a single modifier's state machine (R3). */
export type ModifierEvent = "tap" | "double-tap" | "consume";

/**
 * Pure transition for one sticky modifier (R3):
 *  - tap:        off → armed; armed → off; locked → off
 *  - double-tap: any → locked
 *  - consume:    armed → off (one-shot spent); locked stays locked
 */
export function nextModifierState(
  state: ModifierState,
  event: ModifierEvent
): ModifierState {
  switch (event) {
    case "tap":
      return state === "off" ? "armed" : "off";
    case "double-tap":
      return "locked";
    case "consume":
      return state === "armed" ? "off" : state;
  }
}

/**
 * Per-node persistence of the aux-keyboard dock expand/collapse state (R2-3 /
 * SA6). The key + its read/write live here (a terminal-owned module) rather than
 * inline in the route so the follow-up #4548 can reuse "#4516's key and default
 * exactly" (contract K-4548-1 / T3). The page still owns the React `expanded`
 * state and setter — only the storage primitive is shared. The default is the
 * shared TERMINAL_KEYBOARD_EXPANDED_DEFAULT (#4548 T8 — one default) so a
 * first-time user sees the keyboard; both accessors are try/catch-guarded so a
 * disabled/full store degrades to the default and never throws into render.
 */
export const KEYBOARD_EXPANDED_KEY = "hapi.terminal.keyboardExpanded";

export function readKeyboardExpanded(): boolean {
  try {
    const v = localStorage.getItem(KEYBOARD_EXPANDED_KEY);
    return v === null
      ? TERMINAL_KEYBOARD_EXPANDED_DEFAULT.expanded
      : v === "true";
  } catch {
    return TERMINAL_KEYBOARD_EXPANDED_DEFAULT.expanded;
  }
}

export function writeKeyboardExpanded(value: boolean): void {
  try {
    localStorage.setItem(KEYBOARD_EXPANDED_KEY, String(value));
  } catch {
    // private mode / full store — the toggle still works for this session.
  }
}
