// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server entry point for `builtin.extension-marketplace` (issue #1292, PR-2).
 *
 * Server-only and stateless (like `builtin.github-issues`): no service, no store, no lifecycle
 * hooks. `register()` mounts the marketplace route factory via `host.routes.add` — the loader
 * invokes it and mounts the returned Hono app under `/api` AFTER the JWT auth middleware, so
 * `GET /api/ext/catalog` and `POST /api/ext/install` are authenticated.
 */
import type { ServerRegister } from "@hapi/protocol/ext";

import type { ErrorLogger } from "../../logging/errorLogger";
import { createMarketplaceRoutes } from "./routes";

export const register: ServerRegister = host => {
  const errorLogger = host.getErrorLogger() as ErrorLogger | null;
  host.routes.add(() => createMarketplaceRoutes({ errorLogger }));
};
