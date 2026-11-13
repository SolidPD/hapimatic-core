// SPDX-License-Identifier: AGPL-3.0-only
import {
  INTERVAL_FEED_CAPABILITY,
  IntervalFeedPageSchema,
  SupervisedLoop,
  type IntervalFeedPage,
  type JobRegistry,
} from "@hapi/protocol";
import type { TurnMirrorConfig } from "../config/turnMirrorConfig";
import type { PeerReadOutcome } from "../federation/nodeRegistry";
import type { IntervalMirrorStore } from "../store/billable/intervalMirrorStore";

/**
 * Billable interval mirror pull loop (issue #6586, R11).
 *
 * Its own `SupervisedLoop` (`interval-mirror-pull`), beside the turn mirror's, so
 * a failure in one loop cannot stop the other and each shows in the System Jobs
 * portal. It shares the turn mirror's cadence and opt-out: a node that opted out
 * of holding other nodes' history opted out of both kinds. It runs in every
 * `HAPI_BILLABLE_INTERVALS` mode, because a node in `off` still holds its peers'
 * history for reports.
 *
 * Per origin, per tick:
 * 1. not yet polled by the registry (`capabilities` undefined): skip;
 * 2. polled and without the `billable:interval-feed` tag: send nothing (an old
 *    origin would log an `auth` warning every minute) and record `unsupported`;
 * 3. tagged: read the feed. An `unsupported` reply is handled as case 2 (the
 *    backstop for the one poll after a downgrade); an offline or unreachable
 *    origin, or a page that fails to parse, keeps its state and cursor.
 *
 * Resync (cursor to 0 under the page's incarnation, every row kept) when there is
 * no cursor row, the incarnation changed, or the origin's counter rewound below
 * the cursor under the same incarnation (a restore from backup).
 */

const PAGE_LIMIT = 500;
/** Bound pages per origin per tick, as the turn mirror does. */
const MAX_PAGES_PER_TICK = 20;

let loop: SupervisedLoop | null = null;

/** The structural subset of NodeRegistry the puller needs (tests pass a stub). */
export interface IntervalPullRegistry {
  getNodeSummaries(): Array<{ nodeId: string; capabilities?: string[] }>;
  getIntervalFeedOnNode(
    nodeId: string,
    opts: { cursor?: number; limit?: number }
  ): Promise<PeerReadOutcome>;
}

export function start(opts: {
  jobNodeId: string;
  jobRegistry: JobRegistry;
  getNodeRegistry: () => IntervalPullRegistry | null;
  intervalMirror: IntervalMirrorStore;
  turnMirrorConfig: TurnMirrorConfig;
}): void {
  if (loop) return;
  const {
    jobNodeId,
    jobRegistry,
    getNodeRegistry,
    intervalMirror,
    turnMirrorConfig,
  } = opts;
  loop = new SupervisedLoop({
    name: "interval-mirror-pull",
    node: jobNodeId,
    intervalMs: turnMirrorConfig.pollIntervalMs,
    enabled: turnMirrorConfig.enabled,
    immediate: false,
    registry: jobRegistry,
    tick: async () => {
      if (!turnMirrorConfig.enabled) return;
      const registry = getNodeRegistry();
      if (!registry) return;
      await pullAllOnce(registry, intervalMirror);
    },
  });
  loop.start();
  console.log(
    `[IntervalMirrorPull] ${
      turnMirrorConfig.enabled ? "started" : "disabled (registered stopped)"
    } — interval ${turnMirrorConfig.pollIntervalMs}ms`
  );
}

export function stop(): void {
  loop?.stop();
  loop = null;
}

/** One pass over every mesh peer, with per-origin isolation (exported for tests). */
export async function pullAllOnce(
  registry: IntervalPullRegistry,
  intervalMirror: IntervalMirrorStore,
  getNow: () => number = Date.now
): Promise<void> {
  for (const summary of registry.getNodeSummaries()) {
    try {
      await pullOriginOnce(registry, intervalMirror, summary, getNow);
    } catch (err) {
      console.warn(
        `[IntervalMirrorPull] origin ${summary.nodeId} pull failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

type ReadResult =
  | { kind: "page"; page: IntervalFeedPage }
  | { kind: "unsupported" }
  | { kind: "skip" };

async function readPage(
  registry: IntervalPullRegistry,
  nodeId: string,
  cursor: number
): Promise<ReadResult> {
  const outcome = await registry.getIntervalFeedOnNode(nodeId, {
    cursor,
    limit: PAGE_LIMIT,
  });
  if (outcome.kind === "unsupported") return { kind: "unsupported" };
  if (outcome.kind !== "ok") return { kind: "skip" };
  const parsed = IntervalFeedPageSchema.safeParse(outcome.body);
  if (parsed.success) return { kind: "page", page: parsed.data };
  // The plan's rule: a page that fails to parse keeps the origin's state and
  // cursor for this tick. Say so (at most once an hour per origin), because the
  // same page comes back every tick until the origin changes, and the mirror
  // would otherwise fall behind with no trace.
  warnMalformedPage(nodeId, parsed.error.issues[0]);
  return { kind: "skip" };
}

const MALFORMED_WARN_INTERVAL_MS = 3_600_000;
const lastMalformedWarnAt = new Map<string, number>();

function warnMalformedPage(
  nodeId: string,
  issue: { path: PropertyKey[]; message: string } | undefined
): void {
  const now = Date.now();
  const last = lastMalformedWarnAt.get(nodeId);
  if (last !== undefined && now - last < MALFORMED_WARN_INTERVAL_MS) return;
  lastMalformedWarnAt.set(nodeId, now);
  console.warn(
    `[IntervalMirrorPull] origin ${nodeId}: interval-feed page did not parse; cursor kept`,
    issue ? `${issue.path.join(".")}: ${issue.message}` : ""
  );
}

export async function pullOriginOnce(
  registry: IntervalPullRegistry,
  intervalMirror: IntervalMirrorStore,
  summary: { nodeId: string; capabilities?: string[] },
  getNow: () => number = Date.now
): Promise<void> {
  const { nodeId, capabilities } = summary;
  // Case 1: the registry has not polled this origin yet.
  if (capabilities === undefined) return;
  // Case 2: an origin without the feed — no request.
  if (!capabilities.includes(INTERVAL_FEED_CAPABILITY)) {
    intervalMirror.markUnsupported(nodeId, getNow());
    return;
  }

  const stored = intervalMirror.getCursor(nodeId);
  let cursor = stored?.cursor ?? 0;
  let read = await readPage(registry, nodeId, cursor);
  if (read.kind === "unsupported") {
    intervalMirror.markUnsupported(nodeId, getNow());
    return;
  }
  if (read.kind === "skip") {
    intervalMirror.noteAttempt(nodeId, getNow());
    return;
  }

  const needResync =
    !stored ||
    stored.originIncarnation !== read.page.incarnation ||
    read.page.maxChangeSeq < cursor;
  if (needResync) {
    intervalMirror.resetCursor(nodeId, read.page.incarnation, getNow());
    cursor = 0;
    read = await readPage(registry, nodeId, cursor);
    if (read.kind === "unsupported") {
      intervalMirror.markUnsupported(nodeId, getNow());
      return;
    }
    if (read.kind === "skip") {
      intervalMirror.noteAttempt(nodeId, getNow());
      return;
    }
  }

  let page: IntervalFeedPage = read.page;
  for (let applied = 0; applied < MAX_PAGES_PER_TICK; ) {
    intervalMirror.applyPage(nodeId, page, getNow());
    applied++;
    const sent = cursor;
    cursor = page.nextCursor;
    // Drained, or no progress: stop for this tick.
    if (page.nextCursor >= page.maxChangeSeq || page.nextCursor <= sent) return;
    if (applied >= MAX_PAGES_PER_TICK) return;
    const next = await readPage(registry, nodeId, cursor);
    if (next.kind === "unsupported") {
      intervalMirror.markUnsupported(nodeId, getNow());
      return;
    }
    if (next.kind === "skip") {
      intervalMirror.noteAttempt(nodeId, getNow());
      return;
    }
    page = next.page;
  }
}
