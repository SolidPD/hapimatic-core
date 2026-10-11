// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiClient } from "@/api/client";

/**
 * Issue #1325 / Task 18 — one-shot migration of legacy sessionStorage queues
 * to the server-backed queue.
 *
 * Before #1325, `useMessageQueue` persisted the per-session queue to
 * `sessionStorage` under keys of the form `hapi:queue:<sessionId>` carrying a
 * JSON array of strings. After #1325, the queue lives on the server and is
 * driven by `QueueDrainObserver`. This helper migrates any in-flight legacy
 * data on first PWA load post-deploy:
 *
 *   1. Scan sessionStorage for keys matching `hapi:queue:<sessionId>`
 *   2. For each key, POST each message to `/api/sessions/<sid>/queue/enqueue`
 *      with a stable `clientGeneratedId = legacy:<sid>:<i>:<sha256(body)>`
 *   3. If ALL messages for a session succeeded, remove the sessionStorage key
 *   4. If ANY failed, leave the key intact (retry on next load)
 *
 * Idempotency: `clientGeneratedId` is stable per (sessionId, position, body),
 * and the server's `queued_messages` table has a partial UNIQUE index on
 * `(session_id, client_generated_id WHERE NOT NULL)`. Re-running the migration
 * (e.g. user opens two tabs, or migration partially failed last time) produces
 * `result: "deduplicated"` for already-migrated messages — no duplicate rows.
 *
 * Failures are non-fatal: this function never throws to the caller. Network
 * errors, 503s, or per-message failures are absorbed and reported via the
 * return value's `failed` count.
 */
export async function migrateLegacyQueue(
  api: ApiClient
): Promise<{ migrated: number; failed: number; sessionsProcessed: number }> {
  if (typeof sessionStorage === "undefined") {
    return { migrated: 0, failed: 0, sessionsProcessed: 0 };
  }

  const STORAGE_PREFIX = "hapi:queue:";
  const keys: string[] = [];
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) {
        keys.push(key);
      }
    }
  } catch {
    // sessionStorage access blocked (e.g. private browsing in some browsers)
    return { migrated: 0, failed: 0, sessionsProcessed: 0 };
  }

  if (keys.length === 0) {
    return { migrated: 0, failed: 0, sessionsProcessed: 0 };
  }

  let migrated = 0;
  let failed = 0;
  let sessionsProcessed = 0;

  for (const key of keys) {
    const sessionId = key.slice(STORAGE_PREFIX.length);
    if (!sessionId) continue;

    let messages: string[];
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) {
        // Empty/missing — sweep the key away on the way out.
        sessionStorage.removeItem(key);
        continue;
      }
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        sessionStorage.removeItem(key);
        continue;
      }
      messages = parsed.filter((m): m is string => typeof m === "string");
    } catch {
      // Malformed JSON — drop the key to prevent infinite retry on garbage.
      sessionStorage.removeItem(key);
      continue;
    }

    if (messages.length === 0) {
      sessionStorage.removeItem(key);
      continue;
    }

    sessionsProcessed += 1;
    let allOk = true;

    for (let i = 0; i < messages.length; i++) {
      const body = messages[i];
      try {
        const clientGeneratedId = await deriveClientGeneratedId(
          sessionId,
          i,
          body
        );
        await api.enqueueQueuedMessage(sessionId, body, clientGeneratedId);
        migrated += 1;
      } catch (err) {
        // Network error, 503, 404 (session deleted server-side), etc.
        // Leave the key in place for a future retry pass.
        console.warn(
          `[migrateLegacyQueue] failed to migrate ${sessionId}[${i}]:`,
          err
        );
        failed += 1;
        allOk = false;
      }
    }

    if (allOk) {
      try {
        sessionStorage.removeItem(key);
      } catch {
        // Best effort; ignore quota/access issues here.
      }
    }
  }

  return { migrated, failed, sessionsProcessed };
}

/**
 * Compute a stable per-message migration ID. Avoids the partial-failure
 * trap where re-running the migration would re-POST already-sent messages.
 *
 * Uses Web Crypto SHA-256 when available (all modern browsers); falls back
 * to a deterministic non-cryptographic hash when not. The server treats
 * `clientGeneratedId` as opaque text — only equality matters for dedup.
 */
async function deriveClientGeneratedId(
  sessionId: string,
  position: number,
  body: string
): Promise<string> {
  const input = `${sessionId}:${position}:${body}`;
  if (typeof globalThis !== "undefined" && globalThis.crypto?.subtle?.digest) {
    try {
      const buf = new TextEncoder().encode(input);
      const hash = await globalThis.crypto.subtle.digest("SHA-256", buf);
      const hex = Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
      return `legacy:${sessionId}:${position}:${hex.slice(0, 16)}`;
    } catch {
      // Fall through to non-crypto fallback
    }
  }
  // Non-crypto fallback (FNV-1a 32-bit). Sufficient for migration idempotency.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `legacy:${sessionId}:${position}:${(h >>> 0).toString(16).padStart(8, "0")}`;
}
