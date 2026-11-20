// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "@/api/client";
import { applyMergePatch } from "@hapi/protocol/mergePatch";
import type {
  FederationSettingKey,
  FederationSettingsView,
} from "@hapi/protocol/schemas";

/** One queued `mergeValue` patch; an object, so a failed one drops alone. */
type PendingMerge = { patch: Record<string, unknown> };

/** `values[key]` for every key with queued merges: the base value with each
 *  pending patch applied in order, the same function the server applies. */
function withPendingMerges(
  view: FederationSettingsView,
  base: FederationSettingsView | null,
  pending: Map<FederationSettingKey, PendingMerge[]>
): FederationSettingsView {
  let values = view.values;
  for (const [key, list] of pending) {
    if (list.length === 0) continue;
    values = {
      ...values,
      [key]: list.reduce<unknown>(
        (acc, entry) => applyMergePatch(acc, entry.patch),
        (base ?? view).values[key]
      ),
    };
  }
  return values === view.values ? view : { ...view, values };
}

/**
 * Issue #2624 (Sub-Issue B) — the browser 🌐 engine for federation-global
 * settings. Hydrates the per-key view (effective value, inherit flag,
 * provenance) from `GET /preferences/federation-settings` on mount, and flips
 * a key's 🌐 flag via `PUT /preferences/federation-settings/:key` — the ONLY
 * path that toggles inherit. Each PUT responds with the fresh view (re-adopted
 * effective values included), which replaces the local one; the Preferences
 * page then pushes re-adopted values into A's value hooks via their
 * non-writing `adopt` (a plain setter would re-PUT the value as a fresh
 * GLOBAL write — wrong under LWW when a peer's global is newer).
 *
 * Structural kin of the Create-page defaults engine (hydrate-on-mount,
 * optimistic update, server-authoritative reconcile). The PUT is immediate
 * rather than debounced: a 🌐 toggle is a discrete boolean action (no
 * keystroke stream to coalesce), matching the ToggleRow/auto-recover
 * precedent — and an immediate PUT can never be lost to an unmount the way a
 * pending debounce can. The `epoch` guard drops any stale response (mount
 * hydrate or an older PUT) that resolves after a newer toggle.
 *
 * `refetchOnFocus` (#4467, ruling G-3 A; default OFF): re-read the view on
 * window `focus` and when the document becomes visible, so an open page picks
 * up a peer node's change. A refetch is dropped when any write of this hook
 * instance is in flight (at its start or its end) or the epoch moved. The
 * Preferences page keeps it off: its value hooks keep their own generation
 * counter and never bump this epoch, so a refetch there could overwrite a
 * local edit.
 *
 * #6526: `confirmedView` is the latest view the SERVER returned (a GET or a
 * PUT response), never an optimistic value, so a caller can cache only what
 * was stored. `mergeValue` sends an RFC 7396 merge patch of only the changed
 * fields; the server applies it to the stored raw value. Merges for one key
 * reach the server one at a time, in order; `view` shows the confirmed value
 * with every queued merge applied, and a failed merge drops only its own
 * patch and resolves `null`. A key written with `mergeValue` should not also
 * be written with `setValue` in the same instance. A PUT answers once the
 * value is stored locally; it does not wait for the push to the other nodes.
 */
export function useFederationSettings(
  api: ApiClient | null,
  opts: { refetchOnFocus?: boolean } = {}
): {
  /** True once the mount hydrate settled (success OR degrade). */
  hydrated: boolean;
  /** The latest view: the server's, plus optimistic edits and queued merges;
   *  null before hydration or with no api. */
  view: FederationSettingsView | null;
  /** #6526: the latest view the server returned; never an optimistic value. */
  confirmedView: FederationSettingsView | null;
  /** Per-key 🌐 state; defaults to ON (R2) before hydration. */
  inheritFor: (key: FederationSettingKey) => boolean;
  /** Flip a key's 🌐 flag (optimistic; server view adopted on response). */
  setInherit: (key: FederationSettingKey, inherit: boolean) => void;
  /**
   * #4613: set a key's VALUE (optimistic; server view adopted on response). For
   * keys with no dedicated A-value hook (e.g. `timeLogTimezone`) this is the ONLY
   * write path — the PUT follows the key's current inherit flag server-side
   * (global write while inheriting, local override otherwise). Same epoch-guard as
   * `setInherit`, so a stale response can never clobber a newer edit.
   */
  setValue: (key: FederationSettingKey, value: unknown) => void;
  /**
   * #6526: send an RFC 7396 merge patch for a key. Resolves with the view the
   * server confirmed once it has stored the patch, or `null` when the PUT
   * failed (or there is no api).
   */
  mergeValue: (
    key: FederationSettingKey,
    patch: Record<string, unknown>
  ) => Promise<FederationSettingsView | null>;
} {
  const [view, setView] = useState<FederationSettingsView | null>(null);
  const [confirmedView, setConfirmedView] =
    useState<FederationSettingsView | null>(null);
  const confirmedRef = useRef<FederationSettingsView | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const epochRef = useRef(0);
  // Writes (setInherit / setValue / mergeValue PUTs) still in flight; a
  // refetch that overlaps one is dropped so it cannot undo an optimistic edit.
  const pendingRef = useRef(0);
  // #6526: queued merge patches per key, and the settle of the last merge PUT
  // sent per key (absent when none is in flight).
  const pendingMergesRef = useRef(
    new Map<FederationSettingKey, PendingMerge[]>()
  );
  const mergeTailRef = useRef(new Map<FederationSettingKey, Promise<void>>());
  const apiRef = useRef(api);
  apiRef.current = api;
  const refetchOnFocus = opts.refetchOnFocus === true;

  // #6526 (FX-9): every view the server returns goes through here. It becomes
  // `confirmedView`, and `view` keeps every merge still queued on top of it,
  // so a GET, a refetch or another PUT's response never hides a queued pick.
  const adoptServerView = useCallback((fresh: FederationSettingsView) => {
    confirmedRef.current = fresh;
    setConfirmedView(fresh);
    setView(withPendingMerges(fresh, fresh, pendingMergesRef.current));
  }, []);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const epoch = epochRef.current;
    void api
      .getFederationSettings()
      .then(fresh => {
        if (cancelled || epochRef.current !== epoch) return;
        adoptServerView(fresh);
        setHydrated(true);
      })
      .catch(() => {
        // Degrade: toggles render the all-inheriting default (R2); a toggle
        // still PUTs and adopts the response, self-healing the view.
        if (!cancelled) setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, adoptServerView]);

  useEffect(() => {
    if (!api || !refetchOnFocus) return;
    let cancelled = false;
    const refetch = () => {
      if (pendingRef.current > 0) return;
      const epoch = epochRef.current;
      void api
        .getFederationSettings()
        .then(fresh => {
          if (cancelled || epochRef.current !== epoch) return;
          if (pendingRef.current > 0) return;
          adoptServerView(fresh);
          setHydrated(true);
        })
        .catch(() => {
          /* best-effort: the current view stays until the next focus */
        });
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refetch();
    };
    window.addEventListener("focus", refetch);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refetch);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [api, refetchOnFocus, adoptServerView]);

  const inheritFor = useCallback(
    (key: FederationSettingKey) => view?.inheritFlags[key] !== false,
    [view]
  );

  const setInherit = useCallback(
    (key: FederationSettingKey, inherit: boolean) => {
      epochRef.current += 1;
      const epoch = epochRef.current;
      // Optimistic flip so the 🌐 icon answers instantly — even BEFORE the
      // mount hydrate resolves (synthesize a minimal view then; the epoch
      // guard already drops the late hydrate so it cannot clobber this).
      setView(prev =>
        prev
          ? { ...prev, inheritFlags: { ...prev.inheritFlags, [key]: inherit } }
          : { values: {}, inheritFlags: { [key]: inherit }, provenance: {} }
      );
      const client = apiRef.current;
      if (!client) return;
      pendingRef.current += 1;
      void client
        .putFederationSetting(key, { inherit })
        .then(fresh => {
          if (epochRef.current !== epoch) return; // superseded by a newer toggle
          adoptServerView(fresh);
        })
        .catch(() => {
          /* best-effort: the optimistic flag stays; the next hydrate reconciles */
        })
        .finally(() => {
          pendingRef.current -= 1;
        });
    },
    [adoptServerView]
  );

  const setValue = useCallback(
    (key: FederationSettingKey, value: unknown) => {
      epochRef.current += 1;
      const epoch = epochRef.current;
      // Optimistic value update so the control reflects the pick immediately.
      setView(prev =>
        prev
          ? { ...prev, values: { ...prev.values, [key]: value } }
          : { values: { [key]: value }, inheritFlags: {}, provenance: {} }
      );
      const client = apiRef.current;
      if (!client) return;
      pendingRef.current += 1;
      void client
        .putFederationSetting(key, { value })
        .then(fresh => {
          if (epochRef.current !== epoch) return; // superseded by a newer edit
          adoptServerView(fresh);
        })
        .catch(() => {
          /* best-effort: the optimistic value stays; the next hydrate reconciles */
        })
        .finally(() => {
          pendingRef.current -= 1;
        });
    },
    [adoptServerView]
  );

  const mergeValue = useCallback(
    (
      key: FederationSettingKey,
      patch: Record<string, unknown>
    ): Promise<FederationSettingsView | null> => {
      const client = apiRef.current;
      if (!client) return Promise.resolve(null);
      epochRef.current += 1; // drops an in-flight hydrate or refetch
      pendingRef.current += 1; // skips focus refetches while queued
      const entry: PendingMerge = { patch };
      const queued = pendingMergesRef.current;
      queued.set(key, [...(queued.get(key) ?? []), entry]);
      // Show the pick at once: the confirmed value with every queued merge.
      setView(prev =>
        withPendingMerges(
          prev ?? { values: {}, inheritFlags: {}, provenance: {} },
          confirmedRef.current,
          queued
        )
      );

      const drop = () => {
        const rest = (queued.get(key) ?? []).filter(e => e !== entry);
        if (rest.length > 0) queued.set(key, rest);
        else queued.delete(key);
        pendingRef.current -= 1;
      };
      const send = (): Promise<FederationSettingsView | null> => {
        let put: Promise<FederationSettingsView>;
        try {
          put = client.putFederationSetting(key, { merge: patch });
        } catch (err) {
          put = Promise.reject(err);
        }
        return put.then(
          fresh => {
            drop();
            adoptServerView(fresh);
            return fresh;
          },
          () => {
            // Drop first: the re-read below needs no write pending.
            drop();
            const confirmed = confirmedRef.current;
            setView(prev => {
              const base = confirmed ?? prev;
              if (!base) return prev;
              const rest = queued.get(key) ?? [];
              return {
                ...(prev ?? base),
                values: {
                  ...(prev ?? base).values,
                  [key]: rest.reduce<unknown>(
                    (acc, e) => applyMergePatch(acc, e.patch),
                    confirmed?.values[key]
                  ),
                },
              };
            });
            // The last settled write failed: re-read once, in case the PUT
            // landed and only its response was lost. A queued success needs
            // no re-read; its response is the server's view.
            if (pendingRef.current === 0) {
              const epoch = epochRef.current;
              void client
                .getFederationSettings()
                .then(fresh => {
                  if (epochRef.current !== epoch) return;
                  if (pendingRef.current > 0) return;
                  adoptServerView(fresh);
                })
                .catch(() => {
                  /* best-effort: the confirmed value stays shown */
                });
            }
            return null;
          }
        );
      };

      // One merge PUT per key at a time, in order. An idle queue sends in
      // this tick; a busy one sends after the previous PUT settles.
      const tail = mergeTailRef.current.get(key);
      const settled = tail ? tail.then(send) : send();
      const done = settled.then(() => undefined);
      mergeTailRef.current.set(key, done);
      void done.then(() => {
        if (mergeTailRef.current.get(key) === done) {
          mergeTailRef.current.delete(key);
        }
      });
      return settled;
    },
    [adoptServerView]
  );

  return {
    hydrated,
    view,
    confirmedView,
    inheritFor,
    setInherit,
    setValue,
    mergeValue,
  };
}
