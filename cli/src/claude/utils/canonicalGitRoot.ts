// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Canonical git-root resolution.
 *
 * The pure implementation moved to `@hapi/protocol/gitRoot` (hapimatic-private
 * #2142) so the SERVER on-demand MCP poller can key `disabledMcpServers` by the
 * SAME canonical git root this file's callers (the #1347/#2364 spawn scrub) use
 * — the server package cannot import from `cli/`. This file re-exports the
 * shared functions so existing CLI consumers (and their tests) are unchanged.
 *
 * Mirrors Claude Code's `findGitRoot` / `findCanonicalGitRoot` in `utils/git.ts`
 * (source mirror at `/mnt/netshare/claude-code_anthropic-source-code/utils/git.ts`).
 */
export { findGitRoot, findCanonicalGitRoot } from "@hapi/protocol/gitRoot";
