// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6740: switch a session ANOTHER node owns onto an API key, from this hub.
 *
 * The hub forwards a QUALIFIED reference (`<uuid>@<home>`) and its own node id,
 * never a key: the owner resolves the reference once, requires the key shared,
 * and restarts or stages the session. The hub's part is the gate before the
 * request and the reading of the answer after it.
 */
import {
  isQualifiedApiKeyRef,
  SESSION_API_KEY_SWITCH_CAPABILITY,
} from "@hapi/protocol";
import { AuthBindingSchema } from "@hapi/protocol/schemas";
import type { NodeRegistry } from "../federation/nodeRegistry";
import type { SwitchPaymentMethodServiceResult } from "./sessionService";

type ProxyAnswer =
  | { type: "success"; data: Record<string, unknown> }
  | { type: "not-found" }
  | { type: "error"; message: string; status: number; code?: string };

/** `SessionService.proxyToResolvedNode`, narrowed to what the switch uses. */
export type ProxyToOwner = (
  node: { nodeId: string; url: string },
  sessionId: string,
  pathSuffix: string,
  method: string,
  namespace: string,
  body?: unknown
) => Promise<ProxyAnswer>;

/**
 * The statuses of a code-less refusal that may reach the browser as they are. A
 * 401 never may: the web client would refresh its own token and re-send the POST.
 */
const REFUSAL_STATUS_PASS_THROUGH = new Set([400, 403, 404, 409, 503]);

/**
 * Switch `sessionId`, which this node does not own, onto `apiKeyId`.
 *
 * What an answer means: a refusal with a code is the owner's own (its code,
 * status and words, named as the owner's); a code-less 4xx or 503 is a refusal by
 * the owner, or a proxy in front of it, before anything ran; every other failure,
 * and a success this hub cannot read, is an UNKNOWN outcome — the owner may still
 * complete the switch, so it is never reported as a failure.
 */
export async function switchPeerSessionToApiKey(
  registry: NodeRegistry | null,
  originatingNodeId: string,
  proxy: ProxyToOwner,
  request: { sessionId: string; apiKeyId: string; namespace: string }
): Promise<SwitchPaymentMethodServiceResult> {
  const { sessionId, apiKeyId, namespace } = request;
  // An unknown (or offline) owner stays a 404, as for an account target.
  const owner = registry?.findNodeForSession(sessionId);
  if (!registry || !owner) return { type: "not-found" };
  const label =
    registry.getNodeIdentity(owner.nodeId)?.nodeLabel ?? owner.nodeId;
  const needsUpdating = {
    type: "error",
    message: `${label} needs updating before its sessions can switch to an API key from another node.`,
    status: 409,
    code: "api_key_remote_unsupported",
  } as const;
  const unknownOutcome = {
    type: "error",
    message: `${label} could not be reached or stopped answering. If it got the request, the switch may still complete: check the session before trying again.`,
    status: 502,
    code: "switch_outcome_unknown",
  } as const;

  if (!registry.nodeSupports(owner.nodeId, SESSION_API_KEY_SWITCH_CAPABILITY)) {
    return needsUpdating;
  }
  if (!isQualifiedApiKeyRef(apiKeyId)) {
    return {
      type: "error",
      message: `To switch a session on ${label}, send the key's bindingRef from GET /api/api-keys/available?targetNodeId=${owner.nodeId}.`,
      status: 400,
      code: "api_key_remote_unsupported",
    };
  }

  const answer = await proxy(owner, sessionId, "/account", "POST", namespace, {
    apiKeyId,
    originatingNodeId,
  });
  if (answer.type === "not-found") return answer;
  if (answer.type === "error") {
    const { status, code, message } = answer;
    // An owner downgraded since the last poll rejects a body it cannot read.
    if (status === 400 && code === "invalid_request") return needsUpdating;
    if (code) {
      // The owner says "This node ..." about itself: say whose words they are.
      return {
        type: "error",
        message: `On ${label}: ${message}`,
        status,
        code,
      };
    }
    if ((status >= 400 && status < 500) || status === 503) {
      return {
        type: "error",
        message: `${label} refused the request (HTTP ${status}); the session was not switched.`,
        status: REFUSAL_STATUS_PASS_THROUGH.has(status) ? status : 502,
        code: "transport_failed",
      };
    }
    return unknownOutcome;
  }

  const { apiKeyId: boundRef, apiKeyLabel, staged } = answer.data;
  const binding = AuthBindingSchema.safeParse(answer.data.authBinding);
  if (typeof boundRef !== "string" || !boundRef || !binding.success) {
    return unknownOutcome;
  }
  registry.updateCachedSessionApiKeyBinding(sessionId, boundRef, binding.data);
  return {
    type: "success",
    apiKeyLabel: typeof apiKeyLabel === "string" ? apiKeyLabel : "",
    ...(staged === true ? { staged: true } : {}),
  };
}
