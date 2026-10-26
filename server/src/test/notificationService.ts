// SPDX-License-Identifier: AGPL-3.0-only
import { ErrorLogger } from "../logging/errorLogger";
import { NotificationService } from "../notifications/notificationService";
import type { Store } from "../store";
import type { SyncEngine } from "../sync/syncEngine";

/**
 * Issue #4914: wire a real NotificationService over a test's in-memory store
 * into a real SyncEngine, so a producer test can assert the stored row. The
 * node identity is the one an `account-unrefreshable` row then carries
 * (`nodeId: "rp1"`, `nodeLabel: "RP1"`).
 */
export function wireTestNotifications(engine: SyncEngine, store: Store): void {
  engine.setNotificationService(
    new NotificationService({
      store: store.notifications,
      getSyncEngine: () => engine,
      getPushService: () => null,
      errorLogger: new ErrorLogger(store.errorLogs),
    }),
    { getLocalNode: () => ({ nodeId: "rp1", nodeLabel: "RP1" }) }
  );
}
