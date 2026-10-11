// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { WebAppEnv } from "../middleware/auth";
import {
  OpenRouterModelSchema,
  type OpenRouterModel,
} from "@hapi/protocol/schemas";

/**
 * OpenRouter model-catalog route (issue #1975).
 *
 * The Create-Session OpenRouter model picker is backed by OpenRouter's full
 * live catalog (hundreds of models) rather than a hardcoded curated list — the
 * documented #1733 follow-up. This route fetches `/api/v1/models` (a PUBLIC
 * OpenRouter endpoint, no key required), trims each entry to what the picker
 * needs, and caches the result in-memory so the client never hammers OpenRouter
 * or hits CORS. Resilient: a fetch failure serves the last good cache (or an
 * empty list) so the form never breaks.
 */

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 15_000;

let cache: { models: OpenRouterModel[]; fetchedAt: number } | null = null;

/** Shape of one raw entry in OpenRouter's `/api/v1/models` `data[]`. */
type RawOpenRouterModel = {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown } | null;
};

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Trim OpenRouter's `/api/v1/models` response to the picker shape. Pure +
 * exported so it is unit-testable without a network call. Skips entries with no
 * `id`; validates each via {@link OpenRouterModelSchema}.
 */
export function trimOpenRouterModels(raw: unknown): OpenRouterModel[] {
  if (
    !raw ||
    typeof raw !== "object" ||
    !Array.isArray((raw as { data?: unknown }).data)
  ) {
    return [];
  }
  const data = (raw as { data: unknown[] }).data;
  const out: OpenRouterModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const m = entry as RawOpenRouterModel;
    const id = asString(m.id);
    if (!id) continue;
    const ctx =
      typeof m.context_length === "number" ? m.context_length : undefined;
    const parsed = OpenRouterModelSchema.safeParse({
      id,
      name: asString(m.name) ?? id,
      contextLength: ctx,
      promptPrice: asString(m.pricing?.prompt),
      completionPrice: asString(m.pricing?.completion),
    });
    if (parsed.success) out.push(parsed.data);
  }
  // Stable alphabetical order by id so the picker list is deterministic.
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export function createOpenRouterRoutes(): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // GET /openrouter/models — the trimmed, cached OpenRouter catalog.
  app.get(
    "/openrouter/models",
    cataloged(
      defineCapability({
        id: "model-permission.openrouter-models",
        domain: "model-permission",
        surface: "rest",
        description: "Return the available OpenRouter model list.",
        whenToUse: "When the UI shows selectable OpenRouter models.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/openrouter/models",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const now = Date.now();
      if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
        return c.json(cache.models);
      }
      try {
        const resp = await fetch(OPENROUTER_MODELS_URL, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { Accept: "application/json" },
        });
        if (!resp.ok) {
          throw new Error(
            `OpenRouter models fetch failed: HTTP ${resp.status}`
          );
        }
        const json: unknown = await resp.json();
        const models = trimOpenRouterModels(json);
        cache = { models, fetchedAt: now };
        return c.json(models);
      } catch {
        // Resilient fallback: serve the last good cache if we have one, else [].
        return c.json(cache?.models ?? []);
      }
    }
  );

  return app;
}

/** Test-only: reset the in-memory cache between cases. */
export function _resetOpenRouterCache(): void {
  cache = null;
}
