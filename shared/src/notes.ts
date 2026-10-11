// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session Notes content model (issue #1075).
 *
 * The persisted `notes` field on a session is an OPAQUE string at the DB layer
 * (a SQLite TEXT column) and on the wire (`SessionSummary.notes?: string`). This
 * module gives that string structure WITHOUT a schema migration:
 *
 * - New notes are a JSON-serialized {@link NotesContent} envelope
 *   `{ text, attachments }`.
 * - Legacy notes are a plain string (everything written before #1075).
 *
 * {@link parseNotes} normalizes BOTH shapes to a {@link NotesContent} on read;
 * {@link serializeNotes} produces the wire string (or `null` when empty). The
 * server never parses — it round-trips the opaque string — so the only server
 * change #1075 needs is widening the payload cap to fit the JSON envelope
 * (`notesSchema` in `server/src/web/routes/sessionMutationHandlers.ts`).
 *
 * Design decisions (directive D1–D4): a backward-compat UNION (no version field,
 * one-direction migration), attachments re-parent between prompt/notes by
 * metadata only (same `path`, no re-upload), and notes attachments share the
 * session's `UserFileUploads/` directory so session-delete cascades to them.
 */

import { z } from "zod";

/** Max attachments per notes entry (client + schema enforced). */
export const MAX_NOTES_ATTACHMENTS = 10;

/** Max characters in the notes text body (unchanged from the legacy cap). */
export const MAX_NOTES_TEXT_LENGTH = 5000;

/**
 * A single notes attachment. `path` is the session-relative
 * `UserFileUploads/<storedName>` reference; the SAME `path` is reused when an
 * attachment moves between the prompt and notes (metadata-only re-parenting).
 * Only `uploaded` and `error` attachments are ever persisted — `pending` /
 * `uploading` are mid-flight and dropped from the persisted set.
 */
export const NotesAttachmentSchema = z
  .object({
    /** Client-generated stable id (survives transfers between fields). */
    id: z.string(),
    /** Server-assigned content-addressed filename. */
    storedName: z.string(),
    /** `UserFileUploads/<storedName>` relative path. */
    path: z.string(),
    /** User-facing display name. */
    name: z.string(),
    size: z.number().optional(),
    mimeType: z.string().optional(),
    status: z.enum(["uploaded", "error"]).default("uploaded"),
    error: z.string().optional(),
  })
  .passthrough();

export const NotesContentSchema = z
  .object({
    text: z.string().max(MAX_NOTES_TEXT_LENGTH),
    attachments: z.array(NotesAttachmentSchema).max(MAX_NOTES_ATTACHMENTS),
  })
  .passthrough();

/** The persisted wire shape: legacy plain string, structured object, or null. */
export const NotesPersistedSchema = z.union([
  z.string(),
  NotesContentSchema,
  z.null(),
]);

export type NotesAttachment = z.infer<typeof NotesAttachmentSchema>;
export type NotesContent = z.infer<typeof NotesContentSchema>;

/** An empty, well-formed NotesContent — the normalized value for null/absent. */
function emptyNotes(): NotesContent {
  return { text: "", attachments: [] };
}

/**
 * Normalize any persisted notes value to a {@link NotesContent}.
 *
 * - `null` / `undefined` → `{ text: "", attachments: [] }`
 * - a plain string (legacy) → `{ text: <string>, attachments: [] }`
 * - a stringified JSON envelope → parsed + schema-validated
 * - an already-parsed object → schema-validated
 * - anything malformed → `{ text: "", attachments: [] }` (never throws)
 *
 * Never throws: a malformed persisted value degrades to empty rather than
 * crashing the notes UI on read.
 */
export function parseNotes(raw: unknown): NotesContent {
  if (raw === null || raw === undefined) return emptyNotes();

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    // A JSON object envelope always starts with "{". Anything else is a legacy
    // plain-string note — return it verbatim as the text body.
    if (trimmed.startsWith("{")) {
      try {
        const decoded: unknown = JSON.parse(raw);
        const parsed = NotesContentSchema.safeParse(decoded);
        if (parsed.success) return parsed.data;
      } catch {
        // Not valid JSON after all — fall through to legacy-string handling.
      }
    }
    return { text: raw, attachments: [] };
  }

  const parsed = NotesContentSchema.safeParse(raw);
  return parsed.success ? parsed.data : emptyNotes();
}

/**
 * Produce the persisted wire string for a {@link NotesContent}, or `null` when
 * the note is entirely empty (no text and no attachments) so an empty note
 * clears the field rather than storing `{"text":"","attachments":[]}`.
 */
export function serializeNotes(content: NotesContent | null): string | null {
  if (!content) return null;
  if (!content.text && content.attachments.length === 0) return null;
  return JSON.stringify(content);
}
