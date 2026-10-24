// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { createAuthMiddleware, type WebAppEnv } from "../../middleware/auth";
import { resolveLocalNodeIdentity } from "../../../config/nodeLabel";
import type { FederationDeps } from "./shared";
import {
  FederationSpawnBodySchema,
  LOCAL_NODE_ID,
  defineCapability,
} from "@hapi/protocol";
import { cataloged } from "../../../capabilities/cataloged";
import { createRateLimiter } from "../../middleware/rateLimit";
import {
  addFederationPendingSpawn,
  dismissPendingSpawn,
  listFederationForNamespace,
} from "../../../sync/pendingSpawns";

export function createWebClientRoutes(deps: FederationDeps): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // ─── Web client endpoint: GET /federation/nodes (JWT auth) ─────
  const jwtAuth = createAuthMiddleware(deps.jwtSecret);

  // issue #3498 (#1099 convention): the JWT-facing mutating node-create-directory
  // route is rate-limited. Instantiated once per mount (fresh bucket map).
  const createNodeDirLimiter = createRateLimiter({
    name: "federation-create-directory",
  });

  // ─── Web client endpoint: GET /federation/active-accounts (JWT, HUB aggregation) ─
  // Issue #1452 (Sub-Issue F): per-node active-account summary across the local
  // node + all remote nodes. Partial-success (R6): an unreachable/erroring node
  // yields status:"error" rather than failing the whole aggregate.
  app.get(
    "/federation/active-accounts",
    cataloged(
      defineCapability({
        id: "federation.active-accounts",
        domain: "federation",
        surface: "rest",
        description:
          "Summarize the active Anthropic account (email, org, uuid) on the local node and every reachable peer, marking unreachable nodes with an error status.",
        whenToUse:
          "When the user asks which account each federation node is currently running under.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/active-accounts",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    jwtAuth,
    async c => {
      const registry = deps.getNodeRegistry();
      const accountService = deps.getAccountService();
      const localNodeId = deps.federationConfig?.nodeId ?? null;

      type NodeActiveAccount = {
        nodeId: string;
        accountUuid: string | null;
        emailAddress: string | null;
        organizationName: string | null;
        status: string;
      };
      const nodes: NodeActiveAccount[] = [];

      // Local node (the hub is itself a node; not present in getNodeSummaries()).
      if (accountService) {
        const local = accountService.getActiveAccount();
        nodes.push({
          nodeId: localNodeId ?? LOCAL_NODE_ID,
          accountUuid: local?.accountUuid ?? null,
          emailAddress: local?.emailAddress ?? null,
          organizationName: local?.organizationName ?? null,
          status: "ok",
        });
      }

      // Remote nodes — concurrent, partial-success (R6).
      if (registry) {
        const summaries = registry.getNodeSummaries();
        const results = await Promise.allSettled(
          summaries.map(s => registry.getActiveAccountOnNode(s.nodeId))
        );
        summaries.forEach((s, i) => {
          const r = results[i];
          if (r.status === "fulfilled" && r.value.type === "success") {
            const acct = r.value.account;
            nodes.push({
              nodeId: s.nodeId,
              accountUuid: acct?.accountUuid ?? null,
              emailAddress: acct?.emailAddress ?? null,
              organizationName: acct?.organizationName ?? null,
              status: "ok",
            });
          } else {
            nodes.push({
              nodeId: s.nodeId,
              accountUuid: null,
              emailAddress: null,
              organizationName: null,
              status: "error",
            });
          }
        });
      }

      return c.json({ nodes });
    }
  );

  app.get(
    "/federation/nodes",
    cataloged(
      defineCapability({
        id: "federation.nodes",
        domain: "federation",
        surface: "rest",
        description:
          "Report federation enablement, this node's own identity and role, and the live state of every known peer node in the mesh.",
        whenToUse:
          "When the user wants the federation node list or this node's identity.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/nodes",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    jwtAuth,
    c => {
      const config = deps.federationConfig;
      const registry = deps.getNodeRegistry();

      c.header(
        "X-Deprecated",
        "Migration planned to /api/sessions/* - see issue #978"
      );
      return c.json({
        enabled: Boolean(config),
        role: config?.role ?? "node",
        // #2332: a node must at minimum be able to name ITSELF. Federation-disabled
        // deployments (every freshly-provisioned cloud VM) previously got
        // `localNode: null` here — an HTTP 200 that withholds the node's identity —
        // which starved /admin/federation's identity-only fallback and rendered a
        // zero-node page. `enabled`/`role` still report federation state, so callers
        // that need to distinguish standalone from federated are unaffected.
        // Matches the sibling synthesis at :35 (/federation/active-accounts) and the
        // client-side fallback at web/src/routes/admin/account-usage.tsx:155.
        // #4461: one copy of the identity rule (`||` hostname fallback, casing)
        // shared with the account-health read and the 409 / SSE stamps.
        localNode: resolveLocalNodeIdentity(config),
        nodes: registry ? registry.getNodeStates() : [],
      });
    }
  );

  // ─── Web client endpoint: GET /federation/all-sessions (JWT) ───
  app.get(
    "/federation/all-sessions",
    cataloged(
      defineCapability({
        id: "federation.all-sessions",
        domain: "federation",
        surface: "rest",
        description:
          "List the sessions running across every remote federation node, with a summary of each node.",
        whenToUse:
          "When the user wants to see sessions on other machines in the mesh.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/all-sessions",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    jwtAuth,
    c => {
      const registry = deps.getNodeRegistry();
      c.header(
        "X-Deprecated",
        "Migration planned to /api/sessions/* - see issue #978"
      );
      if (!registry) {
        return c.json({ sessions: [], nodes: [] });
      }

      // Issue #2150 (R1/R4): append this caller's hub-side federation spawn
      // placeholders — a `spawning` row while the peer works, a `failed` row
      // carrying the peer's error — as ADDITIVE members of `sessions`. A request
      // with no pending federation spawn returns exactly the pre-#2150 payload.
      const placeholders = listFederationForNamespace(
        c.get("namespace") ?? "default"
      );
      const remote = registry.getAllRemoteSessions();
      return c.json({
        sessions:
          placeholders.length > 0 ? [...remote, ...placeholders] : remote,
        nodes: registry.getNodeSummaries(),
      });
    }
  );

  // ─── Web client endpoint: POST /federation/nodes/:nodeId/spawn (JWT) ─
  app.post(
    "/federation/nodes/:nodeId/spawn",
    cataloged(
      defineCapability({
        id: "federation.spawn-on-node",
        domain: "federation",
        surface: "rest",
        description:
          "Start a new Claude session on a named remote federation node, tagged with this node's origin id.",
        whenToUse:
          "When the user wants to launch a session on a specific other machine.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/nodes/:nodeId/spawn",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    jwtAuth,
    async c => {
      c.header(
        "X-Deprecated",
        "Migration planned to /api/sessions/* - see issue #978"
      );
      const registry = deps.getNodeRegistry();
      if (!registry) {
        return c.json(
          { type: "error", message: "Federation not enabled" },
          503
        );
      }

      const body = await c.req.json().catch(() => null);
      // Issue #4568 (R8): an API-key binding names a key in THIS node's vault, so
      // it cannot bind a session on another node (vault keys never cross the
      // federation, #1996). Refused loudly here — before the peer schema below
      // silently strips the field and the remote session bills its own default.
      if (
        body &&
        typeof body === "object" &&
        (body as { apiKeyId?: unknown }).apiKeyId !== undefined
      ) {
        return c.json(
          {
            type: "error",
            message:
              "API-key sessions are available on this node only — a remote node cannot use this node's API keys",
            code: "api_key_remote_unsupported",
          },
          400
        );
      }
      const parsed = FederationSpawnBodySchema.safeParse(body);
      if (!parsed.success) {
        const message = parsed.error.issues[0]?.message ?? "Invalid body";
        return c.json({ type: "error", message }, 400);
      }

      // Issue #2822 (epic #2478 D2a): resolve the managed-peer parent HERE, on
      // the sending node. The parent (the spawning PM) is local to this hub, NOT
      // to the receiving node — and the producer (`hapi-spawn.sh
      // --federation-node`, rp1-home#1130/#1540) sends HAPI_SESSION_ID, a session
      // TAG, while grouping matches parentSessionId against the parent's store
      // uuid (grouping.ts). Resolve uuid-then-tag in the caller's namespace
      // (mirrors routes/machines.ts); the receiver stores the result raw. The raw
      // fields are pulled out of the spread so an unresolved TAG never reaches the
      // wire. Fail-OPEN: an unresolved parent forwards NEITHER field and never
      // fails the spawn. (Deliberately stricter than the retroactive
      // `PUT /sessions/:id/parent` route, which forwards an unresolved value
      // unchanged — PM ruling D-2822-1: the spawn producer posts to the PM's OWN
      // node, where its parent always resolves; anything this hub cannot resolve,
      // including an explicit remote-node uuid, is forwarded with no link, and a
      // raw tag stored on the receiving node could never match a uuid.)
      const {
        parentSessionId: requestedParentId,
        parentRelationship: requestedRelationship,
        ...forwardable
      } = parsed.data;
      let parentAttribution:
        | { parentSessionId: string; parentRelationship: "branch" | "spawn" }
        | undefined;
      if (requestedParentId) {
        const engine = deps.getSyncEngine();
        const namespace = c.get("namespace");
        const parent =
          engine?.getSessionByNamespace(requestedParentId, namespace) ??
          engine?.getSessionByTagAndNamespace(requestedParentId, namespace);
        if (parent) {
          parentAttribution = {
            parentSessionId: parent.id,
            parentRelationship: requestedRelationship ?? "spawn",
          };
        } else {
          deps.errorLogger?.warn(
            engine
              ? `Federation spawn: parentSessionId "${requestedParentId}" did not resolve to a session in namespace "${namespace}" — forwarding with no parent link`
              : `Federation spawn: sync engine unavailable, cannot resolve parentSessionId "${requestedParentId}" — forwarding with no parent link`,
            { category: "federation" }
          );
        }
      }

      // Inject this peer's nodeId so the remote node can tag the session's origin
      const fedConfig = deps.federationConfig;
      const spawnBody = {
        ...forwardable,
        ...parentAttribution,
        originatingNodeId: fedConfig?.nodeId,
      };

      const nodeId = c.req.param("nodeId");

      // Issue #2150 (R1, ruling D2-A): register the hub-side placeholder BEFORE
      // forwarding — a fast peer refusal callback can race the accept response —
      // keyed by the caller's spawnCorrelationId (the only id it holds). The
      // spawn-status handler marks THIS entry failed or settles it, and reads the
      // caller's namespace from it for the outcome events (K-4497-1). A body
      // without a correlation id registers nothing (the field is optional).
      const spawnCorrelationId = forwardable.spawnCorrelationId;
      if (spawnCorrelationId) {
        addFederationPendingSpawn({
          spawnCorrelationId,
          namespace: c.get("namespace") ?? "default",
          directory: forwardable.directory,
          nodeId,
          nodeLabel: registry.getNodeIdentity(nodeId)?.nodeLabel,
        });
      }

      const result = await registry.spawnOnNode(nodeId, spawnBody);

      if (result.type === "error") {
        // The peer never accepted it — the 502 IS the caller's error, so no
        // placeholder may linger as a second, stale signal.
        if (spawnCorrelationId) dismissPendingSpawn(spawnCorrelationId);
        return c.json(result, 502);
      }
      return c.json(result);
    }
  );

  // ─── Web client endpoint: POST /federation/nodes/:nodeId/list-directory (JWT) ─
  app.post(
    "/federation/nodes/:nodeId/list-directory",
    cataloged(
      defineCapability({
        id: "federation.node-list-directory",
        domain: "federation",
        surface: "rest",
        description:
          "List the contents of a directory on a named remote federation node's filesystem.",
        whenToUse:
          "When the user browses files on another machine to pick a project directory.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/nodes/:nodeId/list-directory",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    jwtAuth,
    async c => {
      c.header(
        "X-Deprecated",
        "Migration planned to /api/sessions/* - see issue #978"
      );
      const registry = deps.getNodeRegistry();
      if (!registry) {
        return c.json(
          { type: "error", message: "Federation not enabled" },
          503
        );
      }

      const body = await c.req.json().catch(() => null);
      if (!body?.path || typeof body.path !== "string") {
        return c.json({ type: "error", message: "Invalid body" }, 400);
      }

      const nodeId = c.req.param("nodeId");
      const result = await registry.listDirectoryOnNode(nodeId, body.path);

      if ("type" in result && result.type === "error") {
        return c.json(result, 502);
      }
      return c.json(result);
    }
  );

  // ─── Web client endpoint: POST /federation/nodes/:nodeId/create-directory (JWT) ─
  // issue #3498: create a folder on a remote node (New Session form). Mirrors the
  // node list-directory route above; the peer receiver runs the authoritative
  // create-target UNION guard. Rate-limited (#1099). Peer {type:"error"} bodies
  // are flattened to 502 (the double-encoded shape humanizeFsError handles).
  app.post(
    "/federation/nodes/:nodeId/create-directory",
    cataloged(
      defineCapability({
        id: "federation.node-create-directory",
        domain: "federation",
        surface: "rest",
        description:
          "Create a directory on a named remote federation node's filesystem.",
        whenToUse:
          "When the user creates a new folder on another machine from the New Session directory browser.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/nodes/:nodeId/create-directory",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    jwtAuth,
    createNodeDirLimiter,
    async c => {
      c.header(
        "X-Deprecated",
        "Migration planned to /api/sessions/* - see issue #978"
      );
      const registry = deps.getNodeRegistry();
      if (!registry) {
        return c.json(
          { type: "error", message: "Federation not enabled" },
          503
        );
      }

      const body = await c.req.json().catch(() => null);
      if (
        !body?.path ||
        typeof body.path !== "string" ||
        typeof body.recursive !== "boolean"
      ) {
        return c.json({ type: "error", message: "Invalid body" }, 400);
      }
      if (body.path.includes("\0")) {
        return c.json({ type: "error", message: "Invalid path" }, 400);
      }

      const nodeId = c.req.param("nodeId");
      const result = await registry.createDirectoryOnNode(
        nodeId,
        body.path,
        body.recursive
      );

      if ("type" in result && result.type === "error") {
        return c.json(result, 502);
      }
      return c.json(result);
    }
  );

  // ─── Web client endpoint: POST /federation/nodes/:nodeId/paths/exists (JWT) ─
  app.post(
    "/federation/nodes/:nodeId/paths/exists",
    cataloged(
      defineCapability({
        id: "federation.node-paths-exists",
        domain: "federation",
        surface: "rest",
        description:
          "Check, on a named remote node, which of a set of candidate directory paths exist.",
        whenToUse:
          "When validating that project paths are present on a remote machine.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/nodes/:nodeId/paths/exists",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    jwtAuth,
    async c => {
      c.header(
        "X-Deprecated",
        "Migration planned to /api/sessions/* - see issue #978"
      );
      const registry = deps.getNodeRegistry();
      if (!registry) {
        return c.json(
          { type: "error", message: "Federation not enabled" },
          503
        );
      }

      const body = await c.req.json().catch(() => null);
      if (!body?.paths || !Array.isArray(body.paths)) {
        return c.json({ type: "error", message: "Invalid body" }, 400);
      }

      const nodeId = c.req.param("nodeId");
      const result = await registry.checkPathsExistOnNode(nodeId, body.paths);

      if ("type" in result && result.type === "error") {
        return c.json(result, 502);
      }
      return c.json(result);
    }
  );

  // ─── Web client endpoint: POST /federation/nodes/:nodeId/recent-paths (JWT) ─
  app.post(
    "/federation/nodes/:nodeId/recent-paths",
    cataloged(
      defineCapability({
        id: "federation.node-recent-paths",
        domain: "federation",
        surface: "rest",
        description:
          "List the recently used project directories cached for a named remote node in the caller's namespace.",
        whenToUse:
          "When offering recent directories for a remote spawn target.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/nodes/:nodeId/recent-paths",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    jwtAuth,
    async c => {
      c.header(
        "X-Deprecated",
        "Migration planned to /api/sessions/* - see issue #978"
      );
      const registry = deps.getNodeRegistry();
      if (!registry) {
        return c.json(
          { type: "error", message: "Federation not enabled" },
          503
        );
      }

      const nodeId = c.req.param("nodeId");
      const namespace = c.get("namespace") ?? "default";

      const result = await registry.getRecentPathsOnNode(nodeId, namespace);

      if ("type" in result && result.type === "error") {
        return c.json(result, 502);
      }
      return c.json(result);
    }
  );

  // ─── Web client endpoint: POST /federation/nodes/:nodeId/recent-paths/add (JWT) ─
  app.post(
    "/federation/nodes/:nodeId/recent-paths/add",
    cataloged(
      defineCapability({
        id: "federation.node-recent-paths-add",
        domain: "federation",
        surface: "rest",
        description:
          "Record a project directory as recently used for a named remote node in the caller's namespace.",
        whenToUse:
          "When a directory opened on a remote machine should be remembered.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/nodes/:nodeId/recent-paths/add",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    jwtAuth,
    async c => {
      c.header(
        "X-Deprecated",
        "Migration planned to /api/sessions/* - see issue #978"
      );
      const registry = deps.getNodeRegistry();
      if (!registry) {
        return c.json(
          { type: "error", message: "Federation not enabled" },
          503
        );
      }

      const body = await c.req.json().catch(() => null);
      if (!body?.path || typeof body.path !== "string") {
        return c.json({ type: "error", message: "Invalid body" }, 400);
      }

      const nodeId = c.req.param("nodeId");
      const namespace = c.get("namespace") ?? "default";

      const result = await registry.addRecentPathOnNode(
        nodeId,
        namespace,
        body.path.trim()
      );

      if ("type" in result && result.type === "error") {
        return c.json(result, 502);
      }
      return c.json(result);
    }
  );

  // ─── Web client endpoint: POST /federation/nodes/:nodeId/recent-paths/remove (JWT) ─
  app.post(
    "/federation/nodes/:nodeId/recent-paths/remove",
    cataloged(
      defineCapability({
        id: "federation.node-recent-paths-remove",
        domain: "federation",
        surface: "rest",
        description:
          "Forget a recently used project directory for a named remote node in the caller's namespace.",
        whenToUse:
          "When the user removes a directory from the remote recent list.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/nodes/:nodeId/recent-paths/remove",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    jwtAuth,
    async c => {
      c.header(
        "X-Deprecated",
        "Migration planned to /api/sessions/* - see issue #978"
      );
      const registry = deps.getNodeRegistry();
      if (!registry) {
        return c.json(
          { type: "error", message: "Federation not enabled" },
          503
        );
      }

      const body = await c.req.json().catch(() => null);
      if (!body?.path || typeof body.path !== "string") {
        return c.json({ type: "error", message: "Invalid body" }, 400);
      }

      const nodeId = c.req.param("nodeId");
      const namespace = c.get("namespace") ?? "default";

      const result = await registry.removeRecentPathOnNode(
        nodeId,
        namespace,
        body.path.trim()
      );

      if ("type" in result && result.type === "error") {
        return c.json(result, 502);
      }
      return c.json(result);
    }
  );

  // ─── Web client endpoint: POST /federation/nodes/:nodeId/drain (JWT) ─
  app.post(
    "/federation/nodes/:nodeId/drain",
    cataloged(
      defineCapability({
        id: "federation.drain-node",
        domain: "federation",
        surface: "rest",
        description:
          "Mark a named remote node as draining so it stops accepting new session spawns while existing sessions keep running.",
        whenToUse: "When taking a machine out of rotation without evicting it.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/nodes/:nodeId/drain",
        },
        auth: "jwt",
        riskTier: "mutating",
        // #3837 R12: fleet node-lifecycle management (take a machine out of
        // rotation) — no per-user use case, no web-UI consumer, so it must never
        // be advertised to a user-VM agent (R5). [ER 2026-09-19: D17]
        availability: { scope: "operator" },
      })
    ),
    jwtAuth,
    async c => {
      const registry = deps.getNodeRegistry();
      if (!registry) {
        return c.json(
          { type: "error", message: "Federation not enabled" },
          503
        );
      }

      const nodeId = c.req.param("nodeId");
      registry.drainNode(nodeId);
      return c.json({ ok: true, nodeId, status: "draining" });
    }
  );

  // ─── Web client endpoint: DELETE /federation/nodes/:nodeId (JWT) ─
  app.delete(
    "/federation/nodes/:nodeId",
    cataloged(
      defineCapability({
        id: "federation.evict-node",
        domain: "federation",
        surface: "rest",
        description:
          "Remove a named node from the federation mesh, writing a death-certificate tombstone so gossip does not resurrect it.",
        whenToUse: "When permanently removing a machine from the mesh.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/federation/nodes/:nodeId",
        },
        auth: "jwt",
        riskTier: "destructive",
        // #3837 R12: fleet node-lifecycle management (permanently remove a
        // machine from the mesh) — no per-user use case, no web-UI consumer, so
        // it must never be advertised to a user-VM agent (R5). [ER 2026-09-19: D17]
        availability: { scope: "operator" },
      })
    ),
    jwtAuth,
    async c => {
      const registry = deps.getNodeRegistry();
      if (!registry) {
        return c.json(
          { type: "error", message: "Federation not enabled" },
          503
        );
      }

      const nodeId = c.req.param("nodeId");
      // #2531: explicit eviction. evictNode() removes the in-memory registry entry
      // AND writes a death-certificate tombstone (replacing the old store-only
      // `announcer.peerStore.remove()` cast), so a single eviction propagates
      // mesh-wide via gossip instead of being resurrected within one announce
      // cycle. The response reflects BOTH store and in-memory removal (AC).
      const result = registry.evictNode(nodeId);
      return c.json({
        ok: true,
        removed: nodeId,
        inMemoryRemoved: result.inMemoryRemoved,
        tombstoned: result.storeUpdated,
        isStatic: result.isStatic,
      });
    }
  );

  return app;
}
