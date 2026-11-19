// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6646, Task 10: the web's data layer for the billable switch.
 *
 * One rule governs every screen of this feature (plan, Phase B): the server's
 * state comes from `GET /api/version` (`billableSwitch`: `on`, `closed`, or
 * absent = `off`). The version query is read once per page life, so a bare 404
 * from a billable route (the server turned billable sessions off) or a 409
 * `billable_feature_closed` refetches it, and the person is told in words.
 *
 * The amount every confirmation shows goes through `unloggedAmount` (one swap
 * point, plan section 5); `useLoggedMinutes` is the provider #6204 replaces.
 */
import { useCallback, useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  BILLABLE_SWITCH_CAPABILITY,
  BILLABLE_SWITCH_CLOSED_CAPABILITY,
  LOCAL_NODE_ID,
  unloggedAmount,
} from "@hapi/protocol";
import {
  ApiError,
  type ApiClient,
  type BillableKeepAllResult,
  type BillableSwitchHeadersNode,
  type BillableSwitchSetResult,
} from "@/api/client";
import type {
  FederationAllSessionsResponse,
  SessionResponse,
  SessionsResponse,
} from "@/types/api";
import { queryKeys } from "@/lib/query-keys";
import {
  clearFederationOverride,
  setFederationOverride,
} from "@/lib/federation-mutation-overrides";
import { useToast } from "@/components/Toast";
import { useVersion } from "@/hooks/useVersion";
import { formatDuration } from "@/utils/duration";
import {
  elapsedWithLiveSegment,
  hasLiveSegment,
  type ElapsedSessionLike,
} from "@/utils/sessionElapsed";

// ─── the server's state ────────────────────────────────────────────────────

export type BillableSwitchMode = "on" | "closed" | "off";

/** The server's billable sessions state; `off` until the version read answers. */
export function useBillableSwitchMode(): BillableSwitchMode {
  const { data } = useVersion();
  return data?.billableSwitch ?? "off";
}

// ─── errors ────────────────────────────────────────────────────────────────

export type BillableErrorKind = "gate-off" | "closed" | "unsupported" | "other";

function parseBody(body: string | undefined): Record<string, unknown> | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * What a failed billable request means, in the words a person reads. A bare 404
 * (plain text, not a JSON error) is the gate answering while off; a 409 names
 * the node it is about, and the message names that node, not "this server".
 */
export function describeBillableError(err: unknown): {
  kind: BillableErrorKind;
  message: string;
} {
  if (err instanceof ApiError) {
    const body = parseBody(err.body);
    const nodeLabel =
      typeof body?.nodeLabel === "string" ? body.nodeLabel : null;
    if (err.status === 404 && body === null) {
      return {
        kind: "gate-off",
        message: "Billable sessions were turned off on this server.",
      };
    }
    if (err.code === "billable_feature_closed") {
      const where = nodeLabel ?? "this server";
      return {
        kind: "closed",
        message: `Billable sessions are closed on ${where}: sessions can be switched off, nothing can be switched on.`,
      };
    }
    if (err.code === "billable_feature_unsupported") {
      return {
        kind: "unsupported",
        message: nodeLabel
          ? `${nodeLabel} runs a Hapimatic without billable sessions.`
          : "That node runs a Hapimatic without billable sessions.",
      };
    }
    if (typeof body?.error === "string") {
      return { kind: "other", message: body.error };
    }
  }
  return {
    kind: "other",
    message: err instanceof Error ? err.message : "The billable switch failed.",
  };
}

/**
 * Map a failure, refetch the version when the server's state may have changed
 * (a bare 404 or a closed refusal), and return the message for the toast.
 */
export function handleBillableError(
  queryClient: QueryClient,
  err: unknown
): string {
  const described = describeBillableError(err);
  if (described.kind === "gate-off" || described.kind === "closed") {
    void queryClient.invalidateQueries({ queryKey: queryKeys.version });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.billableSwitchHeaders,
    });
  }
  return described.message;
}

// ─── the headers read ──────────────────────────────────────────────────────

/** Every node's billable project headers; read while the gate is on or closed. */
export function useBillableSwitchHeaders(api: ApiClient | null) {
  const mode = useBillableSwitchMode();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: queryKeys.billableSwitchHeaders,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      try {
        return await api.getBillableSwitchHeaders();
      } catch (err) {
        handleBillableError(queryClient, err);
        throw err;
      }
    },
    enabled: Boolean(api) && mode !== "off",
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * The headers-read entry of a project group's node. A group on an instance
 * without federation is keyed by the `LOCAL_NODE_ID` sentinel (`"local"`),
 * which maps to the response's `isLocal` entry.
 */
export function resolveHeaderNode(
  nodes: readonly BillableSwitchHeadersNode[] | undefined,
  groupNodeId: string
): BillableSwitchHeadersNode | null {
  if (!nodes) return null;
  if (groupNodeId === LOCAL_NODE_ID) {
    return nodes.find(n => n.isLocal) ?? null;
  }
  return nodes.find(n => n.nodeId === groupNodeId) ?? null;
}

/**
 * #6646 (ruling T-1, 2026-11-18, under D-1): what a person's start from the
 * Create form sends. A session a person starts is non-billable until that
 * person switches it on in the timer menu, so where billable sessions are on
 * and the target takes the switch it sends the explicit answer `not-billable`
 * (the start rule takes a person's answer before any header row). Everywhere
 * else it sends nothing: a target without the switch refuses an answer, and
 * with the gate off a session starts off anyway. `targetNodeId` is a peer's
 * node id, or `LOCAL_NODE_ID` for this server's machines.
 */
export function billableStartForCreate(input: {
  mode: BillableSwitchMode;
  headers: readonly BillableSwitchHeadersNode[] | undefined;
  targetNodeId: string;
}): { choice: "not-billable" } | undefined {
  if (input.mode !== "on") return undefined;
  const target = resolveHeaderNode(input.headers, input.targetNodeId);
  const targetOn = target ? target.on : input.targetNodeId === LOCAL_NODE_ID;
  return targetOn ? { choice: "not-billable" } : undefined;
}

// ─── which node owns a session, and what its gate allows ───────────────────

/** A node's gate as the web can read it: its tags, or this server's mode. */
export type BillableNodeGate = { on: boolean; closed: boolean };

/** The nodes the web knows: this server's id, and the federation list. */
export type BillableGateNodes = {
  localNodeId: string | null;
  remoteNodes: ReadonlyArray<{ nodeId: string; capabilities?: string[] }>;
};

/** True for a session of this server: no node id, the sentinel, or our own id. */
function isLocalSession(
  nodeId: string | null | undefined,
  nodes: BillableGateNodes
): boolean {
  return !nodeId || nodeId === LOCAL_NODE_ID || nodeId === nodes.localNodeId;
}

/**
 * The owning node's gate: this server's mode for a local session; the owning
 * node's `billable:switch*` tags for another node's; null for a node the
 * federation list does not hold.
 */
export function owningNodeGate(
  sessionNodeId: string | null | undefined,
  nodes: BillableGateNodes,
  mode: BillableSwitchMode
): BillableNodeGate | null {
  if (isLocalSession(sessionNodeId, nodes)) {
    return { on: mode === "on", closed: mode === "closed" };
  }
  const remote = nodes.remoteNodes.find(n => n.nodeId === sessionNodeId);
  if (!remote) return null;
  const tags = remote.capabilities ?? [];
  return {
    on: tags.includes(BILLABLE_SWITCH_CAPABILITY),
    closed: tags.includes(BILLABLE_SWITCH_CLOSED_CAPABILITY),
  };
}

/** What the timer menu's billable block offers (Task 11). */
export type BillableSwitchState =
  | "can-switch"
  | "off-only"
  | "unknown"
  | "unsupported";

type BillableSessionLike = {
  nodeId?: string | null;
  billable?: boolean;
  billableConfirm?: "pending" | null;
  lifecycleState?: string;
};

/**
 * `unknown` when the session carries no switch; `unsupported` when its node has
 * neither gate tag (or this server is off); `off-only` when its node or this
 * server is closed; else `can-switch`.
 */
export function billableSwitchState(
  session: BillableSessionLike,
  nodes: BillableGateNodes,
  mode: BillableSwitchMode
): BillableSwitchState {
  if (session.billable === undefined) return "unknown";
  if (mode === "off") return "unsupported";
  const owner = owningNodeGate(session.nodeId, nodes, mode);
  if (!owner || (!owner.on && !owner.closed)) return "unsupported";
  if (owner.closed || mode === "closed") return "off-only";
  return "can-switch";
}

/** True for a spawning or failed placeholder, which has no session row yet. */
export function isBillablePlaceholder(session: BillableSessionLike): boolean {
  return (
    session.lifecycleState === "spawning" || session.lifecycleState === "failed"
  );
}

/** The time block's mark (ROW-C): the coin, the waiting coin, the lock, or none. */
export type BillableMark = "coin" | "coin-pending" | "lock" | null;

/**
 * With the server's state `on` or `closed`: the coin for a billable session (the
 * waiting tone while it waits), the lock when its switch cannot be read, nothing
 * for a placeholder or a non-billable session. With `off`: only the read-only
 * coin of a billable session on a node whose gate is open (review P34).
 */
export function billableMark(
  session: BillableSessionLike,
  nodes: BillableGateNodes,
  mode: BillableSwitchMode
): BillableMark {
  if (isBillablePlaceholder(session)) return null;
  const coin = session.billableConfirm === "pending" ? "coin-pending" : "coin";
  if (mode === "off") {
    if (session.billable !== true) return null;
    const owner = owningNodeGate(session.nodeId, nodes, mode);
    return owner && (owner.on || owner.closed) ? coin : null;
  }
  if (session.billable === undefined) return "lock";
  return session.billable ? coin : null;
}

// ─── the amount (one swap point, plan section 5) ───────────────────────────

/**
 * The minutes each session already logged. Null for every id until the time
 * entry record (#6204) replaces this one provider.
 */
export function useLoggedMinutes(
  ids: readonly string[]
): Readonly<Record<string, number | null>> {
  const key = ids.join("\0");
  return useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const id of key ? key.split("\0") : []) out[id] = null;
    return out;
  }, [key]);
}

/** The session's timer, with the live segment while it thinks. */
export function billableTimerMs(
  session: ElapsedSessionLike,
  nowMs: number
): number {
  return elapsedWithLiveSegment(
    session.serverAccumulatedMs,
    hasLiveSegment(session),
    session.thinkingStartedAt,
    nowMs
  );
}

/** What switching the session would move into or out of billing. */
export function billableAmount(
  session: ElapsedSessionLike,
  nowMs: number,
  loggedMs: number | null
): { ms: number; loggedKnown: boolean } {
  return unloggedAmount({ timerMs: billableTimerMs(session, nowMs), loggedMs });
}

/** `billableAmount` with this session's logged minutes from the provider. */
export function useBillableAmount(
  session: ElapsedSessionLike & { id: string },
  nowMs: number
): { ms: number; loggedKnown: boolean } {
  const logged = useLoggedMinutes([session.id]);
  return billableAmount(session, nowMs, logged[session.id] ?? null);
}

// ─── the optimistic patch (pattern: useSessionActions.ts, auto-recover) ────

export type BillableFields = {
  billable: boolean;
  billableConfirm: "pending" | null;
};

type PrevFields = Map<string, BillableFields | undefined>;

function readFields(
  queryClient: QueryClient,
  id: string
): BillableFields | undefined {
  const pick = (s: {
    id: string;
    billable?: boolean;
    billableConfirm?: "pending" | null;
  }): BillableFields | undefined =>
    s.billable === undefined
      ? undefined
      : { billable: s.billable, billableConfirm: s.billableConfirm ?? null };
  const detail = queryClient.getQueryData<SessionResponse>(
    queryKeys.session(id)
  )?.session;
  if (detail) return pick(detail);
  const lists = [
    queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)?.sessions,
    queryClient.getQueryData<FederationAllSessionsResponse>(
      queryKeys.federationAllSessions
    )?.sessions,
  ];
  for (const list of lists) {
    const row = list?.find(s => s.id === id);
    if (row) return pick(row);
  }
  return undefined;
}

/**
 * Write the two fields into the session, the sessions list and the federation
 * list, and register the federation override so the next poll does not undo a
 * write the hub has not seen yet. Returns each session's fields before.
 */
export function patchBillableCaches(
  queryClient: QueryClient,
  patches: ReadonlyMap<string, BillableFields>
): PrevFields {
  const prev: PrevFields = new Map();
  for (const id of patches.keys()) prev.set(id, readFields(queryClient, id));
  const patchRow = <T extends { id: string }>(row: T): T => {
    const next = patches.get(row.id);
    return next ? { ...row, ...next } : row;
  };
  for (const [id, fields] of patches) {
    queryClient.setQueryData<SessionResponse>(queryKeys.session(id), old =>
      old?.session ? { ...old, session: { ...old.session, ...fields } } : old
    );
    setFederationOverride(id, { ...fields });
  }
  queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, old =>
    old ? { ...old, sessions: old.sessions.map(patchRow) } : old
  );
  queryClient.setQueryData<FederationAllSessionsResponse>(
    queryKeys.federationAllSessions,
    old => (old ? { ...old, sessions: old.sessions.map(patchRow) } : old)
  );
  return prev;
}

/** Put back the fields of `ids` as `prev` holds them, and drop their overrides. */
export function revertBillableCaches(
  queryClient: QueryClient,
  prev: PrevFields,
  ids: readonly string[]
): void {
  const back = new Map<string, BillableFields>();
  for (const id of ids) {
    clearFederationOverride(id);
    const fields = prev.get(id);
    if (fields) back.set(id, fields);
  }
  if (back.size === 0) return;
  patchBillableCaches(queryClient, back);
  for (const id of back.keys()) clearFederationOverride(id);
}

async function cancelSessionQueries(
  queryClient: QueryClient,
  ids: readonly string[]
): Promise<void> {
  await queryClient.cancelQueries({ queryKey: queryKeys.sessions });
  await queryClient.cancelQueries({
    queryKey: queryKeys.federationAllSessions,
  });
  for (const id of ids) {
    await queryClient.cancelQueries({ queryKey: queryKeys.session(id) });
  }
}

function reconcile(queryClient: QueryClient, ids: readonly string[]): void {
  for (const id of ids) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.session(id) });
  }
  void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
  void queryClient.invalidateQueries({
    queryKey: queryKeys.federationAllSessions,
    refetchType: "none",
  });
}

type PatchContext = { prev: PrevFields };

// ─── the writes ────────────────────────────────────────────────────────────

/** Switch one session billable or not (ROW-C, CONF-A). */
export function useSetSessionBillable(api: ApiClient | null) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  return useMutation<
    BillableSwitchSetResult,
    Error,
    { sessionId: string; billable: boolean },
    PatchContext
  >({
    mutationFn: async ({ sessionId, billable }) => {
      if (!api) throw new Error("API unavailable");
      return await api.setSessionBillable(sessionId, billable);
    },
    onMutate: async ({ sessionId, billable }) => {
      await cancelSessionQueries(queryClient, [sessionId]);
      return {
        prev: patchBillableCaches(
          queryClient,
          new Map([[sessionId, { billable, billableConfirm: null }]])
        ),
      };
    },
    onError: (err, { sessionId }, ctx) => {
      if (ctx) revertBillableCaches(queryClient, ctx.prev, [sessionId]);
      showToast(handleBillableError(queryClient, err), { type: "error" });
    },
    onSuccess: (result, { sessionId }) => {
      patchBillableCaches(
        queryClient,
        new Map([
          [
            sessionId,
            {
              billable: result.billable,
              billableConfirm: result.billableConfirm,
            },
          ],
        ])
      );
    },
    onSettled: (_r, _e, { sessionId }) => reconcile(queryClient, [sessionId]),
  });
}

/**
 * Runs `onDone` when a billable write succeeds, even when the component that
 * started it has left the screen first: a kept or reversed row leaves "To
 * confirm", and Keep all can empty the section.
 * TanStack Query drops the callbacks given to `mutate(vars, { onSuccess })`
 * once the calling component unmounts, but the promise of `mutateAsync`
 * always settles. A failure needs nothing here: the mutation's own `onError`
 * has already toasted why.
 */
export function afterBillableWrite<T>(
  write: Promise<T>,
  onDone: (result: T) => void
): void {
  write.then(onDone, () => {
    // The mutation's own error toast has said why.
  });
}

/** Keep or Reverse a waiting session (AGL-A). */
export function useBillableConfirm(api: ApiClient | null) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  return useMutation<
    BillableSwitchSetResult,
    Error,
    { sessionId: string; decision: "keep" | "reverse" },
    PatchContext
  >({
    mutationFn: async ({ sessionId, decision }) => {
      if (!api) throw new Error("API unavailable");
      return await api.confirmSessionBillable(sessionId, decision);
    },
    onMutate: async ({ sessionId, decision }) => {
      await cancelSessionQueries(queryClient, [sessionId]);
      return {
        prev: patchBillableCaches(
          queryClient,
          new Map([
            [
              sessionId,
              { billable: decision === "keep", billableConfirm: null },
            ],
          ])
        ),
      };
    },
    onError: (err, { sessionId }, ctx) => {
      if (ctx) revertBillableCaches(queryClient, ctx.prev, [sessionId]);
      showToast(handleBillableError(queryClient, err), { type: "error" });
    },
    onSettled: (_r, _e, { sessionId }) => reconcile(queryClient, [sessionId]),
  });
}

/**
 * Keep all: every listed waiting session is shown kept at once; a session the
 * server did not keep returns to waiting when the answer arrives.
 */
export function useKeepAllBillable(api: ApiClient | null) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  return useMutation<
    { ok: true; results: BillableKeepAllResult[] },
    Error,
    { ids: string[] },
    PatchContext
  >({
    mutationFn: async ({ ids }) => {
      if (!api) throw new Error("API unavailable");
      return await api.keepAllBillable(ids);
    },
    onMutate: async ({ ids }) => {
      await cancelSessionQueries(queryClient, ids);
      return {
        prev: patchBillableCaches(
          queryClient,
          new Map(
            ids.map(id => [id, { billable: true, billableConfirm: null }])
          )
        ),
      };
    },
    onError: (err, { ids }, ctx) => {
      if (ctx) revertBillableCaches(queryClient, ctx.prev, ids);
      showToast(handleBillableError(queryClient, err), { type: "error" });
    },
    onSuccess: (data, _vars, ctx) => {
      const notKept = data.results
        .filter(r => r.outcome !== "ok")
        .map(r => r.id);
      if (ctx && notKept.length > 0) {
        revertBillableCaches(queryClient, ctx.prev, notKept);
      }
    },
    onSettled: (_r, _e, { ids }) => reconcile(queryClient, ids),
  });
}

// ─── one session's switch, in its two homes (Task 11) ──────────────────────

/**
 * The nodes `owningNodeGate` reads: this server's id and each peer's tags, from
 * the federation nodes read (the title bar's node chip shares this cache). Not
 * fetched while nothing on the screen needs a peer's gate.
 */
export function useBillableGateNodes(
  api: ApiClient | null,
  enabled: boolean
): BillableGateNodes {
  const { data } = useQuery({
    queryKey: queryKeys.federationNodes,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getFederationNodes();
    },
    enabled: Boolean(api) && enabled,
    staleTime: 60000,
    retry: 1,
  });
  return useMemo(
    () => ({
      localNodeId: data?.localNode?.nodeId ?? null,
      remoteNodes: (data?.nodes ?? []).map(n => ({
        nodeId: n.config.id,
        capabilities: n.info?.capabilities,
      })),
    }),
    [data]
  );
}

/**
 * The one line the timer menu's block shows where its switch cannot be used
 * (Task 11): an older node, a node without billable sessions, or a closed one.
 * Null where the switch works. A node is named when the session is not this
 * server's; the gate is "billable sessions" in words a person reads (TERM-1).
 */
export function billableSwitchNote(
  state: BillableSwitchState,
  session: BillableSessionLike,
  nodes: BillableGateNodes,
  mode: BillableSwitchMode,
  nodeLabel: string | null | undefined
): string | null {
  const local = isLocalSession(session.nodeId, nodes);
  const node = nodeLabel || "its node";
  if (state === "unknown") {
    return local
      ? "This session's switch cannot be read here."
      : `${node} runs an older version, so its switch cannot be read here.`;
  }
  if (state === "unsupported") {
    return `Billable sessions are not enabled on ${local ? "this server" : node}.`;
  }
  if (state === "off-only" && session.billable !== true) {
    const owner = owningNodeGate(session.nodeId, nodes, mode);
    const remoteClosed = !local && owner?.closed === true;
    return `Billable sessions are closed on ${remoteClosed ? node : "this server"}.`;
  }
  return null;
}

/**
 * How a confirmation names its figure (one place, plan section 5): "on its
 * timer" until the time-entry record (#6204) knows what was logged, then "not
 * yet logged".
 */
export function billableAmountWords(
  amount: { ms: number; loggedKnown: boolean },
  direction: "on" | "off" = "on"
): string {
  const figure = formatDuration(amount.ms);
  if (amount.loggedKnown) return `${figure} not yet logged`;
  return direction === "on"
    ? `${figure} on its timer`
    : `${figure} tracked on its timer`;
}

/** What the switch, Keep or Reverse asks for. */
export type BillableSwitchRequest = "on" | "off" | "reverse";

/** The toast after a switch, Keep or Reverse; never "by you" (section 6). */
export function billableSwitchToast(
  kind: BillableSwitchRequest | "keep",
  sessionName: string,
  amount: { ms: number; loggedKnown: boolean }
): string {
  if (kind === "keep") return `${sessionName} kept billable`;
  if (kind === "on") {
    return amount.ms > 0
      ? `${sessionName} is billable · ${billableAmountWords(amount)} now counts`
      : `${sessionName} is billable`;
  }
  return amount.ms > 0
    ? `${sessionName} is non-billable · ${billableAmountWords(amount, "off")} will not be logged`
    : `${sessionName} is non-billable`;
}

/** A session as the switch's two homes hold it. */
export type BillableSwitchSession = BillableSessionLike &
  ElapsedSessionLike & { id: string; active?: boolean };

/** What the timer menu's billable block is given (Task 11). */
export type BillableTimerBlock = {
  billable: boolean | undefined;
  billableConfirm: "pending" | null;
  sessionName: string;
  switchState: BillableSwitchState;
  /** The line shown where the switch cannot be used; null where it can. */
  switchNote: string | null;
  onRequestBillable: (next: boolean) => void;
  onConfirm: (decision: "keep" | "reverse") => void;
};

/**
 * One session's billable switch for the row and the open session's header
 * (Task 11): its mark, the timer menu's block (absent while the server's state
 * is `off` and for a placeholder), and the confirmation the owner renders
 * beside it. A figure of zero switches at once; otherwise the switch only asks
 * for the dialog, which confirms with the figure frozen at that moment.
 */
export function useBillableSessionSwitch(input: {
  api: ApiClient | null;
  session: BillableSwitchSession;
  sessionName: string;
  nodeLabel?: string | null;
}): {
  mark: BillableMark;
  block: BillableTimerBlock | undefined;
  request: BillableSwitchRequest | null;
  closeRequest: () => void;
  confirmRequest: (amount: { ms: number; loggedKnown: boolean }) => void;
} {
  const { api, session, sessionName, nodeLabel } = input;
  const mode = useBillableSwitchMode();
  const nodes = useBillableGateNodes(
    api,
    mode !== "off" || session.billable === true
  );
  const { showToast } = useToast();
  const setBillable = useSetSessionBillable(api);
  const confirm = useBillableConfirm(api);
  const logged = useLoggedMinutes([session.id]);
  const [request, setRequest] = useState<BillableSwitchRequest | null>(null);

  const act = useCallback(
    (
      kind: BillableSwitchRequest | "keep",
      amount: { ms: number; loggedKnown: boolean }
    ) => {
      const toast = () =>
        showToast(billableSwitchToast(kind, sessionName, amount), {
          type: "success",
        });
      afterBillableWrite(
        kind === "keep" || kind === "reverse"
          ? confirm.mutateAsync({ sessionId: session.id, decision: kind })
          : setBillable.mutateAsync({
              sessionId: session.id,
              billable: kind === "on",
            }),
        toast
      );
    },
    [confirm, setBillable, session.id, sessionName, showToast]
  );

  const ask = useCallback(
    (kind: BillableSwitchRequest) => {
      const amount = billableAmount(
        session,
        Date.now(),
        logged[session.id] ?? null
      );
      if (amount.ms === 0) act(kind, amount);
      else setRequest(kind);
    },
    [act, logged, session]
  );

  const mark = billableMark(session, nodes, mode);
  const switchState = billableSwitchState(session, nodes, mode);
  const block: BillableTimerBlock | undefined =
    mode === "off" || isBillablePlaceholder(session)
      ? undefined
      : {
          billable: session.billable,
          billableConfirm: session.billableConfirm ?? null,
          sessionName,
          switchState,
          switchNote: billableSwitchNote(
            switchState,
            session,
            nodes,
            mode,
            nodeLabel
          ),
          onRequestBillable: next => ask(next ? "on" : "off"),
          onConfirm: decision =>
            decision === "keep"
              ? act("keep", { ms: 0, loggedKnown: false })
              : ask("reverse"),
        };

  return {
    mark,
    block,
    request,
    closeRequest: () => setRequest(null),
    confirmRequest: amount => {
      if (request) act(request, amount);
      setRequest(null);
    },
  };
}
