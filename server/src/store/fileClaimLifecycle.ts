// SPDX-License-Identifier: AGPL-3.0-only
import type { StoredFileClaim } from "./types";
import type { FileClaimsStore } from "./fileClaimsStore";

/**
 * File Conflict Monitor (Epic #1965, Sub C / #1968) — pure claim-lifecycle
 * helpers that bridge the session-agnostic {@link FileClaimsStore} to the
 * server's per-session liveness predicate.
 *
 * The store intentionally has no FK to `sessions` (#1966), so "who is live"
 * cannot live in the store. These helpers take an already-computed live-session
 * set (built by the caller from `SyncEngine.getActiveSessions()`, using BOTH the
 * session `id` and `tag` because a claim's `sessionId` is client-supplied and
 * may be either). Keeping them pure makes R4/R5 unit-testable against a
 * `:memory:` store without constructing a full SyncEngine.
 *
 * Liveness source is the server's in-process `active` predicate (kept honest by
 * the `expireInactive` crash-detection watchdog), NOT the daemon #1477 substrate
 * — a deliberate MVP choice consistent with #1967's store-direct, observe-first
 * boundary. Cross-node / daemon-tmux ground-truth liveness is deferred to #1969.
 */

/**
 * Build the live-session id-set consumed by the R4 query filter (route) and the
 * R5 reaper (SyncEngine). Includes BOTH `id` and `tag` for each session because
 * a claim's `sessionId` is client-supplied and may be either.
 */
export function liveSessionIdSet(
  sessions: readonly { id: string; tag?: string | null }[]
): Set<string> {
  const live = new Set<string>();
  for (const session of sessions) {
    live.add(session.id);
    if (session.tag) live.add(session.tag);
  }
  return live;
}

/**
 * R4: keep only claims whose owning session is present in `liveSessionIds`.
 * A crashed session's unreleased claims (whose `released_at` is still NULL but
 * whose session is no longer live) are filtered out so a query never surfaces a
 * stale lock. An empty `liveSessionIds` set correctly filters everything out.
 */
export function filterClaimsToLiveSessions(
  claims: StoredFileClaim[],
  liveSessionIds: Set<string>
): StoredFileClaim[] {
  return claims.filter(claim => liveSessionIds.has(claim.sessionId));
}

/**
 * R5: soft-release every LIVE claim owned by a session NOT in `liveSessionIds`
 * (a crashed session that never fired `handleSessionEnd`). Returns the total
 * number of claims released. Idempotent — a second call with the same live set
 * releases 0, because the first call already set `released_at`.
 */
export function reapOrphanedClaims(
  fileClaims: FileClaimsStore,
  liveSessionIds: Set<string>,
  now: number = Date.now()
): number {
  const orphanSessionIds = new Set(
    fileClaims
      .getLiveClaims()
      .map(claim => claim.sessionId)
      .filter(sessionId => !liveSessionIds.has(sessionId))
  );
  let released = 0;
  for (const sessionId of orphanSessionIds) {
    released += fileClaims.releaseClaimsBySession(sessionId, now);
  }
  return released;
}
