// SPDX-License-Identifier: AGPL-3.0-only
import {
  BILLABLE_SWITCH_EVENT_KINDS,
  BILLABLE_SWITCH_FEED_SCHEMA,
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
 *    keeps its state. A row of a kind this node does not know (a newer
 *    origin's) is left out of its page, the cursor moves past it, and the
 *    origin is named in the log once (#6778 F1).
 * Every request asks with `schema` 2 (#6778 PR-B, 6.3), whatever the origin
 * advertises: an origin that knows it sends every kind with the four new
 * fields and `cursorAt`, and one that does not ignores it.
 * Resync (the cursor back to 0 under the page's incarnation, every copied row
 * kept): no cursor row, another incarnation (a rebuilt node), a highest id
 * below the cursor (a database restored from a backup under the same
 * incarnation), a cursor row whose `at` is not the copy's (a restore that
 * re-issued ids at or below the cursor, review S14), or a cursor row that does
 * not yet record the `schema` 2 reset. That reset happens once per origin
 * (review H6): it is recorded in `feed_state` with the first page applied after
 * it, kept by the `unsupported` branch, and erased only by a build before PR-B,
 * whose pulls write a plain state, so a roll forward copies once more what that
 * build copied without the new fields (section 12 step 4). Then pages are
 * applied until drained or 20 were applied. This service never deletes a
 * copied row, so the copy outlives the session and the node.
 */

const PAGE_LIMIT = 500;
/**
 * The `feed_state` suffixes that record the once-per-origin reset (review H6),
 * by what the origin served (review finding M7): `:schema-2` when its page
 * carried `cursorAt` (it honoured `schema` 2), `:schema-1` when it did not (a
 * build before PR-B, or one rolled back to it). A `:schema-1` origin that
 * starts serving `cursorAt` is copied once more, which repairs the rows it
 * served without the four new fields; an origin that stays older is not
 * copied again on every tick.
 */
export const SCHEMA_RESET_MARK = `:schema-${BILLABLE_SWITCH_FEED_SCHEMA}`;
export const OLD_ORIGIN_RESET_MARK = ":schema-1";
const resetMarkOf = (state: string | undefined): string =>
  state?.endsWith(SCHEMA_RESET_MARK)
    ? SCHEMA_RESET_MARK
    : state?.endsWith(OLD_ORIGIN_RESET_MARK)
      ? OLD_ORIGIN_RESET_MARK
      : "";
const pageResetMark = (page: BillableSwitchEventFeedPage): string =>
  page.cursorAt !== undefined ? SCHEMA_RESET_MARK : OLD_ORIGIN_RESET_MARK;
/** One large origin cannot starve the rest within a tick. */
const MAX_PAGES_PER_TICK = 20;

let loop: SupervisedLoop | null = null;

/** The registry calls the puller needs; a real NodeRegistry satisfies it. */
export interface BillableSwitchPullRegistry {
  getBillableSwitchNodeViews(): BillableSwitchNodeRegistryView[];
  getBillableSwitchEventFeedOnNode(
    nodeId: string,
    opts: { cursor: number; limit: number; schema?: number }
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
  // PR-2 item E3: with the switch storage not ready (a failed migration) every
  // tick's store call would throw, and each origin was logged once a minute as
  // unreachable. Say once what is wrong and leave the loop unstarted.
  if (!opts.store.storageReady()) {
    console.error(
      "[BillableSwitchMirrorPull] not started: this node's billable switch storage is not ready (its migration failed), so other nodes' switch events are not copied here"
    );
    return;
  }
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

/**
 * (origin, kind) pairs already named in the log for a kind this node does not
 * know: keyed by both, so a second unknown kind from one origin is named too
 * (review finding L4).
 */
const warnedUnknownKind = new Set<string>();
/** Origins already named for a page that failed its schema, by field path (M5). */
const warnedMalformed = new Set<string>();

/**
 * Leaves out of a page, before it is parsed, every row whose `kind` this build
 * does not know (#6778 F1), so a newer origin's new kind cannot fail the page.
 * Before, the strict parse failed the whole page, and because the cursor is
 * written only after a page is applied, every tick re-read the same page and
 * the origin's copy stalled with nothing in the log. A row whose `kind` is
 * missing or not a string is not left out, so it still fails the page.
 * `received` is the row count the origin sent, which decides whether to read on.
 */
function dropUnknownKinds(body: unknown): {
  body: unknown;
  received: number;
  dropped: string[];
} {
  const events =
    typeof body === "object" && body !== null
      ? (body as { events?: unknown }).events
      : undefined;
  if (!Array.isArray(events)) return { body, received: 0, dropped: [] };
  const known = BILLABLE_SWITCH_EVENT_KINDS as readonly string[];
  const dropped: string[] = [];
  const kept = events.filter(row => {
    const kind =
      typeof row === "object" && row !== null
        ? (row as { kind?: unknown }).kind
        : undefined;
    if (typeof kind === "string" && !known.includes(kind)) {
      dropped.push(kind);
      return false;
    }
    return true;
  });
  return {
    body: { ...(body as object), events: kept },
    received: events.length,
    dropped,
  };
}

type FetchedPage = {
  kind: "page";
  page: BillableSwitchEventFeedPage;
  received: number;
};

async function fetchPage(
  registry: BillableSwitchPullRegistry,
  nodeId: string,
  cursor: number
): Promise<FetchedPage | { kind: "unreachable" } | { kind: "malformed" }> {
  const outcome = await registry.getBillableSwitchEventFeedOnNode(nodeId, {
    cursor,
    limit: PAGE_LIMIT,
    schema: BILLABLE_SWITCH_FEED_SCHEMA,
  });
  if (outcome.kind !== "ok") return { kind: "unreachable" };
  const { body, received, dropped } = dropUnknownKinds(outcome.body);
  const parsed = BillableSwitchEventFeedPageSchema.safeParse(body);
  if (!parsed.success) {
    // Review finding M5: a page that fails its schema stops this origin's copy
    // until it parses; say so once per origin and failing field.
    const issue = parsed.error.issues[0];
    const where = issue ? issue.path.join(".") || "(root)" : "(unknown)";
    if (!warnedMalformed.has(`${nodeId}|${where}`)) {
      warnedMalformed.add(`${nodeId}|${where}`);
      console.warn(
        `[BillableSwitchMirrorPull] origin ${nodeId} sent a page this node cannot parse (at ${where}: ${issue?.message ?? "unknown"}); its copy waits until a page parses`
      );
    }
    return { kind: "malformed" };
  }
  const fresh = [...new Set(dropped)].filter(
    k => !warnedUnknownKind.has(`${nodeId}|${k}`)
  );
  if (fresh.length > 0) {
    for (const k of fresh) warnedUnknownKind.add(`${nodeId}|${k}`);
    console.warn(
      `[BillableSwitchMirrorPull] origin ${nodeId} sent switch events of a kind this node does not know (${fresh.join(", ")}); they are not copied here, and the copy goes on past them`
    );
  }
  return { kind: "page", page: parsed.data, received };
}

/**
 * Whether the origin's row at the cursor is not the one this node copied
 * (review S14). Only a `schema` 2 page carries `cursorAt`; an older origin's
 * page does not, and nothing is compared. Nothing is compared either when the
 * copy holds no row with that id (a row of a kind this node left out). A
 * re-issued id is copied as a second row, so any copied row with that `at`
 * matches.
 */
function cursorRowMoved(
  store: BillableSwitchStore,
  nodeId: string,
  page: BillableSwitchEventFeedPage,
  cursor: number
): boolean {
  if (page.cursorAt === undefined || cursor === 0) return false;
  const ats = store.getMirrorEventAts(nodeId, page.incarnation, cursor);
  if (ats.length === 0) return false;
  return page.cursorAt === null || !ats.includes(page.cursorAt);
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
  const mark = resetMarkOf(stored?.feedState);
  if (!view.on && !view.closed) {
    store.setMirrorCursor(nodeId, {
      originIncarnation: stored?.originIncarnation ?? "",
      cursor: stored?.cursor ?? 0,
      // The reset mark survives a gate that leaves `on` or `closed` (H6).
      feedState: `unsupported${mark}`,
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

  const moved = cursorRowMoved(store, nodeId, fetched.page, cursor);
  const upgraded =
    mark === OLD_ORIGIN_RESET_MARK && fetched.page.cursorAt !== undefined;
  const resync =
    !stored ||
    mark === "" ||
    upgraded ||
    stored.originIncarnation !== fetched.page.incarnation ||
    fetched.page.maxEventId < cursor ||
    moved;
  if (resync && cursor !== 0) {
    console.log(
      `[BillableSwitchMirrorPull] origin ${nodeId}: copying its record again from the start (${
        mark === ""
          ? `once, to get every kind and field of feed schema ${BILLABLE_SWITCH_FEED_SCHEMA}`
          : upgraded
            ? `once more: it now serves feed schema ${BILLABLE_SWITCH_FEED_SCHEMA}, which repairs the rows it served without the new fields`
            : moved
              ? "the row at the cursor is not the copy's: a restored database"
              : "another incarnation, or a highest id below the cursor"
      }); rows already copied are kept`
    );
    cursor = 0;
    fetched = await fetchPage(registry, nodeId, cursor);
    if (fetched.kind === "unreachable") return "skipped-unreachable";
    if (fetched.kind === "malformed") return "skipped-malformed";
  }

  let pagesLeft = MAX_PAGES_PER_TICK;
  let current: FetchedPage | null = fetched;
  while (current && pagesLeft-- > 0) {
    const { page, received } = current;
    const at = now();
    store.upsertMirrorEvents(nodeId, page.incarnation, page.events, at);
    store.setMirrorCursor(nodeId, {
      originIncarnation: page.incarnation,
      cursor: page.nextCursor,
      // Written with the first page applied: the reset is done for this
      // origin, at the schema its page shows it served (M7).
      feedState: `ok${pageResetMark(page)}`,
      lastOriginMaxId: page.maxEventId,
      lastSyncAt: at,
      lastAttemptAt: at,
    });
    const advanced = page.nextCursor > cursor;
    cursor = page.nextCursor;
    // The origin's own row count: rows left out above still fill its page.
    if (received < PAGE_LIMIT || !advanced) break;
    const next = await fetchPage(registry, nodeId, cursor);
    current = next.kind === "page" ? next : null;
  }
  return "copied";
}
