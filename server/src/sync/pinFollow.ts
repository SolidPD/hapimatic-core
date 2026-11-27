// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A pin decided elsewhere goes away (issue #6456, epic #6446; Matt, 2026-11-17:
 * "If a pin gets decided by some other session, then that pin needs to go away").
 *
 * Two rules close a pin as superseded, never as answered:
 *
 * - **A copy follows its original (R5).** An open pin that names, in `repeats`,
 *   a pin of ANOTHER session in the same namespace closes when that pin closes
 *   by any route but a replacement (R9): at once when both are on this node,
 *   and within one loop pass (five minutes) when the original is on another node.
 *   A copy of a replaced original follows the pin that replaced it. One direction
 *   only: a copy never closes an original, because nothing would deliver the
 *   answer to the original's agent; and a pin never follows a pin of its own
 *   session (a same-session `repeats` replaces or links instead).
 * - **A Detected pin follows the pins linked to it (R4).** It closes when every
 *   pin linked to it is settled. Settled: answered, picked automatically,
 *   dismissed, ruled by a PM, resolved or withdrawn by its agent, or closed by
 *   following its own original. A replaced link is read through the pin that
 *   replaced it. A linked pin that is gone (deleted, evicted) is not settled.
 *   The Pins PM's correction of R1 (2026-11-25, the issue body wins over the
 *   directive): a linked pin created after the Detected pin settles it only by
 *   the operator's act or a PM's ruling, so a session cannot retire its own
 *   Detected pin by posting a pin that names it and withdrawing that pin. And a
 *   Detected pin the operator starred or wrote on is left open unless every
 *   settlement is the operator's or a PM's ruling.
 *
 * Why an event listener and not a hook in `PinService.answer`: every close
 * publishes `pin-changed` after its commit, including the two that bypass
 * `answer`/`withdraw`: a Submit records inside its message's transaction
 * (`pinSubmission.ts`, `recordBatch` then `publishBatch`) and an automatic pick
 * records then publishes (`recordAutomaticPick` then `publishAnswered`). The
 * listener does no database work: it queues `(session, key)` and drains one per
 * `setImmediate`, the `PinPromptMirror` pattern, with its own guard and one retry
 * on a busy database. The loop (`createPinFollowLoop`) repairs anything a crash
 * between a commit and its drain left open.
 *
 * Only a `found` original that is closed settles a copy: `not_found`,
 * `incomplete`, `ambiguous` and a local-only spoke leave it open. The event path
 * reads originals on this node only; the loop also asks the other nodes. A pin a
 * Submit or an automatic pick has claimed is left for the claim's own event.
 * Named limits: an original no node knows (a deleted pin) leaves its copy open; a
 * second busy failure leaves the pin to the next loop pass, and a pass stops at
 * its first busy database; and a pass reads at most `PIN_FOLLOW_PASS_ROWS` copies,
 * so with more open copies on a node than that, a copy of an original on another
 * node can wait more than one pass.
 */
import {
  countedClosure,
  isReservedPinKey,
  PIN_CLOSURE_REASON_MAX_CHARS,
  SupervisedLoop,
  settlingAnswer,
  type JobFailureEvent,
  type JobRegistry,
  type Pin,
  type PinClosure,
  type SyncEvent,
} from "@hapi/protocol";

import type { ErrorLogger } from "../logging/errorLogger";
import { isSqliteBusy } from "../socket/handlers/cli/messageWriteRetryQueue";
import type { PinByIdOutcome } from "./pinById";
import type { PinService, PinSessionRef } from "./pinService";

/** The job name in the System Jobs registry. */
export const PIN_FOLLOW_JOB = "pin-follow";
/** The loop's cadence (R5: within five minutes for an original on another node). */
export const PIN_FOLLOW_INTERVAL_MS = 5 * 60_000;
/** Rows one loop pass reads; the cursor carries over to the next pass. */
export const PIN_FOLLOW_PASS_ROWS = 100;
/** The most `replaced` steps followed from one pin. */
export const PIN_FOLLOW_MAX_STEPS = 8;
/** The delay before a busy pin is tried again, once. */
export const PIN_FOLLOW_BUSY_RETRY_MS = 1000;

/** Who settled a pin, for the R1 correction and the starred guard. */
export type PinSettledBy =
  | "operator"
  | "pm"
  | "auto"
  | "agent"
  | "dismissed"
  | "server";

/** How a closed pin was settled, and the words a closure's reason uses. */
export type PinSettlement = { by: PinSettledBy; words: string };

const SETTLED_BY: ReadonlySet<string> = new Set([
  "operator",
  "pm",
  "auto",
  "agent",
  "dismissed",
  "server",
]);

/**
 * How a closed pin was settled, or null while it is open, live, or closed only
 * because a newer pin replaced it (the caller reads the replacement instead).
 */
export function settlementOf(pin: Pin): PinSettlement | null {
  switch (pin.status) {
    case "answered": {
      const answer = settlingAnswer(pin.answers);
      if (answer?.via === "pm") {
        return { by: "pm", words: "was ruled on by the Project Manager" };
      }
      if (answer?.by === "operator") {
        return { by: "operator", words: "was answered" };
      }
      if (answer?.by === "agent") {
        return { by: "agent", words: "was resolved by its agent" };
      }
      return { by: "server", words: "was answered" };
    }
    case "auto-answered":
      return { by: "auto", words: "was picked automatically" };
    case "dismissed": {
      // Only a Submit's dismissal leaves an entry; the dismiss route leaves none,
      // and it refuses only the pin's own session, so a bare dismissal is not
      // the operator's for certain.
      const byOperator = pin.answers.some(
        answer =>
          answer.dismissed === true && answer.by === "operator" && !answer.moot
      );
      return {
        by: byOperator ? "operator" : "dismissed",
        words: "was dismissed",
      };
    }
    case "withdrawn": {
      const closure = countedClosure(pin);
      if (closure?.rule === "replaced") return null;
      if (closure?.rule === "repeats") {
        const by = closure.settledBy;
        return {
          by: by && SETTLED_BY.has(by) ? (by as PinSettledBy) : "server",
          words: closure.ref
            ? `closed with ${closure.ref}, which it repeats`
            : "closed with the pin it repeats",
        };
      }
      if (closure) return { by: "server", words: "was closed as superseded" };
      // A Submit's dismissal of a `prompt:` pin closes it withdrawn (#6458 round
      // 6): the operator's dismissal, as the web's ledger reads it.
      if (dismissedByOperator(pin)) {
        return { by: "operator", words: "was dismissed" };
      }
      // Only an agent withdraws its own key; a Detected or `prompt:` pin is
      // withdrawn by the server (a cap, a prompt that went away), never by it.
      if (isReservedPinKey(pin.key)) {
        return { by: "server", words: "was withdrawn by Hapimatic" };
      }
      return { by: "agent", words: "was withdrawn by its agent" };
    }
    default:
      return null;
  }
}

/** An ISO time in epoch ms; one that does not parse reads as the far future. */
function epochMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * #6458 round 6: a withdrawn pin whose close is the operator's Submit dismissal,
 * an operator entry with `dismissed: true` at or after the close's time. A later
 * re-post and close moves `updatedAt` past that entry. The same rule as the
 * web's `dismissedByOperator` (`web/src/lib/pins/ledger.ts`).
 */
function dismissedByOperator(pin: Pin): boolean {
  if (pin.status !== "withdrawn") return false;
  const closedAt = epochMs(pin.updatedAt);
  return pin.answers.some(
    answer =>
      answer.dismissed === true &&
      answer.by === "operator" &&
      !answer.moot &&
      epochMs(answer.at) >= closedAt
  );
}

/** The operator's act or a PM's ruling: what the R1 correction and the guard accept. */
function isOperatorOrPm(by: PinSettledBy): boolean {
  return by === "operator" || by === "pm";
}

/** A closure's reason, cut to its cap; unlike `capPinText`, never inside a surrogate pair. */
function cutReason(text: string): string {
  const max = PIN_CLOSURE_REASON_MAX_CHARS;
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 2);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 2 : max - 1;
  return `${text.slice(0, end)}…`;
}

/** An error's words; never throws (a thrown value may have no usable `toString`). */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "an error with no text";
  }
}

/** Where a failure happened, for its log line. */
type FailedAt = { sessionId: string; key: string };

export type PinFollowOptions = {
  pins: Pick<
    PinService,
    | "get"
    | "claimedBy"
    | "getByPinId"
    | "supersede"
    | "listOpenDetected"
    | "listOpenCopiesNaming"
    | "listReplacedBy"
    | "listOpenWithRepeats"
    | "listSessionsWithOpenDetected"
  >;
  /** A local session's namespace, or null when this node holds no such session. */
  getSessionNamespace(sessionId: string): string | null;
  pinsEnabled: boolean;
  errorLogger?: Pick<ErrorLogger, "warn"> | null;
  /** Runs one drain step later; `setImmediate` by default. */
  schedule?: (run: () => void) => void;
  /** Runs `run` after `ms`; `setTimeout` by default. */
  delay?: (run: () => void, ms: number) => void;
  now?: () => number;
};

/** Reads a pin by ID across the federation (`lookupPinById`), in a namespace. */
export type PinFollowLookup = (
  pinId: string,
  namespace: string
) => Promise<PinByIdOutcome>;

/** A by-ID read that says why a pin was not read (`PinFollow.lookupById`). */
export type PinFollowRead =
  | { kind: "found"; pin: Pin }
  | { kind: "missing" }
  | { kind: "local_only" }
  | {
      kind: "unread";
      reason: "offline" | "incomplete" | "ambiguous";
      /** The node labels: offline, unasked, or holding the ID. */
      nodes: string[];
    };

type Queued = { sessionId: string; key: string };

export class PinFollow {
  private readonly queue = new Map<string, Queued>();
  private readonly retried = new Set<string>();
  private draining = false;
  private cursor: { sessionId: string; key: string } | null = null;
  private lookupRemote: PinFollowLookup | null = null;
  private readonly schedule: (run: () => void) => void;
  private readonly delay: (run: () => void, ms: number) => void;
  private readonly now: () => number;

  constructor(private readonly options: PinFollowOptions) {
    this.schedule = options.schedule ?? (run => setImmediate(run));
    this.delay = options.delay ?? ((run, ms) => setTimeout(run, ms));
    this.now = options.now ?? Date.now;
  }

  /**
   * Set the federation lookup. Late-bound, because the node registry exists only
   * after the federation block in `index.ts`; until then (and on a node with no
   * registry) originals are read on this node only.
   */
  setLookup(lookup: PinFollowLookup | null): void {
    this.lookupRemote = lookup;
  }

  /** The EventPublisher listener: no database work, ever. */
  onEvent(event: SyncEvent): void {
    if (!this.options.pinsEnabled) return;
    if (event.type !== "pin-changed" || !event.sessionId || !event.key) return;
    this.enqueue({ sessionId: event.sessionId, key: event.key });
  }

  /** Resolves once the queue is empty (tests). */
  async idle(): Promise<void> {
    while (this.draining || this.queue.size > 0) {
      await new Promise<void>(resolve => this.schedule(resolve));
    }
  }

  private enqueue(item: Queued): void {
    this.queue.set(`${item.sessionId}\u0000${item.key}`, item);
    if (this.draining) return;
    this.draining = true;
    this.schedule(() => void this.drainOne());
  }

  /**
   * One queued pin. Nothing here rejects, and the next step is scheduled in
   * `finally`, so a fault in one item never stops the queue or leaves
   * `draining` stuck.
   */
  private async drainOne(): Promise<void> {
    const next = this.queue.entries().next();
    if (next.done) {
      this.draining = false;
      return;
    }
    const [id, item] = next.value;
    this.queue.delete(id);
    try {
      await this.follow(item.sessionId, item.key);
      this.retried.delete(id);
    } catch (error) {
      this.failed(id, item, error);
    } finally {
      this.schedule(() => void this.drainOne());
    }
  }

  /** A drain failure: one retry on a busy database, else the loop's next pass. */
  private failed(id: string, item: Queued, error: unknown): void {
    try {
      const busy = isSqliteBusy(error);
      if (busy && !this.retried.has(id)) {
        this.retried.add(id);
        this.delay(() => this.enqueue(item), PIN_FOLLOW_BUSY_RETRY_MS);
        this.log("write lock busy; retrying once", item, error, busy);
        return;
      }
      this.retried.delete(id);
      this.log(
        busy
          ? "write lock busy again; left to the next loop pass"
          : "follow failed; left to the next loop pass",
        item,
        error,
        busy
      );
    } catch {
      // A logger fault must not stop the queue either.
    }
  }

  /** What one changed pin settles, here and in its session. */
  async follow(sessionId: string, key: string): Promise<void> {
    const namespace = this.options.getSessionNamespace(sessionId);
    if (namespace === null) return;
    const pin = this.options.pins.get(sessionId, key)?.pin;
    if (!pin) return;
    const session: PinSessionRef = { id: sessionId, namespace };
    if (pin.status === "open") {
      // The event path reads originals on this node only, so a slow peer never
      // holds same-node closes behind it; the loop reads the other nodes.
      if ((pin.repeats ?? []).length > 0) {
        await this.followOriginals(session, pin, false);
      }
      return;
    }
    if (pin.status === "live") return;
    this.closeCopiesOf(session, pin);
    if (!isReservedPinKey(pin.key)) this.settleDetected(session);
  }

  /**
   * One loop pass: a page of open pins with `repeats` (originals on this node
   * and on others), then every open Detected pin with links, so a close a crash
   * left undelivered is still made.
   */
  async sweep(): Promise<void> {
    if (!this.options.pinsEnabled) return;
    // A blocked write sleeps the server for up to busy_timeout, so a pass ends at
    // the first busy database; the next pass resumes at that row.
    let before = this.cursor;
    const page = this.options.pins.listOpenWithRepeats(
      before,
      PIN_FOLLOW_PASS_ROWS
    );
    this.cursor =
      page.length < PIN_FOLLOW_PASS_ROWS
        ? null
        : (page[page.length - 1] ?? null);
    for (const row of page) {
      try {
        await this.sweepRow(row);
      } catch (error) {
        if (isSqliteBusy(error)) {
          this.cursor = before;
          this.log(
            "loop: write lock busy; the pass stops here",
            row,
            error,
            true
          );
          return;
        }
        this.log("loop: follow failed", row, error, false);
      }
      before = row;
    }
    for (const sessionId of this.options.pins.listSessionsWithOpenDetected()) {
      const at = { sessionId, key: "(its Detected pins)" };
      try {
        const namespace = this.options.getSessionNamespace(sessionId);
        if (namespace === null) continue;
        this.settleDetected({ id: sessionId, namespace });
      } catch (error) {
        const busy = isSqliteBusy(error);
        this.log(
          busy
            ? "loop: write lock busy; the pass stops here"
            : "loop: Detected settle failed",
          at,
          error,
          busy
        );
        if (busy) return;
      }
    }
  }

  private async sweepRow(row: FailedAt): Promise<void> {
    const namespace = this.options.getSessionNamespace(row.sessionId);
    if (namespace === null) return;
    const pin = this.options.pins.get(row.sessionId, row.key)?.pin;
    if (pin?.status !== "open") return;
    await this.followOriginals({ id: row.sessionId, namespace }, pin, true);
  }

  /**
   * (i) A closed pin closes the open copies of it on this node, in other
   * sessions of its namespace; also copies that name a pin it replaced. A pin
   * closed only because it was replaced closes no copy.
   */
  private closeCopiesOf(session: PinSessionRef, pin: Pin): void {
    if (!pin.pinId) return;
    const settlement = settlementOf(pin);
    if (!settlement) return;
    const named = this.replacedAncestry(session.id, pin.pinId);
    const copies = this.options.pins.listOpenCopiesNaming(named, session.id);
    for (const copy of copies) {
      if (
        this.options.getSessionNamespace(copy.sessionId) !== session.namespace
      ) {
        continue;
      }
      this.closeCopy(
        { id: copy.sessionId, namespace: session.namespace },
        copy.key,
        pin,
        settlement
      );
    }
  }

  /** `pinId` and the pins it replaced, at most `PIN_FOLLOW_MAX_STEPS` back. */
  private replacedAncestry(sessionId: string, pinId: string): string[] {
    const found = [pinId];
    let frontier = [pinId];
    for (
      let step = 0;
      step < PIN_FOLLOW_MAX_STEPS && frontier.length > 0;
      step++
    ) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const older of this.options.pins.listReplacedBy(sessionId, id)) {
          if (!found.includes(older)) {
            found.push(older);
            next.push(older);
          }
        }
      }
      frontier = next;
    }
    return found;
  }

  /**
   * (ii) An open copy is checked against the originals it names: any one that
   * is found, closed and not replaced closes it. A named pin of the copy's own
   * session is never followed.
   */
  private async followOriginals(
    session: PinSessionRef,
    copy: Pin,
    remote: boolean
  ): Promise<void> {
    for (const named of copy.repeats ?? []) {
      if (named === copy.pinId) continue;
      let original: Pin | null;
      try {
        original = await this.resolveOriginal(named, session.namespace, remote);
      } catch (error) {
        // One unreadable name leaves the copy's other names still checked.
        if (isSqliteBusy(error)) throw error;
        this.log(`reading ${named} failed`, copy, error, false);
        continue;
      }
      if (!original || original.sessionId === copy.sessionId) continue;
      const settlement = settlementOf(original);
      if (!settlement) continue;
      this.closeCopy(session, copy.key, original, settlement);
      return;
    }
  }

  /**
   * The pin `pinId` names now: read by ID (here, then on the other nodes), and
   * through a `replaced` closure to the pin that replaced it. Null unless found.
   */
  private async resolveOriginal(
    pinId: string,
    namespace: string,
    remote: boolean
  ): Promise<Pin | null> {
    let id = pinId;
    for (let step = 0; step <= PIN_FOLLOW_MAX_STEPS; step++) {
      const pin = await this.readById(id, namespace, remote);
      if (!pin) return null;
      const closure = countedClosure(pin);
      if (closure?.rule !== "replaced") return pin;
      if (!closure.ref) return null;
      id = closure.ref;
    }
    return null;
  }

  /**
   * A pin by its ID in `namespace`: this node's store, then the federation
   * lookup unless `remote` is false. Null unless found.
   */
  async readById(
    pinId: string,
    namespace: string,
    remote = true
  ): Promise<Pin | null> {
    const read = await this.lookupById(pinId, namespace, remote);
    return read.kind === "found" ? read.pin : null;
  }

  /**
   * `readById`, saying why a pin was not read: no node in reach holds it
   * (`missing`, another namespace's pin included), this node is a spoke that
   * searched only itself (`local_only`), or the federation could not answer for
   * certain (`unread`: a node was offline, the lookup was incomplete, or more
   * than one node holds the ID). The retire route's `ref` proof reads it, so a
   * miss it can retry is never reported as a pin that does not exist (PR-2,
   * 47a4dac9).
   */
  async lookupById(
    pinId: string,
    namespace: string,
    remote = true
  ): Promise<PinFollowRead> {
    const local = this.options.pins.getByPinId(pinId)?.pin;
    if (local) {
      return this.options.getSessionNamespace(local.sessionId) === namespace
        ? { kind: "found", pin: local }
        : { kind: "missing" };
    }
    if (!remote || !this.lookupRemote) return { kind: "missing" };
    const outcome = await this.lookupRemote(pinId, namespace);
    switch (outcome.kind) {
      case "found":
        return { kind: "found", pin: outcome.pin };
      case "not_found":
        if (outcome.localOnly) return { kind: "local_only" };
        return outcome.notAsked.length === 0
          ? { kind: "missing" }
          : {
              kind: "unread",
              reason: "offline",
              nodes: outcome.notAsked.map(node => node.nodeLabel),
            };
      case "incomplete":
        return {
          kind: "unread",
          reason: "incomplete",
          nodes: outcome.nodes.map(node => node.nodeLabel),
        };
      case "ambiguous":
        return {
          kind: "unread",
          reason: "ambiguous",
          nodes: outcome.matches.map(match => match.nodeLabel),
        };
    }
  }

  private closeCopy(
    session: PinSessionRef,
    key: string,
    original: Pin,
    settlement: PinSettlement
  ): void {
    // The operator's answer to this pin is being delivered (a Submit claims its
    // pins across the send), and closing it now would make that answer moot.
    // The Submit's own event, or the next loop pass, settles it instead.
    if (this.options.pins.claimedBy(session.id, key)) return;
    const ref = original.pinId ?? undefined;
    const closure: PinClosure = {
      how: "superseded",
      by: "server",
      rule: "repeats",
      at: new Date(this.now()).toISOString(),
      ...(ref ? { ref } : {}),
      reason: cutReason(`${ref ?? "The pin it repeats"} ${settlement.words}`),
      settledBy: settlement.by,
    };
    this.options.pins.supersede(session, key, closure, this.now());
  }

  /**
   * (iii) The session's open Detected pins whose every linked pin is settled
   * close as superseded (R4, with the R1 correction and the operator guard).
   */
  private settleDetected(session: PinSessionRef): void {
    for (const detected of this.options.pins.listOpenDetected(session.id)) {
      if (detected.reopened || detected.state.links.length === 0) continue;
      const settled: Array<{ pin: Pin; settlement: PinSettlement }> = [];
      for (const link of detected.state.links) {
        const result = this.linkSettlement(
          session.id,
          link.pinId,
          detected.createdAt
        );
        if (!result) break;
        settled.push(result);
      }
      if (settled.length !== detected.state.links.length) continue;
      // As in `closeCopy`: never inside a Submit's claim on this pin.
      if (this.options.pins.claimedBy(session.id, detected.key)) continue;
      const operatorHeld = detected.starred || detected.operatorAnswered;
      if (
        operatorHeld &&
        !settled.every(s => isOperatorOrPm(s.settlement.by))
      ) {
        continue;
      }
      const agentAct = settled.some(s => s.settlement.by === "agent");
      const first = settled[0];
      const reason = cutReason(
        settled
          .map(s => `${s.pin.pinId ?? s.pin.key} ${s.settlement.words}`)
          .join("; ")
      );
      const closure: PinClosure = {
        how: "superseded",
        by: agentAct ? "agent" : "server",
        rule: "linked",
        at: new Date(this.now()).toISOString(),
        ...(agentAct ? { bySession: session.id } : {}),
        ...(first?.pin.pinId ? { ref: first.pin.pinId } : {}),
        reason,
        settledBy: first?.settlement.by,
      };
      this.options.pins.supersede(session, detected.key, closure, this.now());
    }
  }

  /**
   * A link's settlement, read on this node (a link is always to a pin of the
   * Detected pin's own session) through any `replaced` closure, or null when it
   * does not settle the Detected pin made at `detectedCreatedAt`.
   */
  private linkSettlement(
    sessionId: string,
    pinId: string,
    detectedCreatedAt: number
  ): { pin: Pin; settlement: PinSettlement } | null {
    let id = pinId;
    for (let step = 0; step <= PIN_FOLLOW_MAX_STEPS; step++) {
      const pin = this.options.pins.getByPinId(id)?.pin;
      if (!pin || pin.sessionId !== sessionId) return null;
      const closure = countedClosure(pin);
      if (closure?.rule === "replaced") {
        if (!closure.ref) return null;
        id = closure.ref;
        continue;
      }
      const settlement = settlementOf(pin);
      if (!settlement) return null;
      // The R1 correction: a pin made after the Detected pin settles it only by
      // the operator's act or a PM's ruling.
      const createdAt = Date.parse(pin.createdAt);
      if (!(createdAt < detectedCreatedAt) && !isOperatorOrPm(settlement.by)) {
        return null;
      }
      return { pin, settlement };
    }
    return null;
  }

  /**
   * A failure's warning, naming the pin. A busy database is a console line only,
   * because a row written while the lock is held would wait on it (#3631); any
   * other fault is persisted, so a pin that keeps failing leaves a record.
   */
  private log(
    message: string,
    at: FailedAt,
    error: unknown,
    busy: boolean
  ): void {
    const detail = errorText(error);
    this.options.errorLogger?.warn(
      `pin follow: ${message} (session ${at.sessionId}, pin ${at.key}): ${detail}`,
      {
        category: "pin-follow",
        sessionId: at.sessionId,
        context: { key: at.key, error: detail },
        persist: !busy,
      }
    );
  }
}

/**
 * The follow loop: every five minutes and once after boot. Inert (a "stopped"
 * row) while Pins is off.
 */
export function createPinFollowLoop(deps: {
  follow: Pick<PinFollow, "sweep">;
  node: string;
  registry?: JobRegistry;
  enabled: boolean;
  onEvent?: (event: JobFailureEvent) => void;
}): SupervisedLoop {
  return new SupervisedLoop({
    name: PIN_FOLLOW_JOB,
    node: deps.node,
    intervalMs: PIN_FOLLOW_INTERVAL_MS,
    immediate: true,
    enabled: deps.enabled,
    registry: deps.registry,
    onEvent: deps.onEvent,
    tick: () => deps.follow.sweep(),
  });
}
