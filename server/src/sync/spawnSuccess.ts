// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The spawn RPC's success result as the hub returns it (issue #5614, split out
 * of `rpcGateway.ts` so that file stays under its line cap). The daemon's reply
 * crosses the wire as an untrusted value, so each optional field is copied
 * only when it has the expected shape (the #1262 field-by-field trap: a field
 * not listed here never reaches a caller). The daemon's `spawn-happy-session`
 * handler (`cli/src/api/apiMachine.ts`) rebuilds the reply field by field too,
 * so a new field must be added at both hops.
 */

/**
 * Issue #5614 (#5202 U2): a defaulted worktree spawn that ran as a simple
 * session. Mirrors `SessionTypeDowngrade` in
 * `cli/src/modules/common/rpcTypes.ts` and the 200 response schema of
 * `POST /spawn-session` in `cli/src/daemon/controlServer.ts`; keep all three in
 * lockstep, because a schema that disagrees fails serialization and turns a
 * successful spawn into a 500.
 */
export interface SpawnTypeDowngrade {
  from: "worktree";
  to: "simple";
  reason: string;
}

export interface SpawnSuccess {
  type: "success";
  sessionId: string;
  resolvedName?: string;
  sessionTypeDowngrade?: SpawnTypeDowngrade;
}

/**
 * The daemon's downgrade reason as a NEW object, or `undefined` when the value
 * is absent or not the expected shape.
 */
export function parseSpawnTypeDowngrade(
  value: unknown
): SpawnTypeDowngrade | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.from !== "worktree" || v.to !== "simple") return undefined;
  if (typeof v.reason !== "string") return undefined;
  return { from: "worktree", to: "simple", reason: v.reason };
}

/**
 * Build the hub's success result from a daemon reply whose `type` is
 * `"success"` and whose `sessionId` is a string (the caller checks both).
 * `sessionTypeDowngrade` reaches the synchronous `/machines/:id/spawn` body,
 * which `POST /api/capabilities/call` relays verbatim to the MCP
 * `spawn_session` tool. The early-return path
 * discards a success result, so `hapi api sessions spawn` and the web's local
 * create do not see it.
 */
export function spawnSuccessFromRpc(
  obj: Record<string, unknown> & { sessionId: string }
): SpawnSuccess {
  const downgrade = parseSpawnTypeDowngrade(obj.sessionTypeDowngrade);
  return {
    type: "success",
    sessionId: obj.sessionId,
    ...(typeof obj.resolvedName === "string"
      ? { resolvedName: obj.resolvedName }
      : {}),
    ...(downgrade ? { sessionTypeDowngrade: downgrade } : {}),
  };
}
