// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HAL capability-miss handler — the cli-side gate + delivery mechanism (issue
 * #3132, Task 2; epic #3117 Sub R). Expert ruling D5a: the capability check
 * lives at the cli-side skill/spawn boundary (there is NO slash-dispatch to
 * intercept — `cli/src/modules/common/slashCommands.ts` is enumeration-only),
 * where the #3118 manifest registry is directly importable.
 *
 * Two responsibilities:
 *
 *   1. {@link computeCapabilityMiss} — PURE. Resolve the session harness's
 *      manifest, run the shared `checkCapabilities` predicate against the skill
 *      envelope's `required_capabilities`, and — on a miss — build the COMPLETED
 *      `{ missing, degradation, capableHarnesses }` payload (KD2: the web
 *      computes nothing from manifests). Returns `null` when the harness fully
 *      satisfies the skill (zero added friction — AC / V4).
 *
 *   2. {@link CapabilityMissHandler} — delivery. Publishes the payload into
 *      `AgentState.requests` and awaits the web's degrade/respawn answer over an
 *      RPC round-trip, patterned on `permission/BasePermissionHandler.ts`
 *      (pending-request map + `updateAgentState` + a registered RPC handler).
 *      A capability miss is NEVER silent (R3) — it always reaches the UI, even
 *      when a policy will auto-degrade.
 *
 * FORWARD SEAM (OR2 / #3124): nothing registers an interceptor that CALLS this
 * handler on a live foreign-harness skill-intent prompt yet — #3124's message
 * stage plans no interceptor-registration API today. When it exposes one, that
 * interceptor invokes {@link computeCapabilityMiss} + {@link CapabilityMissHandler}
 * behind the SAME shared `checkCapabilities` predicate — do not build or depend
 * on it here.
 */
import { randomUUID } from "node:crypto";
import {
  HARNESS_MANIFESTS,
  checkCapabilities,
  findCapableHarnesses,
  tryResolveHarnessManifest,
  CAPABILITY_OFFER_TOOL,
  type CapabilityMissPayload,
  type CapabilityOfferDecision,
  type TriState,
} from "@hapi/protocol";
import type { PermissionHandlerClient } from "./permission/BasePermissionHandler";

/** Inputs to {@link computeCapabilityMiss} — the envelope + session facts. */
export interface CapabilityMissInput {
  /** The skill being dispatched (`ContractEnvelope.skill`). */
  skill: string;
  /** The envelope's `required_capabilities` (snake_case tokens). */
  required: string[];
  /** The envelope's per-capability `degradation` annotations (KD5). */
  degradation?: Partial<Record<string, TriState>>;
  /** The session harness's canonical id (the stock-4 `AgentFlavor`). */
  sessionHarness: string;
}

/**
 * Compute the COMPLETED capability-miss payload for a skill on a session's
 * harness, or `null` when there is no miss (the harness satisfies the skill →
 * zero friction, V4). Pure — no I/O, no state.
 *
 * A session harness with no stock-4 manifest (a catalog CLI, #3120) returns
 * `null`: catalog manifests resolve via #3120's SEPARATE `resolveCatalogManifest`
 * (out of this gate's scope), and fabricating a miss would spuriously gate.
 * A missed offer equals today's status quo (the issue's green failure impact),
 * so `null` is the fallback-preserving choice (#3126 posture).
 */
export function computeCapabilityMiss(
  input: CapabilityMissInput
): CapabilityMissPayload | null {
  const manifest = tryResolveHarnessManifest(input.sessionHarness);
  if (!manifest) return null;

  const { ok, missing } = checkCapabilities(input.required, manifest);
  if (ok) return null;

  const degradation: Partial<Record<string, TriState>> = {};
  for (const cap of missing) {
    const declared = input.degradation?.[cap];
    if (declared !== undefined) degradation[cap] = declared;
  }

  const capableHarnesses = findCapableHarnesses(
    input.required,
    HARNESS_MANIFESTS
  ).filter(id => id !== input.sessionHarness);

  return {
    skill: input.skill,
    sessionHarness: input.sessionHarness,
    missing,
    degradation,
    capableHarnesses,
  };
}

/** The web's answer envelope for a capability-miss offer (KD2 RPC round-trip). */
export interface CapabilityOfferResponse {
  /** The `AgentState.requests` id of the offer being answered. */
  id: string;
  /** The user's (or a policy's) choice. */
  decision: CapabilityOfferDecision;
}

type PendingOffer = {
  resolve: (decision: CapabilityOfferDecision) => void;
  reject: (error: Error) => void;
};

/**
 * Delivers capability-miss offers to the web and resolves the user's answer.
 * Standalone (NOT a `BasePermissionHandler` subclass — that class's
 * `setupRpcHandler` is private and hardcodes the `"permission"` method; the
 * capability offer would use its own `capabilityOffer` RPC method), but it
 * follows the same pending-map + `AgentState` publication pattern.
 *
 * ⚠️ Issue #3745 (R10): the `capabilityOffer` RPC registration was removed from
 * the constructor as dead code (this class is instantiated nowhere in
 * production). The response-handler registration is re-established by #3124 when
 * it wires the capability-miss interceptor. See the constructor comment.
 */
export class CapabilityMissHandler {
  private readonly pending = new Map<string, PendingOffer>();
  private readonly client: PermissionHandlerClient;

  constructor(client: PermissionHandlerClient) {
    this.client = client;
    // Issue #3745 (epic #3740, Sub-Issue E / R10 preferred path): the
    // `capabilityOffer` RPC registration was REMOVED here as dead code. This
    // class is instantiated NOWHERE in production (verified: only its own
    // `.test.ts` references `CapabilityMissHandler`/`computeCapabilityMiss`), and
    // the #3124 message stage plans no interceptor-registration API yet. Keeping
    // the registration would have (a) permanently forward-drifted the #3744 audit
    // (an announced-nowhere method the catalog must never list), and (b) kept the
    // #3742 registrations guard forever ratcheted — its named allowlist could
    // never drain to empty (the `capabilityOffer` entry can carry no real meta).
    // With the registration gone, the allowlist drains to EMPTY and the guard is
    // ABSOLUTE. When #3124 wires the capability-miss interceptor, it re-adds a
    // response-handler registration here (calling `finalizeRequest` /
    // `offer.resolve` below) with a real CapabilityMeta authored in that PR.
  }

  /**
   * Publish a capability-miss offer into `AgentState.requests` and resolve when
   * the web answers. The returned Promise rejects only if {@link cancelPending}
   * is called (e.g. session teardown) before an answer arrives.
   */
  requestDecision(
    payload: CapabilityMissPayload
  ): Promise<CapabilityOfferDecision> {
    const id = `capability-offer-${randomUUID()}`;
    return new Promise<CapabilityOfferDecision>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.client.updateAgentState(state => ({
        ...state,
        requests: {
          ...(state.requests ?? {}),
          [id]: {
            tool: CAPABILITY_OFFER_TOOL,
            arguments: payload,
            createdAt: Date.now(),
          },
        },
      }));
    });
  }

  /** Reject every pending offer (session teardown) and clear the AgentState. */
  cancelPending(reason: string): void {
    for (const [, offer] of this.pending.entries()) {
      offer.reject(new Error(reason));
    }
    this.pending.clear();
    this.client.updateAgentState(state => {
      const pending = state.requests ?? {};
      const completed = { ...(state.completedRequests ?? {}) };
      for (const [id, request] of Object.entries(pending)) {
        if (request.tool !== CAPABILITY_OFFER_TOOL) continue;
        completed[id] = {
          ...request,
          completedAt: Date.now(),
          status: "canceled",
          reason,
        };
      }
      const nextRequests = { ...pending };
      for (const id of Object.keys(nextRequests)) {
        if (nextRequests[id].tool === CAPABILITY_OFFER_TOOL) {
          delete nextRequests[id];
        }
      }
      return {
        ...state,
        requests: nextRequests,
        completedRequests: completed,
      };
    });
  }

  /** Move an answered offer from `requests` to `completedRequests`. */
  private finalizeRequest(id: string, decision: CapabilityOfferDecision): void {
    this.client.updateAgentState(state => {
      const request = state.requests?.[id];
      if (!request) return state;
      const nextRequests = { ...(state.requests ?? {}) };
      delete nextRequests[id];
      return {
        ...state,
        requests: nextRequests,
        completedRequests: {
          ...(state.completedRequests ?? {}),
          [id]: {
            ...request,
            completedAt: Date.now(),
            status: "approved",
            reason: `capability-offer:${decision}`,
          },
        },
      };
    });
  }
}
