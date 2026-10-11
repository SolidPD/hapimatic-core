// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import {
  parseAllTurns,
  type TurnParseResult,
} from "../../sync/transcript/transcriptParser";
import { backfillCosts, type BackfillSummary } from "./backfill";
import { newUuidV7 } from "./ids";
import { resolveTranscriptPaths } from "../../sync/transcript/transcriptPath";
import {
  excludedBackgroundAgents,
  readTurnBinding,
  seedExcludedBackgroundAgents,
} from "../../sync/backgroundAgentSeed";
import { BackgroundAgentUsageStore } from "./backgroundAgentUsage";

/**
 * Backfill & repair core for the per-turn telemetry DB (issue #1668, epic #1662, Sub F).
 *
 * The disaster-recovery story: rebuild or repair `turns` + `turn_events` from on-disk
 * transcript JSONLs plus the daemon's `sessions` records, making the DB a rebuildable
 * index. Two modes:
 *
 *   - REPAIR (primary, low-risk — AC#2): rows EXIST. Re-derive ONLY the parser-derived
 *     column group + parser-emitted `turn_events`, leaving daemon-enriched, live-only,
 *     cost, and lifecycle columns byte-unchanged. NOT via `TurnStore.finalizeTurn`
 *     (its COALESCE only fills NULLs — repair must OVERWRITE a re-derived value).
 *
 *   - REBUILD (disaster recovery — AC#1): rows are DELETED / never existed. Reconstruct
 *     lifecycle invariants from transcript order, daemon-enriched columns from
 *     `sessions.metadata` (mirroring Sub D's `createOpenEnrichStep`), parser columns
 *     from `parseAllTurns`, then upsert by the operational key `(hapi_session_id, seq)`.
 *     Live-only columns (`permission_mode`, `git_sha_*`, `git_dirty`) and event-sourced
 *     columns (`launcher`, `cwd`) are NOT reconstructible post-hoc → NULL.
 *
 * Co-located with the single DB writer; the testable core is separated from the
 * `backfill-turns` CLI script (a thin path-resolution + DB-open wrapper).
 *
 * KEY DECISIONS:
 *   - K1: REPAIR force-overwrites the parser group (no COALESCE).
 *   - K2: F owns the upsert (`ON CONFLICT(hapi_session_id, seq)`); A's `TurnStore` is unchanged.
 *   - K4: REBUILD mirrors `createOpenEnrichStep`'s metadata mapping so enrichment can't drift.
 *   - K5/R11: F writes ONLY `turns`/`turn_events` — never `timelog_adjustments` (user data).
 *   - R8: cost columns are NOT recomputed by default; `--reprice` opt-in delegates to E's `backfillCosts`.
 */

/**
 * The parser-derived column group (Sub C). REPAIR force-overwrites exactly these and
 * nothing else; REBUILD fills them from the parse result.
 */
export const PARSER_COLUMNS = [
  "cc_session_id",
  "prompt_msg_uuid",
  "model_provider",
  "model_id",
  "tok_in",
  "tok_out",
  "tok_cache_read",
  "tok_cache_write",
  "tokens_extra",
  "context_used_tokens",
  "context_remaining_tokens",
  "capture_source",
  "transcript_path",
  "prompt_hash",
  "schema_version",
] as const;

/**
 * `turn_events.kind` values the parser emits. REPAIR deletes-and-reinserts ONLY these
 * kinds, leaving any non-parser events (e.g. future daemon-emitted kinds) intact.
 */
export const PARSER_EVENT_KINDS = [
  "skill",
  "mcp_call",
  "subagent",
  "compaction",
  "label_added",
  "label_removed",
  "error",
  "api_error",
  "model_switch",
] as const;

/** Resolve a session's account-config dir from its `metadata.accountUuid` (#1573). */
export type ConfigDirResolver = (
  accountUuid: string | null | undefined
) => string | undefined;

export interface BackfillTurnsOptions {
  /** Compute + count, write nothing. */
  dryRun?: boolean;
  /** Scope to a single hapi session. */
  sessionId?: string;
  /** Scope to turns started at or after this ms epoch. */
  sinceMs?: number;
  /** Scope to turns started at or before this ms epoch. */
  untilMs?: number;
  /** Opt-in cost re-derive (R8); delegates to E's `backfillCosts`. */
  reprice?: boolean;
}

export interface RepairSummary {
  /** Rows considered (matched the scope + had a resolvable transcript). */
  scanned: number;
  /** Rows whose parser columns + events were re-derived. */
  repaired: number;
  /** Rows skipped (no transcript_path, or no aligned parse segment). */
  skipped: number;
  /** Transcripts that produced zero segments / were missing or malformed. */
  unparseable: number;
  /** Cost backfill summary when `reprice` was requested. */
  reprice?: BackfillSummary;
}

export interface RebuildSummary {
  /** Sessions processed. */
  sessionsScanned: number;
  /** Turn rows upserted (inserted or replaced). */
  upserted: number;
  /** Transcripts that produced zero segments / were missing or malformed. */
  unparseable: number;
  /** Cost backfill summary when `reprice` was requested. */
  reprice?: BackfillSummary;
}

interface RepairRow {
  id: string;
  hapi_session_id: string;
  cc_session_id: string | null;
  seq: number;
  status: string;
  started_at_ms: number;
  transcript_path: string | null;
}

interface SessionRow {
  id: string;
  namespace: string | null;
  metadata: string | null;
  node_id: string | null;
  linked_issue: string | null;
}

interface SessionMetadata {
  accountUuid?: string;
  claudeAccount?: { rateLimitTier?: string };
  claudeSessionId?: string;
  originatingNodeId?: string;
  safeMode?: boolean;
  source?: string;
  name?: string;
  orchestrationId?: unknown;
  repoIdentity?: { name?: string };
  worktree?: { branch?: string } | null;
}

function safeParseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Map `metadata.source` → `session_mode` (mirrors Sub D `deriveSessionMode`). */
function deriveSessionMode(source: string | undefined): string {
  return source === "scheduler" || source === "heartbeat"
    ? "scheduled"
    : "standard";
}

function toBit(v: boolean | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return v ? 1 : 0;
}

/**
 * Daemon-enriched columns reconstructable from `sessions.metadata` (mirrors Sub D).
 *
 * #4824: the billing binding (`auth_binding_kind` / `api_key_id`) is the one
 * open-time column deliberately NOT reconstructed. Today's session record may
 * carry a binding the turn never ran under (a mid-session switch, #4823), so a
 * re-created row keeps NULL — unattributed, which never renders as real cost —
 * and an existing row's recorded binding is left untouched by the upsert.
 */
interface EnrichedColumns {
  node_id: string;
  namespace: string | null;
  account_id: string | null;
  plan_tier: string | null;
  safe_mode: number | null;
  session_mode: string;
  session_name: string | null;
  linked_issue: string | null;
  orchestration_id: string | null;
  repo: string | null;
  is_worktree: number | null;
  git_branch: string | null;
}

function reconstructEnrichedColumns(session: SessionRow): EnrichedColumns {
  const m = (safeParseJson(session.metadata) ?? {}) as SessionMetadata;
  const linked = safeParseJson(session.linked_issue) as {
    number?: number;
  } | null;
  const orchestration =
    typeof m.orchestrationId === "string" ? m.orchestrationId : null;
  return {
    // node_id is NOT NULL on `turns`; prefer the session column, fall back to the
    // metadata-stamped originating node, else a sentinel so the row still inserts.
    node_id: session.node_id ?? m.originatingNodeId ?? "unknown",
    namespace: session.namespace ?? null,
    account_id: m.accountUuid ?? null,
    plan_tier: m.claudeAccount?.rateLimitTier ?? null,
    safe_mode: toBit(m.safeMode),
    session_mode: deriveSessionMode(m.source),
    session_name: m.name ?? null,
    linked_issue: linked?.number ? `#${linked.number}` : null,
    orchestration_id: orchestration,
    repo: m.repoIdentity?.name ?? null,
    is_worktree: m.worktree != null ? 1 : 0,
    git_branch: m.worktree?.branch ?? null,
  };
}

/** Parser-result → SQL bind params for the PARSER_COLUMNS group. */
function parserBindParams(
  r: TurnParseResult
): Record<string, string | number | null> {
  return {
    // cc_session_id is the caller's value (the transcript id), not a parse-result
    // field — callers override this; default null keeps the bind shape complete.
    cc_session_id: null,
    prompt_msg_uuid: r.promptMsgUuid,
    model_provider: r.modelProvider,
    model_id: r.modelId,
    tok_in: r.tokIn,
    tok_out: r.tokOut,
    tok_cache_read: r.tokCacheRead,
    tok_cache_write: r.tokCacheWrite,
    tokens_extra: r.tokensExtra !== null ? JSON.stringify(r.tokensExtra) : null,
    context_used_tokens: r.contextUsedTokens,
    context_remaining_tokens: r.contextRemainingTokens,
    capture_source: r.captureSource,
    transcript_path: r.transcriptPath,
    prompt_hash: r.promptHash,
    schema_version: 1,
  };
}

function deleteAndReinsertParserEvents(
  db: Database,
  turnId: string,
  nodeId: string,
  r: TurnParseResult
): void {
  const placeholders = PARSER_EVENT_KINDS.map(() => "?").join(", ");
  db.prepare(
    `DELETE FROM turn_events WHERE turn_id = ? AND kind IN (${placeholders})`
  ).run(turnId, ...PARSER_EVENT_KINDS);
  if (r.events.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO turn_events (id, turn_id, node_id, ts_ms, kind, name, payload)
     VALUES (@id, @turn_id, @node_id, @ts_ms, @kind, @name, @payload)`
  );
  for (const ev of r.events) {
    insert.run({
      id: newUuidV7(),
      turn_id: turnId,
      node_id: nodeId,
      ts_ms: ev.tsMs,
      kind: ev.kind,
      name: ev.name ?? null,
      payload: ev.payload != null ? JSON.stringify(ev.payload) : null,
    });
  }
}

/**
 * REPAIR mode (AC#2): re-derive the parser column group + parser events for EXISTING
 * rows, in place, force-overwriting (no COALESCE). Daemon-enriched, live-only, cost,
 * and lifecycle columns are untouched; `timelog_adjustments` is never referenced (R11).
 */
/**
 * Issue #4385 fix round 1: a re-parse excludes background agents from their turn
 * rollup (parser schema 2), so write each one's row from its file — the same
 * seed the live finalize runs. A stale `running` partial is refreshed to the
 * full file; a completion (`done` / `error`) row is left alone. Fail-open: a
 * backfill never aborts on a seed error.
 */
function seedBackfilledBackgroundAgents(
  db: Database,
  input: {
    hapiSessionId: string;
    ccSessionId: string;
    transcriptPath: string;
    configDir: string | undefined;
    results: readonly TurnParseResult[];
    /** #4824: the ledger `seq` of `results[i]` — the turn that launched its
     *  agents, whose recorded binding the agent rows take. */
    seqs: readonly number[];
    namespace: string | null;
    nodeId: string | null;
  }
): void {
  if (!input.ccSessionId) return;
  if (!input.results.some(r => excludedBackgroundAgents(r.events).length > 0)) {
    return;
  }
  try {
    const { subagentsDir } = resolveTranscriptPaths({
      ccSessionId: input.ccSessionId,
      transcriptPath: input.transcriptPath,
      configDir: input.configDir,
    });
    const store = new BackgroundAgentUsageStore(db);
    input.results.forEach((r, i) => {
      const agents = excludedBackgroundAgents(r.events);
      const seq = input.seqs[i];
      if (agents.length === 0 || seq === undefined) return;
      seedExcludedBackgroundAgents({
        db,
        store,
        hapiSessionId: input.hapiSessionId,
        namespace: input.namespace,
        nodeId: input.nodeId ?? "backfill",
        subagentsDir,
        agents,
        // #4824: the launching turn's recorded binding (NULL on a turn the
        // rebuild re-created — never re-derived from today's session record).
        binding: readTurnBinding(db, input.hapiSessionId, seq),
        onMissing: agentId =>
          console.warn(
            `[backfill-turns #4385] ${input.hapiSessionId}: background agent ${agentId} has no readable file — usage not counted`
          ),
        onError: (agentId, error) =>
          console.warn(
            `[backfill-turns #4385] ${input.hapiSessionId}: background agent ${agentId} seed failed: ${error instanceof Error ? error.message : String(error)}`
          ),
      });
    });
  } catch (error) {
    console.warn(
      `[backfill-turns #4385] ${input.hapiSessionId}: background agent seed failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function repairTurns(
  db: Database,
  deps: { getConfigDir: ConfigDirResolver },
  options: BackfillTurnsOptions = {}
): RepairSummary {
  const dryRun = options.dryRun ?? false;

  const clauses: string[] = [];
  const params: Record<string, string | number> = {};
  if (options.sessionId) {
    clauses.push("hapi_session_id = @sid");
    params.sid = options.sessionId;
  }
  if (options.sinceMs != null) {
    clauses.push("started_at_ms >= @since");
    params.since = options.sinceMs;
  }
  if (options.untilMs != null) {
    clauses.push("started_at_ms <= @until");
    params.until = options.untilMs;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT id, hapi_session_id, cc_session_id, seq, status, started_at_ms,
              transcript_path
         FROM turns ${where}
        ORDER BY hapi_session_id, cc_session_id, seq`
    )
    .all(params) as RepairRow[];

  // Group rows by (hapi_session_id, cc_session_id) — each group shares one transcript.
  const groups = new Map<string, RepairRow[]>();
  for (const row of rows) {
    const key = `${row.hapi_session_id} ${row.cc_session_id ?? ""}`;
    const g = groups.get(key);
    if (g) g.push(row);
    else groups.set(key, [row]);
  }

  // Resolve each hapi session's account-config dir once.
  const configDirCache = new Map<string, string | undefined>();
  const resolveConfigDir = (hapiSessionId: string): string | undefined => {
    if (configDirCache.has(hapiSessionId))
      return configDirCache.get(hapiSessionId);
    const srow = db
      .prepare(`SELECT metadata FROM sessions WHERE id = ?`)
      .get(hapiSessionId) as { metadata: string | null } | undefined;
    const meta = safeParseJson(
      srow?.metadata ?? null
    ) as SessionMetadata | null;
    const dir = deps.getConfigDir(meta?.accountUuid);
    configDirCache.set(hapiSessionId, dir);
    return dir;
  };

  const summary: RepairSummary = {
    scanned: 0,
    repaired: 0,
    skipped: 0,
    unparseable: 0,
  };

  const updateSql = `UPDATE turns SET
       cc_session_id            = @cc_session_id,
       prompt_msg_uuid          = @prompt_msg_uuid,
       model_provider           = @model_provider,
       model_id                 = @model_id,
       tok_in                   = @tok_in,
       tok_out                  = @tok_out,
       tok_cache_read           = @tok_cache_read,
       tok_cache_write          = @tok_cache_write,
       tokens_extra             = @tokens_extra,
       context_used_tokens      = @context_used_tokens,
       context_remaining_tokens = @context_remaining_tokens,
       capture_source           = @capture_source,
       transcript_path          = @transcript_path,
       prompt_hash              = @prompt_hash,
       schema_version           = @schema_version,
       status                   = @status
     WHERE id = @id`;
  const update = db.prepare(updateSql);

  const applyGroup = (group: RepairRow[]) => {
    // The transcript_path is per-row but identical within a cc_session group; take the
    // first non-null. ccSessionId for subagents-dir resolution comes from the row key.
    const withPath = group.find(r => r.transcript_path);
    if (!withPath || !withPath.transcript_path) {
      summary.skipped += group.length;
      return;
    }
    const ccSessionId = group[0].cc_session_id ?? "";
    const configDir = resolveConfigDir(group[0].hapi_session_id);
    const results = parseAllTurns({
      transcriptPath: withPath.transcript_path,
      ccSessionId,
      configDir,
      fallbackTsMs: group[0].started_at_ms,
    });
    if (results.length === 0) {
      summary.unparseable += 1;
      summary.skipped += group.length;
      return;
    }
    // Align result[i] → rows-sorted-by-seq[i] (both are prompt order).
    const sorted = [...group].sort((a, b) => a.seq - b.seq);
    const n = Math.min(sorted.length, results.length);
    for (let i = 0; i < n; i += 1) {
      const row = sorted[i];
      const r = results[i];
      summary.scanned += 1;
      if (dryRun) {
        summary.repaired += 1;
        continue;
      }
      const bind = parserBindParams(r);
      // R4: rekey — set cc_session_id to the row's group cc OR the transcript's,
      // never trust an SDK shadow uuid; prompt_msg_uuid is the authoritative value.
      bind.cc_session_id = ccSessionId || row.cc_session_id || null;
      const nextStatus =
        r.errored && row.status === "completed" ? "errored" : row.status;
      update.run({ ...bind, status: nextStatus, id: row.id });
      deleteAndReinsertParserEvents(db, row.id, row.cc_session_id ?? "", r);
      summary.repaired += 1;
    }
    if (!dryRun) {
      const owner = db
        .prepare(`SELECT namespace, node_id FROM sessions WHERE id = ?`)
        .get(group[0].hapi_session_id) as
        | { namespace: string | null; node_id: string | null }
        | undefined;
      seedBackfilledBackgroundAgents(db, {
        hapiSessionId: group[0].hapi_session_id,
        ccSessionId,
        transcriptPath: withPath.transcript_path,
        configDir,
        results: results.slice(0, n),
        seqs: sorted.slice(0, n).map(row => row.seq),
        namespace: owner?.namespace ?? null,
        nodeId: owner?.node_id ?? null,
      });
    }
    // Rows beyond the parsed segment count can't be re-derived from this transcript.
    if (sorted.length > results.length) {
      summary.skipped += sorted.length - results.length;
    }
  };

  if (dryRun) {
    for (const g of groups.values()) applyGroup(g);
  } else {
    const tx = db.transaction(() => {
      for (const g of groups.values()) applyGroup(g);
    });
    tx();
  }

  if (options.reprice) {
    summary.reprice = backfillCosts(db, { dryRun });
  }

  return summary;
}

/**
 * REBUILD mode (AC#1): (re)construct a session's `turns` rows from its transcript +
 * `sessions` record. Upserts on `(hapi_session_id, seq)` so a re-run over unchanged
 * inputs makes zero net changes (R3). The transcript is resolved by the caller (the
 * script/test passes `transcriptPath` — disaster recovery resolves it from the project
 * dir; a surviving row's `transcript_path` is the in-DB source).
 */
export function rebuildSession(
  db: Database,
  args: {
    hapiSessionId: string;
    transcriptPath: string;
    ccSessionId?: string;
    getConfigDir: ConfigDirResolver;
  },
  options: BackfillTurnsOptions = {}
): RebuildSummary {
  const dryRun = options.dryRun ?? false;
  const summary: RebuildSummary = {
    sessionsScanned: 0,
    upserted: 0,
    unparseable: 0,
  };

  const session = db
    .prepare(
      `SELECT id, namespace, metadata, node_id, linked_issue
         FROM sessions WHERE id = ?`
    )
    .get(args.hapiSessionId) as SessionRow | undefined;
  if (!session) {
    return summary;
  }
  summary.sessionsScanned = 1;

  const meta = (safeParseJson(session.metadata) ?? {}) as SessionMetadata;
  const ccSessionId = args.ccSessionId ?? meta.claudeSessionId ?? "";
  const configDir = args.getConfigDir(meta.accountUuid);
  const enriched = reconstructEnrichedColumns(session);

  const results = parseAllTurns({
    transcriptPath: args.transcriptPath,
    ccSessionId,
    configDir,
    fallbackTsMs: 0,
  });
  if (results.length === 0) {
    summary.unparseable += 1;
    return summary;
  }

  const upsertSql = `INSERT INTO turns (
       id, hapi_session_id, seq, cc_session_id, prompt_msg_uuid, status,
       started_at_ms, ended_at_ms, duration_ms, node_id, namespace,
       launcher, account_id, plan_tier, safe_mode, session_mode, permission_mode,
       session_name, linked_issue, orchestration_id, model_provider, model_id,
       context_window, cwd, repo, is_worktree, git_branch, git_sha_start,
       git_sha_end, git_dirty, tok_in, tok_out, tok_cache_read, tok_cache_write,
       tokens_extra, context_used_tokens, context_remaining_tokens,
       capture_source, transcript_path, prompt_hash, schema_version
     ) VALUES (
       @id, @hapi_session_id, @seq, @cc_session_id, @prompt_msg_uuid, @status,
       @started_at_ms, @ended_at_ms, @duration_ms, @node_id, @namespace,
       NULL, @account_id, @plan_tier, @safe_mode, @session_mode, NULL,
       @session_name, @linked_issue, @orchestration_id, @model_provider, @model_id,
       NULL, NULL, @repo, @is_worktree, @git_branch, NULL,
       NULL, NULL, @tok_in, @tok_out, @tok_cache_read, @tok_cache_write,
       @tokens_extra, @context_used_tokens, @context_remaining_tokens,
       @capture_source, @transcript_path, @prompt_hash, @schema_version
     )
     ON CONFLICT(hapi_session_id, seq) DO UPDATE SET
       cc_session_id            = excluded.cc_session_id,
       prompt_msg_uuid          = excluded.prompt_msg_uuid,
       status                   = excluded.status,
       ended_at_ms              = excluded.ended_at_ms,
       duration_ms              = excluded.duration_ms,
       node_id                  = excluded.node_id,
       namespace                = excluded.namespace,
       account_id               = excluded.account_id,
       plan_tier                = excluded.plan_tier,
       safe_mode                = excluded.safe_mode,
       session_mode             = excluded.session_mode,
       session_name             = excluded.session_name,
       linked_issue             = excluded.linked_issue,
       orchestration_id         = excluded.orchestration_id,
       model_provider           = excluded.model_provider,
       model_id                 = excluded.model_id,
       repo                     = excluded.repo,
       is_worktree              = excluded.is_worktree,
       git_branch               = excluded.git_branch,
       tok_in                   = excluded.tok_in,
       tok_out                  = excluded.tok_out,
       tok_cache_read           = excluded.tok_cache_read,
       tok_cache_write          = excluded.tok_cache_write,
       tokens_extra             = excluded.tokens_extra,
       context_used_tokens      = excluded.context_used_tokens,
       context_remaining_tokens = excluded.context_remaining_tokens,
       capture_source           = excluded.capture_source,
       transcript_path          = excluded.transcript_path,
       prompt_hash              = excluded.prompt_hash,
       schema_version           = excluded.schema_version`;
  const upsert = db.prepare(upsertSql);

  const applyAll = () => {
    results.forEach((r, i) => {
      const seq = i + 1; // 1-based, prompt order (mirrors B's getMaxSeq+1)
      // Resolve / mint the row id: reuse an existing (hapi_session_id, seq) row's id
      // so an upsert preserves the lifecycle id; mint a UUIDv7 when rebuilding fresh.
      const existing = db
        .prepare(
          `SELECT id, started_at_ms FROM turns WHERE hapi_session_id = ? AND seq = ?`
        )
        .get(args.hapiSessionId, seq) as
        | { id: string; started_at_ms: number }
        | undefined;
      const id = existing?.id ?? newUuidV7();
      // started_at_ms is reconstructible from the transcript prompt timestamp (#1668);
      // prefer it, fall back to an existing row's value, else 0.
      const startedAtMs = r.startedAtMs ?? existing?.started_at_ms ?? 0;
      const bind = parserBindParams(r);
      bind.cc_session_id = ccSessionId || null;
      upsert.run({
        ...bind,
        id,
        hapi_session_id: args.hapiSessionId,
        seq,
        status: r.errored ? "errored" : "completed",
        started_at_ms: startedAtMs,
        ended_at_ms: null,
        duration_ms: null,
        node_id: enriched.node_id,
        namespace: enriched.namespace,
        account_id: enriched.account_id,
        plan_tier: enriched.plan_tier,
        safe_mode: enriched.safe_mode,
        session_mode: enriched.session_mode,
        session_name: enriched.session_name,
        linked_issue: enriched.linked_issue,
        orchestration_id: enriched.orchestration_id,
        repo: enriched.repo,
        is_worktree: enriched.is_worktree,
        git_branch: enriched.git_branch,
      });
      // Replace this turn's parser events.
      const turnId = (
        db
          .prepare(`SELECT id FROM turns WHERE hapi_session_id = ? AND seq = ?`)
          .get(args.hapiSessionId, seq) as { id: string }
      ).id;
      deleteAndReinsertParserEvents(db, turnId, enriched.node_id, r);
      summary.upserted += 1;
    });
  };

  if (!dryRun) {
    const tx = db.transaction(applyAll);
    tx();
    seedBackfilledBackgroundAgents(db, {
      hapiSessionId: args.hapiSessionId,
      ccSessionId,
      transcriptPath: args.transcriptPath,
      configDir,
      results,
      // Rebuild seq is 1-based prompt order (see `applyAll` above).
      seqs: results.map((_, i) => i + 1),
      namespace: enriched.namespace,
      nodeId: enriched.node_id,
    });
  } else {
    summary.upserted = results.length;
  }

  if (options.reprice) {
    summary.reprice = backfillCosts(db, { dryRun });
  }

  return summary;
}
