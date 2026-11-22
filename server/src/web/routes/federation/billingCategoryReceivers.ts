// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from "hono";
import {
  defineCapability,
  FederationBillingCategoryListBodySchema,
  FederationBillingCategoryLookupBodySchema,
  type FederationBillingCategoryLookupAnswer,
} from "@hapi/protocol";
import type { BillingCategoryService } from "../../../billingCategories/billingCategoryService";
import { cataloged } from "../../../capabilities/cataloged";
import type { WebAppEnv } from "../../middleware/auth";
import { billableSwitchGate } from "../../middleware/billableSwitchGate";
import { checkFederationToken, type FederationDeps } from "./shared";

/**
 * Issue #6779 (plan 4.2): the owner's two receivers, read by every other node
 * through `NodeRegistry.listBillingCategoriesOnNode` and
 * `lookupBillingCategoryOnNode`. Each runs, in order: the catalog tag, the
 * gate, the federation token (401), this node must be the ready owner (404),
 * the caller's namespace (404 when absent), and this node's own place must be
 * `local` (409 `categories_not_local` otherwise, so a reader that sees only
 * this owner is never served a contested list). They call the service's
 * local-only reads, never the ones that route by place, so a receiver never
 * fans out. Bodies and answers use the stripping node-to-node schemas.
 */
type Checked =
  | { ok: true; service: BillingCategoryService; namespace: string }
  | { ok: false; response: Response };

function check(c: Context<WebAppEnv>, deps: FederationDeps): Checked {
  if (!checkFederationToken(deps, c.req.header("authorization"))) {
    return { ok: false, response: c.json({ error: "Unauthorized" }, 401) };
  }
  const service = deps.getBillingCategoryService?.() ?? null;
  if (!service || !service.isReadyOwner()) {
    return { ok: false, response: c.json({ error: "Not found" }, 404) };
  }
  const namespace = c.req.header("x-hapi-caller-namespace");
  if (!namespace) {
    return { ok: false, response: c.json({ error: "Not found" }, 404) };
  }
  const place = service.place();
  if (place.kind !== "local") {
    const reason = place.kind === "none" ? place.reason : "two-owners";
    return {
      ok: false,
      response: c.json({ code: "categories_not_local", reason }, 409),
    };
  }
  return { ok: true, service, namespace };
}

/** The body, or undefined when it is not JSON (the receiver answers 400). */
async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function createFederationBillingCategoryRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  // The gate is read once at mount, as the billable receivers read it.
  const mode = deps.getSyncEngine()?.getBillableSwitchMode?.() ?? "off";
  const gate = billableSwitchGate(mode);

  app.post(
    "/federation/billing-categories/list",
    cataloged(
      defineCapability({
        id: "session-lifecycle.federation-billing-categories",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Return the billing-category list this node keeps as the billing hub, in the caller's namespace (POST because the node proxy only issues POST).",
        whenToUse:
          "When another node reads the billing categories through from the billing hub.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/billing-categories/list",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    async c => {
      const checked = check(c, deps);
      if (!checked.ok) return checked.response;
      const body = FederationBillingCategoryListBodySchema.safeParse(
        await jsonBody(c)
      );
      if (!body.success) {
        return c.json({ code: "invalid_field", field: "includeRetired" }, 400);
      }
      return c.json(
        checked.service.readListLocal(checked.namespace, {
          includeRetired: body.data.includeRetired === true,
        }),
        200
      );
    }
  );

  app.post(
    "/federation/billing-categories/lookup",
    cataloged(
      defineCapability({
        id: "session-lifecycle.federation-billing-category-lookup",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Look one billing category up on the billing hub, in the caller's namespace; a hit and a miss both answer 200.",
        whenToUse:
          "When another node validates a tracked session's category against the billing hub.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/billing-categories/lookup",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    async c => {
      const checked = check(c, deps);
      if (!checked.ok) return checked.response;
      const body = FederationBillingCategoryLookupBodySchema.safeParse(
        await jsonBody(c)
      );
      if (!body.success) {
        return c.json({ code: "invalid_field", field: "ref" }, 400);
      }
      const category = checked.service.lookupLocal(
        checked.namespace,
        body.data.ref
      );
      const answer: FederationBillingCategoryLookupAnswer = category
        ? { found: true, category }
        : { found: false };
      return c.json(answer, 200);
    }
  );

  return app;
}
