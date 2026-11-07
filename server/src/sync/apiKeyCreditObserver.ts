// SPDX-License-Identifier: AGPL-3.0-only
import type { SyncEvent } from "@hapi/protocol/types";
import { canonicalizeErrorType } from "@hapi/protocol/apiErrorClasses";
import { updateSettings } from "../config/settings";
import type { ErrorLogger } from "../logging/errorLogger";
import type { SyncEngine } from "./syncEngine";

/** The narrow engine surface this observer uses (test seam). */
export type ApiKeyCreditEngine = Pick<SyncEngine, "subscribe" | "getSession">;

/** A key is re-stamped at most this often while its sessions keep failing. */
const RESTAMP_WINDOW_MS = 60_000;

/**
 * API key budgets: records the provider's own "credit balance is too low"
 * answer on the vault key a session ran on, so the key's card says "Out of
 * credit" for certain rather than as an estimate.
 *
 * Subscribes to the `api-error` SyncEvent (published by the `/cli/error-reports`
 * bridge, which files the exhausted-credit text under `billing_error`) and, on
 * `phase: "exhausted"` with that class, stamps `outOfCreditAt` on the session's
 * `apiKeyId` when the key lives in THIS node's vault. A shared key used from
 * another node is stamped on neither node (its session reports on the other
 * node, and the vault lives here) — the card then falls back to the estimate.
 * The stamp is superseded at read time by later spend, a budget edit or a
 * top-up (`computeApiKeyBudget`), so this never has to clear it.
 *
 * Mirrors `SpendLimitNoticeObserver`: one per-process subscriber; session state
 * is resolved via `engine.getSession`, never from `event.data`. Fail-open: a
 * write error is logged, never thrown.
 */
export class ApiKeyCreditObserver {
  private unsubscribe: (() => void) | null = null;
  private readonly stampedAt = new Map<string, number>();

  constructor(
    private readonly engine: ApiKeyCreditEngine,
    private readonly settingsFile: string,
    private readonly errorLogger: ErrorLogger | null = null,
    /** Test seam — the stamp's clock. */
    private readonly now: () => number = Date.now
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.engine.subscribe(event => this.handle(event));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stampedAt.clear();
  }

  /** The in-flight stamp write, for tests. */
  pending: Promise<void> = Promise.resolve();

  private handle(event: SyncEvent): void {
    if (event.type !== "api-error" || !event.sessionId) return;
    const data = event.data as
      | { phase?: unknown; errorType?: unknown }
      | null
      | undefined;
    if (!data || typeof data !== "object" || data.phase !== "exhausted") return;
    if (typeof data.errorType !== "string") return;
    if (canonicalizeErrorType(data.errorType) !== "billing_error") return;

    const metadata = this.engine.getSession(event.sessionId)?.metadata;
    const apiKeyId = metadata?.apiKeyId;
    if (metadata?.authBinding?.kind !== "api-key") return;
    // A `<id>@<home>` ref names a key in another node's vault.
    if (typeof apiKeyId !== "string" || !apiKeyId || apiKeyId.includes("@")) {
      return;
    }

    const at = this.now();
    const last = this.stampedAt.get(apiKeyId);
    if (last !== undefined && at - last < RESTAMP_WINDOW_MS) return;
    this.stampedAt.set(apiKeyId, at);
    this.pending = this.stamp(apiKeyId, at, event.sessionId);
  }

  private async stamp(
    apiKeyId: string,
    at: number,
    sessionId: string
  ): Promise<void> {
    try {
      await updateSettings(this.settingsFile, fresh => {
        const entries = fresh.apiKeys ?? [];
        const idx = entries.findIndex(e => e.id === apiKeyId);
        if (idx === -1) return fresh;
        return {
          ...fresh,
          apiKeys: entries.map((e, i) =>
            i === idx ? { ...e, outOfCreditAt: new Date(at).toISOString() } : e
          ),
        };
      });
    } catch (err) {
      this.errorLogger?.warn(
        `[ApiKeyCreditObserver] out-of-credit stamp failed for key ${apiKeyId}: ${
          err instanceof Error ? err.name : "unknown"
        }`,
        { category: "api-keys-credit", sessionId }
      );
    }
  }
}
