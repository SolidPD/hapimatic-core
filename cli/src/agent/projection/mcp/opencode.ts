// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HAL MCP — OpenCode ACP `newSession({ mcpServers })` array emitter (issue
 * #3125, KD1a).
 *
 * OpenCode is spawned with `OPENCODE_CONFIG_CONTENT` inline JSON +
 * `OPENCODE_DISABLE_PROJECT_CONFIG=1` (`sessionSpawner.ts`), so its
 * `opencode.json` file is DEAD config — deliberately ignored under the current
 * spawn path. Like Gemini, OpenCode's VERIFIED MCP carrier is the ACP
 * `session/new` `mcpServers` array. OpenCode and Gemini therefore share ONE
 * carrier builder (`gemini.ts` `buildAcpMcpServers`); this module re-exports it
 * under OpenCode-flavored names so a future OpenCode-specific ACP quirk has a
 * home without touching the Gemini path. Do NOT write `opencode.json`.
 */
import { buildAcpMcpServers, parseAcpMcpServers } from "./gemini";

/** OpenCode-named alias for the shared ACP carrier builder (KD1a). */
export const buildOpencodeMcpServers = buildAcpMcpServers;

/** OpenCode-named alias for the shared ACP carrier parse-back (R5/KD3). */
export const parseOpencodeMcpServers = parseAcpMcpServers;
