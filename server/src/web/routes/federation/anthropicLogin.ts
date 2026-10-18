// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import type { WebAppEnv } from "../../middleware/auth";
import { cataloged } from "../../../capabilities/cataloged";
import { RedactedAccountSchema } from "../../../services/accountService";
import { IN_VM_SIGN_IN_REQUIRED } from "../../../services/accountLoginService";
import { checkFederationToken, type FederationDeps } from "./shared";

/**
 * Node-targeted Anthropic login, peer side (issue #4462, epic #4460 B).
 *
 *   POST /api/federation/anthropic-login/start    — run the PKCE start on THIS node
 *   POST /api/federation/anthropic-login/complete — exchange the code on THIS node
 *
 * The hub's `/api/accounts/login/{start,complete}` proxy here when the user names
 * this node, so the new refresh chain is minted and stored on the node that will
 * use it (a chain is single-use: never copy a record between nodes, #4423). The
 * PKCE pending map lives in this process, so `complete` must reach the node that
 * ran `start`; the hub routes it by the node id it wraps into the login token.
 *
 * Both answer HTTP 200 with `{ ok, ... }` for every login outcome, because the
 * hub's generic proxy drops a non-2xx body's `code` (the loop-cron precedent).
 * Fed-token gated like the OpenAI login receivers (`./accounts.ts`). Every
 * success body is re-parsed through the whitelist `RedactedAccountSchema`, so no
 * access token, refresh token or PKCE verifier can cross; the hub parses again on
 * ingress (#4461 R4 rule).
 *
 * Separate file (not `./accounts.ts`) to stay clear of #3982's hunks there.
 */
const completeBodySchema = z.object({
  loginToken: z.string().min(1),
  code: z.string().min(1),
  state: z.string().optional(),
});

const IN_VM_REFUSAL =
  "This node is a hosted VM: sign in there with Claude Code's own /login.";

export function createFederationAnthropicLoginRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.post(
    "/federation/anthropic-login/start",
    cataloged(
      defineCapability({
        id: "accounts.federation-anthropic-login-start",
        domain: "accounts",
        surface: "rest",
        description:
          "Begin an Anthropic OAuth (PKCE) login on THIS node for the hub; returns the authorize URL and an opaque login token, never a token or verifier.",
        whenToUse:
          "When the hub proxies a node-targeted Anthropic login to the node that will store the account.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/anthropic-login/start",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const svc = deps.getAccountLoginService?.();
      if (!svc) {
        return c.json({ error: "Account login service unavailable" }, 503);
      }
      // #4349: a tenant VM runs no OAuth flow. Answered as a login outcome (200) so
      // the hub can name this node instead of falling back to a local sign-in.
      if (svc.inVmSignInRequired()) {
        return c.json({
          ok: false,
          code: IN_VM_SIGN_IN_REQUIRED,
          error: IN_VM_REFUSAL,
        });
      }
      try {
        const { loginToken, authorizeUrl } = svc.start();
        return c.json({ ok: true, loginToken, authorizeUrl });
      } catch (error) {
        deps.errorLogger?.error("Federation Anthropic login start failed", {
          category: "accounts",
          context: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
        return c.json({ error: "Failed to start account login" }, 500);
      }
    }
  );

  app.post(
    "/federation/anthropic-login/complete",
    cataloged(
      defineCapability({
        id: "accounts.federation-anthropic-login-complete",
        domain: "accounts",
        surface: "rest",
        description:
          "Complete an Anthropic OAuth login on THIS node for the hub: exchange the code, store the account here, and return only the redacted account.",
        whenToUse:
          "When the hub forwards the authorization code of a login it started on this node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/anthropic-login/complete",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const svc = deps.getAccountLoginService?.();
      if (!svc) {
        return c.json({ error: "Account login service unavailable" }, 503);
      }
      const parsed = completeBodySchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success) {
        return c.json({
          ok: false,
          code: "invalid_request",
          error: "loginToken and code are required",
        });
      }
      try {
        const result = await svc.complete(parsed.data);
        if (!result.ok) {
          return c.json({
            ok: false,
            code: result.code,
            error:
              result.code === IN_VM_SIGN_IN_REQUIRED
                ? IN_VM_REFUSAL
                : result.error,
          });
        }
        // Same post-login refresh as the local route (routes/accounts.ts): the
        // usage snapshot is push-to-cache and would otherwise miss the new
        // account until the sampler's next cycle. Fire-and-forget.
        void deps
          .getUsageService?.()
          ?.refresh()
          .catch(() => undefined);
        return c.json({
          ok: true,
          account: RedactedAccountSchema.parse(result.account),
        });
      } catch (error) {
        deps.errorLogger?.error("Federation Anthropic login complete failed", {
          category: "accounts",
          context: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
        return c.json({ error: "Failed to complete account login" }, 500);
      }
    }
  );

  return app;
}
