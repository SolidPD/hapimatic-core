// SPDX-License-Identifier: MIT
/**
 * Parse image attachments from user messages and convert them to
 * base64 content blocks for direct injection into the Claude API.
 *
 * This bypasses Claude Code's internal Read tool (which resizes images)
 * and sends images directly as base64 content blocks, ensuring the
 * highest resolution reaches the API (subject to the 1568px auto-resize
 * that the API applies on its own).
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@/ui/logger";

/** Claude API supported image media types */
const MEDIA_TYPE_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Max base64 payload size per image (Claude API limit) */
const MAX_BASE64_BYTES = 5 * 1024 * 1024;

/**
 * Regex matching the attached files block appended by HappyComposer.
 * Must match the pattern in web/src/lib/parseAttachedFiles.ts.
 */
const ATTACHED_FILES_PATTERN =
  /\n\n---\n📎 \*\*Attached files\*\* \(read from filesystem\):\n```\n([\s\S]*?)\n```$/;

/** A single content block in a structured user message.
 *  Index signature included for SDKUserMessage.content compatibility. */
interface TextBlock {
  type: "text";
  text: string;
  [key: string]: unknown;
}

interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
  [key: string]: unknown;
}

type ContentBlock = TextBlock | ImageBlock;

/**
 * Build the structured content for an SDKUserMessage.
 *
 * If the message contains image attachments that can be base64-encoded,
 * returns an array of content blocks (text + images). Otherwise returns
 * the original string unchanged.
 *
 * @param messageText - The full user message text (may contain attachment block)
 * @param cwd - Working directory for resolving relative file paths
 * @param onMissing - Issue #1442: invoked (fire-and-forget) with the list of
 *   footer paths that claimed to exist but failed to stat()/read at parse time
 *   (silently-dropped attachments). Used to surface a warning toast to the
 *   sender. Side-channel only — never affects the returned content blocks.
 */
export async function buildImageContent(
  messageText: string,
  cwd: string,
  onMissing?: (missingPaths: string[]) => void
): Promise<string | ContentBlock[]> {
  const match = messageText.match(ATTACHED_FILES_PATTERN);
  if (!match) {
    return messageText;
  }

  const textBefore = messageText.slice(0, match.index!);
  const pathsBlock = match[1];

  const filePaths = pathsBlock
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0);

  if (filePaths.length === 0) {
    return messageText;
  }

  const imageBlocks: ImageBlock[] = [];
  const nonImagePaths: string[] = [];
  // Issue #1442: footer paths that exist in the message but fail to stat()/read
  // — i.e. uploads the server confirmed yet whose bytes never reached disk.
  const missingPaths: string[] = [];

  for (const relativePath of filePaths) {
    const ext = getExtension(relativePath);
    const mediaType = MEDIA_TYPE_MAP[ext];

    if (!mediaType) {
      // Non-image or unsupported format (HEIC, HEIF, PDF, etc.)
      nonImagePaths.push(relativePath);
      continue;
    }

    const absolutePath = join(cwd, relativePath);

    try {
      const fileStat = await stat(absolutePath);

      // Base64 encoding inflates size by ~33%, check raw file size
      const estimatedBase64Size = Math.ceil(fileStat.size * 1.37);
      if (estimatedBase64Size > MAX_BASE64_BYTES) {
        logger.warn(
          `[parseImageAttachments] Image too large for base64 (${fileStat.size} bytes, ` +
            `~${estimatedBase64Size} base64): ${relativePath} — falling back to text reference`
        );
        nonImagePaths.push(relativePath);
        continue;
      }

      const buffer = await readFile(absolutePath);
      const base64 = buffer.toString("base64");

      imageBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: base64,
        },
      });

      logger.debug(
        `[parseImageAttachments] Encoded image: ${relativePath} ` +
          `(${fileStat.size} bytes, ${mediaType})`
      );
    } catch (err) {
      // Issue #1442: a stat()/readFile() failure on a footer path is anomalous
      // — the footer only ever lists server-confirmed uploads, so an absent or
      // unreadable file here is silent data loss. Track it in missingPaths (to
      // surface a warning toast to the sender) AND keep pushing to nonImagePaths
      // so the receiving Claude still sees the path reference (no footer
      // regression — R3). Only this catch (absent/unreadable) is treated as
      // "missing"; the !mediaType and oversized-image branches above are NOT.
      logger.warn(
        `[parseImageAttachments] Failed to read image: ${relativePath} — ${err}`
      );
      missingPaths.push(relativePath);
      nonImagePaths.push(relativePath);
    }
  }

  // Issue #1442: signal any footer paths that claimed to exist but were absent
  // at parse time. Fire BEFORE the early-return below so the "all attachments
  // missing" case (zero image blocks) still surfaces the divergence to the
  // sender. Fire-and-forget; does not block or alter content assembly.
  if (missingPaths.length > 0 && onMissing) {
    onMissing(missingPaths);
  }

  // If no images were successfully encoded, return original string
  if (imageBlocks.length === 0) {
    return messageText;
  }

  // Build structured content blocks
  const blocks: ContentBlock[] = [];

  // Add the user's text (without the attachment block)
  const userText = textBefore.trim();
  if (userText) {
    blocks.push({ type: "text", text: userText });
  }

  // Add image content blocks
  blocks.push(...imageBlocks);

  // If there are non-image files, append a text reference for them
  // so Claude can still use the Read tool
  if (nonImagePaths.length > 0) {
    const fileRefsBlock = nonImagePaths.map(p => `  ${p}`).join("\n");
    blocks.push({
      type: "text",
      text:
        `\n\n---\n📎 **Attached files** (read from filesystem):\n\`\`\`\n` +
        `${fileRefsBlock}\n\`\`\``,
    });
  }

  logger.debug(
    `[parseImageAttachments] Built ${blocks.length} content blocks ` +
      `(${imageBlocks.length} images, ${nonImagePaths.length} text refs)`
  );

  return blocks;
}

/** Extract lowercase file extension including the dot */
function getExtension(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const lastDot = filename.lastIndexOf(".");
  return lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : "";
}
