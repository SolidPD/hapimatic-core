// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";

import {
  computeDedupeKey,
  isNotificationSuppressed,
  NOTIFICATION_KIND_DEFAULTS,
  NOTIFICATION_TTL_MS,
  type NotificationSeverity,
  type NotifyInput,
  type StoredNotification,
} from "@hapi/protocol";

import type { ErrorLogger } from "../logging/errorLogger";
import type { PushPayload, PushService } from "../push/pushService";
import { buildSessionPushPayload } from "../push/sessionPushPayload";
import type { NotificationStore } from "../store/notificationStore";
import type { NotificationListOptions } from "../store/notifications";
import type { SyncEngine, SyncEvent } from "../sync/syncEngine";
import {
  salvageFields,
  SERIALIZATION_ERROR_KEY,
  stringifyOrNull,
} from "../utils/jsonSalvage";
import { getSessionName } from "./sessionInfo";

// The single server entry point for user-facing notifications (issue #4913,
// epic #4912 — Lane 2). `notify()` persists (or coalesces) the row, emits one
// `notification` SyncEvent, pushes the five push kinds on insert, and mirrors
// warn-and-above into `error_logs`. It never throws, in the ErrorLogger
// tradition. Producers call it through `SyncEngine.notifyUser` (#4914), with
// per-kind inputs built in `producerNotifications.ts`.

const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 2000;
const MAX_CONTEXT_LENGTH = 4000;
const CLIP_SUFFIX = "...";
/** A string clipped to just the suffix: shorter values are never clipped. */
const MIN_CLIPPED_LENGTH = JSON.stringify(CLIP_SUFFIX).length;
const TRUNCATED_KEY = "contextTruncated";

export type NotificationServiceDeps = {
  store: NotificationStore | null;
  getSyncEngine: () => SyncEngine | null;
  getPushService: () => PushService | null;
  errorLogger: ErrorLogger;
  getNow?: () => number;
};

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 3) + "...";
}

function serializedLength(value: unknown): number {
  return stringifyOrNull(value)?.length ?? 0;
}

/**
 * A prefix of `value` whose serialized form, suffix included, fits
 * `maxSerialized` characters, found by binary search on the serialized length
 * because an escape expands (`\u0001` is six characters), and never split
 * inside a surrogate pair. It is the longest such prefix for BMP text; for
 * astral text (emoji) it can stop up to two characters short, because a lone
 * high surrogate serializes to six characters.
 */
function clipToSerialized(value: string, maxSerialized: number): string {
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const length = JSON.stringify(value.slice(0, mid) + CLIP_SUFFIX).length;
    if (length <= maxSerialized) lo = mid;
    else hi = mid - 1;
  }
  let end = lo;
  if (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return value.slice(0, end) + CLIP_SUFFIX;
}

const MARKER_KEYS = new Set([TRUNCATED_KEY, SERIALIZATION_ERROR_KEY]);

/**
 * A copy of `fields` with its string values clipped, longest first, each only
 * by what is still over `max`. The result may still be over when the strings
 * alone cannot absorb the overflow.
 */
function clipStringFields(
  fields: Record<string, unknown>,
  max: number
): Record<string, unknown> {
  const out = { ...fields };
  const stringKeys = Object.keys(out)
    .filter(key => !MARKER_KEYS.has(key) && typeof out[key] === "string")
    .sort((a, b) => serializedLength(out[b]) - serializedLength(out[a]));
  for (const key of stringKeys) {
    const overflow = JSON.stringify(out).length - max;
    if (overflow <= 0) break;
    const value = out[key] as string;
    const length = serializedLength(value);
    // Sorted longest first: a value no longer than the suffix cannot shrink.
    if (length <= MIN_CLIPPED_LENGTH) break;
    out[key] = clipToSerialized(
      value,
      Math.max(length - overflow, MIN_CLIPPED_LENGTH)
    );
  }
  return out;
}

/**
 * Serialize a notification context so the stored string always parses as JSON
 * and fits `max` characters for any `max` of at least 58 (the default is
 * 4,000; below 58 the fallback marker object can exceed it) (issue #5696).
 * JSON text is never cut. An over-cap context has its longest string fields
 * clipped, by serialized length, to fit. Only when clipping every string cannot make it fit is a field
 * dropped — the largest non-string field first, then the largest string — and
 * the clip is retried on the remaining, unclipped fields. A shortened context
 * carries `contextTruncated: true`; a context that does not serialize keeps the
 * fields that do and carries `contextSerializationError: true`. A context at or
 * under the cap is exactly `JSON.stringify(context)`.
 */
export function serializeContext(
  context: Record<string, unknown>,
  max: number = MAX_CONTEXT_LENGTH
): string {
  let source = context;
  let serialized = stringifyOrNull(context);
  if (serialized === null) {
    source = { ...salvageFields(context), [SERIALIZATION_ERROR_KEY]: true };
    serialized = JSON.stringify(source);
  }
  if (serialized.length <= max) return serialized;

  const working: Record<string, unknown> = { ...source, [TRUNCATED_KEY]: true };
  for (;;) {
    serialized = JSON.stringify(clipStringFields(working, max));
    if (serialized.length <= max) return serialized;

    // Clipping cannot fit: drop one field from the unclipped set and retry. A
    // non-string goes first, since a string can still be clipped instead.
    const bySize = Object.keys(working)
      .filter(key => !MARKER_KEYS.has(key))
      .sort(
        (a, b) => serializedLength(working[b]) - serializedLength(working[a])
      );
    const victim =
      bySize.find(key => typeof working[key] !== "string") ?? bySize[0];
    if (victim === undefined) return JSON.stringify({ [TRUNCATED_KEY]: true });
    delete working[victim];
  }
}

export class NotificationService {
  private readonly store: NotificationStore | null;
  private readonly getSyncEngine: () => SyncEngine | null;
  private readonly getPushService: () => PushService | null;
  private readonly errorLogger: ErrorLogger;
  private readonly getNow: () => number;

  constructor(deps: NotificationServiceDeps) {
    this.store = deps.store;
    this.getSyncEngine = deps.getSyncEngine;
    this.getPushService = deps.getPushService;
    this.errorLogger = deps.errorLogger;
    this.getNow = deps.getNow ?? Date.now;
  }

  /**
   * Record a notification and fan it out. Never throws. Returns the row, or
   * `null` when a `NOTIFICATION_SUPPRESSIONS` rule drops it or the kind is
   * unknown (nothing is persisted, emitted, pushed or mirrored then — #4914).
   * `persist: false` touches no `notifications` table, sends no push, and
   * mirrors to the log without persisting (#3631 held-lock windows); the
   * returned row is then `ephemeral`. `mirror: false` skips the warn-plus mirror
   * for a producer that wrote its own `error_logs` row.
   */
  notify(input: NotifyInput): StoredNotification | null {
    const now = this.getNow();
    const defaults = Object.hasOwn(NOTIFICATION_KIND_DEFAULTS, input.kind)
      ? NOTIFICATION_KIND_DEFAULTS[input.kind]
      : undefined;
    if (!defaults) {
      // A runtime kind outside the table (#4914 hardening): never throw.
      console.error(
        "[NotificationService] Unknown notification kind:",
        String(input.kind)
      );
      return null;
    }
    if (isNotificationSuppressed(input)) return null;
    const severity = input.severity ?? defaults.severity;
    const sessionId = input.sessionId ? input.sessionId : null;
    const persist = input.persist !== false;

    // #5696: bounded by serialized length, so a stored context always parses.
    let context: string | null = null;
    if (input.context != null) {
      try {
        context = serializeContext(input.context);
      } catch {
        // serializeContext does not throw by design; this keeps notify()
        // non-throwing even for a context whose getters throw on a re-read.
        context = JSON.stringify({ [SERIALIZATION_ERROR_KEY]: true });
      }
    }

    const fields = {
      namespace: input.namespace,
      kind: input.kind,
      severity,
      title: truncate(input.title, MAX_TITLE_LENGTH),
      body: input.body != null ? truncate(input.body, MAX_BODY_LENGTH) : null,
      sessionId,
      sessionTitle: this.snapshotSessionTitle(sessionId, input.namespace),
      context,
      dedupeKey: computeDedupeKey(
        input.kind,
        sessionId,
        input.dedupeKey,
        input.dedupe
      ),
    };

    let notification: StoredNotification | null = null;
    let inserted = false;
    let persistFailed = false;
    if (persist && this.store) {
      try {
        const result = this.store.createOrCoalesce(fields, now);
        notification = result.notification;
        inserted = !result.coalesced;
      } catch (err) {
        persistFailed = true;
        // Console only: an error_logs write here would be another store write on
        // the same connection that just failed (#3631).
        console.error(
          "[NotificationService] Failed to persist notification:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }
    if (!notification) {
      notification = {
        id: randomUUID(),
        ...fields,
        count: 1,
        firstAt: now,
        lastAt: now,
        readAt: null,
        dismissedAt: null,
        ephemeral: true,
      };
    }

    this.emit(notification);
    if (inserted && defaults.pushType !== null) {
      this.push(notification, defaults.pushType);
    }
    if (
      (severity === "warn" || severity === "error") &&
      input.mirror !== false
    ) {
      // The mirror logs THIS call (its severity and title), and never persists
      // after the store write failed — that would be a second busy wait on the
      // same connection (#3631, sink #5648 S-4).
      this.mirror(notification, input, severity, persist && !persistFailed);
    }
    return notification;
  }

  list(
    namespace: string,
    options: NotificationListOptions
  ): StoredNotification[] {
    return this.store?.list(namespace, options, this.getNow()) ?? [];
  }

  countUnread(namespace: string): number {
    return this.store?.countUnread(namespace, this.getNow()) ?? 0;
  }

  /** Mark read and announce the updated row; `null` when not in the namespace. */
  markRead(namespace: string, id: string): StoredNotification | null {
    const row = this.store?.markRead(namespace, id, this.getNow()) ?? null;
    if (row) this.emit(row);
    return row;
  }

  /** Dismiss and announce the updated row; `null` when not in the namespace. */
  dismiss(namespace: string, id: string): StoredNotification | null {
    const row = this.store?.dismiss(namespace, id, this.getNow()) ?? null;
    if (row) this.emit(row);
    return row;
  }

  /** Dismiss every row in the namespace; announces once when anything changed. */
  dismissAll(namespace: string): number {
    const now = this.getNow();
    const changed = this.store?.dismissAll(namespace, now) ?? 0;
    if (changed > 0) {
      this.publish({
        type: "notifications-cleared",
        namespace,
        dismissedAt: now,
      });
    }
    return changed;
  }

  /** Delete rows past the 48-hour TTL; returns how many were removed. */
  purgeExpired(): number {
    return (
      this.store?.deleteOlderThan(this.getNow() - NOTIFICATION_TTL_MS) ?? 0
    );
  }

  /**
   * The session's title at creation time. Cache-only and namespace-scoped
   * (#4914): a session outside the row's namespace, or not cached, yields
   * `null` rather than a foreign title or a DB read on the notify path.
   */
  private snapshotSessionTitle(
    sessionId: string | null,
    namespace: string
  ): string | null {
    if (!sessionId) return null;
    try {
      const session = this.getSyncEngine()?.getSessionByNamespace(
        sessionId,
        namespace
      );
      return session ? getSessionName(session) : null;
    } catch {
      return null;
    }
  }

  /** The session's emoji for the push title; cache-only, `null` on any miss. */
  private sessionEmoji(sessionId: string, namespace: string): string | null {
    try {
      return (
        this.getSyncEngine()?.getSessionByNamespace(sessionId, namespace)
          ?.emoji ?? null
      );
    } catch {
      return null;
    }
  }

  private emit(notification: StoredNotification): void {
    this.publish({
      type: "notification",
      namespace: notification.namespace,
      notification,
    });
  }

  private publish(
    event: Extract<
      SyncEvent,
      { type: "notification" | "notifications-cleared" }
    >
  ): void {
    try {
      this.getSyncEngine()?.handleRealtimeEvent(event);
    } catch (err) {
      console.error(
        "[NotificationService] Failed to emit SyncEvent:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private push(notification: StoredNotification, pushType: string): void {
    const pushService = this.getPushService();
    if (!pushService) return;
    const sessionId = notification.sessionId;
    // #4921 R4: a session-scoped push is titled by its session, with the
    // notification's own title as the body; an account-global one is unchanged.
    const payload: PushPayload = sessionId
      ? buildSessionPushPayload({
          kind: notification.kind,
          type: pushType,
          sessionId,
          sessionTitle: notification.sessionTitle,
          sessionEmoji: this.sessionEmoji(sessionId, notification.namespace),
          body: notification.title,
        })
      : {
          title: notification.title,
          body: notification.body ?? "",
          tag: notification.kind,
          data: { type: pushType, url: "/" },
        };
    try {
      pushService
        .sendToNamespace(notification.namespace, payload)
        .catch(err => {
          console.error(
            "[NotificationService] Push failed:",
            err instanceof Error ? err.message : String(err)
          );
        });
    } catch (err) {
      console.error(
        "[NotificationService] Push failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private mirror(
    notification: StoredNotification,
    input: NotifyInput,
    severity: NotificationSeverity,
    persist: boolean
  ): void {
    try {
      this.errorLogger.log(severity, truncate(input.title, MAX_TITLE_LENGTH), {
        category: `notification:${notification.kind}`,
        sessionId: notification.sessionId,
        namespace: notification.namespace,
        // The producer's context first, so it cannot overwrite these two.
        context: {
          ...(input.context ?? {}),
          notificationId: notification.id,
          count: notification.count,
        },
        ...(persist ? {} : { persist: false }),
      });
    } catch {
      // ErrorLogger is non-throwing by contract; this guard keeps notify()
      // non-throwing even if that ever regresses.
    }
  }
}
