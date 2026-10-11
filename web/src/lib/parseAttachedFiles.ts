// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Parse attached file paths from a user message.
 *
 * HappyComposer appends file references in this format:
 * ```
 * ---
 * 📎 **Attached files** (read from filesystem):
 * ```
 *   UserFileUploads/2026-03-16_screenshot_abc123.png
 *   UserFileUploads/2026-03-16_document_def456.pdf
 * ```
 * ```
 *
 * Returns an object with:
 * - `textBeforeAttachments`: the message text without the attachment block
 * - `files`: array of { path, filename, isImage }
 */

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
]);

export interface AttachedFile {
  /** Full relative path, e.g. "UserFileUploads/2026-03-16_screenshot_abc123.png" */
  path: string;
  /** Just the filename, e.g. "2026-03-16_screenshot_abc123.png" */
  filename: string;
  /** Whether this file is an image based on extension */
  isImage: boolean;
}

export interface ParsedAttachedFiles {
  /** The message text with the attachment block removed */
  textBeforeAttachments: string;
  /** Extracted file references */
  files: AttachedFile[];
}

/**
 * Regex that matches the attached files block appended by HappyComposer.
 * Captures the code block content (file paths, one per line).
 */
const ATTACHED_FILES_PATTERN =
  /\n\n---\n📎 \*\*Attached files\*\* \(read from filesystem\):\n```\n([\s\S]*?)\n```$/;

export function parseAttachedFiles(text: string): ParsedAttachedFiles {
  const match = text.match(ATTACHED_FILES_PATTERN);

  if (!match) {
    return { textBeforeAttachments: text, files: [] };
  }

  const textBeforeAttachments = text.slice(0, match.index!);
  const pathsBlock = match[1];

  const files: AttachedFile[] = pathsBlock
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(path => {
      const lastSlash = path.lastIndexOf("/");
      const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
      const lastDot = filename.lastIndexOf(".");
      const ext = lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : "";
      return {
        path,
        filename,
        isImage: IMAGE_EXTENSIONS.has(ext),
      };
    });

  return { textBeforeAttachments, files };
}
