// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import type { WebAppEnv } from "../../middleware/auth";
import type { FederationDeps } from "./shared";
import { checkFederationToken } from "./shared";
import { defineCapability, toSessionSummary } from "@hapi/protocol";
import { cataloged } from "../../../capabilities/cataloged";
import type { MessageOrigin } from "../../../sync/sentFrom";
import { computeApprovalState } from "../../../services/approvalTokens";
import { loadApprovalHygieneConfig } from "../../../config/approvalHygieneConfig";
import { loadApprovalTokensConfig } from "../../../config/approvalTokensConfig";

export function createSessionDataRoutes(deps: FederationDeps): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // ─── Helper: run an async function and catch errors ───────────
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

  // issue #2518: server-side path containment re-check for the write/directory
  // receivers. The receiver must NOT trust the calling peer — mirror how the
  // read receiver re-guards. The authoritative symlink-hardened check runs
  // CLI-side in validatePath (the file lives on this node's filesystem).
  async function guardContainment(
    sessionPath: string,
    relPath: string
  ): Promise<{ error: string; status: 400 | 403 } | null> {
    const { resolve, sep, isAbsolute } = await import("node:path");
    if (isAbsolute(relPath)) {
      return { error: "Absolute paths not allowed", status: 400 };
    }
    const resolvedCwd = resolve(sessionPath);
    const resolvedPath = resolve(resolvedCwd, relPath);
    if (
      resolvedPath !== resolvedCwd &&
      !resolvedPath.startsWith(resolvedCwd + sep)
    ) {
      return { error: "Path escapes session working directory", status: 403 };
    }
    return null;
  }

  // issue #2715 (sweep finding 2715-1): the mutating receivers must ALSO reject
  // the session-cwd ROOT itself — guardContainment permits target == cwd by
  // design. Pure resolve() string check; the receiver re-guards independently
  // of the calling peer.
  async function rejectWorkingDirRoot(
    sessionPath: string,
    relPath: string
  ): Promise<{ error: string; status: 403 } | null> {
    const { resolve } = await import("node:path");
    if (resolve(sessionPath, relPath) === resolve(sessionPath)) {
      return {
        error: "Cannot target the session working directory root",
        status: 403,
      };
    }
    return null;
  }

  // ─── Node-to-node endpoint: GET /federation/sessions ───────────
  app.get(
    "/federation/sessions",
    cataloged(
      defineCapability({
        id: "session-introspection.federation-list",
        domain: "session-introspection",
        surface: "rest",
        description:
          "List every active session on this federation node, returned as summaries for the hub's federated all-sessions view.",
        whenToUse:
          "When the hub aggregates sessions across the mesh and needs this node's roster.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions",
        },
        auth: "federation-token",
        riskTier: "readonly",
        availability: { scope: "operator" },
        telemetry: "off",
      })
    ),
    c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const config = deps.federationConfig;
      if (!config) {
        return c.json({ error: "Federation not enabled" }, 503);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      // Return all sessions as summaries (no namespace filtering —
      // federation exposes the full node).
      // Include messageCount and childBranchCount so remote session lists
      // display the same indicators as local sessions.
      const allSessions = engine.getSessions();
      const sessions = allSessions.map(s =>
        toSessionSummary(
          s,
          engine.getMessageCountForSession(s.id),
          engine.getChildBranchCountForSession(s.id),
          // #1804 (A2): the owning node resolves its own sessions' workflow badges
          // so they propagate through the existing federation all-sessions poll.
          engine.getSessionWorkflowBadge(s.id)
        )
      );

      return c.json({
        nodeId: config.nodeId,
        nodeLabel: config.nodeLabel,
        sessions,
        fetchedAt: Date.now(),
      });
    }
  );

  // ─── Node-to-node endpoint: GET /federation/sessions/:id (detail) ─
  // Returns the full Session object (including agentState) for a specific
  // session. The hub proxies here when the web client needs permission data
  // for remote sessions (e.g. AskUserQuestion interactive footers).
  app.get(
    "/federation/sessions/:id",
    cataloged(
      defineCapability({
        id: "session-introspection.federation-detail",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Return the full Session object (including agentState) for one session owned by this node.",
        whenToUse:
          "When the hub needs a remote session's live detail, such as permission data for an interactive footer.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id",
        },
        auth: "federation-token",
        riskTier: "readonly",
        availability: { scope: "operator" },
      })
    ),
    c => {
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

      const messageCount = engine.getMessageCountForSession(sessionId);
      return c.json({ session, messageCount });
    }
  );

  // ─── Node-to-node endpoint: GET /federation/sessions/:id/capabilities ─
  // Answers the passthrough from the hub's GET /api/sessions/:id/capabilities
  // (issue #2418) for a session that lives on THIS node. Returns the same
  // {ok,data:{sessionId,capabilities}} envelope the local route returns, so the
  // hub relays the body verbatim. Federation-token-gated only — like the sibling
  // per-session reads above, no X-Hapi-Caller-Namespace check (the hub's GET
  // passthrough does not forward it; namespace ownership is asserted hub-side
  // before proxying to a foreign node).
  app.get(
    "/federation/sessions/:id/capabilities",
    cataloged(
      defineCapability({
        id: "session-introspection.federation-capabilities",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Return the live capability list for one session on this node, relayed verbatim to the hub.",
        whenToUse:
          "When the hub enumerates a remote session's invocable capabilities.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/capabilities",
        },
        auth: "federation-token",
        riskTier: "readonly",
        availability: { scope: "operator" },
      })
    ),
    c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const capabilities = engine.getSessionCapabilities(sessionId);
      if (capabilities === null) {
        // No live /cli socket on the owning node (or unknown session). The hub
        // discards this non-2xx and returns its own envelope 404 (R4).
        return c.json(
          { ok: false, error: "Session not found", code: "session_not_found" },
          404
        );
      }
      return c.json({ ok: true, data: { sessionId, capabilities } });
    }
  );

  // ─── Node-to-node endpoint: GET /federation/sessions/:id/messages ─
  app.get(
    "/federation/sessions/:id/messages",
    cataloged(
      defineCapability({
        id: "messaging.federation-get-messages",
        domain: "messaging",
        surface: "rest",
        description:
          "Return a page of the message history for one session on this node.",
        whenToUse: "When the hub loads the transcript of a remote session.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/messages",
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

      const query = c.req.query();
      const limit = Math.min(
        Math.max(parseInt(query.limit ?? "50") || 50, 1),
        200
      );
      const afterSeq = query.afterSeq ? parseInt(query.afterSeq) : null;
      const beforeSeq = query.beforeSeq ? parseInt(query.beforeSeq) : null;

      if (afterSeq !== null && !isNaN(afterSeq)) {
        const messages = engine.getMessagesAfter(sessionId, {
          afterSeq,
          limit,
        });
        return c.json({ messages });
      }

      return c.json(
        engine.getMessagesPage(sessionId, {
          limit,
          beforeSeq: beforeSeq !== null && !isNaN(beforeSeq) ? beforeSeq : null,
        })
      );
    }
  );

  // ─── Node-to-node endpoint: POST /federation/sessions/:id/messages ─
  app.post(
    "/federation/sessions/:id/messages",
    cataloged(
      defineCapability({
        id: "messaging.federation-send-message",
        domain: "messaging",
        surface: "rest",
        description:
          "Deliver a message to one session on this node on behalf of the originating hub.",
        whenToUse:
          "When a user sends a prompt to a session that lives on this node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/messages",
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

      const body = await c.req.json().catch(() => null);
      if (!body?.text || typeof body.text !== "string") {
        return c.json({ error: "Invalid body" }, 400);
      }

      // #3331 (Task 10): a federated send is classed `federation` on the owning
      // node, preserving the original uid/session id the hub forwarded, so a
      // federated approval mints a grant with a populated approved_by. An older
      // peer that dropped the origin field yields no origin here → the token gate
      // denies with provenance-rejected (never a silent mint with an empty
      // identity).
      const fwd =
        body.origin && typeof body.origin === "object"
          ? body.origin
          : undefined;
      const federationOrigin: MessageOrigin | undefined = fwd
        ? {
            class: "federation",
            uid: typeof fwd.uid === "number" ? fwd.uid : undefined,
            sessionId:
              typeof fwd.sessionId === "string" ? fwd.sessionId : undefined,
          }
        : undefined;

      const result = await engine.sendMessage(sessionId, {
        text: body.text,
        localId: typeof body.localId === "string" ? body.localId : undefined,
        sentFrom: "webapp",
        origin: federationOrigin,
      });
      // #3124: this receiver runs on the OWNING node, so it executes the message-
      // hook stage. Forward a gate denial to the proxying node as {ok:false,
      // denied} (the proxy in routes/messages.ts forwards it to the client).
      if (result.delivered === false) {
        // #3579: the owning node runs the hook stage; the hub forwards this body
        // verbatim, so the resolved outcome + params MUST be built here too (added
        // fields do not pass through unless this site is widened — R-3579-2).
        return c.json({
          ok: false,
          denied: {
            hookId: result.hookId,
            reason: result.reason,
            outcome: result.outcome,
            ...(result.params ? { params: result.params } : {}),
          },
        });
      }
      // #2357: the same additive delivery-signal body as the local POST route,
      // computed from THIS (owning) node's session state. The hub forwards this
      // body verbatim (routes/messages.ts okBody passthrough), so a cross-node
      // send carries the signal only once this receiver is widened. OR-2: all
      // federation nodes must run this before the hub's forwarded body is
      // meaningful.
      return c.json({
        ok: true,
        accepted: true,
        targetThinking: session.thinking,
        expectedInjection: session.thinking ? "next-turn-boundary" : "now",
        queueDepth: engine.listQueuedMessages(sessionId, session.namespace)
          .length,
        message: { id: result.message.id, seq: result.message.seq },
      });
    }
  );

  // ─── Node-to-node endpoint: GET /federation/sessions/:id/approval-state ─
  // #3331 (R8/R10): the approval-state read surface's federation leg. The
  // grant/challenge files live on THIS owning node's host, so the hub proxies
  // the read here and returns the local state.
  app.get(
    "/federation/sessions/:id/approval-state/:challengeId",
    cataloged(
      defineCapability({
        id: "model-permission.federation-approval-state",
        domain: "model-permission",
        surface: "rest",
        description:
          "Return the grant state of a permission challenge for one session on this node.",
        whenToUse:
          "When the hub renders a remote session's pending approval challenge.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/approval-state/:challengeId",
        },
        auth: "federation-token",
        riskTier: "readonly",
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
      const repoPath = session.metadata?.path;
      if (!repoPath) {
        return c.json({ error: "Session has no working path" }, 409);
      }
      const issueNumber = Number(c.req.param("challengeId"));
      if (!Number.isInteger(issueNumber)) {
        return c.json({ error: "Invalid challengeId" }, 400);
      }
      // #3559 R6: the hub forwards `?nonce=` so THIS owning node's ledger read can
      // report `used` for a hub-proxied remote session (the acceptance ledger is
      // per-node — it lives on this host). `globalStateDir` is #3538's injected base.
      const nonce = c.req.query("nonce") || undefined;
      const result = await computeApprovalState(repoPath, issueNumber, {
        hygieneTtlDays: loadApprovalHygieneConfig().hygieneTtlDays,
        globalStateDir: loadApprovalTokensConfig().globalStateDir,
        nonce,
      });
      return c.json(result);
    }
  );

  // ─── Node-to-node endpoint: GET /federation/sessions/:id/slash-commands ─
  app.get(
    "/federation/sessions/:id/slash-commands",
    cataloged(
      defineCapability({
        id: "session-introspection.federation-slash-commands",
        domain: "session-introspection",
        surface: "rest",
        description:
          "List the slash commands available to one session on this node.",
        whenToUse:
          "When the hub populates the slash-command menu for a remote session.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/slash-commands",
        },
        auth: "federation-token",
        riskTier: "readonly",
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

      const agent = session.metadata?.flavor ?? "claude";
      try {
        const result = await engine.listSlashCommands(sessionId, agent);
        return c.json(result);
      } catch (error) {
        return c.json({
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to list slash commands",
        });
      }
    }
  );

  // ─── Node-to-node endpoint: GET /federation/sessions/:id/git-status ─
  app.get(
    "/federation/sessions/:id/git-status",
    cataloged(
      defineCapability({
        id: "files-git.federation-git-status",
        domain: "files-git",
        surface: "rest",
        description:
          "Return the git working-tree status for one session's workspace on this node.",
        whenToUse: "When the hub shows a remote session's uncommitted changes.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/git-status",
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

      const sessionPath = session.metadata?.path;
      if (!sessionPath) {
        return c.json({ success: false, error: "Session path not available" });
      }

      const result = await runRpc(() =>
        engine.getGitStatus(sessionId, sessionPath)
      );
      return c.json(result);
    }
  );

  // ─── Node-to-node endpoint: GET /federation/sessions/:id/git-remote-url ─
  app.get(
    "/federation/sessions/:id/git-remote-url",
    cataloged(
      defineCapability({
        id: "files-git.federation-git-remote-url",
        domain: "files-git",
        surface: "rest",
        description:
          "Return the git remote (origin) URL for one session's repository on this node.",
        whenToUse:
          "When the hub needs a remote session's repository origin URL.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/git-remote-url",
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

      const sessionPath = session.metadata?.path;
      if (!sessionPath) {
        return c.json({ success: false, error: "Session path not available" });
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
  );

  // ─── Node-to-node endpoint: GET /federation/sessions/:id/git-diff-numstat ─
  app.get(
    "/federation/sessions/:id/git-diff-numstat",
    cataloged(
      defineCapability({
        id: "files-git.federation-git-diff-numstat",
        domain: "files-git",
        surface: "rest",
        description:
          "Return per-file changed-line counts for one session's working tree on this node.",
        whenToUse: "When the hub summarizes a remote session's diff size.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/git-diff-numstat",
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

      const sessionPath = session.metadata?.path;
      if (!sessionPath) {
        return c.json({ success: false, error: "Session path not available" });
      }

      const staged =
        c.req.query("staged") === "true"
          ? true
          : c.req.query("staged") === "false"
            ? false
            : undefined;
      const result = await runRpc(() =>
        engine.getGitDiffNumstat(sessionId, { cwd: sessionPath, staged })
      );
      return c.json(result);
    }
  );

  // ─── Node-to-node endpoint: GET /federation/sessions/:id/git-diff-file ─
  app.get(
    "/federation/sessions/:id/git-diff-file",
    cataloged(
      defineCapability({
        id: "files-git.federation-git-diff-file",
        domain: "files-git",
        surface: "rest",
        description:
          "Return the full git diff for one file in a session's working tree on this node.",
        whenToUse: "When the hub displays a remote session's per-file diff.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/git-diff-file",
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

      const sessionPath = session.metadata?.path;
      if (!sessionPath) {
        return c.json({ success: false, error: "Session path not available" });
      }

      const filePath = c.req.query("path");
      if (!filePath) {
        return c.json({ error: "Invalid file path" }, 400);
      }

      const staged =
        c.req.query("staged") === "true"
          ? true
          : c.req.query("staged") === "false"
            ? false
            : undefined;
      const result = await runRpc(() =>
        engine.getGitDiffFile(sessionId, {
          cwd: sessionPath,
          filePath,
          staged,
        })
      );
      return c.json(result);
    }
  );

  // ─── Node-to-node endpoint: GET /federation/sessions/:id/file ─
  app.get(
    "/federation/sessions/:id/file",
    cataloged(
      defineCapability({
        id: "files-git.federation-file-read",
        domain: "files-git",
        surface: "rest",
        description: "Read a file from one session's workspace on this node.",
        whenToUse: "When the hub opens a file belonging to a remote session.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/file",
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

      const filePath = c.req.query("path");
      if (!filePath) {
        return c.json({ error: "Invalid file path" }, 400);
      }

      // H-5: reject absolute paths and enforce containment within the session's
      // working directory. Without this, an attacker (federation-authorized or,
      // if apiToken is null, unauthenticated) could read any file the CLI
      // process can access.
      {
        const { resolve, sep, isAbsolute } = await import("node:path");
        if (isAbsolute(filePath)) {
          return c.json({ error: "Absolute paths not allowed" }, 400);
        }
        const cwd = session.metadata?.path;
        if (!cwd) {
          return c.json({ error: "Session has no working directory" }, 400);
        }
        const resolvedCwd = resolve(cwd);
        const resolvedPath = resolve(resolvedCwd, filePath);
        if (
          resolvedPath !== resolvedCwd &&
          !resolvedPath.startsWith(resolvedCwd + sep)
        ) {
          return c.json(
            { error: "Path escapes session working directory" },
            403
          );
        }
      }

      const result = await runRpc(() =>
        engine.readSessionFile(sessionId, filePath)
      );
      return c.json(result);
    }
  );

  // ─── Node-to-node endpoint: PUT /federation/sessions/:id/file (issue #2518) ─
  app.put(
    "/federation/sessions/:id/file",
    cataloged(
      defineCapability({
        id: "files-git.federation-file-write",
        domain: "files-git",
        surface: "rest",
        description: "Write a file into one session's workspace on this node.",
        whenToUse: "When a user edits a file in a remote session via the hub.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/federation/sessions/:id/file",
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

      const sessionPath = session.metadata?.path;
      if (!sessionPath) {
        return c.json({ success: false, error: "Session path not available" });
      }

      const body = (await c.req.json().catch(() => null)) as {
        path?: unknown;
        content?: unknown;
        expectedHash?: unknown;
      } | null;
      const filePath = body?.path;
      const fileContent = body?.content;
      if (
        typeof filePath !== "string" ||
        filePath.length === 0 ||
        typeof fileContent !== "string"
      ) {
        return c.json({ error: "Invalid request body" }, 400);
      }
      const expectedHash =
        typeof body?.expectedHash === "string" ? body.expectedHash : null;

      const guardError = await guardContainment(sessionPath, filePath);
      if (guardError) {
        return c.json({ error: guardError.error }, guardError.status);
      }

      const result = await runRpc(() =>
        engine.writeSessionFile(sessionId, {
          path: filePath,
          content: fileContent,
          expectedHash,
        })
      );
      if (!result.success && "conflict" in result && result.conflict) {
        return c.json(result, 409);
      }
      return c.json(result);
    }
  );

  // ─── Node-to-node endpoint: GET /federation/sessions/:id/directory (issue #2518) ─
  app.get(
    "/federation/sessions/:id/directory",
    cataloged(
      defineCapability({
        id: "files-git.federation-directory-read",
        domain: "files-git",
        surface: "rest",
        description:
          "List a directory in one session's workspace on this node.",
        whenToUse: "When the hub browses a remote session's file tree.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/directory",
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

      const sessionPath = session.metadata?.path;
      if (!sessionPath) {
        return c.json({ success: false, error: "Session path not available" });
      }

      const rawPath = c.req.query("path") ?? ".";
      const guardError = await guardContainment(sessionPath, rawPath);
      if (guardError) {
        return c.json({ error: guardError.error }, guardError.status);
      }

      const result = await runRpc(() =>
        engine.listSessionDirectory(sessionId, rawPath)
      );
      return c.json(result);
    }
  );

  // ─── Node-to-node endpoint: GET /federation/sessions/:id/files ─
  app.get(
    "/federation/sessions/:id/files",
    cataloged(
      defineCapability({
        id: "files-git.federation-files-search",
        domain: "files-git",
        surface: "rest",
        description:
          "Search files (ripgrep) in one session's workspace on this node.",
        whenToUse: "When the hub runs a file search against a remote session.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/files",
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

      const sessionPath = session.metadata?.path;
      if (!sessionPath) {
        return c.json({ success: false, error: "Session path not available" });
      }

      const query = c.req.query("query")?.trim() ?? "";
      const limit = Math.min(
        Math.max(parseInt(c.req.query("limit") ?? "200") || 200, 1),
        500
      );
      const args = ["--files"];
      if (query) {
        args.push("--iglob", `*${query}*`);
      }

      const result = await runRpc(() =>
        engine.runRipgrep(sessionId, args, sessionPath)
      );
      if (!result.success) {
        return c.json({
          success: false,
          error: result.error ?? "Failed to list files",
        });
      }

      const stdout = result.stdout ?? "";
      const files = stdout
        .split("\n")
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0)
        .slice(0, limit)
        .map((fullPath: string) => {
          const parts = fullPath.split("/");
          const fileName = parts[parts.length - 1] || fullPath;
          const filePath = parts.slice(0, -1).join("/");
          return {
            fileName,
            filePath,
            fullPath,
            fileType: "file" as const,
          };
        });

      return c.json({ success: true, files });
    }
  );

  // ─── Node-to-node endpoint: POST /federation/sessions/:id/directory (issue #2715) ─
  app.post(
    "/federation/sessions/:id/directory",
    cataloged(
      defineCapability({
        id: "files-git.federation-directory-create",
        domain: "files-git",
        surface: "rest",
        description:
          "Create a directory in one session's workspace on this node.",
        whenToUse: "When a user adds a folder to a remote session via the hub.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/directory",
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

      const sessionPath = session.metadata?.path;
      if (!sessionPath) {
        return c.json({ success: false, error: "Session path not available" });
      }

      const body = (await c.req.json().catch(() => null)) as {
        path?: unknown;
      } | null;
      const dirPath = body?.path;
      if (typeof dirPath !== "string" || dirPath.length === 0) {
        return c.json({ error: "Invalid request body" }, 400);
      }

      const guardError = await guardContainment(sessionPath, dirPath);
      if (guardError) {
        return c.json({ error: guardError.error }, guardError.status);
      }
      const rootError = await rejectWorkingDirRoot(sessionPath, dirPath);
      if (rootError) {
        return c.json({ error: rootError.error }, rootError.status);
      }

      const result = await runRpc(() =>
        engine.createSessionDirectory(sessionId, dirPath)
      );
      return c.json(result);
    }
  );

  // ─── Node-to-node endpoint: POST /federation/sessions/:id/rename (issue #2715) ─
  app.post(
    "/federation/sessions/:id/rename",
    cataloged(
      defineCapability({
        id: "files-git.federation-rename",
        domain: "files-git",
        surface: "rest",
        description: "Rename a path in one session's workspace on this node.",
        whenToUse:
          "When a user renames a file or folder in a remote session via the hub.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/rename",
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

      const sessionPath = session.metadata?.path;
      if (!sessionPath) {
        return c.json({ success: false, error: "Session path not available" });
      }

      const body = (await c.req.json().catch(() => null)) as {
        path?: unknown;
        newPath?: unknown;
      } | null;
      const srcPath = body?.path;
      const destPath = body?.newPath;
      if (
        typeof srcPath !== "string" ||
        srcPath.length === 0 ||
        typeof destPath !== "string" ||
        destPath.length === 0
      ) {
        return c.json({ error: "Invalid request body" }, 400);
      }

      for (const p of [srcPath, destPath]) {
        const guardError = await guardContainment(sessionPath, p);
        if (guardError) {
          return c.json({ error: guardError.error }, guardError.status);
        }
        const rootError = await rejectWorkingDirRoot(sessionPath, p);
        if (rootError) {
          return c.json({ error: rootError.error }, rootError.status);
        }
      }

      const result = await runRpc(() =>
        engine.renameSessionPath(sessionId, {
          path: srcPath,
          newPath: destPath,
        })
      );
      return c.json(result);
    }
  );

  // ─── Node-to-node endpoint: POST /federation/sessions/:id/delete (issue #2715) ─
  app.post(
    "/federation/sessions/:id/delete",
    cataloged(
      defineCapability({
        id: "files-git.federation-delete",
        domain: "files-git",
        surface: "rest",
        description:
          "Delete a path (optionally recursive) in one session's workspace on this node.",
        whenToUse:
          "When a user deletes a file or folder in a remote session via the hub.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/delete",
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

      const sessionPath = session.metadata?.path;
      if (!sessionPath) {
        return c.json({ success: false, error: "Session path not available" });
      }

      const body = (await c.req.json().catch(() => null)) as {
        path?: unknown;
        recursive?: unknown;
      } | null;
      const targetPath = body?.path;
      if (typeof targetPath !== "string" || targetPath.length === 0) {
        return c.json({ error: "Invalid request body" }, 400);
      }
      const recursive = body?.recursive === true;

      const guardError = await guardContainment(sessionPath, targetPath);
      if (guardError) {
        return c.json({ error: guardError.error }, guardError.status);
      }
      const rootError = await rejectWorkingDirRoot(sessionPath, targetPath);
      if (rootError) {
        return c.json({ error: rootError.error }, rootError.status);
      }

      const result = await runRpc(() =>
        engine.deleteSessionPath(sessionId, { path: targetPath, recursive })
      );
      return c.json(result);
    }
  );

  return app;
}
