// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Agent-escalation floors for the routes the capability channel promotes
 * (issue #3842, R6 + R8 — TRUST-CRITICAL, expert-review gated).
 *
 * #3842 promotes the spawn, schedule-write and permission-response routes in
 * `PROMOTED_ENTRY_IDS`, so every agent can reach them through raw `hapi_call`,
 * not only through the typed tools. The checks therefore live HERE, in the
 * routes, so neither a typed tool nor raw `hapi_call` can step around them (both
 * go through the wrapper, which always stamps the header below).
 *
 * Both floors key on `X-Hapi-Session-Id`, the caller's own session id. The
 * injected hapi MCP wrapper stamps it on every `POST /api/capabilities/call` and
 * the invoker copies it onto the dispatched request (Task 2). The `hapi api` CLI
 * stamps its `HAPI_SESSION_ID` tag only on `sessions send`, which has no floor;
 * its spawn and other calls carry no header. A request without the header (the
 * web UI, the `hapi api` CLI, a shell or cron caller) keeps today's behaviour:
 * web and CLI mint identical JWTs, so the header is the only discriminator, and
 * an unsandboxed agent holding `CLI_API_TOKEN` can still call a route without it
 * (registry §5.3, documented residual).
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
 */
import type { Context } from "hono";
import { isYoloEquivalentMode } from "@hapi/protocol";
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
  if (!c.req.header(CALLER_SESSION_HEADER)) return null;
  const mode = resolveCallerSession(c, engine)?.permissionMode;
  if (mode !== undefined && isYoloEquivalentMode(mode)) return null;
  return c.json(
    {
      ok: false,
      error:
        "A session that is not in a bypass permission mode cannot do this through the capability channel",
      code: "agent_escalation_refused",
    },
    403
  );
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
