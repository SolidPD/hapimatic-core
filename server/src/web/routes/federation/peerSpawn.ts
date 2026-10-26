// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The peer-incoming spawn receivers' shared body: `POST /federation/spawn` and
 * (issue #5127, D21) `POST /federation/spawn-api-key`, registered in
 * `sessionLifecycle.ts`. One function, so the spawn field list stays single.
 *
 * Fire-and-forget: validates the request and machine availability, then kicks
 * off the spawn asynchronously. The hub's polling discovers the new session; we
 * don't block on the (potentially 30s+) daemon RPC. The api-key mode adds one
 * synchronous step before the accept: the key is confirmed with its home.
 */
import type { Context } from "hono";
import {
  FederationApiKeySpawnBodySchema,
  FederationSpawnBodySchema,
  type FederationApiKeySpawnBody,
} from "@hapi/protocol";
import type { WebAppEnv } from "../../middleware/auth";
import { isSafeMachinePath } from "../../../utils/pathSecurity";
import { expandTilde } from "../../../utils/expandTilde";
import { validateApiKeySpawn } from "../machines";
import type { FederationDeps } from "./shared";
import { checkFederationToken, notifyOriginatingHub } from "./shared";

export async function spawnForPeer(
  c: Context<WebAppEnv>,
  deps: FederationDeps,
  mode: "plain" | "api-key"
): Promise<Response> {
  if (!checkFederationToken(deps, c.req.header("authorization"))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const engine = deps.getSyncEngine();
  if (!engine) {
    return c.json({ type: "error", message: "Not connected" }, 503);
  }

  const body = await c.req.json().catch(() => null);
  // Issue #5127: the api-key path also requires `apiKeyId`, a qualified ref.
  const parsed =
    mode === "api-key"
      ? FederationApiKeySpawnBodySchema.safeParse(body)
      : FederationSpawnBodySchema.safeParse(body);
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
    sourceBranch,
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

  // Issue #5127: a key stored on another node is confirmed with its home
  // BEFORE the spawn is accepted, so a refusal (the home is offline, the key
  // is not shared, …) reaches the hub's caller at once and nothing is spawned.
  // No background report is sent for it: the hub returns this answer.
  let apiKeyId: string | undefined;
  if (mode === "api-key") {
    const ref = (parsed.data as FederationApiKeySpawnBody).apiKeyId;
    const invalid = validateApiKeySpawn({
      apiKeyId: ref,
      accountUuid,
      agent,
      launcher,
    });
    if (invalid) return c.json({ type: "error", ...invalid }, 400);
    const service = deps.getSharedApiKeyService?.();
    if (!service) {
      return c.json(
        {
          type: "error",
          code: "api_key_shared_unavailable",
          message: "This node cannot use API keys stored on other nodes",
        },
        503
      );
    }
    const resolved = await service.resolve(ref, undefined, {
      requireShared: true,
    });
    if (!resolved.ok) {
      return c.json(
        { type: "error", code: resolved.code, message: resolved.message },
        resolved.httpStatus
      );
    }
    // A key whose home is this node comes back as its bare vault id.
    apiKeyId = resolved.canonicalRef;
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
      // hapimatic-private#4370: forward the explicit base branch (#1262 trap).
      sourceBranch,
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
      // Issue #5127: the API-key binding on the peer-incoming hop (#1262 trap —
      // un-enumerated here, the session would bill this node's default).
      ...(apiKeyId !== undefined ? { apiKeyId } : {}),
      claudePath,
    })
    // Issue #2150: a REJECTED spawn takes the same failure branch below (log
    // + hub callback) instead of becoming an unhandled rejection that tells
    // the caller nothing — the local early-return path's `.catch`
    // (routes/machines.ts) is the precedent.
    .catch(
      (err: unknown): { type: "error"; message: string; code?: string } => ({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      })
    )
    .then(async result => {
      // [perf] issue #2147 stage (b): the node's own raw-spawn duration
      // (accept → daemon RPC resolved), joinable with the hub stamps on dir.
      deps.errorLogger?.info(
        `[perf][spawn] stage=remote-bg-spawn dir=${directory} node=${originatingNodeId ?? ""} result=${result.type} ms=${Date.now() - perfRemoteSpawnT0}`,
        { category: "perf" }
      );
      if (result.type === "error") {
        // Issue #2150 (R2): name the correlation id and the refusal code so
        // a rejected federation spawn is findable in this node's journal.
        console.error(
          `[Federation] Background spawn failed (spawnCorrelationId=${spawnCorrelationId ?? "none"}${result.code ? `, code=${result.code}` : ""}): ${result.message}`
        );

        // Notify the originating hub of the failure so it can surface
        // the error to the client immediately (issue #933). Issue #2150:
        // forward the refusal code too (K-4497-1 §3).
        void notifyOriginatingHub({
          originatingNodeId,
          nodeId: deps.federationConfig?.nodeId ?? "",
          directory,
          spawnCorrelationId,
          success: false,
          error: result.message,
          code: result.code,
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
        await engine.updateSessionEmoji(result.sessionId, emoji).catch(err => {
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
