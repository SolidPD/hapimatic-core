// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

/**
 * Turn-ledger mirror feed + digest wire schemas (issue #4614).
 *
 * The feed is the node-to-node replication surface: a puller asks an origin for
 * its finalized turns (and timelog_adjustments) changed since a per-origin
 * cursor, and stores them in a SEPARATE mirror store so existing readers never
 * double-count. `.passthrough()` on the row schemas tolerates an origin that
 * ships fields a newer schema added — the puller keeps the row (R9); the FULL
 * origin row additionally rides in `rowJson` so nothing is ever dropped.
 */

/** One mirrored turn row. Projected columns are queryable; `rowJson` is the full origin row. */
export const MirrorTurnRowSchema = z
  .object({
    turnId: z.string(),
    changeSeq: z.number(),
    hapiSessionId: z.string(),
    namespace: z.string().nullable(),
    status: z.string(),
    startedAtMs: z.number().nullable(),
    endedAtMs: z.number().nullable(),
    durationMs: z.number().nullable(),
    /** The FULL origin `turns` row as JSON — preserves columns unknown to the puller (R9). */
    rowJson: z.string(),
  })
  .passthrough();
export type MirrorTurnRow = z.infer<typeof MirrorTurnRowSchema>;

/** One mirrored timelog_adjustments row. */
export const MirrorAdjustmentRowSchema = z
  .object({
    adjustmentId: z.string(),
    changeSeq: z.number(),
    hapiSessionId: z.string(),
    namespace: z.string().nullable(),
    tsMs: z.number().nullable(),
    rowJson: z.string(),
  })
  .passthrough();
export type MirrorAdjustmentRow = z.infer<typeof MirrorAdjustmentRowSchema>;

/**
 * A single feed page. `incarnation` is the origin db's ledger identity (changes
 * on a rebuilt VM); `maxChangeSeq`/`adjMaxChangeSeq` are the origin's current
 * high-water marks (used for lag + the rewind-detection resync, R5). `nextCursor`
 * / `adjNextCursor` are what the puller stores to resume.
 */
export const TurnFeedPageSchema = z
  .object({
    incarnation: z.string(),
    maxChangeSeq: z.number(),
    adjMaxChangeSeq: z.number(),
    turns: z.array(MirrorTurnRowSchema),
    adjustments: z.array(MirrorAdjustmentRowSchema),
    nextCursor: z.number(),
    adjNextCursor: z.number(),
  })
  .passthrough();
export type TurnFeedPage = z.infer<typeof TurnFeedPageSchema>;

/** Per-UTC-day (count, checksum) fingerprint for silent-drift detection (R10). */
export const TurnFeedDigestDaySchema = z.object({
  date: z.string(),
  count: z.number(),
  checksum: z.number(),
});
export type TurnFeedDigestDay = z.infer<typeof TurnFeedDigestDaySchema>;

export const TurnFeedDigestSchema = z
  .object({
    incarnation: z.string(),
    days: z.array(TurnFeedDigestDaySchema),
  })
  .passthrough();
export type TurnFeedDigest = z.infer<typeof TurnFeedDigestSchema>;

/** Per-origin mirror sync status surfaced by the status read (R6). */
export const TurnMirrorOriginStatusSchema = z.object({
  originNodeId: z.string(),
  originIncarnation: z.string(),
  turnCursor: z.number(),
  adjCursor: z.number(),
  lastOriginMaxSeq: z.number().nullable(),
  lastSyncAtMs: z.number().nullable(),
  lagMs: z.number().nullable(),
  mirroredTurnCount: z.number(),
});
export type TurnMirrorOriginStatus = z.infer<
  typeof TurnMirrorOriginStatusSchema
>;
