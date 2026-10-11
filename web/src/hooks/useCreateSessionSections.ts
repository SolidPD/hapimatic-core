// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "@/api/client";

/** The four top-level Create-Session accordion sections. */
export type CreateSectionId = "machine" | "model" | "github" | "session";

/** Default: ALL expanded. The user's deliberate collapses override this and are
 *  persisted server-side. */
const ALL_EXPANDED: Record<CreateSectionId, boolean> = {
  machine: true,
  model: true,
  github: true,
  session: true,
};

/**
 * Server-persisted expand/collapse state for the Create-Session accordion's
 * four top-level sections.
 *
 * Behavior:
 * - Starts ALL-EXPANDED so the form is fully visible on first paint (no flash
 *   of collapsed sections while the server preference loads).
 * - Hydrates ONCE from `GET /api/preferences/create-session`. If the user
 *   toggles a section before the fetch resolves, the fetched value is dropped
 *   so a deliberate interaction is never clobbered.
 * - Every toggle writes back to the server (fire-and-forget). A failed write
 *   degrades silently — the in-memory state already reflects the user's intent;
 *   the worst case is a non-persisted toggle, never a broken UI.
 *
 * The server call is wrapped in `Promise.resolve().then(...)` so a missing or
 * non-promise method (e.g. an incomplete test mock) becomes a rejected promise
 * caught here, rather than a synchronous throw that escapes the effect.
 */
export function useCreateSessionSections(api: ApiClient | null): {
  sections: Record<CreateSectionId, boolean>;
  toggleSection: (id: CreateSectionId) => void;
  toggleAll: () => void;
} {
  const [sections, setSections] =
    useState<Record<CreateSectionId, boolean>>(ALL_EXPANDED);
  const hydratedRef = useRef(false);
  const interactedRef = useRef(false);

  useEffect(() => {
    if (!api || hydratedRef.current) return;
    hydratedRef.current = true;
    let cancelled = false;
    void Promise.resolve()
      .then(() => api.getCreateSessionPreferences())
      .then(prefs => {
        if (cancelled || interactedRef.current || !prefs?.sections) return;
        setSections(prefs.sections);
      })
      .catch(() => {
        /* keep the all-expanded default — see #... R: silent degradation */
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const persist = useCallback(
    (next: Record<CreateSectionId, boolean>) => {
      if (!api) return;
      void Promise.resolve()
        .then(() => api.setCreateSessionPreferences({ sections: next }))
        .catch(() => {
          /* best-effort; in-memory state already reflects the user's intent */
        });
    },
    [api]
  );

  const toggleSection = useCallback(
    (id: CreateSectionId) => {
      setSections(prev => {
        interactedRef.current = true;
        const next = { ...prev, [id]: !prev[id] };
        persist(next);
        return next;
      });
    },
    [persist]
  );

  // Expand-all / collapse-all with majority-rule when mixed (mirrors the page
  // header chevron's three states): all open → collapse all; all closed →
  // expand all; mixed → bring the minority into line with the majority, ties
  // biasing toward expanding.
  const toggleAll = useCallback(() => {
    setSections(prev => {
      interactedRef.current = true;
      const vals = Object.values(prev);
      const total = vals.length;
      const open = vals.filter(Boolean).length;
      const target =
        open === total ? false : open === 0 ? true : open >= total - open;
      const next: Record<CreateSectionId, boolean> = {
        machine: target,
        model: target,
        github: target,
        session: target,
      };
      persist(next);
      return next;
    });
  }, [persist]);

  return { sections, toggleSection, toggleAll };
}
