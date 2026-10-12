// SPDX-License-Identifier: MIT
/**
 * Issue #1852 — freshness gate for the idle-refresh P-REVOKE guard.
 *
 * A federated/local session counts as "live" for the #1806 idle-refresh backstop
 * ONLY when its keepAlive heartbeat (`activeAt`) is recently fresh. Gating on the
 * raw `active` flag (the original #1806 behavior) let an OFFLINE node's frozen
 * `active:true` cache masquerade as a live binding, so the backstop skipped a
 * non-host isolated account's token refresh forever → ~8h decay → `unrefreshable`
 * → HTTP 409 `account_unrefreshable`.
 *
 * Relationship to the sibling issues — keep the two epistemic paths DISTINCT:
 *   - #1806 introduced the P-REVOKE guard (never rotate a token a live session is
 *     using — the #1645 kill-vector). This predicate PRESERVES that: a fresh
 *     `activeAt` still counts as live and still skips rotation.
 *   - #1834 is the INVERSE failure of the SAME guard (rotating a remote account on
 *     a federation-query FAILURE). That path stays in `getLiveAccountKeys`'s
 *     `catch` (unknown ⇒ conservative). This predicate handles only the
 *     query-SUCCEEDED-but-stale case (stale `activeAt` ⇒ positive evidence of
 *     death ⇒ NOT live ⇒ rotate).
 *
 * The predicate is a pure, exported, unit-tested function (R6) mirroring the
 * codebase convention (`clampAliveTime` in server/src/sync/aliveTime.ts,
 * `isSessionInteresting` in server/src/federation/nodeRegistry.ts).
 */

// Issue #2761 (R4): the freshness window is the SINGLE SOURCE OF TRUTH in
// `@hapi/protocol` (shared/src/sessionSummary.ts) so this daemon guard and the
// server's offline-node `active:false` read-path projection
// (nodeRegistry.getAllRemoteSessions) can never drift. Imported for this module's
// internal use (the default `windowMs` param below + the resolveLiveFreshnessWindowMs
// fallback) and re-exported so existing importers (sessionLiveness.test.ts,
// getLiveAccountKeys) keep resolving it from `./sessionLiveness` unchanged. The
// `HAPI_LIVE_FRESHNESS_WINDOW_MS` env override (resolveLiveFreshnessWindowMs, below)
// stays cli-scoped and governs ONLY this guard — never the server projection.
import { LIVE_SESSION_FRESHNESS_WINDOW_MS } from "@hapi/protocol";
export { LIVE_SESSION_FRESHNESS_WINDOW_MS };
import {
  sessionBusyReason,
  type SessionBusyReason,
  type SessionBusySignal,
} from "@hapi/protocol/sessionBusy";

/**
 * The subset of a session summary the liveness predicate reads. Deliberately
 * structural (not the full `SessionSummary`) so the predicate is callable with the
 * widened inline casts in `getLiveAccountKeys` for both the local and federation
 * session shapes.
 */
export interface LivenessInput {
  /** Whether the owning session is active. For a FEDERATION session this arrives
   *  over the wire already dual-corroborated at the source (issue #2761): the hub's
   *  `NodeRegistry.getAllRemoteSessions` projects `active:false` ONLY when the owning
   *  node is offline AND this session's `activeAt` is stale beyond
   *  `LIVE_SESSION_FRESHNESS_WINDOW_MS` — never on node-offline alone. So the
   *  `!active` short-circuit below stays R24-consistent: a `false` seen here already
   *  means "offline AND stale", not "merely offline". */
  active?: boolean;
  /** keepAlive heartbeat timestamp (ms epoch). Bumped ~every 2s on a live session;
   *  frozen on a zombie. Required by `shared/src/schemas.ts`, but typed optional
   *  here for defense against a mixed-version mesh omitting it (see R4). */
  activeAt?: number;
  /** Federation-only: the hub's reachability determination for the owning node,
   *  stamped by `NodeRegistry.getAllRemoteSessions`. Absent for local sessions.
   *  R24: corroborating/diagnostic ONLY — never a standalone not-live trigger.
   *  Post-#2761 that same stamping site ALSO dual-corroborates `active` (offline
   *  AND stale-`activeAt`) in the read path, keeping the wire flag R24-consistent. */
  nodeStatus?: string;
  /** Issue #3541: whether the owning session is mid-inference. A deliberately
   *  structural subset present on BOTH the local `Session` (`shared/src/schemas.ts`
   *  `thinking: z.boolean()`, stamped every keepAlive next to `activeAt`) and the
   *  federation `SessionSummary` (`shared/src/sessionSummary.ts`, mapped from
   *  `session.thinking`), so it rides the same wire this predicate already reads —
   *  the daemon's inline casts merely narrowed it away. Consumed ONLY by
   *  `getLiveAccountKeys` to build the `inferring` key-set that gates the #3541
   *  rotate-anyway path (defer a mid-turn session, never restart it under
   *  inference); it is NEVER consulted by {@link isSessionLiveForGuard} — a
   *  `thinking:true` session is still just as live/not-live as it would be
   *  otherwise (the #1852 heartbeat semantics are untouched). */
  thinking?: boolean;
}

/**
 * Is `s` a live binding for the idle-refresh P-REVOKE guard?
 *
 * INVARIANT (do NOT "simplify" into a single threshold — that resurrects #1852,
 * and folding `nodeStatus` into the not-live decision resurrects the #1834/#1645
 * false-rotation vector):
 *   - `active:false`              ⇒ NOT live. (For a federation session, `active`
 *                                   arrives source-dual-corroborated post-#2761 —
 *                                   `getAllRemoteSessions` projects `false` only on
 *                                   offline AND stale-`activeAt`, never offline
 *                                   alone — so this short-circuit stays R24-safe.)
 *   - fresh `activeAt`            ⇒ live (skip rotation) — even on a node the hub
 *                                   currently reports "offline" (a node flips
 *                                   offline in ~45s while its cached `activeAt` is
 *                                   still fresh; rotating then is the very
 *                                   P-REVOKE kill it must prevent). [R3, R24]
 *   - stale `activeAt`            ⇒ NOT live (rotate) — positive evidence of death,
 *                                   whether or not the node is "offline". [R1, R24]
 *   - missing/non-finite `activeAt` on a reachable node ⇒ conservatively live
 *                                   (skip). "Absence of evidence" is #1834's
 *                                   conservative domain, never "evidence of death";
 *                                   a naive `now - undefined <= T` is `NaN <= T`
 *                                   = `false` = rotate = #1834 at scale. [R4]
 *
 * `nodeStatus` is intentionally NOT consulted here — it is kept in {@link
 * LivenessInput} for logging/diagnostics and possible future tightening, but a
 * fresh `activeAt` always wins.
 *
 * Issue #3541 / #2281 reconciliation: this predicate STILL returns live for a
 * heartbeating-but-idle bound session, so the #1852 stale-`active:true` case it
 * exists to rotate is unchanged (R5). What #3541 changes lives entirely in
 * `refreshIdleIsolatedAccounts`, NOT here: #2281's premise that an idle account
 * "will auto-refresh within ~60s" NOW holds for a LOCALLY-bound, non-inferring,
 * near-expiry isolated account (the rotate-anyway path restarts it), where
 * previously it never held while any session was bound. It still does NOT hold
 * for a remote-only binding (no cross-node restart) or a mid-inference session
 * (deferred until post-expiry) — both keep decaying to expiry by design.
 */
export function isSessionLiveForGuard(
  s: LivenessInput,
  now: number,
  windowMs: number = LIVE_SESSION_FRESHNESS_WINDOW_MS
): boolean {
  if (!s.active) return false;
  // R4: unknown freshness ⇒ conservatively live (skip), never rotate.
  if (!Number.isFinite(s.activeAt)) return true;
  // R1/R3/R24: fresh ⇒ live; stale ⇒ NOT live (independent of nodeStatus).
  // `<=` is inclusive at the boundary (a session exactly `windowMs` old is live).
  return now - (s.activeAt as number) <= windowMs;
}

/**
 * Resolve the freshness window from `HAPI_LIVE_FRESHNESS_WINDOW_MS`, falling back
 * to {@link LIVE_SESSION_FRESHNESS_WINDOW_MS}. Mirrors the numeric-env house pattern
 * (`getGitTimeoutMs` in `cli/src/daemon/worktree.ts`): only a finite, positive
 * value overrides; anything else (unset, non-numeric, ≤ 0) keeps the default.
 *
 * Resolve ONCE where the closure is constructed and thread the number in — do not
 * read `process.env` per-session.
 */
export function resolveLiveFreshnessWindowMs(): number {
  const raw = process.env.HAPI_LIVE_FRESHNESS_WINDOW_MS;
  if (!raw) return LIVE_SESSION_FRESHNESS_WINDOW_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : LIVE_SESSION_FRESHNESS_WINDOW_MS;
}

/**
 * Issue #4679: one LOCAL session as read from `/cli/sessions` (a full `Session`)
 * for the rotation guards — the liveness fields, the shared busy signal, and the
 * bound account.
 */
export type LocalBindingInput = LivenessInput &
  SessionBusySignal & { metadata?: { accountUuid?: string } };

/** Issue #4679: which accounts have a live local session, and which are busy. */
export interface LocalBindings {
  /** Accounts with a live (fresh-heartbeat) local session. */
  uuids: Set<string>;
  /** The subset of `uuids` with at least one BUSY live session. */
  busyUuids: Set<string>;
  /** Why each busy account is busy (the first busy session's axis), for logs. */
  busyReasons: Map<string, SessionBusyReason>;
}

/**
 * Issue #4679: the ONE local-leg collector for the rotation guards, shared by the
 * daemon's `getLiveAccountKeys` (once per pass) and its `getLocalBusyAccounts`
 * re-check (right before a rotation). A session counts only when it is live for
 * the guard ({@link isSessionLiveForGuard}); busy is the shared
 * `isSessionBusyForRotation` predicate — `thinking`, OR background agents
 * running, OR background shells running — so a session whose turn has ended
 * while background work still runs on its token is never treated as idle.
 */
export function collectLocalBindings(
  sessions: readonly LocalBindingInput[],
  now: number,
  windowMs: number = LIVE_SESSION_FRESHNESS_WINDOW_MS
): LocalBindings {
  const uuids = new Set<string>();
  const busyUuids = new Set<string>();
  const busyReasons = new Map<string, SessionBusyReason>();
  for (const s of sessions) {
    const uuid = s.metadata?.accountUuid;
    if (!uuid || !isSessionLiveForGuard(s, now, windowMs)) continue;
    uuids.add(uuid);
    const reason = sessionBusyReason(s);
    if (reason !== null) {
      busyUuids.add(uuid);
      if (!busyReasons.has(uuid)) busyReasons.set(uuid, reason);
    }
  }
  return { uuids, busyUuids, busyReasons };
}
