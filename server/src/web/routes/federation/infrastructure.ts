// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { homedir } from "node:os";
import type { WebAppEnv } from "../../middleware/auth";
import type { FederationDeps } from "./shared";
import { checkFederationToken, startTime } from "./shared";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../../capabilities/cataloged";
import { VERSION } from "../../../version.generated";
import { gatherSystemHealth } from "../../../metrics/systemHealth";
import { gatherAboutInfo } from "../../../metrics/aboutInfo";
import { detectCapabilities } from "../../../federation/capabilityDetector";
import {
  isSafeMachinePath,
  validateCreateDirectoryTarget,
} from "../../../utils/pathSecurity";
import { isGitRepo, resolveRepoIdentity } from "../../../utils/repoIdentity";
import { expandTilde } from "../../../utils/expandTilde";
import { listGitBranches } from "../../../utils/gitBranches";
import {
  fetchGitHubAccounts,
  fetchGitHubRepos,
} from "../../../utils/githubCli";
import { getDaemonCapacity } from "../../../utils/daemonControlClient";

export function createInfrastructureRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // ─── Node-to-node endpoint: GET /federation/info ───────────────
  app.get(
    "/federation/info",
    cataloged(
      defineCapability({
        id: "federation.info",
        domain: "federation",
        surface: "rest",
        description:
          "Advertise this node's identity, version, role, live session count, uptime, platform, home directory, and spawn capacity to a peer.",
        whenToUse:
          "When a peer polls this node's identity and capacity over the mesh.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/info",
        },
        auth: "federation-token",
        riskTier: "readonly",
        availability: { scope: "operator" },
        telemetry: "off",
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const config = deps.federationConfig;
      if (!config) {
        return c.json({ error: "Federation not enabled" }, 503);
      }

      const engine = deps.getSyncEngine();
      // Issue #1477: report only LIVE (active) sessions, not total/exited records.
      // getActiveSessions() filters session.active (sessionCache.ts); the previous
      // getSessions().length counted stale/exited records and inflated the count.
      // Consumed per-node by the hub's NodeRegistry, so the hub now shows live
      // per-node counts. NOTE: this is still NOT the spawn-gate number — see the
      // daemon's effectiveCount (/effective-count) for authoritative spawn capacity.
      const sessionCount = engine ? engine.getActiveSessions().length : 0;

      // #1805: advertise THIS node's authoritative spawn capacity so the hub can
      // meter a remote spawn target (R3). Reads the local daemon's
      // /effective-count. On error the fields are omitted (they're optional →
      // the consumer degrades to "unknown"). `sessionCount` is left exactly as-is
      // — it is a DIFFERENT number (live session records, NOT the spawn-gate
      // count) and must NOT be overloaded (the load-bearing #1477 constraint).
      const capacity = await getDaemonCapacity();
      const capacityFields =
        "error" in capacity
          ? {}
          : {
              effectiveCount: capacity.effectiveCount,
              maxConcurrent: capacity.maxConcurrent,
              // #4417: advertise the warn-at count + resolved source so the hub can
              // meter + show the source for a REMOTE target. Both optional — omitted
              // when this node's daemon didn't report them (fail-open).
              ...(capacity.recommendedConcurrent !== undefined
                ? { recommendedConcurrent: capacity.recommendedConcurrent }
                : {}),
              ...(capacity.capSource !== undefined
                ? { capSource: capacity.capSource }
                : {}),
            };

      return c.json({
        node: {
          nodeId: config.nodeId,
          nodeLabel: config.nodeLabel,
          version: VERSION,
          role: config.role,
          // Issue #1644: hub advertises the lease-coordinator capability via /federation/info.
          capabilities: detectCapabilities({ role: config.role }),
          sessionCount,
          uptime: Date.now() - startTime,
          platform: process.platform,
          // Issue #2533: advertise this node's home dir so the hub can seed the
          // Create page's Directory field for a remote spawn target (same source
          // as version.ts's defaultDirectory, re-emitted on the fed-token channel).
          homeDir: homedir(),
          ...capacityFields,
        },
      });
    }
  );

  // ─── Node-to-node endpoint: GET /federation/node-metrics ───────
  // Peer-facing system-health metrics for the hub's HealthAggregator to poll
  // (#1445). The local /api/system-health is JWT-gated (#1062 M-3) and the hub
  // holds only the federationApiToken, so a fed-token-gated channel is required.
  // Exposes the same metrics shape as /system-health (consistent with
  // /federation/info already exposing node identity over this channel).
  app.get(
    "/federation/node-metrics",
    cataloged(
      defineCapability({
        id: "federation.node-metrics",
        domain: "federation",
        surface: "rest",
        description:
          "Serve this node's live system-health metrics to a peer's health aggregator over the federation channel.",
        whenToUse:
          "When a peer polls this node's CPU, memory, and load for the health panel.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/node-metrics",
        },
        auth: "federation-token",
        riskTier: "readonly",
        availability: { scope: "operator" },
        telemetry: "off",
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      if (!deps.federationConfig) {
        return c.json({ error: "Federation not enabled" }, 503);
      }
      return c.json(await gatherSystemHealth());
    }
  );

  // ─── Node-to-node endpoint: POST /federation/about ─────────────
  // Peer-facing About payload (host identity + harness enumeration) for the
  // hub's client `/api/about?nodeId=` proxy to render a REMOTE node's About
  // (#1984, Epic #1981 B3). POST (not GET) because `NodeRegistry.proxyToNode`
  // is POST-only and returns the receiver's JSON raw — so this receiver OWNS
  // the `{ type: "success", about }` discriminated-union envelope (OR-1). Like
  // node-metrics / info, About is node-global identity, so it is
  // federation-token-gated ONLY — no `checkCallerNamespace`.
  app.post(
    "/federation/about",
    cataloged(
      defineCapability({
        id: "federation.about",
        domain: "federation",
        surface: "rest",
        description:
          "Serve this node's About payload (host identity and installed-harness enumeration) to a peer for a remote About view.",
        whenToUse: "When a peer renders this node's About page over the mesh.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/about",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      if (!deps.federationConfig) {
        return c.json({ error: "Federation not enabled" }, 503);
      }
      return c.json({ type: "success", about: await gatherAboutInfo() });
    }
  );

  // ─── Node-to-node endpoint: POST /federation/list-directory ─────
  // Direct filesystem access — does NOT require an online machine (issue #906).
  // Previously routed through machine RPC, which failed with 503 when no machines
  // were connected. The server process runs on the same filesystem, so it can
  // readdir() directly. Follows the same pattern as /federation/repo-identity.
  app.post(
    "/federation/list-directory",
    cataloged(
      defineCapability({
        id: "federation.list-directory",
        domain: "federation",
        surface: "rest",
        description:
          "List a directory on this node's filesystem directly for a peer, without needing an online machine connection.",
        whenToUse:
          "When a peer browses this node's files to pick a spawn directory.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/list-directory",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const body = await c.req.json().catch(() => null);
      if (!body?.path || typeof body.path !== "string") {
        return c.json({ type: "error", message: "Invalid body" }, 400);
      }

      const { readdir, stat } = await import("node:fs/promises");
      const { join } = await import("node:path");

      // Expand tilde to this node's home (shared helper, #3558 — same semantics
      // as cli/src/api/apiMachine.ts)
      const expandedPath = expandTilde(body.path.trim());

      if (!isSafeMachinePath(expandedPath)) {
        return c.json({ type: "error", message: "Access denied" }, 403);
      }

      try {
        const rawEntries = await readdir(expandedPath, { withFileTypes: true });
        const entries = await Promise.all(
          rawEntries.map(async entry => {
            const fullPath = join(expandedPath, entry.name);
            let type: "file" | "directory" | "other" = "other";
            let size: number | undefined;
            let modified: number | undefined;

            if (entry.isDirectory()) {
              type = "directory";
            } else if (entry.isFile()) {
              type = "file";
            }

            try {
              const s = await stat(fullPath);
              size = s.size;
              modified = s.mtime.getTime();
            } catch {
              // Ignore stat errors (permission denied, etc.)
            }

            return { name: entry.name, type, size, modified };
          })
        );

        entries.sort((a, b) => {
          if (a.type === "directory" && b.type !== "directory") return -1;
          if (a.type !== "directory" && b.type === "directory") return 1;
          return a.name.localeCompare(b.name);
        });

        return c.json({ type: "success", entries });
      } catch (error) {
        deps.errorLogger?.warn("[Federation] list-directory failed", {
          category: "federation-list-directory",
          stack: error instanceof Error ? error.stack : null,
          context: { path: expandedPath },
        });
        return c.json(
          {
            type: "error",
            message:
              error instanceof Error
                ? error.message
                : "Failed to list directory",
          },
          500
        );
      }
    }
  );

  // ─── Node-to-node endpoint: POST /federation/create-directory ─────
  // Direct filesystem access — does NOT require an online machine (issue #3498,
  // mirrors /federation/list-directory #906). Applies the create-target UNION
  // guard (NUL-reject → realpath the deepest existing ancestor → union deny-list
  // on the REAL path → tail validation) then mkdir as THIS node's server uid.
  app.post(
    "/federation/create-directory",
    cataloged(
      defineCapability({
        id: "federation.create-directory",
        domain: "federation",
        surface: "rest",
        description:
          "Create a directory on this node's filesystem directly for a peer, without needing an online machine connection.",
        whenToUse:
          "When a peer creates a new folder on this node from the New Session directory browser.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/create-directory",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const body = await c.req.json().catch(() => null);
      if (
        !body?.path ||
        typeof body.path !== "string" ||
        typeof body.recursive !== "boolean"
      ) {
        return c.json({ type: "error", message: "Invalid body" }, 400);
      }

      const validation = validateCreateDirectoryTarget(body.path);
      if (!validation.ok || !validation.target) {
        return c.json(
          {
            type: "error",
            message: validation.error ?? "Access denied to this path",
          },
          403
        );
      }
      const target = validation.target;

      const { mkdir, stat } = await import("node:fs/promises");
      const { basename } = await import("node:path");

      try {
        await mkdir(target, { recursive: body.recursive });
        let size: number | undefined;
        let modified: number | undefined;
        try {
          const s = await stat(target);
          size = s.size;
          modified = s.mtime.getTime();
        } catch {
          // Ignore stat errors — mkdir succeeded.
        }
        return c.json({
          type: "success",
          entry: { name: basename(target), type: "directory", size, modified },
        });
      } catch (error) {
        deps.errorLogger?.warn("[Federation] create-directory failed", {
          category: "federation-create-directory",
          stack: error instanceof Error ? error.stack : null,
          context: { path: body.path, recursive: body.recursive },
        });
        const message =
          error instanceof Error ? error.message : "Failed to create directory";
        // EEXIST (recursive:false on an existing dir) → 409; else 500. The
        // web-client route flattens both to 502 and humanizeFsError branches on
        // the double-encoded body.
        const status = message.includes("EEXIST") ? 409 : 500;
        return c.json({ type: "error", message }, status);
      }
    }
  );

  // ─── Node-to-node endpoint: POST /federation/paths/exists ──────
  // Direct filesystem access — does NOT require an online machine (issue #906).
  // Previously routed through machine RPC, same fix as /federation/list-directory.
  app.post(
    "/federation/paths/exists",
    cataloged(
      defineCapability({
        id: "federation.paths-exists",
        domain: "federation",
        surface: "rest",
        description:
          "Check which of a set of candidate directory paths exist directly on this node for a peer.",
        whenToUse: "When a peer validates project paths on this node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/paths/exists",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const body = await c.req.json().catch(() => null);
      if (!body?.paths || !Array.isArray(body.paths)) {
        return c.json({ type: "error", message: "Invalid body" }, 400);
      }

      const { stat } = await import("node:fs/promises");

      try {
        const exists: Record<string, boolean> = {};
        await Promise.all(
          (body.paths as string[]).map(async (p: string) => {
            const trimmed = typeof p === "string" ? p.trim() : "";
            if (!trimmed) {
              exists[p] = false;
              return;
            }

            const expanded = expandTilde(trimmed);

            if (!isSafeMachinePath(expanded)) {
              exists[p] = false;
              return;
            }

            try {
              const s = await stat(expanded);
              exists[p] = s.isDirectory();
            } catch {
              exists[p] = false;
            }
          })
        );
        return c.json({ type: "success", exists });
      } catch (error) {
        deps.errorLogger?.warn("[Federation] check-paths failed", {
          category: "federation-check-paths",
          stack: error instanceof Error ? error.stack : null,
        });
        return c.json(
          {
            type: "error",
            message:
              error instanceof Error ? error.message : "Failed to check paths",
          },
          500
        );
      }
    }
  );

  // ─── Node-to-node endpoint: POST /federation/repo-identity ──────
  app.post(
    "/federation/repo-identity",
    cataloged(
      defineCapability({
        id: "federation.repo-identity",
        domain: "federation",
        surface: "rest",
        description:
          "Resolve the git repository name and URL for a directory on this node for a peer.",
        whenToUse:
          "When a peer needs the repo identity of a directory on this node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/repo-identity",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const body = await c.req.json().catch(() => null);
      if (!body?.directory || typeof body.directory !== "string") {
        return c.json({ type: "error", message: "Invalid body" }, 400);
      }

      // #3558: this node is the authority on its own home dir, so it expands a
      // tilde itself (the hub's pre-expansion is best-effort), guards the path
      // like the sibling receivers, and reports TRUE git-ness (rev-parse) so the
      // hub's F25 tri-state matches this node's local UI.
      const directory = expandTilde(body.directory.trim());
      if (!directory) {
        return c.json({ type: "error", message: "Invalid body" }, 400);
      }
      if (!isSafeMachinePath(directory)) {
        return c.json({ type: "error", message: "Access denied" }, 403);
      }

      const identity = resolveRepoIdentity(directory);
      return c.json({
        type: "success",
        repo: identity ? { name: identity.name, url: identity.url } : null,
        directoryIsGitRepo: isGitRepo(directory),
      });
    }
  );

  // ─── Node-to-node endpoint: POST /federation/git-branches ──────
  // hapimatic-private#4481: list a directory's git branches on THIS node for a
  // peer's Create-page Branch control. Server-side like /federation/repo-identity
  // and /federation/list-directory (#906 — no dependency on an online machine).
  // This node is the home-dir authority, so it expands a tilde itself. A peer
  // that answers this endpoint also accepts `existingBranch` on spawn (same
  // release) — the web only offers existing branches from a successful listing.
  app.post(
    "/federation/git-branches",
    cataloged(
      defineCapability({
        id: "federation.git-branches",
        domain: "federation",
        surface: "rest",
        description:
          "List the git branches (current, local, remote-only, held by other worktrees) of a directory on this node for a peer.",
        whenToUse:
          "When a peer's Create-page Branch control needs this node's branches for a directory.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/git-branches",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const body = await c.req.json().catch(() => null);
      if (!body?.directory || typeof body.directory !== "string") {
        return c.json({ type: "error", message: "Invalid body" }, 400);
      }
      const directory = expandTilde(body.directory.trim());
      if (!directory) {
        return c.json({ type: "error", message: "Invalid body" }, 400);
      }
      if (!isSafeMachinePath(directory)) {
        return c.json({ type: "error", message: "Access denied" }, 403);
      }
      try {
        const listing = await listGitBranches(directory);
        return c.json({ type: "success", listing });
      } catch (error) {
        deps.errorLogger?.warn("[Federation] git-branches failed", {
          category: "federation-git-branches",
          stack: error instanceof Error ? error.stack : null,
          context: { directory },
        });
        return c.json(
          {
            type: "error",
            message:
              error instanceof Error
                ? error.message
                : "Failed to list branches",
          },
          500
        );
      }
    }
  );

  // ─── Node-to-node endpoint: POST /federation/github-accounts ──────
  // Issue #1953 (A6): resolve THIS node's host GitHub identity(ies) so a remote
  // spawn target's GitHub-account selector shows the correct account. NEVER
  // returns a token (R11) — only the reason enum crosses the boundary.
  //
  // #2327: previously returned an unconditional `{ type: "success", accounts }`,
  // so a peer whose resolution was broken reported success-with-empty exactly
  // like the local path did. A failure now maps onto the existing `error` arm of
  // the discriminated envelope, carrying the reason enum as `message`.
  app.post(
    "/federation/github-accounts",
    cataloged(
      defineCapability({
        id: "federation.github-accounts",
        domain: "federation",
        surface: "rest",
        description:
          "Resolve this node's host GitHub account identities for a peer; never returns any token.",
        whenToUse:
          "When a peer's GitHub-account selector needs this node's host accounts.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/github-accounts",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const result = await fetchGitHubAccounts(deps.errorLogger);
      if (!result.ok) {
        return c.json({ type: "error", message: result.reason });
      }
      return c.json({ type: "success", accounts: result.data });
    }
  );

  // ─── Node-to-node endpoint: POST /federation/github-repos ──────
  // Issue #1953 (A6): list the repos accessible to a host GitHub account on THIS
  // node. NEVER returns a token (R11) — only the reason enum crosses the
  // boundary. #2327: failure maps onto the `error` arm (see accounts above).
  app.post(
    "/federation/github-repos",
    cataloged(
      defineCapability({
        id: "federation.github-repos",
        domain: "federation",
        surface: "rest",
        description:
          "List the GitHub repositories a host account can access on this node for a peer; never returns any token.",
        whenToUse:
          "When a peer lists this node's accessible repos for an account.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/github-repos",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const body = await c.req.json().catch(() => null);
      const account = body?.account;
      if (typeof account !== "string" || !/^[a-zA-Z0-9._-]+$/.test(account)) {
        return c.json({ type: "error", message: "Invalid account" }, 400);
      }

      const result = await fetchGitHubRepos(account, deps.errorLogger);
      if (!result.ok) {
        return c.json({ type: "error", message: result.reason });
      }
      return c.json({ type: "success", repos: result.data });
    }
  );

  // ─── Node-to-node endpoint: POST /federation/recent-paths ──────
  app.post(
    "/federation/recent-paths",
    cataloged(
      defineCapability({
        id: "federation.recent-paths",
        domain: "federation",
        surface: "rest",
        description:
          "List the recently used project directories cached on this node for a peer, in a chosen namespace.",
        whenToUse: "When a peer offers recent directories from this node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/recent-paths",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ type: "error", message: "Not connected" }, 503);
      }

      const body = await c.req.json().catch(() => null);
      const namespace =
        typeof body?.namespace === "string" ? body.namespace : "default";

      const machines = engine.getOnlineMachines();
      if (machines.length === 0) {
        return c.json({ type: "error", message: "No machines available" }, 503);
      }

      const paths = engine.getRecentPaths(machines[0].id, namespace);
      return c.json({ type: "success", paths });
    }
  );

  // ─── Node-to-node endpoint: POST /federation/recent-paths/add ──
  app.post(
    "/federation/recent-paths/add",
    cataloged(
      defineCapability({
        id: "federation.recent-paths-add",
        domain: "federation",
        surface: "rest",
        description:
          "Record a project directory as recently used on this node for a peer, in a chosen namespace.",
        whenToUse: "When a peer remembers a directory opened on this node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/recent-paths/add",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ type: "error", message: "Not connected" }, 503);
      }

      const body = await c.req.json().catch(() => null);
      if (!body?.path || typeof body.path !== "string") {
        return c.json({ type: "error", message: "Invalid body" }, 400);
      }

      const namespace =
        typeof body.namespace === "string" ? body.namespace : "default";

      const machines = engine.getOnlineMachines();
      if (machines.length === 0) {
        return c.json({ type: "error", message: "No machines available" }, 503);
      }

      engine.addRecentPath(machines[0].id, namespace, body.path.trim());
      return c.json({ type: "success" });
    }
  );

  // ─── Node-to-node endpoint: POST /federation/recent-paths/remove ──
  app.post(
    "/federation/recent-paths/remove",
    cataloged(
      defineCapability({
        id: "federation.recent-paths-remove",
        domain: "federation",
        surface: "rest",
        description:
          "Forget a recently used project directory on this node for a peer, in a chosen namespace.",
        whenToUse:
          "When a peer removes a directory from this node's recent list.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/recent-paths/remove",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ type: "error", message: "Not connected" }, 503);
      }

      const body = await c.req.json().catch(() => null);
      if (!body?.path || typeof body.path !== "string") {
        return c.json({ type: "error", message: "Invalid body" }, 400);
      }

      const namespace =
        typeof body.namespace === "string" ? body.namespace : "default";

      const machines = engine.getOnlineMachines();
      if (machines.length === 0) {
        return c.json({ type: "error", message: "No machines available" }, 503);
      }

      const removed = engine.removeRecentPath(
        machines[0].id,
        namespace,
        body.path.trim()
      );
      return c.json({ type: "success", removed });
    }
  );

  return app;
}
