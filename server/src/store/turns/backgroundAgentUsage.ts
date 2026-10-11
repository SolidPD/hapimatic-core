// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import type {
  BackgroundAgentUsage,
  BackgroundAgentUsageEntry,
} from "@hapi/protocol/schemas";

import { BINDING_COLUMNS, tableHasColumns } from "./schema";
import type { TurnBillingBinding } from "./types";

/** One background agent's full-file usage, as written at completion (#4385).
 *  #4824: `authBindingKind` / `apiKeyId` are REQUIRED (nullable) so a writer
 *  that forgets to thread the launching turn's binding fails typecheck instead
 *  of silently recording NULL. */
export interface BackgroundAgentUsageUpsert extends TurnBillingBinding {
  hapiSessionId: string;
  agentId: string;
  toolUseId: string | null;
  agentType: string | null;
  description: string | null;
  tokIn: number;
  tokOut: number;
  tokCacheRead: number;
  tokCacheWrite: number;
  costTotal: number | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  status: string;
  nodeId: string;
  namespace: string | null;
}

/**
 * Raw synchronous CRUD for the `background_agent_usage` table (issue #4385,
 * epic #4382 Sub C).
 *
 * One row per background agent a session launched, holding the agent file's
 * FULL usage. Written on the owning node each time an agent completes (or
 * re-notifies after a resume) — a full-file recompute that REPLACES the row, so
 * the write is idempotent and a resumed agent is never counted twice.
 *
 * Like `PmRosterStore`: methods are SYNCHRONOUS and MAY THROW; the recorder
 * (`syncEngine`) wraps every call fail-open off the socket handler. Low volume
 * (one write per background-agent completion) and off the prompt/reply path, so
 * no write queue. Named-`@field` statements under bun:sqlite `{ strict: true }`.
 */
export class BackgroundAgentUsageStore {
  constructor(private readonly db: Database) {}

  /** Issue #4824: latched once the binding columns are seen (see `TurnStore`). */
  private bindingColumnsPresent = false;

  private hasBindingColumns(): boolean {
    if (!this.bindingColumnsPresent) {
      this.bindingColumnsPresent = tableHasColumns(
        this.db,
        "background_agent_usage",
        BINDING_COLUMNS
      );
    }
    return this.bindingColumnsPresent;
  }

  /** The status of the session's row for this agent, or null when it has
   *  none (#4385 seed: a `running` row is a partial the seed may refresh). */
  statusOf(hapiSessionId: string, agentId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT status FROM background_agent_usage
          WHERE hapi_session_id = @hapi_session_id AND agent_id = @agent_id`
      )
      .get({ hapi_session_id: hapiSessionId, agent_id: agentId }) as {
      status: string;
    } | null;
    return row?.status ?? null;
  }

  /**
   * Insert or REPLACE the agent's row (full-file recompute).
   *
   * #4824: the binding is the one the agent was FIRST recorded under and is
   * kept through every later recompute. The pair is kept or replaced together
   * (a per-column COALESCE could pair a `subscription-account` kind with a key
   * id from a later write).
   */
  upsert(row: BackgroundAgentUsageUpsert): void {
    const binding = this.hasBindingColumns();
    this.db
      .prepare(
        `INSERT INTO background_agent_usage (
           hapi_session_id, agent_id, tool_use_id, agent_type, description,
           tok_in, tok_out, tok_cache_read, tok_cache_write, cost_total,
           started_at_ms, ended_at_ms, status, node_id, namespace${binding ? ", auth_binding_kind, api_key_id" : ""}
         ) VALUES (
           @hapi_session_id, @agent_id, @tool_use_id, @agent_type, @description,
           @tok_in, @tok_out, @tok_cache_read, @tok_cache_write, @cost_total,
           @started_at_ms, @ended_at_ms, @status, @node_id, @namespace${binding ? ", @auth_binding_kind, @api_key_id" : ""}
         )
         ON CONFLICT(hapi_session_id, agent_id) DO UPDATE SET${
           binding
             ? `
           api_key_id      = CASE WHEN auth_binding_kind IS NULL
                                  THEN excluded.api_key_id ELSE api_key_id END,
           auth_binding_kind = COALESCE(auth_binding_kind, excluded.auth_binding_kind),`
             : ""
         }
           tool_use_id     = COALESCE(excluded.tool_use_id, tool_use_id),
           agent_type      = COALESCE(excluded.agent_type, agent_type),
           description     = COALESCE(excluded.description, description),
           tok_in          = excluded.tok_in,
           tok_out         = excluded.tok_out,
           tok_cache_read  = excluded.tok_cache_read,
           tok_cache_write = excluded.tok_cache_write,
           cost_total      = excluded.cost_total,
           started_at_ms   = COALESCE(excluded.started_at_ms, started_at_ms),
           ended_at_ms     = excluded.ended_at_ms,
           status          = excluded.status,
           node_id         = excluded.node_id,
           namespace       = COALESCE(excluded.namespace, namespace)`
      )
      .run({
        ...(binding
          ? {
              auth_binding_kind: row.authBindingKind,
              api_key_id: row.apiKeyId,
            }
          : {}),
        hapi_session_id: row.hapiSessionId,
        agent_id: row.agentId,
        tool_use_id: row.toolUseId,
        agent_type: row.agentType,
        description: row.description,
        tok_in: row.tokIn,
        tok_out: row.tokOut,
        tok_cache_read: row.tokCacheRead,
        tok_cache_write: row.tokCacheWrite,
        cost_total: row.costTotal,
        started_at_ms: row.startedAtMs,
        ended_at_ms: row.endedAtMs,
        status: row.status,
        node_id: row.nodeId,
        namespace: row.namespace,
      });
  }

  /** The session's stored agents, oldest start first. */
  listForSession(hapiSessionId: string): BackgroundAgentUsageEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM background_agent_usage
         WHERE hapi_session_id = @hapi_session_id
         ORDER BY COALESCE(started_at_ms, ended_at_ms), agent_id`
      )
      .all({ hapi_session_id: hapiSessionId }) as Array<
      Record<string, unknown>
    >;
    return rows.map(rowToEntry);
  }

  /**
   * The token-stats breakout for one session (Task 4): count, per-class sums and
   * the per-agent rows — all from this table, the same rows `v_session_totals`
   * folds into the totals. Null when the session has no stored agent.
   */
  getSessionBreakdown(hapiSessionId: string): BackgroundAgentUsage | null {
    const agents = this.listForSession(hapiSessionId);
    if (agents.length === 0) return null;
    let costTotal: number | null = null;
    const sums = { tokIn: 0, tokOut: 0, tokCacheRead: 0, tokCacheWrite: 0 };
    for (const a of agents) {
      sums.tokIn += a.tokIn;
      sums.tokOut += a.tokOut;
      sums.tokCacheRead += a.tokCacheRead;
      sums.tokCacheWrite += a.tokCacheWrite;
      if (a.costTotal !== null) costTotal = (costTotal ?? 0) + a.costTotal;
    }
    return { count: agents.length, ...sums, costTotal, agents };
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function rowToEntry(r: Record<string, unknown>): BackgroundAgentUsageEntry {
  return {
    agentId: String(r.agent_id),
    agentType: strOrNull(r.agent_type),
    description: strOrNull(r.description),
    status: String(r.status),
    tokIn: numOrNull(r.tok_in) ?? 0,
    tokOut: numOrNull(r.tok_out) ?? 0,
    tokCacheRead: numOrNull(r.tok_cache_read) ?? 0,
    tokCacheWrite: numOrNull(r.tok_cache_write) ?? 0,
    costTotal: numOrNull(r.cost_total),
    startedAtMs: numOrNull(r.started_at_ms),
    endedAtMs: numOrNull(r.ended_at_ms),
  };
}
