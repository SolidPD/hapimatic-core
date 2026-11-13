// SPDX-License-Identifier: AGPL-3.0-only
import type {
  Pin,
  PinChange,
  PinContent,
  PinStatus,
  SyncEvent,
} from "@hapi/protocol";
import type {
  DueDeadlineCursor,
  PinAnswerInput,
  PinAnswerOutcome,
  PinBatchAnswer,
  PinBatchOutcome,
  PinDeadlineRefusal,
  PinDeadlineRow,
  PendingSave,
  PinListOptions,
  PinLiveRef,
  PinStore,
  PinTurnCandidate,
  PinUpsertOptions,
} from "../store/pinStore";

/** What a write needs of the session: the row key and the event's audience. */
export type PinSessionRef = { id: string; namespace: string };

/** Who is delivering an answer for a pin right now (#6452). */
export type PinClaimOwner = "operator" | "auto";

export type PinWriteResult = {
  pin: Pin;
  openPinCount: number;
  /** False for a no-op, which published nothing. */
  changed: boolean;
};

export type PinUpsertResult =
  | PinWriteResult
  | { closed: Pin; openPinCount: number }
  | { missing: true }
  | { capped: "open" | "total" };

export type PinAnswerResult =
  | (PinWriteResult & { moot: boolean })
  | { unknownOption: string };

/**
 * An operator dismissal the server refuses (#6455): an open `prompt:` pin mirrors a
 * prompt the agent is still blocked on, and a sticky dismissal would hide it while
 * the mirror's identical re-post stayed a no-op.
 */
export type PinDismissRefusal = { refused: "pin_reserved_key" };

/** The `prompt:` key prefix the prompt mirror writes (#6455). */
export const PROMPT_PIN_PREFIX = "prompt:";

/**
 * The one place a pin's state changes (issue #6447, epic #6446), owned by
 * `SyncEngine` so "all state changes go through SyncEngine" holds: every change
 * except mark-seen and a save report (#6453) publishes through `EventPublisher`,
 * and neither a no-op nor those two publish anything. Every
 * writer in the epic goes through it: the CLI and federation routes, the `hapi_pin`
 * fence parser (#6448), automatic picks (#6452), and mirroring (#6455).
 *
 * The event names its `namespace` explicitly, because a hub rebroadcasts a bridged
 * event without resolving it, and `resolveNamespace` cannot find a deleted session.
 *
 * This does not read the Pins gate: the gate closes the routes. A server-side
 * writer that bypasses the routes must check `resolvePinsEnabled()` itself.
 */
export class PinService {
  /**
   * Pins an answer is being delivered for right now (#6452): an operator's
   * Submit holds its pins across its send, so an automatic pick never lands on a
   * pin whose answer is in flight. In memory, because the race only exists
   * inside one process: a restart has no send in flight, and a crash between a
   * message and its record cannot happen (the two commit together).
   */
  private readonly claims = new Map<string, PinClaimOwner>();

  constructor(
    private readonly store: PinStore,
    private readonly publisher: { emit(event: SyncEvent): void },
    private readonly getMaxSeq: (sessionId: string) => number
  ) {}

  private claimKey(sessionId: string, key: string): string {
    return `${sessionId}\u0000${key}`;
  }

  /** Hold a pin for an answer in flight. False when another writer holds it. */
  tryClaim(sessionId: string, key: string, owner: PinClaimOwner): boolean {
    const id = this.claimKey(sessionId, key);
    if (this.claims.has(id)) return false;
    this.claims.set(id, owner);
    return true;
  }

  release(sessionId: string, key: string): void {
    this.claims.delete(this.claimKey(sessionId, key));
  }

  /** Who holds a pin, if anyone. */
  claimedBy(sessionId: string, key: string): PinClaimOwner | undefined {
    return this.claims.get(this.claimKey(sessionId, key));
  }

  private publish(session: PinSessionRef, pin: Pin, change: PinChange): number {
    const openPinCount = this.store.countOpen(session.id);
    this.publisher.emit({
      type: "pin-changed",
      sessionId: session.id,
      namespace: session.namespace,
      key: pin.key,
      change,
      revision: pin.revision,
      status: pin.status,
      openPinCount,
    });
    return openPinCount;
  }

  private settle(
    session: PinSessionRef,
    written: { pin: Pin; changed: boolean } | null,
    change: PinChange
  ): PinWriteResult | null {
    if (!written) return null;
    const openPinCount = written.changed
      ? this.publish(session, written.pin, change)
      : this.store.countOpen(session.id);
    return { pin: written.pin, openPinCount, changed: written.changed };
  }

  list(
    sessionId: string,
    options: PinListOptions = {}
  ): { pins: Pin[]; hasMore: boolean; openPinCount: number } {
    return {
      ...this.store.list(sessionId, options),
      openPinCount: this.store.countOpen(sessionId),
    };
  }

  get(
    sessionId: string,
    key: string
  ): { pin: Pin; openPinCount: number } | null {
    const pin = this.store.get(sessionId, key);
    return pin ? { pin, openPinCount: this.store.countOpen(sessionId) } : null;
  }

  /**
   * #6574: the pin with this ID on this node and its session's open count, or
   * null. Namespace-unaware, like the store: the by-ID lookup checks the session.
   */
  getByPinId(pinId: string): { pin: Pin; openPinCount: number } | null {
    const pin = this.store.getByPinId(pinId);
    return pin
      ? { pin, openPinCount: this.store.countOpen(pin.sessionId) }
      : null;
  }

  upsert(
    session: PinSessionRef,
    content: PinContent,
    options: Pick<
      PinUpsertOptions,
      "reopen" | "mustExist" | "anchor" | "now"
    > = {}
  ): PinUpsertResult {
    const outcome = this.store.upsert(session.id, content, {
      ...options,
      postedSeq: this.getMaxSeq(session.id),
    });
    if ("missing" in outcome || "capped" in outcome) return outcome;
    if ("closed" in outcome) {
      return {
        closed: outcome.closed,
        openPinCount: this.store.countOpen(session.id),
      };
    }
    return this.settle(
      session,
      { pin: outcome.pin, changed: outcome.change !== null },
      outcome.change ?? "updated"
    ) as PinWriteResult;
  }

  /** The agent takes its question back. Null for an absent key. */
  withdraw(
    session: PinSessionRef,
    key: string,
    now?: number
  ): PinWriteResult | null {
    return this.settle(
      session,
      this.store.withdraw(session.id, key, now),
      "withdrawn"
    );
  }

  /** The operator clears a pin. Null for an absent key. */
  dismiss(
    session: PinSessionRef,
    key: string,
    now?: number
  ): PinWriteResult | null {
    return this.settle(
      session,
      this.store.dismiss(session.id, key, now),
      "dismissed"
    );
  }

  /**
   * The operator's dismissal, from the web route and the federation receiver
   * (#6455): as `dismiss`, except an open mirrored prompt is refused. A closed one,
   * and any detected pin, dismiss normally.
   */
  dismissForOperator(
    session: PinSessionRef,
    key: string,
    now?: number
  ): PinWriteResult | PinDismissRefusal | null {
    const pin = this.store.get(session.id, key);
    if (pin?.status === "open" && key.startsWith(PROMPT_PIN_PREFIX)) {
      return { refused: "pin_reserved_key" };
    }
    return this.dismiss(session, key, now);
  }

  /** Keys starting `prefix` (#6455). Reads no JSON. */
  listKeysByPrefix(
    sessionId: string,
    prefix: string,
    status?: PinStatus
  ): string[] {
    return this.store.listKeysByPrefix(sessionId, prefix, status);
  }

  /** Every open pin the agent owns, with its timestamps (#6455). */
  listTurnCandidates(sessionId: string): PinTurnCandidate[] {
    return this.store.listTurnCandidates(sessionId);
  }

  /**
   * Keep the newest `keep` closed pins with this prefix and delete the rest
   * (#6455). Each removal publishes `pin-changed`, so a client refetches the key,
   * reads a 404 and drops the row; a silent delete would leave it on screen.
   */
  trimClosedByPrefix(
    session: PinSessionRef,
    prefix: string,
    keep: number
  ): number {
    const removed = this.store.trimClosedByPrefix(session.id, prefix, keep);
    if (removed.length === 0) return 0;
    const openPinCount = this.store.countOpen(session.id);
    for (const row of removed) {
      this.publisher.emit({
        type: "pin-changed",
        sessionId: session.id,
        namespace: session.namespace,
        key: row.key,
        change: "updated",
        revision: row.revision,
        status: row.status,
        openPinCount,
      });
    }
    return removed.length;
  }

  /**
   * Record an answer. It always publishes `answered`, even when moot, because the
   * history changed and the pin must show it. Null for an absent key.
   */
  answer(
    session: PinSessionRef,
    key: string,
    input: PinAnswerInput
  ): PinAnswerResult | null {
    const outcome = this.store.answer(session.id, key, input);
    if (!outcome) return null;
    if ("unknownOption" in outcome) return outcome;
    return {
      pin: outcome.pin,
      moot: outcome.moot,
      changed: true,
      openPinCount: this.publish(session, outcome.pin, "answered"),
    };
  }

  /**
   * Record a Submit's answers in one store transaction (#6450), then publish one
   * `answered` per pin that changed. A pin this submission already recorded comes
   * back as `duplicate` and publishes nothing.
   */
  answerBatch(
    session: PinSessionRef,
    submission: string,
    items: readonly PinBatchAnswer[]
  ): { results: PinBatchOutcome[]; openPinCount: number } {
    const results = this.recordBatch(session, submission, items);
    this.publishBatch(session, results);
    return { results, openPinCount: this.store.countOpen(session.id) };
  }

  /**
   * `answerBatch` without its events (#6452), for a caller that records inside a
   * larger transaction and must publish only after it commits: `publishBatch`.
   */
  recordBatch(
    session: PinSessionRef,
    submission: string,
    items: readonly PinBatchAnswer[]
  ): PinBatchOutcome[] {
    return this.store.answerBatch(session.id, submission, items);
  }

  /**
   * One event per pin a batch changed; a duplicate publishes nothing. The event
   * is `dismissed` for a pin this batch closed as dismissed (#6539), so every
   * device moves it to Completed as Dismissed, and `answered` otherwise. A moot
   * dismissal changed only the history, so it is `answered` too, as is a moot
   * answer recorded on a pin that was dismissed before this batch.
   */
  publishBatch(
    session: PinSessionRef,
    results: readonly PinBatchOutcome[]
  ): number {
    const changed = new Map<string, { pin: Pin; live: boolean }>();
    for (const { key, result } of results) {
      if (!result || !("pin" in result)) continue;
      // `live`: at least one entry was made on the pin's current revision while
      // it was open, so this batch could have closed it.
      const live = (changed.get(key)?.live ?? false) || !result.moot;
      changed.set(key, { pin: result.pin, live });
    }
    // Re-read: the record and any deadline change share one transaction, so the
    // newest row carries both (a Submit can turn a pick off with a question).
    for (const [key, { pin, live }] of changed) {
      const fresh = this.store.get(session.id, key) ?? pin;
      this.publish(
        session,
        fresh,
        live && fresh.status === "dismissed" ? "dismissed" : "answered"
      );
    }
    return this.store.countOpen(session.id);
  }

  // ── Automatic picks (#6452) ───────────────────────────────────────────────

  /** The operator moves, stops or restarts a pick. Publishes `rescheduled`. */
  setDeadline(
    session: PinSessionRef,
    key: string,
    request: { at: number } | { off: true },
    now?: number
  ): PinWriteResult | { refused: PinDeadlineRefusal } | null {
    const outcome = this.store.setDeadline(session.id, key, request, now);
    if (!outcome || "refused" in outcome) return outcome;
    return this.settle(session, outcome, "rescheduled");
  }

  getDeadlineRow(sessionId: string, key: string): PinDeadlineRow | null {
    return this.store.getDeadlineRow(sessionId, key);
  }

  listDueDeadlines(now: number, limit?: number, after?: DueDeadlineCursor) {
    return this.store.listDueDeadlines(now, limit, after);
  }

  nextFutureDeadlineAt(now: number): number | null {
    return this.store.nextFutureDeadlineAt(now);
  }

  armMissingDeadlines(now?: number): number {
    return this.store.armMissingDeadlines(now);
  }

  /** The automatic answer, without its event: the caller publishes after commit. */
  recordAutomaticPick(
    sessionId: string,
    key: string,
    input: { option: string; revision: number; submission: string; now: number }
  ): PinAnswerOutcome | null {
    return this.store.recordAutomaticPick(sessionId, key, input);
  }

  /** Publish `answered` for a pin an automatic pick settled. */
  publishAnswered(session: PinSessionRef, key: string): number {
    return this.publishChange(session, key, "answered");
  }

  /** Publish a change written inside a caller's transaction, after it commits. */
  publishChange(
    session: PinSessionRef,
    key: string,
    change: PinChange
  ): number {
    const pin = this.store.get(session.id, key);
    return pin
      ? this.publish(session, pin, change)
      : this.store.countOpen(session.id);
  }

  /** A late pick moved out (ruling D2). Publishes `rescheduled`. */
  reschedule(
    session: PinSessionRef,
    key: string,
    at: number
  ): PinWriteResult | null {
    return this.settle(
      session,
      this.store.rescheduleDeadline(session.id, key, at),
      "rescheduled"
    );
  }

  /** A pin revised outside the rules: re-armed, not fired. Publishes `rescheduled`. */
  refreshForeignDeadline(
    session: PinSessionRef,
    key: string,
    now?: number
  ): PinWriteResult | null {
    return this.settle(
      session,
      this.store.refreshForeignDeadline(session.id, key, now),
      "rescheduled"
    );
  }

  /** Stop a deadline whose stored content fails the rule. Publishes `rescheduled`, so clients drop it. */
  clearDeadline(session: PinSessionRef, key: string): boolean {
    const cleared = this.store.clearDeadline(session.id, key);
    const pin = cleared ? this.store.get(session.id, key) : null;
    if (pin) this.publish(session, pin, "rescheduled");
    return cleared;
  }

  /** Store only, inside a Submit's transaction; the Submit publishes `answered`. */
  setDeadlineOffForQuestion(sessionId: string, key: string, now?: number) {
    return this.store.setDeadlineOffForQuestion(sessionId, key, now);
  }

  listDeadlineReportPending(sessionId: string): string[] {
    return this.store.listDeadlineReportPending(sessionId);
  }

  /** Store only, inside a Submit's transaction. */
  markDeadlinesReported(
    sessionId: string,
    reports: ReadonlyArray<{ key: string; changedAt: number }>
  ): void {
    this.store.markDeadlinesReported(sessionId, reports);
  }

  /** Publishes, because a star floats a pin to the top on every device. */
  setStarred(
    session: PinSessionRef,
    key: string,
    starred: boolean
  ): PinWriteResult | null {
    return this.settle(
      session,
      this.store.setStarred(session.id, key, starred),
      "starred"
    );
  }

  /**
   * Record "Save to session folder" (#6453). Publishes `saved`, because the Save
   * button reads "Saved to session folder" on every device. Null for an absent key.
   */
  markSaved(
    session: PinSessionRef,
    key: string,
    save: { savedTo: string; revision: number },
    now?: number
  ): PinWriteResult | null {
    return this.settle(
      session,
      this.store.setSaved(session.id, key, { ...save, now }),
      "saved"
    );
  }

  /** The session's saves the agent has not yet heard about (#6453). */
  listPendingSaves(sessionId: string): PendingSave[] {
    return this.store.listPendingSaves(sessionId);
  }

  /**
   * The agent has heard about these saves (#6453). Publishes nothing: only
   * `saveReportPending` changes, and the next list read carries it.
   */
  markSavesReported(
    session: PinSessionRef,
    saves: readonly PendingSave[]
  ): void {
    this.store.markSavesReported(session.id, saves);
  }

  /**
   * Publishes nothing, because a client marking seen would otherwise refetch on
   * every open, and no other client's view depends on it. Null for an absent key.
   */
  markSeen(
    session: PinSessionRef,
    key: string,
    now?: number
  ): PinWriteResult | null {
    const written = this.store.markSeen(session.id, key, now);
    return written
      ? {
          pin: written.pin,
          changed: written.changed,
          openPinCount: this.store.countOpen(session.id),
        }
      : null;
  }

  countOpen(sessionId: string): number {
    return this.store.countOpen(sessionId);
  }

  countOpenBySession(): Map<string, number> {
    return this.store.countOpenBySession();
  }

  /** Open pins the agent owns, without the server's mirrored ones (#6454). */
  countOpenAgentPins(sessionId: string): number {
    return this.store.countOpenAgentPins(sessionId);
  }

  /** Every live dashboard's identity, newest first (#6454). */
  listLiveDashboardRefs(): PinLiveRef[] {
    return this.store.listLiveRefs();
  }

  /** One dashboard pin, read without its open count (#6454). */
  getDashboard(sessionId: string, key: string): Pin | null {
    return this.store.get(sessionId, key);
  }
}
