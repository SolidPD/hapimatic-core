// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ID Generation Utilities
 */

// Issue #1565: generateSessionId moved to @hapi/protocol so the daemon and the
// server early-return spawn route share ONE definition. Re-exported here for
// backward-compat so existing `@/utils/id` importers are unaffected.
export { generateSessionId } from "@hapi/protocol";
import { randomBase36 } from "@hapi/protocol";

/**
 * Generate a short unique ID
 * Format: <random 8 chars of [0-9a-z]>
 *
 * Names the per-spawn temp files under `os.tmpdir()` (including the 0600 env
 * file that carries tokens), so it draws from the CSPRNG like
 * `generateSessionId` rather than `Math.random()`.
 */
export function generateShortId(): string {
  return randomBase36(8);
}

/** Branch-namespace prefix for Hapimatic-minted worktree branches (epic rp1-home#914). */
export const WORKTREE_BRANCH_PREFIX = "ms-";

/**
 * Derive the worktree BRANCH name from a worktree base name (HP1, #1560).
 *
 * Prefixes ONLY session-id-derived names (`hapi-*`) → `ms-hapi-*`. The session
 * ID, tmux window name, and worktree directory basename are unaffected — only
 * the branch changes (Option B: branch-only).
 *
 * Idempotent (an already-`ms-` name passes through) and a deliberate no-op for
 * `issue-*` / default (`MMDD-*`) / test-fixture names, so the `^issue-(\d+)`
 * extraction in worktree.ts + scripts/hapi-worktree.sh and existing fixtures
 * are preserved.
 */
export function deriveWorktreeBranchName(baseName: string): string {
  // Idempotent (R4): an already-prefixed name passes through unchanged.
  if (baseName.startsWith(WORKTREE_BRANCH_PREFIX)) return baseName;
  // R1: only session-id-derived (`hapi-*`) names receive the prefix.
  if (baseName.startsWith("hapi-")) {
    return `${WORKTREE_BRANCH_PREFIX}${baseName}`;
  }
  // R3: issue-*, default MMDD-*, and test-fixture names pass through unchanged.
  return baseName;
}
