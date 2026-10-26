// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from "hono";
import { getConnInfo } from "hono/bun";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import { isDirectLoopbackRequest } from "../../federation/secretTransport";
import type { ErrorLogger } from "../../logging/errorLogger";
import type { SharedApiKeyService } from "../../services/sharedApiKeyService";
import type { Session, SyncEngine } from "../../sync/syncEngine";
import { createRateLimiter } from "../middleware/rateLimit";
import { errorClass } from "./apiKeys";
import type { CliEnv } from "./cli";

/**
 * Shared API keys across federation nodes, CLI surface (issue #5127).
 *
 *   POST /cli/api-keys/resolve — a reference's label, masked form and home node
 *   POST /cli/api-keys/secret  — a foreign key's secret, for a session's helper
 *
 * A session whose key lives on another node binds `<uuid>@<homeNodeId>`. Its
 * daemon and launcher resolve the binding here, and its Claude Code
 * `apiKeyHelper` fetches the secret here (at start and about every 5 minutes);
 * this node asks the key's home over the federation link each time.
 *
 * Mounted inside `createCliRoutes`, behind its CLI-token middleware (the
 * namespace comes from the token). Both routes also serve only a direct request
 * from this host: Caddy (cloud VMs) and Tailscale Serve connect from loopback
 * too, but add forwarding headers, and such a request is refused.
 */

type ResolveSession = (
  engine: SyncEngine,
  sessionIdOrTag: string,
  namespace: string
) =>
  | { ok: true; session: Session }
  | { ok: false; status: 403 | 404; error: string };

export function createCliApiKeyRoutes(
  getSyncEngine: () => SyncEngine | null,
  opts: {
    errorLogger?: ErrorLogger | null;
    sharedApiKeyService?: SharedApiKeyService;
    /** Test seam: the TCP peer of a request (Bun's getConnInfo). */
    getPeerAddress?: (c: Context) => string | undefined;
    /** `resolveSessionForNamespace` from ./cli (injected, no import cycle). */
    resolveSession: ResolveSession;
  }
): Hono<CliEnv> {
  const app = new Hono<CliEnv>();
  const { errorLogger = null, sharedApiKeyService, resolveSession } = opts;
  const apiKeyLimiter = createRateLimiter({ name: "cli-api-keys", limit: 120 });
  const peerOf = (c: Context): string | undefined => {
    if (opts.getPeerAddress) return opts.getPeerAddress(c);
    try {
      return getConnInfo(c).remote.address;
    } catch {
      return undefined;
    }
  };
  const LOCAL_ONLY = {
    ok: false,
    code: "api_key_local_only",
    message: "API keys are served only to this host",
  } as const;
  const UNAVAILABLE = {
    ok: false,
    code: "unavailable",
    message: "Shared API keys are unavailable on this node",
  } as const;
  const resolveSchema = z.object({
    ref: z.string().min(1).max(200),
    expectedMasked: z.string().max(64).optional(),
    // Recorded in the home's audit row (R10); not checked here — a spawn
    // resolves before its session exists.
    sessionId: z.string().min(1).max(128).optional(),
  });
  const secretSchema = z.object({
    ref: z.string().min(1).max(200),
    expectedMasked: z.string().min(1).max(64),
    sessionId: z.string().min(1).max(128),
  });

  app.post(
    "/api-keys/resolve",
    cataloged(
      defineCapability({
        id: "accounts.cli-api-key-resolve",
        domain: "accounts",
        surface: "rest",
        description:
          "Resolve an API-key reference to its label, masked form and home node for a spawning or relaunching session, asking the key's home node when it lives elsewhere. Never returns a key.",
        whenToUse:
          "When the daemon or launcher checks a session's API-key binding.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/cli/api-keys/resolve",
        },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user" },
        telemetry: "off",
        probe: "skip",
      })
    ),
    apiKeyLimiter,
    async c => {
      if (!isDirectLoopbackRequest(peerOf(c), c.req.raw.headers)) {
        return c.json(LOCAL_ONLY, 403);
      }
      const parsed = resolveSchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success) {
        return c.json(
          { ok: false, code: "invalid_request", message: "ref is required" },
          400
        );
      }
      if (!sharedApiKeyService) return c.json(UNAVAILABLE, 503);
      const r = await sharedApiKeyService.resolve(
        parsed.data.ref,
        parsed.data.expectedMasked,
        parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {}
      );
      if (!r.ok) return c.json({ ok: false, code: r.code, message: r.message });
      return c.json({
        ok: true,
        canonicalRef: r.canonicalRef,
        label: r.label,
        maskedKey: r.maskedKey,
        homeNodeId: r.homeNodeId,
        homeNodeLabel: r.homeNodeLabel,
      });
    }
  );

  app.post(
    "/api-keys/secret",
    cataloged(
      defineCapability({
        id: "accounts.cli-api-key-secret",
        domain: "accounts",
        surface: "rest",
        description:
          "Return the secret of an API key homed on another federation node, to the apiKeyHelper of a session bound to it on this host.",
        whenToUse:
          "Only from a session's Claude Code apiKeyHelper, for a key stored on another node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/cli/api-keys/secret",
        },
        auth: "cli-token",
        riskTier: "destructive",
        availability: { scope: "user" },
        telemetry: "off",
        probe: "skip",
      })
    ),
    apiKeyLimiter,
    async c => {
      try {
        if (!isDirectLoopbackRequest(peerOf(c), c.req.raw.headers)) {
          return c.json(LOCAL_ONLY, 403);
        }
        const parsed = secretSchema.safeParse(
          await c.req.json().catch(() => null)
        );
        if (!parsed.success) {
          return c.json(
            {
              ok: false,
              code: "invalid_request",
              message: "ref, expectedMasked and sessionId are required",
            },
            400
          );
        }
        const engine = getSyncEngine();
        if (!engine || !sharedApiKeyService) return c.json(UNAVAILABLE, 503);
        // A guard against a confused caller, not a security boundary: any
        // holder of this token can register a session with any metadata.
        const found = resolveSession(
          engine,
          parsed.data.sessionId,
          c.get("namespace")
        );
        if (!found.ok || found.session.metadata?.apiKeyId !== parsed.data.ref) {
          return c.json(
            {
              ok: false,
              code: "api_key_session_mismatch",
              message: "This session is not bound to that API key",
            },
            403
          );
        }
        const r = await sharedApiKeyService.fetchSecret(
          parsed.data.ref,
          parsed.data.expectedMasked,
          found.session.id
        );
        if (!r.ok) {
          return c.json({ ok: false, code: r.code, message: r.message });
        }
        c.header("Cache-Control", "no-store");
        return c.json({ ok: true, apiKey: r.apiKey });
      } catch (error) {
        errorLogger?.error("Shared API key fetch failed", {
          category: "api-keys",
          context: { error: errorClass(error) },
        });
        return c.json(
          {
            ok: false,
            code: "internal",
            message: "The API key request failed",
          },
          500
        );
      }
    }
  );

  return app;
}
