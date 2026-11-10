// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { SessionView } from "@hapi/protocol/schemas";
import type { ApiClient } from "@/api/client";
import { useUpdateSessionView } from "@/hooks/mutations/useUpdateSessionView";
import {
  markOpenRedirectConsumed,
  sessionViewToPath,
  writeCachedSessionView,
} from "@/lib/session-view";
import { getStorageKey } from "@/lib/storage-keys";
import { THREAD_FULLSCREEN_STORAGE_BASE } from "@/lib/thread-fullscreen-context";

/**
 * Switch a session to one of its views the way a View Picker tab tap does
 * (#3286). Shared by the View Picker and the Pins "Go to chat" and "Go to
 * terminal" buttons (#6455), so a switch from either place behaves the same.
 * #6453: Chat can open at a spot, `at` (`pin:<key>` or a bookmark id), which the
 * chat route's `?at=` jump scrolls to.
 */
export function useSelectSessionView(
  api: ApiClient | null,
  sessionId: string
): (view: SessionView, at?: string | null) => void {
  const navigate = useNavigate();
  const { updateView } = useUpdateSessionView(api, sessionId);
  return useCallback(
    (view: SessionView, at?: string | null) => {
      // Synchronous no-flash cache write + disarm this open's auto-redirect (an
      // explicit choice), then navigate and persist. Persist is fire-and-forget —
      // the optimistic hook updates every cache and rolls back on failure; the
      // localStorage value self-corrects on the next server reconcile.
      writeCachedSessionView(sessionId, view);
      markOpenRedirectConsumed(sessionId);
      // #3638 (D2=(a)): switching to a non-chat view (Terminal/Desktop/Files)
      // exits full-screen DURABLY — clear the per-device flag so returning to
      // Chat is not a surprise re-maximize. Session→session switches keep it
      // (mockup panel F).
      if (view !== "chat") {
        try {
          localStorage.setItem(
            getStorageKey(THREAD_FULLSCREEN_STORAGE_BASE),
            "0"
          );
        } catch {
          // localStorage unavailable/full — non-fatal; the visible exit still
          // happens via SessionChat's route unmount.
        }
      }
      const to = sessionViewToPath(view, sessionId);
      navigate(view === "chat" && at ? { to, search: { at } } : { to });
      void updateView(view).catch(() => {});
    },
    [navigate, updateView, sessionId]
  );
}
