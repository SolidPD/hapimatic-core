// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import type { SyncEngine } from "../../../sync/syncEngine";
import type { NodeRegistry } from "../../../federation/nodeRegistry";
import {
  federationReadSignal,
  readProxyJson,
} from "../../../federation/proxyFetchSignal";
import type { WebAppEnv } from "../../../web/middleware/auth";
import type { ErrorLogger } from "../../../logging/errorLogger";
import { cataloged } from "../../../capabilities/cataloged";
import {
  requireSessionFromParam,
  requireSyncEngine,
} from "../../../web/routes/guards";
import {
  logAndJson,
  proxyTransportFailure,
} from "../../../web/routes/routeErrorHelper";
import {
  checkPathContainment,
  rejectWorkingDirRoot,
} from "../../../web/routes/sessionPathGuards";
import {
  buildFileSearchArgs,
  parseFileSearchOutput,
  parseHiddenParam,
} from "../fileSearchArgs";

const fileSearchSchema = z.object({
  query: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  // #6224: include hidden (non-ignored) files when the Files tab shows them.
  hidden: z
    .string()
    .optional()
    .transform(value => parseHiddenParam(value)),
});

const filePathSchema = z.object({
  path: z.string().min(1),
});

const fileWriteSchema = z.object({
  path: z.string().min(1),
  // base64-encoded file content (matches the CLI writeFile handler)
  content: z.string(),
  expectedHash: z.string().nullable().optional(),
});

// issue #2715: schemas for the V2 mutating file ops (create-folder / rename /
// delete). filePathSchema is reused for create-folder.
const fileRenameSchema = z.object({
  path: z.string().min(1),
  newPath: z.string().min(1),
});

const fileDeleteSchema = z.object({
  path: z.string().min(1),
  recursive: z.boolean().optional(),
});

function parseBooleanParam(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

// #6224: the path pre-filters (checkPathContainment, rejectWorkingDirRoot) live in
// web/routes/sessionPathGuards, shared with the federation receivers. They are
// cheap string checks; the authoritative symlink-hardened guard runs CLI-side in
// validatePath, where the file lives.

async function runRpc<T>(
  fn: () => Promise<T>
): Promise<T | { success: false; error: string }> {
  try {
    return await fn();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Helper: proxy a GET request to a remote node's federation endpoint.
 * Returns the peer's JSON and status. A transport failure is a logged 502
 * (#5410); any other error (an unparseable OK body, a hub bug) is rethrown so
 * app.onError logs it as a 500 (#5404).
 */
async function federationGetProxy(
  c: Context<WebAppEnv>,
  nodeUrl: string,
  path: string,
  federationApiToken: string | null | undefined,
  log: { errorLogger: ErrorLogger | null; nodeId: string },
  queryParams?: Record<string, string | undefined>
): Promise<Response> {
  // #6224 (#1097): the receiver re-asserts the caller's namespace.
  const headers: Record<string, string> = {
    "X-Hapi-Caller-Namespace": c.get("namespace"),
  };
  if (federationApiToken) {
    headers["Authorization"] = `Bearer ${federationApiToken}`;
  }

  const url = new URL(path, nodeUrl);
  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
  }

  try {
    // #5375: bounded read-only proxy fetch (covers every git read route). The
    // body read is bounded too; a cut-off read lands in the catch below.
    const resp = await fetch(url.toString(), {
      headers,
      signal: federationReadSignal(c.req.raw.signal),
    });
    const body = (await readProxyJson(resp)) ?? {};
    return c.json(
      body as Record<string, unknown>,
      resp.status as 200 | 400 | 404 | 409 | 500 | 502 | 503
    );
  } catch (error) {
    return proxyTransportFailure(c, error, {
      errorLogger: log.errorLogger,
      nodeId: log.nodeId,
      // Git web consumers read `success`.
      body: { success: false, error: "Remote node unreachable" },
    });
  }
}

/**
 * Helper: proxy a request with a JSON body (POST/PUT) to a remote node's
 * federation endpoint — the body-carrying sibling of federationGetProxy
 * (issue #2518, for the file-write route). A transport failure, including a
 * body cut off mid-read on any status, is a logged 502 (#5433); any other
 * error (an unparseable OK body, a hub bug) is rethrown so app.onError logs it
 * as a 500 (#5404).
 */
async function federationBodyProxy(
  c: Context<WebAppEnv>,
  nodeUrl: string,
  path: string,
  federationApiToken: string | null | undefined,
  method: "POST" | "PUT",
  body: unknown,
  log: { errorLogger: ErrorLogger | null; nodeId: string }
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // #6224 (#1097): the receiver re-asserts the caller's namespace.
    "X-Hapi-Caller-Namespace": c.get("namespace"),
  };
  if (federationApiToken) {
    headers["Authorization"] = `Bearer ${federationApiToken}`;
  }

  const url = new URL(path, nodeUrl);
  try {
    const resp = await fetch(url.toString(), {
      method,
      headers,
      body: JSON.stringify(body),
    });
    // #5433: this reads every status, so a body cut off mid-read must not
    // relay as 200 {} on a write that may not have landed.
    const respBody = (await readProxyJson(resp)) ?? {};
    return c.json(
      respBody as Record<string, unknown>,
      resp.status as 200 | 400 | 404 | 409 | 500 | 502 | 503
    );
  } catch (error) {
    return proxyTransportFailure(c, error, {
      errorLogger: log.errorLogger,
      nodeId: log.nodeId,
      // Git web consumers read `success`.
      body: { success: false, error: "Remote node unreachable" },
    });
  }
}

export function createGitRoutes(
  getSyncEngine: () => SyncEngine | null,
  options?: {
    getNodeRegistry?: () => NodeRegistry | null;
    federationApiToken?: string | null;
    errorLogger?: ErrorLogger | null;
  }
): Hono<WebAppEnv> {
  const errorLogger = options?.errorLogger ?? null;
  const app = new Hono<WebAppEnv>();

  app.get(
    "/sessions/:id/git-status",
    cataloged(
      defineCapability({
        id: "files-git.session-git-status",
        domain: "files-git",
        surface: "rest",
        description:
          "Return `git status` for a session's worktree (reads the working tree — not safe to hand a generic invoker).",
        whenToUse: "When the UI shows a session's git status.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/git-status",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine);
      if (!(sessionResult instanceof Response)) {
        const sessionPath = sessionResult.session.metadata?.path;
        if (!sessionPath) {
          return c.json({
            success: false,
            error: "Session path not available",
          });
        }

        const result = await runRpc(() =>
          engine.getGitStatus(sessionResult.sessionId, sessionPath)
        );
        return c.json(result);
      }

      // Federation fallback
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          return federationGetProxy(
            c,
            node.url,
            `/api/federation/sessions/${encodeURIComponent(sessionId)}/git-status`,
            options?.federationApiToken,
            { errorLogger, nodeId: node.nodeId }
          );
        }
      }

      return sessionResult;
    }
  );

  app.get(
    "/sessions/:id/git-remote-url",
    cataloged(
      defineCapability({
        id: "files-git.session-git-remote-url",
        domain: "files-git",
        surface: "rest",
        description: "Return a session worktree's git remote URL.",
        whenToUse: "When the UI resolves a session's repo remote.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/git-remote-url",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine);
      if (!(sessionResult instanceof Response)) {
        const sessionPath = sessionResult.session.metadata?.path;
        if (!sessionPath) {
          return c.json({
            success: false,
            error: "Session path not available",
          });
        }

        // Run directly on the filesystem — no CLI process needed.
        // git remote get-url only reads .git/config.
        const proc = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
          cwd: sessionPath,
          stdout: "pipe",
          stderr: "pipe",
        });
        const stdout = proc.stdout.toString().trim();
        if (proc.exitCode === 0 && stdout) {
          return c.json({ success: true, stdout });
        }
        return c.json({
          success: false,
          error: proc.stderr.toString().trim() || "No remote configured",
        });
      }

      // Federation fallback
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          return federationGetProxy(
            c,
            node.url,
            `/api/federation/sessions/${encodeURIComponent(sessionId)}/git-remote-url`,
            options?.federationApiToken,
            { errorLogger, nodeId: node.nodeId }
          );
        }
      }

      return sessionResult;
    }
  );

  app.get(
    "/sessions/:id/git-diff-numstat",
    cataloged(
      defineCapability({
        id: "files-git.session-git-diff-numstat",
        domain: "files-git",
        surface: "rest",
        description:
          "Return the numstat diff summary for a session's worktree.",
        whenToUse: "When the UI shows changed-file counts for a session.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/git-diff-numstat",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine);
      if (!(sessionResult instanceof Response)) {
        const sessionPath = sessionResult.session.metadata?.path;
        if (!sessionPath) {
          return c.json({
            success: false,
            error: "Session path not available",
          });
        }

        const staged = parseBooleanParam(c.req.query("staged"));
        // #4469: the daemon validates `base` and picks the commit to diff
        // against; an empty value is the plain diff.
        const base = c.req.query("base") || undefined;
        const result = await runRpc(() =>
          engine.getGitDiffNumstat(sessionResult.sessionId, {
            cwd: sessionPath,
            staged,
            base,
          })
        );
        return c.json(result);
      }

      // Federation fallback
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          return federationGetProxy(
            c,
            node.url,
            `/api/federation/sessions/${encodeURIComponent(sessionId)}/git-diff-numstat`,
            options?.federationApiToken,
            { errorLogger, nodeId: node.nodeId },
            { staged: c.req.query("staged") }
          );
        }
      }

      return sessionResult;
    }
  );

  app.get(
    "/sessions/:id/git-diff-file",
    cataloged(
      defineCapability({
        id: "files-git.session-git-diff-file",
        domain: "files-git",
        surface: "rest",
        description: "Return the diff for one file in a session's worktree.",
        whenToUse: "When the user views a file's diff in a session.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/git-diff-file",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine);
      if (!(sessionResult instanceof Response)) {
        const sessionPath = sessionResult.session.metadata?.path;
        if (!sessionPath) {
          return c.json({
            success: false,
            error: "Session path not available",
          });
        }

        const parsed = filePathSchema.safeParse(c.req.query());
        if (!parsed.success) {
          return c.json({ error: "Invalid file path" }, 400);
        }

        const guardError = checkPathContainment(sessionPath, parsed.data.path);
        if (guardError) {
          return c.json({ error: guardError.error }, guardError.status);
        }

        const staged = parseBooleanParam(c.req.query("staged"));
        const base = c.req.query("base") || undefined; // #4469
        const result = await runRpc(() =>
          engine.getGitDiffFile(sessionResult.sessionId, {
            cwd: sessionPath,
            filePath: parsed.data.path,
            staged,
            base,
          })
        );
        return c.json(result);
      }

      // Federation fallback
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          return federationGetProxy(
            c,
            node.url,
            `/api/federation/sessions/${encodeURIComponent(sessionId)}/git-diff-file`,
            options?.federationApiToken,
            { errorLogger, nodeId: node.nodeId },
            { path: c.req.query("path"), staged: c.req.query("staged") }
          );
        }
      }

      return sessionResult;
    }
  );

  app.get(
    "/sessions/:id/file",
    cataloged(
      defineCapability({
        id: "files-git.session-read-file",
        domain: "files-git",
        surface: "rest",
        description: "Read one file's contents from a session's worktree.",
        whenToUse: "When the UI opens a file in a session.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/file",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine);
      if (!(sessionResult instanceof Response)) {
        const sessionPath = sessionResult.session.metadata?.path;
        if (!sessionPath) {
          return c.json({
            success: false,
            error: "Session path not available",
          });
        }

        const parsed = filePathSchema.safeParse(c.req.query());
        if (!parsed.success) {
          return c.json({ error: "Invalid file path" }, 400);
        }

        const guardError = checkPathContainment(sessionPath, parsed.data.path);
        if (guardError) {
          return c.json({ error: guardError.error }, guardError.status);
        }

        const result = await runRpc(() =>
          engine.readSessionFile(sessionResult.sessionId, parsed.data.path)
        );
        return c.json(result);
      }

      // Federation fallback
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          return federationGetProxy(
            c,
            node.url,
            `/api/federation/sessions/${encodeURIComponent(sessionId)}/file`,
            options?.federationApiToken,
            { errorLogger, nodeId: node.nodeId },
            { path: c.req.query("path") }
          );
        }
      }

      return sessionResult;
    }
  );

  app.get(
    "/sessions/:id/files",
    cataloged(
      defineCapability({
        id: "files-git.session-search-files",
        domain: "files-git",
        surface: "rest",
        description:
          "Search (ripgrep) files in a session's worktree and return matches.",
        whenToUse: "When the user searches within a session's files.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/files",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine);
      if (!(sessionResult instanceof Response)) {
        const sessionPath = sessionResult.session.metadata?.path;
        if (!sessionPath) {
          return c.json({
            success: false,
            error: "Session path not available",
          });
        }

        const parsed = fileSearchSchema.safeParse(c.req.query());
        if (!parsed.success) {
          return c.json({ error: "Invalid query" }, 400);
        }

        const query = parsed.data.query?.trim() ?? "";
        const limit = parsed.data.limit ?? 200;
        // #6224: glob metacharacters are escaped, and hidden files are added on
        // request (never `.git` or Git-ignored paths).
        const args = buildFileSearchArgs({ query, hidden: parsed.data.hidden });

        const result = await runRpc(() =>
          engine.runRipgrep(sessionResult.sessionId, args, sessionPath)
        );
        if (!result.success) {
          return c.json({
            success: false,
            error: result.error ?? "Failed to list files",
          });
        }

        return c.json(parseFileSearchOutput(result, limit));
      }

      // Federation fallback
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          return federationGetProxy(
            c,
            node.url,
            `/api/federation/sessions/${encodeURIComponent(sessionId)}/files`,
            options?.federationApiToken,
            { errorLogger, nodeId: node.nodeId },
            {
              query: c.req.query("query"),
              limit: c.req.query("limit"),
              hidden: c.req.query("hidden"),
            }
          );
        }
      }

      return sessionResult;
    }
  );

  // issue #2518: write a text file back to the session working directory.
  app.put(
    "/sessions/:id/file",
    cataloged(
      defineCapability({
        id: "files-git.session-write-file",
        domain: "files-git",
        surface: "rest",
        description: "Write contents to one file in a session's worktree.",
        whenToUse: "When the user edits/saves a file in a session.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/sessions/:id/file",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine);
      if (!(sessionResult instanceof Response)) {
        const sessionPath = sessionResult.session.metadata?.path;
        if (!sessionPath) {
          return c.json({
            success: false,
            error: "Session path not available",
          });
        }

        const body = await c.req.json().catch(() => null);
        const parsed = fileWriteSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: "Invalid request body" }, 400);
        }

        const guardError = checkPathContainment(sessionPath, parsed.data.path);
        if (guardError) {
          return c.json({ error: guardError.error }, guardError.status);
        }

        const result = await runRpc(() =>
          engine.writeSessionFile(sessionResult.sessionId, {
            path: parsed.data.path,
            content: parsed.data.content,
            expectedHash: parsed.data.expectedHash ?? null,
          })
        );
        // issue #2518: a stale-hash conflict maps to HTTP 409 so the client can
        // offer a reload instead of silently clobbering the newer file.
        if (!result.success && "conflict" in result && result.conflict) {
          return c.json(result, 409);
        }
        return c.json(result);
      }

      // Federation fallback
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          const body = await c.req.json().catch(() => ({}));
          return federationBodyProxy(
            c,
            node.url,
            `/api/federation/sessions/${encodeURIComponent(sessionId)}/file`,
            options?.federationApiToken,
            "PUT",
            body,
            { errorLogger, nodeId: node.nodeId }
          );
        }
      }

      return sessionResult;
    }
  );

  // issue #2518: session-scoped directory listing (name/type/size/mtime),
  // rooted at the session working directory (defaults to the cwd root).
  app.get(
    "/sessions/:id/directory",
    cataloged(
      defineCapability({
        id: "files-git.session-list-directory",
        domain: "files-git",
        surface: "rest",
        description: "Enumerate a directory in a session's worktree.",
        whenToUse: "When the UI browses a session's file tree.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/directory",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine);
      if (!(sessionResult instanceof Response)) {
        const sessionPath = sessionResult.session.metadata?.path;
        if (!sessionPath) {
          return c.json({
            success: false,
            error: "Session path not available",
          });
        }

        const rawPath = c.req.query("path") ?? ".";
        const guardError = checkPathContainment(sessionPath, rawPath);
        if (guardError) {
          return c.json({ error: guardError.error }, guardError.status);
        }

        const result = await runRpc(() =>
          engine.listSessionDirectory(sessionResult.sessionId, rawPath)
        );
        return c.json(result);
      }

      // Federation fallback
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          return federationGetProxy(
            c,
            node.url,
            `/api/federation/sessions/${encodeURIComponent(sessionId)}/directory`,
            options?.federationApiToken,
            { errorLogger, nodeId: node.nodeId },
            { path: c.req.query("path") }
          );
        }
      }

      return sessionResult;
    }
  );

  // issue #2715: create a folder in the session working directory. GET
  // /directory lists; POST /directory creates. The authoritative realpath guard
  // runs CLI-side; here we run the string-level pre-filter + the R5 root check.
  app.post(
    "/sessions/:id/directory",
    cataloged(
      defineCapability({
        id: "files-git.session-create-directory",
        domain: "files-git",
        surface: "rest",
        description: "Create a directory in a session's worktree.",
        whenToUse: "When the user adds a folder in a session.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/directory",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine);
      if (!(sessionResult instanceof Response)) {
        const sessionPath = sessionResult.session.metadata?.path;
        if (!sessionPath) {
          return c.json({
            success: false,
            error: "Session path not available",
          });
        }

        const body = await c.req.json().catch(() => null);
        const parsed = filePathSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: "Invalid request body" }, 400);
        }

        const guardError = checkPathContainment(sessionPath, parsed.data.path);
        if (guardError) {
          return c.json({ error: guardError.error }, guardError.status);
        }
        const rootError = rejectWorkingDirRoot(sessionPath, parsed.data.path);
        if (rootError) {
          return c.json({ error: rootError.error }, rootError.status);
        }

        const result = await runRpc(() =>
          engine.createSessionDirectory(
            sessionResult.sessionId,
            parsed.data.path
          )
        );
        return c.json(result);
      }

      // Federation fallback
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          const body = await c.req.json().catch(() => ({}));
          return federationBodyProxy(
            c,
            node.url,
            `/api/federation/sessions/${encodeURIComponent(sessionId)}/directory`,
            options?.federationApiToken,
            "POST",
            body,
            { errorLogger, nodeId: node.nodeId }
          );
        }
      }

      return sessionResult;
    }
  );

  // issue #2715: rename a file/folder. Guards BOTH legs (containment + R5) —
  // you cannot rename the cwd root away, nor rename a file onto it, nor move a
  // deny-listed source (the CLI handler enforces the deny-list on both legs).
  app.post(
    "/sessions/:id/rename",
    cataloged(
      defineCapability({
        id: "files-git.session-rename-path",
        domain: "files-git",
        surface: "rest",
        description: "Rename/move a path in a session's worktree.",
        whenToUse: "When the user renames a file or folder in a session.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/rename",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine);
      if (!(sessionResult instanceof Response)) {
        const sessionPath = sessionResult.session.metadata?.path;
        if (!sessionPath) {
          return c.json({
            success: false,
            error: "Session path not available",
          });
        }

        const body = await c.req.json().catch(() => null);
        const parsed = fileRenameSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: "Invalid request body" }, 400);
        }

        for (const p of [parsed.data.path, parsed.data.newPath]) {
          const guardError = checkPathContainment(sessionPath, p);
          if (guardError) {
            return c.json({ error: guardError.error }, guardError.status);
          }
          const rootError = rejectWorkingDirRoot(sessionPath, p);
          if (rootError) {
            return c.json({ error: rootError.error }, rootError.status);
          }
        }

        const result = await runRpc(() =>
          engine.renameSessionPath(sessionResult.sessionId, {
            path: parsed.data.path,
            newPath: parsed.data.newPath,
          })
        );
        return c.json(result);
      }

      // Federation fallback
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          const body = await c.req.json().catch(() => ({}));
          return federationBodyProxy(
            c,
            node.url,
            `/api/federation/sessions/${encodeURIComponent(sessionId)}/rename`,
            options?.federationApiToken,
            "POST",
            body,
            { errorLogger, nodeId: node.nodeId }
          );
        }
      }

      return sessionResult;
    }
  );

  // issue #2715: delete a file/folder. Non-recursive unless the client sets the
  // explicit, separately-confirmed `recursive` flag (sweep finding 2715-5).
  app.post(
    "/sessions/:id/delete",
    cataloged(
      defineCapability({
        id: "files-git.session-delete-path",
        domain: "files-git",
        surface: "rest",
        description: "Delete a path from a session's worktree.",
        whenToUse: "When the user deletes a file or folder in a session.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/delete",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    async c => {
      const engine = requireSyncEngine(c, getSyncEngine);
      if (engine instanceof Response) {
        return engine;
      }

      const sessionResult = requireSessionFromParam(c, engine);
      if (!(sessionResult instanceof Response)) {
        const sessionPath = sessionResult.session.metadata?.path;
        if (!sessionPath) {
          return c.json({
            success: false,
            error: "Session path not available",
          });
        }

        const body = await c.req.json().catch(() => null);
        const parsed = fileDeleteSchema.safeParse(body);
        if (!parsed.success) {
          return c.json({ error: "Invalid request body" }, 400);
        }

        const guardError = checkPathContainment(sessionPath, parsed.data.path);
        if (guardError) {
          return c.json({ error: guardError.error }, guardError.status);
        }
        const rootError = rejectWorkingDirRoot(sessionPath, parsed.data.path);
        if (rootError) {
          return c.json({ error: rootError.error }, rootError.status);
        }

        const result = await runRpc(() =>
          engine.deleteSessionPath(sessionResult.sessionId, {
            path: parsed.data.path,
            recursive: parsed.data.recursive,
          })
        );
        return c.json(result);
      }

      // Federation fallback
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const sessionId = c.req.param("id");
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          const body = await c.req.json().catch(() => ({}));
          return federationBodyProxy(
            c,
            node.url,
            `/api/federation/sessions/${encodeURIComponent(sessionId)}/delete`,
            options?.federationApiToken,
            "POST",
            body,
            { errorLogger, nodeId: node.nodeId }
          );
        }
      }

      return sessionResult;
    }
  );

  return app;
}
