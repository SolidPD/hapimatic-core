// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from "hono";
import { defineCapability } from "@hapi/protocol";

import { cataloged } from "../../../capabilities/cataloged";
import type { Store } from "../../../store";
import type { StoredSession } from "../../../store/types";
import type { WebAppEnv } from "../../middleware/auth";
import { billableSwitchGate } from "../../middleware/billableSwitchGate";
import { closedRefusal, describeIssue } from "../billableSwitch";
import {
  FederationTrackingPutBodySchema,
  localHistory,
  localRead,
  lowersBilling,
  writeLocalTracking,
  type CategoryAnswer,
  type FederationTrackingPutBody,
  type Ready,
} from "../billableTracking";
import {
  checkCallerNamespace,
  checkFederationToken,
  type FederationDeps,
} from "./shared";

/** The store the tracking receivers read and write; `buildWebApp.ts` passes it. */
export type TrackingReceiverDeps = { getStore?: () => Store | null };

/**
 * The owning node's half of the tracking record (issue #6778 PR-C, Task 14; the
 * plan's section 7.1): `GET` and `PUT /api/federation/sessions/:id/tracking` and
 * `GET /api/federation/sessions/:id/tracking/history`. The hub calls them through
 * the session proxy only when this node advertises `billable:tracking-carry`.
 *
 * Every receiver checks, in the order of `billableSwitchReceivers.ts`: the gate
 * (a bare 404 in `off`), the federation token (401), the engine and the store
 * (503), then the session and the STRICT caller namespace (a receiver added
 * after #6224: no header, or another namespace, is a 404), and only then the
 * body. The session is read from the store, never through `engine.getSession`,
 * which can refresh a session that is not cached and run #6586's tracker
 * (7.1; review T12). A deleted session with a kept record or history is read
 * here, `source: "deleted"`, and never written (R11).
 *
 * The answers carry the whole record: the hub redacts for an agent before it
 * answers (7.1), because the proxy forwards no caller session. The write runs
 * `writeLocalTracking`, the hub's own local write, with the actor, the channel,
 * the entry node and the origin the forwarding node recorded (one mesh token,
 * section 6 item 3). The hub is the entry node and resolves the category (ruling
 * 12; #6779 N2); this node alone holds the prior record, so it decides: a kept
 * category uses no resolution at all, a changed one uses the hub's answer, and a
 * changed one the hub could not resolve answers 409 `categories_unavailable`.
 *
 * These call no `SessionService`, because a peer does not proxy to itself (#1063).
 */
export function createBillableTrackingReceiverRoutes(
  deps: FederationDeps & TrackingReceiverDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  // Read once at mount, like the hub routes; `off` without an engine.
  const mode = deps.getSyncEngine()?.getBillableSwitchMode?.() ?? "off";
  const gate = billableSwitchGate(mode);
  const closed = mode === "closed";

  type Found =
    | {
        ok: true;
        ready: Ready;
        store: Store;
        live: StoredSession | null;
        namespace: string;
      }
    | { ok: false; response: Response };

  const notFound = (c: Context): Response =>
    c.json({ error: "Session not found" }, 404);

  const requireTrackingSession = (c: Context<WebAppEnv>): Found => {
    if (!checkFederationToken(deps, c.req.header("authorization"))) {
      return { ok: false, response: c.json({ error: "Unauthorized" }, 401) };
    }
    const engine = deps.getSyncEngine();
    const service = engine?.getBillableSwitchService?.() ?? null;
    const store = deps.getStore?.() ?? null;
    if (!engine || !service || !store) {
      return { ok: false, response: c.json({ error: "Not connected" }, 503) };
    }
    const sessionId = c.req.param("id") as string;
    const row = store.sessions.getSession(sessionId);
    if (row) {
      const refused = checkCallerNamespace(c, row);
      if (refused) return { ok: false, response: refused };
      return {
        ok: true,
        ready: { engine, service },
        store,
        live: row,
        namespace: row.namespace,
      };
    }
    // A deleted session: the strict check has no row to compare, so the
    // namespace is the header's, and the kept rows are read in it alone.
    const namespace = c.req.header("x-hapi-caller-namespace");
    if (
      !namespace ||
      (store.billableTracking.get(sessionId, namespace) === null &&
        store.billableTracking.token(sessionId, namespace) === 0)
    ) {
      return { ok: false, response: notFound(c) };
    }
    return {
      ok: true,
      ready: { engine, service },
      store,
      live: null,
      namespace,
    };
  };

  // ─── GET /federation/sessions/:id/tracking ───────────────────────
  app.get(
    "/federation/sessions/:id/tracking",
    cataloged(
      defineCapability({
        id: "session-lifecycle.api-federation-sessions-tracking",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Read a session's time-tracking record on the node that owns it. Peer-incoming; the hub proxies here and leaves out the money fields for an agent.",
        whenToUse:
          "When the hub reads the tracking record of a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/tracking",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    c => {
      const found = requireTrackingSession(c);
      if (!found.ok) return found.response;
      return c.json(
        localRead(
          found.ready,
          found.store,
          found.live,
          c.req.param("id"),
          found.namespace
        )
      );
    }
  );

  // ─── PUT /federation/sessions/:id/tracking ───────────────────────
  app.put(
    "/federation/sessions/:id/tracking",
    cataloged(
      defineCapability({
        id: "session-lifecycle.api-federation-sessions-tracking-set",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Change a session's time-tracking record on the node that owns it, with the actor and the category answer the hub recorded. Peer-incoming.",
        whenToUse:
          "When the hub forwards a tracking change for a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/federation/sessions/:id/tracking",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    async c => {
      const found = requireTrackingSession(c);
      if (!found.ok) return found.response;
      const raw: unknown = await c.req.json().catch(() => undefined);
      const parsed = FederationTrackingPutBodySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: describeIssue(parsed.error) }, 400);
      }
      const req = parsed.data;
      if (closed && !lowersBilling(req.request)) {
        return closedRefusal(c, found.ready.service.localNodeLabel());
      }
      // A deleted session's kept record is read-only (R11).
      if (!found.live) return notFound(c);
      return writeLocalTracking(c, found.ready, found.store, {
        live: found.live,
        sessionId: found.live.id,
        namespace: found.namespace,
        body: req.request,
        actor: req.actor,
        via: req.via,
        entryNodeId: req.entryNodeId,
        origin: req.origin,
        resolveCategory: async ref => entryNodeAnswer(req, ref),
        agent: false,
      });
    }
  );

  // ─── GET /federation/sessions/:id/tracking/history ───────────────
  app.get(
    "/federation/sessions/:id/tracking/history",
    cataloged(
      defineCapability({
        id: "session-lifecycle.api-federation-sessions-tracking-history",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Read every change to a session's time-tracking record on the node that owns it, with both snapshots of each. Peer-incoming; the hub redacts for an agent.",
        whenToUse:
          "When the hub reads the tracking history of a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/tracking/history",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    c => {
      const found = requireTrackingSession(c);
      if (!found.ok) return found.response;
      return c.json(
        localHistory(
          found.ready,
          found.store,
          found.live,
          c.req.param("id"),
          found.namespace
        )
      );
    }
  );

  return app;
}

/**
 * The entry node's answer for the category a write sets or changes (ruling 12):
 * why its list could not be read, or what it resolved. A resolution of another
 * category than the body names is not an answer for this one, so it counts as
 * unknown (400 `invalid_field` `category`) and never names the record's category.
 * A settings body that arrives with neither (no hub sends one) counts as a list
 * that could not be read.
 */
function entryNodeAnswer(
  req: FederationTrackingPutBody,
  ref: { source: string; id: string }
): CategoryAnswer {
  if (req.categoryUnavailable) {
    return { ok: false, reason: req.categoryUnavailable.reason };
  }
  if (req.resolvedCategory === undefined) return { ok: false, reason: null };
  const category = req.resolvedCategory;
  if (category && (category.source !== ref.source || category.id !== ref.id)) {
    return { ok: true, category: null };
  }
  return { ok: true, category };
}
