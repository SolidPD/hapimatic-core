// SPDX-License-Identifier: AGPL-3.0-only
import { SupervisedLoop, type JobRegistry } from "@hapi/protocol";
import type {
  HarnessRegistry,
  HarnessDescriptor,
  HarnessDetectionState,
  RedactedHarnessDescriptor,
} from "@hapi/protocol";
import type { Store } from "../store";
import {
  type HarnessPollConfig,
  loadHarnessPollConfig,
  saveHarnessPollConfig,
} from "../config/harnessPollConfig";
import type { ErrorLogger } from "../logging/errorLogger";
import { toRedactedHarnessDescriptor } from "./registry";
import {
  detectInstalledVersion,
  fetchLatestVersion,
  fetchChangelog,
  computeUpdateAvailable,
} from "./detection";

/**
 * The web-facing harness-detection status: one entry per registry descriptor,
 * each pairing the REDACTED descriptor (no privileged commands) with its
 * persisted state (or null before the first poll). This is the shape both
 * `GET /api/harness/status` and `POST /api/harness/check` return.
 */
export interface HarnessStatusResponse {
  node_id: string;
  harnesses: Array<{
    descriptor: RedactedHarnessDescriptor;
    state: HarnessDetectionState | null;
  }>;
}

interface HarnessPollServiceDeps {
  store: Store;
  registry: HarnessRegistry;
  config: HarnessPollConfig;
  /** #1775: the data dir whose settings.json holds the `harnessPoll` config.
   *  Threaded via deps (not the global `configuration` singleton the watchdog
   *  uses) so `updateConfig()` re-reads fresh + `setPollConfig()` persists — and
   *  so both stay unit-testable against a temp settings dir. */
  dataDir: string;
  nodeId: string;
  claudePath?: string;
  errorLogger?: ErrorLogger | null;
}

/**
 * Server-side daily harness-detection poll (issue #1770). Scheduling is owned
 * entirely by the shared `SupervisedLoop` (finally-reschedule, tick no-overlap,
 * stall watchdog, System Jobs portal row, job-death alerts) — there is NO
 * hand-rolled timer or `setInterval` here.
 *
 * KD-8: `detectNow()` is the single detection core, called by BOTH the loop tick
 * and the "check now" route. An `inFlight` boolean guards manual-vs-tick overlap
 * (SupervisedLoop already prevents tick self-overlap). Manual checks do NOT use
 * `loop.triggerNow()` — it no-ops when the loop is not running, which would break
 * "check now" while the daily poll is disabled.
 *
 * KD-9: the loop is constructed with `enabled: config.enabled` and `start()` is
 * called UNCONDITIONALLY — when disabled it registers a `"stopped"` job row and
 * never ticks, but the service is still constructed and `detectNow()` still
 * works, so "check now" (R7) functions with the daily poll disabled.
 *
 * R5: `detectNow`/`detectOne` never throw — a failed detection is recorded as
 * state (`last_error`), so a tick never trips the loop's death handling.
 */
export class HarnessPollService {
  private readonly store: Store;
  private readonly registry: HarnessRegistry;
  private config: HarnessPollConfig;
  private readonly dataDir: string;
  private readonly nodeId: string;
  private readonly claudePath?: string;
  private readonly errorLogger: ErrorLogger | null;
  private readonly loop: SupervisedLoop;
  private inFlight = false;
  /** #1775: whether the poll loop is actively ticking. Drives the enable/disable
   *  and cadence-re-arm decisions in updateConfig(). */
  private running = false;

  constructor(
    deps: HarnessPollServiceDeps,
    jobOpts?: { node?: string; jobRegistry?: JobRegistry | null }
  ) {
    this.store = deps.store;
    this.registry = deps.registry;
    this.config = deps.config;
    this.dataDir = deps.dataDir;
    this.nodeId = deps.nodeId;
    this.claudePath = deps.claudePath;
    this.errorLogger = deps.errorLogger ?? null;

    this.loop = new SupervisedLoop({
      name: "harness-poll",
      node: jobOpts?.node ?? "standalone",
      intervalMs: this.config.pollIntervalMs,
      // Re-read live config so a runtime interval change (via #1775) takes
      // effect on the next reschedule.
      getIntervalMs: () => this.config.pollIntervalMs,
      // Run the first detection at start() (non-blocking void tick) so boot is
      // not slowed and the admin drawer has data on first load — and so there is
      // no second untracked bootstrap timer for stop() to miss.
      immediate: true,
      enabled: this.config.enabled,
      registry: jobOpts?.jobRegistry ?? undefined,
      // Wrap so the tick returns Promise<void>: detectNow now returns a coalesce
      // flag for #1775's "check now" route, which the loop tick discards.
      tick: async () => {
        await this.detectNow();
      },
    });
  }

  /** Start the poll. Called UNCONDITIONALLY (KD-9): a disabled loop registers a
   *  `"stopped"` job row and stays visible in the System Jobs portal. */
  start(): void {
    this.loop.start();
    // #1775: a loop built with enabled:false registers a "stopped" row and never
    // arms (KD-9), so `running` reflects config.enabled — not merely that start()
    // was called. Drives updateConfig()'s transition decisions.
    this.running = this.config.enabled;
  }

  /** Stop the poll (clears the loop's tick + watchdog timers, marks the row
   *  `"stopped"`). */
  stop(): void {
    this.loop.stop();
    this.running = false;
  }

  /** Snapshot of the live config (#1775) — what the settings surface displays
   *  (R5) and the read-back after a mutation. In-memory tracks on-disk truth
   *  because updateConfig() re-reads on every change. */
  getConfig(): HarnessPollConfig {
    return { ...this.config };
  }

  /**
   * Apply a config change at runtime (#1775, R1/R3). Re-reads config FRESH from
   * disk (ignoring the argument, mirroring the watchdog template — the route
   * saves first, so disk is the just-persisted truth), then reconciles:
   *   - enable/disable transition → start()/stop();
   *   - cadence change while running → RESTART the loop so the next tick arms
   *     with the new interval (KD-6, in-path bug #1). `SupervisedLoop` reads
   *     `getIntervalMs()` only when ARMING the next tick, so an already-armed
   *     tick keeps the OLD delay — without this restart, R3 fails. The
   *     stall-watchdog's own updateConfig OMITS this restart; #1775 must not copy
   *     that bug.
   */
  async updateConfig(_updates?: Partial<HarnessPollConfig>): Promise<void> {
    const old = this.config;
    this.config = await loadHarnessPollConfig(this.dataDir);

    if (this.config.enabled && !this.running) {
      // Enable transition. Caveat (inherited from #1770's constructor-frozen
      // loop, KD-6): a loop BUILT with enabled:false at boot cannot be armed at
      // runtime — this start() is a no-op in the narrow booted-disabled →
      // runtime-enable case. The v1 cadence-only UI never triggers it; a full
      // fix belongs to #1770's loop design (out of #1775's scope).
      this.start();
    } else if (!this.config.enabled && this.running) {
      this.stop();
    } else if (
      this.running &&
      this.config.pollIntervalMs !== old.pollIntervalMs
    ) {
      // Cadence changed while running → re-arm at the new interval (KD-6/R3).
      // Use the loop directly (not this.stop()/start()) so `running` stays true
      // throughout. Note: #1770's loop is immediate:true, so this restart also
      // fires one immediate (benign, read-only, bounded) re-detection.
      this.loop.stop();
      this.loop.start();
    }
  }

  /**
   * Persist a cadence/enable change, then apply it live without a server restart
   * (#1775, R2/R3). Returns the resolved on-disk config (save-then-read-back —
   * the response reflects exactly what will run, including any minimum clamp).
   */
  async setPollConfig(
    updates: Partial<HarnessPollConfig>
  ): Promise<HarnessPollConfig> {
    await saveHarnessPollConfig(this.dataDir, updates);
    await this.updateConfig();
    return this.getConfig();
  }

  /**
   * The shared detection core (KD-8) — PUBLIC, called by the loop tick AND the
   * "check now" route. Runs each registry entry (or the one matching
   * `harnessId`) through the detection steps and persists the result. Works
   * regardless of loop state (KD-9). Never throws (R5).
   */
  async detectNow(harnessId?: string): Promise<{ coalesced: boolean }> {
    // Guard manual-vs-tick overlap (SupervisedLoop already guards tick-vs-tick).
    // A manual "check now" that arrives mid-detection COALESCES onto the running
    // pass (#1775 R4) rather than running a redundant one — the caller surfaces
    // this so the UI can say "a check is already running" instead of implying a
    // fresh result with an unchanged last-checked timestamp.
    if (this.inFlight) return { coalesced: true };
    this.inFlight = true;
    try {
      const targets = harnessId
        ? this.registry.filter(d => d.id === harnessId)
        : this.registry;
      for (const descriptor of targets) {
        await this.detectOne(descriptor);
      }
      return { coalesced: false };
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * The current web-facing status: the redacted descriptor + persisted state for
   * every registry entry. Redaction happens HERE (server-side, next to the
   * registry) so the route cannot accidentally leak a command (R6), and the
   * state getters never carry `changelog_text`.
   */
  getStatus(): HarnessStatusResponse {
    return {
      node_id: this.nodeId,
      harnesses: this.registry.map(descriptor => ({
        descriptor: toRedactedHarnessDescriptor(descriptor),
        state: this.store.harness.getDetectionState(this.nodeId, descriptor.id),
      })),
    };
  }

  /** Detect one harness and persist its state. Total + non-throwing (R5). */
  private async detectOne(descriptor: HarnessDescriptor): Promise<void> {
    const now = Date.now();
    try {
      const installed = await detectInstalledVersion(descriptor, {
        claudePath: this.claudePath,
      });
      const latest = await fetchLatestVersion(descriptor);
      const changelog = await fetchChangelog(descriptor);

      const errors: string[] = [];
      if (installed === null) errors.push("installed version undetected");
      if (latest === null) errors.push("latest version fetch failed");
      if (changelog === null) errors.push("changelog fetch failed");
      const lastError = errors.length > 0 ? errors.join("; ") : null;

      this.store.harness.upsertDetectionState({
        node_id: this.nodeId,
        harness_id: descriptor.id,
        installed_version: installed,
        latest_version: latest,
        update_available: computeUpdateAvailable(installed, latest),
        // Preserve the last-good cached changelog when this fetch failed, so a
        // transient error does not blank #1771's changelog (Fallback Preservation).
        changelog_text:
          changelog ??
          this.store.harness.getChangelogText(this.nodeId, descriptor.id),
        last_checked_at: now,
        last_error: lastError,
        last_error_at: lastError ? now : null,
      });

      if (lastError) {
        this.errorLogger?.warn(
          `[harness-poll] ${descriptor.id}: ${lastError}`,
          {
            category: "harness-poll",
          }
        );
      }
    } catch (err) {
      // Defense-in-depth (R5): the detect helpers already swallow their own
      // errors; this catches an unexpected throw (e.g. a store failure) so a
      // tick never dies. Record what we can.
      const message = err instanceof Error ? err.message : String(err);
      this.errorLogger?.error(
        `[harness-poll] ${descriptor.id} detection failed: ${message}`,
        { category: "harness-poll" }
      );
      try {
        this.store.harness.upsertDetectionState({
          node_id: this.nodeId,
          harness_id: descriptor.id,
          installed_version: null,
          latest_version: null,
          update_available: false,
          changelog_text: this.store.harness.getChangelogText(
            this.nodeId,
            descriptor.id
          ),
          last_checked_at: now,
          last_error: message,
          last_error_at: now,
        });
      } catch {
        // The store itself is broken — nothing more we can safely do.
      }
    }
  }
}
