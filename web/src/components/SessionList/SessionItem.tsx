// SPDX-License-Identifier: AGPL-3.0-only
// SessionItem — session card/row (name, path, timer, actions, expanded details).
// Extracted from SessionList.tsx (issue #2083, epic #2077 F) — verbatim move.
import type { ApiClient } from "@/api/client";
import { BranchConfirmDialog } from "@/components/BranchConfirmDialog";
import { EmojiPickerPopover } from "@/components/EmojiPickerPopover";
import {
  BranchIcon,
  BulbIcon,
  ChevronIcon,
  PencilIcon,
} from "@/components/icons";
import { IssueInputModal } from "@/components/IssueInputModal";
import { RecoveryStatusBadge } from "@/components/RecoveryStatusBadge";
import {
  EditSessionParamsModal,
  FadeTruncate,
  SessionExpandedDetails,
  SessionRightMetaRow,
  SessionAccountBadge,
} from "@/components/session";
import { NodeBadge } from "@/components/NodeBadge";
import {
  NODE_BADGE_CELL_PX,
  ROW1_CLUSTER_GAP_PX,
  ROW1_GAP_PX,
  ROW1_RIGHT_CLUSTER_PX,
  ROW_GAP_LIST_PX,
  plusNodeBadgeRadius,
} from "@/components/session/rowAnchors";
import { SessionListNotesModal } from "@/components/SessionListNotesModal";
import { ClockIcon, SessionTimer } from "@/components/SessionTimer";
import { SpawnStatusBadge } from "@/components/SpawnStatusBadge";
import { Spinner } from "@/components/Spinner";
import { StatusDotPopover } from "@/components/StatusDotPopover";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { WorktreeDeleteDialog } from "@/components/WorktreeDeleteDialog";
import { useFanOutMenu } from "@/components/FanOut/useFanOutMenu";
import { SESSION_NAME_MAX_LENGTH, validateSessionName } from "@hapi/protocol";
import {
  useSessionActions,
  findDescendantIds,
  dedupeById,
} from "@/hooks/mutations/useSessionActions";
import { useBranchInfo } from "@/hooks/queries/useBranchInfo";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { DEFAULT_REPO, useCurrentIssue } from "@/hooks/useCurrentIssue";
import {
  toSessionInfoBranch,
  useCopySessionInfo,
} from "@/hooks/useCopySessionInfo";
import { useSessionActionPending } from "@/hooks/useSessionActionPending";
import { useSessionStaleness } from "@/hooks/useSessionStaleness";
import { queryKeys } from "@/lib/query-keys";
import { getReconnectErrorToastOptions } from "@/lib/reconnectError";
import {
  markActionPending,
  reconcileActionPending,
} from "@/lib/session-action-pending";
import {
  formatRelativeTimeCompact,
  getHapiShortId,
  getSessionTitle,
  getSessionTypeInfo,
} from "@/lib/sessionHelpers";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { SessionSummary } from "@/types/api";
import { getTodoProgress } from "./grouping";
import {
  isInteractiveTarget,
  splitDragHandle,
  type SortableDragHandle,
} from "./SortableListEntry";
import { IssueStateBadge } from "@/components/IssueStateBadge";
import { resolveStateBadge } from "@hapi/protocol/workflowPhases";

export function SessionItem(props: {
  session: SessionSummary;
  onSelect: (sessionId: string) => void;
  /**
   * Select Mode (#3292, epic #3285 S7). While `selectMode` is true a card TAP toggles
   * membership in the selection (`onToggleSelect`) instead of navigating — OR-7(b):
   * ONLY the tap handler changes, the press-and-hold drag path is untouched. Unselected
   * cards dim + desaturate; selected render normal. All optional so non-list consumers
   * (Session Instance View) keep today's navigate-on-tap by default.
   */
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (sessionId: string) => void;
  showPath?: boolean;
  api: ApiClient | null;
  needsReview: boolean;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onReconnect?: (newSessionId: string) => void;
  branchDepth?: number;
  /** #2479: count of this session's spawn children (managed peers). Drives the
   *  parent's gold fill + the managed-peer count indicator. */
  managedPeerCount?: number;
  /** #2479: resolved display name of the parent session, for a managed peer's
   *  "managed by …" breadcrumb. Null when unresolved or not a managed peer. */
  parentName?: string | null;
  /** #2479 (X2): this row is the reciprocal-highlight target of the hovered row. */
  isRelHighlighted?: boolean;
  /** #2479 (X3): this row is flashing (tap-to-flash from a child's breadcrumb). */
  isFlashing?: boolean;
  /** #2479 (X2): report relationship hover enter/leave (id, or null on leave). */
  onRelHover?: (sessionId: string | null) => void;
  /** #2479 (X3): request a one-shot flash on another row (breadcrumb tap → parent). */
  onFlashSession?: (sessionId: string) => void;
  /**
   * Issue #3114: split drag-handle for always-armed reorder. The pointer/touch
   * listeners arm a press-and-hold drag on the WHOLE row; the keyboard `onKeyDown`
   * + a11y `attributes` go on the chevron so keyboard reorder stays on the handle
   * (no Enter/Space collision with row navigation). Supplied by SessionListContainer
   * via SortableListEntry (the drag apparatus is always mounted now).
   */
  dragHandle?: SortableDragHandle;
}) {
  const {
    session: s,
    onSelect,
    selectMode = false,
    selected = false,
    onToggleSelect,
    showPath = true,
    api,
    needsReview,
    isExpanded,
    onToggleExpanded,
    onReconnect,
    branchDepth = 0,
    managedPeerCount = 0,
    parentName = null,
    isRelHighlighted = false,
    isFlashing = false,
    onRelHover,
    onFlashSession,
    dragHandle,
  } = props;
  // #3114: split the drag handle — pointer/touch (`dragRowListeners`) arm the whole
  // row; the keyboard handler + a11y attributes go on the chevron (keyboard reorder
  // stays on the handle).
  const {
    attributes: dragAttributes,
    rowListeners: dragRowListeners,
    keyDown: dragKeyDown,
  } = splitDragHandle(dragHandle);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [reconnectConfirmOpen, setReconnectConfirmOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [issueModalOpen, setIssueModalOpen] = useState(false);
  const [branchDialogOpen, setBranchDialogOpen] = useState(false);
  // The Session Configuration modal. E9 (operator ruling 2026-09-06): the
  // Row-1 Account Badge opens it (the account selector lives inside it) — the
  // card no longer mounts a bare AccountSelectorModal of its own. (#4480
  // replaced the kebab entry that also opened it with Copy Session Info.)
  const [editParamsOpen, setEditParamsOpen] = useState(false);
  const { copied: pathCopied, copy: copyPath } = useCopyToClipboard();
  const { showToast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const isSavingRef = useRef(false);

  // #3114: Session Peek (#1083) is removed — the row-level press-and-hold gesture is
  // reassigned to drag-to-reorder (armed by the row's dnd-kit pointer/touch listeners).
  // Tap navigation is a plain onClick on the row (below), guarded by the shared
  // `isInteractiveTarget` so a press that begins on an interactive child never navigates.

  // Current GitHub issue tracking (server-side source of truth)
  const { currentIssue, setCurrentIssue, clearCurrentIssue } = useCurrentIssue(
    s.id,
    s.linkedIssue,
    api
  );

  // Compute repo for issue modal from metadata repoIdentity, fallback to default
  const repoForIssueModal = useMemo(() => {
    const repoName = s.metadata?.repoIdentity?.name;
    if (repoName) return repoName;
    return DEFAULT_REPO;
  }, [s.metadata?.repoIdentity?.name]);

  const {
    archiveSession,
    reconnectSession,
    branchSession,
    renameSession,
    setEmoji,
    setNeedsReviewOverride,
    deleteSession,
    deleteSessionCascade,
    archiveAndDeleteSession,
    isPending,
    isReconnecting,
    isBranching,
    isArchiving,
  } = useSessionActions(
    api,
    s.id,
    s.metadata?.flavor ?? null,
    onReconnect,
    onSelect
  );

  // Issue #1902: cross-view in-progress state — a background archive/reconnect/
  // switch started in the session header keeps spinning on this card.
  const pendingActions = useSessionActionPending(s.id);

  const sessionName = getSessionTitle(s);

  // Timer should pause when waiting for user response to AskUserQuestion.
  //
  // Issue #2505: the list row breathes the dot + ticks the timer on this same
  // signal so both pulse together. Unlike SessionHeader — which folds in
  // `hasRunningTools` (see SessionHeader effectiveThinking) — the list row has no
  // running-tools signal: it consumes the lightweight SessionSummary projection,
  // which carries no tool-execution field (`hasRunningTools` is derived from the
  // live message stream in SessionChat, unavailable here). Consequence: during
  // tool execution `s.thinking` can briefly flicker false, so the list-row dot +
  // timer may momentarily stop breathing. This is an accepted, documented
  // limitation (Key Decision 2) — closing it would require a new server-computed
  // SessionSummary field, out of scope for this display-only change.
  const effectiveThinking = s.thinking && !s.isWaitingForUserQuestion;

  // Detect stale thinking sessions (no heartbeat for >60s while thinking)
  const staleness = useSessionStaleness(s.thinking, s.activeAt, s.active);

  // Fetch branch info for sessions with a path (including worktree sessions for detached HEAD detection)
  const hasPath = Boolean(s.metadata?.path);
  const worktreeBranch = s.metadata?.worktree?.branch;
  const isSessionActive = s.active;
  const {
    branchInfo,
    isLoading: branchLoading,
    error: branchError,
    cachedBranch,
  } = useBranchInfo(api, s.id, {
    enabled: hasPath,
    refetchInterval: 30_000, // 30 seconds for list view (less frequent than single session view)
    isActive: isSessionActive, // Only poll for active sessions; inactive sessions use cache
  });

  // Repo URL from metadata (no lazy API call needed)
  const repoUrl = s.metadata?.repoIdentity?.url ?? null;

  // Get branch name — check isDetached before falling back to worktree metadata
  // When detached, branchInfo.branch is null and we must NOT fall through to worktreeBranch
  const isDetached = branchInfo?.isDetached ?? false;
  const branchName = isDetached
    ? null
    : (branchInfo?.branch ??
      worktreeBranch ??
      (isSessionActive ? null : cachedBranch) ??
      null);

  // Construct branch URL
  const branchUrl =
    repoUrl && branchName ? `${repoUrl}/tree/${branchName}` : null;

  // #3818 / #4469: the kebab's Fan out and Peers entries and their dialogs,
  // shared with the session header so both kebabs offer the same entries.
  const fanOutMenu = useFanOutMenu({
    api,
    session: s,
    title: sessionName,
    nodeUrl: s.nodeUrl,
    branchName,
  });

  // #4480: the kebab's Copy Session Info entry. The card holds only the
  // SessionSummary, so opening the kebab prefetches the full record.
  const { onCopySessionInfo, onKebabOpenChange } = useCopySessionInfo({
    api,
    session: s,
    isFullRecord: false,
    sessionName,
    nodeId: s.nodeId,
    nodeLabel: s.nodeLabel,
    nodeUrl: s.nodeUrl,
    branch: toSessionInfoBranch({ isDetached, branchName, branchError }),
    linkedIssue: currentIssue,
    messageCount: s.messageCount,
    effectiveThinking,
  });

  // Inline edit handlers
  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(sessionName);
    setEditError(null);
    setIsEditing(true);
  };

  const handleSaveEdit = async () => {
    if (isSavingRef.current) return;
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === sessionName) {
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
      e.stopPropagation(); // Prevent navigation to session
      handleSaveEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      handleCancelEdit();
    }
  };

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // State-aware button states per Issue #36:
  // - Online sessions: Disconnect=red/enabled, Delete=gray/disabled
  // - Offline sessions: Disconnect=gray/disabled (or green for reconnect), Delete=red/enabled
  const isOnline = s.active;
  const canDisconnect = isOnline;
  const canDelete = !isOnline;

  // Track reconnect-in-progress beyond the HTTP mutation lifecycle.
  const queryClient = useQueryClient();

  // #2480: count ALL descendants (peer + branch, every depth) from the session
  // caches — the exact set "Delete all (N)" removes via findDescendantIds — so
  // the delete dialog appears for peer-only groups too and N never undercounts
  // grandchildren. Memoized on the cache data refs (stable until the list
  // changes) since this renders once per list row.
  const localSessionsForCount = queryClient.getQueryData<{
    sessions: SessionSummary[];
  }>(queryKeys.sessions)?.sessions;
  const fedSessionsForCount = queryClient.getQueryData<{
    sessions: SessionSummary[];
  }>(queryKeys.federationAllSessions)?.sessions;
  const childCount = useMemo(
    () =>
      findDescendantIds(
        s.id,
        dedupeById([
          ...(localSessionsForCount ?? []),
          ...(fedSessionsForCount ?? []),
        ])
      ).length,
    [s.id, localSessionsForCount, fedSessionsForCount]
  );
  const hasChildren = childCount > 0;
  const [reconnectInitiated, setReconnectInitiated] = useState(false);
  useEffect(() => {
    if (reconnectInitiated && isOnline) {
      setReconnectInitiated(false);
    }
  }, [reconnectInitiated, isOnline]);
  const showReconnectSpinner =
    (isReconnecting || reconnectInitiated || pendingActions.reconnecting) &&
    !canDisconnect;

  // Issue #1902: archive (disconnect) spinner on this card's chain icon — shows
  // while the session is still connectable (active) and an archive is pending,
  // whether started here or in the session header (cross-view via the store).
  const showArchiveSpinner =
    (isArchiving || pendingActions.archiving) && canDisconnect;

  // Issue #1902: clear the shared archive/reconnect entry once this card's
  // observed active-state confirms the op landed, preventing a lingering entry
  // from showing a false spinner on a later reactivation.
  useEffect(() => {
    reconcileActionPending([{ id: s.id, active: isOnline }]);
  }, [s.id, isOnline]);

  // Safety timeout: clear reconnectInitiated after 90s to prevent infinite spinner
  // if the remote node fails to reconnect silently.
  useEffect(() => {
    if (!reconnectInitiated) return;
    const timeout = setTimeout(() => setReconnectInitiated(false), 90_000);
    return () => clearTimeout(timeout);
  }, [reconnectInitiated]);

  // Rapid-poll session list and federation data while waiting for reconnect.
  useEffect(() => {
    if (!showReconnectSpinner) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.federationAllSessions,
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [showReconnectSpinner, queryClient]);

  // Emoji update handler (optimistic via useSessionActions)
  const handleEmojiSelect = async (emoji: string | null) => {
    try {
      await setEmoji(emoji);
    } catch (error) {
      console.error("Failed to update session emoji:", error);
      showToast("Failed to update emoji", { type: "error" });
    }
  };

  // Helper to stop event propagation on icon buttons
  const stopProp = {
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
    onMouseUp: (e: React.MouseEvent) => e.stopPropagation(),
    onTouchStart: (e: React.TouchEvent) => e.stopPropagation(),
    onTouchEnd: (e: React.TouchEvent) => e.stopPropagation(),
  };

  // Get project path for display
  const projectPath = s.metadata?.path;

  // Session type categorization (standard, scheduled)
  const typeInfo = getSessionTypeInfo(s);
  // #1804: when the linked issue resolves to a lock/checkpoint state, Row 1 shows
  // that badge in place of the standard type badge (falls back otherwise — R4).
  const issueStateBadge = s.workflowBadge
    ? resolveStateBadge(s.workflowBadge.activeLabels)
    : null;

  // Badge click navigation for spawned sessions
  const navigate = useNavigate();
  const isSpawnedSession =
    s.metadata?.source === "heartbeat" || s.metadata?.source === "scheduler";

  // #2479: parent-relationship styling for managed peers (PM-spawned sessions).
  // Keyed STRICTLY off parentRelationship === "spawn" — NEVER isSpawnedSession
  // above (that means source === heartbeat|scheduler, an unrelated concept).
  // - isManagedPeer: this row is a managed peer (spawn child) → gold accent + pill + breadcrumb
  // - isManagedParent: this row spawned managed peers → gold fill + managed-peer count
  const isManagedPeer = s.parentRelationship === "spawn";
  const isManagedParent = managedPeerCount > 0;
  const isManaged = isManagedPeer || isManagedParent;
  // A branch child is a parentSessionId child that is NOT a managed peer
  // (relationship "branch" or legacy-null). Branch chrome must exclude spawns (R-3).
  const isBranchChild = branchDepth > 0 && !isManagedPeer;

  // #2479: relationship-aware left accent + row tint. Managed rows (spawn peer OR
  // a parent of spawn peers) get the muted-gold accent + fill; branch children keep
  // the mint accent (literal refactored to the --session-rel-branch token, R8).
  const relAccentClasses = isManaged
    ? // #3264: split the managed left-border by role. A managed PEER keeps the
      // current gold (--session-rel-spawn, R5); a managed PARENT (spawned peers,
      // not itself a peer) gets the darker gold (--session-rel-spawn-parent, R4).
      // Resolve PEER-FIRST — a row that is BOTH a managed peer AND a managed parent
      // (a peer that itself spawned peers) keeps its inner-border role within its
      // own parent's cluster, so the peer color dominates. Both keep the fill.
      isManagedPeer
      ? "border-l-[color:var(--session-rel-spawn)] bg-[var(--session-rel-spawn-fill)]"
      : "border-l-[color:var(--session-rel-spawn-parent)] bg-[var(--session-rel-spawn-fill)]"
    : isBranchChild
      ? "border-l-[color:var(--session-rel-branch)] bg-emerald-950/20"
      : `${typeInfo.borderLeftClass} ${typeInfo.headerTintClass || "bg-[var(--app-bg)]"}`;
  // Hover mirrors the scheduled/branch pattern (accent color at ~0.15) so the
  // resting fill stays a dark background tint while hover still brightens.
  const relHoverBg = isManaged
    ? "var(--session-rel-spawn-pill-bg)"
    : isBranchChild
      ? // #3038: was the frozen literal rgba(90, 230, 171, 0.15) — the same mint
        // the branch token resolves to; color-mix keeps the exact 15% tint while
        // restoring the runtime accent-swap contract.
        "color-mix(in srgb, var(--session-rel-branch) 15%, transparent)"
      : typeInfo.hoverBg;
  // #2479 (X2 reciprocal highlight, X3 tap-to-flash): the container toggles these.
  const relInteractionClasses = [
    isRelHighlighted
      ? "ring-1 ring-inset ring-[color:var(--session-rel-spawn)]"
      : "",
    isFlashing
      ? "ring-2 ring-inset ring-[color:var(--session-rel-spawn)] bg-[var(--session-rel-spawn-pill-bg)]"
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const handleBadgeClick = useCallback(() => {
    if (s.metadata?.source === "heartbeat") {
      navigate({ to: "/sessions", search: { view: "schedules" as const } });
    } else if (s.metadata?.source === "scheduler") {
      const sid = s.metadata?.scheduleId;
      navigate({
        to: "/sessions",
        search: sid
          ? { view: "schedules" as const, scheduleId: sid }
          : { view: "schedules" as const },
      });
    }
  }, [s.metadata?.source, s.metadata?.scheduleId, navigate]);

  return (
    <>
      {/* Main session item — tap navigates, press-and-hold arms a drag (#3114). */}
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selectMode ? selected : undefined}
        // #3114: the dnd-kit pointer/touch listeners arm a press-and-hold drag on
        // the WHOLE row. A short tap still fires onClick → navigate; a normal touch
        // swipe still scrolls the list / pull-to-refresh until the ~300ms hold
        // elapses (the delay-based guarded sensors do the scroll-vs-drag
        // disambiguation). Keyboard reorder lives on the chevron, not here, so the
        // row's Enter/Space is free to navigate.
        {...dragRowListeners}
        onClick={e => {
          // Tap navigation — skip while editing, and when the press began on an
          // interactive child (buttons/inputs/links/.icon-row already stopProp,
          // but this keeps the guard explicit).
          if (isEditing) return;
          if (isInteractiveTarget(e.target)) return;
          // #3292 (OR-7b): Select Mode changes ONLY the tap handler — a tap toggles
          // selection; the press-and-hold guarded-sensor drag path is untouched.
          if (selectMode) {
            onToggleSelect?.(s.id);
            return;
          }
          onSelect(s.id);
        }}
        onKeyDown={e => {
          // Enter/Space on the focused row navigates (primary button action);
          // in Select Mode it toggles selection instead (#3292).
          if (isEditing) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (selectMode) {
              onToggleSelect?.(s.id);
              return;
            }
            onSelect(s.id);
          }
        }}
        onMouseEnter={isManaged ? () => onRelHover?.(s.id) : undefined}
        onMouseLeave={isManaged ? () => onRelHover?.(null) : undefined}
        className={`session-list-item relative border-l-4 pr-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] select-none cursor-pointer ${relAccentClasses} ${relInteractionClasses}`}
        style={
          {
            WebkitTouchCallout: "none",
            paddingLeft: "8px",
            // Density-driven vertical padding (#1040). The --row-padding-y var is
            // set by useDensity; rows update live without remount.
            paddingTop: "var(--row-padding-y)",
            paddingBottom: "var(--row-padding-y)",
            "--item-hover-bg": relHoverBg,
            // #3292: Select Mode dims + desaturates UNSELECTED cards (taxonomy .dimcard);
            // selected cards render normal. Full card info is retained either way.
            ...(selectMode && !selected
              ? { opacity: 0.45, filter: "saturate(0.35)" }
              : {}),
          } as React.CSSProperties
        }
      >
        {/* Select Mode (operator round 11, 2026-09-07): the WHOLE row is ONE tap
            surface — every inner control (status dot, emoji, pencil, account
            chip, node badge, loop-cron chip, message count, bell, chevron, the
            expanded details) is `inert`, so a tap anywhere on the card toggles
            the selection instead of landing on whichever control happened to be
            under the finger. `inert` removes the subtree from hit-testing AND
            the tab order (pointer-events:none semantics), so the row's own
            onClick/onKeyDown above are the only handlers that can fire. */}
        <div
          inert={selectMode ? true : undefined}
          data-select-mode-surface={selectMode ? "inert" : undefined}
        >
          {/* === COLLAPSED STATE: Two rows with chevron spanning full height === */}
          {/* #1804 → E9: the Row-2 state badge picks the longest rung of its
            truncation ladder that fits the room left in its row (measured by a
            ResizeObserver inside IssueStateBadge — keyed to the card's actual
            width, not the viewport), so this wrapper no longer needs to be a
            `@container`. Column gap 6px = E9 `--chev-gap` (was 8). */}
          <div className="flex gap-1.5 min-w-0">
            {/* Left side: Two rows of content. E6 seating (#3574 → pass 1):
              Row-1 member gap 7px, Row 1→2 gap 5px on the list card. */}
            <div
              className="flex flex-col min-w-0 flex-1"
              style={{ rowGap: ROW_GAP_LIST_PX }}
              data-testid={`row1-left-${s.id}`}
            >
              {/* Row 1: Status dot + Emoji + Session name */}
              <div
                className="flex items-center min-w-0"
                style={{ gap: ROW1_GAP_PX }}
                data-testid={`row1-${s.id}`}
              >
                {/* Status dot (tappable on active non-thinking sessions) */}
                <StatusDotPopover
                  active={s.active}
                  thinking={effectiveThinking}
                  needsReview={needsReview}
                  recoveryStatus={s.recoveryStatus}
                  isWaitingForUserQuestion={s.isWaitingForUserQuestion}
                  staleness={staleness}
                  rateLimited={!!s.rateLimited}
                  onToggle={async action => {
                    try {
                      await setNeedsReviewOverride(action);
                    } catch (error) {
                      console.error("Failed to update read status:", error);
                    }
                  }}
                />

                {/* Emoji picker */}
                <EmojiPickerPopover
                  emoji={s.emoji}
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
                      onClick={e => e.stopPropagation()}
                      maxLength={SESSION_NAME_MAX_LENGTH}
                      className={`min-w-15 w-full text-[length:var(--text-label-strong)] font-medium leading-tight bg-[var(--app-hover)] text-[var(--app-fg)] px-1 py-0.5 rounded outline-none border ${editError ? "border-red-500" : "border-[var(--app-link)]"}`}
                      aria-invalid={editError !== null}
                    />
                    {editError && (
                      /* design-system PERMANENT exception (#3336, from #3038 pilot):
                       9px inline-edit validation-error text sits below the type-scale
                       floor (--text-caption-xs = 10px); mapping up changes rendering.
                       Registered in docs/design/design-system/decision-typography.md
                       § Sub-floor type-size exceptions. */
                      <span className="text-[9px] text-red-500 whitespace-nowrap">
                        {editError}
                      </span>
                    )}
                  </div>
                ) : (
                  // Operator ruling (2026-09-07): the name is sized to its TEXT (no
                  // flex-1) so the pencil follows it like the next character — it
                  // hugs the name's right edge, never the column's. A long name
                  // shrinks (min-w-0) and is clipped under a short right-edge FADE
                  // (round 10 — no `…`; see FadeTruncate) with the pencil one
                  // row-gap after the last visible pixel of the name.
                  <FadeTruncate className="text-[length:var(--text-label-strong)] font-medium leading-tight">
                    {sessionName}
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
                    className="shrink-0 h-auto p-0.5 active:bg-[var(--app-hover)]"
                  >
                    <PencilIcon className="h-2.5 w-2.5" />
                  </Button>
                )}
                {/* Child branch indicator moved to right side for vertical alignment with parent indicator */}
              </div>

              {/* Row 2: Session Timer · Relative Time · Session Status Badge (taxonomy
                §Session Basic Info Bar Row 2; epic #3285 correction pass 1 moved the
                badge here from the Row-1 right cluster). The clock + timer + time
                sit in a fixed-min-width time block (E6 `.timeblock` = 104px) so every
                Status Badge down the column shares ONE left anchor regardless of
                `12m` / `9m` / `3d`. */}
              <div className="flex items-center gap-1 min-w-0">
                {/* `flex-1`: the wrap row must SPAN the column (not size to its
                  content) — IssueStateBadge measures the room left in this row
                  to pick its ladder rung, and a content-sized row would move
                  its right edge with the badge's own width (E9). */}
                <div className="flex flex-1 flex-wrap items-center gap-x-1 text-[length:var(--text-body-dense)] text-[var(--app-hint)] min-w-0">
                  <span
                    className="flex min-w-[104px] shrink-0 items-center gap-1 whitespace-nowrap" /* design-tokens-allow: 104px E6 `.timeblock` anchor width (worst-case timer + relative time); no --space token is 104px */
                    data-testid={`session-time-block-${s.id}`}
                  >
                    <span className="flex h-2.5 w-2.5 items-center justify-center shrink-0">
                      <ClockIcon className="h-2.5 w-2.5 text-[var(--app-hint)]" />
                    </span>
                    <SessionTimer
                      sessionId={s.id}
                      thinking={effectiveThinking}
                      serverAccumulatedMs={s.serverAccumulatedMs}
                      serverThinkingStartedAt={s.thinkingStartedAt}
                      compact
                    />
                    {/* E6: `00:05:00 · 12m` — middle dot before the compact time.
                        Round 14 follow-up (operator pick "mockup C"): no opacity
                        dimming — an opacity < 1 lets a tinted row bleed through
                        the text (30 % at 0.7), so the row's tint stays background. */}
                    <span className="shrink-0 text-[length:var(--text-caption-xs)]">
                      · {formatRelativeTimeCompact(s.updatedAt)}
                    </span>
                  </span>
                  {/* Session Status Badge (#1804: linked-issue workflow state when it
                    resolves; #2479 managed pill; else standard/scheduled type badge,
                    clickable for spawned sessions → schedules page). */}
                  {isSpawnedSession ? (
                    <button /* design-tokens-allow: caller-styled status-badge pill — badgeTextClass is dynamic per session type; Button's ghost hover:text-[--app-fg] would override the runtime badge color on hover (a visual regression #3354 forbids), un-neutralizable without a static color; keep raw */
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
                  ) : issueStateBadge && s.workflowBadge ? (
                    <IssueStateBadge badge={s.workflowBadge} />
                  ) : isManagedPeer ? (
                    // #2479: managed pill — resting state only. This branch is AFTER
                    // the workflowBadge check, so any workflow-state badge (formatted/
                    // researched/worked/…) takes precedence over the pill (R6).
                    <span
                      className="flex items-center rounded-full px-1.5 py-0.5 text-[length:var(--text-caption-xs)] font-medium leading-none bg-[var(--session-rel-spawn-pill-bg)] text-[color:var(--session-rel-spawn-text)]"
                      title="Managed peer — spawned by another session"
                    >
                      managed
                    </span>
                  ) : (
                    // E6 placeholder for a session with no workflow state: a muted
                    // "— idle" pill (or "— working" while thinking) — replaces the
                    // legacy "standard 👤" type badge (pass 1).
                    <span
                      className="flex min-w-0 items-center rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[length:var(--text-caption-xs)] font-medium leading-none text-[var(--app-hint)]"
                      data-testid={`session-status-placeholder-${s.id}`}
                    >
                      — {effectiveThinking ? "working" : "idle"}
                    </span>
                  )}
                  <RecoveryStatusBadge status={s.recoveryStatus} />
                  {/* Issue #1565: server-authoritative spawn lifecycle (Option B) */}
                  <SpawnStatusBadge lifecycleState={s.lifecycleState} />
                  {(() => {
                    const progress = getTodoProgress(s);
                    if (!progress) return null;
                    return (
                      <span className="flex items-center gap-0.5 shrink-0">
                        <BulbIcon className="h-2.5 w-2.5" />
                        {progress.completed}/{progress.total}
                      </span>
                    );
                  })()}
                </div>
                {/* #87 feedback (#2745 round): the mute bell moved into the shared
                  SessionRightMetaRow (between message count and node badge) so
                  the list and instance views render it identically. */}
              </div>

              {/* Row 3 (#2479, X1): "managed by …" breadcrumb for a managed peer.
                parentName resolves the parent id → its current name (re-resolved
                on rename by the container). Tapping flashes the parent row (X3). */}
              {isManagedPeer && s.parentSessionId && (
                <Button
                  variant="ghostStatic"
                  size="bare"
                  type="button"
                  onClick={e => {
                    e.stopPropagation();
                    if (s.parentSessionId) onFlashSession?.(s.parentSessionId);
                  }}
                  className="flex min-w-0 items-center justify-start gap-1 font-normal text-[length:var(--text-caption)] text-[color:var(--session-rel-spawn-text)] transition-opacity hover:text-[color:var(--session-rel-spawn-text)] hover:opacity-80"
                  title="Managed peer — tap to locate the managing session"
                >
                  <span className="truncate">
                    managed by {parentName ?? "…"}
                  </span>
                </Button>
              )}
            </div>

            {/* Right side: Two rows — session type badge, then indicators + node badge */}
            <div className="flex flex-col items-end gap-0.5 shrink-0 self-start">
              {/* Row 1: Branch count + Session type badge — clickable for spawned sessions */}
              <div className="flex items-center gap-1">
                {/* Branch indicators — renders in a single slot for vertical alignment.
                  Child: green branch icon. Parent: count + gray branch icon.
                  A branch-of-branch shows both (green icon + count + gray icon).
                  Managed (spawn) relationships render NO branch chrome here —
                  managed peers are full sessions, not conversation branches;
                  their signal is the gold pill/breadcrumb + the cluster header. */}
                {(isBranchChild || (s.childBranchCount ?? 0) > 0) && (
                  <span className="flex items-center gap-0.5">
                    {/* #2479: branch-child icon (mint) — branch children only, never
                      spawn peers (R-3 branch-surface gating). */}
                    {isBranchChild && (
                      <BranchIcon className="h-2.5 w-2.5 text-[color:var(--session-rel-branch)]" />
                    )}
                    {/* Branch count (mint) — branch children of this parent
                      (store count now excludes spawn peers, #2479 sub-f). */}
                    {(s.childBranchCount ?? 0) > 0 && (
                      <span className="flex items-center gap-0.5 text-[length:var(--text-caption)] text-[var(--app-hint)]">
                        {s.childBranchCount}
                        <BranchIcon className="h-2.5 w-2.5" />
                      </span>
                    )}
                  </span>
                )}
                {/* #3287 R1 (D3(a)) + epic #3285 correction pass 1: the Row-1 right
                  cluster is [Account Badge] · [Node Badge] ONLY — the Session
                  Status Badge moved DOWN to Row 2 (taxonomy: after the relative
                  time, anchored), freeing Row 1 for the session name. E9 (operator
                  ruling 2026-09-06): the Account Badge opens the Session
                  Configuration modal (the account selector lives in its Account
                  row), NOT a bare account picker; NodeBadge is relocated here from
                  Row 2 (its sole render site per surface). */}
                {/* Fixed-width block = the Row-2 [loop-cron · count · bell] span, so
                  the Account Chip's LEFT edge sits on the Loop-Cron slot's left
                  edge one row below (operator ruling 2026-09-05; rowAnchors.ts).
                  Chip grows/truncates inside; Node Badge pinned right. */}
                <div
                  className="flex items-center"
                  style={{
                    width: plusNodeBadgeRadius(ROW1_RIGHT_CLUSTER_PX),
                    gap: ROW1_CLUSTER_GAP_PX,
                  }}
                  data-testid={`row1-right-cluster-${s.id}`}
                >
                  <SessionAccountBadge
                    session={s}
                    onOpen={() => setEditParamsOpen(true)}
                  />
                  {/* E8/E9 right block: the Node Badge is a FIXED cell exactly as
                    wide as [Message Count · Bell] beneath it, label centered.
                    Round 10: both grow by the badge's corner radius — the count
                    slot pads left by it so the bubble starts where the badge's
                    straight edge begins (rowAnchors.ts). Tapping the badge opens
                    the Node Health modal (NodeBadge owns it). */}
                  <span
                    className="ml-auto flex shrink-0 items-center justify-center"
                    style={{ width: plusNodeBadgeRadius(NODE_BADGE_CELL_PX) }}
                  >
                    <NodeBadge
                      fillCell
                      nodeId={s.nodeId}
                      nodeLabel={s.nodeLabel}
                      nodeUrl={s.nodeUrl}
                      nodeStatus={s.nodeStatus}
                    />
                  </span>
                </div>
              </div>
              {/* Row 2: shared Status Icon Cluster (loop-cron · message count ·
                bell) — the same width as the Row-1 cluster above, so the two
                rows form the E9 two-block layout. NodeBadge moved to Row 1
                above (D3(a)); the conditional `?`/queued slot is gone (E9). */}
              <SessionRightMetaRow
                sessionId={s.id}
                messageCount={s.messageCount}
                backgroundAgents={s.backgroundAgents}
              />
            </div>

            {/* Chevron spanning full height of both rows — expand/collapse toggle.
              #3114: also the KEYBOARD reorder handle — the sortable a11y
              `attributes` + dnd-kit's keyboard `onKeyDown` (Enter/Space picks up
              for a keyboard drag) live here so they don't collide with the row's
              Enter/Space → navigate. Pointer/touch reorder is armed by the whole
              row, not this button. */}
            <button /* design-tokens-allow: dnd-kit keyboard reorder handle (#3114) — carries the sortable a11y {...dragAttributes} + dnd-kit onKeyDown; the guarded drag sensors EXCLUDE <button>, so converting would break keyboard drag (R3 off-limits) */
              type="button"
              {...dragAttributes}
              onKeyDown={dragKeyDown}
              onClick={e => {
                e.stopPropagation();
                onToggleExpanded();
              }}
              // #3285 alignment fix: the chevron occupies a full --icon-btn-size
              // (32px) slot so its glyph centers 16px from the row's right edge —
              // the SAME column as the icon-col-1 controls above it (app-bar gear,
              // ProjectHeader chevron) and the SubheadingBar chevron slot, which
              // already assume this width. The prior `px-1` (a 22px button) centered
              // the glyph only 11px in, poking every row chevron 5px right of that
              // column (the "jagged" right edge). Structural, not a tuned margin.
              className="flex items-center justify-center shrink-0 rounded-md bg-[var(--app-secondary-bg)] text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-hover)] active:bg-[var(--app-hover)] transition-colors w-[var(--icon-btn-size)] self-stretch"
              title={isExpanded ? "Hide details" : "Show details"}
              aria-label={
                isExpanded ? "Hide session details" : "Show session details"
              }
            >
              <ChevronIcon className="h-3.5 w-3.5" collapsed={!isExpanded} />
            </button>
          </div>

          {/* === EXPANDABLE SECTION === */}
          <div
            className={`overflow-hidden transition-all duration-200 ease-in-out ${
              isExpanded ? "max-h-100 opacity-100" : "max-h-0 opacity-0"
            }`}
          >
            {/* Expanded content with background matching input area */}
            {/* No pr here — parent .session-list-item already has pr-3, so icons align with App Title Bar and Project Header */}
            <SessionExpandedDetails
              session={s}
              hapiShortId={getHapiShortId(s.id)}
              pathProps={(() => {
                const isWorktree = Boolean(s.metadata?.worktree);
                const displayPath =
                  (isWorktree
                    ? s.metadata?.worktree?.worktreePath
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
                repoName: s.metadata?.repoIdentity?.name ?? null,
                repoUrl,
                onLinkClick: e => e.stopPropagation(),
              }}
              branchProps={{
                branchName,
                branchUrl,
                isDetached,
                branchError,
                isActive: isSessionActive,
                onLinkClick: e => e.stopPropagation(),
              }}
              issueProps={{
                issue: currentIssue,
                onOpenSelector: () => setIssueModalOpen(true),
                onClear: clearCurrentIssue,
              }}
              modelInfoProps={{
                launcherKind: s.metadata?.launcherKind,
              }}
              actionClusterProps={{
                surface: "list",
                isActive: isOnline,
                onDisconnect: () => setDisconnectOpen(true),
                onReconnect: () => setReconnectConfirmOpen(true),
                showReconnectSpinner,
                showArchiveSpinner,
                onDelete: () => setDeleteOpen(true),
                // #3516 follow-up: one wrapper that removes the row BEFORE the
                // (slow) archive, so it does not linger in the list.
                onDisconnectAndDelete: archiveAndDeleteSession,
                onBranch: () => setBranchDialogOpen(true),
                isBranching,
                isBranchDisabled: isPending || isBranching,
                onCopySessionInfo,
                onKebabOpenChange,
                onFanOut: fanOutMenu.onFanOut,
                onPeers: fanOutMenu.onPeers,
                sessionName,
                isPending,
                notesValue: s.metadata?.notes,
                sessionTitle: sessionName,
              }}
            />
          </div>
        </div>
      </div>

      <ConfirmDialog
        isOpen={disconnectOpen}
        onClose={() => setDisconnectOpen(false)}
        title="Disconnect Session"
        description={`Are you sure you want to disconnect "${sessionName}"? The session will become inactive.`}
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
        description={`Reconnect "${sessionName}"? If this session is still running, it will be re-attached, not restarted.`}
        confirmLabel="Reconnect"
        confirmingLabel="Reconnecting..."
        nonBlocking
        onConfirm={async () => {
          setReconnectInitiated(true);
          markActionPending(s.id, "reconnect");
          try {
            await reconnectSession();
          } catch (err) {
            // Issue #1778 / #1835: every reconnect failure surfaces a toast and
            // clears the spinner immediately — cwd_missing → actionable worktree
            // message, at_capacity → node-full, account_unrefreshable → re-login,
            // everything else → generic fallback. getReconnectErrorToast now
            // always returns a message, so the old non-empty-message guard is
            // gone. The 90s safety timeout (above) remains the backstop for silent/
            // non-throwing failures (Fallback Preservation Rule).
            // #4461: the action ("Log in" on the refusing node) rides with the
            // message, matching the SSE toast so the pair collapses into one.
            const { message, action } = getReconnectErrorToastOptions(err);
            showToast(message, { type: "warning", duration: 6000, action });
            setReconnectInitiated(false);
          }
        }}
        isPending={isPending}
      />

      {hasChildren ? (
        <WorktreeDeleteDialog
          isOpen={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          sessionName={sessionName}
          childCount={childCount}
          onDeleteThis={deleteSession}
          onDeleteAll={deleteSessionCascade}
          isPending={isPending}
        />
      ) : (
        <ConfirmDialog
          isOpen={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          title="Delete Session"
          description={`Are you sure you want to delete "${sessionName}"? This action cannot be undone.`}
          confirmLabel="Delete"
          confirmingLabel="Deleting..."
          onConfirm={deleteSession}
          isPending={isPending}
          destructive
          nonBlocking
        />
      )}

      {notesOpen && (
        <SessionListNotesModal
          api={api}
          sessionId={s.id}
          sessionName={sessionName}
          initialNotes={s.metadata?.notes}
          isOpen={notesOpen}
          onClose={() => setNotesOpen(false)}
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

      {fanOutMenu.dialogs}

      <BranchConfirmDialog
        isOpen={branchDialogOpen}
        onClose={() => setBranchDialogOpen(false)}
        parentName={sessionName}
        onConfirm={async (branchName: string) => {
          await branchSession(branchName);
        }}
        isPending={isBranching}
        nonBlocking
        onError={() => showToast("Failed to branch session", { type: "error" })}
      />

      {/* The Session Configuration modal — opened by the Row-1 Account Badge
          (E9; its Account row holds the account selector). #4480 replaced the
          kebab entry that also opened it. */}
      <EditSessionParamsModal
        isOpen={editParamsOpen}
        onClose={() => setEditParamsOpen(false)}
        session={s}
        api={api}
      />
    </>
  );
}
