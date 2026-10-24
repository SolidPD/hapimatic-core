// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@/api/client";
import type { SpawnResponse } from "@/types/api";
import {
  useSpawnSession,
  type SpawnInput,
} from "@/hooks/mutations/useSpawnSession";
import { queryKeys } from "@/lib/query-keys";
import { randomUuid } from "@/lib/randomUuid";
import {
  addPendingSpawn,
  dismissPendingSpawn,
  isFederationSpawnPlaceholder,
  markSpawnFailed,
  type PendingSpawn,
} from "@/lib/pending-spawns";
import {
  awaitRemoteSpawn,
  type AwaitRemoteSpawnOptions,
  type RemoteSpawnWaiter,
} from "./remoteSpawnOutcome";

/**
 * Fan-out spawn (#3818 Slice 2, epic #4406 ruling D3 = A): from an existing
 * session (the parent), spawn N peers — on the hub's machines or (#4497) another
 * federation node — link each one to the parent (`parentSessionId` +
 * `parentRelationship: "spawn"`), and queue the same prompt to each. The
 * existing session-list grouping then renders the peers with the parent.
 *
 * - **One spawn path** — every peer goes through `useSpawnSession` (the create
 *   page's path: `ApiClient.spawnSession` for a hub machine, `spawnOnNode` for
 *   a node), never a parallel call.
 * - **Sequential, synchronous, no `claimPort`** — `claimPort` peers contend for
 *   the port-claim lock and the ten-port worktree pool, and the early-ack
 *   (`earlyReturn`) answer carries the session TAG while the queue route
 *   resolves by uuid (#4000 still open).
 * - **Queue, not the direct route** — the queue takes a session that is not
 *   active yet and drains on its idle edge. The `fanout:<parentId>:<uuid>`
 *   client id makes a retried enqueue a server-side no-op.
 * - **Every refusal is reported** with its class; the remaining peers still spawn.
 * - **Remote peers (#4497)** — a peer whose input names a `nodeId` spawns
 *   through the federation route. The hub answers it with an EMPTY session id,
 *   so the loop settles it on the hub's correlated outcome events
 *   (`remoteSpawnOutcome.ts`), then verifies/heals the parent link and queues
 *   the prompt exactly once. A peer the client cannot identify is never sent
 *   a prompt.
 */
export const FAN_OUT_MIN = 2;
export const FAN_OUT_MAX = 5;

/** The refusal classes a spawn can answer (directive Task 4); (e) and (f)
 *  come only from a remote node. */
export type FanOutRefusalClass =
  /** (a) the daemon cap — HTTP 409 `{ code: "at_capacity" }`. */
  | "at_capacity"
  /** (b) another worktree spawn holds the port-claim lock. */
  | "port_lock"
  /** (c) every worktree port is claimed. */
  | "port_pool"
  /** (d) #4370: the explicit `sourceBranch` base ref does not exist. */
  | "missing_base"
  /** (e) #4497: the remote node's default account needs sign-in. */
  | "account_unrefreshable"
  /** (f) #4497: the remote node's default account token expired. */
  | "account_token_expired"
  | "other";

export const REFUSAL_LABEL: Record<FanOutRefusalClass, string> = {
  at_capacity: "at capacity",
  port_lock: "port-claim lock busy",
  port_pool: "no free worktree port",
  missing_base: "base branch not found",
  account_unrefreshable: "the node's account needs sign-in",
  account_token_expired: "the node's account token expired",
  other: "refused",
};

/** The refusal codes a spawn answer can carry, by class. */
const CODED_REFUSALS: ReadonlySet<string> = new Set([
  "at_capacity",
  "account_unrefreshable",
  "account_token_expired",
]);

/** An account refusal: every later remote peer on that node would refuse too. */
function isAccountRefusal(refusal: FanOutRefusalClass): boolean {
  return (
    refusal === "account_unrefreshable" || refusal === "account_token_expired"
  );
}

export type FanOutPeerOutcome = {
  key: string;
  label: string;
  /** Where the worktree was cut from (worktree peers only). */
  cutFrom?: "parent-branch" | "repo-default";
  /** #4497: the federation node a remote peer was sent to. */
  nodeLabel?: string;
} & (
  | {
      status: "spawned";
      sessionId: string;
      prompt: { ok: true } | { ok: false; error: string };
      /** Set by {@link verifyParentLinks} (hub peers) or the remote branch
       *  (#4497); undefined = not verified. */
      linked?: boolean;
    }
  | { status: "refused"; refusal: FanOutRefusalClass; message: string }
  /** #4497: a remote peer the node never answered for — no prompt was queued. */
  | { status: "unconfirmed"; message: string }
);

/** Map a daemon refusal message (no code) to its class. Never matches on the
 *  cap message: the cap is identified by its `at_capacity` code only. */
export function classifyRefusalMessage(message: string): FanOutRefusalClass {
  if (/port-claim lock/i.test(message)) return "port_lock";
  if (/worktree ports .* are in use/i.test(message)) return "port_pool";
  if (/source branch .* not found/i.test(message)) return "missing_base";
  return "other";
}

/** #4497: a refusal's class — its code when it carries a known one, else the
 *  message (the daemon's port and base-branch refusals carry no code). */
export function classifyRefusal(
  code: string | undefined,
  message: string
): FanOutRefusalClass {
  if (code && CODED_REFUSALS.has(code)) return code as FanOutRefusalClass;
  return classifyRefusalMessage(message);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type FanOutCapacityNotice =
  | { kind: "none" }
  /** More peers than free slots: the extra spawns will be refused. */
  | {
      kind: "over";
      requested: number;
      free: number;
      effectiveCount: number;
      max: number;
    }
  /** Fits under the cap but past the recommended count. */
  | {
      kind: "above-recommended";
      requested: number;
      effectiveCount: number;
      recommended: number;
    };

/**
 * Capacity pre-flight (directive Task 4) — a WARNING, never the enforcement:
 * the daemon gate stays the only enforcement. A missing field is UNKNOWN —
 * no warning, no block.
 */
export function computeFanOutCapacity(
  requested: number,
  cap: {
    effectiveCount: number | null;
    max: number | null;
    recommended: number | null;
  }
): FanOutCapacityNotice {
  const { effectiveCount, max, recommended } = cap;
  if (effectiveCount == null || max == null) return { kind: "none" };
  const free = Math.max(0, max - effectiveCount);
  if (requested > free) {
    return { kind: "over", requested, free, effectiveCount, max };
  }
  if (recommended != null && effectiveCount + requested > recommended) {
    return {
      kind: "above-recommended",
      requested,
      effectiveCount,
      recommended,
    };
  }
  return { kind: "none" };
}

/** The parent a fan-out spawns from. `branch` = its current git branch, or
 *  null (detached HEAD, unreadable status, inactive session). `upstream` =
 *  its branch's upstream (`origin/<b>`), or null/absent when it has none. */
export type FanOutParent = {
  id: string;
  directory: string;
  branch: string | null;
  upstream?: string | null;
};

/**
 * #4497 R2: the branch a REMOTE worktree peer can be cut from. The node fetches
 * `origin <b>` and resolves `refs/remotes/origin/<b>`, so only a parent branch
 * whose upstream is on `origin` qualifies — and then by its upstream name.
 */
export function remoteCutBranch(
  upstream: string | null | undefined
): string | null {
  const m = upstream ? /^origin\/(.+)$/.exec(upstream) : null;
  return m ? m[1] : null;
}

/**
 * Turn one peer's create-page payload into the fan-out payload: parent link,
 * no `claimPort`, no early-ack, and — only for a worktree peer of the parent's
 * own repository whose branch is known — the cut point `sourceBranch`
 * (epic #4406 T27, #4370). A remote peer (#4497) is cut only from the parent's
 * `origin/<b>` upstream (see {@link remoteCutBranch}).
 */
export function buildPeerInput(
  base: SpawnInput,
  parent: FanOutParent
): { input: SpawnInput; cutFrom?: "parent-branch" | "repo-default" } {
  const isWorktree = base.sessionType === "worktree";
  const sameRepo = base.directory === parent.directory;
  const cutBranch = base.nodeId
    ? remoteCutBranch(parent.upstream)
    : parent.branch;
  const cutFromParent = isWorktree && sameRepo && !!cutBranch;
  const input: SpawnInput = {
    ...base,
    claimPort: false,
    earlyReturn: undefined,
    parentSessionId: parent.id,
    parentRelationship: "spawn",
    sourceBranch: cutFromParent ? (cutBranch ?? undefined) : undefined,
  };
  return {
    input,
    cutFrom: isWorktree
      ? cutFromParent
        ? "parent-branch"
        : "repo-default"
      : undefined,
  };
}

export type FanOutPeerRequest = {
  key: string;
  label: string;
  input: SpawnInput;
  cutFrom?: "parent-branch" | "repo-default";
  /** #4497: the target node's label (remote peers, i.e. `input.nodeId` set). */
  nodeLabel?: string;
};

/** #4497: one row of a node's session list, as the remote branch reads it. */
export type FanOutNodeSession = {
  id: string;
  parentSessionId?: string | null;
  /** The session's display name (`metadata.name`). */
  name?: string | null;
};

/** #4497: what the remote branch needs, injected so the tests can fake it. */
export type FanOutRemoteDeps = {
  newCorrelationId: () => string;
  addStub: (params: Omit<PendingSpawn, "id" | "state" | "createdAt">) => string;
  markStubFailed: (stubId: string, message: string) => void;
  dismissStub: (stubId: string) => void;
  awaitOutcome: (options: AwaitRemoteSpawnOptions) => RemoteSpawnWaiter;
  listNodeSessions: (nodeId: string) => Promise<FanOutNodeSession[]>;
  setParent: (sessionId: string, parentId: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
};

export type FanOutDeps = {
  spawn: (input: SpawnInput) => Promise<SpawnResponse>;
  enqueue: (
    sessionId: string,
    body: string,
    clientGeneratedId: string
  ) => Promise<unknown>;
  /** #4497: required to send a peer whose input names a `nodeId`. */
  remote?: FanOutRemoteDeps;
  /** #4497: called once per peer, in request order, as each one settles. */
  onOutcome?: (outcome: FanOutPeerOutcome) => void;
};

/** #4497: how long the remote branch looks for a spawned peer in its node's
 *  list before it heals the link blind (R4), and how it retries the enqueue
 *  while the hub's cache does not hold the session yet (R5). */
export const REMOTE_LINK_LOOKUP_MS = 30_000;
export const REMOTE_LINK_LOOKUP_EVERY_MS = 5_000;
export const REMOTE_ENQUEUE_RETRIES = 6;
export const REMOTE_ENQUEUE_RETRY_MS = 5_000;

/** The idempotency id of one peer's queued prompt (epic #4406 T35). */
export function fanOutClientId(parentId: string, peerId: string): string {
  return `fanout:${parentId}:${peerId}`;
}

/**
 * Spawn every peer IN SEQUENCE and queue the prompt to each one that spawned.
 * Never throws: a failed spawn is a `refused` outcome, a failed enqueue a
 * `prompt: { ok: false }` outcome, a remote peer the node never answered for
 * an `unconfirmed` outcome, and an unexpected throw while handling one peer
 * that peer's `refused` outcome (the remaining peers still run). Outcomes keep
 * the request order, and `deps.onOutcome` sees each one as soon as its peer
 * settles.
 */
export async function runFanOut(
  deps: FanOutDeps,
  parentId: string,
  prompt: string,
  peers: readonly FanOutPeerRequest[]
): Promise<FanOutPeerOutcome[]> {
  const outcomes: FanOutPeerOutcome[] = [];
  // #4497 R6: the node refused an earlier peer for its account.
  const accountRefusals = new Map<string, FanOutRefusalClass>();
  for (const peer of peers) {
    let outcome: FanOutPeerOutcome;
    try {
      outcome = peer.input.nodeId
        ? await spawnRemotePeer(deps, parentId, prompt, peer, accountRefusals)
        : await spawnLocalPeer(deps, parentId, prompt, peer);
    } catch (err) {
      // #4497: one peer's throw must not drop the outcomes already shown or
      // the peers still to come (the dialog would re-offer the whole batch).
      // Every step after a peer's request is sent catches its own errors, so
      // a throw here means the peer was never sent.
      console.error("[useFanOutSpawn] peer failed before it was sent", err);
      outcome = {
        key: peer.key,
        label: peer.label,
        cutFrom: peer.cutFrom,
        ...(peer.input.nodeId
          ? { nodeLabel: peer.nodeLabel ?? peer.input.nodeId }
          : {}),
        status: "refused",
        refusal: "other",
        message: `not sent — ${errorMessage(err)}`,
      };
    }
    outcomes.push(outcome);
    deps.onOutcome?.(outcome);
  }
  return outcomes;
}

async function spawnLocalPeer(
  deps: FanOutDeps,
  parentId: string,
  prompt: string,
  peer: FanOutPeerRequest
): Promise<FanOutPeerOutcome> {
  const head = { key: peer.key, label: peer.label, cutFrom: peer.cutFrom };
  let result: SpawnResponse;
  try {
    result = await deps.spawn(peer.input);
  } catch (err) {
    // The local route answers a capacity refusal as HTTP 409 with a code —
    // switch on the code, never on the message text.
    const refusal: FanOutRefusalClass =
      err instanceof ApiError && err.code === "at_capacity"
        ? "at_capacity"
        : classifyRefusalMessage(errorMessage(err));
    return {
      ...head,
      status: "refused",
      refusal,
      message: errorMessage(err),
    };
  }
  if (result.type !== "success" || !result.sessionId) {
    const message =
      result.type === "error"
        ? result.message
        : "The spawn did not return a session id";
    return {
      ...head,
      status: "refused",
      refusal: classifyRefusalMessage(message),
      message,
    };
  }
  const sessionId = result.sessionId;
  try {
    await deps.enqueue(sessionId, prompt, fanOutClientId(parentId, sessionId));
    return { ...head, status: "spawned", sessionId, prompt: { ok: true } };
  } catch (err) {
    return {
      ...head,
      status: "spawned",
      sessionId,
      prompt: { ok: false, error: errorMessage(err) },
    };
  }
}

/**
 * #4497: one remote peer — dispatch with a fresh correlation id, settle on the
 * hub's outcome events (or the stub store / list probe / timeout), then verify
 * and heal the parent link and queue the prompt exactly once.
 */
async function spawnRemotePeer(
  deps: FanOutDeps,
  parentId: string,
  prompt: string,
  peer: FanOutPeerRequest,
  accountRefusals: Map<string, FanOutRefusalClass>
): Promise<FanOutPeerOutcome> {
  const nodeId = peer.input.nodeId as string;
  const nodeLabel = peer.nodeLabel ?? nodeId;
  const head = {
    key: peer.key,
    label: peer.label,
    cutFrom: peer.cutFrom,
    nodeLabel,
  };
  const remote = deps.remote;
  if (!remote) {
    return {
      ...head,
      status: "refused",
      refusal: "other",
      message: "Remote peers are not available here",
    };
  }

  // R6: the node already refused a peer for its (default) account.
  const earlier = accountRefusals.get(nodeId);
  if (earlier) {
    return {
      ...head,
      status: "refused",
      refusal: earlier,
      // The dialog appends "(on <node>)"; the message does not repeat it.
      message: "not sent — an earlier peer on this node was refused",
    };
  }

  // The probe needs to know which sessions were already on the node. A failed
  // read leaves no probe (the events and the timeout still settle the peer).
  let before: Set<string> | null = null;
  try {
    before = new Set((await remote.listNodeSessions(nodeId)).map(s => s.id));
  } catch {
    before = null;
  }
  // The probe matches this peer by its parent AND its own name ("<parent> ·
  // peer N", unique per index within a run). The parent alone also matches an
  // earlier peer of this run that landed late or a PM's managed lane, and this
  // peer's prompt would go there. A peer with no name gets no probe. Residual
  // (#5610): two overlapping fan-outs from one parent give peer N the same
  // name; only a node-side correlation id on the session can tell them apart.
  const name = peer.input.name;
  const probe =
    before && name
      ? async (): Promise<string | null> => {
          const fresh = (await remote.listNodeSessions(nodeId)).filter(
            s =>
              !before.has(s.id) &&
              s.parentSessionId === parentId &&
              s.name === name
          );
          return fresh.length === 1 ? fresh[0].id : null;
        }
      : undefined;

  const correlationId = remote.newCorrelationId();
  const stubId = remote.addStub({
    nodeId,
    nodeLabel,
    directory: peer.input.directory,
    name: peer.input.name,
    agent: peer.input.agent,
    spawnCorrelationId: correlationId,
  });
  // Created BEFORE the request: a fast refusal can reach the browser over SSE
  // ahead of the proxy's HTTP answer.
  const waiter = remote.awaitOutcome({ correlationId, stubId, probe });

  let result: SpawnResponse;
  try {
    result = await deps.spawn({
      ...peer.input,
      spawnCorrelationId: correlationId,
    });
  } catch (err) {
    const message = errorMessage(err);
    remote.markStubFailed(stubId, message);
    waiter.cancel();
    const refusal =
      err instanceof ApiError
        ? classifyRefusal(err.code, message)
        : classifyRefusalMessage(message);
    return { ...head, status: "refused", refusal, message };
  }
  if (result.type === "error") {
    remote.markStubFailed(stubId, result.message);
    waiter.cancel();
    return {
      ...head,
      status: "refused",
      refusal: classifyRefusalMessage(result.message),
      message: result.message,
    };
  }

  // The hub answers an accepted remote spawn with an EMPTY id; never use it.
  // A hub that ever answers with a real id is taken at its word.
  let sessionId: string;
  if (result.type === "success" && result.sessionId) {
    waiter.cancel();
    sessionId = result.sessionId;
  } else {
    const settled = await waiter.promise;
    if (settled.kind === "refused") {
      const refusal = classifyRefusal(settled.code, settled.message);
      if (isAccountRefusal(refusal)) accountRefusals.set(nodeId, refusal);
      // #2150's stub store raises the refusal toast while the stub is listed.
      return { ...head, status: "refused", refusal, message: settled.message };
    }
    if (settled.kind === "unconfirmed") {
      return {
        ...head,
        status: "unconfirmed",
        message: `no answer from ${nodeLabel} within 2 minutes — check the session list; no prompt was queued`,
      };
    }
    sessionId = settled.sessionId;
  }
  // Clears the stub when the probe or a direct id settled the peer; harmless
  // when the success event already cleared it.
  remote.dismissStub(stubId);

  const linked = await verifyOrHealRemoteLink(
    remote,
    nodeId,
    sessionId,
    parentId
  );
  const promptResult = await enqueueRemotePrompt(
    deps,
    remote,
    sessionId,
    prompt,
    fanOutClientId(parentId, sessionId)
  );
  return {
    ...head,
    status: "spawned",
    sessionId,
    prompt: promptResult,
    linked,
  };
}

/**
 * #4497 R4: look the peer up on its node (bounded); heal the parent link once
 * when it is listed with another parent or never listed. Returns `linked` as
 * Slice 2 reports it: true, false, or undefined (not verified).
 */
async function verifyOrHealRemoteLink(
  remote: FanOutRemoteDeps,
  nodeId: string,
  sessionId: string,
  parentId: string
): Promise<boolean | undefined> {
  let listed: FanOutNodeSession | undefined;
  const attempts = Math.max(
    1,
    Math.ceil(REMOTE_LINK_LOOKUP_MS / REMOTE_LINK_LOOKUP_EVERY_MS)
  );
  for (let i = 0; i < attempts; i++) {
    try {
      listed = (await remote.listNodeSessions(nodeId)).find(
        s => s.id === sessionId
      );
    } catch {
      listed = undefined;
    }
    if (listed) break;
    if (i < attempts - 1) await remote.sleep(REMOTE_LINK_LOOKUP_EVERY_MS);
  }
  if (listed?.parentSessionId === parentId) return true;
  try {
    await remote.setParent(sessionId, parentId);
    return true;
  } catch (err) {
    console.warn("[useFanOutSpawn] remote parent heal failed", err);
    // Listed with another parent → not linked; never listed → not verified.
    return listed ? false : undefined;
  }
}

/** #4497 R5: queue the prompt once, retrying only the hub's 404 while its
 *  cache does not hold the new session yet. */
async function enqueueRemotePrompt(
  deps: FanOutDeps,
  remote: FanOutRemoteDeps,
  sessionId: string,
  prompt: string,
  clientId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      await deps.enqueue(sessionId, prompt, clientId);
      return { ok: true };
    } catch (err) {
      const notFound = err instanceof ApiError && err.status === 404;
      if (!notFound || attempt >= REMOTE_ENQUEUE_RETRIES) {
        return { ok: false, error: errorMessage(err) };
      }
      await remote.sleep(REMOTE_ENQUEUE_RETRY_MS);
    }
  }
}

/**
 * An unresolvable parent does not refuse a spawn — the server spawns it
 * unlinked with a warning. Mark each spawned peer whose stored
 * `parentSessionId` is not the parent as unlinked. A peer missing from the
 * list (not materialised yet) stays unverified. A remote peer (#4497) is left
 * alone: it is not in the local list, and the remote branch set its `linked`.
 */
export function verifyParentLinks(
  outcomes: readonly FanOutPeerOutcome[],
  sessions: readonly { id: string; parentSessionId?: string | null }[],
  parentId: string
): FanOutPeerOutcome[] {
  const byId = new Map(sessions.map(s => [s.id, s]));
  return outcomes.map(o => {
    if (o.status !== "spawned" || o.nodeLabel !== undefined) return o;
    const s = byId.get(o.sessionId);
    if (!s) return o;
    return { ...o, linked: s.parentSessionId === parentId };
  });
}

/** #4497: the real remote dependencies, from the stub store, the waiter and
 *  the hub's federated list. */
function realRemoteDeps(api: ApiClient): FanOutRemoteDeps {
  return {
    // Not crypto.randomUUID(): it throws on a plain-HTTP origin.
    newCorrelationId: randomUuid,
    addStub: addPendingSpawn,
    markStubFailed: markSpawnFailed,
    dismissStub: dismissPendingSpawn,
    awaitOutcome: awaitRemoteSpawn,
    listNodeSessions: async nodeId => {
      const { sessions } = await api.getFederationAllSessions();
      return sessions
        .filter(s => s.nodeId === nodeId && !isFederationSpawnPlaceholder(s))
        .map(s => ({
          id: s.id,
          parentSessionId: s.parentSessionId,
          name: s.metadata?.name ?? null,
        }));
    },
    setParent: (sessionId, parentId) =>
      api.setSessionParent(sessionId, parentId),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  };
}

export function useFanOutSpawn(api: ApiClient | null): {
  fanOut: (
    parentId: string,
    prompt: string,
    peers: readonly FanOutPeerRequest[],
    onOutcome?: (outcome: FanOutPeerOutcome) => void
  ) => Promise<FanOutPeerOutcome[]>;
  isPending: boolean;
} {
  const queryClient = useQueryClient();
  const { spawnSession } = useSpawnSession(api);
  const [isPending, setIsPending] = useState(false);

  const fanOut = async (
    parentId: string,
    prompt: string,
    peers: readonly FanOutPeerRequest[],
    onOutcome?: (outcome: FanOutPeerOutcome) => void
  ): Promise<FanOutPeerOutcome[]> => {
    if (!api) throw new Error("API unavailable");
    setIsPending(true);
    try {
      const outcomes = await runFanOut(
        {
          spawn: spawnSession,
          enqueue: (id, body, cid) => api.enqueueQueuedMessage(id, body, cid),
          remote: realRemoteDeps(api),
          onOutcome,
        },
        parentId,
        prompt,
        peers
      );
      // Verify the parent link from a fresh list (read-only; a failed read
      // leaves the peers unverified rather than failing the batch).
      let verified = outcomes;
      if (
        outcomes.some(o => o.status === "spawned" && o.nodeLabel === undefined)
      ) {
        try {
          const { sessions } = await api.getSessions();
          verified = verifyParentLinks(outcomes, sessions, parentId);
        } catch (err) {
          // The peers stay unverified (shown as "link not verified").
          console.warn("[useFanOutSpawn] parent-link re-read failed", err);
          verified = outcomes;
        }
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.federationAllSessions,
      });
      return verified;
    } finally {
      setIsPending(false);
    }
  };

  return { fanOut, isPending };
}
