// SPDX-License-Identifier: AGPL-3.0-only
import {
  BillableSwitchEventFeedPageSchema,
  SupervisedLoop,
  type BillableSwitchEventFeedPage,
  type JobRegistry,
} from "@hapi/protocol";
import type { TurnMirrorConfig } from "../config/turnMirrorConfig";
import type {
  BillableSwitchNodeRegistryView,
  NodeRegistry,
  PeerReadOutcome,
} from "../federation/nodeRegistry";
import type { BillableSwitchStore } from "../store/billableSwitchStore";

/**
 * The hub's copy of the other nodes' billable switch records (issue #6646,
 * Task 7b, ruling Q10 (a)), on the turn mirror's pattern
 * (`turnMirrorPullService.ts`).
 *
 * Runs on a node with a registry (hub and peer roles; `turnMirrorWiring` applies
 * the role gate and the turn mirror's cadence and opt-out), in every gate state
 * of THIS node, because a hub whose own gate is off still holds its peers'
 * record. Per origin, per tick, isolated from the others:
 *  - an origin the registry has not polled yet is skipped;
 *  - an origin that advertises neither `billable:switch` nor
 *    `billable:switch-closed` gets no request, and its cursor row says
 *    `unsupported` (the cursor itself is kept);
 *  - otherwise one page after the stored cursor. An offline or unreachable
 *    outcome, or a page that fails its schema, skips the origin this tick and
 *    keeps its state.
 * Resync (the cursor back to 0 under the page's incarnation, every copied row
 * kept): no cursor row, another incarnation (a rebuilt node), or a highest id
 * below the cursor (a database restored from a backup under the same
 * incarnation). Then pages are applied until drained or 20 were applied. This
 * service never deletes a copied row, so the copy outlives the session and the
 * node.
 */

const PAGE_LIMIT = 500;
/** One large origin cannot starve the rest within a tick. */
const MAX_PAGES_PER_TICK = 20;

let loop: SupervisedLoop | null = null;

/** The registry calls the puller needs; a real NodeRegistry satisfies it. */
export interface BillableSwitchPullRegistry {
  getBillableSwitchNodeViews(): BillableSwitchNodeRegistryView[];
  getBillableSwitchEventFeedOnNode(
    nodeId: string,
    opts: { cursor: number; limit: number }
  ): Promise<PeerReadOutcome>;
}

export type BillableSwitchPullOutcome =
  | "copied"
  | "unsupported"
  | "skipped-unpolled"
  | "skipped-unreachable"
  | "skipped-malformed";

export function start(opts: {
  jobNodeId: string;
  jobRegistry: JobRegistry;
  getNodeRegistry: () => NodeRegistry | null;
  store: BillableSwitchStore;
  turnMirrorConfig: TurnMirrorConfig;
}): void {
  if (loop) return;
  const { turnMirrorConfig } = opts;
  loop = new SupervisedLoop({
    name: "billable-switch-mirror-pull",
    node: opts.jobNodeId,
    intervalMs: turnMirrorConfig.pollIntervalMs,
    enabled: turnMirrorConfig.enabled,
    immediate: false,
    registry: opts.jobRegistry,
    tick: async () => {
      if (!turnMirrorConfig.enabled) return;
      const registry = opts.getNodeRegistry();
      if (!registry) return;
      await pullAllOnce(registry, opts.store);
    },
  });
  loop.start();
  console.log(
    `[BillableSwitchMirrorPull] ${
      turnMirrorConfig.enabled ? "started" : "disabled (registered stopped)"
    } — interval ${turnMirrorConfig.pollIntervalMs}ms`
  );
}

export function stop(): void {
  loop?.stop();
  loop = null;
}

/** One pass over every tracked node, each isolated from the others. */
export async function pullAllOnce(
  registry: BillableSwitchPullRegistry,
  store: BillableSwitchStore,
  now: () => number = Date.now
): Promise<Record<string, BillableSwitchPullOutcome>> {
  const outcomes: Record<string, BillableSwitchPullOutcome> = {};
  for (const view of registry.getBillableSwitchNodeViews()) {
    try {
      outcomes[view.nodeId] = await pullOriginOnce(registry, store, view, now);
    } catch (err) {
      outcomes[view.nodeId] = "skipped-unreachable";
      console.warn(
        `[BillableSwitchMirrorPull] origin ${view.nodeId} pull failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return outcomes;
}

async function fetchPage(
  registry: BillableSwitchPullRegistry,
  nodeId: string,
  cursor: number
): Promise<
  | { kind: "page"; page: BillableSwitchEventFeedPage }
  | { kind: "unreachable" }
  | { kind: "malformed" }
> {
  const outcome = await registry.getBillableSwitchEventFeedOnNode(nodeId, {
    cursor,
    limit: PAGE_LIMIT,
  });
  if (outcome.kind !== "ok") return { kind: "unreachable" };
  const parsed = BillableSwitchEventFeedPageSchema.safeParse(outcome.body);
  return parsed.success
    ? { kind: "page", page: parsed.data }
    : { kind: "malformed" };
}

/** One origin, one tick. */
export async function pullOriginOnce(
  registry: BillableSwitchPullRegistry,
  store: BillableSwitchStore,
  view: BillableSwitchNodeRegistryView,
  now: () => number = Date.now
): Promise<BillableSwitchPullOutcome> {
  const nodeId = view.nodeId;
  if (view.awaitingInitialPoll) return "skipped-unpolled";
  const stored = store.getMirrorCursor(nodeId);
  if (!view.on && !view.closed) {
    store.setMirrorCursor(nodeId, {
      originIncarnation: stored?.originIncarnation ?? "",
      cursor: stored?.cursor ?? 0,
      feedState: "unsupported",
      lastOriginMaxId: stored?.lastOriginMaxId ?? null,
      lastSyncAt: stored?.lastSyncAt ?? null,
      lastAttemptAt: now(),
    });
    return "unsupported";
  }

  let cursor = stored?.cursor ?? 0;
  let fetched = await fetchPage(registry, nodeId, cursor);
  if (fetched.kind === "unreachable") return "skipped-unreachable";
  if (fetched.kind === "malformed") return "skipped-malformed";

  const resync =
    !stored ||
    stored.originIncarnation !== fetched.page.incarnation ||
    fetched.page.maxEventId < cursor;
  if (resync && cursor !== 0) {
    cursor = 0;
    fetched = await fetchPage(registry, nodeId, cursor);
    if (fetched.kind === "unreachable") return "skipped-unreachable";
    if (fetched.kind === "malformed") return "skipped-malformed";
  }

  let pagesLeft = MAX_PAGES_PER_TICK;
  let page: BillableSwitchEventFeedPage | null = fetched.page;
  while (page && pagesLeft-- > 0) {
    const at = now();
    store.upsertMirrorEvents(nodeId, page.incarnation, page.events, at);
    store.setMirrorCursor(nodeId, {
      originIncarnation: page.incarnation,
      cursor: page.nextCursor,
      feedState: "ok",
      lastOriginMaxId: page.maxEventId,
      lastSyncAt: at,
      lastAttemptAt: at,
    });
    const advanced = page.nextCursor > cursor;
    cursor = page.nextCursor;
    if (page.events.length < PAGE_LIMIT || !advanced) break;
    const next = await fetchPage(registry, nodeId, cursor);
    page = next.kind === "page" ? next.page : null;
  }
  return "copied";
}
