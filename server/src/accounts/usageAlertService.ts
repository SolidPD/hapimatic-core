// SPDX-License-Identifier: AGPL-3.0-only
import type { AccountUsage, UsageLimitKey } from "@hapi/protocol";
import type { PushPayload } from "../push/pushService";
import {
  NO_RESET_WINDOW,
  type UsageAlertStore,
} from "../store/usageAlertStore";
import type { ErrorLogger } from "../logging/errorLogger";

/**
 * Usage-threshold push-alert service (epic #1855, Sub-Issue H / #1863).
 *
 * Consumes the `AccountUsage[]` the `UsageSampler` already fetches on its
 * periodic cadence and fires a de-duped web-push notification when an `ok`
 * account crosses a configured utilization threshold (default 80/90) on any of
 * the four named limits. De-dupe is per (accountUuid, limitKey, threshold,
 * reset-window) via the `UsageAlertStore` — each threshold alerts at most once
 * per reset window per limit, and one sample sends at most one notification
 * per limit: the highest newly crossed threshold, with every crossed threshold
 * recorded so a lower one never fires later in the same window (#4836 — the
 * original #1863 behavior sent one push per crossed threshold). Usage that
 * climbs within a window still alerts once per threshold (85% then 92% sends
 * 80%+ and later 90%+). It never re-fires after a
 * server restart within the same window. Reuses the existing
 * `PushService.sendToAll` transport (usage is account-global → every subscribed
 * device). This is a PURE consumer of an already-fetched usage list — it does
 * NOT fetch upstream itself; the sampler owns the single `oauth/usage` call.
 */

/** The four user-facing limits the issue alerts on (excludes seven_day_oauth_apps). */
export const ALERT_LIMIT_KEYS: readonly UsageLimitKey[] = [
  "five_hour",
  "seven_day",
  "seven_day_sonnet",
  "seven_day_opus",
];

/** Friendly labels for the notification text. */
const LIMIT_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly (all models)",
  seven_day_sonnet: "Weekly Sonnet",
  seven_day_opus: "Weekly Opus",
};

/** Minimal push surface the alert service needs (test seam — `PushService` satisfies it). */
export interface UsageAlertNotifier {
  sendToAll(payload: PushPayload): Promise<void>;
}

export interface UsageAlertServiceOptions {
  store: UsageAlertStore;
  pushService: UsageAlertNotifier;
  /** Crossing thresholds (0–100). Defaults to [80, 90]; sorted ascending on construction. */
  thresholds?: number[];
  /** Master enable. Defaults to true; false makes `checkAndNotify` a no-op. */
  enabled?: boolean;
  /** Clock seam (test seam). Defaults to `Date.now`. */
  now?: () => number;
  errorLogger?: ErrorLogger | null;
}

export class UsageAlertService {
  private readonly store: UsageAlertStore;
  private readonly pushService: UsageAlertNotifier;
  private readonly thresholds: number[];
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly errorLogger: ErrorLogger | null;

  constructor(opts: UsageAlertServiceOptions) {
    this.store = opts.store;
    this.pushService = opts.pushService;
    this.thresholds = [...(opts.thresholds ?? [80, 90])].sort((a, b) => a - b);
    this.enabled = opts.enabled ?? true;
    this.now = opts.now ?? Date.now;
    this.errorLogger = opts.errorLogger ?? null;
  }

  /**
   * Inspect a freshly-fetched usage list and fire at most one de-duped push per
   * (account, limit) — for the highest threshold newly crossed within the
   * current reset window — recording every crossed threshold as alerted.
   * Returns the number of notifications sent. Never throws — a push failure is
   * logged and skipped so one bad subscription cannot abort the rest (or the
   * sampler that calls this).
   */
  async checkAndNotify(usages: AccountUsage[]): Promise<number> {
    if (!this.enabled) return 0;
    let sent = 0;

    for (const usage of usages) {
      if (usage.status !== "ok") continue;

      for (const limitKey of ALERT_LIMIT_KEYS) {
        const window = usage.utilization?.[limitKey];
        const util = window?.utilization;
        if (typeof util !== "number" || !Number.isFinite(util)) continue;

        const windowKey = window?.resets_at ?? NO_RESET_WINDOW;

        // #4836: collect every newly crossed threshold, fire ONE push for the
        // highest, and record all of them — so 95% sends "90%+" once and 80%
        // never fires later in the same window.
        const due = this.thresholds.filter(
          threshold =>
            util >= threshold &&
            this.store.shouldAlert(
              usage.accountUuid,
              limitKey,
              threshold,
              windowKey
            )
        );
        if (due.length === 0) continue;

        const ok = await this.fire(usage, limitKey, Math.max(...due), util);
        // Record regardless of push success so a transient push failure does
        // not re-alert on every subsequent sample within the same window.
        const alertedAt = this.now();
        for (const threshold of due) {
          this.store.recordAlerted(
            usage.accountUuid,
            limitKey,
            threshold,
            windowKey,
            alertedAt
          );
        }
        if (ok) sent++;
      }
    }

    return sent;
  }

  /** Build + send one notification. Returns false (and logs) on failure. */
  private async fire(
    usage: AccountUsage,
    limitKey: UsageLimitKey,
    threshold: number,
    util: number
  ): Promise<boolean> {
    const label = LIMIT_LABELS[limitKey] ?? limitKey;
    const pct = Math.round(util);
    const payload: PushPayload = {
      title: `Usage ${threshold}%+: ${label}`,
      body: `${usage.displayLabel} — ${label} at ${pct}%`,
      tag: `usage-${usage.accountUuid}-${limitKey}-${threshold}`,
      data: {
        type: "usage-threshold",
        url: "/account-usage",
      },
    };

    try {
      await this.pushService.sendToAll(payload);
      return true;
    } catch (error) {
      this.errorLogger?.warn("Usage-threshold push failed", {
        category: "usage-alert",
        context: {
          error: error instanceof Error ? error.message : String(error),
          limitKey,
          threshold,
        },
      });
      return false;
    }
  }
}
