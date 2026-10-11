// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

// Server-side chat bookmarks with arbitrary-row anchoring (issue #3115, epic
// #3133). This module is the SINGLE cross-package contract for the bookmark
// feature — the persisted model AND the API request/response shapes are designed
// together here (the epic's "get the schema right the first time" Design
// Decision) so the SQLite store (server), the Hono routes (server), and the
// TanStack-Query hook (web) all validate against one source of truth.
//
// ## The anchor model — `{ messageId, blockId, offsetPx }` (scroll position, #3146)
//
// A bookmark is a POSITION in the scrollable area — the exact vertical spot the
// user double-tapped. It anchors to a nearest STABLE element (`messageId` +
// optional inner `blockId`) PLUS a `offsetPx` — the pixel offset of the tapped
// spot from the top of that element. Messages and blocks have ZERO VISIBLE
// standing (issue #3146): the bookmark icon renders AT the tapped spot (not the
// element's top), placement never snaps to a message/block start, and there is
// no per-block visual treatment. The block is used only as a durability
// reference so the offset survives a streaming re-render and reproduces
// cross-device (block ids are stable by construction; `offsetPx` reproduces the
// exact tapped row within that stable element). `blockId: null` anchors the
// offset to the whole turn (the message root). `offsetPx` defaults to 0 (the
// element top) for a legacy row migrated from the pre-#3146 block-anchor model.
//
// ## `anchorHeightPx` — layout-invariant landing (issue #3878, ruling A1′)
//
// `offsetPx` is frozen at creation, but the anchor element's rendered height is
// not stable (image / shiki / tool-card settle, text-scale, nested collapse), so
// a raw offset drifts onto different content. The bookmark ALSO records the
// height of the element the offset was measured from; jump and icon scale
// `offsetPx * (heightNow / anchorHeightPx)` — only when both are > 0 AND the
// resolved element IS that element (never against the message-strip fallback),
// else the raw `offsetPx`. `null` = a legacy row (raw offset). The block stays an
// internal durability reference (#3146 R7); nothing snaps to a block start.

/**
 * A persisted bookmark as returned by the API. `createdAt` is an ISO-8601 UTC
 * string (the store keeps epoch-ms internally and converts on read).
 */
export const BookmarkSchema = z
  .object({
    /** Surrogate id (server-generated UUID) — the DELETE target. */
    id: z.string(),
    /** The assistant-ui turn message id the bookmark belongs to. */
    messageId: z.string(),
    /** The inner block id used as the durability reference; null = whole-turn (message root). */
    blockId: z.string().nullable(),
    /**
     * Pixel offset of the tapped spot from the top of the anchor element (the
     * block when `blockId` is set, else the message root). Reproduces the exact
     * scroll position (issue #3146). Non-negative; 0 = the element top.
     */
    offsetPx: z.number(),
    /**
     * Rendered height (CSS px, rounded) of the element `offsetPx` was measured
     * from, captured at creation (issue #3878). `null` = legacy row — navigation
     * and the icon use the raw `offsetPx`.
     */
    anchorHeightPx: z.number().nullable(),
    /** ISO-8601 UTC creation timestamp. */
    createdAt: z.string(),
  })
  .passthrough();
export type Bookmark = z.infer<typeof BookmarkSchema>;

/** `GET /api/sessions/:id/bookmarks` response. */
export const BookmarkListResponseSchema = z
  .object({
    bookmarks: z.array(BookmarkSchema),
  })
  .passthrough();
export type BookmarkListResponse = z.infer<typeof BookmarkListResponseSchema>;

/**
 * `PUT /api/sessions/:id/bookmarks` request body — upsert one bookmark. Idempotent
 * on `(sessionId, messageId, blockId, offsetPx)`: a repeat PUT at the SAME spot
 * returns the existing row (the store's
 * `UNIQUE(session_id, message_id, COALESCE(block_id,''), offset_px)` index
 * resolves the conflict), while a DIFFERENT `offsetPx` creates a distinct
 * bookmark — so a single message/block can hold multiple bookmarks at arbitrary
 * spots (issue #3146). `blockId` omitted OR null both mean the whole-turn anchor;
 * `offsetPx` omitted defaults to 0.
 */
export const BookmarkUpsertRequestSchema = z
  .object({
    messageId: z.string().min(1),
    blockId: z.string().min(1).nullable().optional(),
    offsetPx: z.number().nonnegative().optional(),
    /** Height of the offset's anchor element at creation (#3878); omitted/null = unknown. */
    anchorHeightPx: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough();
export type BookmarkUpsertRequest = z.infer<typeof BookmarkUpsertRequestSchema>;

/** `PUT /api/sessions/:id/bookmarks` response — the created-or-existing bookmark. */
export const BookmarkUpsertResponseSchema = z
  .object({
    bookmark: BookmarkSchema,
  })
  .passthrough();
export type BookmarkUpsertResponse = z.infer<
  typeof BookmarkUpsertResponseSchema
>;

/**
 * Stable DOM/selector key for a bookmark anchor. The chat gutter tags whole-turn
 * anchors with `data-bookmark-id={messageId}`; block anchors are tagged with
 * this compound key so the SAME `[data-bookmark-id]` + set-membership navigation
 * (`useBookmarkNavigation`) jumps to a block without any special-casing. A null
 * `blockId` collapses to the bare `messageId` (the pre-#3115 whole-turn key), so
 * an existing whole-turn bookmark keeps its exact key.
 */
export function bookmarkAnchorKey(
  messageId: string,
  blockId: string | null | undefined
): string {
  return blockId ? `${messageId}::${blockId}` : messageId;
}
