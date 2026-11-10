// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef } from "react";
import {
  hashKey,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  PIN_LIST_MAX_LIMIT,
  PinGetResponseSchema,
  PinListResponseSchema,
  PinMutationResponseSchema,
  PinSaveResponseSchema,
  PinSubmissionResponseSchema,
  type Pin,
  type PinDeadlineRequest,
  type PinMutationResponse,
  type PinSubmissionRequest,
  type PinSubmissionResponse,
} from "@hapi/protocol";
import { ApiError, type ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import { patchOpenPinCount, subscribePinChanges } from "@/lib/pinEvents";

/**
 * #6449: a session's pins as the Pins page reads them. `unavailable` means the
 * pins gate is closed (the server answers a plain 404) or the owning node has
 * no pin routes (`peerUnsupported: true`); it is data, not an error, so it is
 * never retried and never read as "session gone".
 */
export type PinsData =
  | { kind: "unavailable" }
  | {
      kind: "ready";
      pins: Pin[];
      hasMore: boolean;
      openPinCount: number;
      /**
       * #6452: the operator's Time Log zone from the owning node, or null when
       * none is set (`resolvePinZone` then uses the browser's).
       */
      timeZone?: string | null;
    };

/**
 * #6450: one pin, as a chat card reads it. `missing`: the session has no pin
 * with that key, so the fence stays an ordinary code block. `unavailable`: the
 * gate is closed or the owning node has no pin routes.
 */
export type PinRecordData =
  | { kind: "ready"; pin: Pin; openPinCount: number; timeZone?: string | null }
  | { kind: "missing" }
  | { kind: "unavailable" };

/** 30 s: `pin-changed` events and the reconnect refetch keep it fresh. */
export const PINS_STALE_TIME_MS = 30_000;
/** A left page's list (up to 500 full records) leaves memory after a minute. */
export const PINS_GC_TIME_MS = 60_000;

async function fetchPins(
  api: ApiClient,
  sessionId: string,
  signal?: AbortSignal
): Promise<PinsData> {
  try {
    // Validated here, in the code-split Pins chunk, so the schemas stay out
    // of the main bundle (see the PWA precache limit in vite.config.ts).
    const res = PinListResponseSchema.parse(
      await api.listSessionPins(sessionId, {
        limit: PIN_LIST_MAX_LIMIT,
        signal,
      })
    );
    if (res.peerUnsupported === true) return { kind: "unavailable" };
    return {
      kind: "ready",
      pins: res.pins,
      hasMore: res.hasMore,
      openPinCount: res.openPinCount,
      timeZone: res.timeZone ?? null,
    };
  } catch (error) {
    // Never through classifySessionLoadFailure: a closed gate's 404 is not a
    // missing session, and that path would clear the saved route.
    if (error instanceof ApiError && error.status === 404) {
      return { kind: "unavailable" };
    }
    throw error;
  }
}

async function fetchPinRecord(
  api: ApiClient,
  sessionId: string,
  key: string
): Promise<PinRecordData> {
  try {
    const res = PinGetResponseSchema.parse(
      await api.getSessionPin(sessionId, key)
    );
    return {
      kind: "ready",
      pin: res.pin,
      openPinCount: res.openPinCount,
      timeZone: res.timeZone ?? null,
    };
  } catch (error) {
    if (isMissingPin(error)) return { kind: "missing" };
    if (
      error instanceof ApiError &&
      (error.status === 404 || error.status === 501)
    ) {
      return { kind: "unavailable" };
    }
    throw error;
  }
}

/** Past this many changed pins in one burst, one list fetch is cheaper. */
export const PIN_CHANGE_FETCH_MAX = 20;

function isMissingPin(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 404 &&
    (error.body ?? "").includes("Pin not found")
  );
}

// ── One sync owner per session ──────────────────────────────────────────────

/**
 * #6450: every pin-data mount of a session shares ONE `pin-changed` handler. The
 * coalescer calls every handler of a session, so a handler per mount (the Pins
 * page, the Submit dialog, each chat card) turned a burst of k keys into N×k
 * reads, and the list refetches that followed cost one owner 47% of a core
 * (`docs/internal/architecture/sync.md`). Per query client, so tests and a
 * second app instance never share an owner.
 */
type SyncOwner = {
  count: number;
  /** The newest mount's client, so a token refresh never strands the handler. */
  api: ApiClient | null;
  stop: () => void;
};

const owners = new WeakMap<QueryClient, Map<string, SyncOwner>>();

export type PinsSyncHandle = {
  setApi: (api: ApiClient | null) => void;
  release: () => void;
};

/**
 * Join a session's pin sync; the first join subscribes and the last release
 * unsubscribes. On a burst of changed keys the owner reads each key once and
 * writes the result to the list (when loaded) and to that key's own cache (when
 * present), and drops a "Pin not found" key from both. It falls back to one list
 * refetch for a large burst, a list that is loading or not loaded, a list
 * written while the reads ran, or a failed read; while a list fetch is running
 * it refetches once that fetch lands rather than restarting it, because a steady
 * stream of changes on a slow link would otherwise keep the list from landing.
 */
export function acquirePinsSync(
  queryClient: QueryClient,
  sessionId: string,
  api: ApiClient | null
): PinsSyncHandle {
  let byClient = owners.get(queryClient);
  if (!byClient) owners.set(queryClient, (byClient = new Map()));
  let owner = byClient.get(sessionId);
  if (!owner) {
    const created: SyncOwner = { count: 0, api, stop: () => {} };
    created.stop = startSync(queryClient, sessionId, created);
    byClient.set(sessionId, created);
    owner = created;
  }
  owner.count += 1;
  owner.api = api ?? owner.api;
  const joined = owner;
  const registry = byClient;
  let released = false;
  return {
    setApi: next => {
      if (!released && next) joined.api = next;
    },
    release: () => {
      if (released) return;
      released = true;
      joined.count -= 1;
      if (joined.count > 0) return;
      registry.delete(sessionId);
      joined.stop();
    },
  };
}

function startSync(
  queryClient: QueryClient,
  sessionId: string,
  owner: SyncOwner
): () => void {
  const cache = queryClient.getQueryCache();
  const listKey = queryKeys.pins(sessionId);
  const recordKey = (key: string) => queryKeys.pin(sessionId, key);
  // The newest request per key: a slower, older response never lands.
  const requestSeq = new Map<string, number>();
  // Queries whose running fetch started before a change: refetch once it lands.
  const afterLanding = new Set<string>();
  let disposed = false;
  let burstsInFlight = 0;

  // A hash lookup: `cache.find` walks every cached query, and a burst does a few
  // lookups per changed key.
  const find = (queryKey: QueryKey) => cache.get(hashKey(queryKey));
  const isFetching = (queryKey: QueryKey) =>
    find(queryKey)?.state.fetchStatus === "fetching";
  const updatedAt = (queryKey: QueryKey) =>
    queryClient.getQueryState(queryKey)?.dataUpdatedAt;
  // Only a cached query is refetched, and only an observed one fetches now;
  // an unobserved one is just marked stale for its next mount.
  const refetch = (queryKey: QueryKey) => {
    const query = find(queryKey);
    if (!query) return;
    if (query.state.fetchStatus === "fetching") {
      afterLanding.add(query.queryHash);
      return;
    }
    void queryClient.invalidateQueries({ queryKey, exact: true });
  };

  const unsubscribeCache = cache.subscribe(event => {
    if (event.type !== "updated") return;
    if (!afterLanding.has(event.query.queryHash)) return;
    const action = event.action.type;
    if (action !== "success" && action !== "error") return;
    afterLanding.delete(event.query.queryHash);
    void queryClient.invalidateQueries({
      queryKey: event.query.queryKey,
      exact: true,
    });
  });

  const unsubscribeChanges = subscribePinChanges(sessionId, keys => {
    const api = owner.api;
    const recordKeys = keys.filter(key => find(recordKey(key)));
    if (!api || keys.length > PIN_CHANGE_FETCH_MAX) {
      refetch(listKey);
      for (const key of recordKeys) refetch(recordKey(key));
      return;
    }
    const listUsable =
      queryClient.getQueryData<PinsData>(listKey)?.kind === "ready" &&
      !isFetching(listKey);
    if (!listUsable) refetch(listKey);
    const usableRecords = new Set<string>();
    for (const key of recordKeys) {
      if (isFetching(recordKey(key))) refetch(recordKey(key));
      else usableRecords.add(key);
    }
    const readKeys = keys.filter(key => listUsable || usableRecords.has(key));
    if (readKeys.length === 0) return;

    // The caches as these reads saw them. If anything else writes one before
    // they land (a fetch, a star or mark-seen response), their pins may be older
    // than what is cached; refetch it instead of writing them.
    const seenList = updatedAt(listKey);
    const seenRecords = new Map(
      [...usableRecords].map(key => [key, updatedAt(recordKey(key))])
    );
    const reads = readKeys.map(key => {
      const seq = (requestSeq.get(key) ?? 0) + 1;
      requestSeq.set(key, seq);
      // Parse inside the chain, so a malformed response counts as a failed
      // read (→ one refetch), never an unhandled rejection.
      return api
        .getSessionPin(sessionId, key)
        .then(raw => PinGetResponseSchema.parse(raw))
        .then(
          res => ({ key, seq, res, error: null as unknown }),
          (error: unknown) => ({ key, seq, res: null, error })
        );
    });
    burstsInFlight += 1;
    void Promise.all(reads).then(results => {
      burstsInFlight -= 1;
      if (disposed) return;
      const fresh = results.filter(r => requestSeq.get(r.key) === r.seq);

      for (const r of fresh) {
        if (!usableRecords.has(r.key)) continue;
        const queryKey = recordKey(r.key);
        if (!find(queryKey)) continue;
        if (updatedAt(queryKey) !== seenRecords.get(r.key)) {
          refetch(queryKey);
        } else if (r.res) {
          queryClient.setQueryData<PinRecordData>(queryKey, {
            kind: "ready",
            pin: r.res.pin,
            openPinCount: r.res.openPinCount,
            timeZone: r.res.timeZone ?? null,
          });
        } else if (isMissingPin(r.error)) {
          queryClient.setQueryData<PinRecordData>(queryKey, {
            kind: "missing",
          });
        } else {
          refetch(queryKey);
        }
      }

      if (!listUsable) return;
      if (isFetching(listKey) || updatedAt(listKey) !== seenList) {
        refetch(listKey);
        return;
      }
      const updates = new Map<string, Pin>();
      const removed = new Set<string>();
      let openPinCount: number | undefined;
      let failed = false;
      for (const r of fresh) {
        if (r.res) {
          updates.set(r.key, r.res.pin);
          openPinCount = r.res.openPinCount;
        } else if (isMissingPin(r.error)) {
          removed.add(r.key);
        } else {
          failed = true;
        }
      }
      if (updates.size > 0 || removed.size > 0) {
        queryClient.setQueryData<PinsData>(listKey, prev => {
          if (prev?.kind !== "ready") return prev;
          const pins = prev.pins
            .filter(p => !removed.has(p.key))
            .map(p => updates.get(p.key) ?? p);
          for (const [key, pin] of updates) {
            if (!prev.pins.some(p => p.key === key)) pins.push(pin);
          }
          return {
            ...prev,
            pins,
            openPinCount: openPinCount ?? prev.openPinCount,
          };
        });
      }
      if (failed) refetch(listKey);
    });
  });

  // The reconnect only marks pin caches stale (App.tsx); the Pins page
  // refetches its own list, so this refetches the observed chat cards.
  // Past PIN_CHANGE_FETCH_MAX observed cards (the chat is not virtualized), one
  // list read seeds them all instead of a request per card on every reconnect.
  const onConnect = () => {
    const observed = cache
      .findAll({ queryKey: queryKeys.pins(sessionId) })
      .filter(q => q.queryKey[2] === "pin" && q.getObserversCount() > 0);
    if (observed.length === 0) return;
    const refetchEach = (queries: typeof observed) => {
      for (const q of queries) {
        void queryClient.refetchQueries({ queryKey: q.queryKey, exact: true });
      }
    };
    const api = owner.api;
    if (!api || observed.length <= PIN_CHANGE_FETCH_MAX) {
      refetchEach(observed);
      return;
    }
    void fetchPins(api, sessionId).then(
      data => {
        if (disposed) return;
        if (data.kind !== "ready") {
          refetchEach(observed);
          return;
        }
        const byKey = new Map(data.pins.map(pin => [pin.key, pin]));
        const unread: typeof observed = [];
        for (const q of observed) {
          const pin = byKey.get(q.queryKey[3] as string);
          if (pin) {
            queryClient.setQueryData<PinRecordData>(q.queryKey, {
              kind: "ready",
              pin,
              openPinCount: data.openPinCount,
              timeZone: data.timeZone ?? null,
            });
          } else if (data.hasMore) {
            // The list stops at 500: absence there proves nothing.
            unread.push(q);
          } else {
            queryClient.setQueryData<PinRecordData>(q.queryKey, {
              kind: "missing",
            });
          }
        }
        refetchEach(unread);
      },
      () => {
        if (!disposed) refetchEach(observed);
      }
    );
  };
  window.addEventListener("hapi:sseConnected", onConnect);

  return () => {
    disposed = true;
    unsubscribeChanges();
    unsubscribeCache();
    window.removeEventListener("hapi:sseConnected", onConnect);
    // Changes still being applied are dropped with the owner. Mark the
    // session's pin caches stale so they are not lost: the next visit loads
    // them fresh, even within the stale time.
    if (burstsInFlight > 0 || afterLanding.size > 0) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.pins(sessionId),
      });
    }
  };
}

/** Join the session's pin sync while mounted and enabled. */
function usePinsSync(
  api: ApiClient | null,
  sessionId: string,
  enabled: boolean
): void {
  const queryClient = useQueryClient();
  const apiRef = useRef(api);
  const handle = useRef<PinsSyncHandle | null>(null);
  // Declared first, so the join below sees this render's client.
  useEffect(() => {
    apiRef.current = api;
    handle.current?.setApi(api);
  }, [api]);
  const hasApi = api !== null;
  useEffect(() => {
    if (!hasApi || !enabled) return;
    const joined = acquirePinsSync(queryClient, sessionId, apiRef.current);
    handle.current = joined;
    return () => {
      handle.current = null;
      joined.release();
    };
  }, [hasApi, enabled, queryClient, sessionId]);
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * The pins list, for the Pins page and the Submit dialog. Never mount it in the
 * chat: a list is up to 500 records (the tab badge reads `openPinCount` from the
 * session detail, and chat cards read their own pin with `usePinRecord`).
 */
export function usePins(
  api: ApiClient | null,
  sessionId: string,
  enabled: boolean
) {
  usePinsSync(api, sessionId, enabled);
  return useQuery({
    queryKey: queryKeys.pins(sessionId),
    queryFn: ({ signal }) => {
      if (!api) throw new Error("Session unavailable");
      return fetchPins(api, sessionId, signal);
    },
    enabled: Boolean(api) && enabled,
    staleTime: PINS_STALE_TIME_MS,
    gcTime: PINS_GC_TIME_MS,
  });
}

function recordFromList(
  queryClient: QueryClient,
  sessionId: string,
  key: string
): PinRecordData | undefined {
  const list = queryClient.getQueryData<PinsData>(queryKeys.pins(sessionId));
  if (list?.kind !== "ready") return undefined;
  const pin = list.pins.find(p => p.key === key);
  return pin
    ? {
        kind: "ready",
        pin,
        openPinCount: list.openPinCount,
        timeZone: list.timeZone ?? null,
      }
    : undefined;
}

/**
 * #6450: one pin by key, for a chat card. Seeded from the list when the list is
 * loaded (no request while it is fresh), kept current by the session's sync.
 */
export function usePinRecord(
  api: ApiClient | null,
  sessionId: string,
  key: string,
  enabled: boolean
) {
  const queryClient = useQueryClient();
  usePinsSync(api, sessionId, enabled);
  return useQuery({
    queryKey: queryKeys.pin(sessionId, key),
    queryFn: () => {
      if (!api) throw new Error("Session unavailable");
      return fetchPinRecord(api, sessionId, key);
    },
    enabled: Boolean(api) && enabled,
    staleTime: PINS_STALE_TIME_MS,
    gcTime: PINS_GC_TIME_MS,
    initialData: () => recordFromList(queryClient, sessionId, key),
    initialDataUpdatedAt: () =>
      queryClient.getQueryState(queryKeys.pins(sessionId))?.dataUpdatedAt,
  });
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Rewrite cached pins in the list and in their own caches in one pass, so the
 * Pins tab and a chat card never disagree. Only pins already cached are
 * rewritten; other pins keep their objects.
 */
function updateCachedPins(
  queryClient: QueryClient,
  sessionId: string,
  update: (pin: Pin) => Pin | undefined,
  keys: readonly string[],
  openPinCount?: number
): void {
  queryClient.setQueryData<PinsData>(queryKeys.pins(sessionId), prev => {
    if (prev?.kind !== "ready") return prev;
    let changed = false;
    const pins = prev.pins.map(p => {
      const next = keys.includes(p.key) ? update(p) : undefined;
      if (!next || next === p) return p;
      changed = true;
      return next;
    });
    if (!changed && openPinCount === undefined) return prev;
    return { ...prev, pins, openPinCount: openPinCount ?? prev.openPinCount };
  });
  for (const key of keys) {
    queryClient.setQueryData<PinRecordData>(
      queryKeys.pin(sessionId, key),
      prev => {
        if (prev?.kind !== "ready") return prev;
        const pin = update(prev.pin) ?? prev.pin;
        // Spread keeps the record's Time Log zone (#6452): without it a chat
        // card falls back to the device's zone after its first write.
        return {
          ...prev,
          pin,
          openPinCount: openPinCount ?? prev.openPinCount,
        };
      }
    );
  }
}

/** #6450: the one writer for server pins (star, mark-seen, Submit). */
export function writePinsToCaches(
  queryClient: QueryClient,
  sessionId: string,
  pins: readonly Pin[],
  openPinCount?: number
): void {
  const byKey = new Map(pins.map(pin => [pin.key, pin]));
  updateCachedPins(
    queryClient,
    sessionId,
    p => byKey.get(p.key),
    [...byKey.keys()],
    openPinCount
  );
}

/** A pin as cached, from its own cache first, then the list. */
function cachedPin(
  queryClient: QueryClient,
  sessionId: string,
  key: string
): Pin | undefined {
  const record = queryClient.getQueryData<PinRecordData>(
    queryKeys.pin(sessionId, key)
  );
  if (record?.kind === "ready") return record.pin;
  const list = queryClient.getQueryData<PinsData>(queryKeys.pins(sessionId));
  return list?.kind === "ready"
    ? list.pins.find(p => p.key === key)
    : undefined;
}

function setStarred(
  queryClient: QueryClient,
  sessionId: string,
  key: string,
  starred: boolean
): void {
  updateCachedPins(queryClient, sessionId, p => ({ ...p, starred }), [key]);
}

/**
 * Star or unstar a pin: flipped in the caches at once, rolled back if the
 * request fails, then replaced by the server's pin. Starring publishes a
 * `pin-changed` event, so other devices follow.
 */
export function useStarPin(api: ApiClient | null, sessionId: string) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (vars: { key: string; starred: boolean }) => {
      if (!api) throw new Error("Session unavailable");
      return PinMutationResponseSchema.parse(
        await api.setSessionPinStarred(sessionId, vars.key, vars.starred)
      );
    },
    onMutate: async vars => {
      // A fetch in flight would land the old star; cancel it now and run it
      // again once the star settles, so nothing it carried is lost.
      const queryKeysToGuard = [
        queryKeys.pins(sessionId),
        queryKeys.pin(sessionId, vars.key),
      ];
      const cancelled = queryKeysToGuard.filter(
        queryKey => queryClient.isFetching({ queryKey, exact: true }) > 0
      );
      await Promise.all(
        queryKeysToGuard.map(queryKey =>
          queryClient.cancelQueries({ queryKey, exact: true })
        )
      );
      const before = cachedPin(queryClient, sessionId, vars.key)?.starred;
      setStarred(queryClient, sessionId, vars.key, vars.starred);
      return { before, cancelled };
    },
    onError: (_error, vars, context) => {
      // Roll back this pin's star only: a whole-list snapshot would also undo
      // another pin starred, or updated, while this request was in flight.
      if (context?.before !== undefined) {
        setStarred(queryClient, sessionId, vars.key, context.before);
      }
    },
    onSuccess: res =>
      writePinsToCaches(queryClient, sessionId, [res.pin], res.openPinCount),
    onSettled: (_res, _error, _vars, context) => {
      for (const queryKey of context?.cancelled ?? []) {
        void queryClient.invalidateQueries({ queryKey, exact: true });
      }
    },
  });
  const { mutate } = mutation;
  return useCallback(
    (key: string, starred: boolean) => mutate({ key, starred }),
    [mutate]
  );
}

/**
 * #6455: dismiss a pin. Dismissing publishes a `pin-changed` event, so other
 * devices follow; the response pin is written into the caches at once so this
 * one does not wait for it. The caller handles a refusal (the thrown `ApiError`).
 */
export function useDismissPin(api: ApiClient | null, sessionId: string) {
  const queryClient = useQueryClient();
  const { mutateAsync } = useMutation({
    mutationFn: async (key: string) => {
      if (!api) throw new Error("Session unavailable");
      return PinMutationResponseSchema.parse(
        await api.dismissSessionPin(sessionId, key)
      );
    },
    onSuccess: res =>
      writePinsToCaches(queryClient, sessionId, [res.pin], res.openPinCount),
  });
  return mutateAsync;
}

/**
 * #6452: move, stop, or restart a pin's automatic pick. Not optimistic: the
 * server decides the range and the refusals, so the caches take its pin only
 * once it answers. The caller words a refusal with `pinDeadlineErrorMessage`.
 */
export function useSetPinDeadline(api: ApiClient | null, sessionId: string) {
  const queryClient = useQueryClient();
  const { mutateAsync, isPending } = useMutation({
    mutationFn: async (vars: { key: string; body: PinDeadlineRequest }) => {
      if (!api) throw new Error("Session unavailable");
      return PinMutationResponseSchema.parse(
        await api.setSessionPinDeadline(sessionId, vars.key, vars.body)
      );
    },
    onSuccess: res =>
      writePinsToCaches(queryClient, sessionId, [res.pin], res.openPinCount),
  });
  const setDeadline = useCallback(
    (key: string, body: PinDeadlineRequest): Promise<PinMutationResponse> =>
      mutateAsync({ key, body }),
    [mutateAsync]
  );
  return { setDeadline, isPending };
}

/** A failed deadline change in the server's words ("This pin is no longer open"). */
export function pinDeadlineErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const body = JSON.parse(error.body ?? "") as { error?: unknown };
      if (typeof body.error === "string" && body.error) return body.error;
    } catch {
      // Not JSON: fall through to the status.
    }
    return `The automatic pick could not be changed (HTTP ${error.status})`;
  }
  return error instanceof Error && error.message
    ? error.message
    : "The automatic pick could not be changed";
}

/**
 * #6453: "Save to session folder". The saved pin goes through
 * `writePinsToCaches`, the one writer for the list and record caches; the
 * `pin-changed` event that follows refetches it anyway. A refusal rejects with
 * the server's `ApiError`, whose body names the reason.
 */
export function useSavePinFiles(api: ApiClient | null, sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (key: string) => {
      if (!api) throw new Error("Session unavailable");
      return PinSaveResponseSchema.parse(
        await api.savePinFiles(sessionId, key)
      );
    },
    onSuccess: res =>
      writePinsToCaches(queryClient, sessionId, [res.pin], res.openPinCount),
  });
}

/**
 * Mark-seen requests already sent, per session: shared by every provider (the
 * Pins tab and each chat card), so one `key:revision` is sent once.
 */
const seenSent = new WeakMap<QueryClient, Map<string, Set<string>>>();

function seenSetFor(queryClient: QueryClient, sessionId: string): Set<string> {
  let bySession = seenSent.get(queryClient);
  if (!bySession) seenSent.set(queryClient, (bySession = new Map()));
  let set = bySession.get(sessionId);
  if (!set) bySession.set(sessionId, (set = new Set()));
  return set;
}

/**
 * Mark a pin's current revision seen, once per `key:revision` however often
 * the row re-renders, re-expands, or renders twice (A rate-limits pin writes to
 * 120 a minute per session). Mark-seen publishes no event, so the response pin
 * is written into the caches here. A failed request can be retried on the next
 * open.
 */
export function useMarkPinSeen(api: ApiClient | null, sessionId: string) {
  const queryClient = useQueryClient();
  const { mutate } = useMutation({
    mutationFn: async (vars: { key: string; id: string }) => {
      if (!api) throw new Error("Session unavailable");
      return PinMutationResponseSchema.parse(
        await api.markSessionPinSeen(sessionId, vars.key)
      );
    },
    onSuccess: res =>
      writePinsToCaches(queryClient, sessionId, [res.pin], res.openPinCount),
    // Mutation-level, not per-call: TanStack fires a `mutate(…, { onError })`
    // callback only for the latest call, so a second pin marked right after a
    // failing one would leave the failed id stuck in the set.
    onError: (_error, vars) => {
      seenSetFor(queryClient, sessionId).delete(vars.id);
    },
  });
  return useCallback(
    (pin: Pin) => {
      const id = `${pin.key}:${pin.revision}`;
      const sent = seenSetFor(queryClient, sessionId);
      if (sent.has(id)) return;
      sent.add(id);
      mutate({ key: pin.key, id });
    },
    [mutate, queryClient, sessionId]
  );
}

/**
 * #6450: send staged answers (or preview them with `dryRun`). Every pin the
 * server returns is written into the caches in one list update, and the session
 * badge follows the server's `openPinCount`. The caller handles refusals: the
 * thrown `ApiError` carries their `code`.
 */
export function useSubmitPinAnswers(api: ApiClient | null, sessionId: string) {
  const queryClient = useQueryClient();
  return useCallback(
    async (request: PinSubmissionRequest): Promise<PinSubmissionResponse> => {
      if (!api) throw new Error("Session unavailable");
      const res = PinSubmissionResponseSchema.parse(
        await api.submitPinAnswers(sessionId, request)
      );
      if (request.dryRun) return res;
      const pins = res.entries.flatMap(entry => (entry.pin ? [entry.pin] : []));
      if (pins.length > 0) {
        writePinsToCaches(queryClient, sessionId, pins, res.openPinCount);
      }
      patchOpenPinCount(queryClient, sessionId, res.openPinCount);
      return res;
    },
    [api, queryClient, sessionId]
  );
}
