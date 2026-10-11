// SPDX-License-Identifier: AGPL-3.0-only
import { isAbsolute, resolve, sep } from "node:path";
import { isSafeMachinePath, machinePathDenial } from "../utils/pathSecurity";

/**
 * Destination containment for the Configuration Porter import path (issue #2343,
 * epic #2339 Sub D, R7 / AC-7 — the real zip-slip guard).
 *
 * 🔴 Why this exists, and why `isSafeMachinePath` is NOT enough (directive D3):
 * `server/src/utils/pathSecurity.ts` is a DENYLIST of known-sensitive prefixes
 * and path parts (`/etc`, `.ssh`, `.config`, …). It answers "is this an obviously
 * dangerous location?" — it CANNOT answer "does this resolved path stay under the
 * intended destination directory?". An archive entry resolving to a
 * non-denylisted location OUTSIDE the destination root passes `isSafeMachinePath`
 * today. This module answers the containment question directly, and keeps
 * `isSafeMachinePath` as defence-in-depth alongside it, not instead of it.
 *
 * The archive is UNTRUSTED input (it arrived from a machine Hapimatic does not
 * control) and its contents are EXECUTABLE configuration the instance later runs,
 * so containment precedes any filesystem write — validate-before-write.
 *
 * Issue #4172: on the IMPORT path ({@link assertSafeEntry}) the denylist applies
 * to the destination ROOT and to system prefixes only — never to a path part
 * inside the root. A contained `skills/x/.config/app.json` is an honest file; a
 * credential-bearing name inside the root is skipped per member by the planners
 * instead (`credentialPathPart`, ./planSections, ./plannedDestinations). The
 * read surface keeps {@link assertContained}'s whole-path denylist unchanged.
 */

/** The kind of an archive member, as classified by the tar parser. */
export type ArchiveEntryKind =
  | "file"
  | "directory"
  | "symlink"
  | "hardlink"
  | "other";

/**
 * Thrown when an archive-supplied path would resolve outside the intended
 * destination root, is absolute, contains a `..` segment or NUL byte, is a
 * symlink/hardlink/link member, or fails the {@link isSafeMachinePath} denylist.
 * A single typed error so callers reject-with-zero-bytes on any escape.
 */
export class PathEscapeError extends Error {
  readonly destRoot: string;
  readonly candidate: string;
  readonly reason: string;
  constructor(destRoot: string, candidate: string, reason: string) {
    super(
      `Refusing archive path ${JSON.stringify(candidate)} (${reason}); it does ` +
        `not stay under the destination root ${JSON.stringify(destRoot)}.`
    );
    this.name = "PathEscapeError";
    this.destRoot = destRoot;
    this.candidate = candidate;
    this.reason = reason;
  }
}

/**
 * Split an archive-relative path into POSIX/Win path segments. Tar archives are
 * POSIX (`/`), but we also split on `\` so a Windows-style escape in a hostile
 * archive cannot smuggle a `..` past the segment check.
 */
function segments(p: string): string[] {
  return p.split(/[/\\]/);
}

/**
 * A path inside the destination root whose root is itself denylisted, or that
 * resolves under a denylisted system prefix (issue #4172). Still a
 * {@link PathEscapeError} — same `name`, so the route's 400 mapping and the wire
 * `kind` are unchanged — with a message that names the offending part and does
 * not claim the path left the root.
 */
export class DenylistedDestinationError extends PathEscapeError {
  constructor(
    destRoot: string,
    candidate: string,
    denial: { match: string },
    where: "root" | "prefix"
  ) {
    super(
      destRoot,
      candidate,
      where === "root"
        ? `the destination root is a denylisted system location (${denial.match})`
        : `resolves under the denylisted system location ${denial.match}`
    );
    this.message =
      where === "root"
        ? `Refusing to import into ${JSON.stringify(destRoot)}: the destination root is a denylisted system location (${denial.match}).`
        : `Refusing archive path ${JSON.stringify(candidate)}: it resolves under the denylisted system location ${denial.match}.`;
  }
}

/**
 * The lexical half of containment: reject NUL / empty / absolute / `..`, then
 * resolve and require the result to be `destRoot` or strictly under it. Shared
 * by {@link assertContained} and {@link assertSafeEntry}, which then apply their
 * own denylist rule.
 */
function containLexically(
  destRoot: string,
  candidate: string
): { normDest: string; resolved: string } {
  if (candidate.includes("\0")) {
    throw new PathEscapeError(destRoot, candidate, "contains a NUL byte");
  }
  if (candidate.length === 0) {
    throw new PathEscapeError(destRoot, candidate, "is empty");
  }
  if (isAbsolute(candidate)) {
    throw new PathEscapeError(destRoot, candidate, "is an absolute path");
  }
  if (segments(candidate).some(s => s === "..")) {
    throw new PathEscapeError(destRoot, candidate, "contains a '..' segment");
  }

  const normDest = resolve(destRoot);
  const resolved = resolve(normDest, candidate);

  if (resolved !== normDest && !resolved.startsWith(normDest + sep)) {
    throw new PathEscapeError(
      destRoot,
      candidate,
      "resolves outside the destination root"
    );
  }
  return { normDest, resolved };
}

/**
 * Resolve `candidate` (an archive-relative path) against `destRoot` and assert it
 * stays strictly under `destRoot`. Returns the resolved ABSOLUTE path on success.
 *
 * Rejects, with a typed {@link PathEscapeError}:
 *  - a NUL byte anywhere in the path;
 *  - an absolute candidate (`isAbsolute`) — `resolve(dest, "/etc/x")` would
 *    REPLACE `dest` entirely, so this is checked explicitly for a clear error;
 *  - any `..` path segment — rejected outright rather than normalised, so a
 *    deeply-nested `../../../` chain cannot climb out;
 *  - a resolved path that is not `destRoot` and does not start with
 *    `destRoot + sep` (the definitive containment check — belt to the `..`
 *    braces above, and it also catches symlink-free escapes that `resolve`
 *    collapses);
 *  - a resolved path the {@link isSafeMachinePath} denylist rejects (defence in
 *    depth — catches a destination root that is itself wrong, e.g. one that
 *    lands under `/etc`).
 *
 * The whole-path denylist stays on this function (issue #4172, R6): the
 * read surface `web/routes/porterInstalled.ts` uses it as layer 1 and must keep
 * refusing a read under any `.config`/`.ssh`/… part. The import path uses
 * {@link assertSafeEntry}, which scopes the denylist to the root.
 */
export function assertContained(destRoot: string, candidate: string): string {
  const { resolved } = containLexically(destRoot, candidate);

  // Defence-in-depth denylist — NOT the containment control, but it catches a
  // destination that is itself a sensitive location (directive D3).
  if (!isSafeMachinePath(resolved)) {
    throw new PathEscapeError(
      destRoot,
      candidate,
      "resolves to a denylisted system location"
    );
  }

  return resolved;
}

/**
 * Non-throwing containment predicate — used by the advisory hook-command lint
 * (which must never abort an import) and by callers that want to test
 * containment without a `try`/`catch`.
 */
export function isContained(destRoot: string, candidate: string): boolean {
  try {
    assertContained(destRoot, candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Full per-entry archive safety gate: containment ({@link assertContained}) PLUS
 * a link-kind rejection. Symlink and hardlink members are refused outright — a
 * symlink member is a classic escape vector (its target can point anywhere, and
 * a later write THROUGH it escapes containment even though its own path is
 * contained). Returns the resolved absolute path for a `file`/`directory` entry.
 *
 * This is the single decision point `importArchive` calls for every archive
 * member before materialising it into the staging tree.
 *
 * Issue #4172: after lexical containment, the denylist is applied to the
 * destination ROOT (a root that is itself sensitive refuses the archive) and to
 * system PREFIXES on the resolved path (a root such as `/var` must not reach
 * `/var/log`), but NOT to path parts inside the root — containment governs
 * there, so `skills/x/.config/app.json` imports. Credential-bearing names inside
 * the root are handled per member by the planners, never here.
 */
export function assertSafeEntry(
  destRoot: string,
  entry: { path: string; kind: ArchiveEntryKind }
): string {
  if (entry.kind === "symlink" || entry.kind === "hardlink") {
    throw new PathEscapeError(
      destRoot,
      entry.path,
      `is a ${entry.kind} member (links are refused outright)`
    );
  }
  if (entry.kind === "other") {
    throw new PathEscapeError(
      destRoot,
      entry.path,
      "is not a regular file or directory member"
    );
  }
  const { normDest, resolved } = containLexically(destRoot, entry.path);

  const rootDenial = machinePathDenial(normDest);
  if (rootDenial !== null) {
    throw new DenylistedDestinationError(
      destRoot,
      entry.path,
      rootDenial,
      "root"
    );
  }
  const denial = machinePathDenial(resolved);
  if (denial?.kind === "prefix") {
    throw new DenylistedDestinationError(
      destRoot,
      entry.path,
      denial,
      "prefix"
    );
  }
  return resolved;
}

/**
 * ADVISORY hook-command containment lint (directive Task 2 / Open Risks).
 *
 * A hook `command` is an arbitrary shell string (pipelines, env-var prefixes,
 * multi-token lines), so "the referenced script path" is not well-defined and
 * cannot be a hard guarantee. This is best-effort: extract obvious path tokens
 * and return those that resolve OUTSIDE `destRoot`. The result is a set of
 * WARNINGS the import summary surfaces — NEVER an error and never a write block.
 * The actual control for hook commands is the import review summary
 * (`ImportPlanSummary.hooks.commands`, #2600), which surfaces each hook command
 * verbatim for the reviewer to inspect; this lint is only an advisory
 * path-containment supplement.
 *
 * A token is "obvious" when it looks like a filesystem path: it starts with `/`,
 * `~/`, `./`, `../`, or `$HOME/`, or contains a `/` and a config-root marker
 * (`.claude/`). Everything else (flags, env assignments, bare command names) is
 * ignored — a false negative here is acceptable because this is advisory.
 */
export function lintHookCommandContainment(
  destRoot: string,
  command: string
): string[] {
  const warnings: string[] = [];
  // Split on shell whitespace; strip surrounding quotes from each token.
  const tokens = command
    .split(/\s+/)
    .map(t => t.replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);

  const normDest = resolve(destRoot);
  for (const token of tokens) {
    const looksLikePath =
      token.startsWith("/") ||
      token.startsWith("~/") ||
      token.startsWith("./") ||
      token.startsWith("../") ||
      token.startsWith("$HOME/") ||
      (token.includes("/") && token.includes(".claude/"));
    if (!looksLikePath) continue;

    // Only reason about ALREADY-DESTINATION-EXPANDED tokens: a token pointing at
    // an absolute path under destRoot is fine; anything else is flagged. We do
    // NOT expand $HOME/~ here (that is the caller's denormalisation step) — an
    // unexpanded token that is not under destRoot is exactly what to warn about.
    let resolved: string;
    try {
      resolved = isAbsolute(token) ? resolve(token) : resolve(normDest, token);
    } catch {
      continue;
    }
    if (resolved !== normDest && !resolved.startsWith(normDest + sep)) {
      warnings.push(
        `hook command references a path outside the destination: ${token}`
      );
    }
  }
  return warnings;
}
