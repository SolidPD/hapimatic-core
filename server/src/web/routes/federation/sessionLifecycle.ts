// SPDX-License-Identifier: AGPL-3.0-only
import { access } from "node:fs/promises";
import { Hono } from "hono";
import { z } from "zod";
import type { WebAppEnv } from "../../middleware/auth";
import type { FederationDeps } from "./shared";
import { checkFederationToken, notifyOriginatingHub } from "./shared";
import { logAndJson } from "../routeErrorHelper";
import { isSafeMachinePath } from "../../../utils/pathSecurity";
import { expandTilde } from "../../../utils/expandTilde";
import {
  defineCapability,
  FederationSpawnBodySchema,
  FederationSpawnStatusSchema,
} from "@hapi/protocol";
import { cataloged } from "../../../capabilities/cataloged";
import {
  isFileTypeAllowed,
  generateStoredFilename,
  getExtension,
  verifyWrittenFile,
  logUploadAudit,
  MAX_FILE_SIZE,
} from "../upload";

export function createSessionLifecycleRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // ─── Schemas for permission federation routes ───
  const federationDecisionSchema = z.enum([
    "approved",
    "approved_for_session",
    "denied",
    "abort",
  ]);

  const federationApproveBodySchema = z.object({
    mode: z.string().optional(),
    allowTools: z.array(z.string()).optional(),
    decision: federationDecisionSchema.optional(),
    answers: z.record(z.string(), z.array(z.string())).optional(),
  });

  const federationDenyBodySchema = z.object({
    decision: federationDecisionSchema.optional(),
  });

  // ─── Node-to-node endpoint: POST /federation/sessions/:id/archive ─
  app.post(
    "/federation/sessions/:id/archive",
    cataloged(
      defineCapability({
        id: "session-lifecycle.federation-archive",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Archive (disconnect) one session on this node, preserving it for later reconnect.",
        whenToUse: "When a user archives a session that lives on this node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/archive",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      // Peer-incoming RPC: bypasses SessionService by design — see server/CLAUDE.md § "SessionService Audience Boundary"
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }
      if (!session.active) {
        return c.json({ error: "Session is inactive" }, 409);
      }

      try {
        // #1603: federation peer-archive is a TERMINAL archive — reap window B.
        // #2245 [2245-4]: ALSO pass preserveForReconnect so window A is tagged
        // `@hapi_archive` (parity with the local archive at sessions.ts:494-496).
        // Without it, a cross-node archive left window A untagged, so the #2245
        // recovery guard could not recognize it and this node's daemon restart
        // would resurrect the archived session.
        await engine.archiveSession(sessionId, {
          reapRemoteWindow: true,
          preserveForReconnect: true,
        });
      } catch (err) {
        // archiveSession may throw if the CLI's killSession RPC handler
        // isn't registered (e.g. test harness or already-exited process).
        // The session is still marked inactive by handleSessionEnd, so
        // we log the error but treat it as a successful archive.
        deps.errorLogger?.warn(
          `[Federation] archiveSession error for ${sessionId}`,
          {
            category: "federation-archive-session",
            stack: err instanceof Error ? err.stack : null,
            context: { sessionId },
          }
        );
      }
      return c.json({ ok: true });
    }
  );

  // ─── Node-to-node endpoint: POST /federation/sessions/:id/abort ─
  app.post(
    "/federation/sessions/:id/abort",
    cataloged(
      defineCapability({
        id: "session-lifecycle.federation-abort",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Abort the running Claude process for one session on this node.",
        whenToUse:
          "When a user stops a running session that lives on this node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/abort",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }
      if (!session.active) {
        return c.json({ error: "Session is inactive" }, 409);
      }

      try {
        // Peer-incoming RPC: bypasses SessionService by design — see server/CLAUDE.md § "SessionService Audience Boundary"
        await engine.abortSession(sessionId);
      } catch (err) {
        return logAndJson(c, err, 500, {
          errorLogger: deps.errorLogger ?? null,
          category: "federation-abort-session",
          fallbackMessage: "Failed to abort session",
          context: { sessionId },
        });
      }
      return c.json({ ok: true });
    }
  );

  // ─── Node-to-node endpoint: POST /federation/sessions/:id/permissions/:requestId/approve ─
  app.post(
    "/federation/sessions/:id/permissions/:requestId/approve",
    cataloged(
      defineCapability({
        id: "model-permission.federation-permission-approve",
        domain: "model-permission",
        surface: "rest",
        description:
          "Approve a pending permission request for one session on this node.",
        whenToUse:
          "When a user approves a remote session's tool-permission or approval prompt.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/permissions/:requestId/approve",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const requestId = c.req.param("requestId");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }
      if (!session.active) {
        return c.json({ error: "Session is inactive" }, 409);
      }

      const json = await c.req.json().catch(() => null);
      const parsed = federationApproveBodySchema.safeParse(json ?? {});
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      const requests = session.agentState?.requests ?? null;
      if (!requests || !requests[requestId]) {
        return c.json({ error: "Request not found" }, 404);
      }

      const mode = parsed.data.mode as
        | "default"
        | "acceptEdits"
        | "bypassPermissions"
        | "plan"
        | undefined;
      const allowTools = parsed.data.allowTools;
      const decision = parsed.data.decision;
      const answers = parsed.data.answers;

      try {
        await engine.approvePermission(
          sessionId,
          requestId,
          mode,
          allowTools,
          decision,
          answers
        );
        return c.json({ ok: true });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger: deps.errorLogger ?? null,
          category: "federation-approve-permission",
          fallbackMessage: "Failed to approve permission",
        });
      }
    }
  );

  // ─── Node-to-node endpoint: POST /federation/sessions/:id/permissions/:requestId/deny ─
  app.post(
    "/federation/sessions/:id/permissions/:requestId/deny",
    cataloged(
      defineCapability({
        id: "model-permission.federation-permission-deny",
        domain: "model-permission",
        surface: "rest",
        description:
          "Deny a pending permission request for one session on this node.",
        whenToUse:
          "When a user denies a remote session's tool-permission prompt.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/permissions/:requestId/deny",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const requestId = c.req.param("requestId");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }
      if (!session.active) {
        return c.json({ error: "Session is inactive" }, 409);
      }

      const requests = session.agentState?.requests ?? null;
      if (!requests || !requests[requestId]) {
        return c.json({ error: "Request not found" }, 404);
      }

      const json = await c.req.json().catch(() => null);
      const parsed = federationDenyBodySchema.safeParse(json ?? {});
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      try {
        await engine.denyPermission(sessionId, requestId, parsed.data.decision);
        return c.json({ ok: true });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger: deps.errorLogger ?? null,
          category: "federation-deny-permission",
          fallbackMessage: "Failed to deny permission",
        });
      }
    }
  );

  // ─── Node-to-node endpoint: POST /federation/sessions/:id/reconnect ─
  // Fire-and-forget: validates the session then kicks off reconnect
  // asynchronously.  The hub's rapidPollUntilActive discovers the real
  // active state; we don't block on the (potentially 30s+) spawn RPC.
  app.post(
    "/federation/sessions/:id/reconnect",
    cataloged(
      defineCapability({
        id: "session-lifecycle.federation-reconnect",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Reconnect (resume) one session on this node; runs asynchronously.",
        whenToUse:
          "When a user reconnects a disconnected session that lives on this node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/reconnect",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }
      if (session.active) {
        return c.json({ error: "Session is already active" }, 400);
      }

      // #1778: PROACTIVE CWD-gone pre-check (mirrors the #1364 archiveSession guard).
      //
      // The respawn below is deliberately fire-and-forget — a healthy --resume can
      // take 30s+ and the hub's rapidPollUntilActive discovers the real active
      // state. But that means a TERMINAL failure (the session's worktree was
      // deleted out from under it) was previously only `console.error`d here while
      // the hub returned {ok:true} → reconnectOnNode reported success → the client
      // spun on a never-arriving "active" state until timeout (the bug this fixes).
      //
      // A missing cwd is cheap to detect (one fs.access) and is terminal — respawn
      // can never succeed. Detect it synchronously and return a real terminal error
      // (502, code "cwd_missing") so reconnectOnNode surfaces it across the
      // federation boundary, achieving parity with the local reconnect path. The
      // fire-and-forget for the HEALTHY respawn case is preserved below (Fallback
      // Preservation Rule — this only short-circuits the already-doomed case).
      const reconnectCwd = session.metadata?.path;
      if (reconnectCwd) {
        try {
          await access(reconnectCwd);
        } catch {
          engine.markSessionOrphaned(sessionId, "cwd-missing");
          return c.json(
            {
              error: `Session working directory no longer exists: ${reconnectCwd}`,
              code: "cwd_missing",
            },
            502
          );
        }
      }

      // Kick off reconnect in the background — don't await.
      void engine.reconnectSession(sessionId).then(result => {
        if (result.type === "error") {
          console.error(
            `[Federation] Background reconnect failed for ${sessionId}: ${result.message}`
          );
        }
      });

      // Return immediately — the session ID stays the same on reconnect.
      return c.json({ ok: true, newSessionId: sessionId });
    }
  );

  // ─── Node-to-node endpoint: POST /federation/sessions/:id/branch ──
  // Creates a new session that forks the conversation history from the parent.
  // Unlike reconnect, this creates a NEW session ID.
  app.post(
    "/federation/sessions/:id/branch",
    cataloged(
      defineCapability({
        id: "session-lifecycle.federation-branch",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Fork one session's conversation history into a new session on this node.",
        whenToUse:
          "When a user branches a remote session to explore an alternative path.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/branch",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      // Parse optional branch label
      let branchLabel: string | undefined;
      try {
        const body = await c.req.json();
        if (body && typeof body.branchLabel === "string") {
          branchLabel = body.branchLabel;
        }
      } catch {
        // Empty body is fine
      }

      // Branch is async and may take a while — await it since the hub
      // needs the new session ID to return to the client.
      const result = await engine.branchSession(sessionId, branchLabel);
      if (result.type === "success") {
        return c.json({ ok: true, newSessionId: result.newSessionId });
      }

      return c.json({ error: result.message }, 500);
    }
  );

  // ─── Node-to-node endpoint: DELETE /federation/sessions/:id ──────
  app.delete(
    "/federation/sessions/:id",
    cataloged(
      defineCapability({
        id: "session-lifecycle.federation-delete-session",
        domain: "session-lifecycle",
        surface: "rest",
        description: "Delete one inactive or orphaned session on this node.",
        whenToUse:
          "When a user deletes a session that lives on this node (it must be archived or inactive first).",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/federation/sessions/:id",
        },
        auth: "federation-token",
        riskTier: "destructive",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }
      // #1443: orphaned sessions (CWD gone) bypass the active-check — federation
      // parity with the hub DELETE route. The peer received this proxied delete
      // for a local session it owns; orphan state is local to its SyncEngine.
      if (session.active && !engine.isSessionOrphaned(sessionId)) {
        return c.json(
          { error: "Cannot delete active session. Archive it first." },
          409
        );
      }

      try {
        // Peer-incoming RPC: bypasses SessionService by design — see server/CLAUDE.md § "SessionService Audience Boundary"
        await engine.deleteSession(sessionId);
        return c.json({ ok: true });
      } catch (err) {
        return logAndJson(c, err, 500, {
          errorLogger: deps.errorLogger ?? null,
          category: "federation-delete-session",
          fallbackMessage: "Failed to delete session",
          context: { sessionId },
        });
      }
    }
  );

  // ─── Node-to-node endpoint: POST /federation/sessions/:id/upload ─
  // Receives proxied file uploads from the hub for sessions on this node.
  app.post(
    "/federation/sessions/:id/upload",
    cataloged(
      defineCapability({
        id: "files-git.federation-upload",
        domain: "files-git",
        surface: "rest",
        description:
          "Receive a proxied file upload into one session's uploads directory on this node.",
        whenToUse:
          "When a user attaches a file to a session that lives on this node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/upload",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }
      if (!session.active) {
        return c.json({ error: "Session is inactive" }, 409);
      }

      const cwd = session.metadata?.path;
      if (!cwd) {
        return c.json(
          { success: false, error: "Session has no working directory" },
          400
        );
      }

      // Parse multipart form data
      const body = await c.req.parseBody();
      const file = body["file"];

      if (!file || !(file instanceof File)) {
        return c.json({ success: false, error: "No file provided" }, 400);
      }

      // Validate file size — shared MAX_FILE_SIZE from upload.ts (issue #2030;
      // single source of truth, no local redefinition to drift).
      if (file.size > MAX_FILE_SIZE) {
        return c.json(
          {
            success: false,
            error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`,
          },
          400
        );
      }

      // Validate file type (same allowlist as main upload route)
      if (!isFileTypeAllowed(file.type, file.name)) {
        return c.json(
          { success: false, error: `File type not allowed: ${file.type}` },
          400
        );
      }

      // Read file content
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Generate stored filename using shared helper
      const storedName = generateStoredFilename(file.name, buffer);

      // Create UserFileUploads directory if needed
      const { join } = await import("node:path");
      const { mkdir, writeFile, rm } = await import("node:fs/promises");
      const { existsSync } = await import("node:fs");
      const uploadsDir = join(cwd, "UserFileUploads");
      if (!existsSync(uploadsDir)) {
        await mkdir(uploadsDir, { recursive: true });
      }

      // Write file to disk with post-write verification (issue #1442).
      // Identical hardening to the primary upload route (see upload.ts). This is
      // the proxied/remote-node write path used by worktree + multi-node sessions
      // — both sites shared the same vulnerable `writeFile -> success` pattern, so
      // both apply verifyWrittenFile + logUploadAudit via the shared helpers.
      const filePath = join(uploadsDir, storedName);
      const fileExists = existsSync(filePath);
      const relativePath = `UserFileUploads/${storedName}`;
      const auditBase = {
        sessionId: session.id,
        cwd,
        originalName: file.name,
        storedName,
        bytesIn: buffer.length,
        site: "federation" as const,
      };

      if (!fileExists) {
        await writeFile(filePath, buffer);
        const persisted = await verifyWrittenFile(filePath, buffer.length);
        if (!persisted) {
          await rm(filePath, { force: true }).catch(() => {});
          logUploadAudit(deps.errorLogger, {
            ...auditBase,
            dedupSkip: false,
            postStatOk: false,
          });
          return c.json(
            {
              success: false,
              error: "Upload verification failed: persisted size mismatch",
            },
            500
          );
        }
      } else {
        let persisted = await verifyWrittenFile(filePath, buffer.length);
        if (!persisted) {
          await writeFile(filePath, buffer);
          persisted = await verifyWrittenFile(filePath, buffer.length);
          if (!persisted) {
            await rm(filePath, { force: true }).catch(() => {});
            logUploadAudit(deps.errorLogger, {
              ...auditBase,
              dedupSkip: true,
              postStatOk: false,
            });
            return c.json(
              {
                success: false,
                error: "Upload verification failed: persisted size mismatch",
              },
              500
            );
          }
        }
      }

      logUploadAudit(deps.errorLogger, {
        ...auditBase,
        dedupSkip: fileExists,
        postStatOk: true,
      });

      return c.json({
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

  // ─── Node-to-node endpoint: GET /federation/sessions/:id/upload/:filename ─
  // Serves uploaded files from a session's UserFileUploads directory.
  app.get(
    "/federation/sessions/:id/upload/:filename",
    cataloged(
      defineCapability({
        id: "files-git.federation-upload-serve",
        domain: "files-git",
        surface: "rest",
        description:
          "Serve a previously uploaded file from one session's uploads directory on this node.",
        whenToUse:
          "When the hub fetches an attachment belonging to a remote session.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/upload/:filename",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const cwd = session.metadata?.path;
      if (!cwd) {
        return c.json({ error: "Session has no working directory" }, 400);
      }

      const filename = c.req.param("filename");
      if (
        !filename ||
        filename.includes("/") ||
        filename.includes("\\") ||
        filename.includes("..") ||
        filename.includes("\0")
      ) {
        return c.json({ error: "Invalid filename" }, 400);
      }

      const { join } = await import("node:path");
      const { readFile } = await import("node:fs/promises");
      const { existsSync } = await import("node:fs");

      const filePath = join(cwd, "UserFileUploads", filename);
      if (!existsSync(filePath)) {
        return c.json({ error: "File not found" }, 404);
      }

      const data = await readFile(filePath);
      const ext = getExtension(filename);

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
      const EXTENSION_TO_MIME: Record<string, string> = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".heic": "image/heic",
        ".heif": "image/heif",
        ".pdf": "application/pdf",
      };

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

  // ─── Node-to-node endpoint: POST /federation/sessions/:id/uploads/delete ─
  // Receives proxied notes-attachment file deletes from the hub for sessions on
  // this node (issue #1075). Idempotent; see the hub route's OR5 ref-counting TODO.
  app.post(
    "/federation/sessions/:id/uploads/delete",
    cataloged(
      defineCapability({
        id: "files-git.federation-uploads-delete",
        domain: "files-git",
        surface: "rest",
        description:
          "Delete uploaded attachment files for one session on this node.",
        whenToUse: "When a user removes attachments from a remote session.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/uploads/delete",
        },
        auth: "federation-token",
        riskTier: "destructive",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

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

      const { join } = await import("node:path");
      const { rm } = await import("node:fs/promises");
      let deleted = 0;
      for (const filename of filenames) {
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
        await rm(join(cwd, "UserFileUploads", filename), { force: true });
        deleted += 1;
      }

      return c.json({ ok: true, deleted });
    }
  );

  // ─── Node-to-node endpoint: POST /federation/sessions/bulk-delete ─
  app.post(
    "/federation/sessions/bulk-delete",
    cataloged(
      defineCapability({
        id: "session-lifecycle.federation-bulk-delete",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Delete multiple inactive sessions on this node in one request.",
        whenToUse: "When a user bulk-deletes sessions that live on this node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/bulk-delete",
        },
        auth: "federation-token",
        riskTier: "destructive",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const body = await c.req.json().catch(() => null);
      const parsed = z
        .object({ ids: z.array(z.string().uuid()).min(1).max(100) })
        .safeParse(body);

      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      // Delete each session individually (no namespace constraint for federation)
      let deleted = 0;
      let skipped = 0;
      for (const id of parsed.data.ids) {
        const session = engine.getSession(id);
        // #1443: orphaned sessions bypass the active-check (bulk federation
        // parity with SessionCache.deleteSessions).
        if (!session || (session.active && !engine.isSessionOrphaned(id))) {
          skipped++;
          continue;
        }
        try {
          await engine.deleteSession(id);
          deleted++;
        } catch {
          skipped++;
        }
      }

      return c.json({ ok: true, deleted, skipped });
    }
  );

  // ─── Node-to-node endpoint: POST /federation/spawn ──────────────
  // Fire-and-forget: validates the request and machine availability, then
  // kicks off the spawn asynchronously.  The hub's polling discovers the
  // new session; we don't block on the (potentially 30s+) daemon RPC.
  app.post(
    "/federation/spawn",
    cataloged(
      defineCapability({
        id: "federation.spawn",
        domain: "federation",
        surface: "rest",
        description:
          "Spawn a new Claude session on this node on behalf of the hub; runs asynchronously.",
        whenToUse:
          "When a user creates a session targeted at this node's machine.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/spawn",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ type: "error", message: "Not connected" }, 503);
      }

      const body = await c.req.json().catch(() => null);
      const parsed = FederationSpawnBodySchema.safeParse(body);
      if (!parsed.success) {
        const message = parsed.error.issues[0]?.message ?? "Invalid body";
        return c.json({ type: "error", message }, 400);
      }

      // Pick the first online machine (nodes typically have one daemon)
      const machines = engine.getOnlineMachines();
      if (machines.length === 0) {
        return c.json(
          { type: "error", message: "No machines available on this node" },
          503
        );
      }

      const machineId = machines[0].id;
      const {
        directory,
        agent,
        yolo,
        claimPort,
        sessionType,
        worktreeName,
        existingBranch,
        name,
        emoji,
        originatingNodeId,
        accountUuid,
        parentSessionId,
        parentRelationship,
        safeMode,
        launcher,
        model,
        modelRouting,
        modelMode,
        effort,
        rawModel,
        cloneRepo,
        sessionRole,
        outputStyle,
        nativeModelSelection,
        spawnCorrelationId,
      } = parsed.data;

      // H-4: validate the directory against the path-security blacklist BEFORE
      // spawning a session in it. Without this, any federation-authorized caller
      // could spawn in /etc, /root/.ssh, /proc/*, etc. Mirrors the check applied
      // in /federation/list-directory and /federation/paths/exists.
      {
        const expanded = expandTilde(directory.trim());
        if (!isSafeMachinePath(expanded)) {
          return c.json(
            {
              type: "error",
              message: "Access denied: directory is not allowed",
            },
            403
          );
        }
      }

      // Read claudePath from this node's own federation config (issue #933).
      // Falls back to auto-detection in the daemon if not configured.
      const claudePath = deps.federationConfig?.claudePath;

      // Kick off spawn in the background — don't await.
      // Note: name is intentionally omitted here and applied post-spawn
      // to avoid a race condition between spawn completion and the next poll cycle.
      //
      // Issue #1262/#1683 (claim-at-deploy): the peer's `claimPort` intent now
      // defaults to `false` when omitted, so a peer-incoming worktree spawn does
      // not consume a 3010-3019 slot until it deploys an instance. Older peers
      // that omit the field therefore no longer claim at spawn (deploys are
      // lockstep via deploy-federation-nodes.sh; a deploy claims anyway). A peer
      // that genuinely wants a spawn-time claim must send `claimPort: true`.
      // [perf] issue #2147 stage (b): remote background-spawn timer — accept →
      // spawnSession resolved (the node's own view of the raw spawn cost).
      // Additive; grep `[perf][spawn]`.
      const perfRemoteSpawnT0 = Date.now();
      void engine
        .spawnSession({
          machineId,
          directory,
          agent,
          yolo,
          claimPort: claimPort ?? false,
          sessionType,
          worktreeName,
          // hapimatic-private#4481: forward the existing-branch pick on the
          // peer-incoming hop (#1262 trap).
          existingBranch,
          originatingNodeId,
          accountUuid,
          // Issue #2822 (epic #2478 D2a): forward the managed-peer attribution on
          // the peer-incoming hop (#1262 trap — un-enumerated here, a cross-node
          // PM spawn comes up unattributed and ungrouped). Passed RAW: the sending
          // hub already resolved the parent to its store uuid (webClient.ts); the
          // parent lives on that hub, so re-resolving against THIS node's store
          // would drop every cross-node link. The syncEngine.spawnSession choke
          // point persists it when parentRelationship === "spawn". Spawn-time
          // options — NOT a post-spawn `.then()` apply like name/emoji.
          parentSessionId,
          parentRelationship,
          safeMode,
          launcher,
          // Issue #1733: forward the OpenRouter model on the peer-incoming hop.
          model,
          // Issue #3349 (D4(a)): forward the native-vs-OpenRouter routing
          // discriminator on the peer-incoming hop (#1262 trap — un-enumerated
          // here, a federated native opencode spawn silently strips the routing
          // and the receiving daemon misroutes it to OpenRouter; this IS the
          // "worst hop" the directive flags).
          modelRouting,
          // Issue #2434: forward the Claude model-mode pin on the peer-incoming
          // hop (#1262 trap — un-enumerated here, a federated spawn silently
          // ignores the peer's pin and starts on the default model).
          modelMode,
          // Issue #2456: forward the reasoning-effort + pinned raw model on the
          // peer-incoming hop (#1262 trap — un-enumerated here, a federated spawn
          // silently drops the peer's effort/model selection).
          effort,
          rawModel,
          // Issue #1953 (A6): forward the clone-on-spawn repo on the peer-incoming hop.
          cloneRepo,
          // Issue #2155: forward the role-scoped profile on the peer-incoming hop.
          sessionRole,
          // Issue #2626 (D): forward the per-session output style on the
          // peer-incoming hop (#1262 trap — un-enumerated here, a federated spawn
          // silently drops the peer's style selection and R1-remote fails).
          outputStyle,
          // Issue #3348: forward the bundled non-claude native model selection on
          // the peer-incoming hop (#1262 trap — un-enumerated here, a federated
          // gemini/codex spawn silently drops the peer's model + effort selection).
          nativeModelSelection,
          claudePath,
        })
        .then(async result => {
          // [perf] issue #2147 stage (b): the node's own raw-spawn duration
          // (accept → daemon RPC resolved), joinable with the hub stamps on dir.
          deps.errorLogger?.info(
            `[perf][spawn] stage=remote-bg-spawn dir=${directory} node=${originatingNodeId ?? ""} result=${result.type} ms=${Date.now() - perfRemoteSpawnT0}`,
            { category: "perf" }
          );
          if (result.type === "error") {
            console.error(
              `[Federation] Background spawn failed: ${result.message}`
            );

            // Notify the originating hub of the failure so it can surface
            // the error to the client immediately (issue #933).
            void notifyOriginatingHub({
              originatingNodeId,
              nodeId: deps.federationConfig?.nodeId ?? "",
              directory,
              spawnCorrelationId,
              success: false,
              error: result.message,
              deps,
            });
            return;
          }

          // Apply optional session identity after successful spawn
          if (name) {
            await engine.renameSession(result.sessionId, name).catch(err => {
              console.warn(
                `[Federation] Failed to rename session ${result.sessionId}:`,
                err
              );
            });
          }
          if (emoji) {
            await engine
              .updateSessionEmoji(result.sessionId, emoji)
              .catch(err => {
                console.warn(
                  `[Federation] Failed to update session emoji ${result.sessionId}:`,
                  err
                );
              });
          }

          // Notify the originating hub of success
          void notifyOriginatingHub({
            originatingNodeId,
            nodeId: deps.federationConfig?.nodeId ?? "",
            directory,
            spawnCorrelationId,
            success: true,
            sessionId: result.sessionId,
            deps,
          });
        });

      // [perf] issue #2147 stage (b): remote accept — the hub's dispatch RTT ends
      // here; the raw spawn runs in the background above. grep `[perf][spawn]`.
      deps.errorLogger?.info(
        `[perf][spawn] stage=remote-accept dir=${directory} node=${originatingNodeId ?? ""}`,
        { category: "perf" }
      );
      // Return immediately — the hub polls for the new session.
      return c.json({ type: "accepted" });
    }
  );

  // ─── Node-to-node endpoint: POST /federation/spawn-status (issue #933) ─
  // Receives spawn result callbacks from remote nodes. On failure, emits
  // an SSE event so the client's pending-spawn stub shows an error
  // immediately instead of waiting for the 120s timeout.
  app.post(
    "/federation/spawn-status",
    cataloged(
      defineCapability({
        id: "federation.spawn-status",
        domain: "federation",
        surface: "rest",
        description:
          "Receive a spawn-result callback from a remote node and surface it to the client.",
        whenToUse:
          "When a peer reports the outcome of a spawn this node requested.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/spawn-status",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const body = await c.req.json().catch(() => null);
      const parsed = FederationSpawnStatusSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      const {
        nodeId,
        directory,
        spawnCorrelationId,
        success,
        sessionId,
        error,
      } = parsed.data;

      if (!success && error) {
        // Emit SSE event to all connected clients so the web UI can
        // call markSpawnFailed() on the matching pending-spawn stub.
        const sseManager = deps.getSseManager();
        if (sseManager) {
          sseManager.broadcast({
            type: "federation-spawn-failed",
            nodeId,
            directory,
            spawnCorrelationId: spawnCorrelationId ?? null,
            error,
          });
        }

        console.warn(
          `[Federation] Spawn failed on node ${nodeId}: ${error} (dir: ${directory})`
        );
      } else if (success && sessionId) {
        // [#2147 Quick Win #1] Act on the SUCCESS callback the remote already
        // sends (notifyOriginatingHub POSTs {success:true, sessionId, ...}). Trigger
        // an immediate targeted poll of the spawning node so the hub discovers the
        // new session ~1 poll-RTT after Claude is alive, instead of waiting up to a
        // full pollIntervalMs periodic poll (measured BEFORE: mean ~3.4s on a 10s
        // interval, up to the interval). Hub-only, zero schema change, zero extra
        // remote load. AUGMENTS (never replaces) the single post-accept pollNode +
        // the periodic loop — Fallback Preservation Rule (saga #293→#370→#494).
        // pollNode then emits the session-added nudge that carries discovery to the
        // browser.
        const registry = deps.getNodeRegistry();
        if (registry?.hasNode(nodeId)) {
          void registry.pollNodeById(nodeId, "spawn-status").catch(err => {
            console.warn(
              `[Federation] spawn-status success poll failed for ${nodeId}:`,
              err
            );
          });
        }
      }

      return c.json({ ok: true });
    }
  );

  return app;
}
