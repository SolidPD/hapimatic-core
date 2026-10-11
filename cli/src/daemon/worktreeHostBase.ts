// SPDX-License-Identifier: MIT
import { basename, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

/**
 * Local slug helper — identical to the private `toSlug` in
 * `cli/src/daemon/worktree.ts` (issue #1558 keeps it local rather than
 * exporting that file's private helper, to avoid churning worktree.ts's API
 * surface). Restricting the slug to `[a-z0-9-]` is the path-traversal
 * sanitization that — combined with the sha-suffixed namespace below — makes a
 * relocated host base a trusted, unique, traversal-free path.
 */
function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolve the worktree *host base* for a repository — the directory that
 * CONTAINS `.worktrees/`. By default this is `repoRoot` itself (byte-identical
 * to the historical `join(repoRoot, ".worktrees")` behavior). It is relocated
 * onto a configured NVMe host root ONLY when BOTH env knobs are set AND the
 * repo lives at or under a configured slow-storage prefix.
 *
 * Issue #1558 ("A1", split from genai-playground#519): worktrees for
 * CIFS-mounted repos (e.g. genai-playground at /mnt/docker) are structurally
 * forced onto CIFS, where `git worktree add` pays ~17.5s of per-file SMB
 * latency. Git natively supports absolute worktree paths outside the main repo
 * dir, so the NAS checkout stays put while its worktrees live on local NVMe.
 *
 * Configuration (BOTH required; either unset → relocation disabled, so the
 * function returns `repoRoot` verbatim):
 *   - HAPI_WORKTREE_HOST_ROOT          NVMe base dir under which relocated
 *                                      worktrees live (e.g.
 *                                      ~/.hapimatic-worktrees). A leading `~`
 *                                      expands via homedir() — matches the
 *                                      precedent at configuration.ts:57.
 *   - HAPI_WORKTREE_RELOCATE_PREFIXES  comma-separated absolute path prefixes;
 *                                      a repo relocates only if
 *                                      resolve(repoRoot) equals or is under one
 *                                      of them (e.g. /mnt/docker,/mnt/netshare).
 *
 * Determinism (R5): the result is a pure function of `repoRoot` + the durable
 * env. The daemon recomputes the SAME host base at create-time AND cleanup-time
 * with no persisted `.worktree-meta.json` field. The env is process-stable
 * (carried by the daemon's systemd `Environment=` directives), mirroring the
 * existing inline env-getter precedent `getGitTimeoutMs()`.
 *
 * Uniqueness (R6): a relocated repo's namespace is `<slug>-<sha12>` where
 * `slug = toSlug(basename(resolve(repoRoot)))` and `sha12` is the first 12 hex
 * chars of sha256(resolve(repoRoot)). Two distinct slow-storage repos cannot
 * collide under the shared host root.
 *
 * Security (R3): the returned base is derived solely from trusted inputs (env +
 * the git-resolved repoRoot) and the namespace is `[a-z0-9-]`-sanitized +
 * sha-suffixed, so it contains no traversal segments. `isWithinWorktreeBase`
 * callers pass this value as the base and still reject `..` segments and any
 * worktree path not contained under `<hostBase>/.worktrees/`.
 *
 * Operational invariant: do NOT change either env knob while relocated
 * worktrees are live — a change re-points the deterministic resolver and would
 * strand existing worktrees (cleanup would compute a different base). Treat the
 * config as stable per host (symmetric with how HAPI_GIT_TIMEOUT_MS is trusted
 * to be stable).
 *
 * @param repoRoot the repository root (the value historically joined with
 *   ".worktrees"). Returned verbatim when relocation is not engaged.
 * @returns the host base directory that contains `.worktrees/`.
 */
export function resolveWorktreeHostBase(repoRoot: string): string {
  const hostRoot = process.env.HAPI_WORKTREE_HOST_ROOT?.trim();
  if (!hostRoot) {
    return repoRoot;
  }

  const prefixes = (process.env.HAPI_WORKTREE_RELOCATE_PREFIXES ?? "")
    .split(",")
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .map(p => resolve(p));
  if (prefixes.length === 0) {
    return repoRoot;
  }

  const resolvedRoot = resolve(repoRoot);
  const matches = prefixes.some(
    p =>
      resolvedRoot === p ||
      resolvedRoot.startsWith(p.endsWith(sep) ? p : p + sep)
  );
  if (!matches) {
    return repoRoot;
  }

  const expandedHostRoot = resolve(hostRoot.replace(/^~(?=$|\/)/, homedir()));
  const slug = toSlug(basename(resolvedRoot));
  const hash = createHash("sha256")
    .update(resolvedRoot)
    .digest("hex")
    .slice(0, 12);
  const ns = `${slug || "repo"}-${hash}`;
  return join(expandedHostRoot, ns);
}
