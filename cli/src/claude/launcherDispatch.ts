// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, existsSync } from "node:fs";
import { logger } from "@/ui/logger";
import { configuration } from "@/configuration";
import {
  resolveLauncherKind,
  type ClaudeRemoteLauncherKind,
  type ResolvedLauncher,
} from "@hapi/protocol/launcherResolver";
import type { Session } from "./session";
import { claudeRemoteLauncher } from "./claudeRemoteLauncher";
import { claudePtyLauncher } from "./claudePtyLauncher";
import { claudeTmuxRemoteLauncher } from "./claudeTmuxRemoteLauncher";

/**
 * Callback for raw terminal output bytes (decoded text). Used by both the
 * PTY-attach launcher (via `onPtyOutput`) and the tmux backup launcher
 * (via `onTmuxOutput`) so they can share the same downstream emit-site at
 * `session.client.sendClaudePtyOutput(data)`. Issue #1310 R3.
 *
 * Note: the option fields on the two launchers retain their launcher-specific
 * names (`onPtyOutput` / `onTmuxOutput`) per architect-review Q2 — the TYPE
 * is shared, the OPTION FIELDS are not. The channel itself uses C's
 * PTY-specific naming (`claude:pty-output`) — see issue #1310 Open Risks #3
 * for the rename caveat.
 */
export type ClaudeRawOutputCallback = (data: string) => void;

export type { ClaudeRemoteLauncherKind } from "@hapi/protocol/launcherResolver";

type LauncherFn = (session: Session) => Promise<"switch" | "exit">;

const REGISTRY: Record<ClaudeRemoteLauncherKind, LauncherFn> = {
  sdk: claudeRemoteLauncher,
  pty: claudePtyLauncher,
  tmux: claudeTmuxRemoteLauncher,
};

export const AVAILABLE_LAUNCHER_KINDS = Object.keys(
  REGISTRY
) as ClaudeRemoteLauncherKind[];

function readSettingsLauncherSync(): string | undefined {
  if (!existsSync(configuration.settingsFile)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(configuration.settingsFile, "utf8"));
    return typeof raw?.launcher === "string" ? raw.launcher : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the active launcher from the priority chain (env > settings >
 * default) WITHOUT selecting the launcher function. `runClaude` calls it once
 * per wrapper and hands the result to loop(), which selects the launcher from
 * it (issue #6617 round 5), so every use of the kind — the #1611 thinking
 * scope, the #1613 stamp, the D7-1 refusal — is the launcher that runs.
 */
export function resolveActiveLauncher(): ResolvedLauncher {
  const envValue = process.env.HAPI_CLAUDE_LAUNCHER;
  const settingsValue = readSettingsLauncherSync();
  return resolveLauncherKind(envValue, settingsValue);
}

/**
 * Select the remote launcher for the ONE launcher the caller resolved. Issue
 * #6617 round 5: runClaude resolves once and hands that value here through
 * loop(), so the launcher that runs is the kind the D7-1 refusal holds; a
 * second read of env and settings here could pick another kind after a
 * `hapi launcher set` in the start window.
 */
export function selectClaudeRemoteLauncher(
  resolved: ResolvedLauncher
): LauncherFn {
  if (resolved.rejected) {
    logger.error(
      `[launcherDispatch] Rejected invalid HAPI_CLAUDE_LAUNCHER value: ${JSON.stringify(resolved.rejectedValue)}. ` +
        `Valid values: ${AVAILABLE_LAUNCHER_KINDS.join(", ")}. Falling back to '${resolved.kind}' (source: ${resolved.source}).`
    );
  }

  if (resolved.kind !== "sdk") {
    logger.debug(
      `[launcherDispatch] Selecting non-default remote launcher: ${resolved.kind} (source: ${resolved.source})`
    );
  }

  return REGISTRY[resolved.kind];
}
