// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Domain types + write-service input contracts for the per-turn telemetry core
 * (issue #1663, epic #1662).
 *
 * Two kinds of type live here:
 *
 *   - **Row types** (`TurnRow`, `TurnEventRow`, `TimelogAdjustmentRow`,
 *     `RateCardRow`) mirror the pinned SQLite columns. camelCase TS field ↔
 *     snake_case column (matching `store/types.ts`). Boolean-backed columns
 *     are `0 | 1` in SQLite, so they surface as `number | null` on raw reads.
 *
 *   - **Input types** (`OpenTurnInput`, `FinalizeTurnInput`, `AppendEventsInput`,
 *     `TurnEventInput`) are the published write-service contracts that Sub B/C/D/E
 *     populate (R8). They use ergonomic TS shapes (`boolean`, structured JSON
 *     objects); `TurnStore` normalizes them to the raw column representation on
 *     write. Each optional field is owned by a specific downstream sub-issue —
 *     keeping them flat (one field per column) makes that ownership legible.
 */

/** Lifecycle status of a turn. Plain TEXT in SQL — no CHECK (see Key Decision K1). */
export type TurnStatus =
  | "open"
  | "completed"
  | "interrupted"
  | "errored"
  | "orphaned";

/**
 * Canonical `turn_events.kind` values. Modeled as a TS union, NOT a SQL CHECK
 * constraint (Key Decision K1): the epic reserves kinds that are wired later
 * (`cron_started` / `cron_stopped`), and a rigid CHECK enum would force a table
 * rebuild on every new kind. The column is open TEXT; this union is the
 * forward-compatible contract.
 */
export type TurnEventKind =
  | "skill"
  | "hook"
  | "mcp_call"
  | "subagent"
  | "error"
  | "label_added"
  | "label_removed"
  | "cron_started"
  | "cron_stopped"
  | "compaction"
  | "model_switch"
  | "config_snapshot"
  | "api_error"
  // #1921: transcript-parser fail-open observability. The `parseTurn` R12 catch
  // surfaces a swallowed parse error; the finalize seam records it as this event
  // (open TEXT, no SQL CHECK → no migration, per K1) so a fleet-wide parse
  // regression is counted via `v_analytics_counts` instead of silently zeroing.
  | "parse_failed";

/**
 * Append-only manual time-ledger adjustment type. Plain TEXT — no CHECK (K1).
 *
 * The six clock controls (Sub H / #1670) map to these types:
 *   - Adjust (relative)  → `delta`   (signed `deltaMs` added to the bucket)
 *   - Set (absolute)     → `set`     (`toMs` absolute checkpoint; `fromMs` audit)
 *   - Reset              → `reset`   (`set` to 0)
 *   - Undo               → `undo`    (reversing entry referencing `targetAdjustmentId`; never deletes)
 *   - Disable            → `disable` (`[fromMs, toMs]` aggregation-exclusion range)
 *   - Enable             → `enable`  (`[fromMs, toMs]` re-inclusion of a previously-disabled range)
 *
 * `disable`/`enable` were added by #1670 (H1). They are forward-compatible
 * additions the open-TEXT column already accommodates — the schema comment at
 * `schema.ts` ("Sub H (#1670) refines") authorizes this; NO migration is needed.
 */
export type TimelogAdjustmentType =
  | "set"
  | "delta"
  | "reset"
  | "undo"
  | "disable"
  | "enable";

// ───────────────────────────── Row types ─────────────────────────────

/** One row of `turns` (one UserPromptSubmit→Stop cycle). */
export interface TurnRow {
  id: string;
  hapiSessionId: string;
  seq: number;
  ccSessionId: string | null;
  promptMsgUuid: string | null;
  status: TurnStatus;
  startedAtMs: number;
  endedAtMs: number | null;
  durationMs: number | null;
  nodeId: string;
  namespace: string | null;
  launcher: string | null;
  accountId: string | null;
  planTier: string | null;
  /** Issue #4824: the session's `authBinding.kind` when the turn OPENED
   *  (`subscription-account` | `api-key` | `gateway-key` | `inherited`); NULL on
   *  a legacy row or a session with no binding. Never rewritten after open. */
  authBindingKind: string | null;
  /** Issue #4824: the vault key id of an `api-key` turn (never key material). */
  apiKeyId: string | null;
  /** SQLite INTEGER 0/1. */
  safeMode: number | null;
  sessionMode: string | null;
  permissionMode: string | null;
  sessionName: string | null;
  linkedIssue: string | null;
  orchestrationId: string | null;
  modelProvider: string | null;
  modelId: string | null;
  contextWindow: number | null;
  cwd: string | null;
  repo: string | null;
  /** SQLite INTEGER 0/1. */
  isWorktree: number | null;
  gitBranch: string | null;
  gitShaStart: string | null;
  gitShaEnd: string | null;
  /** SQLite INTEGER 0/1. */
  gitDirty: number | null;
  tokIn: number | null;
  tokOut: number | null;
  tokCacheRead: number | null;
  tokCacheWrite: number | null;
  /** JSON string: nested cache_creation 5m/1h, server_tool_use, … (Sub C/E). */
  tokensExtra: string | null;
  costIn: number | null;
  costOut: number | null;
  costCacheRead: number | null;
  costCacheWrite: number | null;
  costTotal: number | null;
  /** FK-by-convention → `rate_cards.id` (Sub E). */
  rateCardId: string | null;
  contextUsedTokens: number | null;
  contextRemainingTokens: number | null;
  /** Provenance: sdk | hooks | parsed (Sub C). */
  captureSource: string | null;
  transcriptPath: string | null;
  /** Content hash only — NO prompt text is ever stored. */
  promptHash: string | null;
  /** Per-turn-row schema version (parser evolution). Defaults to 1. */
  schemaVersion: number;
  recorderVersion: string | null;
}

/** One row of `turn_events` (an event inside a turn). */
export interface TurnEventRow {
  id: string;
  turnId: string;
  /** Denormalized (K3) so Sub L aggregates events without a `turns` join. */
  nodeId: string;
  tsMs: number;
  kind: TurnEventKind;
  name: string | null;
  /** JSON string. */
  payload: string | null;
}

/** One row of `timelog_adjustments` (append-only manual time-ledger adjustment). */
export interface TimelogAdjustmentRow {
  id: string;
  hapiSessionId: string;
  nodeId: string;
  namespace: string | null;
  tsMs: number;
  type: TimelogAdjustmentType;
  deltaMs: number | null;
  fromMs: number | null;
  toMs: number | null;
  /** For type='undo' → the adjustment id it reverses. */
  targetAdjustmentId: string | null;
  actor: string | null;
  note: string | null;
}

/** One row of `rate_cards` (versioned pricing reference — Sub E seeds; Sub A creates empty). */
export interface RateCardRow {
  id: string;
  provider: string;
  modelId: string;
  /** ms epoch. */
  effectiveFrom: number;
  /** JSON string: {in,out,cache_read,cache_write,…} — Sub E pins the exact shape. */
  prices: string;
}

// ──────────────────────── Write-service input contracts ────────────────────────

/** A single event to record against a turn (used by finalize + append). */
export interface TurnEventInput {
  tsMs: number;
  kind: TurnEventKind;
  name?: string | null;
  /** Structured; `TurnStore` serializes to the JSON `payload` column. */
  payload?: Record<string, unknown> | null;
}

/**
 * Payload contract for `kind: "skill"` events (issue #2154).
 *
 * `injectedBytes` is the measured UTF-8 size of the SKILL.md body that the
 * Skill tool_result carried into the session's context — i.e. the per-invocation
 * context-load cost the skill-diet epic (rp1-home#1312) needs to rank skills by.
 *
 * It is deliberately a BYTE count, not a token count: bytes are the fact the
 * transcript actually contains. Token figures are derived downstream (see
 * `TurnAnalyticsCounts.getSkillTokenEstimates`) so the divisor stays one
 * documented, changeable assumption rather than being baked into stored data.
 *
 * The field is OPTIONAL. It is absent when the tool_result was not correlated —
 * an errored invocation, a skill result landing outside the parsed segment, or a
 * transcript predating this measurement. Absent must be read as "not measured",
 * never as zero: a skill reported as costing 0 would rank as free and never get
 * dieted.
 *
 * Written as a plain JSON payload on the existing open-TEXT `payload` column, so
 * it needs no `turn_events` migration (consistent with K1's forward-compat
 * stance on that table).
 */
export interface SkillEventPayload {
  injectedBytes?: number;
}

/**
 * Opening a turn at UserPromptSubmit (R8). The not-null-at-open subset is
 * required; everything else is open-time enrichment a caller (Sub B) MAY set.
 * `status` is forced to 'open' by the store regardless of input.
 */
export interface OpenTurnInput {
  hapiSessionId: string;
  seq: number;
  nodeId: string;
  startedAtMs: number;
  // ── optional open-time enrichment ──
  ccSessionId?: string | null;
  namespace?: string | null;
  launcher?: string | null;
  accountId?: string | null;
  planTier?: string | null;
  /** Issue #4824: the session's binding kind at open (see `TurnRow`). */
  authBindingKind?: string | null;
  /** Issue #4824: the vault key id, set only for an `api-key` turn. */
  apiKeyId?: string | null;
  safeMode?: boolean | null;
  sessionMode?: string | null;
  permissionMode?: string | null;
  sessionName?: string | null;
  linkedIssue?: string | null;
  orchestrationId?: string | null;
  modelProvider?: string | null;
  modelId?: string | null;
  contextWindow?: number | null;
  cwd?: string | null;
  repo?: string | null;
  isWorktree?: boolean | null;
  gitBranch?: string | null;
  gitShaStart?: string | null;
  gitDirty?: boolean | null;
  captureSource?: string | null;
  transcriptPath?: string | null;
  recorderVersion?: string | null;
  schemaVersion?: number;
}

/**
 * Finalizing a turn at Stop (R8). Keyed by the operational `(hapiSessionId, seq)`
 * pair (D1). The transcript-authoritative `ccSessionId` / `promptMsgUuid` are
 * backfilled here (Sub C) — the partial unique index (R3) rejects a duplicate
 * finalize once a real `promptMsgUuid` is known. `events` are inserted in the
 * same transaction as the turn UPDATE.
 */
export interface FinalizeTurnInput {
  hapiSessionId: string;
  seq: number;
  endedAtMs: number;
  durationMs: number;
  status: TurnStatus;
  ccSessionId?: string | null;
  promptMsgUuid?: string | null;
  // ── model (Sub C, R4) ──
  modelProvider?: string | null;
  modelId?: string | null;
  // ── tokens (Sub C/E) ──
  tokIn?: number | null;
  tokOut?: number | null;
  tokCacheRead?: number | null;
  tokCacheWrite?: number | null;
  /** Structured; serialized to the JSON `tokens_extra` column. */
  tokensExtra?: Record<string, unknown> | null;
  // ── costs (Sub E) ──
  costIn?: number | null;
  costOut?: number | null;
  costCacheRead?: number | null;
  costCacheWrite?: number | null;
  costTotal?: number | null;
  rateCardId?: string | null;
  // ── context window (Sub C) ──
  contextUsedTokens?: number | null;
  contextRemainingTokens?: number | null;
  // ── git / provenance ──
  gitShaEnd?: string | null;
  gitDirty?: boolean | null;
  captureSource?: string | null;
  transcriptPath?: string | null;
  promptHash?: string | null;
  recorderVersion?: string | null;
  schemaVersion?: number;
  // ── events recorded at finalize ──
  events?: TurnEventInput[];
}

/**
 * Issue #4824: the billing binding a turn ran under, as recorded on its ledger
 * row. Background-agent rows copy it from the turn that launched the agent, so
 * a later switch never re-attributes an agent's cost.
 */
export interface TurnBillingBinding {
  authBindingKind: string | null;
  apiKeyId: string | null;
}

/** Appending events to an already-open turn (R8). */
export interface AppendEventsInput {
  turnId: string;
  nodeId: string;
  events: TurnEventInput[];
}
