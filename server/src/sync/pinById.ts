// SPDX-License-Identifier: AGPL-3.0-only
import {
  neutralizeApprovalTokens,
  PinSchema,
  type Pin,
  type SessionSummary,
} from "@hapi/protocol";
import { z } from "zod";

import type { NodeRegistry, PeerReadOutcome } from "../federation/nodeRegistry";
import type { Session, SyncEngine } from "./syncEngine";

// Read a pin by its ID (issue #6574, epic #6446), across the federation.
//
// The read rule (ruling D3, part of Matt's SEC1): any caller authenticated in a
// namespace may read, read-only, any pin of a session in that namespace, on any
// node. A pin in another namespace, a deleted pin and an ID nobody holds give the
// same answer, built so timing and body cannot tell them apart: a local pin whose
// session is not in the caller's namespace falls through to the peers exactly like
// a miss, and the `notAsked` list depends only on the registry, never on the pin.
//
// Order: the local store first (a hit in the caller's namespace answers at once,
// Open Risk OR-2), then every peer the registry does not mark offline, in parallel.
// Ruling DA: a peer the registry already knows is offline is not asked; a miss
// names it in `notAsked` (404). 503 is kept for transient trouble only: an asked
// peer that timed out, failed or sent an unreadable or malformed reply, and the
// hub-restart window, while static peers still read offline before their first
// poll. Two hits answer `ambiguous` and never pick one.
//
// Every by-ID answer carries agent-written text, so every route passes the pin
// through `neutralizePinText` (SEC1: approval tokens are blanked in every read by
// ID). The existing key reads are left as they are (ruling DB, Open Risk OR-8).

export type PinByIdNode = { nodeId: string; nodeLabel: string };

/** The owning session, named so the "found elsewhere" line needs no second read. */
export type PinByIdSession = {
  id: string;
  name: string | null;
  nodeId: string | null;
  nodeLabel: string | null;
};

export type PinByIdMatch = PinByIdNode & { sessionId: string; key: string };

export type PinByIdOutcome =
  | {
      kind: "found";
      pin: Pin;
      openPinCount: number;
      /** The owning node's pin time zone (its loop fires the automatic pick). */
      timeZone: string | null;
      session: PinByIdSession;
    }
  | { kind: "not_found"; notAsked: PinByIdNode[] }
  | { kind: "incomplete"; nodes: PinByIdNode[] }
  | { kind: "ambiguous"; matches: PinByIdMatch[] };

export type PinByIdRegistry = Pick<
  NodeRegistry,
  | "getNodeSummaries"
  | "getPinByIdOnNode"
  | "isAwaitingInitialPoll"
  | "getAllRemoteSessions"
>;

/** What the lookup reads of this node. */
export type PinByIdDeps = {
  getByPinId(pinId: string): { pin: Pin; openPinCount: number } | null;
  getSessionByNamespace(
    sessionId: string,
    namespace: string
  ): Session | undefined;
  /** This node's pin time zone, or null. */
  getTimeZone(): Promise<string | null>;
  localNode: { nodeId: string; nodeLabel?: string } | null;
  registry: PinByIdRegistry | null;
};

/** The lookup's deps over a node's engine and registry, shared by the JWT and CLI routes. */
export function enginePinByIdDeps(
  engine: Pick<SyncEngine, "pins" | "getSessionByNamespace">,
  options: {
    registry: PinByIdRegistry | null;
    getTimeZone?: () => Promise<string | null>;
    localNode: { nodeId: string; nodeLabel?: string } | null;
  }
): PinByIdDeps {
  return {
    getByPinId: pinId => engine.pins.getByPinId(pinId),
    getSessionByNamespace: (sessionId, namespace) =>
      engine.getSessionByNamespace(sessionId, namespace),
    getTimeZone: async () => (await options.getTimeZone?.()) ?? null,
    localNode: options.localNode,
    registry: options.registry,
  };
}

/** The pin with this ID on THIS node, in the caller's namespace, or null. */
export async function findLocalPinById(
  deps: Pick<
    PinByIdDeps,
    "getByPinId" | "getSessionByNamespace" | "getTimeZone"
  >,
  namespace: string,
  pinId: string
): Promise<{
  pin: Pin;
  openPinCount: number;
  timeZone: string | null;
  session: Session;
} | null> {
  const hit = deps.getByPinId(pinId);
  if (!hit) return null;
  const session = deps.getSessionByNamespace(hit.pin.sessionId, namespace);
  if (!session) return null;
  return {
    pin: hit.pin,
    openPinCount: hit.openPinCount,
    timeZone: await deps.getTimeZone(),
    session,
  };
}

/** A peer's answer, as the federation receiver sends it. */
const PeerHitSchema = z
  .object({
    found: z.literal(true),
    pin: PinSchema,
    openPinCount: z.number().int(),
    timeZone: z.string().nullable().optional(),
  })
  .loose();
const PeerMissSchema = z.object({ found: z.literal(false) }).loose();

type PeerAnswer =
  | { kind: "hit"; pin: Pin; openPinCount: number; timeZone: string | null }
  | { kind: "miss" }
  | { kind: "not_asked" }
  | { kind: "failed" };

/** Classify one peer's read. A reply that names another ID is malformed. */
export function classifyPeerRead(
  read: PeerReadOutcome,
  pinId: string
): PeerAnswer {
  if (read.kind === "offline") return { kind: "not_asked" };
  if (read.kind === "unsupported") return { kind: "miss" };
  if (read.kind === "unreachable") return { kind: "failed" };
  const hit = PeerHitSchema.safeParse(read.body);
  if (hit.success) {
    if (hit.data.pin.pinId !== pinId) return { kind: "failed" };
    return {
      kind: "hit",
      pin: hit.data.pin,
      openPinCount: hit.data.openPinCount,
      timeZone: hit.data.timeZone ?? null,
    };
  }
  return PeerMissSchema.safeParse(read.body).success
    ? { kind: "miss" }
    : { kind: "failed" };
}

export async function lookupPinById(
  deps: PinByIdDeps,
  namespace: string,
  pinId: string
): Promise<PinByIdOutcome> {
  const local = await findLocalPinById(deps, namespace, pinId);
  if (local) {
    return {
      kind: "found",
      pin: local.pin,
      openPinCount: local.openPinCount,
      timeZone: local.timeZone,
      session: {
        id: local.session.id,
        name: local.session.metadata?.name ?? null,
        nodeId: deps.localNode?.nodeId ?? null,
        nodeLabel: deps.localNode?.nodeLabel ?? null,
      },
    };
  }

  const registry = deps.registry;
  const peers = registry ? registry.getNodeSummaries() : [];
  const notAsked: PinByIdNode[] = [];
  const failed: PinByIdNode[] = [];
  const asked: PinByIdNode[] = [];
  for (const node of peers) {
    const label = { nodeId: node.nodeId, nodeLabel: node.nodeLabel };
    if (node.status === "offline") notAsked.push(label);
    else asked.push(label);
  }

  const settled = registry
    ? await Promise.allSettled(
        asked.map(node =>
          registry.getPinByIdOnNode(node.nodeId, pinId, namespace)
        )
      )
    : [];
  const hits: Array<
    PinByIdNode & { pin: Pin; openPinCount: number; timeZone: string | null }
  > = [];
  settled.forEach((outcome, index) => {
    const node = asked[index];
    if (!node) return;
    if (outcome.status === "rejected") {
      failed.push(node);
      return;
    }
    const answer = classifyPeerRead(outcome.value, pinId);
    if (answer.kind === "hit") {
      hits.push({
        ...node,
        pin: answer.pin,
        openPinCount: answer.openPinCount,
        timeZone: answer.timeZone,
      });
    } else if (answer.kind === "not_asked") {
      notAsked.push(node);
    } else if (answer.kind === "failed") {
      failed.push(node);
    }
  });

  if (hits.length > 1) {
    return {
      kind: "ambiguous",
      matches: hits.map(hit => ({
        nodeId: hit.nodeId,
        nodeLabel: hit.nodeLabel,
        sessionId: hit.pin.sessionId,
        key: hit.pin.key,
      })),
    };
  }
  const hit = hits[0];
  if (hit) {
    const remote: SessionSummary | undefined = registry
      ?.getAllRemoteSessions()
      .find(summary => summary.id === hit.pin.sessionId);
    return {
      kind: "found",
      pin: hit.pin,
      openPinCount: hit.openPinCount,
      timeZone: hit.timeZone,
      session: {
        id: hit.pin.sessionId,
        name: remote?.metadata?.name ?? null,
        nodeId: hit.nodeId,
        nodeLabel: hit.nodeLabel,
      },
    };
  }
  // The hub-restart window wins over `notAsked`: static peers read offline until
  // their first poll, so "not found" would be a guess.
  if (registry?.isAwaitingInitialPoll()) {
    return { kind: "incomplete", nodes: [...failed, ...notAsked] };
  }
  if (failed.length > 0) return { kind: "incomplete", nodes: failed };
  return { kind: "not_found", notAsked };
}

/**
 * A copy of the pin with every string passed through `neutralizeApprovalTokens`.
 * A walk, not a field list, because a list drifts: it reaches every agent-written
 * string by construction (titles and text, option ids and labels, step ids, links
 * and evidence paths, `recommended`, `ifUnanswered.option`, answer options and
 * `deliveredTo`, every `lanes` string) and any field a newer peer adds through the
 * loose `PinSchema`. It never throws: a value that is not a string, an array or a
 * plain object passes through unchanged.
 */
export function neutralizePinText(pin: Pin): Pin {
  return walk(pin) as Pin;
}

function walk(value: unknown): unknown {
  if (typeof value === "string") return neutralizeApprovalTokens(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = walk(inner);
    return out;
  }
  return value;
}
