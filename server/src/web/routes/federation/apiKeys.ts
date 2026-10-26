// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import {
  defineCapability,
  FederationApiKeyRequestSchema,
  FederationSharedApiKeysRequestSchema,
  isUsableNodeIdForSharing,
  type FederationApiKeyRequest,
} from "@hapi/protocol";
import {
  maskApiKey,
  StoredApiKeySchema,
  type StoredApiKey,
} from "@hapi/protocol/schemas";
import { isTenantVm as defaultIsTenantVm } from "@hapi/protocol/tenantMode";
import type { WebAppEnv } from "../../middleware/auth";
import { cataloged } from "../../../capabilities/cataloged";
import { readSettings } from "../../../config/settings";
import { homePeerAllowed } from "../../../federation/secretTransport";
import type { ApiKeySharePurpose } from "../../../store/apiKeyShareAuditStore";
import { FixedWindowCounter } from "../../../utils/rateLimitCounter";
import { errorClass, toRedactedApiKey } from "../apiKeys";
import { checkFederationToken, type FederationDeps } from "./shared";

/**
 * Shared API keys, home side (issue #5127).
 *
 *   POST /api/federation/api-keys/shared  — this node's shared keys, redacted
 *   POST /api/federation/api-keys/resolve — one shared key's identity (no secret)
 *   POST /api/federation/api-keys/secret  — one shared key's secret
 *
 * A key stays in this node's vault. Another node of the same federation asks for
 * it each time one of its sessions needs it, and only a key the operator marked
 * "Make available to all nodes" (`shareAcrossNodes: true`) is ever served.
 *
 * Every request is checked, in this order: the mesh token (401); the body
 * (refused as `invalid_request`, unaudited: it names no requester); a hosted
 * customer VM; this node's own id and the home id the body names; the transport
 * (Tailscale or a direct same-host request only, never a proxied one); a
 * per-peer rate limit; a requester this node knows; then, for one key, the key's
 * own checks and a per-requester-and-key rate limit. The vault is read fresh on
 * every call, so an untick or a removal takes effect at once. Refusals answer
 * HTTP 200 `{ ok: false, code, message }` so the code survives every hop (the
 * `./anthropicLogin.ts` convention); only a bad token answers 401.
 *
 * Both rate limits are bounded: the per-peer one keys only tailnet or loopback
 * addresses (it runs after the transport check), and the per-key one is charged
 * only once a shared key is found, so a made-up id creates no bucket.
 *
 * Every outcome with a requester is written to `api_key_share_audit` before the
 * response leaves (the store coalesces a burst of identical refusals).
 * No body, error message or key ever reaches a log: faults are logged as an
 * error class only (`errorClass`, #5429), and a thrown error becomes the fixed
 * refusal `internal` before the root `onError` (which logs messages) sees it.
 */

/** Requests per requester and key (per requester for `shared`) per window. */
export const FEDERATION_API_KEYS_RATE_LIMIT = 60;
/** Requests per peer address per receiver per window, whatever they ask for. */
export const FEDERATION_API_KEYS_PEER_RATE_LIMIT = 240;
export const FEDERATION_API_KEYS_RATE_WINDOW_MS = 60_000;

type Refusal = { ok: false; code: string; message: string };

const refuse = (code: string, message: string): Refusal => ({
  ok: false,
  code,
  message,
});

/** How a key is named in a message: its label, else its masked form. */
function keyName(entry: StoredApiKey): string {
  return entry.label?.trim()
    ? `"${entry.label.trim()}"`
    : maskApiKey(entry.key);
}

function defaultPeerAddress(c: Context<WebAppEnv>): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

export function createFederationApiKeyRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const isTenant = deps.isTenantVm ?? (() => defaultIsTenantVm());
  const peerOf = deps.getPeerAddress ?? defaultPeerAddress;
  const keyLimiter = new FixedWindowCounter({
    limit: FEDERATION_API_KEYS_RATE_LIMIT,
    windowMs: FEDERATION_API_KEYS_RATE_WINDOW_MS,
  });
  const peerLimiter = new FixedWindowCounter({
    limit: FEDERATION_API_KEYS_PEER_RATE_LIMIT,
    windowMs: FEDERATION_API_KEYS_RATE_WINDOW_MS,
  });
  let lastLimiterPrune = 0;
  /** Charge one request; false when over the limit. Prunes at most once per
   *  window, so a flood cannot make every request scan the bucket maps. */
  function allow(counter: FixedWindowCounter, key: string): boolean {
    const now = Date.now();
    if (now - lastLimiterPrune >= FEDERATION_API_KEYS_RATE_WINDOW_MS) {
      lastLimiterPrune = now;
      keyLimiter.pruneOlderThan(2 * FEDERATION_API_KEYS_RATE_WINDOW_MS);
      peerLimiter.pruneOlderThan(2 * FEDERATION_API_KEYS_RATE_WINDOW_MS);
    }
    return counter.check(key).action === "forward";
  }
  const rateLimited = () =>
    refuse(
      "api_key_rate_limited",
      `Too many requests for API keys on ${selfLabel()}; try again in a minute`
    );
  const selfLabel = () =>
    deps.federationConfig?.nodeLabel?.trim() ||
    deps.federationConfig?.nodeId ||
    "this node";

  /** The mesh token, before anything else (also keeps an unauthenticated caller
   *  from touching the rate limiter or the audit table). */
  const requireToken: MiddlewareHandler<WebAppEnv> = async (c, next) => {
    if (!checkFederationToken(deps, c.req.header("authorization"))) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  };

  type Gate =
    | { ok: true; entries: StoredApiKey[]; peer: string | null }
    | { ok: false; refusal: Refusal; peer: string | null };

  /** The checks shared by all three receivers, after the token. */
  async function gate(
    c: Context<WebAppEnv>,
    purpose: ApiKeySharePurpose,
    requestingNodeId: string,
    homeNodeId: string | null
  ): Promise<Gate> {
    const peer = peerOf(c) ?? null;
    if (isTenant()) {
      return {
        ok: false,
        peer,
        refusal: refuse(
          "tenant_vm",
          "This node is a hosted VM and does not share API keys"
        ),
      };
    }
    const selfId = deps.federationConfig?.nodeId;
    if (!deps.federationConfig?.enabled || !isUsableNodeIdForSharing(selfId)) {
      return {
        ok: false,
        peer,
        refusal: refuse(
          "home_mismatch",
          `${selfLabel()} has no federation node id it can share keys under`
        ),
      };
    }
    if (homeNodeId !== null && homeNodeId !== selfId) {
      return {
        ok: false,
        peer,
        refusal: refuse(
          "home_mismatch",
          `This API key belongs to another node, not ${selfLabel()}`
        ),
      };
    }
    if (!homePeerAllowed(peer, c.req.raw.headers)) {
      return {
        ok: false,
        peer,
        refusal: refuse(
          "api_key_transport_refused",
          `Keys on ${selfLabel()} can be shared only over Tailscale`
        ),
      };
    }
    // After the transport check, so only a tailnet or loopback peer can create
    // a bucket here.
    if (!allow(peerLimiter, `${purpose}|${peer}`)) {
      return { ok: false, peer, refusal: rateLimited() };
    }
    const registry = deps.getNodeRegistry();
    if (
      requestingNodeId === selfId ||
      !registry ||
      !registry.knowsNode(requestingNodeId)
    ) {
      return {
        ok: false,
        peer,
        refusal: refuse(
          "api_key_requester_unknown",
          `${selfLabel()} does not know the node asking for this key`
        ),
      };
    }
    if (purpose === "list" && !allow(keyLimiter, `list|${requestingNodeId}`)) {
      return { ok: false, peer, refusal: rateLimited() };
    }
    const settingsFile = deps.getSettingsFile?.();
    const settings = settingsFile ? await readSettings(settingsFile) : null;
    if (!settings || typeof settings !== "object") {
      return {
        ok: false,
        peer,
        refusal: refuse(
          "api_key_vault_unreadable",
          `The API-key vault on ${selfLabel()} cannot be read`
        ),
      };
    }
    const entries: StoredApiKey[] = [];
    for (const raw of Array.isArray(settings.apiKeys) ? settings.apiKeys : []) {
      const parsed = StoredApiKeySchema.safeParse(raw);
      if (parsed.success) entries.push(parsed.data);
    }
    return { ok: true, entries, peer };
  }

  type AuditFields = {
    keyId: string;
    entry?: StoredApiKey;
    requestingNodeId: string;
    sessionId: string | null;
    peer: string | null;
    purpose: ApiKeySharePurpose;
    outcome: string;
  };

  /** Write the audit row. Returns false when no audit store is wired, so the
   *  caller refuses instead of serving an unaudited request. */
  function audit(f: AuditFields): boolean {
    const store = deps.getApiKeyShareAudit?.();
    if (!store) return false;
    store.append({
      timestamp: Date.now(),
      keyId: f.keyId,
      keyLabel: f.entry?.label ?? null,
      maskedKey: f.entry ? maskApiKey(f.entry.key) : null,
      requestingNodeId: f.requestingNodeId.slice(0, 64),
      peerAddress: f.peer,
      sessionId: f.sessionId,
      purpose: f.purpose,
      outcome: f.outcome,
      detail: null,
    });
    return true;
  }

  const NO_AUDIT = refuse(
    "api_key_audit_unavailable",
    "This node cannot record API-key requests, so it serves none"
  );

  /** Run a receiver body; a throw becomes the fixed refusal `internal`, logged
   *  by error class only. The message never leaves this function. */
  async function guarded(
    purpose: ApiKeySharePurpose,
    body: () => Promise<Response>,
    c: Context<WebAppEnv>
  ): Promise<Response> {
    try {
      return await body();
    } catch (error) {
      deps.errorLogger?.error("Shared API key request failed", {
        category: "api-keys",
        context: { purpose, error: errorClass(error) },
      });
      return c.json(refuse("internal", "The API key request failed"));
    }
  }

  /** The checks a key must pass before its identity or secret is served. */
  function checkKey(
    entries: StoredApiKey[],
    req: FederationApiKeyRequest
  ): { entry: StoredApiKey } | { entry?: StoredApiKey; refusal: Refusal } {
    const entry = entries.find(e => e.id === req.id);
    if (!entry || entry.provider !== "anthropic") {
      return {
        refusal: refuse(
          "api_key_not_found",
          `This API key is no longer stored on ${selfLabel()}`
        ),
      };
    }
    if (entry.shareAcrossNodes !== true) {
      return {
        entry,
        refusal: refuse(
          "api_key_not_shared",
          `This API key on ${selfLabel()} is not available to other nodes`
        ),
      };
    }
    if (
      req.expectedMasked !== undefined &&
      req.expectedMasked !== maskApiKey(entry.key)
    ) {
      return {
        entry,
        refusal: refuse(
          "api_key_changed",
          `The API key ${keyName(entry)} on ${selfLabel()} was replaced; pick it again`
        ),
      };
    }
    return { entry };
  }

  app.post(
    "/federation/api-keys/shared",
    cataloged(
      defineCapability({
        id: "accounts.federation-api-keys-shared",
        domain: "accounts",
        surface: "rest",
        description:
          "List the Anthropic keys THIS node shares with its federation, redacted (label and masked form only, never a key).",
        whenToUse:
          "Only node-to-node: a federation peer asking this node about a key it shares.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/api-keys/shared",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        telemetry: "off",
        probe: "skip",
      })
    ),
    requireToken,
    c =>
      guarded(
        "list",
        async () => {
          const body = FederationSharedApiKeysRequestSchema.safeParse(
            await c.req.json().catch(() => null)
          );
          if (!body.success) {
            return c.json(
              refuse("invalid_request", "requestingNodeId is required")
            );
          }
          const requester = body.data.requestingNodeId;
          const g = await gate(c, "list", requester, null);
          const outcome = g.ok ? "ok" : g.refusal.code;
          const audited = audit({
            keyId: "*",
            requestingNodeId: requester,
            sessionId: null,
            peer: g.peer,
            purpose: "list",
            outcome,
          });
          if (!audited) return c.json(NO_AUDIT);
          if (!g.ok) return c.json(g.refusal);
          const keys = g.entries
            .filter(
              e => e.provider === "anthropic" && e.shareAcrossNodes === true
            )
            .map(e => {
              // `descriptor` stays on this node: a passthrough object with
              // free-text notes, which the picker does not need.
              const { descriptor: _descriptor, ...redacted } =
                toRedactedApiKey(e);
              return redacted;
            });
          return c.json({
            ok: true,
            homeNodeId: deps.federationConfig?.nodeId,
            keys,
          });
        },
        c
      )
  );

  const keyRoute =
    (purpose: "resolve" | "secret") => async (c: Context<WebAppEnv>) =>
      guarded(
        purpose,
        async () => {
          const body = FederationApiKeyRequestSchema.safeParse(
            await c.req.json().catch(() => null)
          );
          if (!body.success) {
            return c.json(
              refuse(
                "invalid_request",
                "id, homeNodeId and requestingNodeId are required"
              )
            );
          }
          const req = body.data;
          const g = await gate(
            c,
            purpose,
            req.requestingNodeId,
            req.homeNodeId
          );
          const fields = {
            keyId: req.id,
            requestingNodeId: req.requestingNodeId,
            sessionId: req.sessionId ?? null,
            peer: g.peer,
            purpose,
          };
          // Every refusal is audited before it is sent; one whose audit row
          // cannot be written goes out as NO_AUDIT instead.
          const refuseAudited = (refusal: Refusal, entry?: StoredApiKey) =>
            c.json(
              audit({ ...fields, entry, outcome: refusal.code })
                ? refusal
                : NO_AUDIT
            );
          if (!g.ok) return refuseAudited(g.refusal);
          const checked = checkKey(g.entries, req);
          if ("refusal" in checked) {
            return refuseAudited(checked.refusal, checked.entry);
          }
          const { entry } = checked;
          // Charged only for a key that exists and is shared, so a made-up id
          // creates no bucket.
          if (
            !allow(keyLimiter, `${purpose}|${req.requestingNodeId}|${req.id}`)
          ) {
            return refuseAudited(rateLimited(), entry);
          }
          if (!audit({ ...fields, entry, outcome: "ok" })) {
            return c.json(NO_AUDIT);
          }
          if (purpose === "resolve") {
            return c.json({
              ok: true,
              id: entry.id,
              provider: "anthropic",
              ...(entry.label ? { label: entry.label } : {}),
              maskedKey: maskApiKey(entry.key),
              status: entry.status ?? "none",
            });
          }
          c.header("Cache-Control", "no-store");
          return c.json({ ok: true, apiKey: entry.key });
        },
        c
      );

  app.post(
    "/federation/api-keys/resolve",
    cataloged(
      defineCapability({
        id: "accounts.federation-api-keys-resolve",
        domain: "accounts",
        surface: "rest",
        description:
          "Confirm one key THIS node shares and return its label, masked form and status, never the key.",
        whenToUse:
          "Only node-to-node: a federation peer asking this node about a key it shares.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/api-keys/resolve",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        telemetry: "off",
        probe: "skip",
      })
    ),
    requireToken,
    keyRoute("resolve")
  );

  app.post(
    "/federation/api-keys/secret",
    cataloged(
      defineCapability({
        id: "accounts.federation-api-keys-secret",
        domain: "accounts",
        surface: "rest",
        description:
          "Return the secret of one key THIS node shares, to a federation peer whose session uses it. Audited; never generically invocable.",
        whenToUse:
          "Only node-to-node: a federation peer asking this node about a key it shares.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/api-keys/secret",
        },
        auth: "federation-token",
        riskTier: "destructive",
        availability: { scope: "operator" },
        telemetry: "off",
        probe: "skip",
      })
    ),
    requireToken,
    keyRoute("secret")
  );

  return app;
}
