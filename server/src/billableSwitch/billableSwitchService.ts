// SPDX-License-Identifier: AGPL-3.0-only
import {
  BILLABLE_SWITCH_REPORT_MAX_AGE_MS,
  BillableConfirmSchema,
  crossNodeBillable,
  crossNodeMatchKey,
  projectBaseKey,
  projectKeyKind,
  resolveBillableSwitchStart,
  unloggedAmount,
  type BillableConfirm,
  type BillableSwitchActor,
  type BillableSwitchEvent,
  type BillableSwitchHeader,
  type BillableSwitchKeyKind,
  type BillableSwitchMode,
  type BillableSwitchNodeView,
  type BillableSwitchStartContext,
  type BillableSwitchVia,
  type BillableSwitchWriteReason,
  type ProjectKeyMetadata,
  type Session,
} from "@hapi/protocol";
import { z } from "zod";
import type { Store } from "../store";
import type {
  BillableSwitchApplyHeaderResult,
  BillableSwitchListedSession,
  BillableSwitchMirrorEvent,
  BillableSwitchSessionEventFields,
} from "../store/billableSwitchStore";
import type { BillableSwitchInitial } from "../store/sessions";
import type {
  BillableSwitchNodeRegistryView,
  NodeRegistry,
} from "../federation/nodeRegistry";

// The billable switch's service (issue #6646, Task 5): the one place that decides
// a new session's start value, writes a switch, a confirm and a header, keeps
// other nodes' header reports, answers the history and the across-node list,
// and sends the reports to a node that has no view of the mesh.

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
  | { found: false }
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
};

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

/** Thrown inside a confirm's transaction when the session is no longer waiting. */
class NotPendingError extends Error {}

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
   * THE one definition of the join: this node's own table as the local entry;
   * one entry per node with a stored report; one entry with no report (unknown)
   * for every node the registry tracks that never reported; each joined with the
   * registry's label, status and flags when it tracks the node, else shown from
   * its stored label as `not-tracked` (a peer evicted automatically can re-join).
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
        headers: this.deps.store.billableSwitch.listHeaders(),
        status: "local",
        on: mode === "on",
        closed: mode === "closed",
        store: this.deps.store.billableSwitchStorageReady,
        awaitingInitialPoll: false,
      },
    ];
    const seen = new Set<string>([localId]);
    const unreported = new Map<string, BillableSwitchHeader[]>();
    for (const {
      nodeId,
      header,
    } of this.deps.store.billableSwitch.listUnreportedPeerHeaders()) {
      unreported.set(nodeId, [...(unreported.get(nodeId) ?? []), header]);
    }
    const remote = (
      nodeId: string,
      label: string | null,
      reportedAt: number | null,
      headers: BillableSwitchHeader[]
    ): BillableSwitchCrossNodeEntry => {
      const view = registryViews.get(nodeId);
      return {
        nodeId,
        nodeLabel: view?.nodeLabel ?? label ?? nodeId,
        isLocal: false,
        reportedAt,
        headers,
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
      entries.push(
        remote(
          report.nodeId,
          report.nodeLabel,
          report.reportedAt,
          report.headers
        )
      );
    }
    for (const view of registryViews.values()) {
      if (seen.has(view.nodeId)) continue;
      seen.add(view.nodeId);
      entries.push(
        remote(
          view.nodeId,
          view.nodeLabel,
          null,
          unreported.get(view.nodeId) ?? []
        )
      );
    }
    for (const [nodeId, headers] of unreported) {
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      entries.push(remote(nodeId, null, null, headers));
    }
    return entries;
  }

  // ─── the start value of a new row ─────────────────────────────────────────

  /**
   * The start value of a session row about to be inserted (the start hook).
   * Null when the gate is not `on` (row 1: no event). `context` is the queued
   * start context, or null for a registration that had nothing queued (a
   * terminal start, the daemon's local spawn, a context lost to a hub restart
   * or to the sweep): that start is `unattended`, and its label says
   * `context: "none"` with the reported `startedBy`. No start value ever
   * branches on `startedBy`, which is whatever the registering process sent.
   */
  resolveStartForInsert(input: {
    tag: string;
    metadata: unknown;
    namespace: string;
    context: BillableSwitchStartContext | null;
  }): BillableSwitchInitial | null {
    const mode = this.mode();
    if (mode !== "on") return null;
    const now = this.now();
    const meta = (input.metadata ?? {}) as ProjectKeyMetadata & {
      name?: unknown;
      path?: unknown;
      startedBy?: unknown;
    };
    const context = input.context;
    const kind = context?.kind ?? "unattended";
    const projectKey = projectBaseKey(meta);
    const keyKind: BillableSwitchKeyKind = projectKeyKind(meta);

    const parent =
      kind === "inherit" && context?.fromSessionId
        ? this.deps.store.billableSwitch.getSwitch(context.fromSessionId)
        : null;
    const headerRow = this.deps.store.billableSwitch.getHeader(
      input.namespace,
      projectKey
    );
    const header =
      headerRow === null ? "unset" : headerRow.billable ? "on" : "off";
    const crossNode = crossNodeBillable(
      this.crossNodeView(),
      crossNodeMatchKey(projectKey, keyKind),
      input.namespace,
      this.deps.getLocalNodeId(),
      { now, maxAgeMs: BILLABLE_SWITCH_REPORT_MAX_AGE_MS }
    );
    const result = resolveBillableSwitchStart({
      mode,
      context: { kind, choice: context?.choice },
      parent,
      header,
      crossNode,
    });
    if (result.reason === null) return null;

    const label: Record<string, unknown> = {
      name: typeof meta.name === "string" ? meta.name : null,
      projectKey,
      path: typeof meta.path === "string" ? meta.path : null,
    };
    if (!context) {
      label.context = "none";
      label.startedBy =
        typeof meta.startedBy === "string" ? meta.startedBy : null;
    }
    if (result.reason === "inherit" && context?.fromSessionId) {
      label.parentSessionId = context.fromSessionId;
    }
    if (kind === "schedule" && context?.scheduleId)
      label.scheduleId = context.scheduleId;
    if (result.causeNodes) label.causeNodes = result.causeNodes;

    const actorFields = {
      actorKind: context?.actor?.kind ?? ("system" as const),
      actorSessionId: context?.actor?.sessionId ?? null,
      actorUserAgent: context?.actor?.userAgent ?? null,
      via: context?.actor
        ? (context.via ?? ("direct" as const))
        : ("internal" as const),
      entryNodeId: context?.entryNodeId ?? this.deps.getLocalNodeId(),
    };
    return {
      billable: result.billable,
      confirm: result.confirm,
      event: {
        ...actorFields,
        namespace: input.namespace,
        projectKey,
        keyKind,
        kind: "start",
        reason: result.reason,
        startKind: kind,
        billableBefore: null,
        billableAfter: result.billable,
        confirmBefore: null,
        confirmAfter: result.confirm,
        timerMs: 0,
        unloggedMs: 0,
        loggedKnown: false,
        label,
        at: now,
      },
      ...(result.headerOn
        ? {
            header: {
              projectKey,
              keyKind,
              event: {
                ...actorFields,
                namespace: input.namespace,
                projectKey,
                keyKind,
                kind: "header-on" as const,
                reason: "create-choice",
                label: { projectKey, keyKind, picks: 0 },
                at: now,
              },
            },
          }
        : {}),
    };
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
    return this.write(
      sessionId,
      namespace,
      { billable: input.billable, confirm: null },
      input,
      before => {
        if (input.billable) {
          return {
            kind: before.confirm === "pending" ? "keep" : "on",
            reason: input.reason,
          };
        }
        return {
          kind: before.confirm === "pending" ? "reverse" : "off",
          reason: input.reason,
        };
      }
    );
  }

  /**
   * Decide a waiting session: `keep` clears the confirm state (still billable),
   * `reverse` switches it off. Not waiting → `not_pending`.
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
    try {
      const result = this.write(
        sessionId,
        namespace,
        input.decision === "keep"
          ? { billable: true, confirm: null }
          : { billable: false, confirm: null },
        input,
        before => {
          if (before.confirm !== "pending") throw new NotPendingError();
          return {
            kind: input.decision === "keep" ? "keep" : "reverse",
            reason,
          };
        }
      );
      if (!result.found) return { outcome: "not_found" };
      if (!result.changed) return { outcome: "not_pending" };
      return { outcome: "ok", result };
    } catch (err) {
      if (err instanceof NotPendingError) return { outcome: "not_pending" };
      throw err;
    }
  }

  private write(
    sessionId: string,
    namespace: string,
    next: { billable: boolean; confirm: BillableConfirm },
    input: BillableSwitchWriteActor & { loggedMs: number | null },
    decide: (before: { billable: boolean; confirm: BillableConfirm }) => {
      kind: BillableSwitchSessionEventFields["kind"];
      reason: string;
    }
  ): BillableSwitchSetOutcome {
    const now = this.now();
    const session = this.deps.getSession(sessionId);
    const timerMs = this.timerMsFor(session, now);
    const amount = unloggedAmount({ timerMs, loggedMs: input.loggedMs });
    const meta = session?.metadata as ProjectKeyMetadata | undefined;
    const result = this.deps.store.billableSwitch.setSwitch(
      sessionId,
      namespace,
      next,
      before => ({
        ...decide(before),
        actorKind: input.actor.kind,
        actorSessionId: input.actor.sessionId ?? null,
        actorUserAgent: input.actor.userAgent ?? null,
        via: input.via,
        entryNodeId: input.entryNodeId,
        projectKey: meta ? projectBaseKey(meta) : null,
        keyKind: meta ? projectKeyKind(meta) : null,
        timerMs,
        unloggedMs: amount.ms,
        loggedKnown: amount.loggedKnown,
        label: this.labelFor(session),
        at: now,
      })
    );
    if (!result.found) return { found: false };
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

  /**
   * Set THIS node's header for a project and switch the picked sessions on, in
   * one transaction (R12). Each pick's timer is read from the record here; its
   * logged minutes come as given (the entry hub's provider, null today).
   */
  applyHeader(
    input: BillableSwitchWriteActor & {
      namespace: string;
      projectKey: string;
      keyKind: BillableSwitchKeyKind;
      billable: boolean;
      picks: ReadonlyArray<{ sessionId: string; loggedMs: number | null }>;
    }
  ): BillableSwitchApplyHeaderResult {
    const now = this.now();
    const result = this.deps.store.billableSwitch.applyHeader({
      namespace: input.namespace,
      projectKey: input.projectKey,
      keyKind: input.keyKind,
      billable: input.billable,
      picks: input.picks.map(p => ({
        sessionId: p.sessionId,
        timerMs: this.timerMsFor(this.deps.getSession(p.sessionId), now),
        loggedMs: p.loggedMs,
      })),
      actor: input.actor,
      via: input.via,
      entryNodeId: input.entryNodeId,
      now,
    });
    for (const id of result.changedSessionIds) this.deps.refreshSession(id);
    return result;
  }

  // ─── other nodes' reports ────────────────────────────────────────────────

  /** A node's header report (the registry's hook). Returns whether the stored report changed. */
  recordPeerReport(
    nodeId: string,
    nodeLabel: string | null,
    headers: readonly BillableSwitchHeader[],
    reportedAt: number
  ): boolean {
    if (nodeId === this.deps.getLocalNodeId()) return false;
    return this.deps.store.billableSwitch.replacePeerReport(
      nodeId,
      nodeLabel,
      headers,
      reportedAt
    ).changed;
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
   * reports it was sent or seeded.
   */
  pruneOnStart(): string[] {
    const registry = this.deps.getRegistry();
    if (!registry) return [];
    return this.deps.store.billableSwitch.prunePeerNodes(
      registry.getBillableSwitchKeepNodeIds()
    );
  }

  /**
   * A registry-less node's side of the push: apply each report with its own
   * report time and prune the nodes the push no longer names. A node with a
   * registry refuses (its own polls are the truth).
   */
  applyPushedReports(
    body: BillableSwitchPushBody
  ):
    | { applied: true; nodes: number }
    | { applied: false; reason: "has-registry" } {
    if (this.deps.getRegistry())
      return { applied: false, reason: "has-registry" };
    const localId = this.deps.getLocalNodeId();
    const named: string[] = [];
    for (const report of body.reports) {
      if (report.nodeId === localId) continue;
      named.push(report.nodeId);
      this.deps.store.billableSwitch.replacePeerReport(
        report.nodeId,
        report.nodeLabel,
        report.headers,
        report.reportedAt
      );
    }
    this.deps.store.billableSwitch.prunePeerNodes(named);
    return { applied: true, nodes: named.length };
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
   * Send every usable report (at most 7 days old; this node's own headers
   * included, the receiver's own left out) to each tracked node that
   * advertises billable:switch or billable:switch-closed. Best-effort: a node
   * that answers `has-registry` is skipped from then on.
   */
  async pushPeerReports(): Promise<{ sent: string[]; skipped: string[] }> {
    const registry = this.deps.getRegistry();
    const sent: string[] = [];
    const skipped: string[] = [];
    const mode = this.mode();
    if (!registry || (mode !== "on" && mode !== "closed") || !this.isPusher()) {
      return { sent, skipped };
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
      if (outcome.kind !== "ok") continue;
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
    return { sent, skipped };
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
    };
  }

  /**
   * History steps 1 and 2 (the route owns step 3, the owning node): a live local
   * row in the caller's namespace, or local event rows of a deleted session in
   * that namespace. Null when neither.
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
      namespace
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

  /** History step 4: the hub's copy of another node's events, in the caller's namespace. */
  mirrorHistory(
    sessionId: string,
    namespace: string
  ): BillableSwitchHistory | null {
    const rows: BillableSwitchMirrorEvent[] =
      this.deps.store.billableSwitch.listMirrorEvents(sessionId, namespace);
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

  /**
   * After a header write proxied to another node succeeded: keep that one header
   * row as the node now has it, so this node's view sees the change at once (the
   * caller also advances the node's report counter, so an older poll skips).
   */
  recordRemoteHeader(nodeId: string, header: BillableSwitchHeader): void {
    if (nodeId === this.deps.getLocalNodeId()) return;
    this.deps.store.billableSwitch.upsertPeerHeader(nodeId, header);
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
