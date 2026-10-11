// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #4517: type-only stand-in for `@xterm/xterm` inside the cli program.
 *
 * `@xterm/addon-serialize`'s typings import their types from the BROWSER
 * package `@xterm/xterm`, whose typings start with `/// <reference lib="dom"/>`.
 * Resolving them puts the DOM lib into the cli program, which also typechecks
 * `../server/src`, and DOM's `RequestInit` / `BlobPart` then clash with
 * bun-types in server files. `cli/tsconfig.json` maps `@xterm/xterm` here, so
 * the addon's types resolve to `@xterm/headless` (the terminal TerminalMirror
 * actually loads the addon into) and no DOM lib is pulled in.
 *
 * Types only: nothing in the cli bundle imports `@xterm/xterm` at runtime, and
 * the addon's own JavaScript does not import it either.
 */
export type {
  Terminal,
  ITerminalAddon,
  IMarker,
  IBufferRange,
} from "@xterm/headless";
