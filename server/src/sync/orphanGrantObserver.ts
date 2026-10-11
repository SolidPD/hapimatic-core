// SPDX-License-Identifier: AGPL-3.0-only
import type { SyncEvent } from "@hapi/protocol/types";
import type { ErrorLogger } from "../logging/errorLogger";
import type { SyncEngine } from "./syncEngine";

/**
 * Orphaned-grant `api-error` observer (issue #3563, R2 delta R-3563-1).
 *
 * The `rateLimited` rising edge (`sessionCache` → `syncEngine.handleSessionAlive`)
 * covers a session-limit 429 detected by `RateLimitDetector`. But that detector is
 * NOT wired in `claudeLocalLauncher.ts` at all, and it fires only on the
 * `SESSION_LIMIT_SUBSTRINGS` gate — so a local-mode 429 and EVERY non-429 terminal
 * exhaustion (an `overloaded_error`, a hard connection-drop) raise no edge and fire
 * no Stop hook. This observer is the ONLY detector for those: it subscribes to the
 * existing `api-error` SyncEvent (`web/routes/cli.ts` → `apiErrorDetector.reportExhausted`,
 * wired in ALL FOUR launchers) and fires the orphan check on `data.phase === "exhausted"`.
 *
 * Mirrors {@link QueueDrainObserver}: a single per-process subscriber; resolves
 * session state via `engine.getSession` (NEVER from `event.data`). The orphan check
 * drops the record on the first post, so a repeated exhaustion RE-EMITTING this event
 * cannot double-post. Federation: each peer runs its own observer; a remote-owned
 * session is skipped (defense-in-depth — a remote session's mint lives on its own
 * node, so the local mint store is empty for it and the check is already a no-op).
 */
export class OrphanGrantObserver {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly engine: SyncEngine,
    private readonly errorLogger: ErrorLogger | null = null,
    /**
     * Optional remote-owned skip (defense-in-depth). Late-bound in `index.ts` from
     * the node registry — absent → never remote (byte-identical for a single node).
     * The empty-mint-store guard in `checkOrphanGrant` already makes a remote session
     * a no-op, so this is a cheap early-out, not a correctness requirement.
     */
    private readonly isRemoteOwned:
      | ((sessionId: string) => boolean)
      | null = null
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.engine.subscribe(event => this.handle(event));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private handle(event: SyncEvent): void {
    // Store hygiene: drop a removed session's mint records so the map cannot grow
    // one stranded entry per ever-minted-then-deleted session.
    if (event.type === "session-removed") {
      if (event.sessionId) this.engine.forgetOrphanRecords(event.sessionId);
      return;
    }
    if (event.type !== "api-error") return;
    const sessionId = event.sessionId;
    if (!sessionId) return;

    // The api-error `data` is typed loosely on SyncEvent; narrow at runtime and
    // fire ONLY on the terminal `exhausted` phase (never `retrying`/`recovered`/
    // `give-up`). Mirrors AutoRecoveryService's `data` narrowing.
    const data = event.data as { phase?: unknown } | null | undefined;
    if (!data || typeof data !== "object" || data.phase !== "exhausted") return;

    // Defense-in-depth remote-owned skip (see constructor note).
    if (this.isRemoteOwned?.(sessionId)) return;

    // Resolve session state by lookup, not from event.data (QueueDrainObserver
    // rule) — an unknown session is skipped.
    if (!this.engine.getSession(sessionId)) return;

    try {
      this.engine.checkOrphanGrant(sessionId);
    } catch (err) {
      this.errorLogger?.warn("[OrphanGrantObserver] orphan check failed", {
        category: "orphan-grant",
        sessionId,
        context: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}
