// SPDX-License-Identifier: AGPL-3.0-only
import type { MiddlewareHandler } from "hono";
import {
  PORTER_WITHHELD_CODE,
  PORTER_WITHHELD_MESSAGE,
  type PorterWithheldBody,
} from "@hapi/protocol/porter";
import type { WebAppEnv } from "./auth";
import { porterExposed } from "../../config/porterExposureConfig";

/**
 * Configuration Porter exposure gate (issues #4533 and #5165, epic #4290).
 *
 * Porter is exposed by default (#5165), and this middleware is then a
 * pass-through. While Porter is withheld (`HAPI_PORTER_EXPOSED=0`, or any value
 * other than empty / `1` / `true` / `yes`), it answers 404 `porter_withheld`
 * and never calls `next()`, so no Porter handler, TTL sweep, staging-dir write,
 * age-keypair generation, token mint or settings write runs.
 *
 * 🔴 Mounted at the COMPOSITION ROOT (`buildWebApp.ts`) on exactly the two
 * prefixes every Porter capability lives under — `/api/porter/*` and the
 * root-mounted public `/p/*` — and registered BEFORE the Porter route mounts,
 * because Hono runs matching handlers in registration order. The mount position
 * IS the enforcement: the route factories carry no gate of their own, so their
 * direct-construction test suites are unchanged. `porterExposure.test.ts` scans
 * the full app's route table so a Porter route outside the two prefixes fails CI.
 *
 * `hapi_call` (MCP) and `hapi api call` (CLI) re-enter the app in-process
 * (`routes/capabilityCall.ts`), so they inherit this gate and relay its 404.
 *
 * The exposure check runs per request; it is registered AFTER the global
 * `/api/*` JWT gate, so a JWT-gated Porter path still answers 401 to a caller
 * with no token, and the exact-match auth-exempt `/api/porter/recipient/public`
 * reaches this gate unauthenticated and gets the 404.
 */
export function createPorterExposureGate(): MiddlewareHandler<WebAppEnv> {
  return async (c, next) => {
    if (porterExposed()) {
      await next();
      return;
    }
    const body: PorterWithheldBody = {
      error: PORTER_WITHHELD_MESSAGE,
      code: PORTER_WITHHELD_CODE,
    };
    return c.json(body, 404);
  };
}
