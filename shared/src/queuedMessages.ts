// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

/**
 * Server-backed message queue (issue #1325).
 *
 * Replaces the per-tab sessionStorage queue in web/src/hooks/useMessageQueue.ts
 * so that idle-driven drain can fire regardless of which (if any) client view is
 * mounted. The queue lives on the owning peer node; the hub proxies mutations.
 *
 * Idempotency: `clientGeneratedId` is a stable per-(sessionId, position, body)
 * hash used by the legacy-sessionStorage migration path. The server enforces a
 * partial unique index on (session_id, client_generated_id WHERE NOT NULL) so
 * re-running migration produces a deduplicated no-op rather than duplicate rows.
 */
export const QueuedMessageSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string(),
  namespace: z.string(),
  body: z.string().min(1),
  position: z.number().int().nonnegative(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  clientGeneratedId: z.string().nullable(),
});
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;

export const EnqueueQueuedMessageSchema = z.object({
  body: z.string().min(1),
  clientGeneratedId: z.string().nullable().optional(),
});
export type EnqueueQueuedMessage = z.infer<typeof EnqueueQueuedMessageSchema>;

export const UpdateQueuedMessageSchema = z.object({
  body: z.string().min(1),
});
export type UpdateQueuedMessage = z.infer<typeof UpdateQueuedMessageSchema>;

export const ListQueuedMessagesResponseSchema = z.object({
  messages: z.array(QueuedMessageSchema),
});
export type ListQueuedMessagesResponse = z.infer<
  typeof ListQueuedMessagesResponseSchema
>;

export const DrainQueueResponseSchema = z.object({
  ok: z.literal(true),
  sent: z.boolean(),
  remaining: z.number().int().nonnegative(),
});
export type DrainQueueResponse = z.infer<typeof DrainQueueResponseSchema>;
