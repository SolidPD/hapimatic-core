// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Local hardware companion routes (issue #4352, Task 2).
 *
 * Two factories, mounted at two different points in `buildWebApp.ts`:
 *
 *  - `createCompanionHelperRoutes` — `/api/companion/helper/*`, used by the bench
 *    helper (`hapi companion start`). Mounted BEFORE the global JWT middleware:
 *    pair-request creation is unauthenticated (rate-limited per client address,
 *    capped globally), the claim is authenticated by its poll secret, and the
 *    heartbeat and end routes by the pairing-scoped `hcp_` token. That token is
 *    valid nowhere else: these handlers check it themselves, and the JWT
 *    middleware refuses any `hcp_` bearer token outright.
 *  - `createCompanionRoutes` — `/api/companion/*` for the VM side (the web UI and
 *    `hapi companion pair|list|ssh|revoke`, which authenticate with a JWT minted
 *    from the instance's CLI token). Mounted AFTER the JWT middleware.
 *
 * Both answer 404 `companion_disabled` unless the server runs with
 * `HAPI_COMPANION=1` (`getService()` returns `null`). Design:
 * docs/internal/architecture/hardware-companion.md.
 *
 * Import hygiene: type-checked by `typecheck:cli` too — relative and `@hapi/*`
 * imports only.
 */
import { Hono, type Context } from "hono";
import { defineCapability } from "@hapi/protocol";
import {
  CompanionCertificateRequestSchema,
  CompanionClaimSchema,
  CompanionCodeConfirmSchema,
  CompanionCodeLookupSchema,
  CompanionHeartbeatSchema,
  CompanionPairRequestCreateSchema,
} from "@hapi/protocol/companion";
import type { ZodType } from "zod";
import { cataloged } from "../../capabilities/cataloged";
import { clientAddrKey } from "../clientAddress";
import type { WebAppEnv } from "../middleware/auth";
import { createRateLimiter } from "../middleware/rateLimit";
import {
  CompanionError,
  type CompanionPairingService,
} from "../../services/companionPairingService";

export type CompanionRoutesOptions = {
  /** The service, or `null` when `HAPI_COMPANION` is off. */
  getService: () => CompanionPairingService | null;
};

function disabled(c: Context<WebAppEnv>) {
  return c.json(
    {
      error: "companion_disabled",
      message: "The companion is not enabled on this server",
    },
    404
  );
}

function fail(c: Context<WebAppEnv>, error: unknown) {
  if (error instanceof CompanionError) {
    return c.json({ error: error.code, message: error.message }, error.status);
  }
  throw error;
}

async function readJson<T>(
  c: Context<WebAppEnv>,
  schema: ZodType<T>
): Promise<{ ok: true; value: T } | { ok: false }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false };
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

function bearer(c: Context<WebAppEnv>): string | undefined {
  const header = c.req.header("authorization");
  return header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : undefined;
}

const badRequest = (c: Context<WebAppEnv>) =>
  c.json({ error: "invalid_request", message: "Invalid request body" }, 400);

/** Bench-helper routes — mount BEFORE the JWT middleware. */
export function createCompanionHelperRoutes(
  opts: CompanionRoutesOptions
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.post(
    "/companion/helper/pair-requests",
    cataloged(
      defineCapability({
        id: "machine-daemon.companion-pair-request",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Open a pending companion pairing request from a bench helper; returns a short code the owner confirms on the VM.",
        whenToUse: "Called by hapi companion start on the bench machine.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/companion/helper/pair-requests",
        },
        auth: "none",
        riskTier: "mutating",
        availability: { scope: "user", mountedWhen: "HAPI_COMPANION=1" },
        probe: "skip",
      })
    ),
    createRateLimiter({
      name: "companion-pair-request",
      limit: 10,
      windowMs: 60_000,
      keyFn: clientAddrKey,
    }),
    async c => {
      const service = opts.getService();
      if (!service) return disabled(c);
      const body = await readJson(c, CompanionPairRequestCreateSchema);
      if (!body.ok) return badRequest(c);
      try {
        return c.json(await service.createPairRequest(body.value), 201);
      } catch (error) {
        return fail(c, error);
      }
    }
  );

  app.post(
    "/companion/helper/pair-requests/:requestId/claim",
    cataloged(
      defineCapability({
        id: "machine-daemon.companion-pair-claim",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Poll a companion pairing request; once confirmed, returns the pairing token and CA public key exactly once.",
        whenToUse:
          "Called by hapi companion start while it waits for the owner.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/companion/helper/pair-requests/:requestId/claim",
        },
        auth: "none",
        riskTier: "mutating",
        availability: { scope: "user", mountedWhen: "HAPI_COMPANION=1" },
        probe: "skip",
      })
    ),
    createRateLimiter({
      name: "companion-pair-claim",
      limit: 60,
      windowMs: 60_000,
      keyFn: clientAddrKey,
    }),
    async c => {
      const service = opts.getService();
      if (!service) return disabled(c);
      const body = await readJson(c, CompanionClaimSchema);
      if (!body.ok) return badRequest(c);
      try {
        return c.json(
          service.claimPairRequest(
            c.req.param("requestId"),
            body.value.pollSecret
          )
        );
      } catch (error) {
        return fail(c, error);
      }
    }
  );

  app.post(
    "/companion/helper/heartbeat",
    cataloged(
      defineCapability({
        id: "machine-daemon.companion-heartbeat",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Bench helper heartbeat: liveness, approve/deny decisions and instance reports in; the principals to admit and their renewed validity out.",
        whenToUse: "Called by a running bench helper every heartbeat interval.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/companion/helper/heartbeat",
        },
        auth: "none",
        riskTier: "mutating",
        availability: { scope: "user", mountedWhen: "HAPI_COMPANION=1" },
        probe: "skip",
      })
    ),
    async c => {
      const service = opts.getService();
      if (!service) return disabled(c);
      const body = await readJson(c, CompanionHeartbeatSchema);
      if (!body.ok) return badRequest(c);
      try {
        const pairingId = service.authenticateHelper(bearer(c));
        return c.json(service.heartbeat(pairingId, body.value));
      } catch (error) {
        return fail(c, error);
      }
    }
  );

  app.post(
    "/companion/helper/end",
    cataloged(
      defineCapability({
        id: "machine-daemon.companion-helper-end",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "The bench helper ends its pairing on Stop; the pairing's CA is discarded.",
        whenToUse: "Called by hapi companion when the bench user stops it.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/companion/helper/end",
        },
        auth: "none",
        riskTier: "destructive",
        availability: { scope: "user", mountedWhen: "HAPI_COMPANION=1" },
        probe: "skip",
      })
    ),
    c => {
      const service = opts.getService();
      if (!service) return disabled(c);
      try {
        service.endByHelper(service.authenticateHelper(bearer(c)));
        return c.json({ ok: true });
      } catch (error) {
        return fail(c, error);
      }
    }
  );

  return app;
}

/** VM-side routes — mount AFTER the JWT middleware. */
export function createCompanionRoutes(
  opts: CompanionRoutesOptions
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const codeLimiter = () =>
    createRateLimiter({
      name: "companion-code-entry",
      limit: 10,
      windowMs: 10 * 60_000,
    });

  app.get(
    "/companion/pairings",
    cataloged(
      defineCapability({
        id: "machine-daemon.companion-pairings",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "List this owner's bench pairings, their live state and principals, and the pairing requests waiting for a code.",
        whenToUse:
          "To show which bench machines are paired and who is connected.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/companion/pairings",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user", mountedWhen: "HAPI_COMPANION=1" },
      })
    ),
    c => {
      const service = opts.getService();
      if (!service) return disabled(c);
      return c.json(service.list(c.get("namespace")));
    }
  );

  app.post(
    "/companion/pair-requests/lookup",
    cataloged(
      defineCapability({
        id: "machine-daemon.companion-code-lookup",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Show the bench machine, account and host-key fingerprint behind a pairing code before confirming it.",
        whenToUse:
          "When the owner enters the code shown by hapi companion start.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/companion/pair-requests/lookup",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user", mountedWhen: "HAPI_COMPANION=1" },
        probe: "skip",
      })
    ),
    codeLimiter(),
    async c => {
      const service = opts.getService();
      if (!service) return disabled(c);
      const body = await readJson(c, CompanionCodeLookupSchema);
      if (!body.ok) return badRequest(c);
      try {
        return c.json(service.lookupCode(body.value.code));
      } catch (error) {
        return fail(c, error);
      }
    }
  );

  app.post(
    "/companion/pair-requests/confirm",
    cataloged(
      defineCapability({
        id: "machine-daemon.companion-code-confirm",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Confirm a pairing code with the host-key fingerprint shown to the owner; creates the pairing and its in-memory CA.",
        whenToUse: "After the owner compared the bench host-key fingerprint.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/companion/pair-requests/confirm",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user", mountedWhen: "HAPI_COMPANION=1" },
        probe: "skip",
      })
    ),
    codeLimiter(),
    async c => {
      const service = opts.getService();
      if (!service) return disabled(c);
      const body = await readJson(c, CompanionCodeConfirmSchema);
      if (!body.ok) return badRequest(c);
      try {
        return c.json(
          await service.confirmCode(
            c.get("namespace"),
            body.value.code,
            body.value.hostKeyFingerprint
          )
        );
      } catch (error) {
        return fail(c, error);
      }
    }
  );

  app.delete(
    "/companion/pairings/:pairingId",
    cataloged(
      defineCapability({
        id: "machine-daemon.companion-revoke",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Revoke a bench pairing: its CA is discarded and the helper tears down at its next heartbeat.",
        whenToUse: "To cut a paired bench machine off from this VM.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/companion/pairings/:pairingId",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "user", mountedWhen: "HAPI_COMPANION=1" },
        probe: "skip",
      })
    ),
    c => {
      const service = opts.getService();
      if (!service) return disabled(c);
      try {
        service.revoke(c.get("namespace"), c.req.param("pairingId"));
        return c.json({ ok: true });
      } catch (error) {
        return fail(c, error);
      }
    }
  );

  app.post(
    "/companion/certificates",
    cataloged(
      defineCapability({
        id: "machine-daemon.companion-certificate",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Ask for a short-lived SSH certificate so a cloud session can reach the paired bench; the bench must approve the session first.",
        whenToUse: "Called by hapi companion ssh inside a cloud session.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/companion/certificates",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user", mountedWhen: "HAPI_COMPANION=1" },
        probe: "skip",
      })
    ),
    async c => {
      const service = opts.getService();
      if (!service) return disabled(c);
      const body = await readJson(c, CompanionCertificateRequestSchema);
      if (!body.ok) return badRequest(c);
      try {
        return c.json(
          service.requestCertificate(c.get("namespace"), body.value)
        );
      } catch (error) {
        return fail(c, error);
      }
    }
  );

  return app;
}
