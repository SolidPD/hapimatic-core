// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLI-side per-turn telemetry reporter (issue #1664, epic #1662 — Sub B).
 *
 * One `TurnReporter` is owned by a single Claude session for its whole lifetime
 * (constructed in `runClaude`, wired to the hook server's `onTurnOpen` /
 * `onTurnFinalize` callbacks and to the launcher interrupt sites). It is the
 * client-side authority for the two things the server cannot reconstruct:
 *
 *   1. **A stable per-turn id** (`turnLocalId`) — the server dedup key (R7). The
 *      server allocates the persisted `seq`; the reporter only needs an opaque
 *      local id so open/finalize for the same turn correlate.
 *   2. **The monotonic clock facts** — duration is computed from
 *      `process.hrtime.bigint()` deltas, NOT wall clock. On Linux
 *      `CLOCK_MONOTONIC` does not advance while the host is suspended, so a turn
 *      that spans a laptop-sleep records only its real compute time — never a
 *      multi-hour phantom (R6). When wall-clock elapsed far exceeds monotonic
 *      elapsed we additionally flag `spansSleep`.
 *
 * Everything here is FIRE-AND-FORGET and NEVER THROWS to the caller (R8): a turn
 * telemetry failure must not block, stall, or crash a Claude session. The actual
 * socket emit + server write are off the session critical path; durability is
 * owned by Sub A's fail-open write service on the server.
 *
 * The reporter lives in ONE launcher process for the whole turn, so open and
 * finalize are always same-process — `spans_restart` (open and finalize in
 * different processes) is therefore a SERVER-side condition (the server lost its
 * in-memory open-turn map across a restart while this reporter stayed alive),
 * detected in `turnLifecycle`, not here.
 */

import { randomUUID } from "node:crypto";

/** A turn's terminal outcome reported by the CLI. `orphaned` is sweep-only (server). */
export type TurnOutcome = "completed" | "interrupted" | "errored";

/** Wire payload for `turn:open` (CLI → server, `/cli` Socket.IO channel). */
export interface TurnOpenPayload {
  kind: "open";
  turnLocalId: string;
  startedAtMs: number;
  ccSessionId?: string;
  launcher?: string;
  cwd?: string;
  transcriptPath?: string;
  // Sub D (#1666, CLI-wire git, R2): working-tree state captured locally at
  // turn-open. Omitted when the local git probe fails (the server records NULL).
  gitShaStart?: string;
  gitBranch?: string;
  gitDirty?: boolean;
}

/** Wire payload for `turn:finalize` (CLI → server). */
export interface TurnFinalizePayload {
  kind: "finalize";
  turnLocalId: string;
  outcome: TurnOutcome;
  endedAtMs: number;
  durationMs: number;
  /** Set when the host slept mid-turn (wall ≫ monotonic). Omitted when false. */
  spansSleep?: boolean;
  ccSessionId?: string;
  transcriptPath?: string;
  // Sub D (#1666, CLI-wire git, R3): working-tree state captured locally at
  // turn-finalize. Omitted when the local git probe fails.
  gitShaEnd?: string;
  gitDirty?: boolean;
  // Issue #3352: optional per-turn usage measured by a non-claude runner.
  // Absent on claude finalizes (R7); see {@link TurnUsageBlock}.
  usage?: TurnUsageBlock;
}

/**
 * Optional CLI-supplied per-turn usage block on `turn:finalize` (issue #3352).
 * NON-claude runners (gemini / codex / opencode) attach measured usage here
 * because they have no claude-format transcript for the server's finalize
 * `parseStep` to read. It is ABSENT on claude finalizes (claude usage enters
 * server-side via the transcript parse), so this is purely additive — a claude
 * turn's server-side numbers stay byte-identical (R7).
 *
 * R4 (no fabrication): every field is optional. A CLI that exposes no
 * cache-read/write split OMITS those fields entirely — never a fabricated 0 —
 * and the server records an absent field as NULL, not a measured zero.
 */
export interface TurnUsageBlock {
  /** Resolved model id (e.g. "gemini-2.5-pro", "gpt-5-codex"). */
  modelId?: string;
  /** Provider key for #3353's provider-rate-cards (e.g. "google", "openai"). */
  modelProvider?: string;
  tokIn?: number;
  tokOut?: number;
  /** Omitted when the CLI exposes no cache-read count (R4). */
  tokCacheRead?: number;
  /** Omitted when the CLI exposes no cache-write count (R4). */
  tokCacheWrite?: number;
  /** Context-window occupancy at finalize, where the CLI exposes it (R6). */
  contextUsedTokens?: number;
  contextWindowTokens?: number;
}

export type TurnEventPayload = TurnOpenPayload | TurnFinalizePayload;

/** Injected emitter — `runClaude` wires this to `apiSession.sendTurnEvent`. */
export type TurnEmit = (payload: TurnEventPayload) => void;

/**
 * Sub D (#1666): a single working-tree git snapshot. `sha` is the current HEAD
 * commit (null in a fresh repo / detached at no commit); `branch` is the current
 * branch (null when detached); `dirty` is true when the tree has uncommitted
 * changes. Captured locally in the CLI process (the server's git-status RPC is
 * async and cannot run in the synchronous turn seams).
 */
export interface GitSnapshot {
  sha: string | null;
  branch: string | null;
  dirty: boolean;
}

/**
 * Injectable, fail-open git probe (test seam; production impl in `runClaude`).
 * Returns null on ANY failure (no repo, git missing, timeout) — a probe failure
 * must never disturb the turn path (R9).
 */
export type GitProbe = (cwd: string | undefined) => GitSnapshot | null;

/**
 * Host-sleep skew threshold. If wall-clock elapsed exceeds monotonic elapsed by
 * more than this, the host suspended during the turn (monotonic froze, wall did
 * not). One minute of skew is far beyond scheduler/GC jitter and is a reliable
 * suspend signal without false positives on normal long turns.
 */
const SLEEP_SKEW_THRESHOLD_MS = 60_000;

interface OpenTurnState {
  turnLocalId: string;
  wallStartMs: number;
  monoStartNs: bigint;
  meta: { ccSessionId?: string; cwd?: string; transcriptPath?: string };
  finalized: boolean;
}

export interface TurnReporterOptions {
  /** Fire-and-forget emitter for turn events. */
  emit: TurnEmit;
  /** Launcher kind recorded at open (sdk | pty | tmux | local). */
  launcher?: string;
  /** Injectable wall clock (test seam; defaults to Date.now). */
  now?: () => number;
  /** Injectable monotonic clock (test seam; defaults to process.hrtime.bigint). */
  monoNow?: () => bigint;
  /** Injectable id generator (test seam; defaults to randomUUID). */
  genId?: () => string;
  /** Sub D (#1666): injectable git probe (default: no-op `() => null`). The
   *  production probe is wired in `runClaude`. */
  gitProbe?: GitProbe;
}

export class TurnReporter {
  private current: OpenTurnState | null = null;
  private readonly emit: TurnEmit;
  private readonly launcher?: string;
  private readonly now: () => number;
  private readonly monoNow: () => bigint;
  private readonly genId: () => string;
  private readonly gitProbe: GitProbe;

  constructor(options: TurnReporterOptions) {
    this.emit = options.emit;
    this.launcher = options.launcher;
    this.now = options.now ?? Date.now;
    this.monoNow = options.monoNow ?? (() => process.hrtime.bigint());
    this.genId = options.genId ?? randomUUID;
    this.gitProbe = options.gitProbe ?? (() => null);
  }

  /**
   * Run the injected git probe under a fail-open guard (R9). A throwing or slow
   * probe degrades to `null` (no git fields emitted); it must never disturb the
   * turn path.
   */
  private safeProbe(cwd: string | undefined): GitSnapshot | null {
    try {
      return this.gitProbe(cwd);
    } catch {
      return null;
    }
  }

  /**
   * Open a turn (fired from the `UserPromptSubmit` hook). Captures the wall +
   * monotonic start and emits `turn:open`. A new open while a turn is already
   * tracked replaces it (the previous turn never finalized — the server's sweep
   * will orphan its row). Never throws (R8).
   */
  open(meta?: {
    ccSessionId?: string;
    cwd?: string;
    transcriptPath?: string;
  }): void {
    try {
      const turnLocalId = this.genId();
      const wallStartMs = this.now();
      this.current = {
        turnLocalId,
        wallStartMs,
        monoStartNs: this.monoNow(),
        meta: meta ?? {},
        finalized: false,
      };
      // Sub D (#1666, R2): snapshot the working-tree git state at turn-open.
      const git = this.safeProbe(meta?.cwd);
      this.emit({
        kind: "open",
        turnLocalId,
        startedAtMs: wallStartMs,
        ccSessionId: meta?.ccSessionId,
        launcher: this.launcher,
        cwd: meta?.cwd,
        transcriptPath: meta?.transcriptPath,
        gitShaStart: git?.sha ?? undefined,
        gitBranch: git?.branch ?? undefined,
        gitDirty: git?.dirty,
      });
    } catch {
      // R8: a turn-open failure must never surface to the session path.
      this.current = null;
    }
  }

  /**
   * Finalize the open turn with an outcome (fired from the `Stop` hook for
   * `completed`, or a launcher interrupt site for `interrupted` / `errored`).
   * Idempotent per turn (R7): the first finalize wins; a racing teardown/Stop is
   * a no-op. Duration is the monotonic delta (sleep-excluded; never multi-hour).
   * Never throws (R8).
   */
  finalize(
    outcome: TurnOutcome,
    meta?: { ccSessionId?: string; transcriptPath?: string }
  ): void {
    try {
      const turn = this.current;
      if (!turn || turn.finalized) return; // no open turn / already finalized
      turn.finalized = true;

      const endedAtMs = this.now();
      const monoEndNs = this.monoNow();
      const monoDeltaMs = Number((monoEndNs - turn.monoStartNs) / 1_000_000n);
      const wallDeltaMs = endedAtMs - turn.wallStartMs;
      const spansSleep = wallDeltaMs - monoDeltaMs > SLEEP_SKEW_THRESHOLD_MS;
      // Monotonic delta excludes host-sleep (R6). Fall back to a clamped wall
      // delta only if the monotonic clock somehow went backwards (never on a
      // healthy host); clamp at 0 so duration is never negative.
      const durationMs =
        monoDeltaMs >= 0 ? monoDeltaMs : Math.max(wallDeltaMs, 0);

      // Sub D (#1666, R3): snapshot the working-tree git state at turn-finalize,
      // probing the same cwd recorded at open.
      const git = this.safeProbe(turn.meta.cwd);
      this.emit({
        kind: "finalize",
        turnLocalId: turn.turnLocalId,
        outcome,
        endedAtMs,
        durationMs,
        spansSleep: spansSleep || undefined,
        ccSessionId: meta?.ccSessionId ?? turn.meta.ccSessionId,
        transcriptPath: meta?.transcriptPath ?? turn.meta.transcriptPath,
        gitShaEnd: git?.sha ?? undefined,
        gitDirty: git?.dirty,
      });
      this.current = null;
    } catch {
      // R8: a turn-finalize failure must never surface to the session path.
      this.current = null;
    }
  }

  /**
   * Whether a turn is currently open and not yet finalized. The launcher
   * interrupt sites consult this so they only finalize a genuinely-open turn
   * (and the idempotency guard above makes a double-call safe regardless).
   */
  hasOpenTurn(): boolean {
    return this.current !== null && !this.current.finalized;
  }
}
