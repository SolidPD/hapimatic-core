// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

/**
 * Launcher resolver — pure logic for picking which Claude launcher Hapimatic
 * uses when spawning a remote Claude session.
 *
 * Single source of truth for the `ClaudeRemoteLauncherKind` union, the valid
 * kinds list, and the priority-chain resolver. Used by:
 * - `cli/src/claude/launcherDispatch.ts` (boot-time selection per session spawn)
 * - `cli/src/commands/launcher.ts` (operator-facing `hapi launcher` CLI)
 * - `server/src/web/routes/launcher.ts` (`GET /api/launcher/status` endpoint)
 *
 * Background: the 2026-06-15 Anthropic Agent SDK billing change motivated
 * letting Hapimatic spawn Claude either via SDK (default, billed as Agent SDK
 * post-2026-06-15) or via a direct PTY (interactive, billed as subscription).
 * See epic #1305 and `claudedocs/pty-launcher-runbook.md` for context.
 *
 * Resolution priority: env (`HAPI_CLAUDE_LAUNCHER`) > settings.json (`launcher`)
 * > default (`sdk`). Invalid values at any layer "fall through" to the next
 * layer with a `rejected` flag so callers can surface the bad value to the
 * operator.
 *
 * This module is PURE — no filesystem, no env reads, no logger calls. Callers
 * own the I/O and pass both values into `resolveLauncherKind()`. Keeping the
 * function pure makes it trivially testable and lets the cli + server + web
 * surfaces share identical resolution semantics without coupling to a runtime.
 */

export type ClaudeRemoteLauncherKind = "sdk" | "pty" | "tmux";

export const VALID_KINDS = ["sdk", "pty", "tmux"] as const;

export const ClaudeRemoteLauncherKindSchema = z.enum(VALID_KINDS);

export type LauncherSource = "env" | "settings" | "default";

export interface ResolvedLauncher {
  kind: ClaudeRemoteLauncherKind;
  source: LauncherSource;
  rejected: boolean;
  rejectedValue?: string;
}

function isValid(value: unknown): value is ClaudeRemoteLauncherKind {
  return (
    typeof value === "string" &&
    (VALID_KINDS as readonly string[]).includes(value)
  );
}

function normalize(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.toLowerCase();
}

/**
 * Resolve the active launcher kind from the priority chain.
 *
 * Inputs are raw string values (or undefined) provided by the caller — this
 * function performs no I/O. The caller is responsible for reading
 * `process.env.HAPI_CLAUDE_LAUNCHER` and the `launcher` field from settings.json.
 *
 * The `rejected` flag and `rejectedValue` capture the FIRST invalid layer
 * encountered. If env is invalid but settings is valid, the result reflects
 * settings as the source AND flags env as rejected. If both layers are
 * invalid, the result falls through to default with the env value as
 * `rejectedValue` (env is the higher-priority layer, so its rejection is the
 * more actionable signal for the operator).
 */
export function resolveLauncherKind(
  envValue: string | undefined,
  settingsValue: string | undefined
): ResolvedLauncher {
  const env = normalize(envValue);
  const settings = normalize(settingsValue);

  if (env !== undefined) {
    if (isValid(env)) {
      return { kind: env, source: "env", rejected: false };
    }
    if (settings !== undefined && isValid(settings)) {
      return {
        kind: settings,
        source: "settings",
        rejected: true,
        rejectedValue: env,
      };
    }
    return {
      kind: "sdk",
      source: "default",
      rejected: true,
      rejectedValue: env,
    };
  }

  if (settings !== undefined) {
    if (isValid(settings)) {
      return { kind: settings, source: "settings", rejected: false };
    }
    return {
      kind: "sdk",
      source: "default",
      rejected: true,
      rejectedValue: settings,
    };
  }

  return { kind: "sdk", source: "default", rejected: false };
}
