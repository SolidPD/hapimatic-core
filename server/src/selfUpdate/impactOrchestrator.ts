// SPDX-License-Identifier: AGPL-3.0-only
import { versionRangeKey, type UpdateSpan } from "@hapi/protocol";
import type { SyncEngine } from "../sync/syncEngine";
import type { Store } from "../store";
import type {
  ImpactAnalysisCoordinator,
  ActiveImpactAnalysis,
} from "../web/routes/impactArtifact";
import { buildSeedPrompt } from "./seedPromptBuilder";

/**
 * Impact-analysis orchestrator (issue #1772, Task 5). The state machine that
 * spawns ONE peer per in-flight `(node, harness, range)`, seeds it, and watches
 * for its POST-back — the correctness-heavy core.
 *
 * Data flow is one-way: `#1770 UpdateSpan → orchestrator → peer → submit
 * endpoint → store`. The orchestrator never parses the transcript (KD1) — the
 * peer POSTs to `/cli/impact-artifact` and the endpoint calls
 * `notifyArtifactSubmitted` to wake the watchdog.
 *
 * It IS the `ImpactAnalysisCoordinator` the submit endpoint depends on
 * (`getActiveAnalysisForSession` + `notifyArtifactSubmitted`).
 */

/** The outcome of TRIGGERING an analysis — returned promptly after spawn+seed,
 *  NOT after the (detached) watchdog completes. */
export type TriggerOutcome =
  | { status: "analyzing"; sessionId: string }
  | { status: "at_capacity" }
  | { status: "failed"; reason: string };

export interface OrchestratorDeps {
  engine: Pick<
    SyncEngine,
    | "spawnSession"
    | "sendMessage"
    | "archiveSession"
    | "getSession"
    | "getMachines"
  >;
  store: Store;
  /** `federationConfig?.nodeId ?? "standalone"` — the SAME value #1770's poll +
   *  the submit endpoint stamp (R4). */
  nodeId: string;
  /** Working directory the peer spawns into (a Hapimatic checkout so it can grep
   *  for evidence + run `gh issue list`). */
  repoRoot: string;
  /** The endpoint the seed prompt tells the peer to POST to. The peer resolves
   *  `$HAPI_SERVER_URL` from its own env, so this is the literal env-var form. */
  submitUrl: string;
  /** Watchdog window; a peer that has not POSTed a valid artifact by then is
   *  archived and the analysis fails (R7). */
  timeoutMs: number;
  /** Advisory capacity pre-check (R6 UX). Returns true iff at capacity, or null
   *  when the probe is unavailable (rely on the authoritative spawn `code`). */
  probeCapacity?: () => Promise<boolean | null>;
  /** Injectable clock for deterministic tests (default `Date.now`). Argless
   *  `Date.now`/`new Date` are unavailable in some sandboxes, so it is a dep. */
  now?: () => number;
  /** Injectable seed builder (default `buildSeedPrompt`) for tests. */
  buildSeed?: (span: UpdateSpan, opts: { submitUrl: string }) => string;
}

interface ActiveAnalysisState {
  key: string;
  sessionId: string;
  span: UpdateSpan;
  triggerTime: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Guards the notify/timeout race so an analysis settles exactly once. */
  settled: boolean;
}

export class ImpactOrchestrator implements ImpactAnalysisCoordinator {
  readonly nodeId: string;
  private readonly engine: OrchestratorDeps["engine"];
  private readonly store: Store;
  private readonly repoRoot: string;
  private readonly submitUrl: string;
  private readonly timeoutMs: number;
  private readonly probeCapacity?: () => Promise<boolean | null>;
  private readonly now: () => number;
  private readonly buildSeed: (
    span: UpdateSpan,
    opts: { submitUrl: string }
  ) => string;

  /** range-key → the spawn+seed trigger promise, so two concurrent triggers for
   *  one range dedup to ONE spawn (R1) during the spawn+wait window. */
  private readonly inFlightTriggers = new Map<
    string,
    Promise<TriggerOutcome>
  >();
  /** range-key → active (post-seed) analysis whose watchdog is running. */
  private readonly activeAnalyses = new Map<string, ActiveAnalysisState>();
  /** sessionId → range-key, for the coordinator lookups keyed by session. */
  private readonly sessionToRange = new Map<string, string>();
  /** range-key → last terminal non-success outcome (for status reporting). */
  private readonly lastOutcome = new Map<string, "failed" | "at_capacity">();

  constructor(deps: OrchestratorDeps) {
    this.engine = deps.engine;
    this.store = deps.store;
    this.nodeId = deps.nodeId;
    this.repoRoot = deps.repoRoot;
    this.submitUrl = deps.submitUrl;
    this.timeoutMs = deps.timeoutMs;
    this.probeCapacity = deps.probeCapacity;
    this.now = deps.now ?? (() => Date.now());
    this.buildSeed = deps.buildSeed ?? buildSeedPrompt;
  }

  private rangeKey(harnessId: string, from: string, to: string): string {
    // "|" separator — neither a harness id ([a-z0-9-]) nor a version contains it.
    return `${harnessId}|${versionRangeKey(from, to)}`;
  }

  /** True iff an analysis for this range is currently spawning or being watched. */
  isAnalyzing(harnessId: string, from: string, to: string): boolean {
    const key = this.rangeKey(harnessId, from, to);
    return this.inFlightTriggers.has(key) || this.activeAnalyses.has(key);
  }

  /** The last terminal non-success outcome for this range, or null. */
  lastTerminalOutcome(
    harnessId: string,
    from: string,
    to: string
  ): "failed" | "at_capacity" | null {
    return this.lastOutcome.get(this.rangeKey(harnessId, from, to)) ?? null;
  }

  /** Trigger an analysis. Returns after spawn+seed (analyzing) OR immediately on
   *  a capacity/spawn failure. The watchdog runs DETACHED — the caller (the
   *  /analyze route) must not block for `timeoutMs`. */
  async startAnalysis(span: UpdateSpan): Promise<TriggerOutcome> {
    const key = this.rangeKey(
      span.harness_id,
      span.from_version,
      span.to_version
    );

    // 0. Same-range in-flight guard (R1 — exactly ONE peer per range).
    const pendingTrigger = this.inFlightTriggers.get(key);
    if (pendingTrigger) return pendingTrigger;
    const active = this.activeAnalyses.get(key);
    if (active) {
      return { status: "analyzing", sessionId: active.sessionId };
    }

    const promise = this.doStartAnalysis(span, key);
    this.inFlightTriggers.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlightTriggers.delete(key);
    }
  }

  private async doStartAnalysis(
    span: UpdateSpan,
    key: string
  ): Promise<TriggerOutcome> {
    // 1. Advisory capacity pre-check (R6 UX — avoid a doomed spawn).
    if (this.probeCapacity) {
      const atCap = await this.probeCapacity();
      if (atCap === true) {
        this.lastOutcome.set(key, "at_capacity");
        return { status: "at_capacity" };
      }
    }

    // 3. Spawn ONE peer on the local machine (v1: local node only).
    const machineId = this.engine.getMachines().find(m => m.active)?.id;
    if (!machineId) {
      this.lastOutcome.set(key, "failed");
      return { status: "failed", reason: "No machines online" };
    }

    const spawn = await this.engine.spawnSession({
      machineId,
      directory: this.repoRoot,
      yolo: true,
      claimPort: false,
      sessionType: "simple",
      name: `impact ${versionRangeKey(span.from_version, span.to_version)}`,
    });
    if (spawn.type === "error") {
      // Authoritative capacity classifier (Task 6). A generic error → failed.
      const outcome: "failed" | "at_capacity" =
        spawn.code === "at_capacity" ? "at_capacity" : "failed";
      this.lastOutcome.set(key, outcome);
      return outcome === "at_capacity"
        ? { status: "at_capacity" }
        : { status: "failed", reason: spawn.message };
    }
    const sessionId = spawn.sessionId;

    // 2. Register the active analysis BEFORE seeding — the peer POSTs only after
    //    it receives the seed, and the submit endpoint validates against this.
    this.sessionToRange.set(sessionId, key);

    // 4. Wait active, then send the seed prompt.
    try {
      await this.waitForSessionActive(sessionId);
      await this.engine.sendMessage(sessionId, {
        text: this.buildSeed(span, { submitUrl: this.submitUrl }),
        // #3124: programmatic self-update impact-analysis seed prompt (was
        // mislabeled "webapp"). Bypasses UserPromptSubmit-class message hooks —
        // this is a system-generated seed, not a user's intent-bearing prompt.
        sentFrom: "self-update",
      });
    } catch (err) {
      // Seeding failed — treat like a timed-out peer: archive + clean up.
      this.sessionToRange.delete(sessionId);
      await this.archiveQuietly(sessionId);
      this.lastOutcome.set(key, "failed");
      return {
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    // Register the watchdog state + launch the DETACHED watchdog (5).
    const state: ActiveAnalysisState = {
      key,
      sessionId,
      span,
      triggerTime: this.now(),
      timer: null,
      settled: false,
    };
    this.activeAnalyses.set(key, state);
    this.lastOutcome.delete(key); // a fresh attempt clears any prior terminal outcome
    state.timer = setTimeout(() => {
      void this.onTimeout(state);
    }, this.timeoutMs);

    return { status: "analyzing", sessionId };
  }

  /**
   * Watchdog timeout (R7): the peer never POSTed a valid artifact. Archive the
   * zombie FIRST so its cap slot is reclaimed and a retry can spawn cleanly, THEN
   * clear the registration, THEN record `failed`. A late POST from the archived
   * peer is rejected by the submit endpoint's active-analysis check (cleared).
   */
  private async onTimeout(state: ActiveAnalysisState): Promise<void> {
    if (state.settled) return;
    state.settled = true;
    await this.archiveQuietly(state.sessionId);
    this.clearRegistration(state);
    this.lastOutcome.set(state.key, "failed");
  }

  /** Called by the submit endpoint after a valid artifact is persisted. Wakes
   *  the watchdog for a SUCCESSFUL completion (the companion is NOT archived —
   *  it stays active for Q&A, KD5). */
  notifyArtifactSubmitted(sessionId: string): void {
    const key = this.sessionToRange.get(sessionId);
    if (!key) return;
    const state = this.activeAnalyses.get(key);
    if (!state || state.settled) return;
    // Completion signal: a row for this range now carries THIS session's id. The
    // freshly-spawned sessionId is a unique UUID, so a row bearing it cannot be
    // the stale pre-existing row (which held a different, older sid) — this is a
    // stronger, clock-independent refinement of the directive's `analyzed_at >
    // trigger_time AND peer_session_id === sid` predicate (which risks a false
    // FAILURE if the peer LLM mis-stamps analyzed_at). See #1772 handoff.
    const row = this.store.impactAnalysis.getByRange(
      this.nodeId,
      state.span.harness_id,
      state.span.from_version,
      state.span.to_version
    );
    if (!row || row.peer_session_id !== sessionId) return;
    state.settled = true;
    if (state.timer) clearTimeout(state.timer);
    this.clearRegistration(state);
    this.lastOutcome.delete(state.key); // success → status reads the stored row as "ready"
    // NOTE (KD5): do NOT archive — a successful companion stays active for Q&A
    // through #1772; archive-after-update is #1774's job.
  }

  // ── ImpactAnalysisCoordinator ────────────────────────────────

  getActiveAnalysisForSession(sessionId: string): ActiveImpactAnalysis | null {
    const key = this.sessionToRange.get(sessionId);
    if (!key) return null;
    const state = this.activeAnalyses.get(key);
    return state ? { seedSpan: state.span } : null;
  }

  // ── internals ────────────────────────────────────────────────

  private clearRegistration(state: ActiveAnalysisState): void {
    this.activeAnalyses.delete(state.key);
    this.sessionToRange.delete(state.sessionId);
  }

  private async archiveQuietly(sessionId: string): Promise<void> {
    try {
      await this.engine.archiveSession(sessionId, { reapRemoteWindow: true });
    } catch {
      // best-effort — a failed archive must not throw out of the watchdog.
    }
  }

  private async waitForSessionActive(sessionId: string): Promise<void> {
    const deadline = this.now() + SESSION_ACTIVE_TIMEOUT_MS;
    let interval = SESSION_POLL_INTERVAL_MS;
    while (this.now() < deadline) {
      if (this.engine.getSession(sessionId)?.active) return;
      await new Promise(resolve => setTimeout(resolve, interval));
      interval = Math.min(interval * 2, 5000);
    }
    throw new Error(
      `Impact peer ${sessionId} did not become active within ${SESSION_ACTIVE_TIMEOUT_MS}ms`
    );
  }
}

const SESSION_ACTIVE_TIMEOUT_MS = 60_000;
const SESSION_POLL_INTERVAL_MS = 250;
