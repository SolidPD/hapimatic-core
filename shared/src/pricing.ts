// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Model pricing table — the SINGLE source of truth for per-token USD pricing
 * (issue #1667, epic #1662, Sub E; made provider-aware by issue #3353, epic #3345).
 *
 * Relocated here from `web/src/lib/costEstimate.ts` (D5): the web client and the
 * single-exe server BOTH derive pricing from this module. The web keeps its own
 * `estimateUsd` (it operates on the web-only `SessionTokenStats` type); the
 * server seeds `rate_cards` from `MODEL_PRICING_BY_PROVIDER` and computes per-turn
 * costs from the seeded snapshot (never from this table directly).
 *
 * PROVIDER-AWARE SSOT (issue #3353, ruling 3353-1). The provider is HALF the
 * rate-card lookup key (`server/src/store/turns/rateCards.ts` — `WHERE provider =
 * @provider AND model_id = @model_id`); an id-only table cannot express a
 * non-anthropic provider, nor OpenRouter passthrough (the same model id under a
 * different provider carries a different price). `MODEL_PRICING_BY_PROVIDER` nests
 * `provider → { modelId → ModelPricing }` so the provider is un-forgettable at the
 * seed. `MODEL_PRICING` is retained as a DERIVED alias for the anthropic sub-table
 * (the pre-#3353 flat shape) so existing web importers + claude-only tests are
 * byte-compatible — it is single-sourced (no duplication) from the nested map.
 *
 * This module is PURE — pure data + pure functions only. NO Zod, NO web/server
 * imports — it is consumed by both cli/web/server, so it must stay dependency-free.
 */

export interface ModelPricing {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /**
   * USD per million cache-read input tokens. OPTIONAL (issue #3353, 3353-2): a
   * provider without a distinct cached-input tier omits it (→ that class prices
   * as null, never a fabricated 0).
   */
  cacheReadPerMTok?: number;
  /**
   * USD per million cache-write input tokens for 5-minute TTL. OPTIONAL
   * (3353-2): only Anthropic charges a per-token cache-write fee. Google bills
   * caching as storage-per-hour and OpenAI has no separate write fee, so their
   * rows omit this — NEVER fabricate a number to satisfy the field.
   */
  cacheWrite5mPerMTok?: number;
  /** USD per million cache-write input tokens for 1-hour TTL. OPTIONAL (3353-2). */
  cacheWrite1hPerMTok?: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

/**
 * Provider-aware pricing SSOT: `provider → { modelId → ModelPricing }` (3353-1).
 * The provider strings MUST match what ingestion writes to `turns.model_provider`
 * (issue #3352): claude → `anthropic`, gemini → `google`, codex → `openai`
 * (`cli/src/agent/runners/runAgentSession.ts` `resolveAcpProvider`;
 * `cli/src/extensions/agent-codex/codex/codexRemoteLauncher.ts`). A NULL turn
 * provider defaults to `anthropic` (`cost.ts`), so anthropic rows also work for
 * legacy NULL-provider claude turns.
 *
 * Non-claude prices are CURRENT external facts (Google / OpenAI public pricing
 * pages, snapshot 2026-09-21 — see `PRICING_VERIFIED_AT_MS_BY_PROVIDER`). Tiered
 * Gemini Pro pricing (≤200k vs >200k tokens) is collapsed to the base (≤200k)
 * tier — a flat-rate-card approximation, the same spirit as pricing cache-writes
 * at the 5m rate (R7); the displayed cost is an estimate, not a bill. OpenRouter
 * is intentionally ABSENT (passthrough margin not determinable → those turns
 * resolve to null → "—", R4 no-fabrication); add an `openrouter` sub-table when a
 * reliable snapshot exists.
 */
export const MODEL_PRICING_BY_PROVIDER: Record<
  string,
  Record<string, ModelPricing>
> = {
  anthropic: {
    // Current models (in-path add, issue #3353) — the pre-#3353 table topped out
    // at opus-4-7, so every CURRENT claude session (opus-4-8 etc.) resolved no
    // card and displayed "—". Sourced: platform.claude.com/docs/about-claude/pricing
    // (snapshot 2026-09-21). Opus 5 / 4.8 share the Opus tier ($5/$25) with 4.7–4.5.
    // Opus 5.5 (issue #3271): a CHEAPER tier ($4/$20) than Opus 5 — a DISTINCT exact
    // key, because longest-prefix resolution would otherwise price "claude-opus-5-5"
    // under "claude-opus-5" ($5/$25, 25% too high). Cache-read uses a NON-standard
    // 0.05x multiplier -> $0.20 (NOT the usual 0.1x -> $0.40); standard/base rate only
    // (its fast-mode $8/$40 is a separate modifier the schema does not model).
    // Verified against platform.claude.com/docs/about-claude/pricing (live, 2026-09-23).
    "claude-opus-5-5": {
      inputPerMTok: 4,
      cacheReadPerMTok: 0.2,
      cacheWrite5mPerMTok: 5,
      cacheWrite1hPerMTok: 8,
      outputPerMTok: 20,
    },
    "claude-opus-5": {
      inputPerMTok: 5,
      cacheReadPerMTok: 0.5,
      cacheWrite5mPerMTok: 6.25,
      cacheWrite1hPerMTok: 10,
      outputPerMTok: 25,
    },
    "claude-opus-4-8": {
      inputPerMTok: 5,
      cacheReadPerMTok: 0.5,
      cacheWrite5mPerMTok: 6.25,
      cacheWrite1hPerMTok: 10,
      outputPerMTok: 25,
    },
    "claude-sonnet-5": {
      inputPerMTok: 2,
      cacheReadPerMTok: 0.2,
      cacheWrite5mPerMTok: 2.5,
      cacheWrite1hPerMTok: 4,
      outputPerMTok: 10,
    },
    "claude-fable-5-1": {
      inputPerMTok: 10,
      cacheReadPerMTok: 0.25,
      cacheWrite5mPerMTok: 12.5,
      cacheWrite1hPerMTok: 20,
      outputPerMTok: 50,
    },
    "claude-fable-5": {
      inputPerMTok: 10,
      cacheReadPerMTok: 1,
      cacheWrite5mPerMTok: 12.5,
      cacheWrite1hPerMTok: 20,
      outputPerMTok: 50,
    },
    "claude-opus-4-7": {
      inputPerMTok: 5,
      cacheReadPerMTok: 0.5,
      cacheWrite5mPerMTok: 6.25,
      cacheWrite1hPerMTok: 10,
      outputPerMTok: 25,
    },
    "claude-opus-4-6": {
      inputPerMTok: 5,
      cacheReadPerMTok: 0.5,
      cacheWrite5mPerMTok: 6.25,
      cacheWrite1hPerMTok: 10,
      outputPerMTok: 25,
    },
    "claude-opus-4-5": {
      inputPerMTok: 5,
      cacheReadPerMTok: 0.5,
      cacheWrite5mPerMTok: 6.25,
      cacheWrite1hPerMTok: 10,
      outputPerMTok: 25,
    },
    "claude-opus-4-1": {
      inputPerMTok: 15,
      cacheReadPerMTok: 1.5,
      cacheWrite5mPerMTok: 18.75,
      cacheWrite1hPerMTok: 30,
      outputPerMTok: 75,
    },
    "claude-sonnet-4-6": {
      inputPerMTok: 3,
      cacheReadPerMTok: 0.3,
      cacheWrite5mPerMTok: 3.75,
      cacheWrite1hPerMTok: 6,
      outputPerMTok: 15,
    },
    "claude-sonnet-4-5": {
      inputPerMTok: 3,
      cacheReadPerMTok: 0.3,
      cacheWrite5mPerMTok: 3.75,
      cacheWrite1hPerMTok: 6,
      outputPerMTok: 15,
    },
    "claude-haiku-4-5": {
      inputPerMTok: 1,
      cacheReadPerMTok: 0.1,
      cacheWrite5mPerMTok: 1.25,
      cacheWrite1hPerMTok: 2,
      outputPerMTok: 5,
    },
  },
  // Google Gemini — source: ai.google.dev/gemini-api/docs/pricing (snapshot
  // 2026-09-21). Pro tiers are the base (≤200k) rate. `cacheReadPerMTok` = the
  // context-cache read rate; Gemini has NO per-token cache-write fee (storage-
  // per-hour), so the cache-write fields are omitted (3353-2). Gemini 2.5 tiers
  // deprecate Oct 2026 (#3348) but are still live at snapshot time.
  google: {
    "gemini-3.1-pro-preview": {
      inputPerMTok: 2.0,
      cacheReadPerMTok: 0.2,
      outputPerMTok: 12.0,
    },
    "gemini-3.5-flash": {
      inputPerMTok: 1.5,
      cacheReadPerMTok: 0.15,
      outputPerMTok: 9.0,
    },
    "gemini-2.5-pro": {
      inputPerMTok: 1.25,
      cacheReadPerMTok: 0.125,
      outputPerMTok: 10.0,
    },
    "gemini-2.5-flash": {
      inputPerMTok: 0.3,
      cacheReadPerMTok: 0.03,
      outputPerMTok: 2.5,
    },
    "gemini-2.5-flash-lite": {
      inputPerMTok: 0.1,
      cacheReadPerMTok: 0.01,
      outputPerMTok: 0.4,
    },
  },
  // OpenAI (codex → provider "openai") — source:
  // developers.openai.com/api/docs/pricing (snapshot 2026-09-21).
  // `cacheReadPerMTok` = the discounted cached-input rate; OpenAI has no separate
  // per-token cache-write fee, so the cache-write fields are omitted (3353-2).
  openai: {
    "gpt-5.3-codex": {
      inputPerMTok: 1.75,
      cacheReadPerMTok: 0.175,
      outputPerMTok: 14.0,
    },
    "gpt-5.1": {
      inputPerMTok: 1.25,
      cacheReadPerMTok: 0.125,
      outputPerMTok: 10.0,
    },
    "gpt-5-mini": {
      inputPerMTok: 0.25,
      cacheReadPerMTok: 0.025,
      outputPerMTok: 2.0,
    },
    "gpt-5-nano": {
      inputPerMTok: 0.05,
      cacheReadPerMTok: 0.005,
      outputPerMTok: 0.4,
    },
    "gpt-5": {
      inputPerMTok: 1.25,
      cacheReadPerMTok: 0.125,
      outputPerMTok: 10.0,
    },
  },
  // openrouter: intentionally absent (see the SSOT doc above) — passthrough
  // margin is not determinable, so those turns resolve to null → "—".
};

/**
 * The default pricing provider, stamped on a turn whose `model_provider` is NULL
 * (legacy claude turns predate the #3352 provider write). Retained for
 * `computeTurnCost`'s NULL-provider default.
 */
export const PRICING_PROVIDER = "anthropic";

/**
 * Back-compat DERIVED alias: the anthropic sub-table in the pre-#3353 flat shape
 * (`Record<modelId, ModelPricing>`). Single-sourced from
 * `MODEL_PRICING_BY_PROVIDER.anthropic` — NO duplication. Existing web importers
 * (`web/src/lib/costEstimate.ts` re-export) and claude-only tests read this.
 */
export const MODEL_PRICING: Record<string, ModelPricing> =
  MODEL_PRICING_BY_PROVIDER.anthropic;

/**
 * The date the ANTHROPIC price table was verified, as a ms epoch. Used as the
 * `effective_from` anchor when seeding anthropic `rate_cards` (Sub E): a future
 * price change adds a NEW card with a later `effective_from`; old turns keep
 * their snapshot.
 */
export const PRICING_VERIFIED_AT_MS = Date.parse("2026-05-27T00:00:00Z");

/**
 * Per-provider price-snapshot date (ms epoch), used as each provider's seeded
 * rate-card `effective_from` (issue #3353). Anthropic stays anchored at its
 * original 2026-05-27 verification (no re-pricing of claude history); the
 * non-claude providers are anchored at their 2026-09-21 sourcing date. A provider
 * absent here falls back to `PRICING_VERIFIED_AT_MS`.
 */
export const PRICING_VERIFIED_AT_MS_BY_PROVIDER: Record<string, number> = {
  anthropic: PRICING_VERIFIED_AT_MS,
  google: Date.parse("2026-09-21T00:00:00Z"),
  openai: Date.parse("2026-09-21T00:00:00Z"),
};

/**
 * Resolve a `(model, provider?)` pair to its pricing entry using LONGEST-prefix
 * matching within a provider: an exact id wins, else the LONGEST table key that
 * the id starts with (so a dated/variant id like `claude-opus-4-7-20260101`
 * resolves to `claude-opus-4-7`, and `gpt-5.3-codex` resolves to `gpt-5.3-codex`
 * rather than the shorter `gpt-5`). Longest-prefix (not first-match) is required
 * now that a provider has keys where one is a prefix of another (`gpt-5` ⊂
 * `gpt-5.1`; `gemini-2.5-flash` ⊂ `gemini-2.5-flash-lite`). It is backward-
 * compatible for the non-colliding anthropic keys.
 *
 * When `provider` is given, only that provider's sub-table is searched (the
 * server path — the provider is the turn's `model_provider`). When omitted, ALL
 * providers are searched in declaration order (the web client-estimate fallback,
 * which has only a model id) — model ids are disjoint across providers except for
 * an OpenRouter passthrough, which is intentionally unseeded.
 */
function resolvePricingEntry(
  model: string | undefined,
  provider?: string
): { provider: string; modelKey: string; pricing: ModelPricing } | null {
  if (!model) return null;

  const searchProvider = (
    prov: string
  ): { provider: string; modelKey: string; pricing: ModelPricing } | null => {
    const sub = MODEL_PRICING_BY_PROVIDER[prov];
    if (!sub) return null;
    if (sub[model])
      return { provider: prov, modelKey: model, pricing: sub[model] };
    let bestKey: string | null = null;
    for (const key of Object.keys(sub)) {
      if (
        model.startsWith(key) &&
        (bestKey === null || key.length > bestKey.length)
      ) {
        bestKey = key;
      }
    }
    return bestKey
      ? { provider: prov, modelKey: bestKey, pricing: sub[bestKey] }
      : null;
  };

  if (provider !== undefined) return searchProvider(provider);
  for (const prov of Object.keys(MODEL_PRICING_BY_PROVIDER)) {
    const hit = searchProvider(prov);
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolve a model id to the matching pricing KEY (the base `model_id` a
 * `rate_cards` row is keyed by). Returns `null` for an unknown / empty /
 * undefined model. Provider-aware (see `resolvePricingEntry`); the optional
 * `provider` narrows the search to one provider's sub-table.
 */
export function resolveModelPricingKey(
  model: string | undefined,
  provider?: string
): string | null {
  return resolvePricingEntry(model, provider)?.modelKey ?? null;
}

/**
 * Resolve a model id to its `ModelPricing` (see `resolveModelPricingKey`).
 * Returns `null` for unknown models. Provider-aware; `provider` narrows the
 * search when known (the web client estimate calls it without a provider).
 */
export function resolveModelPricing(
  model: string | undefined,
  provider?: string
): ModelPricing | null {
  return resolvePricingEntry(model, provider)?.pricing ?? null;
}
