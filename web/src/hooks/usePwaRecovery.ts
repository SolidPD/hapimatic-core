// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from "react";
import { useOnlineStatus } from "./useOnlineStatus";
import { getStorageKey } from "@/lib/storage-keys";
import { reloadWhenVisible } from "@/lib/safe-reload";

/**
 * PWA self-recovery on network reconnect (issue #2854).
 *
 * The bounded, last-resort tier of the two-tier recovery design. Task 1 (in
 * `useSSE`) is the primary, state-preserving path — an immediate SSE reconnect
 * on `online`. This hook is the fallback for when that stream stays wedged: on
 * an offline→online transition it starts a grace timer, and if the SSE does NOT
 * re-establish (no `hapi:sseConnected` event) within the window, it reloads the
 * app so an authenticated session is restored with no manual reload (R3).
 *
 * Loop safety (R4):
 * - Arms ONLY on an offline→online transition — a continuously-online session
 *   (and the initial mount while online) never arms, so a healthy session is
 *   never spuriously reloaded (R2).
 * - A re-flap back to offline before the grace window elapses cancels the
 *   pending reload (the effect cleanup clears the timer).
 * - A `sessionStorage` cooldown sentinel (port-scoped, survives the reload it
 *   triggers) blocks a second recovery reload within COOLDOWN_MS — so rapid
 *   flapping across reload boundaries cannot storm.
 *
 * Reload primitive: `reloadWhenVisible("pwa-recovery")` — the #1793 R2 single
 * choke point (visibility-guarded + durable `page-reload` telemetry). Never a
 * raw window-level reload: that bypasses the choke point, loses the
 * telemetry this field-diagnosis feature depends on, and re-opens the iOS
 * blank-shell class. A hidden tab's reload deferring to the next `visible`
 * transition is desired here — a hidden tab needs no urgent recovery.
 */

/** Grace window (ms) after offline→online for the SSE to re-establish itself. */
export const GRACE_MS = 10_000;
/** Minimum gap (ms) between recovery reloads — the loop-guard cooldown. */
export const COOLDOWN_MS = 60_000;
/** sessionStorage base key for the last-recovery-reload timestamp. */
export const RECOVERY_SENTINEL = "hapi_last_recovery_reload";

/**
 * Whether a recovery reload is currently permitted by the cooldown sentinel.
 * Fails open (allows) when storage is unavailable — the grace window still
 * rate-limits, and a permanently-blocked recovery would defeat the feature.
 */
function recoveryAllowed(now: number): boolean {
  try {
    const raw = sessionStorage.getItem(getStorageKey(RECOVERY_SENTINEL));
    if (!raw) return true;
    const last = Number(raw);
    if (!Number.isFinite(last)) return true;
    return now - last >= COOLDOWN_MS;
  } catch {
    return true;
  }
}

/** Record a recovery reload for the cooldown guard (best-effort). */
function markRecovery(now: number): void {
  try {
    sessionStorage.setItem(getStorageKey(RECOVERY_SENTINEL), String(now));
  } catch {
    // Storage unavailable — the guard degrades to grace-window rate-limiting.
  }
}

export function usePwaRecovery(): void {
  const online = useOnlineStatus();
  const prevOnlineRef = useRef(online);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const wasOnline = prevOnlineRef.current;
    prevOnlineRef.current = online;

    // Arm ONLY on an offline→online transition. The initial mount (wasOnline ===
    // online) and any online→offline change never arm — R2.
    if (!(online && !wasOnline)) {
      return undefined;
    }

    // If the SSE re-establishes within the grace window (Task 1 recovered the
    // stream), cancel the pending reload — no full reload is needed.
    const onSseConnected = () => {
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
    };
    window.addEventListener("hapi:sseConnected", onSseConnected);

    graceTimerRef.current = setTimeout(() => {
      graceTimerRef.current = null;
      window.removeEventListener("hapi:sseConnected", onSseConnected);
      // Grace elapsed with no reconnect — the stream is still wedged. Fall back
      // to a bounded, cooldown-guarded full reload (R3/R4).
      const now = Date.now();
      if (recoveryAllowed(now)) {
        markRecovery(now);
        reloadWhenVisible("pwa-recovery");
      }
    }, GRACE_MS);

    return () => {
      window.removeEventListener("hapi:sseConnected", onSseConnected);
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
    };
  }, [online]);
}
