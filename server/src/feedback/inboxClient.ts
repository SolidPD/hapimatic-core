// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Operator instance → gateway client for the central feedback inbox (issue
 * #2912, epic #2909 Sub C).
 *
 * The browser talks only to its own instance; the instance's inbox proxy
 * (`web/routes/feedbackInbox.ts`) calls the gateway's inbox API
 * (`gateway/src/routes/feedbackInbox.ts`) through this client, with this node's
 * own inbox token (`FEEDBACK_INBOX_NODE_TOKEN`, #5858 R1 — never the sink
 * bearer). Modeled on `utils/githubBrokerClient.ts`: env-resolved config (null
 * when unprovisioned), an injectable `fetchImpl`, and results that carry a
 * reason enum — never the token, never upstream error text.
 *
 * A gateway body this node's schema rejects (a newer gateway, #5858 R3) is
 * `schema_mismatch`, never `unavailable`, and is logged once per call by
 * {@link logSchemaMismatch}: a list keeps its readable rows and counts the rest
 * in `skipped`; a PATCH the gateway answered 200 is `ok` with `data: null`,
 * because the gateway stored it; a 409 whose `current` is unreadable is still
 * `conflict`, without `current`.
 *
 * Every request is rebuilt from validated values: the query string from the
 * parsed filters (never a forwarded raw query), and the row id checked as a
 * UUID before it is percent-encoded into the path — Hono decodes `%2F`, so an
 * unchecked `..%2Fusers` would send the node's inbox token to another route.
 */
import {
  feedbackInboxFiltersToQuery,
  FeedbackConflictSchema,
  FeedbackCountsSchema,
  FeedbackInboxItemSchema,
  type FeedbackCounts,
  type FeedbackInboxFilters,
  type FeedbackInboxItem,
  type FeedbackInboxList,
  type FeedbackPatch,
} from "@hapi/protocol/feedbackSink";
import { z } from "zod";

import type { FeedbackInboxConfig } from "../config/serverSettings";

/** Per-request bound on a gateway call. */
export const FEEDBACK_INBOX_TIMEOUT_MS = 5000;
/** The header the gateway records as the acting operator. */
export const FEEDBACK_ACTOR_HEADER = "x-hapi-feedback-actor";

export type FeedbackInboxFailure =
  | "unavailable"
  | "not_found"
  | "conflict"
  | "invalid"
  /** The gateway answered, but with a body this node's schema rejects (#5858). */
  | "schema_mismatch";

export type FeedbackInboxResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: FeedbackInboxFailure; current?: FeedbackInboxItem };

export interface FeedbackInboxClient {
  list(
    filters: FeedbackInboxFilters
  ): Promise<FeedbackInboxResult<FeedbackInboxList>>;
  counts(): Promise<FeedbackInboxResult<FeedbackCounts>>;
  get(id: string): Promise<FeedbackInboxResult<FeedbackInboxItem>>;
  /**
   * `data: null` means the gateway stored the change but this node cannot read
   * the row it returned (#5858 R3) — a success, never a failure.
   */
  patch(
    id: string,
    body: FeedbackPatch,
    actor: string
  ): Promise<FeedbackInboxResult<FeedbackInboxItem | null>>;
}

const IdSchema = z.uuid();

/** The list envelope with its rows unparsed, so one bad row cannot fail the page. */
const LooseListSchema = z.object({
  items: z.array(z.unknown()),
  total: z.number().int().min(0),
  skipped: z.number().int().min(0).default(0),
});

/** One issue path as keys and indices only: a key that is not a plain identifier prints as `?`. */
function issuePath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return "(root)";
  return path
    .map(segment =>
      typeof segment === "number"
        ? `[${segment}]`
        : typeof segment === "string" &&
            /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(segment)
          ? `.${segment}`
          : ".?"
    )
    .join("")
    .replace(/^\./, "");
}

/**
 * Log a gateway body this node's schema rejects (#5858 R3), once per call: the
 * route, the status, the issue count and the FIRST issue's path (keys and
 * indices only). Never a value, the token or upstream text.
 */
export function logSchemaMismatch(
  route: string,
  status: number,
  error: z.ZodError,
  pathPrefix: ReadonlyArray<PropertyKey> = []
): void {
  const first = error.issues[0];
  const where =
    first === undefined ? "(root)" : issuePath([...pathPrefix, ...first.path]);
  console.error(
    `[feedback-inbox] ${route}: gateway ${status} body does not match this node's schema (${error.issues.length} issue(s), first at ${where}) — the gateway may be newer than this node`
  );
}

export function createFeedbackInboxClient(
  config: FeedbackInboxConfig,
  fetchImpl: typeof fetch = fetch
): FeedbackInboxClient {
  const root = `${config.baseUrl}/api/feedback-inbox`;

  /**
   * One gateway call. `on200` maps a 200 body to the result (each caller decides
   * what an unreadable body means); every other status is mapped here.
   */
  async function send<T>(
    url: string,
    route: string,
    on200: (json: unknown) => FeedbackInboxResult<T>,
    init: { method?: string; body?: unknown; actor?: string } = {}
  ): Promise<FeedbackInboxResult<T>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${config.token}`,
    };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.actor !== undefined) headers[FEEDBACK_ACTOR_HEADER] = init.actor;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(FEEDBACK_INBOX_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    if (res.status === 200) return on200(json);
    if (res.status === 409) {
      const conflict = FeedbackConflictSchema.safeParse(json);
      if (conflict.success) {
        return {
          ok: false,
          reason: "conflict",
          current: conflict.data.current,
        };
      }
      // The gateway did say conflict; only the row it attached is unreadable.
      logSchemaMismatch(route, 409, conflict.error);
      return { ok: false, reason: "conflict" };
    }
    if (res.status === 404) return { ok: false, reason: "not_found" };
    if (res.status === 400) return { ok: false, reason: "invalid" };
    return { ok: false, reason: "unavailable" };
  }

  /** A 200 that must match `schema` exactly; anything else is `schema_mismatch`. */
  function strict<T>(
    route: string,
    schema: z.ZodType<T>
  ): (json: unknown) => FeedbackInboxResult<T> {
    return json => {
      const parsed = schema.safeParse(json);
      if (parsed.success) return { ok: true, data: parsed.data };
      logSchemaMismatch(route, 200, parsed.error);
      return { ok: false, reason: "schema_mismatch" };
    };
  }

  function itemUrl(id: string): string | null {
    return IdSchema.safeParse(id).success
      ? `${root}/${encodeURIComponent(id)}`
      : null;
  }

  return {
    list(filters) {
      const qs = feedbackInboxFiltersToQuery(filters).toString();
      return send(qs ? `${root}?${qs}` : root, "list", json => {
        const envelope = LooseListSchema.safeParse(json);
        if (!envelope.success) {
          logSchemaMismatch("list", 200, envelope.error);
          return { ok: false, reason: "schema_mismatch" };
        }
        const items: FeedbackInboxItem[] = [];
        let dropped = 0;
        let firstDrop: { index: number; error: z.ZodError } | null = null;
        for (const [index, raw] of envelope.data.items.entries()) {
          const item = FeedbackInboxItemSchema.safeParse(raw);
          if (item.success) {
            items.push(item.data);
          } else {
            dropped += 1;
            firstDrop ??= { index, error: item.error };
          }
        }
        if (firstDrop !== null) {
          logSchemaMismatch(
            `list (${dropped} row(s) skipped)`,
            200,
            firstDrop.error,
            ["items", firstDrop.index]
          );
        }
        return {
          ok: true,
          data: {
            items,
            total: envelope.data.total,
            skipped: envelope.data.skipped + dropped,
          },
        };
      });
    },
    counts() {
      return send(
        `${root}/counts`,
        "counts",
        strict("counts", FeedbackCountsSchema)
      );
    },
    async get(id) {
      const url = itemUrl(id);
      if (url === null) return { ok: false, reason: "not_found" };
      return send(url, "get", strict("get", FeedbackInboxItemSchema));
    },
    async patch(id, body, actor) {
      const url = itemUrl(id);
      if (url === null) return { ok: false, reason: "not_found" };
      return send<FeedbackInboxItem | null>(
        url,
        "patch",
        json => {
          const parsed = FeedbackInboxItemSchema.safeParse(json);
          if (parsed.success) return { ok: true, data: parsed.data };
          // The gateway answered 200: the change is stored. Only the returned
          // row is unreadable here, so this is a success without the row.
          logSchemaMismatch("patch", 200, parsed.error);
          return { ok: true, data: null };
        },
        { method: "PATCH", body, actor }
      );
    },
  };
}
