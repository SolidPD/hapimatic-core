// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session Persistence Module
 *
 * Provides persistence for Hapimatic sessions, enabling recovery after
 * server restarts and system reboots.
 */

export { SessionStore, createSessionStore } from "./sessionStore";
export type {
  PersistedSession,
  SessionStoreData,
  SessionStoreOptions,
  SessionStatus,
} from "./types";
export { CURRENT_SCHEMA_VERSION, DEFAULT_STORE_DATA } from "./types";
