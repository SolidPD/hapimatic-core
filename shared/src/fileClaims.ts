// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

// Epic #1965 (File Conflict Monitor) Sub B / #1967 — shared claim + request/
// response schemas for the file-claim write/release/query API. Route factory
// lives in `server/src/web/routes/fileClaims.ts` over the #1966 store.
//
// Every schema is `.passthrough()` per the shared/CLAUDE.md forked-upstream
// rule. API shapes are camelCase views of the snake_case `session_file_claims`
// columns; the enums exactly match #1966's `FileClaimType` / `FileClaimChangeKind`.

export const ClaimTypeSchema = z.enum(["expected", "active"]);
export type ClaimType = z.infer<typeof ClaimTypeSchema>;

export const ChangeKindSchema = z.enum(["edit", "rename", "move", "delete"]);
export type ChangeKind = z.infer<typeof ChangeKindSchema>;

/** A file-claim row as returned by queries (camelCase view of the DB row). */
export const FileClaimSchema = z
  .object({
    id: z.string(),
    sessionId: z.string(),
    repo: z.string(),
    path: z.string(),
    claimType: ClaimTypeSchema,
    changeKind: ChangeKindSchema,
    claimedAt: z.number(), // epoch ms
    releasedAt: z.number().nullable(),
  })
  .passthrough();
export type FileClaim = z.infer<typeof FileClaimSchema>;

/** POST /file-claims/footprint — replace a session's predicted (`expected`) set for a repo. */
export const RecordFootprintRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    repo: z.string().min(1),
    issue: z.string().optional(), // provenance; optional
    claims: z
      .array(
        z.object({ path: z.string().min(1), changeKind: ChangeKindSchema })
      )
      .max(1000), // bound bulk payload
  })
  .passthrough();
export type RecordFootprintRequest = z.infer<
  typeof RecordFootprintRequestSchema
>;

/** POST /file-claims/active — register one in-flight edit. */
export const AddActiveClaimRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    repo: z.string().min(1),
    path: z.string().min(1),
    changeKind: ChangeKindSchema,
  })
  .passthrough();
export type AddActiveClaimRequest = z.infer<typeof AddActiveClaimRequestSchema>;

/** DELETE /file-claims/active — release this session's active claims, optionally one path. */
export const ReleaseClaimQuerySchema = z
  .object({
    sessionId: z.string().min(1),
    path: z.string().min(1).optional(),
  })
  .passthrough();
export type ReleaseClaimQuery = z.infer<typeof ReleaseClaimQuerySchema>;

/**
 * GET /file-claims — query modes: `repo`+`path`, `repo` alone, or `sessionId` alone.
 * `path` requires `repo` (the store's only path index is `(repo, path)`; a path-alone
 * query would be an un-indexed full scan).
 */
export const FileClaimQuerySchema = z
  .object({
    path: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
  })
  .passthrough()
  .refine(v => Boolean(v.repo) || Boolean(v.sessionId), {
    message: "one of repo or sessionId is required",
  })
  .refine(v => !v.path || Boolean(v.repo), {
    message: "path must be accompanied by repo",
  });
export type FileClaimQuery = z.infer<typeof FileClaimQuerySchema>;

export const FileClaimListResponseSchema = z
  .object({ claims: z.array(FileClaimSchema) })
  .passthrough();
export type FileClaimListResponse = z.infer<typeof FileClaimListResponseSchema>;

// File Conflict Monitor follow-up (#2815) — historical overlapping-window
// conflict pairs. A SIBLING surface of the live-only GET above (KD1): released
// claims are the whole point, so these schemas never touch FileClaimQuerySchema's
// live-only contract. Query params arrive as strings → z.coerce; the window is
// REQUIRED-with-default (never unbounded — the all-time self-join is the only
// shape that degrades quadratically).

/** GET /file-claims/history — window (days) + cap (limit) + optional repo filter. */
export const FileClaimHistoryQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(90).default(7),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    repo: z.string().min(1).optional(),
  })
  .passthrough();
export type FileClaimHistoryQuery = z.infer<typeof FileClaimHistoryQuerySchema>;

/**
 * One historical conflict pair: two sessions whose [claimedAt, releasedAt)
 * windows overlapped on the same (repo, path). `overlapEnd` is null only
 * while BOTH sides are still unreleased — the overlap window closes when the
 * FIRST party releases.
 */
export const FileClaimConflictPairSchema = z
  .object({
    repo: z.string(),
    path: z.string(),
    sessionA: z.string(),
    sessionB: z.string(),
    claimTypeA: ClaimTypeSchema,
    claimTypeB: ClaimTypeSchema,
    changeKindA: ChangeKindSchema,
    changeKindB: ChangeKindSchema,
    overlapStart: z.number(),
    overlapEnd: z.number().nullable(),
  })
  .passthrough();
export type FileClaimConflictPair = z.infer<typeof FileClaimConflictPairSchema>;

export const FileClaimHistoryResponseSchema = z
  .object({ conflicts: z.array(FileClaimConflictPairSchema) })
  .passthrough();
export type FileClaimHistoryResponse = z.infer<
  typeof FileClaimHistoryResponseSchema
>;

// Epic #1965 Sub E / #1970 — orchestrator-local batch-conflict endpoint. A stateless
// overlap + severity-hint computation over a set of issue footprints; the rp1-home
// spawn gate (#1078) is the consumer. Pure (no store, no DB writes). The severity
// formula + churn-ignore matcher live in `./conflictSeverity` (shared with #1971).

/** One issue's predicted footprint: the paths it will touch + how. */
export const ConflictFootprintSchema = z
  .object({
    // "#N" or "N" — matches the string convention of RecordFootprintRequestSchema.issue.
    issue: z.string().min(1),
    footprint: z
      .array(
        z.object({
          path: z.string().min(1).max(512),
          changeKind: ChangeKindSchema,
        })
      )
      .max(1000),
  })
  .passthrough();
export type ConflictFootprint = z.infer<typeof ConflictFootprintSchema>;

/** POST /conflict-check — pure overlap + severity-hint over a set of issue footprints. */
export const ConflictCheckRequestSchema = z
  .object({
    // Short-name or owner/name; drives the repo-aware blast-radius tiers.
    repo: z.string().min(1),
    footprints: z.array(ConflictFootprintSchema).max(500),
    // gitignore-LIKE churn globs (#1080); paths matching any are excluded from overlaps.
    ignore: z.array(z.string().min(1).max(512)).max(1000).optional(),
  })
  .passthrough();
export type ConflictCheckRequest = z.infer<typeof ConflictCheckRequestSchema>;

/** One overlap group: a path claimed by ≥2 distinct issues, with the severity hint. */
export const ConflictOverlapSchema = z
  .object({
    path: z.string(),
    issues: z.array(z.string()), // ≥2 distinct claimants, sorted
    // Resolved: the highest-weight change-kind among the claimants (conservative).
    changeKind: ChangeKindSchema,
    blastRadius: z.number(), // 0–3 (classified, repo-aware)
    concurrency: z.number(), // n = issues.length
    severityScore: z.number(), // blast × changeKindWeight × n
    severity: z.enum(["🔴", "🟡", "🟢"]), // the severity hint glyph (spec §4)
  })
  .passthrough();
export type ConflictOverlap = z.infer<typeof ConflictOverlapSchema>;

export const ConflictCheckResponseSchema = z
  .object({
    overlaps: z.array(ConflictOverlapSchema),
    // Paths excluded by the churn ignore-list (reported for transparency).
    ignoredPaths: z.array(z.string()),
  })
  .passthrough();
export type ConflictCheckResponse = z.infer<typeof ConflictCheckResponseSchema>;

// Epic #1965 (File Conflict Monitor) Sub D / #1969 — federation-wide claim sync.
// A per-node snapshot of that node's LIVE claims. This is the payload for BOTH
// sync flows: the `file-claim-delta` `SyncEvent` (fast path over the SSE event
// bridge) AND the `GET /api/federation/claims` anti-entropy response body — one
// shape, one merge path. `version` is the emitting node's monotonic (wall-clock-
// max, restart-safe) version; the CRDT merge is a per-node last-writer-wins on it
// (K1/K2 — single-writer-per-node makes the map of per-node registers conflict-
// free by construction). `claims` reuses `FileClaimSchema` (the store's
// `StoredFileClaim` rows are structurally identical), pre-filtered to the owner's
// live sessions so peers never replicate a crashed session's claims.
export const FileClaimSyncSnapshotSchema = z
  .object({
    nodeId: z.string(),
    version: z.number(),
    claims: z.array(FileClaimSchema),
  })
  .passthrough();
export type FileClaimSyncSnapshot = z.infer<typeof FileClaimSyncSnapshotSchema>;
