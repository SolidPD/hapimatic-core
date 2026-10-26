// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { resolveLocalNodeIdentity } from "../../config/nodeLabel";
import { z } from "zod";
import { optionalSessionNameSchema } from "@hapi/protocol";
import {
  EffortLevelSchema,
  ModelModeSchema,
  ModelRoutingSchema,
  NativeModelSelectionSchema,
  SessionRoleSchema,
} from "@hapi/protocol/schemas";
import { isModelModeAllowedForFlavor } from "@hapi/protocol/modes";
import { ClaudeRemoteLauncherKindSchema } from "@hapi/protocol/launcherResolver";
import {
  ExistingBranchSchema,
  SourceBranchSchema,
} from "@hapi/protocol/gitBranches";
import type { SyncEngine } from "../../sync/syncEngine";
import type { WebAppEnv } from "../middleware/auth";
import type { ErrorLogger } from "../../logging/errorLogger";
import type { SharedApiKeyService } from "../../services/sharedApiKeyService";
import { requireMachine } from "./guards";
import { refuseAgentEscalation } from "./agentEscalation";
import { logAndJson } from "./routeErrorHelper";
import { cataloged } from "../../capabilities/cataloged";
import { createRateLimiter } from "../middleware/rateLimit";
import type { SSEManager } from "../../sse/sseManager";
import { generateSessionId, defineCapability } from "@hapi/protocol";
import { addPendingSpawn, markSpawnFailed } from "../../sync/pendingSpawns";
import { spawnFailedNotification } from "../../notifications/producerNotifications";

// Issue #1262: `claimPort` defers port allocation from spawn-time to deploy-time.
// Default-false: callers must opt-in to consume a 3010-3019 port slot. This
// prevents config-only worktrees (rp1-home, etc.) and idle sessions from
// hoarding ports they'll never use. See `cli/src/daemon/run.ts` for the gate.
// Exported for unit testing — see `machines.test.ts`. The route handler
// remains the sole producer of `engine.spawnSession({...})` calls in this
// file, but the schema is consumed in tests to verify accept/reject behavior.
export const spawnBodySchema = z.object({
  directory: z.string().min(1),
  agent: z.enum(["claude", "codex", "gemini", "opencode"]).optional(),
  yolo: z.boolean().optional(),
  claimPort: z.boolean().optional(),
  sessionType: z.enum(["simple", "worktree"]).optional(),
  worktreeName: z.string().optional(),
  /** hapimatic-private#4481: open the worktree on this EXISTING branch. */
  existingBranch: ExistingBranchSchema.optional(),
  /** hapimatic-private#4370: cut a new worktree from exactly this branch;
   *  absent → the daemon resolves the repo's target branch. */
  sourceBranch: SourceBranchSchema.optional(),
  name: optionalSessionNameSchema,
  /** Multi-account (#1455): bind the new session to this stored account.
   *  Optional — omitted spawns use the host/node-default credential. */
  accountUuid: z.string().uuid().optional(),
  /** Issue #4568: bill this Claude session to the node-vault Anthropic API key
   *  with this id (`GET /api/api-keys` → `id`) — NEVER the key itself. Mutually
   *  exclusive with `accountUuid`; Claude + the SDK launcher only (ruling
   *  D-4568-2 A) — see {@link validateApiKeySpawn}. Threaded field-by-field
   *  daemon-ward (#1262). */
  apiKeyId: z.string().min(1).max(200).optional(),
  /** Issue #1633: launch the claude child with --safe-mode (CLAUDE.md,
   *  skills, hooks, MCP customizations disabled) — for Fable
   *  content-sensitivity testing. Spawn-only; not live-switchable. */
  safeMode: z.boolean().optional(),
  /** Issue #1660: per-session launcher override (sdk | tmux | pty). Threaded
   *  daemon-ward as a HAPI_CLAUDE_LAUNCHER env injection so the existing
   *  env > settings > default resolver applies it per-session. Omitted by the
   *  web client when the selection equals the resolved global default. */
  launcher: ClaudeRemoteLauncherKindSchema.optional(),
  /** Issue #1733: gateway model id ("provider/model") for an OpenRouter-routed
   *  Codex session. Forwarded daemon-ward as --hapi-model (#1262 enumeration). */
  model: z.string().optional(),
  /** Issue #3349 (ruling D4(a)): native-vs-OpenRouter routing discriminator.
   *  `"native"` → the `model` above is an opencode native `provider/model` whose
   *  key is resolved from the #1955 apiKeys vault; `"openrouter"`/absent → the
   *  OpenRouter gateway path. Forwarded daemon-ward field-by-field (#1262 — an
   *  un-enumerated field silently vanishes; a native opencode spawn would then be
   *  misrouted to OpenRouter). Absent = today's model-presence semantics (R6). */
  modelRouting: ModelRoutingSchema.optional(),
  /** Issue #2434: Claude model-mode pin ("sonnet"|"opus"|"fable"|"default"), so
   *  a session starts on its intended model ATOMICALLY instead of requiring a
   *  post-spawn `POST /sessions/:id/model` correction.
   *
   *  🔴 DISTINCT from `model` above — that is the #1733 OpenRouter GATEWAY axis
   *  (forwarded as --hapi-model); this is the Claude axis (#1633, forwarded as
   *  --hapi-model-mode). Feeding a Claude model id to `model` misroutes the
   *  session. The two fields coexist without interference.
   *
   *  The rest of the chain (rpcGateway → daemon → launcher) already threads
   *  this field for the #1633 model-switch respawn — only this entry point was
   *  missing. Validated against the agent flavor below, mirroring the
   *  post-spawn route's check so the two entry points cannot drift. */
  modelMode: ModelModeSchema.optional(),
  /** Issue #2456: reasoning-effort level for the create page's Effort dropdown.
   *  Threaded daemon-ward as --hapi-effort (#1262). */
  effort: EffortLevelSchema.optional(),
  /** Issue #2456: a specific pinned raw Claude model id ("More models" / full
   *  catalog). Threaded daemon-ward as --hapi-raw-model (#1262). */
  rawModel: z.string().optional(),
  /** Issue #1953 (A6): clone-on-spawn repo ("owner/repo"). Threaded daemon-ward
   *  so the daemon clones it into the working dir before launch (#1262). */
  cloneRepo: z.string().optional(),
  /** Issue #2155: role-scoped `@`-include profile. Threaded daemon-ward as
   *  --hapi-session-role so runClaude scopes the instruction stack (#1262).
   *  `.catch(undefined)` implements R3/V3: an UNRECOGNIZED role coerces to
   *  undefined → no excludes → the FULL stack (a spawn with a garbage role
   *  succeeds and loads everything, never 400s and never starves). An absent
   *  role behaves identically. Only a valid role is ever threaded/stamped. */
  sessionRole: SessionRoleSchema.optional().catch(undefined),
  /** Issue #2626 (D): per-session output style name ("default" | "Explanatory"
   *  | "Learning" or a custom style). Threaded daemon-ward as --hapi-output-style
   *  so runClaude injects it into the generated --settings file (#1262). Plain
   *  `z.string().optional()` — no enum: built-in AND custom style names are both
   *  valid, and an unknown name is silently no-op'd by Claude Code (Task 1 spike,
   *  fail-open); the pre-select never sends "default"/unknown that would 400. */
  outputStyle: z.string().optional(),
  /** Issue #3348: bundled non-claude native model selection (gemini id →
   *  GEMINI_MODEL env; codex id + effort → config.toml bake). Interpreted by
   *  AGENT at the daemon; threaded field-by-field daemon-ward (#1262). */
  nativeModelSelection: NativeModelSelectionSchema.optional(),
  /** Issue #1565: opt-in to the early-return spawn path. When true the route
   *  acks {type:"accepted", sessionId} before the heavy work and surfaces
   *  completion via lifecycleState + the spawn-failed SSE. Omitted/false =
   *  legacy synchronous {success|error} path (R5). */
  earlyReturn: z.boolean().optional(),
  /** Issue #2479: link the spawned session to a parent (a PM-spawned managed
   *  peer, or an explicit `--parent-session-id`). Accepts a session UUID or a
   *  session TAG; the route resolves tag→uuid server-side (grouping matches
   *  parentSessionId against the store uuid — grouping.ts). Plain `.optional()`
   *  — deliberately NOT `.catch(undefined)` like sessionRole: a linkage field
   *  should 400 on a malformed value, not silently null it (expert-review R-4). */
  parentSessionId: z.string().optional(),
  /** Issue #2479: "branch" | "spawn". Defaulted to "spawn" by the route when a
   *  parent is present and this is omitted (a PM-originated managed peer). */
  parentRelationship: z.enum(["branch", "spawn"]).optional(),
});

/** Issue #4568 (R8): the stable 400 codes for an invalid API-key spawn body. */
export type ApiKeySpawnRejectionCode =
  | "api_key_with_account"
  | "api_key_agent_unsupported"
  | "api_key_launcher_unsupported";

/**
 * Issue #4568 (R2/R8): reject an API-key spawn body that cannot bill the key
 * alone. Pure; `null` = valid (or no key in the body — every existing caller is
 * byte-identical). An API-key session carries exactly ONE credential, so it binds
 * no account; it is a Claude Code session; and it runs on the SDK launcher, the
 * only launcher verified and supported for API billing (D-4568-2 A — the PTY/tmux
 * launchers refuse a key session). An absent `launcher` is valid — the daemon
 * forces SDK for a key spawn.
 */
export function validateApiKeySpawn(body: {
  apiKeyId?: string;
  accountUuid?: string;
  agent?: string;
  launcher?: string;
}): { code: ApiKeySpawnRejectionCode; message: string } | null {
  if (!body.apiKeyId) return null;
  if (body.accountUuid) {
    return {
      code: "api_key_with_account",
      message:
        "An API-key session binds no subscription account — send apiKeyId or accountUuid, not both",
    };
  }
  if ((body.agent ?? "claude") !== "claude") {
    return {
      code: "api_key_agent_unsupported",
      message: "API-key billing is available for Claude Code sessions only",
    };
  }
  if (body.launcher !== undefined && body.launcher !== "sdk") {
    return {
      code: "api_key_launcher_unsupported",
      message: `API-key sessions run on the SDK launcher (requested: ${body.launcher})`,
    };
  }
  return null;
}

const pathsExistsSchema = z.object({
  paths: z.array(z.string().min(1)).max(1000),
});

const listDirectorySchema = z.object({
  path: z.string().min(1),
});

// issue #3498: machine-level create-directory. ONE wire shape { path, recursive }
// (the full target path). Segment-level validation is authoritative in the daemon
// guard; this route rejects empty (min(1)) and NUL (below) too.
const createDirectorySchema = z.object({
  path: z.string().min(1),
  recursive: z.boolean(),
});

const addRecentPathSchema = z.object({
  path: z.string().min(1),
});

export function createMachinesRoutes(
  getSyncEngine: () => SyncEngine | null,
  options?: {
    errorLogger?: ErrorLogger | null;
    getSseManager?: () => SSEManager | null;
    // Issue #4461 (R6): THIS node's identity, stamped on an account_unrefreshable
    // create refusal. Absent ⇒ the non-federated identity.
    getLocalNode?: () => { nodeId: string; nodeLabel: string };
    // Issue #5127: resolves an `apiKeyId` homed on another federation node
    // (`<uuid>@<homeNodeId>`) before the spawn is dispatched.
    getSharedApiKeyService?: () => SharedApiKeyService | null;
  }
): Hono<WebAppEnv> {
  const errorLogger = options?.errorLogger ?? null;
  const getLocalNode =
    options?.getLocalNode ?? (() => resolveLocalNodeIdentity(null));
  const getSseManager = options?.getSseManager ?? null;
  const app = new Hono<WebAppEnv>();

  // issue #3498 (#1099 convention): the JWT-facing mutating create-directory route
  // is rate-limited. Instantiated once per mount (fresh bucket map).
  const createDirLimiter = createRateLimiter({
    name: "machines-create-directory",
  });

  app.get(
    "/machines",
    cataloged(
      defineCapability({
        id: "machine-daemon.machines-list",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "List the machines registered with this hub, each with its liveness, capacity, and metadata.",
        whenToUse: "When the user picks a machine to spawn a session on.",
        invocation: { kind: "rest", method: "GET", path: "/api/machines" },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const engine = getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const namespace = c.get("namespace");
      const machines = engine.getOnlineMachinesByNamespace(namespace);
      return c.json({ machines });
    }
  );

  app.post(
    "/machines/:id/spawn",
    cataloged(
      defineCapability({
        id: "machine-daemon.machine-spawn",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Spawn a new agent session on a named machine, optionally in a worktree and bound to a chosen account, model, or launcher.",
        whenToUse: "When starting a session on a specific machine.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/machines/:id/spawn",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example:
          '{"directory":"/home/matt/projects/app","agent":"claude","sessionType":"worktree"}',
      })
    ),
    async c => {
      const engine = getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const machineId = c.req.param("id");
      const machine = requireMachine(c, engine, machineId);
      if (machine instanceof Response) {
        return machine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = spawnBodySchema.safeParse(body);
      if (!parsed.success) {
        const message = parsed.error.issues[0]?.message ?? "Invalid body";
        return c.json({ error: message }, 400);
      }

      // #3842 R8 (ruling NEW-3842-1 = b): a session that is not in a bypass
      // mode cannot start a permission-bypassing peer through this route. Gate on
      // the daemon's OWN predicate: it spawns in YOLO mode unless `yolo` is
      // exactly `false` (`cli/src/daemon/sessionSpawner.ts` `options.yolo !==
      // false`), so an OMITTED `yolo` is a YOLO spawn and must be floored too.
      // A non-bypass caller therefore has to send `yolo: false` explicitly.
      if (parsed.data.yolo !== false) {
        const refusal = refuseAgentEscalation(c, engine);
        if (refusal) return refusal;
      }

      // Issue #2434: reject a model-mode that the requested agent flavor does not
      // support (e.g. `fable` on a Codex spawn) BEFORE any spawn work. Mirrors the
      // post-spawn route's guard (`routes/sessions.ts` POST /sessions/:id/model)
      // verbatim so the two entry points cannot drift.
      //
      // Gated on `!== undefined` so an OMITTED field never 400s — every existing
      // caller (web, scheduler, federation peers) stays byte-identical (R7).
      // Note: `getModelModesForFlavor()` returns [] for codex/gemini/opencode, so
      // EVERY mode — including "default" — is rejected on a non-Claude spawn. That
      // is intentional: the Claude axis is meaningless there, and the web client
      // omits the field entirely for non-Claude agents (formState.effective).
      const spawnFlavor = parsed.data.agent ?? "claude";
      if (
        parsed.data.modelMode !== undefined &&
        !isModelModeAllowedForFlavor(parsed.data.modelMode, spawnFlavor)
      ) {
        return c.json(
          {
            error: `Model mode "${parsed.data.modelMode}" is not supported for a "${spawnFlavor}" session (Claude only)`,
          },
          400
        );
      }

      // Issue #4568 (R8): an API-key body must bill the key alone (no account, a
      // Claude agent, the SDK launcher) — refused BEFORE any spawn work.
      const apiKeyRejection = validateApiKeySpawn(parsed.data);
      if (apiKeyRejection) {
        return c.json(
          { error: apiKeyRejection.message, code: apiKeyRejection.code },
          400
        );
      }
      // Issue #5127: a key homed on another node is confirmed with its home
      // NOW, before dispatch, so an offline or unticked home fails this request
      // (naming the home) instead of a spawn that reports it later. A bare id
      // takes today's path untouched.
      if (parsed.data.apiKeyId?.includes("@")) {
        const shared = options?.getSharedApiKeyService?.();
        if (!shared) {
          return c.json(
            {
              error: "API keys from other nodes are unavailable on this node",
              code: "api_key_shared_unavailable",
            },
            503
          );
        }
        const resolved = await shared.resolve(parsed.data.apiKeyId);
        if (!resolved.ok) {
          return c.json(
            { error: resolved.message, code: resolved.code },
            resolved.httpStatus
          );
        }
      }

      const namespace = c.get("namespace");

      // Issue #2479: resolve the parent id/tag → the store uuid BEFORE persisting.
      // HAPI_SESSION_ID (what the CLI `--parent-session-id` flag and Sub-Issue R's
      // hapi-spawn.sh default to) is the session TAG, but grouping matches
      // parentSessionId against s.id (the uuid) — grouping.ts. Resolve uuid-then-tag
      // (mirrors routes/cli.ts resolveSessionForNamespace) so a tag-valued parent
      // actually groups. Unknown ⇒ persist no link + log (fail-OPEN): a bad parent
      // must NEVER fail the spawn (expert-review 2026-08-02, D1a).
      let resolvedParentSessionId: string | undefined;
      if (parsed.data.parentSessionId) {
        const parent =
          engine.getSessionByNamespace(
            parsed.data.parentSessionId,
            namespace
          ) ??
          engine.getSessionByTagAndNamespace(
            parsed.data.parentSessionId,
            namespace
          );
        if (parent) {
          resolvedParentSessionId = parent.id;
        } else {
          errorLogger?.warn(
            `Spawn: parentSessionId "${parsed.data.parentSessionId}" did not resolve to a session in namespace "${namespace}" — spawning with no parent link`,
            { category: "sync" }
          );
        }
      }

      const spawnOptions = {
        machineId,
        directory: parsed.data.directory,
        agent: parsed.data.agent,
        yolo: parsed.data.yolo,
        claimPort: parsed.data.claimPort,
        sessionType: parsed.data.sessionType,
        worktreeName: parsed.data.worktreeName,
        // hapimatic-private#4481: thread the existing-branch pick (#1262 trap).
        existingBranch: parsed.data.existingBranch,
        // hapimatic-private#4370: explicit worktree base branch (#1262 trap).
        sourceBranch: parsed.data.sourceBranch,
        name: parsed.data.name,
        accountUuid: parsed.data.accountUuid,
        // Issue #4568: thread the API-key binding (#1262 trap — un-enumerated here,
        // the daemon never learns the key id and the session silently runs on the
        // node-default subscription instead).
        apiKeyId: parsed.data.apiKeyId,
        safeMode: parsed.data.safeMode,
        launcher: parsed.data.launcher,
        // Issue #1733: thread the OpenRouter model into the spawn options.
        model: parsed.data.model,
        // Issue #3349 (D4(a)): thread the native-vs-OpenRouter routing
        // discriminator into the spawn options (#1262 trap — un-enumerated here,
        // the daemon never learns a native opencode selection and misroutes it to
        // OpenRouter).
        modelRouting: parsed.data.modelRouting,
        // Issue #2434: thread the Claude model-mode pin into the spawn options
        // (#1262 trap — an un-enumerated field is silently dropped here, so the
        // daemon would never add --hapi-model-mode and the session would spawn
        // unpinned with NO error).
        modelMode: parsed.data.modelMode,
        // Issue #2456: thread the effort + specific raw-model pins into the spawn
        // options (#1262 trap — un-enumerated fields are silently dropped, so the
        // daemon would never add --hapi-effort / --hapi-raw-model).
        effort: parsed.data.effort,
        rawModel: parsed.data.rawModel,
        // Issue #1953 (A6): thread the clone-on-spawn repo into the spawn options.
        cloneRepo: parsed.data.cloneRepo,
        // Issue #2155: thread the role-scoped profile into the spawn options.
        sessionRole: parsed.data.sessionRole,
        // Issue #2626 (D): thread the per-session output style into the spawn
        // options (#1262 trap — an un-enumerated field is silently dropped here,
        // so the daemon would never add --hapi-output-style and the style would
        // never reach the --settings file, failing R1 with NO error).
        outputStyle: parsed.data.outputStyle,
        // Issue #3348: thread the bundled non-claude native model selection into
        // the spawn options (#1262 trap — an un-enumerated field is silently
        // dropped here, so the daemon would never set GEMINI_MODEL / bake the
        // codex config.toml model + effort).
        nativeModelSelection: parsed.data.nativeModelSelection,
        // Issue #2479: parent linkage for a managed peer. parentSessionId is the
        // RESOLVED store uuid (tag→uuid done above). Default the relationship to
        // "spawn" for any parent-linked spawn (the syncEngine.spawnSession choke
        // point persists it); an explicit body value wins. Gate on the RESOLVED id
        // so an unresolved parent stamps no relationship (choke point skips it).
        parentSessionId: resolvedParentSessionId,
        parentRelationship:
          parsed.data.parentRelationship ??
          (resolvedParentSessionId ? "spawn" : undefined),
      };

      // Issue #1565 (Option B): opt-in early-return path. Pre-generate the
      // hapiSessionId server-side and pass it to the daemon (which honors
      // providedHapiSessionId) so the spawning placeholder and the eventual real
      // session share ONE id and reconcile exactly. The synchronous fallback below
      // is byte-unchanged so every legacy caller + the scheduler + the #1698 409
      // are preserved (R5).
      if (parsed.data.earlyReturn === true) {
        const sseManager = getSseManager?.() ?? null;
        const hapiSessionId = generateSessionId();
        // Issue #2270 (F23): a worktree-on-non-git pre-validation here (before the
        // placeholder) is intentionally NOT added. There is no federation-safe
        // git-ness probe (checkPathsExistOnNode can't robustly determine git-ness;
        // resolveRepoIdentityOnNode is forge-origin, not rev-parse), and a
        // server-LOCAL rev-parse would FALSE-REJECT a remote git repo (its path is
        // absent on the server) — a regression against R4, and there is no reliable
        // local-vs-remote machine signal to gate it. Per the directive's explicit
        // clause ("...falling back to the daemon-side early rejection otherwise"),
        // the daemon's F23 early rejection (sessionSpawner.ts) is the backstop: it
        // flows through surfaceFailure() below → markSpawnFailed + the spawn-failed
        // SSE (the #1565 designed failure surfacing — a 30s failed placeholder, NOT
        // an orphan). earlyReturn callers: `hapi api sessions spawn` AND, since
        // issue #3515, the web Create page's LOCAL optimistic spawn.
        addPendingSpawn({
          sessionId: hapiSessionId,
          namespace,
          directory: parsed.data.directory,
          name: parsed.data.name ?? undefined,
          machineId,
        });
        // Issue #1565: nudge event-driven clients (the web) to refetch
        // /api/sessions so the spawning placeholder renders immediately. A spawning
        // placeholder has no other SSE trigger (the CLI polls /api/sessions
        // directly, but the web is event-driven). Broadcast via sseManager directly
        // (NOT the EventPublisher) so this doesn't fan out to notification/other
        // listeners — only the SSE session-list refetch cares. The reconcile→running
        // and failure transitions get their own SSE (daemon session-added /
        // spawn-failed below), so the placeholder is added, updated, and removed
        // from the web list as its lifecycle advances.
        sseManager?.broadcast({
          type: "session-added",
          sessionId: hapiSessionId,
          namespace,
        });
        // Issue #3515: carry the pre-daemon refusal `code` (account_unrefreshable
        // / account_token_expired / at_capacity — the same codes the synchronous
        // path returns as an HTTP 409) through the failure surface so the web
        // create page can show code-specific, actionable copy on the return-to-
        // Create instead of a generic error. The code is optional — a mid-spawn
        // rejection (or the .catch below) carries only a message.
        const surfaceFailure = (message: string, code?: string) => {
          // R2: the local path has no originating hub to notify, so the server
          // emits the spawn-failed SSE itself (analogue of /federation/spawn-status).
          // The placeholder also flips to lifecycleState="failed" — a poll-visible
          // backstop if the SSE is lost.
          markSpawnFailed(hapiSessionId, message, code);
          // TODO(#4912): legacy spawn-failed SSE event, kept for one release so
          // a pre-#4915 web client still reacts. Remove its toast use once Sub C
          // (#4915) has shipped for a release; SpawningSessionView's in-view
          // return-to-Create still reads it (hapi:spawnFailed).
          sseManager?.broadcast({
            type: "spawn-failed",
            sessionId: hapiSessionId,
            directory: parsed.data.directory,
            error: message,
            code,
            namespace,
          });
          // #4914: the inbox row. The placeholder id is not a session (it flips
          // to failed and is purged), so it rides context, not sessionId.
          engine.notifyUser({
            ...spawnFailedNotification({
              placeholderId: hapiSessionId,
              directory: parsed.data.directory,
              error: message,
              code,
            }),
            namespace,
          });
        };
        void engine
          .spawnSession({ ...spawnOptions, hapiSessionId })
          .then(result => {
            if (result.type === "error")
              surfaceFailure(result.message, result.code);
          })
          .catch(err => {
            surfaceFailure(err instanceof Error ? err.message : String(err));
          });
        return c.json({ type: "accepted", sessionId: hapiSessionId });
      }

      const result = await engine.spawnSession(spawnOptions);
      // Issue #1698 (G1 surfacing): a dead-account spawn is rejected pre-daemon
      // with code "account_unrefreshable" → return HTTP 409 so the create page
      // surfaces an actionable "re-login required" state instead of a generic
      // error (this route otherwise always returns 200). A fresh spawn has no
      // sessionId yet, so the HTTP code is the surface — the #1531 SSE toast is
      // session-scoped and only applies to the reconnect/restart paths.
      // Mirrors switchAccountCodeToStatus's mapping (services/sessionService.ts).
      if (
        result.type === "error" &&
        (result.code === "account_unrefreshable" ||
          // Issue #2457: an account bound with an expired token and no refresh path
          // is refused pre-daemon by the syncEngine G1 gate — same 409 surface as
          // account_unrefreshable so the create page shows an actionable re-login
          // instead of a generic error (distinct from a capacity 409).
          result.code === "account_token_expired" ||
          // Issue #1772: an at-capacity spawn rejection maps to HTTP 409 (same
          // precedent), so a client discriminates by `code`, not by string-matching
          // the "Too many concurrent sessions" message.
          result.code === "at_capacity")
      ) {
        // Issue #4461 (R6): name the refusing node and the account — for
        // account_unrefreshable only; the other 409 bodies are unchanged.
        if (result.code === "account_unrefreshable") {
          return c.json(
            {
              error: result.message,
              code: result.code,
              ...getLocalNode(),
              ...(spawnOptions.accountUuid
                ? { accountUuid: spawnOptions.accountUuid }
                : {}),
            },
            409
          );
        }
        return c.json({ error: result.message, code: result.code }, 409);
      }
      return c.json(result);
    }
  );

  app.post(
    "/machines/:id/paths/exists",
    cataloged(
      defineCapability({
        id: "machine-daemon.machine-paths-exists",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Check whether one or more project paths exist on a named machine; a read exposed as POST to carry the path list.",
        whenToUse:
          "When validating that directories exist on a target machine before spawning.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/machines/:id/paths/exists",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example: '{"paths":["/home/matt/projects/app"]}',
      })
    ),
    async c => {
      const engine = getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const machineId = c.req.param("id");
      const machine = requireMachine(c, engine, machineId);
      if (machine instanceof Response) {
        return machine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = pathsExistsSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      const uniquePaths = Array.from(
        new Set(parsed.data.paths.map(path => path.trim()).filter(Boolean))
      );
      if (uniquePaths.length === 0) {
        return c.json({ exists: {} });
      }

      try {
        const exists = await engine.checkPathsExist(machineId, uniquePaths);
        return c.json({ exists });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "machines-check-paths",
          fallbackMessage: "Failed to check paths",
          severity: "warn",
        });
      }
    }
  );

  app.post(
    "/machines/:id/list-directory",
    cataloged(
      defineCapability({
        id: "machine-daemon.machine-list-directory",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Enumerate the entries of a directory on a named machine; a host-filesystem read exposed as POST, never a safe generic read.",
        whenToUse:
          "When browsing a machine's filesystem to choose a project directory.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/machines/:id/list-directory",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example: '{"path":"/home/matt/projects"}',
      })
    ),
    async c => {
      const engine = getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const machineId = c.req.param("id");
      const machine = requireMachine(c, engine, machineId);
      if (machine instanceof Response) {
        return machine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = listDirectorySchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      try {
        const entries = await engine.listDirectory(machineId, parsed.data.path);
        return c.json({ entries });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "machines-list-directory",
          fallbackMessage: "Failed to list directory",
          severity: "warn",
        });
      }
    }
  );

  // issue #3498: create a directory on a machine (New Session form's "New
  // folder"). Mirrors the list-directory route above; the daemon runs the
  // authoritative create-target UNION guard (deny-list + realpath). Rate-limited
  // (#1099) because it is a JWT-facing mutating endpoint.
  app.post(
    "/machines/:id/create-directory",
    cataloged(
      defineCapability({
        id: "machine-daemon.machine-create-directory",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Create a directory on a named machine's filesystem; a host-filesystem write exposed as POST, never a safe generic call.",
        whenToUse:
          "When creating a new folder on a machine from the New Session directory browser.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/machines/:id/create-directory",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example: '{"path":"/home/matt/projects/new-app","recursive":false}',
      })
    ),
    createDirLimiter,
    async c => {
      const engine = getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const machineId = c.req.param("id");
      const machine = requireMachine(c, engine, machineId);
      if (machine instanceof Response) {
        return machine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = createDirectorySchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }
      if (parsed.data.path.includes("\0")) {
        return c.json({ error: "Invalid path" }, 400);
      }

      try {
        const entry = await engine.createDirectory(
          machineId,
          parsed.data.path,
          parsed.data.recursive
        );
        return c.json({ entry });
      } catch (error) {
        // Map daemon errors to client-branchable statuses BEFORE the 500
        // fallback (issue #3498): deny-list → 403, existing folder → 409.
        const message = error instanceof Error ? error.message : "";
        if (message.includes("Access denied")) {
          return c.json({ error: "This location is restricted" }, 403);
        }
        if (message.includes("EEXIST")) {
          return c.json(
            { error: "A folder with that name already exists" },
            409
          );
        }
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "machines-create-directory",
          fallbackMessage: "Failed to create directory",
          severity: "warn",
        });
      }
    }
  );

  app.get(
    "/machines/:id/recent-paths",
    cataloged(
      defineCapability({
        id: "machine-daemon.machine-recent-paths",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "List the recently used project directories cached for a named machine in the caller's namespace.",
        whenToUse:
          "When offering recent directories for a spawn on that machine.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/machines/:id/recent-paths",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const engine = getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const machineId = c.req.param("id");
      const machine = requireMachine(c, engine, machineId);
      if (machine instanceof Response) {
        return machine;
      }

      const namespace = c.get("namespace");
      const paths = engine.getRecentPaths(machineId, namespace);
      return c.json({ paths });
    }
  );

  app.post(
    "/machines/:id/recent-paths",
    cataloged(
      defineCapability({
        id: "machine-daemon.machine-recent-paths-add",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Record a project directory as recently used on a named machine in the caller's namespace.",
        whenToUse: "When a directory opened on a machine should be remembered.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/machines/:id/recent-paths",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example: '{"path":"/home/matt/projects/app"}',
      })
    ),
    async c => {
      const engine = getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const machineId = c.req.param("id");
      const machine = requireMachine(c, engine, machineId);
      if (machine instanceof Response) {
        return machine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = addRecentPathSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      const namespace = c.get("namespace");
      engine.addRecentPath(machineId, namespace, parsed.data.path.trim());
      return c.json({ ok: true });
    }
  );

  app.delete(
    "/machines/:id/recent-paths",
    cataloged(
      defineCapability({
        id: "machine-daemon.machine-recent-paths-remove",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Remove a specific recently-used project directory from a machine's cached list in the caller's namespace.",
        whenToUse:
          "When the user removes a directory from a machine's recent list.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/machines/:id/recent-paths",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "user" },
        example: '{"path":"/home/matt/projects/app"}',
      })
    ),
    async c => {
      const engine = getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const machineId = c.req.param("id");
      const machine = requireMachine(c, engine, machineId);
      if (machine instanceof Response) {
        return machine;
      }

      const body = await c.req.json().catch(() => null);
      const parsed = addRecentPathSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      const namespace = c.get("namespace");
      const removed = engine.removeRecentPath(
        machineId,
        namespace,
        parsed.data.path.trim()
      );
      return c.json({ ok: true, removed });
    }
  );

  return app;
}
