// SPDX-License-Identifier: AGPL-3.0-only
import type { Session } from "@hapi/protocol/types";
import { respawnYoloFromPosture } from "@hapi/protocol";
import type { SpawnSessionOptions } from "./syncEngine";

/**
 * Issue #6171: the per-session pins EVERY respawn and inheriting spawn carries
 * from the session's metadata — the output style (#2626) and the MCP set — in one
 * place, so a path can no longer pick up one and drop the other (before #6171,
 * reconnect, branch and the watermark successor all dropped `outputStyle`).
 * Spread by `buildRespawnBase`, the inline config restart, reconnect, branch and
 * the successor. Both are absent for a session that never had them, so such a
 * spawn is unchanged.
 */
export function inheritedSessionPins(
  session: Pick<Session, "metadata">
): Pick<SpawnSessionOptions, "outputStyle" | "mcpSet"> {
  return {
    outputStyle: session.metadata?.outputStyle,
    mcpSet: session.metadata?.mcpSet,
  };
}

/**
 * Issue #2149 — the canonical "respawn base": the SUPERSET of spawn fields a
 * teardown + `--resume` respawn MUST preserve so the session comes back identical
 * except for the field(s) the caller overrides.
 *
 * Extracted so the new `SessionRelaunch` delegate (launcher / safeMode relaunch)
 * builds the exact same preserved-field list that `SessionLifecycleOps
 * .sessionConfigRestart` (model-mode / effort / rawModel restart) builds inline —
 * ONE builder prevents the #1262-trap "silently dropped a preserved field" class
 * from ever diverging between the two respawn paths.
 *
 * Callers pass the already-validated `machineId` / `directory` / `sessionTag` and
 * the recovered `claudeSessionId`; every other preserved field is read from
 * `session.metadata`. Claude-only (callers gate on flavor before calling). The
 * caller then spreads its own override(s) over the returned base, and uses the
 * BARE base for the all-or-nothing rollback respawn.
 *
 * ⚠️ KEEP IN SYNC with `SpawnSessionOptions`: when a new spawn-frozen field that
 * must survive a respawn is added (mirroring safeMode / launcher / sessionRole /
 * outputStyle), add it here so BOTH respawn paths preserve it.
 *
 * NOTE: `sessionConfigRestart` still builds this list inline (untested lifecycle
 * code left untouched under #2149) — the sole remaining inline holdout, a tracked
 * follow-up. `accountRestart.ts`'s four respawn builders were reconciled ONTO this
 * builder by #3087 (they now spread `...buildRespawnBase(...)`), so they preserve
 * outputStyle / effort / rawModel too — the earlier "hand-rolls FOUR payloads that
 * DROP" gap is closed (verified by the #3087 (R3) tests in
 * syncEngine.{switchAccount,tokenRefreshRestart}.test.ts).
 */
export function buildRespawnBase(
  session: Session,
  args: {
    machineId: string;
    directory: string;
    sessionTag: string;
    claudeSessionId: string | undefined;
  }
): SpawnSessionOptions {
  return {
    machineId: args.machineId,
    directory: args.directory,
    agent: "claude",
    // Issue #6218 (absorbs #5353 R1): respawn in the session's SAVED posture —
    // YOLO only when it was saved in a bypass mode; otherwise no `--yolo`, and the
    // CLI restores the saved mode itself (metadata pin > spawn seed). An absent
    // posture (a session recorded before the spawn-time stamp) keeps the legacy
    // bypass respawn. Covers every builder spreading this base: the four
    // accountRestart paths (incl. the automatic token-refresh restart) and
    // SessionRelaunch.
    yolo: respawnYoloFromPosture(session.metadata?.permissionMode),
    claimPort: true,
    resumeSessionId: args.claudeSessionId ?? undefined,
    hapiSessionId: args.sessionTag,
    name: session.metadata?.name,
    sessionType: "simple",
    accountUuid: session.metadata?.accountUuid,
    // Issue #4568 (R6): preserve an API-key binding — the vault id AND the mask
    // recorded at the first spawn, so the daemon re-binds the SAME key (or
    // refuses a key replaced under that id). Absent for a subscription session.
    // An account switch overrides `accountUuid` and clears these two itself.
    apiKeyId: session.metadata?.apiKeyId,
    apiKeyMasked: session.metadata?.apiKeyMasked,
    // Issue #5819: the cross-node placement marker rides every respawn, so the
    // spawn choke point re-checks the key is still shared.
    apiKeyPlacedBy: session.metadata?.apiKeyPlacedBy,
    // Issue #1633: preserve Safe Mode across the respawn.
    safeMode: session.metadata?.safeMode === true,
    // Issue #1660: preserve the per-session launcher (resolved kind frozen at
    // spawn by runClaude, #1613); undefined for legacy sessions → omitted.
    launcher: session.metadata?.launcherKind,
    // Issue #2155: preserve the role-scoped profile — else a respawn reverts to
    // the FULL stack (OR-4).
    sessionRole: session.metadata?.sessionRole,
    // Issue #2626 / #6171: preserve the output style and the MCP set — else a
    // respawn reverts to the machine default style and starts every server.
    ...inheritedSessionPins(session),
    // Issue #2434 / #2456: preserve the model axis + effort. Load-bearing for the
    // BARE-base rollback respawn; the primary spawn overrides these when relevant.
    modelMode: session.metadata?.modelMode,
    effort: session.metadata?.effort,
    rawModel: session.metadata?.rawModel,
    // Issue #1555: return on child-start, not full cold-MCP boot.
    awaitWebhook: false,
  };
}
