// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6208: tell a session keepalive apart from a real session change.
 *
 * The server re-broadcasts every live session about every 10–12 s
 * (`server/src/sync/sessionCache.ts`, the `now - lastBroadcastAt > 10_000`
 * arm) with a fixed set of fields. Before #6208 the web client refetched both
 * session lists and the open session on every one of those events, and each
 * refetch re-rendered the whole chat. With ~24 live sessions across the mesh
 * that is several refetches a second per tab.
 *
 * The classifier compares the event against what the client already has
 * cached: when nothing the UI shows would change, the event is a keepalive and
 * only `activeAt` needs to move (it drives the 60 s stale / 180 s unresponsive
 * thinking indicators). Any other event shape, or any differing value, keeps
 * the refetch path.
 */
import { projectBackgroundAgentsSummary } from "@hapi/protocol";
import type { Session, SessionResponse, SessionSummary } from "@/types/api";

/**
 * The exact key set of the server's keepalive `session-updated` payload. A key
 * the server emits but this set lacks makes every keepalive take the refetch
 * path; `server/src/sync/sessionCache.test.ts` pins the emitted set.
 */
export const KEEPALIVE_KEYS: ReadonlySet<string> = new Set([
  "activeAt",
  "updatedAt",
  "thinking",
  "blockedOnTuiPrompt",
  "rateLimited",
  "backgroundAgents",
  "thinkingStartedAt",
  "serverAccumulatedMs",
  "permissionMode",
  "modelMode",
  "effort",
  // Issue #6166: the effort the Claude process applies, its model, and the
  // effort that process was launched with.
  "appliedEffort",
  "appliedModel",
  "appliedForEffort",
  "rawModel",
  "resolvedModel",
  "contextWindowTokens",
  "contextUsedTokens",
  "contextPercentage",
]);

/**
 * Smallest `activeAt` advance worth writing into the caches. `activeAt` only
 * feeds the thinking-staleness check (60 s / 180 s), so 20 s keeps it accurate
 * while sparing a list re-render on every keepalive.
 */
export const ACTIVE_AT_PATCH_MIN_MS = 20_000;

/** Shortest wait a poll schedules once it is already due (e.g. after a hidden tab). */
export const POLL_CATCH_UP_MIN_MS = 2_000;

/**
 * Issue #6208: the time left until a poll of `intervalMs` is due, counted from
 * the query's last real fetch (success or failure), not from its last cache
 * write. Use it as a `refetchInterval` function.
 *
 * TanStack restarts an observer's `refetchInterval` timer on every update to
 * its query, `setQueryData` included (query-core `queryObserver.ts`
 * `onQueryUpdate` → `#updateTimers`). The `activeAt` patches land at least
 * every ~24 s while any session is live, so a fixed 30 s interval was restarted
 * before it could fire and the list polls stopped entirely. Returning the
 * remaining time makes each restart keep the original schedule. The patches
 * pass the query's previous `dataUpdatedAt`, so they do not count as a fetch.
 */
export function msUntilPollDue(
  intervalMs: number,
  state: { dataUpdatedAt: number; errorUpdatedAt: number } | undefined,
  now: number = Date.now()
): number {
  const lastFetch = Math.max(
    state?.dataUpdatedAt ?? 0,
    state?.errorUpdatedAt ?? 0
  );
  if (lastFetch <= 0) return intervalMs;
  const remaining = intervalMs - (now - lastFetch);
  return Math.min(intervalMs, Math.max(POLL_CATCH_UP_MIN_MS, remaining));
}

/**
 * Keys compared against the cached summary row. `activeAt` is the field a
 * keepalive is allowed to move; `effort`, `rawModel` and `appliedModel` are
 * checked against the session detail; `backgroundAgents` is compared after
 * projection.
 */
const SUMMARY_COMPARED_KEYS = [...KEEPALIVE_KEYS].filter(
  key =>
    key !== "activeAt" &&
    key !== "effort" &&
    key !== "rawModel" &&
    key !== "appliedModel" &&
    key !== "backgroundAgents"
);

/** Issue #6166: the applied read-back, also compared against a cached detail. */
const DETAIL_APPLIED_KEYS = [
  "appliedEffort",
  "appliedModel",
  "appliedForEffort",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

/**
 * Structural equality with JSON semantics: `null` and `undefined` are the same
 * (the wire drops `undefined`), at every depth.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== "object" || typeof b !== "object") return Object.is(a, b);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, index) => sameValue(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!sameValue(left[key], right[key])) return false;
  }
  return true;
}

function projectBackgroundAgents(value: unknown): unknown {
  if (value == null) return null;
  if (!isPlainObject(value)) return value;
  return projectBackgroundAgentsSummary(
    value as NonNullable<Session["backgroundAgents"]>
  );
}

/**
 * True when `data` has the keepalive's shape: a plain object with a numeric
 * `activeAt` and no key outside {@link KEEPALIVE_KEYS}. Says nothing about
 * whether its values match any cache.
 */
export function isKeepaliveShaped(
  data: unknown
): data is Record<string, unknown> & { activeAt: number } {
  if (!isPlainObject(data)) return false;
  if (typeof data.activeAt !== "number") return false;
  return Object.keys(data).every(key => KEEPALIVE_KEYS.has(key));
}

/**
 * True only when `data` is a keepalive whose every field already matches the
 * cached session: `data` is a plain object with a numeric `activeAt`, carries
 * no key outside {@link KEEPALIVE_KEYS}, `row` exists and is active, and every
 * keepalive field equals the row (a key absent from `data` counts as
 * `undefined`, because the server emits the full key set and JSON drops
 * `undefined`). When the session detail is cached, `effort`, `rawModel`, the
 * applied read-back (#6166) and the full `backgroundAgents` snapshot must also
 * match it.
 */
export function isKeepaliveOnlyUpdate(
  data: unknown,
  row: SessionSummary | undefined,
  detail: Session | undefined
): boolean {
  if (!isKeepaliveShaped(data)) return false;
  if (!row || row.active !== true) return false;

  const cached = row as unknown as Record<string, unknown>;
  for (const key of SUMMARY_COMPARED_KEYS) {
    if (!sameValue(data[key], cached[key])) return false;
  }

  const backgroundAgents = data.backgroundAgents;
  if (backgroundAgents != null && !isPlainObject(backgroundAgents)) {
    return false;
  }
  if (
    !sameValue(
      projectBackgroundAgents(backgroundAgents),
      row.backgroundAgents ?? null
    )
  ) {
    return false;
  }

  if (detail) {
    if (!sameValue(data.effort, detail.effort)) return false;
    if (!sameValue(data.rawModel, detail.rawModel)) return false;
    if (!sameValue(backgroundAgents, detail.backgroundAgents)) return false;
    const cachedDetail = detail as unknown as Record<string, unknown>;
    for (const key of DETAIL_APPLIED_KEYS) {
      if (!sameValue(data[key], cachedDetail[key])) return false;
    }
  }
  return true;
}

/**
 * Write a newer `activeAt` into one row of a `{ sessions }` list cache.
 * Returns `data` itself unless the row exists and `activeAt` advanced by at
 * least {@link ACTIVE_AT_PATCH_MIN_MS}, so the caller can skip the write.
 * Writing even the same object back still updates the query and restarts its
 * observers' poll timers, so callers compare identity before writing.
 */
export function patchSessionActiveAt<T extends { sessions: SessionSummary[] }>(
  data: T | undefined,
  sessionId: string,
  activeAt: number
): T | undefined {
  if (!data) return data;
  const index = data.sessions.findIndex(session => session.id === sessionId);
  if (index === -1) return data;
  const row = data.sessions[index];
  if (activeAt - row.activeAt < ACTIVE_AT_PATCH_MIN_MS) return data;
  const sessions = data.sessions.slice();
  sessions[index] = { ...row, activeAt };
  return { ...data, sessions };
}

/** The detail-cache counterpart of {@link patchSessionActiveAt}. */
export function patchSessionDetailActiveAt(
  data: SessionResponse | undefined,
  activeAt: number
): SessionResponse | undefined {
  if (!data) return data;
  if (activeAt - data.session.activeAt < ACTIVE_AT_PATCH_MIN_MS) return data;
  return { ...data, session: { ...data.session, activeAt } };
}
