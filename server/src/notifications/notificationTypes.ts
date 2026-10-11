// SPDX-License-Identifier: AGPL-3.0-only
import type { Session } from "../sync/syncEngine";
import type { ErrorLogger } from "../logging/errorLogger";

export type NotificationChannel = {
  sendReady: (session: Session) => Promise<void>;
  sendPermissionRequest: (session: Session) => Promise<void>;
  sendQuestion?: (session: Session, questionSummary: string) => Promise<void>;
  sendError?: (session: Session, errorMessage: string) => Promise<void>;
};

export type NotificationHubOptions = {
  readyCooldownMs?: number;
  permissionDebounceMs?: number;
  questionDebounceMs?: number;
  errorLogger?: ErrorLogger | null;
};
