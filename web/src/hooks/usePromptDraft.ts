// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "@/api/client";

const STORAGE_KEY = "hapi:promptDrafts";
const DRAFT_SYNC_EVENT = "hapi:draftSync";
const DEBOUNCE_MS = 500;
const STALE_DAYS = 7;

/**
 * Draft data stored per session
 */
interface PromptDraft {
  text: string;
  updatedAt: number;
}

/**
 * All session drafts stored in localStorage
 */
type PromptDraftsStore = Record<string, PromptDraft>;

/**
 * Get all drafts from localStorage, pruning stale entries (older than STALE_DAYS)
 */
function getStoredDrafts(): PromptDraftsStore {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return {};
    const parsed: PromptDraftsStore = JSON.parse(stored);
    // Prune stale drafts older than STALE_DAYS
    const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
    let pruned = false;
    const result: PromptDraftsStore = {};
    for (const [id, draft] of Object.entries(parsed)) {
      if (draft.updatedAt >= cutoff) {
        result[id] = draft;
      } else {
        pruned = true;
      }
    }
    if (pruned) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(result));
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Save all drafts to localStorage and notify all hook instances in same tab
 */
function setStoredDrafts(drafts: PromptDraftsStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
    window.dispatchEvent(new CustomEvent(DRAFT_SYNC_EVENT, { detail: drafts }));
  } catch {
    // Ignore storage errors (quota exceeded, etc.)
  }
}

/**
 * Hook to persist unsent prompt drafts across navigation, with cross-device sync
 * via server-side persistence (issue #1261).
 *
 * Architecture: server is source of truth; localStorage is a transient cache for
 * offline resilience and instant load. A `hydrated` flag gates autosave until the
 * server's value has been consumed — this prevents Device B (which opens with no
 * local cache) from blanking Device A's typed draft.
 *
 * @param sessionId   The session ID to track drafts for
 * @param api         ApiClient for server PUT (pass null to disable server sync — local-only mode)
 * @param serverDraft The server-side draft text for this session (from `session.promptDraft`).
 *                    `undefined` = "not loaded yet" (autosave gated);
 *                    `null` or `string` (including empty) = "loaded" (autosave enabled).
 * @returns { draft, saveDraft, clearDraft, hydrated }
 */
export function usePromptDraft(
  sessionId: string,
  api: ApiClient | null = null,
  serverDraft: string | null | undefined = undefined
) {
  const [drafts, setDraftsState] = useState<PromptDraftsStore>(getStoredDrafts);
  const [hydrated, setHydrated] = useState<boolean>(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track which sessionId we've already hydrated so a re-render of the same session
  // (with an unchanged serverDraft) does not re-hydrate.
  const hydratedSessionRef = useRef<string | null>(null);
  // #2766: latest value handed to a currently-pending debounced save (null once no
  // save is pending). Read by the unmount flush so navigating away inside the 500 ms
  // debounce window (iOS swipe-back with no blur) doesn't drop BOTH the localStorage
  // and server writes.
  const pendingDraftRef = useRef<string | null>(null);
  // #2766: current sessionId/api/hydrated snapshot for the []-deps unmount flush.
  // A ref (not effect deps) so the flush stays registered once yet always sees live
  // values — deps would re-run cleanup on every hydrated flip.
  const latestRef = useRef({ sessionId, api, hydrated });
  latestRef.current = { sessionId, api, hydrated };

  // Subscribe to cross-tab storage events and same-tab sync events
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY || e.key === null) {
        setDraftsState(getStoredDrafts());
      }
    };
    const handleSync = (e: Event) => {
      const customEvent = e as CustomEvent<PromptDraftsStore>;
      setDraftsState(customEvent.detail);
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener(DRAFT_SYNC_EVENT, handleSync);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(DRAFT_SYNC_EVENT, handleSync);
    };
  }, []);

  // Flush any pending debounced draft on unmount / session change (#2766).
  // The debounce writes BOTH localStorage and the server PUT; cancelling it with no
  // flush drops both when navigation happens inside the 500 ms window (symmetric to
  // the SessionNotes flush). Replays the debounce body's dual-write once, directly —
  // no setDraftsState (setState on an unmounting component warns). Gated on `hydrated`
  // so a pre-hydration flush can't reintroduce the #1261 Device-B-blanks-Device-A race
  // (in practice `debounceRef.current` is already null pre-hydration, since saveDraft
  // early-returns before scheduling — this is defense in depth).
  useEffect(() => {
    return () => {
      if (!debounceRef.current) return;
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
      const text = pendingDraftRef.current;
      const {
        sessionId: sid,
        api: client,
        hydrated: isHydrated,
      } = latestRef.current;
      if (!isHydrated || text === null || !sid) return;
      const next = { ...getStoredDrafts() };
      if (text.trim()) {
        next[sid] = { text, updatedAt: Date.now() };
      } else {
        delete next[sid];
      }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage errors (quota, etc.) — the server PUT below still runs.
      }
      if (client) {
        client
          .updateSessionPromptDraft(sid, text.trim() ? text : null)
          .catch(() => {
            // Best-effort flush during teardown; nothing to recover to.
          });
      }
    };
  }, []);

  // Reset hydration state when sessionId changes (Device B opens a new session).
  // Local-only mode (api === null) skips the hydration wait — no server to load from.
  useEffect(() => {
    if (hydratedSessionRef.current !== sessionId) {
      if (api === null) {
        // No server sync: hydration is instant. Local cache IS the source of truth.
        hydratedSessionRef.current = sessionId;
        setHydrated(true);
      } else {
        setHydrated(false);
        hydratedSessionRef.current = null;
      }
    }
  }, [sessionId, api]);

  // Hydrate from serverDraft when it arrives (string, possibly empty = valid signal).
  // `undefined` = "not loaded yet" → keep hydrated=false (autosave gated).
  useEffect(() => {
    if (!sessionId) return;
    if (hydratedSessionRef.current === sessionId) return;
    if (api === null) return; // Already handled by the sessionId-change effect above
    if (serverDraft === undefined) return;
    // Server value is the authoritative initial state. Write into local cache
    // so the `draft` accessor below sees it on this render.
    setDraftsState(prev => {
      const next = { ...prev };
      if (serverDraft && serverDraft.trim()) {
        next[sessionId] = { text: serverDraft, updatedAt: Date.now() };
      } else {
        delete next[sessionId];
      }
      // Note: do NOT call setStoredDrafts here — initial hydration should not
      // dispatch the cross-tab sync event (avoids feedback loops with other tabs).
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
    hydratedSessionRef.current = sessionId;
    setHydrated(true);
  }, [sessionId, serverDraft]);

  // Get draft text for this session (empty string if none)
  const draft = drafts[sessionId]?.text ?? "";

  /**
   * Save draft text (debounced to avoid excessive localStorage + server writes).
   * Empty text removes the draft entry.
   *
   * No-op while `hydrated === false` — protects against the Device-B-blanks-Device-A
   * race where the local empty state would otherwise overwrite the server's draft.
   */
  const saveDraft = useCallback(
    (text: string) => {
      if (!hydrated) return;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      // #2766: record the value now scheduled, so an unmount inside the debounce
      // window can flush it.
      pendingDraftRef.current = text;
      debounceRef.current = setTimeout(() => {
        setDraftsState(prev => {
          const next = { ...prev };
          if (text.trim()) {
            next[sessionId] = { text, updatedAt: Date.now() };
          } else {
            delete next[sessionId];
          }
          setStoredDrafts(next);
          return next;
        });
        // Server write — fire-and-forget. The local cache is the user-visible
        // source of truth between debounce cycles; the server PUT only matters
        // for cross-device / refresh-survival paths.
        if (api && sessionId) {
          const payload = text.trim() ? text : null;
          api.updateSessionPromptDraft(sessionId, payload).catch(() => {
            // Swallow — offline / 404 / server error doesn't degrade the local
            // typing experience. localStorage still has the value.
          });
        }
        // #2766: the scheduled save has landed — clear the pending markers so a
        // later unmount does not re-flush an already-persisted value.
        debounceRef.current = null;
        pendingDraftRef.current = null;
      }, DEBOUNCE_MS);
    },
    [sessionId, api, hydrated]
  );

  /**
   * Immediately clear draft for this session (call on successful send).
   * Fires an IMMEDIATE (non-debounced) server PUT with null so other devices
   * observe the cleared state within the normal SSE window.
   */
  const clearDraft = useCallback(() => {
    // Cancel any pending debounced save
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setDraftsState(prev => {
      if (!prev[sessionId]) return prev;
      const next = { ...prev };
      delete next[sessionId];
      setStoredDrafts(next);
      return next;
    });
    // Server clear — immediate, non-debounced. Sending a message is an explicit
    // action; the cross-device propagation shouldn't wait on a stale typing timer.
    if (api && sessionId && hydrated) {
      api.updateSessionPromptDraft(sessionId, null).catch(() => {
        // Swallow — clear-on-send should never block message delivery.
      });
    }
  }, [sessionId, api, hydrated]);

  return { draft, saveDraft, clearDraft, hydrated };
}

/**
 * Prune drafts for sessions that no longer exist.
 * Call from session list when sessions are loaded/refreshed.
 */
export function prunePromptDrafts(validSessionIds: Set<string>): void {
  const drafts = getStoredDrafts();
  let changed = false;
  const next: PromptDraftsStore = {};
  for (const [id, draft] of Object.entries(drafts)) {
    if (validSessionIds.has(id)) {
      next[id] = draft;
    } else {
      changed = true;
    }
  }
  if (changed) {
    setStoredDrafts(next);
  }
}
