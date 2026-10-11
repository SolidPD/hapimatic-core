// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session Store
 *
 * Manages persistence of session state to a JSON file.
 * Provides atomic operations with file locking to prevent race conditions.
 */

import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "@/ui/logger";
import type {
  PersistedSession,
  SessionStoreData,
  SessionStoreOptions,
  SessionStatus,
} from "./types";
import { CURRENT_SCHEMA_VERSION, DEFAULT_STORE_DATA } from "./types";

export class SessionStore {
  private readonly storePath: string;
  private readonly lockPath: string;
  private readonly createIfMissing: boolean;

  constructor(options: SessionStoreOptions) {
    this.storePath = options.storePath;
    this.lockPath = `${options.storePath}.lock`;
    this.createIfMissing = options.createIfMissing ?? true;

    // Ensure directory exists
    const dir = dirname(this.storePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Save a new session or update an existing one
   */
  async save(session: PersistedSession): Promise<void> {
    await this.withLock(async () => {
      const data = await this.readStore();
      const existingIndex = data.sessions.findIndex(
        s => s.hapiSessionId === session.hapiSessionId
      );

      if (existingIndex >= 0) {
        data.sessions[existingIndex] = session;
        logger.debug(
          `[SessionStore] Updated session: ${session.hapiSessionId}`
        );
      } else {
        data.sessions.push(session);
        logger.debug(
          `[SessionStore] Added new session: ${session.hapiSessionId}`
        );
      }

      data.updatedAt = new Date().toISOString();
      await this.writeStore(data);
    });
  }

  /**
   * Save multiple sessions at once (batch operation)
   */
  async saveAll(sessions: PersistedSession[]): Promise<void> {
    if (sessions.length === 0) return;

    await this.withLock(async () => {
      const data = await this.readStore();

      for (const session of sessions) {
        const existingIndex = data.sessions.findIndex(
          s => s.hapiSessionId === session.hapiSessionId
        );

        if (existingIndex >= 0) {
          data.sessions[existingIndex] = session;
        } else {
          data.sessions.push(session);
        }
      }

      data.updatedAt = new Date().toISOString();
      await this.writeStore(data);
      logger.debug(`[SessionStore] Saved ${sessions.length} sessions`);
    });
  }

  /**
   * Remove a session by its HAPI session ID
   */
  async remove(hapiSessionId: string): Promise<boolean> {
    return await this.withLock(async () => {
      const data = await this.readStore();
      const initialLength = data.sessions.length;
      data.sessions = data.sessions.filter(
        s => s.hapiSessionId !== hapiSessionId
      );

      if (data.sessions.length < initialLength) {
        data.updatedAt = new Date().toISOString();
        await this.writeStore(data);
        logger.debug(`[SessionStore] Removed session: ${hapiSessionId}`);
        return true;
      }

      logger.debug(
        `[SessionStore] Session not found for removal: ${hapiSessionId}`
      );
      return false;
    });
  }

  /**
   * Get all persisted sessions
   */
  async getAll(): Promise<PersistedSession[]> {
    const data = await this.readStore();
    return [...data.sessions];
  }

  /**
   * Get a specific session by HAPI session ID
   */
  async get(hapiSessionId: string): Promise<PersistedSession | null> {
    const data = await this.readStore();
    return data.sessions.find(s => s.hapiSessionId === hapiSessionId) ?? null;
  }

  /**
   * Update the Claude session ID for a session
   * Called when Claude reports its session ID via hook
   */
  async updateClaudeSessionId(
    hapiSessionId: string,
    claudeSessionId: string
  ): Promise<boolean> {
    return await this.withLock(async () => {
      const data = await this.readStore();
      const session = data.sessions.find(
        s => s.hapiSessionId === hapiSessionId
      );

      if (!session) {
        logger.debug(
          `[SessionStore] Session not found for Claude ID update: ${hapiSessionId}`
        );
        return false;
      }

      session.claudeSessionId = claudeSessionId;
      data.updatedAt = new Date().toISOString();
      await this.writeStore(data);
      logger.debug(
        `[SessionStore] Updated Claude session ID for ${hapiSessionId}: ${claudeSessionId}`
      );
      return true;
    });
  }

  /**
   * Update the Codex session ID for a session (#1082).
   * Mirror of updateClaudeSessionId — called when a daemon-started codex session
   * discovers its codex session id (via the id-delivery wire in sessionTracker),
   * so daemon-restart recovery can thread it into the respawned wrapper for
   * findCodexResumeFile-based resume.
   */
  async updateCodexSessionId(
    hapiSessionId: string,
    codexSessionId: string
  ): Promise<boolean> {
    return await this.withLock(async () => {
      const data = await this.readStore();
      const session = data.sessions.find(
        s => s.hapiSessionId === hapiSessionId
      );

      if (!session) {
        logger.debug(
          `[SessionStore] Session not found for Codex ID update: ${hapiSessionId}`
        );
        return false;
      }

      session.codexSessionId = codexSessionId;
      data.updatedAt = new Date().toISOString();
      await this.writeStore(data);
      logger.debug(
        `[SessionStore] Updated Codex session ID for ${hapiSessionId}: ${codexSessionId}`
      );
      return true;
    });
  }

  /**
   * Update the status of a session
   */
  async updateStatus(
    hapiSessionId: string,
    status: SessionStatus
  ): Promise<boolean> {
    return await this.withLock(async () => {
      const data = await this.readStore();
      const session = data.sessions.find(
        s => s.hapiSessionId === hapiSessionId
      );

      if (!session) {
        logger.debug(
          `[SessionStore] Session not found for status update: ${hapiSessionId}`
        );
        return false;
      }

      session.status = status;
      data.updatedAt = new Date().toISOString();
      await this.writeStore(data);
      logger.debug(
        `[SessionStore] Updated status for ${hapiSessionId}: ${status}`
      );
      return true;
    });
  }

  /**
   * Mark all sessions as offline (called on startup before recovery)
   */
  async markAllOffline(): Promise<void> {
    await this.withLock(async () => {
      const data = await this.readStore();
      for (const session of data.sessions) {
        session.status = "offline";
      }
      data.updatedAt = new Date().toISOString();
      await this.writeStore(data);
      logger.debug(
        `[SessionStore] Marked ${data.sessions.length} sessions as offline`
      );
    });
  }

  /**
   * Clear all sessions (for testing or reset)
   */
  async clear(): Promise<void> {
    await this.withLock(async () => {
      const data = {
        ...DEFAULT_STORE_DATA,
        sessions: [], // Deep copy - don't share the array reference
        updatedAt: new Date().toISOString(),
      };
      await this.writeStore(data);
      logger.debug("[SessionStore] Cleared all sessions");
    });
  }

  /**
   * Get count of sessions
   */
  async count(): Promise<number> {
    const data = await this.readStore();
    return data.sessions.length;
  }

  /**
   * Check if store file exists
   */
  exists(): boolean {
    return existsSync(this.storePath);
  }

  // ==================== Private Methods ====================

  private async readStore(): Promise<SessionStoreData> {
    if (!existsSync(this.storePath)) {
      if (this.createIfMissing) {
        return { ...DEFAULT_STORE_DATA, sessions: [] }; // Deep copy sessions array
      }
      throw new Error(`Session store not found: ${this.storePath}`);
    }

    try {
      const content = await readFile(this.storePath, "utf-8");
      const raw = JSON.parse(content);

      // Structural validation: must be a non-null object with a sessions array.
      // Bare arrays ([]), null, strings, numbers, or objects missing .sessions
      // all pass JSON.parse but break downstream code that expects SessionStoreData.
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        !Array.isArray(raw.sessions)
      ) {
        throw new Error(
          `[SessionStore] Invalid store structure: expected {sessions: [...]}, got ${
            Array.isArray(raw) ? "array" : typeof raw
          }`
        );
      }

      const data = raw as SessionStoreData;

      // Validate and migrate if needed
      return this.migrateIfNeeded(data);
    } catch (error) {
      logger.warn(`[SessionStore] Failed to read store: ${error}`);

      // If corrupted, backup and start fresh
      if (this.createIfMissing) {
        await this.backupCorruptedStore();
        return { ...DEFAULT_STORE_DATA, sessions: [] }; // Deep copy sessions array
      }
      throw error;
    }
  }

  private async writeStore(data: SessionStoreData): Promise<void> {
    try {
      const content = JSON.stringify(data, null, 2);
      await writeFile(this.storePath, content, "utf-8");
    } catch (error) {
      logger.warn(`[SessionStore] Failed to write store: ${error}`);
      throw error;
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    // Simple file-based locking with atomic exclusive creation
    const maxRetries = 50;
    const retryDelay = 50; // ms

    // Try to acquire lock
    for (let i = 0; i < maxRetries; i++) {
      try {
        // Try to create lock file exclusively (atomic - no race condition)
        await writeFile(this.lockPath, Date.now().toString(), { flag: "wx" });

        try {
          return await operation();
        } finally {
          // Release lock
          try {
            await unlink(this.lockPath);
          } catch {
            // Ignore cleanup errors
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          // Lock exists, check if stale
          try {
            if (existsSync(this.lockPath)) {
              const stat = await readFile(this.lockPath, "utf-8");
              const lockTime = parseInt(stat, 10);
              if (isNaN(lockTime) || Date.now() - lockTime > 30000) {
                // Lock is stale or has invalid content (e.g., empty from a crash) — remove it
                logger.debug("[SessionStore] Removing stale lock file");
                await unlink(this.lockPath).catch(() => {});
                continue;
              }
            }
          } catch {
            // Ignore read errors, will retry
          }

          // Wait and retry
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          continue;
        }

        if (i === maxRetries - 1) {
          throw new Error(
            `Failed to acquire lock after ${maxRetries} retries: ${error}`
          );
        }
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }

    throw new Error("Failed to acquire lock");
  }

  private migrateIfNeeded(data: SessionStoreData): SessionStoreData {
    if (data.version === CURRENT_SCHEMA_VERSION) {
      return data;
    }

    logger.info(
      `[SessionStore] Migrating from version ${data.version} to ${CURRENT_SCHEMA_VERSION}`
    );

    // Add migration logic here as schema evolves
    // For now, just update the version
    data.version = CURRENT_SCHEMA_VERSION;
    return data;
  }

  private async backupCorruptedStore(): Promise<void> {
    if (!existsSync(this.storePath)) {
      return;
    }

    const backupPath = `${this.storePath}.corrupted.${Date.now()}`;
    try {
      const content = await readFile(this.storePath, "utf-8");
      await writeFile(backupPath, content, "utf-8");
      logger.warn(`[SessionStore] Backed up corrupted store to: ${backupPath}`);
    } catch {
      logger.warn("[SessionStore] Failed to backup corrupted store");
    }
  }
}

/**
 * Create a session store with default path
 */
export function createSessionStore(hapiHome: string): SessionStore {
  const storePath = `${hapiHome}/sessions-state.json`;
  return new SessionStore({ storePath, createIfMissing: true });
}
