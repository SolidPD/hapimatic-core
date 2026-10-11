// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Client-side attachment validation for the feedback form (issue #2665, epic
 * #2663). Reuses the prompt attachment stack's helpers — `isFileAllowed`
 * (extension allowlist, `allowed-file-types.ts`) and `dedupeFilename`
 * (`useAttachments.ts`) — plus the SHARED caps from `@hapi/protocol/schemas`, so
 * the modal and the server route enforce ONE set of rules. The server
 * (`feedback.ts`) re-validates every field; this layer is UX-only.
 *
 * Validation is intentionally split from the async byte-read: `planAttachment
 * Additions` is a PURE function over `{name, type, size}` descriptors, so the
 * modal validates (extension + count + total size, all knowable from `File`
 * metadata) BEFORE reading any bytes — an oversize file is rejected without a
 * wasteful base64 read.
 */

import { isFileAllowed } from "@/lib/allowed-file-types";
import { dedupeFilename } from "@/hooks/useAttachments";
import {
  FEEDBACK_MAX_ATTACHMENTS,
  FEEDBACK_MAX_ATTACHMENT_TOTAL_BYTES,
} from "@hapi/protocol/schemas";
import type { FeedbackAttachment } from "@/types/api";

/**
 * A file the user has picked but not yet submitted. `data` is base64 (with NO
 * `data:...;base64,` prefix — that is stripped by {@link readFileAsBase64}).
 */
export interface PendingFeedbackAttachment {
  /** Stable local id for React keys / remove targeting. */
  id: string;
  /** Deduped display name (also sent as the attachment filename). */
  filename: string;
  mimeType: string;
  /** Size in bytes (from `File.size`, pre-read). */
  size: number;
  /** Base64-encoded file bytes. */
  data: string;
}

/** Minimal shape needed to validate a candidate — `File` structurally matches. */
export interface CandidateFile {
  name: string;
  type: string;
  size: number;
}

/** An accepted candidate, with its deduped name + source index for the byte-read. */
export interface PlannedAddition {
  filename: string;
  mimeType: string;
  size: number;
  /** Index into the `candidates` array — the modal reads THIS file's bytes. */
  sourceIndex: number;
}

/**
 * Same "Unsupported file type" copy the prompt attachment feature surfaces
 * (`useAttachments.ts`), so the feedback rejection reads identically (V1 parity).
 */
export const UNSUPPORTED_FILE_TYPE_MESSAGE = "Unsupported file type";

/** Human-readable total-cap in MB, for messaging. */
const TOTAL_CAP_MB = FEEDBACK_MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024;

/**
 * PURE. Given the already-pending attachments and a batch of freshly-picked
 * candidate files, decide which are acceptable. Enforces, in order: the
 * extension allowlist (prompt-feature parity), the shared count cap, and the
 * shared total-byte cap (summed across pending + accepted-so-far). Returns the
 * planned additions (with deduped filenames) plus a human-readable error per
 * rejected candidate. No bytes are read here.
 */
export function planAttachmentAdditions(
  existing: PendingFeedbackAttachment[],
  candidates: CandidateFile[]
): { planned: PlannedAddition[]; errors: string[] } {
  const planned: PlannedAddition[] = [];
  const errors: string[] = [];
  const taken = new Set(existing.map(a => a.filename));
  let count = existing.length;
  let total = existing.reduce((sum, a) => sum + a.size, 0);

  candidates.forEach((candidate, index) => {
    if (!isFileAllowed(candidate.name)) {
      errors.push(`${candidate.name}: ${UNSUPPORTED_FILE_TYPE_MESSAGE}`);
      return;
    }
    if (count >= FEEDBACK_MAX_ATTACHMENTS) {
      errors.push(
        `${candidate.name}: too many attachments (max ${FEEDBACK_MAX_ATTACHMENTS})`
      );
      return;
    }
    if (total + candidate.size > FEEDBACK_MAX_ATTACHMENT_TOTAL_BYTES) {
      errors.push(
        `${candidate.name}: attachments exceed ${TOTAL_CAP_MB} MB total`
      );
      return;
    }
    const filename = dedupeFilename(candidate.name, taken);
    taken.add(filename);
    count += 1;
    total += candidate.size;
    planned.push({
      filename,
      mimeType: candidate.type || "application/octet-stream",
      size: candidate.size,
      sourceIndex: index,
    });
  });

  return { planned, errors };
}

/**
 * Read a `File`'s bytes as base64, with NO `data:<mime>;base64,` prefix — the
 * shape the feedback payload / AgentMail `content` field expects. Rejects on a
 * `FileReader` error rather than resolving to a partial string.
 */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("File read failed"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unexpected FileReader result"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

/** Map the pending list to the submit-payload attachment shape (drops id/size). */
export function toFeedbackAttachments(
  pending: PendingFeedbackAttachment[]
): FeedbackAttachment[] {
  return pending.map(a => ({
    filename: a.filename,
    mimeType: a.mimeType,
    data: a.data,
  }));
}
