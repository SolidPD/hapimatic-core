// SPDX-License-Identifier: AGPL-3.0-only
import * as webPush from "web-push";
import type { PushBadgeFields } from "@hapi/protocol";
import type { Store } from "../store";
import type { VapidKeys } from "../config/vapidKeys";
import type { ErrorLogger } from "../logging/errorLogger";

export type PushPayload = {
  title: string;
  body: string;
  tag?: string;
  data?: {
    type: string;
    // Optional: session-scoped notifications set this; account-global ones
    // (e.g. usage-threshold alerts, #1863) omit it. The service worker's
    // notificationclick handler navigates via `data.url`, not sessionId.
    sessionId?: string;
    url: string;
  };
} & PushBadgeFields;

/** The sending node's unread count for a namespace (#4921 R5). */
export type UnreadCountProvider = (namespace: string) => number;

type StoredSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

type PushSubscription = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

/** Host part of a push endpoint, safe to log (the full URL is a capability). */
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "invalid-endpoint";
  }
}

export class PushService {
  private unreadCountProvider: UnreadCountProvider | null = null;

  constructor(
    private readonly vapidKeys: VapidKeys,
    private readonly subject: string,
    private readonly store: Store,
    private readonly errorLogger?: ErrorLogger | null
  ) {
    webPush.setVapidDetails(
      this.subject,
      this.vapidKeys.publicKey,
      this.vapidKeys.privateKey
    );
  }

  /**
   * Bind the unread-count source (#4921). Late-bound because the notification
   * service is constructed after this service; `null` unbinds. When it yields
   * a count, that count overwrites any producer-supplied `unreadCount` (the
   * store is the one source of truth, and every push goes through
   * `sendToNamespace`); when it cannot, any producer value is stripped too, so
   * a push never carries an unverified count.
   */
  setUnreadCountProvider(provider: UnreadCountProvider | null): void {
    this.unreadCountProvider = provider;
  }

  async sendToAll(payload: PushPayload): Promise<void> {
    const namespaces = this.store.push.getDistinctNamespaces();
    for (const ns of namespaces) {
      await this.sendToNamespace(ns, payload);
    }
  }

  async sendToNamespace(
    namespace: string,
    payload: PushPayload
  ): Promise<void> {
    const subscriptions =
      this.store.push.getPushSubscriptionsByNamespace(namespace);
    if (subscriptions.length === 0) {
      return;
    }

    // One count per namespace, computed outside the per-subscription loop
    // (#4921 D4): every subscription in the namespace sees the same inbox.
    const unreadCount = this.safeUnreadCount(namespace);
    const { unreadCount: _producerCount, ...rest } = payload;
    const body = JSON.stringify(
      unreadCount === undefined ? rest : { ...rest, unreadCount }
    );
    await Promise.all(
      subscriptions.map(subscription => {
        return this.sendToSubscription(namespace, subscription, body);
      })
    );
  }

  /**
   * The provider's count, or `undefined` when unbound, throwing, or not a
   * non-negative integer — the field is then omitted, never guessed (#4921 R5).
   */
  private safeUnreadCount(namespace: string): number | undefined {
    const provider = this.unreadCountProvider;
    if (!provider) return undefined;
    let count: unknown;
    try {
      count = provider(namespace);
    } catch (error) {
      this.errorLogger?.warn("Push unread count unavailable", {
        category: "push",
        context: { namespace, error: String(error) },
      });
      return undefined;
    }
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      this.errorLogger?.warn("Push unread count invalid", {
        category: "push",
        context: { namespace, count: String(count) },
      });
      return undefined;
    }
    return count;
  }

  private async sendToSubscription(
    namespace: string,
    subscription: StoredSubscription,
    body: string
  ): Promise<void> {
    const pushSubscription: PushSubscription = {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.p256dh,
        auth: subscription.auth,
      },
    };

    try {
      await webPush.sendNotification(pushSubscription, body);
    } catch (error) {
      const statusCode =
        typeof (error as { statusCode?: unknown }).statusCode === "number"
          ? (error as { statusCode: number }).statusCode
          : null;

      // #4836: 404 and 410 both mean the push service has dropped this
      // subscription for good, so remove the stored row. Each prune is logged
      // with the endpoint HOST only — the full endpoint is a capability URL.
      if (statusCode === 404 || statusCode === 410) {
        this.store.push.removePushSubscription(
          namespace,
          subscription.endpoint
        );
        this.errorLogger?.info("Pruned gone push subscription", {
          category: "push-prune",
          context: {
            namespace,
            endpointHost: endpointHost(subscription.endpoint),
            statusCode,
          },
        });
        return;
      }

      // #4836: name the endpoint by host only — the full URL is a capability
      // and this line reaches error_logs and Sentry on every 429 / connect error.
      if (this.errorLogger) {
        this.errorLogger.error("Failed to send push notification", {
          category: "push",
          context: {
            error: String(error),
            statusCode,
            endpointHost: endpointHost(subscription.endpoint),
          },
        });
      } else {
        console.error("[PushService] Failed to send notification:", error);
      }
    }
  }
}
