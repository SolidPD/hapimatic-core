// SPDX-License-Identifier: AGPL-3.0-only
import {
  laneSessionRefs,
  parseDashboardLanes,
  stageFromLabels,
  stagesReached,
  toSessionSummary,
  type Pin,
  type PinDashboard,
  type PinDashboardSessionFacts,
  type PinDashboardsNodeResult,
  type PinLane,
  type SessionSummary,
  type SessionTokenTotals,
  type SessionWorkflowBadge,
} from "@hapi/protocol";

import type { PinLiveRef } from "../store/pinStore";
import type { Session, SyncEngine } from "./syncEngine";

// The Project Manager dashboards this node holds (issue #6454, epic #6446): each
// live dashboard pin in the caller's namespace, with the server's facts for the
// sessions its lanes name. The PM publishes intent (lanes, tasks, queues); every
// fact here (name, model, account, status, open pins, stage, cost) comes from
// the session's own record, so a stale or wrong dashboard cannot misreport them.
//
// Namespace-scoped lookups only: a dashboard is kept, and a lane ref resolved,
// only through `getSessionByNamespace` / `getSessionByTagAndNamespace`, because
// `getSession` would hand another namespace's session facts to this caller.

/** What the join needs of the engine and the pin service. */
export type PinDashboardDeps = {
  listLiveDashboardRefs(): PinLiveRef[];
  getDashboard(sessionId: string, key: string): Pin | null;
  getSessionByNamespace(
    sessionId: string,
    namespace: string
  ): Session | undefined;
  getSessionByTagAndNamespace(
    tag: string,
    namespace: string
  ): Session | undefined;
  getSessionWorkflowBadge(sessionId: string): SessionWorkflowBadge | null;
  countOpenBySession(): Map<string, number>;
  getSessionTotals(sessionId: string): SessionTokenTotals | null;
  localNode: { nodeId: string; nodeLabel?: string } | null;
};

/** What the join reads of a node's engine. */
export type PinDashboardEngine = Pick<
  SyncEngine,
  | "pins"
  | "getSessionByNamespace"
  | "getSessionByTagAndNamespace"
  | "getSessionWorkflowBadge"
  | "getSessionTotals"
>;

/** The join's deps over a node's engine. */
export function engineDashboardDeps(
  engine: PinDashboardEngine,
  localNode: PinDashboardDeps["localNode"]
): PinDashboardDeps {
  return {
    listLiveDashboardRefs: () => engine.pins.listLiveDashboardRefs(),
    getDashboard: (sessionId, key) => engine.pins.getDashboard(sessionId, key),
    getSessionByNamespace: (sessionId, namespace) =>
      engine.getSessionByNamespace(sessionId, namespace),
    getSessionByTagAndNamespace: (tag, namespace) =>
      engine.getSessionByTagAndNamespace(tag, namespace),
    getSessionWorkflowBadge: sessionId =>
      engine.getSessionWorkflowBadge(sessionId),
    countOpenBySession: () => engine.pins.countOpenBySession(),
    getSessionTotals: sessionId => engine.getSessionTotals(sessionId),
    localNode,
  };
}

type ParsedLanes = { lanes: PinLane[]; degraded: boolean };

const LANE_CACHE_MAX = 256;

/**
 * Parsed lanes by `sessionId:key:revision`. A dashboard row stays live until it
 * is withdrawn or dismissed, or its session is deleted, and is read on every
 * poll, so a re-read at the same revision reuses its parse. Bounded; the oldest
 * entry goes first.
 */
export class DashboardLaneCache {
  private readonly entries = new Map<string, ParsedLanes>();
  /** How many times a dashboard's lanes were parsed, for the tests. */
  parses = 0;

  constructor(private readonly max = LANE_CACHE_MAX) {}

  get(ref: PinLiveRef, pin: Pin): ParsedLanes {
    const id = `${ref.sessionId}:${ref.key}:${pin.revision}`;
    const hit = this.entries.get(id);
    if (hit) return hit;
    this.parses += 1;
    const parsed = parseDashboardLanes(pin.lanes);
    this.entries.set(id, parsed);
    if (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return parsed;
  }
}

const defaultLaneCache = new DashboardLaneCache();

function sumTokens(totals: SessionTokenTotals): number | null {
  const parts = [
    totals.totalTokIn,
    totals.totalTokOut,
    totals.totalTokCacheRead,
    totals.totalTokCacheWrite,
  ];
  if (parts.every(part => part === null)) return null;
  return parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
}

/**
 * A session's facts from its list projection, for this node's own sessions and
 * for a peer's as the hub's poll holds them. `totals` only from the node that
 * owns the session's turns; the hub's poll carries none.
 */
export function sessionFacts(
  summary: SessionSummary,
  node: { nodeId?: string | null; nodeLabel?: string | null } | null,
  totals: SessionTokenTotals | null
): PinDashboardSessionFacts {
  const linked = summary.linkedIssue;
  const badge = summary.workflowBadge ?? null;
  const stage = badge ? stageFromLabels(badge.activeLabels) : null;
  return {
    id: summary.id,
    tag: summary.tag,
    name: summary.metadata?.name ?? null,
    emoji: summary.emoji ?? null,
    active: summary.active,
    thinking: summary.thinking,
    model: summary.resolvedModel ?? summary.modelMode ?? null,
    accountEmail: summary.metadata?.claudeAccount?.email ?? null,
    nodeId: node?.nodeId ?? null,
    nodeLabel: node?.nodeLabel ?? null,
    linkedIssue: linked
      ? {
          number: linked.number,
          title: linked.title,
          repo: linked.repo,
          ...(linked.state ? { state: linked.state } : {}),
        }
      : null,
    // The badge is the linked issue's, so the repo comes from the link.
    badge:
      badge && stage
        ? {
            repo: linked?.repo ?? null,
            number: badge.issueNumber,
            done: stage.done,
            active: stage.active,
            reached: stagesReached(badge.activeLabels),
          }
        : null,
    // Absent when the owning node cannot serve pins: unknown, not zero.
    ...(summary.openPinCount !== undefined
      ? { openPinCount: summary.openPinCount }
      : {}),
    createdAt: summary.createdAt,
    activeAt: summary.activeAt,
    parentSessionId: summary.parentSessionId ?? null,
    parentRelationship: summary.parentRelationship ?? null,
    totals: totals
      ? { cost: totals.totalCost, tokens: sumTokens(totals) }
      : null,
  };
}

/** Resolves a session id or tag on this node, within one namespace. */
export type LocalSessionResolver = {
  /** The session a ref names here, with its facts; null when this node has none. */
  resolve(ref: string): PinDashboardSessionFacts | null;
};

/**
 * One request's namespace-scoped resolver: open counts read once, each
 * session's facts built once.
 */
export function localSessionResolver(
  deps: PinDashboardDeps,
  namespace: string
): LocalSessionResolver & {
  /** The session a ref names here, without building its facts. */
  find(ref: string): Session | undefined;
  /** A session's open pins, from one read per request. */
  openCount(sessionId: string): number;
  factsOf(session: Session): PinDashboardSessionFacts;
} {
  let openCounts: Map<string, number> | null = null;
  const openCount = (sessionId: string): number => {
    openCounts ??= deps.countOpenBySession();
    return openCounts.get(sessionId) ?? 0;
  };
  const find = (ref: string): Session | undefined =>
    deps.getSessionByNamespace(ref, namespace) ??
    deps.getSessionByTagAndNamespace(ref, namespace);
  const facts = new Map<string, PinDashboardSessionFacts>();
  const factsOf = (session: Session): PinDashboardSessionFacts => {
    let known = facts.get(session.id);
    if (!known) {
      const badge = deps.getSessionWorkflowBadge(session.id);
      // The session list's own projection, so a name or model reads the same here.
      const summary = toSessionSummary(
        session,
        undefined,
        undefined,
        badge,
        openCount(session.id)
      );
      known = sessionFacts(
        summary,
        deps.localNode,
        deps.getSessionTotals(session.id)
      );
      facts.set(session.id, known);
    }
    return known;
  };
  return {
    find,
    openCount,
    factsOf,
    resolve: ref => {
      const session = find(ref);
      return session ? factsOf(session) : null;
    },
  };
}

/** Whether a lane keeps a stopped Project Manager listed (ruling D5). */
export function laneHoldsDashboard(facts: PinDashboardSessionFacts): boolean {
  return facts.active === true || (facts.openPinCount ?? 0) > 0;
}

/**
 * Every dashboard in `namespace` on this node, newest first, and the facts for
 * each session they name that this node holds. A ref this node cannot resolve
 * (a lane session on another node) goes in that dashboard's `unresolved`, for the
 * hub to fill. A dashboard whose row cannot be read is skipped, not fatal.
 *
 * A Project Manager that is not running is kept only while one of its lanes is
 * running or has an open pin (ruling D5), or while a lane is on another node,
 * where the hub decides.
 */
export function listLocalDashboards(
  deps: PinDashboardDeps,
  namespace: string,
  cache: DashboardLaneCache = defaultLaneCache
): PinDashboardsNodeResult {
  const kept = deps.listLiveDashboardRefs().flatMap(ref => {
    const owner = deps.getSessionByNamespace(ref.sessionId, namespace);
    return owner ? [{ ref, owner }] : [];
  });
  if (kept.length === 0) return { dashboards: [], sessions: {} };

  const local = localSessionResolver(deps, namespace);
  const facts = new Map<string, PinDashboardSessionFacts>();

  const dashboards: PinDashboard[] = [];
  for (const { ref, owner } of kept) {
    let pin: Pin | null;
    try {
      pin = deps.getDashboard(ref.sessionId, ref.key);
    } catch {
      // A row this build cannot read drops its own dashboard, not the list.
      continue;
    }
    if (!pin || pin.kind !== "dashboard") continue;

    const { lanes } = cache.get(ref, pin);
    const refs: Record<string, string> = {};
    const unresolved: string[] = [];
    const laneSessions: Session[] = [];
    for (const laneRef of laneSessionRefs(lanes)) {
      const lane = local.find(laneRef);
      if (lane) {
        refs[laneRef] = lane.id;
        laneSessions.push(lane);
      } else {
        unresolved.push(laneRef);
      }
    }

    // Ruling D5 from the in-memory state first, so a stopped PM's lanes never
    // cost a badge or a totals read (a totals read scans a whole view).
    const listed =
      owner.active === true ||
      unresolved.length > 0 ||
      laneSessions.some(
        lane => lane.active === true || local.openCount(lane.id) > 0
      );
    if (!listed) continue;
    for (const session of [owner, ...laneSessions]) {
      facts.set(session.id, local.factsOf(session));
    }

    dashboards.push({
      pin,
      sessionId: owner.id,
      nodeId: deps.localNode?.nodeId ?? null,
      nodeLabel: deps.localNode?.nodeLabel ?? null,
      refs,
      unresolved,
    });
  }

  // Facts for the sessions the listed dashboards name, and no others.
  const sessions: Record<string, PinDashboardSessionFacts> = {};
  for (const dashboard of dashboards) {
    for (const id of [dashboard.sessionId, ...Object.values(dashboard.refs)]) {
      const known = facts.get(id);
      if (known) sessions[id] = known;
    }
  }
  return { dashboards, sessions };
}

/**
 * The hub's merge of every node's answer (local first): dashboards concatenated
 * (a pin lives on one node), facts keyed by session id. Each still-unresolved
 * lane ref is then filled from this node's own sessions (namespace-scoped, with
 * totals), else from the hub's projected view of its peers' sessions, which
 * shows an offline node's sessions as not running and carries no totals. A ref
 * is never filled from the dashboard's own node: that node already answered for
 * its sessions, within the namespace.
 *
 * Ruling D5 is applied again over the joined facts. A stopped PM with a ref
 * nobody resolved stays listed only while the answer is partial, because the
 * lane may be on the node that did not answer.
 */
export function mergeDashboards(input: {
  results: readonly PinDashboardsNodeResult[];
  local: LocalSessionResolver;
  remoteSessions: readonly SessionSummary[];
  partial: boolean;
}): PinDashboardsNodeResult {
  const sessions: Record<string, PinDashboardSessionFacts> = {};
  const dashboards: PinDashboard[] = [];
  for (const result of input.results) {
    for (const facts of Object.values(result.sessions)) {
      sessions[facts.id] ??= facts;
    }
    for (const dashboard of result.dashboards) {
      dashboards.push({
        ...dashboard,
        refs: { ...dashboard.refs },
        unresolved: [...dashboard.unresolved],
      });
    }
  }

  const byId = new Map<string, SessionSummary>();
  const byTag = new Map<string, SessionSummary>();
  for (const summary of input.remoteSessions) {
    if (!byId.has(summary.id)) byId.set(summary.id, summary);
    if (summary.tag && !byTag.has(summary.tag)) byTag.set(summary.tag, summary);
  }
  const remote = (
    ref: string,
    skipNodeId: string | null | undefined
  ): PinDashboardSessionFacts | null => {
    const summary = byId.get(ref) ?? byTag.get(ref);
    if (!summary || (skipNodeId && summary.nodeId === skipNodeId)) return null;
    return sessionFacts(
      summary,
      { nodeId: summary.nodeId ?? null, nodeLabel: summary.nodeLabel ?? null },
      null
    );
  };

  for (const dashboard of dashboards) {
    if (dashboard.unresolved.length === 0) continue;
    const still: string[] = [];
    for (const ref of dashboard.unresolved) {
      const facts = input.local.resolve(ref) ?? remote(ref, dashboard.nodeId);
      if (facts) {
        dashboard.refs[ref] = facts.id;
        sessions[facts.id] ??= facts;
      } else {
        still.push(ref);
      }
    }
    dashboard.unresolved = still;
  }

  const kept = dashboards.filter(dashboard => {
    if (sessions[dashboard.sessionId]?.active === true) return true;
    const lanes = Object.values(dashboard.refs).flatMap(id =>
      sessions[id] ? [sessions[id]] : []
    );
    if (lanes.some(laneHoldsDashboard)) return true;
    return input.partial && dashboard.unresolved.length > 0;
  });
  // A peer's malformed timestamp sorts last instead of poisoning the order.
  const at = (dashboard: PinDashboard): number => {
    const ms = Date.parse(dashboard.pin.updatedAt);
    return Number.isFinite(ms) ? ms : 0;
  };
  kept.sort((a, b) => at(b) - at(a));

  const named: Record<string, PinDashboardSessionFacts> = {};
  for (const dashboard of kept) {
    for (const id of [dashboard.sessionId, ...Object.values(dashboard.refs)]) {
      const facts = sessions[id];
      if (facts) named[id] = facts;
    }
  }
  return { dashboards: kept, sessions: named };
}
