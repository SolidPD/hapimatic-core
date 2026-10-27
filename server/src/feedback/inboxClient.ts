// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Operator instance → gateway client for the central feedback inbox (issue
 * #2912, epic #2909 Sub C).
 *
 * The browser talks only to its own instance; the instance's inbox proxy
 * (`web/routes/feedbackInbox.ts`) calls the gateway's operator-bearer API
 * (`gateway/src/routes/feedbackInbox.ts`) through this client, with the shared
 * operator bearer (`FEEDBACK_INBOX_TOKEN`, ruling D12). Modeled on
 * `utils/githubBrokerClient.ts`: env-resolved config (null when unprovisioned),
 * an injectable `fetchImpl`, and results that carry a reason enum — never the
 * token, never upstream error text.
 *
 * Every request is rebuilt from validated values: the query string from the
 * parsed filters (never a forwarded raw query), and the row id checked as a
 * UUID before it is percent-encoded into the path — Hono decodes `%2F`, so an
 * unchecked `..%2Fusers` would send the operator bearer to another route.
 */
import {
  feedbackInboxFiltersToQuery,
  FeedbackConflictSchema,
  FeedbackCountsSchema,
  FeedbackInboxItemSchema,
  FeedbackInboxListSchema,
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
  | "invalid";

export type FeedbackInboxResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: FeedbackInboxFailure; current?: FeedbackInboxItem };

export interface FeedbackInboxClient {
  list(
    filters: FeedbackInboxFilters
  ): Promise<FeedbackInboxResult<FeedbackInboxList>>;
  counts(): Promise<FeedbackInboxResult<FeedbackCounts>>;
  get(id: string): Promise<FeedbackInboxResult<FeedbackInboxItem>>;
  patch(
    id: string,
    body: FeedbackPatch,
    actor: string
  ): Promise<FeedbackInboxResult<FeedbackInboxItem>>;
}

const IdSchema = z.uuid();

export function createFeedbackInboxClient(
  config: FeedbackInboxConfig,
  fetchImpl: typeof fetch = fetch
): FeedbackInboxClient {
  const root = `${config.baseUrl}/api/feedback-inbox`;

  async function send<T>(
    url: string,
    schema: z.ZodType<T>,
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
    if (res.status === 200) {
      const parsed = schema.safeParse(json);
      return parsed.success
        ? { ok: true, data: parsed.data }
        : { ok: false, reason: "unavailable" };
    }
    if (res.status === 409) {
      const conflict = FeedbackConflictSchema.safeParse(json);
      return conflict.success
        ? { ok: false, reason: "conflict", current: conflict.data.current }
        : { ok: false, reason: "unavailable" };
    }
    if (res.status === 404) return { ok: false, reason: "not_found" };
    if (res.status === 400) return { ok: false, reason: "invalid" };
    return { ok: false, reason: "unavailable" };
  }

  function itemUrl(id: string): string | null {
    return IdSchema.safeParse(id).success
      ? `${root}/${encodeURIComponent(id)}`
      : null;
  }

  return {
    list(filters) {
      const qs = feedbackInboxFiltersToQuery(filters).toString();
      return send(qs ? `${root}?${qs}` : root, FeedbackInboxListSchema);
    },
    counts() {
      return send(`${root}/counts`, FeedbackCountsSchema);
    },
    async get(id) {
      const url = itemUrl(id);
      if (url === null) return { ok: false, reason: "not_found" };
      return send(url, FeedbackInboxItemSchema);
    },
    async patch(id, body, actor) {
      const url = itemUrl(id);
      if (url === null) return { ok: false, reason: "not_found" };
      return send(url, FeedbackInboxItemSchema, {
        method: "PATCH",
        body,
        actor,
      });
    },
  };
}
