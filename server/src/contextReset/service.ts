// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The context-reset service (issue #6559, Task 9; R1, R2, R4, R6, R7, R8, R9,
 * R10, R11, R12, R13, R15).
 *
 * A lane arms a reset over its wrapper's socket. The service stores one pending
 * request per session, bound to the arming turn, and answers. When the arming
 * turn ends cleanly and every safe point holds it sends ONE message through the
 * engine that both resets the conversation (`contextReset: {armId}`) and carries
 * the resume text; when a safe point never holds, a hard condition appears or
 * another turn ends cleanly first, it sends the text without the flag. The
 * wrapper reports a flagged send on confirmation (`recordResult`).
 *
 * The state machine, per request (`context_reset_requests`, one row per
 * session):
 *
 *   armed ──flagged send commits──▶ firing ──wrapper result──▶ delivered_reset
 *     │                               │                        delivered_no_reset
 *     │                               └─no result in time / failed──▶ unconfirmed
 *     ├─send without the flag commits──▶ delivered_no_reset  (ruling Q13 option 1, see `fire`)
 *     ├─interrupt / abort / cancel / disarm / abandoned / send failed──▶ dropped
 *     └─session still inactive at its deadline──▶ expired
 *
 * Always keep these rules, because each one is what keeps a lane from being
 * stranded or dispatched twice:
 *   - The backstop loop runs when the switch is off: a request armed before the
 *     switch went off still owes its lane a delivery (it goes without the flag),
 *     and a hub restart orphans the arming turn, whose finalize is then never
 *     seen (`turnLifecycle.ts:505-511`).
 *   - A request's message is sent at most once. The flagged send moves the row
 *     `armed → firing` in the message insert's own transaction; a `firing` row
 *     with no result after `resultTimeoutMs` ends `unconfirmed` with a
 *     needs-attention notice and is never re-sent, because the server cannot tell
 *     a lost message from a lost result.
 *   - The delivery id (the message's `localId`) is minted here, per request, and
 *     no route returns it. A replayed id ends the row `dropped:delivery_id_collision`.
 *   - An interrupt of any tracked turn while a request is pending drops it and
 *     sends nothing (ruling Q6a). An interrupted finalize for a turn the server
 *     never saw opened drops nothing and only disallows the reset (binding 4).
 *     Since #6617 the wrapper also finalizes a turn `interrupted` when it stops a
 *     query for a permission-mode switch; the payload does not say why, so that
 *     stop drops the request too (open question Q12, ruled Option 1: keep Q6a).
 *
 * The lock read is the arming turn's label events, handed in by the finalize
 * step (Task 10) from its in-memory enrichment. It is gone after a hub restart,
 * so a pending request then reads `lock_unknown`, defers, and is delivered
 * without a reset at its deadline: the conservative side of "never lose a lock"
 * (ruling Q5a). Earlier turns' locks are named by the lane's checkpoint.
 *
 * Every dependency is a narrow port, wired in `server/src/index.ts` (Task 10),
 * so the tests run on fakes. Methods never throw to their caller: the socket
 * handlers and finalize step are fail-open, so every public entry catches.
 */

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONTEXT_RESET_DEFAULTS,
  CONTEXT_RESET_SENT_FROM,
  SupervisedLoop,
  abandonedArmIds,
  type ContextResetArmRefusal,
  type ContextResetArmRequest,
  type ContextResetArmResult,
  type ContextResetCancelResult,
  type ContextResetConfig as SharedContextResetConfig,
  type ContextResetResult,
  type ContextResetTrigger,
  type JobRegistry,
} from "@hapi/protocol";
import type { Session, SyncEvent } from "@hapi/protocol/types";

import type { ErrorLogger } from "../logging/errorLogger";
import type {
  ContextResetRequestRow,
  NewContextResetRequest,
} from "../store/contextResetStore";
import { globalChallengeDir } from "../services/approvalTokens";
import { checkArm, decideFire, hasPendingChallenge } from "./policy";
import {
  extractInstructingMessages,
  renderResumeMessage,
  type StoredMessageLike,
} from "./render";

/** The config the service reads; `loadContextResetConfig`'s result satisfies it. */
export type ContextResetServiceConfig = SharedContextResetConfig;

/** The store methods the service uses (`ContextResetStore`). */
export interface ContextResetRequests {
  arm(input: NewContextResetRequest): boolean;
  get(sessionId: string): ContextResetRequestRow | null;
  listPending(): ContextResetRequestRow[];
  markFiring(
    sessionId: string,
    armId: string,
    deliveryId: string,
    firedAtMs: number,
    opts?: { requireResetAllowed?: boolean }
  ): boolean;
  finish(
    sessionId: string,
    armId: string,
    opts: {
      state:
        | "delivered_reset"
        | "delivered_no_reset"
        | "unconfirmed"
        | "dropped"
        | "expired";
      fromStates?: readonly ("armed" | "firing")[];
      outcome?: string;
      reason?: string | null;
      newConversationId?: string | null;
    }
  ): boolean;
  setDeferReason(
    sessionId: string,
    armId: string,
    reason: string | null
  ): boolean;
  disallowReset(sessionId: string): boolean;
  incrementFireAttempts(sessionId: string, armId: string): number | null;
}

/** What the engine's `sendMessage` answers, narrowed to what the service reads. */
export type ContextResetSendResult =
  | { delivered: true; replayed?: true }
  | { delivered: false; reason: string };

export interface ContextResetSendPayload {
  text: string;
  /** The delivery id the service minted for this request. */
  localId: string;
  sentFrom: typeof CONTEXT_RESET_SENT_FROM;
  /** Present only for a send that resets. */
  contextReset?: { armId: string };
  /** Runs in the message insert's own transaction; false persists nothing. */
  record: () => boolean;
}

export interface ContextResetEngine {
  getSession(sessionId: string): Session | undefined;
  subscribe(listener: (event: SyncEvent) => void): () => void;
  /** Always through the engine, because every state change is broadcast from there. */
  sendMessage(
    sessionId: string,
    payload: ContextResetSendPayload
  ): Promise<ContextResetSendResult>;
}

/** A label event of a turn, as the transcript parser records it. */
export interface ContextResetLabelEvent {
  kind: string;
  name: string | null;
  payload?: Record<string, unknown> | null;
}

/** What `context_reset` turn events carry (Task 12). */
export interface ContextResetEvent {
  sessionId: string;
  /** The arming turn, or the open turn of a refused arm. */
  turnSeq: number | null;
  armId: string;
  trigger: ContextResetTrigger;
  /** `armed`, `refused`, or the terminal state. */
  outcome: string;
  reason: string | null;
  fromStage: string | null;
  toStage: string | null;
  issue: string | null;
  contextBefore: number | null;
  newConversationId: string | null;
}

export interface ContextResetServiceOptions {
  requests: ContextResetRequests;
  engine: ContextResetEngine;
  /** Read fresh at every arm and evaluation, so the switch applies at once. */
  loadConfig: () =>
    | Promise<ContextResetServiceConfig>
    | ContextResetServiceConfig;
  /** The seq of the session's open turn, or null. */
  getOpenTurnSeq: (sessionId: string) => number | null;
  /** A watermark handoff is armed or in flight for the session. */
  isHandoffHeld: (sessionId: string) => boolean;
  /** An unanswered approval challenge (`readChallengeInput` + `hasPendingChallenge`). */
  challengePending: (session: Session) => boolean;
  /** Every stored message of the session, oldest first. */
  listSessionMessages: (sessionId: string) => readonly StoredMessageLike[];
  /** The session's active file claims, as `repo:path`. */
  listActiveClaims: (sessionId: string) => readonly string[];
  /** Zero and persist the session's context figures (R12; Task 10 item 9). */
  zeroContextUsage: (sessionId: string) => void;
  /** Re-record a grant mint found on disk after a reset (Task 10 item 9). */
  rerecordGrantMint?: (sessionId: string) => void;
  /** Write one `context_reset` turn event (Task 12). */
  recordEvent?: (event: ContextResetEvent) => void;
  /**
   * ROUND RV10 item 2: wake the session's queue drain once, after a hold that
   * ended with no new turn (`QueueDrainObserver.wake`).
   */
  wakeQueueDrain?: (sessionId: string) => void;
  nodeId: string;
  jobRegistry?: JobRegistry | null;
  errorLogger?: ErrorLogger | null;
  now?: () => number;
  /**
   * A fixed backstop tick (a test seam). When absent, each tick reads
   * `backstopTickMs` and it sets the delay before the next tick.
   */
  tickMs?: number;
  /** Test seam: mint a delivery id. */
  mintDeliveryId?: () => string;
  /** Test seam: schedule the settle evaluation. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** The fields of a request a route may return: never the delivery id. */
export type ContextResetPublicRow = Omit<ContextResetRequestRow, "deliveryId">;

/** The lock read of a turn's label events. */
export interface LockRead {
  state: "none" | "held" | "unknown";
  /** The lock labels known to be held, in the order they were added. */
  locks: string[];
}

/** A label that is a workflow lock (`🔒 locked: …`, with or without the space). */
export function isLockLabel(label: string): boolean {
  return /^[^a-z0-9]*locked\s*:/i.test(label);
}

/**
 * The lock read of the arming turn's label events (ruling Q5a). `null` events —
 * the turn was never parsed — read `unknown`. A label change the parser could
 * not resolve reads `unknown` when it could have added a lock, or removed one
 * that was held at that point; one that could only have removed a lock nobody
 * held changes nothing.
 */
export function readLocks(
  events: readonly ContextResetLabelEvent[] | null
): LockRead {
  if (events === null) return { state: "unknown", locks: [] };
  const held: string[] = [];
  let ambiguous = false;
  for (const ev of events) {
    if (ev.kind !== "label_added" && ev.kind !== "label_removed") continue;
    const unresolved = ev.name === null || ev.payload?.unresolved === true;
    if (unresolved) {
      if (ev.kind === "label_added" || held.length > 0) ambiguous = true;
      continue;
    }
    const name = ev.name as string;
    if (!isLockLabel(name)) continue;
    const at = held.indexOf(name);
    if (ev.kind === "label_added") {
      if (at === -1) held.push(name);
    } else if (at !== -1) {
      held.splice(at, 1);
    }
  }
  if (ambiguous) return { state: "unknown", locks: held };
  return { state: held.length > 0 ? "held" : "none", locks: held };
}

const ISSUE_CHALLENGE_RE = /^\.approval-challenge-(.+)\.json$/;

function readNonce(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const nonce =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).nonce
        : undefined;
    return typeof nonce === "string" && nonce !== "" ? nonce : null;
  } catch {
    return null;
  }
}

/**
 * The names in a challenge folder. ROUND RV10 item 6: a folder that does not
 * exist holds no challenge, but one that exists and cannot be read is unknown,
 * like an unreadable challenge file, so the read throws and the caller's
 * fail-closed path counts a challenge as pending.
 */
function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw new Error(
      `challenge folder ${dir} cannot be read (${code ?? errorText(error)})`
    );
  }
}

/**
 * The challenge facts on disk for Task 8's `hasPendingChallenge`: each
 * `.approval-challenge-<key>.json` in the session's `claudedocs/` with the nonce
 * of its `.user-approval-granted-<key>.json`, and the session id each global
 * challenge record carries (`session_id` or `sessionId`). An unreadable
 * challenge reads with no nonce, which the policy counts as pending.
 */
export function readChallengeInput(input: {
  worktree: string | null | undefined;
  stateDir: string | null | undefined;
}): {
  challenges: { key: string; nonce: string | null }[];
  grantNonceByKey: Map<string, string>;
  globalChallengeSessionIds: (string | null)[];
} {
  const challenges: { key: string; nonce: string | null }[] = [];
  const grantNonceByKey = new Map<string, string>();
  if (input.worktree) {
    const dir = join(input.worktree, "claudedocs");
    for (const name of listDir(dir)) {
      const m = ISSUE_CHALLENGE_RE.exec(name);
      if (!m) continue;
      const key = m[1];
      challenges.push({ key, nonce: readNonce(join(dir, name)) });
      const grant = readNonce(join(dir, `.user-approval-granted-${key}.json`));
      if (grant !== null) grantNonceByKey.set(key, grant);
    }
  }
  const globalChallengeSessionIds: (string | null)[] = [];
  if (input.stateDir) {
    const dir = globalChallengeDir(input.stateDir);
    for (const name of listDir(dir)) {
      if (!ISSUE_CHALLENGE_RE.test(name)) continue;
      let sid: string | null = null;
      try {
        const rec = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<
          string,
          unknown
        >;
        const v = rec?.session_id ?? rec?.sessionId;
        sid = typeof v === "string" && v !== "" ? v : null;
      } catch {
        sid = null;
      }
      globalChallengeSessionIds.push(sid);
    }
  }
  return { challenges, grantNonceByKey, globalChallengeSessionIds };
}

/** The challenge test for a session, read from disk (the `challengePending` port). */
export function challengePendingOnDisk(
  session: Pick<Session, "id" | "tag" | "metadata">,
  stateDir: string | null | undefined
): boolean {
  const facts = readChallengeInput({
    worktree: session.metadata?.path,
    stateDir,
  });
  const sessionIds = [session.id];
  if (typeof session.tag === "string" && session.tag !== "") {
    sessionIds.push(session.tag);
  }
  return hasPendingChallenge({ ...facts, sessionIds });
}

/**
 * `MessageService.sendMessage` throws `RecordVetoError` when the record step
 * declines. Matched by name, so this module does not load the message service.
 */
function isRecordVeto(error: unknown): boolean {
  return error instanceof Error && error.name === "RecordVetoError";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPendingState(state: string): boolean {
  return state === "armed" || state === "firing";
}

/** ROUND RV10, Finding 1: the states a drop may move, unless a caller names more. */
const DROP_FROM_ARMED = ["armed"] as const;
/** The one drop that also ends a `firing` row: its session is gone. */
const DROP_FROM_PENDING = ["armed", "firing"] as const;
/**
 * ROUND RV10 item 2: the endings that start no turn. A delivery's message starts
 * one, and that turn's idle edge drains the queue; these leave no edge behind.
 */
const ENDS_WITH_NO_TURN = new Set(["dropped", "expired", "unconfirmed"]);

function alreadyDelivering(): ContextResetCancelResult {
  return { cancelled: false, reason: "already_delivering" };
}

export class ContextResetService {
  private readonly loop: SupervisedLoop;
  /** The delay before the next backstop tick (A1, #6559 PR 1 round 2). */
  private backstopTickMs: number;
  private readonly now: () => number;
  private readonly bootAtMs: number;
  /** Turns the server tracked as opened, per session (binding 4). */
  private readonly openTurns = new Map<string, Set<number>>();
  /** When the arming turn finalized cleanly, per arm id. */
  private readonly cleanFinalizeAt = new Map<string, number>();
  /** The arming turn's lock read, per arm id. */
  private readonly lockReads = new Map<string, LockRead>();
  /** The delivery id minted for a request, per arm id. */
  private readonly deliveryIds = new Map<string, string>();
  /** Sessions with an `armed` or `firing` request: the one hold (R13). */
  private readonly pending = new Set<string>();
  /** Sessions being evaluated now, so a timer and a tick never fire together. */
  private readonly evaluating = new Set<string>();
  private readonly settleTimers = new Map<string, unknown>();
  private unsubscribe: (() => void) | null = null;
  private started = false;

  constructor(private readonly opts: ContextResetServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.bootAtMs = this.now();
    this.backstopTickMs = opts.tickMs ?? CONTEXT_RESET_DEFAULTS.backstopTickMs;
    this.loop = new SupervisedLoop({
      name: "context-reset",
      node: opts.nodeId,
      intervalMs: this.backstopTickMs,
      getIntervalMs: () => this.backstopTickMs,
      immediate: false,
      registry: opts.jobRegistry ?? undefined,
      tick: () => this.runTick(),
    });
  }

  /** Boot: load the pending rows; the loop does the rest. */
  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      for (const row of this.opts.requests.listPending()) {
        this.pending.add(row.sessionId);
      }
    } catch (error) {
      this.warn("could not load pending requests at boot", { error });
    }
    this.unsubscribe = this.opts.engine.subscribe(event => {
      if (event.type === "session-removed") {
        this.dropForRemovedSession(event.sessionId);
      }
    });
    this.loop.start();
  }

  stop(): void {
    this.started = false;
    this.loop.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const handle of this.settleTimers.values()) this.clear(handle);
    this.settleTimers.clear();
  }

  /** True while the session has an `armed` or `firing` request (R13's one hold). */
  isPending(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  /** The session's request for the read route, without the delivery id. */
  getRequest(sessionId: string): ContextResetPublicRow | null {
    const row = this.opts.requests.get(sessionId);
    if (!row) return null;
    const { deliveryId: _omit, ...rest } = row;
    return rest;
  }

  // ── Arm and disarm ────────────────────────────────────────────────────

  /** R1, R5: answer an arm. Never throws; an internal error refuses. */
  async arm(
    sessionId: string,
    request: ContextResetArmRequest
  ): Promise<ContextResetArmResult> {
    try {
      return await this.armInner(sessionId, request);
    } catch (error) {
      this.warn("arm failed; refused", { sessionId, error });
      return { armed: false };
    }
  }

  private async armInner(
    sessionId: string,
    request: ContextResetArmRequest
  ): Promise<ContextResetArmResult> {
    const config = await this.opts.loadConfig();
    const session = this.opts.engine.getSession(sessionId);
    const openTurnSeq = this.opts.getOpenTurnSeq(sessionId);
    const existing = this.opts.requests.get(sessionId);
    const trigger = request.trigger ?? "stage";
    const decision = checkArm({
      enabled: config.enabled,
      sessionActive: session?.active === true,
      openTurnSeq,
      launcherKind: session?.metadata?.launcherKind,
      hasPendingRequest: existing ? isPendingState(existing.state) : false,
      challengePending: session ? this.safeChallenge(session) : false,
      busy: {
        thinking: session?.thinking,
        backgroundAgents: session?.backgroundAgents ?? null,
      },
      sessionTimers: request.wrapperFacts?.sessionTimers ?? 0,
      handoffActive: this.opts.isHandoffHeld(sessionId),
      request,
    });
    const contextBefore = session?.contextUsedTokens ?? null;
    if (!decision.armed) {
      this.refusedEvent(sessionId, openTurnSeq, request, decision.reason, {
        trigger,
        contextBefore,
      });
      return { armed: false, reason: decision.reason };
    }
    const now = this.now();
    const stored = this.opts.requests.arm({
      sessionId,
      armId: request.armId,
      turnSeq: openTurnSeq,
      resumeText: request.resume,
      trigger,
      checkpointPath: request.checkpointPath ?? null,
      fromStage: request.fromStage ?? null,
      toStage: request.toStage ?? null,
      stageArgs: request.stageArgs ?? null,
      issueRef: request.issue ?? null,
      armedAtMs: now,
      deadlineAtMs: now + config.maxDeferMs,
      contextBefore,
    });
    if (!stored) {
      // Another arm won the race between the read above and the write.
      this.refusedEvent(sessionId, openTurnSeq, request, "already_pending", {
        trigger,
        contextBefore,
      });
      return { armed: false, reason: "already_pending" };
    }
    this.pending.add(sessionId);
    this.cleanFinalizeAt.delete(request.armId);
    this.lockReads.delete(request.armId);
    this.emitEvent({
      sessionId,
      turnSeq: openTurnSeq,
      armId: request.armId,
      trigger,
      outcome: "armed",
      reason: null,
      fromStage: request.fromStage ?? null,
      toStage: request.toStage ?? null,
      issue: request.issue ?? null,
      contextBefore,
      newConversationId: null,
    });
    return { armed: true };
  }

  /** The wrapper gave up on an arm: a pending row with that arm id ends `dropped:disarmed`. */
  disarm(sessionId: string, armId: string): boolean {
    return this.safeDrop(sessionId, armId, "disarmed");
  }

  /**
   * The operator's cancel (Task 11): an `armed` row ends `dropped:cancelled`.
   * ROUND RV10, Finding 1: a `firing` row is refused `already_delivering` and
   * stays firing, because its flagged message is already stored and sent.
   */
  cancel(sessionId: string): ContextResetCancelResult {
    const row = this.safeGet(sessionId);
    if (!row || !isPendingState(row.state)) return { cancelled: false };
    if (row.state === "firing") return alreadyDelivering();
    if (this.safeDrop(sessionId, row.armId, "cancelled")) {
      return { cancelled: true };
    }
    // The fire may have won between the read and the drop.
    return this.safeGet(sessionId)?.state === "firing"
      ? alreadyDelivering()
      : { cancelled: false };
  }

  /**
   * An abort of the session (`abortSession`, Task 10): an `armed` row ends
   * `dropped:aborted`. ROUND RV10, Finding 1: the abort stops the turn and does
   * not end a `firing` row (`drop` moves armed rows only).
   */
  abort(sessionId: string): boolean {
    const row = this.safeGet(sessionId);
    if (!row || !isPendingState(row.state)) return false;
    return this.safeDrop(sessionId, row.armId, "aborted");
  }

  // ── Turn and session lifecycle ────────────────────────────────────────

  /** Binding 4: the turn is tracked; a turn other than the arming one disallows the reset. */
  onTurnOpen(sessionId: string, seq: number): void {
    try {
      let turns = this.openTurns.get(sessionId);
      if (!turns) {
        turns = new Set();
        this.openTurns.set(sessionId, turns);
      }
      turns.add(seq);
      const row = this.opts.requests.get(sessionId);
      if (row && isPendingState(row.state) && row.turnSeq !== seq) {
        this.opts.requests.disallowReset(sessionId);
      }
    } catch (error) {
      this.warn("onTurnOpen failed", { sessionId, seq, error });
    }
  }

  /**
   * A turn ended. Claude wrappers send only `completed` and `interrupted`.
   * `labelEvents` is the turn's parsed label events, or null when the turn was
   * not parsed (an orphan of a restart).
   */
  onTurnFinalize(
    sessionId: string,
    seq: number,
    outcome: string,
    labelEvents: readonly ContextResetLabelEvent[] | null = null
  ): void {
    try {
      const turns = this.openTurns.get(sessionId);
      const sawOpen = turns?.delete(seq) ?? false;
      const row = this.opts.requests.get(sessionId);
      if (!row || !isPendingState(row.state)) return;
      const arming = row.turnSeq !== null && row.turnSeq === seq;
      const tracked = sawOpen || arming;
      if (outcome === "interrupted") {
        // ROUND RV10, Finding 1: on a `firing` row neither branch changes
        // anything. `drop` moves armed rows only, and binding 4's "disallow the
        // reset" has nothing left to disallow: the flagged message is sent.
        if (tracked) {
          this.drop(row, "interrupted");
        } else {
          this.opts.requests.disallowReset(sessionId);
        }
        return;
      }
      if (outcome !== "completed") return;
      if (arming) {
        this.cleanFinalizeAt.set(row.armId, this.now());
        this.lockReads.set(row.armId, readLocks(labelEvents));
      } else {
        this.opts.requests.disallowReset(sessionId);
      }
      if (row.state === "armed") this.scheduleSettle(sessionId);
    } catch (error) {
      this.warn("onTurnFinalize failed", { sessionId, seq, error });
    }
  }

  /**
   * A finalize the hub could resolve to no turn (Task 10 item 1): its boot
   * sweep closed the turn after a restart, so the seq is unknown. Handed over
   * RAW, because an operator's stop of that turn must still drop the request.
   *   - `interrupted` with the request armed before this process booted: that
   *     turn was open across the restart, so the previous process tracked it
   *     (the arming turn or one after it): drop (ruling Q6a).
   *   - `interrupted` with the request armed after boot: the arming turn is
   *     tracked by this process, so the stopped turn is one it never saw opened:
   *     drop nothing, disallow the reset (binding 4).
   *   - `completed`: a turn ended cleanly with no seq to match against the
   *     arming one; disallow the reset and evaluate, so the text goes without
   *     it. After a restart the lock read is unknown anyway (ruling Q5a).
   */
  onUnresolvedFinalize(sessionId: string, outcome: string): void {
    try {
      const row = this.opts.requests.get(sessionId);
      if (!row || !isPendingState(row.state)) return;
      if (outcome === "interrupted") {
        if (row.armedAtMs < this.bootAtMs) this.drop(row, "interrupted");
        else this.opts.requests.disallowReset(sessionId);
        return;
      }
      if (outcome !== "completed") return;
      this.opts.requests.disallowReset(sessionId);
      if (row.state === "armed") this.scheduleSettle(sessionId);
    } catch (error) {
      this.warn("onUnresolvedFinalize failed", { sessionId, outcome, error });
    }
  }

  /**
   * A respawn (account switch, token-refresh restart, relaunch): keep the row,
   * because the respawned lane resumes a conversation that was told "armed, end
   * your turn"; disallow the reset. Safe to call twice (#3478: two ends).
   */
  onSessionRespawn(sessionId: string): void {
    try {
      this.opts.requests.disallowReset(sessionId);
    } catch (error) {
      this.warn("onSessionRespawn failed", { sessionId, error });
    }
  }

  /**
   * A terminal end, never a respawn. A deleted session's row ends
   * `dropped:session_ended`; a session that still exists defers as
   * `session_inactive` and ends `expired` at its deadline.
   */
  onSessionEnd(sessionId: string): void {
    this.openTurns.delete(sessionId);
    if (this.opts.engine.getSession(sessionId)) return;
    this.dropForRemovedSession(sessionId);
  }

  private dropForRemovedSession(sessionId: string): void {
    this.openTurns.delete(sessionId);
    const row = this.safeGet(sessionId);
    // ROUND RV10, Finding 1: the one drop that also ends a `firing` row. The
    // session is gone, so no result can come and nobody is left to notify;
    // `session_ended` says so.
    if (row && isPendingState(row.state)) {
      this.drop(row, "session_ended", undefined, DROP_FROM_PENDING);
    }
  }

  /**
   * ROUND RV10, Finding 1: a wrapper result that moves nothing is never dropped
   * silently. One line (category `context-reset`) with the request's final
   * state.
   */
  private lateResult(
    sessionId: string,
    result: ContextResetResult,
    row: ContextResetRequestRow | null
  ): void {
    const stateText = (r: ContextResetRequestRow): string =>
      r.outcomeReason ? `${r.state}:${r.outcomeReason}` : r.state;
    const found = !row
      ? "no request is stored"
      : row.armId !== result.armId
        ? `the stored request is arm ${row.armId} (${stateText(row)})`
        : `the request is ${stateText(row)}`;
    this.logLine(
      `[context-reset] a wrapper result (${result.outcome}) for session ${sessionId} arm ${result.armId} was not recorded: ${found}`,
      {
        sessionId,
        armId: result.armId,
        outcome: result.outcome,
        state: row?.state ?? null,
        reason: row?.outcomeReason ?? null,
      }
    );
  }

  /** One line (category `context-reset`) through the error logger, else the console. */
  private logLine(message: string, context: Record<string, unknown>): void {
    if (!this.opts.errorLogger) {
      console.warn(message);
      return;
    }
    this.opts.errorLogger.warn(message, { category: "context-reset", context });
  }

  // ── The wrapper's result ──────────────────────────────────────────────

  /**
   * The wrapper's `context-reset:result`, accepted only for a `firing` row with
   * that arm id. Only a flagged send is reported here. This is the only writer
   * of `delivered_reset`, and of `delivered_no_reset` for a flagged send the
   * wrapper delivered as plain text.
   *
   * The one exception to "only the wrapper's result writes `delivered_*`": a
   * send the SERVER decided to make without the flag ends `delivered_no_reset`
   * in its own record step (`fire`), because the wrapper never reports a plain
   * message (ruling Q13, option 1, by the board-26 PM, 2026-11-13).
   */
  recordResult(sessionId: string, result: ContextResetResult): boolean {
    try {
      const row = this.opts.requests.get(sessionId);
      if (!row || row.armId !== result.armId || row.state !== "firing") {
        this.lateResult(sessionId, result, row);
        return false;
      }
      if (result.outcome === "delivered_reset") {
        const moved = this.opts.requests.finish(sessionId, row.armId, {
          state: "delivered_reset",
          fromStates: ["firing"],
          newConversationId: result.newConversationId ?? null,
        });
        if (!moved) return false;
        // ROUND RV10, Finding 1: the effects first, the hold lifted last. The
        // session stays in `pending` until `afterTerminal`, so the queue drain
        // and the keep-alive hold while the figures are zeroed and the grants
        // re-recorded.
        this.safeCall("zeroContextUsage", () =>
          this.opts.zeroContextUsage(sessionId)
        );
        if (this.opts.rerecordGrantMint) {
          const rerecord = this.opts.rerecordGrantMint;
          this.safeCall("rerecordGrantMint", () => rerecord(sessionId));
        }
        this.afterTerminal(row, "delivered_reset", null, {
          newConversationId: result.newConversationId ?? null,
        });
        return true;
      }
      if (result.outcome === "delivered_no_reset") {
        const reason = result.reason ?? null;
        const moved = this.opts.requests.finish(sessionId, row.armId, {
          state: "delivered_no_reset",
          fromStates: ["firing"],
          reason,
        });
        if (moved) this.afterTerminal(row, "delivered_no_reset", reason);
        return moved;
      }
      // `failed`: the wrapper took the item and no fresh conversation came up.
      const reason = `wrapper_failed:${result.reason ?? "unknown"}`;
      const moved = this.opts.requests.finish(sessionId, row.armId, {
        state: "unconfirmed",
        fromStates: ["firing"],
        reason,
      });
      if (moved) {
        this.afterTerminal(row, "unconfirmed", reason);
        this.notice(row, reason);
      }
      return moved;
    } catch (error) {
      this.warn("recordResult failed", { sessionId, error });
      return false;
    }
  }

  // ── Evaluation ────────────────────────────────────────────────────────

  private async runTick(): Promise<void> {
    if (this.opts.tickMs === undefined) {
      try {
        this.backstopTickMs = (await this.opts.loadConfig()).backstopTickMs;
      } catch (error) {
        this.warn("could not read backstopTickMs; the tick is unchanged", {
          error,
        });
      }
    }
    let rows: ContextResetRequestRow[];
    try {
      rows = this.opts.requests.listPending();
    } catch (error) {
      console.error("[context-reset] tick could not list requests:", error);
      throw error;
    }
    for (const row of rows) {
      await this.evaluate(row.sessionId);
    }
  }

  /** Exposed for tests: one backstop tick. */
  async tick(): Promise<void> {
    await this.runTick();
  }

  private scheduleSettle(sessionId: string): void {
    const existing = this.settleTimers.get(sessionId);
    if (existing !== undefined) this.clear(existing);
    void Promise.resolve(this.opts.loadConfig())
      .then(config => {
        const handle = this.schedule(() => {
          this.settleTimers.delete(sessionId);
          // Nothing awaits a timer: always catch here.
          this.evaluate(sessionId).catch(error =>
            this.warn("settle evaluation failed", { sessionId, error })
          );
        }, config.settleMs);
        this.settleTimers.set(sessionId, handle);
      })
      .catch(error =>
        this.warn("settle scheduling failed", { sessionId, error })
      );
  }

  /** Evaluate the session's pending request once. Never throws. */
  async evaluate(sessionId: string): Promise<void> {
    if (this.evaluating.has(sessionId)) return;
    this.evaluating.add(sessionId);
    try {
      await this.evaluateInner(sessionId);
    } catch (error) {
      this.warn("evaluation failed", { sessionId, error });
    } finally {
      this.evaluating.delete(sessionId);
    }
  }

  private async evaluateInner(sessionId: string): Promise<void> {
    const row = this.opts.requests.get(sessionId);
    if (!row || !isPendingState(row.state)) {
      this.pending.delete(sessionId);
      return;
    }
    const config = await this.opts.loadConfig();
    const now = this.now();

    if (row.state === "firing") {
      const firedAt = row.firedAtMs ?? row.armedAtMs;
      if (now - firedAt >= config.resultTimeoutMs) {
        const reason = "result_timeout";
        const moved = this.opts.requests.finish(sessionId, row.armId, {
          state: "unconfirmed",
          fromStates: ["firing"],
          reason,
        });
        if (moved) {
          this.afterTerminal(row, "unconfirmed", reason);
          this.notice(row, reason);
        }
      }
      return;
    }

    const session = this.opts.engine.getSession(sessionId);
    if (!session) {
      this.drop(row, "session_ended");
      return;
    }
    if (abandonedArmIds(session.metadata).includes(row.armId)) {
      this.drop(row, "abandoned");
      return;
    }

    // A session that is still inactive at its deadline gets nothing (R7).
    if (!session.active) {
      if (now >= row.deadlineAtMs) {
        this.expire(row);
      } else {
        this.opts.requests.setDeferReason(
          sessionId,
          row.armId,
          "session_inactive"
        );
      }
      return;
    }

    const cleanAt = this.cleanFinalizeAt.get(row.armId);
    const lock = this.lockReads.get(row.armId) ?? {
      state: "unknown" as const,
      locks: [],
    };
    const decision = decideFire({
      enabled: config.enabled,
      now,
      trigger: row.trigger,
      resetAllowed: row.resetAllowed,
      deadlineAtMs: row.deadlineAtMs,
      sessionActive: session.active,
      aliveSinceBoot: session.activeAt >= this.bootAtMs,
      launcherKind: session.metadata?.launcherKind,
      busy: {
        thinking: session.thinking,
        backgroundAgents: session.backgroundAgents ?? null,
      },
      permissionPending:
        Object.keys(session.agentState?.requests ?? {}).length > 0,
      tuiBlocked: session.blockedOnTuiPrompt != null,
      rateLimited: session.rateLimited != null,
      handoffHeld: this.opts.isHandoffHeld(sessionId),
      settled: cleanAt !== undefined && now - cleanAt >= config.settleMs,
      challengePending: this.safeChallenge(session),
      lock: lock.state,
    });

    if (decision.action === "defer") {
      this.opts.requests.setDeferReason(sessionId, row.armId, decision.reason);
      return;
    }
    // A delivery without the flag waits for a turn that is still open, so the
    // text lands after it ends cleanly (an interrupt of it drops the request,
    // ruling Q6a) — up to the deadline, so a stuck turn never strands the lane.
    if (
      decision.action === "no_reset" &&
      this.hasOpenTurn(sessionId) &&
      now < row.deadlineAtMs
    ) {
      this.opts.requests.setDeferReason(sessionId, row.armId, "thinking");
      return;
    }
    await this.fire(
      row,
      config,
      decision.action === "reset" ? null : decision.reason,
      lock
    );
  }

  private hasOpenTurn(sessionId: string): boolean {
    return (this.openTurns.get(sessionId)?.size ?? 0) > 0;
  }

  /**
   * Send ONE message. `noResetReason === null` sends it with the flag and moves
   * the row `armed → firing` in the insert's transaction; the wrapper's result
   * ends it. Otherwise the text goes without the flag and the same transaction
   * ends the row `delivered_no_reset` with the server's reason (the one
   * exception to "only the wrapper's result writes `delivered_*`"), because a
   * plain message is never reported back and needs no confirmation: it is stored
   * and emitted like any operator send, so nothing is inferred from silence, and
   * it raises no warning. A flagged send still waits for the wrapper's result
   * and ends `unconfirmed` without one (ruling Q13, option 1, by the board-26
   * PM, 2026-11-13; option 3 would have ended every plain fallback
   * `unconfirmed`).
   */
  private async fire(
    row: ContextResetRequestRow,
    config: ContextResetServiceConfig,
    noResetReason: string | null,
    lock: LockRead
  ): Promise<void> {
    const sessionId = row.sessionId;
    const withReset = noResetReason === null;
    const text = renderResumeMessage({
      row,
      instructions: extractInstructingMessages(
        this.opts.listSessionMessages(sessionId)
      ),
      instructionsMaxChars: config.instructionsMaxChars,
      // An unresolved read names no lock: the checkpoint names them.
      locks: lock.state === "unknown" ? null : lock.locks,
      claims: this.opts.listActiveClaims(sessionId),
    });
    let deliveryId = this.deliveryIds.get(row.armId);
    if (!deliveryId) {
      deliveryId = (this.opts.mintDeliveryId ?? randomUUID)();
      this.deliveryIds.set(row.armId, deliveryId);
    }
    const id = deliveryId;
    const firedAt = this.now();
    const record = (): boolean => {
      // ROUND RV10 item 3: `row` was read before awaits, so a flagged send
      // re-checks the reset in the insert's own transaction (binding 4). A
      // veto stores nothing; the next evaluation sends without the flag.
      if (
        !this.opts.requests.markFiring(sessionId, row.armId, id, firedAt, {
          requireResetAllowed: withReset,
        })
      ) {
        return false;
      }
      if (withReset) return true;
      return this.opts.requests.finish(sessionId, row.armId, {
        state: "delivered_no_reset",
        fromStates: ["firing"],
        reason: noResetReason,
      });
    };

    let result: ContextResetSendResult;
    try {
      result = await this.opts.engine.sendMessage(sessionId, {
        text,
        localId: id,
        sentFrom: CONTEXT_RESET_SENT_FROM,
        ...(withReset ? { contextReset: { armId: row.armId } } : {}),
        record,
      });
    } catch (error) {
      this.afterSendThrow(row, config, error, id);
      return;
    }

    if (!result.delivered) {
      this.drop(row, "send_failed", `hook:${result.reason}`);
      return;
    }
    if (result.replayed) {
      // The delivery id was already stored: the record step did not run, and
      // the stored message is not this request's (one message is kept).
      this.drop(row, "delivery_id_collision");
      return;
    }
    this.deliveryIds.delete(row.armId);
    if (withReset) {
      this.refreshPending(sessionId);
      return;
    }
    this.afterTerminal(row, "delivered_no_reset", noResetReason);
  }

  private afterSendThrow(
    row: ContextResetRequestRow,
    config: ContextResetServiceConfig,
    error: unknown,
    deliveryId: string
  ): void {
    const current = this.safeGet(row.sessionId);
    if (!current || current.armId !== row.armId) return;
    if (current.deliveryId === deliveryId && current.state !== "armed") {
      // ROUND RV10 item 5: this send's record step committed (its delivery id
      // is stored), then the send threw after the commit, for instance in the
      // emit. The message is stored, so nothing is retried: a flagged send
      // waits for the wrapper's result as usual, and a plain one is ended, so
      // it writes its terminal event like any other. Never silent.
      this.deliveryIds.delete(row.armId);
      this.logLine(
        `[context-reset] the send for session ${row.sessionId} arm ${row.armId} threw after its message was stored (${errorText(error)}); the request is ${current.state}`,
        {
          sessionId: row.sessionId,
          armId: row.armId,
          state: current.state,
          error: errorText(error),
        }
      );
      if (isPendingState(current.state)) {
        this.refreshPending(row.sessionId);
      } else {
        this.afterTerminal(current, current.state, current.outcomeReason);
      }
      return;
    }
    if (isRecordVeto(error) || current.state !== "armed") {
      // The row moved under the send (cancelled, interrupted, or the insert
      // committed before the throw): nothing to retry.
      this.refreshPending(row.sessionId);
      return;
    }
    const attempts = this.opts.requests.incrementFireAttempts(
      row.sessionId,
      row.armId
    );
    this.warn("send failed; the request stays armed", {
      sessionId: row.sessionId,
      attempts,
      error,
    });
    if (attempts !== null && attempts >= config.fireAttemptsMax) {
      this.drop(row, "send_failed", errorText(error));
    }
  }

  // ── Terminal transitions ──────────────────────────────────────────────

  /**
   * End a row `dropped`. ROUND RV10, Finding 1: `from` names the states this
   * drop may move, and it is `armed` alone unless the caller says otherwise,
   * because a `firing` row's flagged message is already stored and sent: only
   * the wrapper's result or the deadline ends it. A row this call does not move
   * stays as it is.
   */
  private drop(
    row: ContextResetRequestRow,
    dropReason: string,
    detail?: string,
    from: readonly ("armed" | "firing")[] = DROP_FROM_ARMED
  ): boolean {
    const reason = detail ? `${dropReason}:${detail}` : dropReason;
    const moved = this.opts.requests.finish(row.sessionId, row.armId, {
      state: "dropped",
      fromStates: from,
      reason,
    });
    if (moved) this.afterTerminal(row, "dropped", reason);
    else this.refreshPending(row.sessionId);
    return moved;
  }

  private expire(row: ContextResetRequestRow): void {
    const reason = "session_inactive";
    const moved = this.opts.requests.finish(row.sessionId, row.armId, {
      state: "expired",
      fromStates: ["armed"],
      reason,
    });
    if (moved) {
      this.afterTerminal(row, "expired", reason);
      this.notice(
        row,
        "expired: the session was still inactive at its deadline"
      );
    }
  }

  private afterTerminal(
    row: ContextResetRequestRow,
    state: string,
    reason: string | null,
    extra: { newConversationId?: string | null } = {}
  ): void {
    this.refreshPending(row.sessionId);
    this.cleanFinalizeAt.delete(row.armId);
    this.lockReads.delete(row.armId);
    this.deliveryIds.delete(row.armId);
    const timer = this.settleTimers.get(row.sessionId);
    if (timer !== undefined) {
      this.clear(timer);
      this.settleTimers.delete(row.sessionId);
    }
    this.emitEvent({
      sessionId: row.sessionId,
      turnSeq: row.turnSeq,
      armId: row.armId,
      trigger: row.trigger,
      outcome: state,
      reason,
      fromStage: row.fromStage,
      toStage: row.toStage,
      issue: row.issueRef,
      contextBefore: row.contextBefore,
      newConversationId:
        state === "delivered_reset" ? (extra.newConversationId ?? null) : null,
    });
    // ROUND RV10 item 2: the hold is lifted (`refreshPending` above), and no
    // idle edge will follow, so wake the drain once for what queued under it.
    const wake = this.opts.wakeQueueDrain;
    if (
      wake &&
      ENDS_WITH_NO_TURN.has(state) &&
      !this.isPending(row.sessionId)
    ) {
      this.safeCall("wakeQueueDrain", () => wake(row.sessionId));
    }
  }

  private refreshPending(sessionId: string): void {
    const row = this.safeGet(sessionId);
    if (row && isPendingState(row.state)) this.pending.add(sessionId);
    else this.pending.delete(sessionId);
  }

  // ── Small helpers ─────────────────────────────────────────────────────

  private refusedEvent(
    sessionId: string,
    turnSeq: number | null,
    request: ContextResetArmRequest,
    reason: ContextResetArmRefusal,
    extra: { trigger: ContextResetTrigger; contextBefore: number | null }
  ): void {
    // A refusal for `no_open_turn` has no turn to carry an event (Task 12).
    if (reason === "no_open_turn" || turnSeq === null) {
      console.log(
        `[context-reset] arm refused (${reason}) for session ${sessionId}, arm ${request.armId}`
      );
      return;
    }
    this.emitEvent({
      sessionId,
      turnSeq,
      armId: request.armId,
      trigger: extra.trigger,
      outcome: "refused",
      reason,
      fromStage: request.fromStage ?? null,
      toStage: request.toStage ?? null,
      issue: request.issue ?? null,
      contextBefore: extra.contextBefore,
      newConversationId: null,
    });
  }

  private emitEvent(event: ContextResetEvent): void {
    if (!this.opts.recordEvent) return;
    const record = this.opts.recordEvent;
    this.safeCall("recordEvent", () => record(event));
  }

  private safeDrop(sessionId: string, armId: string, reason: string): boolean {
    try {
      const row = this.opts.requests.get(sessionId);
      if (!row || row.armId !== armId || !isPendingState(row.state)) {
        return false;
      }
      return this.drop(row, reason);
    } catch (error) {
      this.warn(`drop (${reason}) failed`, { sessionId, error });
      return false;
    }
  }

  private safeGet(sessionId: string): ContextResetRequestRow | null {
    try {
      return this.opts.requests.get(sessionId);
    } catch (error) {
      this.warn("could not read the request", { sessionId, error });
      return null;
    }
  }

  /** A challenge read that fails counts as a pending challenge (fail-closed). */
  private safeChallenge(session: Session): boolean {
    try {
      return this.opts.challengePending(session);
    } catch (error) {
      this.warn("challenge read failed; treated as pending", {
        sessionId: session.id,
        error,
      });
      return true;
    }
  }

  private safeCall(what: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.warn(`${what} failed`, { error });
    }
  }

  private schedule(fn: () => void, ms: number): unknown {
    return (this.opts.setTimer ?? ((f, t) => setTimeout(f, t)))(fn, ms);
  }

  private clear(handle: unknown): void {
    if (this.opts.clearTimer) this.opts.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  /** The needs-attention notice for `unconfirmed` and `expired` (category `context-reset`). */
  private notice(row: ContextResetRequestRow, reason: string): void {
    this.opts.errorLogger?.warn(
      `[context-reset] needs attention: session ${row.sessionId} request ${row.armId} ended ${reason}; look at that lane and re-kick it if it is idle`,
      {
        category: "context-reset",
        context: {
          sessionId: row.sessionId,
          armId: row.armId,
          reason,
          toStage: row.toStage,
          issue: row.issueRef,
        },
      }
    );
  }

  private warn(message: string, context: Record<string, unknown>): void {
    const ctx: Record<string, unknown> = { ...context };
    if ("error" in ctx) ctx.error = errorText(ctx.error);
    console.warn(`[context-reset] ${message}`, ctx);
  }
}
