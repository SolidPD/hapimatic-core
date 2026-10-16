// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Destination resolution for the Configuration Porter import core.
 *
 * Split out of `importArchive.ts` (#2806) to keep that module under the 1,500-line
 * `max-lines` guardrail (#2077) as the porter import surface accretes fixes — the
 * same decomposition that moved the error classes to `importArchiveErrors.ts`
 * (#2563) and the read-side projection to `importPlanSummary.ts` (#2565). Keeping
 * ALL destination-resolution logic here also lets the serialized importArchive.ts
 * chain (#2806 → #3246 → #3247) re-anchor cleanly against a small, stable surface.
 *
 * `importArchive.ts` re-exports every symbol below, so the public API is unchanged
 * — consumers (e.g. `web/routes/porterInstalled.ts`, the test suite) may import
 * them from either module.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { isSafeMachinePath } from "../utils/pathSecurity";
import {
  IsolatedDestConflictError,
  IsolatedDestReapedError,
  IsolatedDestUnsafeError,
  SameFilesystemError,
} from "./importArchiveErrors";

/** Config-root resolver: explicit dir → `CLAUDE_CONFIG_DIR` → `~/.claude`. */
export function resolveClaudeDir(claudeDir?: string): string {
  return (
    claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
  );
}

/**
 * Resolve the host `.claude.json` (MCP servers) destination (#2620 / F6).
 *
 * Precedence mirrors {@link resolveClaudeDir}'s DI-seam shape:
 *   1. An explicit `opts.hostConfigPath` always wins (DI seam / test injection).
 *   2. When the config root is REDIRECTED — an explicit `claudeDir` OR
 *      `CLAUDE_CONFIG_DIR` — the host config lives INSIDE the resolved root:
 *      `join(resolveClaudeDir(claudeDir), ".claude.json")`. A native `claude`
 *      spawned with `CLAUDE_CONFIG_DIR=<dir>` reads AND rotates `.claude.json`
 *      INSIDE that dir (see `cli/src/accounts/accountConfigDir.ts`
 *      `isolatedConfigPath` / native `getClaudeConfigHomeDir`; #1551). A
 *      `dirname()`/"beside" derivation would both write a file the redirected
 *      `claude` never reads AND, for `CLAUDE_CONFIG_DIR=$HOME/<child>`, collapse
 *      to the REAL `~/.claude.json` — the exact isolation failure R2 fixes.
 *   3. Nothing redirected → byte-identical legacy default `~/.claude.json`
 *      (beside `~/.claude`, NOT inside it), so unchanged behavior for every
 *      same-machine instance that does not redirect the config root.
 */
export function resolveHostConfigPath(
  hostConfigPath?: string,
  claudeDir?: string
): string {
  if (hostConfigPath !== undefined) return hostConfigPath;
  if (claudeDir !== undefined || process.env.CLAUDE_CONFIG_DIR !== undefined) {
    return join(resolveClaudeDir(claudeDir), ".claude.json");
  }
  return join(homedir(), ".claude.json");
}

/** Read the filesystem device id of a path. Default backing of the `getDev` seam. */
function statDev(path: string): number {
  return statSync(path).dev;
}

/**
 * Assert the data dir and destination root live on the same filesystem (D1). If
 * `destRoot` does not exist yet, check the nearest existing ancestor. Throwing
 * here at plan time means an atomicity-breaking misconfiguration fails loudly.
 *
 * `getDev` is a test/DI seam (#2806) defaulting to `statSync(p).dev`, so prod is
 * byte-identical. Tests inject a fake to exercise the cross-filesystem throw
 * deterministically (a real cross-fs, non-denylisted path is environment-coupled,
 * and common cross-fs paths like `/tmp` are rejected by RC-4 before they reach here).
 */
export function assertSameFilesystem(
  dataDir: string,
  destRoot: string,
  getDev: (path: string) => number = statDev
): void {
  let probe = destRoot;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  try {
    if (getDev(dataDir) !== getDev(probe)) {
      throw new SameFilesystemError(dataDir, destRoot);
    }
  } catch (err) {
    if (err instanceof SameFilesystemError) throw err;
    // stat failure (e.g. dataDir missing) is not a same-fs violation — let the
    // downstream mkdir surface a clearer error.
  }
}

/** Subtrees under `dataDir` that `sweepExpiredPorterDirs` reaps (30-min TTL + 5-min grace, #5170) (RC-6). */
const REAPED_SUBTREES = ["porter-staging", "porter-backup"] as const;

/** The slice of `PlanImportOptions` that governs destination resolution. */
export interface ImportDestinationOptions {
  dataDir: string;
  /**
   * Same-machine isolation (#2806, R4): redirect BOTH `claudeDir` and
   * `hostConfigPath` at a throwaway dir on the SAME filesystem as `dataDir`. Not
   * `/tmp`/tmpfs (denylist, RC-4); not under `dataDir/porter-staging|porter-backup`
   * (reaped, RC-6); mutually exclusive with `claudeDir`/`hostConfigPath` (A7).
   */
  isolatedDest?: string;
  /** Destination config root. Defaults to `CLAUDE_CONFIG_DIR || ~/.claude`. */
  claudeDir?: string;
  /** Host `~/.claude.json` for MCP servers. Defaults to `~/.claude.json`. */
  hostConfigPath?: string;
}

/**
 * Resolve the effective `{ claudeDir, hostConfigPath }` for an import plan.
 *
 * When `opts.isolatedDest` is unset this is byte-identical to the legacy inline
 * resolution ({@link resolveClaudeDir} + {@link resolveHostConfigPath}). When set,
 * it funnels the isolated destination through the SAME seam (no divergent resolver,
 * per the AC), after three plan-time guards:
 *   - **A7** — mutually exclusive with an explicit `claudeDir`/`hostConfigPath`.
 *   - **RC-4** — the FIRST blocker, independent of filesystem: reject a denylisted
 *     path (`/tmp`, `~/.config`, `.ssh`, …) via {@link isSafeMachinePath}.
 *   - **RC-6** — reject a path inside `dataDir/porter-staging|porter-backup`
 *     (TTL-reaped); BOTH sides are `resolve()`d before the prefix+`sep` compare so
 *     an unnormalized `dataDir` cannot defeat the guard.
 *
 * The config root becomes `<isolatedDest>/.claude` and the host config lives INSIDE
 * it (`<isolatedDest>/.claude/.claude.json`, via {@link resolveHostConfigPath}'s
 * redirect precedence), so a same-machine plan/commit never touches the host
 * `~/.claude` / `~/.claude.json`.
 *
 * RC-5 (same-filesystem) is NOT enforced here — the caller's
 * `assertSameFilesystem(opts.dataDir, claudeDir)` covers it, because `isolatedDest`
 * flows into `claudeDir`. `hostConfigPath` is never passed to `assertSameFilesystem`
 * (fine — both point into the one `isolatedDest`).
 */
export function resolveImportDestination(opts: ImportDestinationOptions): {
  claudeDir: string;
  hostConfigPath: string;
} {
  if (opts.isolatedDest === undefined) {
    return {
      claudeDir: resolveClaudeDir(opts.claudeDir),
      hostConfigPath: resolveHostConfigPath(
        opts.hostConfigPath,
        opts.claudeDir
      ),
    };
  }

  // A7 — mutually exclusive with explicit claudeDir / hostConfigPath.
  if (opts.claudeDir !== undefined || opts.hostConfigPath !== undefined) {
    throw new IsolatedDestConflictError();
  }

  // RC-4 — denylist is the FIRST blocker, independent of filesystem.
  if (!isSafeMachinePath(opts.isolatedDest)) {
    throw new IsolatedDestUnsafeError(opts.isolatedDest);
  }

  // RC-6 — forbid the reaped porter subtrees; resolve BOTH sides first.
  const isoAbs = resolve(opts.isolatedDest);
  const dataAbs = resolve(opts.dataDir);
  for (const sub of REAPED_SUBTREES) {
    const reapedRoot = join(dataAbs, sub);
    if (isoAbs === reapedRoot || isoAbs.startsWith(reapedRoot + sep)) {
      throw new IsolatedDestReapedError(opts.isolatedDest, reapedRoot);
    }
  }

  // Redirect BOTH roots into the isolated dir; host config lives INSIDE it.
  const isoRoot = join(opts.isolatedDest, ".claude");
  return {
    claudeDir: isoRoot,
    hostConfigPath: resolveHostConfigPath(undefined, isoRoot),
  };
}
