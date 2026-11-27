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
import { isQualifiedApiKeyRef } from "@hapi/protocol/apiKeyRef";
import type { WebAppEnv } from "../../middleware/auth";
import { isSafeMachinePath } from "../../../utils/pathSecurity";
import { expandTilde } from "../../../utils/expandTilde";
import { validateApiKeySpawn } from "../machines";
import { refuseRetiredBillableAnswer } from "../agentEscalation";
import { resolveSpawnMcpSet } from "../../../services/mcpSetResolver";
import {
  checkCarriedCopy,
  checkTrackingStartValues,
  resolveModelFamily,
  TrackingCarriedCopySchema,
  TrackingStartValuesSchema,
  type BillableSwitchStartContext,
  type BillableSwitchStartWire,
  type SpawnWarning,
} from "@hapi/protocol";
import { resolveLocalNodeIdentity } from "../../../config/nodeLabel";
import {
  ACCOUNT_EXHAUSTED_CODE,
  checkAccountHeadroom,
  headroomWarnings,
} from "../../../accounts/accountHeadroom";
import type { FederationDeps } from "./shared";
import { checkFederationToken, notifyOriginatingHub } from "./shared";
import type { TrackingReceiverDeps } from "./billableTrackingReceivers";
import { observedTrackingStart } from "../../../billableSwitch/trackingStart";
import { isManagerStampEnabled } from "../../../configuration";
import { acceptForwardedManagerStamp } from "../../../sync/managerStamp";
import type { ManagerStampWrite } from "../../../store/sessions";

/** Issue #6918 (R7, V15): keep a forwarded pair, or drop it with one warning. */
function acceptForwardedStampOrWarn(
  pair: ManagerStampWrite | undefined,
  parentRelationship: "branch" | "spawn" | undefined,
  parentSessionId: string | undefined
): ManagerStampWrite | undefined {
  if (!pair) return undefined;
  const enabled = isManagerStampEnabled();
  const kept = acceptForwardedManagerStamp({
    enabled,
    parentRelationship,
    parentSessionId,
    pair,
  });
  if (!kept && enabled) {
    console.warn(
      `[manager-stamp] dropped an inconsistent forwarded pair (reason ${pair.reason}); the session stays undecided`
    );
  }
  return kept;
}

/**
 * Issue #6646: the start context a peer receiver passes to its engine. Only the
 * kinds that can cross a hop (`person`, `agent`, `unattended`, and from #6778
 * ruling 11 `schedule`) are kept; any other or unknown kind, and a missing
 * context (an older hub), read as `unattended`. The carried settings are
 * `receivedTracking`'s. The actor, channel and entry node are the forwarding node's
 * claims (one shared mesh token); `fromSessionId` never crosses (the wire
 * schema strips it). The caller's namespace is kept, so a registration from
 * another namespace under the same tag does not consume it.
 */
export function receivedBillableSwitchStart(
  wire: BillableSwitchStartWire | undefined,
  namespace: string | undefined
): BillableSwitchStartContext {
  const kind =
    wire &&
    (wire.kind === "person" ||
      wire.kind === "agent" ||
      wire.kind === "schedule" ||
      wire.kind === "unattended")
      ? wire.kind
      : "unattended";
  return {
    kind,
    ...(kind === "person" && wire?.choice ? { choice: wire.choice } : {}),
    ...(wire?.actor ? { actor: wire.actor } : {}),
    ...(wire?.entryNodeId ? { entryNodeId: wire.entryNodeId } : {}),
    ...(wire?.via ? { via: wire.via } : {}),
    ...(namespace ? { namespace } : {}),
  };
}

/** What a peer keeps of a carried start, or why it refuses it (400). */
export type ReceivedTracking =
  | Pick<
      BillableSwitchStartContext,
      "tracking" | "inheritedFrom" | "inheritedCopy"
    >
  | { refused: { code: string; message: string; field?: string } };

/**
 * Issue #6778 (4.2 row 8; ruling 11; Task 15): the carried settings a peer
 * keeps, re-checked here, before the background spawn, never in the start hook,
 * where a failure would be a silent lost start (reviewer 2, question H). A
 * person's or a schedule's `tracking` is parsed strictly and checked with R5's
 * structural rules, which the carried category and default make checkable
 * without a lookup; an agent's claimed parent keeps its carried copy, checked
 * the same way. A malformed or refused value answers 400 with a code, never
 * dropped. A category the owner retired after the entry node validated it is
 * still accepted: the entry node's lookup decided.
 */
export function receivedTracking(
  wire: BillableSwitchStartWire | undefined,
  kind: BillableSwitchStartContext["kind"]
): ReceivedTracking {
  const refused = (field?: string, reason?: string): ReceivedTracking => ({
    refused: {
      code: field ? "invalid_field" : "invalid_tracking",
      message: field
        ? `The carried tracking settings were refused: ${field} (${reason}).`
        : "The carried tracking settings are not in a form this node reads.",
      ...(field ? { field } : {}),
    },
  });
  // #6778 FND-2: a carried value is never dropped in silence. Tracking beside a
  // kind that cannot carry it, and a copy beside one or without a usable claimed
  // parent (the wire's `inheritedFrom` is `.catch(undefined)`), are refused.
  const carriesTracking = wire?.tracking !== undefined;
  if (carriesTracking && kind !== "person" && kind !== "schedule") {
    return refused();
  }
  if (
    wire?.inheritedCopy !== undefined &&
    (kind !== "agent" || !wire.inheritedFrom)
  ) {
    return refused();
  }
  if ((kind === "person" || kind === "schedule") && carriesTracking) {
    const parsed = TrackingStartValuesSchema.safeParse(wire.tracking);
    if (!parsed.success) return refused();
    const bad = checkTrackingStartValues(parsed.data);
    if (bad) return refused(bad.field, bad.reason);
    return { tracking: parsed.data };
  }
  if (kind === "agent" && wire?.inheritedFrom) {
    if (wire.inheritedCopy === undefined) {
      return { inheritedFrom: wire.inheritedFrom };
    }
    const parsed = TrackingCarriedCopySchema.safeParse(wire.inheritedCopy);
    if (!parsed.success) return refused();
    const bad = checkCarriedCopy(parsed.data);
    if (bad) return refused(bad.field, bad.reason);
    return { inheritedFrom: wire.inheritedFrom, inheritedCopy: parsed.data };
  }
  return {};
}

/** The accept's warning when this node's gate is not `on`: nothing carried was applied (4.2 row 8). */
export const TRACKING_NOT_APPLIED: SpawnWarning = {
  code: "tracking_not_applied",
  message:
    "Billable sessions are not on for this node, so the session started untracked: its tracking settings were not applied.",
};

export async function spawnForPeer(
  c: Context<WebAppEnv>,
  deps: FederationDeps & TrackingReceiverDeps,
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

  // #6778 (4.2 rows 8 and 9): the carried settings, re-checked before the
  // spawn. Applied only while this node's gate is `on`; otherwise the spawn is
  // accepted untracked and the accept says so. A start that carries settings
  // takes a machine of the caller's namespace, so its queued start can be
  // consumed; with none online there, 409 namespace_mismatch before the accept.
  const callerNamespace = c.req.header("x-hapi-caller-namespace") ?? undefined;
  const wireStart = parsed.data.billableSwitchStart;
  const kept = receivedTracking(
    wireStart,
    receivedBillableSwitchStart(wireStart, callerNamespace).kind
  );
  if ("refused" in kept) {
    return c.json({ type: "error", ...kept.refused }, 400);
  }
  const carried =
    kept.tracking !== undefined || kept.inheritedCopy !== undefined;
  const carriedApplies =
    carried && (engine.getBillableSwitchMode?.() ?? "off") === "on";

  // Pick the first online machine (nodes typically have one daemon); a start
  // that carries settings, one of the caller's namespace.
  const machines =
    carriedApplies && callerNamespace
      ? engine.getOnlineMachinesByNamespace(callerNamespace)
      : engine.getOnlineMachines();
  if (machines.length === 0 && carriedApplies && callerNamespace) {
    return c.json(
      {
        type: "error",
        message:
          "No machine of the caller's namespace is online on this node, so a session with tracking settings cannot start here.",
        code: "namespace_mismatch",
      },
      409
    );
  }
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
    permissionMode,
    claimPort,
    sessionType,
    worktreeName,
    existingBranch,
    sourceBranch,
    name,
    emoji,
    originatingNodeId,
    accountUuid,
    forceAccount,
    parentSessionId,
    parentRelationship,
    managerStamp: forwardedManagerStampRaw,
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
    mcpSet: requestedMcpSet,
    spawnCorrelationId,
    billableSwitchStart: wireBillableSwitchStart,
  } = parsed.data;

  // Issue #6646: only the kinds that can cross a hop (person, agent, unattended,
  // and from #6778 schedule); any other or unknown kind reads as `unattended`,
  // and a missing context (an older hub) too. The actor, the channel and the
  // entry node are taken as claimed by the federation-token caller;
  // `fromSessionId` is never accepted.
  const billableSwitchStart: BillableSwitchStartContext = {
    ...receivedBillableSwitchStart(wireBillableSwitchStart, callerNamespace),
    ...(carriedApplies ? kept : {}),
  };
  // #6778 PR-A (R12; review C9): a person's retired billable answer, which an
  // older hub can still send, is refused with 400 billable_choice_retired in
  // every gate state, never dropped (it would start the session non-billable
  // with a 200). The hub passes the coded refusal on to the person
  // (webClient.ts). The check reads only the kind and the choice.
  const billableRefusal = refuseRetiredBillableAnswer(c, {
    kind: billableSwitchStart.kind === "person" ? "person" : "unattended",
    choice: billableSwitchStart.choice,
  });
  if (billableRefusal) {
    return billableRefusal;
  }

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
  let apiKeyPlacedBy: string | undefined;
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
    // Issue #5819: another node is placing this session here on one of THIS
    // node's keys. Record that with the binding, so every later relaunch
    // re-checks the key is still shared. The marker is set for every bare
    // canonical ref and never depends on a peer-supplied field: the federation
    // token is shared by every peer and `originatingNodeId` is optional, so it
    // only names the placer for display. A key homed on a third node needs no
    // marker, because its home re-checks sharing on every call.
    if (!isQualifiedApiKeyRef(apiKeyId)) {
      apiKeyPlacedBy = originatingNodeId || "peer";
    }
  }

  // Issue #6171: THIS node owns the project and its MCP config, so it resolves
  // the set (or the project's default) and refuses a project-disabled pick
  // BEFORE the accept, so the refusal reaches the hub's caller at once.
  const mcpResolution = resolveSpawnMcpSet({
    requested: requestedMcpSet,
    directory,
    flavor: agent ?? "claude",
    safeMode: safeMode === true,
    cloneRepo,
    catalog: deps.getMcpCatalog?.() ?? null,
  });
  if (!mcpResolution.ok) {
    return c.json(
      {
        type: "error",
        code: mcpResolution.code,
        message: mcpResolution.message,
        ...(mcpResolution.servers ? { servers: mcpResolution.servers } : {}),
      },
      mcpResolution.status
    );
  }

  // Issue #5879 (three-point spawn checklist, point 2): THIS node holds the
  // account and its usage, so it decides — synchronously, BEFORE the accept, so
  // a refusal reaches the hub's caller at once and nothing is spawned (the same
  // shape as the #5127 key check above; no background report is sent for it).
  // The read is deadline-bounded (2.5 s), well under the hub's 10 s timeout.
  const spawnWarnings: SpawnWarning[] = [...mcpResolution.warnings];
  if (carried && !carriedApplies) spawnWarnings.push(TRACKING_NOT_APPLIED);
  let pinnedAccount:
    | {
        accountUuid: string;
        email: string | null;
        source: "requested" | "forced";
      }
    | undefined;
  const flavor = agent ?? "claude";
  if (
    accountUuid &&
    apiKeyId === undefined &&
    (flavor === "claude" || flavor === "opencode")
  ) {
    const verdict = await checkAccountHeadroom(
      {
        usageService: deps.getUsageService?.() ?? null,
        accountService: deps.getAccountService(),
        nodeIdentity: resolveLocalNodeIdentity(deps.federationConfig),
        errorLogger: deps.errorLogger ?? null,
      },
      {
        accountUuid,
        modelFamily: resolveModelFamily(rawModel ?? modelMode),
        forceAccount: forceAccount === true,
      }
    );
    if (verdict.kind === "exhausted" && !verdict.forced) {
      return c.json(
        {
          type: "error",
          code: ACCOUNT_EXHAUSTED_CODE,
          message: verdict.message,
          exhaustion: verdict.exhaustion,
        },
        409
      );
    }
    spawnWarnings.push(...headroomWarnings(verdict));
    pinnedAccount = {
      accountUuid,
      email: verdict.email,
      source:
        verdict.kind === "exhausted" && verdict.forced ? "forced" : "requested",
    };
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
      billableSwitchStart,
      yolo,
      // Issue #6218: forward the starting permission mode on the peer-incoming
      // hop (#1262 trap). With `yolo` also omitted, this node's own default
      // spawn permission mode preference applies at `spawnSession`.
      permissionMode,
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
      // Issue #6918 (R7): the sending node's pair, kept only when consistent
      // and with this node's own switch on; never derived here (the parent
      // is not local).
      forwardedManagerStamp: acceptForwardedStampOrWarn(
        forwardedManagerStampRaw,
        parentRelationship,
        parentSessionId
      ),
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
      // Issue #6171: the RESOLVED MCP set on the peer-incoming hop (#1262 trap —
      // un-enumerated here, a federated spawn starts every server).
      mcpSet: mcpResolution.mcpSet,
      // Issue #5127: the API-key binding on the peer-incoming hop (#1262 trap —
      // un-enumerated here, the session would bill this node's default).
      ...(apiKeyId !== undefined ? { apiKeyId } : {}),
      // Issue #5819: the cross-node placement marker (#1262 trap — un-enumerated
      // here, an unshare would never stop this session's relaunches).
      ...(apiKeyPlacedBy !== undefined ? { apiKeyPlacedBy } : {}),
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

      // Notify the originating hub of success. #6778 PRC-R9: with whether a
      // start that carried settings or a copy was applied, the cause only.
      const trackingStart = !carried
        ? undefined
        : carriedApplies
          ? observedTrackingStart(
              deps.getStore?.() ?? null,
              result.sessionId,
              engine.getSession?.(result.sessionId)?.namespace ??
                callerNamespace
            )
          : ({ applied: false, cause: "gate-off" } as const);
      void notifyOriginatingHub({
        originatingNodeId,
        nodeId: deps.federationConfig?.nodeId ?? "",
        directory,
        spawnCorrelationId,
        success: true,
        sessionId: result.sessionId,
        ...(trackingStart ? { trackingStart } : {}),
        deps,
      });
    });

  // [perf] issue #2147 stage (b): remote accept — the hub's dispatch RTT ends
  // here; the raw spawn runs in the background above. grep `[perf][spawn]`.
  deps.errorLogger?.info(
    `[perf][spawn] stage=remote-accept dir=${directory} node=${originatingNodeId ?? ""}`,
    { category: "perf" }
  );
  // Return immediately — the hub polls for the new session. Issue #5879: the
  // accept carries the headroom warnings and the pinned account, when any.
  return c.json({
    type: "accepted",
    ...(spawnWarnings.length > 0 ? { warnings: spawnWarnings } : {}),
    ...(pinnedAccount ? { account: pinnedAccount } : {}),
  });
}
