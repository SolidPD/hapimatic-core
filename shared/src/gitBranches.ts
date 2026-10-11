// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

/**
 * Create-page Branch control contract (hapimatic-private#4481).
 *
 * One shared definition consumed by:
 *  - the server runner (`server/src/utils/gitBranches.ts`) that executes git on
 *    the TARGET node and builds a {@link GitBranchListing} from raw output,
 *  - the federation peer receiver / proxy (same payload crosses node boundaries),
 *  - the spawn wire (`existingBranch` field, validated by {@link ExistingBranchSchema}),
 *  - the web Create page (selection model, ref-name validation, slug hint).
 *
 * Everything here is PURE (no I/O) so it is unit-testable with string fixtures.
 */

/** Remote-tracking refs are only listed for this remote (issue scope: `origin`). */
export const BRANCH_REMOTE = "origin";

/** Default cap on listed branches (most recent first); the rest are `truncated`. */
export const BRANCH_LIST_LIMIT = 500;

/**
 * An existing branch picked on the Create page. `remote: true` means the branch
 * exists only as `origin/<name>` — the daemon creates a local tracking branch.
 *
 * `name` must be a valid git branch name (`validateBranchName`, git's own
 * ref-format rules). Every real branch passes, while a crafted value that git
 * would read as a refspec (`+a:b`, a `*` glob) or an option (`-x`) is refused
 * at every API boundary before it reaches `git fetch` / `git worktree add`.
 */
export const ExistingBranchSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(255)
    .refine(n => n === n.trim() && validateBranchName(n) === null, {
      message: "Not a valid git branch name",
    }),
  remote: z.boolean(),
});
export type ExistingBranch = z.infer<typeof ExistingBranchSchema>;

export const GitCurrentRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), name: z.string() }),
  z.object({ kind: z.literal("detached"), sha: z.string() }),
  z.object({ kind: z.literal("unborn"), name: z.string() }),
]);
export type GitCurrentRef = z.infer<typeof GitCurrentRefSchema>;

export const GitBranchEntrySchema = z.object({
  name: z.string(),
  source: z.enum(["local", "remote"]),
  /** Unix seconds of the tip commit, or null when git did not report one. */
  lastCommitAt: z.number().nullable(),
  /** Path of ANOTHER worktree holding this branch (null when free). */
  checkedOutAt: z.string().nullable(),
});
export type GitBranchEntry = z.infer<typeof GitBranchEntrySchema>;

export const GitBranchListingSchema = z.object({
  isGitRepo: z.boolean(),
  repoRoot: z.string().nullable(),
  current: GitCurrentRefSchema.nullable(),
  /** Every branch EXCEPT the current one, most-recent first. */
  branches: z.array(GitBranchEntrySchema),
  truncated: z.boolean(),
});
export type GitBranchListing = z.infer<typeof GitBranchListingSchema>;

/** The listing for a directory that is not a git repository. */
export const NON_GIT_LISTING: GitBranchListing = {
  isGitRepo: false,
  repoRoot: null,
  current: null,
  branches: [],
  truncated: false,
};

/**
 * `git for-each-ref` format the runner uses. Fields are NUL-separated so a ref
 * name can never be confused with a separator; records are newline-separated.
 */
export const FOR_EACH_REF_FORMAT =
  "%(refname)%00%(refname:short)%00%(committerdate:unix)%00%(HEAD)";

export type ParsedRef = {
  /** Full ref, e.g. `refs/heads/feat` or `refs/remotes/origin/feat`. */
  refname: string;
  /** Branch name without the `origin/` prefix. */
  name: string;
  source: "local" | "remote";
  lastCommitAt: number | null;
  /** True for the ref HEAD points at (`%(HEAD)` == `*`). */
  isHead: boolean;
};

const LOCAL_PREFIX = "refs/heads/";
const REMOTE_PREFIX = `refs/remotes/${BRANCH_REMOTE}/`;

/** Parse {@link FOR_EACH_REF_FORMAT} output. Drops `origin/HEAD` and foreign refs. */
export function parseForEachRef(stdout: string): ParsedRef[] {
  const refs: ParsedRef[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [refname = "", , date = "", head = ""] = line.split("\0");
    let source: "local" | "remote";
    let name: string;
    if (refname.startsWith(LOCAL_PREFIX)) {
      source = "local";
      name = refname.slice(LOCAL_PREFIX.length);
    } else if (refname.startsWith(REMOTE_PREFIX)) {
      source = "remote";
      name = refname.slice(REMOTE_PREFIX.length);
      // `refs/remotes/origin/HEAD` is a symbolic pointer, not a branch.
      if (name === "HEAD") continue;
    } else {
      continue;
    }
    if (!name) continue;
    const seconds = Number.parseInt(date, 10);
    refs.push({
      refname,
      name,
      source,
      lastCommitAt: Number.isFinite(seconds) ? seconds : null,
      isHead: head.trim() === "*",
    });
  }
  return refs;
}

/**
 * Parse `git worktree list --porcelain` into branch name → worktree path.
 * Detached and bare worktrees carry no `branch` line and are skipped.
 */
export function parseWorktreePorcelain(stdout: string): Map<string, string> {
  const held = new Map<string, string>();
  let path: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ") && path) {
      const ref = line.slice("branch ".length);
      if (ref.startsWith(LOCAL_PREFIX))
        held.set(ref.slice(LOCAL_PREFIX.length), path);
    } else if (line === "") {
      path = null;
    }
  }
  return held;
}

/**
 * Assemble the listing for the directory whose top-level is `repoRoot`.
 *  - current = the local ref HEAD points at; else `detached` (with `detachedSha`)
 *    or `unborn` (with `unbornName`) when supplied by the runner.
 *  - remote refs whose name matches a local branch are deduplicated away.
 *  - `checkedOutAt` = the holding worktree path, unless it is `repoRoot` itself.
 *  - most-recent first, capped at `limit` (`truncated` when cut).
 */
export function buildBranchListing(args: {
  refs: ParsedRef[];
  worktrees: Map<string, string>;
  repoRoot: string;
  detachedSha?: string | null;
  unbornName?: string | null;
  limit?: number;
}): GitBranchListing {
  const limit = args.limit ?? BRANCH_LIST_LIMIT;
  const headRef = args.refs.find(r => r.isHead && r.source === "local");
  let current: GitCurrentRef | null = null;
  if (headRef) current = { kind: "branch", name: headRef.name };
  else if (args.unbornName) current = { kind: "unborn", name: args.unbornName };
  else if (args.detachedSha)
    current = { kind: "detached", sha: args.detachedSha };

  const currentName =
    current && current.kind !== "detached" ? current.name : null;
  const localNames = new Set(
    args.refs.filter(r => r.source === "local").map(r => r.name)
  );
  const entries: GitBranchEntry[] = [];
  for (const ref of args.refs) {
    if (ref.name === currentName) continue;
    if (ref.source === "remote" && localNames.has(ref.name)) continue;
    const holder =
      ref.source === "local" ? (args.worktrees.get(ref.name) ?? null) : null;
    entries.push({
      name: ref.name,
      source: ref.source,
      lastCommitAt: ref.lastCommitAt,
      checkedOutAt: holder && holder !== args.repoRoot ? holder : null,
    });
  }
  entries.sort((a, b) => (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0));
  return {
    isGitRepo: true,
    repoRoot: args.repoRoot,
    current,
    branches: entries.slice(0, limit),
    truncated: entries.length > limit,
  };
}

/**
 * Validate a NEW branch name the way `git check-ref-format --branch` would,
 * returning an error message or null. Empty is valid (the daemon generates a
 * name). `@` is rejected explicitly: git accepts it because `--branch` expands
 * it to HEAD, but it is never a usable new branch name.
 */
export function validateBranchName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return null;
  if (name === "@" || name === "HEAD") return `"${name}" is reserved by git.`;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name))
    return "Branch names can't contain spaces or any of ~ ^ : ? * [ \\";
  if (name.includes("..")) return 'Branch names can\'t contain "..".';
  if (name.includes("@{")) return 'Branch names can\'t contain "@{".';
  if (name.includes("//")) return 'Branch names can\'t contain "//".';
  if (name.startsWith("-")) return 'Branch names can\'t start with "-".';
  if (name.endsWith("/") || name.endsWith("."))
    return 'Branch names can\'t end with "/" or ".".';
  for (const part of name.split("/")) {
    if (part.startsWith("."))
      return 'No part of a branch name can start with ".".';
    if (part.endsWith(".lock"))
      return 'No part of a branch name can end with ".lock".';
  }
  return null;
}

/**
 * The branch name the daemon will actually create for a NEW branch hint —
 * a byte-for-byte mirror of `toSlug` in `cli/src/daemon/worktree.ts`.
 */
export function slugBranchName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
