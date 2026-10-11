// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "@/api/client";
import { TerminalKeyboardExpandedPreferenceSchema } from "@hapi/protocol/schemas";
import {
  readKeyboardExpanded,
  writeKeyboardExpanded,
} from "@/components/Terminal/terminalKeys";

/**
 * The Terminal aux-keyboard dock expand/collapse state, broadcast
 * federation-wide (#4548, epic #4515). It layers #4516's per-node local
 * persistence with the #2624 federation-global settings key
 * `terminalKeyboardExpanded`, so a toggle on node A's PWA reaches node B's open
 * Terminal — while a desktop (non-touch) session, where `enabled` is false,
 * keeps #4516's pure-local behavior and never touches the federation surface.
 *
 * Source-of-truth rule (R2/R3): the FEDERATION value wins when one exists
 * (provenance `global`/`local`); #4516's local value is only the first-paint
 * cache and the fallback when none exists or the read fails, and is NEVER
 * published on its own. The dock toggle is optimistic — `setExpanded` writes the
 * cache and fires the PUT without awaiting the server's ≤5s peer fan-out.
 *
 * Pattern: `useChatSectionPrefs` (cache, generation guard, adopt-without-PUT)
 * plus #4467's focus/visibility refetch. This hook deliberately does NOT use or
 * extend `useFederationSettings` (#4467 Task 3 owns that file's value setter).
 */
const KEY = "terminalKeyboardExpanded";

export function useTerminalDockExpanded(
  api: ApiClient | null,
  opts: { enabled: boolean }
): { expanded: boolean; setExpanded: (next: boolean) => void } {
  const { enabled } = opts;

  // First paint: #4516's synchronous per-node cache (its default is the shared
  // TERMINAL_KEYBOARD_EXPANDED_DEFAULT, T8). No flash, and it works before — or
  // without — any federation read.
  const [expanded, setExpandedState] = useState<boolean>(() =>
    readKeyboardExpanded()
  );

  // Monotonic generation: every value-establishing action (each GET, each
  // setExpanded) bumps it, and a GET applies only if it is still the newest. So
  // a stale GET (a mount read superseded by a focus refetch) or a GET that
  // resolves after a local toggle can never clobber the newer value.
  const genRef = useRef(0);
  // > 0 while a local PUT is in flight: a GET that resolves during it is dropped
  // (the server may not yet reflect our optimistic write).
  const putPendingRef = useRef(0);

  // Adopt the federation value WITHOUT a PUT (mount + focus/visibility refetch).
  const refetch = useCallback(() => {
    if (!enabled || !api) return;
    const myGen = ++genRef.current;
    // `Promise.resolve().then` so a missing method becomes a rejection (caught),
    // never a synchronous throw into render.
    void Promise.resolve()
      .then(() => api.getFederationSettings())
      .then(view => {
        if (myGen !== genRef.current) return; // superseded by a newer action
        if (putPendingRef.current > 0) return; // our PUT is in flight — drop
        const prov = view.provenance?.[KEY];
        if (prov !== "global" && prov !== "local") return; // "default" → keep cache
        const parsed = TerminalKeyboardExpandedPreferenceSchema.safeParse(
          view.values?.[KEY]
        );
        if (!parsed.success) return;
        setExpandedState(parsed.data.expanded);
        writeKeyboardExpanded(parsed.data.expanded); // reconcile the local cache
      })
      .catch(() => {
        /* best-effort: keep the local cache, never publish it */
      });
  }, [api, enabled]);

  useEffect(() => {
    if (!enabled || !api) return;
    refetch();
    const onFocus = () => refetch();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refetch();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [api, enabled, refetch]);

  const setExpanded = useCallback(
    (next: boolean) => {
      // A local change supersedes any in-flight GET (generation bump), then
      // publishes optimistically.
      ++genRef.current;
      setExpandedState(next);
      writeKeyboardExpanded(next); // #4516's per-node cache
      if (!enabled || !api) return;
      putPendingRef.current += 1;
      void Promise.resolve()
        .then(() =>
          api.putFederationSetting(KEY, { value: { expanded: next } })
        )
        .catch(() => {
          /* fire-and-forget; the optimistic local value stands on failure */
        })
        .finally(() => {
          putPendingRef.current -= 1;
        });
    },
    [api, enabled]
  );

  return { expanded, setExpanded };
}
