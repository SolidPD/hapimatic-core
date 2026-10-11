// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  type QueryKey,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { isPermissionModeAllowedForFlavor } from "@hapi/protocol";
import type { EffortLevel } from "@hapi/protocol";
import type { RelaunchRequest } from "@hapi/protocol/schemas";
import type { ApiClient } from "@/api/client";
import type {
  FederationAllSessionsResponse,
  ModelMode,
  PermissionMode,
  SessionResponse,
  SessionsResponse,
} from "@/types/api";
import { queryKeys } from "@/lib/query-keys";
import {
  setFederationOverride,
  clearFederationOverride,
} from "@/lib/federation-mutation-overrides";
import { useToast } from "@/components/Toast";
import {
  markActionPending,
  clearActionPending,
} from "@/lib/session-action-pending";

/**
 * Collect all descendant session IDs (children, grandchildren, etc.)
 * from the TanStack Query sessions cache.
 */
// #2480: exported so the delete dialog's consumers (SessionHeader / SessionItem)
// can count "Delete all (N)" using the SAME descendant walk the cascade uses —
// N then equals exactly what deleteSessionCascade removes (peers + branches, all
// depths), instead of the branch-only direct-child count.
export function findDescendantIds(
  sessionId: string,
  allSessions: { id: string; parentSessionId?: string | null }[]
): string[] {
  const result: string[] = [];
  const queue = [sessionId];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const s of allSessions) {
      if (s.parentSessionId === parentId) {
        result.push(s.id);
        queue.push(s.id);
      }
    }
  }
  return result;
}

// #2826: dedupe merged local+federation caches by id (first occurrence wins)
// before any descendant walk, so display counts match the cascade-delete set.
export function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter(it => {
    if (seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  });
}

// Issue #3704: spec consumed by the in-hook `optimisticSessionPatch` factory.
// One shape spans both tiers: `caches[].apply` returning `undefined` means
// "leave this cache untouched" (preserves each mutation's snapshot guard so the
// helper never creates a phantom query or bumps dataUpdatedAt on an untouched
// cache); `federationOverride` runs AFTER the snapshots are taken and only for
// Tier B; `settle` preserves the per-tier onSettled form (Tier A synchronous,
// Tier B awaited) and the `refetchType: "none"` federation invalidate.
type OptimisticCacheSpec<TVars> = {
  key: QueryKey;
  apply: (prev: unknown, vars: TVars) => unknown;
};

type OptimisticSettle = {
  invalidateSession?: boolean;
  await?: boolean;
  invalidate?: Array<{ key: QueryKey; refetchType?: "none" }>;
};

type OptimisticSpec<TVars> = {
  caches: Array<OptimisticCacheSpec<TVars>>;
  // Returns the override value (registered via setFederationOverride) or
  // `undefined` to skip registration. `snapshots` is positionally aligned to
  // `caches` — rename reads its federation snapshot to merge sibling metadata.
  federationOverride?: (
    vars: TVars,
    snapshots: readonly unknown[]
  ) => Parameters<typeof setFederationOverride>[1] | undefined;
  settle: OptimisticSettle;
};

// The onMutate context: the per-cache snapshots, positionally aligned to
// `spec.caches`, that onError restores. onMutate ALWAYS returns this shape (an
// empty `snapshots` on the no-session short-circuit) so TContext never carries
// `undefined` — this TanStack version infers TContext from several call sites at
// once (onMutate's covariant return + onError/onSettled's contravariant result
// param), and a `| undefined` return produces conflicting candidates.
type OptimisticContext = { snapshots: unknown[] };

export function useSessionActions(
  api: ApiClient | null,
  sessionId: string | null,
  agentFlavor?: string | null,
  onReconnect?: (newSessionId: string) => void,
  onBranch?: (newSessionId: string) => void,
  // Issue #3516: navigate to a session by id — used by the delete rollback toast's
  // back-link. Passed by SessionHeader (which has router access); the hook itself
  // has none. Optional so the many router-less test/consumer call sites are unchanged.
  onNavigateToSession?: (sessionId: string) => void
): {
  abortSession: () => Promise<void>;
  archiveSession: () => Promise<void>;
  reconnectSession: () => Promise<string>;
  branchSession: (branchLabel?: string) => Promise<string>;
  switchSession: () => Promise<void>;
  setPermissionMode: (mode: PermissionMode) => Promise<void>;
  setModelMode: (mode: ModelMode) => Promise<void>;
  /** Issue #2456: set the session's reasoning-effort level. */
  setSessionEffort: (effort: EffortLevel) => Promise<void>;
  /** Issue #2456: pin a specific raw Claude model id ("More models"). */
  setSessionRawModel: (rawModel: string) => Promise<void>;
  /** Issue #2149: apply a full desired MCP set to the running session (live, no respawn). */
  setMcpDesired: (desired: Record<string, boolean>) => Promise<void>;
  /** Issue #2149: relaunch with new spawn-frozen params (launcher / safeMode). */
  relaunchSession: (overrides: RelaunchRequest) => Promise<void>;
  renameSession: (name: string) => Promise<void>;
  setEmoji: (emoji: string | null) => Promise<void>;
  setNeedsReviewOverride: (override: "read" | "unread" | null) => Promise<void>;
  setAutoRecoverFromApiError: (autoRecover: boolean | null) => Promise<void>;
  deleteSession: () => Promise<void>;
  deleteSessionCascade: () => Promise<void>;
  /** "Disconnect & Delete" on a live session: optimistic row removal FIRST, then
   *  archive, then delete — so the row never lingers through the (slow) archive. */
  archiveAndDeleteSession: () => Promise<void>;
  isPending: boolean;
  isReconnecting: boolean;
  isBranching: boolean;
  isArchiving: boolean;
  isDeleting: boolean;
} {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  // Issue #3516: `isDeleting` is driven by the delete wrappers (below), NOT a
  // useMutation observer. Navigate-first unmounts SessionHeader the instant
  // `onSessionDeleted()` runs, which in @tanstack/react-query 5.90.12 both drops a
  // mutation observer's `isPending` AND — critically — ABANDONS its `mutateAsync`
  // promise mid-flight, so an `await mutation.mutateAsync()` in the wrapper would
  // hang forever for any realistic (network-latency) failure and the settle
  // (rollback / toast / clear) would never run. The delete wrappers therefore
  // drive the raw `api.*` calls directly — a browser `fetch` promise is not
  // observer-tied and settles after the unmount — and track this flag themselves.
  const [isDeleting, setIsDeleting] = useState(false);

  const invalidateSession = async () => {
    if (!sessionId) return;
    await queryClient.invalidateQueries({
      queryKey: queryKeys.session(sessionId),
    });
    await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
  };

  // Issue #3704: one parameterized factory for the optimistic cache-patch idiom
  // shared by the 7 field-patch mutations below — 3 Tier-A (single `session(id)`
  // cache) and 4 Tier-B (session + sessions + federation, plus a federation
  // override). `deleteMutation` stays bespoke (optimistic REMOVAL, not a field
  // patch). `clearFederationOverride` fires in `onError` ONLY: the override is
  // TTL-governed (15s), so a settle-time clear would re-expose the stale hub row
  // and revert the optimistic value until the next poll.
  const optimisticSessionPatch = <TVars>(
    spec: OptimisticSpec<TVars>
  ): Pick<
    UseMutationOptions<void, Error, TVars, OptimisticContext>,
    "onMutate" | "onError" | "onSettled"
  > => {
    // Named callbacks (not inline `onMutate:` properties) so the 7 converted
    // mutations own exactly ZERO inline optimistic bodies — deleteMutation is
    // the only remaining inline `onMutate:` (issue #3704 V1).
    const onMutate = async (vars: TVars): Promise<OptimisticContext> => {
      // No session: short-circuit BEFORE any cache op (mutationFn throws anyway).
      // Return an empty context rather than undefined — see OptimisticContext.
      if (!sessionId) return { snapshots: [] };
      for (const cache of spec.caches) {
        await queryClient.cancelQueries({ queryKey: cache.key });
      }
      const snapshots = spec.caches.map(cache =>
        queryClient.getQueryData(cache.key)
      );
      // Register the federation override AFTER the snapshots (rename derives it
      // from the federation snapshot); skip when the spec returns undefined.
      if (spec.federationOverride) {
        const override = spec.federationOverride(vars, snapshots);
        if (override !== undefined) setFederationOverride(sessionId, override);
      }
      // Apply each cache patch; `undefined` from `apply` means "leave untouched".
      spec.caches.forEach((cache, i) => {
        const next = cache.apply(snapshots[i], vars);
        if (next !== undefined) queryClient.setQueryData(cache.key, next);
      });
      return { snapshots };
    };

    const onError = (
      _err: unknown,
      _vars: TVars,
      context: OptimisticContext | undefined
    ) => {
      if (!sessionId || !context) return;
      // onError ONLY (never onSettled) — the override is TTL-governed.
      if (spec.federationOverride) clearFederationOverride(sessionId);
      spec.caches.forEach((cache, i) => {
        const snapshot = context.snapshots[i];
        if (snapshot !== undefined) {
          queryClient.setQueryData(cache.key, snapshot);
        }
      });
    };

    const onSettled = () => {
      const {
        invalidateSession: doInvalidateSession,
        await: doAwait,
        invalidate,
      } = spec.settle;
      const fireInvalidations = () => {
        for (const inv of invalidate ?? []) {
          void queryClient.invalidateQueries({
            queryKey: inv.key,
            refetchType: inv.refetchType,
          });
        }
      };
      // Tier B awaits the session reconcile before firing the non-refetching
      // federation invalidate; Tier A is fire-and-forget so `mutateAsync`
      // resolves without waiting on the reconcile (preserves the timing).
      if (doAwait) {
        return (async () => {
          if (doInvalidateSession) await invalidateSession();
          fireInvalidations();
        })();
      }
      if (doInvalidateSession) void invalidateSession();
      fireInvalidations();
      return;
    };

    return { onMutate, onError, onSettled };
  };

  const abortMutation = useMutation({
    mutationFn: async () => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }
      await api.abortSession(sessionId);
    },
    onSuccess: () => void invalidateSession(),
  });

  const archiveMutation = useMutation({
    mutationFn: async () => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }
      await api.archiveSession(sessionId);
    },
    onMutate: () => {
      // Issue #1902: mark archive in-progress in the shared store so the chain
      // icon spins on BOTH the header and the list card (cross-view) until the
      // session is observed inactive (reconcileActionPending) or the TTL fires.
      if (sessionId) markActionPending(sessionId, "archive");
    },
    onError: () => {
      // Non-blocking failure: stop the spinner immediately and toast.
      if (sessionId) clearActionPending(sessionId, "archive");
      showToast("Failed to disconnect session", { type: "error" });
    },
    onSuccess: async () => {
      // Do NOT clear the pending store here — keep the spinner until the session
      // is observed inactive (reconcileActionPending in SessionList) so it tracks
      // the real state change, not just the HTTP ack. TTL is the safety backstop.
      await invalidateSession();
      void queryClient.invalidateQueries({
        queryKey: queryKeys.federationAllSessions,
      });
    },
  });

  const reconnectMutation = useMutation({
    mutationFn: async () => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }
      const result = await api.reconnectSession(sessionId);
      return result.newSessionId;
    },
    onError: () => {
      // Issue #1902: defensively clear the cross-view reconnect spinner on
      // failure. The toast is surfaced by the UI confirm handler (which has the
      // richer getReconnectErrorToast message, e.g. #1778 cwd_missing).
      if (sessionId) clearActionPending(sessionId, "reconnect");
    },
    onSuccess: async newSessionId => {
      await invalidateSession();
      void queryClient.invalidateQueries({
        queryKey: queryKeys.federationAllSessions,
      });
      if (onReconnect && newSessionId) {
        onReconnect(newSessionId);
      }
    },
  });

  const branchMutation = useMutation({
    mutationFn: async (branchLabel?: string) => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }
      const result = await api.branchSession(sessionId, branchLabel);
      return result.newSessionId;
    },
    onSuccess: async newSessionId => {
      await invalidateSession();
      void queryClient.invalidateQueries({
        queryKey: queryKeys.federationAllSessions,
      });
      if (onBranch && newSessionId) {
        onBranch(newSessionId);
      }
    },
  });

  const switchMutation = useMutation({
    mutationFn: async () => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }
      await api.switchSession(sessionId);
    },
    onSuccess: () => void invalidateSession(),
  });

  const permissionMutation = useMutation({
    mutationFn: async (mode: PermissionMode) => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }
      // Issue #3350 (3350-5): "opencode" was omitted here, so an opencode live
      // permission mutation bypassed this client gate entirely and 400'd
      // server-side (opencode's allowed in-session set is also empty). Include it
      // so the invalid mutation is rejected cleanly client-side. (The live
      // Permission Mode picker now renders a grayed default for gemini/opencode,
      // so this is unreachable from the UI — it is the defense-in-depth backstop.)
      const isKnownFlavor =
        agentFlavor === "claude" ||
        agentFlavor === "codex" ||
        agentFlavor === "gemini" ||
        agentFlavor === "opencode";
      if (
        isKnownFlavor &&
        !isPermissionModeAllowedForFlavor(mode, agentFlavor)
      ) {
        throw new Error("Invalid permission mode for session flavor");
      }
      await api.setPermissionMode(sessionId, mode);
    },
    onSuccess: () => void invalidateSession(),
  });

  // Issue #2768: optimistic in-session model/effort/rawModel display. Each of the
  // three mutations gets the react-query cancel→snapshot→setQueryData→rollback→
  // settle idiom (matching renameMutation) so the composer's SessionConfigCluster
  // chip (and getModelLabel's handoff surface) updates INSTANTLY — before the
  // server round-trip / next-message SSE. Post-#3289 no list surface renders
  // model/effort, so ONLY the per-session query (["session", id], the source
  // SessionChat.props.session derives from) is patched. effort/rawModel render
  // directly from session.* so a cache patch reconciles cleanly (no lag). MODE is
  // different — session.resolvedModel lags (sdk: next message) and the label
  // prefers it, so the mode label's instant display + reconcile-lag bridge is
  // owned by the useModelSwitchVerification pending-override in SessionChat; here
  // modelMutation only patches the correct modelMode/rawModel state. Mode↔rawModel
  // mutual exclusivity mirrors the CLI (runClaude.ts:673-676/:697-706): a mode
  // pick clears rawModel, a rawModel pick clears modelMode — sessionCache
  // .applySessionConfig skips undefined fields, so the reconcile won't clear a
  // stale counter-axis on its own.
  const modelMutation = useMutation({
    mutationFn: async (mode: ModelMode) => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }
      await api.setModelMode(sessionId, mode);
    },
    ...optimisticSessionPatch<ModelMode>({
      caches: [
        {
          key: queryKeys.session(sessionId ?? ""),
          // A mode pick clears the rawModel pin (exclusivity). resolvedModel is
          // intentionally NOT patched — it lags for sdk and the reconcile would
          // restore it (flicker); the SessionChat pending-override owns the label.
          apply: (prev, mode) => {
            const p = prev as SessionResponse | undefined;
            if (!p?.session) return undefined;
            return {
              ...p,
              session: { ...p.session, modelMode: mode, rawModel: undefined },
            };
          },
        },
      ],
      settle: { invalidateSession: true, await: false },
    }),
  });

  // Issue #2456: in-session reasoning-effort + specific raw-model changes.
  // Mirror modelMutation — the server respawns tmux/pty or re-queries the SDK
  // launcher, and the keepAlive tick reflects the applied value. Issue #2768 adds
  // the optimistic cache patch — effort renders directly from session.effort, so
  // it reconciles with no lag.
  const effortMutation = useMutation({
    mutationFn: async (effort: EffortLevel) => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }
      await api.setSessionEffort(sessionId, effort);
    },
    ...optimisticSessionPatch<EffortLevel>({
      caches: [
        {
          key: queryKeys.session(sessionId ?? ""),
          apply: (prev, effort) => {
            const p = prev as SessionResponse | undefined;
            if (!p?.session) return undefined;
            return { ...p, session: { ...p.session, effort } };
          },
        },
      ],
      settle: { invalidateSession: true, await: false },
    }),
  });

  const rawModelMutation = useMutation({
    mutationFn: async (rawModel: string) => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }
      await api.setSessionRawModel(sessionId, rawModel);
    },
    ...optimisticSessionPatch<string>({
      caches: [
        {
          key: queryKeys.session(sessionId ?? ""),
          // A rawModel pick clears the mode pin (exclusivity); the rawModel-first
          // label shows the pinned id directly, so it reconciles with no lag.
          apply: (prev, rawModel) => {
            const p = prev as SessionResponse | undefined;
            if (!p?.session) return undefined;
            return {
              ...p,
              session: { ...p.session, rawModel, modelMode: "default" },
            };
          },
        },
      ],
      settle: { invalidateSession: true, await: false },
    }),
  });

  // Issue #2149: apply a full desired MCP set (live plane, no respawn) — the
  // server worker reconciles desired vs current, so the session's tool set
  // changes without a teardown.
  const mcpMutation = useMutation({
    mutationFn: async (desired: Record<string, boolean>) => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }
      await api.setMcpDesired(sessionId, desired);
    },
    onSuccess: () => {
      void invalidateSession();
      if (sessionId) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.mcpBatchState(sessionId),
        });
      }
    },
  });

  // Issue #2149: relaunch with new spawn-frozen params (launcher / safeMode).
  // No optimistic override — launcher/safeMode live under `session.metadata`, and
  // the shallow-merge federation-override helper would clobber sibling metadata
  // fields. onSettled refreshes BOTH the session and the federation list so all
  // clients see the change without waiting for the ~10s poll (R6); the server
  // evicts + repolls the hub cache on the proxied path (Task 11).
  const relaunchMutation = useMutation({
    mutationFn: async (overrides: RelaunchRequest) => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }
      await api.relaunchSession(sessionId, overrides);
    },
    onSettled: async () => {
      await invalidateSession();
      void queryClient.invalidateQueries({
        queryKey: queryKeys.federationAllSessions,
      });
    },
  });

  const renameMutation = useMutation({
    mutationFn: async (name: string) => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }
      await api.renameSession(sessionId, name);
    },
    ...optimisticSessionPatch<string>({
      caches: [
        {
          key: queryKeys.session(sessionId ?? ""),
          apply: (prev, newName) => {
            const p = prev as SessionResponse | undefined;
            if (!p?.session?.metadata) return undefined;
            return {
              ...p,
              session: {
                ...p.session,
                metadata: { ...p.session.metadata, name: newName },
              },
            };
          },
        },
        {
          key: queryKeys.sessions,
          apply: (prev, newName) => {
            const p = prev as SessionsResponse | undefined;
            if (!p) return undefined;
            return {
              ...p,
              sessions: p.sessions.map(s =>
                s.id === sessionId && s.metadata
                  ? { ...s, metadata: { ...s.metadata, name: newName } }
                  : s
              ),
            };
          },
        },
        {
          key: queryKeys.federationAllSessions,
          apply: (prev, newName) => {
            const p = prev as FederationAllSessionsResponse | undefined;
            if (!p) return undefined;
            return {
              ...p,
              sessions: p.sessions.map(s =>
                s.id === sessionId && s.metadata
                  ? { ...s, metadata: { ...s.metadata, name: newName } }
                  : s
              ),
            };
          },
        },
      ],
      // Merge the new name into the federation snapshot's existing metadata so
      // the poll doesn't revert it; skip when the session has no federation row.
      // snapshots[2] is the federationAllSessions snapshot (caches order above).
      federationOverride: (newName, snapshots) => {
        const prevFederation = snapshots[2] as
          | FederationAllSessionsResponse
          | undefined;
        const fedSession = prevFederation?.sessions.find(
          s => s.id === sessionId
        );
        if (!fedSession?.metadata) return undefined;
        return { metadata: { ...fedSession.metadata, name: newName } };
      },
      settle: {
        invalidateSession: true,
        await: true,
        // Mark federation cache stale WITHOUT immediate refetch — the
        // NodeRegistry cache on the hub may still hold stale data for up to 10s.
        // Letting the regular poll pick up fresh data avoids overwriting our
        // optimistic value.
        invalidate: [
          { key: queryKeys.federationAllSessions, refetchType: "none" },
        ],
      },
    }),
  });

  const emojiMutation = useMutation({
    mutationFn: async (emoji: string | null) => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }
      await api.updateSessionEmoji(sessionId, emoji);
    },
    ...optimisticSessionPatch<string | null>({
      caches: [
        {
          key: queryKeys.session(sessionId ?? ""),
          apply: (prev, newEmoji) => {
            const p = prev as SessionResponse | undefined;
            if (!p?.session) return undefined;
            // Convert null to undefined to match session type (emoji?: string)
            return {
              ...p,
              session: { ...p.session, emoji: newEmoji ?? undefined },
            };
          },
        },
        {
          key: queryKeys.sessions,
          apply: (prev, newEmoji) => {
            const p = prev as SessionsResponse | undefined;
            if (!p) return undefined;
            return {
              ...p,
              sessions: p.sessions.map(s =>
                s.id === sessionId ? { ...s, emoji: newEmoji ?? undefined } : s
              ),
            };
          },
        },
        {
          key: queryKeys.federationAllSessions,
          apply: (prev, newEmoji) => {
            const p = prev as FederationAllSessionsResponse | undefined;
            if (!p) return undefined;
            return {
              ...p,
              sessions: p.sessions.map(s =>
                s.id === sessionId ? { ...s, emoji: newEmoji ?? undefined } : s
              ),
            };
          },
        },
      ],
      federationOverride: newEmoji => ({ emoji: newEmoji ?? undefined }),
      settle: {
        invalidateSession: true,
        await: true,
        invalidate: [
          { key: queryKeys.federationAllSessions, refetchType: "none" },
        ],
      },
    }),
  });

  const needsReviewOverrideMutation = useMutation({
    mutationFn: async (override: "read" | "unread" | null) => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }
      await api.updateSessionNeedsReviewOverride(sessionId, override);
    },
    ...optimisticSessionPatch<"read" | "unread" | null>({
      caches: [
        {
          key: queryKeys.session(sessionId ?? ""),
          apply: (prev, newOverride) => {
            const p = prev as SessionResponse | undefined;
            if (!p?.session) return undefined;
            return {
              ...p,
              session: { ...p.session, needsReviewOverride: newOverride },
            };
          },
        },
        {
          key: queryKeys.sessions,
          apply: (prev, newOverride) => {
            const p = prev as SessionsResponse | undefined;
            if (!p) return undefined;
            return {
              ...p,
              sessions: p.sessions.map(s =>
                s.id === sessionId
                  ? { ...s, needsReviewOverride: newOverride }
                  : s
              ),
            };
          },
        },
        {
          key: queryKeys.federationAllSessions,
          apply: (prev, newOverride) => {
            const p = prev as FederationAllSessionsResponse | undefined;
            if (!p) return undefined;
            return {
              ...p,
              sessions: p.sessions.map(s =>
                s.id === sessionId
                  ? { ...s, needsReviewOverride: newOverride }
                  : s
              ),
            };
          },
        },
      ],
      federationOverride: newOverride => ({
        needsReviewOverride: newOverride,
      }),
      settle: {
        invalidateSession: true,
        await: true,
        invalidate: [
          { key: queryKeys.federationAllSessions, refetchType: "none" },
        ],
      },
    }),
  });

  const autoRecoverFromApiErrorMutation = useMutation({
    mutationFn: async (autoRecover: boolean | null) => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }
      await api.updateSessionAutoRecoverFromApiError(sessionId, autoRecover);
    },
    ...optimisticSessionPatch<boolean | null>({
      caches: [
        {
          key: queryKeys.session(sessionId ?? ""),
          apply: (prev, newValue) => {
            const p = prev as SessionResponse | undefined;
            if (!p?.session) return undefined;
            return {
              ...p,
              session: { ...p.session, autoRecoverFromApiError: newValue },
            };
          },
        },
        {
          key: queryKeys.sessions,
          apply: (prev, newValue) => {
            const p = prev as SessionsResponse | undefined;
            if (!p) return undefined;
            return {
              ...p,
              sessions: p.sessions.map(s =>
                s.id === sessionId
                  ? { ...s, autoRecoverFromApiError: newValue }
                  : s
              ),
            };
          },
        },
        {
          key: queryKeys.federationAllSessions,
          apply: (prev, newValue) => {
            const p = prev as FederationAllSessionsResponse | undefined;
            if (!p) return undefined;
            return {
              ...p,
              sessions: p.sessions.map(s =>
                s.id === sessionId
                  ? { ...s, autoRecoverFromApiError: newValue }
                  : s
              ),
            };
          },
        },
      ],
      federationOverride: newValue => ({
        autoRecoverFromApiError: newValue,
      }),
      settle: {
        invalidateSession: true,
        await: true,
        invalidate: [
          { key: queryKeys.federationAllSessions, refetchType: "none" },
        ],
      },
    }),
  });

  // Issue #3516 — the delete wrappers own the ENTIRE delete: optimistic cache
  // work, the raw `api.*` network call, and the settle side-effects (rollback /
  // partial-skip restore / toast / clear / invalidate). There is NO `useMutation`
  // for delete anymore — see the `isDeleting` comment above for why an observer
  // cannot survive the navigate-away unmount. `deleteMutation` stays conceptually
  // the single-session recipe (#1902 optimism + #2556 bubble cleanup); the cascade
  // wrapper is BESPOKE — it walks N descendants, marks each for the route guard,
  // chunks the 100-id bulk cap, and reconciles a partial skip.
  // The pre-removal snapshots of both list caches — what a rollback restores.
  type ListSnapshots = {
    prevSessions: SessionsResponse | undefined;
    prevFederation: FederationAllSessionsResponse | undefined;
  };

  // Cancel any in-flight list fetch and snapshot both list caches. Split from
  // `removeRows` because the cascade derives its id set FROM the snapshot.
  const snapshotLists = async (): Promise<ListSnapshots> => {
    await queryClient.cancelQueries({ queryKey: queryKeys.sessions });
    await queryClient.cancelQueries({
      queryKey: queryKeys.federationAllSessions,
    });
    return {
      prevSessions: queryClient.getQueryData<SessionsResponse>(
        queryKeys.sessions
      ),
      prevFederation: queryClient.getQueryData<FederationAllSessionsResponse>(
        queryKeys.federationAllSessions
      ),
    };
  };

  // Optimistic removal: mark every id delete-pending (the route guard AND the
  // list queryFns' refetch filter, `withoutDeletePending`), then drop the rows
  // from both list caches. The mark goes first so a refetch that lands between
  // the two steps is already filtered.
  const removeRows = (ids: string[], snap: ListSnapshots): void => {
    for (const id of ids) markActionPending(id, "delete");
    const idSet = new Set(ids);
    if (snap.prevSessions) {
      queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, {
        ...snap.prevSessions,
        sessions: snap.prevSessions.sessions.filter(s => !idSet.has(s.id)),
      });
    }
    if (snap.prevFederation) {
      queryClient.setQueryData<FederationAllSessionsResponse>(
        queryKeys.federationAllSessions,
        {
          ...snap.prevFederation,
          sessions: snap.prevFederation.sessions.filter(s => !idSet.has(s.id)),
        }
      );
    }
  };

  // Rollback: restore both list caches from the snapshot.
  const restoreRows = (snap: ListSnapshots): void => {
    if (snap.prevSessions) {
      queryClient.setQueryData(queryKeys.sessions, snap.prevSessions);
    }
    if (snap.prevFederation) {
      queryClient.setQueryData(
        queryKeys.federationAllSessions,
        snap.prevFederation
      );
    }
  };

  const viewSessionToastAction = () =>
    onNavigateToSession && sessionId
      ? {
          action: {
            label: "View session",
            onClick: () => onNavigateToSession(sessionId),
          },
        }
      : {};

  // The single-session delete core. `preRemoved` is set by the archive-then-
  // delete combo, which already took the snapshot + removed the row BEFORE the
  // archive — a fresh snapshot here would capture the row-less list and a
  // rollback would then "restore" the row to nowhere.
  const runDeleteSession = async (
    preRemoved?: ListSnapshots
  ): Promise<void> => {
    if (!api || !sessionId) {
      throw new Error("Session unavailable");
    }
    setIsDeleting(true);
    // Route-guard mark + optimistic removal from both list caches, before the
    // network call, so the row leaves instantly and the header can navigate away.
    let snap = preRemoved;
    if (!snap) {
      snap = await snapshotLists();
      removeRows([sessionId], snap);
    }
    try {
      // Raw fetch promise — NOT observer-tied, so it settles after the unmount.
      await api.deleteSession(sessionId);
      // Success: drop the per-session caches (#1902; #2556 optimistic-bubble store).
      queryClient.removeQueries({ queryKey: queryKeys.session(sessionId) });
      queryClient.removeQueries({ queryKey: queryKeys.messages(sessionId) });
      queryClient.removeQueries({
        queryKey: queryKeys.optimisticMessages(sessionId),
      });
    } catch (err) {
      // Failure: roll the row back and toast with a back-link to the session.
      restoreRows(snap);
      showToast("Failed to delete session", {
        type: "error",
        ...viewSessionToastAction(),
      });
      throw err;
    } finally {
      // Always clear the route-guard mark + reconcile from the server.
      setIsDeleting(false);
      clearActionPending(sessionId, "delete");
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.federationAllSessions,
      });
    }
  };

  const deleteSession = (): Promise<void> => runDeleteSession();

  // "Disconnect & Delete" on a LIVE session (#3516 follow-up). The archive is the
  // slow half — it kills the CLI process — and the old `await archive; await
  // delete` sequence only removed the row inside the delete step, so the row sat
  // in the list for the whole archive. Remove + mark FIRST, then archive, then
  // delete. Uses the raw `api.archiveSession` (not `archiveMutation`) for the
  // same reason the delete core does: the header navigates away before this
  // resolves, and an observer-tied `mutateAsync` is abandoned on unmount.
  const archiveAndDeleteSession = async (): Promise<void> => {
    if (!api || !sessionId) {
      throw new Error("Session unavailable");
    }
    setIsDeleting(true);
    const snap = await snapshotLists();
    removeRows([sessionId], snap);
    try {
      await api.archiveSession(sessionId);
    } catch (err) {
      // The archive failed, so the session is still live and undeletable: put
      // the row back, drop the mark, and toast with a back-link.
      restoreRows(snap);
      setIsDeleting(false);
      clearActionPending(sessionId, "delete");
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.federationAllSessions,
      });
      showToast("Failed to disconnect session", {
        type: "error",
        ...viewSessionToastAction(),
      });
      throw err;
    }
    await runDeleteSession(snap);
  };

  const deleteSessionCascade = async (): Promise<void> => {
    if (!api || !sessionId) {
      throw new Error("Session unavailable");
    }
    setIsDeleting(true);
    await queryClient.cancelQueries({ queryKey: queryKeys.session(sessionId) });
    const snap = await snapshotLists();
    const { prevSessions, prevFederation } = snap;

    // Same descendant walk the "Delete all (N)" count uses (#2480), so the
    // removed set equals the cascade set exactly.
    const unique = dedupeById([
      ...(prevSessions?.sessions ?? []),
      ...(prevFederation?.sessions ?? []),
    ]);
    const descendantIds = findDescendantIds(sessionId, unique);
    const ids = Array.from(new Set([sessionId, ...descendantIds]));
    const activeDescendantIds = unique
      .filter(s => descendantIds.includes(s.id) && s.active)
      .map(s => s.id);

    // Optimistic removal from BOTH list caches + the route-guard / refetch mark
    // for every removed session. Cleared for the whole set in the finally.
    removeRows(ids, snap);

    try {
      // Archive active descendants (raw api — survives the unmount), then chunk
      // the bulk-delete by the 100-id server cap. Per-descendant archive failures
      // are swallowed (a still-active descendant comes back as `skipped` below).
      const skipped: string[] = [];
      for (const id of activeDescendantIds) {
        try {
          await api.archiveSession(id);
        } catch (err) {
          console.warn(
            `[useSessionActions] Failed to archive descendant ${id}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
      for (let i = 0; i < ids.length; i += 100) {
        const res = await api.bulkDeleteSessions(ids.slice(i, i + 100));
        skipped.push(...res.skipped);
      }
      const skippedSet = new Set(skipped);
      // Drop the per-session caches only for the ids the server actually deleted.
      for (const id of ids) {
        if (skippedSet.has(id)) continue;
        queryClient.removeQueries({ queryKey: queryKeys.session(id) });
        queryClient.removeQueries({ queryKey: queryKeys.messages(id) });
        queryClient.removeQueries({
          queryKey: queryKeys.optimisticMessages(id),
        });
      }
      // Partial failure: the server kept some rows (still-active / unknown). The
      // call RESOLVED, so without this those rows would only reappear on the
      // finally's refetch — restore EXACTLY the skipped rows now and toast (R3).
      if (skipped.length > 0) {
        const restoreSessions =
          prevSessions?.sessions.filter(s => skippedSet.has(s.id)) ?? [];
        if (restoreSessions.length > 0) {
          queryClient.setQueryData<SessionsResponse>(
            queryKeys.sessions,
            cur => {
              if (!cur) return cur;
              const have = new Set(cur.sessions.map(s => s.id));
              const add = restoreSessions.filter(s => !have.has(s.id));
              return add.length === 0
                ? cur
                : { ...cur, sessions: [...cur.sessions, ...add] };
            }
          );
        }
        const restoreFederation =
          prevFederation?.sessions.filter(s => skippedSet.has(s.id)) ?? [];
        if (restoreFederation.length > 0) {
          queryClient.setQueryData<FederationAllSessionsResponse>(
            queryKeys.federationAllSessions,
            cur => {
              if (!cur) return cur;
              const have = new Set(cur.sessions.map(s => s.id));
              const add = restoreFederation.filter(s => !have.has(s.id));
              return add.length === 0
                ? cur
                : { ...cur, sessions: [...cur.sessions, ...add] };
            }
          );
        }
        const n = skipped.length;
        showToast(`${n} session${n === 1 ? "" : "s"} could not be deleted`, {
          type: "error",
          ...viewSessionToastAction(),
        });
      }
    } catch (err) {
      // Full failure: roll the whole optimistic removal back + toast (R3/R4).
      restoreRows(snap);
      showToast("Failed to delete sessions", {
        type: "error",
        ...viewSessionToastAction(),
      });
      throw err;
    } finally {
      setIsDeleting(false);
      for (const id of ids) clearActionPending(id, "delete");
      await queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.federationAllSessions,
      });
    }
  };

  return {
    abortSession: abortMutation.mutateAsync,
    archiveSession: archiveMutation.mutateAsync,
    reconnectSession: reconnectMutation.mutateAsync,
    branchSession: branchMutation.mutateAsync,
    switchSession: switchMutation.mutateAsync,
    setPermissionMode: permissionMutation.mutateAsync,
    setModelMode: modelMutation.mutateAsync,
    setSessionEffort: effortMutation.mutateAsync,
    setSessionRawModel: rawModelMutation.mutateAsync,
    setMcpDesired: mcpMutation.mutateAsync,
    relaunchSession: relaunchMutation.mutateAsync,
    renameSession: renameMutation.mutateAsync,
    setEmoji: emojiMutation.mutateAsync,
    setNeedsReviewOverride: needsReviewOverrideMutation.mutateAsync,
    setAutoRecoverFromApiError: autoRecoverFromApiErrorMutation.mutateAsync,
    deleteSession,
    deleteSessionCascade,
    archiveAndDeleteSession,
    isPending:
      abortMutation.isPending ||
      archiveMutation.isPending ||
      reconnectMutation.isPending ||
      branchMutation.isPending ||
      switchMutation.isPending ||
      permissionMutation.isPending ||
      modelMutation.isPending ||
      mcpMutation.isPending ||
      relaunchMutation.isPending ||
      renameMutation.isPending ||
      emojiMutation.isPending ||
      needsReviewOverrideMutation.isPending ||
      autoRecoverFromApiErrorMutation.isPending ||
      isDeleting,
    isReconnecting: reconnectMutation.isPending,
    isBranching: branchMutation.isPending,
    isArchiving: archiveMutation.isPending,
    isDeleting,
  };
}
