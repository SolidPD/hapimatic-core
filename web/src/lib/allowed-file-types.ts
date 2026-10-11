// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Client-side file type validation.
 *
 * Mirrors the authoritative ALLOWED_EXTENSIONS set from
 * server/src/web/routes/upload.ts — keep in sync when adding new types.
 */

export const ALLOWED_EXTENSIONS = new Set([
  // Images
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
  // Documents
  ".pdf",
  ".txt",
  ".md",
  ".markdown",
  // Code
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  ".html",
  ".css",
  ".xml",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".sh",
  ".bash",
  ".zsh",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  // Plain-text config / secrets files, e.g. a WireGuard .conf or a dotenv .env
  ".conf",
  ".env",
  ".sql",
  ".graphql",
  ".vue",
  ".svelte",
  // Data / logs
  ".csv",
  ".log",
  // Video (issue #2030) — keep in sync with server ALLOWED_EXTENSIONS
  ".mov",
  ".mp4",
  ".m4v",
  ".webm",
]);

/**
 * `accept` value for the attachment file picker, derived from ALLOWED_EXTENSIONS so the
 * picker can never drift from what the upload actually accepts (it had: .toml/.ini/.cfg
 * and others were accepted on upload but not selectable in the picker).
 */
export const ATTACHMENT_PICKER_ACCEPT = [
  "image/*",
  "video/*",
  ...ALLOWED_EXTENSIONS,
].join(",");

/** Check if a file is an allowed type based on its extension. */
export function isFileAllowed(filename: string): boolean {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot < 0) return false;
  const ext = filename.slice(lastDot).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}
