// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server-side turn-lifecycle orchestrator (issue #1664, epic #1662 — Sub B).
 *
 * Sub B owns the OPEN → FINALIZE → SWEEP orchestration that the rest of the
 * telemetry epic plugs into. The Fable cross-issue matrix flagged the
 * Stop-finalize path as having "no orchestration / partial-failure owner"; this
 * module is that owner. The server is the SINGLE WRITER, so `seq` is allocated
 * here (never by the CLI — reconnect races would collide on the operational
 * `UNIQUE(hapi_session_id, seq)` key, D1).
 *
 * Boundaries (Key Decision 7):
 *   - the schema, migrations, and the fail-open write service are **Sub A**'s,
 *     consumed here via `TurnWriteService` / `TurnStore`;
 *   - the transcript parse (tokens/tools/labels, `prompt_msg_uuid` backfill) is
 *     **Sub C** — `parseStep`, a no-op stub here;
 *   - daemon identity/git/account enrichment is **Sub D** — `enrichStep`, a stub;
 *   - cost snapshots are **Sub E** — `costStep`, a stub.
 *
 * The finalize seam (`runFinalizeSteps`) runs the three steps in order; each is
 * INDIVIDUALLY FAIL-OPEN — a throwing step degrades to NULLs and NEVER aborts
 * the finalize (R8). Sub C/D/E land their real bodies by passing the steps to
 * the constructor; the contract is "return ENRICHMENT fields only" — the core
 * lifecycle fields (`hapiSessionId`/`seq`/`endedAtMs`/`durationMs`/`status`) are
 * Sub B's and are applied AFTER the spread so an enrichment step can never
 * override them.
 *
 * Every public method is fail-open and NEVER THROWS to the caller (R8): a turn
 * write failure must not block, stall, or crash a session. Open/finalize go
 * through Sub A's bounded fail-open queue; the orphan sweep (a boot/reconnect
 * maintenance op, off any session path) writes directly with per-row try/catch.
 */

import type { ErrorLogger } from "../logging/errorLogger";
import type { TurnStore } from "../store/turns/turnStore";
import { clampOrphanWatermark } from "../store/turns/orphanWatermark";
import type { TurnWriteService } from "../store/turns/turnWriteService";
import type {
  FinalizeTurnInput,
  OpenTurnInput,
  TurnEventInput,
  TurnRow,
} from "../store/turns/types";

/** CLI → server `turn:open` payload (mirrors the cli turnReporter + `sid`). */
export interface TurnOpenEvent {
  sid: string;
  turnLocalId: string;
  startedAtMs: number;
  ccSessionId?: string;
  launcher?: string;
  cwd?: string;
  transcriptPath?: string;
  // Sub D (#1666, CLI-wire git, R2): working-tree git state captured by the CLI
  // reporter at turn-open. Absent/undefined when the local git probe failed —
  // the row then records NULL. `gitBranch` overrides the server's
  // worktree-metadata fallback when the CLI supplies a live `# branch.head`.
  gitShaStart?: string;
  gitBranch?: string;
  gitDirty?: boolean;
}

/**
 * Issue #3352: optional CLI-supplied per-turn usage on `turn:finalize`, carried
 * by non-claude runners (gemini / codex / opencode) that have no claude
 * transcript for the finalize `parseStep` to read. ABSENT on claude finalizes
 * (R7). Mirror of the CLI `TurnUsageBlock` (the two packages share no import —
 * they communicate over the socket wire, validated by `turnFinalizeSchema`).
 * R4: an absent field is NULL, never a fabricated 0.
 */
export interface TurnUsageBlock {
  modelId?: string;
  modelProvider?: string;
  tokIn?: number;
  tokOut?: number;
  tokCacheRead?: number;
  tokCacheWrite?: number;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
}

/** CLI → server `turn:finalize` payload. `orphaned` is sweep-only, never sent. */
export interface TurnFinalizeEvent {
  sid: string;
  turnLocalId: string;
  outcome: "completed" | "interrupted" | "errored";
  endedAtMs: number;
  durationMs: number;
  spansSleep?: boolean;
  ccSessionId?: string;
  transcriptPath?: string;
  // Sub D (#1666, CLI-wire git, R3): working-tree git state captured by the CLI
  // reporter at turn-finalize. A force-killed / expired session sends no
  // finalize event, so `git_sha_end` stays NULL via the orphan sweep.
  gitShaEnd?: string;
  gitDirty?: boolean;
  // Issue #3352: optional per-turn usage measured by a non-claude runner.
  // Consumed by the `cliUsageStep` finalize seam; absent on claude (R7).
  usage?: TurnUsageBlock;
}

/** Context handed to each finalize seam step (Sub C/D/E). */
export interface FinalizeStepContext {
  hapiSessionId: string;
  seq: number;
  event: TurnFinalizeEvent;
}

/**
 * What a finalize seam step returns: ENRICHMENT-ONLY partial input (tokens,
 * costs, git, `promptMsgUuid`, …) merged into the finalize, PLUS an optional
 * `errored` signal. The enrichment MUST NOT carry the core lifecycle fields
 * (they are applied after the spread and would be ignored anyway).
 *
 * `errored` (Sub C, R11 — "C detects, B records"): the transcript parser sets
 * it when the turn slice contains a genuine API-level error (`isApiErrorMessage`).
 * `finalizeTurn` reads it to upgrade a `completed` outcome to `errored`; it is
 * NOT a write-service column (it never reaches `FinalizeTurnInput`).
 */
export type FinalizeStepResult = Partial<FinalizeTurnInput> & {
  errored?: boolean;
  /** #1921: the transcript parser's swallowed R12 error message — non-null ONLY
   *  when `parseTurn`'s fail-open catch fired. Out-of-band like `errored` (never a
   *  write-service column). `finalizeTurn` logs it (rate-limited) + records a
   *  `parse_failed` turn_event so a fleet-wide parse regression is observable. */
  parseError?: string | null;
  /** #1921: `readTranscript().skipped` — per-line skip count, surfaced into the
   *  parse-failure log context + the `parse_failed` event payload (softer drift signal). */
  parseSkipped?: number;
};

/**
 * A finalize seam step. A thrown error is caught and the step degrades to no
 * enrichment (fail-open).
 *
 * Issue #3353: steps receive the READONLY enrichment ACCUMULATED by the steps
 * that ran before them in the chain, so a later step can price / decorate the
 * columns an earlier step produced. This is required by `costStep`: a claude
 * turn's token/model columns come from `parseStep` (which runs first) and live
 * only in the accumulator — they are absent from `ctx.event` — so `costStep`
 * needs the accumulator to price a claude turn live. The parameter is OPTIONAL
 * and READONLY, so every pre-existing step (which reads only `ctx`) is unaffected
 * and no step can mutate a sibling's output.
 */
export type FinalizeStep = (
  ctx: FinalizeStepContext,
  accumulated?: Readonly<Partial<FinalizeTurnInput>>
) => FinalizeStepResult;

/** Context handed to the Sub D OPEN-enrich seam (keyed by the open turn's session). */
export interface OpenEnrichContext {
  hapiSessionId: string;
}

/**
 * The Sub D OPEN-enrich seam (issue #1666). Returns ONLY the identity/account/repo
 * columns `insertOpenTurn` writes — the real A+B build writes those columns only
 * at OPEN, never at finalize. The core open fields
 * (`hapiSessionId`/`seq`/`nodeId`/`startedAtMs`) are applied AFTER the spread in
 * `openTurn`, so an enrich step can never override them. A thrown error is caught
 * (in `safeOpenEnrich`) and the step degrades to no enrichment (fail-open).
 */
export type OpenEnrichStep = (ctx: OpenEnrichContext) => Partial<OpenTurnInput>;

export interface TurnLifecycleOptions {
  /** Sub C — transcript parse + prompt_msg_uuid backfill (default: no-op). */
  parseStep?: FinalizeStep;
  /** Issue #3352 — map the optional CLI-supplied usage block on a non-claude
   *  finalize (`event.usage`) into the token/model columns. Runs AFTER
   *  `parseStep` so a claude turn's transcript parse wins byte-identically (the
   *  CLI block is absent on claude) and a non-claude turn (empty parse) is
   *  filled here. Default: no-op. */
  cliUsageStep?: FinalizeStep;
  /** Issue #2010 — fail-open PM spawn-roster reconciliation at finalize: greps the
   *  transcript for each non-complete roster row's completion_token and flips it to
   *  `complete` (default: no-op). Runs AFTER parseStep; contributes no enrichment. */
  pmReconcileStep?: FinalizeStep;
  /** Issue #4385 — fail-open: writes a `background_agent_usage` row from the
   *  agent file as it is now for each background launch the parse excluded and
   *  that has no row yet, so the agent is never counted nowhere (the completion
   *  write later REPLACES it in full). Runs AFTER parseStep, before the ceiling
   *  guard; contributes no enrichment. Default: no-op. */
  backgroundAgentSeedStep?: FinalizeStep;
  /** Sub D — finalize git passthrough (maps CLI-provided git_sha_end/git_dirty
   *  from the finalize event; default: no-op). */
  enrichStep?: FinalizeStep;
  /** Sub D — OPEN-time identity/account/repo enrichment from `session.metadata`
   *  (default: no-op). Distinct from `enrichStep` (finalize) because the identity
   *  columns are written only by `insertOpenTurn`, never the finalize UPDATE. */
  openEnrichStep?: OpenEnrichStep;
  /** Sub E — cost snapshot (default: no-op). */
  costStep?: FinalizeStep;
  /** Issue #2158 — context-watermark successor handoff. On finalize of an ARMED
   *  orchestrator session at a clean boundary, it SYNCHRONOUSLY evaluates the
   *  boundary gate and, on fire, `void`-detaches the async handoff pipeline
   *  (persist packet → spawn successor → deliver + confirm → roster handover →
   *  reap). Contributes no enrichment; runs last (default: no-op). */
  successorHandoffStep?: FinalizeStep;
  /** Issue #1905 — runaway-session ceiling guard. A SYNCHRONOUS FinalizeStep that
   *  invokes `SyncEngine.checkSessionCeilings(sid)` at the turn boundary; the
   *  engine meters `v_session_totals`, and on a token/iteration breach it
   *  surfaces an out-of-band notice and hard-stops the session (once per session,
   *  fail-open). Contributes no enrichment (returns `{}`); default: no-op. */
  ceilingGuardStep?: FinalizeStep;
  /** Issue #3563 — orphaned-approval-grant detection at finalize. A SYNCHRONOUS
   *  FinalizeStep that reads the RAW `event.outcome`: on a non-`completed` abort it
   *  posts a proactive `grant-orphaned` notice if a minted grant is still unconsumed;
   *  on a clean end it drops any record the finalized turn opened at/after (R3
   *  bind-first). Contributes no enrichment (returns `{}`); default: no-op. */
  orphanGrantStep?: FinalizeStep;
  /** Issue #3563 — the orphaned-grant sweep for the account-switch / kill backstop.
   *  Invoked at the END of {@link TurnLifecycle.orphanTrackedTurnsForSession} (which
   *  a session-limit 429 account-switch and a token-refresh restart both funnel
   *  through AFTER `archiveSession`, emitting NO `turn:finalize`), so an orphaned
   *  grant survives the switch as a durable notice. Fail-open; default: no-op. */
  onSessionOrphaned?: (hapiSessionId: string) => void;
  /** Bounded dedup-set cap for replayed finalizes (default 5000). */
  finalizedCap?: number;
  /** Injectable clock for orphan ended_at_ms (test seam; default Date.now). */
  now?: () => number;
  /** Issue #2248 — resolves an orphaned turn's last-observed-activity watermark
   *  (the transcript's last message timestamp) at sweep time, so the orphan is
   *  closed at a STRICT lower-bound duration instead of NULL. Returns null when
   *  unavailable → the sweep floors to `started_at_ms` (duration 0). Default:
   *  no-op (always floors), so any non-server construction path is byte-identical. */
  orphanWatermarkResolver?: OrphanWatermarkResolver;
}

/**
 * Issue #2248 — the injected orphan-close watermark resolver. Returns the turn's
 * last-observed-activity timestamp (epoch ms) or null when unavailable (missing
 * transcript, unresolvable path) → the sweep floors to `started_at_ms`.
 * `upperBoundMs` (the same session's next-turn start, when one exists) caps the
 * scan so a later turn's messages are not mis-attributed to a stale-open orphan.
 * Fail-open by contract — an implementation must not throw (the caller also guards).
 */
export type OrphanWatermarkResolver = (ctx: {
  transcriptPath: string | null;
  ccSessionId: string | null;
  workingDirectory: string | null;
  upperBoundMs?: number;
}) => number | null;

const DEFAULT_FINALIZED_CAP = 5000;
/**
 * Defensive duration ceiling. The CLI reporter already excludes host-sleep via
 * the monotonic clock, so a value beyond a day signals a clock anomaly / buggy
 * client — clamp it rather than persist a multi-day phantom (R6 belt-and-braces).
 */
const MAX_SANE_DURATION_MS = 24 * 60 * 60 * 1000;

const NOOP_STEP: FinalizeStep = () => ({});
const NOOP_OPEN_STEP: OpenEnrichStep = () => ({});
/** #2248 default: no watermark source → the sweep floors to `started_at_ms`. */
const NOOP_WATERMARK: OrphanWatermarkResolver = () => null;

export class TurnLifecycle {
  /** sid → highest seq this process has allocated (seeded from the DB lazily). */
  private readonly seqHighWater = new Map<string, number>();
  /** turnLocalId → the open turn's key, for finalize correlation + dedup. */
  private readonly openByLocalId = new Map<
    string,
    { hapiSessionId: string; seq: number }
  >();
  /** "sid:seq" set of turns this process is actively tracking as open. */
  private readonly trackedKeys = new Set<string>();
  /** Bounded dedup of finalized turnLocalIds (fast path; DB key is durable). */
  private readonly finalizedLocalIds = new Set<string>();
  private readonly finalizedOrder: string[] = [];

  private readonly parseStep: FinalizeStep;
  private readonly cliUsageStep: FinalizeStep;
  private readonly pmReconcileStep: FinalizeStep;
  private readonly backgroundAgentSeedStep: FinalizeStep;
  private readonly enrichStep: FinalizeStep;
  private readonly costStep: FinalizeStep;
  private readonly successorHandoffStep: FinalizeStep;
  private readonly ceilingGuardStep: FinalizeStep;
  private readonly orphanGrantStep: FinalizeStep;
  private readonly onSessionOrphaned?: (hapiSessionId: string) => void;
  private readonly openEnrichStep: OpenEnrichStep;
  private readonly finalizedCap: number;
  private readonly now: () => number;
  private readonly orphanWatermarkResolver: OrphanWatermarkResolver;

  constructor(
    private readonly turnStore: TurnStore,
    private readonly writeService: TurnWriteService,
    private readonly nodeId: string,
    private readonly errorLogger: ErrorLogger,
    options?: TurnLifecycleOptions
  ) {
    this.parseStep = options?.parseStep ?? NOOP_STEP;
    this.cliUsageStep = options?.cliUsageStep ?? NOOP_STEP;
    this.pmReconcileStep = options?.pmReconcileStep ?? NOOP_STEP;
    this.backgroundAgentSeedStep =
      options?.backgroundAgentSeedStep ?? NOOP_STEP;
    this.enrichStep = options?.enrichStep ?? NOOP_STEP;
    this.costStep = options?.costStep ?? NOOP_STEP;
    this.successorHandoffStep = options?.successorHandoffStep ?? NOOP_STEP;
    this.ceilingGuardStep = options?.ceilingGuardStep ?? NOOP_STEP;
    this.orphanGrantStep = options?.orphanGrantStep ?? NOOP_STEP;
    this.onSessionOrphaned = options?.onSessionOrphaned;
    this.openEnrichStep = options?.openEnrichStep ?? NOOP_OPEN_STEP;
    this.finalizedCap = options?.finalizedCap ?? DEFAULT_FINALIZED_CAP;
    this.now = options?.now ?? Date.now;
    this.orphanWatermarkResolver =
      options?.orphanWatermarkResolver ?? NOOP_WATERMARK;
  }

  /**
   * Resolve an orphaned turn's close timestamp (issue #2248): the injected
   * watermark resolver's last-observed-activity ts, else the `started_at_ms`
   * floor — clamped by the shared `clampOrphanWatermark` so the derived
   * `duration_ms` is a strict, non-phantom lower bound. Fail-open — a throwing
   * resolver floors. Returns the close ms + the provenance source (transcript
   * vs floor).
   */
  private resolveOrphanClose(turn: TurnRow): {
    endedAtMs: number;
    source: "transcript" | "floor";
  } {
    let wm: number | null = null;
    try {
      const nextStart = this.turnStore.getNextTurnStartMs(
        turn.hapiSessionId,
        turn.seq
      );
      wm = this.orphanWatermarkResolver({
        transcriptPath: turn.transcriptPath,
        ccSessionId: turn.ccSessionId,
        workingDirectory: turn.cwd,
        upperBoundMs: nextStart ?? undefined,
      });
    } catch (error) {
      this.safeLog(
        "turn orphan watermark resolve failed (floored)",
        turn.hapiSessionId,
        error
      );
      wm = null;
    }
    return clampOrphanWatermark(wm, turn.startedAtMs);
  }

  /**
   * Record the orphan-close provenance turn_event (issue #2248) so a swept row's
   * derivation method stays queryable — an estimate must never masquerade as an
   * observed completion. Mirrors the `spans_sleep`/`spans_restart` config_snapshot
   * event. Best-effort; never throws.
   */
  private recordOrphanCloseEvent(
    turn: TurnRow,
    endedAtMs: number,
    source: "transcript" | "floor"
  ): void {
    try {
      this.turnStore.appendEvents({
        turnId: turn.id,
        nodeId: this.nodeId,
        events: [
          {
            tsMs: endedAtMs,
            kind: "config_snapshot",
            name: "orphan_close",
            payload: {
              watermark_source: source,
              duration_ms: Math.max(0, endedAtMs - turn.startedAtMs),
              ended_at_ms: endedAtMs,
            },
          },
        ],
      });
    } catch (error) {
      this.safeLog("turn orphan_close event failed", turn.hapiSessionId, error);
    }
  }

  /**
   * Open a turn at UserPromptSubmit (R1). Allocates `seq` server-side
   * (`max(in-memory high-water, DB max) + 1`), tracks it, and enqueues the
   * fail-open INSERT. Dedups a replayed open by `turnLocalId` (R7). Fail-open.
   */
  openTurn(event: TurnOpenEvent): void {
    try {
      if (this.openByLocalId.has(event.turnLocalId)) return; // replay dedup (R7)

      const last =
        this.seqHighWater.get(event.sid) ?? this.turnStore.getMaxSeq(event.sid);
      const seq = last + 1;
      this.seqHighWater.set(event.sid, seq);
      this.openByLocalId.set(event.turnLocalId, {
        hapiSessionId: event.sid,
        seq,
      });
      this.trackedKeys.add(turnKey(event.sid, seq));

      // Sub D (#1666, R1): identity/account/repo enrichment from the live
      // in-memory session. Localized fail-open (R9) so a throwing enrich step
      // degrades to NO enrichment but STILL records the turn row.
      const enrich = this.safeOpenEnrich(event.sid);

      this.writeService.enqueueOpenTurn({
        // Sub D identity enrichment (account/plan/safe_mode/session_mode/
        // permission_mode/session_name/linked_issue/orchestration_id/repo/
        // is_worktree/git_branch).
        ...enrich,
        // Sub D CLI-wire git at turn-open (R2). `git_branch` prefers the CLI's
        // live `# branch.head`, falling back to the enrich step's worktree value.
        gitShaStart: event.gitShaStart ?? null,
        gitBranch: event.gitBranch ?? enrich.gitBranch ?? null,
        gitDirty: event.gitDirty ?? null,
        // Sub B core + CLI-provided fields — applied AFTER the enrich spread so
        // an enrich step can never override them.
        hapiSessionId: event.sid,
        seq,
        nodeId: this.nodeId,
        startedAtMs: event.startedAtMs,
        ccSessionId: event.ccSessionId ?? null,
        launcher: event.launcher ?? null,
        cwd: event.cwd ?? null,
        transcriptPath: event.transcriptPath ?? null,
        captureSource: "hooks",
      });
    } catch (error) {
      this.safeLog("turn openTurn failed", event.sid, error);
    }
  }

  /**
   * Run the Sub D OPEN-enrich step under a localized fail-open guard (R9). A
   * throwing step degrades to no enrichment but the turn row is STILL inserted —
   * the outer `openTurn` try/catch would otherwise drop the whole open.
   */
  private safeOpenEnrich(hapiSessionId: string): Partial<OpenTurnInput> {
    try {
      return this.openEnrichStep({ hapiSessionId });
    } catch (error) {
      this.safeLog("turn open enrich failed (degraded)", hapiSessionId, error);
      return {};
    }
  }

  /**
   * Finalize a turn at Stop / interrupt / error (R2/R3/R4). Resolves `seq` from
   * the in-memory open map, or — if this process didn't open the turn (a server
   * restart while the CLI reporter stayed alive) — from the latest open DB row
   * for the session, flagging `spans_restart`. Runs the C/D/E enrichment seam
   * (fail-open), then enqueues the fail-open finalize. Idempotent (R7).
   */
  finalizeTurn(event: TurnFinalizeEvent): void {
    try {
      if (this.finalizedLocalIds.has(event.turnLocalId)) return; // dedup (R7)

      let seq: number;
      let spansRestart = false;
      const tracked = this.openByLocalId.get(event.turnLocalId);
      if (tracked) {
        seq = tracked.seq;
      } else {
        // The server lost its in-memory map across a restart while the CLI
        // reporter outlived it — resolve the still-open turn from the DB.
        const open = this.turnStore
          .getOpenTurns()
          .filter(t => t.hapiSessionId === event.sid);
        const latest = open[open.length - 1];
        if (!latest) return; // nothing open to finalize — no-op
        seq = latest.seq;
        spansRestart = true;
      }

      const durationMs = clampDuration(event.durationMs);
      const events: TurnEventInput[] = [];
      if (event.spansSleep || spansRestart) {
        // No schema column exists for these flags — record them as a turn_event
        // (only when an anomaly is actually detected). Satisfies R6's "set a
        // flag" without touching Sub A's frozen schema.
        events.push({
          tsMs: event.endedAtMs,
          kind: "config_snapshot",
          name: "clock",
          payload: {
            spans_sleep: Boolean(event.spansSleep),
            spans_restart: spansRestart,
            duration_ms: durationMs,
          },
        });
      }

      const {
        enrichment,
        errored: erroredSignal,
        parseError,
        parseSkipped,
      } = this.runFinalizeSteps({
        hapiSessionId: event.sid,
        seq,
        event,
      });

      // #1921: observability for the parser's fail-open R12 catch. `parseError` is
      // non-null ONLY when the transcript parser swallowed a TRUE error — never on an
      // empty/missing-transcript turn (R4). Emit a rate-limited log line (the
      // ErrorLogger is per-category rate-limited, #1141) AND a `parse_failed`
      // turn_event so a fleet-wide parse regression is visible instead of silently
      // zeroing the telemetry. Resilient by construction (R2): the log is try/catch-
      // wrapped (logParseFailure) and the event is a plain push into the fail-open
      // finalize events array — neither can throw out of finalizeTurn.
      if (parseError != null) {
        this.logParseFailure(event.sid, parseError, parseSkipped);
        events.push({
          tsMs: event.endedAtMs,
          kind: "parse_failed",
          name: null,
          payload: { skipped: parseSkipped },
        });
      }

      // Sub C (R11, "C detects, B records"): a transcript-level api_error upgrades
      // a completed turn to errored. Never downgrade an interrupt/error the CLI
      // already reported; the parser sets `errored` ONLY for a genuine
      // isApiErrorMessage (never a recoverable tool_result error).
      const status =
        event.outcome === "completed" && erroredSignal
          ? "errored"
          : event.outcome;

      this.writeService.enqueueFinalizeTurn({
        ...enrichment, // Sub C/D/E enrichment (tokens, costs, git, uuid, …)
        // Sub B core lifecycle fields — applied AFTER the spread so an
        // enrichment step can never override them.
        hapiSessionId: event.sid,
        seq,
        endedAtMs: event.endedAtMs,
        durationMs,
        status,
        captureSource: enrichment.captureSource ?? "hooks",
        events: [...(enrichment.events ?? []), ...events],
      });

      this.markFinalized(event.turnLocalId);
      this.openByLocalId.delete(event.turnLocalId);
      this.trackedKeys.delete(turnKey(event.sid, seq));
    } catch (error) {
      this.safeLog("turn finalizeTurn failed", event.sid, error);
    }
  }

  /**
   * Mark stale-open turns orphaned (R5) — at server boot (no filter; the
   * in-memory map is empty so every persisted open turn is stale) and at session
   * resume (scoped to the resuming `hapiSessionId`). A turn this process is
   * actively tracking is never orphaned. Off any session critical path; per-row
   * fail-open. Returns the number of rows flipped (for logging/tests).
   */
  sweepOrphans(opts?: { hapiSessionId?: string }): number {
    let orphaned = 0;
    try {
      const open = this.turnStore.getOpenTurns();
      for (const turn of open) {
        if (opts?.hapiSessionId && turn.hapiSessionId !== opts.hapiSessionId) {
          continue;
        }
        if (this.trackedKeys.has(turnKey(turn.hapiSessionId, turn.seq))) {
          continue; // genuinely open in THIS process — not an orphan
        }
        try {
          // #2248: close at the last-observed-activity watermark (lower-bound
          // duration) instead of the sweep wall-clock, which would over-count a
          // turn orphaned across a long downtime.
          const { endedAtMs, source } = this.resolveOrphanClose(turn);
          if (
            this.turnStore.markOrphaned(turn.hapiSessionId, turn.seq, endedAtMs)
          ) {
            orphaned += 1;
            this.recordOrphanCloseEvent(turn, endedAtMs, source);
          }
        } catch (error) {
          this.safeLog("turn markOrphaned failed", turn.hapiSessionId, error);
        }
      }
    } catch (error) {
      this.safeLog("turn sweepOrphans failed", null, error);
    }
    return orphaned;
  }

  /**
   * #2002 (R1a-opt gate): true iff this process is tracking an open (unfinalized)
   * turn for the session. The account-switch / token-refresh restart path consults
   * this to decide whether a bounded graceful pre-kill interrupt is worthwhile.
   * Keyed off turn-lifecycle open state — NOT `session.thinking`, which
   * `setRateLimited` stales to `false` the instant a 429 is observed, BEFORE any
   * finalize fires (#2002 Finding B). Read-only; never throws.
   */
  hasOpenTurnForSession(hapiSessionId: string): boolean {
    try {
      for (const key of this.openByLocalId.values()) {
        if (key.hapiSessionId === hapiSessionId) return true;
      }
    } catch {
      // never surface to the caller
    }
    return false;
  }

  /**
   * #2002 (R1a): terminally close any open turn(s) this process TRACKS for a session
   * that is being hard-killed by an account-switch / token-refresh restart.
   *
   * Distinct from `sweepOrphans` (a boot/reconnect maintenance op that SKIPS tracked
   * turns): the `killSession` restart path emits NO `turn:finalize`, so a turn open at
   * kill time is BOTH still `trackedKeys`-tracked AND `status='open'` in the DB —
   * `sweepOrphans` would skip it this server lifetime, leaving it `open` until the next
   * server boot. This method marks each such tracked turn `orphaned` AND untracks it,
   * so it reaches a terminal status immediately. Idempotent with a racing graceful-abort
   * `finalizeTurn` (that path removes the turn from `openByLocalId` first — so this
   * finds nothing — and `markFinalized` here dedups a late-arriving finalize either way).
   * Per-turn fail-open; never throws (R8). Returns the number of turns orphaned.
   */
  orphanTrackedTurnsForSession(hapiSessionId: string): number {
    let orphaned = 0;
    try {
      // #2248: the in-memory map holds only session+seq, so fetch the still-open
      // rows for this session to resolve each orphan's last-observed-activity
      // watermark (transcript path / started_at). A tracked turn is status='open'
      // in the DB, so it appears here; if it doesn't, markOrphaned no-ops (guard).
      const rowsBySeq = new Map<number, TurnRow>();
      for (const row of this.turnStore.getOpenTurns()) {
        if (row.hapiSessionId === hapiSessionId) rowsBySeq.set(row.seq, row);
      }
      for (const [turnLocalId, key] of [...this.openByLocalId.entries()]) {
        if (key.hapiSessionId !== hapiSessionId) continue;
        try {
          const row = rowsBySeq.get(key.seq);
          // Fall back to the sweep clock only when the row is absent (already
          // finalized/orphaned) — markOrphaned then no-ops, so it is never written.
          const close = row
            ? this.resolveOrphanClose(row)
            : { endedAtMs: this.now(), source: "floor" as const };
          if (
            this.turnStore.markOrphaned(
              key.hapiSessionId,
              key.seq,
              close.endedAtMs
            )
          ) {
            orphaned += 1;
            if (row)
              this.recordOrphanCloseEvent(row, close.endedAtMs, close.source);
          }
        } catch (error) {
          this.safeLog(
            "turn orphanTrackedTurnsForSession markOrphaned failed",
            hapiSessionId,
            error
          );
        }
        this.openByLocalId.delete(turnLocalId);
        this.trackedKeys.delete(turnKey(key.hapiSessionId, key.seq));
        this.markFinalized(turnLocalId); // dedup a late-arriving turn:finalize
      }
    } catch (error) {
      this.safeLog(
        "turn orphanTrackedTurnsForSession failed",
        hapiSessionId,
        error
      );
    }
    // Issue #3563: the account-switch / kill backstop emits NO `turn:finalize`, so
    // the orphanGrantStep FinalizeStep never fires for it — sweep the orphaned-grant
    // check here. Runs even when 0 turns were orphaned (a grant minted before the
    // kill is still orphaned). Fail-open — its own guard so a throwing check can
    // never surface to the caller (R8).
    if (this.onSessionOrphaned) {
      try {
        this.onSessionOrphaned(hapiSessionId);
      } catch (error) {
        this.safeLog(
          "turn onSessionOrphaned failed (degraded)",
          hapiSessionId,
          error
        );
      }
    }
    return orphaned;
  }

  private runFinalizeSteps(ctx: FinalizeStepContext): {
    enrichment: Partial<FinalizeTurnInput>;
    errored: boolean;
    parseError: string | null;
    parseSkipped: number;
  } {
    const out: Partial<FinalizeTurnInput> = {};
    let errored = false;
    // #1921: out-of-band parse-failure signals from the Sub C parse step.
    let parseError: string | null = null;
    let parseSkipped = 0;
    for (const step of [
      this.parseStep,
      // Issue #3352: CLI-supplied usage for non-claude runners. MUST run right
      // after parseStep — on a claude turn the CLI block is absent so this is a
      // no-op and the parse result is preserved byte-identically (R7); on a
      // non-claude turn the parse yields nothing (no claude transcript) and this
      // fills the token/model columns. Placed before the pure side-effecting
      // steps below (none of which touch token columns).
      this.cliUsageStep,
      // Issue #2010: PM spawn-roster reconciliation runs AFTER parseStep. It
      // returns no enrichment (a pure side-effecting step), so it cannot disturb
      // the parse/git/cost columns or the out-of-band signals split below.
      this.pmReconcileStep,
      // Issue #4385: seed a row for each excluded background agent (reads the
      // parse step's accumulated `events`); side-effecting, no enrichment. Runs
      // before ceilingGuardStep so the guard sees the seeded usage.
      this.backgroundAgentSeedStep,
      this.enrichStep,
      this.costStep,
      // Issue #2158: context-watermark successor handoff runs LAST. Pure
      // side-effecting (returns {}); on fire it detaches its own async pipeline,
      // so it never blocks finalize.
      this.successorHandoffStep,
      // Issue #3563: orphaned-grant detection. Pure side-effecting (returns {}) and
      // SYNCHRONOUS (reads the raw `event.outcome`; posts/drops via injected engine
      // callbacks). Fail-open — a throw is caught by the per-step try/catch below.
      this.orphanGrantStep,
      // Issue #1905: runaway-session ceiling guard, LAST — a terminal action
      // (hard-stop) that reads the persisted `v_session_totals` (independent of
      // this turn's enrichment, so ordering is immaterial). Pure side-effecting
      // (returns {}); fail-open (the engine wraps it, and the per-step try/catch
      // below is the second net).
      this.ceilingGuardStep,
    ]) {
      try {
        // Split the out-of-band signals (Sub C `errored`; #1921 `parseError` /
        // `parseSkipped`) from the column enrichment so they never leak into the
        // write-service input.
        // Issue #3353: hand each step the enrichment accumulated so far (readonly)
        // so `costStep` — which runs after `parseStep`/`cliUsageStep` — can price
        // the token/model/provider columns they produced.
        const {
          errored: stepErrored,
          parseError: stepParseError,
          parseSkipped: stepParseSkipped,
          ...enrichment
        } = step(ctx, out) ?? {};
        Object.assign(out, enrichment);
        if (stepErrored) errored = true;
        if (stepParseError != null) {
          parseError = stepParseError;
          parseSkipped = stepParseSkipped ?? 0;
        }
      } catch (error) {
        // Fail-open: a misbehaving enrichment step degrades to no enrichment;
        // it must never abort the finalize or disturb the session (R8).
        this.safeLog(
          "turn finalize step failed (degraded)",
          ctx.hapiSessionId,
          error
        );
      }
    }
    return { enrichment: out, errored, parseError, parseSkipped };
  }

  private markFinalized(turnLocalId: string): void {
    if (this.finalizedLocalIds.has(turnLocalId)) return;
    this.finalizedLocalIds.add(turnLocalId);
    this.finalizedOrder.push(turnLocalId);
    while (this.finalizedOrder.length > this.finalizedCap) {
      const evicted = this.finalizedOrder.shift();
      if (evicted !== undefined) this.finalizedLocalIds.delete(evicted);
    }
  }

  private safeLog(
    message: string,
    sessionId: string | null,
    error: unknown
  ): void {
    try {
      this.errorLogger.error(message, {
        category: "turns-lifecycle",
        sessionId,
        context: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } catch {
      // never let a logging failure surface to the caller
    }
  }

  /**
   * #1921: resilient, rate-limited log for a swallowed transcript-parse failure
   * (the parser's fail-open R12 catch). Uses a DISTINCT category so the failure
   * rate is queryable from `error_logs` (`WHERE category='transcript-parse-failed'`)
   * independently of other lifecycle errors; `ErrorLogger` is already per-category
   * rate-limited (#1141), satisfying the "rate-limited / sampled" requirement. Wrapped
   * in try/catch (mirrors `safeLog`) so a logging failure can never surface to — or
   * throw out of — the fail-open finalize path.
   */
  private logParseFailure(
    sessionId: string,
    message: string,
    skipped: number
  ): void {
    try {
      this.errorLogger.error("transcript parse failed (fail-open R12)", {
        category: "transcript-parse-failed",
        sessionId,
        context: { error: message, skipped },
      });
    } catch {
      // never let a logging failure surface to the caller
    }
  }
}

function turnKey(hapiSessionId: string, seq: number): string {
  return `${hapiSessionId}:${seq}`;
}

function clampDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs < 0) return 0;
  return Math.min(durationMs, MAX_SANE_DURATION_MS);
}
