// SPDX-License-Identifier: AGPL-3.0-only
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * Which keystroke sends a composer message.
 *
 * - `shift-to-send` (the #1524 default): a bare Enter inserts a newline,
 *   Shift+Enter sends.
 * - `enter-to-send` (the legacy behavior, kept for a future toggle): a bare
 *   Enter sends, Shift+Enter inserts a newline.
 *
 * Ctrl/Cmd+Enter always force-sends regardless of behavior.
 */
export type ComposerSubmitBehavior = "enter-to-send" | "shift-to-send";

/**
 * Hardcoded default shipped by #1524. A future /settings/preferences toggle
 * (dependent sub-issue of epic #1034 / #1040) will let users override this
 * per-user; until then every composer surface reads this single constant via
 * {@link getComposerEnterIntent} so the flip stays consistent.
 */
export const DEFAULT_COMPOSER_SUBMIT_BEHAVIOR: ComposerSubmitBehavior =
  "shift-to-send";

/**
 * Human labels for the /settings/preferences composer-submit control (#1525). Each
 * label names the keystroke that SENDS, matching the issue's "Send message with:
 * Enter / Shift+Enter" framing.
 */
export const COMPOSER_SUBMIT_LABELS: Record<ComposerSubmitBehavior, string> = {
  "shift-to-send": "Shift+Enter",
  "enter-to-send": "Enter",
};

/** Display order for the preferences control: the shipped default first. */
export const COMPOSER_SUBMIT_ORDER: ComposerSubmitBehavior[] = [
  "shift-to-send",
  "enter-to-send",
];

/** What a given Enter keystroke means for the composer. */
export type ComposerEnterIntent = "send" | "newline";

/**
 * The single decision point for "what does this Enter keystroke mean?".
 *
 * Returns `null` for non-Enter keys so callers can early-out. Ctrl/Cmd+Enter
 * ALWAYS resolves to `"send"` (force-send) regardless of the behavior, on every
 * composer surface (R3). For a bare Enter the result depends on the behavior:
 * under the default `shift-to-send`, a bare Enter is a `"newline"` and
 * Shift+Enter is a `"send"`.
 *
 * Pure and React-free (it only reads four event fields), so it is unit-testable
 * with a plain object literal — see `composerSubmitBehavior.test.ts`.
 */
export function getComposerEnterIntent(
  e: Pick<ReactKeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey">,
  behavior: ComposerSubmitBehavior = DEFAULT_COMPOSER_SUBMIT_BEHAVIOR
): ComposerEnterIntent | null {
  if (e.key !== "Enter") return null;
  if (e.ctrlKey || e.metaKey) return "send"; // force-send on all surfaces (R3)
  if (behavior === "shift-to-send") return e.shiftKey ? "send" : "newline";
  return e.shiftKey ? "newline" : "send"; // legacy enter-to-send path
}
