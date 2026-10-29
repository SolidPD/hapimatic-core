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
 * stamps its `HAPI_SESSION_ID` tag only on `sessions send`, so that verb run from
 * inside a session meets the send floor below (#5616 D5); its spawn, archive and
 * `call` verbs carry no header. A request without the header (the web UI, the
 * `hapi api` CLI outside a session, a shell or cron caller) keeps today's
 * behaviour: web and CLI mint identical JWTs, so the header is the only
 * discriminator, and an unsandboxed agent holding `CLI_API_TOKEN` can still call
 * a route without it (`hapi api call`, curl, `env -u HAPI_SESSION_ID`; registry
 * §5.3, documented residual).
 *
 * - Self-permission refusal (R6): a session cannot approve or deny its OWN
 *   permission request through this channel.
 * - Caller-mode floor (R8, operator ruling NEW-3842-1 = b, 2026-10-01): a
 *   session whose live permission mode is not a bypass mode cannot spawn a
 *   `yolo` peer (any spawn without an explicit `yolo: false`, because the daemon
 *   spawns in YOLO mode unless `yolo` is exactly `false`), create or update a
 *   schedule (scheduled sessions always run in
 *   the bypass mode), or answer any session's permission request. A bypass-mode
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
 */
import type { Context } from "hono";
import {
  isPermissionMode,
  isPermissionModeAllowedForFlavor,
  isYoloEquivalentMode,
  KNOWN_AGENT_IDS,
} from "@hapi/protocol";
import type { PermissionMode } from "@hapi/protocol/types";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { Session, SyncEngine } from "../../sync/syncEngine";
import type { WebAppEnv } from "../middleware/auth";

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
type CallerView = { id: string; permissionMode?: PermissionMode };

/**
 * The federation-cache lookups the #5616 floors read. `locateSessionByTag`
 * (#5640) is optional, like the engine's tag lookup, so a fake may omit it.
 */
type FederationLookup = Pick<NodeRegistry, "locateSession"> &
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
function resolveRemoteCaller(
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
