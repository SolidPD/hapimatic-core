// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

// User notifications (issue #4913, epic #4912 — Lane 2). This module is the
// cross-package contract for the server `notify()` service, the `notifications`
// table, its REST surface and the `notification` SyncEvent: the kind taxonomy,
// the per-kind defaults producers never re-decide, the `notify()` input, and the
// stored-row schema the web client reads.
//
// Do NOT import `./schemas` here: `schemas.ts` imports this module for the
// SyncEvent union, so the reverse import would be a cycle.

/**
 * Every notification kind. The first five match the existing push toggles
 * (`web/src/lib/notificationPreferences.ts`); the rest are the event kinds that
 * today only toast.
 */
export const NOTIFICATION_KINDS = [
  "permission",
  "question",
  "ready",
  "stall",
  "usage",
  "tool-error",
  "prompt-blocked",
  "api-error",
  "account-unrefreshable",
  "session-restart-failed",
  "spawn-failed",
  "waiting-for-slot",
  "loops-resuming",
  "model-reverted",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_SEVERITIES = ["info", "warn", "error"] as const;

export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/**
 * How a kind's dedupe key is derived when the producer passes none:
 * - `session`: one open row per (namespace, kind, session);
 * - `kind`: one open row per (namespace, kind) — for account- or node-scoped kinds;
 * - `none`: never coalesce.
 */
export type NotificationDedupeStrategy = "session" | "kind" | "none";

export type NotificationKindDefaults = {
  severity: NotificationSeverity;
  dedupe: NotificationDedupeStrategy;
  /**
   * The service worker's push `data.type` for this kind, or `null` when the
   * kind never pushes. Only types `getPreferenceKeyForType`
   * (`web/src/lib/pushDisplayGate.ts`) maps may appear here: the service worker
   * displays an unmapped type regardless of the user's toggles.
   */
  pushType: string | null;
};

/** The per-kind defaults. Producers pass a kind and a title; the service owns the rest. */
export const NOTIFICATION_KIND_DEFAULTS: Record<
  NotificationKind,
  NotificationKindDefaults
> = {
  permission: {
    severity: "info",
    dedupe: "session",
    pushType: "permission-request",
  },
  question: { severity: "info", dedupe: "session", pushType: "question" },
  ready: { severity: "info", dedupe: "session", pushType: "ready" },
  stall: { severity: "warn", dedupe: "session", pushType: "stall-detected" },
  usage: { severity: "warn", dedupe: "kind", pushType: "usage-threshold" },
  "tool-error": { severity: "warn", dedupe: "session", pushType: null },
  "prompt-blocked": { severity: "warn", dedupe: "session", pushType: null },
  "api-error": { severity: "warn", dedupe: "session", pushType: null },
  // #4914: the three terminal kinds are never coalesced — each occurrence is
  // its own row (one per refused account, failed restart or failed spawn).
  "account-unrefreshable": {
    severity: "error",
    dedupe: "none",
    pushType: null,
  },
  "session-restart-failed": {
    severity: "error",
    dedupe: "none",
    pushType: null,
  },
  "spawn-failed": { severity: "error", dedupe: "none", pushType: null },
  "waiting-for-slot": { severity: "info", dedupe: "session", pushType: null },
  "loops-resuming": { severity: "info", dedupe: "session", pushType: null },
  "model-reverted": { severity: "warn", dedupe: "session", pushType: null },
};

/** A repeat within this window of an open row's `last_at` coalesces into it. */
export const COALESCE_WINDOW_MS = 60_000;

/** Rows whose `last_at` is older than this are purged and never returned. */
export const NOTIFICATION_TTL_MS = 48 * 60 * 60 * 1000;

/** Largest page `GET /api/notifications` returns. */
export const NOTIFICATION_LIST_MAX_LIMIT = 200;

/** Deepest `offset` `GET /api/notifications` accepts; deeper answers 400. */
export const NOTIFICATION_LIST_MAX_OFFSET = 1000;

/**
 * Largest `limit` a peer's list receiver accepts. The hub asks each peer for
 * its top `offset + limit` rows, so this is derived from the two caps above and
 * a valid hub page can never exceed what a peer will answer.
 */
export const NOTIFICATION_PEER_LIST_MAX =
  NOTIFICATION_LIST_MAX_LIMIT + NOTIFICATION_LIST_MAX_OFFSET;

/** Input to the server `notify()` service. */
export type NotifyInput = {
  kind: NotificationKind;
  title: string;
  namespace: string;
  /** Overrides the kind's default severity (e.g. `api-error` give-up is `error`). */
  severity?: NotificationSeverity;
  body?: string | null;
  sessionId?: string | null;
  /** Overrides the kind's default dedupe key (e.g. one row per account). */
  dedupeKey?: string | null;
  /**
   * `"none"` turns coalescing off for this call (e.g. an `api-error` give-up,
   * #4914), whatever the kind's default. Wins over `dedupeKey`. The only value
   * honoured, so the only one the type admits.
   */
  dedupe?: "none";
  context?: Record<string, unknown> | null;
  /**
   * `false` = skip every `notifications` table access and the push, and mirror
   * to the error log without persisting (#3631 held-lock windows). Default `true`.
   */
  persist?: boolean;
  /**
   * `false` = skip the warn-plus `error_logs` mirror, for a producer that has
   * already written its own row (`POST /cli/error-reports`, #4914). Default `true`.
   */
  mirror?: boolean;
};

/**
 * The dedupe key for a notification: `null` when the call's strategy is
 * `"none"`, else the explicit override when given, else the kind's strategy.
 * `null` means the row never coalesces. An empty session id counts as no
 * session.
 */
export function computeDedupeKey(
  kind: NotificationKind,
  sessionId?: string | null,
  override?: string | null,
  strategy?: "none"
): string | null {
  if (strategy === "none") return null;
  if (override) return override;
  switch (NOTIFICATION_KIND_DEFAULTS[kind].dedupe) {
    case "session":
      return `${kind}:${sessionId || ""}`;
    case "kind":
      return kind;
    case "none":
      return null;
  }
}

/**
 * A notification that is never raised because its text marks a known-benign
 * event. The event still reaches the error log through its own producer; only
 * the user-facing row (inbox, badge, pop-up, push) is dropped.
 */
export type NotificationSuppressionRule = {
  kind: NotificationKind;
  field: "title" | "body";
  includes: string;
  reason: string;
};

/**
 * Kind-level suppressions applied by `notify()` (#4914). Keep this set minimal:
 * every rule hides a whole class from the user. These are the #1612 R5 classes
 * the web tool-error listener also filters client-side (`web/src/App.tsx`)
 * until Sub C (#4915) removes that listener.
 */
export const NOTIFICATION_SUPPRESSIONS: readonly NotificationSuppressionRule[] =
  [
    {
      kind: "tool-error",
      field: "body",
      includes: "Permission denied for Bash",
      reason: "#1612 R5: a hook guard blocking a command as designed",
    },
    {
      kind: "tool-error",
      field: "body",
      includes: "No such tool available",
      reason: "#1612 R5: a tool-routing mistake, not a tool failure",
    },
  ];

/** True when a `NOTIFICATION_SUPPRESSIONS` rule drops this notification. */
export function isNotificationSuppressed(
  input: Pick<NotifyInput, "kind" | "title" | "body">
): boolean {
  return NOTIFICATION_SUPPRESSIONS.some(rule => {
    if (rule.kind !== input.kind) return false;
    const text = rule.field === "title" ? input.title : input.body;
    return typeof text === "string" && text.includes(rule.includes);
  });
}

/** A stored notification as returned by the REST routes and the SyncEvent. */
export const StoredNotificationSchema = z.object({
  id: z.string(),
  namespace: z.string(),
  kind: z.enum(NOTIFICATION_KINDS),
  severity: z.enum(NOTIFICATION_SEVERITIES),
  title: z.string(),
  body: z.string().nullable(),
  sessionId: z.string().nullable(),
  /** The session's title when the row was created, kept after the session is gone. */
  sessionTitle: z.string().nullable(),
  /** JSON-serialized context, as in `error_logs`. */
  context: z.string().nullable(),
  dedupeKey: z.string().nullable(),
  count: z.number().int(),
  firstAt: z.number(),
  lastAt: z.number(),
  readAt: z.number().nullable(),
  dismissedAt: z.number().nullable(),
  /** Set by a federation hub on rows it fetched from a peer; never stored. */
  nodeId: z.string().optional(),
  /** `true` on a row that was never persisted (`persist: false` or a store failure). */
  ephemeral: z.boolean().optional(),
});

export type StoredNotification = z.infer<typeof StoredNotificationSchema>;

export const NotificationListResponseSchema = z.object({
  notifications: z.array(StoredNotificationSchema),
});

export type NotificationListResponse = z.infer<
  typeof NotificationListResponseSchema
>;

export const NotificationUnreadCountResponseSchema = z.object({
  count: z.number().int(),
});

export type NotificationUnreadCountResponse = z.infer<
  typeof NotificationUnreadCountResponseSchema
>;

/**
 * The badge fields every Web Push payload may carry (issue #4921). R5: the
 * sending node's unread count (rows neither read nor dismissed) at send time,
 * stamped once per namespace by `PushService.sendToNamespace`; omitted when it
 * cannot be computed. R6 (the app badge = this count) was replaced by N1 on
 * 2026-10-29: the service worker sets the badge to 1 on a displayed push and
 * opening the app clears it, so no client reads this field today.
 */
export type PushBadgeFields = {
  unreadCount?: number;
};
