// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-session result of a bulk session action (#3815, epic #4406 contract K1).
 *
 * ONE shape for every bulk action — Stop turn (`POST /api/sessions/bulk-abort`),
 * Disconnect (`/bulk-archive`), Delete (`/bulk-delete`, additive `results`),
 * the web Connect loop, and #3818's send-to-selected — so the summary toast,
 * the `hapi api sessions bulk-*` subcommands and the UI all report the same
 * per-session outcomes. Each item names ONE session; the array keeps request
 * order.
 *
 * Buckets (`summarizeBulkSessionResult`, web/src/lib/bulkSessionToast.ts):
 *   done    = ok && code !== "queued"
 *   queued  = ok && code === "queued"
 *   skipped = skipped === true            (always ok: false)
 *   failed  = !ok && !skipped
 *
 * Any failure outside the code vocabulary is `{ id, ok: false, error }` with
 * no `code`. Imports only `zod` on purpose: `schemas.ts` is a shared hotspot.
 */
import { z } from "zod";

/** The whole `code` vocabulary — the toast and the CLI switch on it. */
export const BULK_SESSION_RESULT_CODES = [
  /** The action needs an active session and this one is disconnected. */
  "session_inactive",
  /** Stop turn on a session that is not mid-turn (`thinking` false). */
  "session_idle",
  /** Delete refused because the session is still connected. */
  "session_active",
  /** #4000's refusal for a row that is still spawning. */
  "session_spawning",
  /** The owning node is known but offline. */
  "node_offline",
  /** No node knows this id. */
  "not_found",
  /** The id belongs to another namespace (never retried on a remote node). */
  "forbidden",
  /** ok: true — the prompt was queued, not delivered yet (#3818's send). */
  "queued",
  /** A message hook refused the prompt (#3818's send). */
  "denied",
] as const;

export type BulkSessionResultCode = (typeof BULK_SESSION_RESULT_CODES)[number];

/** The codes that mark a session as SKIPPED (`ok: false, skipped: true`). */
export const BULK_SESSION_SKIP_CODES = [
  "session_inactive",
  "session_idle",
  "session_active",
  "session_spawning",
] as const satisfies readonly BulkSessionResultCode[];

/** Server cap on ids per bulk request; clients chunk by it. */
export const BULK_SESSION_MAX_IDS = 100;

export const BulkSessionResultItemSchema = z
  .object({
    id: z.string(),
    ok: z.boolean(),
    skipped: z.literal(true).optional(),
    code: z.enum(BULK_SESSION_RESULT_CODES).optional(),
    error: z.string().optional(),
    /** Stop turn only (ruling D2): prompts still queued on a stopped session. */
    queued: z.number().int().nonnegative().optional(),
  })
  .superRefine((item, ctx) => {
    if (item.skipped === true && item.ok) {
      ctx.addIssue({
        code: "custom",
        message: "skipped implies ok: false",
        path: ["skipped"],
      });
    }
    if (item.ok && item.code !== undefined && item.code !== "queued") {
      ctx.addIssue({
        code: "custom",
        message: `code "${item.code}" is a failure code; ok must be false`,
        path: ["code"],
      });
    }
    if (!item.ok && item.code === "queued") {
      ctx.addIssue({
        code: "custom",
        message: 'code "queued" implies ok: true',
        path: ["code"],
      });
    }
    const isSkipCode = (BULK_SESSION_SKIP_CODES as readonly string[]).includes(
      item.code ?? ""
    );
    if (isSkipCode !== (item.skipped === true)) {
      ctx.addIssue({
        code: "custom",
        message: isSkipCode
          ? `code "${item.code}" is a skip code; skipped must be true`
          : "skipped: true needs a skip code",
        path: ["skipped"],
      });
    }
  });

export const BulkSessionResultSchema = z.array(BulkSessionResultItemSchema);

export type BulkSessionResultItem = z.infer<typeof BulkSessionResultItemSchema>;
export type BulkSessionResult = BulkSessionResultItem[];

/** Response body of `POST /api/sessions/bulk-abort` and `/bulk-archive`. */
export const BulkSessionActionResponseSchema = z.object({
  ok: z.literal(true),
  results: BulkSessionResultSchema,
});

export type BulkSessionActionResponse = z.infer<
  typeof BulkSessionActionResponseSchema
>;
