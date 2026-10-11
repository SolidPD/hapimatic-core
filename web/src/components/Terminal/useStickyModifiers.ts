// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sticky-modifier state hook for the Terminal key bar (#4516, Task 2).
 *
 * Holds each modifier's state ("off" | "armed" | "locked") in `useState` for
 * rendering AND mirrors it into a ref, so the xterm `onData` closure (set up
 * once on mount) can read the CURRENT modifier state and `consume()` it without
 * re-subscribing on every change. The ref is the authority the reducer reads
 * from; the state is its render mirror.
 */
import { useCallback, useRef, useState } from "react";
import {
  nextModifierState,
  type ModifierEvent,
  type ModifierId,
  type ModifierState,
  type Modifiers,
} from "./terminalKeys";

export interface StickyModifiers {
  /** Ctrl modifier state (for rendering armed vs locked). */
  ctrl: ModifierState;
  /** Alt modifier state (for rendering armed vs locked). */
  alt: ModifierState;
  /** Single tap: off → armed, armed → off, locked → off. */
  tap(mod: ModifierId): void;
  /** Double tap: any → locked. */
  doubleTap(mod: ModifierId): void;
  /**
   * Return the active modifiers ({ ctrl, alt } as booleans) and spend them:
   * an armed modifier drops to off, a locked modifier stays locked.
   */
  consume(): Modifiers;
  /**
   * Turn both modifiers off, armed or locked. Called when the key bar is hidden,
   * so a modifier the user can no longer see never rewrites typed keys.
   */
  reset(): void;
  /** The live mirror the onData closure reads without re-subscribing. */
  snapshotRef: React.MutableRefObject<{
    ctrl: ModifierState;
    alt: ModifierState;
  }>;
}

export function useStickyModifiers(): StickyModifiers {
  const [ctrl, setCtrl] = useState<ModifierState>("off");
  const [alt, setAlt] = useState<ModifierState>("off");
  const snapshotRef = useRef<{ ctrl: ModifierState; alt: ModifierState }>({
    ctrl: "off",
    alt: "off",
  });

  // Transition one modifier, reading the base state from the ref (never a stale
  // closure) and writing through to both the ref and the render state.
  const dispatch = useCallback((mod: ModifierId, event: ModifierEvent) => {
    const base = snapshotRef.current[mod];
    const next = nextModifierState(base, event);
    snapshotRef.current = { ...snapshotRef.current, [mod]: next };
    if (mod === "ctrl") setCtrl(next);
    else setAlt(next);
  }, []);

  const tap = useCallback(
    (mod: ModifierId) => dispatch(mod, "tap"),
    [dispatch]
  );
  const doubleTap = useCallback(
    (mod: ModifierId) => dispatch(mod, "double-tap"),
    [dispatch]
  );

  const consume = useCallback((): Modifiers => {
    const cur = snapshotRef.current;
    const active: Modifiers = {
      ctrl: cur.ctrl !== "off",
      alt: cur.alt !== "off",
    };
    const nextCtrl = nextModifierState(cur.ctrl, "consume");
    const nextAlt = nextModifierState(cur.alt, "consume");
    snapshotRef.current = { ctrl: nextCtrl, alt: nextAlt };
    setCtrl(nextCtrl);
    setAlt(nextAlt);
    return active;
  }, []);

  const reset = useCallback(() => {
    snapshotRef.current = { ctrl: "off", alt: "off" };
    setCtrl("off");
    setAlt("off");
  }, []);

  return { ctrl, alt, tap, doubleTap, consume, reset, snapshotRef };
}
