// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Choose and Disconnect others (#4469 Task 8, ruling D-4469-3 = A).
 *
 * - **Choose** queues a merge request to exactly the selected peer and changes
 *   no other peer.
 * - **Disconnect others** archives (never deletes) the peers the parent RANKED
 *   minus the winner, through #3815's bulk archive. A parent's `spawn`
 *   children also include a PM's lanes and any other parent-linked spawn
 *   (the spawn route defaults the relationship to "spawn"), so the set is the
 *   ranking — or, with no readable ranking, the view's selection (by default
 *   every live child, so untick lanes to keep them) — never the child list
 *   itself (refresh review R-1).
 *
 * Nothing here deletes a session: a failed merge leaves every peer intact.
 */
import { useCallback } from "react";
import type { ApiClient } from "@/api/client";
import type { BulkSessionResult } from "@hapi/protocol/bulkSessionResult";
import { useBulkSessionAction } from "@/hooks/mutations/useBulkSessionAction";
import { summarizeBulkSessionResult } from "@/lib/bulkSessionToast";
import type { ExperimentPeer } from "./experiment";
import type { RankedReport } from "./rankedReport";
import { neutralizeGateTokens } from "./peerReply";

export const WORKTREE_MERGE_COMMAND = "worktree-merge";

/** The facts Choose needs about the winning peer. */
export type ChosenPeer = Pick<ExperimentPeer, "id" | "flavor" | "branch">;

/** The queue id for a Choose of `winnerId` (dedupes only while queued). */
export function chooseClientId(winnerId: string): string {
  return `fanout-choose:${winnerId}`;
}

/**
 * The peers Disconnect others archives: the ranked ids minus the winner, or
 * — with no readable ranking (none, or the newest is unreadable) — the
 * selection minus the winner.
 */
export function nonWinnerIds(
  winnerId: string,
  ranking: RankedReport | null,
  selection: readonly string[]
): string[] {
  const source = ranking ? ranking.entries.map(e => e.id) : [...selection];
  return Array.from(new Set(source)).filter(id => id !== winnerId);
}

export type MergePromptInput = {
  winner: ChosenPeer;
  /** The parent's branch, the merge target; null when unknown. */
  parentBranch: string | null;
  /** The winner lists the worktree-merge slash command. */
  hasWorktreeMerge: boolean;
};

/** The merge request queued to the chosen peer. */
export function buildMergePrompt(input: MergePromptInput): string {
  const { winner, parentBranch, hasWorktreeMerge } = input;
  const target = parentBranch ?? "the branch this work was cut from";
  const lines: string[] = [
    "Your result was chosen from the fan-out. Merge your work back now.",
    "",
  ];
  if (hasWorktreeMerge) {
    lines.push(
      `Run /${WORKTREE_MERGE_COMMAND} to merge your branch${winner.branch ? ` (${winner.branch})` : ""} into ${target}.`
    );
  } else {
    lines.push(
      `1. Commit any uncommitted work on your branch${winner.branch ? ` (${winner.branch})` : ""}.`,
      `2. Push the branch and open a pull request into ${target} (or merge it into ${target} if this project merges locally).`,
      "3. Report the pull request or merge commit when you are done."
    );
  }
  if (winner.flavor === "codex") {
    lines.push(
      "",
      "A push needs network access. If your sandbox refuses it, say so instead of retrying."
    );
  }
  lines.push(
    "",
    "If the merge fails, stop and report the error. Do not delete or reset anything."
  );
  return neutralizeGateTokens(lines.join("\n"));
}

export type ChooseResult = { result: "inserted" | "deduplicated" };

/** Queue the merge request to the winner. Calls no bulk action. */
export async function chooseWinner(
  api: Pick<ApiClient, "getSlashCommands" | "enqueueQueuedMessage">,
  winner: ChosenPeer,
  parentBranch: string | null
): Promise<ChooseResult> {
  let hasWorktreeMerge = false;
  if (winner.flavor === "claude") {
    try {
      const commands = await api.getSlashCommands(winner.id);
      hasWorktreeMerge = (commands.commands ?? []).some(
        c => c.name === WORKTREE_MERGE_COMMAND
      );
    } catch {
      hasWorktreeMerge = false; // plain git steps work everywhere
    }
  }
  const prompt = buildMergePrompt({ winner, parentBranch, hasWorktreeMerge });
  const response = await api.enqueueQueuedMessage(
    winner.id,
    prompt,
    chooseClientId(winner.id)
  );
  return { result: response.result };
}

/** The toast text for a Disconnect others run, plus the per-session results. */
export type DisconnectSummary = ReturnType<
  typeof summarizeBulkSessionResult
> & {
  results: BulkSessionResult;
};

export function useExperimentActions(api: ApiClient | null): {
  choose: (
    winner: ChosenPeer,
    parentBranch: string | null
  ) => Promise<ChooseResult>;
  disconnectOthers: (ids: readonly string[]) => Promise<DisconnectSummary>;
  isDisconnecting: boolean;
} {
  const { runBulkAction, isPending } = useBulkSessionAction(api);

  const choose = useCallback(
    async (
      winner: ChosenPeer,
      parentBranch: string | null
    ): Promise<ChooseResult> => {
      if (!api) throw new Error("API unavailable");
      return chooseWinner(api, winner, parentBranch);
    },
    [api]
  );

  const disconnectOthers = useCallback(
    async (ids: readonly string[]) => {
      const results = await runBulkAction("archive", ids);
      return { ...summarizeBulkSessionResult("archive", results), results };
    },
    [runBulkAction]
  );

  return { choose, disconnectOthers, isDisconnecting: isPending };
}
