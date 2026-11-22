// SPDX-License-Identifier: AGPL-3.0-only
import {
  BILLABLE_SWITCH_REPORT_MAX_AGE_MS,
  BillableConfirmSchema,
  projectBaseKey,
  projectKeyKind,
  unloggedAmount,
  type BillableConfirm,
  type BillableSwitchActor,
  type BillableSwitchEvent,
  type BillableSwitchHeader,
  type BillableSwitchMode,
  type BillableSwitchNodeView,
  type BillableSwitchVia,
  type BillableSwitchWriteReason,
  type ProjectKeyMetadata,
  type OldRouteAction,
  type Session,
} from "@hapi/protocol";
import { z } from "zod";
import type { Store } from "../store";
import type {
  BillableSwitchListedSession,
  BillableSwitchMirrorEvent,
} from "../store/billableSwitchStore";
import type { BillableSwitchInitial } from "../store/sessions";
import {
  resolveTrackingStartForInsert,
  type TrackingRegistration,
} from "./trackingStart";
import { retryTrackingReconcileFor } from "./trackingStartup";
import type {
  BillableSwitchNodeRegistryView,
  NodeRegistry,
  PeerReadOutcome,
} from "../federation/nodeRegistry";

// The billable switch's service (issue #6646, Task 5): the one place that decides
// a new session's start value, writes a switch and a confirm, answers the
// history and the across-node list, and sends a node with no view of the mesh
// its (empty) header reports. Since #6778 PR-A (R12) no header is written and no
// other node's header list is kept (the start-up step deleted the peers' stored
// header rows; their report rows stay, and a received report stores nothing):
// no header decides a start.

/** One node in the cross-node view (the join of the stored reports and the registry). */
export type BillableSwitchCrossNodeEntry = Omit<
  BillableSwitchNodeView,
  "headers"
> & {
  /** `local`, the registry's status, or `not-tracked` for a stored node the registry no longer tracks. */
  status: string;
  on: boolean;
  closed: boolean;
  store: boolean;
  awaitingInitialPoll: boolean;
  headers: BillableSwitchHeader[];
};

export type BillableSwitchWriteActor = {
  actor: BillableSwitchActor;
  via: BillableSwitchVia;
  entryNodeId: string | null;
};

export type BillableSwitchSetOutcome =
  /** `reconcilePending`: the start-up reconcile has not settled this session yet (409, 3.4 step 6). */
  | { found: false; reconcilePending?: true }
  | {
      found: true;
      changed: boolean;
      billable: boolean;
      billableConfirm: BillableConfirm;
      timerMs: number;
      unloggedMs: number;
      loggedKnown: boolean;
    };

export type BillableSwitchConfirmOutcome =
  | {
      outcome: "ok";
      result: Extract<BillableSwitchSetOutcome, { found: true }>;
    }
  | { outcome: "not_found" }
  | { outcome: "reconcile_pending" }
  | { outcome: "not_pending" };

/** Section 6 item 4: the history response's event, built field by field. */
export type BillableSwitchHistoryEvent = {
  id: number;
  at: number;
  kind: BillableSwitchEvent["kind"];
  reason: string | null;
  billableBefore: boolean | null;
  billableAfter: boolean | null;
  confirmBefore: BillableConfirm;
  confirmAfter: BillableConfirm;
  startKind?: string;
  actor: { kind: string; sessionId?: string };
  via: string;
  entryNodeId: string | null;
  timerMs: number | null;
  unloggedMs: number | null;
  loggedKnown: boolean;
  /**
   * #6646 (Task 14): on a start event only, the nodes whose header made the
   * session billable (its label's `causeNodes`), as label and report time and
   * nothing else. Absent when the start had no cause.
   */
  causeNodes?: Array<{ nodeLabel: string; reportedAt: number | null }>;
};

/** A start event label's cause nodes, as the history read shows them. */
function historyCauseNodes(
  label: Record<string, unknown> | null
): Array<{ nodeLabel: string; reportedAt: number | null }> {
  const raw = label?.causeNodes;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ nodeLabel: string; reportedAt: number | null }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { nodeLabel, reportedAt } = entry as Record<string, unknown>;
    if (typeof nodeLabel !== "string") continue;
    out.push({
      nodeLabel,
      reportedAt: typeof reportedAt === "number" ? reportedAt : null,
    });
  }
  return out;
}

export type BillableSwitchHistory = {
  sessionId: string;
  source: "local" | "origin" | "mirror";
  originNodeId: string | null;
  mirrorSyncedAt: number | null;
  events: BillableSwitchHistoryEvent[];
};

export type BillableSwitchNodeListing = {
  nodeId: string;
  state: "ok" | "unreachable" | "unsupported";
  mode?: BillableSwitchMode;
  sessions?: Array<BillableSwitchListedSession & { namespace: string }>;
};

/** The body of `POST /api/federation/billable-switch/sessions` (a billing reader's list). */
export const BillableSwitchSessionListResponseSchema = z.object({
  mode: z.enum(["off", "on", "closed"]),
  sessions: z.array(
    z.object({
      sessionId: z.string(),
      namespace: z.string(),
      billable: z.boolean(),
      confirm: BillableConfirmSchema,
      lastEventId: z.number().nullable(),
      lastEventAt: z.number().nullable(),
    })
  ),
});

/** One node's report as the push carries it (Task 4). */
export const BillableSwitchPushedReportSchema = z.object({
  nodeId: z.string().min(1).max(200),
  nodeLabel: z.string().max(200).nullable(),
  reportedAt: z.number(),
  headers: z.array(
    z.object({
      namespace: z.string().max(200),
      projectKey: z.string().min(1).max(500),
      keyKind: z.enum(["repo", "path"]),
      billable: z.boolean(),
      updatedAt: z.number(),
    })
  ),
});
export const BillableSwitchPushBodySchema = z
  .object({ reports: z.array(BillableSwitchPushedReportSchema).max(1000) })
  .strict();
export type BillableSwitchPushBody = z.infer<
  typeof BillableSwitchPushBodySchema
>;

const PUSH_INTERVAL_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export type BillableSwitchServiceDeps = {
  store: Store;
  /** Late-bound: null on a node without a registry (role `node`, a bare test). */
  getRegistry: () => NodeRegistry | null;
  getLocalNodeId: () => string;
  getLocalNodeLabel: () => string;
  getMode: () => BillableSwitchMode;
  /** The engine's record, for the timer and the label. */
  getSession: (sessionId: string) => Session | undefined;
  /** `sessionCache.refreshSession`, so a change emits `session-updated`. */
  refreshSession: (sessionId: string) => void;
  /** This node's role (the push rule); absent → `node`. */
  getRole?: () => "hub" | "peer" | "node";
  /** The 30-minute sweep of the spawn queues (sessionCache.sweepPendingByTag). */
  sweepPendingByTag?: () => void;
  now?: () => number;
};

export class BillableSwitchService {
  private readonly now: () => number;
  /** Nodes that answered the push with `has-registry`: skipped from then on. */
  private readonly pushSkip = new Set<string>();
  /**
   * PR-2 item E2: each node whose header-report push is failing, with how many
   * pushes in a row failed. A streak is logged when it starts and when it ends,
   * so a push that fails every time is seen without a line every round.
   */
  private readonly pushFailing = new Map<string, number>();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private pushInFlight: Promise<void> | null = null;

  constructor(private readonly deps: BillableSwitchServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  mode(): BillableSwitchMode {
    return this.deps.getMode();
  }

  /** This node's id as the record names it (the entry node of a local write). */
  localNodeId(): string {
    return this.deps.getLocalNodeId();
  }

  /** This node's label, for a refusal that names the node. */
  localNodeLabel(): string {
    return this.deps.getLocalNodeLabel();
  }

  // ─── the amount (section 5) ───────────────────────────────────────────────

  /** The swap point: the minutes already logged. Unknown until #6204 replaces this. */
  loggedMsFor(_sessionId: string): number | null {
    return null;
  }

  /**
   * The live segment while thinking. Read only through this test for a number
   * (the plan's rule 2): #6586 widens `thinkingStartedAt` to allow `null`, and
   * a test with `!== undefined` would add `now - 0`, about 55 years.
   */
  liveSegmentMs(
    session: Pick<Session, "thinking" | "thinkingStartedAt">,
    now: number
  ): number {
    const started = (session as { thinkingStartedAt?: unknown })
      .thinkingStartedAt;
    if (!session.thinking || typeof started !== "number") return 0;
    return Math.max(0, now - started);
  }

  /** The session timer plus the live segment. */
  timerMsFor(session: Session | undefined, now: number): number {
    if (!session) return 0;
    const accumulated =
      typeof session.serverAccumulatedMs === "number"
        ? session.serverAccumulatedMs
        : 0;
    return accumulated + this.liveSegmentMs(session, now);
  }

  private labelFor(
    session: Session | undefined,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> {
    const meta = session?.metadata as
      | (ProjectKeyMetadata & { name?: unknown; path?: unknown })
      | undefined;
    return {
      name: typeof meta?.name === "string" ? meta.name : null,
      projectKey: meta ? projectBaseKey(meta) : null,
      path: typeof meta?.path === "string" ? meta.path : null,
      ...extra,
    };
  }

  // ─── the cross-node view ──────────────────────────────────────────────────

  /**
   * The node view of `GET /api/billable-switch/headers`, whose `on` flags the
   * web's Create reads. Since #6778 PR-A (R12) every entry's header list is
   * empty: no header decides a start, the start-up step switched this node's
   * rows off and deleted the peers' stored header rows (their report rows stay,
   * so a node still shows with its last report time), and no report is stored
   * again.
   *
   * THE one definition of the join: this node as the local entry; one entry
   * per node with a stored report; one entry with no report (unknown) for every
   * node the registry tracks that never reported, and for every node known only
   * by a stored header row; each joined with the registry's label, status and
   * flags when it tracks the node, else shown from its stored label as
   * `not-tracked` (a peer evicted automatically can re-join).
   */
  crossNodeView(): BillableSwitchCrossNodeEntry[] {
    const localId = this.deps.getLocalNodeId();
    const mode = this.mode();
    const registryViews = new Map<string, BillableSwitchNodeRegistryView>(
      (this.deps.getRegistry()?.getBillableSwitchNodeViews() ?? []).map(v => [
        v.nodeId,
        v,
      ])
    );
    const entries: BillableSwitchCrossNodeEntry[] = [
      {
        nodeId: localId,
        nodeLabel: this.deps.getLocalNodeLabel(),
        isLocal: true,
        reportedAt: this.now(),
        headers: [],
        status: "local",
        on: mode === "on",
        closed: mode === "closed",
        store: this.deps.store.billableSwitchStorageReady,
        awaitingInitialPoll: false,
      },
    ];
    const seen = new Set<string>([localId]);
    // Only the node ids: since #6778 PR-A no entry shows a header.
    const unreported = new Set(
      this.deps.store.billableSwitch
        .listUnreportedPeerHeaders()
        .map(row => row.nodeId)
    );
    const remote = (
      nodeId: string,
      label: string | null,
      reportedAt: number | null
    ): BillableSwitchCrossNodeEntry => {
      const view = registryViews.get(nodeId);
      return {
        nodeId,
        nodeLabel: view?.nodeLabel ?? label ?? nodeId,
        isLocal: false,
        reportedAt,
        // #6778 PR-A: a stored report row (the start-up step deletes only its
        // header rows) shows no header either.
        headers: [],
        status: view?.status ?? "not-tracked",
        on: view?.on ?? false,
        closed: view?.closed ?? false,
        store: view?.store ?? false,
        awaitingInitialPoll: view?.awaitingInitialPoll ?? false,
      };
    };
    for (const report of this.deps.store.billableSwitch.listPeerReports()) {
      if (seen.has(report.nodeId)) continue;
      seen.add(report.nodeId);
      entries.push(remote(report.nodeId, report.nodeLabel, report.reportedAt));
    }
    for (const view of registryViews.values()) {
      if (seen.has(view.nodeId)) continue;
      seen.add(view.nodeId);
      entries.push(remote(view.nodeId, view.nodeLabel, null));
    }
    for (const nodeId of unreported) {
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      entries.push(remote(nodeId, null, null));
    }
    return entries;
  }

  // ─── the start value of a new row ─────────────────────────────────────────

  /**
   * The start value of a session row about to be inserted (the start hook).
   * #6778 PR-B (Task 7): the rule lives in `trackingStart.ts`, which reads the
   * queued start from the durable table inside the registration transaction;
   * this method keeps the hook's name for its callers.
   */
  resolveStartForInsert(
    input: TrackingRegistration
  ): BillableSwitchInitial | null {
    return resolveTrackingStartForInsert(
      {
        store: this.deps.store,
        getMode: () => this.mode(),
        getLocalNodeId: this.deps.getLocalNodeId,
        now: this.now,
      },
      input
    );
  }

  // ─── switch, confirm, header ──────────────────────────────────────────────

  /**
   * Switch one session on or off on THIS node. The kind is judged on the pair
   * the write replaces: a switch-off of a waiting session is `reverse`, a
   * switch-on sent to a waiting session is `keep`. A write that changes neither
   * the switch nor the confirm state records nothing.
   */
  setSwitch(
    sessionId: string,
    namespace: string,
    input: BillableSwitchWriteActor & {
      billable: boolean;
      reason: BillableSwitchWriteReason;
      loggedMs: number | null;
    }
  ): BillableSwitchSetOutcome {
    const result = this.write(sessionId, namespace, input, {
      action: input.billable ? "switch-on" : "switch-off",
      reason: input.reason,
    });
    if (result === "reconcile-pending")
      return { found: false, reconcilePending: true };
    // `not-waiting` comes only with `requireWaiting`, which a switch never sets.
    return result === "not-waiting" ? { found: false } : result;
  }

  /**
   * Decide a waiting session (#6778, Matt Starfield's ruling 1): `keep` clears
   * the confirm state and keeps the status; `reverse` makes the session
   * Non-billable and keeps its record. "Waiting" is judged on the record, any
   * status. Not waiting → `not_pending`.
   */
  confirm(
    sessionId: string,
    namespace: string,
    input: BillableSwitchWriteActor & {
      decision: "keep" | "reverse";
      reason: "confirm" | "confirm-all" | "confirm-reverse";
      loggedMs: number | null;
    }
  ): BillableSwitchConfirmOutcome {
    const reason =
      input.decision === "reverse"
        ? "confirm-reverse"
        : input.reason === "confirm-reverse"
          ? "confirm"
          : input.reason;
    const result = this.write(sessionId, namespace, input, {
      action: input.decision,
      reason,
      requireWaiting: true,
    });
    if (result === "reconcile-pending") return { outcome: "reconcile_pending" };
    if (result === "not-waiting") return { outcome: "not_pending" };
    if (!result.found) return { outcome: "not_found" };
    if (!result.changed) return { outcome: "not_pending" };
    return { outcome: "ok", result };
  }

  /**
   * Whether a Keep of this session would raise billing, which the `closed`
   * gate refuses (3.3; review G5). A Keep only clears the wait, so it raises
   * billing only for a waiting copy that is Billable. A session with no local
   * record (one on another node, or none at all) counts as raising, as before.
   */
  keepRaisesBilling(sessionId: string, namespace: string): boolean {
    const record = this.deps.store.billableTracking.get(
      sessionId,
      namespace
    )?.record;
    if (!record || record.confirm !== "pending") return true;
    return record.billingStatus === "billable";
  }

  private write(
    sessionId: string,
    namespace: string,
    input: BillableSwitchWriteActor & { loggedMs: number | null },
    route: {
      action: OldRouteAction;
      reason: string;
      requireWaiting?: boolean;
    }
  ): BillableSwitchSetOutcome | "not-waiting" | "reconcile-pending" {
    // 3.4 step 6: a session the start-up reconcile could not settle is retried
    // before the write, and refused while it stays unsettled.
    if (!retryTrackingReconcileFor(this.deps.store, sessionId)) {
      return "reconcile-pending";
    }
    const now = this.now();
    const session = this.deps.getSession(sessionId);
    const timerMs = this.timerMsFor(session, now);
    const amount = unloggedAmount({ timerMs, loggedMs: input.loggedMs });
    const meta = session?.metadata as ProjectKeyMetadata | undefined;
    const projectKey = projectBaseKey(meta);
    const result = this.deps.store.billableSwitch.setByOldRoute(
      sessionId,
      namespace,
      {
        ...route,
        project: {
          kind: projectKeyKind(meta),
          key: projectKey,
          name: projectKey,
        },
        trackFrom: session?.createdAt ?? now,
        event: {
          actorKind: input.actor.kind,
          actorSessionId: input.actor.sessionId ?? null,
          actorUserAgent: input.actor.userAgent ?? null,
          via: input.via,
          entryNodeId: input.entryNodeId,
          projectKey: meta ? projectKey : null,
          keyKind: meta ? projectKeyKind(meta) : null,
          timerMs,
          unloggedMs: amount.ms,
          loggedKnown: amount.loggedKnown,
          label: this.labelFor(session),
          at: now,
        },
      }
    );
    if (!result.found) return { found: false };
    if ("notWaiting" in result) return "not-waiting";
    if (result.changed) this.deps.refreshSession(sessionId);
    return {
      found: true,
      changed: result.changed,
      billable: result.after.billable,
      billableConfirm: result.after.confirm,
      timerMs,
      unloggedMs: amount.ms,
      loggedKnown: amount.loggedKnown,
    };
  }

  // ─── other nodes' reports ────────────────────────────────────────────────

  /**
   * A node's header report (the registry's hook). Since #6778 PR-A (R12) it is
   * ignored: nothing is stored, so no report from an older node can steer a
   * start, and `false` (nothing changed) means the registry raises no push.
   */
  recordPeerReport(
    _nodeId: string,
    _nodeLabel: string | null,
    _headers: readonly BillableSwitchHeader[],
    _reportedAt: number
  ): boolean {
    return false;
  }

  /** A node left the mesh (an explicit eviction or a received tombstone). */
  onNodeRemoved(nodeId: string): void {
    this.deps.store.billableSwitch.deletePeerNode(nodeId);
    this.pushSkip.delete(nodeId);
  }

  /**
   * At start, on a node that has a registry only: drop every stored node that
   * is neither a configured static node nor a row of the peer store (removed
   * from the settings, or re-keyed). An instance without a registry keeps the
   * report rows it holds from before #6778 PR-A (since then a pushed report
   * stores nothing, and the start-up step deleted their header rows).
   */
  pruneOnStart(): string[] {
    const registry = this.deps.getRegistry();
    if (!registry) return [];
    return this.deps.store.billableSwitch.prunePeerNodes(
      registry.getBillableSwitchKeepNodeIds()
    );
  }

  /**
   * The receiving side of the push. Since #6778 PR-A (R12) nothing is stored:
   * the answer is `applied` so a pusher keeps its count of good pushes, and an
   * older pusher keeps pushing every five minutes, which is harmless (review
   * H12).
   */
  applyPushedReports(_body: BillableSwitchPushBody): {
    applied: true;
    nodes: 0;
  } {
    return { applied: true, nodes: 0 };
  }

  /**
   * Whether THIS node sends the push: the hub; in a mesh without a hub, the
   * peer with the lowest node id. A node with no registry never pushes.
   */
  isPusher(): boolean {
    const registry = this.deps.getRegistry();
    if (!registry) return false;
    const role = this.deps.getRole?.() ?? "node";
    if (role === "hub") return true;
    const views = registry.getBillableSwitchNodeViews();
    if (views.some(v => v.role === "hub")) return false;
    const localId = this.deps.getLocalNodeId();
    return views.every(v => localId < v.nodeId);
  }

  /**
   * Send every usable report (at most 7 days old; this node's own included,
   * the receiver's own left out) to each tracked node that advertises
   * billable:switch or billable:switch-closed. Since #6778 PR-A every report's
   * header list is empty (`crossNodeView`), so an older receiver replaces what
   * it kept with nothing. Best-effort: a node that answers `has-registry` (an
   * older one) is skipped from then on.
   */
  async pushPeerReports(): Promise<{
    sent: string[];
    skipped: string[];
    failed: string[];
  }> {
    const registry = this.deps.getRegistry();
    const sent: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    const mode = this.mode();
    if (!registry || (mode !== "on" && mode !== "closed") || !this.isPusher()) {
      return { sent, skipped, failed };
    }
    const now = this.now();
    const usable = this.crossNodeView().filter(
      e =>
        e.reportedAt !== null &&
        (e.isLocal || now - e.reportedAt <= BILLABLE_SWITCH_REPORT_MAX_AGE_MS)
    );
    for (const view of registry.getBillableSwitchNodeViews()) {
      if (!view.on && !view.closed) continue;
      if (this.pushSkip.has(view.nodeId)) {
        skipped.push(view.nodeId);
        continue;
      }
      const reports = usable
        .filter(e => e.nodeId !== view.nodeId)
        .map(e => ({
          nodeId: e.nodeId,
          nodeLabel: e.nodeLabel,
          reportedAt: e.reportedAt as number,
          headers: e.headers,
        }));
      const outcome = await registry.pushBillableSwitchPeerReports(
        view.nodeId,
        { reports }
      );
      if (outcome.kind !== "ok") {
        failed.push(view.nodeId);
        this.notePushFailure(view.nodeId, view.nodeLabel, outcome);
        continue;
      }
      this.notePushSuccess(view.nodeId, view.nodeLabel);
      const body = outcome.body as {
        applied?: unknown;
        reason?: unknown;
      } | null;
      if (body && body.applied === false && body.reason === "has-registry") {
        this.pushSkip.add(view.nodeId);
        skipped.push(view.nodeId);
      } else {
        sent.push(view.nodeId);
      }
    }
    return { sent, skipped, failed };
  }

  private notePushFailure(
    nodeId: string,
    nodeLabel: string,
    outcome: Exclude<PeerReadOutcome, { kind: "ok" }>
  ): void {
    const streak = (this.pushFailing.get(nodeId) ?? 0) + 1;
    this.pushFailing.set(nodeId, streak);
    if (streak !== 1) return;
    const why =
      outcome.kind === "unreachable"
        ? `${outcome.reason}${outcome.status ? ` (${outcome.status})` : ""}: ${outcome.message}`
        : outcome.kind;
    console.warn(
      `[BillableSwitch] Header report push to ${nodeLabel} (${nodeId}) failed: ${why}. Its copy of the other nodes' headers ages out after 7 days unless a push lands; logged again when it recovers.`
    );
  }

  private notePushSuccess(nodeId: string, nodeLabel: string): void {
    const streak = this.pushFailing.get(nodeId);
    if (streak === undefined) return;
    this.pushFailing.delete(nodeId);
    console.warn(
      `[BillableSwitch] Header report push to ${nodeLabel} (${nodeId}) works again after ${streak} failed push${streak === 1 ? "" : "es"}.`
    );
  }

  /** The registry raised "a report changed this round": push now (one at a time). */
  onReportsChanged(): void {
    void this.pushOnce();
  }

  private pushOnce(): Promise<void> {
    if (this.pushInFlight) return this.pushInFlight;
    this.pushInFlight = this.pushPeerReports()
      .then(() => undefined)
      .catch(err => {
        console.warn(
          "[BillableSwitch] Header report push failed:",
          err instanceof Error ? err.message : err
        );
      })
      .finally(() => {
        this.pushInFlight = null;
      });
    return this.pushInFlight;
  }

  /** Start the two timers: the 5-minute push repeat and the queue sweep. */
  start(): void {
    const schedulePush = () => {
      this.pushTimer = setTimeout(() => {
        void this.pushOnce().finally(schedulePush);
      }, PUSH_INTERVAL_MS);
      this.pushTimer.unref?.();
    };
    const scheduleSweep = () => {
      this.sweepTimer = setTimeout(() => {
        try {
          this.deps.sweepPendingByTag?.();
        } finally {
          scheduleSweep();
        }
      }, SWEEP_INTERVAL_MS);
      this.sweepTimer.unref?.();
    };
    if (!this.pushTimer) schedulePush();
    if (!this.sweepTimer) scheduleSweep();
  }

  stop(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.pushTimer = null;
    this.sweepTimer = null;
  }

  // ─── history and the across-node list ────────────────────────────────────

  /** Section 6 item 4: the response carries no user agent, project key, label or path. */
  static toHistoryEvent(e: BillableSwitchEvent): BillableSwitchHistoryEvent {
    const causeNodes = e.kind === "start" ? historyCauseNodes(e.label) : [];
    return {
      id: e.id,
      at: e.at,
      kind: e.kind,
      reason: e.reason,
      billableBefore: e.billableBefore,
      billableAfter: e.billableAfter,
      confirmBefore: e.confirmBefore,
      confirmAfter: e.confirmAfter,
      ...(e.startKind ? { startKind: e.startKind } : {}),
      actor: {
        kind: e.actor.kind,
        ...(e.actor.sessionId ? { sessionId: e.actor.sessionId } : {}),
      },
      via: e.via,
      entryNodeId: e.entryNodeId,
      timerMs: e.timerMs,
      unloggedMs: e.unloggedMs,
      loggedKnown: e.loggedKnown,
      ...(causeNodes.length > 0 ? { causeNodes } : {}),
    };
  }

  /**
   * History steps 1 and 2 (the route owns step 3, the owning node): a live local
   * row in the caller's namespace, or local event rows of a deleted session in
   * that namespace. Null when neither. The seven old kinds only (#6778 PR-B,
   * 6.3), because an older hub parses this answer with a strict kind enum:
   * a `tracking` row is read through the tracking history route (PR-C).
   */
  localHistory(
    sessionId: string,
    namespace: string
  ): BillableSwitchHistory | null {
    const live = this.deps.store.sessions.getSessionByNamespace(
      sessionId,
      namespace
    );
    const events = this.deps.store.billableSwitch.listEvents(
      sessionId,
      namespace,
      { legacyOnly: true }
    );
    if (!live && events.length === 0) return null;
    return {
      sessionId,
      source: "local",
      originNodeId: this.deps.getLocalNodeId(),
      mirrorSyncedAt: null,
      events: events.map(BillableSwitchService.toHistoryEvent),
    };
  }

  /**
   * History step 4: the hub's copy of another node's events, in the caller's
   * namespace, the seven old kinds only (#6778 PR-B, as `localHistory`).
   */
  mirrorHistory(
    sessionId: string,
    namespace: string
  ): BillableSwitchHistory | null {
    const rows: BillableSwitchMirrorEvent[] =
      this.deps.store.billableSwitch.listMirrorEvents(sessionId, namespace, {
        legacyOnly: true,
      });
    if (rows.length === 0) return null;
    const origin = rows[rows.length - 1].originNodeId;
    return {
      sessionId,
      source: "mirror",
      originNodeId: origin,
      mirrorSyncedAt:
        this.deps.store.billableSwitch.getMirrorCursor(origin)?.lastSyncAt ??
        null,
      events: rows.map(BillableSwitchService.toHistoryEvent),
    };
  }

  /**
   * `GET /api/billable-switch/headers?history=1`: the header changes of this node
   * and of every node whose record this node holds, each with its origin.
   */
  headerHistory(
    namespace: string
  ): Array<{ originNodeId: string; event: BillableSwitchEvent }> {
    const store = this.deps.store.billableSwitch;
    const localId = this.deps.getLocalNodeId();
    return [
      ...store
        .listHeaderEvents(namespace)
        .map(event => ({ originNodeId: localId, event })),
      ...store
        .listMirrorHeaderEvents(namespace)
        .map(event => ({ originNodeId: event.originNodeId, event })),
    ];
  }

  /**
   * `GET /api/billable-switch/events`: the namespace's events after two cursors,
   * this node's own (by id) and its copy of other nodes' (by arrival).
   */
  eventsSince(
    namespace: string,
    after: { local: number; mirror: number },
    kinds: readonly string[]
  ): {
    local: BillableSwitchEvent[];
    mirror: BillableSwitchMirrorEvent[];
  } {
    const store = this.deps.store.billableSwitch;
    return {
      local: store.listEventsSince(namespace, after.local, { kinds }),
      mirror: store.listMirrorEventsSince(namespace, after.mirror, { kinds }),
    };
  }

  /** This node's switched-on sessions of a namespace (the authoritative list, section 6 item 5). */
  listLocalBillable(
    namespace: string
  ): Array<BillableSwitchListedSession & { namespace: string }> {
    return this.deps.store.billableSwitch
      .listBillableSessions(namespace)
      .map(s => ({ ...s, namespace }));
  }

  /**
   * The authoritative list across nodes for a billing reader: the local store for
   * this node's sessions, the federation route for every other node. A node that
   * cannot be reached is reported as such; nothing is billed from a cached copy.
   */
  async listBillableAcrossNodes(
    namespace: string
  ): Promise<{ nodes: BillableSwitchNodeListing[] }> {
    const nodes: BillableSwitchNodeListing[] = [
      {
        nodeId: this.deps.getLocalNodeId(),
        state: "ok",
        mode: this.mode(),
        sessions: this.listLocalBillable(namespace),
      },
    ];
    const registry = this.deps.getRegistry();
    if (!registry) return { nodes };
    for (const view of registry.getBillableSwitchNodeViews()) {
      if (view.nodeId === this.deps.getLocalNodeId()) continue;
      if (
        !view.on &&
        !view.closed &&
        view.status === "online" &&
        !view.awaitingInitialPoll
      ) {
        nodes.push({ nodeId: view.nodeId, state: "unsupported" });
        continue;
      }
      const outcome = await registry.callBillableSwitchPeerRoute(
        view.nodeId,
        "/api/federation/billable-switch/sessions",
        {},
        { namespace }
      );
      if (outcome.kind === "unsupported") {
        nodes.push({ nodeId: view.nodeId, state: "unsupported" });
        continue;
      }
      if (outcome.kind !== "ok") {
        nodes.push({ nodeId: view.nodeId, state: "unreachable" });
        continue;
      }
      const parsed = BillableSwitchSessionListResponseSchema.safeParse(
        outcome.body
      );
      nodes.push(
        parsed.success
          ? {
              nodeId: view.nodeId,
              state: "ok",
              mode: parsed.data.mode,
              sessions: parsed.data.sessions,
            }
          : { nodeId: view.nodeId, state: "unreachable" }
      );
    }
    return { nodes };
  }
}
