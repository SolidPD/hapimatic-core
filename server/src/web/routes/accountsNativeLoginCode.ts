// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { AccountLoginService } from "../../services/accountLoginService";
import type { UsageService } from "../../accounts/usageService";
import type { WebAppEnv } from "../middleware/auth";
import { createRateLimiter } from "../middleware/rateLimit";

/** Longer than a resolved code needs: the service waits up to 20 s per submit. */
const SUBMIT_LIMIT_PER_MINUTE = 20;

const STATUS_BY_CODE = {
  invalid_code: 400,
  expired_state: 400,
  signing_in: 202,
  already_added: 409,
  exchange_failed: 422,
} as const;

/**
 * `POST /accounts/native-login/code` — the tenant-VM paste sign-in (#6211). The
 * body's code goes to the stdin of the unmodified `claude auth login` running
 * for this sign-in, and nowhere else: never to a log, the error table or a
 * response. It travels only in the POST body because the request logger prints
 * URLs. Its own file because `routes/accounts.ts` sits near its `max-lines`
 * ceiling.
 *
 * Answers 200 `{ok, account}`; 202 `signing_in` (the client keeps polling
 * `native-login/complete`); 400 `invalid_code` (the flow is still alive) or
 * `expired_state`; 409 `already_added`; 422 `exchange_failed` (the flow is spent,
 * so the client offers a new link).
 *
 * Mounted after the global JWT gate in `buildWebApp.ts`.
 */
export function createAccountsNativeLoginCodeRoutes(opts: {
  getLoginService: () => AccountLoginService | undefined;
  getUsageService?: () => UsageService | undefined;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const limiter = createRateLimiter({
    name: "accounts-native-login-code",
    limit: SUBMIT_LIMIT_PER_MINUTE,
  });

  app.post(
    "/accounts/native-login/code",
    cataloged(
      defineCapability({
        id: "accounts.native-login-code",
        domain: "accounts",
        surface: "rest",
        description:
          "On a tenant VM, pass a pasted authorization code to the unmodified claude binary signing in here, and register the account if it finished. The code is not stored or logged.",
        whenToUse:
          "When a user adding a Claude account on a tenant VM has opened the sign-in page from native-login/start and pasted the code it showed.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/accounts/native-login/code",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    limiter,
    async c => {
      const login = opts.getLoginService();
      if (!login) {
        return c.json({ error: "Account login service unavailable" }, 503);
      }
      const body = (await c.req.json().catch(() => null)) as {
        loginToken?: unknown;
        code?: unknown;
      } | null;
      if (
        typeof body?.loginToken !== "string" ||
        !body.loginToken ||
        typeof body.code !== "string" ||
        !body.code
      ) {
        return c.json(
          {
            ok: false,
            error: "loginToken and code are required",
            code: "invalid_request",
          },
          400
        );
      }
      const result = await login.submitInVmCode(
        body.loginToken,
        body.code,
        c.get("namespace") ?? ""
      );
      if (result.ok) {
        void opts
          .getUsageService?.()
          ?.refresh()
          .catch(() => undefined);
        return c.json({ ok: true, account: result.account });
      }
      return c.json(
        { ok: false, error: result.error, code: result.code },
        STATUS_BY_CODE[result.code]
      );
    }
  );

  return app;
}
