// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Codex-specific system prompt for local mode.
 *
 * This prompt instructs Codex to call the hapi__change_title function
 * to set appropriate chat session titles.
 */

import { trimIdent } from "@/utils/trimIdent";
import { configuration } from "@/configuration";
import { renderTier0, capabilityCatalogIndex } from "@hapi/protocol";

/**
 * Title instruction for Codex to call the hapi MCP tool.
 * Note: Codex exposes MCP tools under the `functions.` namespace,
 * so the tool is called as `functions.hapi__change_title`.
 */
export const TITLE_INSTRUCTION = trimIdent(`
    Based on this message, call functions.hapi__change_title to change chat session title that would represent the current task. If chat idea would change dramatically - call this function again to update the title.
`);

/**
 * The system prompt to inject via developer_instructions — used by BOTH the
 * local `-c developer_instructions=` path (codexLocal.ts) and the remote
 * JSON-config path (codexStartConfig.ts), which both import this const.
 *
 * Issue #3748 (Sub H, R5): with Tier-0 injection ON (default) the title
 * instruction + the rendered capability catalog; with HAPI_CAPABILITY_TIER0=0
 * the pre-H title instruction alone (R8). The catalog travels through the TOML
 * escaper (codexMcpConfig.ts `escapeTomlString`) on the way to the CLI (R5a).
 */
export const codexSystemPrompt = configuration.capabilityTier0Enabled
  ? TITLE_INSTRUCTION + "\n\n" + renderTier0(capabilityCatalogIndex)
  : TITLE_INSTRUCTION;
