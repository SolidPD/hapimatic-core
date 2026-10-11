// SPDX-License-Identifier: AGPL-3.0-only
import type { SessionSummary } from "@/types/api";
import { getSessionTitle } from "@/lib/sessionHelpers";

/**
 * Identity of the live session that has claimed (linked) a given issue.
 * Surfaced in the create-page Link Issue picker so the user can see which
 * issues another session is already working on (#1899).
 */
export type IssueClaimant = {
  sessionId: string;
  title: string;
  emoji?: string | null;
  nodeLabel?: string;
};

/** Stable lookup key for a claimed issue: repo + number (never number alone). */
export function claimedIssueKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

/**
 * Build a lookup of issues currently claimed by a LIVE session.
 *
 * - Only `active` (unarchived/unexited) sessions count — a stale `linkedIssue`
 *   on an inactive session must NOT mark an issue as claimed (R2).
 * - Keyed by `repo#number` so claims never leak across repos (R3).
 * - Pass the MERGED local+remote session list so cross-node claims appear (R4).
 *   `/api/federation/all-sessions` returns remote-only sessions, so callers must
 *   combine `useSessions` (local) with `useFederatedSessions` (remote).
 * - First live claimant wins (deterministic across renders).
 */
export function buildClaimedIssueIndex(
  sessions: SessionSummary[]
): Map<string, IssueClaimant> {
  const index = new Map<string, IssueClaimant>();
  for (const s of sessions) {
    if (!s.active) continue;
    const li = s.linkedIssue;
    if (!li || !li.repo) continue;
    const key = claimedIssueKey(li.repo, li.number);
    if (index.has(key)) continue; // first live claimant wins
    index.set(key, {
      sessionId: s.id,
      title: getSessionTitle(s),
      emoji: s.emoji,
      nodeLabel: s.nodeLabel,
    });
  }
  return index;
}
