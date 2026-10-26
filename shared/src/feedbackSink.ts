// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Universal feedback sink — canonical wire + stored-row shapes (issue #2911,
 * epic #2909 Sub B).
 *
 * Every Hapimatic instance (customer VM or operator node) forwards each locally
 * persisted feedback row to the gateway's `POST /api/feedback-sink`; the gateway
 * stores it in its central `central_feedback` table, the store of record the
 * #2912 inbox reads. The local row stays the durable buffer.
 *
 * 🔴 CANONICAL SOURCE. The gateway is deployed standalone and cannot import this
 * package, so it keeps a self-contained replica at
 * `gateway/src/lib/feedbackSink.ts`. Change both together: the two test files
 * parse the same literal fixtures, and `feedbackSink.test.ts` here fails if the
 * fixture blocks drift apart.
 *
 * The payload carries NO `originKind` and no attachment bytes: the gateway
 * derives the origin kind from the credential that authenticated the call, and
 * only attachment REFS (`filename`, `mimeType`, `size`) ever leave the instance.
 * Unknown keys are stripped (`z.object`'s default), so an older or hostile
 * sender cannot smuggle either one in.
 *
 * Import this module through the `@hapi/protocol/feedbackSink` subpath, never
 * the root barrel.
 */
import { z } from "zod";

import { FeedbackEntryCategorySchema } from "./schemas";

/** Hard cap on the raw sink request body, enforced by the gateway before parse. */
export const FEEDBACK_SINK_MAX_BODY_BYTES = 64 * 1024;

/**
 * Cap on the serialized `metadata` the sink stores. A larger object is replaced
 * by {@link truncateSinkMetadata}'s marker rather than rejected, so a row is
 * never lost over its metadata.
 */
export const FEEDBACK_SINK_METADATA_MAX_BYTES = 32 * 1024;

/** Maximum attachment refs per row (mirrors `FEEDBACK_MAX_ATTACHMENTS`). */
export const FEEDBACK_SINK_MAX_ATTACHMENTS = 5;

/** Longest `description` the sink accepts (the request cap; scrubbing can lengthen text past it). */
export const FEEDBACK_SINK_DESCRIPTION_MAX = 5000;
/** Longest attachment `filename` the sink accepts. */
export const FEEDBACK_SINK_FILENAME_MAX = 255;
/** Longest attachment `mimeType` the sink accepts. */
export const FEEDBACK_SINK_MIME_TYPE_MAX = 127;

/**
 * An origin instance id: a hostname-like token (a subdomain, a federation node
 * id or `os.hostname()`), part of the central idempotency key.
 */
export const FEEDBACK_SINK_ORIGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One attachment reference. The bytes never travel to the sink. */
export const FeedbackSinkAttachmentRefSchema = z.object({
  filename: z.string().min(1).max(FEEDBACK_SINK_FILENAME_MAX),
  mimeType: z.string().min(1).max(FEEDBACK_SINK_MIME_TYPE_MAX),
  size: z.number().int().min(0),
});
export type FeedbackSinkAttachmentRef = z.infer<
  typeof FeedbackSinkAttachmentRefSchema
>;

/**
 * Body of `POST /api/feedback-sink`. `localRowId` + the origin instance id form
 * the idempotency key, so a re-forward never duplicates a central row.
 * `createdAt`, `appVersion` and `submitterEmail` are advisory claims; the
 * gateway stamps its own `receivedAt`. A customer VM sends null origin fields
 * (the gateway derives them from its relay token); an operator node must send
 * `originInstanceId`.
 */
export const FeedbackSinkPayloadSchema = z.object({
  localRowId: z.uuid(),
  createdAt: z.number().int().min(0),
  originInstanceId: z
    .string()
    .min(1)
    .max(64)
    .regex(FEEDBACK_SINK_ORIGIN_ID_RE)
    .nullable(),
  originLabel: z.string().min(1).max(64).nullable(),
  appVersion: z.string().max(64).nullable(),
  category: FeedbackEntryCategorySchema,
  description: z.string().min(1).max(FEEDBACK_SINK_DESCRIPTION_MAX),
  submitterEmail: z.string().max(320).nullable(),
  metadata: z.record(z.string(), z.unknown()),
  attachments: z
    .array(FeedbackSinkAttachmentRefSchema)
    .max(FEEDBACK_SINK_MAX_ATTACHMENTS)
    .optional(),
});
export type FeedbackSinkPayload = z.infer<typeof FeedbackSinkPayloadSchema>;

/** `200` body of `POST /api/feedback-sink`: the central row id. */
export const FeedbackSinkResponseSchema = z.object({
  id: z.string().min(1),
  duplicate: z.boolean(),
});
export type FeedbackSinkResponse = z.infer<typeof FeedbackSinkResponseSchema>;

/** Who a central row came from, derived by the gateway from the credential. */
export const FeedbackOriginKindSchema = z.enum(["operator", "customer"]);
export type FeedbackOriginKind = z.infer<typeof FeedbackOriginKindSchema>;

/**
 * One `central_feedback` row as the gateway reads it back (camelCase mirror of
 * the table's columns). #2912 extends it with its lifecycle fields.
 */
export const CentralFeedbackRowSchema = z.object({
  id: z.string(),
  receivedAt: z.number().int(),
  createdAt: z.number().int(),
  /**
   * The sender's `createdAt` exactly as received, kept only when the gateway
   * clamped it (#5799); otherwise null. Sender-reported, never trusted. A row
   * from a gateway that predates the column reads as null.
   */
  claimedCreatedAt: z.number().int().nullable().default(null),
  originInstanceId: z.string(),
  originLabel: z.string(),
  originKind: FeedbackOriginKindSchema,
  localRowId: z.string(),
  instanceOwnerEmails: z.array(z.string()).nullable(),
  submitterEmail: z.string().nullable(),
  appVersion: z.string().nullable(),
  category: FeedbackEntryCategorySchema,
  description: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  attachments: z.array(FeedbackSinkAttachmentRefSchema).nullable(),
});
export type CentralFeedbackRow = z.infer<typeof CentralFeedbackRowSchema>;

/**
 * Bound a metadata object for the sink: returned unchanged when its JSON
 * serialization fits {@link FEEDBACK_SINK_METADATA_MAX_BYTES}, otherwise
 * replaced by `{ _truncated: true, originalBytes }`.
 */
export function truncateSinkMetadata(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  const bytes = new TextEncoder().encode(JSON.stringify(metadata)).length;
  return bytes > FEEDBACK_SINK_METADATA_MAX_BYTES
    ? { _truncated: true, originalBytes: bytes }
    : metadata;
}
