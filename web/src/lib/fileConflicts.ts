// SPDX-License-Identifier: AGPL-3.0-only
// File Conflict Monitor (epic #1965) Sub F / #1971 — the pure, tested heart of the
// observe-phase web conflict surface. Given the raw live file-claims returned by
// `GET /api/file-claims` (per-repo, merged client-side) plus the all-sessions list,
// derive one standardized-table row per genuinely-conflicting file. The severity /
// action formula lives ENTIRELY in the shared `@hapi/protocol` module — this helper
// only wires the raw claims into it, so both the #1970 endpoint and this UI render
// the same numbers.
//
// Four correctness constraints are baked in from the start (the first three are the
// directive's named traps, verified load-bearing by the #1971 expert review; the
// fourth is an in-path refinement for the multi-repo merge this consumer performs):
//   A. join sessions by BOTH `id` AND `tag` — a claim's `sessionId` is the session
//      TAG in practice (claims are written under $HAPI_SESSION_ID = the tag), so an
//      id-only map silently loses every tag-written claim. Mirrors the server's
//      `liveSessionIdSet()` (fileClaimLifecycle.ts).
//   B. dedupe by `sessionId` BEFORE counting concurrency — one session can hold both
//      an `expected` and an `active` claim on the same path (two live rows, same
//      session), which would otherwise manufacture a false self-conflict.
//   C. apply `isChurnIgnored` client-side — the GET route does NOT churn-filter
//      server-side (unlike `/conflict-check`), so lockfiles/docs/test files would
//      otherwise show as conflicts.
//   D. group by (repo, path), NOT path alone — this hook merges claims across repos,
//      so path-only grouping would show a false cross-repo conflict when two sessions
//      in different repos touch a common filename (package.json / README.md / CLAUDE.md,
//      none of which are churn-ignored). Grouping by (repo, path) keeps a "conflict"
//      what it actually is: the SAME file raced by ≥2 sessions. This is the same class
//      of manufactured-conflict trap as constraint B, on the repo axis.

import {
  classifyBlastRadius,
  changeKindWeight,
  computeSeverity,
  recommendAction,
  isChurnIgnored,
} from "@hapi/protocol";
import type {
  ChangeKind,
  ClaimType,
  FileClaim,
  FileClaimConflictPair,
  Severity,
} from "@hapi/protocol";
import type { SessionSummary } from "@/types/api";

/**
 * The canonical churn-ignore set. `TRIVIAL_PATTERNS` is module-private in
 * `shared/src/conflictSeverity.ts` (not exported; `isChurnIgnored` has no default),
 * so it is duplicated here VERBATIM.
 *
 * Drift backstop: trivial paths already classify to blastRadius 0 → 🟢, so a stale
 * copy degrades to green noise, never a false red.
 *
 * @see shared/src/conflictSeverity.ts TRIVIAL_PATTERNS @ d6bb4945 — keep in sync.
 */
export const DEFAULT_CHURN: readonly string[] = [
  "claudedocs/**",
  "docs/**",
  "**/*.test.*",
  "**/*.spec.*",
  "*.lock",
  "**/*.lock",
  "**/package-lock.json",
  "**/bun.lockb",
];

/** Aggregate claim-type across a path's live claims. */
export type RowClaimType = "expected" | "active" | "mixed";

/** One standardized-table row: a file raced by ≥2 distinct live sessions. */
export interface FileConflictRow {
  /** Repo-relative path (the File/Pattern column value). */
  path: string;
  /** owner/name of the repo this file belongs to (row identity + disambiguation). */
  repo: string;
  /** 🔴 / 🟡 / 🟢 — produced by the shared `computeSeverity`, never re-derived here. */
  severity: Severity;
  /** Highest-weight change-kind across the path's sessions (conservative). */
  changeKind: ChangeKind;
  /** Distinct linked-issue numbers, ascending; `[]` when no owning session is linked. */
  issues: number[];
  /** One entry per distinct session racing this file. */
  sessions: Array<{ sessionId: string; label: string; nodeLabel?: string }>;
  /** `active` if all active, `expected` if all expected, `mixed` if both present. */
  claimType: RowClaimType;
  /** From `recommendAction(severity, { orderingKnown: false })`. */
  recommendedAction: string;
  /** blast × changeKindWeight × concurrency — the sort key (mirrors the endpoint). */
  severityScore: number;
  /** Structural blast-radius weight (0–3), repo-aware. */
  blastRadius: number;
  /** Distinct-session count on this file (always ≥2 for an emitted row). */
  concurrency: number;
}

interface SessionAgg {
  /** Highest-weight change-kind this session declared on the path. */
  changeKind: ChangeKind;
  /** The claim-types this session holds on the path (expected and/or active). */
  claimTypes: Set<"expected" | "active">;
}

/**
 * NUL composite-key separator: cannot occur in a repo owner/name or a file
 * path, so composite keys can never collide. Written as the \u0000 escape
 * (not a raw NUL byte) so the source stays text and diffs normally.
 */
const SEP = "\u0000";

/**
 * Constraint A — session lookup keyed by BOTH id AND tag. A claim's
 * `sessionId` is the session TAG in practice (claims are written under
 * $HAPI_SESSION_ID = the tag), so an id-only map silently loses every
 * tag-written claim. Shared by every derivation in this module.
 */
function buildSessionLookup(
  sessions: SessionSummary[]
): Map<string, SessionSummary> {
  const byId = new Map<string, SessionSummary>();
  for (const s of sessions) {
    byId.set(s.id, s);
    if (s.tag) byId.set(s.tag, s);
  }
  return byId;
}

/**
 * Session display label shared by every derivation: linked-issue `#N` >
 * session tag > session id > the raw claim sessionId (R6 graceful
 * degradation for sessions unknown to this node).
 */
function sessionLabel(
  session: SessionSummary | undefined,
  rawId: string
): string {
  const issueNumber = session?.linkedIssue?.number;
  if (typeof issueNumber === "number") return `#${issueNumber}`;
  return session ? (session.tag ?? session.id) : rawId;
}

/** One live claim inside an in-flight session group (#2815). */
export interface InFlightClaimRow {
  repo: string;
  path: string;
  claimType: ClaimType;
  changeKind: ChangeKind;
  claimedAt: number;
}

/** All live claims held by one session — the "what's in flight" view (#2815). */
export interface InFlightSessionGroup {
  sessionId: string;
  label: string;
  nodeLabel?: string;
  issue?: number;
  claims: InFlightClaimRow[];
}

/** One (repo, path) aggregate of historical conflict pairs (#2815). */
export interface HistoryConflictRow {
  repo: string;
  path: string;
  /** Distinct sessions ever party to a pair on this file, labeled. */
  sessions: Array<{ sessionId: string; label: string }>;
  /** Highest-weight change-kind across the pairs (conservative). */
  changeKind: ChangeKind;
  /** Raw pair count (repeat claims by the same pair count individually). */
  pairCount: number;
  /** Most recent overlap start (epoch ms) — the sort key. */
  lastConflictAt: number;
  /** True when any pair's overlap window is still open (BOTH sides unreleased). */
  open: boolean;
}

/**
 * Derive the standardized conflict rows from raw live claims + the all-sessions list.
 *
 * Pure and fail-safe: it never throws (the shared severity helpers are themselves
 * fail-safe), never mutates its inputs, and degrades gracefully when a claim's
 * owning session is unknown to the local node (R5) — the exact behavior the Sub-D
 * (#1969) federation seam relies on for cross-node claims whose sessionId is remote.
 *
 * @param claims   merged live claims (already server-filtered to live sessions).
 * @param sessions the all-sessions list used to enrich the issues / sessions columns.
 * @param opts.ignore churn-ignore globs; omit for {@link DEFAULT_CHURN}, `[]` to disable.
 * @returns rows (most-severe first, then path-alphabetical) + the ignored paths.
 */
export function deriveConflictRows(
  claims: FileClaim[],
  sessions: SessionSummary[],
  opts?: { ignore?: readonly string[] }
): { rows: FileConflictRow[]; ignoredPaths: string[] } {
  // Constraint A — session lookup keyed by BOTH id AND tag.
  const byId = buildSessionLookup(sessions);

  // Constraint C — churn-ignore before any grouping.
  const ignore = opts?.ignore ?? DEFAULT_CHURN;
  const ignorePatterns = ignore as string[];
  const ignoredPathsSet = new Set<string>();
  const liveClaims = claims.filter(c => {
    if (isChurnIgnored(c.path, ignorePatterns)) {
      ignoredPathsSet.add(c.path);
      return false;
    }
    return true;
  });

  // Constraint D — group by (repo, path). Constraint B — collapse by sessionId within
  // a group so a single session's expected+active pair counts as ONE participant.
  const groups = new Map<
    string,
    { repo: string; path: string; sessions: Map<string, SessionAgg> }
  >();
  for (const c of liveClaims) {
    const key = c.repo + SEP + c.path;
    let group = groups.get(key);
    if (!group) {
      group = { repo: c.repo, path: c.path, sessions: new Map() };
      groups.set(key, group);
    }
    let agg = group.sessions.get(c.sessionId);
    if (!agg) {
      agg = { changeKind: c.changeKind, claimTypes: new Set() };
      group.sessions.set(c.sessionId, agg);
    }
    agg.claimTypes.add(c.claimType);
    if (changeKindWeight(c.changeKind) > changeKindWeight(agg.changeKind)) {
      agg.changeKind = c.changeKind;
    }
  }

  const rows: FileConflictRow[] = [];
  for (const group of groups.values()) {
    const sessionIds = [...group.sessions.keys()];
    // Emit only genuine conflicts: ≥2 distinct sessions on the same file.
    if (sessionIds.length < 2) continue;

    const concurrency = sessionIds.length;

    // Row change-kind = highest-weight kind across participants (conservative).
    let changeKind: ChangeKind = "edit";
    for (const agg of group.sessions.values()) {
      if (changeKindWeight(agg.changeKind) > changeKindWeight(changeKind)) {
        changeKind = agg.changeKind;
      }
    }

    const blastRadius = classifyBlastRadius(group.path, group.repo);
    const severity = computeSeverity(blastRadius, changeKind, concurrency);
    const severityScore =
      blastRadius * changeKindWeight(changeKind) * concurrency;
    const recommendedAction = recommendAction(severity, {
      orderingKnown: false,
    });

    // Aggregate claim-type across all participating sessions.
    let hasActive = false;
    let hasExpected = false;
    for (const agg of group.sessions.values()) {
      if (agg.claimTypes.has("active")) hasActive = true;
      if (agg.claimTypes.has("expected")) hasExpected = true;
    }
    const claimType: RowClaimType =
      hasActive && hasExpected ? "mixed" : hasActive ? "active" : "expected";

    // Per-session enrichment via the dual-key join; unknown sessions degrade to the
    // raw sessionId label with no issue (R5 — the #1969 remote-claim seam).
    const issueSet = new Set<number>();
    const sessionCells = sessionIds.map(sessionId => {
      const session = byId.get(sessionId);
      const issueNumber = session?.linkedIssue?.number;
      if (typeof issueNumber === "number") issueSet.add(issueNumber);
      return {
        sessionId,
        label: sessionLabel(session, sessionId),
        nodeLabel: session?.nodeLabel,
      };
    });

    rows.push({
      path: group.path,
      repo: group.repo,
      severity,
      changeKind,
      issues: [...issueSet].sort((a, b) => a - b),
      sessions: sessionCells,
      claimType,
      recommendedAction,
      severityScore,
      blastRadius,
      concurrency,
    });
  }

  // Most-severe first, then path-alphabetical — mirrors conflictCheck.ts:118.
  rows.sort(
    (a, b) => b.severityScore - a.severityScore || a.path.localeCompare(b.path)
  );

  return { rows, ignoredPaths: [...ignoredPathsSet].sort() };
}

/**
 * #2815 — derive the in-flight claims inventory: EVERY live claim grouped by
 * owning session. Deliberately NO churn filter (KD8): this is an inventory of
 * what sessions declared, not a conflict/noise surface — churn filtering stays
 * a conflict-table (and history-panel) concept.
 *
 * Pure and fail-safe like {@link deriveConflictRows}: dual-key session join
 * (constraint A), unknown sessions degrade to the raw sessionId label (R6).
 * Identical (sessionId, repo, path, claimType) rows are deduped keeping the
 * newest `claimedAt` — repeat active claims on one path are one inventory line.
 */
export function deriveInFlightRows(
  claims: FileClaim[],
  sessions: SessionSummary[]
): InFlightSessionGroup[] {
  const byId = buildSessionLookup(sessions);

  const dedup = new Map<string, FileClaim>();
  for (const c of claims) {
    const key = c.sessionId + SEP + c.repo + SEP + c.path + SEP + c.claimType;
    const prev = dedup.get(key);
    if (!prev || c.claimedAt > prev.claimedAt) dedup.set(key, c);
  }

  const groups = new Map<string, InFlightSessionGroup>();
  for (const c of dedup.values()) {
    let group = groups.get(c.sessionId);
    if (!group) {
      const session = byId.get(c.sessionId);
      const issueNumber = session?.linkedIssue?.number;
      group = {
        sessionId: c.sessionId,
        label: sessionLabel(session, c.sessionId),
        nodeLabel: session?.nodeLabel,
        ...(typeof issueNumber === "number" ? { issue: issueNumber } : {}),
        claims: [],
      };
      groups.set(c.sessionId, group);
    }
    group.claims.push({
      repo: c.repo,
      path: c.path,
      claimType: c.claimType,
      changeKind: c.changeKind,
      claimedAt: c.claimedAt,
    });
  }

  const rows = [...groups.values()];
  for (const g of rows) {
    g.claims.sort(
      (a, b) => a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path)
    );
  }
  rows.sort((a, b) => a.label.localeCompare(b.label));
  return rows;
}

/**
 * #2815 — derive the recent-conflicts history rows from the raw pair stream
 * returned by `GET /api/file-claims/history`, grouped by (repo, path) via the
 * module-scope NUL SEP (constraint D). Churn-filtered client-side with
 * {@link DEFAULT_CHURN} (constraint C / R5 — the endpoint is deliberately
 * unfiltered, mirroring the live GET's contract). Sessions join dual-key
 * (constraint A) and degrade to the raw sessionId label — history sessions
 * are usually dead, so degradation is the COMMON case here, not the edge.
 */
export function deriveHistoryRows(
  pairs: FileClaimConflictPair[],
  sessions: SessionSummary[],
  opts?: { ignore?: readonly string[] }
): { rows: HistoryConflictRow[]; ignoredPaths: string[] } {
  const byId = buildSessionLookup(sessions);
  const ignore = (opts?.ignore ?? DEFAULT_CHURN) as string[];
  const ignoredPathsSet = new Set<string>();

  const kept = pairs.filter(p => {
    if (isChurnIgnored(p.path, ignore)) {
      ignoredPathsSet.add(p.path);
      return false;
    }
    return true;
  });

  interface HistoryAgg {
    repo: string;
    path: string;
    sessionIds: Set<string>;
    changeKind: ChangeKind;
    pairCount: number;
    lastConflictAt: number;
    open: boolean;
  }
  const groups = new Map<string, HistoryAgg>();
  for (const p of kept) {
    const key = p.repo + SEP + p.path;
    let group = groups.get(key);
    if (!group) {
      group = {
        repo: p.repo,
        path: p.path,
        sessionIds: new Set(),
        changeKind: "edit",
        pairCount: 0,
        lastConflictAt: 0,
        open: false,
      };
      groups.set(key, group);
    }
    group.sessionIds.add(p.sessionA);
    group.sessionIds.add(p.sessionB);
    group.pairCount += 1;
    if (p.overlapStart > group.lastConflictAt) {
      group.lastConflictAt = p.overlapStart;
    }
    if (p.overlapEnd === null) group.open = true;
    for (const kind of [p.changeKindA, p.changeKindB]) {
      if (changeKindWeight(kind) > changeKindWeight(group.changeKind)) {
        group.changeKind = kind;
      }
    }
  }

  const rows: HistoryConflictRow[] = [...groups.values()].map(g => ({
    repo: g.repo,
    path: g.path,
    sessions: [...g.sessionIds].sort().map(id => ({
      sessionId: id,
      label: sessionLabel(byId.get(id), id),
    })),
    changeKind: g.changeKind,
    pairCount: g.pairCount,
    lastConflictAt: g.lastConflictAt,
    open: g.open,
  }));

  // Most recent first, then path-alphabetical (deterministic ties).
  rows.sort(
    (a, b) =>
      b.lastConflictAt - a.lastConflictAt || a.path.localeCompare(b.path)
  );
  return { rows, ignoredPaths: [...ignoredPathsSet].sort() };
}
