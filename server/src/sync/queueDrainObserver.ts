// SPDX-License-Identifier: AGPL-3.0-only
import type { SyncEvent } from "@hapi/protocol/types";
import type { ErrorLogger } from "../logging/errorLogger";
import type { SyncEngine } from "./syncEngine";

/**
 * Issue #1325: server-driven queue drain.
 *
 * Subscribes to the SyncEngine's event stream and watches for session-state
 * transitions that should trigger dispatch of the next queued message:
 *
 *   - `thinking: true → false`  (Claude finished a turn — R1)
 *   - `active: false → true`    (session reconnected — R2)
 *
 * Maintains its own per-session delta map. On a qualifying transition,
 * pops the head of the queue via `engine.popHeadQueuedMessage` and
 * dispatches it via `engine.sendMessage` with `localId = row.id` for
 * idempotency (R3 — MessageStore.addMessage dedups on `(session_id, local_id)`).
 *
 * Design notes:
 *   - One head per transition. After dispatch, the CLI re-enters
 *     `thinking: true`; the next idle transition picks up the next entry.
 *     Matches existing client UX (one queued message per idle cycle).
 *   - The observer is a single per-process subscriber that handles all
 *     sessions on that process. Federation: each peer runs its own
 *     observer and drains its own queue locally (R4).
 *   - drainOnce is fire-and-forget (returns void). Errors are caught and
 *     routed to the error logger so a sendMessage failure doesn't stall
 *     the event listener.
 */
export class QueueDrainObserver {
  private readonly prevState = new Map<
    string,
    { active: boolean; thinking: boolean }
  >();
  // Issue #3235: per-session guard against a concurrent drain. Set in drainOnce
  // BEFORE popHead, released in its finally. Both the level-triggered
  // (queue-changed) and edge-triggered (session-updated) branches skip a
  // session whose drain is already in flight — the synchronous pop-echo
  // re-enters handle() DURING drainOnce, and an enqueue can race an edge drain.
  private readonly inFlight = new Set<string>();
  // Issue #3235: per-session one-per-idle-cycle latch. Set ONLY after a
  // delivered:true dispatch; cleared on null-pop / deny-drop / send-failure and
  // (in the session-updated branch) when the CLI takes a turn (thinking rises)
  // or reconnects. This preserves "at most one queued message dispatched per
  // idle cycle" (R4) across the CLI round-trip window where a level-triggered
  // dispatch has not yet produced a thinking:true→false edge.
  private readonly dispatchedSinceIdle = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly engine: SyncEngine,
    private readonly errorLogger: ErrorLogger | null = null,
    /**
     * Issue #2158: an optional dispatch HOLD predicate. While it returns true for
     * a session (its context-watermark handoff pipeline is in flight,
     * `handoffState === "handing_off"`), the drain SKIPS that session — because
     * `drainOnce` POPS the queued row from the store BEFORE sending it, so
     * dispatching mid-handoff to a predecessor that is about to be reaped would
     * silently lose the message. Absent → no hold (byte-identical to pre-#2158).
     */
    private readonly isDispatchHeld:
      | ((sessionId: string) => boolean)
      | null = null
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.engine.subscribe(event => this.handle(event));
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.prevState.clear();
    this.inFlight.clear();
    this.dispatchedSinceIdle.clear();
  }

  /**
   * Prune the per-session delta map when a session is deleted (R10).
   * Called by SyncEngine.deleteSession as part of Task 8 wiring.
   *
   * Also runs automatically when a session-removed SyncEvent arrives, as
   * defense-in-depth — but the explicit call from the deletion path is
   * the load-bearing one (deterministic; doesn't depend on event order).
   */
  onSessionDeleted(sessionId: string): void {
    this.prevState.delete(sessionId);
    // Issue #3235: prune the drain-guard state alongside prevState.
    this.inFlight.delete(sessionId);
    this.dispatchedSinceIdle.delete(sessionId);
  }

  private handle(event: SyncEvent): void {
    if (event.type === "session-removed") {
      this.prevState.delete(event.sessionId);
      this.inFlight.delete(event.sessionId);
      this.dispatchedSinceIdle.delete(event.sessionId);
      return;
    }

    // Issue #3235 (the wedge fix): level-triggered drain on a genuine ENQUEUE.
    // Delivery re-arm used to be purely edge-triggered (session-updated only),
    // so a session that settled idle after a 1-turn / 0-token session-limit
    // refusal — leaving no future thinking:true→false edge — accumulated an
    // undrained queue until a manual `abort` forced state churn. Draining on the
    // enqueue itself makes delivery LEVEL-triggered (R1/R2).
    if (event.type === "queue-changed") {
      // Only a genuine user enqueue re-arms. pop / requeue / edit / remove ALSO
      // emit queue-changed (the pop-echo from drainOnce's own popHead, the #1362
      // send-failure re-enqueue, and edit/remove/clear mutations) but MUST NOT
      // trigger a drain — the pop-echo would double-dispatch and a failing send
      // would spin on its requeue echo. An absent reason (a pre-#3235 emitter)
      // is treated as "not an enqueue".
      if (event.reason !== "enqueue") return;
      // A drain for this session is already in flight (its synchronous pop-echo
      // re-enters here mid-drainOnce) — ignore.
      if (this.inFlight.has(event.sessionId)) return;
      // A head was already dispatched this idle cycle and the CLI has not yet
      // gone thinking:true→false — suppress a second level dispatch (R4).
      if (this.dispatchedSinceIdle.has(event.sessionId)) return;
      const current = this.engine.getSession(event.sessionId);
      if (!current) return;
      // Only drain when the session is CURRENTLY idle AND active (same gate as
      // the edge branch below). An offline session waits for its active-rose
      // edge; a thinking session waits for its thinking-fall edge.
      if (!current.thinking && current.active) {
        // Issue #2158: honor the dispatch hold (successor handoff in flight).
        if (this.isDispatchHeld?.(event.sessionId)) return;
        void this.drainOnce(event.sessionId).catch(err =>
          this.logDrainError(event.sessionId, err)
        );
      }
      // Issue #3235: a queue-changed carries no session-state edge — do NOT
      // touch prevState (that map tracks session-state transitions only).
      return;
    }

    if (event.type !== "session-updated") return;

    // Resolve the current session state by lookup, not from event.data —
    // some session-updated emissions carry only a partial `data` payload
    // (e.g., the {active:false, thinking:false} archive events).
    const current = this.engine.getSession(event.sessionId);
    if (!current) return;

    const prev = this.prevState.get(event.sessionId);
    const next = { active: current.active, thinking: current.thinking };
    this.prevState.set(event.sessionId, next);

    // Issue #3235 (R4): the CLI started a turn (thinking rose) — reset the
    // one-per-idle-cycle latch so the NEXT idle cycle can dispatch a fresh head.
    // Runs even on first sighting (a no-op on an empty set).
    if (next.thinking === true) {
      this.dispatchedSinceIdle.delete(event.sessionId);
    }

    // First sighting — record state but don't try to compute a transition.
    if (!prev) return;

    const thinkingFell = prev.thinking === true && next.thinking === false;
    const activeRose = prev.active === false && next.active === true;

    // Issue #3235 (R4): a reconnect also resets the dispatch cycle.
    if (activeRose) {
      this.dispatchedSinceIdle.delete(event.sessionId);
    }

    // Only drain when the session is CURRENTLY idle AND active. If active
    // is false right now, the session is offline; dispatching a message
    // would either fail or queue at a lower layer that we don't want
    // touching this. Wait for the active=true transition.
    if ((thinkingFell || activeRose) && !next.thinking && next.active) {
      // Issue #2158: hold dispatch while a successor handoff is in flight for
      // this session — `drainOnce` pops-before-send, so a mid-handoff dispatch to
      // a soon-to-be-reaped predecessor would lose the message.
      if (this.isDispatchHeld?.(event.sessionId)) return;
      // Issue #3235: skip if a level-triggered drain is already in flight for
      // this session (the edge-vs-level race).
      if (this.inFlight.has(event.sessionId)) return;
      void this.drainOnce(event.sessionId).catch(err =>
        this.logDrainError(event.sessionId, err)
      );
    }
  }

  private async drainOnce(sessionId: string): Promise<void> {
    // Issue #3235: mark in-flight BEFORE popHead so the synchronous pop-echo
    // (popHeadQueuedMessage emits queue-changed) and any racing edge/enqueue do
    // not start a second concurrent drain for this session. Released in finally.
    this.inFlight.add(sessionId);
    try {
      const row = this.engine.popHeadQueuedMessage(sessionId);
      if (!row) {
        // Issue #3235: nothing dispatched — clear the one-per-cycle latch so a
        // later enqueue can try again.
        this.dispatchedSinceIdle.delete(sessionId);
        return;
      }
      try {
        // #3331 (Task 12b): a queued send carries NO origin (the route-side origin
        // derivation is bypassed), so a queued USER-APPROVAL token is denied
        // `provenance-rejected` by the token gate and DROPPED below — never a
        // silent grant with an empty identity; the user re-approves live. Both
        // drain sites (here + syncEngine.drainQueueHead) behave identically.
        const result = await this.engine.sendMessage(sessionId, {
          text: row.body,
          localId: row.id,
          sentFrom: "webapp",
        });
        // Issue #3124: a gate-class message hook DENIED this queued message. A
        // denial is NOT a send failure — DROP it (the row was already popped) and
        // do NOT re-enqueue: re-enqueue → next idle → drain → deny would loop
        // forever on this red-blast-radius path. The user-visible prompt-blocked
        // toast already fired from MessageService; record the drop for the audit.
        if (result.delivered === false) {
          // Issue #3235: a denial is not a dispatch — clear the latch.
          this.dispatchedSinceIdle.delete(sessionId);
          this.logDrainDenied(sessionId, result.hookId, result.reason);
          return;
        }
        // Issue #3235: a head WAS dispatched this idle cycle — suppress a second
        // level-triggered dispatch until the CLI takes a turn (thinking rises)
        // or reconnects (R4).
        this.dispatchedSinceIdle.add(sessionId);
      } catch (err) {
        // Issue #3235: a send failure is not a dispatch — clear the latch. The
        // #1362 re-enqueue below emits reason "requeue", which the level-trigger
        // ignores, so a failing send cannot spin.
        this.dispatchedSinceIdle.delete(sessionId);
        // Issue #1362: preserve the message body on send failure by
        // re-enqueueing at the back of the queue. popHead already DELETEd
        // the original row, freeing the (session_id, client_generated_id)
        // partial unique-index slot, so we can safely re-use
        // row.clientGeneratedId to preserve end-to-end idempotency.
        //
        // We log here (with the disposition) and DO NOT re-throw — the
        // outer .catch handler in handle() exists as a safety net for
        // unexpected errors (e.g. popHead throwing); for send failures
        // the disposition log below is the canonical record. Re-throwing
        // would cause that outer handler to log a duplicate entry with
        // no disposition.
        try {
          this.engine.enqueueQueuedMessage({
            sessionId,
            namespace: row.namespace,
            body: row.body,
            clientGeneratedId: row.clientGeneratedId,
            reason: "requeue",
          });
          this.logDrainError(sessionId, err, { reEnqueued: true });
        } catch (reEnqErr) {
          this.logDrainError(sessionId, err, {
            reEnqueued: false,
            reEnqueueError: reEnqErr,
          });
        }
      }
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  private logDrainError(
    sessionId: string,
    err: unknown,
    disposition?: { reEnqueued: boolean; reEnqueueError?: unknown }
  ): void {
    const msg = "[QueueDrainObserver] drainOnce failed";
    if (this.errorLogger) {
      const context: Record<string, unknown> = {
        category: "queue-drain",
        stack: err instanceof Error ? err.stack : null,
        sessionId,
        reEnqueued: disposition?.reEnqueued ?? false,
      };
      if (disposition && !disposition.reEnqueued) {
        const reEnqErr = disposition.reEnqueueError;
        context.reEnqueueError =
          reEnqErr instanceof Error
            ? { message: reEnqErr.message, stack: reEnqErr.stack }
            : String(reEnqErr);
      }
      this.errorLogger.warn(msg, context);
    } else {
      console.error(msg, err);
    }
  }

  /**
   * Issue #3124: record that a queued message was DROPPED by a gate-class
   * message hook (never re-enqueued). Distinct from logDrainError (a send
   * FAILURE that IS re-enqueued) — this is an intentional, policy-driven drop,
   * so it logs at info level.
   */
  private logDrainDenied(
    sessionId: string,
    hookId: string,
    reason: string
  ): void {
    const msg = "[QueueDrainObserver] queued message denied by hook (dropped)";
    if (this.errorLogger) {
      this.errorLogger.info(msg, {
        category: "queue-drain",
        sessionId,
        context: { hookId, reason, reEnqueued: false },
      });
    } else {
      console.info(msg, { sessionId, hookId, reason });
    }
  }
}
