// SPDX-License-Identifier: AGPL-3.0-only
import {
  MAX_RUNNER_KEYS_PER_LIST,
  RUNNER_REPORT_INTERVAL_MS,
  RUNNER_SUPERSEDED,
  RUNNER_SUPERSEDED_EVENT,
  type RunnerIdentityMode,
  type RunnerRefusalReason,
} from "@hapi/protocol";

import type { ErrorLogOptions } from "../logging/errorLogger";
import type { RunnerRecord } from "../store/sessions";
import type {
  RunnerIdentityDailyWrite,
  RunnerIdentitySnapshot,
} from "../store/runnerIdentityDaily";
import type { ResolvedRunnerIdentityMode } from "./runnerIdentityMode";
import {
  COND1_READABLE_AFTER_SECONDS,
  decideAttach,
  decideHandshake,
  decideReport,
  emptyReportKinds,
  hasRecord,
  reportWarning,
  runnerKeyOf,
  runnerSupersededError,
  unidentifiedReason,
  type AttachDecision,
  type CutReason,
  type CuttableSocket,
  type GatedReportKind,
  type ReplacedReportReason,
  type RunnerSocketLike,
  type UnidentifiedReason,
} from "./runnerIdentityRules";

// The pure rules live in their own module (the 1,500-line cap); every name
// is re-exported, so importers of this module are unchanged.
export * from "./runnerIdentityRules";

/**
 * Runner identity: the hub tells two live processes on one session apart
 * (issue #6647, R2-R11).
 *
 * A runner sends a runner id it minted for its attach. The hub derives a key
 * from it at once (`runnerKeyOf`) and stores, compares and logs only the key.
 * This class decides attaches, handshakes and reports against the session's
 * runner record, keeps the record cache with the pending-write rule (plan §7),
 * the counts (R10) and the spawn notes (§4.2). It keeps no map of sockets: the
 * sockets of a session are read from socket.io's room each time.
 *
 * `off`: every method proceeds at once and nothing is read, written, counted or
 * warned, except the cut-off mark (R15), which `socketConnected` clears in
 * every mode. `observe`: everything `enforce` would decide is recorded, counted
 * and warned as "would-…", and the caller is always told to proceed. `enforce`
 * (PR2, Task 12) acts: it refuses the attach, refuses the handshake, drops the
 * report and cuts off the replaced runner's sockets (R3, R5-R7). Every public
 * method fails open (R11): on a throw it counts `failedOpen`, warns once per
 * method and session, and proceeds.
 */

export const SPAWN_NOTE_TTL_MS = 180_000;

export type RunnerIdentityStore = {
  getRunnerRecord(sessionId: string, namespace: string): RunnerRecord | null;
  setRunnerRecord(
    sessionId: string,
    namespace: string,
    record: RunnerRecord
  ): boolean;
  setRunnerCutAt(sessionId: string, cutAt: number | null): boolean;
  addRefusedRunnerKey(
    sessionId: string,
    namespace: string,
    key: string
  ): boolean;
  /** The attach's tag lookup, used when the caller passes no session id. */
  findSessionIdByTag?(tag: string, namespace: string): string | null;
};

export type RunnerIdentityLogger = {
  warn(message: string, options?: ErrorLogOptions): void;
};

export type RunnerIdentityDeps = {
  store: RunnerIdentityStore;
  mode: RunnerIdentityMode;
  logger: RunnerIdentityLogger;
  now?: () => number;
  /** How the mode was resolved (Task 3), reported by the status route (Task 9). */
  resolution?: Omit<ResolvedRunnerIdentityMode, "mode">;
};

/** A session the status route checks for an unnamed live process (Task 9). */
export type LiveSessionInput = {
  id: string;
  namespace: string;
  active: boolean;
  name: string | null;
  launcherKind: string | null;
};

/** The fields of a cached session the check reads (Task 9). */
export function liveSessionInput(session: {
  id: string;
  namespace: string;
  active: boolean;
  metadata?: { name?: string; launcherKind?: string } | null;
}): LiveSessionInput {
  return {
    id: session.id,
    namespace: session.namespace,
    active: session.active,
    name: session.metadata?.name ?? null,
    launcherKind: session.metadata?.launcherKind ?? null,
  };
}

/** Where the daily snapshot is kept (Task 9a): one node's rows. */
export type RunnerIdentityDailyStore = {
  write(input: RunnerIdentityDailyWrite): void;
  snapshots(): RunnerIdentitySnapshot[];
};

/**
 * N1: the bound on the whole shutdown's retry of pending record writes. No
 * retry starts after it; writes left untried are counted and warned. After it,
 * under a held lock, at most five writes can each still wait the database's
 * busy_timeout (5 s): the retry in flight (its warning is not persisted, P4),
 * the pending-at-shutdown warning, the snapshot, the snapshot's fail-open
 * warning (attach) and the shutdown's snapshot-not-landed warning (Q1). So the
 * step ends within 35 s, under the units' 90 s stop limit.
 */
export const RUNNER_IDENTITY_SHUTDOWN_BUDGET_MS = 10_000;

/**
 * D2 (the Project Manager's ruling of 08:22Z): a session is listed in
 * `replacedStillReporting` only while a replaced or refused key, or a runner
 * with no key on a keyed record (P2), reported within this window: three of
 * the runner's report intervals, and never under ten minutes. So an empty list
 * means nothing replaced has reported for this long.
 */
export const REPLACED_REPORTING_WINDOW_MS = Math.max(
  3 * RUNNER_REPORT_INTERVAL_MS,
  10 * 60_000
);

/** How often the timer retries pending writes and writes the snapshot (Task 9a). */
export const RUNNER_IDENTITY_SNAPSHOT_INTERVAL_MS = 5 * 60_000;

/** `now - last` key by key over two count trees of the same shape. */
function diffCounts<T>(now: T, last: T): T {
  if (typeof now === "number") {
    return (now - (typeof last === "number" ? last : 0)) as T;
  }
  const out: Record<string, unknown> = {};
  const previous = (last ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(now as Record<string, unknown>)) {
    out[key] = diffCounts(value, previous[key]);
  }
  return out as T;
}

export type UnidentifiedLive = {
  sessionId: string;
  name: string | null;
  launcherKind: string | null;
  reason: UnidentifiedReason;
  socketCount: number;
  attachedAt: number | null;
};

export type AttachInput = {
  tag: string;
  namespace: string;
  /**
   * The id of the row the tag already names, or null for a new tag. Left
   * undefined, the registry looks the tag up itself, inside its fail-open.
   */
  existingSessionId?: string | null;
  runnerId?: string | null;
  pid?: number | null;
  startedBy?: string | null;
};

/** The decision of an attach, carried from `attach` to `commitAttach`. */
export type AttachPlan = {
  decision: AttachDecision;
  /** False only for a refusal in `enforce` (PR2). */
  proceed: boolean;
  key: string | null;
  startedBy: string | null;
  pid: number | null;
  namespace: string;
  existingSessionId: string | null;
  previous: RunnerRecord | null;
  requested: boolean;
  /** The wording of an `enforce` refusal (R3), picked by a liveness read only. */
  refusal: RunnerRefusalReason | null;
};

export type RunnerIdentityCounts = {
  attach: {
    created: number;
    firstRunner: number;
    sameRunner: number;
    refused: number;
    wouldRefuse: number;
    takeoverRequested: number;
    takeoverUnrequested: number;
  };
  handshake: {
    refused: number;
    wouldRefuse: number;
    unknownKeyAccepted: number;
  };
  report: {
    dropped: Record<GatedReportKind, number>;
    wouldDrop: Record<GatedReportKind, number>;
  };
  socketsCutOff: number;
  wouldCutOff: number;
  stopsSent: number;
  failedOpen: number;
  recordWriteFailures: number;
};

export function emptyRunnerIdentityCounts(): RunnerIdentityCounts {
  return {
    attach: {
      created: 0,
      firstRunner: 0,
      sameRunner: 0,
      refused: 0,
      wouldRefuse: 0,
      takeoverRequested: 0,
      takeoverUnrequested: 0,
    },
    handshake: { refused: 0, wouldRefuse: 0, unknownKeyAccepted: 0 },
    report: { dropped: emptyReportKinds(), wouldDrop: emptyReportKinds() },
    socketsCutOff: 0,
    wouldCutOff: 0,
    stopsSent: 0,
    failedOpen: 0,
    recordWriteFailures: 0,
  };
}

type CacheEntry = {
  namespace: string;
  record: RunnerRecord | null;
  /** The intended record whose write has not landed yet (plan §7). */
  pending: RunnerRecord | null;
};

const ATTACH_CATEGORY = "runner-identity-attach";
const HANDSHAKE_CATEGORY = "runner-identity-handshake";
const REPORT_CATEGORY = "runner-identity-report";
/**
 * D1 (the Project Manager's ruling of 08:22Z): a refusal or would-be refusal,
 * at attach or at handshake, has a category of its own, so a burst of routine
 * takeovers can fill only the attach category's rate-limit summary.
 */
const REFUSAL_CATEGORY = "runner-identity-refusal";
/**
 * P1, Q1 (the Project Manager's rulings of 08:46Z and 09:13Z): the shutdown
 * step's own warnings (pending-at-shutdown, snapshot-not-landed and the step's
 * fail-opens) have a category of their own, so the record-write warnings of the
 * same held lock can never push them past the rate limit. The snapshot write's
 * own fail-open stays in the attach category, shared with the timer.
 */
const SHUTDOWN_CATEGORY = "runner-identity-shutdown";

export class RunnerIdentity {
  readonly mode: RunnerIdentityMode;
  private readonly store: RunnerIdentityStore;
  private readonly logger: RunnerIdentityLogger;
  private readonly now: () => number;
  private liveSockets: (sessionId: string) => RunnerSocketLike[] = () => [];
  private socketLookup: (socketId: string) => CuttableSocket | undefined = () =>
    undefined;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly spawnNotes = new Map<string, number>();
  private readonly warnedSockets = new WeakMap<object, Set<string>>();
  private readonly wouldCutSockets = new WeakSet<object>();
  /** Y1: per session, when each runner key's handshake was last refused. */
  private readonly refusedHandshakeAt = new Map<string, Map<string, number>>();
  private readonly failOpenWarned = new Set<string>();
  /**
   * D2: per session, the would-be-dropped heartbeats from a listed key or a
   * keyless runner on a keyed record (P2), and the newest one's time.
   */
  private readonly replacedReports = new Map<
    string,
    { count: number; lastAt: number; why: ReplacedReportReason }
  >();
  /** OR4: per session, the newest cut-off whose stop could not reach its runner. */
  private readonly cutWithoutStop = new Map<
    string,
    { at: number; hadKey: boolean }
  >();
  /** F11: a boot snapshot write that failed; its flag goes with the next write. */
  private bootUnwritten = false;
  private countsState = emptyRunnerIdentityCounts();
  /** When this registry was built: the start of the route's counts (R10). */
  readonly bootedAt: number;
  readonly resolution: Omit<ResolvedRunnerIdentityMode, "mode">;
  private billableModeState = "off";
  private daily: RunnerIdentityDailyStore | null = null;
  /** The counts at the last daily write that landed (Task 9a). */
  private lastWrittenCounts = emptyRunnerIdentityCounts();
  private snapshotTimer: { stop(): void } | null = null;

  constructor(deps: RunnerIdentityDeps) {
    this.store = deps.store;
    this.mode = deps.mode;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
    this.bootedAt = this.now();
    this.resolution = deps.resolution ?? { source: "default" };
  }

  /** The registry's clock, so the route's `secondsSinceBoot` uses the same one. */
  nowMs(): number {
    return this.now();
  }

  /** The billable mode the engine is given (M4), known after this registry. */
  setBillableMode(mode: string): void {
    this.billableModeState = mode;
  }

  get billableMode(): string {
    return this.billableModeState;
  }

  /** Bound after the socket server exists: the sockets of room `session:<id>`. */
  bindLiveSockets(fn: (sessionId: string) => RunnerSocketLike[]): void {
    this.liveSockets = fn;
  }

  /** Bound by the socket server: the namespace's own socket for an id (R5's cut). */
  bindSocketLookup(fn: (socketId: string) => CuttableSocket | undefined): void {
    this.socketLookup = fn;
  }

  /** The hub asked the daemon to spawn this tag (§4.2): a label, read and not consumed. */
  noteSpawnRequested(tag: string): void {
    if (this.mode === "off") return;
    try {
      // F3: a note is read, never consumed, so expired ones are pruned here.
      const now = this.now();
      for (const [noted, expires] of this.spawnNotes) {
        if (expires <= now) this.spawnNotes.delete(noted);
      }
      this.spawnNotes.set(tag, now + SPAWN_NOTE_TTL_MS);
    } catch (error) {
      this.failOpen("noteSpawnRequested", null, ATTACH_CATEGORY, error);
    }
  }

  /**
   * Decides an attach before the session cache attaches (Task 5 steps 1-3). A
   * refusal's key joins the refused list here; every other record write waits
   * for `commitAttach`, after the attach succeeded.
   */
  attach(input: AttachInput): AttachPlan {
    const key = input.runnerId ? runnerKeyOf(input.runnerId) : null;
    const plan: AttachPlan = {
      decision: "create",
      proceed: true,
      key,
      startedBy: input.startedBy ?? null,
      pid: input.pid ?? null,
      namespace: input.namespace,
      existingSessionId: input.existingSessionId ?? null,
      previous: null,
      requested: false,
      refusal: null,
    };
    if (this.mode === "off") return plan;
    try {
      const sessionId =
        input.existingSessionId !== undefined
          ? input.existingSessionId
          : (this.store.findSessionIdByTag?.(input.tag, input.namespace) ??
            null);
      plan.existingSessionId = sessionId;
      if (sessionId !== null) this.retryPending(sessionId);
      const record =
        sessionId === null ? null : this.recordOf(sessionId, input.namespace);
      plan.previous = record;
      plan.decision = decideAttach(record, {
        key,
        startedBy: input.startedBy,
        tagExists: sessionId !== null,
      });
      plan.requested = this.isRequested(input.tag);
      if (plan.decision === "same-runner") {
        this.countsState.attach.sameRunner += 1;
      } else if (plan.decision === "refuse" && sessionId !== null) {
        const enforce = this.mode === "enforce";
        if (enforce) this.countsState.attach.refused += 1;
        else this.countsState.attach.wouldRefuse += 1;
        // X2: a decided refusal stands when its list write or warning throws.
        try {
          if (key !== null) this.addRefused(sessionId, input.namespace, key);
          this.logger.warn(
            enforce
              ? "runner identity: refused an attach to an existing session"
              : "runner identity: would refuse an attach to an existing session (observe)",
            {
              category: REFUSAL_CATEGORY,
              sessionId,
              namespace: input.namespace,
              context: {
                decision: enforce ? "refuse" : "would-refuse",
                mode: this.mode,
                newcomerKey: key,
                recordedKey: record?.runnerKey ?? null,
                startedBy: input.startedBy ?? null,
              },
            }
          );
        } catch (error) {
          this.countsState.recordWriteFailures += 1;
          this.recordWriteFailed("attach", sessionId, error);
        }
        plan.proceed = !enforce;
        if (enforce) plan.refusal = this.refusalReason(sessionId);
      }
      return plan;
    } catch (error) {
      this.failOpen("attach", plan.existingSessionId, ATTACH_CATEGORY, error);
      // TY3: a fail-open plan never refuses, whatever its decision field says.
      return { ...plan, decision: "same-runner", proceed: true, refusal: null };
    }
  }

  /**
   * After the session cache attached (Task 5 steps 5-6): writes the record,
   * then (R5's first moment, after the write, never before) cuts off every
   * other socket in the room at a takeover or a first-runner attach.
   */
  commitAttach(plan: AttachPlan, sessionId: string): void {
    if (this.mode === "off") return;
    try {
      const { decision } = plan;
      if (
        decision !== "create" &&
        decision !== "first-runner" &&
        decision !== "takeover"
      ) {
        return;
      }
      const previous = plan.previous;
      const room = decision === "create" ? [] : this.liveSockets(sessionId);
      // The new runner has no socket yet; any socket with its own key stays.
      const others = room.filter(
        s => plan.key === null || s.data.runnerKey !== plan.key
      );
      const superseded = [...(previous?.supersededKeys ?? [])];
      if (decision === "takeover" && previous?.runnerKey) {
        superseded.push(previous.runnerKey);
      }
      // F-A: the key of every socket cut here is listed too, so its runner's
      // reconnect is refused instead of accepted as an unknown key.
      for (const k of others.map(s => s.data.runnerKey)) {
        if (k && k !== plan.key && !superseded.includes(k)) superseded.push(k);
      }
      // F1: cap here, as the row is capped, so the cache never decides on a
      // key the row no longer lists. P2: a full list drops the oldest dead
      // key first. Live is a socket in the room, (Y1, as enforce never lets
      // a listed runner join it) a handshake refused within the window, or
      // (G1) the key a takeover replaces; when all are live the oldest goes.
      const inRoom = new Set(room.map(s => s.data.runnerKey));
      const refused = this.refusedHandshakeAt.get(sessionId);
      const live = (k: string) =>
        inRoom.has(k) ||
        (decision === "takeover" && k === previous?.runnerKey) ||
        this.now() - (refused?.get(k) ?? -Infinity) <=
          REPLACED_REPORTING_WINDOW_MS;
      while (superseded.length > MAX_RUNNER_KEYS_PER_LIST) {
        const dead = superseded.findIndex(k => !live(k));
        superseded.splice(Math.max(dead, 0), 1);
      }
      this.writeRecord(sessionId, plan.namespace, {
        runnerKey: plan.key,
        startedBy: plan.startedBy,
        pid: plan.pid,
        attachedAt: this.now(),
        supersededKeys: superseded,
        refusedKeys: previous?.refusedKeys ?? [],
        cutAt: previous?.cutAt ?? null,
      });
      const cut = this.cutOrCount(
        sessionId,
        plan.namespace,
        others,
        "takeover"
      );
      if (decision === "create") {
        this.countsState.attach.created += 1;
      } else if (decision === "first-runner") {
        this.countsState.attach.firstRunner += 1;
        // Line 930 of the plan: a row with no record can still have a live
        // runner from before this build; cutting it is warned as a takeover.
        if (cut > 0) {
          this.logger.warn(
            this.mode === "enforce"
              ? "runner identity: a daemon-started runner took over a session with no record"
              : "runner identity: a daemon-started runner would take over a session with no record (observe)",
            {
              category: ATTACH_CATEGORY,
              sessionId,
              namespace: plan.namespace,
              context: {
                decision: "first-runner",
                cut,
                mode: this.mode,
                newcomerKey: plan.key,
                startedBy: plan.startedBy,
              },
            }
          );
        }
      } else {
        if (plan.requested) this.countsState.attach.takeoverRequested += 1;
        else this.countsState.attach.takeoverUnrequested += 1;
        this.logger.warn(
          "runner identity: a daemon-started runner took over a session",
          {
            category: ATTACH_CATEGORY,
            sessionId,
            namespace: plan.namespace,
            context: {
              decision: "takeover",
              label: plan.requested ? "requested" : "unrequested",
              mode: this.mode,
              newcomerKey: plan.key,
              replacedKey: previous?.runnerKey ?? null,
              startedBy: plan.startedBy,
              cut,
            },
          }
        );
      }
    } catch (error) {
      this.failOpen("commitAttach", sessionId, ATTACH_CATEGORY, error);
    }
  }

  /**
   * The socket handshake test (R6). Returns false only for a refusal in
   * `enforce`, which sets the cut-off mark when no connected socket of the
   * session passes (R15, K18); a socket with no session id is not tested.
   */
  handshake(socket: RunnerSocketLike): boolean {
    if (this.mode === "off") return true;
    const sessionId = socket.data.sessionId;
    if (!sessionId) return true;
    try {
      this.retryPending(sessionId, false);
      const record = this.recordOf(sessionId, socket.data.namespace);
      const decision = decideHandshake(record, socket.data.runnerKey ?? null);
      if (decision === "accept") return true;
      if (decision === "accept-unknown") {
        this.countsState.handshake.unknownKeyAccepted += 1;
        this.warnOnce(socket, "handshake:accept-unknown", () =>
          this.logger.warn(
            "runner identity: accepted a socket with an unknown runner key",
            this.socketWarning(
              socket,
              HANDSHAKE_CATEGORY,
              "accept-unknown",
              record
            )
          )
        );
        return true;
      }
      const enforce = this.mode === "enforce";
      if (enforce) this.countsState.handshake.refused += 1;
      else this.countsState.handshake.wouldRefuse += 1;
      // X1: enforce refuses this socket here and never cuts it.
      if (!enforce) this.wouldCutSockets.add(socket.data);
      if (socket.data.runnerKey)
        this.noteRefused(sessionId, socket.data.runnerKey);
      this.warnOnce(socket, "handshake:refuse", () =>
        this.logger.warn(
          enforce
            ? "runner identity: refused a socket handshake"
            : "runner identity: would refuse a socket handshake (observe)",
          this.socketWarning(
            socket,
            REFUSAL_CATEGORY,
            enforce ? "refuse" : "would-refuse",
            record
          )
        )
      );
      // The refused socket is not in the room yet, so the room alone decides.
      if (enforce) this.markIfNoPassing(sessionId, socket.data.namespace);
      return !enforce;
    } catch (error) {
      this.failOpen("handshake", sessionId, HANDSHAKE_CATEGORY, error, false);
      return true;
    }
  }

  /**
   * An accepted socket joined its session's room: clears the cut-off mark (in
   * every mode, `off` included). When it is the recorded runner's own socket,
   * R5's second moment cuts off every other socket the handshake would refuse
   * (`observe` counts them); an unknown key is never cut (K3). The connecting
   * socket passes, so this cut never sets a mark.
   */
  socketConnected(
    socket: RunnerSocketLike,
    sessionId: string | undefined = socket.data.sessionId
  ): void {
    if (!sessionId) return;
    try {
      this.clearCutMark(sessionId, socket.data.namespace);
      if (this.mode === "off") return;
      const record = this.recordOf(sessionId, socket.data.namespace);
      const key = socket.data.runnerKey ?? null;
      if (!hasRecord(record) || record.runnerKey === null) return;
      if (key !== record.runnerKey) return;
      const refused = this.liveSockets(sessionId).filter(
        other =>
          other.id !== socket.id &&
          decideHandshake(record, other.data.runnerKey ?? null) === "refuse"
      );
      this.cutOrCount(
        sessionId,
        socket.data.namespace,
        refused,
        "recorded-runner-connected"
      );
    } catch (error) {
      this.failOpen(
        "socketConnected",
        sessionId,
        HANDSHAKE_CATEGORY,
        error,
        false
      );
    }
  }

  /**
   * The per-event backstop (R7). Returns false only for a drop in `enforce`;
   * the caller answers the report, then calls `afterDroppedReport`. In
   * `observe` a drop is counted and warned once per socket and kind.
   */
  gateReport(
    socket: RunnerSocketLike,
    sid: string,
    kind: GatedReportKind
  ): boolean {
    if (this.mode === "off") return true;
    try {
      const sessionId = socket.data.sessionId ?? null;
      const record =
        sessionId === null
          ? null
          : this.recordOf(sessionId, socket.data.namespace);
      const decision = decideReport(
        record,
        { sessionId, runnerKey: socket.data.runnerKey ?? null },
        sid
      );
      if (decision === "pass") return true;
      const enforce = this.mode === "enforce";
      if (enforce) this.countsState.report.dropped[kind] += 1;
      else this.countsState.report.wouldDrop[kind] += 1;
      const key = socket.data.runnerKey ?? null;
      // P2: a runner with no key on a keyed record (an older CLI left running
      // after a keyed respawn) is listed too, because enforce refuses it.
      const listed =
        sessionId === sid &&
        record !== null &&
        (key === null
          ? record.runnerKey !== null
          : record.supersededKeys.includes(key) ||
            record.refusedKeys.includes(key));
      if (kind === "session-alive" && listed && sessionId !== null) {
        this.replacedReports.set(sessionId, {
          count: (this.replacedReports.get(sessionId)?.count ?? 0) + 1,
          lastAt: this.now(),
          // Q9: what an operator acts on differs by reason (plan §8.5).
          why:
            key === null
              ? "no-key"
              : record?.supersededKeys.includes(key)
                ? "replaced-key"
                : "refused-key",
        });
      }
      // R5's third moment; a socket counts once across the three (F-B).
      if (!enforce && this.cuttableAfterDrop(socket, record)) {
        this.countWouldCut([socket]);
      }
      if (reportWarning(kind, sessionId === sid) === "persist") {
        this.warnOnce(socket, `report:${kind}`, () =>
          this.logger.warn(
            enforce
              ? `runner identity: dropped a ${kind} report`
              : `runner identity: would drop a ${kind} report (observe)`,
            {
              ...this.socketWarning(
                socket,
                REPORT_CATEGORY,
                enforce ? "drop" : "would-drop",
                record
              ),
              context: {
                decision: enforce ? "drop" : "would-drop",
                kind,
                mode: this.mode,
                socketKey: key,
                recordedKey: record?.runnerKey ?? null,
                sidMatches: sessionId === sid,
                namedSid: sessionId === sid ? undefined : sid,
              },
            }
          )
        );
      }
      return !enforce;
    } catch (error) {
      this.failOpen(
        "gateReport",
        socket.data.sessionId ?? null,
        REPORT_CATEGORY,
        error,
        false
      );
      return true;
    }
  }

  /**
   * R5's third moment: after a dropped report was answered, cut off the socket
   * that sent it when its own session refuses it (#6974 O6; K3 is never cut).
   * A socket with no session id is in no session's room and is never cut.
   * Nothing outside `enforce`. Never throws.
   */
  afterDroppedReport(socket: RunnerSocketLike): void {
    if (this.mode !== "enforce") return;
    const sessionId = socket.data.sessionId;
    if (!sessionId) return;
    try {
      const record = this.recordOf(sessionId, socket.data.namespace);
      if (!this.cuttableAfterDrop(socket, record)) return;
      this.cutOff(sessionId, socket.data.namespace, [socket], "report-dropped");
    } catch (error) {
      this.failOpen(
        "afterDroppedReport",
        sessionId,
        REPORT_CATEGORY,
        error,
        false
      );
    }
  }

  /**
   * R15: whether the identity layer cut this session off and no handshake was
   * accepted since, read in every mode. False in the route's `cond1Readable`
   * window after this registry's start (Task 12a, OR12): a refused socket can
   * set the mark there before the recorded runner's own reconnect.
   */
  wasCutOff(sessionId: string, namespace?: string): boolean {
    try {
      if (this.now() - this.bootedAt < COND1_READABLE_AFTER_SECONDS * 1000) {
        return false;
      }
      return this.recordOf(sessionId, namespace)?.cutAt != null;
    } catch (error) {
      this.failOpen("wasCutOff", sessionId, HANDSHAKE_CATEGORY, error);
      return false;
    }
  }

  /** The counts since the server start (R10). Zeros in `off`. */
  counts(): RunnerIdentityCounts {
    return structuredClone(this.countsState);
  }

  /**
   * Sessions whose backstop counted a would-be-dropped heartbeat from a listed
   * key, or from a keyless runner on a keyed record (P2), within the last `REPLACED_REPORTING_WINDOW_MS` (D2), with the count
   * since the server start and the newest report's time. `include` scopes it
   * (the route passes the caller's namespace).
   */
  replacedStillReporting(
    include: (sessionId: string) => boolean = () => true
  ): Array<{
    sessionId: string;
    wouldDropAlive: number;
    lastReportAt: number;
    why: ReplacedReportReason;
  }> {
    const since = this.now() - REPLACED_REPORTING_WINDOW_MS;
    const out: Array<{
      sessionId: string;
      wouldDropAlive: number;
      lastReportAt: number;
      why: ReplacedReportReason;
    }> = [];
    for (const [sessionId, entry] of this.replacedReports) {
      if (!include(sessionId) || entry.lastAt < since) continue;
      out.push({
        sessionId,
        wouldDropAlive: entry.count,
        lastReportAt: entry.lastAt,
        why: entry.why,
      });
    }
    return out;
  }

  /**
   * OR4 (Task 9's field, filled from PR2 on): sessions where a cut-off hit a
   * socket whose runner the stop cannot reach: one with no key (an old
   * binary), or one whose `runner-superseded` emit failed (`hadKey: true`).
   * The newest per session, since the server start; `include` scopes it.
   */
  cutOffWithoutStop(
    include: (sessionId: string) => boolean = () => true
  ): Array<{ sessionId: string; at: number; hadKey: boolean }> {
    const out: Array<{ sessionId: string; at: number; hadKey: boolean }> = [];
    for (const [sessionId, entry] of this.cutWithoutStop) {
      if (include(sessionId)) out.push({ sessionId, ...entry });
    }
    return out;
  }

  /** D2: the time of the newest report from a listed key, listed or not, or null. */
  newestReplacedReportAt(
    include: (sessionId: string) => boolean = () => true
  ): number | null {
    let newest: number | null = null;
    for (const [sessionId, entry] of this.replacedReports) {
      if (include(sessionId) && (newest === null || entry.lastAt > newest)) {
        newest = entry.lastAt;
      }
    }
    return newest;
  }

  /** Sessions whose record write has not landed yet (§7), with their namespace. */
  pendingWrites(): Array<{ sessionId: string; namespace: string }> {
    const out: Array<{ sessionId: string; namespace: string }> = [];
    for (const [sessionId, entry] of this.cache) {
      if (entry.pending !== null)
        out.push({ sessionId, namespace: entry.namespace });
    }
    return out;
  }

  /**
   * Task 9 (R10, COND-WIDE): every given session with a live process the hub
   * cannot name as its current identified runner, with the first reason that
   * applies. Built from the sockets in the session's room and its record, not
   * from the `active` flag alone. A session that fails is skipped (fail open).
   * Empty in `off`.
   */
  listUnidentifiedLive(sessions: LiveSessionInput[]): UnidentifiedLive[] {
    if (this.mode === "off") return [];
    const pending = new Set(this.pendingWrites().map(p => p.sessionId));
    const out: UnidentifiedLive[] = [];
    for (const session of sessions) {
      try {
        const sockets = this.liveSockets(session.id);
        const record = this.recordOf(session.id, session.namespace);
        const reason = unidentifiedReason(
          sockets,
          record,
          session.active,
          pending.has(session.id)
        );
        if (reason === null) continue;
        out.push({
          sessionId: session.id,
          name: session.name,
          launcherKind: session.launcherKind,
          reason,
          socketCount: sockets.length,
          attachedAt: record?.attachedAt ?? null,
        });
      } catch (error) {
        this.failOpen(
          "listUnidentifiedLive",
          session.id,
          ATTACH_CATEGORY,
          error
        );
      }
    }
    return out;
  }

  /** Task 9a: where the daily snapshot is written and read. */
  setDaily(daily: RunnerIdentityDailyStore): void {
    this.daily = daily;
  }

  /**
   * Task 9a: adds the counts since the last write that landed to the day's
   * row. Nothing in `off`. A failed write fails open and is counted; its
   * counts go with the next write. Returns false only when the write failed
   * (Q1: the shutdown warns, because no next write will carry them).
   */
  writeDailySnapshot(input: {
    boot: boolean;
    unidentifiedLive: () => number;
  }): boolean {
    if (this.mode === "off" || this.daily === null) return true;
    try {
      const counts = this.counts();
      this.daily.write({
        nowMs: this.now(),
        mode: this.mode,
        countsDelta: diffCounts(counts, this.lastWrittenCounts),
        // F11: a failed boot write's flag goes with the next write that lands.
        boot: input.boot || this.bootUnwritten,
        unidentifiedLive: input.unidentifiedLive(),
      });
      this.lastWrittenCounts = counts;
      this.bootUnwritten = false;
      return true;
    } catch (error) {
      this.bootUnwritten = this.bootUnwritten || input.boot;
      this.failOpen("writeDailySnapshot", null, ATTACH_CATEGORY, error);
      return false;
    }
  }

  /** Task 9a: the node's last 14 daily rows, newest first. Empty in `off`. */
  snapshots(): RunnerIdentitySnapshot[] {
    if (this.mode === "off" || this.daily === null) return [];
    try {
      return this.daily.snapshots();
    } catch (error) {
      this.failOpen("snapshots", null, ATTACH_CATEGORY, error);
      return [];
    }
  }

  /**
   * Task 9a: every five minutes, retry pending record writes and write the
   * snapshot. The timer is unref'd and never throws; nothing runs in `off`.
   */
  startSnapshotTimer(
    writeSnapshot: () => void,
    intervalMs = RUNNER_IDENTITY_SNAPSHOT_INTERVAL_MS
  ): { stop(): void } {
    if (this.mode === "off") return { stop: () => {} };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = (): void => {
      try {
        this.retryPendingWrites();
        writeSnapshot();
      } catch (error) {
        this.failOpen("snapshotTimer", null, ATTACH_CATEGORY, error);
      }
      timer = setTimeout(tick, intervalMs);
      timer.unref?.();
    };
    timer = setTimeout(tick, intervalMs);
    timer.unref?.();
    this.snapshotTimer = {
      stop: () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
      },
    };
    return this.snapshotTimer;
  }

  /**
   * F8: the graceful-shutdown step. Stops the timer, retries pending record
   * writes until the bound `budgetMs` (N1), warns once about any that did not
   * land, tried or not (each is counted in `recordWriteFailures`), then writes
   * the last snapshot and warns when it did not land (Q1). Nothing in `off`.
   * Never throws.
   */
  shutdown(
    writeSnapshot: () => boolean | void,
    budgetMs = RUNNER_IDENTITY_SHUTDOWN_BUDGET_MS
  ): void {
    if (this.mode === "off") return;
    try {
      this.snapshotTimer?.stop();
      // N1: one bound for the whole retry. A held lock makes each retry wait
      // busy_timeout, so no retry starts once the bound has passed; a write
      // left untried is counted as failed and named in the warning below.
      const deadline = this.now() + budgetMs;
      const notTried: string[] = [];
      for (const { sessionId } of this.pendingWrites()) {
        if (this.now() >= deadline) {
          notTried.push(sessionId);
          this.countsState.recordWriteFailures += 1;
          continue;
        }
        // P4: not persisted, so a failing retry waits busy_timeout once.
        this.retryPending(sessionId, false);
      }
      const pending = this.pendingWrites();
      if (pending.length > 0) {
        this.logger.warn(
          "runner identity: runner record writes still pending at shutdown",
          {
            category: SHUTDOWN_CATEGORY,
            context: {
              decision: "pending-at-shutdown",
              sessionIds: pending.map(p => p.sessionId),
              notTried,
              budgetMs,
            },
          }
        );
      }
    } catch (error) {
      this.failOpen("shutdown", null, SHUTDOWN_CATEGORY, error);
    }
    try {
      if (writeSnapshot() === false) {
        // Q1: the counts since the last landed write are lost with this
        // process, and the write's own fail-open may be silenced by its
        // once-key or the attach category's rate limit.
        this.logger.warn(
          "runner identity: the last daily snapshot did not land at shutdown",
          {
            category: SHUTDOWN_CATEGORY,
            context: { decision: "snapshot-not-landed", mode: this.mode },
          }
        );
      }
    } catch (error) {
      this.failOpen("shutdown", null, SHUTDOWN_CATEGORY, error);
    }
  }

  /** Retries every pending record write (the snapshot timer, Task 9a). */
  retryPendingWrites(): void {
    if (this.mode === "off") return;
    for (const { sessionId } of this.pendingWrites()) {
      try {
        this.retryPending(sessionId);
      } catch (error) {
        this.failOpen("retryPendingWrites", sessionId, ATTACH_CATEGORY, error);
      }
    }
  }

  /** A deleted session leaves the cache, the lists and the warn-once keys (N5). */
  forget(sessionId: string): void {
    this.cache.delete(sessionId);
    this.replacedReports.delete(sessionId);
    this.cutWithoutStop.delete(sessionId);
    this.refusedHandshakeAt.delete(sessionId);
    for (const once of this.failOpenWarned) {
      if (once.endsWith(`:${sessionId}`)) this.failOpenWarned.delete(once);
    }
  }

  /** The record that decides: the pending one when a write has not landed. */
  recordOf(sessionId: string, namespace?: string): RunnerRecord | null {
    const cached = this.cache.get(sessionId);
    if (
      cached !== undefined &&
      (namespace === undefined || cached.namespace === namespace)
    ) {
      return cached.pending ?? cached.record;
    }
    if (namespace === undefined) return null;
    const record = this.store.getRunnerRecord(sessionId, namespace);
    if (record === null) return null;
    this.cache.set(sessionId, { namespace, record, pending: null });
    return record;
  }

  private writeRecord(
    sessionId: string,
    namespace: string,
    record: RunnerRecord
  ): void {
    let written = false;
    try {
      written = this.store.setRunnerRecord(sessionId, namespace, record);
    } catch (error) {
      this.recordWriteFailed("commitAttach", sessionId, error);
      written = false;
    }
    if (written) {
      this.cache.set(sessionId, { namespace, record, pending: null });
      return;
    }
    const entry = this.cache.get(sessionId);
    this.cache.set(sessionId, {
      namespace,
      record: entry?.record ?? null,
      pending: record,
    });
    this.countsState.recordWriteFailures += 1;
  }

  private retryPending(sessionId: string, persist = true): void {
    const entry = this.cache.get(sessionId);
    if (entry === undefined || entry.pending === null) return;
    let written = false;
    try {
      written = this.store.setRunnerRecord(
        sessionId,
        entry.namespace,
        entry.pending
      );
    } catch (error) {
      this.recordWriteFailed("retryPending", sessionId, error, persist);
      written = false;
    }
    if (written) {
      this.cache.set(sessionId, {
        namespace: entry.namespace,
        record: entry.pending,
        pending: null,
      });
    } else {
      this.countsState.recordWriteFailures += 1;
    }
  }

  private addRefused(sessionId: string, namespace: string, key: string): void {
    this.store.addRefusedRunnerKey(sessionId, namespace, key);
    const entry = this.cache.get(sessionId);
    if (entry === undefined) return;
    const apply = (record: RunnerRecord | null): RunnerRecord | null =>
      record === null
        ? null
        : {
            ...record,
            refusedKeys: [
              ...record.refusedKeys.filter(k => k !== key),
              key,
            ].slice(-MAX_RUNNER_KEYS_PER_LIST),
          };
    this.cache.set(sessionId, {
      namespace: entry.namespace,
      record: apply(entry.record),
      pending: apply(entry.pending),
    });
  }

  /** R5 in `enforce`: cut these sockets; in `observe`: count them. */
  private cutOrCount(
    sessionId: string,
    namespace: string | undefined,
    sockets: RunnerSocketLike[],
    why: CutReason
  ): number {
    if (sockets.length === 0) return 0;
    if (this.mode !== "enforce") {
      this.countWouldCut(sockets);
      return sockets.length;
    }
    return this.cutOff(sessionId, namespace, sockets, why);
  }

  /**
   * F-B: observe counts a socket once, as enforce cuts it once at the first
   * moment that meets it. Keyed on `data`: the room read returns fresh
   * `{ id, data }` objects around each socket's own `data`.
   */
  private countWouldCut(sockets: RunnerSocketLike[]): void {
    for (const s of sockets) {
      if (this.wouldCutSockets.has(s.data)) continue;
      this.wouldCutSockets.add(s.data);
      this.countsState.wouldCutOff += 1;
    }
  }

  /** Y1: note a refused handshake's time; entries past the window are pruned. */
  private noteRefused(sessionId: string, key: string): void {
    const at = this.refusedHandshakeAt.get(sessionId) ?? new Map();
    for (const [k, t] of at) {
      if (this.now() - t > REPLACED_REPORTING_WINDOW_MS) at.delete(k);
    }
    this.refusedHandshakeAt.set(sessionId, at.set(key, this.now()));
  }

  /**
   * R5: tells each socket `runner-superseded`, marks it evicted (its
   * `disconnect` arms no grace timer) and disconnects it, each socket inside
   * its own try/catch: `disconnect(true)` runs the socket's own `disconnect`
   * listeners inside this call, and at a takeover that is the new runner's
   * POST. Then counts, lists a stop that could not reach its runner (OR4: no
   * key, no declared reader of the stop (F1), a failed emit, or a socket
   * already gone), and sets the mark only when
   * no passing socket is left (R15, K18). Returns the number cut.
   */
  private cutOff(
    sessionId: string,
    namespace: string | undefined,
    sockets: RunnerSocketLike[],
    why: CutReason
  ): number {
    const cut = new Set<string>();
    for (const s of sockets) {
      const hadKey = Boolean(s.data.runnerKey);
      let stopped = false;
      try {
        // A socket the namespace no longer holds is gone: nothing is cut and
        // no stop reaches its runner (the PM's ruling of 01:00Z).
        const live = this.socketLookup(s.id);
        if (live === undefined) {
          // Only a mis-wired lookup misses a socket the room read returned.
          this.failOpen(
            "cutOff:lookup",
            sessionId,
            HANDSHAKE_CATEGORY,
            new Error(`no live socket ${s.id} for a member of the room`),
            false
          );
        } else {
          live.data.evicted = true;
          cut.add(s.id);
          try {
            live.emit(RUNNER_SUPERSEDED_EVENT, {
              code: RUNNER_SUPERSEDED,
              sessionId,
              why,
            });
            // F1: a PR1 binary is keyed but deaf to the stop; count only a declared reader.
            stopped = hadKey && live.data.readsStop === true;
          } catch (error) {
            this.failOpen(
              "cutOff:emit",
              sessionId,
              HANDSHAKE_CATEGORY,
              error,
              false
            );
          }
          live.disconnect(true);
        }
      } catch (error) {
        this.failOpen("cutOff", sessionId, HANDSHAKE_CATEGORY, error, false);
      }
      if (stopped) this.countsState.stopsSent += 1;
      else this.cutWithoutStop.set(sessionId, { at: this.now(), hadKey });
    }
    if (cut.size === 0) return 0;
    this.countsState.socketsCutOff += cut.size;
    this.markIfNoPassing(sessionId, namespace, cut);
    return cut.size;
  }

  /**
   * R15, K18: the mark, set only when no connected socket of the session
   * passes. Never throws: the refusal or cut that called it stands, and a mark
   * that could not be written is counted (a throw as a fail-open, a write that
   * changed no row as a record write failure) and not cached.
   */
  private markIfNoPassing(
    sessionId: string,
    namespace: string | undefined,
    cut: Set<string> = new Set()
  ): void {
    const cutAt = this.now();
    try {
      const record = this.recordOf(sessionId, namespace);
      if (record === null || record.cutAt !== null) return;
      const passing = this.liveSockets(sessionId).some(
        s =>
          !cut.has(s.id) &&
          !s.data.evicted &&
          decideHandshake(record, s.data.runnerKey ?? null) !== "refuse"
      );
      if (passing) return;
      if (!this.store.setRunnerCutAt(sessionId, cutAt)) {
        this.countsState.recordWriteFailures += 1;
        return;
      }
    } catch (error) {
      this.failOpen("markCut", sessionId, HANDSHAKE_CATEGORY, error, false);
      return;
    }
    const entry = this.cache.get(sessionId);
    if (entry === undefined) return;
    const mark = (r: RunnerRecord | null) =>
      r === null ? null : { ...r, cutAt };
    this.cache.set(sessionId, {
      namespace: entry.namespace,
      record: mark(entry.record),
      pending: mark(entry.pending),
    });
  }

  /** #6974 O6: after a drop, cut the socket only when its own session refuses it. */
  private cuttableAfterDrop(
    socket: RunnerSocketLike,
    record: RunnerRecord | null
  ): boolean {
    if (!socket.data.sessionId) return false;
    return decideHandshake(record, socket.data.runnerKey ?? null) === "refuse";
  }

  /** R3: the liveness read that picks the refusal's wording, and nothing else. */
  private refusalReason(sessionId: string): RunnerRefusalReason {
    try {
      return this.liveSockets(sessionId).length > 0
        ? "runner-present"
        : "session-exists";
    } catch (error) {
      this.failOpen("refusalReason", sessionId, REFUSAL_CATEGORY, error);
      return "session-exists";
    }
  }

  private clearCutMark(sessionId: string, namespace?: string): void {
    const record = this.recordOf(sessionId, namespace);
    if (record === null || record.cutAt === null) return;
    this.store.setRunnerCutAt(sessionId, null);
    const entry = this.cache.get(sessionId);
    if (entry === undefined) return;
    const clear = (r: RunnerRecord | null) =>
      r === null ? null : { ...r, cutAt: null };
    this.cache.set(sessionId, {
      namespace: entry.namespace,
      record: clear(entry.record),
      pending: clear(entry.pending),
    });
  }

  /**
   * F5 (R11): a record write that throws warns once per session with the error.
   * The caller counts it in `recordWriteFailures`, the figure the route shows,
   * and keeps the record pending. Never throws.
   */
  private recordWriteFailed(
    method: string,
    sessionId: string,
    error: unknown,
    persist = true
  ): void {
    try {
      const once = `recordWrite:${sessionId}`;
      if (this.failOpenWarned.has(once)) return;
      this.failOpenWarned.add(once);
      this.logger.warn("runner identity: a runner record write failed", {
        category: ATTACH_CATEGORY,
        sessionId,
        ...(persist ? {} : { persist: false }),
        context: {
          decision: "record-write-failed",
          method,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } catch {
      // Fail open means nothing here may throw (R11).
    }
  }

  private isRequested(tag: string): boolean {
    const expires = this.spawnNotes.get(tag);
    if (expires === undefined) return false;
    if (expires <= this.now()) {
      this.spawnNotes.delete(tag);
      return false;
    }
    return true;
  }

  private warnOnce(
    socket: RunnerSocketLike,
    kind: string,
    write: () => void
  ): void {
    let kinds = this.warnedSockets.get(socket);
    if (kinds === undefined) {
      kinds = new Set();
      this.warnedSockets.set(socket, kinds);
    }
    if (kinds.has(kind)) return;
    kinds.add(kind);
    write();
  }

  private socketWarning(
    socket: RunnerSocketLike,
    category: string,
    decision: string,
    record: RunnerRecord | null
  ): ErrorLogOptions {
    return {
      category,
      sessionId: socket.data.sessionId ?? null,
      namespace: socket.data.namespace ?? null,
      context: {
        decision,
        mode: this.mode,
        socketKey: socket.data.runnerKey ?? null,
        recordedKey: record?.runnerKey ?? null,
      },
    };
  }

  private failOpen(
    method: string,
    sessionId: string | null,
    category: string,
    error: unknown,
    // F4 (Task 4, #3631): false only inside a socket listener's own catch.
    persist = true
  ): void {
    try {
      this.countsState.failedOpen += 1;
      const once = `${method}:${sessionId ?? "-"}`;
      if (this.failOpenWarned.has(once)) return;
      this.failOpenWarned.add(once);
      this.logger.warn(`runner identity: ${method} failed open`, {
        category,
        sessionId,
        ...(persist ? {} : { persist: false }),
        context: {
          decision: "fail-open",
          method,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } catch {
      // Fail open means nothing here may throw (R11).
    }
  }
}

/**
 * The `/cli` middleware's identity step (Task 6, R6, R11): puts the
 * handshake's session id and runner key on `socket.data` (the id itself is not
 * kept; an empty id is no id, since it would hash to a real key), then tests
 * the socket. `off` adds nothing. Never throws, because a throw in the
 * middleware exits the server; returns false only for a refusal in `enforce`.
 */
export function runnerHandshake(
  socket: RunnerSocketLike,
  auth: Record<string, unknown> | undefined,
  identity: RunnerIdentity | null | undefined
): boolean {
  try {
    if (!identity || identity.mode === "off") return true;
    if (typeof auth?.sessionId === "string") {
      socket.data.sessionId = auth.sessionId;
    }
    if (typeof auth?.runnerId === "string" && auth.runnerId.length > 0) {
      socket.data.runnerKey = runnerKeyOf(auth.runnerId);
    }
    if (auth?.readsStop === true) socket.data.readsStop = true; // F1
    return identity.handshake(socket);
  } catch {
    return true;
  }
}

/**
 * The `/cli` middleware's whole identity step (Tasks 6 and 12, R6, R11): calls
 * `next` exactly once, with the `runner-superseded` refusal only for a refused
 * handshake in `enforce`. A throw anywhere in it ends in a plain `next()`.
 */
export function runnerHandshakeStep(
  socket: RunnerSocketLike,
  auth: Record<string, unknown> | undefined,
  identity: RunnerIdentity | null | undefined,
  next: (err?: Error) => void
): void {
  let refusal: Error | undefined;
  try {
    if (!runnerHandshake(socket, auth, identity)) {
      refusal = runnerSupersededError();
    }
  } catch {
    refusal = undefined;
  }
  next(refusal);
}
