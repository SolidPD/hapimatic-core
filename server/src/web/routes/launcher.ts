// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  resolveLauncherKind,
  type ClaudeRemoteLauncherKind,
} from "@hapi/protocol/launcherResolver";

/**
 * GET /api/launcher/status — server-side launcher state.
 *
 * Returns the current launcher kind, its source in the priority chain, and
 * presence of required dependencies. The endpoint does NOT depend on a live
 * Claude session — it reads only the server process env and settings.json.
 * This is intentional so the web UI footer remains visible and accurate even
 * when no Claude session is active (the anxiety scenario from issue #1314).
 *
 * Auth: none (mirrors /api/version).
 */

function resolveSettingsPath(): string {
  if (process.env.HAPI_HOME) {
    const expanded = process.env.HAPI_HOME.replace(/^~/, homedir());
    return join(expanded, "settings.json");
  }
  return join(homedir(), ".hapi", "settings.json");
}

function readSettingsLauncher(): string | undefined {
  const file = resolveSettingsPath();
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return typeof raw?.launcher === "string" ? raw.launcher : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The resolved launcher kind, exactly as `GET /api/launcher/status` reports it
 * (issue #4371: the support escalation bundle reads it in-process rather than
 * shelling out to the CLI).
 */
export function resolveCurrentLauncherKind(): string {
  return resolveLauncherKind(
    process.env.HAPI_CLAUDE_LAUNCHER,
    readSettingsLauncher()
  ).kind;
}

function which(binary: string): boolean {
  const r = spawnSync("which", [binary], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return r.status === 0;
}

function checkDependencies(
  kind: ClaudeRemoteLauncherKind | string
): Record<string, boolean> {
  const deps: Record<string, boolean> = { claude: which("claude") };
  if (kind === "tmux") deps.tmux = which("tmux");
  return deps;
}

export function createLauncherRoutes(): Hono {
  const app = new Hono();

  app.get(
    "/launcher/status",
    cataloged(
      defineCapability({
        id: "harness-admin.launcher-status",
        domain: "harness-admin",
        surface: "rest",
        description: "Return the launcher/service status for this node.",
        whenToUse: "When the launcher UI polls readiness.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/launcher/status",
        },
        auth: "none",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    c => {
      const envValue = process.env.HAPI_CLAUDE_LAUNCHER;
      const settingsValue = readSettingsLauncher();
      const resolved = resolveLauncherKind(envValue, settingsValue);
      return c.json({
        kind: resolved.kind,
        source: resolved.source,
        rejected: resolved.rejected,
        rejectedValue: resolved.rejectedValue ?? null,
        dependencies: checkDependencies(resolved.kind),
      });
    }
  );

  return app;
}
