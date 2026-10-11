// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A background agent id is ONE file-name component (`agent-<id>.jsonl`,
 * `agent-<id>.meta.json`): no separators, no dots, bounded length. Shared by
 * the finalize seed path, the agent-transcript peek route and the
 * background-agent usage recorder (reached from session-alive and session
 * end), so the CLI-supplied id is checked the same
 * way everywhere before it reaches `path.join` (#4657). Real ids are 17 hex
 * chars; 64 leaves ample headroom.
 */
export const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidAgentId(id: unknown): id is string {
  return typeof id === "string" && AGENT_ID_RE.test(id);
}
