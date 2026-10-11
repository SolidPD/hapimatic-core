// SPDX-License-Identifier: AGPL-3.0-only
import type { QueueHealth } from "@hapi/protocol";

import type { GitHubWebhookConfig } from "../config/githubWebhookConfig";
import type { ErrorLogger } from "../logging/errorLogger";
import type { Store } from "../store";

/**
 * Skill-revamp 3.2 (#2157, epic rp1-home#1319) — the ARBITER between the push
 * queue and the poll fallback (R6, R8). It never rebuilds a poller: on a genuine
 * gap it triggers the EXISTING `WorkflowReconcileService` (`reconcileNow`).
 *
 * 🔴 R8 (the evidence-drift rule): this detector NEVER decides a gate. It only
 * decides WHICH ingestion path is trusted for FRESHNESS. The PM's gate decisions
 * still read the primary source (sub-issue 3.3). A queue event — or queue
 * silence — is a HINT, never the verdict.
 */

export interface GapDetectInput {
  /** Last verified webhook delivery for the repo (`webhook_health`), or null. */
  lastDeliveryAtMs: number | null;
  /**
   * Last time the webhook CONFIG was actively verified reachable — e.g. a
   * periodic `gh` webhook-config check, or a last-reconcile watermark. Distinct
   * from `lastDeliveryAtMs` on purpose: GitHub sends NO heartbeat deliveries, so
   * delivery silence is a QUIET-repo signal, not a fault. `null` = never verified.
   */
  lastConfigOkAtMs: number | null;
  now: number;
  /** The gap bound (ms) — `HAPI_PM_WEBHOOK_GAP_MS`. */
  gapMs: number;
  /** The webhook feature flag (R7). */
  enabled: boolean;
}

export interface GapVerdict {
  gapDetected: boolean;
  mode: "push" | "poll-fallback";
}

/**
 * PURE gap arbitration — table-testable, no I/O.
 *
 * 🔴 Distinguish webhooks-BROKEN from repo-QUIET. A repo can be silent for hours
 * with perfectly healthy webhooks (nobody touched an issue), so delivery silence
 * ALONE must NOT force permanent poll-fallback. The verdict:
 *   - feature off ⇒ `poll-fallback` (no push path exists; poll is the only path),
 *     but NOT a "gap" (nothing is broken — it's simply disabled).
 *   - a recent verified DELIVERY ⇒ webhooks provably work ⇒ `push`.
 *   - no recent delivery but a FRESH config-verified heartbeat ⇒ quiet repo,
 *     webhooks presumed healthy ⇒ `push` (the quiet-repo optimization).
 *   - no recent delivery AND the heartbeat is stale/never-verified ⇒ webhooks
 *     are genuinely broken ⇒ `poll-fallback` (the real R6 gap).
 */
export function detectGap(input: GapDetectInput): GapVerdict {
  if (!input.enabled) {
    return { gapDetected: false, mode: "poll-fallback" };
  }
  const deliveryFresh =
    input.lastDeliveryAtMs != null &&
    input.now - input.lastDeliveryAtMs <= input.gapMs;
  const heartbeatFresh =
    input.lastConfigOkAtMs != null &&
    input.now - input.lastConfigOkAtMs <= input.gapMs;

  if (deliveryFresh || heartbeatFresh) {
    return { gapDetected: false, mode: "push" };
  }
  return { gapDetected: true, mode: "poll-fallback" };
}

export interface WebhookGapDetectorDeps {
  config: GitHubWebhookConfig;
  getStore: () => Store | null;
  /**
   * Trigger the EXISTING reconcile poller for a repo (fail-open, async). Wired
   * to `WorkflowReconcileService.reconcileNow` in `index.ts`. The detector never
   * writes its own poller.
   */
  reconcile: (repo: string) => Promise<void>;
  errorLogger?: ErrorLogger | null;
  /** Injectable clock for deterministic tests. */
  getNow?: () => number;
}

/**
 * The stateful arbiter used by the drain endpoint. Reads `webhook_health` for a
 * repo's last delivery, arbitrates via {@link detectGap}, and — on a genuine gap
 * — FIRE-AND-FORGETS a reconcile (never awaited, so the drain response stays
 * cheap; R5's healthy no-op tick triggers NO poll because a healthy verdict has
 * no gap).
 */
export class WebhookGapDetector {
  private readonly configOkAtMs = new Map<string, number>();

  constructor(private readonly deps: WebhookGapDetectorDeps) {}

  private now(): number {
    return this.deps.getNow ? this.deps.getNow() : Date.now();
  }

  /**
   * Record that the webhook CONFIG for `repo` was actively verified reachable
   * (the config-verified heartbeat distinct from delivery arrival). The seam a
   * periodic `gh` webhook-config check calls; until that lands, the heartbeat
   * stays unset and {@link detectGap} arbitrates on delivery-freshness alone
   * (a quiet repo then reads as `poll-fallback` — SAFE, just not optimal; R8
   * means the extra poll never changes a gate outcome).
   */
  noteConfigVerified(repo: string, at: number = this.now()): void {
    this.configOkAtMs.set(repo, at);
  }

  /** The cheap, no-I/O queue-health verdict for `repo` (the drain endpoint reads this). */
  health(repo: string): QueueHealth {
    const store = this.deps.getStore();
    const lastDeliveryAtMs = store
      ? store.initiatives.getWebhookLastDeliveryMs(repo)
      : null;
    const verdict = detectGap({
      lastDeliveryAtMs,
      lastConfigOkAtMs: this.configOkAtMs.get(repo) ?? null,
      now: this.now(),
      gapMs: this.deps.config.gapMs,
      enabled: this.deps.config.enabled,
    });
    return {
      webhooksHealthy: verdict.mode === "push",
      lastDeliveryAtMs,
      gapDetected: verdict.gapDetected,
      mode: verdict.mode,
    };
  }

  /**
   * Compute the verdict AND, on a genuine gap, fire-and-forget a reconcile poll
   * (R6). Returns the verdict for the drain response. The reconcile is NOT
   * awaited — the drain stays fast (R5) and the fresh reconcile data lands for
   * the NEXT tick.
   */
  evaluate(repo: string): QueueHealth {
    const verdict = this.health(repo);
    if (verdict.gapDetected) {
      void this.deps.reconcile(repo).catch(err => {
        const msg = "[WebhookGapDetector] reconcile trigger failed";
        if (this.deps.errorLogger) {
          this.deps.errorLogger.warn(msg, {
            category: "webhook-gap-detector",
            stack: err instanceof Error ? err.stack : null,
            context: { repo },
          });
        } else {
          console.error(msg, err);
        }
      });
    }
    return verdict;
  }
}
