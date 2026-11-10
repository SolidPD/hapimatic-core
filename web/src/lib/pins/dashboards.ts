// SPDX-License-Identifier: AGPL-3.0-only
import {
  formatModelName,
  laterStage,
  MODEL_MODE_LABELS,
  parseDashboardLanes,
  PIN_LANE_STAGE_EMOJI,
  PIN_LANE_STAGES,
  stageOrder,
  type PinDashboard,
  type PinDashboardSessionFacts,
  type PinDashboardsResponse,
  type PinLaneIssue,
  type PinLane,
  type PinLaneSession,
  type PinLaneStage,
} from "@hapi/protocol";
import { tokens } from "@/design/tokens";
import { formatDurationShort } from "@/utils/easternTime";

/**
 * #6454: the Project Managers section's pure view model. React-free, like
 * `ledger.ts`. The dashboard pin carries the PM's intent (lanes, tasks,
 * queues); the server's facts for each session win wherever they exist (name,
 * model, account, node, running, linked issue, open pins, cost). The stage is
 * the later of the PM's and the session's labels, for the same issue.
 * Design of record: `docs/design/pins/pins-mockup-v6.html` (`?b=b3&l=l5`).
 */

/** The session whose Pins tab is open, for "Manages this session". */
export type CurrentSession = {
  id: string;
  parentSessionId?: string | null;
  parentRelationship?: string | null;
};

/** A session's live status from the app's own session caches, when held. */
export type LiveStatus = { active: boolean; thinking: boolean };

export type DashboardIssue = { number: number; repo: string; title?: string };

export type LaneSessionModel = {
  /** The ref the PM published: an id or a tag. */
  ref: string;
  /** The session it resolved to; null when no node knows it. */
  id: string | null;
  name: string;
  emoji: string | null;
  model: string | null;
  accountEmail: string | null;
  nodeId: string | null;
  nodeLabel: string | null;
  running: boolean;
  thinking: boolean;
  /** Null when the session's node cannot say (an older node, or unresolved). */
  openPinCount: number | null;
  issue: DashboardIssue | null;
  /** The last finished stage of `issue`. */
  stage: PinLaneStage | null;
  /** The stage in progress (a lock on `issue`). */
  activeStage: PinLaneStage | null;
  /** Every stage reached, when the server read the issue's labels. */
  reached: readonly PinLaneStage[] | null;
  task: string | null;
  progress: { done: number; total: number } | null;
  createdAt: number | null;
  activeAt: number | null;
  cost: number | null;
  tokens: number | null;
};

export type LaneStatus = "waiting" | "working" | "idle";

export type LaneModel = {
  letter: string;
  name: string;
  color: string;
  sessions: LaneSessionModel[];
  /** The issue the lane row shows: its first session's, else the lane's own. */
  issue: DashboardIssue | null;
  stage: PinLaneStage | null;
  activeStage: PinLaneStage | null;
  reached: readonly PinLaneStage[] | null;
  queue: PinLaneIssue[];
  status: LaneStatus;
  /** No session of the lane is running. */
  notRunning: boolean;
  /** Open pins across the lane's sessions. */
  openPinCount: number;
};

export type ProjectManagerModel = {
  /** Unique across nodes: `nodeId:sessionId:pinKey`. */
  key: string;
  sessionId: string;
  nodeId: string | null;
  nodeLabel: string | null;
  name: string;
  emoji: string | null;
  running: boolean;
  accountEmail: string | null;
  updatedAt: number;
  lanes: LaneModel[];
  /** A lane did not parse and was left out. */
  degraded: boolean;
  /** It manages the open session; also true when it is the open session. */
  managing: boolean;
  /** The Project Manager is the open session itself (`managing` is then true too). */
  self: boolean;
  /** Open pins across every lane session, each session counted once. */
  openPinCount: number;
  /** Lanes with a running session, and all lanes. */
  lanesRunning: number;
  lanesTotal: number;
};

const LANE_COLORS: Readonly<Record<string, string>> = {
  A: tokens.pinsLane.a,
  B: tokens.pinsLane.b,
  C: tokens.pinsLane.c,
  D: tokens.pinsLane.d,
  E: tokens.pinsLane.e,
  F: tokens.pinsLane.f,
  G: tokens.pinsLane.g,
  H: tokens.pinsLane.h,
};

/** A lane letter's color: A to H are fixed; any other letter is gold. */
export function laneColorVar(letter: string): string {
  return LANE_COLORS[letter] ?? tokens.pinsLane.other;
}

const QUEUE_CELL_MAX = 999;

/** The `+N` cell: empty at none, so the row never shifts; capped at `+999`. */
export function queueCell(count: number): string {
  if (count <= 0) return "";
  return `+${Math.min(count, QUEUE_CELL_MAX)}`;
}

/** A session's model for a chip: a mode's label, else the model's own name. */
export function modelLabel(model: string | null): string | null {
  if (!model) return null;
  const mode = (MODEL_MODE_LABELS as Readonly<Record<string, string>>)[model];
  return mode ?? formatModelName(model);
}

/** A cost as `$x.xx`, or null when unknown. */
export function formatCost(cost: number | null): string | null {
  return cost === null || !Number.isFinite(cost) ? null : `$${cost.toFixed(2)}`;
}

/** How long a session has run, from its creation, as `Xh Ym` / `Ym`. */
export function formatRuntime(
  createdAt: number | null,
  now: number
): string | null {
  return createdAt === null ? null : formatDurationShort(now - createdAt);
}

export type StageCellState =
  | "done"
  | "current"
  | "waiting"
  | "todo"
  | "skipped";

export type StageCell = {
  stage: PinLaneStage;
  emoji: string;
  state: StageCellState;
  tooltip: string;
};

const STATE_WORDS: Record<StageCellState, string> = {
  done: "done",
  current: "in progress",
  waiting: "waiting on you",
  todo: "not started",
  skipped: "optional, not run",
};

/**
 * The eight stage cells (ruling D3). `expert-reviewed` is optional: once a later
 * stage is done it reads as skipped unless the labels show it was reached, and
 * its tooltip says "not run" only when the labels are known (`reached`); with
 * no label history it says "not recorded". The cell in progress is the lock's stage,
 * else, while the lane waits on the operator, the stage after the last done.
 */
export function stageTrack(
  done: PinLaneStage | null,
  active: PinLaneStage | null,
  waiting: boolean,
  reached: readonly PinLaneStage[] | null = null
): StageCell[] {
  const doneOrder = stageOrder(done);
  // The optional expert review is never the stage a wait is "at".
  const next = PIN_LANE_STAGES.find(
    stage => stageOrder(stage) > doneOrder && stage !== "expert-reviewed"
  );
  const current =
    active && stageOrder(active) > doneOrder ? active : waiting ? next : null;
  return PIN_LANE_STAGES.map(stage => {
    let state: StageCellState;
    if (stage === current) {
      state = waiting ? "waiting" : "current";
    } else if (stageOrder(stage) <= doneOrder) {
      state =
        stage === "expert-reviewed" &&
        stage !== done &&
        !(reached ?? []).includes(stage)
          ? "skipped"
          : "done";
    } else {
      state = "todo";
    }
    const emoji = PIN_LANE_STAGE_EMOJI[stage];
    const words =
      state === "skipped" && reached === null
        ? "optional, not recorded"
        : STATE_WORDS[state];
    return { stage, emoji, state, tooltip: `${emoji} ${stage}: ${words}` };
  });
}

function asStage(value: string | null | undefined): PinLaneStage | null {
  return value && (PIN_LANE_STAGES as readonly string[]).includes(value)
    ? (value as PinLaneStage)
    : null;
}

function sameIssue(
  a: { repo?: string | null; number: number } | null | undefined,
  b: DashboardIssue | null
): boolean {
  return Boolean(
    a && b && a.number === b.number && (a.repo ?? null) === b.repo
  );
}

function laneSession(
  entry: PinLaneSession,
  dashboard: PinDashboard,
  facts: Record<string, PinDashboardSessionFacts>,
  live: ((id: string) => LiveStatus | undefined) | undefined
): LaneSessionModel {
  const id = dashboard.refs[entry.session] ?? null;
  const fact = id ? facts[id] : undefined;
  const status = id ? live?.(id) : undefined;
  // Facts win: the session's own linked issue over the PM's view of it.
  const linked = fact?.linkedIssue ?? null;
  const issue: DashboardIssue | null = linked
    ? { number: linked.number, repo: linked.repo, title: linked.title }
    : entry.issue
      ? {
          number: entry.issue.number,
          repo: entry.issue.repo,
          title: entry.issue.title,
        }
      : null;
  // The badge raises the stage only when it is about this same issue.
  const badge = fact?.badge && sameIssue(fact.badge, issue) ? fact.badge : null;
  // The PM's stage describes the issue it published: once the session is on
  // another issue, neither of its stages applies (#6454 review).
  const payloadFits = !entry.issue || sameIssue(entry.issue, issue);
  const payloadStage = payloadFits
    ? (entry.stage ?? entry.issue?.stage ?? null)
    : null;
  return {
    ref: entry.session,
    id,
    name: fact?.name?.trim() || fact?.tag || entry.session,
    emoji: fact?.emoji ?? null,
    model: fact?.model ?? null,
    accountEmail: fact?.accountEmail ?? null,
    nodeId: fact?.nodeId ?? null,
    nodeLabel: fact?.nodeLabel ?? null,
    running: status?.active ?? fact?.active === true,
    thinking: status?.thinking ?? fact?.thinking === true,
    openPinCount: fact?.openPinCount ?? null,
    issue,
    stage: laterStage(payloadStage, asStage(badge?.done)),
    activeStage: asStage(badge?.active),
    reached: badge?.reached
      ? badge.reached.flatMap(stage => asStage(stage) ?? [])
      : null,
    task: entry.task ?? null,
    progress: entry.progress ?? null,
    createdAt: fact?.createdAt ?? null,
    activeAt: fact?.activeAt ?? null,
    cost: fact?.totals?.cost ?? null,
    tokens: fact?.totals?.tokens ?? null,
  };
}

/**
 * Open pins across sessions, each resolved session counted once: a PM may name
 * one session twice, by id and by tag or in two lanes (#6454 review).
 */
function uniquePinCount(sessions: LaneSessionModel[]): number {
  const counted = new Set<string>();
  let sum = 0;
  for (const session of sessions) {
    if (session.id === null || counted.has(session.id)) continue;
    counted.add(session.id);
    sum += session.openPinCount ?? 0;
  }
  return sum;
}

function laneModel(
  lane: PinLane,
  dashboard: PinDashboard,
  facts: Record<string, PinDashboardSessionFacts>,
  live: ((id: string) => LiveStatus | undefined) | undefined
): LaneModel {
  const sessions = (lane.sessions ?? []).map(entry =>
    laneSession(entry, dashboard, facts, live)
  );
  const first = sessions[0];
  const openPinCount = uniquePinCount(sessions);
  const status: LaneStatus =
    openPinCount > 0
      ? "waiting"
      : sessions.some(session => session.running && session.thinking)
        ? "working"
        : "idle";
  // The issue and its stage come from one source: the first session when it
  // has an issue (or the lane names none), else the lane (#6454 review).
  const source = first?.issue || !lane.issue ? first : undefined;
  const issue =
    source?.issue ??
    (lane.issue
      ? {
          number: lane.issue.number,
          repo: lane.issue.repo,
          title: lane.issue.title,
        }
      : null);
  return {
    letter: lane.letter,
    name: lane.name,
    color: laneColorVar(lane.letter),
    sessions,
    issue,
    stage: source ? source.stage : (lane.issue?.stage ?? null),
    activeStage: source?.activeStage ?? null,
    reached: source?.reached ?? null,
    queue: lane.queue ?? [],
    status,
    notRunning: !sessions.some(session => session.running),
    openPinCount,
  };
}

/**
 * A dashboard's lanes, parsed once per pin object: the count and status
 * patches keep the pin object, so a running-state flip re-parses nothing.
 */
const LANE_PARSES = new WeakMap<
  object,
  ReturnType<typeof parseDashboardLanes>
>();
function parsedLanes(
  pin: PinDashboard["pin"]
): ReturnType<typeof parseDashboardLanes> {
  let parsed = LANE_PARSES.get(pin);
  if (!parsed) {
    parsed = parseDashboardLanes(pin.lanes);
    LANE_PARSES.set(pin, parsed);
  }
  return parsed;
}

/** Whether `pm` manages the open session: it is the PM, its spawn child, or a lane session. */
export function managesSession(
  pm: Pick<PinDashboard, "sessionId" | "refs">,
  current: CurrentSession | null
): boolean {
  if (!current) return false;
  return (
    pm.sessionId === current.id ||
    (current.parentRelationship === "spawn" &&
      current.parentSessionId === pm.sessionId) ||
    Object.values(pm.refs).includes(current.id)
  );
}

/**
 * Every Project Manager, ordered: the one managing the open session first,
 * then running before stopped, then the most recently updated dashboard.
 */
export function toDashboardModels(
  snapshot: Pick<PinDashboardsResponse, "dashboards" | "sessions">,
  current: CurrentSession | null,
  live?: (id: string) => LiveStatus | undefined
): ProjectManagerModel[] {
  const models = snapshot.dashboards.map(dashboard => {
    const { lanes, degraded } = parsedLanes(dashboard.pin);
    const fact = snapshot.sessions[dashboard.sessionId];
    const status = live?.(dashboard.sessionId);
    const laneModels = lanes.map(lane =>
      laneModel(lane, dashboard, snapshot.sessions, live)
    );
    const updatedAt = Date.parse(dashboard.pin.updatedAt);
    return {
      key: `${dashboard.nodeId ?? "local"}:${dashboard.sessionId}:${dashboard.pin.key}`,
      sessionId: dashboard.sessionId,
      nodeId: dashboard.nodeId ?? fact?.nodeId ?? null,
      nodeLabel: dashboard.nodeLabel ?? fact?.nodeLabel ?? null,
      name: fact?.name?.trim() || fact?.tag || dashboard.pin.title,
      emoji: fact?.emoji ?? null,
      running: status?.active ?? fact?.active === true,
      accountEmail: fact?.accountEmail ?? null,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      lanes: laneModels,
      degraded,
      managing: managesSession(dashboard, current),
      self: current !== null && dashboard.sessionId === current.id,
      openPinCount: uniquePinCount(laneModels.flatMap(lane => lane.sessions)),
      lanesRunning: laneModels.filter(lane => !lane.notRunning).length,
      lanesTotal: laneModels.length,
    } satisfies ProjectManagerModel;
  });
  return models.sort(
    (a, b) =>
      Number(b.managing) - Number(a.managing) ||
      Number(b.running) - Number(a.running) ||
      b.updatedAt - a.updatedAt
  );
}

/**
 * The note a partial answer needs (#6454 review SFH-1): a node that should have
 * answered did not, so its Project Managers may be missing from the list. Null
 * when every node answered. Offline and older nodes are not asked, so they never
 * make an answer partial.
 */
export function missingNodesNote(
  snapshot: Pick<PinDashboardsResponse, "nodes" | "partial">
): string | null {
  if (!snapshot.partial) return null;
  const names = snapshot.nodes
    .filter(node => node.status === "failed")
    .map(node => node.nodeLabel || node.nodeId);
  if (names.length === 0) return null;
  const who =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${who} did not answer, so ${names.length === 1 ? "its" : "their"} Project Managers may be missing`;
}

/** Every resolved session id the snapshot names (PMs and lane sessions). */
export function dashboardSessionIds(
  snapshot: Pick<PinDashboardsResponse, "dashboards">
): string[] {
  const ids = new Set<string>();
  for (const dashboard of snapshot.dashboards) {
    ids.add(dashboard.sessionId);
    for (const id of Object.values(dashboard.refs)) ids.add(id);
  }
  return [...ids];
}
