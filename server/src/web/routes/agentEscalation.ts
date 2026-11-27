// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Agent-escalation floors for the routes the capability channel promotes
 * (issue #3842, R6 + R8 — TRUST-CRITICAL, expert-review gated).
 *
 * #3842 promotes eight routes in `PROMOTED_ENTRY_IDS` (spawn, the two schedule
 * writes, the two permission responses, send-message, list-messages and
 * archive), so every agent can reach them through raw `hapi_call`,
 * not only through the typed tools. The checks therefore live HERE, in the
 * routes, so neither a typed tool nor raw `hapi_call` can step around them (both
 * go through the wrapper, which always stamps the header below).
 *
 * Every floor keys on `X-Hapi-Session-Id`, the caller's own session id. The
 * injected hapi MCP wrapper stamps it on every `POST /api/capabilities/call` and
 * the invoker copies it onto the dispatched request (Task 2). The `hapi api` CLI
 * stamps its `HAPI_SESSION_ID` tag on `sessions send` and `sessions billable`
 * (#6646), so those verbs run from inside a session meet the send floor below
 * (#5616 D5) and the billable agent rule; its spawn, archive and `call` verbs
 * carry no header. A request without the header (the web UI, the
 * `hapi api` CLI outside a session, a shell or cron caller) keeps today's
 * behaviour: web and CLI mint identical JWTs, so the header is the only
 * discriminator, and an unsandboxed agent holding `CLI_API_TOKEN` can still call
 * a route without it (`hapi api call`, curl, `env -u HAPI_SESSION_ID`; registry
 * §5.3, documented residual).
 *
 * - Self-permission refusal (R6): a session cannot approve or deny its OWN
 *   permission request through this channel.
 * - Caller-mode floor (R8, operator ruling NEW-3842-1 = b, 2026-10-01): a
 *   session whose live permission mode is not a bypass mode cannot change its
 *   node's default spawn permission mode (#6218), create or update a schedule
 *   (scheduled sessions always run in the bypass mode), or answer any session's
 *   permission request. Its spawns meet a RANK floor (#6218, ruling D5-a,
 *   `floorAgentSpawnPosture`): an explicit posture above its own mode's rank is
 *   refused, and an omitted one (the node default — an omitted `yolo` is no
 *   longer YOLO by itself) is clamped down to its rank. A bypass-mode
 *   caller (an orchestrating PM session) is unaffected. Fails closed: a caller
 *   the server cannot resolve, or one with no live mode, is refused.
 * - Send and archive floors (#5616, operator ruling CK1 = option 1 on D1..D10):
 *   the same non-bypass caller cannot message a session that counts as bypass
 *   (its live mode is a bypass mode, or absent, or its flavor has no in-session
 *   modes — gemini and opencode never report one, so the server's `"default"`
 *   would hide a yolo session — or it cannot be found), and can archive only
 *   itself or a session it spawned, through a chain of at most `MAX_SPAWN_HOPS`
 *   `parentRelationship: "spawn"` links. The target is resolved on the
 *   entry hub before the federation split: the local record in the caller's
 *   namespace, else the federation cache, whose copy of a remote session's mode
 *   can lag one poll (15 s by default). No exception for the caller's parent, so
 *   a non-bypass lane's report to a bypass PM is refused; the PM reads the
 *   lane's transcript instead. A background job left by an archived session is
 *   judged by the mode that session last reported, which the hub keeps until it
 *   restarts; after a restart the mode is absent and the job is refused, the
 *   same as under R8.
 * - Caller lookup across hubs (#5640, operator ruling D2 = a): the send and
 *   archive floors resolve the caller on the entry hub from the local record in
 *   the caller's namespace (by id, then tag), else from the federation cache (by
 *   id, then tag) when its node is not offline, reading its mode only when it is
 *   a known mode. So a bypass session's `hapi api sessions send` pointed at
 *   another hub (`HAPI_SERVER_URL` overridden while `HAPI_SESSION_ID` is
 *   inherited) passes when that hub polls the session's node. A remote record
 *   carries no namespace, so none is checked (#5291); the header is
 *   unauthenticated, so a pass on a remote record is no more than omitting the
 *   header already gives. A caller the hub cannot find at all (one on a hub it
 *   does not poll, such as a `hapimatic-dev` or worktree-instance session sending
 *   through the prod hub, or a session in another namespace) is refused with its
 *   own text (PM ruling OD-1 = 1). The R8 floors resolve callers locally only:
 *   their header comes only from the injected MCP wrapper, which posts to the
 *   session's own hub.
 * - Pins operator-only actions (#6458 Task 12, M-1 option 1 "FLOOR", ruled by
 *   Matt 2026-11-12 03:07Z): a Submit, moving or stopping an automatic pick,
 *   and dismissing or saving a pin of the caller's own session, and P's
 *   `pin_not_owned` on the CLI pin writes, refuse only a caller that sends this
 *   header (`pinRouteHelpers.ts`). The web client never sends it, so a caller
 *   with `CLI_API_TOKEN` and a shell can act as the operator: the same residual
 *   as above. Invariant: no gate, hook or automation treats a pin answer's
 *   `by: "operator"` as authorization. Everything inside a Pins answers
 *   message, notes and review-mark comments included, is machine text to the
 *   hooks: a note is the operator's answer, never a sign-off, and starts no
 *   workflow by itself (Matt, NOTE1, 04:08Z). rp1-home's
 *   `deploy-approval-detector.py` broke it by reading a Pins answers message as
 *   a deploy approval; rp1-home Part 1 (R11a, rp1-home#3226) marks that message
 *   machine-originated. Closing the floor needs per-session credentials (#6633)
 *   and an agent kept out of `HAPI_HOME`; #6632 marks an answer recorded
 *   outside the app (a hint). Detail: `docs/internal/architecture/sync.md` "Who
 *   counts as the operator".
 */
import type { Context } from "hono";
import {
  isPermissionMode,
  isPermissionModeAllowedForFlavor,
  isRetiredBillableSwitchChoice,
  isYoloEquivalentMode,
  KNOWN_AGENT_IDS,
  validateTrackingSettings,
  type BillableSwitchBranchClaim,
  type BillableSwitchMode,
  type McpSet,
  type SpawnWarning,
  type TrackingCarriedCopy,
  type TrackingSettingsInput,
  type TrackingStartValues,
} from "@hapi/protocol";
import {
  clampSpawnPermissionMode,
  spawnPermissionRank,
  spawnPostureRank,
} from "@hapi/protocol/modes";
import type { PermissionMode } from "@hapi/protocol/types";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { Session, SyncEngine } from "../../sync/syncEngine";
import type { WebAppEnv } from "../middleware/auth";
import type { CategoryAnswer } from "./billableTracking";

/** The caller-provenance header the floors read. */
export const CALLER_SESSION_HEADER = "X-Hapi-Session-Id";

/** The two engine lookups the floors need; a fake engine may omit the tag one. */
export type CallerSessionLookup = Pick<SyncEngine, "getSession"> &
  Partial<Pick<SyncEngine, "getSessionByTagAndNamespace">>;

/**
 * Resolve the caller's own session from `X-Hapi-Session-Id` in the request's
 * namespace: by id first (the MCP wrapper stamps the server id), then by tag
 * (the form `hapi api sessions send` stamps, so a manual caller that copies it
 * is still resolved). A
 * session in another namespace is treated as unresolved (the `requireSession`
 * namespace rule).
 */
export function resolveCallerSession(
  c: Context<WebAppEnv>,
  engine: CallerSessionLookup | null
): Session | undefined {
  const callerId = c.req.header(CALLER_SESSION_HEADER);
  if (!callerId || !engine) return undefined;
  const namespace = c.get("namespace");
  const byId = engine.getSession(callerId);
  if (byId) return byId.namespace === namespace ? byId : undefined;
  return engine.getSessionByTagAndNamespace?.(callerId, namespace);
}

/**
 * R6: refuse a permission response whose caller is the session that raised the
 * request. Matches on the raw header OR the resolved caller id, so a caller that
 * stamps its tag is caught too. Returns `null` when the request may proceed.
 */
export function refuseSelfPermission(
  c: Context<WebAppEnv>,
  engine: CallerSessionLookup | null
): Response | null {
  const callerId = c.req.header(CALLER_SESSION_HEADER);
  if (!callerId) return null;
  const targetId = c.req.param("id");
  const isSelf =
    callerId === targetId || resolveCallerSession(c, engine)?.id === targetId;
  if (!isSelf) return null;
  return c.json(
    {
      ok: false,
      error: "A session cannot respond to its own permission request",
      code: "self_permission_refused",
    },
    403
  );
}

/** What the caller-mode floors read of the caller, local or (#5640) remote. */
export type CallerView = { id: string; permissionMode?: PermissionMode };

/**
 * The federation-cache lookups the #5616 floors read. `locateSessionByTag`
 * (#5640) is optional, like the engine's tag lookup, so a fake may omit it.
 */
export type FederationLookup = Pick<NodeRegistry, "locateSession"> &
  Partial<Pick<NodeRegistry, "locateSessionByTag">>;

/**
 * #5640 (operator ruling D2 = a): the caller from the hub's federation cache, by
 * id then by tag (`hapi api sessions send` stamps the tag). Trusted only from a
 * node that is not offline, because a frozen cache must not keep passing an old
 * bypass mode, and its mode only when it is a known mode (remote summaries are
 * cast, not validated), else it reads as mode-less. An ambiguous tag resolves
 * nothing (`locateSessionByTag`). The id is the summary's, never the header,
 * which may be a tag: the archive floor's spawn walk compares ids.
 */
export function resolveRemoteCaller(
  callerId: string,
  registry: FederationLookup | null
): CallerView | undefined {
  const hit =
    registry?.locateSession(callerId) ??
    registry?.locateSessionByTag?.(callerId) ??
    null;
  if (!hit || hit.status === "offline") return undefined;
  const mode: unknown = hit.session.permissionMode;
  return {
    id: hit.session.id,
    permissionMode:
      typeof mode === "string" && isPermissionMode(mode) ? mode : undefined,
  };
}

/**
 * The caller a floor judges: the local record (`resolveCallerSession`), else,
 * for a floor that passes a registry, the federation cache. A local id in
 * another namespace settles it as unresolved (the `requireSession` rule) and is
 * never re-read remotely.
 */
function resolveCallerView(
  c: Context<WebAppEnv>,
  engine: CallerSessionLookup | null,
  registry: FederationLookup | null
): CallerView | undefined {
  const callerId = c.req.header(CALLER_SESSION_HEADER);
  if (!callerId || !engine) return undefined;
  const local = resolveCallerSession(c, engine);
  if (local || engine.getSession(callerId)) return local;
  return resolveRemoteCaller(callerId, registry);
}

/**
 * The caller check every caller-mode floor shares (R8 and #5616), so they cannot
 * drift; they differ only in whether they pass a registry (#5640: the send and
 * archive floors do, R8's do not). `"pass"` with no header (today's behaviour)
 * or for a bypass-mode caller; `"unknown"` when the caller cannot be found and
 * `"refuse"` when it has no live mode (both fail closed); otherwise the
 * non-bypass caller, for a floor to judge against its target.
 */
function classifyCaller(
  c: Context<WebAppEnv>,
  engine: CallerSessionLookup | null,
  registry: FederationLookup | null = null
): "pass" | "unknown" | "refuse" | CallerView {
  if (!c.req.header(CALLER_SESSION_HEADER)) return "pass";
  const caller = resolveCallerView(c, engine, registry);
  if (!caller) return "unknown";
  const mode = caller.permissionMode;
  if (mode === undefined) return "refuse";
  if (isYoloEquivalentMode(mode)) return "pass";
  return caller;
}

/**
 * The R8 refusal text, for an unknown caller too; the #5616 floors' text for a
 * mode-less caller.
 */
const ESCALATION_REFUSED_ERROR =
  "A session that is not in a bypass permission mode cannot do this through the capability channel";

/**
 * #5640 (PM ruling OD-1 = 1): the send and archive floors' text for a caller
 * this hub cannot find. R8's text is unchanged.
 */
const UNKNOWN_CALLER_ERROR =
  "The session named in X-Hapi-Session-Id is not known to this hub, so its permission mode cannot be checked; send through a hub that runs or polls that session";

/** The 403 envelope every caller-mode floor returns (#5616 D7: the R8 code). */
function escalationRefused(c: Context<WebAppEnv>, error: string): Response {
  return c.json({ ok: false, error, code: "agent_escalation_refused" }, 403);
}

/**
 * R8: refuse when the header names a caller that is not in a bypass permission
 * mode. Returns `null` with no header (today's behaviour) or for a bypass-mode
 * caller; a 403 `agent_escalation_refused` otherwise, including when the caller
 * cannot be resolved or has no live mode (fail closed).
 */
export function refuseAgentEscalation(
  c: Context<WebAppEnv>,
  engine: CallerSessionLookup | null
): Response | null {
  if (classifyCaller(c, engine) === "pass") return null;
  return escalationRefused(c, ESCALATION_REFUSED_ERROR);
}

/** A resolved spawn posture, as `resolveSpawnPosture` returns it. */
export type SpawnPostureRequest = {
  yolo: boolean;
  permissionMode?: PermissionMode;
};

/**
 * #6218 (operator ruling D5-a, amends NEW-3842-1 = b): the spawn route's
 * agent-escalation floor, a RANK floor over the EFFECTIVE posture
 * (`spawnPermissionRank`: prompting modes 0, accept / safe-YOLO 1, YOLO 2).
 *
 * - No header (the web UI, and the `hapi api` CLI, which never sends one on a
 *   spawn) or a bypass-mode caller: the posture is returned unchanged.
 * - A caller that cannot be resolved or has no live mode: refused for any
 *   posture above rank 0 (fail closed); a rank-0 posture proceeds.
 * - Any other caller (its mode is its rank): an EXPLICIT posture above its
 *   rank is refused 403 `agent_escalation_refused`; an OMITTED posture (the
 *   node default) above its rank is clamped down to its rank for the harness
 *   (`clampSpawnPermissionMode`), so a prompting agent that names no posture
 *   gets a prompting peer and is never refused for omitting one.
 *
 * Returns the posture to spawn with, or the 403 response.
 */
export function floorAgentSpawnPosture(
  c: Context<WebAppEnv>,
  engine: CallerSessionLookup | null,
  requested: SpawnPostureRequest,
  opts: { explicit: boolean; flavor: string }
): SpawnPostureRequest | Response {
  const caller = classifyCaller(c, engine);
  if (caller === "pass") return requested;
  const rank = spawnPostureRank(requested);
  if (caller === "unknown" || caller === "refuse") {
    return rank > 0
      ? escalationRefused(c, ESCALATION_REFUSED_ERROR)
      : requested;
  }
  // classifyCaller only returns a CallerView with a live, non-bypass mode.
  const callerRank = spawnPermissionRank(
    caller.permissionMode as PermissionMode
  );
  if (rank <= callerRank) return requested;
  if (opts.explicit) {
    return escalationRefused(c, SPAWN_RANK_REFUSED_ERROR);
  }
  const permissionMode = clampSpawnPermissionMode(
    requested.permissionMode ?? "bypassPermissions",
    callerRank,
    opts.flavor
  );
  return { yolo: isYoloEquivalentMode(permissionMode), permissionMode };
}

/**
 * Issue #6171: an MCP set's `enableForProject` turns servers on for the whole
 * project (a write to `~/.claude.json` that every later session in it reads), so
 * an agent caller that is not in a bypass mode may not send it through the
 * capability channel. Narrowing a set (no `enableForProject`) stays allowed: it
 * only takes servers away from the one session. No header, or a bypass-mode
 * caller, passes. Returns the 403 response, or `null` to proceed.
 */
export function floorAgentMcpEnable(
  c: Context<WebAppEnv>,
  engine: CallerSessionLookup | null,
  mcpSet: McpSet | undefined
): Response | null {
  if (mcpSet?.mode !== "only" || !mcpSet.enableForProject?.length) {
    return null;
  }
  return classifyCaller(c, engine) === "pass"
    ? null
    : escalationRefused(c, MCP_ENABLE_REFUSED_ERROR);
}

/** #6171: the refusal text for `enableForProject` from a non-bypass agent. */
const MCP_ENABLE_REFUSED_ERROR =
  "A session that is not in a bypass permission mode cannot turn an MCP server on for a whole project through the capability channel";

/** #6218 (D5-a): the refusal text for an explicit posture above the caller's. */
const SPAWN_RANK_REFUSED_ERROR =
  "A session cannot spawn a peer in a more permissive mode than its own through the capability channel";

/**
 * The permission approve/deny routes' combined floor: the self-permission
 * refusal (R6) first, then the caller-mode floor (R8). One helper so both
 * handlers apply the same checks in the same order. Returns `null` when the
 * response may proceed.
 */
export function refusePermissionResponse(
  c: Context<WebAppEnv>,
  engine: CallerSessionLookup | null
): Response | null {
  return refuseSelfPermission(c, engine) ?? refuseAgentEscalation(c, engine);
}

/**
 * #5616: where the send and archive floors look a target up — the local engine,
 * then the hub's federation cache (`locateSession` returns a remote session's
 * cached summary whatever its node's status).
 */
export type TargetSessionLookup = {
  engine: Pick<SyncEngine, "getSession">;
  registry?: FederationLookup | null;
};

/** The longest spawn chain the archive floor walks (#5616 D3). */
export const MAX_SPAWN_HOPS = 16;

/** What the #5616 floors read of a session, local or remote. */
type SessionView = {
  permissionMode?: PermissionMode;
  flavor?: string | null;
  parentSessionId?: string | null;
  parentRelationship?: "branch" | "spawn" | null;
};

/**
 * #5616 D6: a session by id, from the local record in the caller's namespace
 * (a session in another namespace is not found, the `requireSession` rule) or
 * else from the federation cache. A remote summary carries no namespace, so
 * none is checked here; the owning node's receiver gap is #5291.
 */
function resolveSessionView(
  id: string,
  namespace: string,
  lookup: TargetSessionLookup | null
): SessionView | undefined {
  if (!lookup) return undefined;
  const local = lookup.engine.getSession(id);
  if (local) {
    if (local.namespace !== namespace) return undefined;
    return {
      permissionMode: local.permissionMode,
      flavor: local.metadata?.flavor,
      parentSessionId: local.parentSessionId,
      parentRelationship: local.parentRelationship,
    };
  }
  const remote = lookup.registry?.locateSession(id)?.session;
  if (!remote) return undefined;
  return {
    permissionMode: remote.permissionMode,
    flavor: remote.metadata?.flavor,
    parentSessionId: remote.parentSessionId,
    parentRelationship: remote.parentRelationship,
  };
}

/**
 * #5616 D6 + #5640 S2: a target counts as bypass when it cannot be found, has no
 * live mode, runs a flavor this hub does not know (a newer peer's agent, whose
 * modes it cannot read; a null or empty flavor reads as claude), reports a mode
 * its flavor does not have (`null`, an unrecognised string, another flavor's
 * mode: remote summaries are cast, not validated), runs a flavor with no
 * in-session modes (gemini and opencode never report one, so the server's
 * `"default"` could hide a yolo session; their mode list is empty), or is in a
 * bypass mode. Fails closed.
 */
function isBypassTarget(view: SessionView | undefined): boolean {
  if (!view || view.permissionMode === undefined) return true;
  if (
    view.flavor &&
    !(KNOWN_AGENT_IDS as readonly string[]).includes(view.flavor)
  ) {
    return true;
  }
  if (!isPermissionModeAllowedForFlavor(view.permissionMode, view.flavor)) {
    return true;
  }
  return isYoloEquivalentMode(view.permissionMode);
}

/**
 * #5616 D3 + D10: true when the target is the caller, or the caller spawned it
 * through a chain of `parentRelationship: "spawn"` links. A missing hop, a
 * branch or unlabelled link, a cycle, or a chain longer than `MAX_SPAWN_HOPS`
 * ends the walk with `false`. Through the capability channel a link can only be
 * set on a new session (the promoted spawn route), never rewritten on an
 * existing one (`PUT /api/sessions/:id/parent` is not promoted). The CLI-token
 * parent routes can rewrite it from a shell, part of the registry §5.3 residual
 * (#5629).
 */
function isSpawnDescendantOrSelf(
  targetId: string,
  callerId: string,
  namespace: string,
  lookup: TargetSessionLookup | null
): boolean {
  if (targetId === callerId) return true;
  const visited = new Set<string>();
  let id = targetId;
  for (let hop = 0; hop < MAX_SPAWN_HOPS; hop++) {
    if (visited.has(id)) return false;
    visited.add(id);
    const view = resolveSessionView(id, namespace, lookup);
    const parentId = view?.parentSessionId;
    if (!view || !parentId || view.parentRelationship !== "spawn") return false;
    if (parentId === callerId) return true;
    id = parentId;
  }
  return false;
}

/**
 * #5616 send floor (D2): refuse a non-bypass caller's message to a target that
 * counts as bypass (`isBypassTarget`), with no exception for the caller's own
 * parent. Returns `null` with no header, for a bypass-mode caller (local, or
 * remote from the federation cache, #5640), or for a non-bypass target (the
 * caller itself included); fails closed like R8, with its own text for a caller
 * this hub cannot find.
 */
export function refuseAgentMessage(
  c: Context<WebAppEnv>,
  engine: CallerSessionLookup | null,
  lookup: TargetSessionLookup | null
): Response | null {
  const caller = classifyCaller(c, engine, lookup?.registry ?? null);
  if (caller === "pass") return null;
  if (caller === "unknown") return escalationRefused(c, UNKNOWN_CALLER_ERROR);
  if (caller === "refuse") {
    return escalationRefused(c, ESCALATION_REFUSED_ERROR);
  }
  const target = resolveSessionView(
    c.req.param("id") ?? "",
    c.get("namespace"),
    lookup
  );
  if (!isBypassTarget(target)) return null;
  return escalationRefused(
    c,
    "A session that is not in a bypass permission mode cannot message a session in a bypass permission mode"
  );
}

/**
 * #5616 archive floor (D3): a non-bypass caller can archive only itself or a
 * session it spawned (`isSpawnDescendantOrSelf`). Returns `null` with no header
 * or for a bypass-mode caller (local, or remote from the federation cache,
 * #5640); fails closed like R8, with its own text for a caller this hub cannot
 * find.
 */
export function refuseAgentArchive(
  c: Context<WebAppEnv>,
  engine: CallerSessionLookup | null,
  lookup: TargetSessionLookup | null
): Response | null {
  const caller = classifyCaller(c, engine, lookup?.registry ?? null);
  if (caller === "pass") return null;
  if (caller === "unknown") return escalationRefused(c, UNKNOWN_CALLER_ERROR);
  if (caller === "refuse") {
    return escalationRefused(c, ESCALATION_REFUSED_ERROR);
  }
  const allowed = isSpawnDescendantOrSelf(
    c.req.param("id") ?? "",
    caller.id,
    c.get("namespace"),
    lookup
  );
  if (allowed) return null;
  return escalationRefused(
    c,
    "A session that is not in a bypass permission mode can archive only itself or a session it spawned"
  );
}

// ─── Issue #6646: the billable switch's agent rule ──────────────────────────

/**
 * The capability invoker's re-entrancy header: set on every request it
 * dispatches (the agents' tool channel and `hapi api call`), and refused on the
 * way in, so a caller cannot strip it from a dispatched request. Moved here from
 * `capabilityCall.ts` (which imports it) so the billable agent rule reads it.
 */
export const CAPABILITY_DEPTH_HEADER = "X-Hapi-Capability-Depth";

/**
 * A billable write (or a spawn) is an agent's when it names a session (the
 * header is present, resolved or not) or arrived through the tool channel. A
 * floor on the paths agents normally use, not a guarantee: a caller holding the
 * node's access token that names no session reads as `client` (R14).
 */
export function isAgentRequest(c: Context<WebAppEnv>): boolean {
  return Boolean(
    c.req.header(CALLER_SESSION_HEADER) || c.req.header(CAPABILITY_DEPTH_HEADER)
  );
}

/** The channel a billable write came in on: `tool` through the invoker, else `direct`. */
export function billableSwitchVia(c: Context<WebAppEnv>): "tool" | "direct" {
  return c.req.header(CAPABILITY_DEPTH_HEADER) ? "tool" : "direct";
}

/**
 * The actor a billable write records, set by the hub from the request and never
 * from a client body: a request that names a session is that session (the
 * resolved id, else the raw header value); any other is `client`, with its user
 * agent. Claims, not identities (the plan's section 6 item 3).
 */
export function billableSwitchActor(
  c: Context<WebAppEnv>,
  engine: CallerSessionLookup | null
): { kind: "session" | "client"; sessionId?: string; userAgent?: string } {
  const raw = c.req.header(CALLER_SESSION_HEADER);
  if (raw) {
    const resolved = resolveCallerSession(c, engine);
    return { kind: "session", sessionId: (resolved?.id ?? raw).slice(0, 200) };
  }
  const userAgent = c.req.header("user-agent")?.slice(0, 200);
  return { kind: "client", ...(userAgent ? { userAgent } : {}) };
}

/** What a billable write asks for, for the agent rule. */
export type BillableSwitchWriteIntent =
  | "on"
  | "off"
  | "keep"
  | "reverse"
  | "keep-all"
  | "header";

/**
 * The agent rule (review P3), the same on every billable write: an agent may
 * switch off and Reverse; it is refused the on direction, Keep, Keep all and
 * every header change; and a request whose named session does not resolve is
 * refused on every write (the product's other floors fail closed the same way).
 * Returns null when the request may proceed.
 */
export function refuseAgentBillableWrite(
  c: Context<WebAppEnv>,
  engine: CallerSessionLookup | null,
  wants: BillableSwitchWriteIntent
): Response | null {
  if (!isAgentRequest(c)) return null;
  if (c.req.header(CALLER_SESSION_HEADER) && !resolveCallerSession(c, engine)) {
    return escalationRefused(c, UNKNOWN_CALLER_ERROR);
  }
  switch (wants) {
    case "off":
    case "reverse":
      return null;
    case "on":
      return c.json(
        {
          ok: false,
          error:
            "An agent cannot switch a session on. Switch it on in the app.",
          code: "agent_cannot_switch_on",
        },
        403
      );
    case "keep":
      return c.json(
        {
          ok: false,
          error: "An agent cannot keep a session billable. Keep it in the app.",
          code: "agent_cannot_keep",
        },
        403
      );
    case "keep-all":
    case "header":
      return c.json(
        {
          ok: false,
          error:
            wants === "header"
              ? "An agent cannot change a project's billable header. Change it in the app."
              : "An agent cannot keep sessions billable. Keep them in the app.",
          code: "agent_billable_refused",
        },
        403
      );
  }
}

/** The start context a route builds; the server-only form of the wire context. */
export type RouteBillableSwitchStart = {
  kind: "agent" | "person" | "unattended";
  choice?:
    | "follow-header"
    | "header-and-session"
    | "session-only"
    | "not-billable";
  actor: { kind: "session" | "client"; sessionId?: string; userAgent?: string };
  via: "tool" | "direct";
  entryNodeId?: string;
  namespace?: string;
  /** #6778: a person's settings, validated at the entry node (row 2; 7.3). */
  tracking?: TrackingStartValues;
  /** #6778: the parent an agent's start copies, always a claim (4.1; review A1). */
  inheritedFrom?: {
    sessionId: string;
    nodeId: string | null;
    claimed: true;
    headerBound: boolean;
  };
  /** #6778: that parent's record, carried by the hub to another node (4.2, the one rule). */
  inheritedCopy?: TrackingCarriedCopy;
};

/**
 * Issue #6646 (Task 6): the start context of a spawn request, by this signal
 * order, built by the ENTRY hub and never taken from a client body:
 *  1. an agent's request (names a session, resolved or not, or came through the
 *     tool channel) → `agent`; a body choice is ignored. A person's spawn sent
 *     through `hapi api call` comes through the tool channel and is `agent` on
 *     purpose: that channel is the agents' own, and no screen uses it;
 *  2. a body choice, or a person's tracking settings (#6778; validated after,
 *     by `resolvePersonTrackedStart`) → `person` (with or without a parent
 *     link: the web's Fan-out sends one and is a person's start);
 *  3. a parent link with relationship `spawn` (what `hapi api sessions spawn`
 *     sends from inside a session) → `agent`, with the parent as the actor;
 *  4. anything else → `unattended` (a script, a Create from a cached old app).
 */
export function buildBillableSwitchStart(
  c: Context<WebAppEnv>,
  engine: CallerSessionLookup | null,
  body: {
    choice?: RouteBillableSwitchStart["choice"];
    tracking?: TrackingSettingsInput;
    parentSessionId?: string;
    parentRelationship?: "branch" | "spawn";
  },
  entryNodeId?: string
): RouteBillableSwitchStart {
  const via = billableSwitchVia(c);
  const namespace = c.get("namespace");
  const common = {
    via,
    ...(entryNodeId ? { entryNodeId } : {}),
    ...(namespace ? { namespace } : {}),
  };
  if (isAgentRequest(c)) {
    return { kind: "agent", actor: billableSwitchActor(c, engine), ...common };
  }
  if (body.choice || body.tracking) {
    return {
      kind: "person",
      ...(body.choice ? { choice: body.choice } : {}),
      actor: billableSwitchActor(c, engine),
      ...common,
    };
  }
  if (body.parentRelationship === "spawn" && body.parentSessionId) {
    return {
      kind: "agent",
      actor: { kind: "session", sessionId: body.parentSessionId.slice(0, 200) },
      ...common,
    };
  }
  return {
    kind: "unattended",
    actor: billableSwitchActor(c, engine),
    ...common,
  };
}

/**
 * #6778 PR-C (Task 15b; section 4.3, ruling 5): what a branch or a transcript
 * resume asks for on its `inherit` start, built by the entry hub from the
 * request and never from a body. A request that names no session and did not
 * come through the tool channel is a person's in the app (row 6a, no wait); the
 * CLI's verb (it stamps the caller session) and a tool are an agent's, and wait
 * (row 6b). A header-less script reads as a person's: the residual of 7.2.
 */
export function inheritStartClaim(
  c: Context<WebAppEnv>,
  engine: CallerSessionLookup | null,
  entryNodeId?: string
): BillableSwitchBranchClaim {
  return {
    actor: billableSwitchActor(c, engine),
    via: billableSwitchVia(c),
    ...(entryNodeId ? { entryNodeId } : {}),
    ...(isAgentRequest(c) ? {} : { inheritClaim: "person" as const }),
  };
}

/**
 * Issue #6778 PR-A (R12; reviews H8, T11, C9): a person's start that carries a
 * retired billable answer (`session-only`, `header-and-session`) is refused with
 * 400 `billable_choice_retired`, in every gate state, by the local Create, the
 * hub's route to another node and the peer's receiver (an older hub can still
 * send one). Both answers billed through the project header, which no longer
 * decides a start; passed on, the session would start non-billable with a 200
 * and the person's answer would be lost without a word. Every other start (no
 * answer, `follow-header`, `not-billable`, an agent's or an unattended start,
 * whose body answer is ignored) passes. Returns null to pass.
 */
export function refuseRetiredBillableAnswer(
  c: Context<WebAppEnv>,
  start: Pick<RouteBillableSwitchStart, "kind" | "choice">
): Response | null {
  if (start.kind !== "person" || !isRetiredBillableSwitchChoice(start.choice)) {
    return null;
  }
  const message = `The billable answer "${start.choice}" is retired: no project setting decides whether a session is billable any more, so start the session without it.`;
  return c.json(
    {
      type: "error",
      error: message,
      message,
      code: "billable_choice_retired",
      choice: start.choice,
    },
    400
  );
}

/** A spawn refusal in the spawn routes' envelope (`type`, `error`, `message`, `code`). */
function spawnRefusal(
  c: Context<WebAppEnv>,
  status: 400 | 409,
  code: string,
  message: string,
  detail: Record<string, unknown> = {}
): Response {
  return c.json(
    { type: "error", error: message, message, code, ...detail },
    status
  );
}

/** 409 `sync_unavailable` (7.3) until #6783 gives its lookup: the PUT's words and the spawn's. */
export const SYNC_UNAVAILABLE_MESSAGE =
  "Syncing a session's time to another service is not available yet.";

/**
 * Issue #6778 (4.1, 7.2, 7.3; Task 15): a person's spawn that carries tracking
 * settings, checked at the entry node before anything is spawned. This node's
 * gate must be `on`, whatever the target: off → 409
 * `billable_feature_unsupported`, closed → 409 `billable_feature_closed` (an
 * answer a node cannot honour is refused, never dropped). The category goes
 * through #6779's lookup: no list, or one that cannot be read → 409
 * `categories_unavailable` (with the lookup's reason when it gave one); a
 * category the list does not know → 400 `invalid_field`. Then the one validator
 * (`validateTrackingSettings`, no prior record); a sync selection → 409
 * `sync_unavailable`, as the PUT answers. A refusal names the field and
 * the rule, never a value. Any other start (an agent's tracking body included,
 * which is ignored) passes unchanged.
 */
export async function resolvePersonTrackedStart(
  c: Context<WebAppEnv>,
  start: RouteBillableSwitchStart,
  input: TrackingSettingsInput | undefined,
  deps: {
    mode: BillableSwitchMode;
    nodeLabel: string;
    lookUp: (ref: TrackingSettingsInput["category"]) => Promise<CategoryAnswer>;
  }
): Promise<RouteBillableSwitchStart | Response> {
  if (start.kind !== "person" || input === undefined) return start;
  const nodeLabel = deps.nodeLabel;
  if (deps.mode === "off") {
    return spawnRefusal(
      c,
      409,
      "billable_feature_unsupported",
      `${nodeLabel} does not run billable sessions, so a session cannot start with time tracking from it.`,
      { nodeLabel }
    );
  }
  if (deps.mode === "closed") {
    return spawnRefusal(
      c,
      409,
      "billable_feature_closed",
      `Billable sessions are closed on ${nodeLabel}: a session cannot start with time tracking from it.`,
      { nodeLabel }
    );
  }
  const looked = await deps.lookUp(input.category);
  if (!looked.ok) {
    return spawnRefusal(
      c,
      409,
      "categories_unavailable",
      "The billing categories cannot be read right now, so a session cannot start with a category. Try again later.",
      looked.reason ? { reason: looked.reason } : {}
    );
  }
  if (looked.category === null) {
    return spawnRefusal(
      c,
      400,
      "invalid_field",
      "The tracking settings were refused: the category is not on the list.",
      { field: "category", reason: "unknown_category" }
    );
  }
  const checked = validateTrackingSettings(input, looked.category, null);
  if (!checked.ok) {
    // RF-3: the PUT's own answer (7.3), never a 400 for a sync selection.
    if (checked.reason === "sync_unavailable") {
      return spawnRefusal(c, 409, "sync_unavailable", SYNC_UNAVAILABLE_MESSAGE);
    }
    return spawnRefusal(
      c,
      400,
      "invalid_field",
      `The tracking settings were refused: ${checked.field} (${checked.reason}).`,
      { field: checked.field, reason: checked.reason }
    );
  }
  return { ...start, tracking: checked.values };
}

/** C9's warning: the start went ahead without its parent's settings. */
export const TRACKING_COPY_NOT_SENT_CALLER: SpawnWarning = {
  code: "tracking_copy_not_sent",
  message:
    "The new session started untracked: the parent it names is neither the session that asked for it nor a session that one spawned, so its tracking settings were not copied.",
};

/**
 * Issue #6778 (4.2 row 5; C9 as ruled, reviews A1 and C3; Task 15): the parent
 * an agent's spawn copies. The parent is the body's (resolved in the caller's
 * namespace), else the session `X-Hapi-Session-Id` resolves to; with neither,
 * the start is untracked. Only when a copy would be made (this node's gate `on`
 * and the parent has a record) is anything recorded, so with the gate off or an
 * untracked parent the start is what it was before PR-C. Then, only where the
 * header resolves, the parent must be the caller or one of its spawned sessions
 * (`isSpawnDescendantOrSelf`); on a failure the start goes ahead without the
 * copy, with the warning `tracking_copy_not_sent`, and nothing is written on
 * the named parent's history. Every parent is a claim: `headerBound` records
 * only whether the check ran. The record itself is read at registration on the
 * owning node (the one rule of 4.2), not here.
 */
export function resolveAgentParent(
  c: Context<WebAppEnv>,
  engine: CallerSessionLookup | null,
  start: RouteBillableSwitchStart,
  deps: {
    mode: BillableSwitchMode;
    parentSessionId?: string;
    hasRecord: (sessionId: string) => boolean;
    nodeId: string | null;
    lookup: TargetSessionLookup | null;
  }
): { start: RouteBillableSwitchStart; warning?: SpawnWarning } {
  if (start.kind !== "agent" || deps.mode !== "on") return { start };
  const caller = resolveCallerSession(c, engine);
  const parentId = deps.parentSessionId ?? caller?.id;
  if (!parentId || !deps.hasRecord(parentId)) return { start };
  if (
    caller &&
    !isSpawnDescendantOrSelf(
      parentId,
      caller.id,
      c.get("namespace"),
      deps.lookup
    )
  ) {
    return { start, warning: TRACKING_COPY_NOT_SENT_CALLER };
  }
  return {
    start: {
      ...start,
      inheritedFrom: {
        sessionId: parentId,
        nodeId: deps.nodeId,
        claimed: true,
        headerBound: caller !== undefined,
      },
    },
  };
}
