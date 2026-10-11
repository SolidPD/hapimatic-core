// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "@/api/client";
import { useAdminPreferences } from "@/hooks/useAdminPreferences";
import {
  ChatSectionsPreferenceSchema,
  type ChatSectionsPreference,
} from "@hapi/protocol/schemas";

/**
 * Server-authoritative per-category "chat sections" preference (#2988, epic
 * #2987 Sub-Issue S1). Structural successor to the retired chat-verbosity hook — same
 * server-authoritative pattern (#2486 / #2623): the server persists the truth,
 * localStorage is only the no-flash pre-fetch cache (never the displayed truth).
 *
 * - On mount the hook READS the server matrix and adopts it, then reconciles it
 *   THROUGH to the localStorage cache (so later offline reads stay consistent).
 * - No-flash first paint: display initializes from the synchronous localStorage
 *   value, then converges to the server value once the fetch resolves.
 * - `userToggledRef` race guard: once the user changes the matrix, an in-flight
 *   mount READ must not clobber it with the stale pre-toggle server value
 *   (the authority-flip race, #2486).
 * - Writes are best-effort fire-and-forget; a failed WRITE degrades silently
 *   (these preferences are cosmetic — chat rendering). A failed READ falls back
 *   to the localStorage cache.
 * - `api === null` (above-context): no fetch; the value falls back to the cache.
 *
 * #3018 — live propagation to already-open sessions (cross-tab / cross-device):
 * - Cross-tab (R1): a `hapi:chat-sections-storage-changed` window event (dispatched
 *   by useAdminPreferences when another tab writes the cache) carries the new value;
 *   this hook `adopt()`s it immediately — updating the HYDRATED `serverPrefs` (which
 *   otherwise masks the cache), never a PUT.
 * - Cross-device (R2): a payload-free `hapi:chat-sections-changed` window event
 *   (dispatched by useSSE on the server SSE notification) triggers an authoritative
 *   GET; the response is `adopt()`ed (never the event, never a PUT).
 * - Ordering (R2b): a monotonic `requestGenRef` orders concurrent / out-of-order
 *   completions. Every value-establishing action (each read issue, `setPrefs`,
 *   `adopt`) bumps the generation and captures its own; a read applies only if its
 *   captured generation is still the newest — so a stale mount read or an earlier
 *   SSE refresh can never overwrite a newer external-storage adoption or later
 *   refresh.
 */
export function useChatSectionPrefs(api: ApiClient | null): {
  prefs: ChatSectionsPreference;
  setPrefs: (value: ChatSectionsPreference) => void;
  adopt: (value: ChatSectionsPreference) => void;
} {
  const { prefs: adminPrefs, setChatSections } = useAdminPreferences();

  // Server-authoritative value once fetched. `null` = not yet known (pre-fetch,
  // fetch failure, or `api === null`) → display falls back to the cache.
  const [serverPrefs, setServerPrefs] = useState<ChatSectionsPreference | null>(
    null
  );

  // Once the user has toggled, a still in-flight mount read MUST NOT clobber it
  // with the stale pre-toggle server value (the authority-flip race, #2486).
  const userToggledRef = useRef(false);

  // #3018 (R2b): monotonic request generation. Bumped by every value-establishing
  // action (each read issue, setPrefs, adopt). A read applies its result only if
  // its captured generation is still the newest (=== requestGenRef.current) — this
  // orders concurrent / out-of-order GET completions so a stale read cannot
  // overwrite a newer value. `userToggledRef` alone (a boolean) cannot order
  // multiple reads; this can.
  const requestGenRef = useRef(0);

  // Server READ on mount. Best-effort: a failed fetch degrades silently to the
  // localStorage cache.
  useEffect(() => {
    if (!api) return;
    // #3018: claim a generation for this mount read; a newer action supersedes it.
    const myGen = ++requestGenRef.current;
    let cancelled = false;
    void api
      .getChatSectionPrefs()
      .then(value => {
        if (cancelled || userToggledRef.current) return;
        // #3018: a later read / setPrefs / adopt bumped the generation — this mount
        // read is stale, so drop it.
        if (myGen !== requestGenRef.current) return;
        setServerPrefs(value);
      })
      .catch(() => {
        /* best-effort; keep the localStorage cache */
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Reconcile the localStorage cache to the server value once known (#2486).
  // The matrix is an OBJECT, so compare by VALUE (JSON) — a reference !== would
  // fire a redundant cache write (and re-render) for a structurally-equal value.
  useEffect(() => {
    if (serverPrefs === null) return;
    if (
      JSON.stringify(serverPrefs) !== JSON.stringify(adminPrefs.chatSections)
    ) {
      setChatSections(serverPrefs);
    }
  }, [serverPrefs, adminPrefs.chatSections, setChatSections]);

  // Display: the server value once known, else the localStorage cache
  // (no-flash first paint).
  const prefs = serverPrefs ?? adminPrefs.chatSections;

  const setPrefs = useCallback(
    (value: ChatSectionsPreference) => {
      userToggledRef.current = true;
      // #3018: a newer local value invalidates any in-flight read (incl. an SSE
      // refresh, which does not consult userToggledRef).
      ++requestGenRef.current;
      setChatSections(value); // localStorage cache
      setServerPrefs(value); // optimistic
      if (api) {
        void api.setChatSectionPrefs(value).catch(() => {
          /* fire-and-forget; cosmetic pref, silent-degrade on write failure */
        });
      }
    },
    [api, setChatSections]
  );

  // #2624 (B): adopt a server-side value WITHOUT writing back — used by the 🌐
  // inherit toggle, whose PUT response carries the re-adopted effective value; and
  // by the #3018 cross-tab / SSE convergence paths below. A plain setPrefs would
  // re-PUT it as a fresh GLOBAL write (new timestamp + peer fan-out), turning
  // "re-adopt the federation-global" into "re-publish my value over it" — wrong
  // under LWW when a peer's global is newer.
  const adopt = useCallback(
    (value: ChatSectionsPreference) => {
      userToggledRef.current = true; // an in-flight mount read must not clobber
      // #3018: adoption establishes a newer visible value → bump the generation so
      // an older in-flight read (mount or SSE refresh) drops its stale result.
      ++requestGenRef.current;
      setChatSections(value); // localStorage cache
      setServerPrefs(value);
    },
    [setChatSections]
  );

  // #3018 (R1): cross-tab adoption. useAdminPreferences dispatches this ONLY when
  // another tab changed the chat-sections matrix by value, with detail
  // { origin: "storage", value }. adopt() converges the hydrated serverPrefs (not
  // merely the masked admin cache) and sets the race guard so an in-flight mount GET
  // cannot overwrite the external-tab value. No PUT. Registered after adopt's
  // declaration so [adopt] is never evaluated before the callback exists (Task 6.1).
  useEffect(() => {
    const onStorageChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || detail.origin !== "storage") return;
      // Validate the value shape before adopting (defense-in-depth; also normalizes
      // via the schema transform, e.g. previewLines clamp).
      const parsed = ChatSectionsPreferenceSchema.safeParse(detail.value);
      if (!parsed.success) return;
      adopt(parsed.data);
    };
    window.addEventListener(
      "hapi:chat-sections-storage-changed",
      onStorageChange
    );
    return () => {
      window.removeEventListener(
        "hapi:chat-sections-storage-changed",
        onStorageChange
      );
    };
  }, [adopt]);

  // #3018 (R2): SSE authoritative-refetch. The payload-free notification triggers a
  // GET of the current effective server value; adopt() converges it without a PUT.
  // NEVER trust event detail (there is none) and never setPrefs(). The generation
  // guard drops a superseded completion (out-of-order refreshes, or a newer local
  // write / storage adoption issued after this GET). A failed GET leaves the current
  // visible/cache value unchanged.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const onSseInvalidate = () => {
      const myGen = ++requestGenRef.current;
      void api
        .getChatSectionPrefs()
        .then(value => {
          if (cancelled) return;
          if (myGen !== requestGenRef.current) return; // superseded
          adopt(value);
        })
        .catch(() => {
          /* best-effort; keep the current value, no PUT */
        });
    };
    window.addEventListener("hapi:chat-sections-changed", onSseInvalidate);
    return () => {
      cancelled = true;
      window.removeEventListener("hapi:chat-sections-changed", onSseInvalidate);
    };
  }, [api, adopt]);

  return { prefs, setPrefs, adopt };
}
