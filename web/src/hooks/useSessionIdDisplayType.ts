// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";

/**
 * ID display type preference: CLI ID (the harness's native session id) vs
 * Hapimatic ID. Persisted to localStorage so the preference is shared across
 * components and survives page refreshes.
 *
 * Issue #4479: the token was renamed "claude" → "cli" (Hapimatic is
 * harness-agnostic). No compatibility shim — a stored legacy "claude" reads as
 * the default "hapi" (a one-time reset accepted by the operator, 2026-10-01).
 */
export type SessionIdDisplayType = "cli" | "hapi";

const SESSION_ID_DISPLAY_KEY = "hapi:sessionIdDisplayType";

export function useSessionIdDisplayType(): [SessionIdDisplayType, () => void] {
  const [displayType, setDisplayTypeState] = useState<SessionIdDisplayType>(
    () => {
      try {
        const stored = localStorage.getItem(SESSION_ID_DISPLAY_KEY);
        // Default to 'hapi' since Hapimatic short ID is always available
        // (the CLI's native session ID may not exist until a message is sent)
        return stored === "cli" ? "cli" : "hapi";
      } catch {
        return "hapi";
      }
    }
  );

  const toggleDisplayType = () => {
    const newType = displayType === "cli" ? "hapi" : "cli";
    setDisplayTypeState(newType);
    try {
      localStorage.setItem(SESSION_ID_DISPLAY_KEY, newType);
    } catch {
      // Ignore localStorage errors
    }
  };

  return [displayType, toggleDisplayType];
}
