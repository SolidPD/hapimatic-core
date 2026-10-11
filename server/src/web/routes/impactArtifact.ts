// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import { z } from "zod";
import { validateImpactArtifact, type UpdateSpan } from "@hapi/protocol";
import { configuration } from "../../configuration";
import { constantTimeEquals } from "../../utils/crypto";
import { parseAccessToken } from "../../utils/accessToken";
import { createRateLimiter } from "../middleware/rateLimit";
import { resolveSessionForNamespace, type CliEnv } from "./cli";
import type { SyncEngine } from "../../sync/syncEngine";
import type { Store } from "../../store";

/**
 * Peer → server impact-artifact SUBMIT endpoint (issue #1772, Task 3).
 * `POST /cli/impact-artifact` — the spawned analysis peer POSTs its produced
 * artifact here, authenticating with its injected `$CLI_API_TOKEN` (CLI-token
 * routes live under `/cli`, next to `/cli/error-reports` which the peer can
 * already reach). The server VALIDATES on write (R2/R3), server-STAMPS `node_id`
 * (R4 — never trusts the peer body), confirms the artifact matches the active
 * analysis the orchestrator registered for the posting session, persists it, and
 * signals the orchestrator's watchdog.
 */

/**
 * The seam to Task 5's `impactService`. The route (consumer) declares the
 * minimal surface it needs; the service implements it. Type-only, so there is no
 * circular runtime import (route never imports the service module).
 */
export interface ActiveImpactAnalysis {
  /** The UpdateSpan that seeded this analysis — carries the harness_id +
   *  version range the submitted artifact must match. */
  seedSpan: UpdateSpan;
}

export interface ImpactAnalysisCoordinator {
  /** The node id the server stamps on every artifact (R4). Resolved once at
   *  bootstrap as `federationConfig?.nodeId ?? "standalone"` — the SAME literal
   *  #1770's harness poll uses, so `(node_id, harness_id, version_range)`
   *  lookups cannot mis-hit on a standalone install. */
  readonly nodeId: string;
  /** The active analysis registered for a posting session, or null when no
   *  analysis is in flight for it (e.g. the watchdog already timed out). */
  getActiveAnalysisForSession(sessionId: string): ActiveImpactAnalysis | null;
  /** Called after a valid artifact is persisted, so the orchestrator's watchdog
   *  can complete without polling. */
  notifyArtifactSubmitted(sessionId: string): void;
}

const bearerSchema = z.string().regex(/^Bearer\s+(.+)$/i);

const submitSchema = z.object({
  sessionId: z.string().min(1).max(200),
  namespace: z.string().optional(),
  // Validated separately with validateImpactArtifact (evidence-for-non-gray
  // superRefine → 400) so the peer gets the precise Zod error to correct + re-POST.
  artifact: z.unknown(),
});

export function createImpactArtifactRoutes(
  getSyncEngine: () => SyncEngine | null,
  opts: {
    getStore: () => Store | null;
    getCoordinator: () => ImpactAnalysisCoordinator | null;
  }
): Hono<CliEnv> {
  const app = new Hono<CliEnv>();

  // Bearer auth — DELIBERATELY replicated from createCliRoutes (cli.ts) rather
  // than extracted. The main cli middleware guards ~40 daemon-RPC routes (high
  // blast radius); a localized second copy here keeps that path byte-identical.
  // Same primitives: parseAccessToken + constant-time compare vs cliApiToken.
  app.use("*", async (c, next) => {
    const raw = c.req.header("authorization");
    if (!raw) return c.json({ error: "Missing Authorization header" }, 401);
    const parsed = bearerSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid Authorization header" }, 401);
    }
    const token = parsed.data.replace(/^Bearer\s+/i, "");
    const parsedToken = parseAccessToken(token);
    if (
      !parsedToken ||
      !constantTimeEquals(parsedToken.baseToken, configuration.cliApiToken)
    ) {
      return c.json({ error: "Invalid token" }, 401);
    }
    c.set("namespace", parsedToken.namespace);
    return await next();
  });

  const limiter = createRateLimiter({ name: "impact-artifact" });

  app.post(
    "/impact-artifact",
    limiter,
    cataloged(
      defineCapability({
        id: "session-introspection.cli-impact-artifact",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Submit a peer-to-server impact-analysis artifact over the CLI-token surface.",
        whenToUse: "When a peer session reports its impact-analysis result.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/cli/impact-artifact",
        },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    async c => {
      const engine = getSyncEngine();
      const store = opts.getStore();
      const coordinator = opts.getCoordinator();
      if (!engine || !store || !coordinator) {
        return c.json({ error: "Not ready" }, 503);
      }

      const json = await c.req.json().catch(() => null);
      const parsed = submitSchema.safeParse(json);
      if (!parsed.success) return c.json({ error: "Invalid body" }, 400);

      const namespace = c.get("namespace");

      // Confirm the posting session belongs to the caller's namespace (anti-spoof).
      const resolved = resolveSessionForNamespace(
        engine,
        parsed.data.sessionId,
        namespace
      );
      if (!resolved.ok)
        return c.json({ error: resolved.error }, resolved.status);
      // Use resolved.session.id (the UUID), not `.sessionId` which may be a tag
      // (same convention cli.ts follows) — the orchestrator registers the active
      // analysis under the spawned session's UUID.
      const postingUuid = resolved.session.id;

      // The orchestrator must have registered an active analysis for this session.
      // A missing registration → 409 (the peer should stop, not retry a 400).
      const active = coordinator.getActiveAnalysisForSession(postingUuid);
      if (!active) {
        return c.json(
          { error: "No active impact analysis for this session" },
          409
        );
      }

      // Validate the artifact shape — evidence-for-non-gray is enforced IN the
      // schema (R2/R3). On failure the peer's seed prompt instructs it to re-POST.
      const validation = validateImpactArtifact(parsed.data.artifact);
      if (!validation.ok) return c.json({ error: validation.error }, 400);
      const artifact = validation.artifact;

      // The artifact must describe the SAME (harness, range) the orchestrator
      // seeded — a mismatched span means the peer analyzed the wrong thing.
      const span = active.seedSpan;
      if (
        artifact.harness_id !== span.harness_id ||
        artifact.from_version !== span.from_version ||
        artifact.to_version !== span.to_version
      ) {
        return c.json(
          {
            error:
              "Artifact harness/version-range does not match the active analysis",
          },
          400
        );
      }

      // Server-stamp node_id (R4) — overwrite whatever the peer sent.
      const stamped = { ...artifact, node_id: coordinator.nodeId };

      // Persist. Idempotent on the PK (a double-POST is harmless — OR5).
      store.impactAnalysis.upsert({
        node_id: coordinator.nodeId,
        harness_id: artifact.harness_id,
        version_from: artifact.from_version,
        version_to: artifact.to_version,
        analyzed_at: artifact.analyzed_at,
        peer_session_id: postingUuid,
        artifact: stamped,
        seed_span: span,
      });

      // Signal the orchestrator's watchdog (fresh-row completion, not polling).
      coordinator.notifyArtifactSubmitted(postingUuid);
      return c.json({ ok: true }, 200);
    }
  );

  return app;
}
