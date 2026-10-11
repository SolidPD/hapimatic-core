// SPDX-License-Identifier: MIT
import { existsSync } from "node:fs";
import { join } from "node:path";

// Project-scoped MCP servers (added via `claude mcp add --scope project`)
// are stored in a `.mcp.json` file at the project root. The global
// `claude mcp list` poll does not surface them, so the daemon must run
// an additional per-project poll for any directory that has one.
//
// Default poll architecture (issue #1069):
//   1. One global poll per cycle (covers all user/global/plugin MCPs)
//   2. One additional poll per project dir that has `.mcp.json`
//
// Pre-fix: one poll per project dir = K spawns of every stdio MCP per cycle.
// Post-fix: 1 + (count of dirs with .mcp.json) spawns per cycle. In practice
// K shrinks from ~5-7 to 0-1 for typical setups.
export function dirsNeedingProjectPoll(
  uniqueProjectDirs: Iterable<string>,
  existsFn: (path: string) => boolean = existsSync
): string[] {
  const result: string[] = [];
  for (const dir of uniqueProjectDirs) {
    try {
      if (existsFn(join(dir, ".mcp.json"))) {
        result.push(dir);
      }
    } catch {
      // Defensive: a throwing existsFn (e.g. a future swap to
      // fs.promises.access, which throws on EACCES) must not blackhole the
      // rest of Phase B. The caller (run.ts) owns failure aggregation; this
      // helper just decides which dirs need polling.
    }
  }
  return result;
}
