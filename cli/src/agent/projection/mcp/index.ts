// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HAL MCP config translation — projection stage + spawn-path handoff (issue
 * #3125, epic #3117 Sub-Issue J).
 *
 * This module is the integration seam for MCP dialect translation:
 *
 *  - `createMcpProjectionStage(input)` is a KD6 `ProjectionStage` (registered by
 *    `projectSkills` — projection/index.ts). It filters the canonical set by the
 *    per-session enable profile (R3) and writes the VERIFIED carrier into
 *    `ctx.configHomeDir`, selecting by the harness's `agentId`:
 *      • gemini / opencode → a 0600 ACP handoff artifact (`acpMcpServers.json`)
 *        the child reads at `session/new` time (KD1a).
 *      • codex → NO-OP here: the `[mcp_servers]` section is threaded into the
 *        SINGLE composed `config.toml` writer (`writeOpenRouterCodexHome`) at its
 *        call site, because that file is written BEFORE stages run — a second
 *        writer would clobber it (KD1 / V6).
 *      • claude → never reached: #3122 R6 skips projection for claude spawns.
 *
 *  - `readProjectedAcpMcpServers()` / `mergeAcpMcpServers()` are the CHILD-side
 *    pickup: `runAgentSession.ts` reads the env-pointed artifact and merges it
 *    with the hapi bridge entry it already injects, DEDUPED by name (never
 *    double-register the hapi server — R4).
 *
 * The stage runs in the DAEMON, which does not hold the live hapi endpoint URL
 * (it is minted in the child via `startHappyServer`). So the stage writes only
 * the NON-hapi enabled servers; the child owns the hapi entry. The stage does
 * NOT mutate `ctx.provenance` — that record's shape is owned by #3130 (the
 * provenance stage); adding an MCP field is a cross-issue seam change (OR3:
 * reconcile, don't adapt ad hoc).
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpServerStdio } from "@/agent/types";
import type { ProjectionContext, ProjectionStage } from "../types";
import { buildAcpMcpServers } from "./gemini";
import { SECRET_FILE_MODE } from "./secretDelivery";
import { filterEnabled, type McpProjectionInput } from "./types";

/** The MCP projection stage id (KD6 ordered-stage seam). */
export const MCP_PROJECTION_STAGE_ID = "mcp";

/** Filename of the ACP MCP handoff artifact under the session config home. */
export const ACP_MCP_HANDOFF_FILENAME = "acpMcpServers.json";

/**
 * Env var the daemon sets to the absolute path of the ACP handoff artifact so
 * the child (`runAgentSession.ts`) can locate it. Absent → no projected servers
 * (byte-identical to pre-#3125 behavior).
 */
export const ACP_MCP_HANDOFF_ENV = "HAPI_MCP_PROJECTION_FILE";

/**
 * Write the ACP MCP handoff artifact (0600) into the session config home and
 * return its absolute path. Carries the projected NON-hapi servers to the child.
 * The 0600 mode + chmod-after-write (umask defense) satisfy R2 for the on-disk
 * artifact that holds per-server `env` values.
 */
export async function writeAcpHandoffArtifact(
  configHomeDir: string,
  servers: McpServerStdio[]
): Promise<string> {
  const target = join(configHomeDir, ACP_MCP_HANDOFF_FILENAME);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(servers, null, 2)}\n`, {
    mode: SECRET_FILE_MODE,
  });
  await chmod(target, SECRET_FILE_MODE).catch(() => {});
  return target;
}

/** Minimal runtime shape guard for a persisted `McpServerStdio`. */
function isMcpServerStdio(value: unknown): value is McpServerStdio {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.command === "string" &&
    Array.isArray(v.args) &&
    Array.isArray(v.env)
  );
}

/**
 * CHILD-side: read the projected ACP MCP servers from the env-pointed handoff
 * artifact. Fail-open — a missing env var, missing file, or malformed content
 * yields `[]` and never throws, so a projection glitch can never break a spawn.
 */
export function readProjectedAcpMcpServers(): McpServerStdio[] {
  const path = process.env[ACP_MCP_HANDOFF_ENV];
  if (!path) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isMcpServerStdio);
  } catch {
    return [];
  }
}

/**
 * Merge projected ACP servers into the base set (the child's built-in entries),
 * deduplicated by `name`. Base entries win — a projected `happy` server is
 * dropped so the hapi bridge is never double-registered (R4).
 */
export function mergeAcpMcpServers(
  base: McpServerStdio[],
  projected: McpServerStdio[]
): McpServerStdio[] {
  const seen = new Set(base.map(server => server.name));
  const merged = [...base];
  for (const server of projected) {
    if (seen.has(server.name)) continue;
    seen.add(server.name);
    merged.push(server);
  }
  return merged;
}

/**
 * Build the MCP projection stage (KD6). The `input` is captured at registration
 * time because the canonical set + enable profile are NOT part of
 * `ProjectionContext` (unlike the skills stage, which reads `ctx.skills`).
 */
export function createMcpProjectionStage(
  input: McpProjectionInput
): ProjectionStage {
  return {
    id: MCP_PROJECTION_STAGE_ID,
    async run(ctx: ProjectionContext): Promise<void> {
      const enabled = filterEnabled(input); // R3
      const agentId = ctx.manifest.agentId;
      if (agentId === "gemini" || agentId === "opencode") {
        // ACP carrier (KD1a): write the NON-hapi enabled servers. The child
        // (runAgentSession) injects + dedups the hapi bridge (R4).
        await writeAcpHandoffArtifact(
          ctx.configHomeDir,
          buildAcpMcpServers(enabled)
        );
      }
      // codex → handled at the writeOpenRouterCodexHome call site (KD1 single
      //   writer). claude → R6 skips projection entirely (never reaches here).
    },
  };
}

export { buildClaudeMcpDocument, parseClaudeMcpDocument } from "./claude";
export {
  buildCodexMcpServers,
  serializeCodexMcpServersToml,
  parseCodexMcpServers,
} from "./codex";
export {
  buildAcpMcpServers,
  parseAcpMcpServers,
  buildGeminiMcpServers,
} from "./gemini";
export { buildOpencodeMcpServers, parseOpencodeMcpServers } from "./opencode";
export {
  assertNoSecretInArgv,
  assertOwnerOnly,
  collectSecretValues,
  secretPlacement,
  SECRET_FILE_MODE,
  SECRET_PLACEMENT,
  type McpCarrier,
  type SecretPlacement,
} from "./secretDelivery";
export {
  filterEnabled,
  hapiMcpServer,
  HAPI_MCP_SERVER_NAME,
  type CanonicalMcpServer,
  type McpProjectionInput,
  type McpTransport,
} from "./types";
