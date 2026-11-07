// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useRef } from "react";
import {
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  FederationAllSessionsResponse,
  MessagesResponse,
  SessionResponse,
  SessionSummary,
  SessionsResponse,
  SyncEvent,
} from "@/types/api";
import { queryKeys } from "@/lib/query-keys";
import { upsertMessagesInCache } from "@/lib/messages";
import { parseSseStream } from "@/lib/sse-stream";
import { updateLastSeenSeq } from "@/lib/seq-tracker";
import { errorReporter } from "@/lib/error-reporter";
import {
  isKeepaliveOnlyUpdate,
  isKeepaliveShaped,
  patchSessionActiveAt,
  patchSessionDetailActiveAt,
} from "@/lib/sessionHeartbeat";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

/** The caches a `session-updated` event can make stale. */
function sessionCacheKeys(sessionId: string) {
  return [
    queryKeys.sessions,
    queryKeys.federationAllSessions,
    queryKeys.session(sessionId),
  ];
}

function isSessionCacheFetching(
  queryClient: QueryClient,
  sessionId: string
): boolean {
  return sessionCacheKeys(sessionId).some(
    queryKey => queryClient.isFetching({ queryKey, exact: true }) > 0
  );
}

/**
 * Invalidate the lists any session change can make stale. The federation list
 * is included because the SSE bridge forwards session events from remote
 * nodes, so thinking/active changes for remote sessions must refresh it too.
 * File claims are included because a session's death auto-releases its claims
 * (File Conflict Monitor #1971); `["file-claims"]` prefix-matches every
 * per-repo `["file-claims", repo]` query (queryKeys.fileClaims).
 */
function invalidateSessionLists(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
  void queryClient.invalidateQueries({
    queryKey: queryKeys.federationAllSessions,
  });
  void queryClient.invalidateQueries({ queryKey: ["file-claims"] });
}

/** The response to a changed session: invalidate the lists and claims, refetch the detail. */
function refetchAfterSessionChange(
  queryClient: QueryClient,
  sessionId: string
): void {
  invalidateSessionLists(queryClient);
  void queryClient.refetchQueries({ queryKey: queryKeys.session(sessionId) });
}

/**
 * Issue #6208: decide what a `session-updated` event needs.
 *
 * - "refetch": not a keepalive, or a value differs from the cache.
 * - "absorbed": every cached copy already shows what the keepalive carries;
 *   only a newer `activeAt` was written (when it moved by ≥ 20 s).
 * - "deferred": a keepalive arrived while one of the session's caches was
 *   refetching. It is held in `pending` and re-checked against what that fetch
 *   lands (see {@link recheckPendingKeepalives}). Invalidating here instead would
 *   cancel and restart the in-flight fetch on every keepalive; with keepalives
 *   arriving faster than a fetch completes, the lists never land and every tab
 *   refetches continuously (measured in Edge on the SL7: 927 of 927 keepalives
 *   in 30 s, 1,878 list requests, create page 9 s).
 */
function classifySessionUpdate(
  queryClient: QueryClient,
  pending: Map<string, unknown>,
  sessionId: string,
  data: unknown
): "refetch" | "absorbed" | "deferred" {
  if (!isKeepaliveShaped(data)) {
    // The refetch this event triggers supersedes any keepalive still held.
    pending.delete(sessionId);
    return "refetch";
  }
  if (isSessionCacheFetching(queryClient, sessionId)) {
    pending.set(sessionId, data);
    return "deferred";
  }
  // Decided now, so a keepalive still held is superseded. One can outlive its
  // fetch: a cancel with revert settles it with neither success nor error.
  pending.delete(sessionId);
  return applyKeepaliveIfUnchanged(queryClient, sessionId, data)
    ? "absorbed"
    : "refetch";
}

/**
 * Re-check keepalives held while a fetch was in flight, once none of their
 * session's caches is still fetching. A keepalive the landed data agrees with
 * is absorbed; one it contradicts (the fetch started before a newer change)
 * takes the refetch path, so a superseded response cannot stick.
 */
function recheckPendingKeepalives(
  queryClient: QueryClient,
  pending: Map<string, unknown>
): void {
  for (const [sessionId, data] of [...pending]) {
    if (isSessionCacheFetching(queryClient, sessionId)) continue;
    pending.delete(sessionId);
    if (!applyKeepaliveIfUnchanged(queryClient, sessionId, data)) {
      refetchAfterSessionChange(queryClient, sessionId);
    }
  }
}

/**
 * Absorb a keepalive without a refetch when every cached copy of the session
 * already shows what it carries: only a newer `activeAt` is written into the
 * caches (and only when it moved by ≥ 20 s). Returns false, touching nothing,
 * when anything differs.
 */
function applyKeepaliveIfUnchanged(
  queryClient: QueryClient,
  sessionId: string,
  data: unknown
): boolean {
  const local = queryClient.getQueryData<SessionsResponse>(queryKeys.sessions);
  const federation = queryClient.getQueryData<FederationAllSessionsResponse>(
    queryKeys.federationAllSessions
  );
  const rows = [local, federation]
    .map(list => list?.sessions.find(session => session.id === sessionId))
    .filter((row): row is SessionSummary => row !== undefined);
  if (rows.length === 0) return false;
  const detail = queryClient.getQueryData<SessionResponse>(
    queryKeys.session(sessionId)
  );
  if (!rows.every(row => isKeepaliveOnlyUpdate(data, row, detail?.session))) {
    return false;
  }

  const activeAt = (data as { activeAt: number }).activeAt;
  // Write only when a patch helper returns a new object: an unchanged cache
  // is left alone so its observers are not notified at all. An `activeAt`
  // patch is not a fetch, so it replaces `data` and nothing else. setQueryData
  // would dispatch a fetch success: status "success", error cleared,
  // `dataUpdatedAt` moved. That would hide a failed list fetch (the error
  // banner, and the update auto-reload's "lists are known" check) and push back
  // the list polls, which count from the last real fetch (msUntilPollDue).
  const patch = <T>(queryKey: readonly unknown[], next: T) =>
    queryClient
      .getQueryCache()
      .find({ queryKey, exact: true })
      ?.setState({ data: next });
  const nextLocal = patchSessionActiveAt(local, sessionId, activeAt);
  if (nextLocal !== local) {
    patch(queryKeys.sessions, nextLocal);
  }
  const nextFederation = patchSessionActiveAt(federation, sessionId, activeAt);
  if (nextFederation !== federation) {
    patch(queryKeys.federationAllSessions, nextFederation);
  }
  const nextDetail = patchSessionDetailActiveAt(detail, activeAt);
  if (nextDetail !== detail) {
    patch(queryKeys.session(sessionId), nextDetail);
  }
  return true;
}

type SSESubscription = {
  all?: boolean;
  sessionId?: string;
  machineId?: string;
};

function buildEventsUrl(
  baseUrl: string,
  token: string,
  subscription: SSESubscription
): string {
  const params = new URLSearchParams();
  params.set("token", token);
  if (subscription.all) {
    params.set("all", "true");
  }
  if (subscription.sessionId) {
    params.set("sessionId", subscription.sessionId);
  }
  if (subscription.machineId) {
    params.set("machineId", subscription.machineId);
  }

  const path = `/api/events?${params.toString()}`;
  try {
    return new URL(path, baseUrl).toString();
  } catch {
    return path;
  }
}

/** Backoff delays in milliseconds: 1s, 2s, 4s, 8s, 16s, 30s cap */
const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

/**
 * Issue #6208 (R9): a stream that stayed up at least this long counts as a
 * healthy connection, so a later mid-read failure reconnects from the base
 * delay. A shorter-lived stream that fails mid-read keeps backing off, so that
 * loop cannot reconnect (and resync) every second. This applies to the error
 * path only: a stream that ends normally, or arrives with no body, always
 * reconnects from the base delay.
 */
const STABLE_STREAM_MS = 30_000;

function getBackoffDelay(attempt: number): number {
  return BACKOFF_DELAYS[Math.min(attempt, BACKOFF_DELAYS.length - 1)] ?? 30000;
}

export function useSSE(options: {
  enabled: boolean;
  token: string;
  baseUrl: string;
  subscription?: SSESubscription;
  onEvent: (event: SyncEvent) => void;
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onError?: (error: unknown) => void;
  onAuthError?: () => void;
  getToken?: () => string;
}): void {
  const queryClient = useQueryClient();
  const onEventRef = useRef(options.onEvent);
  const onConnectRef = useRef(options.onConnect);
  const onDisconnectRef = useRef(options.onDisconnect);
  const onErrorRef = useRef(options.onError);
  const onAuthErrorRef = useRef(options.onAuthError);
  const getTokenRef = useRef(options.getToken);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Issue #2854: state-preserving fast reconnect on the browser `online` event.
  // - connectedRef: true only while a stream is actively connected, so the
  //   `online` handler skips recovery for a healthy session (R2).
  // - reconnectTimerRef: the pending backoff timer, retained so `online` can
  //   clear it and reconnect immediately instead of waiting out the growing
  //   backoff (up to 30s) after an outage (R1).
  // - attemptControllerRef: a per-attempt AbortController so a fresh connect()
  //   (whether from the backoff timer or `online`) supersedes any in-flight
  //   attempt — aborting a hung dead-TCP fetch — guaranteeing exactly one
  //   active stream (R4) instead of no-op'ing behind the hang.
  const connectedRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    onEventRef.current = options.onEvent;
  }, [options.onEvent]);

  useEffect(() => {
    onErrorRef.current = options.onError;
  }, [options.onError]);

  useEffect(() => {
    onConnectRef.current = options.onConnect;
  }, [options.onConnect]);

  useEffect(() => {
    onDisconnectRef.current = options.onDisconnect;
  }, [options.onDisconnect]);

  useEffect(() => {
    onAuthErrorRef.current = options.onAuthError;
  }, [options.onAuthError]);

  useEffect(() => {
    getTokenRef.current = options.getToken;
  }, [options.getToken]);

  const subscription = options.subscription ?? {};
  const subscriptionKey = useMemo(() => {
    return `${subscription.all ? "1" : "0"}|${subscription.sessionId ?? ""}|${subscription.machineId ?? ""}`;
  }, [subscription.all, subscription.sessionId, subscription.machineId]);

  useEffect(() => {
    if (!options.enabled) {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    const { signal } = controller;

    // Issue #6208: keepalives held while their session's caches were fetching,
    // re-checked whenever a fetch lands (success or error).
    const pendingKeepalives = new Map<string, unknown>();
    const unsubscribeQueryCache = queryClient
      .getQueryCache()
      .subscribe(cacheEvent => {
        if (pendingKeepalives.size === 0 || cacheEvent.type !== "updated") {
          return;
        }
        const action = cacheEvent.action.type;
        if (action !== "success" && action !== "error") return;
        recheckPendingKeepalives(queryClient, pendingKeepalives);
      });

    const handleSyncEvent = (event: SyncEvent) => {
      if (event.type === "message-received") {
        // Track highest seen seq for backfill on reconnect
        const seq = event.message?.seq;
        if (typeof seq === "number") {
          updateLastSeenSeq(event.sessionId, seq);
        }

        queryClient.setQueryData<InfiniteData<MessagesResponse>>(
          queryKeys.messages(event.sessionId),
          data => upsertMessagesInCache(data, [event.message])
        );
        // Mark stale so the initial query still fetches history when it mounts.
        void queryClient.invalidateQueries({
          queryKey: queryKeys.messages(event.sessionId),
          refetchType: "none",
        });
      }

      // Issue #6208: the server re-sends every live session about every
      // 10–12 s. A keepalive the cache already matches is absorbed (only
      // activeAt moves); one that arrives while a list or detail fetch is in
      // flight is held and re-checked when that fetch lands
      // (recheckPendingKeepalives). Either way the refetches below are
      // skipped: they would change nothing on screen but re-render the whole
      // chat. The rest of this handler, including the onEvent callback at the
      // end, still runs.
      const skipRefetchForKeepalive =
        event.type === "session-updated" &&
        classifySessionUpdate(
          queryClient,
          pendingKeepalives,
          event.sessionId,
          event.data
        ) !== "refetch";

      if (
        !skipRefetchForKeepalive &&
        (event.type === "session-added" ||
          event.type === "session-updated" ||
          event.type === "session-removed")
      ) {
        invalidateSessionLists(queryClient);
        if ("sessionId" in event) {
          if (event.type === "session-removed") {
            pendingKeepalives.delete(event.sessionId);
            void queryClient.removeQueries({
              queryKey: queryKeys.session(event.sessionId),
            });
            void queryClient.removeQueries({
              queryKey: queryKeys.messages(event.sessionId),
            });
            // Issue #2556: drop the client-only optimistic bubble store for a
            // removed session so no stale sending/failed bubbles linger.
            void queryClient.removeQueries({
              queryKey: queryKeys.optimisticMessages(event.sessionId),
            });
          } else {
            // Use refetchQueries instead of invalidateQueries to force immediate
            // refetch. This ensures session.thinking state updates propagate
            // immediately to the timer, preventing premature timer stops.
            void queryClient.refetchQueries({
              queryKey: queryKeys.session(event.sessionId),
            });
          }
        }
      }

      if (event.type === "machine-updated") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.machines });
      }

      // Issue #2700: a scheduled task was created / deleted / executed server-side.
      // Refetch schedules so the list reflects it live, AND sessions so a session
      // spawned by a now-deleted one-shot schedule re-homes into the main list
      // (SessionListContainer's knownScheduleIds predicate) without a remount.
      if (event.type === "schedule-changed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      }

      // Issue #1325: server-backed queue change. Refetch the affected
      // session's queue. We also invalidate sessions in case a queue-depth
      // badge appears in the list view (PR can stay optimistic until the
      // next refetch lands).
      if (event.type === "queue-changed" && "sessionId" in event) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.queue(event.sessionId),
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      }

      if (event.type === "mcp-status-updated") {
        const projectDir = (event.data as { projectDir?: string } | undefined)
          ?.projectDir;
        void queryClient.invalidateQueries({
          queryKey: queryKeys.mcpStatus(projectDir),
        });
      }

      // Issue #989 follow-up: live-update the batch coordinator snapshot
      // for the affected session. Subscribers (StatusBar, MCP indicator)
      // pull this from the query cache.
      if (event.type === "mcp-batch-progress") {
        queryClient.setQueryData(queryKeys.mcpBatchState(event.sessionId), {
          snapshot: event.data,
        });
      }

      // Issue #933: Surface federation spawn failures immediately. Issue #2150:
      // the hub now stamps the caller's namespace, so this actually arrives;
      // the stub store path stays, and the outcome is ALSO re-emitted as a
      // window CustomEvent (K-4497-1 §4, the `hapi:spawnFailed` pattern below).
      if (event.type === "federation-spawn-failed") {
        const {
          nodeId,
          nodeLabel,
          directory,
          spawnCorrelationId,
          error,
          code,
        } = event;
        // Dynamically import to avoid circular dependency
        import("@/lib/pending-spawns").then(({ handleSpawnFailed }) => {
          handleSpawnFailed({
            nodeId,
            directory,
            spawnCorrelationId,
            error,
            code,
            nodeLabel,
          });
        });
        window.dispatchEvent(
          new CustomEvent("hapi:federationSpawnFailed", {
            detail: {
              nodeId,
              spawnCorrelationId: spawnCorrelationId ?? undefined,
              error,
              code,
            },
          })
        );
        void queryClient.invalidateQueries({
          queryKey: queryKeys.federationAllSessions,
        });
      }

      // Issue #2150 (K-4497-1 §2/§4): a federation spawn this hub proxied
      // succeeded and the hub's cache already holds the session.
      if (event.type === "federation-spawn-succeeded") {
        const { spawnCorrelationId } = event;
        // Clear the stub by correlation id: a worktree or clone spawn runs in
        // another directory than the stub recorded, so the poll would never
        // match it and its TTL would raise a false failure toast.
        import("@/lib/pending-spawns").then(({ handleSpawnSucceeded }) => {
          handleSpawnSucceeded({ spawnCorrelationId });
        });
        window.dispatchEvent(
          new CustomEvent("hapi:federationSpawnSucceeded", {
            detail: {
              nodeId: event.nodeId,
              spawnCorrelationId: event.spawnCorrelationId,
              sessionId: event.sessionId,
            },
          })
        );
        void queryClient.invalidateQueries({
          queryKey: queryKeys.federationAllSessions,
        });
      }

      // Issue #1565: LOCAL-path background spawn failure (Option B). The server
      // already flipped the spawning placeholder to lifecycleState="failed" (and
      // embedded the error in metadata.summary); invalidate the session lists so
      // it renders immediately instead of waiting for the next poll (R2). Distinct
      // from federation-spawn-failed (which drives the remote client-stub store).
      if (event.type === "spawn-failed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.federationAllSessions,
        });
        // Issue #3515: re-emit as a window CustomEvent so the mounted
        // SpawningSessionView (at /sessions/<placeholderId>) can drive the
        // optimistic-spawn return-to-Create with code-specific copy immediately,
        // rather than waiting for the invalidated list refetch to flip the
        // placeholder to lifecycleState:"failed" (its poll-visible backstop).
        // Sibling of the tool-error / account-unrefreshable dispatches above.
        window.dispatchEvent(
          new CustomEvent("hapi:spawnFailed", {
            detail: {
              sessionId: event.sessionId,
              directory: event.directory,
              error: event.error,
              code: event.code,
            },
          })
        );
      }

      // Issue #1119 / #1892 (Sub H2): server-authoritative midnight reset. The
      // legacy `useTimeLogReset` listener (and `useAllSessionTimers`) were deleted
      // with the client timer surface in H2; this direct invalidation of all
      // "time-log*" query keys is now the sole path that refreshes the time-log
      // modal at 0:00.
      if (event.type === "timer-reset" && "sessionId" in event) {
        void queryClient.invalidateQueries({
          predicate: query => {
            const key = query.queryKey;
            return (
              Array.isArray(key) &&
              typeof key[0] === "string" &&
              key[0].startsWith("time-log")
            );
          },
        });
      }

      // TODO(#4912): remove with Sub B's (#4914) legacy SyncEvents — since #4915
      // nothing listens for this CustomEvent; NotificationListener reads the
      // `notification` event instead.
      if (event.type === "tool-error") {
        const data = (event as { data?: unknown }).data as
          | { toolName?: string; toolUseId?: string; errorContent?: string }
          | undefined;
        if (data?.toolName && typeof data.errorContent === "string") {
          window.dispatchEvent(
            new CustomEvent("hapi:toolError", {
              detail: {
                sessionId: event.sessionId,
                toolName: data.toolName,
                toolUseId: data.toolUseId,
                errorContent: data.errorContent,
              },
            })
          );
        } else {
          // Issue #1078 hardening: surface incomplete payloads instead of dropping silently.
          // Issue #1107: `event.type === "tool-error"` narrows to the SessionChangedSchema
          // variant where `sessionId: z.string()` is guaranteed — the previous
          // `"sessionId" in event ? event.sessionId : null` ternary was redundant.
          console.warn(
            "[useSSE] tool-error event missing toolName/errorContent; toast suppressed",
            { sessionId: event.sessionId, data }
          );
        }
      }

      // TODO(#4912): remove with Sub B's (#4914) legacy SyncEvents — since #4915
      // nothing listens for this CustomEvent; NotificationListener reads the
      // `notification` event instead.
      if (event.type === "prompt-blocked") {
        // Issue #1348: UserPromptSubmit hook block — sibling to tool-error.
        const data = (event as { data?: unknown }).data as
          | {
              hookEvent?: string;
              blockedReason?: string;
              originalPrompt?: string;
              // #3579: optional catalogue title + ISO instant for the toast.
              title?: string;
              at?: string;
            }
          | undefined;
        if (data?.hookEvent && typeof data.blockedReason === "string") {
          window.dispatchEvent(
            new CustomEvent("hapi:promptBlocked", {
              detail: {
                sessionId: event.sessionId,
                hookEvent: data.hookEvent,
                blockedReason: data.blockedReason,
                originalPrompt: data.originalPrompt,
                title: data.title,
                at: data.at,
              },
            })
          );
        } else {
          // Issue #1348 hardening (mirrors #1078 / #1107 pattern above):
          // surface incomplete payloads instead of dropping silently.
          console.warn(
            "[useSSE] prompt-blocked event missing hookEvent/blockedReason; toast suppressed",
            { sessionId: event.sessionId, data }
          );
        }
      }

      // TODO(#4912): remove with Sub B's (#4914) legacy SyncEvents — since #4915
      // nothing listens for this CustomEvent; NotificationListener reads the
      // `notification` event instead.
      // Issue #1233 (Epic #1231): Anthropic API error — sibling of tool-error /
      // prompt-blocked. Payload is NESTED (locked contract LC-1): read
      // event.data.* and re-emit a typed hapi:apiError CustomEvent that
      // ApiErrorToastListener consumed (retired by #4915).
      if (event.type === "api-error") {
        const data = (event as { data?: unknown }).data as
          | {
              phase?: "retrying" | "exhausted" | "recovered" | "give-up";
              errorType?: string;
              retryAttempt?: number;
              maxRetries?: number;
              requestId?: string;
            }
          | undefined;
        if (data?.phase && data.errorType) {
          window.dispatchEvent(
            new CustomEvent("hapi:apiError", {
              detail: {
                sessionId: event.sessionId,
                phase: data.phase,
                errorType: data.errorType,
                retryAttempt: data.retryAttempt,
                maxRetries: data.maxRetries,
                requestId: data.requestId,
              },
            })
          );
        } else {
          // Hardening parallel to #1078/#1348: surface incomplete payloads
          // instead of dropping silently.
          console.warn(
            "[useSSE] api-error event missing phase/errorType; toast suppressed",
            { sessionId: event.sessionId, data }
          );
        }
      }

      // TODO(#4912): remove with Sub B's (#4914) legacy SyncEvents — since #4915
      // nothing listens for this CustomEvent; NotificationListener reads the
      // `notification` event instead.
      // Issue #1531: bound account became unrefreshable mid token-refresh restart.
      // Sibling of tool-error / prompt-blocked — dispatch a window CustomEvent that
      // the AccountUnrefreshableToastListener consumed (retired by #4915).
      // event.type narrows to the variant where sessionId + accountUuid are strings.
      if (event.type === "account-unrefreshable") {
        window.dispatchEvent(
          new CustomEvent("hapi:accountUnrefreshable", {
            detail: {
              sessionId: event.sessionId,
              accountUuid: event.accountUuid,
              // Issue #4461 (R7/R8): the node whose store refused — stamped by
              // the server (the hub's bridge for a peer, GET /api/events for the
              // serving node), so the toast names it without guessing.
              nodeId: event.nodeId,
              nodeLabel: event.nodeLabel,
            },
          })
        );
      }

      // TODO(#4912): remove with Sub B's (#4914) legacy SyncEvents — since #4915
      // nothing listens for this CustomEvent; NotificationListener reads the
      // `notification` event instead.
      // Issue #1532: token-refresh restart failed BOTH respawn and rollback. The
      // session is disconnected but RECONNECTABLE. Sibling of account-unrefreshable
      // (#1531) — dispatch a window CustomEvent that the SessionRestartFailedToast-
      // Listener consumed (retired by #4915). event.type narrows to the
      // variant where sessionId + accountUuid + error are strings.
      if (event.type === "session-restart-failed") {
        window.dispatchEvent(
          new CustomEvent("hapi:sessionRestartFailed", {
            detail: {
              sessionId: event.sessionId,
              accountUuid: event.accountUuid,
              error: event.error,
            },
          })
        );
      }

      // TODO(#4912): remove with Sub B's (#4914) legacy SyncEvents — since #4915
      // nothing listens for this CustomEvent; NotificationListener reads the
      // `notification` event instead.
      // Issue #2453 (Task 14, R6): a reconnect auto-resumed the loops paused on
      // disconnect. Sibling of session-restart-failed — dispatch a window
      // CustomEvent the LoopsResumingToastListener consumed (retired by #4915).
      if (event.type === "loops-resuming") {
        window.dispatchEvent(
          new CustomEvent("hapi:loopsResuming", {
            detail: {
              sessionId: event.sessionId,
              count: event.count,
              pausedAtMs: event.pausedAtMs,
            },
          })
        );
      }

      // TODO(#4912): remove with Sub B's (#4914) legacy SyncEvents — since #4915
      // nothing listens for this CustomEvent; NotificationListener reads the
      // `notification` event instead.
      // Issue #2301 (Task 5, R4): a reconnect or account-switch spawn is polling
      // for a free session slot (capacity throttle). Sibling of loops-resuming —
      // dispatch a window CustomEvent the WaitingForSlotToastListener consumed
      // (retired by #4915). Advisory only — no early return (control still
      // reaches onEvent below).
      if (event.type === "waiting-for-slot") {
        window.dispatchEvent(
          new CustomEvent("hapi:waitingForSlot", {
            detail: {
              sessionId: event.sessionId,
              context: event.context,
              elapsedMs: event.elapsedMs,
              deadlineMs: event.deadlineMs,
            },
          })
        );
      }

      // Issue #4915 (epic #4912, Sub C): a notification row was created,
      // coalesced, read or dismissed. Re-emit the stored row as a window
      // CustomEvent; NotificationListener (App.tsx, inside ToastProvider)
      // updates the inbox cache and decides whether it pops up. No early return
      // — control still reaches onEventRef.current(event) below.
      if (event.type === "notification") {
        window.dispatchEvent(
          new CustomEvent("hapi:notification", { detail: event.notification })
        );
      }
      if (event.type === "notifications-cleared") {
        window.dispatchEvent(
          new CustomEvent("hapi:notificationsCleared", {
            detail: { dismissedAt: event.dismissedAt },
          })
        );
      }

      // Issue #3018: host-global chat-sections invalidation. Dispatch a payload-free
      // window CustomEvent that useChatSectionPrefs consumes to refetch the
      // authoritative preference and adopt() it (no PUT). Deliberately NO early
      // return — control must still reach onEventRef.current(event) below so the
      // general onEvent callback fires for this event exactly like every other (R4).
      if (event.type === "chat-sections-changed") {
        window.dispatchEvent(new CustomEvent("hapi:chat-sections-changed"));
      }

      // Issue #3446 (Sub A, K5): a source machine uploaded its config archive to a
      // porter one-liner's upload leg. Re-emit as a window CustomEvent the export
      // card listens for (→ an immediate status refetch: waiting → received) —
      // NO second EventSource. Namespace-gated server-side (shouldSend), so this
      // only ever fires in the minting operator's own browser. No early return —
      // control still reaches onEventRef.current(event) below.
      if (event.type === "porter-token-received") {
        window.dispatchEvent(
          new CustomEvent("hapi:porterTokenReceived", {
            detail: { token: event.token, stagingHandle: event.stagingHandle },
          })
        );
      }

      onEventRef.current(event);
    };

    const handleMessage = (data: string) => {
      if (typeof data !== "string") {
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }

      if (!isObject(parsed)) {
        return;
      }
      if (typeof parsed.type !== "string") {
        return;
      }

      handleSyncEvent(parsed as SyncEvent);
    };

    const connect = async (attempt: number = 0) => {
      if (signal.aborted) return;

      // Issue #2854: clear any pending backoff so an `online`-driven connect(0)
      // fires immediately (R1), and supersede any in-flight attempt — aborting a
      // hung dead-TCP fetch — so exactly one stream is ever active (R4).
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      attemptControllerRef.current?.abort();
      const attemptController = new AbortController();
      attemptControllerRef.current = attemptController;
      const attemptSignal = attemptController.signal;
      connectedRef.current = false;

      // Get the latest token before each connection attempt
      const currentToken = getTokenRef.current?.() || options.token;
      const url = buildEventsUrl(options.baseUrl, currentToken, subscription);
      // Issue #6208 (R9): when this attempt's stream stayed up long enough to
      // count as healthy, a later mid-read failure is a fresh outage and
      // reconnects from the base delay, not from this attempt's backoff step.
      let connectedAt: number | null = null;

      try {
        const response = await fetch(url, {
          signal: attemptSignal,
          headers: {
            Accept: "text/event-stream",
          },
        });

        if (attemptSignal.aborted) return;

        // Auth failure — stop reconnecting
        if (response.status === 401 || response.status === 403) {
          onAuthErrorRef.current?.();
          return;
        }

        // Non-200 — treat as transient, reconnect with backoff
        if (!response.ok) {
          connectedRef.current = false;
          onErrorRef.current?.(
            new Error(`SSE connection failed: HTTP ${response.status}`)
          );
          onDisconnectRef.current?.("error");
          scheduleReconnect(attempt);
          return;
        }

        // Connected — notify, and note when, so a later mid-read failure can
        // tell a stable stream from a flapping one (STABLE_STREAM_MS).
        onConnectRef.current?.();
        connectedRef.current = true;
        connectedAt = Date.now();

        const body = response.body;
        if (!body) {
          // No body — treat as stream end, reconnect
          connectedRef.current = false;
          onDisconnectRef.current?.("closed");
          scheduleReconnect(0);
          return;
        }

        const reader = body.getReader();

        // If the attempt is aborted while reading, cancel the reader
        const onAbort = () => {
          reader.cancel().catch(() => {});
        };
        attemptSignal.addEventListener("abort", onAbort, { once: true });

        try {
          await parseSseStream(reader, {
            onEvent: handleMessage,
          });
        } finally {
          attemptSignal.removeEventListener("abort", onAbort);
        }

        // Stream ended normally — reconnect from the base delay (backoff reset)
        connectedRef.current = false;
        if (!attemptSignal.aborted) {
          onDisconnectRef.current?.("closed");
          scheduleReconnect(0);
        }
      } catch (error: unknown) {
        if (attemptSignal.aborted) return;

        // Network error or AbortError (incl. an `online`-superseded attempt)
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        connectedRef.current = false;
        onErrorRef.current?.(error);
        onDisconnectRef.current?.("error");
        const stayedUp =
          connectedAt !== null && Date.now() - connectedAt >= STABLE_STREAM_MS;
        scheduleReconnect(stayedUp ? 0 : attempt);
      }
    };

    const scheduleReconnect = (attempt: number) => {
      if (signal.aborted) return;

      if (attempt > 0) {
        errorReporter.report({
          message: `SSE reconnection attempt ${attempt + 1}`,
          category: "sse-reconnect",
          severity: "warn",
          context: `backoff=${getBackoffDelay(attempt)}ms`,
        });
      }

      const delay = getBackoffDelay(attempt);
      // Issue #2854: retain the timer so an `online` event can clear it and
      // reconnect immediately instead of waiting out the backoff (R1).
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (!signal.aborted) {
          void connect(attempt + 1);
        }
      }, delay);
    };

    // Issue #2854: force an immediate, state-preserving reconnect when the
    // browser reports it is back online — but ONLY while the stream is bad
    // (connectedRef === false), never during a healthy session (R2). connect(0)
    // clears the pending backoff and supersedes any hung in-flight attempt, so
    // a dead-TCP fetch left over from the outage is aborted and replaced (R1)
    // rather than waited out, and exactly one stream survives (R4).
    const onOnline = () => {
      if (connectedRef.current) return;
      void connect(0);
    };
    window.addEventListener("online", onOnline);

    void connect(0);

    return () => {
      window.removeEventListener("online", onOnline);
      unsubscribeQueryCache();
      pendingKeepalives.clear();
      controller.abort();
      attemptControllerRef.current?.abort();
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    };
  }, [
    options.baseUrl,
    options.enabled,
    options.token,
    subscriptionKey,
    queryClient,
  ]);
}
