// SPDX-License-Identifier: AGPL-3.0-only
import { resolveModelPricingKey } from "@hapi/protocol/pricing";
import type { RateCardPrices } from "../store/turns/rateCards";
import type {
  RateCard,
  RateCardSource,
} from "../store/throughput/rateCardSource";

/**
 * Cache-TTL-aware API-equivalent pricing for throughput metrics (issue #6164,
 * A1 — R5, KD3).
 *
 * The ledger's `computeTurnCost` (`store/turns/cost.ts`) prices EVERY cache
 * write at the 5-minute rate, and the runaway ceiling guard depends on that, so
 * it stays as it is. Throughput metrics price in their own layer from the same
 * stored rate cards (`rate_cards.prices` already carries `cacheWrite1hPerMTok`):
 *
 * - 1-hour writes at the 1-hour rate (absent → the 5-minute rate, flagged);
 * - 5-minute writes and writes with no TTL split at the 5-minute rate;
 * - an unknown, NULL or `<synthetic>` model at the configured default model,
 *   flagged as fallback-priced (`<synthetic>` is never priced as a model);
 * - a turn older than every card for its model at the EARLIEST card, flagged.
 *
 * `fallback` is the USD part priced by any fallback, so the summary can show
 * the fallback-priced share beside every total. Results are memoized per
 * (provider, model, UTC day).
 */

export interface PriceTokens {
  in: number;
  out: number;
  cr: number;
  w1: number;
  w5: number;
  /** Cache writes with no TTL split. */
  wu: number;
}

export interface PricedLine {
  input: number;
  output: number;
  cacheRead: number;
  write1h: number;
  write5m: number;
  writeUnknown: number;
  total: number;
  /** The part of `total` priced by a fallback (model, card time or 1h rate). */
  fallback: number;
}

interface Resolved {
  prices: RateCardPrices | null;
  cardId: string | null;
  /** The whole line is fallback-priced (model or time). */
  fallbackLine: boolean;
}

export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_PRICING_MODEL = "claude-opus-5-5";
const SYNTHETIC_MODEL = "<synthetic>";
const DAY_MS = 86_400_000;

export function emptyPricedLine(): PricedLine {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    write1h: 0,
    write5m: 0,
    writeUnknown: 0,
    total: 0,
    fallback: 0,
  };
}

export function addPricedLine(into: PricedLine, add: PricedLine): void {
  into.input += add.input;
  into.output += add.output;
  into.cacheRead += add.cacheRead;
  into.write1h += add.write1h;
  into.write5m += add.write5m;
  into.writeUnknown += add.writeUnknown;
  into.total += add.total;
  into.fallback += add.fallback;
}

export class ThroughputPricer {
  private readonly memo = new Map<string, Resolved>();
  private readonly usedCards = new Set<string>();

  constructor(
    private readonly cards: RateCardSource,
    private readonly defaultModel: string = DEFAULT_PRICING_MODEL
  ) {}

  /** Price `t` for `model` at `atMs`. */
  price(
    model: string | null,
    atMs: number,
    t: PriceTokens,
    provider: string = DEFAULT_PROVIDER
  ): PricedLine {
    const r = this.resolve(provider, model, atMs);
    const out = emptyPricedLine();
    if (!r.prices) return out;
    const p = r.prices;
    const m = 1_000_000;
    const rate5m = p.cacheWrite5mPerMTok ?? 0;
    out.input = (t.in / m) * p.inPerMTok;
    out.output = (t.out / m) * p.outPerMTok;
    out.cacheRead = (t.cr / m) * (p.cacheReadPerMTok ?? 0);
    const rate1h = p.cacheWrite1hPerMTok ?? rate5m;
    out.write1h = (t.w1 / m) * rate1h;
    out.write5m = (t.w5 / m) * rate5m;
    out.writeUnknown = (t.wu / m) * rate5m;
    out.total =
      out.input +
      out.output +
      out.cacheRead +
      out.write1h +
      out.write5m +
      out.writeUnknown;
    if (r.fallbackLine) out.fallback = out.total;
    else if (p.cacheWrite1hPerMTok == null) out.fallback = out.write1h;
    return out;
  }

  /** The rate-card ids used so far (the digest records them). */
  cardIds(): string[] {
    return [...this.usedCards].sort();
  }

  private resolve(
    provider: string,
    model: string | null,
    atMs: number
  ): Resolved {
    const day = Math.floor(atMs / DAY_MS);
    const key = `${provider}\u0000${model ?? ""}\u0000${day}`;
    const hit = this.memo.get(key);
    if (hit) return hit;
    const resolved = this.lookup(provider, model, atMs);
    this.memo.set(key, resolved);
    if (resolved.cardId) this.usedCards.add(resolved.cardId);
    return resolved;
  }

  private lookup(
    provider: string,
    model: string | null,
    atMs: number
  ): Resolved {
    const real = model && model !== SYNTHETIC_MODEL ? model : null;
    if (real && resolveModelPricingKey(real, provider)) {
      const card =
        this.cards.active(provider, real, atMs) ??
        this.earliestCard(provider, real);
      if (card) {
        const early = card.effectiveFrom > atMs;
        return {
          prices: parsePrices(card.prices),
          cardId: card.id,
          fallbackLine: early,
        };
      }
    }
    const fallback =
      this.cards.active(DEFAULT_PROVIDER, this.defaultModel, atMs) ??
      this.earliestCard(DEFAULT_PROVIDER, this.defaultModel);
    return fallback
      ? {
          prices: parsePrices(fallback.prices),
          cardId: fallback.id,
          fallbackLine: true,
        }
      : { prices: null, cardId: null, fallbackLine: true };
  }

  private earliestCard(provider: string, model: string): RateCard | null {
    const key = resolveModelPricingKey(model, provider);
    return key ? this.cards.earliest(provider, key) : null;
  }
}

function parsePrices(raw: string): RateCardPrices | null {
  try {
    const p = JSON.parse(raw) as RateCardPrices;
    return typeof p.inPerMTok === "number" && typeof p.outPerMTok === "number"
      ? p
      : null;
  } catch {
    return null;
  }
}

/**
 * Issue #6169: what a kept-warm reopening saved, as an estimate: rewriting its
 * `warmCr` cache-read tokens at the 1-hour write rate, less reading them.
 */
export function avoidedRewriteUsd(
  pricer: ThroughputPricer,
  model: string | null,
  atMs: number,
  warmCr: number
): number {
  if (warmCr <= 0) return 0;
  const zero = { in: 0, out: 0, cr: 0, w1: 0, w5: 0, wu: 0 };
  return (
    pricer.price(model, atMs, { ...zero, w1: warmCr }).total -
    pricer.price(model, atMs, { ...zero, cr: warmCr }).total
  );
}

/**
 * Issue #6169: a keep-alive ledger's attempts by outcome, and what the `sent`
 * ones are estimated to have cost (each priced as its cache read, input and
 * output at `atMs`). Shared by the summary route and the report CLI.
 */
export function keepaliveLedgerCost(
  pricer: ThroughputPricer,
  rows: ReadonlyArray<{
    outcome: "sent" | "refused" | "failed";
    model: string | null;
    n: number;
    crTokens: number;
    inTokens: number;
    outTokens: number;
  }>,
  atMs: number
): {
  byOutcome: { sent: number; refused: number; failed: number };
  costUsd: number;
} {
  const byOutcome = { sent: 0, refused: 0, failed: 0 };
  let costUsd = 0;
  for (const r of rows) {
    byOutcome[r.outcome] += r.n;
    if (r.outcome !== "sent") continue;
    costUsd += pricer.price(r.model, atMs, {
      in: r.inTokens,
      out: r.outTokens,
      cr: r.crTokens,
      w1: 0,
      w5: 0,
      wu: 0,
    }).total;
  }
  return { byOutcome, costUsd };
}
