// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import type { ApiClient } from "@/api/client";
import {
  SHARE_API_KEYS_BY_DEFAULT_DEFAULT,
  ShareApiKeysByDefaultPreferenceSchema,
} from "@hapi/protocol/schemas";

const KEY = "shareApiKeysByDefault";

/**
 * Issue #5127: the initial state of the add forms' "Make available to all
 * nodes" checkbox — the federation setting `shareApiKeysByDefault`. Read once
 * from `GET /preferences/federation-settings`: the published value when its
 * provenance is `global` or `local`, else the shared default (off). Read-only:
 * it never publishes; the Preferences row writes it (`setValue`). A failed or
 * malformed read keeps the default, so an add form never breaks on it.
 */
export function useShareApiKeysByDefault(api: ApiClient | null): {
  enabled: boolean;
  /** True once the read settled (success or failure). */
  loaded: boolean;
} {
  // With no client there is nothing to read: the default is final at once.
  const [state, setState] = useState<{ enabled: boolean; loaded: boolean }>({
    enabled: SHARE_API_KEYS_BY_DEFAULT_DEFAULT.enabled,
    loaded: api === null,
  });

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    // `Promise.resolve().then` so a missing method becomes a rejection (caught),
    // never a synchronous throw into render.
    void Promise.resolve()
      .then(() => api.getFederationSettings())
      .then(view => {
        if (cancelled) return;
        const prov = view.provenance?.[KEY];
        const parsed = ShareApiKeysByDefaultPreferenceSchema.safeParse(
          view.values?.[KEY]
        );
        const enabled =
          (prov === "global" || prov === "local") && parsed.success
            ? parsed.data.enabled
            : SHARE_API_KEYS_BY_DEFAULT_DEFAULT.enabled;
        // Same value → same object, so a re-read never re-renders the form.
        setState(s =>
          s.loaded && s.enabled === enabled ? s : { enabled, loaded: true }
        );
      })
      .catch(() => {
        if (!cancelled) setState(s => (s.loaded ? s : { ...s, loaded: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return state;
}
