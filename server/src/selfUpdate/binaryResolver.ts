// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InstallFlavor } from "@hapi/protocol";

/**
 * Harness-binary resolution + install-flavor detection for the self-update
 * executor (issue #1774, Sub E of epic #1769, Task 1).
 *
 * The SERVER process runs the descriptor's `install_flavors[flavor].update.cmd`
 * via argv-form `execFile` (see `updateOrchestrator.ts`). Under the minimal
 * systemd PATH, a bare `claude` is NOT resolvable — so the binary is resolved
 * multi-tier here and the child's PATH is augmented with `~/.local/bin` via
 * `buildExecEnv()` so a native `claude install` finds its own helpers (OR-1,
 * the #1 runtime failure risk).
 *
 * ── Intentional overlap (flagged per the directive) ──
 * The multi-tier resolution mirrors the UNEXPORTED `findClaudePath()` in
 * `server/src/utils/mcpPoller.ts` and overlaps `server/src/metrics/aboutInfo.ts`
 * (#1984 harness enumeration). Consolidating the fleet onto ONE harness-binary
 * surface is a follow-up (see the #1774 worker handoff) — kept a NEW, additive
 * module here rather than refactoring the shared `findClaudePath` in place, so
 * this landing is collision-free with concurrent work on those files.
 */

/**
 * Resolve a harness binary (e.g. `"claude"`) to an absolute path, or `null`
 * when it cannot be found. Multi-tier, mirroring `mcpPoller.findClaudePath`:
 *   1. `HAPI_CLAUDE_PATH` env (absolute + on disk) — for `claude` only.
 *   2. `Bun.which(name)` — the Bun-native PATH lookup.
 *   3. Well-known install locations (systemd daemons have a minimal PATH):
 *      `~/.local/bin/<name>`, `~/.npm-global/bin/<name>`, `/usr/local/bin/<name>`.
 */
export function resolveHarnessBinary(name: string): string | null {
  // Tier 1: explicit env override (claude only — matches HAPI_CLAUDE_PATH).
  if (name === "claude" && process.env.HAPI_CLAUDE_PATH) {
    const envPath = process.env.HAPI_CLAUDE_PATH;
    if (envPath.startsWith("/") && existsSync(envPath)) {
      return envPath;
    }
  }

  // Tier 2: Bun-native PATH resolution.
  const fromPath = Bun.which(name);
  if (fromPath) return fromPath;

  // Tier 3: well-known locations (minimal systemd PATH fallback).
  const home = homedir();
  const wellKnownPaths = [
    join(home, ".local", "bin", name),
    join(home, ".npm-global", "bin", name),
    join("/usr", "local", "bin", name),
  ];
  for (const p of wellKnownPaths) {
    if (existsSync(p)) return p;
  }

  return null;
}

/**
 * Classify an ALREADY-real (symlink-followed) path as a native vs npm install.
 * Pure — no filesystem access, so it is directly unit-testable.
 *
 *   - native: the vendor installer layout — the real binary lives under a
 *     `.../share/claude/versions/<v>/...` tree (`~/.local/bin/claude` symlinks
 *     into `~/.local/share/claude/versions/<v>`).
 *   - npm: an npm global / node_modules layout.
 *   - ambiguous: default `native`. The verified fleet is native (research
 *     2026-06-20), and an npm-template run on a native host is a SILENT no-op
 *     while a native-template run is the correct action — so native is the safer
 *     default. The residual misclassification risk (OR-2) is caught end-to-end
 *     by V6 (`readlink ~/.local/bin/claude` must move after an update).
 */
export function classifyInstallFlavor(realPath: string): InstallFlavor {
  const norm = realPath.replace(/\\/g, "/");
  if (/\/(?:\.local\/)?share\/claude\/versions\//.test(norm)) {
    return "native";
  }
  if (/\/node_modules\//.test(norm) || /\/\.npm-global\//.test(norm)) {
    return "npm";
  }
  return "native";
}

/**
 * Detect the install flavor of a resolved harness binary. Follows the symlink
 * to the real target (a native `~/.local/bin/claude` symlinks into
 * `~/.local/share/claude/versions/<v>`), then classifies the REAL path. The
 * `realpath` fn is injectable so tests exercise classification without a real
 * filesystem symlink; it defaults to `realpathSync`.
 */
export function detectInstallFlavor(
  resolvedPath: string,
  realpath: (p: string) => string = realpathSync
): InstallFlavor {
  let real = resolvedPath;
  try {
    real = realpath(resolvedPath);
  } catch {
    // Symlink resolution failed (e.g. a dangling link, or a plain file that is
    // not a symlink and realpath still returns it) — classify the raw path.
  }
  return classifyInstallFlavor(real);
}

/**
 * Build the child-process env for the update `execFile`. Augments `PATH` with
 * `~/.local/bin` (prepended if absent) so a native `claude install` resolves its
 * own helpers under the server's minimal systemd PATH (OR-1). Everything else is
 * inherited verbatim.
 */
export function buildExecEnv(): NodeJS.ProcessEnv {
  const localBin = join(homedir(), ".local", "bin");
  const currentPath = process.env.PATH ?? "";
  const segments = currentPath.split(":").filter(Boolean);
  const augmentedPath = segments.includes(localBin)
    ? currentPath
    : [localBin, ...segments].join(":");
  return { ...process.env, PATH: augmentedPath };
}
