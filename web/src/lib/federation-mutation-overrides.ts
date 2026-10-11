// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Federation Mutation Overrides
 *
 * Problem: When we optimistically update a federated session's metadata
 * (emoji, read status, linked issue), the regular 30-second polling of
 * federationAllSessions overwrites our optimistic values with stale data
 * from the hub's NodeRegistry cache (which also refreshes every ~10s).
 *
 * Solution: Maintain a map of "override" fields that get applied on top of
 * poll results in the queryFn. Overrides auto-expire after 15 seconds
 * (by which time the NodeRegistry has refreshed with fresh data).
 */

type SessionOverride = Record<string, unknown>;

const overrides = new Map<string, SessionOverride>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

// Must exceed the NodeRegistry server-side poll interval (10s)
const OVERRIDE_TTL_MS = 15_000;

/**
 * Set override fields for a session. Merged on top of poll data in queryFn.
 */
export function setFederationOverride(
  sessionId: string,
  fields: SessionOverride
): void {
  const prev = overrides.get(sessionId);
  const merged: SessionOverride = { ...prev, ...fields };
  // #1617: when BOTH the existing override and the incoming fields carry a
  // `metadata` object, deep-merge that one sub-key. applyFederationOverrides
  // replaces session.metadata WHOLESALE, so a metadata-wrapping override (name,
  // notes) landing within another metadata override's 15s TTL would otherwise
  // clobber it — each wraps a full-but-stale-at-fire-time metadata object.
  // Merging the sub-key lets a rename and a notes edit coexist.
  const prevMeta = prev?.metadata;
  const nextMeta = fields.metadata;
  if (
    prevMeta &&
    typeof prevMeta === "object" &&
    nextMeta &&
    typeof nextMeta === "object"
  ) {
    merged.metadata = {
      ...(prevMeta as Record<string, unknown>),
      ...(nextMeta as Record<string, unknown>),
    };
  }
  overrides.set(sessionId, merged);

  // Reset the expiry timer
  const existing = timers.get(sessionId);
  if (existing) clearTimeout(existing);
  timers.set(
    sessionId,
    setTimeout(() => {
      overrides.delete(sessionId);
      timers.delete(sessionId);
    }, OVERRIDE_TTL_MS)
  );
}

/**
 * Clear all overrides for a session (e.g., on mutation error/rollback).
 */
export function clearFederationOverride(sessionId: string): void {
  overrides.delete(sessionId);
  const timer = timers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(sessionId);
  }
}

/**
 * Apply overrides to a list of sessions. Called inside queryFn after fetch.
 */
export function applyFederationOverrides<T extends { id: string }>(
  sessions: T[]
): T[] {
  if (overrides.size === 0) return sessions;
  return sessions.map(s => {
    const override = overrides.get(s.id);
    return override ? { ...s, ...override } : s;
  });
}
