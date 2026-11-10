// SPDX-License-Identifier: AGPL-3.0-only
import {
  CACHE_KEEPALIVE_RPC_METHOD,
  SupervisedLoop,
  type CacheKeepaliveOutcome,
  type CacheKeepaliveResponse,
  type JobRegistry,
} from "@hapi/protocol";
import type { Session, SyncEvent } from "@hapi/protocol/types";
import type { ErrorLogger } from "../logging/errorLogger";
import type { KeepaliveLedgerEntry } from "../store/throughput/keepaliveStore";
import type { CacheKeepaliveConfig } from "./config";
import { decideKeepalive } from "./policy";

/**
 * The prompt-cache keep-alive scheduler (issue #6169, epic #6163 Sub C2).
 *
 * A 60 s `SupervisedLoop` walks this node's sessions, asks the pure policy
 * whether each one is due, and calls the CLI's `cache-keepalive` RPC for those
 * that are. It is a core module, not a builtin extension: it reads the
 * context-watermark handoff hold and writes the core throughput ledger.
 *
 * The cache clock is CLI-reported (`session.promptCache`, on the keepAlive
 * tick), so a server restart loses only what this service keeps in memory: the
 * last prompt-draft change, the last send and the per-idle-period stop.
 *
 * A tick never waits on an RPC. It queues the due sessions, closest deadline
 * first, and sends behind a per-session `inFlight` guard (a hung tick can be
 * superseded by a fresh one while it still runs) and a concurrency cap; each
 * settled send records its outcome in the ledger and starts the next queued one,
 * re-checked against the policy at that moment. Outcomes: ok → `sent`;
 * `turn_in_flight` or `in_flight` → `refused`, try again next tick; any other
 * refusal → `refused` and no more keep-alives this idle period; a failure, a
 * timeout included, → `failed` and no more this idle period (a timeout may still
 * have reached the model, so it is never retried in the same window). The ledger
 * row carries the refusal or failure code.
 */

/** Estimated tokens of one side question beyond the cache read (fixtures: 439–454 in, 4 out). */
export const KEEPALIVE_IN_TOKENS = 500;
export const KEEPALIVE_OUT_TOKENS = 10;
export const KEEPALIVE_TICK_MS = 60_000;
export const KEEPALIVE_MAX_CONCURRENT = 2;

/** Refusals that sent nothing and say "try again soon", not "this period is over". */
const RETRY_CODES = new Set(["turn_in_flight", "in_flight"]);
/** Refusals that point at a contract or environment problem, logged as failures. */
const UNEXPECTED_CODES = new Set([
  "invalid_request",
  "unsupported",
  "no_active_query",
]);

export interface CacheKeepaliveEngine {
  getSessions(): Session[];
  getSession(sessionId: string): Session | undefined;
  subscribe(listener: (event: SyncEvent) => void): () => void;
  listQueuedMessages(sessionId: string, namespace: string): unknown[];
  hasSessionMethod(sessionId: string, method: string): boolean;
  cacheKeepalive(
    sessionId: string,
    request: { deadlineAt: number }
  ): Promise<CacheKeepaliveResponse>;
}

export interface CacheKeepaliveServiceOptions {
  engine: CacheKeepaliveEngine;
  ledger: { record(entry: KeepaliveLedgerEntry): void };
  /** Re-read every tick, so the switch and the thresholds apply without a restart. */
  loadConfig: () => Promise<CacheKeepaliveConfig> | CacheKeepaliveConfig;
  /** A context-watermark handoff holds the session (late-bound). */
  isHandoffHeld: (sessionId: string) => boolean;
  nodeId: string;
  jobRegistry?: JobRegistry | null;
  errorLogger?: ErrorLogger | null;
  now?: () => number;
  maxConcurrent?: number;
  tickMs?: number;
}

interface SessionState {
  draft: string | null | undefined;
  lastDraftChangeAt: number | null;
  lastSentAt: number | null;
  /** The `promptCache.idleSince` of the idle period a refusal or failure stopped. */
  stoppedIdleSince: number | null;
}

interface Failure {
  sessionId: string;
  code: string;
  error?: string;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class CacheKeepaliveService {
  private readonly loop: SupervisedLoop;
  private readonly state = new Map<string, SessionState>();
  private readonly inFlight = new Set<string>();
  private readonly loggedRejections = new Set<string>();
  private pendingFailures: Failure[] = [];
  /** This tick's due sessions, closest deadline first, not yet dispatched. */
  private queue: string[] = [];
  private queueConfig: CacheKeepaliveConfig | null = null;
  /** The switch as last logged, so each on/off change is logged once. */
  private loggedEnabled: boolean | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly now: () => number;
  private readonly maxConcurrent: number;

  constructor(private readonly opts: CacheKeepaliveServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.maxConcurrent = opts.maxConcurrent ?? KEEPALIVE_MAX_CONCURRENT;
    this.loop = new SupervisedLoop({
      name: "cache-keepalive",
      node: opts.nodeId,
      intervalMs: opts.tickMs ?? KEEPALIVE_TICK_MS,
      immediate: false,
      registry: opts.jobRegistry ?? undefined,
      tick: () => this.runTick(),
    });
  }

  start(): void {
    if (!this.unsubscribe) {
      this.unsubscribe = this.opts.engine.subscribe(event =>
        this.observe(event)
      );
    }
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.queue = [];
    this.queueConfig = null;
    this.state.clear();
    this.flushFailures();
  }

  /** Keep the per-session typing clock and the idle-period stop current. */
  observe(event: SyncEvent): void {
    if (event.type === "session-removed") {
      this.state.delete(event.sessionId);
      return;
    }
    if (event.type !== "session-updated") return;
    const session = this.opts.engine.getSession(event.sessionId);
    if (!session) return;
    if (!session.active || session.metadata?.lifecycleState === "archived") {
      this.state.delete(session.id);
      return;
    }
    const prev = this.state.get(session.id);
    if (!prev) {
      // First sighting: a draft that already exists is not someone typing now.
      this.state.set(session.id, {
        draft: session.promptDraft,
        lastDraftChangeAt: null,
        lastSentAt: null,
        stoppedIdleSince: null,
      });
      return;
    }
    if (session.promptDraft !== prev.draft) {
      // The store bumps only `seq` on a draft write, so this is the only clock.
      prev.draft = session.promptDraft;
      prev.lastDraftChangeAt = this.now();
    }
    // A real turn ends the idle period, and with it any stop.
    if (session.thinking) prev.stoppedIdleSince = null;
  }

  /** One supervised tick: log, then rethrow so the loop records the error. */
  private async runTick(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      console.error("[cache-keepalive] tick failed:", error);
      throw error;
    }
  }

  /** Exposed for tests; dispatches sends and returns without waiting for them. */
  async tick(): Promise<void> {
    this.flushFailures();
    const config = await this.opts.loadConfig();
    for (const r of config.rejected) {
      if (this.loggedRejections.has(r)) continue;
      this.loggedRejections.add(r);
      console.warn(`[cache-keepalive] ignored invalid setting: ${r}`);
    }
    this.queue = [];
    this.queueConfig = config;
    if (config.enabled !== this.loggedEnabled) {
      this.loggedEnabled = config.enabled;
      console.log(
        `[cache-keepalive] ${config.enabled ? "enabled" : "disabled"} (source: ${config.source})`
      );
    }
    if (!config.enabled) return;
    const now = this.now();
    const due: Array<{ id: string; deadlineAt: number }> = [];
    for (const session of this.opts.engine.getSessions()) {
      if (this.inFlight.has(session.id)) continue;
      const deadlineAt = this.due(session, config, now);
      if (deadlineAt !== null) due.push({ id: session.id, deadlineAt });
    }
    // Closest deadline first: a session with a minute left goes before one
    // with five, so a burst of parked sessions misses as few windows as it can.
    due.sort((a, b) => a.deadlineAt - b.deadlineAt);
    this.queue = due.map(d => d.id);
    this.pump();
  }

  /** Dispatch queued sessions up to the cap, each re-checked now. */
  private pump(): void {
    const config = this.queueConfig;
    if (!config) return;
    while (this.inFlight.size < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift()!;
      if (this.inFlight.has(id)) continue;
      const session = this.opts.engine.getSession(id);
      if (!session) continue;
      const deadlineAt = this.due(session, config, this.now());
      if (deadlineAt === null) continue;
      this.dispatch(session, deadlineAt);
    }
  }

  /** The deadline to send with, or null when the policy says skip. */
  private due(
    session: Session,
    config: CacheKeepaliveConfig,
    now: number
  ): number | null {
    const st = this.state.get(session.id);
    const idleSince = session.promptCache?.idleSince ?? null;
    const base = {
      session,
      queuedCount: 0,
      handoffHeld: this.opts.isHandoffHeld(session.id),
      hasMethod: this.opts.engine.hasSessionMethod(
        session.id,
        CACHE_KEEPALIVE_RPC_METHOD
      ),
      lastDraftChangeAt: st?.lastDraftChangeAt ?? null,
      stopped:
        st?.stoppedIdleSince != null && st.stoppedIdleSince === idleSince,
      lastSentAt: st?.lastSentAt ?? null,
    };
    // The queue is read only for a session that would otherwise be sent one.
    const first = decideKeepalive(base, config, now);
    if (first.action !== "send") return null;
    const queuedCount = this.opts.engine.listQueuedMessages(
      session.id,
      session.namespace
    ).length;
    const decision = decideKeepalive({ ...base, queuedCount }, config, now);
    return decision.action === "send" ? decision.deadlineAt : null;
  }

  private dispatch(session: Session, deadlineAt: number): void {
    const sid = session.id;
    this.inFlight.add(sid);
    const st = this.stateOf(sid);
    st.lastSentAt = this.now();
    // The idle period this send belongs to, read NOW: the live record can move
    // to the next idle period while the RPC is out.
    const idleSince = session.promptCache?.idleSince ?? null;
    void this.send(session, deadlineAt, idleSince)
      .catch(error => {
        this.pendingFailures.push({
          sessionId: sid,
          code: "internal",
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.inFlight.delete(sid);
        this.pump();
      });
  }

  private async send(
    session: Session,
    deadlineAt: number,
    idleSince: number | null
  ): Promise<void> {
    const res = await this.opts.engine.cacheKeepalive(session.id, {
      deadlineAt,
    });
    let outcome: CacheKeepaliveOutcome;
    if (res.ok) {
      outcome = "sent";
    } else if (res.code === "side_question_failed") {
      outcome = "failed";
      this.pendingFailures.push({
        sessionId: session.id,
        code: res.cause ?? res.code,
        error: res.error,
      });
    } else {
      outcome = "refused";
      if (UNEXPECTED_CODES.has(res.code)) {
        this.pendingFailures.push({
          sessionId: session.id,
          code: res.code,
          error: res.error,
        });
      }
    }
    // A session that ended while the RPC was out keeps no state.
    if (!res.ok && this.opts.engine.getSession(session.id)) {
      const st = this.stateOf(session.id);
      if (RETRY_CODES.has(res.code)) {
        // Nothing was sent: the next tick may try again.
        st.lastSentAt = null;
      } else {
        st.stoppedIdleSince = idleSince;
      }
    }
    // A refusal sent nothing; a failure may still have reached the model.
    const billed = outcome !== "refused";
    try {
      this.opts.ledger.record({
        ns: session.namespace,
        origin: this.opts.nodeId,
        day: utcDay(this.now()),
        outcome,
        code: res.ok ? "" : res.code,
        model: session.resolvedModel ?? null,
        crTokens: billed ? (session.contextUsedTokens ?? 0) : 0,
        inTokens: billed ? KEEPALIVE_IN_TOKENS : 0,
        outTokens: billed ? KEEPALIVE_OUT_TOKENS : 0,
      });
    } catch (error) {
      this.pendingFailures.push({
        sessionId: session.id,
        code: "ledger_write_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private stateOf(sessionId: string): SessionState {
    let st = this.state.get(sessionId);
    if (!st) {
      st = {
        draft: this.opts.engine.getSession(sessionId)?.promptDraft,
        lastDraftChangeAt: null,
        lastSentAt: null,
        stoppedIdleSince: null,
      };
      this.state.set(sessionId, st);
    }
    return st;
  }

  /** One aggregated error-log entry per tick for the previous tick's failures. */
  private flushFailures(): void {
    if (this.pendingFailures.length === 0) return;
    const failures = this.pendingFailures;
    this.pendingFailures = [];
    this.opts.errorLogger?.warn(
      `[cache-keepalive] ${failures.length} keep-alive problem(s): ${[
        ...new Set(failures.map(f => f.code)),
      ].join(", ")}`,
      {
        category: "cache-keepalive",
        context: { failures: failures.slice(0, 5), total: failures.length },
      }
    );
  }
}
