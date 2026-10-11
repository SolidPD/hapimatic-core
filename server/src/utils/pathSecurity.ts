// SPDX-License-Identifier: AGPL-3.0-only
import { dirname, relative, resolve, sep } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";

/**
 * Validates paths for machine-level browsing, enforcing a blacklist of sensitive
 * system paths and user-specific hidden files to prevent unauthorized access.
 *
 * Duplicated from cli/src/modules/common/pathSecurity.ts — both packages need
 * this function but the shared package (@hapi/protocol) is consumed by the web
 * frontend's Vite browser build, which cannot use Node.js `path` module.
 *
 * @param targetPath - The path to validate (absolute path expected)
 * @returns boolean indicating if the path is safe
 */
export function isSafeMachinePath(targetPath: string): boolean {
  return machinePathDenial(targetPath) === null;
}

const MACHINE_DENY_PREFIXES = [
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

const MACHINE_DENY_COMPONENTS = [
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
 * Why {@link isSafeMachinePath} rejects `targetPath`, or `null` when it is safe
 * — the same checks in the same order (a denylisted path component first, then
 * a denylisted prefix), so the two can never disagree. Callers use it to name
 * the offending part in a refusal (issue #4172).
 */
export function machinePathDenial(
  targetPath: string
): { kind: "component" | "prefix"; match: string } | null {
  const resolvedTarget = resolve(targetPath);
  const normalizedTarget =
    process.platform === "win32"
      ? resolvedTarget.toLowerCase()
      : resolvedTarget;

  const component = normalizedTarget
    .split(sep)
    .find(part => MACHINE_DENY_COMPONENTS.includes(part));
  if (component !== undefined) {
    return { kind: "component", match: component };
  }

  for (const prefix of MACHINE_DENY_PREFIXES) {
    const normalizedPrefix =
      process.platform === "win32" ? prefix.toLowerCase() : prefix;

    if (
      normalizedTarget === normalizedPrefix ||
      normalizedTarget.startsWith(normalizedPrefix + sep)
    ) {
      return { kind: "prefix", match: prefix };
    }
  }

  return null;
}

// ── Issue #3498: federation-node create-directory guard ───────────────────────
// Duplicated from cli/src/modules/common/pathSecurity.ts (same reason
// isSafeMachinePath is duplicated: @hapi/protocol can't use node:fs in the
// browser build). The federation create receiver
// (server/src/web/routes/federation/infrastructure.ts) must reject a create
// target that EITHER the cli OR the server browse deny-list would reject — the
// UNION — applied to the REAL (realpath'd) target. A create-SPECIFIC guard, not a
// narrowing of the shared isSafeMachinePath browse function (whose extra entries
// vs the cli copy are already the union on the SERVER side; the only cli-only
// addition is the .env.* family, included below). Both isSafeMachinePath copies
// are lexical (no realpathSync), so a symlinked ancestor would smuggle a mkdir
// past either list; this guard realpaths the deepest existing ancestor first.
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
 * The UNION deny-list check for a CREATE target (issue #3498), applied to the
 * REAL realpath-resolved absolute path (see `validateCreateDirectoryTarget`).
 * Returns TRUE when the path is DENIED (inverted sense vs `isSafeMachinePath`).
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
 * Validate a federation-node create-directory target (issue #3498). Guard order:
 * NUL-reject before resolve() → tilde-expand + normalize → realpath the deepest
 * existing ancestor + re-join the tail (fail CLOSED) → UNION deny-list on the
 * REAL target → tail-segment validation. Returns the realpath-resolved target to
 * `mkdir` on success. Byte-for-byte the cli sibling.
 */
export function validateCreateDirectoryTarget(
  rawPath: unknown
): CreateTargetValidation {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return { ok: false, error: "Path is required" };
  }
  if (rawPath.includes("\0")) {
    return { ok: false, error: "Invalid directory name" };
  }
  let expanded = rawPath.trim();
  if (expanded.startsWith("~/")) {
    expanded = `${homedir()}/${expanded.slice(2)}`;
  } else if (expanded === "~") {
    expanded = homedir();
  }
  const target = resolve(expanded);

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

  if (isDeniedCreatePath(realTarget)) {
    return { ok: false, error: "Access denied to this path" };
  }

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
