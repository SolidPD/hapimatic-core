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
 * Inside `failed`, Delete (#6681) marks two kinds of not-done item with a flag,
 * never a code (an older CLI rejects an unknown code; an older client reads a
 * flagged item as today's code-less failure):
 *   pending = pending === true  (sent; the outcome is unknown and the delete
 *                                may still complete; the web decides it from
 *                                a direct read)
 *   retry   = retry === true    (never sent; safe to send again)
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

/**
 * #6681 (D3 = 1): how long one bulk delete keeps resending `retry` ids, from
 * its first request. The web's round loop and the CLI's resend both use it.
 */
export const BULK_DELETE_BUDGET_MS = 300_000;

export const BulkSessionResultItemSchema = z
  .object({
    id: z.string(),
    ok: z.boolean(),
    skipped: z.literal(true).optional(),
    code: z.enum(BULK_SESSION_RESULT_CODES).optional(),
    error: z.string().optional(),
    /** Stop turn only (ruling D2): prompts still queued on a stopped session. */
    queued: z.number().int().nonnegative().optional(),
    /** #6681 (Delete): outcome unknown, the action may still complete. */
    pending: z.literal(true).optional(),
    /** #6681 (Delete): not sent, safe to send again. */
    retry: z.literal(true).optional(),
  })
  .superRefine((item, ctx) => {
    const flagged = item.pending === true || item.retry === true;
    if (item.pending === true && item.retry === true) {
      ctx.addIssue({
        code: "custom",
        message: "an item is pending or retry, never both",
        path: ["retry"],
      });
    }
    if (flagged) {
      const flag = item.pending === true ? "pending" : "retry";
      if (item.ok) {
        ctx.addIssue({
          code: "custom",
          message: `${flag} implies ok: false`,
          path: [flag],
        });
      }
      if (item.skipped !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `${flag} never carries skipped`,
          path: ["skipped"],
        });
      }
      if (item.code !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `${flag} never carries a code`,
          path: ["code"],
        });
      }
      if (!item.error) {
        ctx.addIssue({
          code: "custom",
          message: `${flag} needs a non-empty error`,
          path: ["error"],
        });
      }
    }
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
