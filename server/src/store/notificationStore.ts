// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import type { StoredNotification } from "@hapi/protocol";

import {
  countUnread,
  createOrCoalesce,
  type CreateOrCoalesceResult,
  deleteOlderThan,
  dismiss,
  dismissAll,
  getById,
  list,
  markRead,
  type NewNotificationRow,
  type NotificationListOptions,
} from "./notifications";

/** Store for the `notifications` table (issue #4913). */
export class NotificationStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  createOrCoalesce(
    row: NewNotificationRow,
    now?: number
  ): CreateOrCoalesceResult {
    return createOrCoalesce(this.db, row, now);
  }

  list(
    namespace: string,
    options: NotificationListOptions,
    now?: number
  ): StoredNotification[] {
    return list(this.db, namespace, options, now);
  }

  /**
   * Unread (and undismissed) rows in the namespace. #4921 binds this as the
   * `PushService` unread-count provider, so keep the name.
   */
  countUnread(namespace: string, now?: number): number {
    return countUnread(this.db, namespace, now);
  }

  getById(namespace: string, id: string): StoredNotification | null {
    return getById(this.db, namespace, id);
  }

  markRead(
    namespace: string,
    id: string,
    now?: number
  ): StoredNotification | null {
    return markRead(this.db, namespace, id, now);
  }

  dismiss(
    namespace: string,
    id: string,
    now?: number
  ): StoredNotification | null {
    return dismiss(this.db, namespace, id, now);
  }

  dismissAll(namespace: string, now?: number): number {
    return dismissAll(this.db, namespace, now);
  }

  deleteOlderThan(cutoffMs: number): number {
    return deleteOlderThan(this.db, cutoffMs);
  }
}
