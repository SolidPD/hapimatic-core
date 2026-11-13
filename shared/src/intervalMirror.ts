// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

/**
 * Billable interval feed wire schemas (issue #6586, R11).
 *
 * A puller asks an origin for its CLOSED thinking intervals changed since a
 * per-origin cursor and stores them in a separate mirror table, so a report works
 * while the origin is offline. `.passthrough()` on the row and the page tolerates
 * fields a newer origin adds; the full origin row also rides in `rowJson`.
 */

/** One mirrored closed interval. Projected columns are queryable; `rowJson` is the full origin row. */
export const MirrorIntervalRowSchema = z
  .object({
    intervalId: z.string(),
    changeSeq: z.number(),
    hapiSessionId: z.string(),
    namespace: z.string(),
    launcherKind: z.string(),
    startedAtMs: z.number(),
    endedAtMs: z.number(),
    durationMs: z.number(),
    endCause: z.string(),
    rowJson: z.string(),
  })
  .passthrough();
export type MirrorIntervalRow = z.infer<typeof MirrorIntervalRowSchema>;

/**
 * One feed page. `incarnation` is the origin database's ledger identity;
 * `mode` is the origin's effective billable mode (a plain string, so a mode added
 * later does not make an older puller drop the page); `maxChangeSeq` is the
 * high-water mark over closed rows; `nextCursor` is what the puller stores.
 */
export const IntervalFeedPageSchema = z
  .object({
    incarnation: z.string(),
    mode: z.string(),
    maxChangeSeq: z.number(),
    intervals: z.array(MirrorIntervalRowSchema),
    nextCursor: z.number(),
  })
  .passthrough();
export type IntervalFeedPage = z.infer<typeof IntervalFeedPageSchema>;
