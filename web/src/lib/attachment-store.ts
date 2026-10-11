// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Attachment Store — session-keyed, survives composer remounts (issue #2541).
 *
 * The composer's staged attachments used to live in `useAttachments`' component-
 * local `useState`, so navigating session-view → list → the SAME session-view
 * unmounted the composer and dropped every pending/uploaded file. This module
 * lifts that state to module scope, keyed by `sessionId`, so the list survives
 * navigation until sent or explicitly cleared.
 *
 * Pattern mirrors `pending-spawns.ts` / `session-action-pending.ts`: a
 * module-level `Map` + listener `Set` with a `useSyncExternalStore`-compatible
 * `subscribe`/`getSnapshot`. The per-key snapshot IS the stored array itself — it
 * is replaced (never mutated in place) on every write, so
 * `getAttachmentsSnapshot(sessionId)` is referentially stable between writes (the
 * `useSyncExternalStore` contract; React 19.2.3 throws "Maximum update depth
 * exceeded" on an unstable snapshot). Missing keys return a shared `EMPTY`
 * constant. Contract test mirrors `session-action-pending.test.ts:115`.
 *
 * Tier 1 (this module) is IN-MEMORY only — pending browser `File` objects are not
 * serializable, so they survive in-app navigation but not a full page reload.
 * Tier 2 (localStorage for uploaded-file metadata) is a separate, optional layer.
 */

export type AttachmentStatus = "pending" | "uploading" | "uploaded" | "error";

export interface Attachment {
  id: string;
  /**
   * The in-memory browser File. Present for freshly-added attachments (drag/drop,
   * paste, picker) and required for the upload path. OPTIONAL (issue #1075)
   * because an already-uploaded attachment can arrive WITHOUT its original File —
   * e.g. a notes attachment hydrated from the persisted `NotesContent` envelope,
   * or one transferred between the notes and composer boxes. Upload loops only
   * process `pending` entries, which always carry `file`; preview code must
   * fall back gracefully when it is absent.
   */
  file?: File;
  name: string;
  isValid: boolean;
  storedName?: string;
  path?: string;
  status: AttachmentStatus;
  error?: string;
}

// ── Module-level store ──────────────────────────────────────────────

/** Per-session attachment lists. Each value IS that key's cached snapshot. */
const store = new Map<string, Attachment[]>();
const listeners = new Set<() => void>();

/**
 * Shared reference returned for any session with no staged attachments. MUST be
 * a single stable constant — returning a fresh `[]` from getSnapshot makes
 * `useSyncExternalStore` see a new value every render and throw "Maximum update
 * depth exceeded" (React 19.2.3). Never mutated in place: every mutator produces
 * a NEW array via spread/map/filter, so this shared empty is safe unfrozen.
 */
const EMPTY: Attachment[] = [];

function notify(): void {
  for (const fn of listeners) fn();
}

// ── Mutators ────────────────────────────────────────────────────────

/**
 * Immutably update one session's attachment list. `updater` receives the current
 * slice (or the shared `EMPTY` for a missing key) and MUST return a NEW array
 * (spread/map/filter) — never mutate the argument in place. The returned array
 * becomes the key's new cached snapshot and subscribers are notified. Returning
 * the same reference is treated as a no-op (no notify). A `""` sessionId is a
 * legal (ephemeral) in-memory bucket.
 */
export function updateSessionAttachments(
  sessionId: string,
  updater: (prev: Attachment[]) => Attachment[]
): void {
  const prev = store.get(sessionId) ?? EMPTY;
  const next = updater(prev);
  if (next === prev) return; // updater chose a no-op — don't churn subscribers
  store.set(sessionId, next);
  notify();
}

// ── useSyncExternalStore interface ──────────────────────────────────

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The current snapshot for one session. Referentially stable between writes:
 * returns the stored array (replaced only by `updateSessionAttachments`) or the
 * shared `EMPTY` constant for a missing key. Never builds a fresh array.
 */
export function getAttachmentsSnapshot(sessionId: string): Attachment[] {
  return store.get(sessionId) ?? EMPTY;
}

/** Test-only: clear every session's attachments and all listeners. */
export function __resetAttachmentStore(): void {
  store.clear();
  listeners.clear();
}
