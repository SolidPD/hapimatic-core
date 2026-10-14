// SPDX-License-Identifier: MIT AND AGPL-3.0-only
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getProjectPath(
  workingDirectory: string,
  configDirOverride?: string
) {
  const projectId = resolve(workingDirectory).replace(/[^a-zA-Z0-9]/g, "-");
  // Issue #1573: the session scanner runs in the launcher process, which (under
  // account isolation) has CLAUDE_CONFIG_DIR UNSET even though the claude child is
  // spawned with CLAUDE_CONFIG_DIR=<account-configs>/<uuid>. Without an override the
  // scanner would watch host ~/.claude/projects while claude writes the isolated
  // projects dir — they coincide only via a symlink, and break (no output relay)
  // when that symlink is a real dir (#1574). Passing the session's resolved
  // account config dir here makes the scanner watch exactly where claude writes.
  const claudeConfigDir =
    configDirOverride ||
    process.env.CLAUDE_CONFIG_DIR ||
    join(homedir(), ".claude");
  return join(claudeConfigDir, "projects", projectId);
}
