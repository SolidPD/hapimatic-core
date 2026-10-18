// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from "hono";
import { z } from "zod";
import { LOCAL_NODE_ID } from "@hapi/protocol";
import type { WebAppEnv } from "../middleware/auth";
import { RedactedAccountSchema } from "../../services/accountService";
import { IN_VM_SIGN_IN_REQUIRED } from "../../services/accountLoginService";
import type {
  NodeLoginGate,
  NodeRegistry,
} from "../../federation/nodeRegistry";

/**
 * Node-targeted Anthropic login, hub side (issue #4462, epic #4460 B).
 *
 * `POST /api/accounts/login/{start,complete}` (routes/accounts.ts) hand a remote
 * target to this module. It refuses an unknown, offline or unsupported node
 * before any proxy call, runs the PKCE step on the peer through
 * `/api/federation/anthropic-login/*`, and maps the peer's answer to the
 * browser. The local flow never reaches this module, so it stays byte-for-byte.
 *
 * The browser never talks to the peer: the hub proxies server-to-server with the
 * federation token, which is what lets it reach a node behind SSO.
 */

/**
 * The hub wraps the peer's opaque token with the HUB's own id for that node —
 * `fed1.<base64url(nodeId)>.<token>` — so `complete` routes to the node that ran
 * `start` (its PKCE map is per process) without hub-side state, and a mismatch is
 * caught before any peer call. A plain local token (a UUID) never has the prefix.
 */
const WRAPPED_LOGIN_TOKEN_PREFIX = "fed1.";

export function wrapLoginToken(nodeId: string, peerToken: string): string {
  return `${WRAPPED_LOGIN_TOKEN_PREFIX}${Buffer.from(nodeId, "utf8").toString("base64url")}.${peerToken}`;
}

export type UnwrappedLoginToken =
  | { kind: "plain"; token: string }
  | { kind: "wrapped"; nodeId: string; token: string }
  | { kind: "malformed" };

export function unwrapLoginToken(loginToken: string): UnwrappedLoginToken {
  if (!loginToken.startsWith(WRAPPED_LOGIN_TOKEN_PREFIX)) {
    return { kind: "plain", token: loginToken };
  }
  const rest = loginToken.slice(WRAPPED_LOGIN_TOKEN_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return { kind: "malformed" };
  const encoded = rest.slice(0, dot);
  const nodeId = Buffer.from(encoded, "base64url").toString("utf8");
  // Only the exact encoding round-trips: a hand-edited or truncated id is malformed.
  if (
    !nodeId ||
    Buffer.from(nodeId, "utf8").toString("base64url") !== encoded
  ) {
    return { kind: "malformed" };
  }
  return { kind: "wrapped", nodeId, token: rest.slice(dot + 1) };
}

// Hub-ingress parse of a peer's answer (R8): the account goes through the
// whitelist RedactedAccountSchema, so a peer on a different build cannot relay a
// token field to the browser.
const PeerLoginStartAnswerSchema = z.union([
  z.object({
    ok: z.literal(true),
    loginToken: z.string().min(1),
    authorizeUrl: z.string().min(1),
  }),
  z.object({ ok: z.literal(false), code: z.string(), error: z.string() }),
]);
const PeerLoginCompleteAnswerSchema = z.union([
  z.object({ ok: z.literal(true), account: RedactedAccountSchema }),
  z.object({ ok: z.literal(false), code: z.string(), error: z.string() }),
]);

type GateRefusal = { status: 404 | 409 | 503; code: string; error: string };

export function createAnthropicLoginRouting(deps: {
  getNodeRegistry?: () => NodeRegistry | null;
  getLocalNodeId?: () => string | null;
}) {
  /**
   * STRICT local test. Unlike the OpenAI helpers in routes/accounts.ts it never
   * treats an unrecognised id as local on an instance without federation: a login
   * must never be stored on a node other than the one named (R3).
   */
  const isLocalTarget = (nodeId: string | undefined): boolean =>
    nodeId === undefined ||
    nodeId === LOCAL_NODE_ID ||
    nodeId === (deps.getLocalNodeId?.() ?? null);

  /** A node's display label for a message; this node's own ids read "this node". */
  const labelOf = (nodeId: string): string =>
    isLocalTarget(nodeId)
      ? "this node"
      : (deps.getNodeRegistry?.()?.getNodeIdentity(nodeId)?.nodeLabel ??
        nodeId);

  const offlineAtStart = (label: string) =>
    `${label} is offline. Log in there when it is back.`;

  const offlineAtComplete = (label: string) =>
    `${label} is offline. The login stays pending there for up to 5 minutes: submit the code again when it is back, or start over.`;

  const inVmRefusal = (label: string) => ({
    error: `${label} is a hosted VM: sign in there with Claude Code's own /login, from ${label}'s own Hapimatic page.`,
    code: "node_in_vm_sign_in_required",
  });

  /**
   * R3: refuse a remote target before any proxy call. Every check reads ONE
   * registry snapshot. A node not yet polled counts as offline — its capabilities
   * are unknown, so it is refused, never mis-routed.
   */
  const gateFor = (
    nodeId: string
  ):
    | { gate: NodeLoginGate; registry: NodeRegistry }
    | { refusal: GateRefusal } => {
    const registry = deps.getNodeRegistry?.() ?? null;
    if (!registry) {
      return {
        refusal: {
          status: 503,
          code: "federation_not_enabled",
          error: `Federation is not enabled on this node, so it cannot store a login on "${nodeId}".`,
        },
      };
    }
    const gate = registry.getNodeLoginGate(nodeId);
    if (!gate) {
      return {
        refusal: {
          status: 404,
          code: "node_not_found",
          error: `Unknown node "${nodeId}".`,
        },
      };
    }
    if (!gate.online || !gate.polled) {
      return {
        refusal: {
          status: 409,
          code: "node_offline",
          error: offlineAtStart(gate.nodeLabel),
        },
      };
    }
    if (!gate.supportsAnthropicLogin) {
      return {
        refusal: {
          status: 409,
          code: "node_login_unsupported",
          error: `${gate.nodeLabel} runs a Hapimatic build without node-targeted login; deploy the current release to it.`,
        },
      };
    }
    return { gate, registry };
  };

  /** R2, R3: run `start` on the peer and hand back a token wrapped with its id. */
  async function startRemote(c: Context<WebAppEnv>, nodeId: string) {
    const checked = gateFor(nodeId);
    if ("refusal" in checked) {
      const { status, code, error } = checked.refusal;
      return c.json({ error, code }, status);
    }
    const { gate, registry } = checked;
    const label = gate.nodeLabel;
    const result = await registry.startAnthropicLoginOnNode(gate.nodeId);
    if (result.type === "error") {
      if (result.kind === "offline") {
        return c.json(
          {
            error: offlineAtStart(label),
            code: "node_offline",
          },
          409
        );
      }
      return c.json(
        {
          error: `${label} did not start the login: ${result.message}`,
          code: "federation_proxy_error",
        },
        502
      );
    }
    const answer = PeerLoginStartAnswerSchema.safeParse(result.body);
    if (!answer.success) {
      return c.json(
        {
          error: `${label} sent an unexpected answer to the login start.`,
          code: "federation_proxy_error",
        },
        502
      );
    }
    if (!answer.data.ok) {
      if (answer.data.code === IN_VM_SIGN_IN_REQUIRED) {
        return c.json(inVmRefusal(label), 409);
      }
      return c.json(
        {
          error: `${label} did not start the login: ${answer.data.error}`,
          code: "federation_proxy_error",
        },
        502
      );
    }
    // R8: only the authorize URL (which must carry `state` to Anthropic) and the
    // wrapped token reach the browser.
    return c.json({
      loginToken: wrapLoginToken(gate.nodeId, answer.data.loginToken),
      authorizeUrl: answer.data.authorizeUrl,
      nodeId: gate.nodeId,
      nodeLabel: label,
    });
  }

  const sessionLost = (c: Context<WebAppEnv>, error: string) =>
    c.json({ ok: false, error, code: "login_session_lost" }, 400);

  /**
   * R3–R8: forward `complete` to the node the token names. A mismatch is caught
   * before any peer call (R4); the answer is re-parsed before it reaches the
   * browser (R8). `nodeId` is the request body's optional id.
   */
  async function completeRemote(
    c: Context<WebAppEnv>,
    routed: UnwrappedLoginToken,
    nodeId: string | undefined,
    args: { code: string; state?: string }
  ) {
    if (routed.kind === "malformed") {
      return sessionLost(c, "This login token is not valid. Start over.");
    }
    if (routed.kind === "plain") {
      return sessionLost(
        c,
        `This login was started on this node, not on ${labelOf(nodeId!)}. Start over.`
      );
    }
    if (nodeId !== undefined && nodeId !== routed.nodeId) {
      return sessionLost(
        c,
        `This login was started on ${labelOf(routed.nodeId)}, not on ${labelOf(nodeId)}. Start over.`
      );
    }
    if (isLocalTarget(routed.nodeId)) {
      // Only a hub wraps, and only for a peer: a wrapped token naming this node
      // was issued through another node.
      return sessionLost(
        c,
        "This login was started through another node. Start over."
      );
    }
    const checked = gateFor(routed.nodeId);
    if ("refusal" in checked) {
      const { status, code, error } = checked.refusal;
      return c.json(
        {
          ok: false,
          error:
            code === "node_offline"
              ? offlineAtComplete(labelOf(routed.nodeId))
              : error,
          code,
        },
        status
      );
    }
    const { gate, registry } = checked;
    const label = gate.nodeLabel;
    const result = await registry.completeAnthropicLoginOnNode(gate.nodeId, {
      loginToken: routed.token,
      // Forwarded raw: the peer's own 6-digit-paste guard refuses it before the
      // single-use token is consumed.
      code: args.code,
      ...(args.state !== undefined ? { state: args.state } : {}),
    });
    if (result.type === "error") {
      switch (result.kind) {
        case "offline":
          return c.json(
            {
              ok: false,
              error: offlineAtComplete(label),
              code: "node_offline",
            },
            409
          );
        case "timeout":
          return c.json(
            {
              ok: false,
              error: `No answer from ${label} within 35 s. The login may have completed there; check ${label}'s accounts before starting over.`,
              code: "login_outcome_unknown",
            },
            504
          );
        case "transport":
          // The single-use token may already be consumed on the peer, so this is
          // never reported as a failed login.
          return c.json(
            {
              ok: false,
              error: `Lost the connection to ${label} before it answered. The login may have completed there; check ${label}'s accounts before starting over.`,
              code: "login_outcome_unknown",
            },
            504
          );
        case "http":
          return c.json(
            {
              ok: false,
              error: `${label} could not complete the login: ${result.message}`,
              code: "federation_proxy_error",
            },
            502
          );
      }
    }
    const answer = PeerLoginCompleteAnswerSchema.safeParse(result.body);
    if (!answer.success) {
      return c.json(
        {
          ok: false,
          error: `${label} sent an unexpected answer to the login.`,
          code: "federation_proxy_error",
        },
        502
      );
    }
    if (answer.data.ok) {
      return c.json({
        ok: true,
        account: answer.data.account,
        nodeId: gate.nodeId,
        nodeLabel: label,
      });
    }
    const { code, error } = answer.data;
    if (code === "expired_state") {
      return sessionLost(
        c,
        `The login on ${label} is no longer pending: it expired after 5 minutes or ${label} restarted. Start over.`
      );
    }
    if (code === IN_VM_SIGN_IN_REQUIRED) {
      return c.json({ ok: false, ...inVmRefusal(label) }, 409);
    }
    // Same status table as the local route.
    const status =
      code === "csrf" || code === "invalid_request" || code === "invalid_code"
        ? 400
        : 502;
    return c.json({ ok: false, error, code }, status);
  }

  return { isLocalTarget, startRemote, completeRemote };
}
