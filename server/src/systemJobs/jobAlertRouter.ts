// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import type { JobFailureEvent } from "@hapi/protocol";

import type { ErrorLogger } from "../logging/errorLogger";
import type { PushService } from "../push/pushService";

/**
 * Durable, non-Toast failure alerting for supervised in-process loops
 * (issue #1964, Sub-Issue D — the "fail loudly" channel the user requested,
 * explicitly NOT a transient Toast).
 *
 * Consumes the `JobFailureEvent` stream from Sub-Issue C's (#1963) runtime job
 * registry — wired in `server/src/index.ts` via `JobRegistry.setEventSink`,
 * which already routes the same event to `ErrorLogger.warn`. This router ADDS
 * (does not replace) the user-facing durable channels:
 *   - Web Push via `pushService.sendToAll` (durable, lands on the device)
 *   - `notify-pm.sh` — the three-tier Telegram → AgentMail → gmail cascade
 *
 * Dedup: the supervised-loop primitive (#1963) already emits ONLY on the
 * `ok → stalled` transition (no per-tick spam — see `supervisedLoop.ts`). This
 * router adds a coarse per-`(node,name)` cooldown so a flapping loop
 * (`ok → stalled → ok → stalled`) cannot re-alert within `cooldownMs`. An `ok`
 * or `stopped` event clears the cooldown key so the next genuine stall alerts
 * promptly. Recovery is not separately announced — the System Jobs portal's live
 * red → green status is the recovery surface.
 *
 * Every send is fire-and-forget and absorbs its own failure: alerting must
 * NEVER throw into the registry's event sink or crash a supervised loop.
 */

const DEFAULT_COOLDOWN_MS = 5 * 60_000; // 5 minutes

export interface JobAlertRouterDeps {
  /** Web Push surface. Null/absent → push alerts are skipped (notify-pm still fires). */
  pushService?: Pick<PushService, "sendToAll"> | null;
  /** For recording send failures. */
  errorLogger?: ErrorLogger | null;
  /** Path to notify-pm.sh; defaults to `~/.claude/scripts/notify-pm.sh`. */
  notifyPmPath?: string;
  /** Injectable spawner (test seam). Defaults to a detached fire-and-forget spawn. */
  spawnFn?: (command: string, args: string[]) => void;
  /** Injectable clock (test seam). Defaults to `Date.now`. */
  now?: () => number;
  /** Per-`(node,name)` alert cooldown in ms (default 5 min). */
  cooldownMs?: number;
}

export class JobAlertRouter {
  private readonly pushService: Pick<PushService, "sendToAll"> | null;
  private readonly errorLogger: ErrorLogger | null;
  private readonly notifyPmPath: string;
  private readonly spawnFn: (command: string, args: string[]) => void;
  private readonly now: () => number;
  private readonly cooldownMs: number;
  /** `${node}\n${name}` → last-alerted epoch ms. */
  private readonly lastAlerted = new Map<string, number>();

  constructor(deps: JobAlertRouterDeps = {}) {
    this.pushService = deps.pushService ?? null;
    this.errorLogger = deps.errorLogger ?? null;
    this.notifyPmPath =
      deps.notifyPmPath ?? join(homedir(), ".claude/scripts/notify-pm.sh");
    this.spawnFn = deps.spawnFn ?? defaultSpawn;
    this.now = deps.now ?? Date.now;
    this.cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  /**
   * Route a failure event to the durable alert channels. Only `stalled`/`dead`
   * events alert (subject to the cooldown); `ok`/`stopped` clear the cooldown so
   * the next genuine stall re-alerts immediately. Never throws.
   */
  route(event: JobFailureEvent): void {
    const key = `${event.node}\n${event.name}`;

    if (event.status !== "stalled" && event.status !== "dead") {
      // Recovery / stop — clear the cooldown so a future stall alerts promptly.
      this.lastAlerted.delete(key);
      return;
    }

    const last = this.lastAlerted.get(key);
    if (last !== undefined && this.now() - last < this.cooldownMs) {
      return; // within cooldown — suppress flapping repeats
    }
    this.lastAlerted.set(key, this.now());

    const subject = `⚠️ Background job ${event.status}: ${event.name} (${event.node})`;
    const body =
      `Supervised loop "${event.name}" on node "${event.node}" is ${event.status}.\n` +
      `Last error: ${event.error ?? "no detail"}.\n` +
      `Surfaced in the System Jobs portal (/admin/system-jobs).`;

    // Web Push — durable, user-facing. Fire-and-forget; absorb failure.
    try {
      void Promise.resolve(
        this.pushService?.sendToAll({
          title: subject,
          body,
          tag: `job-alert-${event.node}-${event.name}`,
          data: { type: "job-alert", url: "/admin/system-jobs" },
        })
      ).catch(err => this.logSendFailure("push", err));
    } catch (err) {
      this.logSendFailure("push", err);
    }

    // notify-pm three-tier cascade. Fire-and-forget spawn; absorb failure.
    try {
      this.spawnFn(this.notifyPmPath, [subject, body]);
    } catch (err) {
      this.logSendFailure("notify-pm", err);
    }
  }

  private logSendFailure(channel: string, err: unknown): void {
    this.errorLogger?.warn(
      `JobAlertRouter ${channel} send failed: ${err instanceof Error ? err.message : String(err)}`,
      { category: "job-alert" }
    );
  }
}

/** Detached, fire-and-forget spawn that can never crash the caller (e.g. ENOENT). */
function defaultSpawn(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {
    // A missing notify-pm.sh (ENOENT) or spawn failure must not propagate.
  });
  child.unref();
}
