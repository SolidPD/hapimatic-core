// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The host user-scope config dimensions symlinked into each isolated per-account
 * config dir by the #1562 bridge (`provisionUserScopeConfigDir`,
 * `cli/src/accounts/accountConfigDir.ts`).
 *
 * Lifted here (#3246) so the CLI bridge AND the server-side post-import
 * visibility probe (`server/src/porter/visibilityProbe.ts`) import ONE list — a
 * divergence between the two would silently misclassify a dimension. Pure data,
 * no `node:` imports, so it lives in the `@hapi/protocol` root (NOT
 * `shared/src/porter`, whose R7 guard bans `node:` specifiers — this constant
 * carries none either way).
 *
 * Per-dimension mapping the bridge symlinks (`<CONFIG>/<dim>` → `<hostClaudeDir>/<dim>`):
 *  - `skills`/`commands` → `getSkillsPath('userSettings', dir)` = `join(root, dir)`
 *  - `agents` → `join(root, 'agents')`
 *  - `plugins` → `getPluginsDirectory()` = `join(root, 'plugins')`
 *  - `rules` → `getUserClaudeRulesDir()` = `join(root, 'rules')`
 *  - `CLAUDE.md` → `getMemoryPath('User')` = `join(root, 'CLAUDE.md')` (its `@`-imports
 *    resolve relative to the symlink's realpath, so the sibling `.md` includes are
 *    carried without individually symlinking them)
 *  - `settings.json` → `getSettingsFilePathForSource('userSettings')` = `join(root, 'settings.json')`
 *  - `projects` → `join(root, 'projects')` — shared host tree so native `--resume`
 *    AND Hapimatic's host-path transcript scanner both converge on `~/.claude/projects`
 *  - `output-styles` → `join(root, 'output-styles')` (defensive; symlinked only if present)
 */
export const USER_SCOPE_CONFIG_DIMS = [
  "skills",
  "commands",
  "agents",
  "plugins",
  "rules",
  "projects",
  "output-styles",
  "CLAUDE.md",
  "settings.json",
] as const;

/** One host user-scope config dimension (an element of {@link USER_SCOPE_CONFIG_DIMS}). */
export type UserScopeConfigDim = (typeof USER_SCOPE_CONFIG_DIMS)[number];

/**
 * The FILE dims the bridge may repair in place (#4681): when the isolated dir holds a
 * regular file at one of these names whose bytes equal the host source, the file is a
 * stray copy of the host file (an in-place editor such as `sed -i` renamed a temp file
 * over the managed symlink), so replacing it with the symlink loses nothing. Directory
 * dims are never repaired. Shared so the CLI bridge and the server-side visibility probe
 * classify the same state the same way.
 */
export const REPAIRABLE_FILE_DIMS: readonly UserScopeConfigDim[] = [
  "CLAUDE.md",
  "settings.json",
];
