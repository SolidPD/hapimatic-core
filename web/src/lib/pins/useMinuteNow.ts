// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";

/**
 * One shared minute clock (#6450, moved here by #6452): every inline card's age
 * label and every automatic-pick countdown reads it, so a chat full of pins
 * runs one timer, and only the components that read it re-render each minute.
 */
let minuteNow = Date.now();
const minuteListeners = new Set<() => void>();
let minuteTimer: ReturnType<typeof setInterval> | null = null;

export function useMinuteNow(): number {
  // A first card after a quiet spell reads the clock now: the shared value
  // stops moving while no card is mounted.
  const [now, setNow] = useState(() => {
    if (!minuteTimer) minuteNow = Date.now();
    return minuteNow;
  });
  useEffect(() => {
    const listener = () => setNow(minuteNow);
    minuteListeners.add(listener);
    if (!minuteTimer) {
      minuteNow = Date.now();
      minuteTimer = setInterval(() => {
        minuteNow = Date.now();
        for (const l of minuteListeners) l();
      }, 60_000);
    }
    return () => {
      minuteListeners.delete(listener);
      if (minuteListeners.size === 0 && minuteTimer) {
        clearInterval(minuteTimer);
        minuteTimer = null;
      }
    };
  }, []);
  return now;
}
