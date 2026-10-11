// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-session token-usage aggregation — the SINGLE client-side counting rule
 * (issue #2229; consumed by BOTH `web/src/chat/reducer.ts` and
 * `server/src/parity/tokenParity.ts` so the parity baseline provably mirrors
 * the browser).
 *
 * Why this exists (#2229 verified mechanism, condensed):
 *   - One Anthropic API message is stored as ~1.5 `messages` rows (one per
 *     content block), each repeating the SAME usage object → naive per-row
 *     summing over-counts input/cache (Defect 2).
 *   - SDK-launcher rows carry message_start placeholder `output_tokens`
 *     (prod p50=2) — the real output count exists ONLY on the turn-final
 *     `result` event (Defect 1). tmux/pty rows are transcript-fed and carry
 *     real output with NO result rows.
 *   - A result event's `modelUsage` (per-model map, camelCase keys) is
 *     sub-agent-INCLUSIVE (probe-verified equal to main+subagent transcript
 *     deduped sums — the same scope as `turns.tok_*`); its `usage` covers the
 *     main chain only.
 *
 * The rule (per-RUN fold over a session's chronologically-ordered rows):
 *   1. Per-message usage accumulates into a pending run bucket, deduped by
 *      API `message.id` taking the per-class MAX per id (empirically
 *      max = first = last today — max is robust if a future Claude Code writes
 *      progressively-accumulating per-block usage). Rows with no id count
 *      per-row (defensive — never drop an uncorrelatable row).
 *   2. A row carrying result usage CLOSES the run: the run's totals come from
 *      `modelUsage` (summed across models) when usable, else `usage`; the
 *      pending per-message accumulation for that run is DISCARDED (it was the
 *      placeholder view of the same work).
 *   3. A trailing run with no result row (interrupted turn, tmux/pty session,
 *      pre-#2229 history) contributes its deduped per-message accumulation
 *      (input/cache real; output best-available).
 *
 * Pure, dependency-free, and defensive: malformed values coerce to 0, and a
 * result row with no usable usage payload is a no-op (it does NOT close the
 * run) — pre-#2229 stored result rows carry no usage and must not zero a run.
 */

/** The four billable token classes (matches the parity harness vocabulary). */
export interface TokenClassTotals {
  tokIn: number;
  tokOut: number;
  tokCacheRead: number;
  tokCacheWrite: number;
}

export function zeroTokenClassTotals(): TokenClassTotals {
  return { tokIn: 0, tokOut: 0, tokCacheRead: 0, tokCacheWrite: 0 };
}

/**
 * One session row, in chronological order. Callers map their own shapes
 * (stored `messages.content` JSON server-side; `NormalizedMessage` web-side):
 *   - `apiMessageId` — Anthropic `message.id` (`msg_…`) when known.
 *   - `usage` — per-message usage object (snake_case Anthropic fields).
 *   - `resultUsage` — a turn-final result event's `usage` (snake_case).
 *   - `resultModelUsage` — a result event's `modelUsage` per-model map
 *     (camelCase fields: `inputTokens`/`outputTokens`/`cacheReadInputTokens`/
 *     `cacheCreationInputTokens`).
 */
export interface TokenUsageRow {
  apiMessageId?: string | null;
  usage?: Record<string, unknown> | null;
  resultUsage?: Record<string, unknown> | null;
  resultModelUsage?: Record<string, unknown> | null;
}

/**
 * Own numeric coercion (deliberately NOT reusing the three subtly-different
 * helpers elsewhere in the tree): finite positive numbers pass, everything
 * else is 0. Token counts are never legitimately negative.
 */
function asTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Extract the four classes from a snake_case Anthropic usage object. */
function totalsFromUsage(usage: Record<string, unknown>): TokenClassTotals {
  return {
    tokIn: asTokenCount(usage.input_tokens),
    tokOut: asTokenCount(usage.output_tokens),
    tokCacheRead: asTokenCount(usage.cache_read_input_tokens),
    tokCacheWrite: asTokenCount(usage.cache_creation_input_tokens),
  };
}

/**
 * Sum a result event's per-model `modelUsage` map (camelCase fields) across
 * models. Returns null when NOTHING contributes — an unusable map must NOT
 * close a run: all-zero totals (e.g. `{model: {}}`, or a future entry carrying
 * only `costUSD`) fall through to the `usage` fallback instead of discarding
 * the pending per-message accumulation with zeros.
 */
function totalsFromModelUsage(
  modelUsage: Record<string, unknown>
): TokenClassTotals | null {
  const totals = zeroTokenClassTotals();
  for (const value of Object.values(modelUsage)) {
    if (!isObject(value)) continue;
    totals.tokIn += asTokenCount(value.inputTokens);
    totals.tokOut += asTokenCount(value.outputTokens);
    totals.tokCacheRead += asTokenCount(value.cacheReadInputTokens);
    totals.tokCacheWrite += asTokenCount(value.cacheCreationInputTokens);
  }
  const contributes =
    totals.tokIn + totals.tokOut + totals.tokCacheRead + totals.tokCacheWrite >
    0;
  return contributes ? totals : null;
}

function addInto(target: TokenClassTotals, source: TokenClassTotals): void {
  target.tokIn += source.tokIn;
  target.tokOut += source.tokOut;
  target.tokCacheRead += source.tokCacheRead;
  target.tokCacheWrite += source.tokCacheWrite;
}

function maxInto(target: TokenClassTotals, source: TokenClassTotals): void {
  target.tokIn = Math.max(target.tokIn, source.tokIn);
  target.tokOut = Math.max(target.tokOut, source.tokOut);
  target.tokCacheRead = Math.max(target.tokCacheRead, source.tokCacheRead);
  target.tokCacheWrite = Math.max(target.tokCacheWrite, source.tokCacheWrite);
}

/**
 * Fold ONE session's chronologically-ordered rows into its four token-class
 * totals under the #2229 per-run rule (see module header). Pure; never throws.
 */
export function foldSessionTokenUsage(
  rows: readonly TokenUsageRow[]
): TokenClassTotals {
  const grand = zeroTokenClassTotals();
  // Pending run state: per-id maxes + unconditional no-id accumulation.
  let pendingById = new Map<string, TokenClassTotals>();
  let pendingNoId = zeroTokenClassTotals();

  const flushPending = (): void => {
    for (const totals of pendingById.values()) addInto(grand, totals);
    addInto(grand, pendingNoId);
    pendingById = new Map();
    pendingNoId = zeroTokenClassTotals();
  };

  for (const row of rows) {
    // Run-close check first: a usable result payload replaces the pending run.
    const modelTotals = isObject(row.resultModelUsage)
      ? totalsFromModelUsage(row.resultModelUsage)
      : null;
    const resultTotals =
      modelTotals ??
      (isObject(row.resultUsage) ? totalsFromUsage(row.resultUsage) : null);
    if (resultTotals !== null) {
      // Discard the run's per-message accumulation — the result event is the
      // authoritative (and output-complete) count for the same work.
      pendingById = new Map();
      pendingNoId = zeroTokenClassTotals();
      addInto(grand, resultTotals);
      continue;
    }

    if (!isObject(row.usage)) continue;
    const totals = totalsFromUsage(row.usage);
    const id =
      typeof row.apiMessageId === "string" && row.apiMessageId !== ""
        ? row.apiMessageId
        : null;
    if (id === null) {
      addInto(pendingNoId, totals);
    } else {
      const existing = pendingById.get(id);
      if (existing) {
        maxInto(existing, totals);
      } else {
        pendingById.set(id, totals);
      }
    }
  }

  // Trailing run without a result row (interrupted / tmux / historical).
  flushPending();
  return grand;
}
