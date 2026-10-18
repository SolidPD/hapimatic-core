// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { join } from "node:path";
import { mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import type { SyncEngine } from "../../sync/syncEngine";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { ErrorLogger } from "../../logging/errorLogger";
import type { WebAppEnv } from "../middleware/auth";
import { defineCapability } from "@hapi/protocol";
import { requireSessionFromParam, requireSyncEngine } from "./guards";
import { cataloged } from "../../capabilities/cataloged";

// Maximum file size: 200MB (raised from 25MB for video uploads — issue #2030).
// The transport-layer body limit is 220MB (socket/server.ts maxHttpBufferSize)
// and MUST stay strictly greater than this value, so the friendly application
// 400 ("Maximum size is 200MB") fires before the bare transport 413.
// Exported so the federation upload route shares one source of truth (no drift).
export const MAX_FILE_SIZE = 200 * 1024 * 1024;

// Allowed MIME types for upload
export const ALLOWED_MIME_TYPES = new Set([
  // Images
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  // Documents
  "application/pdf",
  "text/plain",
  "text/markdown",
  // Code files
  "text/javascript",
  "text/typescript",
  "application/json",
  "text/html",
  "text/css",
  "text/xml",
  "application/xml",
  // Common code MIME types that browsers might send
  "application/javascript",
  "application/typescript",
  "application/x-javascript",
  // Data formats
  "text/csv",
  // Video (issue #2030). iOS Safari sends video/quicktime for .mov and
  // video/mp4 for .mp4; keep in sync with the client allowlist.
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v",
  // application/octet-stream is deliberately NOT listed: it is the generic label for
  // "unknown type", so listing it accepted ANY file (e.g. a .exe) regardless of
  // extension. Unlabeled uploads are decided by ALLOWED_EXTENSIONS below.
]);

// File extensions that are always allowed (even if MIME is octet-stream)
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
  // Video (issue #2030) — matches the octet-stream extension-fallback path;
  // keep in sync with the client allowed-file-types.ts.
  ".mov",
  ".mp4",
  ".m4v",
  ".webm",
]);

/**
 * Sanitize filename to be safe for filesystem
 */
export function sanitizeFilename(filename: string): string {
  // Remove path separators and null bytes
  const base = filename.replace(/[/\\:\x00]/g, "_");
  // Replace spaces and special chars with underscores
  const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  // Collapse multiple underscores
  return sanitized.replace(/_+/g, "_");
}

/**
 * Get file extension from filename
 */
export function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot === -1) return "";
  return filename.slice(lastDot).toLowerCase();
}

/**
 * Generate a unique filename with date prefix and hash suffix
 */
export function generateStoredFilename(
  originalName: string,
  buffer: Buffer
): string {
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const ext = getExtension(originalName);
  const baseName = originalName.slice(0, originalName.length - ext.length);
  const sanitizedBase = sanitizeFilename(baseName);

  // Generate 6-char hash from file content
  const hash = createHash("md5").update(buffer).digest("hex").slice(0, 6);

  return `${date}_${sanitizedBase}_${hash}${ext}`;
}

/**
 * Check if file type is allowed based on MIME type and extension
 */
export function isFileTypeAllowed(mimeType: string, filename: string): boolean {
  // A specific, allowlisted MIME type is accepted as-is.
  if (ALLOWED_MIME_TYPES.has(mimeType)) {
    return true;
  }

  // Anything else — including the generic application/octet-stream label and an
  // empty MIME, which browsers send for types they don't recognise (.conf, .env…) —
  // is decided by the file extension alone.
  return ALLOWED_EXTENSIONS.has(getExtension(filename));
}

export type UploadedFile = {
  name: string;
  storedName: string;
  path: string;
  size: number;
  type: string;
};

export type UploadResponse = {
  success: boolean;
  file?: UploadedFile;
  error?: string;
};

/**
 * Map file extension to MIME type for serving uploaded files.
 */
const EXTENSION_TO_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".html": "text/html",
  ".css": "text/css",
  ".xml": "text/xml",
  ".csv": "text/csv",
  ".log": "text/plain",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".go": "text/x-go",
  ".rs": "text/x-rustsrc",
  ".java": "text/x-java",
  ".c": "text/x-csrc",
  ".cpp": "text/x-c++src",
  ".sql": "text/x-sql",
  ".toml": "text/x-toml",
};

/**
 * Verify that a just-written file is durably persisted at the expected size.
 * Issue #1442: post-write verification closes the silent-data-loss gap where
 * `await writeFile()` resolved but the bytes never reached disk. Returns true
 * iff stat() succeeds AND the on-disk size matches `expectedSize`; false on any
 * stat() throw (ENOENT etc.) or size mismatch.
 */
export async function verifyWrittenFile(
  filePath: string,
  expectedSize: number
): Promise<boolean> {
  try {
    const s = await stat(filePath);
    return s.size === expectedSize;
  } catch {
    return false;
  }
}

/** Structured audit record for one upload attempt (issue #1442 R4). */
export type UploadAuditRecord = {
  sessionId: string | null;
  cwd: string;
  originalName: string;
  storedName: string;
  dedupSkip: boolean;
  bytesIn: number;
  postStatOk: boolean;
  site: "local" | "federation";
};

/**
 * Emit a durable structured audit record for one upload attempt.
 * Issue #1442 (R4): the prior `console.log` rotated out of the journal within
 * ~1 hr, which is why the original silent-loss bug could not be converged. This
 * writes to the `error_logs` SQLite table (survives rotation) so a future
 * occurrence is diagnosable without a live repro. A failed persist is logged at
 * `error` severity (→ Sentry); a healthy persist at `info`. Routing through
 * ErrorLogger reuses its non-throwing console + SQLite persistence path.
 */
export function logUploadAudit(
  errorLogger: ErrorLogger | null | undefined,
  record: UploadAuditRecord
): void {
  if (!errorLogger) {
    return;
  }
  const summary =
    `${record.originalName} -> ${record.storedName} ` +
    `(${record.bytesIn} bytes, dedupSkip=${record.dedupSkip}, site=${record.site})`;
  const message = record.postStatOk
    ? `[upload-audit] persisted ${summary}`
    : `[upload-audit] VERIFICATION FAILED — bytes not durably persisted: ${summary}`;
  errorLogger.log(record.postStatOk ? "info" : "error", message, {
    // Distinct buckets so a flood of success audits cannot rate-limit out the
    // rare verification-failure record. ErrorLogger rate-limits per category
    // (#1141) at 10/window; a large multi-image send is N sequential uploads in
    // one window, so a failure on the 11th+ upload would otherwise be throttled
    // by the preceding successes — exactly the R4 record we must never drop.
    category: record.postStatOk ? "upload-audit" : "upload-audit-failure",
    source: "server",
    sessionId: record.sessionId,
    context: {
      cwd: record.cwd,
      originalName: record.originalName,
      storedName: record.storedName,
      dedupSkip: record.dedupSkip,
      bytesIn: record.bytesIn,
      postStatOk: record.postStatOk,
      site: record.site,
    },
  });
}

export function createUploadRoutes(
  getSyncEngine: () => SyncEngine | null,
  options?: {
    getNodeRegistry?: () => NodeRegistry | null;
    federationApiToken?: string | null;
    errorLogger?: ErrorLogger | null;
  }
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  /**
   * GET /sessions/:id/upload/:filename
   * Serve an uploaded file from the session's UserFileUploads directory.
   * Auth via ?token= query param (img tags can't set headers).
   */
  app.get(
    "/sessions/:id/upload/:filename",
    cataloged(
      defineCapability({
        id: "files-git.serve-upload",
        domain: "files-git",
        surface: "rest",
        description:
          "Serve an uploaded file from a session's upload directory as a binary response (authenticated via bearer or ?token= query param).",
        whenToUse:
          "When displaying or downloading a file previously uploaded to a session.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/upload/:filename",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    async (c): Promise<Response> => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine);
      if (sessionResult instanceof Response) {
        // Federation fallback: proxy file serving to the remote node
        const registry = options?.getNodeRegistry?.();
        if (registry) {
          const sessionId = c.req.param("id");
          const node = registry.findNodeForSession(sessionId);
          if (node) {
            const filename = c.req.param("filename");
            const headers: Record<string, string> = {};
            if (options?.federationApiToken) {
              headers["Authorization"] = `Bearer ${options.federationApiToken}`;
            }
            // #5375: transport failure → 502, not an onError 500.
            let resp: Response;
            try {
              resp = await fetch(
                `${node.url}/api/federation/sessions/${encodeURIComponent(sessionId)}/upload/${encodeURIComponent(filename)}`,
                { method: "GET", headers }
              );
            } catch {
              return c.json({ error: "Remote node unreachable" }, 502);
            }
            if (resp.ok) {
              // Stream the binary response back with the remote's headers
              return new Response(resp.body, {
                headers: {
                  "Content-Type":
                    resp.headers.get("Content-Type") ??
                    "application/octet-stream",
                  ...(resp.headers.get("Content-Length")
                    ? { "Content-Length": resp.headers.get("Content-Length")! }
                    : {}),
                  "Cache-Control":
                    resp.headers.get("Cache-Control") ??
                    "private, max-age=3600, immutable",
                  "X-Content-Type-Options": "nosniff",
                  ...(resp.headers.get("Content-Disposition")
                    ? {
                        "Content-Disposition": resp.headers.get(
                          "Content-Disposition"
                        )!,
                      }
                    : {}),
                },
              });
            }
            const body = await resp.json().catch(() => ({}));
            return c.json(
              body as Record<string, unknown>,
              resp.status as 400 | 404 | 500 | 503
            );
          }
        }
        return sessionResult;
      }

      const { session } = sessionResult;
      const cwd = session.metadata?.path;
      if (!cwd) {
        return c.json({ error: "Session has no working directory" }, 400);
      }

      const filename = c.req.param("filename");

      // Security: reject path traversal and dangerous characters
      if (
        !filename ||
        filename.includes("/") ||
        filename.includes("\\") ||
        filename.includes("..") ||
        filename.includes("\0")
      ) {
        return c.json({ error: "Invalid filename" }, 400);
      }

      const filePath = join(cwd, "UserFileUploads", filename);

      if (!existsSync(filePath)) {
        return c.json({ error: "File not found" }, 404);
      }

      const data = await readFile(filePath);
      const ext = getExtension(filename);

      // Security: only images and PDFs may render inline (needed for
      // thumbnails and the PDF viewer). All other types are forced to
      // download as application/octet-stream to prevent stored XSS via
      // uploaded HTML/JS files.
      const INLINE_SAFE_EXTENSIONS = new Set([
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".webp",
        ".heic",
        ".heif",
        ".pdf",
      ]);
      const isInlineSafe = INLINE_SAFE_EXTENSIONS.has(ext);
      const mimeType = isInlineSafe
        ? (EXTENSION_TO_MIME[ext] ?? "application/octet-stream")
        : "application/octet-stream";

      const headers: Record<string, string> = {
        "Content-Type": mimeType,
        "Content-Length": String(data.length),
        "Cache-Control": "private, max-age=3600, immutable",
        "X-Content-Type-Options": "nosniff",
      };
      if (!isInlineSafe) {
        headers["Content-Disposition"] =
          `attachment; filename="${encodeURIComponent(filename)}"`;
      }

      return new Response(data, { headers });
    }
  );

  /**
   * POST /sessions/:id/upload
   * Upload a file to the session's UserFileUploads directory
   */
  app.post(
    "/sessions/:id/upload",
    cataloged(
      defineCapability({
        id: "files-git.create-upload",
        domain: "files-git",
        surface: "rest",
        description:
          "Upload a file (image, document, code, or video up to 200MB) into a session's upload directory.",
        whenToUse: "When attaching a file to a session.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/upload",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    async (c): Promise<Response> => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine, {
        requireActive: true,
      });
      if (sessionResult instanceof Response) {
        // Federation fallback: proxy file upload to the remote node
        const registry = options?.getNodeRegistry?.();
        if (registry) {
          const sessionId = c.req.param("id");
          const node = registry.findNodeForSession(sessionId);
          if (node) {
            const contentType = c.req.header("content-type");
            const headers: Record<string, string> = {};
            if (contentType) {
              headers["Content-Type"] = contentType;
            }
            if (options?.federationApiToken) {
              headers["Authorization"] = `Bearer ${options.federationApiToken}`;
            }
            // #5375: transport failure → 502, not an onError 500.
            let resp: Response;
            try {
              resp = await fetch(
                `${node.url}/api/federation/sessions/${encodeURIComponent(sessionId)}/upload`,
                {
                  method: "POST",
                  headers,
                  body: c.req.raw.body,
                  duplex: "half",
                }
              );
            } catch {
              return c.json({ error: "Remote node unreachable" }, 502);
            }
            const body = await resp.json().catch(() => ({}));
            return c.json(
              body as Record<string, unknown>,
              resp.status as 200 | 400 | 404 | 409 | 500 | 503
            );
          }
        }
        return sessionResult;
      }

      const { session } = sessionResult;

      // Get session's working directory
      const cwd = session.metadata?.path;
      if (!cwd) {
        return c.json<UploadResponse>(
          {
            success: false,
            error: "Session does not have a working directory",
          },
          400
        );
      }

      // Parse multipart form data
      const body = await c.req.parseBody();
      const file = body["file"];

      if (!file || !(file instanceof File)) {
        return c.json<UploadResponse>(
          {
            success: false,
            error: "No file provided",
          },
          400
        );
      }

      // Validate file size
      if (file.size > MAX_FILE_SIZE) {
        return c.json<UploadResponse>(
          {
            success: false,
            error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`,
          },
          400
        );
      }

      // Validate file type
      if (!isFileTypeAllowed(file.type, file.name)) {
        return c.json<UploadResponse>(
          {
            success: false,
            error: `File type not allowed: ${file.type}`,
          },
          400
        );
      }

      // Read file content
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Generate stored filename
      const storedName = generateStoredFilename(file.name, buffer);

      // Create UserFileUploads directory if needed
      const uploadsDir = join(cwd, "UserFileUploads");
      if (!existsSync(uploadsDir)) {
        await mkdir(uploadsDir, { recursive: true });
      }

      // Write file to disk with post-write verification (issue #1442).
      // The original code wrote unconditionally and returned success with only a
      // rotated console.log — when `await writeFile()` resolved but the bytes
      // never reached disk, the client saw success while the file was absent at
      // parse time (the silent multi-image data-loss bug). We now stat() the
      // persisted file and only return success when its on-disk size matches what
      // we wrote; a divergence returns a per-file 500 so the client marks the
      // attachment failed and excludes it from the message footer.
      const filePath = join(uploadsDir, storedName);
      const fileExists = existsSync(filePath);
      const relativePath = `UserFileUploads/${storedName}`;
      const auditBase = {
        sessionId: session.id,
        cwd,
        originalName: file.name,
        storedName,
        bytesIn: buffer.length,
        site: "local" as const,
      };

      if (!fileExists) {
        await writeFile(filePath, buffer);
        const persisted = await verifyWrittenFile(filePath, buffer.length);
        if (!persisted) {
          // Bytes did not survive the write — clean up the phantom path so a
          // later request doesn't dedup against a zero/partial file.
          await rm(filePath, { force: true }).catch(() => {});
          logUploadAudit(options?.errorLogger, {
            ...auditBase,
            dedupSkip: false,
            postStatOk: false,
          });
          return c.json<UploadResponse>(
            {
              success: false,
              error: "Upload verification failed: persisted size mismatch",
            },
            500
          );
        }
      } else {
        // Dedup branch: a prior upload with the same content-hash exists. Re-verify
        // its size — a stale/partial earlier write (the very failure mode this
        // issue targets) is overwritten and re-verified before we trust it.
        let persisted = await verifyWrittenFile(filePath, buffer.length);
        if (!persisted) {
          await writeFile(filePath, buffer);
          persisted = await verifyWrittenFile(filePath, buffer.length);
          if (!persisted) {
            await rm(filePath, { force: true }).catch(() => {});
            logUploadAudit(options?.errorLogger, {
              ...auditBase,
              dedupSkip: true,
              postStatOk: false,
            });
            return c.json<UploadResponse>(
              {
                success: false,
                error: "Upload verification failed: persisted size mismatch",
              },
              500
            );
          }
        }
      }

      // Verification passed — emit the durable success audit and return success.
      logUploadAudit(options?.errorLogger, {
        ...auditBase,
        dedupSkip: fileExists,
        postStatOk: true,
      });

      return c.json<UploadResponse>({
        success: true,
        file: {
          name: file.name,
          storedName,
          path: relativePath,
          size: file.size,
          type: file.type,
        },
      });
    }
  );

  /**
   * POST /sessions/:id/uploads/delete
   * Delete one or more uploaded files from the session's UserFileUploads
   * directory. Idempotent — an absent file is treated as success. Used by the
   * notes trashcan to remove attachment files when notes are cleared (issue
   * #1075). Body: `{ filenames: string[] }` (server-assigned stored filenames).
   *
   * TODO(#1075 OR5 — reference counting): content-addressed storage means two
   * attachments with identical bytes resolve to the SAME on-disk file. This
   * endpoint deletes unconditionally, so removing one notes attachment can
   * delete a file still referenced by another notes/prompt attachment (in this
   * or another session). Reference counting is deferred to a follow-up issue;
   * acceptable for this personal-instance tool where the blast radius is a
   * re-uploadable local file.
   */
  app.post(
    "/sessions/:id/uploads/delete",
    cataloged(
      defineCapability({
        id: "files-git.delete-uploads",
        domain: "files-git",
        surface: "rest",
        description:
          "Delete one or more previously uploaded files from a session's upload directory (irreversible; the files are re-uploadable).",
        whenToUse: "When removing files attached to a session.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/uploads/delete",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "user" },
      })
    ),
    async (c): Promise<Response> => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine);
      if (sessionResult instanceof Response) {
        // Federation fallback: proxy the delete to the owning remote node.
        const registry = options?.getNodeRegistry?.();
        if (registry) {
          const sessionId = c.req.param("id");
          const node = registry.findNodeForSession(sessionId);
          if (node) {
            const headers: Record<string, string> = {
              "Content-Type": "application/json",
            };
            if (options?.federationApiToken) {
              headers["Authorization"] = `Bearer ${options.federationApiToken}`;
            }
            // #5375: transport failure → 502, not an onError 500. The request
            // body is read before the try so a client-side read error still
            // surfaces as it did before.
            const deleteBody = await c.req.text();
            let resp: Response;
            try {
              resp = await fetch(
                `${node.url}/api/federation/sessions/${encodeURIComponent(sessionId)}/uploads/delete`,
                { method: "POST", headers, body: deleteBody }
              );
            } catch {
              return c.json({ error: "Remote node unreachable" }, 502);
            }
            const body = await resp.json().catch(() => ({}));
            return c.json(
              body as Record<string, unknown>,
              resp.status as 200 | 400 | 404 | 500 | 503
            );
          }
        }
        return sessionResult;
      }

      const { session } = sessionResult;
      const cwd = session.metadata?.path;
      if (!cwd) {
        return c.json({ error: "Session has no working directory" }, 400);
      }

      const parsed = (await c.req.json().catch(() => null)) as {
        filenames?: unknown;
      } | null;
      const filenames = parsed?.filenames;
      if (!Array.isArray(filenames)) {
        return c.json(
          { error: "Invalid body: expected { filenames: string[] }" },
          400
        );
      }

      let deleted = 0;
      for (const filename of filenames) {
        // Reject path traversal / dangerous chars — same checks as the serve route.
        if (
          typeof filename !== "string" ||
          !filename ||
          filename.includes("/") ||
          filename.includes("\\") ||
          filename.includes("..") ||
          filename.includes("\0")
        ) {
          return c.json({ error: "Invalid filename" }, 400);
        }
        const filePath = join(cwd, "UserFileUploads", filename);
        // force:true makes the delete idempotent (ignores ENOENT for an already-
        // absent file), so a double-clear or a stale filename is a no-op success.
        await rm(filePath, { force: true });
        deleted += 1;
      }

      return c.json({ ok: true, deleted });
    }
  );

  return app;
}
