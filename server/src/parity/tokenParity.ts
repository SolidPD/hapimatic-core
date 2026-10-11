// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Token parity: DB totals vs server-recomputed client-equivalent
 * (issue #1669, epic #1662, Sub G).
 *
 * KD3: the browser token aggregate (`reduceChatBlocks`, `web/src/chat/reducer.ts:36`)
 * is computed in browser memory and NEVER persisted, so the harness recomputes the
 * SAME per-class aggregation SERVER-SIDE from stored `messages.usage` and diffs it
 * against the DB totals (`Σ turns.tok_*`). `messages.usage` survives scrubbing —
 * `scrubAnthropicTokens` (`shared/src/sentryScrub.ts:89`) redacts only `sk-ant-…`,
 * never usage counts.
 *
 * OR3 — structural gap, NARROWED by #2229: `turns.tok_*` rolls up SEPARATE
 * sub-agent transcript files (Sub C). Post-#2229 the client-equivalent folds
 * each session per-run through the SHARED rule in
 * `@hapi/protocol/tokenUsageAggregation` (`message.id` dedup; a result event
 * closes its run sourcing `modelUsage`, which is sub-agent-INCLUSIVE —
 * probe-verified equal to main+subagent transcript deduped sums). So for
 * SDK-launcher sessions with result rows the sub-agent surplus largely
 * disappears; the residual OR3 bias remains for tmux/pty sessions and
 * result-less trailing runs (per-message data excludes sub-agent files). The
 * KD3 "mirrors the browser exactly" contract is now enforced structurally:
 * both this recompute and `web/src/chat/reducer.ts` consume the same shared
 * fold (+ cross-package contract fixtures).
 *
 * Class mapping (matches Sub C's locked token semantics):
 *   tokIn  ↔ tok_in  ↔ usage.input_tokens
 *   tokOut ↔ tok_out ↔ usage.output_tokens
 *   tokCacheRead  ↔ tok_cache_read  ↔ usage.cache_read_input_tokens
 *   tokCacheWrite ↔ tok_cache_write ↔ usage.cache_creation_input_tokens
 *
 * Shadow mode (R7): read-only — only SELECTs from `turns`, `messages`, `sessions`.
 */

import { unwrapRoleWrappedRecordEnvelope } from "@hapi/protocol/messages";
import {
  foldSessionTokenUsage,
  type TokenUsageRow,
} from "@hapi/protocol/tokenUsageAggregation";
import type { Database } from "bun:sqlite";

export type TokenClass = "tokIn" | "tokOut" | "tokCacheRead" | "tokCacheWrite";

export const TOKEN_CLASSES: readonly TokenClass[] = [
  "tokIn",
  "tokOut",
  "tokCacheRead",
  "tokCacheWrite",
] as const;

export type TokenTotals = Record<TokenClass, number>;

function zeroTotals(): TokenTotals {
  return { tokIn: 0, tokOut: 0, tokCacheRead: 0, tokCacheWrite: 0 };
}

export interface TokenScopeOptions {
  namespaces?: string[];
  /** Inclusive epoch-ms lower bound (turns.started_at_ms / messages.created_at). */
  startMs?: number;
  /** Inclusive epoch-ms upper bound. */
  endMs?: number;
}

interface DbTokenRow {
  namespace: string;
  tok_in: number;
  tok_out: number;
  tok_cache_read: number;
  tok_cache_write: number;
}

/**
 * DB-side per-namespace token totals from finalized turns. NULL namespaces
 * coalesce to `""`. READ-ONLY.
 */
export function computeDbTokenTotals(
  db: Database,
  opts: TokenScopeOptions = {}
): Map<string, TokenTotals> {
  const clauses = ["status = 'completed'"];
  const params: (string | number)[] = [];
  if (opts.namespaces && opts.namespaces.length > 0) {
    const placeholders = opts.namespaces.map(() => "?").join(", ");
    clauses.push(`COALESCE(namespace, '') IN (${placeholders})`);
    params.push(...opts.namespaces);
  }
  if (typeof opts.startMs === "number") {
    clauses.push("started_at_ms >= ?");
    params.push(opts.startMs);
  }
  if (typeof opts.endMs === "number") {
    clauses.push("started_at_ms <= ?");
    params.push(opts.endMs);
  }

  const rows = db
    .prepare(
      `SELECT COALESCE(namespace, '') AS namespace,
              COALESCE(SUM(tok_in), 0)          AS tok_in,
              COALESCE(SUM(tok_out), 0)         AS tok_out,
              COALESCE(SUM(tok_cache_read), 0)  AS tok_cache_read,
              COALESCE(SUM(tok_cache_write), 0) AS tok_cache_write
       FROM turns
       WHERE ${clauses.join(" AND ")}
       GROUP BY COALESCE(namespace, '')`
    )
    .all(...params) as DbTokenRow[];

  const out = new Map<string, TokenTotals>();
  for (const row of rows) {
    out.set(row.namespace, {
      tokIn: row.tok_in,
      tokOut: row.tok_out,
      tokCacheRead: row.tok_cache_read,
      tokCacheWrite: row.tok_cache_write,
    });
  }
  return out;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extract a #2229 aggregation row from a stored `messages.content` JSON string.
 * Handles BOTH persisted shapes:
 *   - assistant rows — usage at `content.data.message.usage`, API message id at
 *     `content.data.message.id` (flat raw-transcript fallback: `message.usage` /
 *     `message.id`);
 *   - result rows — `content.data.type === "system" && subtype === "result"`
 *     with the turn-final `usage` / `modelUsage` forwarded by the CLI converter
 *     (pre-#2229 result rows lack both → nulls, and the fold treats them as
 *     no-ops rather than run-closers).
 * Defensive: malformed input yields an all-null row. READ-ONLY.
 */
export function extractTokenUsageRow(content: string): TokenUsageRow {
  const empty: TokenUsageRow = {
    apiMessageId: null,
    usage: null,
    resultUsage: null,
    resultModelUsage: null,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return empty;
  }
  if (!isRecord(parsed)) return empty;
  // Enveloped shape (production): the raw transcript body lives at
  // content.data. unwrapRoleWrappedRecordEnvelope returns null for the flat
  // raw-transcript shape, which then uses `parsed` itself as the body.
  const record = unwrapRoleWrappedRecordEnvelope(parsed);
  let data: Record<string, unknown> | null = null;
  if (record) {
    const inner = record.content;
    const d = isRecord(inner) ? inner.data : undefined;
    if (isRecord(d)) data = d;
  }
  if (data === null) data = parsed;
  // Result rows (#2229 R4): the run-closing usage source.
  if (data.type === "system" && data.subtype === "result") {
    return {
      apiMessageId: null,
      usage: null,
      resultUsage: isRecord(data.usage) ? data.usage : null,
      resultModelUsage: isRecord(data.modelUsage) ? data.modelUsage : null,
    };
  }
  const message = isRecord(data.message) ? data.message : null;
  if (message === null) return empty;
  return {
    apiMessageId:
      typeof message.id === "string" && message.id !== "" ? message.id : null,
    usage: isRecord(message.usage) ? message.usage : null,
    resultUsage: null,
    resultModelUsage: null,
  };
}

/**
 * Extract the four token-class counts from a stored `messages.content` JSON
 * string. Production writers persist the role-wrapped envelope
 * (`{role, content:{type,data:<raw transcript body>}, meta}`, CLI wrap at
 * `apiSession.ts:441-451`), so usage lives at `content.data.message.usage` —
 * this mirrors the browser's own extraction (`web/src/chat/normalize.ts:16` →
 * `normalizeAgent.ts` reads `data.message.usage`). Raw-transcript-shaped rows
 * carry the flat `message.usage` shape and are handled by a fallback path.
 * Defensive: returns zeros for any message without a well-formed usage object
 * (user messages, tool results, etc.).
 */
export function extractUsageFromContent(content: string): TokenTotals {
  // #2229: delegate the envelope descent to extractTokenUsageRow (one descent
  // path). This function keeps its historical semantics — PER-MESSAGE usage
  // only; result rows yield zeros here.
  const totals = zeroTotals();
  const u = extractTokenUsageRow(content).usage;
  if (!u) return totals;
  totals.tokIn = asCount(u.input_tokens);
  totals.tokOut = asCount(u.output_tokens);
  totals.tokCacheRead = asCount(u.cache_read_input_tokens);
  totals.tokCacheWrite = asCount(u.cache_creation_input_tokens);
  return totals;
}

interface MessageRow {
  namespace: string;
  session_id: string;
  content: string;
}

/**
 * Server-side recompute of the browser token aggregation, per namespace, from
 * stored `messages`. Joins `messages → sessions` (the
 * `estimateNamespaceTimeFromMessages` pattern), orders each session's rows
 * chronologically, and folds them through the SHARED #2229 per-run rule
 * (`@hapi/protocol/tokenUsageAggregation` — `message.id` dedup + result-event
 * run-close), the same module `web/src/chat/reducer.ts` uses for its displayed
 * totals. Per-session totals then sum into per-namespace totals. A namespace
 * containing only tmux/pty-shaped sessions (no result rows) reduces to the
 * deduped per-message sum. READ-ONLY.
 */
export function computeClientEquivalentTokenTotals(
  db: Database,
  opts: TokenScopeOptions = {}
): Map<string, TokenTotals> {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts.namespaces && opts.namespaces.length > 0) {
    const placeholders = opts.namespaces.map(() => "?").join(", ");
    clauses.push(`COALESCE(s.namespace, '') IN (${placeholders})`);
    params.push(...opts.namespaces);
  }
  if (typeof opts.startMs === "number") {
    clauses.push("m.created_at >= ?");
    params.push(opts.startMs);
  }
  if (typeof opts.endMs === "number") {
    clauses.push("m.created_at <= ?");
    params.push(opts.endMs);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  // ORDER BY is load-bearing (#2229): the per-run fold is sequential, so each
  // session's rows must arrive in insertion order (created_at, seq tiebreak).
  const rows = db
    .prepare(
      `SELECT COALESCE(s.namespace, '') AS namespace,
              m.session_id AS session_id,
              m.content AS content
       FROM messages m
       INNER JOIN sessions s ON s.id = m.session_id
       ${where}
       ORDER BY m.session_id, m.created_at, m.seq`
    )
    .all(...params) as MessageRow[];

  const out = new Map<string, TokenTotals>();
  let curSession: string | null = null;
  let curNamespace = "";
  let curRows: TokenUsageRow[] = [];
  const flush = (): void => {
    if (curSession === null || curRows.length === 0) {
      curRows = [];
      return;
    }
    const t = foldSessionTokenUsage(curRows);
    const acc = out.get(curNamespace) ?? zeroTotals();
    acc.tokIn += t.tokIn;
    acc.tokOut += t.tokOut;
    acc.tokCacheRead += t.tokCacheRead;
    acc.tokCacheWrite += t.tokCacheWrite;
    out.set(curNamespace, acc);
    curRows = [];
  };
  for (const row of rows) {
    if (row.session_id !== curSession) {
      flush();
      curSession = row.session_id;
      curNamespace = row.namespace;
    }
    curRows.push(extractTokenUsageRow(row.content));
  }
  flush();
  return out;
}

/**
 * Signed percentage delta of `newVal` relative to `baseVal`.
 * `(new - base) / base * 100`. Edge cases return JSON-safe finite numbers:
 *   - both 0 → 0 (a clean match)
 *   - base 0, new > 0 → a large sentinel (clearly beyond any tolerance → red)
 */
export function computeDeltaPct(newVal: number, baseVal: number): number {
  if (baseVal === 0) return newVal === 0 ? 0 : 1_000_000;
  return ((newVal - baseVal) / baseVal) * 100;
}

export interface TokenParityNamespaceResult {
  namespace: string;
  dbTotals: TokenTotals;
  clientTotals: TokenTotals;
  /** Per-class signed delta% of DB (new) vs client-equivalent (baseline). */
  deltas: Record<TokenClass, number>;
}

/**
 * Compute per-namespace token parity: DB totals vs client-equivalent, with a
 * signed delta% per token class. The set of namespaces is the union of both
 * sides so a namespace present on only one side still surfaces (as a large delta).
 */
export function computeTokenParity(
  db: Database,
  opts: TokenScopeOptions = {}
): TokenParityNamespaceResult[] {
  const dbTotalsByNs = computeDbTokenTotals(db, opts);
  const clientTotalsByNs = computeClientEquivalentTokenTotals(db, opts);

  const namespaces = new Set<string>([
    ...dbTotalsByNs.keys(),
    ...clientTotalsByNs.keys(),
  ]);

  const results: TokenParityNamespaceResult[] = [];
  for (const namespace of namespaces) {
    const dbTotals = dbTotalsByNs.get(namespace) ?? zeroTotals();
    const clientTotals = clientTotalsByNs.get(namespace) ?? zeroTotals();
    const deltas = {} as Record<TokenClass, number>;
    for (const cls of TOKEN_CLASSES) {
      deltas[cls] = computeDeltaPct(dbTotals[cls], clientTotals[cls]);
    }
    results.push({ namespace, dbTotals, clientTotals, deltas });
  }
  return results;
}
