// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Session } from "@hapi/protocol";
import { SupervisedLoop, type JobRegistry } from "@hapi/protocol";
import type { ErrorLogger } from "../logging/errorLogger";
import { readJobState } from "./updateJobState";

/**
 * Server-side deferred-apply for the session-aware update flow (issue #2589,
 * epic #2586 Sub-Issue G).
 *
 * "Update when idle" writes a `<dataDir>/staged-update/deferred.json` marker (the
 * same fail-safe file pattern as `marker.json` in `web/routes/update.ts`). A
 * {@link DeferredApplyWatcher} — a `SupervisedLoop` poller modelled on
 * `contextWatermarkService.ts` — fires the SAME apply the "Update now" path uses
 * (`launchUpdater`, injected) the moment no session is thinking, then clears the
 * marker. Because the state lives on disk, the deferral survives BOTH the browser
 * tab closing AND the server restarting (the watcher resumes from the marker on
 * boot — there is no in-memory hydrate: the marker IS the state).
 *
 * This module is PURE of the update route and the scheduler: the apply, the
 * availability read, the session source, and the R4 nudge are all INJECTED. That
 * keeps `web/routes/update.ts → this module` a one-way dependency (no cycle) and
 * makes the watcher hermetically testable — a test injects spies and drives
 * {@link DeferredApplyWatcher.tick} directly, exactly like
 * `ContextWatermarkService.runPollTick`.
 */

const DEFERRAL_DIR = "staged-update";
const DEFERRAL_FILE = "deferred.json";

/** Default poll cadence — the residual idle→apply race window is bounded by this. */
const DEFAULT_POLL_INTERVAL_MS = 30_000;
/** Default "still waiting" nudge threshold (R4) — 6 hours pending. */
const DEFAULT_NUDGE_AFTER_MS = 6 * 60 * 60 * 1000;

/** The persisted "apply when idle" request. */
export interface DeferralRecord {
  mode: "when-idle";
  /** ISO 8601 — when the deferral was requested (drives the R4 nudge age). */
  requestedAt: string;
  /** JWT namespace of the requester — scopes the R4 nudge task. */
  requestedBy?: string;
  /** Project directory captured for the scheduler nudge task. */
  projectDirectory?: string;
  /**
   * ISO 8601 — set once the R4 nudge has fired. Persisted (not in-memory) so the
   * nudge is idempotent ACROSS a server restart: a resumed watcher never re-nudges.
   */
  nudgedAt?: string | null;
}

function deferralPath(dataDir: string): string {
  return path.join(dataDir, DEFERRAL_DIR, DEFERRAL_FILE);
}

/**
 * Read the deferral marker. Returns null on missing/malformed (fail-safe — a
 * corrupt marker must never strand a phantom pending state). Mirrors `readMarker`.
 */
export function readDeferral(dataDir: string): DeferralRecord | null {
  try {
    const raw = readFileSync(deferralPath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<DeferralRecord>;
    if (parsed.mode !== "when-idle" || typeof parsed.requestedAt !== "string") {
      return null;
    }
    return parsed as DeferralRecord;
  } catch {
    return null;
  }
}

/** Write (or overwrite) the deferral marker. */
export function writeDeferral(dataDir: string, rec: DeferralRecord): void {
  const dir = path.join(dataDir, DEFERRAL_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(deferralPath(dataDir), JSON.stringify(rec, null, 2));
}

/** Remove the deferral marker. Best-effort — a missing file is the desired state. */
export function clearDeferral(dataDir: string): void {
  try {
    rmSync(deferralPath(dataDir), { force: true });
  } catch {
    // best-effort: the end state is "no marker", which is already true on error
  }
}

/**
 * A session that GENUINELY blocks the deferred apply: mid-inference, not a stuck
 * flag (issue #3735). The old gate relied on the `thinking ⇒ active` invariant and
 * counted a raw `thinking` flag — but that flag can be stuck `true` on a session
 * that is NOT actually inferring, which wedges the apply forever:
 *   - `blockedOnTuiPrompt` (#1653): a tmux/pty permission prompt renders only in the
 *     terminal; the web shows perpetual "thinking".
 *   - `rateLimited` (#1647): a 429 session-limit aborts the turn but fires NO Stop
 *     hook under tmux/pty, so `thinking` stays true forever.
 *   - a non-active record (defensive; the {@link DeferredApplyWatcherDeps.getActiveSessions}
 *     source already excludes these, but the `active` check keeps the predicate
 *     self-contained/testable over any session list).
 * Excluding these classes can NEVER interrupt a real turn — a genuinely mid-response
 * session is active, not tui-blocked, and not rate-limited (the core regression guard,
 * #3735 R7). This is the SINGLE source of truth for both the gate and the badge's
 * displayed `blocking` count, so displayed == gate by construction (#3735 R2).
 */
export function isBlockingThinking(s: Session): boolean {
  return (
    s.thinking === true &&
    (s.active ?? true) &&
    !s.blockedOnTuiPrompt &&
    !s.rateLimited
  );
}

/** Context passed to the injected R4 nudge sink. */
export interface DeferredNudgeContext {
  requestedAt: string;
  ageMs: number;
  namespace?: string;
  projectDirectory?: string;
  machineName?: string;
}

export interface DeferredApplyWatcherDeps {
  /** Instance data dir (HAPI_HOME) — where `staged-update/deferred.json` lives. */
  dataDir: string;
  /**
   * Node-local ACTIVE sessions (`syncEngine.getActiveSessions` — the #1477
   * history-deflated set the badge's `computeSessionImpact` also uses). The gate
   * no longer RELIES on the `thinking ⇒ active` invariant (issue #3735: a
   * disconnected / tui-blocked / rate-limited record can leave `thinking` stuck
   * true); it counts blocking sessions via {@link isBlockingThinking}, which
   * excludes the documented not-actually-inferring classes.
   */
  getActiveSessions: () => Session[];
  /**
   * Fresh availability read — is a newer version staged? Read the marker
   * directly (NOT the route's 5-min cache) so the lifecycle-closure check is live.
   */
  isUpdateAvailable: () => boolean;
  /**
   * The apply — byte-identical to the "Update now" path (bind to `launchUpdater`
   * with the resolved launcher config in index.ts).
   */
  applyUpdate: () => Promise<{ ok: boolean; exitCode: number; unit: string }>;
  /**
   * R4 "still waiting after N hours" nudge sink (default wired to
   * `SchedulerService.createTask` in index.ts). Best-effort; may be omitted.
   */
  onNudge?: (ctx: DeferredNudgeContext) => void | Promise<void>;
  /** Instance machine name, surfaced in the nudge context. */
  machineName?: string;
  errorLogger?: ErrorLogger | null;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Poll cadence (default 30s). */
  pollIntervalMs?: number;
  /** Nudge threshold (default 6h). */
  nudgeAfterMs?: number;
  jobRegistry?: JobRegistry | null;
  node?: string;
}

/**
 * Polls for a pending "apply when idle" deferral and fires the apply the moment
 * no session is thinking. Self-healing via {@link SupervisedLoop}; resumes from
 * the disk marker on boot (a restart mid-deferral loses nothing).
 */
export class DeferredApplyWatcher {
  private readonly deps: DeferredApplyWatcherDeps;
  private readonly now: () => number;
  private readonly nudgeAfterMs: number;
  private readonly loop: SupervisedLoop;

  constructor(deps: DeferredApplyWatcherDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.nudgeAfterMs = deps.nudgeAfterMs ?? DEFAULT_NUDGE_AFTER_MS;
    this.loop = new SupervisedLoop({
      name: "deferred-update-apply",
      node: deps.node ?? "standalone",
      intervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      immediate: false,
      registry: deps.jobRegistry ?? undefined,
      now: this.now,
      tick: () => this.tick(),
    });
  }

  /** Start polling. A pending on-disk deferral is picked up by the first tick. */
  start(): void {
    this.loop.start();
  }

  /** Stop polling. Idempotent. */
  stop(): void {
    this.loop.stop();
  }

  /** Registry-row status (for tests / health surfacing). */
  getStatus(): string {
    return this.loop.getStatus();
  }

  /**
   * One evaluation. Public so tests drive it deterministically without real
   * timers. Never throws out — a throw is caught by the SupervisedLoop and the
   * loop keeps ticking; but this method itself degrades safe on every branch
   * (a session-read failure leaves the deferral pending, never force-applies).
   */
  async tick(): Promise<void> {
    const { dataDir } = this.deps;
    const deferral = readDeferral(dataDir);
    if (!deferral) return; // nothing pending

    // #3057: the durable job state — NOT an accepted systemd-run launch — owns
    // completion. A prior tick launched apply-only (`systemd-run` returned 202
    // immediately); the shell then writes `applying`, then `succeeded`/`failed`.
    // We read that state fresh each tick (fail-safe file read, like readDeferral).
    const job = readJobState(dataDir);

    // Terminal phase → the deferred apply concluded (succeeded, or failed/rolled
    // back). Clear the deferral (and its dead R4 nudge) — do NOT leave a phantom
    // "pending" once the apply has resolved (#3057 R6; finding 2589-3).
    if (job && (job.phase === "succeeded" || job.phase === "failed")) {
      clearDeferral(dataDir);
      this.deps.errorLogger?.info?.(
        `[DeferredApply] cleared deferral — apply reached terminal phase '${job.phase}'`,
        { category: "update" }
      );
      return;
    }

    // Lifecycle closure (finding 2589-3): an "Update now" or a rollback consumed
    // the staged marker (update-hapimatic.sh removes it on apply/rollback), so
    // this deferral can never become satisfiable. Clear it — and its dead nudge —
    // rather than leave a phantom "pending" state in the UI forever.
    if (!this.safeIsUpdateAvailable()) {
      clearDeferral(dataDir);
      this.deps.errorLogger?.info?.(
        "[DeferredApply] cleared stale deferral (no update staged)",
        { category: "update" }
      );
      return;
    }

    let thinking: number;
    try {
      thinking = this.deps
        .getActiveSessions()
        .filter(isBlockingThinking).length;
    } catch (err) {
      // A session-source failure must NEVER force an apply — leave the deferral
      // pending and retry next tick (degrade safe, R6).
      this.deps.errorLogger?.warn?.(
        "[DeferredApply] session read failed; leaving deferral pending",
        { category: "update", context: { error: errMsg(err) } }
      );
      return;
    }

    if (thinking === 0) {
      // The deferred apply is an `--apply-only`, which requires a `ready` staged
      // record for the current target. Only launch when the job is `ready` — if
      // it is `applying` (an apply already in flight), null, or not-ready, launching
      // again would either overlap (the shell's flock refuses) or spin every tick
      // for nothing. In the normal flow a deferral is only created once `ready`, so
      // any other phase here is transient (applying) or defensive; the R4 nudge
      // still covers a genuinely stuck deferral.
      if (!job || job.phase !== "ready") return;

      // Race guard (OR1): re-read thinking immediately before firing. A turn
      // could begin between the check above and the launch; the residual window
      // is bounded by the poll cadence.
      let recheck: number;
      try {
        recheck = this.deps
          .getActiveSessions()
          .filter(isBlockingThinking).length;
      } catch {
        return; // read failed on re-check → do not fire
      }
      if (recheck !== 0) return; // a session started thinking → keep waiting

      let result: { ok: boolean; exitCode: number; unit: string };
      try {
        result = await this.deps.applyUpdate();
      } catch (err) {
        this.deps.errorLogger?.error?.(
          "[DeferredApply] apply threw; leaving deferral pending",
          { category: "update", context: { error: errMsg(err) } }
        );
        return; // leave pending → retry next tick
      }
      // #3057: DO NOT clear the deferral here. `systemd-run` accepting the
      // detached apply-only is not completion — the shell has yet to swap,
      // restart, and health-check. The terminal-phase check at the top of the
      // NEXT tick (or the lifecycle closure once the marker is consumed) clears
      // the deferral. A launch failure (result.ok=false) likewise leaves it
      // pending for a later retry.
      if (result.ok) {
        this.deps.errorLogger?.info?.(
          `[DeferredApply] deferred apply-only launched (unit ${result.unit}); awaiting terminal job state`,
          { category: "update" }
        );
      } else {
        this.deps.errorLogger?.error?.(
          `[DeferredApply] deferred launch failed (exit ${result.exitCode}); leaving deferral pending`,
          { category: "update" }
        );
      }
      return;
    }

    // Sessions are still thinking → keep waiting. Fire the R4 nudge once after N
    // hours so a never-idle deferral does not wait forever silently.
    await this.maybeNudge(deferral);
  }

  private safeIsUpdateAvailable(): boolean {
    try {
      return this.deps.isUpdateAvailable();
    } catch {
      // If we cannot read availability, assume still-available (do NOT clear a
      // deferral we cannot prove is stale).
      return true;
    }
  }

  private async maybeNudge(deferral: DeferralRecord): Promise<void> {
    if (deferral.nudgedAt) return; // already nudged — idempotent across restart
    const age = this.now() - Date.parse(deferral.requestedAt);
    if (!Number.isFinite(age) || age < this.nudgeAfterMs) return;

    try {
      await this.deps.onNudge?.({
        requestedAt: deferral.requestedAt,
        ageMs: age,
        namespace: deferral.requestedBy,
        projectDirectory: deferral.projectDirectory,
        machineName: this.deps.machineName,
      });
    } catch (err) {
      this.deps.errorLogger?.warn?.("[DeferredApply] nudge sink failed", {
        category: "update",
        context: { error: errMsg(err) },
      });
    }

    // Persist nudgedAt regardless of the sink's outcome — a best-effort nudge
    // must never re-spam every tick after the threshold is crossed.
    writeDeferral(this.deps.dataDir, {
      ...deferral,
      nudgedAt: new Date(this.now()).toISOString(),
    });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
