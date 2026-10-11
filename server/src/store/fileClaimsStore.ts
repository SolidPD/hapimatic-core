// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type {
  FileClaimChangeKind,
  FileClaimType,
  StoredFileClaim,
} from "./types";

export interface CreateFileClaimInput {
  sessionId: string;
  repo: string;
  path: string;
  claimType: FileClaimType;
  changeKind: FileClaimChangeKind;
}

/**
 * Optional scoping for {@link FileClaimsStore.releaseClaims}. Omitted fields
 * mean "all" (an empty scope releases every live claim for the session, exactly
 * like {@link FileClaimsStore.releaseClaimsBySession}). Epic #1965 Sub B / #1967.
 */
export interface ReleaseClaimsScope {
  /** Restrict to one claim type (e.g. only "expected" or only "active"). */
  claimType?: FileClaimType;
  /** Restrict to one repo. */
  repo?: string;
  /** Restrict to one path. */
  path?: string;
}

interface FileClaimRow {
  id: string;
  session_id: string;
  repo: string;
  path: string;
  claim_type: string;
  change_kind: string;
  claimed_at: number;
  released_at: number | null;
}

/**
 * Options for {@link FileClaimsStore.getConflictHistory}. The window is
 * REQUIRED (never unbounded — the all-time self-join is the only shape that
 * degrades quadratically in hot (repo, path) groups). #2815.
 */
export interface ConflictHistoryOptions {
  /** Only pairs whose overlap BEGAN at/after this epoch-ms cutoff. */
  sinceMs: number;
  /** Hard cap on returned pairs (route REJECTS out-of-range with 400; 1-500). */
  limit: number;
  /** Optional repo filter (owner/name, exact match). */
  repo?: string;
}

/**
 * One historical conflict pair: two DIFFERENT sessions whose
 * [claimedAt, releasedAt) windows overlapped on the same (repo, path).
 * `overlapEnd` is null only while BOTH sides are still unreleased — the
 * overlap window closes when the FIRST party releases. #2815.
 */
export interface ConflictHistoryPair {
  repo: string;
  path: string;
  sessionA: string;
  sessionB: string;
  claimTypeA: FileClaimType;
  claimTypeB: FileClaimType;
  changeKindA: FileClaimChangeKind;
  changeKindB: FileClaimChangeKind;
  overlapStart: number;
  overlapEnd: number | null;
}

interface ConflictHistoryRow {
  repo: string;
  path: string;
  session_a: string;
  session_b: string;
  claim_type_a: string;
  claim_type_b: string;
  change_kind_a: string;
  change_kind_b: string;
  overlap_start: number;
  overlap_end: number;
}

/**
 * Open-interval sentinel for the history join: an unreleased claim's window
 * end. 9e15 is far beyond any epoch-ms (year ~287396) yet well inside
 * Number.MAX_SAFE_INTEGER, so COALESCE/min stay exact in SQLite's float math.
 */
const OPEN_INTERVAL_SENTINEL = 9e15;

function toStoredFileClaim(row: FileClaimRow): StoredFileClaim {
  return {
    id: row.id,
    sessionId: row.session_id,
    repo: row.repo,
    path: row.path,
    claimType: row.claim_type as FileClaimType,
    changeKind: row.change_kind as FileClaimChangeKind,
    claimedAt: row.claimed_at,
    releasedAt: row.released_at,
  };
}

/**
 * SQLite-backed store for per-session file claims (Epic #1965, Sub A / #1966).
 *
 * Records which files each session has *predicted* it will touch (`expected`)
 * and which it is *actively* editing (`active`), so other sessions can ask
 * "who else is touching path X." Pure data-access — lifecycle/seeding lives in
 * #1968. The `session_file_claims` table + its indexes are created in
 * `Store.runMigrations()` (`store/index.ts`), NOT here (parity with LeaseStore).
 *
 * Release is a soft update (`released_at = now`), never a row delete, so history
 * is preserved for the #1972 prediction-accuracy dataset; this is also why there
 * is intentionally no FK to `sessions` (a hard ON DELETE CASCADE would erase
 * released history, and `session_id` may reference a session that does not have
 * a row on this node under federation — matching `timelog_entries`/`error_logs`,
 * which also carry an FK-less `session_id`).
 */
export class FileClaimsStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** R1: insert a live claim and return the stored row. */
  insertClaim(
    input: CreateFileClaimInput,
    now: number = Date.now()
  ): StoredFileClaim {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO session_file_claims
           (id, session_id, repo, path, claim_type, change_kind, claimed_at, released_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        id,
        input.sessionId,
        input.repo,
        input.path,
        input.claimType,
        input.changeKind,
        now
      );
    return {
      id,
      sessionId: input.sessionId,
      repo: input.repo,
      path: input.path,
      claimType: input.claimType,
      changeKind: input.changeKind,
      claimedAt: now,
      releasedAt: null,
    };
  }

  /**
   * R2: claims for a (repo, path) — the "who claims X" lookup. Live-only by
   * default (`released_at IS NULL`); pass `includeReleased: true` for history.
   * Index-backed by `idx_file_claims_repo_path`.
   */
  getClaimsByPath(
    repo: string,
    path: string,
    opts?: { includeReleased?: boolean }
  ): StoredFileClaim[] {
    const includeReleased = opts?.includeReleased ?? false;
    const rows = this.db
      .prepare(
        `SELECT * FROM session_file_claims
          WHERE repo = ? AND path = ?` +
          (includeReleased ? "" : " AND released_at IS NULL") +
          ` ORDER BY claimed_at ASC`
      )
      .all(repo, path) as FileClaimRow[];
    return rows.map(toStoredFileClaim);
  }

  /** R3: all claims for a session (live + released by default), oldest first. */
  getClaimsBySession(
    sessionId: string,
    opts?: { includeReleased?: boolean }
  ): StoredFileClaim[] {
    const includeReleased = opts?.includeReleased ?? true;
    const rows = this.db
      .prepare(
        `SELECT * FROM session_file_claims
          WHERE session_id = ?` +
          (includeReleased ? "" : " AND released_at IS NULL") +
          ` ORDER BY claimed_at ASC`
      )
      .all(sessionId) as FileClaimRow[];
    return rows.map(toStoredFileClaim);
  }

  /** R4: every live (unreleased) claim across all sessions. */
  getLiveClaims(): StoredFileClaim[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM session_file_claims
          WHERE released_at IS NULL
          ORDER BY claimed_at ASC`
      )
      .all() as FileClaimRow[];
    return rows.map(toStoredFileClaim);
  }

  /**
   * Soft-release a session's live claims, optionally scoped by claimType / repo
   * / path. Returns the number released. With an empty scope this is exactly
   * {@link FileClaimsStore.releaseClaimsBySession}. Idempotent — the
   * `released_at IS NULL` guard excludes already-released rows (a repeat call
   * with the same scope releases 0). Epic #1965 Sub B / #1967.
   *
   * The scoped variants power the #1967 route: R1 (footprint replace — release
   * only the session's `expected` claims for one repo, preserving its `active`
   * claims) and R3 (release only `active` claims, optionally for one path).
   */
  releaseClaims(
    sessionId: string,
    scope: ReleaseClaimsScope = {},
    now: number = Date.now()
  ): number {
    const where: string[] = ["session_id = ?", "released_at IS NULL"];
    const args: (string | number)[] = [sessionId];
    if (scope.claimType !== undefined) {
      where.push("claim_type = ?");
      args.push(scope.claimType);
    }
    if (scope.repo !== undefined) {
      where.push("repo = ?");
      args.push(scope.repo);
    }
    if (scope.path !== undefined) {
      where.push("path = ?");
      args.push(scope.path);
    }
    const res = this.db
      .prepare(
        `UPDATE session_file_claims
            SET released_at = ?
          WHERE ${where.join(" AND ")}`
      )
      .run(now, ...args);
    return res.changes;
  }

  /**
   * R5: soft-release ALL live claims for a session; returns the number released.
   * Session-scoped lifecycle release (used by #1968 on session end). Idempotent
   * — a second call for the same session releases 0 (already-released rows have
   * a non-null `released_at`). Thin wrapper over {@link
   * FileClaimsStore.releaseClaims} with no scope — behavior is unchanged, so
   * #1966's existing tests (which pass `now` positionally) stay green.
   */
  releaseClaimsBySession(sessionId: string, now: number = Date.now()): number {
    return this.releaseClaims(sessionId, {}, now);
  }

  /**
   * #2815: historical overlapping-window conflict pairs — two different
   * sessions whose claim windows overlapped on the same (repo, path), the
   * overlap having BEGUN within the window (`b.claimed_at >= sinceMs`).
   *
   * Shape notes (perf-measured on the real prod DB — 13.6ms windowed+limited
   * vs 197ms for the naive `session_id <` canonicalization run all-time,
   * unwindowed — the only shape that degrades quadratically):
   * - TIME-ordered pair canonicalization (`a` strictly earlier than `b`, id
   *   tiebreak) makes `b.claimed_at` the overlap start, so the window bound,
   *   the DESC sort, and the LIMIT all ride `idx_file_claims_claimed_at`
   *   with early termination and no sort step.
   * - `a.session_id <> b.session_id` keeps a single session's expected+active
   *   pair from manufacturing a self-conflict (constraint-B analogue).
   * - The cutoff correctly INCLUDES an old long-lived claim conflicted by a
   *   NEW claim (a before cutoff, b after) and excludes only conflicts whose
   *   overlap began before the window.
   * - No live-session filter and no churn filter — history is deliberately
   *   about ended sessions, and churn filtering stays client-side (constraint
   *   C symmetry with the live GET).
   */
  getConflictHistory(opts: ConflictHistoryOptions): ConflictHistoryPair[] {
    const repoFilter = opts.repo !== undefined ? " AND b.repo = ?" : "";
    const args: (string | number)[] = [opts.sinceMs];
    if (opts.repo !== undefined) args.push(opts.repo);
    args.push(opts.limit);
    const rows = this.db
      .prepare(
        `SELECT b.repo AS repo, b.path AS path,
                a.session_id AS session_a, b.session_id AS session_b,
                a.claim_type AS claim_type_a, b.claim_type AS claim_type_b,
                a.change_kind AS change_kind_a, b.change_kind AS change_kind_b,
                b.claimed_at AS overlap_start,
                min(COALESCE(a.released_at, ${OPEN_INTERVAL_SENTINEL}),
                    COALESCE(b.released_at, ${OPEN_INTERVAL_SENTINEL})) AS overlap_end
           FROM session_file_claims b
           JOIN session_file_claims a
             ON a.repo = b.repo AND a.path = b.path
            AND a.session_id <> b.session_id
            AND (a.claimed_at < b.claimed_at
                 OR (a.claimed_at = b.claimed_at AND a.id < b.id))
          WHERE b.claimed_at >= ?
            AND a.claimed_at < COALESCE(b.released_at, ${OPEN_INTERVAL_SENTINEL})
            AND b.claimed_at < COALESCE(a.released_at, ${OPEN_INTERVAL_SENTINEL})${repoFilter}
          ORDER BY b.claimed_at DESC
          LIMIT ?`
      )
      .all(...args) as ConflictHistoryRow[];
    return rows.map(r => ({
      repo: r.repo,
      path: r.path,
      sessionA: r.session_a,
      sessionB: r.session_b,
      claimTypeA: r.claim_type_a as FileClaimType,
      claimTypeB: r.claim_type_b as FileClaimType,
      changeKindA: r.change_kind_a as FileClaimChangeKind,
      changeKindB: r.change_kind_b as FileClaimChangeKind,
      overlapStart: r.overlap_start,
      overlapEnd:
        r.overlap_end >= OPEN_INTERVAL_SENTINEL ? null : r.overlap_end,
    }));
  }
}
