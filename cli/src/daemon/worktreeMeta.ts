// SPDX-License-Identifier: MIT
import { execFile } from "node:child_process";
import {
  lstat,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  WORKTREE_PORT_MAX,
  WORKTREE_PORT_MIN,
  WorktreeMetaSchema,
  type WorktreeMeta,
} from "@hapi/protocol";

import { withFileLock, type FileLockOptions } from "@/utils/fileLock";

import { resolveWorktreeHostBase } from "./worktreeHostBase";

const execFileAsync = promisify(execFile);

// Re-export for backward compatibility — older callers still import from this module.
export {
  WORKTREE_PORT_MAX,
  WORKTREE_PORT_MIN,
  WorktreeMetaSchema,
  type WorktreeMeta,
};

export type WriteWorktreeMetaOptions = {
  worktreePath: string;
  repoRoot: string;
  branch: string;
  sourceBranch: string;
  sessionId: string;
  // Nullable to support the two-phase write (createWorktree writes meta with
  // null port; caller patches port after claim). Schema already permits null.
  port: number | null;
  issueNumber: number | null;
  /** hapimatic-private#4481: set only for an existing-branch worktree. */
  branchOrigin?: "existing-local" | "existing-remote";
};

type WriteResult =
  | { ok: true; port: number | null }
  | { ok: false; error: string };

export async function getListeningPorts(): Promise<Set<number>> {
  const ports = new Set<number>();
  try {
    const { stdout } = await execFileAsync("ss", [
      "-tln",
      `sport ge :${WORKTREE_PORT_MIN}`,
      `sport le :${WORKTREE_PORT_MAX}`,
    ]);
    const lines = stdout.split("\n").slice(1);
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      const localAddr = fields[3];
      if (!localAddr) continue;
      const portMatch = localAddr.match(/:(\d+)$/);
      if (portMatch) {
        const port = Number(portMatch[1]);
        if (port >= WORKTREE_PORT_MIN && port <= WORKTREE_PORT_MAX) {
          ports.add(port);
        }
      }
    }
  } catch {
    // ss not available or failed — fall through with empty set
  }
  return ports;
}

async function getClaimedPorts(
  repoRoot: string,
  excludeWorktreePath?: string
): Promise<Set<number>> {
  const ports = new Set<number>();
  // Issue #1558: scan the resolved host base so port discovery sees a
  // relocated (NVMe) repo's worktrees. Default-off → repoRoot.
  const worktreesDir = join(resolveWorktreeHostBase(repoRoot), ".worktrees");

  let entries: string[];
  try {
    entries = await readdir(worktreesDir);
  } catch {
    return ports;
  }

  for (const entry of entries) {
    if (entry === ".trash") continue;
    const wtPath = join(worktreesDir, entry);
    if (excludeWorktreePath && wtPath === excludeWorktreePath) continue;

    const metaPath = join(wtPath, ".worktree-meta.json");
    try {
      const raw = await readFile(metaPath, "utf-8");
      // Defensive parse: malformed meta files are skipped, not crashed on.
      // Use partial schema so meta files written before schema_version was
      // added (or with missing optional fields) don't reject.
      const parsed = WorktreeMetaSchema.partial().safeParse(JSON.parse(raw));
      if (parsed.success && typeof parsed.data.claimed_port === "number") {
        ports.add(parsed.data.claimed_port);
      }
    } catch {
      // No meta, unreadable, or invalid JSON — skip
    }
  }

  return ports;
}

/**
 * Read the claimed_port from a single worktree's .worktree-meta.json file.
 * Returns null if the meta file is absent, unreadable, malformed, or has a
 * null/missing claimed_port. Issue #1337.
 */
export async function readClaimedPort(
  worktreePath: string
): Promise<number | null> {
  const metaPath = join(worktreePath, ".worktree-meta.json");
  try {
    const raw = await readFile(metaPath, "utf-8");
    const parsed = WorktreeMetaSchema.partial().safeParse(JSON.parse(raw));
    if (parsed.success && typeof parsed.data.claimed_port === "number") {
      return parsed.data.claimed_port;
    }
    return null;
  } catch {
    return null;
  }
}

export async function claimWorktreePort(
  repoRoot: string,
  excludeWorktreePath?: string
): Promise<number | null> {
  const [listening, claimed] = await Promise.all([
    getListeningPorts(),
    getClaimedPorts(repoRoot, excludeWorktreePath),
  ]);

  for (let p = WORKTREE_PORT_MIN; p <= WORKTREE_PORT_MAX; p += 1) {
    if (!listening.has(p) && !claimed.has(p)) {
      return p;
    }
  }

  return null;
}

// Issue #1730: the worktree port claim and its meta-write are two phases —
// claimWorktreePort() returns a free port, and the caller (run.ts) persists it
// later via createWorktree -> writeWorktreeMeta. Without a lock spanning the
// whole claim->write cycle, two concurrent claimPort:true spawns both read the
// pre-write claimed set, both pick the lowest free port, and both write it
// (cross-spawn TOCTOU). This is the TypeScript sibling of the bash flock added
// in #1619 R5 (scripts/hapi-worktree.sh).
//
// Lock scope is machine-GLOBAL (a single fixed path): the protected resource —
// the WORKTREE_PORT_MIN..MAX range — is machine-wide (getListeningPorts() scans
// the whole host), mirroring the bash flock's global scope. NOTE: this is a
// SEPARATE lock file from the bash flock; Node's `wx`/O_EXCL and kernel flock(2)
// do NOT mutually exclude on a shared path, so this closes the TS<->TS race only
// (the issue's Acceptance Criteria). The TS<->bash same-machine race is a
// documented residual, mitigated by #1683 (default claimPort:false routes the
// dominant claim through the already-serialized bash deploy path).
const PORT_CLAIM_LOCK_PATH = "/tmp/hapimatic-wt-claim-ts.lock";

// staleTimeoutMs MUST exceed the `git worktree add` budget inside the critical
// section (HAPI_GIT_TIMEOUT_MS, default 30_000 — see worktree.ts) or a
// concurrent waiter would reap the live lock mid-create and reopen the TOCTOU.
// 60_000 leaves a 2x margin. Exported so the test suite can assert the
// ">= git budget" invariant without a multi-second behavioral test.
export const PORT_CLAIM_STALE_TIMEOUT_MS = 60_000;

/**
 * Serialize a worktree port claim together with its later meta-write across
 * processes, closing the cross-spawn TOCTOU (#1730). Wrap the WHOLE
 * claim -> createWorktree(meta-write) sequence in this helper so a
 * picked-but-unwritten port is never visible to a concurrent caller.
 *
 * A thin wrapper over `withFileLock` — it gives run.ts (which is not
 * unit-testable) a testable seam. `opts` overrides the production defaults
 * (lock path, attempts, intervals, stale window) for TESTS ONLY; production
 * callers pass `fn` alone. Default acquire window = maxAttempts*retryIntervalMs
 * = 350*100 = 35s, slightly above the 30s git budget so a legitimate waiter does
 * not time out while the holder finishes a worst-case `git worktree add`. Models
 * the precedent at worktree.ts (`tearDownWorktreeInstance`, a per-port
 * withFileLock around a slow critical section).
 */
export async function withPortClaimLock<T>(
  fn: () => Promise<T>,
  opts?: Partial<FileLockOptions>
): Promise<T> {
  return withFileLock(
    {
      lockPath: PORT_CLAIM_LOCK_PATH,
      staleTimeoutMs: PORT_CLAIM_STALE_TIMEOUT_MS,
      maxAttempts: 350,
      retryIntervalMs: 100,
      ...opts,
    },
    fn
  );
}

export type DiscoveredWorktreeInstance = {
  /** Absolute path to the worktree's working directory (e.g. `.worktrees/foo`). */
  worktreePath: string;
  /** Validated to fall within `[WORKTREE_PORT_MIN, WORKTREE_PORT_MAX]`. */
  port: number;
  /** ISO 8601 string from the meta's `created_at` field. May be empty if absent. */
  createdAt: string;
  /** From the meta's `feature_branch` field. May be empty if absent. */
  branch: string;
  /** From the meta's `session_id` field. May be empty if absent. */
  sessionId: string;
};

/**
 * Discover all worktree instances by scanning `.worktrees/` for valid meta
 * files. Used by the `daemon cleanup-worktrees` CLI subcommand (#1385 Task 4)
 * for cron-based discovery of failed / expired worktree instances.
 *
 * Defenses (subsumes sibling defenses at the TS discovery layer):
 *   - Skips `.trash/` subdirectory (soft-deleted worktrees — never auto-cleaned)
 *   - Skips entries whose directory is a symlink (`lstat`-based — subsumes the
 *     bash symlink-redirection guard tracked at #1383)
 *   - Skips entries with missing, unreadable, or malformed meta
 *   - Skips entries whose `claimed_port` is non-numeric OR outside
 *     `[WORKTREE_PORT_MIN, WORKTREE_PORT_MAX]` (subsumes the bash port-range
 *     validation tracked at #1384)
 *
 * Returns an array of valid instances ordered by directory entry order. Empty
 * array on any error (missing `.worktrees/`, readdir failure).
 */
export async function discoverWorktreeInstances(
  repoRoot: string
): Promise<DiscoveredWorktreeInstance[]> {
  const results: DiscoveredWorktreeInstance[] = [];
  // Issue #1558: scan the resolved host base so port discovery sees a
  // relocated (NVMe) repo's worktrees. Default-off → repoRoot.
  const worktreesDir = join(resolveWorktreeHostBase(repoRoot), ".worktrees");

  let entries: string[];
  try {
    entries = await readdir(worktreesDir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry === ".trash") continue;
    const wtPath = join(worktreesDir, entry);

    // Symlink defense (#1383): lstat returns the symlink itself, NOT its
    // target. Skip the entry if the directory IS a symlink — a malicious or
    // mistaken symlink could otherwise redirect cleanup to an unrelated path.
    try {
      const stats = await lstat(wtPath);
      if (stats.isSymbolicLink()) continue;
    } catch {
      // lstat failed — skip defensively
      continue;
    }

    const metaPath = join(wtPath, ".worktree-meta.json");
    try {
      const raw = await readFile(metaPath, "utf-8");
      const parsed = WorktreeMetaSchema.partial().safeParse(JSON.parse(raw));
      if (!parsed.success) continue;

      const port = parsed.data.claimed_port;
      // Port-range defense (#1384): explicit numeric + range check.
      // The schema already constrains the field type, but defense-in-depth
      // catches any future schema loosening AND null claimed_port (allowed
      // by the schema for the two-phase write at createWorktree time).
      if (typeof port !== "number") continue;
      if (port < WORKTREE_PORT_MIN || port > WORKTREE_PORT_MAX) continue;

      results.push({
        worktreePath: wtPath,
        port,
        createdAt: parsed.data.created_at ?? "",
        branch: parsed.data.feature_branch ?? "",
        sessionId: parsed.data.session_id ?? "",
      });
    } catch {
      // No meta, unreadable, or invalid JSON — skip
    }
  }

  return results;
}

export async function detectSourceBranch(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      repoRoot,
      "symbolic-ref",
      "--short",
      "HEAD",
    ]);
    return stdout.trim() || "ms-dev";
  } catch {
    return "ms-dev";
  }
}

export async function writeWorktreeMeta(
  options: WriteWorktreeMetaOptions
): Promise<WriteResult> {
  const metaPath = join(options.worktreePath, ".worktree-meta.json");

  // Read-before-write (#3209): recover a prior last_port so a full rewrite —
  // including the two-phase createWorktree -> port-claim path that passes
  // port=null intermediately — never drops the durable, never-nulled
  // worktree -> port backlink #2231 added on the bash side. Mirrors the
  // defensive partial-parse in readClaimedPort / getClaimedPorts.
  let existingLastPort: number | null = null;
  // hapimatic-private#4481: preserve an existing-branch marker across rewrites —
  // dropping it would let cleanup `git branch -D` the user's branch.
  let existingBranchOrigin: "existing-local" | "existing-remote" | undefined;
  try {
    const prior = WorktreeMetaSchema.partial().safeParse(
      JSON.parse(await readFile(metaPath, "utf-8"))
    );
    if (prior.success && typeof prior.data.last_port === "number") {
      existingLastPort = prior.data.last_port;
    }
    if (prior.success) existingBranchOrigin = prior.data.branch_origin;
  } catch {
    // Absent / malformed meta — no prior last_port to preserve.
  }

  // A real claimed port wins (R3); a port=null rewrite falls back to the
  // preserved prior (R2), never clobbering it to null.
  const lastPort = options.port ?? existingLastPort;
  const branchOrigin = options.branchOrigin ?? existingBranchOrigin;

  const meta: WorktreeMeta = {
    schema_version: 1,
    created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    source_branch: options.sourceBranch,
    feature_branch: options.branch,
    issue_number: options.issueNumber,
    session_id: options.sessionId,
    // #4481: emitted only for an existing-branch worktree (new-branch meta stays
    // byte-identical to the bash writer, ADR-0007), placed BEFORE last_port so
    // claimed_port stays the LAST key in both writers.
    ...(branchOrigin ? { branch_origin: branchOrigin } : {}),
    last_port: lastPort,
    claimed_port: options.port,
  };

  // Atomic write: write to temp file then rename. rename(2) is atomic on
  // Linux (same filesystem). Prevents bash readers from seeing a truncated
  // JSON file mid-write — issue #1144.
  const tmpPath = `${metaPath}.tmp`;

  try {
    await writeFile(tmpPath, JSON.stringify(meta, null, 2) + "\n");
    await rename(tmpPath, metaPath);
    return { ok: true, port: options.port };
  } catch (error) {
    // Reap the temp file if writeFile succeeded but rename failed — otherwise
    // a stale `.tmp` survives the worktree and confuses git worktree remove.
    try {
      await unlink(tmpPath);
    } catch {
      // No file to clean up, or unlink failed — non-fatal.
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Failed to write ${metaPath}: ${message}` };
  }
}

/**
 * Null a worktree's `claimed_port` in its `.worktree-meta.json` — the
 * port-only, work-preserving reclaim primitive (#1683). Reads the raw meta;
 * if `claimed_port` is currently a number, rewrites it as `claimed_port: null`
 * via an atomic tmp+rename write, PRESERVING every other field — notably
 * `created_at`, which the TTL cleanup keys off. This is why it does NOT route
 * through `writeWorktreeMeta`, which would stamp a fresh `created_at`. NEVER
 * deletes the worktree directory or branch.
 *
 * Idempotent: returns `false` (no-op) when the meta is absent, unreadable,
 * malformed, or `claimed_port` is already null/non-numeric — mirroring the
 * bash `cmd_stop` sed's `[0-9]+` guard (which only fires on a numeric claim).
 * Returns `true` only when it actually flipped a numeric claim to null.
 */
export async function releaseWorktreePortClaim(
  worktreePath: string
): Promise<boolean> {
  const metaPath = join(worktreePath, ".worktree-meta.json");

  let raw: string;
  try {
    raw = await readFile(metaPath, "utf-8");
  } catch {
    return false; // no meta — nothing to release
  }

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return false; // malformed — do not clobber
  }

  // Idempotency guard: only act on a numeric claim (matches the bash sed).
  if (typeof meta.claimed_port !== "number") {
    return false;
  }

  meta.claimed_port = null;

  const tmpPath = `${metaPath}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(meta, null, 2) + "\n");
    await rename(tmpPath, metaPath);
    return true;
  } catch {
    try {
      await unlink(tmpPath);
    } catch {
      // No temp file to clean up, or unlink failed — non-fatal.
    }
    return false;
  }
}

/**
 * Lenient owner scan for the fleet orphan-unit sweep (#3210). Collects EVERY
 * port owned by an extant worktree meta of `repoRoot` — a port is "owned" if
 * any meta claims it (`claimed_port`) OR last started on it (`last_port`, the
 * #3209 durable backlink). Returns the union across all `.worktrees/` entries.
 *
 * Deliberately NOT `discoverWorktreeInstances` (directive #3210-1):
 *   - Reads the meta LENIENTLY — raw `JSON.parse` + `typeof === "number"`, the
 *     `releaseWorktreePortClaim` posture — NOT `WorktreeMetaSchema.partial()`,
 *     whose `min(1)` string checks would drop an odd-but-live meta (e.g. an
 *     empty `source_branch`) and wrongly mark its port unowned → reapable.
 *   - Surfaces BOTH `claimed_port` AND `last_port`. `discoverWorktreeInstances`
 *     only exposes `claimed_port` and `continue`s on a null claim, so it can
 *     never report a `last_port`-only owner (the #3209-enabled fail-safe case).
 *   - Returns `null` (NOT `[]`) when `.worktrees/` is unreadable: `[]` reads as
 *     "owns nothing" → the sweep would reap every running unit; `null` means
 *     "cannot determine ownership" → the sweep MUST abort and reap nothing
 *     (fail toward RUNNING, matching `scripts/hapi-worktree.sh:58-72`).
 *
 * Shares the `discoverWorktreeInstances` walk: resolved host base (#1558),
 * `.trash/` skipped (a soft-deleted worktree's units are correctly orphans),
 * symlinked entries skipped (`lstat`, #1383). A missing/malformed meta
 * contributes nothing (it cannot be correlated to a port).
 */
export async function collectOwnedWorktreePorts(
  repoRoot: string
): Promise<Set<number> | null> {
  const worktreesDir = join(resolveWorktreeHostBase(repoRoot), ".worktrees");

  let entries: string[];
  try {
    entries = await readdir(worktreesDir);
  } catch {
    // Unreadable `.worktrees/` — cannot determine ownership. Return null so the
    // caller aborts the sweep (reaps NOTHING); never `[]`, which reads as "owns
    // nothing" and would reap every running unit.
    return null;
  }

  const owned = new Set<number>();
  for (const entry of entries) {
    if (entry === ".trash") continue;
    const wtPath = join(worktreesDir, entry);

    // Symlink defense (#1383): lstat returns the symlink itself; skip the entry
    // if the directory IS a symlink.
    try {
      const stats = await lstat(wtPath);
      if (stats.isSymbolicLink()) continue;
    } catch {
      // lstat failed — skip defensively.
      continue;
    }

    const metaPath = join(wtPath, ".worktree-meta.json");
    let meta: Record<string, unknown>;
    try {
      const raw = await readFile(metaPath, "utf-8");
      meta = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Missing, unreadable, or malformed meta — contributes no owned port.
      continue;
    }

    // Lenient read (mirrors releaseWorktreePortClaim): a numeric, in-range
    // claimed_port AND/OR last_port both mark the port owned. A meta that
    // violates a schema `min(1)` string check is still a LIVE worktree — its
    // port must be protected.
    for (const key of ["claimed_port", "last_port"] as const) {
      const value = meta[key];
      if (
        typeof value === "number" &&
        value >= WORKTREE_PORT_MIN &&
        value <= WORKTREE_PORT_MAX
      ) {
        owned.add(value);
      }
    }
  }

  return owned;
}
