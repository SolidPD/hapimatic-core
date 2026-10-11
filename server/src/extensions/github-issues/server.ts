// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server entry point for `builtin.github-issues` (issue #1280, Sub-Issue P of
 * epic #1264).
 *
 * Migrates the read-only GitHub issue/repo/account proxy out of the inline
 * `app.route("/api", createGitHubRoutes(...))` mount in `server/src/web/server.ts`.
 * The routes shell out to the host-authenticated `gh` CLI; no OAuth exists (the
 * issue title "github-oauth" is a misnomer — see #1280 research findings).
 *
 * Server-only and stateless: no service, no store, no lifecycle hooks. `register()`
 * mounts the route factory via `host.routes.add` (the loader invokes each factory
 * with `undefined` and mounts the returned Hono app under `/api` AFTER the JWT auth
 * middleware — the same post-auth position the inline mount occupied, so the
 * `/api/github/*` URLs and their auth gating are byte-for-byte preserved).
 *
 * DI note (locked contract §3c): `getNodeRegistry` is passed as a LATE-BOUND
 * getter because federation initializes AFTER extensions load — the
 * `/github/repo-issues` and `/github/{accounts,repos}` routes resolve it lazily
 * at request time (a federated `nodeId` query param routes the gh lookup to a
 * peer node). The `ErrorLogger`, being core infrastructure constructed before
 * the extension loader runs, resolves eagerly here in `register()`.
 */
import type { ServerRegister } from "@hapi/protocol/ext";

import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { ErrorLogger } from "../../logging/errorLogger";
import { createGitHubRoutes } from "./routes";

export const register: ServerRegister = host => {
  const errorLogger = host.getErrorLogger() as ErrorLogger | null;

  host.routes.add(() =>
    createGitHubRoutes({
      getNodeRegistry: () => host.getNodeRegistry() as NodeRegistry | null,
      errorLogger,
    })
  );
};
