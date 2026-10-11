// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useRef, useState, type RefObject } from "react";

/**
 * Kiosk IME-suppression state machine for a composer textarea (issue #2848).
 *
 * Shared by the two composer surfaces (`HappyComposer`, `FullscreenPromptEditorModal`)
 * so the subtle summon/re-arm logic lives in ONE place — a single home for the
 * `summoningRef` guard and the future V5 hardware fix (the directive's
 * `inputMode="text"` + `readOnly`-toggle fallback would otherwise have to change
 * both surfaces in lockstep).
 *
 * - `imeSummoned` gates `inputMode` (`"none"` when armed, `undefined` when summoned).
 * - `summonKeyboard()` lifts suppression then blur→refocuses — Chrome does NOT
 *   reliably re-show the OSK when `inputMode` changes on an already-focused element.
 *   The `summoningRef` guard stops this programmatic blur from tripping `handleImeBlur`
 *   and instantly re-suppressing the just-summoned keyboard.
 * - `handleImeBlur()` re-arms suppression on a GENUINE blur (skipped during the summon).
 * - `rearmSuppression()` explicitly re-arms (e.g. after a send).
 */
export function useKioskImeSuppression(
  textareaRef: RefObject<HTMLTextAreaElement | null>
): {
  imeSummoned: boolean;
  summonKeyboard: () => void;
  handleImeBlur: () => void;
  rearmSuppression: () => void;
} {
  const [imeSummoned, setImeSummoned] = useState(false);
  // Guards the programmatic blur→focus inside summonKeyboard so it doesn't trip
  // the handleImeBlur re-arm — that would instantly re-suppress the summoned OSK.
  const summoningRef = useRef(false);

  const summonKeyboard = useCallback(() => {
    setImeSummoned(true);
    summoningRef.current = true;
    // Toggling inputMode on an already-focused element does NOT reliably re-show
    // the OSK in Chrome — a blur then focus is required (the #2848 directive Open
    // Risk; final confirmation is the on-r1 hardware check V5).
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      ta?.blur();
      ta?.focus();
      summoningRef.current = false;
    });
  }, [textareaRef]);

  const handleImeBlur = useCallback(() => {
    if (!summoningRef.current) setImeSummoned(false);
  }, []);

  const rearmSuppression = useCallback(() => setImeSummoned(false), []);

  return { imeSummoned, summonKeyboard, handleImeBlur, rearmSuppression };
}
