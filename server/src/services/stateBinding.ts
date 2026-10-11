// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Two-layer, topology-agnostic state-binding engine (issue #3332, epic #3329
 * Sub-Issue D). Replaces the 60-minute approval-validity TTL: a grant is valid
 * while the approved artifact is unchanged — regardless of elapsed time — and
 * Layer-2 target-drift matters only when it touches the approved files.
 *
 * ## Two layers
 *
 * - **Layer 1** (`checkLayer1`) — did the APPROVED content change locally? A
 *   per-file `git hash-object` comparison against the minted blob hashes, with a
 *   cleanliness-gated HEAD-equality fast path. Any approved-file change ⇒ the
 *   grant is invalid and the caller mints a fresh challenge.
 * - **Layer 2** (`checkLayer2`) — did the TARGET branch move in a way that
 *   touches the approved files? The target-of-record is the authoritative remote
 *   tip; a collision produces an {@link OverlapAnalysis} for the decision-menu
 *   flow (epic ruling D1a — overlap is a DECISION, not a rejection).
 *
 * ## Cross-issue contract (R9 / GAP-2)
 *
 * `StateFingerprint`, `OverlapAnalysis`, `InvalidReason` and the
 * {@link StateCheckResult} discriminated union are the EXPORTED contract this
 * issue owns. #3331 (`approvalTokens.ts`) IMPORTS them — it must never
 * re-declare. The engine-outcome → deny-reason seam is pinned in the
 * {@link StateCheckResult} docblock.
 *
 * ## Purity (R8)
 *
 * Every exported function is pure/deterministic given `(repoPath, fingerprint)`
 * plus its explicit options — no module-level mutable state — so the hook-side
 * fallback (rp1-home#1750) can port or shell to it faithfully. Network I/O in
 * Layer 2 is inherent (target drift is a remote fact) and is reached through an
 * INJECTABLE resolver whose default uses the gh-then-REST transport; a port
 * supplies its own resolver.
 *
 * ## No shallow git (R7)
 *
 * No `--depth` / `--shallow-since` / `--shallow-exclude` appears anywhere here
 * (enforced by Task 8's grep audit, since the `git-shallow-fetch-guard.py` hook
 * is PreToolUse/Bash-only and cannot observe a runtime `execFile("git", …)`).
 *
 * Git plumbing mirrors `cli/src/daemon/worktree.ts` `runGit` (the server package
 * cannot import from `cli/`), CARRYING its hardening: a 30s timeout +
 * `killSignal: "SIGKILL"` (#1327 — git can hang in an uninterruptible syscall),
 * the `GIT_*` env scrub (#1435 — a leaked `GIT_DIR`/`GIT_WORK_TREE` breaks repo
 * discovery), and CIFS-aware transient-vs-stable error discipline (this
 * deployment is NAS-mounted, `server/src/utils/repoIdentity.ts:44-67`).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runGhWithBunSpawn, type GhRunner } from "../utils/githubCli";
import { resolveGitHubToken, type FetchImpl } from "../utils/githubRest";

const execFileAsync = promisify(execFile);

// ── Git exec helper (Task 1) ────────────────────────────────────────────────

// Issue #1327 (mirrored from worktree.ts): 30s ceiling for git operations.
// Env-overridable via HAPI_GIT_TIMEOUT_MS. Local git ops complete in ms; the
// budget is CIFS-aware headroom (a cold `.git` stat up a NAS tree can take
// seconds — repoIdentity.ts uses 10s; runGit's 30s allows extra headroom).
const DEFAULT_GIT_TIMEOUT_MS = 30_000;
function getGitTimeoutMs(): number {
  const raw = process.env.HAPI_GIT_TIMEOUT_MS;
  if (!raw) return DEFAULT_GIT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_GIT_TIMEOUT_MS;
}

// Issue #1435 (mirrored from worktree.ts): scrub inherited GIT_* env vars before
// invoking git. A leaked GIT_DIR/GIT_WORK_TREE/… from a parent shell or systemd
// drop-in overrides git's repo discovery, producing "fatal: not a valid object
// name: 'HEAD'" against a repo whose HEAD resolves fine from a shell. Do NOT
// widen this list — copy it verbatim.
const GIT_ENV_VARS_TO_STRIP = [
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

function buildScrubbedGitEnv(): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_ENV_VARS_TO_STRIP) {
    delete scrubbed[key];
  }
  return scrubbed;
}

/**
 * A git call that was killed by the timeout (CIFS wedge, #1327) — TRANSIENT.
 * Distinct from a normal non-zero git exit so callers classify a wedged-git
 * result as `indeterminate` rather than a stable negative
 * (repoIdentity.ts:53-67's transient-vs-stable discipline). NEVER treat a
 * transient as "valid".
 */
export class GitTransientError extends Error {
  override name = "GitTransientError";
}

/**
 * Run one `git` command in `cwd`, mirroring `cli/src/daemon/worktree.ts`
 * `runGit`. Returns `{stdout, stderr}` and THROWS on any non-zero exit (a
 * timeout throws {@link GitTransientError}; every other non-zero throws a plain
 * Error). Never returns a falsy sentinel — every caller handles the throw.
 *
 * Exported (#3653): approvalTokenHook's provenance-comment emit resolves the
 * close-target repo slug via `runGit(["remote", "get-url", "origin"], repoPath)`
 * (then {@link parseRepoSlug}), reusing this hardened runner rather than
 * duplicating the spawn.
 */
export async function runGit(
  args: string[],
  cwd: string,
  options?: { timeoutMs?: number }
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options?.timeoutMs ?? getGitTimeoutMs();
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout: timeoutMs,
      // SIGKILL (not SIGTERM): git can sit in an uninterruptible syscall (DNS,
      // TCP handshake) where SIGTERM is queued but not delivered until the
      // syscall returns. SIGKILL is kernel-delivered (#1327).
      killSignal: "SIGKILL",
      // #1435: scrub inherited GIT_* env vars before spawning git.
      env: buildScrubbedGitEnv(),
      maxBuffer: 32 * 1024 * 1024,
    });
    return {
      stdout: result.stdout ? result.stdout.toString() : "",
      stderr: result.stderr ? result.stderr.toString() : "",
    };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    if (execError.code === "ETIMEDOUT" || execError.killed) {
      const cmdHint = args.slice(0, 2).join(" ");
      throw new GitTransientError(
        `git ${cmdHint} timed out after ${timeoutMs}ms (HAPI_GIT_TIMEOUT_MS to override)`
      );
    }
    const stderr = execError.stderr ? execError.stderr.toString() : "";
    const stdout = execError.stdout ? execError.stdout.toString() : "";
    throw new Error(
      stderr.trim() ||
        stdout.trim() ||
        execError.message ||
        "Git command failed"
    );
  }
}

// ── Exported contract types (R9 / GAP-2) ────────────────────────────────────

/**
 * Sentinel `blob_hash` recorded for an approved path that did NOT exist at mint
 * time. It cannot collide with a real git object id (40 lowercase hex), so a
 * later create (absent→present) or a still-absent path is distinguishable. This
 * covers MINT-time absence only; CHECK-time absence is Layer 1's concern
 * (3332-4).
 */
export const ABSENT_SENTINEL = "<absent>";

/** One approved file's minted content hash. */
export interface ApprovedFileHash {
  /** Repo-relative path (relative to the fingerprint's `repoPath`). */
  path: string;
  /** `git hash-object` of the working-tree content at mint, or
   *  {@link ABSENT_SENTINEL} when the path did not exist at mint. */
  blob_hash: string;
}

/**
 * The mint-time state fingerprint (R1). Captures per-file working-tree hashes
 * (so uncommitted edits are bound), the HEAD, the merge-base against the target,
 * and — critically (3332-1) — whether the approved paths were CLEAN at mint.
 */
export interface StateFingerprint {
  head_sha: string;
  files: ApprovedFileHash[];
  /**
   * True iff `git status --porcelain -- <approved paths>` was EMPTY at mint.
   * This single boolean is what makes the Layer-1 fast path SOUND: without it
   * the fast path validates stale approvals in the dirty-tree topology, which is
   * the engine's COMMON state (indefinite validity + agents that edit without
   * committing), not an edge case (3332-1).
   */
  clean_at_mint: boolean;
  merge_base: string;
  target_branch: string;
}

/** Overlap-analysis output (R4). Exported as the cross-issue contract (GAP-2):
 *  #3331's `verifyToken` and the rp1-home#1749 registry describe ONE object. */
export interface OverlapAnalysis {
  /** Approved files the target-branch drift also touched. */
  collided_files: string[];
  /** What the incoming (target-side) change does, at file granularity. */
  incoming_change_description: string;
  /** Whether the approved change and the incoming change plausibly interact. */
  plausible_interaction_assessment: string;
  /** Suggested next action. */
  recommendation: string;
  /**
   * True for user-taste / secrets / subjective-judgment surfaces (a human must
   * decide); false for mechanically-rebaseable code. Conservative — defaults to
   * true when a collided path cannot be confidently classified as mechanical
   * (R4). Only when this is false MAY a PM auto-consume the decision.
   */
  escalation_required: boolean;
}

/** Why a grant is invalid. Exported as a union of string literals (R9). */
export type InvalidReason =
  | "content-changed"
  | "approved-path-absent"
  | "hygiene-expired";

/**
 * The engine's outcome (R9). #3331 IMPORTS this — never re-declare it.
 *
 * 🔴 SEAM MAPPING (the part most likely to drift — pinned here per GAP-2). #3331's
 * deny-reason enum is `nonce-mismatch | state-drift | provenance-rejected |
 * replayed` (#3331 R1); THIS engine owns exactly `state-drift`:
 *   - `kind:"valid"`         ⇒ the grant is honored.
 *   - `kind:"invalid"`       ⇒ #3331's **`state-drift`** deny (a hard denial in
 *                              the message pipeline). ALL invalid reasons —
 *                              content-changed, approved-path-absent,
 *                              hygiene-expired — map to `state-drift`.
 *   - `kind:"overlap"`       ⇒ the **decision-menu** flow, NOT a denial (epic
 *                              ruling D1a; #3331 Task 8). The caller surfaces the
 *                              {@link OverlapAnalysis}; a PM may auto-consume only
 *                              when `escalation_required === false`.
 *   - `kind:"indeterminate"` ⇒ CONSERVATIVE handling by the caller (re-challenge
 *                              or escalate). NEVER silently valid, and never
 *                              silently `state-drift` without surfacing the
 *                              reason.
 */
export type StateCheckResult =
  | { kind: "valid" }
  | { kind: "invalid"; changed: string[]; reason: InvalidReason }
  | { kind: "overlap"; analysis: OverlapAnalysis }
  | { kind: "indeterminate"; reason: string };

/**
 * A gate record handed to {@link isValid} (Task 6, resolution (a)). #3332 lands
 * FIRST — the full gate-record storage is owned by #3331 and rp1-home#1749's
 * schema — so this is a MINIMAL input type aligned to that schema, not the whole
 * record. A crisp gate carries a `fingerprint`; a bypass-class gate carries none
 * (only `minted_at`, consulted solely by the hygiene TTL). The engine reads the
 * record it is handed; it never loads one (R8).
 */
export interface GateRecord {
  fingerprint?: StateFingerprint;
  /** ISO-8601 mint time; used ONLY by the hygiene-TTL path for fingerprint-less
   *  gates. Aligned to rp1-home#1749's gate-record schema. */
  minted_at?: string;
}

// ── Task 2: mint-time fingerprint ───────────────────────────────────────────

/**
 * `git hash-object` of a working-tree path, or {@link ABSENT_SENTINEL} when the
 * path does not exist. A TRANSIENT git failure (timeout) is re-thrown so the
 * caller resolves it to `indeterminate`; a genuine non-zero (file absent) yields
 * the sentinel — never a throw that escapes the validity gate (3332-4).
 */
async function hashObjectOrAbsent(
  repoPath: string,
  filePath: string
): Promise<string> {
  try {
    const { stdout } = await runGit(["hash-object", "--", filePath], repoPath);
    return stdout.trim();
  } catch (err) {
    if (err instanceof GitTransientError) throw err;
    // Genuine non-zero (path absent / unreadable) — record absence, do not throw.
    return ABSENT_SENTINEL;
  }
}

/**
 * Mint the state fingerprint for `approvedPaths` in `repoPath` against
 * `targetBranch` (R1). Works identically across worktree / shared basic checkout
 * / detached HEAD / dirty tree: `rev-parse HEAD` resolves in detached HEAD;
 * `hash-object` reads the WORKING file (so uncommitted edits are captured);
 * `status --porcelain` reflects the dirty tree.
 *
 * `approvedPaths` are repo-relative to `repoPath`.
 */
export async function mintFingerprint(
  repoPath: string,
  approvedPaths: string[],
  targetBranch: string
): Promise<StateFingerprint> {
  const head_sha = (
    await runGit(["rev-parse", "HEAD"], repoPath)
  ).stdout.trim();
  const merge_base = (
    await runGit(["merge-base", "HEAD", targetBranch], repoPath)
  ).stdout.trim();

  const files: ApprovedFileHash[] = [];
  for (const path of approvedPaths) {
    files.push({ path, blob_hash: await hashObjectOrAbsent(repoPath, path) });
  }

  // 3332-1: clean_at_mint is the boolean that makes Task 3's fast path sound.
  const status = (
    await runGit(["status", "--porcelain", "--", ...approvedPaths], repoPath)
  ).stdout.trim();
  const clean_at_mint = status.length === 0;

  return {
    head_sha,
    files,
    clean_at_mint,
    merge_base,
    target_branch: targetBranch,
  };
}

// ── Task 3: Layer 1 consumption check ───────────────────────────────────────

/**
 * Layer 1 (R2): did the APPROVED content change locally?
 *
 * 🔴 The HEAD-equality fast path is CLEANLINESS-GATED IN BOTH DIRECTIONS (3332-1
 * — the security core). It fires only when `fingerprint.clean_at_mint === true`
 * AND `git status --porcelain -- <approved paths>` is EMPTY right now:
 *   - check-time-only is insufficient — a fingerprint minted while a file was
 *     dirty, then reverted to the committed content, has an unchanged HEAD + a
 *     clean tree but a DIFFERENT approved content than what was approved;
 *   - mint-time-only is insufficient — a clean mint followed by an uncommitted
 *     edit has an unchanged HEAD + a CHANGED approved file.
 * When both hold and HEAD is unchanged, the approved content is provably
 * unchanged. In every other case, per-file `hash-object` comparison decides.
 *
 * A deleted / renamed-away approved path ⇒ invalid-with-reason, NEVER an
 * unhandled throw (3332-4). A transient git failure ⇒ `indeterminate`, never
 * "valid" (CIFS discipline).
 */
export async function checkLayer1(
  repoPath: string,
  fingerprint: StateFingerprint
): Promise<StateCheckResult> {
  const approvedPaths = fingerprint.files.map(f => f.path);
  try {
    // Cleanliness-gated fast path.
    if (fingerprint.clean_at_mint) {
      const currentHead = (
        await runGit(["rev-parse", "HEAD"], repoPath)
      ).stdout.trim();
      if (currentHead === fingerprint.head_sha) {
        const statusNow = (
          await runGit(
            ["status", "--porcelain", "--", ...approvedPaths],
            repoPath
          )
        ).stdout.trim();
        if (statusNow.length === 0) {
          // clean_at_mint ∧ clean_now ∧ HEAD unchanged ⇒ provably unchanged.
          return { kind: "valid" };
        }
      }
    }

    // Per-file fallback (always correct).
    const changed: string[] = [];
    let sawAbsence = false;
    for (const f of fingerprint.files) {
      const currentHash = await hashObjectOrAbsent(repoPath, f.path);
      if (currentHash !== f.blob_hash) {
        changed.push(f.path);
        // An approved path that EXISTED at mint but is now absent.
        if (
          currentHash === ABSENT_SENTINEL &&
          f.blob_hash !== ABSENT_SENTINEL
        ) {
          sawAbsence = true;
        }
      }
    }
    if (changed.length > 0) {
      return {
        kind: "invalid",
        changed,
        reason: sawAbsence ? "approved-path-absent" : "content-changed",
      };
    }
    return { kind: "valid" };
  } catch (err) {
    // Any git failure inside the sole validity gate resolves CONSERVATIVELY.
    const reason =
      err instanceof GitTransientError
        ? `layer-1 git transient: ${err.message}`
        : `layer-1 git error: ${(err as Error).message}`;
    return { kind: "indeterminate", reason };
  }
}

// ── Task 4: Layer 2 target-drift overlap check ──────────────────────────────

/**
 * Resolves the set of files the TARGET branch changed since `mergeBase`.
 * INJECTABLE so the engine stays pure/testable (R8): the default reaches the
 * authoritative remote tip via the gh-then-REST transport; a caller (or the
 * rp1-home#1750 port) may supply its own.
 *
 * 🔴 An indeterminate result (unreachable / 404 unpushed merge-base / no gh + no
 * token) is its OWN outcome — it must NEVER be collapsed into "no drift ⇒ valid"
 * (3332-3).
 */
export type TargetDriftResolver = (input: {
  repoPath: string;
  mergeBase: string;
  targetBranch: string;
}) => Promise<
  { kind: "files"; files: string[] } | { kind: "indeterminate"; reason: string }
>;

export interface CheckLayer2Options {
  /** Override the target-drift resolver (default: gh-then-REST compare). */
  resolveTargetChanges?: TargetDriftResolver;
  /** Env for the default resolver's token lookup (default: `process.env`). */
  env?: Record<string, string | undefined>;
  /** Injectable `gh` runner for the default resolver (default: real spawn). */
  runGh?: GhRunner;
  /** Injectable `fetch` for the default resolver's REST fallback. */
  fetchImpl?: FetchImpl;
}

/** GitHub compare payload fields this engine consumes (both transports). */
interface CompareFile {
  filename?: string;
  previous_filename?: string;
}
interface ComparePayload {
  files?: CompareFile[];
}

/**
 * Collect changed paths from a GitHub compare payload, including BOTH the
 * post-image `filename` AND the pre-image `previous_filename`. This is the
 * gh-API equivalent of `git diff --no-renames` (3332-4): a target-side rename of
 * an approved file would otherwise appear only under its NEW name and evade the
 * intersection on the approved path's OLD name. Shared by both transports so the
 * rename handling has one source of truth.
 */
export function extractCompareFiles(payload: ComparePayload): string[] {
  const out = new Set<string>();
  for (const f of payload.files ?? []) {
    if (f.filename) out.add(f.filename);
    if (f.previous_filename) out.add(f.previous_filename);
  }
  return [...out];
}

/** Parse `owner/repo` from a git remote URL (ssh or https). */
export function parseRepoSlug(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  const ssh = trimmed.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = trimmed.match(/^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}

/**
 * Default target-drift resolver: the authoritative remote tip of `targetBranch`
 * via the gh-then-REST transport (`server/src/utils/githubCli.ts` documents the
 * fixed order; `gh` is absent by design on provisioned cloud VMs, so the
 * token-backed REST fallback needs no binary). No octokit. Any failure yields
 * `indeterminate` — never a false "no drift".
 *
 * Both transports fetch the compare object and extract files in JS via
 * {@link extractCompareFiles} (one rename-handling source of truth). Renames are
 * detected on both the old and new path.
 */
function defaultTargetDriftResolver(
  opts: CheckLayer2Options
): TargetDriftResolver {
  const runGh = opts.runGh ?? runGhWithBunSpawn;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;

  return async ({ repoPath, mergeBase, targetBranch }) => {
    let slug: string | null = null;
    try {
      const url = (
        await runGit(["remote", "get-url", "origin"], repoPath)
      ).stdout.trim();
      slug = parseRepoSlug(url);
    } catch (err) {
      return {
        kind: "indeterminate",
        reason: `cannot resolve origin remote: ${(err as Error).message}`,
      };
    }
    if (!slug) {
      return {
        kind: "indeterminate",
        reason: "origin remote is not a GitHub owner/repo URL",
      };
    }

    const basehead = `${mergeBase}...${targetBranch}`;

    // Transport 1: `gh api` (tried first — byte-identical behavior on RP1 and
    // every federation peer). A missing binary THROWS; a non-zero exit returns a
    // non-zero code. Both fall through to REST.
    try {
      const { code, stdout } = await runGh([
        "gh",
        "api",
        `repos/${slug}/compare/${basehead}`,
      ]);
      if (code === 0) {
        try {
          const payload = JSON.parse(stdout) as ComparePayload;
          return { kind: "files", files: extractCompareFiles(payload) };
        } catch {
          return {
            kind: "indeterminate",
            reason: "gh compare returned unparseable JSON",
          };
        }
      }
    } catch {
      // `gh` missing / spawn failure — fall through to REST.
    }

    // Transport 2: token-backed REST (no binary). A 404 means the mint-time
    // merge-base was never pushed — indeterminate, NOT "no drift".
    const token = resolveGitHubToken(env);
    if (!token) {
      return {
        kind: "indeterminate",
        reason: "compare unavailable: gh failed and no GH_TOKEN/GITHUB_TOKEN",
      };
    }
    let response: Response;
    try {
      response = await fetchImpl(
        `https://api.github.com/repos/${slug}/compare/${encodeURIComponent(
          mergeBase
        )}...${encodeURIComponent(targetBranch)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "hapimatic",
          },
        }
      );
    } catch {
      return { kind: "indeterminate", reason: "compare REST network failure" };
    }
    if (!response.ok) {
      return {
        kind: "indeterminate",
        reason: `compare REST status ${response.status}`,
      };
    }
    try {
      const payload = (await response.json()) as ComparePayload;
      return { kind: "files", files: extractCompareFiles(payload) };
    } catch {
      return {
        kind: "indeterminate",
        reason: "compare REST returned unparseable JSON",
      };
    }
  };
}

/** Secret / config surfaces: a collision here always escalates (R4). */
const SENSITIVE_PATTERN =
  /(^|\/)\.env|secret|credential|password|token|\.pem$|\.key$|(^|\/)\.?config($|[./])|\.(ya?ml|toml|ini|conf)$/i;
/** User-taste surfaces (styling, branding, copy): subjective ⇒ escalate (R4). */
const TASTE_PATTERN =
  /\.(css|scss|sass|less)$|theme|brand|copy|content|styles?/i;
/** Confidently-mechanical code file extensions (rebaseable without judgment). */
const MECHANICAL_CODE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|cc|cpp|h|hpp|kt|swift|php|cs|scala)$/i;

/** A collided path requires human escalation unless it is confidently a
 *  mechanical code file (conservative default-true, R4). */
function pathRequiresEscalation(path: string): boolean {
  if (SENSITIVE_PATTERN.test(path)) return true;
  if (TASTE_PATTERN.test(path)) return true;
  return !MECHANICAL_CODE.test(path);
}

function buildOverlapAnalysis(collided: string[]): OverlapAnalysis {
  // A single pass: escalation is required iff any collided path escalates.
  const escalated = collided.filter(pathRequiresEscalation);
  const escalation_required = escalated.length > 0;
  return {
    collided_files: collided,
    incoming_change_description: `The target branch modified ${collided.length} of the approved file(s) since the approval merge-base: ${collided.join(
      ", "
    )}.`,
    plausible_interaction_assessment:
      "The approved change and the incoming target-branch change touch the same file(s), so they may conflict or interact — a rebase will replay the approved change on top of the incoming one.",
    recommendation: escalation_required
      ? `Escalate to the user: the collision touches sensitive / subjective surfaces (${escalated.join(
          ", "
        )}) that need human judgment before the approval is re-consumed.`
      : "Mechanical rebase-and-proceed: rebase the approved change onto the current target tip and re-verify; no subjective judgment is required.",
    escalation_required,
  };
}

/**
 * Layer 2 (R3, R4): did the TARGET branch move in a way that touches the
 * approved files? Zero overlap ⇒ valid (unrelated edits never invalidate).
 * Overlap ⇒ an {@link OverlapAnalysis} for the decision-menu flow (a DECISION,
 * not a rejection — epic D1a). An indeterminate target read ⇒ `indeterminate`,
 * never valid (3332-3).
 */
export async function checkLayer2(
  repoPath: string,
  fingerprint: StateFingerprint,
  opts: CheckLayer2Options = {}
): Promise<StateCheckResult> {
  const resolver =
    opts.resolveTargetChanges ?? defaultTargetDriftResolver(opts);
  const drift = await resolver({
    repoPath,
    mergeBase: fingerprint.merge_base,
    targetBranch: fingerprint.target_branch,
  });
  if (drift.kind === "indeterminate") {
    return {
      kind: "indeterminate",
      reason: `layer-2 target read: ${drift.reason}`,
    };
  }
  const approved = new Set(fingerprint.files.map(f => f.path));
  const collided = drift.files.filter(p => approved.has(p));
  if (collided.length === 0) {
    return { kind: "valid" };
  }
  return { kind: "overlap", analysis: buildOverlapAnalysis(collided) };
}

// ── Task 5: epic-batch binding ──────────────────────────────────────────────

/** One member of an epic-batch grant, at mint time. */
export interface BatchMemberSpec {
  repoPath: string;
  branch: string;
  approvedPaths: string[];
  targetBranch: string;
}

/** A minted epic-batch fingerprint: the SET of member HEADs + per-member
 *  fingerprints (union file list is the union of each member's approved paths). */
export interface BatchFingerprint {
  members: Array<{
    repoPath: string;
    branch: string;
    fingerprint: StateFingerprint;
  }>;
}

/**
 * The epic-batch outcome (3332-5, epic D1a). A member's LAYER-1 invalidation
 * invalidates the WHOLE batch; a member's LAYER-2 overlap does NOT — it
 * aggregates into a single overlap analysis for the decision-menu flow; any
 * member indeterminate ⇒ the batch is indeterminate (conservative).
 */
export type BatchCheckResult =
  | { kind: "valid" }
  | {
      kind: "invalid";
      members: Array<{
        repoPath: string;
        branch: string;
        result: Extract<StateCheckResult, { kind: "invalid" }>;
      }>;
    }
  | { kind: "overlap"; analysis: OverlapAnalysis; members: string[] }
  | { kind: "indeterminate"; reason: string };

/**
 * Mint an epic-batch fingerprint (R5): binds each member branch HEAD + the union
 * file list. Replaces the `EPIC_BATCH_TTL_MINUTES` clock (rp1-home#1518,
 * CLOSED). Any single member's drift later invalidates the batch.
 */
export async function mintBatchFingerprint(
  members: BatchMemberSpec[]
): Promise<BatchFingerprint> {
  const out: BatchFingerprint["members"] = [];
  for (const m of members) {
    const fingerprint = await mintFingerprint(
      m.repoPath,
      m.approvedPaths,
      m.targetBranch
    );
    out.push({ repoPath: m.repoPath, branch: m.branch, fingerprint });
  }
  return { members: out };
}

/**
 * Check an epic-batch grant (3332-5). Layer-1 invalidation dominates (batch
 * invalid); indeterminate next (batch indeterminate); Layer-2 overlaps aggregate
 * (batch overlap, NOT invalid); otherwise valid.
 */
export async function checkBatch(
  batch: BatchFingerprint,
  opts: CheckLayer2Options = {}
): Promise<BatchCheckResult> {
  const l1invalid: Array<{
    repoPath: string;
    branch: string;
    result: Extract<StateCheckResult, { kind: "invalid" }>;
  }> = [];
  let indeterminate: string | null = null;

  // Layer 1 across all members — a definite invalidation dominates.
  for (const m of batch.members) {
    const r = await checkLayer1(m.repoPath, m.fingerprint);
    if (r.kind === "invalid") {
      l1invalid.push({ repoPath: m.repoPath, branch: m.branch, result: r });
    } else if (r.kind === "indeterminate") {
      indeterminate ??= `member ${m.branch}: ${r.reason}`;
    }
  }
  if (l1invalid.length > 0) return { kind: "invalid", members: l1invalid };
  if (indeterminate) return { kind: "indeterminate", reason: indeterminate };

  // Layer 2 across all members — aggregate overlaps for the decision menu.
  const overlaps: Array<{ branch: string; analysis: OverlapAnalysis }> = [];
  for (const m of batch.members) {
    const r = await checkLayer2(m.repoPath, m.fingerprint, opts);
    if (r.kind === "overlap") {
      overlaps.push({ branch: m.branch, analysis: r.analysis });
    } else if (r.kind === "indeterminate") {
      indeterminate ??= `member ${m.branch}: ${r.reason}`;
    }
  }
  if (indeterminate) return { kind: "indeterminate", reason: indeterminate };

  if (overlaps.length > 0) {
    const collided = [
      ...new Set(
        overlaps.flatMap(o =>
          o.analysis.collided_files.map(f => `${o.branch}:${f}`)
        )
      ),
    ];
    const escalation_required = overlaps.some(
      o => o.analysis.escalation_required
    );
    return {
      kind: "overlap",
      members: overlaps.map(o => o.branch),
      analysis: {
        collided_files: collided,
        incoming_change_description: `Target drift overlaps approved files in ${overlaps.length} batch member(s): ${collided.join(
          ", "
        )}.`,
        plausible_interaction_assessment:
          "One or more batch members' approved files collide with target-branch movement; the batch remains a single decision, not a rejection (epic D1a).",
        recommendation: escalation_required
          ? "Escalate to the user: at least one member's collision touches sensitive / subjective surfaces."
          : "Mechanical rebase-and-proceed for every colliding member; no subjective judgment is required.",
        escalation_required,
      },
    };
  }

  return { kind: "valid" };
}

// ── Task 6: hygiene-TTL routing ─────────────────────────────────────────────

/** Days-scale hygiene TTL for fingerprint-less (bypass-class) gates only. */
function checkHygieneTtl(
  gate: GateRecord,
  ttlDays: number,
  now: number
): StateCheckResult {
  if (!gate.minted_at) {
    return {
      kind: "indeterminate",
      reason:
        "fingerprint-less gate has no minted_at timestamp for hygiene TTL",
    };
  }
  const minted = Date.parse(gate.minted_at);
  if (Number.isNaN(minted)) {
    return {
      kind: "indeterminate",
      reason: `unparseable minted_at: ${gate.minted_at}`,
    };
  }
  const ageMs = now - minted;
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  if (ageMs <= ttlMs) return { kind: "valid" };
  return { kind: "invalid", changed: [], reason: "hygiene-expired" };
}

export interface IsValidOptions extends CheckLayer2Options {
  /**
   * Resolved hygiene-TTL in DAYS, injected by the caller (Task 6 keeps the
   * engine pure — it does not read `process.env`). Provide
   * `loadApprovalHygieneConfig().hygieneTtlDays`. Default: 7.
   */
  hygieneTtlDays?: number;
  /** Injectable clock for the hygiene path (default: `Date.now()`). */
  now?: number;
}

const DEFAULT_HYGIENE_TTL_DAYS = 7;

/**
 * The single validity router (R6). A CRISP gate (has a `fingerprint`) is checked
 * by state-binding — Layer 1, then Layer 2 — and carries NO clock. A
 * FINGERPRINT-LESS gate (bypass-class) is governed ONLY by the days-scale
 * hygiene TTL. Pure: it reads the record it is handed and the injected config;
 * it never loads either (R8).
 */
export async function isValid(
  repoPath: string,
  gate: GateRecord,
  opts: IsValidOptions = {}
): Promise<StateCheckResult> {
  if (gate.fingerprint) {
    const l1 = await checkLayer1(repoPath, gate.fingerprint);
    if (l1.kind !== "valid") return l1; // invalid / indeterminate short-circuits
    return checkLayer2(repoPath, gate.fingerprint, opts);
  }
  return checkHygieneTtl(
    gate,
    opts.hygieneTtlDays ?? DEFAULT_HYGIENE_TTL_DAYS,
    opts.now ?? Date.now()
  );
}
