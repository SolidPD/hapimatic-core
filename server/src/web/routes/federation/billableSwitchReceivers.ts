// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from "hono";
import type { z } from "zod";
import { defineCapability } from "@hapi/protocol";

import {
  BillableSwitchPushBodySchema,
  type BillableSwitchService,
} from "../../../billableSwitch/billableSwitchService";
import { cataloged } from "../../../capabilities/cataloged";
import type { Session, SyncEngine } from "../../../sync/syncEngine";
import type { WebAppEnv } from "../../middleware/auth";
import { billableSwitchGate } from "../../middleware/billableSwitchGate";
import {
  BillableSwitchHeaderResponseSchema,
  BillableSwitchSetResponseSchema,
  closedRefusal,
  describeIssue,
  FederationBillableConfirmBodySchema,
  FederationBillableHeaderBodySchema,
  FederationBillableSetBodySchema,
  projectKeyProblem,
} from "../billableSwitch";
import {
  checkCallerNamespace,
  checkFederationToken,
  type FederationDeps,
} from "./shared";

/**
 * Peer-incoming billable switch receivers (issue #6646, Task 7): the owning
 * node's half of every proxied switch, confirm, history and header write, the
 * authoritative list a billing reader asks each node for, and the header-report
 * push to a node without a registry (Task 4).
 *
 * Every per-session receiver checks, in the order of `pinMutations.ts`: the gate
 * (a bare 404 in `off`), the federation token (401), the engine (503), the
 * session (404), the STRICT caller namespace, and only then the body
 * (`c.req.json().catch(() => undefined)`, strict schemas, 400 on a mismatch). The
 * actor, the channel and the entry node are taken as the forwarding node claims
 * them (one shared mesh token, section 6 item 3). In `closed` the on direction
 * (a switch-on, Keep, every header write) answers 409 `billable_feature_closed`.
 *
 * These call `BillableSwitchService` directly and never `SessionService`,
 * because a peer does not proxy to itself (#1063).
 */
export function createBillableSwitchReceiverRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  // The gate is read once at mount, like the hub routes (index.ts sets it on
  // the engine before the web app is built); `off` without an engine.
  const mode = deps.getSyncEngine()?.getBillableSwitchMode?.() ?? "off";
  const gate = billableSwitchGate(mode);
  const closed = mode === "closed";

  type Node =
    | { ok: true; engine: SyncEngine; service: BillableSwitchService }
    | { ok: false; response: Response };

  const requireNode = (c: Context<WebAppEnv>): Node => {
    if (!checkFederationToken(deps, c.req.header("authorization"))) {
      return { ok: false, response: c.json({ error: "Unauthorized" }, 401) };
    }
    const engine = deps.getSyncEngine();
    const service = engine?.getBillableSwitchService?.() ?? null;
    if (!engine || !service) {
      return { ok: false, response: c.json({ error: "Not connected" }, 503) };
    }
    return { ok: true, engine, service };
  };

  type Local =
    | {
        ok: true;
        engine: SyncEngine;
        service: BillableSwitchService;
        session: Session;
      }
    | { ok: false; response: Response };

  const requireLocalSession = (c: Context<WebAppEnv>): Local => {
    const node = requireNode(c);
    if (!node.ok) return node;
    const session = node.engine.getSession(c.req.param("id") as string);
    if (!session) {
      return {
        ok: false,
        response: c.json({ error: "Session not found" }, 404),
      };
    }
    const refused = checkCallerNamespace(c, session);
    if (refused) return { ok: false, response: refused };
    return {
      ok: true,
      engine: node.engine,
      service: node.service,
      session,
    };
  };

  /** A node-level receiver scoped to a namespace: without the header it serves nothing. */
  const callerNamespace = (c: Context<WebAppEnv>): string | null =>
    c.req.header("x-hapi-caller-namespace") || null;

  const readBody = async <T>(
    c: Context<WebAppEnv>,
    schema: z.ZodType<T>
  ): Promise<{ ok: true; data: T } | { ok: false; response: Response }> => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        response: c.json({ error: describeIssue(parsed.error) }, 400),
      };
    }
    return { ok: true, data: parsed.data };
  };

  // ─── PUT /federation/sessions/:id/billable ───────────────────────
  app.put(
    "/federation/sessions/:id/billable",
    cataloged(
      defineCapability({
        id: "session-lifecycle.api-federation-sessions-billable",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Switch a session billable or not on the node that owns it. Peer-incoming; the hub proxies here with the actor it recorded.",
        whenToUse:
          "When the hub forwards a billable switch for a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/federation/sessions/:id/billable",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    async c => {
      const local = requireLocalSession(c);
      if (!local.ok) return local.response;
      const body = await readBody(c, FederationBillableSetBodySchema);
      if (!body.ok) return body.response;
      const req = body.data;
      if (req.reason !== "switch" && req.billable) {
        return c.json(
          { error: `The reason "${req.reason}" is only for switching off` },
          400
        );
      }
      if (closed && req.billable) {
        return closedRefusal(c, local.service.localNodeLabel());
      }
      const result = local.service.setSwitch(
        local.session.id,
        local.session.namespace,
        {
          billable: req.billable,
          reason: req.reason,
          actor: req.actor,
          via: req.via,
          entryNodeId: req.entryNodeId,
          loggedMs: req.loggedMs,
        }
      );
      if (!result.found) return c.json({ error: "Session not found" }, 404);
      return c.json({
        ok: true,
        changed: result.changed,
        billable: result.billable,
        billableConfirm: result.billableConfirm,
        timerMs: result.timerMs,
        unloggedMs: result.unloggedMs,
        loggedKnown: result.loggedKnown,
      } satisfies z.infer<typeof BillableSwitchSetResponseSchema>);
    }
  );

  // ─── POST /federation/sessions/:id/billable/confirm ──────────────
  app.post(
    "/federation/sessions/:id/billable/confirm",
    cataloged(
      defineCapability({
        id: "session-lifecycle.api-federation-sessions-billable-confirm",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Keep or reverse a session waiting for a billable confirmation on the node that owns it. Peer-incoming; Keep all calls it once per remote session.",
        whenToUse:
          "When the hub forwards Keep, Reverse or Keep all for a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/billable/confirm",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    async c => {
      const local = requireLocalSession(c);
      if (!local.ok) return local.response;
      const body = await readBody(c, FederationBillableConfirmBodySchema);
      if (!body.ok) return body.response;
      const req = body.data;
      if (closed && req.decision === "keep") {
        return closedRefusal(c, local.service.localNodeLabel());
      }
      const outcome = local.service.confirm(
        local.session.id,
        local.session.namespace,
        {
          decision: req.decision,
          reason: req.reason,
          actor: req.actor,
          via: req.via,
          entryNodeId: req.entryNodeId,
          loggedMs: req.loggedMs,
        }
      );
      if (outcome.outcome === "not_found") {
        return c.json({ error: "Session not found" }, 404);
      }
      if (outcome.outcome === "not_pending") {
        return c.json(
          {
            error: "The session is not waiting for a billable confirmation",
            code: "not_pending",
          },
          409
        );
      }
      const result = outcome.result;
      return c.json({
        ok: true,
        changed: result.changed,
        billable: result.billable,
        billableConfirm: result.billableConfirm,
        timerMs: result.timerMs,
        unloggedMs: result.unloggedMs,
        loggedKnown: result.loggedKnown,
      } satisfies z.infer<typeof BillableSwitchSetResponseSchema>);
    }
  );

  // ─── GET /federation/sessions/:id/billable/history ───────────────
  app.get(
    "/federation/sessions/:id/billable/history",
    cataloged(
      defineCapability({
        id: "session-lifecycle.api-federation-sessions-billable-history",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Read a session's billable switch history on the node that owns it, the record of a deleted session included. Peer-incoming.",
        whenToUse:
          "When the hub reads the authoritative billable history of a session that lives, or lived, on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/billable/history",
        },
        auth: "federation-token",
        riskTier: "readonly",
        availability: { scope: "operator" },
      })
    ),
    gate,
    c => {
      const node = requireNode(c);
      if (!node.ok) return node.response;
      // The live row or the events of a deleted one, both read in the caller's
      // namespace only: another namespace, or no header, is the same 404.
      const namespace = callerNamespace(c);
      const history = namespace
        ? node.service.localHistory(c.req.param("id") as string, namespace)
        : null;
      if (!history) return c.json({ error: "Session not found" }, 404);
      return c.json(history);
    }
  );

  // ─── POST /federation/billable-switch/headers ────────────────────
  app.post(
    "/federation/billable-switch/headers",
    cataloged(
      defineCapability({
        id: "session-lifecycle.api-federation-billable-switch-headers",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Set this node's billable header for a project and switch the picked sessions on with it, in one transaction. Peer-incoming.",
        whenToUse:
          "When the hub forwards a person's header change for a project on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/billable-switch/headers",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    async c => {
      const node = requireNode(c);
      if (!node.ok) return node.response;
      const namespace = callerNamespace(c);
      if (!namespace) return c.json({ error: "Not found" }, 404);
      const body = await readBody(c, FederationBillableHeaderBodySchema);
      if (!body.ok) return body.response;
      const req = body.data;
      if (!req.billable && req.picks.length > 0) {
        return c.json(
          { error: "Sessions are picked only when a header goes on" },
          400
        );
      }
      const keyProblem = projectKeyProblem(req.projectKey, req.keyKind);
      if (keyProblem) return c.json({ error: keyProblem }, 400);
      if (closed) return closedRefusal(c, node.service.localNodeLabel());
      const result = node.service.applyHeader({
        namespace,
        projectKey: req.projectKey,
        keyKind: req.keyKind,
        billable: req.billable,
        picks: req.picks,
        actor: req.actor,
        via: req.via,
        entryNodeId: req.entryNodeId,
      });
      return c.json({
        ok: true,
        header: {
          projectKey: result.header.projectKey,
          keyKind: result.header.keyKind,
          billable: result.header.billable,
          updatedAt: result.header.updatedAt,
        },
        sessions: result.sessions,
      } satisfies z.infer<typeof BillableSwitchHeaderResponseSchema>);
    }
  );

  // ─── POST /federation/billable-switch/sessions ───────────────────
  app.post(
    "/federation/billable-switch/sessions",
    cataloged(
      defineCapability({
        id: "session-lifecycle.api-federation-billable-switch-sessions",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "List this node's sessions whose billable switch is on, for the caller's namespace: the authoritative read a billing reader makes of every node.",
        whenToUse:
          "When a billing reader on the hub asks each node which of its sessions are billable now.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/billable-switch/sessions",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    c => {
      const node = requireNode(c);
      if (!node.ok) return node.response;
      const namespace = callerNamespace(c);
      if (!namespace) return c.json({ error: "Not found" }, 404);
      return c.json({
        mode: node.service.mode(),
        sessions: node.service.listLocalBillable(namespace),
      });
    }
  );

  // ─── POST /federation/billable-switch/peer-reports ───────────────
  app.post(
    "/federation/billable-switch/peer-reports",
    cataloged(
      defineCapability({
        id: "session-lifecycle.api-federation-billable-switch-peer-reports",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Receive every node's billable header reports on a node that has no view of the mesh; a node with a registry answers that its own polls are the truth.",
        whenToUse:
          "When the hub pushes the other nodes' billable headers to a node that does not poll the mesh itself.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/billable-switch/peer-reports",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    async c => {
      const node = requireNode(c);
      if (!node.ok) return node.response;
      const body = await readBody(c, BillableSwitchPushBodySchema);
      if (!body.ok) return body.response;
      return c.json(node.service.applyPushedReports(body.data));
    }
  );

  return app;
}
