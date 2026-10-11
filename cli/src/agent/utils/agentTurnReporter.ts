// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Agent-side per-turn telemetry reporter (issue #3352, epic #3345 — Sub G).
 *
 * The non-claude equivalent of `cli/src/claude/utils/turnReporter.ts`. Today
 * only claude constructs a `TurnReporter` (`runClaude.ts`), so gemini / codex /
 * opencode sessions produce ZERO `turns` rows — the TokenUsageWidget and the
 * server token-stats are empty for them. This reporter emits the SAME
 * `turn:open` / `turn:finalize` wire events through the SAME `sendTurnEvent`
 * emitter, so the server side (seq allocation, dedup, orphan sweep, the
 * `v_session_totals` view) handles non-claude turns flavor-agnostically with no
 * server-boundary change.
 *
 * It reuses the claude reporter's payload contract (`TurnOpenPayload` /
 * `TurnFinalizePayload` / `TurnUsageBlock`), its monotonic-clock duration
 * (sleep-excluded — R6 of #1664), and its FIRE-AND-FORGET, NEVER-THROWS
 * discipline (a telemetry fault must never disturb the agent session). It does
 * NOT alter or subclass the claude `TurnReporter` (R7 of #3352) — a separate,
 * simpler class that additionally accumulates the runner's measured usage and
 * attaches it to `turn:finalize`, since non-claude runners have no claude
 * transcript for the server's finalize parse to read.
 *
 * Two things it does NOT do that the claude reporter does: the CLI-wire git
 * snapshot (#1666) — the server's open-enrich step already stamps git/identity
 * columns from `session.metadata` for every flavor — and multi-turn history; it
 * owns exactly one open turn at a time (a new `open()` replaces an un-finalized
 * one, whose row the server sweep orphans).
 */

import { randomUUID } from "node:crypto";
import type {
  TurnEmit,
  TurnOutcome,
  TurnUsageBlock,
} from "@/claude/utils/turnReporter";

const SLEEP_SKEW_THRESHOLD_MS = 60_000;

interface OpenAgentTurnState {
  turnLocalId: string;
  wallStartMs: number;
  monoStartNs: bigint;
  ccSessionId?: string;
  transcriptPath?: string;
  /** Usage accumulated across the turn's signals (merged, defined-fields-win). */
  usage: TurnUsageBlock;
  finalized: boolean;
}

export interface AgentTurnReporterOptions {
  /** Fire-and-forget emitter — wire to `apiSession.sendTurnEvent`. */
  emit: TurnEmit;
  /** Launcher/flavor kind recorded at open (e.g. "gemini", "codex", "opencode"). */
  launcher?: string;
  /** Injectable wall clock (test seam; defaults to Date.now). */
  now?: () => number;
  /** Injectable monotonic clock (test seam; defaults to process.hrtime.bigint). */
  monoNow?: () => bigint;
  /** Injectable id generator (test seam; defaults to randomUUID). */
  genId?: () => string;
}

/**
 * Merge `next` into `acc`, copying ONLY defined fields so a later signal that
 * carries context (but no tokens) never blanks a token value an earlier signal
 * set (R4 — an omitted field must stay absent, never become undefined/0).
 */
function mergeUsage(acc: TurnUsageBlock, next: TurnUsageBlock): void {
  for (const [k, v] of Object.entries(next)) {
    if (v !== undefined && v !== null) {
      (acc as Record<string, unknown>)[k] = v;
    }
  }
}

export class AgentTurnReporter {
  private current: OpenAgentTurnState | null = null;
  private readonly emit: TurnEmit;
  private readonly launcher?: string;
  private readonly now: () => number;
  private readonly monoNow: () => bigint;
  private readonly genId: () => string;

  constructor(options: AgentTurnReporterOptions) {
    this.emit = options.emit;
    this.launcher = options.launcher;
    this.now = options.now ?? Date.now;
    this.monoNow = options.monoNow ?? (() => process.hrtime.bigint());
    this.genId = options.genId ?? randomUUID;
  }

  /**
   * Open a turn at the agent's prompt-cycle boundary. Captures the wall +
   * monotonic start, resets the usage accumulator, and emits `turn:open`. A new
   * open while a turn is already tracked replaces it (the previous turn never
   * finalized — the server sweep orphans its row). Never throws.
   */
  open(meta?: { ccSessionId?: string; transcriptPath?: string }): void {
    try {
      const turnLocalId = this.genId();
      const wallStartMs = this.now();
      this.current = {
        turnLocalId,
        wallStartMs,
        monoStartNs: this.monoNow(),
        ccSessionId: meta?.ccSessionId,
        transcriptPath: meta?.transcriptPath,
        usage: {},
        finalized: false,
      };
      this.emit({
        kind: "open",
        turnLocalId,
        startedAtMs: wallStartMs,
        ccSessionId: meta?.ccSessionId,
        launcher: this.launcher,
        transcriptPath: meta?.transcriptPath,
      });
    } catch {
      // R8: a turn-open failure must never surface to the session path.
      this.current = null;
    }
  }

  /**
   * Record usage measured during the open turn (from a runner's usage detector).
   * Merged into the turn's accumulator so a context-only signal and a
   * token-only signal combine; the accumulated block is attached at finalize.
   * A no-op when no turn is open. Never throws.
   */
  recordUsage(usage: TurnUsageBlock): void {
    try {
      if (!this.current || this.current.finalized) return;
      mergeUsage(this.current.usage, usage);
    } catch {
      // R8: never surface to the session path.
    }
  }

  /** Whether any usage was recorded for the open turn (test/introspection). */
  hasRecordedUsage(): boolean {
    return this.current !== null && Object.keys(this.current.usage).length > 0;
  }

  /**
   * Finalize the open turn with an outcome, attaching the accumulated usage
   * block (omitted entirely when the runner reported no usage — a zero-fidelity
   * turn still produces a boundary-only `turns` row, V6). Idempotent per turn:
   * the first finalize wins. Duration is the monotonic delta (sleep-excluded).
   * Never throws.
   */
  finalize(
    outcome: TurnOutcome,
    meta?: { ccSessionId?: string; transcriptPath?: string }
  ): void {
    try {
      const turn = this.current;
      if (!turn || turn.finalized) return;
      turn.finalized = true;

      const endedAtMs = this.now();
      const monoEndNs = this.monoNow();
      const monoDeltaMs = Number((monoEndNs - turn.monoStartNs) / 1_000_000n);
      const wallDeltaMs = endedAtMs - turn.wallStartMs;
      const spansSleep = wallDeltaMs - monoDeltaMs > SLEEP_SKEW_THRESHOLD_MS;
      const durationMs =
        monoDeltaMs >= 0 ? monoDeltaMs : Math.max(wallDeltaMs, 0);

      const hasUsage = Object.keys(turn.usage).length > 0;
      this.emit({
        kind: "finalize",
        turnLocalId: turn.turnLocalId,
        outcome,
        endedAtMs,
        durationMs,
        spansSleep: spansSleep || undefined,
        ccSessionId: meta?.ccSessionId ?? turn.ccSessionId,
        transcriptPath: meta?.transcriptPath ?? turn.transcriptPath,
        usage: hasUsage ? turn.usage : undefined,
      });
      this.current = null;
    } catch {
      // R8: a turn-finalize failure must never surface to the session path.
      this.current = null;
    }
  }

  hasOpenTurn(): boolean {
    return this.current !== null && !this.current.finalized;
  }
}
