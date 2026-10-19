// SPDX-License-Identifier: AGPL-3.0-only
import {
  slugBranchName,
  validateBranchName,
  type ExistingBranch,
  type GitBranchEntry,
  type GitBranchListing,
  type GitCurrentRef,
} from "@hapi/protocol/gitBranches";
import type { SessionMode, SessionType } from "./types";
import { trimTrailingChars } from "@hapi/protocol";

/**
 * hapimatic-private#4481 — the Create-page Branch control's pure model.
 *
 * Raw state stays today's `sessionType` + `worktreeName` (the NEW-branch name)
 * plus ONE new field, `existingBranch`. With `existingBranch === null` every
 * spawn is byte-identical to pre-#4481. The control's value is DERIVED:
 *
 *   Basic                          → "current"  (runs in place on its branch)
 *   Worktree + existingBranch      → that branch (worktree on an existing branch)
 *   Worktree + no existingBranch   → "new"      (today's Worktree behavior)
 *
 * Operator ruling D5b: Basic never switches a branch in place, so choosing any
 * branch other than the current one forces Worktree, and choosing the current
 * branch forces Basic (git cannot check out one branch in two worktrees).
 */
export type BranchChoice =
  | { kind: "current" }
  | { kind: "new" }
  | { kind: "existing"; branch: ExistingBranch };

export type BranchSelectionState = {
  sessionType: SessionType;
  existingBranch: ExistingBranch | null;
  sessionTypeUserSelected: boolean;
};

/** The control's displayed value for the current raw state. */
export function branchChoiceFor(
  sessionType: SessionType,
  existingBranch: ExistingBranch | null
): BranchChoice {
  if (sessionType === "simple") return { kind: "current" };
  return existingBranch
    ? { kind: "existing", branch: existingBranch }
    : { kind: "new" };
}

/** Next raw state when the user picks a Branch option. */
export function applyBranchChoice(choice: BranchChoice): BranchSelectionState {
  switch (choice.kind) {
    case "current":
      return {
        sessionType: "simple",
        existingBranch: null,
        sessionTypeUserSelected: true,
      };
    case "new":
      return {
        sessionType: "worktree",
        existingBranch: null,
        sessionTypeUserSelected: true,
      };
    case "existing":
      return {
        sessionType: "worktree",
        existingBranch: choice.branch,
        sessionTypeUserSelected: true,
      };
  }
}

/**
 * Next `existingBranch` when the user changes Git Type directly: Basic resets
 * the Branch to current; Worktree selects "New branch…". Both clear it.
 */
export function existingBranchAfterGitTypeChange(_value: SessionType): null {
  return null;
}

/** True when two existing-branch picks name the same branch. */
export function sameBranch(
  a: ExistingBranch | null,
  b: ExistingBranch | null
): boolean {
  return Boolean(a && b && a.name === b.name && a.remote === b.remote);
}

export const SCHEDULED_EXISTING_BRANCH_REASON =
  "Scheduled runs can't reuse an existing branch yet";

/** Whether a listed branch can be picked, and why not. */
export function branchOptionState(
  entry: GitBranchEntry,
  ctx: { sessionMode: SessionMode }
): { disabled: boolean; reason: string | null } {
  if (entry.checkedOutAt) {
    return { disabled: true, reason: `checked out in ${entry.checkedOutAt}` };
  }
  if (ctx.sessionMode === "scheduled") {
    return { disabled: true, reason: SCHEDULED_EXISTING_BRANCH_REASON };
  }
  return { disabled: false, reason: null };
}

/** Human label for the directory's current ref. */
export function currentRefLabel(current: GitCurrentRef | null): string | null {
  if (!current) return null;
  switch (current.kind) {
    case "branch":
      return current.name;
    case "unborn":
      return `${current.name} (no commits yet)`;
    case "detached":
      return `detached HEAD at ${current.sha}`;
  }
}

/** Last path segment of a directory, for compact copy (`~/projects/x` → `x`). */
export function directoryLabel(directory: string): string {
  const trimmed = trimTrailingChars(directory.trim(), "/");
  const last = trimmed.split("/").pop();
  return last || trimmed || "this directory";
}

/** The inline note shown when a non-current branch forces Worktree. */
export function worktreeSwitchNote(
  directory: string,
  current: GitCurrentRef | null
): string {
  const label = currentRefLabel(current) ?? "its current branch";
  return `Other branches open in a worktree so ${directoryLabel(directory)} stays on ${label} for other sessions.`;
}

export type NewBranchFeedback = {
  /** Blocks Create when set. */
  error: string | null;
  /** The name the daemon will actually create, when it differs from the input. */
  slugHint: string | null;
  /** An existing branch the (slugged) name collides with — non-blocking. */
  collision: ExistingBranch | null;
  /**
   * Why `collision` can't be picked here (held by another worktree, Scheduled
   * mode) — the same rule that disables its row in the Branch list. Set ⇒ the
   * page explains instead of offering "Use existing branch".
   */
  collisionBlockedReason: string | null;
  /** The collision is the directory's current branch (pick Basic instead). */
  collidesWithCurrent: boolean;
};

/**
 * Feedback for the "New branch…" name field. Empty is valid (the daemon
 * generates a name). The daemon slugs names (`Feature/X` → `feature-x`), so the
 * hint shows the real result, and a collision is computed on the slug. The
 * daemon silently suffixes a name that collides with a LOCAL branch; for a
 * remote-only collision it creates a same-named local branch that does not
 * track origin (it checks `refs/heads/` only). Either way the page offers reuse
 * instead, but only of a branch the Branch list would let the user pick.
 */
export function newBranchFeedback(
  name: string,
  listing: GitBranchListing | undefined,
  ctx: { sessionMode: SessionMode }
): NewBranchFeedback {
  const empty: NewBranchFeedback = {
    error: null,
    slugHint: null,
    collision: null,
    collisionBlockedReason: null,
    collidesWithCurrent: false,
  };
  const trimmed = name.trim();
  if (!trimmed) return empty;
  const error = validateBranchName(trimmed);
  if (error) return { ...empty, error };
  const slug = slugBranchName(trimmed);
  if (!slug) return { ...empty, error: "Use at least one letter or digit." };
  const slugHint = slug !== trimmed ? slug : null;
  if (!listing) return { ...empty, slugHint };
  const current = listing.current;
  if (current && current.kind !== "detached" && current.name === slug) {
    return { ...empty, slugHint, collidesWithCurrent: true };
  }
  const hit = listing.branches.find(b => b.name === slug);
  if (!hit) return { ...empty, slugHint };
  const state = branchOptionState(hit, ctx);
  return {
    ...empty,
    slugHint,
    collision: { name: hit.name, remote: hit.source === "remote" },
    collisionBlockedReason: !state.disabled
      ? null
      : hit.checkedOutAt
        ? `It's checked out in ${hit.checkedOutAt}.`
        : `${state.reason}.`,
  };
}

/**
 * Whether a restored/bookmarked existing-branch pick is still selectable in the
 * listing: present, not the current branch, not held by another worktree.
 */
export function resolveRestoredBranch(
  wanted: ExistingBranch,
  listing: GitBranchListing
): ExistingBranch | null {
  const current = listing.current;
  if (current && current.kind !== "detached" && current.name === wanted.name)
    return null;
  const hit = listing.branches.find(b => b.name === wanted.name);
  if (!hit || hit.checkedOutAt) return null;
  return { name: hit.name, remote: hit.source === "remote" };
}
