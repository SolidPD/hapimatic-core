// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ExistingBranch,
  GitBranchListing,
} from "@hapi/protocol/gitBranches";
import type { ApiClient } from "@/api/client";
import { useGitBranches } from "@/hooks/queries/useGitBranches";
import {
  applyBranchChoice,
  branchChoiceFor,
  type BranchChoice,
} from "./branchSelection";
import type { SessionMode, SessionType } from "./types";

/**
 * How the Session section renders the Branch control (hapimatic-private#4481):
 *  - "selector"       — the searchable Branch control (git dir, listing loaded)
 *  - "clone-readonly" — clone-on-spawn repo: read-only "Branch: <default>"
 *  - "none"           — definitively non-git: no Branch control (#2270 unchanged)
 *  - "legacy"         — no directory yet, still loading, or the lookup failed:
 *                       today's UI (Git Type + Branch Name for Worktree)
 */
export type BranchRenderMode =
  | "selector"
  | "clone-readonly"
  | "none"
  | "legacy";

/**
 * hapimatic-private#4481: owns the Create page's existing-branch selection and
 * its coupling to Git Type. Kept out of `index.tsx` (already over the #2077
 * line guardrail). Invariants: a RAW Basic session never carries an existing
 * branch — Basic runs in place on the current branch (ruling D5b) — and neither
 * does a Scheduled one: Scheduled runs can't reuse an existing branch yet, and
 * the schedule request carries no branch, so a kept pick would be silently
 * replaced by a new branch on every run.
 */
export function useBranchSelection(args: {
  api: ApiClient | null;
  directory: string;
  nodeId: string | null;
  sessionMode: SessionMode;
  sessionType: SessionType;
  setSessionType: (value: SessionType) => void;
  setSessionTypeUserSelected: (value: boolean) => void;
  /** Marks a field touched in the defaults engine (cancels its restore). */
  markTouched: (id: string) => void;
  /** A clone-on-spawn repo is selected (Standard mode). */
  cloneLocked: boolean;
  /** F25 git-ness tri-state from the repo-issues lookup. */
  directoryIsGitRepo: boolean | undefined;
  /** Retry-form restore (#3515 R4). */
  initialExistingBranch?: ExistingBranch | null;
}): {
  existingBranch: ExistingBranch | null;
  listing: GitBranchListing | undefined;
  listingUnavailable: boolean;
  renderMode: BranchRenderMode;
  choice: BranchChoice;
  /** A user (or restore) pick in the Branch control. */
  selectBranch: (choice: BranchChoice, opts?: { restore?: boolean }) => void;
  /** Call from the Git Type control's change handler (direct type change). */
  onGitTypeChange: () => void;
} {
  const {
    api,
    directory,
    nodeId,
    sessionMode,
    sessionType,
    setSessionType,
    setSessionTypeUserSelected,
    markTouched,
    cloneLocked,
    directoryIsGitRepo,
  } = args;
  const [existingBranch, setExistingBranch] = useState<ExistingBranch | null>(
    () => args.initialExistingBranch ?? null
  );

  const { listing, unavailable } = useGitBranches(api, directory, nodeId, {
    enabled: !cloneLocked,
  });

  // A branch belongs to one directory on one node — drop it when either changes
  // (skipping the first run so a retry-form restore survives mount).
  const targetKey = `${nodeId ?? ""}\u0000${directory.trim()}`;
  const prevKeyRef = useRef(targetKey);
  useEffect(() => {
    if (prevKeyRef.current === targetKey) return;
    prevKeyRef.current = targetKey;
    setExistingBranch(null);
  }, [targetKey]);

  // Raw Basic ⇒ no existing branch (covers target resets, clone locks, restores).
  useEffect(() => {
    if (sessionType === "simple") setExistingBranch(null);
  }, [sessionType]);

  // Scheduled ⇒ no existing branch — the same rule that disables those rows in
  // the list. Keyed on both values so a mode switch AND a bookmark restore (in
  // either field order) land on "New branch…" instead of a kept, unused pick.
  useEffect(() => {
    if (sessionMode === "scheduled" && existingBranch) setExistingBranch(null);
  }, [sessionMode, existingBranch]);

  const selectBranch = useCallback(
    (choice: BranchChoice, opts?: { restore?: boolean }) => {
      const next = applyBranchChoice(choice);
      setExistingBranch(next.existingBranch);
      setSessionType(next.sessionType);
      setSessionTypeUserSelected(true);
      if (!opts?.restore) {
        markTouched("branch");
        markTouched("gitType");
      }
    },
    [setSessionType, setSessionTypeUserSelected, markTouched]
  );

  const onGitTypeChange = useCallback(() => {
    // Basic → current branch; Worktree → "New branch…". Both clear the pick.
    setExistingBranch(null);
    markTouched("branch");
  }, [markTouched]);

  const renderMode: BranchRenderMode = useMemo(() => {
    if (cloneLocked) return "clone-readonly";
    if (!directory.trim()) return "legacy";
    if (listing?.isGitRepo) return "selector";
    if (listing && !listing.isGitRepo) return "none";
    if (directoryIsGitRepo === false) return "none";
    return "legacy";
  }, [cloneLocked, directory, listing, directoryIsGitRepo]);

  return {
    existingBranch,
    listing,
    listingUnavailable: unavailable,
    renderMode,
    choice: branchChoiceFor(sessionType, existingBranch),
    selectBranch,
    onGitTypeChange,
  };
}
