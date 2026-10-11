// SPDX-License-Identifier: AGPL-3.0-only
/**
 * File type detection utilities.
 *
 * Used by attachment thumbnails, file viewers, and message rendering
 * to determine how to display different file types.
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

const PDF_EXTENSIONS = new Set([".pdf"]);

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
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
  ".html",
  ".css",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".sql",
  ".graphql",
  ".vue",
  ".svelte",
  ".csv",
  ".log",
]);

/** Map file extension to Shiki language identifier for syntax highlighting. */
const EXTENSION_TO_LANG: Record<string, string> = {
  ".json": "json",
  ".js": "javascript",
  ".jsx": "jsx",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".cpp": "c",
  ".h": "c",
  ".hpp": "c",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".html": "html",
  ".css": "css",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".ini": "ini",
  ".sql": "sql",
  ".graphql": "graphql",
  ".vue": "html",
  ".svelte": "html",
  ".md": "markdown",
  ".markdown": "markdown",
};

export type FileCategory = "image" | "pdf" | "text" | "unknown";

function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : "";
}

/** Determine the broad category of a file from its name or MIME type. */
export function getFileCategory(
  filename: string,
  mimeType?: string
): FileCategory {
  const ext = getExtension(filename);

  if (IMAGE_EXTENSIONS.has(ext) || mimeType?.startsWith("image/"))
    return "image";
  if (PDF_EXTENSIONS.has(ext) || mimeType === "application/pdf") return "pdf";
  if (TEXT_EXTENSIONS.has(ext) || mimeType?.startsWith("text/")) return "text";

  return "unknown";
}

/** Return the Shiki language for syntax highlighting, or undefined for plain text. */
export function getLanguageForFile(filename: string): string | undefined {
  const ext = getExtension(filename);
  return EXTENSION_TO_LANG[ext];
}

/** Check if a file is an image from its name. */
export function isImageFile(filename: string): boolean {
  return getFileCategory(filename) === "image";
}

/** Check if a file is a PDF from its name. */
export function isPdfFile(filename: string): boolean {
  return getFileCategory(filename) === "pdf";
}

/** Check if a file is a viewable text file from its name. */
export function isTextFile(filename: string): boolean {
  return getFileCategory(filename) === "text";
}
