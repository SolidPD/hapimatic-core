// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient, WatermarkStatus } from "@/api/client";

/**
 * Server-authoritative admin hook for the context-watermark surface (#2587).
 *
 * Reproduces the #2486 server-authoritative pattern from `useAutoRecoverPreference`:
 * READ the server's actual state on mount (never a write-only mirror), optimistically
 * reflect a toggle immediately, then reconcile to the server's EFFECTIVE value once the
 * PUT resolves (the `HAPI_CONTEXT_WATERMARK_ENABLED` kill-switch may force it). Every
 * failure degrades silently to an `error` string — it never throws into render, so a
 * transient fetch failure shows the last-known state rather than crashing the page.
 *
 * `api` is threaded in as a parameter (matching `useAutoRecoverPreference`) so the hook
 * works even when `api === null` (it simply does not fetch and reports `loading:false`).
 */
export interface UseWatermarkAdmin {
  /** Server-authoritative status, or `null` until the first fetch resolves. */
  status: WatermarkStatus | null;
  loading: boolean;
  /** Last error message (silent-degrade); `null` when the last op succeeded. */
  error: string | null;
  /** Optimistically toggle enabled, persist to the server, reconcile to effective. */
  setEnabled: (value: boolean) => void;
  /** Optimistically set the watermark percent, persist, reconcile to effective. */
  setWatermarkPercent: (percent: number) => void;
  /** Disarm one armed session, then refresh to reflect the suppressed state. */
  disarm: (sessionId: string) => void;
  /** Manual re-fetch (adopts server truth, clearing the optimistic-toggle guard). */
  refresh: () => void;
}

export function useWatermarkAdmin(api: ApiClient | null): UseWatermarkAdmin {
  const [status, setStatus] = useState<WatermarkStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Prevents a fetch resolving after unmount from calling setState.
  const mountedRef = useRef(true);
  // Guards the initial mount read from clobbering an optimistic toggle made before
  // the first fetch resolved — the first-load race the authority flip introduces
  // (#2486). Reset by an explicit refresh().
  const userToggledRef = useRef(false);

  const load = useCallback(
    async (respectToggle: boolean) => {
      if (!api) {
        setLoading(false);
        return;
      }
      try {
        const next = await api.getWatermarkState();
        if (!mountedRef.current) return;
        setStatus(prev =>
          respectToggle && userToggledRef.current && prev
            ? // Keep the user's just-set editable fields (already reconciled to the
              // server's effective value); adopt fresh states/roles from the fetch.
              {
                ...next,
                enabled: prev.enabled,
                watermarkPercent: prev.watermarkPercent,
              }
            : next
        );
        setError(null);
      } catch (e) {
        if (!mountedRef.current) return;
        setError(
          e instanceof Error ? e.message : "Failed to load watermark status"
        );
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [api]
  );

  useEffect(() => {
    mountedRef.current = true;
    void load(true);
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const refresh = useCallback(() => {
    userToggledRef.current = false;
    void load(false);
  }, [load]);

  const setEnabled = useCallback(
    (value: boolean) => {
      // Mark that the user acted so an in-flight mount read cannot clobber this.
      userToggledRef.current = true;
      // Optimistic: reflect the toggle immediately (the PUT below persists it).
      setStatus(prev => (prev ? { ...prev, enabled: value } : prev));
      if (!api) return;
      void api
        .setWatermarkEnabled({ enabled: value })
        .then(result => {
          if (!mountedRef.current) return;
          // Reconcile to the EFFECTIVE value — the env kill-switch can force it.
          setStatus(prev =>
            prev ? { ...prev, enabled: result.enabled } : prev
          );
          setError(null);
          // Re-fetch to pick up any states the enable/disable transition changed;
          // `enabled` is already reconciled, so respect the toggle guard.
          void load(true);
        })
        .catch(e => {
          if (!mountedRef.current) return;
          setError(
            e instanceof Error ? e.message : "Failed to update watermark config"
          );
          // Reconcile the optimistic value back to server truth on failure.
          void load(false);
        });
    },
    [api, load]
  );

  const setWatermarkPercent = useCallback(
    (percent: number) => {
      // Mark that the user acted so an in-flight mount read cannot clobber this.
      userToggledRef.current = true;
      // Optimistic: reflect the new threshold immediately.
      setStatus(prev => (prev ? { ...prev, watermarkPercent: percent } : prev));
      if (!api) return;
      void api
        .setWatermarkPercent({ watermarkPercent: percent })
        .then(result => {
          if (!mountedRef.current) return;
          // Reconcile to the server's effective (validated) percent.
          setStatus(prev =>
            prev ? { ...prev, watermarkPercent: result.watermarkPercent } : prev
          );
          setError(null);
          void load(true);
        })
        .catch(e => {
          if (!mountedRef.current) return;
          setError(
            e instanceof Error
              ? e.message
              : "Failed to update watermark percent"
          );
          void load(false);
        });
    },
    [api, load]
  );

  const disarm = useCallback(
    (sessionId: string) => {
      if (!api) return;
      void api
        .disarmWatermark(sessionId)
        .then(() => {
          if (!mountedRef.current) return;
          setError(null);
          void load(true);
        })
        .catch(e => {
          if (!mountedRef.current) return;
          setError(e instanceof Error ? e.message : "Failed to disarm session");
        });
    },
    [api, load]
  );

  return {
    status,
    loading,
    error,
    setEnabled,
    setWatermarkPercent,
    disarm,
    refresh,
  };
}
