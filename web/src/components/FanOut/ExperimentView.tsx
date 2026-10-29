// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Experiment view (#4469 Tasks 4 + 7): the parent session's fan-out peers —
 * status, changed-files count against the peer's diff base, the rank and test
 * exit code the parent reported, and a per-peer diff — plus the actions:
 *
 * - **Review peers** builds ONE review prompt (reviewPrompt.ts) and queues it
 *   to the parent. It is enabled when every selected peer has finished; a
 *   "review now" override asks first. A submitted latch blocks a second
 *   request, because the queue's id dedupes only while the row is queued and
 *   an idle parent drains it at once.
 * - **Choose** queues a merge request to one peer; **Disconnect others**
 *   archives the ranked non-winners, or the selected peers minus the winner
 *   when there is no readable ranking (useExperimentActions.ts).
 * - When the parent's newest ranking cannot be read, the view says so and
 *   shows no rank; it never shows an older ranking as current
 *   (rankedReport.ts).
 *
 * A failure anywhere leaves the floor untouched: the peers stay grouped under
 * the parent with their own prompts (#3818 R6).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { GitCommandResponse, SessionSummary } from "@/types/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Spinner } from "@/components/Spinner";
import { DiffView } from "@/components/DiffView";
import { BulkActionConfirm } from "@/components/SessionList/BulkActionConfirm";
import { useToast } from "@/components/Toast";
import { normalizeNumstatPath, parseNumStat } from "@/lib/gitParsers";
import { parseUnifiedDiff } from "@/lib/unifiedDiff";
import { queryKeys } from "@/lib/query-keys";
import {
  peersOf,
  reviewReadiness,
  selectForReview,
  type ExperimentPeer,
  type PeerStatus,
} from "./experiment";
import { PEER_REPLY_FETCH_LIMIT, lastAgentReply } from "./peerReply";
import {
  REVIEW_PROMPT_MAX_CHARS,
  buildReviewPrompt,
  reviewClientId,
  type PeerDiffBase,
} from "./reviewPrompt";
import {
  parseRankedReport,
  type RankedEntry,
  type RankedReading,
} from "./rankedReport";
import { nonWinnerIds, useExperimentActions } from "./useExperimentActions";

/** How often the parent's messages are re-read for the ranking while open. */
const RANKING_REFRESH_MS = 15_000;
const NUMSTAT_STALE_MS = 10_000;

export type ExperimentParent = {
  id: string;
  metadata?: { machineId?: string } | null;
};

type ReviewState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "queued"; deduplicated: boolean }
  | { kind: "error"; message: string };

const STATUS_STYLE: Record<PeerStatus, string> = {
  running: "text-[var(--app-hint)]",
  finished: "text-[var(--app-badge-success-text)]",
  "needs input": "text-[var(--app-badge-warning-text)]",
  "rate-limited": "text-[var(--app-badge-warning-text)]",
  disconnected: "text-[var(--app-hint)]",
  failed: "text-[var(--app-badge-error-text)]",
};

function numstatQueryFn(
  api: ApiClient,
  peerId: string,
  base: string | null
): () => Promise<GitCommandResponse> {
  return () => api.getGitDiffNumstat(peerId, false, base ?? undefined);
}

/** The R4 label for a peer's changed-files count. */
export function changedFilesLabel(
  peer: Pick<ExperimentPeer, "status">,
  numstat: GitCommandResponse | undefined
): string {
  if (peer.status === "disconnected") return "unknown";
  if (!numstat) return "…";
  if (!numstat.success) return "unknown";
  const count = parseNumStat(numstat.stdout ?? "").files.length;
  const files = `${count} file${count === 1 ? "" : "s"}`;
  if (!numstat.mergeBase) return `${files}, uncommitted only`;
  if (numstat.baseSource === "branch-start") {
    return `${files} since the branch was created`;
  }
  return `${files} vs ${numstat.base ?? "base"} — can include upstream commits`;
}

function diffBaseOf(
  numstat: GitCommandResponse | undefined
): PeerDiffBase | null {
  if (!numstat?.success || !numstat.mergeBase || !numstat.baseSource) {
    return null;
  }
  return { mergeBase: numstat.mergeBase, baseSource: numstat.baseSource };
}

function PeerFileDiff(props: {
  api: ApiClient;
  peerId: string;
  path: string;
  base: string | null;
}) {
  const { api, peerId, path, base } = props;
  const query = useQuery({
    queryKey: queryKeys.fanOutPeerFileDiff(peerId, path, base),
    queryFn: () => api.getGitDiffFile(peerId, path, false, base ?? undefined),
  });
  if (query.isPending) {
    return <Spinner size="sm" label="Loading diff" />;
  }
  const failure = query.isError
    ? query.error instanceof Error
      ? query.error.message
      : String(query.error)
    : query.data.success
      ? null
      : query.data.error ||
        query.data.stderr?.trim() ||
        "the git command failed";
  if (failure !== null) {
    return (
      <div
        className="text-xs text-[var(--app-badge-error-text)]"
        data-testid="experiment-diff-error"
      >
        Could not load the diff: {failure}
      </div>
    );
  }
  const data = query.data;
  if (!data?.stdout) {
    return (
      <div className="text-xs text-[var(--app-hint)]">
        No diff for this file.
      </div>
    );
  }
  const parsed = parseUnifiedDiff(data.stdout);
  return (
    <DiffView
      oldString={parsed.oldText}
      newString={parsed.newText}
      filePath={path}
      variant="inline"
    />
  );
}

export function ExperimentView(props: {
  isOpen: boolean;
  onClose: () => void;
  api: ApiClient | null;
  parent: ExperimentParent;
  /** The parent's current branch (the header's or the card's branchName); null on a detached HEAD or when unknown. */
  parentBranch: string | null;
  sessions: readonly SessionSummary[];
}) {
  const { isOpen, onClose, api, parent, parentBranch, sessions } = props;
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { choose, disconnectOthers, isDisconnecting } =
    useExperimentActions(api);

  const peers = useMemo(() => peersOf(parent, sessions), [parent, sessions]);
  const peerKey = peers.map(p => p.id).join(",");

  const [selected, setSelected] = useState<string[]>([]);
  const [review, setReview] = useState<ReviewState>({ kind: "idle" });
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [chooseFor, setChooseFor] = useState<ExperimentPeer | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  // One merge request per Choose: the confirm re-renders as pending only after
  // the first press, and `fanout-choose:<id>` dedupes only while the row is
  // queued (an idle winner drains it at once), so a second press must reuse
  // the request already in flight rather than send another.
  const [choosing, setChoosing] = useState(false);
  const chooseInFlight = useRef<Promise<void> | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [expandedPeer, setExpandedPeer] = useState<string | null>(null);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);

  // Every opening starts from the default selection.
  useEffect(() => {
    if (!isOpen) return;
    setSelected(selectForReview(peers));
    setReview({ kind: "idle" });
    setChosenId(null);
    setExpandedPeer(null);
    setExpandedFile(null);
    // peers is read once per opening; later list updates keep the ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const selectedKey = [...selected].sort().join(",");
  // A result stays shown until the selection changes.
  useEffect(() => {
    setReview(r => (r.kind === "pending" ? r : { kind: "idle" }));
  }, [selectedKey]);

  const numstats = useQueries({
    queries: peers.map(peer => ({
      queryKey: queryKeys.fanOutPeerNumstat(peer.id, parentBranch),
      queryFn: api
        ? numstatQueryFn(api, peer.id, parentBranch)
        : async (): Promise<GitCommandResponse> => ({ success: false }),
      enabled: isOpen && api !== null && peer.status !== "disconnected",
      staleTime: NUMSTAT_STALE_MS,
    })),
  });
  const numstatById = new Map(
    peers.map((p, i) => [p.id, numstats[i]?.data] as const)
  );

  const parentMessages = useQuery({
    queryKey: queryKeys.fanOutParentMessages(parent.id),
    queryFn: () => {
      if (!api) throw new Error("API unavailable");
      return api.getMessages(parent.id, { limit: PEER_REPLY_FETCH_LIMIT });
    },
    enabled: isOpen && api !== null,
    refetchInterval: isOpen ? RANKING_REFRESH_MS : false,
  });
  const reading = useMemo<RankedReading>(
    () =>
      parentMessages.data
        ? parseRankedReport(
            parentMessages.data.messages,
            peerKey.split(",").filter(Boolean)
          )
        : { kind: "none" },
    [parentMessages.data, peerKey]
  );
  const report = reading.kind === "ranked" ? reading.report : null;
  const rankById = new Map<string, RankedEntry>(
    (report?.entries ?? []).map(e => [e.id, e])
  );

  const selectedPeers = peers.filter(p => selected.includes(p.id));
  const readiness = reviewReadiness(selectedPeers);
  const canOverride =
    !readiness.ok &&
    readiness.reason === "unfinished" &&
    selectedPeers.length > 0;
  const latched = review.kind === "pending" || review.kind === "queued";

  async function submitReview(): Promise<void> {
    if (!api || latched || selectedPeers.length === 0) return;
    setReview({ kind: "pending" });
    try {
      const inputs = await Promise.all(
        selectedPeers.map(async peer => {
          const [messages, numstat] = await Promise.all([
            api.getMessages(peer.id, { limit: PEER_REPLY_FETCH_LIMIT }),
            parentBranch && peer.status !== "disconnected"
              ? queryClient.fetchQuery({
                  queryKey: queryKeys.fanOutPeerNumstat(peer.id, parentBranch),
                  queryFn: numstatQueryFn(api, peer.id, parentBranch),
                  staleTime: NUMSTAT_STALE_MS,
                })
              : Promise.resolve(undefined),
          ]);
          return {
            peer,
            reply: lastAgentReply(messages.messages, REVIEW_PROMPT_MAX_CHARS),
            base: diffBaseOf(numstat),
          };
        })
      );
      const prompt = buildReviewPrompt({ parentBranch, peers: inputs });
      const response = await api.enqueueQueuedMessage(
        parent.id,
        prompt,
        reviewClientId(
          parent.id,
          selectedPeers.map(p => p.id)
        )
      );
      setReview({
        kind: "queued",
        deduplicated: response.result === "deduplicated",
      });
    } catch (err) {
      setReview({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const disconnectIds = chosenId
    ? nonWinnerIds(chosenId, report, selected)
    : [];
  const disconnectNames = disconnectIds
    .map(id => peers.find(p => p.id === id)?.name ?? id)
    .join(", ");

  function toggle(id: string): void {
    setSelected(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]));
  }

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Peers</DialogTitle>
          <DialogDescription className="mt-2">
            The sessions this one spawned. Review asks this session to compare
            and rank the selected peers.
          </DialogDescription>
        </DialogHeader>

        {peers.length === 0 ? (
          <div className="mt-3 text-sm text-[var(--app-hint)]">
            This session has no peers.
          </div>
        ) : (
          <ul className="mt-3 space-y-2" data-testid="experiment-peers">
            {peers.map(peer => {
              const numstat = numstatById.get(peer.id);
              const rank = rankById.get(peer.id);
              const files =
                numstat?.success && numstat.stdout
                  ? parseNumStat(numstat.stdout).files
                  : [];
              const expanded = expandedPeer === peer.id;
              return (
                <li
                  key={peer.id}
                  data-testid={`experiment-peer-${peer.id}`}
                  className="rounded-md border border-[var(--app-border)] p-2 text-sm"
                >
                  <div className="flex items-start gap-2">
                    <Checkbox
                      aria-label={`Include ${peer.name} in the review`}
                      checked={selected.includes(peer.id)}
                      onChange={() => toggle(peer.id)}
                      className="mt-0.5"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="truncate font-medium">
                          {peer.name}
                        </span>
                        <span
                          className={`text-xs ${STATUS_STYLE[peer.status]}`}
                          data-testid="experiment-peer-status"
                        >
                          {peer.status}
                        </span>
                      </div>
                      <div className="text-xs text-[var(--app-hint)] break-all">
                        {peer.flavor}
                        {peer.branch ? ` · ${peer.branch}` : ""}
                        {peer.sameMachine ? "" : " · another machine"}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 text-xs">
                        <Button
                          type="button"
                          variant="ghost"
                          size="bare"
                          className="text-xs font-normal underline-offset-2 hover:underline disabled:no-underline"
                          data-testid="experiment-peer-count"
                          disabled={files.length === 0}
                          onClick={() => {
                            setExpandedPeer(expanded ? null : peer.id);
                            setExpandedFile(null);
                          }}
                        >
                          {changedFilesLabel(peer, numstat)}
                        </Button>
                        <span data-testid="experiment-peer-rank">
                          rank: {rank ? rank.rank : "not reported"}
                        </span>
                        <span data-testid="experiment-peer-tests">
                          tests:{" "}
                          {rank?.testExitCode !== undefined
                            ? `exit ${rank.testExitCode}`
                            : "not reported"}
                        </span>
                      </div>
                      {rank ? (
                        <div className="mt-1 text-xs text-[var(--app-hint)]">
                          {rank.summary}
                        </div>
                      ) : null}
                      {expanded ? (
                        <div className="mt-2 space-y-1">
                          {files.map(f => {
                            // A rename is `old => new` (or braced); the diff
                            // is requested for the new path.
                            const { newPath, oldPath } = normalizeNumstatPath(
                              f.file
                            );
                            return (
                              <div key={f.file}>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="bare"
                                  className="justify-start text-left text-xs font-normal break-all whitespace-normal underline-offset-2 hover:underline"
                                  onClick={() =>
                                    setExpandedFile(
                                      expandedFile === f.file ? null : f.file
                                    )
                                  }
                                >
                                  {oldPath && oldPath !== newPath
                                    ? `${oldPath} → ${newPath}`
                                    : newPath}
                                </Button>
                                {api && expandedFile === f.file ? (
                                  <PeerFileDiff
                                    api={api}
                                    peerId={peer.id}
                                    path={newPath}
                                    base={parentBranch}
                                  />
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      data-testid={`experiment-choose-${peer.id}`}
                      disabled={
                        chosenId !== null ||
                        choosing ||
                        !peer.session.active ||
                        !api
                      }
                      onClick={() => setChooseFor(peer)}
                    >
                      {chosenId === peer.id ? "Chosen" : "Choose"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-3 space-y-1 text-xs" aria-live="polite">
          {!readiness.ok && peers.length > 0 ? (
            <div
              className="text-[var(--app-hint)]"
              data-testid="experiment-readiness"
            >
              {readiness.text}
            </div>
          ) : null}
          {reading.kind === "unreadable" ? (
            <div
              className="text-[var(--app-badge-error-text)]"
              data-testid="experiment-ranking-unreadable"
            >
              The latest ranking could not be read: {reading.reason}.
            </div>
          ) : null}
          {review.kind === "queued" ? (
            <div data-testid="experiment-review-result">
              {review.deduplicated
                ? "Already queued — the review starts in this session's chat."
                : "Review requested (queued) — the review starts in this session's chat."}
            </div>
          ) : null}
          {review.kind === "error" ? (
            <div
              className="text-[var(--app-badge-error-text)]"
              data-testid="experiment-review-error"
            >
              Review not requested: {review.message}
            </div>
          ) : null}
          {chosenId ? (
            <div data-testid="experiment-choose-result">
              Merge requested from{" "}
              {peers.find(p => p.id === chosenId)?.name ?? chosenId} (queued).
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {chosenId && disconnectIds.length > 0 ? (
            <Button
              type="button"
              variant="secondary"
              data-testid="experiment-disconnect-others"
              onClick={() => setDisconnectOpen(true)}
            >
              Disconnect others
            </Button>
          ) : null}
          {canOverride ? (
            <Button
              type="button"
              variant="secondary"
              data-testid="experiment-review-now"
              disabled={latched}
              onClick={() => setOverrideOpen(true)}
            >
              Review now
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            data-testid="experiment-review"
            disabled={!readiness.ok || latched || !api}
            onClick={() => void submitReview()}
          >
            {review.kind === "pending" ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner size="sm" label={null} className="!text-inherit" />
                Requesting...
              </span>
            ) : (
              "Review peers"
            )}
          </Button>
        </div>

        <ConfirmDialog
          isOpen={overrideOpen}
          onClose={() => setOverrideOpen(false)}
          title="Review before every peer finished?"
          description={`Still working: ${selectedPeers
            .filter(p => p.status !== "finished")
            .map(p => p.name)
            .join(", ")}. Their replies may be incomplete.`}
          confirmLabel="Review now"
          confirmingLabel="Requesting..."
          isPending={review.kind === "pending"}
          onConfirm={submitReview}
        />

        <BulkActionConfirm
          isOpen={chooseFor !== null}
          onClose={() => {
            // Stays open while the request is in flight, so a failure is
            // shown in it and no other peer's confirm can take over.
            if (!chooseInFlight.current) setChooseFor(null);
          }}
          count={1}
          first={{
            title: `Choose ${chooseFor?.name ?? "this peer"}?`,
            description:
              "Queues a merge request to this peer only. No other peer changes.",
            confirmLabel: "Choose",
          }}
          second={{ title: "", description: "", confirmLabel: "Choose" }}
          confirmingLabel="Queuing..."
          isPending={choosing}
          onConfirm={() => {
            if (chooseInFlight.current) return chooseInFlight.current;
            const winner = chooseFor;
            if (!winner) return Promise.resolve();
            setChoosing(true);
            const run = (async () => {
              try {
                await choose(winner, parentBranch);
                setChosenId(winner.id);
              } finally {
                chooseInFlight.current = null;
                setChoosing(false);
              }
            })();
            chooseInFlight.current = run;
            return run;
          }}
        />

        <BulkActionConfirm
          isOpen={disconnectOpen}
          onClose={() => setDisconnectOpen(false)}
          count={disconnectIds.length}
          destructive
          note={`Disconnects: ${disconnectNames}`}
          first={{
            title: "Disconnect the other peers?",
            description: report
              ? "Disconnects the peers this session ranked, except the chosen one. Nothing is deleted; each can reconnect later."
              : "Disconnects the selected peers, except the chosen one. Nothing is deleted; each can reconnect later.",
            confirmLabel: "Disconnect",
          }}
          second={{
            title: "Disconnect the other peers?",
            description: "This stops each of these sessions' processes.",
            confirmLabel: `Disconnect ${disconnectIds.length} peers`,
          }}
          confirmingLabel="Disconnecting..."
          isPending={isDisconnecting}
          onConfirm={async () => {
            const { message, type } = await disconnectOthers(disconnectIds);
            showToast(message, { type });
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
