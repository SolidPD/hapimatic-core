// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

/**
 * Parsed-changelog-span contract (issue #1771, epic #1769 "Claude Code
 * self-update from the admin drawer").
 *
 * This is the SINGLE SOURCE OF TRUTH for the `ChangelogSpan` wire type — the
 * shape the server's `GET /api/harness/:harnessId/changelog` route returns and
 * the #1773 admin-drawer panel renders. #1773 imports it from `@hapi/protocol`
 * and MUST NOT declare a web-local copy (locked epic contract: one owner).
 *
 * Sub A (#1770) owns the descriptor/detection-state types (`shared/src/harness.ts`);
 * this issue owns the changelog-DISPLAY type. Kept in a SEPARATE file so it can
 * never collide with `harness.ts`. The raw changelog body is NOT a field here —
 * it is served server-side via `HarnessStore.getChangelogText` and parsed into
 * this span; the ~126 KB text never rides the wire.
 *
 * ── Wire convention ──
 * Fields are snake_case on the wire (locked contract — no camelizing mapper in
 * web). `.passthrough()` mirrors the `harness.ts` family so a later sub-issue
 * (#1772 analysis, #1773 panel) can add forward-compatible fields without
 * breaking an older consumer.
 *
 * ── Reason taxonomy ──
 *   "ok"                  — a successful parse (may be an empty span when the
 *                           harness is already up to date: installed == latest).
 *   "no-changelog-source" — the descriptor carries no usable changelog source
 *                           (missing/empty URL). Nothing to show, not an error.
 *   "not-cached"          — a URL exists but #1770's poll has not cached text yet
 *                           (or the last fetch failed); retry after the next poll.
 *   "unparseable"         — the cached text has zero recognizable version sections
 *                           (Anthropic shifted the CHANGELOG.md format); the caller
 *                           should surface `changelog_url` as a link (R4).
 *   "capped"              — a span was served but bounded to the most-recent
 *                           `SPAN_CAP` versions (e.g. `installed` unknown); still
 *                           `available: true`, `truncated: true`.
 *
 * NOTE: "not-ready" (the #1770-data-source-absent 503, R6) is deliberately NOT a
 * member — that 503 body is an ad-hoc `{ error, reason: "not-ready" }`, never a
 * `ChangelogSpan`, so a member here would be dead weight for consumers switching
 * on `span.reason`.
 */

/** One version's verbatim content: the bare semver plus its lines in order.
 *  `bullets` holds bullet TEXT (the content after `- `) plus any non-bullet
 *  lines retained raw (partial format drift — R5 never silently drops content). */
export const ChangelogVersionEntrySchema = z
  .object({
    version: z.string(),
    bullets: z.array(z.string()),
  })
  .passthrough();

export type ChangelogVersionEntry = z.infer<typeof ChangelogVersionEntrySchema>;

export const ChangelogSpanReasonSchema = z.enum([
  "ok",
  "no-changelog-source",
  "not-cached",
  "unparseable",
  "capped",
]);

export type ChangelogSpanReason = z.infer<typeof ChangelogSpanReasonSchema>;

export const ChangelogSpanSchema = z
  .object({
    /** Whether any changelog content is being served. `false` for every
     *  degraded reason ("no-changelog-source" / "not-cached" / "unparseable"). */
    available: z.boolean(),
    harness_id: z.string(),
    /** Installed version (from #1770's detection state); null when undetected. */
    installed: z.string().nullable(),
    /** Latest available version; null when the latest fetch has not succeeded. */
    latest: z.string().nullable(),
    /** The per-version entries in the `installed < v <= latest` span,
     *  latest-first. Empty when `!available` OR when already up to date. */
    versions: z.array(ChangelogVersionEntrySchema),
    /** True when the span was capped to `SPAN_CAP` versions (paired with
     *  `reason: "capped"`). */
    truncated: z.boolean(),
    /** Count of non-bullet lines retained raw within the SERVED versions — the
     *  partial-format-drift telemetry signal the route logs (R5). */
    drift_line_count: z.number(),
    /** The changelog URL, populated for the R4 link fallback and the degraded
     *  cases so a caller can always offer a "view changelog" link. */
    changelog_url: z.string().nullable(),
    reason: ChangelogSpanReasonSchema,
  })
  .passthrough();

export type ChangelogSpan = z.infer<typeof ChangelogSpanSchema>;
