// SPDX-License-Identifier: MIT
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FileLockTimeoutError, withFileLock } from "@/utils/fileLock";
import { isSafeMachinePath } from "@/modules/common/pathSecurity";

/**
 * Thrown when ~/.claude.json exists but cannot be parsed as JSON. Distinct
 * from generic transport/IO failures so callers can surface a "your Claude
 * config file is corrupt" diagnostic instead of a misleading
 * "transport_failed" error code.
 */
export class ConfigCorruptError extends Error {
  readonly path: string;
  readonly cause: unknown;
  constructor(path: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      `Claude config at ${path} is not valid JSON: ${causeMessage}. ` +
        `Restore from backup or remove the corrupted entries.`
    );
    this.name = "ConfigCorruptError";
    this.path = path;
    this.cause = cause;
  }
}

/**
 * Thrown when the per-config-file lock at `<cfgPath>.lock` could not be
 * acquired within the timeout (5s by default). Distinct from
 * `ConfigCorruptError` and generic transport failures so callers can surface
 * a "another Hapimatic session or Claude Code process is mutating
 * ~/.claude.json — please retry" diagnostic and map to the
 * `config_lock_timeout` error code. (Issue #1100)
 */
export class ConfigLockTimeoutError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string) {
    super(
      `Failed to acquire lock on ${lockPath} within timeout. Another ` +
        `Hapimatic session or Claude Code process may be holding it. Retry.`
    );
    this.name = "ConfigLockTimeoutError";
    this.lockPath = lockPath;
  }
}

/**
 * Thrown when `projectDir` fails {@link isSafeMachinePath} validation —
 * either the path resolves to a blacklisted system location (`/etc`,
 * `/root`, `~/.ssh`, etc.) or contains a sensitive segment. Distinct from
 * other config-toggle errors so callers can surface a security-shaped
 * diagnostic ("the projectDir for this session is not allowed") and map to
 * the `unsafe_path` error code. (Issue #1098)
 *
 * Defense-in-depth alongside `MetadataSchema.path` shape validation in
 * `shared/src/schemas.ts` — the schema rejects malformed shapes (relative,
 * traversal, NUL bytes) at session-creation time; this error catches any
 * path that bypassed the boundary OR fails the content blacklist.
 */
export class UnsafePathError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(
      `Refusing to write Claude config for unsafe projectDir '${path}'. ` +
        `Paths must be absolute and must not resolve to system locations ` +
        `(/etc, /root, ~/.ssh, etc.).`
    );
    this.name = "UnsafePathError";
    this.path = path;
  }
}

/**
 * Atomically update Claude Code's per-project disabledMcpServers list at
 * ~/.claude.json (projects[absolutePath].disabledMcpServers).
 *
 * Used as a fallback by the mcp-toggle RPC handler (issue #1077 follow-up)
 * when no SDK Query is active — i.e., the session is idle between turns.
 * Claude Code re-reads the project config on every spawn, so the toggle
 * takes effect on the next user message. The server-side MCP status poller
 * also picks up the file write on its next polling cycle, so the modal
 * reflects the new state quickly even without a turn happening.
 *
 * **Cross-process safety (issue #1100)**: ~/.claude.json is a singleton
 * shared by ALL Claude Code processes on the machine — every concurrent
 * Hapimatic session, every native terminal session. The whole-file
 * read/parse/mutate/write cycle is wrapped in {@link withFileLock} on
 * `<cfgPath>.lock` to prevent lost-update races between processes. The lock
 * is per-config-file (tests using a custom `configPath` don't contend with
 * production toggles).
 *
 * Returns true if the file was written, false if the desired state already
 * matched (idempotent no-op).
 *
 * Throws:
 * - {@link UnsafePathError} if `projectDir` fails {@link isSafeMachinePath}
 *   (Issue #1098 defense-in-depth — fails fast before lock acquisition).
 * - {@link ConfigCorruptError} if the existing file cannot be parsed.
 * - {@link ConfigLockTimeoutError} if the lock cannot be acquired in 5s.
 * - `Error` with `/not found/` message if the config file does not exist.
 */
export async function applyDisabledServerToggle(
  projectDir: string,
  serverName: string,
  enabled: boolean,
  configPath?: string
): Promise<boolean> {
  // Defense-in-depth path validation (issue #1098). Rejects unsafe
  // projectDir values BEFORE acquiring the file lock so doomed calls
  // don't contend for ~/.claude.json.lock and fail fast with a clear
  // security-shaped error code rather than a transport_failed surprise.
  if (!isSafeMachinePath(projectDir)) {
    throw new UnsafePathError(projectDir);
  }

  const cfgPath = configPath ?? join(homedir(), ".claude.json");
  const lockPath = `${cfgPath}.lock`;

  try {
    return await withFileLock({ lockPath }, async () => {
      let raw: string;
      try {
        raw = await readFile(cfgPath, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Claude config not found at ${cfgPath}`);
        }
        throw err;
      }

      let config: ReturnType<typeof JSON.parse>;
      try {
        config = JSON.parse(raw);
      } catch (err) {
        throw new ConfigCorruptError(cfgPath, err);
      }
      config.projects ??= {};
      const project = (config.projects[projectDir] ??= {});
      const existing: string[] = Array.isArray(project.disabledMcpServers)
        ? project.disabledMcpServers.filter(
            (s: unknown): s is string => typeof s === "string"
          )
        : [];

      let next: string[];
      if (enabled) {
        next = existing.filter(s => s !== serverName);
      } else {
        next = existing.includes(serverName)
          ? existing
          : [...existing, serverName];
      }

      const unchanged =
        next.length === existing.length &&
        next.every((v, i) => v === existing[i]);
      if (unchanged) return false;

      project.disabledMcpServers = next;
      const serialized = JSON.stringify(config, null, 2);
      // Defense-in-depth size sanity check (issue #1347 Task 7):
      // refuse to overwrite if the post-mutation serialization is less
      // than 50% the size of the file we just read. The trigger case in
      // #1347's risk assessment was an external `jq` pipeline that
      // truncated ~/.claude.json to 0 bytes; this guard catches the same
      // shape of failure if a future bug inside this function ever
      // produces a wildly-undersized output. The file lock already prevents
      // concurrent-writer races; this guard is for accidental in-memory
      // corruption only. Threshold = 50% per the issue's spec.
      const originalSize = Buffer.byteLength(raw, "utf-8");
      const newSize = Buffer.byteLength(serialized, "utf-8");
      if (newSize < originalSize / 2) {
        throw new Error(
          `Refusing to overwrite ${cfgPath}: post-mutation size ${newSize} ` +
            `bytes is less than 50% of original ${originalSize} bytes. ` +
            `This indicates an in-memory corruption bug; original config ` +
            `is preserved.`
        );
      }
      // Per-toggle unique tmp filename — without the UUID suffix, two
      // concurrent toggles in the same daemon process collide on the tmp
      // path and lose-update. Cross-process races on cfgPath itself are
      // serialized by the file lock above (issue #1100).
      const tmpPath = `${cfgPath}.tmp.${process.pid}.${randomUUID()}`;
      await writeFile(tmpPath, serialized);
      await rename(tmpPath, cfgPath);
      return true;
    });
  } catch (err) {
    // Re-wrap helper-level lock timeout as a domain-specific error so
    // launcher catch blocks can map it to `config_lock_timeout` without
    // knowing about the file-lock helper internals.
    if (err instanceof FileLockTimeoutError) {
      throw new ConfigLockTimeoutError(lockPath);
    }
    throw err;
  }
}

/**
 * Pre-trust shim — write the three trust-acknowledgment fields to
 * `~/.claude.json` BEFORE spawning the tmux launcher, scoped to the specific
 * `projectDir` cwd. Surgical alternative to global
 * `--dangerously-skip-permissions`: bypasses the first-run trust dialog only
 * for this project, leaving other projects' trust state untouched. Issue
 * #1310 augmentation #3 (toll-free-harness pattern from #1352 §2).
 *
 * Fast path (R10): reads `~/.claude.json` ONCE without acquiring the lock; if
 * the three desired fields already match, returns false immediately. After
 * the first spawn warms the cwd, every subsequent spawn hits the fast path,
 * so the 5-concurrent-warm-cwd p95 ≤ 50ms requirement (R10) becomes a
 * single readFile per call.
 *
 * Slow path (R9): acquires `<cfgPath>.lock` via {@link withFileLock},
 * re-reads to defeat TOCTOU, mutates the three fields, applies the same 50%
 * size-sanity guard as {@link applyDisabledServerToggle}, writes via tmp +
 * atomic rename. Cross-process races are serialized by the lock.
 *
 * Mutates these three fields ONLY:
 * - `cfg.hasCompletedOnboarding = true`
 * - `cfg.lastOnboardingVersion = "99.0.0"`
 * - `cfg.projects[projectDir].hasTrustDialogAccepted = true`
 *
 * All other fields are preserved verbatim, including existing
 * `cfg.projects[projectDir].disabledMcpServers` (so the pre-trust shim is
 * orthogonal to {@link applyDisabledServerToggle}'s mutations).
 *
 * Returns true if the file was written, false if the desired state already
 * matched (fast-path or post-lock no-op).
 *
 * Throws:
 * - {@link UnsafePathError} if `projectDir` fails {@link isSafeMachinePath}
 *   (defense-in-depth — fails fast before the fast-path read).
 * - {@link ConfigCorruptError} if the existing file cannot be parsed.
 * - {@link ConfigLockTimeoutError} if the lock cannot be acquired in 5s
 *   (R17 informational — already implemented via {@link withFileLock}).
 */
export async function applyPreTrustShim(
  projectDir: string,
  configPath?: string
): Promise<boolean> {
  // Defense-in-depth path validation (mirror applyDisabledServerToggle).
  // Rejects unsafe projectDir values BEFORE any IO so doomed calls fail
  // fast with a security-shaped error rather than a transport surprise.
  if (!isSafeMachinePath(projectDir)) {
    throw new UnsafePathError(projectDir);
  }

  const cfgPath = configPath ?? join(homedir(), ".claude.json");
  const lockPath = `${cfgPath}.lock`;

  // Fast path (R10): read-only check. If the three fields already match the
  // desired state, return false without acquiring the lock. This collapses
  // N=5 concurrent warm-cwd latency to ~25ms p95 (per perf-engineer review).
  // We deliberately catch all errors here and fall through to the slow path
  // — fast-path failures (missing file, parse error) deserve the slow-path
  // diagnostic surface (ConfigCorruptError etc.).
  try {
    const raw = await readFile(cfgPath, "utf-8");
    const cfg = JSON.parse(raw);
    if (
      cfg?.hasCompletedOnboarding === true &&
      cfg?.lastOnboardingVersion === "99.0.0" &&
      cfg?.projects?.[projectDir]?.hasTrustDialogAccepted === true
    ) {
      return false;
    }
  } catch {
    // Fall through to slow path — propagate diagnostics from there.
  }

  // Slow path (R9): locked mutation. Mirror applyDisabledServerToggle's
  // full structure: read-inside-lock to defeat TOCTOU, parse, mutate three
  // fields, 50% size-sanity check, writeFile-tmp + rename.
  try {
    return await withFileLock({ lockPath }, async () => {
      let raw: string;
      try {
        raw = await readFile(cfgPath, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Claude config not found at ${cfgPath}`);
        }
        throw err;
      }

      let config: ReturnType<typeof JSON.parse>;
      try {
        config = JSON.parse(raw);
      } catch (err) {
        throw new ConfigCorruptError(cfgPath, err);
      }

      // Re-check after lock acquisition — another process may have written
      // the desired state between our fast-path miss and the lock. This is
      // the same TOCTOU defense pattern as applyDisabledServerToggle.
      const projectsAlreadyTrusted =
        config?.projects?.[projectDir]?.hasTrustDialogAccepted === true;
      if (
        config?.hasCompletedOnboarding === true &&
        config?.lastOnboardingVersion === "99.0.0" &&
        projectsAlreadyTrusted
      ) {
        return false;
      }

      // Mutate exactly three fields. Preserve all sibling fields verbatim
      // — including any existing `disabledMcpServers` array under
      // projects[projectDir] (orthogonal concern, owned by
      // applyDisabledServerToggle).
      config.hasCompletedOnboarding = true;
      config.lastOnboardingVersion = "99.0.0";
      config.projects ??= {};
      const project = (config.projects[projectDir] ??= {});
      project.hasTrustDialogAccepted = true;

      const serialized = JSON.stringify(config, null, 2);
      // 50% size-sanity guard (mirror applyDisabledServerToggle issue
      // #1347 Task 7). Catches in-memory corruption that would otherwise
      // truncate ~/.claude.json. The file lock already prevents
      // concurrent-writer races; this guard is for accidental in-memory
      // corruption only.
      const originalSize = Buffer.byteLength(raw, "utf-8");
      const newSize = Buffer.byteLength(serialized, "utf-8");
      if (newSize < originalSize / 2) {
        throw new Error(
          `Refusing to overwrite ${cfgPath}: post-mutation size ${newSize} ` +
            `bytes is less than 50% of original ${originalSize} bytes. ` +
            `This indicates an in-memory corruption bug; original config ` +
            `is preserved.`
        );
      }

      // Per-shim unique tmp filename (mirror applyDisabledServerToggle) —
      // without the UUID suffix, two concurrent pre-trust shims in the same
      // daemon process collide on the tmp path. Cross-process races on
      // cfgPath itself are serialized by the file lock above.
      const tmpPath = `${cfgPath}.tmp.${process.pid}.${randomUUID()}`;
      await writeFile(tmpPath, serialized);
      await rename(tmpPath, cfgPath);
      return true;
    });
  } catch (err) {
    if (err instanceof FileLockTimeoutError) {
      throw new ConfigLockTimeoutError(lockPath);
    }
    throw err;
  }
}
