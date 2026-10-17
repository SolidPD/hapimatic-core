// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  validateSessionName,
  SESSION_NAME_MAX_LENGTH,
  checkIsWaitingForUserQuestion,
} from "@hapi/protocol";
import {
  getSessionTitle,
  formatRelativeTimeCompact,
  getHapiShortId,
  getSessionTypeInfo,
} from "@/lib/sessionHelpers";
import { BranchIcon, ChevronIcon, PencilIcon } from "@/components/icons";
import type {
  Session,
  SessionsResponse,
  FederationAllSessionsResponse,
} from "@/types/api";
import { IssueStateBadge } from "@/components/IssueStateBadge";
import { resolveStateBadge } from "@hapi/protocol/workflowPhases";
import type { ApiClient } from "@/api/client";
import { isTelegramApp } from "@/hooks/useTelegram";
import {
  useSessionActions,
  findDescendantIds,
  dedupeById,
} from "@/hooks/mutations/useSessionActions";
import { useSessionActionPending } from "@/hooks/useSessionActionPending";
import {
  markActionPending,
  reconcileActionPending,
} from "@/lib/session-action-pending";
import { getReconnectErrorToast } from "@/lib/reconnectError";
import { queryKeys } from "@/lib/query-keys";
import { useBranchInfo } from "@/hooks/queries/useBranchInfo";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useToast } from "@/components/Toast";
import { useCurrentIssue, DEFAULT_REPO } from "@/hooks/useCurrentIssue";
import {
  toSessionInfoBranch,
  useCopySessionInfo,
} from "@/hooks/useCopySessionInfo";
import type { SessionWorkflowBadge } from "@hapi/protocol";
import {
  EditSessionParamsModal,
  FadeTruncate,
  SessionExpandedDetails,
  SessionRightMetaRow,
  SessionAccountBadge,
  SessionAuthBindingBadge,
} from "@/components/session";
import { NodeBadge } from "@/components/NodeBadge";
import {
  NODE_BADGE_CELL_PX,
  ROW1_CLUSTER_GAP_PX,
  ROW1_GAP_PX,
  ROW1_RIGHT_CLUSTER_PX,
  ROW_GAP_INSTANCE_PX,
  plusNodeBadgeRadius,
} from "@/components/session/rowAnchors";
import { RenameSessionDialog } from "@/components/RenameSessionDialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { BranchConfirmDialog } from "@/components/BranchConfirmDialog";
import { WorktreeDeleteDialog } from "@/components/WorktreeDeleteDialog";
import { EmojiPickerPopover } from "@/components/EmojiPickerPopover";
import { SessionTimer, ClockIcon } from "@/components/SessionTimer";
import { RecoveryStatusBadge } from "@/components/RecoveryStatusBadge";
import { StatusDotPopover } from "@/components/StatusDotPopover";
import {
  useSessionStaleness,
  STALE_THRESHOLD_MS,
} from "@/hooks/useSessionStaleness";
import { IssueInfoModal } from "@/components/IssueInfoModal";
import { IssueInputModal } from "@/components/IssueInputModal";
import { Spinner } from "@/components/Spinner";
import type { RecoveryStatus } from "@/types/api";
import { Button } from "@/components/ui/button";
import { SupportSessionBar } from "@/components/SupportSessionBar";

export function SessionHeader(props: {
  session: Session;
  onViewFiles?: () => void;
  /** Web-based desktop mode toggle (issue #2693) — renders a col-5 button when supplied. */
  onDesktop?: () => void;
  onViewClaudePty?: () => void;
  api: ApiClient | null;
  onSessionDeleted?: () => void;
  onReconnect?: (newSessionId: string) => void;
  needsReview?: boolean;
  onToggleReadStatus?: (action: "read" | "unread") => void;
  messageCount?: number;
  nodeId?: string;
  nodeLabel?: string;
  nodeUrl?: string;
  nodeStatus?: "online" | "degraded" | "offline";
  /** Whether any tool blocks are currently running in the chat stream */
  hasRunningTools?: boolean;
  /**
   * #3505: start time (ms epoch) of the newest running/pending tool block, used
   * to bound `hasRunningTools`'s contribution to the "thinking" indicator
   * (ruling D7). A running/pending tool keeps the dot + timer alive only while
   * `session.thinking` is true OR the block started within STALE_THRESHOLD_MS
   * (60s); beyond that a persisted orphan (a `tool_result` lost to SQLITE_BUSY
   * #3631, or a stale `agentState.requests` entry) must NOT pin the indicator
   * forever. null when no tool is running.
   */
  runningToolsStartedAt?: number | null;
  /** Session workflow checkpoint badge for the linked issue (issue #1672, Sub J). */
  workflowBadge?: SessionWorkflowBadge | null;
  /** #3275: per-session details expand/collapse — server-persisted via the
   * session's uiCollapseState. SessionChat owns the state; SessionHeader is a
   * controlled child (replaces the former private global-localStorage boolean). */
  detailsExpanded: boolean;
  onToggleDetails: () => void;
}) {
  const {
    session,
    api,
    onSessionDeleted,
    onReconnect,
    needsReview = false,
    onToggleReadStatus,
  } = props;
  const title = useMemo(() => getSessionTitle(session), [session]);
  const worktreeBranch = session.metadata?.worktree?.branch;
  const hasPath = Boolean(session.metadata?.path);
  const projectPath = session.metadata?.path;

  // Fetch branch info with polling (only if session has a path)
  const {
    branchInfo,
    isLoading: branchLoading,
    error: branchError,
  } = useBranchInfo(api, session.id, {
    enabled: hasPath,
    refetchInterval: 10_000,
    isActive: session.active,
  });

  // Repo URL from metadata (no lazy API call needed)
  const repoUrl = session.metadata?.repoIdentity?.url ?? null;

  // Get branch name — check isDetached before falling back to worktree metadata
  const isDetached = branchInfo?.isDetached ?? false;
  const branchName = isDetached
    ? null
    : (branchInfo?.branch ?? worktreeBranch ?? null);
  // Construct branch URL
  const branchUrl =
    repoUrl && branchName ? `${repoUrl}/tree/${branchName}` : null;

  // Timer data for start timestamp and play/pause control
  // Timer should pause when waiting for user response to AskUserQuestion
  const isWaitingForUserQuestion = checkIsWaitingForUserQuestion(
    session.agentState
  );
  // #3505 (ruling D7): a running/pending tool contributes to the "thinking"
  // indicator only while it is RECENT — `session.thinking` is true (handled by
  // the OR in `effectiveThinking`) OR the newest running/pending block started
  // within STALE_THRESHOLD_MS (60s, reused from useSessionStaleness — no second
  // threshold). Beyond that window the header treats the tool as an orphan and
  // reads idle; the tool card still renders "running". This stops a persisted
  // orphan (a `tool_result` lost to SQLITE_BUSY #3631, or a stale
  // `agentState.requests` entry) from pinning the detail indicator forever
  // while the list row correctly shows idle. A missing start time defaults to
  // "recent" (counts) so we never over-clear on absent timing.
  const hasRecentRunningTools =
    (props.hasRunningTools ?? false) &&
    (props.runningToolsStartedAt == null ||
      Date.now() - props.runningToolsStartedAt < STALE_THRESHOLD_MS);
  // Timer runs when Claude is thinking OR when tools are actively executing.
  // session.thinking can briefly go false during tool execution (SDK "result"
  // messages or keepAlive gaps), but a recently-started running tool proves
  // Claude is still working (#2456 gap — preserved by the recency window above).
  const effectiveThinking =
    (session.thinking || hasRecentRunningTools) && !isWaitingForUserQuestion;

  // Detect stale thinking sessions (no heartbeat for >60s while thinking)
  const staleness = useSessionStaleness(
    session.thinking,
    session.activeAt,
    session.active
  );

  // Last activity time
  const lastActivityTime = formatRelativeTimeCompact(session.updatedAt);

  // Session type categorization (standard, scheduled)
  const typeInfo = getSessionTypeInfo(session);
  // #1804: Row 1 shows the linked issue's workflow-state badge (lock P1 /
  // checkpoint P2) in place of the standard type badge when it resolves; the
  // badge data is the same `props.workflowBadge` the Session Details view used.
  const issueStateBadge = props.workflowBadge
    ? resolveStateBadge(props.workflowBadge.activeLabels)
    : null;
  // #2479: a managed peer (parentRelationship === "spawn") is NOT a branch —
  // exclude it so the branch chrome (border/icon/count) never mislabels it.
  const isBranch =
    Boolean(session.parentSessionId) && session.parentRelationship !== "spawn";
  const navigate = useNavigate();

  // Whether the badge is clickable (navigates to schedules page for spawning event)
  const isSpawnedSession =
    session.metadata?.source === "heartbeat" ||
    session.metadata?.source === "scheduler";

  const handleBadgeClick = () => {
    if (session.metadata?.source === "heartbeat") {
      navigate({ to: "/sessions", search: { view: "schedules" as const } });
    } else if (session.metadata?.source === "scheduler") {
      const sid = session.metadata?.scheduleId;
      navigate({
        to: "/sessions",
        search: sid
          ? { view: "schedules" as const, scheduleId: sid }
          : { view: "schedules" as const },
      });
    }
  };

  const [renameOpen, setRenameOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [reconnectConfirmOpen, setReconnectConfirmOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [issueModalOpen, setIssueModalOpen] = useState(false);
  const [issueInfoOpen, setIssueInfoOpen] = useState(false);
  const [branchDialogOpen, setBranchDialogOpen] = useState(false);
  // Issue #2149: the Session Configuration modal (#3290). E9 (operator ruling
  // 2026-09-06): the Row-1 Account Badge opens THIS modal — the account selector
  // lives inside it — so the header no longer mounts its own AccountSelectorModal.
  const [editParamsOpen, setEditParamsOpen] = useState(false);

  // Track reconnect-in-progress beyond the HTTP mutation lifecycle.
  // The mutation resolves when the hub acknowledges the spawn request,
  // but the CLI process takes several more seconds to actually connect.
  const queryClient = useQueryClient();
  const [reconnectInitiated, setReconnectInitiated] = useState(false);

  // Inline editing state
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isSavingRef = useRef(false);

  // Copy to clipboard hook (for path only - session ID handled by SessionIdDisplay)
  const { copied: pathCopied, copy: copyPath } = useCopyToClipboard();
  const { showToast } = useToast();

  // Current GitHub issue tracking (server-side source of truth)
  const { currentIssue, setCurrentIssue, clearCurrentIssue } = useCurrentIssue(
    session.id,
    session.linkedIssue,
    api
  );

  // #4480: the kebab's Copy Session Info entry (synchronous copy; prefetch on open).
  const { onCopySessionInfo, onKebabOpenChange } = useCopySessionInfo({
    api,
    session,
    isFullRecord: true,
    sessionName: title,
    nodeId: props.nodeId,
    nodeLabel: props.nodeLabel,
    nodeUrl: props.nodeUrl,
    branch: toSessionInfoBranch({ isDetached, branchName, branchError }),
    linkedIssue: currentIssue,
    messageCount: props.messageCount,
    effectiveThinking,
  });

  // Compute repo for issue modal from metadata repoIdentity, fallback to default
  const repoForIssueModal = useMemo(() => {
    const repoName = session.metadata?.repoIdentity?.name;
    if (repoName) return repoName;
    return DEFAULT_REPO;
  }, [session.metadata?.repoIdentity?.name]);

  const {
    archiveSession,
    reconnectSession,
    branchSession,
    renameSession,
    setEmoji,
    deleteSession,
    deleteSessionCascade,
    archiveAndDeleteSession,
    isPending,
    isReconnecting,
    isBranching,
    isArchiving,
  } = useSessionActions(
    api,
    session.id,
    session.metadata?.flavor ?? null,
    onReconnect,
    undefined,
    // Issue #3516: back-link target for the delete rollback toast (this header has
    // router access; the hook does not).
    (id: string) =>
      void navigate({ to: "/sessions/$sessionId", params: { sessionId: id } })
  );

  // Issue #1902: cross-view in-progress state for non-blocking actions. Lets a
  // background archive/reconnect/switch started here keep spinning on the list
  // card after this header unmounts (and vice-versa).
  const pendingActions = useSessionActionPending(session.id);

  // Look up child branch count from sessions query cache on each render.
  // SessionHeader receives Session (no childBranchCount), so we check
  // the SessionSummary cache to find how many children this session has.
  // Not memoized: queryClient is stable so useMemo deps wouldn't trigger
  // recomputation when the cache changes. The cache read is synchronous.
  const localData = queryClient.getQueryData<SessionsResponse>(
    queryKeys.sessions
  );
  const fedData = queryClient.getQueryData<FederationAllSessionsResponse>(
    queryKeys.federationAllSessions
  );
  // #2480: count ALL descendants (peer + branch, every depth) — the exact set
  // "Delete all (N)" removes via deleteSessionCascade → findDescendantIds. This
  // makes the delete dialog appear for peer-only groups too (not just branches)
  // and keeps N from undercounting grandchildren.
  const childCount = findDescendantIds(
    session.id,
    dedupeById([...(localData?.sessions ?? []), ...(fedData?.sessions ?? [])])
  ).length;

  const hasChildren = childCount > 0;

  // Derive reconnect spinner visibility (needs isReconnecting from above).
  useEffect(() => {
    if (reconnectInitiated && session.active) {
      setReconnectInitiated(false);
    }
  }, [reconnectInitiated, session.active]);
  const showReconnectSpinner =
    (isReconnecting || reconnectInitiated || pendingActions.reconnecting) &&
    !session.active;

  // Issue #1902: archive (disconnect) spinner on the chain icon — derived from
  // this instance's own mutation OR the shared store (cross-view), shown while
  // the session is still active (i.e. the disconnect hasn't landed yet).
  const showArchiveSpinner =
    (isArchiving || pendingActions.archiving) && session.active;

  // Issue #1902: clear the shared archive/reconnect entry once this session's
  // observed active-state confirms the op landed (archive → inactive, reconnect
  // → active), so a lingering entry can't show a false spinner on a later
  // reactivation. Runs whenever this header is mounted for the session.
  useEffect(() => {
    reconcileActionPending([{ id: session.id, active: session.active }]);
  }, [session.id, session.active]);

  // Safety timeout: clear reconnectInitiated after 90s to prevent infinite spinner
  // if the remote node fails to reconnect silently.
  useEffect(() => {
    if (!reconnectInitiated) return;
    const timeout = setTimeout(() => setReconnectInitiated(false), 90_000);
    return () => clearTimeout(timeout);
  }, [reconnectInitiated]);

  // Rapid-poll session data while waiting for reconnect to complete.
  // This detects when the CLI process connects and marks session active.
  useEffect(() => {
    if (!showReconnectSpinner) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.session(session.id),
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [showReconnectSpinner, queryClient, session.id]);

  const handleDelete = async () => {
    // Issue #3516: navigate away FIRST, then fire the (optimistic) delete in the
    // background — the row is already gone from the cache, so there is nothing to
    // wait for. The mutation's onError/onSettled (rollback + toast) still run after
    // this header unmounts (TanStack keeps the mutation observer alive).
    onSessionDeleted?.();
    void deleteSession().catch(() => {});
  };

  // Inline edit handlers
  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(title);
    setEditError(null);
    setIsEditing(true);
  };

  const handleSaveEdit = async () => {
    if (isSavingRef.current) return;
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === title) {
      setIsEditing(false);
      setEditError(null);
      return;
    }

    // Validate session name for tmux compatibility
    const validationError = validateSessionName(trimmed);
    if (validationError) {
      setEditError(validationError);
      return;
    }

    // Exit edit mode immediately after validation — the rename is optimistic
    // (renameMutation.onMutate updates the name in every cache before the network
    // resolves), so awaiting the PATCH here held the input open for the entire
    // round-trip, making Enter feel unresponsive on a slow/federated rename and
    // inviting a second (guard-swallowed) Enter. Set the guard BEFORE closing so
    // the input's onBlur={handleSaveEdit} no-ops on unmount. On the rare failure the
    // mutation's onError rolls the name back; surface it as a toast.
    isSavingRef.current = true;
    setIsEditing(false);
    setEditError(null);
    try {
      await renameSession(trimmed);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to rename";
      showToast(message, { type: "error" });
    } finally {
      isSavingRef.current = false;
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditValue("");
    setEditError(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSaveEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      handleCancelEdit();
    }
  };

  // Emoji select handler (optimistic via useSessionActions)
  const handleEmojiSelect = async (emoji: string | null) => {
    try {
      await setEmoji(emoji);
    } catch (error) {
      console.error("Failed to update session emoji:", error);
      showToast("Failed to update emoji", { type: "error" });
    }
  };

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // In Telegram, don't render header (Telegram provides its own)
  if (isTelegramApp()) {
    return null;
  }

  return (
    <>
      <div
        className={`border-l-2 ${isBranch ? "border-l-accent" : typeInfo.borderLeftClass} ${isBranch ? "bg-emerald-950/20" : typeInfo.headerTintClass || "bg-[var(--app-bg)]"} border-b border-[var(--app-hint)]/30 pl-2.5 pr-3 py-1.5`}
      >
        {/* #2413: the horizontal inset lives on THIS bordered card (outside the
            max-w-content centering box), mirroring HappyComposer.tsx:1176-1179, so
            the .icon-row grid and all rows anchor to the max-w-content line
            (1000 @1280) instead of being inset by px-3 (was 989). pl-2.5 (10px),
            not px-3: border-l-2 already contributes 2px of the left inset, so the
            effective inset is a symmetric 12px matching the composer — which also
            neutralizes the 1px mx-auto skew the asymmetric border would introduce. */}
        <div className="mx-auto w-full max-w-content">
          {/* === COLLAPSED STATE: Two rows with chevron spanning full height === */}
          {/* #1804 → E9: the Row-2 state badge picks the longest rung of its
              truncation ladder that fits the room left in its row (measured by
              a ResizeObserver inside IssueStateBadge — keyed to the header's
              actual width, not the viewport), so this wrapper no longer needs
              to be a `@container`. Column gap 6px = E9 `--chev-gap` (was 8). */}
          <div className="flex gap-1.5 min-w-0">
            {/* Left side: Two rows of content. E6 seating (#3574 → pass 1):
                Row-1 member gap 7px, Row 1→2 gap 6px on the instance header. */}
            <div
              className="flex flex-col min-w-0 flex-1"
              style={{ rowGap: ROW_GAP_INSTANCE_PX }}
              data-testid="row1-left"
            >
              {/* Row 1: Status dot + Emoji + Session name */}
              <div
                className="flex items-center min-w-0"
                style={{ gap: ROW1_GAP_PX }}
                data-testid="row1"
              >
                {/* Status dot (tappable on active non-thinking sessions) */}
                <StatusDotPopover
                  active={session.active}
                  thinking={session.thinking || hasRecentRunningTools}
                  needsReview={needsReview}
                  recoveryStatus={
                    session.recoveryStatus as RecoveryStatus | undefined
                  }
                  isWaitingForUserQuestion={isWaitingForUserQuestion}
                  staleness={staleness}
                  rateLimited={!!session.rateLimited}
                  onToggle={action => onToggleReadStatus?.(action)}
                  popoverPosition="bottom"
                />

                {/* Emoji picker */}
                <EmojiPickerPopover
                  emoji={session.emoji}
                  onEmojiSelect={handleEmojiSelect}
                  disabled={!api}
                />

                {/* Session name - editable, sized to text content only */}
                {isEditing ? (
                  <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                    <input
                      autoCapitalize="none"
                      ref={inputRef}
                      type="text"
                      value={editValue}
                      onChange={e => {
                        const v = e.target.value;
                        setEditValue(v);
                        const trimmed = v.trim();
                        setEditError(
                          trimmed.length === 0
                            ? null
                            : validateSessionName(trimmed)
                        );
                      }}
                      onKeyDown={handleKeyDown}
                      onBlur={handleSaveEdit}
                      maxLength={SESSION_NAME_MAX_LENGTH}
                      className={`min-w-[60px] w-full text-[length:var(--text-label-strong)] font-medium leading-tight bg-[var(--app-hover)] text-[var(--app-fg)] px-1 py-0.5 rounded outline-none border ${editError ? "border-red-500" : "border-[var(--app-link)]"}`} /* design-tokens-allow: 60px min-width for the inline rename input; no exact spacing token - L2 exception (#3404) */
                      aria-invalid={editError !== null}
                    />
                    {editError && (
                      /* design-system PERMANENT exception (#3336, from #3038 pilot):
                         9px inline-edit validation-error text sits below the type-scale
                         floor (--text-caption-xs = 10px); mapping up changes rendering.
                         Registered in docs/design/design-system/decision-typography.md
                         § Sub-floor type-size exceptions. */
                      <span
                        className="text-[9px] text-red-500 whitespace-nowrap" /* design-tokens-allow: 9px inline-edit validation error; PERMANENT sub-floor exception #3336 (ladder floor 10px) - L2 (#3404) */
                      >
                        {editError}
                      </span>
                    )}
                  </div>
                ) : (
                  // Operator ruling (2026-09-07): the name is sized to its TEXT
                  // (no flex-1) so the pencil follows it like the next character
                  // — the pencil hugs the name's right edge, never the column's.
                  // A long name shrinks (min-w-0) and is clipped under a short
                  // right-edge FADE (round 10 — no `…`: the ellipsis glyph plus
                  // CSS's whole-character truncation left 11–20px of dead space
                  // before the pencil; see FadeTruncate), so the pencil sits one
                  // row-gap after the last visible pixel of the name.
                  <FadeTruncate className="text-[length:var(--text-label-strong)] font-medium leading-tight">
                    {title}
                  </FadeTruncate>
                )}
                {!isEditing && (
                  // E9 `.pencil`: a 14px box (p-0.5 + 10px glyph), right after the name.
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={handleStartEdit}
                    aria-label="Edit session name"
                    title="Edit session name"
                    className="shrink-0 h-auto rounded-md p-0.5 font-normal active:bg-[var(--app-hover)]"
                  >
                    <PencilIcon className="h-2.5 w-2.5" />
                  </Button>
                )}
              </div>

              {/* Row 2: Time info - clock aligned under status dot */}
              <div className="flex items-center gap-2 min-w-0">
                <span className="flex h-3 w-3 items-center justify-center shrink-0">
                  <ClockIcon className="h-3 w-3 text-[var(--app-hint)]" />
                </span>
                {/* `flex-1`: the wrap row must SPAN the column (not size to its
                    content) — IssueStateBadge measures the room left in this
                    row to pick its ladder rung, and a content-sized row would
                    move its right edge with the badge's own width (E9). */}
                <div className="flex flex-1 flex-wrap items-center gap-x-1.5 text-[length:var(--text-body-dense)] text-[var(--app-hint)] min-w-0">
                  <SessionTimer
                    sessionId={session.id}
                    thinking={effectiveThinking}
                    serverAccumulatedMs={session.serverAccumulatedMs}
                    serverThinkingStartedAt={session.thinkingStartedAt}
                    compact
                  />
                  {lastActivityTime && (
                    // E6: `00:05:00 · 12m` — a dimmed middle dot separates the
                    // timer from the compact relative time.
                    <span className="shrink-0 opacity-70">
                      · {lastActivityTime}
                    </span>
                  )}
                  {/* Session Status Badge — Row 2, left-justified after the
                      relative time (taxonomy §Session Basic Info Bar Row 2; E6
                      `.row2 .statusbadge`). Epic #3285 correction pass 1 moved it
                      here from the Row-1 right cluster. #1804: shows the linked
                      issue's workflow-state badge when it resolves, else the
                      standard/scheduled type badge (clickable for spawned
                      sessions → schedules page). */}
                  {isSpawnedSession ? (
                    <button /* design-tokens-allow: badge-styled clickable pill with a dynamic per-type background + opacity-only hover; Button/ghost would substitute the dynamic bg on hover (R1) and it must match its non-clickable span sibling - L2 exception (#3404) */
                      type="button"
                      onClick={handleBadgeClick}
                      className={`flex min-w-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[length:var(--text-caption-xs)] font-medium leading-none transition-opacity hover:opacity-70 active:opacity-50 ${typeInfo.badgeBgClass} ${typeInfo.badgeTextClass}`}
                      title="View schedule"
                    >
                      {typeInfo.label}
                      <span className="text-[length:var(--text-caption-xs)] leading-none">
                        {typeInfo.emoji}
                      </span>
                    </button>
                  ) : issueStateBadge && props.workflowBadge ? (
                    <IssueStateBadge badge={props.workflowBadge} />
                  ) : (
                    // E6 placeholder for a session with no workflow state: a
                    // muted "— idle" pill (or "— working" while thinking) —
                    // replaces the legacy "standard 👤" type badge (pass 1).
                    <span
                      className="flex min-w-0 items-center rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[length:var(--text-caption-xs)] font-medium leading-none text-[var(--app-hint)]"
                      data-testid="session-status-placeholder"
                    >
                      — {effectiveThinking ? "working" : "idle"}
                    </span>
                  )}
                  <RecoveryStatusBadge
                    status={
                      session.recoveryStatus as RecoveryStatus | undefined
                    }
                  />
                </div>
              </div>
            </div>

            {/* Right side: Badge + message count stacked vertically */}
            <div className="flex flex-col items-end gap-0.5 shrink-0 self-center">
              {/* Session type badge + emoji — clickable for spawned sessions */}
              <div className="flex items-center gap-1">
                {isBranch && (
                  <BranchIcon className="h-2.5 w-2.5 text-[var(--app-link)]" />
                )}
                {/* #3287 R1 (D3(a)) + epic #3285 correction pass 1: the Row-1
                    right cluster is [Account Badge] · [Node Badge] ONLY — the
                    Session Status Badge moved DOWN to Row 2 (taxonomy: after the
                    relative time), freeing Row 1 for the session name. E9
                    (operator ruling 2026-09-06): the Account Badge opens the
                    Session Configuration modal — the account selector lives in
                    its Account row — NOT a bare account picker; the NodeBadge is
                    relocated here from Row 2 (its sole render site). */}
                {/* Fixed-width block = the Row-2 [loop-cron · count · bell] span,
                    so the Account Chip's LEFT edge sits on the Loop-Cron slot's
                    left edge one row below (operator ruling 2026-09-05; see
                    rowAnchors.ts). Chip grows/truncates inside; Node Badge is
                    pinned to the right edge. */}
                <div
                  className="flex items-center"
                  style={{
                    width: plusNodeBadgeRadius(ROW1_RIGHT_CLUSTER_PX),
                    gap: ROW1_CLUSTER_GAP_PX,
                  }}
                  data-testid="row1-right-cluster"
                >
                  <SessionAccountBadge
                    session={session}
                    nodeId={props.nodeId}
                    onOpen={() => setEditParamsOpen(true)}
                  />
                  {/* #3351: auth-binding chip for NON-Claude sessions — fills the
                      account slot the Account Badge leaves empty for Codex/Gemini/
                      OpenCode (mutually exclusive with it by flavor). */}
                  <SessionAuthBindingBadge session={session} />
                  {/* E8/E9 right block: the Node Badge is a FIXED cell exactly as
                      wide as [Message Count · Bell] beneath it, label centered.
                      Round 10: both grow by the badge's corner radius — the
                      count slot pads left by it so the bubble starts where the
                      badge's straight edge begins (rowAnchors.ts). Tapping the
                      badge opens the Node Health modal (NodeBadge owns it). */}
                  <span
                    className="ml-auto flex shrink-0 items-center justify-center"
                    style={{ width: plusNodeBadgeRadius(NODE_BADGE_CELL_PX) }}
                  >
                    <NodeBadge
                      fillCell
                      nodeId={props.nodeId}
                      nodeLabel={props.nodeLabel}
                      nodeUrl={props.nodeUrl}
                      nodeStatus={props.nodeStatus}
                    />
                  </span>
                </div>
              </div>
              {/* Row 2: shared Status Icon Cluster (loop-cron · message count ·
                  bell) — the same width as the Row-1 cluster above, so the two
                  rows form the E9 two-block layout. NodeBadge moved to Row 1
                  above (D3(a)); the conditional `?`/queued slot is gone (E9). */}
              <SessionRightMetaRow
                sessionId={session.id}
                messageCount={props.messageCount}
                backgroundAgents={session.backgroundAgents}
              />
            </div>

            {/* Chevron spanning full height of both rows */}
            <Button
              type="button"
              variant="ghost"
              onClick={props.onToggleDetails}
              className="flex items-center justify-center shrink-0 h-auto rounded-md bg-[var(--app-secondary-bg)] active:bg-[var(--app-hover)] px-1 self-stretch font-normal"
              title={props.detailsExpanded ? "Hide details" : "Show details"}
              aria-label={
                props.detailsExpanded
                  ? "Hide session details"
                  : "Show session details"
              }
            >
              <ChevronIcon
                className="h-3.5 w-3.5"
                collapsed={!props.detailsExpanded}
              />
            </Button>
          </div>

          {/* === EXPANDABLE SECTION === */}
          <div
            className={`overflow-hidden transition-all duration-200 ease-in-out ${
              props.detailsExpanded
                ? "max-h-[400px] opacity-100" /* design-tokens-allow: 400px expandable-details max-height cap; no spacing token - L2 exception (#3404) */
                : "max-h-0 opacity-0"
            }`}
          >
            {/* Expanded content with background matching input area */}
            <SessionExpandedDetails
              session={session}
              hapiShortId={getHapiShortId(session.id)}
              pathProps={(() => {
                const isWorktree = Boolean(session.metadata?.worktree);
                const displayPath =
                  (isWorktree
                    ? session.metadata?.worktree?.worktreePath
                    : undefined) ?? projectPath;
                const copyablePath = displayPath ?? projectPath;
                return {
                  isWorktree,
                  displayPath,
                  pathCopied,
                  onCopy: () => copyPath(copyablePath!),
                };
              })()}
              repoProps={{
                repoName: session.metadata?.repoIdentity?.name ?? null,
                repoUrl,
              }}
              branchProps={{
                branchName,
                branchUrl,
                isDetached,
                branchError,
                isActive: session.active,
              }}
              issueProps={{
                issue: currentIssue,
                onOpenSelector: () => setIssueModalOpen(true),
                onClear: clearCurrentIssue,
                onOpenInfo: () => setIssueInfoOpen(true),
              }}
              modelInfoProps={{
                launcherKind: session.metadata?.launcherKind,
              }}
              actionClusterProps={{
                surface: "instance",
                isActive: session.active,
                onDisconnect: () => setDisconnectOpen(true),
                onReconnect: () => setReconnectConfirmOpen(true),
                showReconnectSpinner,
                showArchiveSpinner,
                onDelete: () => setDeleteOpen(true),
                // #3516 follow-up: navigate away FIRST (as handleDelete does),
                // then run the remove-then-archive-then-delete wrapper in the
                // background — the row is already gone from the list caches.
                onDisconnectAndDelete: async () => {
                  onSessionDeleted?.();
                  void archiveAndDeleteSession().catch(() => {});
                },
                onBranch: () => setBranchDialogOpen(true),
                isBranching,
                isBranchDisabled: isPending || isBranching,
                onCopySessionInfo,
                onKebabOpenChange,
                onDesktop: props.onDesktop,
                onViewFiles: props.onViewFiles,
                sessionName: title,
                isPending,
              }}
            />
          </div>
        </div>
      </div>

      <RenameSessionDialog
        isOpen={renameOpen}
        onClose={() => setRenameOpen(false)}
        currentName={title}
        onRename={renameSession}
        isPending={isPending}
      />

      <ConfirmDialog
        isOpen={disconnectOpen}
        onClose={() => setDisconnectOpen(false)}
        title="Disconnect Session"
        description={`Are you sure you want to disconnect "${title}"? The session will become inactive.`}
        confirmLabel="Disconnect"
        confirmingLabel="Disconnecting..."
        onConfirm={archiveSession}
        isPending={isPending}
        destructive
        nonBlocking
      />

      <ConfirmDialog
        isOpen={reconnectConfirmOpen}
        onClose={() => setReconnectConfirmOpen(false)}
        title="Reconnect Session"
        description={`Reconnect "${title}"? If this session is still running, it will be re-attached, not restarted.`}
        confirmLabel="Reconnect"
        confirmingLabel="Reconnecting..."
        onConfirm={async () => {
          setReconnectInitiated(true);
          markActionPending(session.id, "reconnect");
          await reconnectSession();
        }}
        isPending={isPending}
        nonBlocking
        onError={err => {
          // Non-blocking reconnect failed: clear the local spinner flag and
          // toast. The shared store entry is cleared by reconnectMutation.onError.
          // Issue #1835: every reconnect failure now surfaces a toast
          // (cwd_missing / at_capacity / account_unrefreshable / generic
          // fallback) — getReconnectErrorToast always returns a message, so the
          // old non-empty-message guard is gone.
          setReconnectInitiated(false);
          showToast(getReconnectErrorToast(err), {
            type: "warning",
            duration: 6000,
          });
        }}
      />

      {hasChildren ? (
        <WorktreeDeleteDialog
          isOpen={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          sessionName={title}
          childCount={childCount}
          onDeleteThis={async () => {
            await handleDelete();
          }}
          onDeleteAll={async () => {
            // Issue #3516: navigate away FIRST, then fire the optimistic cascade in
            // the background (parent + descendants are already removed from the
            // caches). The dialog closes immediately since this handler resolves at
            // once; rollback + toast survive the unmount.
            onSessionDeleted?.();
            void deleteSessionCascade().catch(() => {});
          }}
          isPending={isPending}
        />
      ) : (
        <ConfirmDialog
          isOpen={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          title="Delete Session"
          description={`Are you sure you want to delete "${title}"? This action cannot be undone.`}
          confirmLabel="Delete"
          confirmingLabel="Deleting..."
          onConfirm={handleDelete}
          isPending={isPending}
          destructive
          nonBlocking
        />
      )}

      <IssueInputModal
        isOpen={issueModalOpen}
        onClose={() => setIssueModalOpen(false)}
        onSubmit={setCurrentIssue}
        defaultRepo={repoForIssueModal}
        currentIssueNumber={currentIssue?.number}
        api={api}
      />

      {currentIssue && (
        <IssueInfoModal
          issue={currentIssue}
          open={issueInfoOpen}
          onOpenChange={setIssueInfoOpen}
          api={api}
        />
      )}

      <BranchConfirmDialog
        isOpen={branchDialogOpen}
        onClose={() => setBranchDialogOpen(false)}
        parentName={title}
        onConfirm={async (branchName: string) => {
          await branchSession(branchName);
        }}
        isPending={isBranching}
        nonBlocking
        onError={() => showToast("Failed to branch session", { type: "error" })}
      />

      {/* #4371: the support session's persistent "Contact a human" bar, in flow
          directly under the header card — renders nothing for every other
          session (outside the closed icon-row registry, #2366). */}
      <SupportSessionBar session={session} api={api} />

      {/* Issue #2149 / #3290: the Session Configuration modal — opened by the
          Row-1 Account Badge (E9). The kebab entry that also opened it was
          replaced by Copy Session Info (#4480). */}
      <EditSessionParamsModal
        isOpen={editParamsOpen}
        onClose={() => setEditParamsOpen(false)}
        session={session}
        api={api}
        nodeLabel={props.nodeLabel}
        // Issue #4823: the header knows its node — a remote session's modal
        // disables the API-key group (keys are node-local).
        nodeId={props.nodeId}
      />
    </>
  );
}
