// SPDX-License-Identifier: AGPL-3.0-only
import {
  SupervisedLoop,
  TurnFeedPageSchema,
  type JobRegistry,
  type TurnFeedPage,
} from "@hapi/protocol";
import type { NodeRegistry } from "../federation/nodeRegistry";
import type { TurnMirrorStore } from "../store/turns/turnMirrorStore";
import type { TurnMirrorConfig } from "../config/turnMirrorConfig";

/**
 * Turn-ledger mirror pull loop (issue #4614).
 *
 * Runs on every node that has a NodeRegistry (hub + peer roles — index.ts only
 * starts it when `role !== "node"`). Each tick enumerates the mesh peers
 * (`registry.getNodeSummaries()` — never includes self, so no self-pull),
 * fetches each origin's finalized-turn feed since a per-origin cursor, and writes
 * the rows into THIS node's SEPARATE mirror store (never into `turns`, so
 * existing readers can't double-count).
 *
 * Resync (R5): before applying, detect a rebuilt VM (origin incarnation changed)
 * OR a restore-from-backup (origin's reported max change_seq rewound below our
 * stored cursor) and reset that origin's cursor to 0 under the new incarnation —
 * no stalled cursor, and the composite-keyed upsert means no duplicate rows.
 *
 * The per-node opt-out is the SupervisedLoop's `enabled` flag: when false the
 * loop registers as "stopped" (visible in the System Jobs portal) and never
 * ticks — zero mirror rows written (R4). A departed origin simply stops
 * appearing in `getNodeSummaries()`; its mirror rows + cursor are left intact
 * (R11) — this service never deletes.
 */

const PAGE_LIMIT = 500;
/** Bound pages drained per origin per tick so one huge origin can't starve the rest. */
const MAX_PAGES_PER_TICK = 20;

let loop: SupervisedLoop | null = null;

export function start(opts: {
  jobNodeId: string;
  jobRegistry: JobRegistry;
  getNodeRegistry: () => NodeRegistry | null;
  turnMirror: TurnMirrorStore;
  turnMirrorConfig: TurnMirrorConfig;
}): void {
  if (loop) return;
  const {
    jobNodeId,
    jobRegistry,
    getNodeRegistry,
    turnMirror,
    turnMirrorConfig,
  } = opts;

  loop = new SupervisedLoop({
    name: "turn-mirror-pull",
    node: jobNodeId,
    intervalMs: turnMirrorConfig.pollIntervalMs,
    enabled: turnMirrorConfig.enabled,
    immediate: false,
    registry: jobRegistry,
    tick: async () => {
      // Belt-and-suspenders: an `enabled:false` loop never ticks, but guard
      // anyway so a future re-enable path can't accidentally write when opted out.
      if (!turnMirrorConfig.enabled) return;
      const registry = getNodeRegistry();
      if (!registry) return;
      await pullAllOnce(registry, turnMirror);
    },
  });
  loop.start();
  console.log(
    `[TurnMirrorPull] ${
      turnMirrorConfig.enabled ? "started" : "disabled (registered stopped)"
    } — interval ${turnMirrorConfig.pollIntervalMs}ms`
  );
}

export function stop(): void {
  loop?.stop();
  loop = null;
}

/**
 * The structural subset of NodeRegistry the pull loop needs. A real NodeRegistry
 * satisfies it; tests pass a stub (the § Verification Strategy Tier 1 harness).
 */
export interface PullRegistry {
  getNodeSummaries(): Array<{ nodeId: string }>;
  getTurnFeedOnNode(
    nodeId: string,
    opts: { cursor?: number; adjCursor?: number; limit?: number }
  ): Promise<unknown>;
}

/** Parse + shape-guard a proxy result; null on offline/error/malformed. */
function parseFeed(feed: unknown): TurnFeedPage | null {
  if (!feed || typeof feed !== "object") return null;
  if ("type" in feed && (feed as { type?: unknown }).type === "error") {
    return null; // proxyToNode graceful-degradation shape → origin unreachable
  }
  const parsed = TurnFeedPageSchema.safeParse(feed);
  return parsed.success ? parsed.data : null;
}

/** One pull pass over every mesh peer, with per-origin isolation (exported for tests). */
export async function pullAllOnce(
  registry: PullRegistry,
  turnMirror: TurnMirrorStore
): Promise<void> {
  for (const summary of registry.getNodeSummaries()) {
    try {
      await pullOriginOnce(registry, turnMirror, summary.nodeId);
    } catch (err) {
      // Per-origin isolation: one bad origin never skips the rest, and the
      // SupervisedLoop survives regardless (auto-restart-on-throw).
      console.warn(
        `[TurnMirrorPull] origin ${summary.nodeId} pull failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

export async function pullOriginOnce(
  registry: PullRegistry,
  turnMirror: TurnMirrorStore,
  nodeId: string
): Promise<void> {
  const stored = turnMirror.getCursor(nodeId);
  let cursor = stored?.turnCursor ?? 0;
  let adjCursor = stored?.adjCursor ?? 0;

  let page = parseFeed(
    await registry.getTurnFeedOnNode(nodeId, {
      cursor,
      adjCursor,
      limit: PAGE_LIMIT,
    })
  );
  if (!page) return; // offline / error / malformed → skip this origin this tick

  // Resync detection (R5): incarnation changed (rebuilt VM) OR either independent
  // high-water mark rewound below its matching cursor (restore-from-backup). The
  // turns and adjustments streams have SEPARATE change_seq counters + cursors, so
  // BOTH limbs are required — an adjustments-ONLY rewind (a backup window with
  // adjustment activity but no finalized turns) is invisible to the turns limb and
  // would otherwise strand the adj cursor permanently past the origin's data
  // (issue #4614). The rewind limbs catch a same-incarnation restore the
  // incarnation check alone would miss.
  const needResync =
    !stored ||
    stored.originIncarnation !== page.incarnation ||
    page.maxChangeSeq < cursor ||
    page.adjMaxChangeSeq < adjCursor;
  if (needResync) {
    turnMirror.resetOrigin(nodeId, page.incarnation);
    cursor = 0;
    adjCursor = 0;
    page = parseFeed(
      await registry.getTurnFeedOnNode(nodeId, {
        cursor,
        adjCursor,
        limit: PAGE_LIMIT,
      })
    );
    if (!page) return;
  }

  let pagesLeft = MAX_PAGES_PER_TICK;
  while (page && pagesLeft-- > 0) {
    turnMirror.upsertMirrorTurns(nodeId, page.incarnation, page.turns);
    turnMirror.upsertMirrorAdjustments(
      nodeId,
      page.incarnation,
      page.adjustments
    );
    turnMirror.setCursor(
      nodeId,
      page.incarnation,
      page.nextCursor,
      page.adjNextCursor,
      page.maxChangeSeq,
      Date.now()
    );
    const advanced = page.nextCursor > cursor || page.adjNextCursor > adjCursor;
    cursor = page.nextCursor;
    adjCursor = page.adjNextCursor;
    // Drained (neither table filled a page) or no progress → done.
    if (
      (page.turns.length < PAGE_LIMIT &&
        page.adjustments.length < PAGE_LIMIT) ||
      !advanced
    ) {
      break;
    }
    page = parseFeed(
      await registry.getTurnFeedOnNode(nodeId, {
        cursor,
        adjCursor,
        limit: PAGE_LIMIT,
      })
    );
  }
}
