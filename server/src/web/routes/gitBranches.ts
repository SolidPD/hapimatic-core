// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import type { GitBranchListing } from "@hapi/protocol/gitBranches";
import type { WebAppEnv } from "../middleware/auth";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { ErrorLogger } from "../../logging/errorLogger";
import { cataloged } from "../../capabilities/cataloged";
import { expandTilde, isTildePath } from "../../utils/expandTilde";
import { isSafeMachinePath } from "../../utils/pathSecurity";
import { listGitBranches } from "../../utils/gitBranches";

export type GitBranchesResponse =
  | { success: true; listing: GitBranchListing }
  | { success: false; error: string };

/**
 * GET /api/git/branches?dir=<abs|~path>[&nodeId=<peer>] (hapimatic-private#4481)
 *
 * The Create page's Branch control data source. Local target → git runs
 * in-process on this node; remote target → proxied to the peer's
 * `/api/federation/git-branches`, which runs the same utility on ITS disk.
 * Mirrors the directory handling of `/api/github/repo-issues` (#3558 tilde rules).
 *
 * A lookup failure is reported as HTTP 200 `{success:false}` so the web maps it
 * to "unavailable" and falls back to today's controls; malformed input is 400.
 */
export function createGitBranchesRoutes(options?: {
  getNodeRegistry?: () => NodeRegistry | null;
  errorLogger?: ErrorLogger | null;
  /** Test seam — defaults to the real git runner. */
  listBranches?: (directory: string) => Promise<GitBranchListing>;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const listBranches = options?.listBranches ?? listGitBranches;

  app.get(
    "/git/branches",
    cataloged(
      defineCapability({
        id: "harness-admin.git-branches",
        domain: "harness-admin",
        surface: "rest",
        description:
          "List a directory's git branches (current, local, remote-only, held by other worktrees) on the local or a remote node.",
        whenToUse: "When the Create page's Branch control loads a directory.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/git/branches",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const dir = c.req.query("dir")?.trim() ?? "";
      if (!dir || (!dir.startsWith("/") && !isTildePath(dir))) {
        return c.json(
          {
            success: false,
            error: "Invalid directory path",
          } satisfies GitBranchesResponse,
          400
        );
      }

      const nodeId = c.req.query("nodeId");
      if (nodeId) {
        const registry = options?.getNodeRegistry?.();
        if (!registry) {
          return c.json({
            success: false,
            error: "Federation not available",
          } satisfies GitBranchesResponse);
        }
        // Pre-expand a tilde with the node's advertised home when known;
        // otherwise forward raw — the peer expands with its own home.
        const nodeHome = isTildePath(dir)
          ? registry.getNodeSummaries().find(n => n.nodeId === nodeId)?.homeDir
          : undefined;
        const remoteDir = nodeHome ? expandTilde(dir, nodeHome) : dir;
        const result = await registry.listGitBranchesOnNode(nodeId, remoteDir);
        if (result.type === "error") {
          return c.json({
            success: false,
            error: result.message,
          } satisfies GitBranchesResponse);
        }
        return c.json({
          success: true,
          listing: result.listing,
        } satisfies GitBranchesResponse);
      }

      const localDir = expandTilde(dir);
      if (!isSafeMachinePath(localDir)) {
        return c.json(
          {
            success: false,
            error: "Access denied",
          } satisfies GitBranchesResponse,
          403
        );
      }
      try {
        const listing = await listBranches(localDir);
        return c.json({ success: true, listing } satisfies GitBranchesResponse);
      } catch (error) {
        options?.errorLogger?.warn("[git-branches] listing failed", {
          category: "git-branches",
          stack: error instanceof Error ? error.stack : null,
          context: { directory: localDir },
        });
        return c.json({
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to list branches",
        } satisfies GitBranchesResponse);
      }
    }
  );

  return app;
}
