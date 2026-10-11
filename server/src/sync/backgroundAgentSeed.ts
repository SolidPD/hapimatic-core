// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { computeTurnCost } from "../store/turns/cost";
import type { BackgroundAgentUsageStore } from "../store/turns/backgroundAgentUsage";
import type { TurnBillingBinding, TurnEventInput } from "../store/turns/types";
import { isValidAgentId } from "./agentId";
import { summarizeAgentTranscript } from "./transcript/transcriptParser";
import type { FinalizeStep } from "./turnLifecycle";

/**
 * Issue #4385 fix round 1: the fallback that keeps a background agent from being
 * counted nowhere.
 *
 * The finalize rollup excludes a background agent from its spawning turn and the
 * hub records it when a keepAlive shows it finishing. When that never happens —
 * an old CLI that sends no `backgroundAgents` snapshot, a session that ends while
 * the agent runs, a completion the tracker clears before any tick reports it, or
 * a #1668 backfill — this seed writes the row from the agent file as it is at
 * finalize, which is exactly what the pre-#4385 rollup counted. Every write is a
 * full-file REPLACE keyed on `(session, agent)`, so a later completion write
 * overwrites the partial and the agent is still counted once.
 */

/** A background launch the parse left out of its turn's rollup. */
export interface ExcludedBackgroundAgent {
  agentId: string;
  toolUseId: string | null;
  agentType: string | null;
  tsMs: number;
}

/** The excluded background launches in a parse's `subagent` events. */
export function excludedBackgroundAgents(
  events: readonly TurnEventInput[] | undefined
): ExcludedBackgroundAgent[] {
  const out: ExcludedBackgroundAgent[] = [];
  for (const e of events ?? []) {
    if (e.kind !== "subagent" || e.payload?.background !== true) continue;
    const agentId = e.payload.agentId;
    if (!isValidAgentId(agentId)) continue;
    const toolUseId = e.payload.toolUseId;
    out.push({
      agentId,
      toolUseId: typeof toolUseId === "string" ? toolUseId : null,
      agentType: e.name ?? null,
      tsMs: e.tsMs,
    });
  }
  return out;
}

/** An agent file's usage, priced with the agent's own model. */
export interface AgentFileUsage {
  tokIn: number;
  tokOut: number;
  tokCacheRead: number;
  tokCacheWrite: number;
  costTotal: number | null;
  startedAtMs: number | null;
}

/**
 * Sum `agent-<id>.jsonl` and price it at the agent's first assistant timestamp.
 * Returns null when the file is missing or the read failed, so a caller never
 * REPLACES a stored row with the zeros of a failed read.
 */
export function readAgentFileUsage(
  db: Database,
  subagentsDir: string,
  agentId: string,
  fallbackStartMs: number | null
): AgentFileUsage | null {
  const usage = summarizeAgentTranscript(
    join(subagentsDir, `agent-${agentId}.jsonl`)
  );
  if (!usage.exists || !usage.readable) return null;
  const startedAtMs = usage.firstAssistantTsMs ?? fallbackStartMs;
  const costs =
    usage.modelId !== null
      ? computeTurnCost(db, {
          modelId: usage.modelId,
          startedAtMs: startedAtMs ?? Date.now(),
          tokIn: usage.in,
          tokOut: usage.out,
          tokCacheRead: usage.cacheRead,
          tokCacheWrite: usage.cacheWrite,
        })
      : null;
  return {
    tokIn: usage.in,
    tokOut: usage.out,
    tokCacheRead: usage.cacheRead,
    tokCacheWrite: usage.cacheWrite,
    costTotal: costs?.costTotal ?? null,
    startedAtMs,
  };
}

/** No recorded binding (a legacy row, or no ledger row to read). */
export const NO_TURN_BINDING: TurnBillingBinding = {
  authBindingKind: null,
  apiKeyId: null,
};

/**
 * Issue #4824: the billing binding recorded on a turn's ledger row, or
 * {@link NO_TURN_BINDING} when there is no such row. Background-agent rows take
 * their binding from HERE — the turn that launched the agent — never from the
 * live session record, which a switch (#4823) has already updated by the time a
 * deferred end-write runs. `SELECT *` so a database whose fail-open ALTER did not
 * run yet reads as no binding rather than throwing.
 */
export function readTurnBinding(
  db: Database,
  hapiSessionId: string,
  seq: number
): TurnBillingBinding {
  const row = db
    .prepare("SELECT * FROM turns WHERE hapi_session_id = ? AND seq = ?")
    .get(hapiSessionId, seq) as Record<string, unknown> | null;
  if (!row) return NO_TURN_BINDING;
  return {
    authBindingKind: (row.auth_binding_kind as string | null) ?? null,
    apiKeyId: (row.api_key_id as string | null) ?? null,
  };
}

export interface SeedBackgroundAgentsInput {
  db: Database;
  store: BackgroundAgentUsageStore;
  hapiSessionId: string;
  namespace: string | null;
  nodeId: string;
  subagentsDir: string;
  agents: readonly ExcludedBackgroundAgent[];
  /** Issue #4824: the binding of the turn that launched `agents`, read from the
   *  turn ledger ({@link readTurnBinding}). Kept on the row through every later
   *  recompute, so a switch never re-attributes the agent. */
  binding: TurnBillingBinding;
  /** Called for an agent whose file is missing or unreadable (nothing written). */
  onMissing?: (agentId: string) => void;
  /** Called when writing one agent throws; the rest of the batch still runs. */
  onError?: (agentId: string, error: unknown) => void;
}

/**
 * Write a `running` row from the current file for each agent that has no
 * completion row. An agent with no row gets one; a `running` row (an earlier
 * seed, or a session end / expiry write) is refreshed, so a #1668 backfill brings
 * a stale partial up to the full file. A `done` / `error` row (the completion
 * write) is left alone. Each agent is isolated: one that throws is reported
 * through `onError` and the rest are still written. Returns the rows written.
 */
export function seedExcludedBackgroundAgents(
  input: SeedBackgroundAgentsInput
): number {
  let written = 0;
  for (const agent of input.agents) {
    try {
      if (seedOne(input, agent)) written += 1;
    } catch (error) {
      input.onError?.(agent.agentId, error);
    }
  }
  return written;
}

function seedOne(
  input: SeedBackgroundAgentsInput,
  agent: ExcludedBackgroundAgent
): boolean {
  // A `running` row is a partial (a seed, or a session end / expiry write) and
  // is refreshed from the file, which only grows. A `done` / `error` row is the
  // completion write and is never touched.
  const status = input.store.statusOf(input.hapiSessionId, agent.agentId);
  if (status !== null && status !== "running") return false;
  const usage = readAgentFileUsage(
    input.db,
    input.subagentsDir,
    agent.agentId,
    agent.tsMs
  );
  if (!usage) {
    input.onMissing?.(agent.agentId);
    return false;
  }
  input.store.upsert({
    hapiSessionId: input.hapiSessionId,
    agentId: agent.agentId,
    toolUseId: agent.toolUseId,
    agentType: agent.agentType,
    // The description comes from the scrubbed cache entry at completion
    // (T11); the seed never writes the raw meta text.
    description: null,
    ...usage,
    endedAtMs: null,
    status: "running",
    nodeId: input.nodeId,
    namespace: input.namespace,
    authBindingKind: input.binding.authBindingKind,
    apiKeyId: input.binding.apiKeyId,
  });
  return true;
}

/**
 * The finalize seam step: hands the parse's excluded background launches to
 * `seed` with the transcript the parse read, plus the finalizing turn's `seq`
 * (#4824: the turn that launched them, whose recorded binding the rows take).
 * Contributes no enrichment.
 */
export function createBackgroundAgentSeedStep(
  seed: (
    hapiSessionId: string,
    transcriptPath: string | undefined,
    ccSessionId: string | undefined,
    agents: ExcludedBackgroundAgent[],
    seq: number
  ) => void
): FinalizeStep {
  return (ctx, accumulated) => {
    const agents = excludedBackgroundAgents(accumulated?.events);
    if (agents.length === 0) return {};
    seed(
      ctx.hapiSessionId,
      accumulated?.transcriptPath ?? ctx.event.transcriptPath,
      ctx.event.ccSessionId,
      agents,
      ctx.seq
    );
    return {};
  };
}
