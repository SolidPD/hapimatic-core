// SPDX-License-Identifier: MIT AND AGPL-3.0-only
import { dirname, relative, resolve, sep } from "path";
import { existsSync, realpathSync } from "fs";
import { homedir } from "os";

export interface PathValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates paths for machine-level browsing, enforcing a blacklist of sensitive
 * system paths and user-specific hidden files to prevent unauthorized access.
 * @param targetPath - The path to validate (absolute path expected)
 * @returns boolean indicating if the path is safe
 */
export function isSafeMachinePath(targetPath: string): boolean {
  const resolvedTarget = resolve(targetPath);
  const normalizedTarget =
    process.platform === "win32"
      ? resolvedTarget.toLowerCase()
      : resolvedTarget;

  const blacklistPrefixes = [
    "/etc",
    "/root",
    "/var/log",
    "/var/shadow",
    "c:\\windows\\system32",
    "c:\\windows\\syswow64",
  ];

  const targetParts = normalizedTarget.split(sep);

  const sensitiveComponents = [
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".env",
    ".bash_history",
    ".zsh_history",
  ];
  if (
    targetParts.some(
      part =>
        sensitiveComponents.includes(part) ||
        // issue #2715 (sweep finding 2715-6): .env.local / .env.production hold
        // the same secrets as .env but slip past the exact-component match. The
        // new delete/rename ops raise the stakes (rename(".env.local", "x.txt")
        // would move a secret out of the deny-list), so block the .env.<suffix>
        // family too. Deliberately NOT .envrc / .environment — those are not
        // .env dotfiles, and over-blocking them would be a false positive.
        part.startsWith(".env.")
    )
  ) {
    return false;
  }

  for (const prefix of blacklistPrefixes) {
    const normalizedPrefix =
      process.platform === "win32" ? prefix.toLowerCase() : prefix;

    if (
      normalizedTarget === normalizedPrefix ||
      normalizedTarget.startsWith(normalizedPrefix + sep)
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Validates that a path is within the allowed working directory
 * @param targetPath - The path to validate (can be relative or absolute)
 * @param workingDirectory - The session's working directory (must be absolute)
 * @returns Validation result
 */
export function validatePath(
  targetPath: string,
  workingDirectory: string
): PathValidationResult {
  // Resolve both paths to absolute paths to handle path traversal attempts
  const resolvedTarget = resolve(workingDirectory, targetPath);
  const resolvedWorkingDir = resolve(workingDirectory);

  // Check if the resolved target path starts with the working directory
  // This prevents access to files outside the working directory
  const normalizedTarget =
    process.platform === "win32"
      ? resolvedTarget.toLowerCase()
      : resolvedTarget;
  const normalizedWorkingDir =
    process.platform === "win32"
      ? resolvedWorkingDir.toLowerCase()
      : resolvedWorkingDir;
  const workingDirPrefix = normalizedWorkingDir.endsWith(sep)
    ? normalizedWorkingDir
    : normalizedWorkingDir + sep;

  if (
    normalizedTarget !== normalizedWorkingDir &&
    !normalizedTarget.startsWith(workingDirPrefix)
  ) {
    return {
      valid: false,
      error: `Access denied: Path '${targetPath}' is outside the working directory`,
    };
  }

  // Layer 2 (issue #2518): realpath containment — defeats symlink-escape.
  // The string check above passes a symlink INSIDE the working dir that points
  // OUTSIDE it, because it never follows the link. Resolve the target's real
  // path and re-check containment. For a not-yet-existing write target, realpath
  // the nearest EXISTING ancestor (a path that doesn't exist can't be a symlink)
  // and re-join the non-existing tail — resolve() already collapsed any `..`, so
  // the tail introduces no traversal. Fail closed if realpath cannot be taken.
  let realWorkingDir: string;
  try {
    realWorkingDir = realpathSync(resolvedWorkingDir);
  } catch {
    // The working directory does not exist / is unreadable — there is no real
    // filesystem to symlink-escape through, so the string-level containment
    // above is the guarantee (this also keeps validatePath usable when the
    // working dir has not been created yet).
    return { valid: true };
  }

  try {
    let existingAncestor = resolvedTarget;
    while (!existsSync(existingAncestor)) {
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) break; // reached the filesystem root
      existingAncestor = parent;
    }
    const realExisting = realpathSync(existingAncestor);
    const tail = relative(existingAncestor, resolvedTarget);
    const realTarget = tail ? resolve(realExisting, tail) : realExisting;

    const normReal =
      process.platform === "win32" ? realTarget.toLowerCase() : realTarget;
    const normRealWorkingDir =
      process.platform === "win32"
        ? realWorkingDir.toLowerCase()
        : realWorkingDir;
    const realWorkingDirPrefix = normRealWorkingDir.endsWith(sep)
      ? normRealWorkingDir
      : normRealWorkingDir + sep;

    if (
      normReal !== normRealWorkingDir &&
      !normReal.startsWith(realWorkingDirPrefix)
    ) {
      return {
        valid: false,
        error: `Access denied: Path '${targetPath}' escapes the working directory via a symlink`,
      };
    }
  } catch {
    return {
      valid: false,
      error: `Access denied: could not verify the real path of '${targetPath}'`,
    };
  }

  return { valid: true };
}

/**
 * issue #2715 (sweep finding 2715-1): `validatePath` permits the target to
 * EQUAL the working-directory root by design — both its string layer and its
 * realpath layer `return { valid: true }` when `resolvedTarget ===
 * resolvedWorkingDir`. That is correct for read / list / write (V1 survives a
 * `"."` target only by accident: read fails `isFile()`, write fails `EISDIR`),
 * but a mutating op — above all `fs.rm(cwd, { recursive: true })` — has no such
 * backstop and would wipe the entire session workspace in one call.
 *
 * This is a pure `resolve()` string comparison with NO `realpathSync`, so it is
 * safe to reuse on the server / federation side for a REMOTE session (unlike
 * `validatePath`, whose realpath layer silently degrades there). Every mutating
 * file op MUST reject a target for which this returns `true`, in addition to
 * the `validatePath` containment check.
 *
 * @returns true when `targetPath` resolves to the working-directory root itself.
 */
export function isWorkingDirectoryRoot(
  targetPath: string,
  workingDirectory: string
): boolean {
  const resolvedTarget = resolve(workingDirectory, targetPath);
  const resolvedWorkingDir = resolve(workingDirectory);
  const norm = (p: string) =>
    process.platform === "win32" ? p.toLowerCase() : p;
  return norm(resolvedTarget) === norm(resolvedWorkingDir);
}

// ── Issue #3498: machine-level create-directory guard ─────────────────────────
// The new machine-level create-directory RPC (cli/src/api/apiMachine.ts) and the
// federation create receiver (server/src/web/routes/federation/infrastructure.ts)
// must reject a create target that EITHER the cli OR the server browse deny-list
// would reject — the UNION — applied to the REAL (realpath'd) target.
//
// Why a create-SPECIFIC guard and not a one-array edit of isSafeMachinePath (the
// directive's literal Task-1 mechanic): the two isSafeMachinePath copies diverge
// (cli lacks /proc /sys /dev /boot /tmp + .netrc/.git-credentials/.npmrc/.pypirc/
// .docker/.config; server lacks the .env.* family) AND isSafeMachinePath is shared
// by browse + the #2715 session file ops, whose test suite legitimately operates
// under /tmp — narrowing the shared browse deny-list would red the cli suite. This
// guard keeps browse/session-ops byte-identical while the CREATE handlers enforce
// the union (ruling D9, Option A: "the CREATE handlers enforce the UNION"). Both
// isSafeMachinePath copies are lexical (resolve() + string prefix, no realpathSync),
// so a symlinked ancestor (~/link -> /var/log) would smuggle a mkdir past either
// list; this guard realpaths the deepest existing ancestor first.
const CREATE_DENY_PREFIXES = [
  "/etc",
  "/root",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/tmp",
  "/var/log",
  "/var/shadow",
  "c:\\windows\\system32",
  "c:\\windows\\syswow64",
];

const CREATE_DENY_COMPONENTS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".env",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".docker",
  ".config",
  ".bash_history",
  ".zsh_history",
];

/**
 * The UNION deny-list check for a CREATE target (issue #3498). Applied to the
 * REAL, realpath-resolved absolute path (see `validateCreateDirectoryTarget`).
 * Mirrors `isSafeMachinePath`'s structure but with the union of the cli + server
 * deny-lists (incl. the `.env.<suffix>` family). Returns TRUE when the path is
 * DENIED (inverted sense vs `isSafeMachinePath`, which returns true for SAFE).
 */
export function isDeniedCreatePath(realTarget: string): boolean {
  const normalized =
    process.platform === "win32" ? realTarget.toLowerCase() : realTarget;
  const parts = normalized.split(sep);
  if (
    parts.some(
      part => CREATE_DENY_COMPONENTS.includes(part) || part.startsWith(".env.")
    )
  ) {
    return true;
  }
  for (const prefix of CREATE_DENY_PREFIXES) {
    const normalizedPrefix =
      process.platform === "win32" ? prefix.toLowerCase() : prefix;
    if (
      normalized === normalizedPrefix ||
      normalized.startsWith(normalizedPrefix + sep)
    ) {
      return true;
    }
  }
  return false;
}

export interface CreateTargetValidation {
  ok: boolean;
  /** The realpath-resolved absolute target to `mkdir` (present iff `ok`). */
  target?: string;
  /** Human-readable rejection reason (present iff `!ok`). */
  error?: string;
}

/**
 * Validate a machine-level create-directory target (issue #3498). Guard order,
 * matching directive R3:
 *   1. reject NUL anywhere BEFORE resolve() (Node otherwise throws
 *      `ERR_INVALID_ARG_VALUE` late, after the guard);
 *   2. tilde-expand + normalize (resolve() collapses any `..`);
 *   3. walk to the deepest EXISTING ancestor, realpath it, re-join the tail —
 *      defeats a symlinked-ancestor escape (the deny-list is lexical); fail
 *      CLOSED if realpath throws;
 *   4. run the UNION deny-list on the REAL target;
 *   5. validate every tail segment beyond the deepest existing ancestor
 *      (reject empty / `.` / `..` / a segment >255 chars).
 * Returns the realpath-resolved target to `mkdir` on success.
 */
export function validateCreateDirectoryTarget(
  rawPath: unknown
): CreateTargetValidation {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return { ok: false, error: "Path is required" };
  }
  // 1. NUL before resolve()
  if (rawPath.includes("\0")) {
    return { ok: false, error: "Invalid directory name" };
  }
  // 2. tilde-expand + normalize
  let expanded = rawPath.trim();
  if (expanded.startsWith("~/")) {
    expanded = `${homedir()}/${expanded.slice(2)}`;
  } else if (expanded === "~") {
    expanded = homedir();
  }
  const target = resolve(expanded);

  // 3. realpath the deepest existing ancestor, re-join the tail (fail closed).
  let realTarget: string;
  let tail: string;
  try {
    let existingAncestor = target;
    while (!existsSync(existingAncestor)) {
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) break; // reached the filesystem root
      existingAncestor = parent;
    }
    const realExisting = realpathSync(existingAncestor);
    tail = relative(existingAncestor, target);
    realTarget = tail ? resolve(realExisting, tail) : realExisting;
  } catch {
    return { ok: false, error: "Access denied to this path" };
  }

  // 4. union deny-list on the REAL target
  if (isDeniedCreatePath(realTarget)) {
    return { ok: false, error: "Access denied to this path" };
  }

  // 5. tail-segment validation (the segments being newly created). resolve()
  // already collapsed `.`/`..`, so those arms are defensive; the length cap is
  // the load-bearing check (a >255-char segment fails mkdir with ENAMETOOLONG).
  if (tail) {
    for (const seg of tail.split(sep)) {
      if (seg === "" || seg === "." || seg === "..") {
        return { ok: false, error: "Invalid directory name" };
      }
      if (seg.length > 255) {
        return { ok: false, error: "Directory name is too long" };
      }
    }
  }

  return { ok: true, target: realTarget };
}
