// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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

// Issue #4058 (decision D1 = B): the git timeout getters and the GIT_* env
// scrub live HERE, and worktree.ts imports them; worktree.ts already imports
// this module, so this is the direction that adds no import. Each getter reads
// its env var on every call (never cached at module load), so a daemon's
// systemd `Environment=` and a test's process.env change both take effect
// immediately.

// Issue #1327: default 30s ceiling for git operations under runGit.
// Env-overridable via HAPI_GIT_TIMEOUT_MS. Protects all runGit callers (local
// ops normally complete in ms, so 30s is generous defense-in-depth). Pattern
// matches the precedent at cli/src/modules/common/handlers/git.ts:64-99 (the
// user-facing git RPC handler uses 10s). The spawn-time fetches it once
// covered (#1320) run under getGitFetchTimeoutMs() since #1557, and the
// worktree checkout under getWorktreeAddTimeoutMs() since #4058.
const DEFAULT_GIT_TIMEOUT_MS = 30_000;
export function getGitTimeoutMs(): number {
  const raw = process.env.HAPI_GIT_TIMEOUT_MS;
  if (!raw) return DEFAULT_GIT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_GIT_TIMEOUT_MS;
}

// Issue #1557: the non-fatal spawn-time config fetch gets a SHORTER, independent
// budget than the fatal worktree-op timeout. A slow/hung fetch fails fast to the
// local-ref fallback (in syncConfigFromMain and createWorktree's fetch-first
// base) WITHOUT starving the worktree add. Default 8s is under the 30s generic
// budget yet above a typical incremental fetch; env-overridable via
// HAPI_GIT_FETCH_TIMEOUT_MS.
const DEFAULT_GIT_FETCH_TIMEOUT_MS = 8_000;
export function getGitFetchTimeoutMs(): number {
  const raw = process.env.HAPI_GIT_FETCH_TIMEOUT_MS;
  if (!raw) return DEFAULT_GIT_FETCH_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_GIT_FETCH_TIMEOUT_MS;
}

// Issue #4058: the worktree CHECKOUT (phase 2 of createWorktree's two-phase
// add, `git reset --hard` in the new worktree) gets its own, larger budget. It
// writes every tracked file, so it is the one git call whose cost scales with
// the repo: a full checkout of hapimatic-private took 74s at load 37 on RP1
// against the 30s generic default. 180s (operator ruling, 2026-09-27) is about
// 2.4x that worst observation. Env-overridable via
// HAPI_GIT_WORKTREE_ADD_TIMEOUT_MS. It is never below HAPI_GIT_TIMEOUT_MS when
// that is set, so an instance that raised the generic budget (prod runs
// HAPI_GIT_TIMEOUT_MS=60000) never gets a SHORTER checkout budget than before.
// Note: a budget above about 60s lets the server's 75s spawn RPC give up before
// the daemon finishes (the #2862 timeout-after-success class, #4000).
const DEFAULT_GIT_WORKTREE_ADD_TIMEOUT_MS = 180_000;
export function getWorktreeAddTimeoutMs(): number {
  const raw = process.env.HAPI_GIT_WORKTREE_ADD_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  const knob =
    Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_GIT_WORKTREE_ADD_TIMEOUT_MS;
  return process.env.HAPI_GIT_TIMEOUT_MS
    ? Math.max(knob, getGitTimeoutMs())
    : knob;
}

// Issue #1435: defense-in-depth scrub of inherited GIT_* env vars before
// invoking git. Mirrors the issue #283 SESSION_ENV_VARS_TO_STRIP pattern at
// run.ts:230-240. If any GIT_* var leaks into the daemon's process.env (from
// a parent shell, a systemd drop-in, or a future caller that sets one for a
// local operation), it would override git's normal repo discovery — producing
// symptoms like `fatal: not a valid object name: 'HEAD'` against a target
// repo whose HEAD demonstrably resolves from a shell.
//
// Allow-list extension: if a future workflow legitimately needs to pass a
// GIT_* var through (e.g. GIT_SSH_COMMAND for federation node SSH keys), add
// it to the allow-list below — do NOT widen by removing entries from the
// strip list, as that would re-open the bug class.
export const GIT_ENV_VARS_TO_STRIP = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
] as const;

export function buildScrubbedGitEnv(): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_ENV_VARS_TO_STRIP) {
    delete scrubbed[key];
  }
  return scrubbed;
}

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

// Stale = no heartbeat for 60s (#4502). The critical section can legitimately
// run longer than this window: since #4058 it holds the worktree checkout,
// whose budget is getWorktreeAddTimeoutMs() (default 180s). Epic #4402 ruled
// D-4402-1 = A: the window stays at 60s because withFileLock's heartbeat
// (#4502; every staleTimeoutMs / 3, so 20s here — withPortClaimLock sets no
// heartbeatMs) keeps a LIVE holder's lock fresh. The window only decides how
// long a DEAD holder (a daemon SIGKILLed mid-create) locks the next
// claimPort:true spawn out. Exported so the test suite can pin the value.
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
 * = 350*100 = 35s. A holder running a long checkout (budget
 * getWorktreeAddTimeoutMs(), default 180s, #4058) can outlast it, so a
 * concurrent claimPort:true spawn then fails after that 35s window with the
 * "retry shortly" message; nothing retries it automatically. claimPort
 * defaults to false (#1683). Models the
 * precedent at worktree.ts (`tearDownWorktreeInstance`, a per-port
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

// Issue #4370: the working-branch name this resolver prefers. It mirrors
// rp1-home's branch-config.json `working_branch`; the scripts read that file,
// the daemon hardcodes it (see the resolution-order note below).
export const WORKING_BRANCH = "ms-dev";

export type SourceBranchReason =
  | "explicit"
  | "target:working-branch"
  | "target:origin-default"
  | "fallback:head"
  | "fallback:constant";

export type ResolvedSourceBranch = {
  branch: string;
  reason: SourceBranchReason;
};

// Issue #4370: every resolver call runs inside the port-claim critical section
// (sessionSpawner's withPortClaimLock), so each one is bounded and env-scrubbed
// the way runGit is: the generic budget, SIGKILL, and the GIT_* scrub. This
// module cannot import runGit (worktree.ts imports this module), so the three
// exec options live here.
async function runResolverGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    timeout: getGitTimeoutMs(),
    killSignal: "SIGKILL",
    env: buildScrubbedGitEnv(),
  });
  return stdout.toString().trim();
}

/**
 * Issue #4370: resolve the branch a new worktree is cut from: the repo's
 * TARGET branch, never the parent checkout's current HEAD. Order:
 *  1. `refs/remotes/origin/ms-dev` or `refs/heads/ms-dev` → `ms-dev`
 *     (`target:working-branch`);
 *  2. `refs/remotes/origin/HEAD` → origin's default branch
 *     (`target:origin-default`);
 *  3. the parent's checked-out branch (`fallback:head`);
 *  4. `ms-dev` when git fails outright (`fallback:constant`).
 *
 * The order approximates rp1-home's `scripts/resolve-target-branch.sh`, but it
 * reads only local refs (no `ls-remote`, no `gh api`), so it costs at most
 * three local git calls. `refs/remotes/origin/HEAD` is a clone-time snapshot:
 * repair a stale one with `git remote set-head origin -a`. #4487 will add a
 * bash twin, `resolve_meta_source_branch` in `scripts/hapi-worktree.sh`; when
 * it lands, keep the two in the same order with the same reason strings.
 *
 * If the first call throws (a timeout, or not a repository), step 2 is skipped:
 * the answer then comes from a `fallback:` reason, which the spawner logs at
 * `warn`, so a slow git can never pass for a healthy `target:origin-default`.
 */
export async function resolveSourceBranch(
  repoRoot: string
): Promise<ResolvedSourceBranch> {
  let workingRefsFailed = false;
  try {
    // One call for both refs: for-each-ref prints whichever of the two
    // refnames exists, and nothing (exit 0) when neither does. Its patterns
    // also match deeper refs (`ms-dev/x`), so compare whole lines.
    const wanted = [
      `refs/remotes/origin/${WORKING_BRANCH}`,
      `refs/heads/${WORKING_BRANCH}`,
    ];
    const workingRefs = await runResolverGit([
      "-C",
      repoRoot,
      "for-each-ref",
      "--format=%(refname)",
      ...wanted,
    ]);
    if (workingRefs.split("\n").some(ref => wanted.includes(ref))) {
      return { branch: WORKING_BRANCH, reason: "target:working-branch" };
    }
  } catch {
    workingRefsFailed = true;
  }
  try {
    if (workingRefsFailed) {
      throw new Error("working-branch lookup failed");
    }
    const originHead = await runResolverGit([
      "-C",
      repoRoot,
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    const branch = originHead.replace(/^origin\//, "");
    if (branch) {
      return { branch, reason: "target:origin-default" };
    }
  } catch {
    // origin/HEAD unset (or no origin) — fall back to the parent's branch.
  }
  try {
    const head = await runResolverGit([
      "-C",
      repoRoot,
      "symbolic-ref",
      "--short",
      "HEAD",
    ]);
    if (head) {
      return { branch: head, reason: "fallback:head" };
    }
  } catch {
    // Detached HEAD, not a repo, or a timeout.
  }
  return { branch: WORKING_BRANCH, reason: "fallback:constant" };
}

/**
 * Issue #4370: true when `name` is a valid branch name per
 * `git check-ref-format --branch`, the daemon-side check on an explicit
 * `sourceBranch` (the server schema is the first check). Bounded and
 * env-scrubbed like the resolver; a timeout reads as invalid.
 */
export async function isValidBranchName(name: string): Promise<boolean> {
  if (!name || name.startsWith("-")) {
    return false;
  }
  try {
    await runResolverGit(["check-ref-format", "--branch", name]);
    return true;
  } catch {
    return false;
  }
}

export async function detectSourceBranch(repoRoot: string): Promise<string> {
  return (await resolveSourceBranch(repoRoot)).branch;
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

/** The states `readInstanceOwnerState` reads (the bash lib's names). */
export type InstanceOwnerState =
  | { state: "own" }
  | { state: "own-legacy" }
  | { state: "foreign"; owner: string }
  | { state: "ambiguous"; claimants: string[] }
  | { state: "unknown"; reason: string };

/**
 * One `systemctl --user show -p <property> --value <unit>` read; `null` when
 * it cannot be read. Injectable so tests never query a real unit.
 */
export type InstanceUnitReader = (
  unit: string,
  property: "ActiveState" | "Environment"
) => Promise<string | null>;

const UNIT_SHOW_TIMEOUT_MS = 15_000;
const RUNNING_UNIT_STATES = new Set(["active", "activating", "reloading"]);

async function readUnitProperty(
  unit: string,
  property: "ActiveState" | "Environment"
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "systemctl",
      ["--user", "show", "-p", property, "--value", unit],
      { timeout: UNIT_SHOW_TIMEOUT_MS }
    );
    // Strip trailing newlines, as the bash `$(...)` reading does.
    let end = stdout.length;
    while (end > 0 && stdout[end - 1] === "\n") end--;
    return stdout.slice(0, end);
  } catch {
    return null;
  }
}

// `[[:space:]]` in the C locale, which `owner_from_unit_env` matches under.
const OWNER_VAR_RE =
  /[ \t\n\v\f\r]HAPI_WT_OWNER_WORKTREE=(\/[^ \t\n\v\f\r"'\\]*)[ \t\n\v\f\r]/;

/**
 * Port of `owner_from_unit_env` (scripts/release-worktree-port.sh; the lib's
 * verbatim copy is `instance_owner_from_unit_env`): the
 * `HAPI_WT_OWNER_WORKTREE` value from one `systemctl show -p Environment
 * --value` line. `rc` as the bash returns: 0 = the owner, 1 = no variable
 * (launched before #4309), 2 = not one plain absolute path, 3 = the line holds
 * a double quote (systemd quotes an item with a space or a shell-special
 * character, so the variable's text could sit inside another item's value).
 * Only ASCII whitespace separates items, as the bash matches byte by byte
 * (LC_ALL=C).
 */
export function ownerFromUnitEnv(
  line: string
): { rc: 0; owner: string } | { rc: 1 | 2 | 3 } {
  const env = ` ${line} `;
  if (!env.includes("HAPI_WT_OWNER_WORKTREE=")) return { rc: 1 };
  if (env.includes('"')) return { rc: 3 };
  const found = env.match(OWNER_VAR_RE);
  return found ? { rc: 0, owner: found[1] } : { rc: 2 };
}

/** The bash state line for `state`, as `instance_owner_state` prints it. */
export function instanceOwnerStateLine(state: InstanceOwnerState): string {
  switch (state.state) {
    case "foreign":
      return `foreign:${state.owner}`;
    case "ambiguous":
      return `ambiguous:${state.claimants.join(",")}`;
    case "unknown":
      return `unknown:${state.reason}`;
    default:
      return state.state;
  }
}

/** `realpath -m`: symlinks resolved as far as the path exists, the rest kept. */
async function realpathMissingOk(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(await realpathMissingOk(parent), basename(absolute));
  }
}

/** `[[ -e ]] || [[ -L ]]`: anything at `path`, a dangling symlink included. */
async function pathPresent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** `[[ -e ]]`, following symlinks. */
async function pathPresentFollowing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** `[[ -d ]]`, following symlinks. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** `[[ -f ]]`, following symlinks. */
async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function hasAccess(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

const READ_SEARCH = fsConstants.R_OK | fsConstants.X_OK;

/** `[[ "$a" -ef "$b" ]]`: both exist and are the same device and inode. */
async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)]);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/** `instance_owner_same_worktree CANON WORKTREE`. */
async function sameWorktree(canon: string, worktree: string): Promise<boolean> {
  return (
    canon === (await realpathMissingOk(worktree)) ||
    (await sameFile(canon, worktree))
  );
}

/**
 * The meta's claim as `grep -o '"claimed_port":[[:space:]]*[0-9]\+' | grep -o
 * '[0-9]\+$'` reads it: every match, one per line, so a meta claims PORT only
 * when it holds exactly one claim and that claim is PORT.
 */
function grepClaimedPort(content: string): string {
  const claims: string[] = [];
  for (const line of content.split("\n")) {
    for (const found of line.matchAll(/"claimed_port":[ \t\v\f\r]*([0-9]+)/g)) {
      claims.push(found[1]);
    }
  }
  return claims.join("\n");
}

async function metaClaims(meta: string, port: number): Promise<boolean> {
  try {
    return grepClaimedPort(await readFile(meta, "utf-8")) === String(port);
  } catch {
    return false;
  }
}

/** Strip leading and trailing ASCII whitespace (`[[:space:]]`). */
function trimAscii(text: string): string {
  const space = " \t\n\v\f\r";
  let start = 0;
  let end = text.length;
  while (start < end && space.includes(text[start])) start++;
  while (end > start && space.includes(text[end - 1])) end--;
  return text.slice(start, end);
}

/**
 * `instance_owner_record_check`: no unit runs. The state when the record
 * decides it; `null` when no record counts and the claims decide.
 */
async function recordCheck(
  port: number,
  worktree: string,
  dataDir: string
): Promise<InstanceOwnerState | null> {
  if (
    (await pathPresentFollowing(dataDir)) &&
    !(await hasAccess(dataDir, READ_SEARCH))
  ) {
    return { state: "unknown", reason: `unreadable-data-dir:${dataDir}` };
  }
  const record = join(dataDir, "owner-worktree");
  if (!(await pathPresent(record))) return null;
  let line: string;
  try {
    if (
      !(await isRegularFile(record)) ||
      !(await hasAccess(record, fsConstants.R_OK))
    ) {
      return { state: "unknown", reason: "unreadable-marker" };
    }
    line = (await readFile(record, "utf-8")).split("\n")[0] ?? "";
  } catch {
    return { state: "unknown", reason: "unreadable-marker" };
  }
  line = trimAscii(line);
  if (!line) return { state: "unknown", reason: "empty-marker" };
  if (!line.startsWith("/")) {
    return { state: "unknown", reason: "malformed-marker" };
  }
  const canon = await realpathMissingOk(line);
  if (await sameWorktree(canon, worktree)) return { state: "own" };
  // Only a folder above the named worktree that can be read says it is gone.
  const parent = dirname(canon);
  if (!(await isDirectory(parent)) || !(await hasAccess(parent, READ_SEARCH))) {
    return { state: "unknown", reason: `unreadable-owner-folder:${parent}` };
  }
  if (!(await pathPresent(canon))) return null;
  if ((await isDirectory(canon)) && !(await hasAccess(canon, READ_SEARCH))) {
    return { state: "unknown", reason: `unreadable-owner-meta:${canon}` };
  }
  const meta = join(canon, ".worktree-meta.json");
  if (!(await pathPresent(meta))) return null;
  if (
    !(await isRegularFile(meta)) ||
    !(await hasAccess(meta, fsConstants.R_OK))
  ) {
    return { state: "unknown", reason: `unreadable-owner-meta:${meta}` };
  }
  return (await metaClaims(meta, port))
    ? { state: "foreign", owner: canon }
    : null;
}

/**
 * `instance_owner_claims_state` with `instance_owner_sibling_claimants`: the
 * other worktrees in the folder holding `worktree` whose meta claims `port`. A
 * claim that can be read decides first; else anything unreadable is unknown.
 */
async function claimsState(
  port: number,
  worktree: string
): Promise<InstanceOwnerState> {
  const wtDir = dirname(worktree);
  const cannotList = {
    state: "unknown" as const,
    reason: `cannot list ${wtDir}, where another worktree may claim port ${port}`,
  };
  if (!(await isDirectory(wtDir)) || !(await hasAccess(wtDir, READ_SEARCH))) {
    return cannotList;
  }
  let entries: string[];
  try {
    entries = await readdir(wtDir);
  } catch {
    return cannotList;
  }
  // The bash globs `*/` then `.*/`, each sorted.
  const ordered = [
    ...entries.filter(name => !name.startsWith(".")).sort(),
    ...entries.filter(name => name.startsWith(".")).sort(),
  ];
  const names: string[] = [];
  const unreadable: string[] = [];
  for (const name of ordered) {
    if (name === ".trash") continue;
    const dir = join(wtDir, name);
    if (!(await isDirectory(dir))) continue;
    if (await sameFile(dir, worktree)) continue;
    if (!(await hasAccess(dir, READ_SEARCH))) {
      unreadable.push(dir);
      continue;
    }
    const meta = join(dir, ".worktree-meta.json");
    if (!(await pathPresent(meta))) continue;
    if (
      !(await isRegularFile(meta)) ||
      !(await hasAccess(meta, fsConstants.R_OK))
    ) {
      unreadable.push(meta);
      continue;
    }
    if (await metaClaims(meta, port)) names.push(name);
  }
  if (names.length > 0) return { state: "ambiguous", claimants: names };
  if (unreadable.length > 0) {
    return {
      state: "unknown",
      reason: `cannot read ${unreadable[0]}, which may claim port ${port}`,
    };
  }
  return { state: "own-legacy" };
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "unreadable";
}

/**
 * Whether the worktree instance on `port` is provably `worktreePath`'s
 * (issue #4588). Read before any claim-based teardown, because a claimed port
 * can be held by ANOTHER worktree's live instance: two worktrees can claim one
 * port (the bash reclaim, and the per-root TS scan across roots, #4309 E3).
 *
 * The TS port of `instance_owner_state` in `scripts/lib/instance-owner-v1.sh`
 * (#4577's file; the A1, D1 = A and G1 rulings). It gives the same
 * state, and the same reason tokens, for the same inputs; a parity test in
 * worktreeMeta.test.ts runs both on one set of fixtures. Keep them in step.
 *   1. The port's units, `hapimatic-wt-<port>-server` and `-daemon`. A unit
 *      runs when its ActiveState is active, activating or reloading, or cannot
 *      be read. Each running unit's environment must be readable and non-empty;
 *      its `HAPI_WT_OWNER_WORKTREE` (#4309) is canonicalised. Every running unit
 *      naming this worktree is `own`, naming the same other worktree `foreign`;
 *      any other mix is `unknown:mixed-units`. Units naming no launcher (before
 *      #4309) fall to the claims below; the owner record is not read then,
 *      because a record outlives a stop, a reboot or a crash.
 *   2. When no unit runs, `<home>/.hapimatic-wt-<port>/owner-worktree` (one
 *      line, an absolute path) naming this worktree is `own`; naming worktree W
 *      is `foreign` only while W still exists and its meta still claims the
 *      port. A record naming a gone W, or one whose claim was released (the
 *      closer keeps the folder and nulls the claim), counts as no record (G1).
 *   3. With no record that counts, the claims: the other worktrees in the
 *      folder holding this one (dot folders read, `.trash` never) whose meta
 *      claims the port give `ambiguous`, else `own-legacy` (D-4588-1 A).
 * Anything that cannot be read is `unknown`. An empty `home` is a bad call (no
 * data dir to read). Never throws.
 */
export async function readInstanceOwnerState(options: {
  port: number;
  worktreePath: string;
  home: string;
  readUnit?: InstanceUnitReader;
}): Promise<InstanceOwnerState> {
  const { port, worktreePath, home } = options;
  const readUnit = options.readUnit ?? readUnitProperty;
  try {
    if (
      !Number.isInteger(port) ||
      port < 0 ||
      !worktreePath.startsWith("/") ||
      !home
    ) {
      return { state: "unknown", reason: "bad-call" };
    }
    const dataDir = join(home, `.hapimatic-wt-${port}`);

    const running: string[] = [];
    for (const unit of [
      `hapimatic-wt-${port}-server`,
      `hapimatic-wt-${port}-daemon`,
    ]) {
      const activeState = await readUnit(unit, "ActiveState");
      if (!activeState || RUNNING_UNIT_STATES.has(activeState)) {
        running.push(unit);
      }
    }

    if (running.length === 0) {
      return (
        (await recordCheck(port, worktreePath, dataDir)) ??
        (await claimsState(port, worktreePath))
      );
    }

    const kinds: string[] = [];
    for (const unit of running) {
      const environment = await readUnit(unit, "Environment");
      if (!environment) {
        return { state: "unknown", reason: `unreadable-unit-env:${unit}` };
      }
      const parsed = ownerFromUnitEnv(environment);
      if (parsed.rc !== 0) {
        if (parsed.rc === 1) {
          kinds.push("none");
          continue;
        }
        return parsed.rc === 3
          ? { state: "unknown", reason: `quoted-unit-env:${unit}` }
          : { state: "unknown", reason: `malformed-unit-owner:${unit}` };
      }
      const canon = await realpathMissingOk(parsed.owner);
      kinds.push(
        (await sameWorktree(canon, worktreePath)) ? "own" : `foreign:${canon}`
      );
    }
    // Every live unit must name the same launcher (#4577 mixed-set ruling).
    if (kinds.some(kind => kind !== kinds[0])) {
      return { state: "unknown", reason: "mixed-units" };
    }
    if (kinds[0] === "own") return { state: "own" };
    if (kinds[0].startsWith("foreign:")) {
      return { state: "foreign", owner: kinds[0].slice("foreign:".length) };
    }
    return await claimsState(port, worktreePath);
  } catch (error) {
    return { state: "unknown", reason: `error:${errorCode(error)}` };
  }
}

/** One-line description of a non-own state, for logs (issue #4588). */
export function describeInstanceOwner(owner: InstanceOwnerState): string {
  switch (owner.state) {
    case "foreign":
      return `owner ${owner.owner}`;
    case "ambiguous":
      return `also claimed by ${owner.claimants.join(", ")}`;
    case "unknown":
      return owner.reason;
    default:
      return owner.state;
  }
}
