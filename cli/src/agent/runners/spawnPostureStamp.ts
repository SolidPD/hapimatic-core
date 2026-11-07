// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6218 — record a non-Claude session's starting permission posture in
 * `metadata.permissionMode`, the field every server respawn derives its `yolo`
 * from (`respawnYoloFromPosture`). Without it an ABSENT posture reads as a
 * legacy session and the respawn relaunches in YOLO, so a Codex session
 * started in safe-YOLO, or a Gemini / OpenCode session started in default,
 * would come back in YOLO on its first reconnect. Claude stamps its own in
 * `runClaude` (`spawnPermissionStamp`).
 */
import type { Metadata } from "@/api/types";
import { isPermissionMode, type PermissionMode } from "@hapi/protocol/modes";

/** The metadata writer every runner's session client exposes. */
export type MetadataWriter = {
  updateMetadata(handler: (metadata: Metadata) => Metadata): void;
};

/**
 * Stamp `mode` as the session's posture unless a valid posture is already
 * saved (a respawn, or a disconnected Session Configuration save, keeps its
 * own). A missing `mode` stamps nothing, so the legacy respawn rule stands.
 */
export function stampSpawnPosture(
  session: MetadataWriter,
  mode: PermissionMode | undefined
): void {
  if (mode === undefined) return;
  session.updateMetadata(prev => {
    const saved: unknown = (prev as { permissionMode?: unknown })
      .permissionMode;
    return typeof saved === "string" && isPermissionMode(saved)
      ? prev
      : ({ ...prev, permissionMode: mode } as Metadata);
  });
}

/**
 * The posture an OpenCode session was spawned with, read from the
 * daemon-injected `OPENCODE_CONFIG_CONTENT` (`buildOpenCodeConfigContent`, which
 * writes one value to every tool category). It reads `permission.edit`: `allow`
 * is YOLO and `ask` is `default` (OpenCode asks). An absent, unparsable or
 * other value returns `undefined` (nothing is stamped).
 */
export function opencodeSpawnPosture(
  configContent: string | undefined
): PermissionMode | undefined {
  if (!configContent) return undefined;
  try {
    const parsed = JSON.parse(configContent) as {
      permission?: { edit?: unknown };
    };
    const edit = parsed?.permission?.edit;
    if (edit === "allow") return "yolo";
    if (edit === "ask") return "default";
    return undefined;
  } catch {
    return undefined;
  }
}
