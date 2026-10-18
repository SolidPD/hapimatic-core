// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Approval-state read surface (issue #3331, epic #3329 Sub-Issue B — R10 / epic
 * GAP-1). Exposes the current state of an issue's approval gate to the client;
 * #3333's approval-card state indicator consumes it.
 *
 *   GET /api/sessions/:id/approval-state/:challengeId
 *
 * `:challengeId` is the ISSUE NUMBER (issue-scoped gates are keyed by issue).
 * The response is `{ state, nonce?, action?, scope?, approved_by?, origin?,
 * reason? }` where `state ∈ pending | consumed | invalidated |
 * awaiting-overlap-decision | none` (registry vocabulary + a `none` "no gate"
 * signal). The state is RE-COMPUTED at read time against #3332's state-binding,
 * so a challenge whose approved tree has since drifted reads `invalidated`.
 *
 * Federation-aware (R8): the grant/challenge files live on the OWNING node's
 * host, so a hub-local read of a remote session would report "none" for every
 * federated gate. The federation fallback mirrors the GET-messages pattern
 * (`messages.ts`) — `findNodeForSession` → forward with the federation bearer →
 * return the remote body.
 */
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { SyncEngine } from "../../sync/syncEngine";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import {
  federationReadSignal,
  readProxyJson,
} from "../../federation/proxyFetchSignal";
import type { WebAppEnv } from "../middleware/auth";
import { requireSessionFromParam, requireSyncEngine } from "./guards";
import { computeApprovalState } from "../../services/approvalTokens";
import { loadApprovalHygieneConfig } from "../../config/approvalHygieneConfig";
import { loadApprovalTokensConfig } from "../../config/approvalTokensConfig";

export function createApprovalsRoutes(
  getSyncEngine: () => SyncEngine | null,
  options?: {
    getNodeRegistry?: () => NodeRegistry | null;
    federationApiToken?: string | null;
  }
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.get(
    "/sessions/:id/approval-state/:challengeId",
    cataloged(
      defineCapability({
        id: "session-lifecycle.approval-state",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Return the approval state for a session's pending challenge by id.",
        whenToUse:
          "When the UI polls whether an approval challenge was answered.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/approval-state/:challengeId",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine);
      if (!(sessionResult instanceof Response)) {
        // Local session — read the grant/challenge from its working dir.
        const repoPath = sessionResult.session.metadata?.path;
        if (!repoPath) {
          return c.json({ error: "Session has no working path" }, 409);
        }
        const issueNumber = Number(c.req.param("challengeId"));
        if (!Number.isInteger(issueNumber)) {
          return c.json({ error: "Invalid challengeId" }, 400);
        }
        // #3559 R6: the card sends `?nonce=<spec.token>` so a completed gate reads
        // `used` from the acceptance ledger. The nonce is an intent carrier, not a
        // credential (registry §5), and the route is authenticated. `globalStateDir`
        // is the SAME injected `~/.claude/state` base #3538 resolves.
        const nonce = c.req.query("nonce") || undefined;
        const result = await computeApprovalState(repoPath, issueNumber, {
          hygieneTtlDays: loadApprovalHygieneConfig().hygieneTtlDays,
          globalStateDir: loadApprovalTokensConfig().globalStateDir,
          nonce,
        });
        return c.json(result);
      }

      // Federation fallback: the grant files live on the owning node.
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          const challengeId = c.req.param("challengeId");
          const nonce = c.req.query("nonce");
          const headers: Record<string, string> = {};
          if (options?.federationApiToken) {
            headers["Authorization"] = `Bearer ${options.federationApiToken}`;
          }
          // #3559 R6: forward `?nonce=` to the owning node so its per-node ledger
          // read can report `used` for this hub-proxied remote session.
          const url = `${node.url}/api/federation/sessions/${encodeURIComponent(
            sessionId
          )}/approval-state/${encodeURIComponent(challengeId)}${
            nonce ? `?nonce=${encodeURIComponent(nonce)}` : ""
          }`;
          try {
            // #5375: bounded read-only proxy fetch.
            const resp = await fetch(url, {
              headers,
              signal: federationReadSignal(c.req.raw.signal),
            });
            if (resp.ok) {
              const body = await resp.json();
              return c.json(body as Record<string, unknown>);
            }
            const body = (await readProxyJson(resp)) ?? {};
            return c.json(
              body as Record<string, unknown>,
              resp.status as 400 | 404 | 409 | 500 | 503
            );
          } catch {
            return c.json({ error: "Remote node unreachable" }, 502);
          }
        }
      }

      return sessionResult;
    }
  );

  return app;
}
