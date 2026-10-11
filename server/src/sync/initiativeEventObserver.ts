// SPDX-License-Identifier: AGPL-3.0-only
import type { PmQueueEventKind } from "@hapi/protocol";
import type { SyncEvent } from "@hapi/protocol/types";

import type { GitHubWebhookConfig } from "../config/githubWebhookConfig";
import type { ErrorLogger } from "../logging/errorLogger";
import type { Store } from "../store";
import type { SyncEngine } from "./syncEngine";

/**
 * Skill-revamp 3.2 (#2157, epic rp1-home#1319) — the PEER-SESSION half of the
 * push queue (R4). A structural clone of `queueDrainObserver.ts`: subscribes to
 * the SyncEngine event stream, keeps its own per-session delta map, and on a
 * qualifying session-state transition appends a corresponding event to the
 * event log of EVERY initiative whose ACTIVE roster contains that session.
 *
 * Transition → kind:
 *   - `session-added`               → `session_spawned`
 *   - `session-updated` thinking↓   → `session_idle`      (true→false)
 *   - `session-updated` active↓     → `session_completed` (true→false — an
 *                                     APPROXIMATION; see discriminate note)
 *   - `tool-error` / `session-restart-failed` / `spawn-failed` /
 *     `account-unrefreshable`       → `session_errored`   (source in payload)
 *
 * Fail-open everywhere (a listener throw must never stall the event stream) and
 * DEFAULT DISABLED (R7): `start()` no-ops unless `config.enabled` — so with the
 * webhook feature off this observer never subscribes and the behavior is
 * byte-identical to poll-only.
 */
export class InitiativeEventObserver {
  private readonly prevState = new Map<
    string,
    { active: boolean; thinking: boolean }
  >();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly engine: SyncEngine,
    private readonly store: Store,
    private readonly config: GitHubWebhookConfig,
    private readonly errorLogger: ErrorLogger | null = null
  ) {}

  start(): void {
    // R7: default-disabled. Never subscribe when the feature flag is off.
    if (!this.config.enabled) return;
    if (this.unsubscribe) return;
    this.unsubscribe = this.engine.subscribe(event => this.handle(event));
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.prevState.clear();
  }

  /** Prune the per-session delta map when a session is deleted (defense-in-depth;
   * the `session-removed` SyncEvent also prunes). */
  onSessionDeleted(sessionId: string): void {
    this.prevState.delete(sessionId);
  }

  private handle(event: SyncEvent): void {
    try {
      switch (event.type) {
        case "session-removed":
          this.prevState.delete(event.sessionId);
          return;
        case "session-added":
          // Key on the EXPLICIT spawn event, NOT "first delta-map sighting" —
          // the map is empty on every server restart, so a first-sighting rule
          // would replay `session_spawned` for every live rostered session into
          // the DURABLE log.
          this.appendForSession(event.sessionId, "session_spawned", {});
          return;
        case "session-updated":
          this.handleUpdated(event.sessionId);
          return;
        case "tool-error":
          this.appendForSession(event.sessionId, "session_errored", {
            source: "tool-error",
            toolName: event.data.toolName,
          });
          return;
        case "session-restart-failed":
          this.appendForSession(event.sessionId, "session_errored", {
            source: "session-restart-failed",
            error: event.error,
          });
          return;
        case "spawn-failed":
          this.appendForSession(event.sessionId, "session_errored", {
            source: "spawn-failed",
            error: event.error,
          });
          return;
        case "account-unrefreshable":
          this.appendForSession(event.sessionId, "session_errored", {
            source: "account-unrefreshable",
            accountUuid: event.accountUuid,
          });
          return;
        default:
          return;
      }
    } catch (err) {
      this.logError("handle", err);
    }
  }

  private handleUpdated(sessionId: string): void {
    // Resolve the current state by lookup (some session-updated emissions carry
    // only a partial `data` payload — mirrors queueDrainObserver).
    const current = this.engine.getSession(sessionId);
    if (!current) return;

    const prev = this.prevState.get(sessionId);
    const next = { active: current.active, thinking: current.thinking };
    this.prevState.set(sessionId, next);

    // First sighting — record state but don't compute a transition (prevents
    // cold-start replay of spurious idle/complete events into the durable log).
    if (!prev) return;

    if (prev.thinking === true && next.thinking === false) {
      this.appendForSession(sessionId, "session_idle", {});
    }
    if (prev.active === true && next.active === false) {
      // active:true→false is an EXPLICIT APPROXIMATION of completion — a
      // disconnect / offline / archive also fires active:false. We only reach
      // here when the session STILL EXISTS (getSession above returned it); a
      // removed/archived-away session is handled by `session-removed`. The PM
      // never trusts this over a primary-source read (R8), so a false completion
      // is corrected on the next reconcile; the delta-map first-sighting guard
      // keeps a server restart from replaying it.
      this.appendForSession(sessionId, "session_completed", {});
    }
  }

  /**
   * R4: append `kind` to the event log of every initiative whose ACTIVE roster
   * holds `sessionId`. A session on no roster → no-op (never synthesize an
   * initiative). Fail-open per initiative: a store throw is logged, never thrown.
   */
  private appendForSession(
    sessionId: string,
    kind: PmQueueEventKind,
    payload: Record<string, unknown>
  ): void {
    let initiativeIds: string[];
    try {
      initiativeIds = this.store.initiatives.initiativesForSession(sessionId);
    } catch (err) {
      this.logError("initiativesForSession", err);
      return;
    }
    for (const initiativeId of initiativeIds) {
      try {
        this.store.initiatives.appendEvent(initiativeId, kind, {
          sessionId,
          ...payload,
        });
      } catch (err) {
        this.logError("appendEvent", err);
      }
    }
  }

  private logError(where: string, err: unknown): void {
    const msg = `[InitiativeEventObserver] ${where} failed`;
    if (this.errorLogger) {
      this.errorLogger.warn(msg, {
        category: "initiative-event-observer",
        stack: err instanceof Error ? err.stack : null,
      });
    } else {
      console.error(msg, err);
    }
  }
}
