// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import {
  BILLING_HISTORY_LIMIT_MAX,
  BillingCategoryAddBodySchema,
  BillingCategoryOrderBodySchema,
  BillingCategorySettingsBodySchema,
  BillingCategoryUpdateBodySchema,
  defineCapability,
  type BillableSwitchMode,
  type BillingCategoryErrorBody,
} from "@hapi/protocol";
import type {
  BillingCategoryRefusal,
  BillingCategoryService,
  BillingCategoryWrite,
} from "../../billingCategories/billingCategoryService";
import { cataloged } from "../../capabilities/cataloged";
import type { WebAppEnv } from "../middleware/auth";
import { billableSwitchGate } from "../middleware/billableSwitchGate";
import { isAgentRequest } from "./agentEscalation";

/**
 * Issue #6779 (plan 4.1): the six billing-category routes. Every handler
 * checks, in this order: the catalog tag, the gate, the agent refusal, the
 * `closed` state (writes only), the place, validation, then the transaction.
 * So an agent's request answers the same 403 whatever else is wrong with it,
 * and no answer an agent gets carries an owner's name, a field or a rate.
 * Both reads are tiered `mutating` (P-7): no agent reads the list.
 *
 * No error body carries a list or a rate (R11, R12): a stale token answers
 * the new token only, and a field refusal names the field and a reason this
 * code composes, never zod's message text. A rate travels only in a JSON
 * body, never in a path or a query.
 */
export type BillingCategoryRoutesOptions = {
  getService: () => BillingCategoryService | null;
  billableSwitchMode: BillableSwitchMode;
};

const AGENT_REFUSAL = { code: "agent_billing_categories_refused" } as const;
const USER_AGENT_MAX = 256;

function refuse(c: Context, refusal: BillingCategoryRefusal): Response {
  return c.json(refusal.body, refusal.status as ContentfulStatusCode);
}

function invalid(c: Context, field: string, reason: string): Response {
  const body: BillingCategoryErrorBody = {
    code: "invalid_field",
    field,
    reason,
  };
  return c.json(body, 400);
}

const NAME_REASONS = new Set(["empty", "too-long", "invisible"]);

/** The first issue as `{ field, reason }`; never zod's message text. */
function fieldRefusal(error: z.ZodError): { field: string; reason: string } {
  const issue = error.issues[0];
  if (!issue) return { field: "body", reason: "invalid" };
  if (issue.code === "unrecognized_keys") {
    return { field: String(issue.keys[0] ?? "body"), reason: "unknown-field" };
  }
  const field = issue.path.map(String).join(".") || "body";
  if (issue.code === "custom" && NAME_REASONS.has(issue.message)) {
    return { field, reason: issue.message };
  }
  if (issue.message === "not a billing currency") {
    return { field, reason: "unknown-currency" };
  }
  if (issue.message === "empty") return { field, reason: "empty" };
  if (issue.code === "too_big" || issue.code === "too_small") {
    return { field, reason: "out-of-range" };
  }
  if (issue.code === "invalid_type") return { field, reason: "invalid-type" };
  return { field, reason: "invalid" };
}

async function readJson(
  c: Context
): Promise<{ ok: true; data: unknown } | { ok: false }> {
  try {
    return { ok: true, data: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

function userAgent(c: Context): string | null {
  const value = c.req.header("user-agent");
  return value ? value.slice(0, USER_AGENT_MAX) : null;
}

export function createBillingCategoryRoutes(
  options: BillingCategoryRoutesOptions
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const gate = billableSwitchGate(options.billableSwitchMode);
  const closed = options.billableSwitchMode === "closed";

  /**
   * One write handler: the agent refusal, `closed`, the place, the body's
   * validation, then the service's transaction.
   */
  const writeHandler =
    <S extends z.ZodTypeAny>(
      schema: S,
      toWrite: (body: z.infer<S>, c: Context<WebAppEnv>) => BillingCategoryWrite
    ) =>
    async (c: Context<WebAppEnv>) => {
      if (isAgentRequest(c)) return c.json(AGENT_REFUSAL, 403);
      if (closed) {
        return c.json({ code: "billable_feature_closed" }, 409);
      }
      const service = options.getService();
      if (!service) return c.notFound();
      const placeRefusal = service.writeRefusal();
      if (placeRefusal) return refuse(c, placeRefusal);
      const raw = await readJson(c);
      if (!raw.ok) return invalid(c, "body", "not-json");
      const parsed = schema.safeParse(raw.data);
      if (!parsed.success) {
        const { field, reason } = fieldRefusal(parsed.error);
        return invalid(c, field, reason);
      }
      const body = parsed.data as z.infer<S> & { token: number };
      const result = service.write(
        c.get("namespace"),
        body.token,
        { userAgent: userAgent(c) },
        toWrite(body, c)
      );
      if (!result.ok) return refuse(c, result.refusal);
      return c.json(result.value, 200);
    };

  // ─── GET /billing-categories ─────────────────────────────────────
  app.get(
    "/billing-categories",
    cataloged(
      defineCapability({
        id: "session-lifecycle.billing-categories",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Read the billing categories offered for tracked sessions, in order, with the default, each default hourly rate and the currency, from the billing hub.",
        whenToUse:
          "When a person's form needs the category list (the Create page, the session controls, Settings); never for an agent.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/billing-categories",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    async c => {
      if (isAgentRequest(c)) return c.json(AGENT_REFUSAL, 403);
      const service = options.getService();
      if (!service) return c.notFound();
      const result = await service.readList(c.get("namespace"), {
        includeRetired: c.req.query("retired") === "1",
      });
      if (!result.ok) return refuse(c, result.refusal);
      return c.json(result.value, 200);
    }
  );

  // ─── GET /billing-categories/history ─────────────────────────────
  app.get(
    "/billing-categories/history",
    cataloged(
      defineCapability({
        id: "session-lifecycle.billing-category-history",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Read the billing categories' change history on the billing hub, newest first.",
        whenToUse:
          "When a person reviews who changed a category, a default rate or the currency.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/billing-categories/history",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    async c => {
      if (isAgentRequest(c)) return c.json(AGENT_REFUSAL, 403);
      const service = options.getService();
      if (!service) return c.notFound();
      const placeRefusal = service.writeRefusal();
      if (placeRefusal) return refuse(c, placeRefusal);
      const limitText = c.req.query("limit");
      const beforeText = c.req.query("before");
      const limit = limitText === undefined ? undefined : Number(limitText);
      const before = beforeText === undefined ? undefined : Number(beforeText);
      if (
        limit !== undefined &&
        (!Number.isInteger(limit) ||
          limit < 1 ||
          limit > BILLING_HISTORY_LIMIT_MAX)
      ) {
        return invalid(c, "limit", "out-of-range");
      }
      if (
        before !== undefined &&
        (!Number.isSafeInteger(before) || before < 1)
      ) {
        return invalid(c, "before", "out-of-range");
      }
      const result = service.history(c.get("namespace"), { limit, before });
      if (!result.ok) return refuse(c, result.refusal);
      return c.json(result.value, 200);
    }
  );

  // ─── POST /billing-categories ────────────────────────────────────
  app.post(
    "/billing-categories",
    cataloged(
      defineCapability({
        id: "session-lifecycle.billing-category-add",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Add a billing category, with an optional default hourly rate, on the billing hub.",
        whenToUse: "When a person adds a category for tracked sessions.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/billing-categories",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    writeHandler(BillingCategoryAddBodySchema, body => ({
      op: "add",
      name: body.name,
      defaultRate: body.defaultRate,
    }))
  );

  // ─── PUT /billing-categories/order ───────────────────────────────
  app.put(
    "/billing-categories/order",
    cataloged(
      defineCapability({
        id: "session-lifecycle.billing-category-order",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Reorder the offered billing categories on the billing hub.",
        whenToUse: "When a person drags the categories into a new order.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/billing-categories/order",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    writeHandler(BillingCategoryOrderBodySchema, body => ({
      op: "order",
      ids: body.ids,
    }))
  );

  // ─── PUT /billing-categories/settings ────────────────────────────
  app.put(
    "/billing-categories/settings",
    cataloged(
      defineCapability({
        id: "session-lifecycle.billing-category-settings",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Choose the default billing category and the currency offered for a new rate, on the billing hub.",
        whenToUse:
          "When a person changes the default category or the currency.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/billing-categories/settings",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    writeHandler(BillingCategorySettingsBodySchema, body => ({
      op: "settings",
      defaultCategoryId: body.defaultCategoryId,
      currency: body.currency,
    }))
  );

  // ─── PATCH /billing-categories/:id ───────────────────────────────
  app.patch(
    "/billing-categories/:id",
    cataloged(
      defineCapability({
        id: "session-lifecycle.billing-category-update",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Rename, re-rate, retire or restore a billing category on the billing hub; a category is never deleted.",
        whenToUse: "When a person edits a category.",
        invocation: {
          kind: "rest",
          method: "PATCH",
          path: "/api/billing-categories/:id",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    gate,
    writeHandler(BillingCategoryUpdateBodySchema, (body, c) => ({
      op: "update",
      id: c.req.param("id") ?? "",
      name: body.name,
      defaultRate: body.defaultRate,
      retired: body.retired,
    }))
  );

  return app;
}
