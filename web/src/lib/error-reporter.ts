// SPDX-License-Identifier: AGPL-3.0-only
import { ErrorOutbox, type PersistableReport } from "./error-outbox";

type ErrorReport = {
  message: string;
  stack?: string | null;
  category: string;
  source: "client";
  severity: "debug" | "info" | "warn" | "error" | "fatal";
  sessionId?: string | null;
  context?: string | null;
  userAgent?: string | null;
  requestPath?: string | null;
  requestMethod?: string | null;
  statusCode?: number | null;
  /**
   * Issue #1244 finding #4: present only on REPLAYED reports — populated by
   * `toWireForm()` from the persisted `enqueuedAt`. Live POSTs are
   * self-stamping (server applies `Date.now()` at INSERT) and omit this
   * field. The server stores it in a NEW `original_timestamp` column,
   * leaving the existing `timestamp` column (= INSERT time) untouched.
   */
  originalTimestamp?: number | null;
};

type ErrorReporterConfig = {
  getBaseUrl: () => string;
  getToken: () => string | null;
};

const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const BATCH_DEBOUNCE_MS = 2_000;

// Outbox replay paces requests at ≥ this interval to avoid hammering the
// server's 10/60s rate-limit on POST /api/error-reports.
const DRAIN_THROTTLE_MS = 100;

// Surface a Toast warning once the session-scoped drop counter crosses this
// threshold. Below it, occasional drops stay silent.
const DROP_TOAST_THRESHOLD = 3;

// Once a drop-warning Toast has fired, suppress further ones for this long
// to avoid alarm fatigue during sustained partitions.
const DROP_TOAST_DEDUP_MS = 5 * 60_000;

export class ErrorReporter {
  private config: ErrorReporterConfig | null = null;
  private queue: ErrorReport[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private count = 0;
  private resetAt = 0;

  // Issue #1225: durable transport.
  private outbox: ErrorOutbox | null = null;
  private onlineHandler: (() => void) | null = null;
  private drainInProgress = false;
  private lastToastAt = 0;

  // Issue #1244 finding #5: drops accumulated since the last toast fired.
  // Distinct from `outbox.dropCount` (lifetime). Reset to 0 each time a
  // toast fires so a fresh "since last toast" series is required to fire
  // the next one — keeps occasional-drops quiet after the dedup window.
  private dropsSinceLastToast = 0;

  initialize(config: ErrorReporterConfig): void {
    this.config = config;

    if (!this.outbox) {
      this.outbox = new ErrorOutbox();
    }

    // Idempotent — only register the listener once even if initialize() is
    // called multiple times in dev StrictMode.
    if (!this.onlineHandler) {
      this.onlineHandler = () => {
        void this.maybeReplay();
      };
      window.addEventListener("online", this.onlineHandler);
    }

    // Bootstrap drain (R2.a). Fire-and-forget — if auth isn't ready yet, the
    // next maybeReplay() trigger (e.g. ApiClient 2xx) will pick up.
    void this.maybeReplay();
  }

  /**
   * Issue #1244 finding #2: tear down event listeners and reset internal state.
   * Intended for tests (clean teardown between cases) and future SSR/HMR
   * scenarios. Idempotent — calling twice is a safe no-op. After dispose(),
   * report() / maybeReplay() / drainOnce() are all safe no-ops via existing
   * config / outbox null-guards.
   *
   * The exported singleton `errorReporter` continues to live for app lifetime
   * — production code never calls dispose() on it.
   */
  dispose(): void {
    if (this.onlineHandler) {
      window.removeEventListener("online", this.onlineHandler);
      this.onlineHandler = null;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.config = null;
    this.outbox = null;
    this.queue = [];
    this.drainInProgress = false;
    this.lastToastAt = 0;
    this.dropsSinceLastToast = 0;
    this.count = 0;
    this.resetAt = 0;
  }

  report(report: Omit<ErrorReport, "source" | "userAgent">): void {
    if (!this.config) return;

    // Client-side rate limiting. Reports rejected here are dropped at the
    // boundary by design — the outbox is for transport-failed reports, not
    // for rate-limit overflow. (R8)
    const now = Date.now();
    if (now > this.resetAt) {
      this.count = 0;
      this.resetAt = now + RATE_WINDOW_MS;
    }
    if (this.count >= RATE_LIMIT) return;
    this.count++;

    this.queue.push({
      ...report,
      source: "client",
      userAgent: navigator.userAgent,
    });

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), BATCH_DEBOUNCE_MS);
  }

  /**
   * Durable variant of report() for the moment right before a programmatic
   * reload (issue #1793 R5b). The normal report() path debounces
   * BATCH_DEBOUNCE_MS before its first wire attempt — in-memory state that
   * dies with the page, so a report issued immediately before
   * location.reload() was ALWAYS lost (the outbox never saw it either: it
   * only receives reports that failed a wire attempt, and none was made).
   * This path writes straight to the persistent outbox (synchronous
   * localStorage) and lets the post-reload bootstrap drain deliver it, with
   * `originalTimestamp` preserving the actual pre-reload time.
   */
  reportBeforeReload(report: Omit<ErrorReport, "source" | "userAgent">): void {
    if (!this.outbox) return;

    // Same rate-limit gate as report() — shares the counter so the combined
    // wire budget stays within RATE_LIMIT per window.
    const now = Date.now();
    if (now > this.resetAt) {
      this.count = 0;
      this.resetAt = now + RATE_WINDOW_MS;
    }
    if (this.count >= RATE_LIMIT) return;
    this.count++;

    this.persistFailedReport({
      ...report,
      source: "client",
      userAgent: navigator.userAgent,
    });
  }

  /**
   * Public hook for ApiClient to call after any 2xx response. Cheap signal
   * that "transport works again" — covers the navigator.onLine blind spot
   * (it reports network-stack state, not server reachability). Idempotent
   * and non-throwing.
   */
  maybeReplay(): void {
    if (!this.outbox) return;
    if (this.drainInProgress) return;
    if (this.outbox.size() === 0) return;

    this.drainInProgress = true;
    void this.drainOnce().finally(() => {
      this.drainInProgress = false;
    });
  }

  private flush(): void {
    this.timer = null;
    if (!this.config || this.queue.length === 0) return;

    const baseUrl = this.config.getBaseUrl();
    const token = this.config.getToken();
    const batch = this.queue.splice(0);

    if (!token) {
      // Stranded-queue fix (#1225 in-path bug). Pre-fix: this returned
      // silently, leaving reports in this.queue with the timer cleared —
      // they sat there indefinitely with no re-arm trigger. Now: persist
      // them so a future online/maybeReplay drain (after auth recovers)
      // delivers them.
      for (const r of batch) {
        this.persistFailedReport(r);
      }
      // R1 (#1244 finding #1): reports never reached the wire — release
      // the rate-limit budget so subsequent report() calls within the
      // same 60s window aren't blocked by reports now sitting in the
      // outbox waiting for replay. The replay path bypasses this counter
      // entirely (drainOnce() does its own pacing via DRAIN_THROTTLE_MS),
      // so decrementing here cannot cause a real wire burst.
      this.count = Math.max(0, this.count - batch.length);
      return;
    }

    for (const report of batch) {
      // Fire-and-forget. On any failure (network or non-2xx), persist.
      fetch(`${baseUrl}/api/error-reports`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(report),
      })
        .then(res => {
          if (!res.ok) this.persistFailedReport(report);
        })
        .catch(() => this.persistFailedReport(report));
    }
  }

  private persistFailedReport(report: ErrorReport): void {
    if (!this.outbox) return;

    // Strip userAgent — re-derived from navigator.userAgent at replay (R5).
    // Coerce undefined → null on the optional fields so the persisted shape
    // matches PersistableReport's strict null-or-string typing.
    const persistable: Omit<PersistableReport, "id" | "enqueuedAt"> = {
      message: report.message,
      stack: report.stack ?? null,
      category: report.category,
      source: report.source,
      severity: report.severity,
      sessionId: report.sessionId ?? null,
      context: report.context ?? null,
      requestPath: report.requestPath ?? null,
      requestMethod: report.requestMethod ?? null,
      statusCode: report.statusCode ?? null,
    };
    const result = this.outbox.enqueue(persistable);
    // Issue #1244 finding #5: count drops "since last toast", not lifetime.
    // Mirrors `outbox.dropCount` semantics (only `dropped: true` counts —
    // a successful enqueue does NOT contribute to the toast threshold).
    if (result.dropped) {
      this.dropsSinceLastToast++;
    }
    this.maybeShowDropToast();
  }

  private maybeShowDropToast(): void {
    if (!this.outbox) return;
    // Issue #1244 finding #5: gate on the "since last toast" counter,
    // not the lifetime `outbox.getDropCount()`. After dedup expires,
    // require a fresh ≥ DROP_TOAST_THRESHOLD accumulation before firing
    // the next toast (occasional-drops quiet, sustained-partition still
    // loud — when the counter is already inflated past threshold during
    // the dedup window, the first post-dedup drop is enough to fire).
    if (this.dropsSinceLastToast < DROP_TOAST_THRESHOLD) return;
    const now = Date.now();
    if (now - this.lastToastAt < DROP_TOAST_DEDUP_MS) return;
    this.lastToastAt = now;
    this.dropsSinceLastToast = 0; // Reset for the next "since last toast" window.
    // CustomEvent bridge — error-reporter is a non-React module, Toast lives
    // in React context. ErrorOutboxDropToastListener (App.tsx) listens for this
    // and calls showToast(). detail.count
    // surfaces lifetime drop count for diagnostics (existing test contract).
    window.dispatchEvent(
      new CustomEvent("hapi:errorOutboxDropped", {
        detail: { count: this.outbox.getDropCount() },
      })
    );
  }

  private async drainOnce(): Promise<void> {
    // Issue #1244 finding #3: bounded while loop re-checks the outbox after
    // each successful pass so entries appended mid-drain (e.g. by a flush()
    // that fired during a throttle wait) drain in the same call without
    // waiting for the next external trigger. Bounded by R7 (≥100ms throttle)
    // × R3 (50-entry FIFO cap) × the rate at which new entries can arrive.
    // While-loop is preferred over tail-recursion to avoid stack growth.
    while (true) {
      if (!this.config || !this.outbox) return;

      // Re-read auth on each outer pass — supports token rotation between
      // passes. (Per-fetch re-read is intentionally NOT done — the existing
      // `if (!res.ok) break;` already handles a 401 mid-drain correctly.)
      const baseUrl = this.config.getBaseUrl();
      const token = this.config.getToken();
      if (!token) return; // Auth not ready — leave outbox for next trigger.

      const entries = this.outbox.peekAll();
      if (entries.length === 0) return;

      let breakedEarly = false;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const wireForm = this.toWireForm(entry);

        try {
          const res = await fetch(`${baseUrl}/api/error-reports`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(wireForm),
          });
          if (!res.ok) {
            // Issue #2362: 429 is the ONE 4xx that is explicitly TRANSIENT —
            // the server sends `Retry-After` and the window expires in <=60s.
            // Treating it as a poison pill discarded genuine reports forever
            // (and logged console noise) precisely when the reporter was
            // rate-limited, which is the failure this issue exists to fix.
            // It falls through to the 5xx branch: break, preserve FIFO order,
            // retry on the next maybeReplay() trigger.
            if (res.status >= 400 && res.status < 500 && res.status !== 429) {
              // Issue #1244 follow-up (silent-failure-hunter C2 / preflight
              // v1.0.387): 4xx is a permanent rejection (schema mismatch,
              // revoked auth, oversize field, etc). Drop the poison-pill
              // entry so it can't block the FIFO outbox for all subsequent
              // reports. console.error provides operator visibility — they
              // can find dropped reports in devtools when investigating.
              console.error(
                "[ErrorReporter] Dropping unsendable report (4xx)",
                {
                  id: entry.id,
                  statusCode: res.status,
                  message: entry.message.slice(0, 200),
                }
              );
              this.outbox.removeById(entry.id);
            } else {
              // 5xx, 429, or other non-2xx — likely transient server-side.
              // Stop draining; preserve order. Next online/maybeReplay retries.
              breakedEarly = true;
              break;
            }
          } else {
            this.outbox.removeById(entry.id);
          }
        } catch {
          // Network failure — preserve order.
          breakedEarly = true;
          break;
        }

        // Pace to ≥ DRAIN_THROTTLE_MS between sends. Skip the wait after the
        // last entry in this pass.
        if (i < entries.length - 1) {
          await new Promise(resolve => setTimeout(resolve, DRAIN_THROTTLE_MS));
        }
      }

      if (breakedEarly) return; // R7: leave remainder for next trigger.
      if (this.outbox.size() === 0) return; // Steady state reached.
      // Otherwise: re-check fired (entries arrived during this pass).
      // Loop back and drain them. Bounded — see header comment.
    }
  }

  private toWireForm(entry: PersistableReport): ErrorReport {
    // Re-derive userAgent at replay time (R5) — explicit field assignment so
    // any extra fields on a stale persisted entry can't leak to the server.
    return {
      message: entry.message,
      stack: entry.stack,
      category: entry.category,
      source: entry.source,
      severity: entry.severity,
      sessionId: entry.sessionId,
      context: entry.context,
      userAgent: navigator.userAgent,
      requestPath: entry.requestPath,
      requestMethod: entry.requestMethod,
      statusCode: entry.statusCode,
      // Issue #1244 finding #4: surface persisted enqueuedAt as the
      // server-side `originalTimestamp`. Replay-only — the live-POST path
      // in flush() builds its own ErrorReport and omits this field.
      originalTimestamp: entry.enqueuedAt,
    };
  }
}

export const errorReporter = new ErrorReporter();
