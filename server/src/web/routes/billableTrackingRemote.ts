// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import {
  BILLABLE_TRACKING_CARRY_CAPABILITY,
  BILLING_CATEGORIES_UNAVAILABLE_REASONS,
  TrackingRecordSchema,
  timeBillingStatus,
  type SessionSummary,
  type TrackingValidationReason,
} from "@hapi/protocol";

import type {
  BillableSwitchNodeRegistryView,
  NodeRegistry,
} from "../../federation/nodeRegistry";
import type { Store } from "../../store";
import type { BillableSwitchMirrorEvent } from "../../store/billableSwitchMirrorStore";
import type { StoredSession } from "../../store/types";
import type { WebAppEnv } from "../middleware/auth";
import {
  closedRefusal,
  isPeerWithoutBillableSwitch,
  notReachableYet,
} from "./billableSwitch";
import type { TrackingReadResponse } from "./billableTracking";
import type {
  ProxyResult,
  TrackingProxyDetail,
} from "./sessionMutationHandlers";

/**
 * The remote half of a session's tracking routes (issue #6778 PR-C), moved out
 * of `billableTracking.ts` unchanged: where a session's record lives (this
 * node, another node, the hub's copy of a deleted remote session, or nowhere),
 * the owning node's reachability, the mapping of a proxied answer with the
 * detail a peer's refusal may carry (ruling PRC-R4a), and the reads from the
 * hub's cached summary and from its copy (ruling Q4). Shared with it: the token
 * and record answer schemas and the 404 and 409 `tracking_unsupported` answers.
 * The routes themselves stay in `billableTracking.ts`.
 */

export const TokenSchema = z.number().int().nonnegative();

/** A record as an answer carries it: field by field, so a newer node's added field is dropped. */
export const TrackingRecordAnswerSchema = z.object(TrackingRecordSchema.shape);

export function sessionNotFound(c: Context): Response {
  return c.json({ error: "Session not found" }, 404);
}

/** 409 `tracking_unsupported`: the owning node cannot serve the record (a PR-B or older node). */
export function trackingUnsupported(c: Context, nodeLabel: string): Response {
  return c.json(
    {
      error: `${nodeLabel} runs a Hapimatic that cannot read or change a session's tracking record.`,
      code: "tracking_unsupported",
      nodeLabel,
    },
    409
  );
}

export type TrackingRegistry = Pick<
  NodeRegistry,
  | "locateSession"
  | "getBillableSwitchNodeViews"
  | "getNodeStates"
  | "nodeSupports"
  | "updateCachedSessionBillable"
>;

/** Where a session's record lives: this node (live or deleted), another node, the hub's copy, or nowhere. */
type TrackingPlace =
  | { kind: "local"; live: StoredSession | null }
  | {
      kind: "mirror";
      originNodeId: string;
      rows: BillableSwitchMirrorEvent[];
    }
  | {
      kind: "remote";
      nodeId: string;
      view: BillableSwitchNodeRegistryView | undefined;
      carries: boolean;
      summary: SessionSummary;
    }
  | { kind: "response"; response: Response };

/**
 * Read through the store, never `engine.getSession`, which refreshes a session
 * that is not cached and so runs #6586's tracker (7.1; review T12). A session
 * row of another namespace is a 404 (#1097). A session gone from this node whose
 * record or history is kept (R11) is this node's, read-only.
 */
export function placeTrackingSession(
  c: Context<WebAppEnv>,
  store: Store,
  registry: Partial<TrackingRegistry> | null,
  sessionId: string
): TrackingPlace {
  const namespace = c.get("namespace");
  const row = store.sessions.getSession(sessionId);
  if (row) {
    if (row.namespace !== namespace) {
      return { kind: "response", response: sessionNotFound(c) };
    }
    return { kind: "local", live: row };
  }
  if (
    store.billableTracking.get(sessionId, namespace) !== null ||
    store.billableTracking.token(sessionId, namespace) > 0
  ) {
    return { kind: "local", live: null };
  }
  const located = registry?.locateSession?.(sessionId) ?? null;
  if (!located) {
    return mirrorPlace(c, store, registry, sessionId, namespace);
  }
  return {
    kind: "remote",
    nodeId: located.nodeId,
    view: registry
      ?.getBillableSwitchNodeViews?.()
      .find(v => v.nodeId === located.nodeId),
    carries:
      registry?.nodeSupports?.(
        located.nodeId,
        BILLABLE_TRACKING_CARRY_CAPABILITY
      ) ?? false,
    summary: located.session,
  };
}

/**
 * A remote session the hub no longer lists (ruling Q4, 2026-11-22): its rows in
 * the hub's copy answer only when the copy's node is online and its session
 * list was fetched after the newest copied row, which is when the session is
 * gone from its node (deleted there). A node the hub does not know answers 404,
 * and one that is offline, not polled yet, failing, or whose list is older than
 * the copy answers 503 as the proxy would: never the copy, which must not stand
 * in for a node that cannot be asked. Read-only either way (R11).
 */
function mirrorPlace(
  c: Context,
  store: Store,
  registry: Partial<TrackingRegistry> | null,
  sessionId: string,
  namespace: string
): TrackingPlace {
  const rows = store.billableSwitch.listMirrorEvents(sessionId, namespace);
  if (rows.length === 0) {
    return { kind: "response", response: sessionNotFound(c) };
  }
  const originNodeId = rows[rows.length - 1].originNodeId;
  const view = registry
    ?.getBillableSwitchNodeViews?.()
    .find(v => v.nodeId === originNodeId);
  const unreachable = remoteReachability(c, view);
  if (unreachable) return { kind: "response", response: unreachable };
  const state = registry
    ?.getNodeStates?.()
    .find(s => s.config.id === originNodeId);
  const newestCopy = rows.reduce((m, r) => Math.max(m, r.mirroredAt), 0);
  const listedAt = state?.status === "online" ? state.lastSuccessfulPoll : null;
  if (listedAt === null || listedAt === undefined || listedAt <= newestCopy) {
    return {
      kind: "response",
      response: notReachableYet(c, view?.nodeLabel ?? originNodeId),
    };
  }
  return { kind: "mirror", originNodeId, rows };
}

/**
 * The owning node's gate for a proxied call: unknown → 404; not polled yet or
 * offline → 503 (its tags are empty until its first poll). Returns null when
 * the node can be asked.
 */
export function remoteReachability(
  c: Context,
  view: BillableSwitchNodeRegistryView | undefined
): Response | null {
  if (!view) {
    return c.json({ error: "Node not found", code: "node_not_found" }, 404);
  }
  if (view.awaitingInitialPoll || view.status === "offline") {
    return notReachableYet(c, view.nodeLabel);
  }
  return null;
}

/** The validator's reasons and the writer's domain refusal (`invalidField`). */
const INVALID_FIELD_REASONS = [
  "required",
  "unknown_category",
  "category_retired",
  "rate_out_of_range",
  "currency_not_allowed",
  "note_required",
  "note_too_long",
  "sync_unavailable",
  "outside_domain",
] as const satisfies readonly (TrackingValidationReason | "outside_domain")[];

/**
 * Ruling PRC-R4a: what a hub forwards from a peer's refusal, per code, each
 * through a strict schema, so a remote refusal reads like a local one. Every
 * other key of the peer's body (a record, a rate, a note) is dropped.
 */
const FORWARDED_DETAIL: Record<string, z.ZodType<Record<string, unknown>>> = {
  early_choice_required: z.object({
    earlierMs: z.number().int().nonnegative(),
    basis: z.literal("timer"),
  }),
  invalid_field: z.object({
    field: z.string().regex(/^[A-Za-z][A-Za-z.]{0,63}$/),
    reason: z.enum(INVALID_FIELD_REASONS),
  }),
  stale_token: z.object({ token: TokenSchema }),
  // #6779 point (2): a rejected lookup names its reason; a missing list names none.
  categories_unavailable: z.object({
    reason: z.enum(BILLING_CATEGORIES_UNAVAILABLE_REASONS).optional(),
  }),
};

/**
 * The detail of a proxied refusal that its code allows, or nothing. A detail
 * that fails its schema is left out (the code and the words still go through),
 * with one console line that names only the code.
 */
function forwardedDetail(
  code: string | undefined,
  detail: TrackingProxyDetail | undefined
): Record<string, unknown> {
  if (!code || !Object.hasOwn(FORWARDED_DETAIL, code)) return {};
  const parsed = FORWARDED_DETAIL[code].safeParse(detail ?? {});
  if (parsed.success) return parsed.data;
  console.warn(
    `[BillableTracking] a peer's ${code} refusal carried a detail this node does not accept; forwarded without it`
  );
  return {};
}

/**
 * Map a proxied answer: a peer without the routes → 409 `tracking_unsupported`;
 * any other 401 → 502 `peer_unauthorized`; a peer's 409
 * `billable_feature_closed` gains the node's label; a success is parsed with the
 * shared schema (502 `peer_bad_response` on a mismatch) and shaped by `answer`.
 */
export function proxiedTrackingResponse<T>(
  c: Context,
  result: ProxyResult,
  schema: z.ZodType<T>,
  nodeLabel: string,
  answer: (data: T) => Record<string, unknown>
): Response {
  if (result.type === "not-found") return sessionNotFound(c);
  if (result.type === "error") {
    if (isPeerWithoutBillableSwitch(result)) {
      return trackingUnsupported(c, nodeLabel);
    }
    if (result.status === 401) {
      return c.json(
        {
          error: "The session's node refused this node's federation token",
          code: "peer_unauthorized",
        },
        502
      );
    }
    if (result.code === "billable_feature_closed") {
      return closedRefusal(c, nodeLabel);
    }
    return c.json(
      {
        error: result.message,
        ...(result.code ? { code: result.code } : {}),
        ...forwardedDetail(result.code, result.trackingDetail),
      },
      result.status as ContentfulStatusCode
    );
  }
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) {
    // FND-7 (B3): one line naming the node and where the answer differs (each
    // issue's path and code), never a value from it.
    const where = parsed.error.issues
      .slice(0, 5)
      .map(i => `${i.path.map(String).join(".") || "(root)"}:${i.code}`)
      .join(", ");
    console.error(
      `[BillableTracking] peer_bad_response: ${nodeLabel}'s answer does not match this node's schema (${where})`
    );
    return c.json(
      {
        error: "The session's node returned an unexpected answer",
        code: "peer_bad_response",
      },
      502
    );
  }
  return c.json(answer(parsed.data));
}

/**
 * A session on a node that cannot serve the record, from the hub's cached
 * summary (3.3 item 6): `billable: true` → tracked, Billable, partial; `false` →
 * untracked; absent → unknown. Nothing in it can be written.
 */
export function summaryRead(
  sessionId: string,
  nodeId: string,
  summary: SessionSummary
): TrackingReadResponse {
  const billable = summary.billable;
  const confirm =
    billable === true && summary.billableConfirm === "pending"
      ? "pending"
      : null;
  return {
    sessionId,
    tracked: billable === undefined ? null : billable,
    record: null,
    confirm,
    timeStatus:
      billable === true
        ? confirm === "pending"
          ? "pending"
          : "billable"
        : null,
    token: 0,
    source: "summary",
    nodeId,
    reconcilePending: false,
  };
}

/**
 * A deleted remote session from the hub's copy (Q4): the newest row's record
 * snapshot. A row copied without the snapshots (an older puller, or a page
 * without `schema=2`), or with one this node cannot read, says nothing: tracked
 * unknown. Never writable, so its token is 0.
 */
export function mirrorRead(
  sessionId: string,
  place: Extract<TrackingPlace, { kind: "mirror" }>
): TrackingReadResponse {
  const after = place.rows[place.rows.length - 1].settingsAfter;
  const parsed =
    after === undefined || after === null
      ? null
      : TrackingRecordAnswerSchema.safeParse(after);
  const record = parsed?.success ? parsed.data : null;
  return {
    sessionId,
    tracked: after === null ? false : record !== null ? true : null,
    record,
    confirm: record?.confirm ?? null,
    timeStatus: timeBillingStatus(record),
    token: 0,
    source: "mirror",
    nodeId: place.originNodeId,
    reconcilePending: false,
  };
}
