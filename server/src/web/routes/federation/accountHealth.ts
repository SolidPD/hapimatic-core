// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import {
  ANTHROPIC_LOGIN_CAPABILITY,
  AccountHealthEnvelopeSchema,
  defineCapability,
  parseNodeAccountHealthPerEntry,
  type NodeAccountHealth,
} from "@hapi/protocol";
import { createAuthMiddleware, type WebAppEnv } from "../../middleware/auth";
import { cataloged } from "../../../capabilities/cataloged";
import { resolveLocalNodeIdentity } from "../../../config/nodeLabel";
import { checkFederationToken, type FederationDeps } from "./shared";

/**
 * Per-node account health (issue #4461, epic #4460 sub-issue A).
 *
 *   GET  /api/federation/account-health — JWT, the hub aggregate: this node's row
 *        first (`isLocal: true`), then one row per known peer, never omitting one.
 *   POST /api/federation/account-health — federation token, the peer receiver: this
 *        node's own row for a hub's aggregate. POST because the node-to-node
 *        convention is POST (`/federation/provider-auth-state`, `/accounts/usage`).
 *
 * Mirrors the #3806 provider-auth-state pair (`./accounts.ts`). Both ends parse
 * with the whitelist schemas — the receiver on egress, the hub again on ingress
 * (`NodeRegistry.getAccountHealthOnNode`) and once more over the whole envelope —
 * so no token, refresh token or credentials-file content can cross (R4).
 *
 * Every peer row carries the HUB's canonical `nodeId` / `nodeLabel` from its own
 * node summary, never the peer's self-report (`./accounts.ts` provider-auth-state
 * rule). A slow peer is bounded by the registry's 10 s per-peer fetch timeout and
 * then reported `unreachable` with a null `fetchedAt` (R5).
 */
export function createFederationAccountHealthRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const jwtAuth = createAuthMiddleware(deps.jwtSecret);
  const logOnce = createDegradedLog(deps);

  /**
   * This node's own row. A reader that is absent yields the `unreachable` row it
   * always has; a reader that throws, or facts that are not a row, yield `error`
   * and a logged warning (issue #5420) — never a dropped node (R1). Entries this
   * build cannot read are dropped one at a time and counted, not the whole row.
   */
  const localRow = (isLocal: boolean): NodeAccountHealth => {
    const identity = resolveLocalNodeIdentity(deps.federationConfig);
    const reader = deps.getAccountHealth;
    if (!reader) {
      return {
        ...identity,
        isLocal,
        status: "unreachable",
        fetchedAt: null,
        accounts: [],
        // #4462: this node always stores a login for itself.
        loginSupported: { anthropic: true },
      };
    }
    let failure: string;
    try {
      const facts = reader();
      const row = parseNodeAccountHealthPerEntry({
        ...identity,
        isLocal,
        status: "ok",
        fetchedAt: facts.fetchedAt,
        accounts: facts.accounts,
        // #4462: this node always stores a login for itself.
        loginSupported: { anthropic: true },
      });
      if (row) {
        // ok() clears the throttle, so call it ONLY on a clean row: clearing it
        // before a dropped-entries warning would re-log that warning every poll.
        if (!row.rejectedEntries) logOnce.ok(LOCAL_KEY);
        else {
          logOnce.warn(
            LOCAL_KEY,
            "rejected_entries",
            `[Federation] account-health: dropped ${row.rejectedEntries} local account record(s) that failed the whitelist schema`,
            { nodeId: identity.nodeId, rejectedEntries: row.rejectedEntries }
          );
        }
        return row;
      }
      failure = "the reader's facts are not an account-health row";
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    logOnce.warn(
      LOCAL_KEY,
      "local_read_failed",
      `[Federation] account-health: this node's reader failed: ${failure}`,
      { nodeId: identity.nodeId }
    );
    return {
      ...identity,
      isLocal,
      status: "error",
      fetchedAt: null,
      accounts: [],
      loginSupported: { anthropic: true },
    };
  };

  app.get(
    "/federation/account-health",
    cataloged(
      defineCapability({
        id: "accounts.federation-account-health-aggregate",
        domain: "accounts",
        surface: "rest",
        description:
          "Per-node account health across the mesh: every account record each node holds, with needsRelogin and since derived; every known peer is listed, even unreachable. Never a token.",
        whenToUse:
          "When a UI must show which node needs a re-login for an account, for example after an account_unrefreshable refusal.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/account-health",
        },
        auth: "jwt",
        // MUTATING (never readonly): it enumerates every node's account emails —
        // identity material (#3837 R12). never-readonly.test.ts pins the path.
        riskTier: "mutating",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    jwtAuth,
    async c => {
      const nodes: NodeAccountHealth[] = [localRow(true)];
      const registry = deps.getNodeRegistry();
      if (registry) {
        const summaries = registry.getNodeSummaries();
        const results = await Promise.allSettled(
          summaries.map(s => registry.getAccountHealthOnNode(s.nodeId))
        );
        results.forEach((r, i) => {
          const s = summaries[i]!;
          const identity = { nodeId: s.nodeId, nodeLabel: s.nodeLabel };
          // #4462 (R9): whether this hub can store an Anthropic login on the peer —
          // from the hub's own view of the peer's capabilities, on every row
          // (offline and unsupported too), never the peer's self-report.
          const loginSupported = {
            anthropic:
              s.capabilities?.includes(ANTHROPIC_LOGIN_CAPABILITY) ?? false,
          };
          const degraded = {
            ...identity,
            isLocal: false,
            fetchedAt: null,
            accounts: [],
            loginSupported,
          };
          if (r.status === "rejected") {
            // A rejection is a hub-side bug (the registry catches every fetch
            // failure itself), so the row carries no peer reason — only the log.
            logOnce.warn(
              s.nodeId,
              "rejected",
              `[Federation] account-health read of ${s.nodeId} threw: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
              { nodeId: s.nodeId }
            );
            nodes.push({ ...degraded, status: "unreachable" });
            return;
          }
          const outcome = r.value;
          if (outcome.kind === "ok") {
            // As for the local row: clear the throttle only on a clean row.
            if (!outcome.row.rejectedEntries) logOnce.ok(s.nodeId);
            else {
              logOnce.warn(
                s.nodeId,
                "rejected_entries",
                `[Federation] account-health: ${s.nodeId} sent ${outcome.row.rejectedEntries} account record(s) this build cannot read; they were dropped`,
                {
                  nodeId: s.nodeId,
                  rejectedEntries: outcome.row.rejectedEntries,
                }
              );
            }
            nodes.push({
              ...outcome.row,
              ...identity,
              isLocal: false,
              status: "ok",
              loginSupported,
            });
            return;
          }
          if (outcome.kind === "unreachable") {
            logOnce.warn(
              s.nodeId,
              outcome.reason,
              `[Federation] account-health read of ${s.nodeId} failed (${outcome.reason}): ${outcome.message}`,
              { nodeId: s.nodeId, reason: outcome.reason }
            );
            nodes.push({
              ...degraded,
              status: "unreachable",
              reason: outcome.reason,
            });
            return;
          }
          // `offline` / `unsupported` are expected states, not failures.
          nodes.push({ ...degraded, status: outcome.kind });
        });
      }
      return c.json(
        AccountHealthEnvelopeSchema.parse({
          localNodeId: nodes[0]!.nodeId,
          nodes,
        })
      );
    }
  );

  app.post(
    "/federation/account-health",
    cataloged(
      defineCapability({
        id: "accounts.federation-account-health-receiver",
        domain: "accounts",
        surface: "rest",
        description:
          "Return this node's account-health row (every account record it holds, derived fields only) for the hub's per-node aggregate; no token crosses the boundary.",
        whenToUse:
          "When the hub gathers a peer node's account records for the per-node account-health view.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/account-health",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        telemetry: "off",
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      if (!deps.getAccountHealth) {
        return c.json({ error: "Account health unavailable" }, 503);
      }
      const row = localRow(false);
      if (row.status !== "ok") {
        return c.json({ error: "Account health unavailable" }, 503);
      }
      return c.json(row);
    }
  );

  return app;
}

/** The throttle key for this node's own reader (peer keys are their node ids). */
const LOCAL_KEY = "\u0000local";

/** How long a repeated, unchanged failure stays quiet in the log. */
const DEGRADED_LOG_REPEAT_MS = 15 * 60_000;

/**
 * A per-node log throttle for degraded account-health reads (issue #5420). The
 * aggregate is polled every 60 s by every open tab, and a peer receiver is hit by
 * every hub, so an unthrottled warning would write one row per poll. A failure is
 * logged when it first appears, again when its reason changes, and otherwise at
 * most once per {@link DEGRADED_LOG_REPEAT_MS}; a success clears the node so its
 * next failure logs at once. The map holds one entry per node, so it is bounded by
 * the mesh size.
 */
function createDegradedLog(deps: FederationDeps) {
  const last = new Map<string, { reason: string; at: number }>();
  return {
    warn(
      key: string,
      reason: string,
      message: string,
      context: Record<string, unknown>
    ): void {
      const t = Date.now();
      const prev = last.get(key);
      if (
        prev &&
        prev.reason === reason &&
        t - prev.at < DEGRADED_LOG_REPEAT_MS
      ) {
        return;
      }
      last.set(key, { reason, at: t });
      deps.errorLogger?.warn(message, { category: "federation", context });
    },
    ok(key: string): void {
      last.delete(key);
    },
  };
}
