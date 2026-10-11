// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { HappyRuntimeProvider } from "@/lib/HappyRuntimeProvider";
import { useSessionTokenStats } from "@/hooks/queries/useSessionTokenStats";
import { useSessionWorkflowState } from "@/hooks/queries/useSessionWorkflowState";
import type { SessionTokenStats } from "@/chat/types";
import type { ApiClient } from "@/api/client";
import type {
  DecryptedMessage,
  ModelMode,
  PermissionMode,
  Session,
} from "@/types/api";
import type { ChatBlock, NormalizedMessage } from "@/chat/types";
import type { Suggestion } from "@/hooks/useActiveSuggestions";
import { normalizeDecryptedMessage } from "@/chat/normalize";
import { isUserMessage } from "@/lib/messages";
import {
  getEffectiveEffort,
  getEffectiveRawModel,
  getSessionTitle,
  isModelDowngraded,
} from "@/lib/sessionHelpers";
import { useSessionAccountEmail } from "@/hooks/queries/useSessionAccountEmail";
import { EditSessionParamsModal } from "@/components/session";
import { reduceChatBlocks } from "@/chat/reducer";
import { reconcileChatBlocks } from "@/chat/reconcile";
import { useThinkingPlaceholder } from "@/hooks/useThinkingPlaceholder";
import {
  HappyComposer,
  HappyComposerCollapsedHeading,
} from "@/components/AssistantChat/HappyComposer";
import {
  HappyThread,
  type ScrollState,
} from "@/components/AssistantChat/HappyThread";
import { useHappyRuntime } from "@/lib/assistant-runtime";
import { SessionHeader } from "@/components/SessionHeader";
import { SessionOfflineBar } from "@/components/session/SessionOfflineBar";
import { useToast } from "@/components/Toast";
import { SessionNotes } from "@/components/SessionNotes";
import { MAX_NOTES_LENGTH } from "@/hooks/useSessionNotesAutosave";
import { parseNotes, type EffortLevel } from "@hapi/protocol";
import type { UiCollapseState } from "@hapi/protocol/schemas";
import { type Attachment } from "@/lib/attachment-store";
import { TokenUsageSection } from "@/components/TokenUsageWidget";
import { computeMergeGroups } from "@/components/SessionChat.mergeGroups";
import { useExtensionHost } from "@/ext/host";
import { SessionDetailInfoFields, SessionDetailTabs } from "@/ext/slots";
import { SessionDetailProvider } from "@/ext/sessionDetailContext";
import { usePlatform } from "@/hooks/usePlatform";
import { useSwipeBack } from "@/hooks/useSwipeBack";
import { useSessionActions } from "@/hooks/mutations/useSessionActions";
import { useModelSwitchVerification } from "@/hooks/useModelSwitchVerification";
import { useUserMessageNavigation } from "@/hooks/useUserMessageNavigation";
import { useBookmarks } from "@/hooks/useBookmarks";
import { useBookmarkNavigation } from "@/hooks/useBookmarkNavigation";
import { useBranchSummary } from "@/hooks/useBranchSummary";
import { useTextScale } from "@/hooks/useTextScale";
import { TextScaleControl } from "@/components/TextScaleControl";
import { useThreadFullscreenMode } from "@/hooks/useThreadFullscreenMode";
import {
  useIPadMultitasking,
  IPAD_FULLSCREEN_GUTTER_TOP,
} from "@/hooks/useIPadMultitasking";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";
import {
  ChevronUpIcon,
  ChevronDownIcon,
  ChevronsUpIcon,
  ChevronsDownIcon,
  CloseIcon,
  TerminalIcon,
  BookmarkIcon,
} from "@/components/icons";
import { Spinner } from "@/components/Spinner";
import { ViewPicker } from "@/components/session/ViewPicker";
import {
  computeEffectiveSessionView,
  hasConsumedOpenRedirect,
  isSessionViewAvailable,
  markOpenRedirectConsumed,
  sessionViewToPath,
} from "@/lib/session-view";

// #3638: gutter expand/compress glyphs — the exact paths from the binding mockup
// (claudedocs/design-mockups/r16/thread-fade-fullscreen.html, panels A/D). Defined
// inline here (BrandedFrame's RefreshIcon/ChevronLeftIcon precedent) rather than in
// icons.tsx, to keep the change within this feature's file scope.
function ThreadMaximizeIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      aria-hidden="true"
    >
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function ThreadMinimizeIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      aria-hidden="true"
    >
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

export function SessionChat(props: {
  api: ApiClient;
  session: Session;
  messages: DecryptedMessage[];
  parentMessages?: DecryptedMessage[];
  isLoadingParentMessages?: boolean;
  messagesWarning: string | null;
  hasMoreMessages: boolean;
  isLoadingMessages: boolean;
  isLoadingMoreMessages: boolean;
  isSending: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onLoadMore: () => Promise<unknown>;
  onSend: (text: string) => void;
  onRetryMessage?: (localId: string) => void;
  autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>;
  onComposeFocus?: () => void;
  needsReview?: boolean;
  onToggleReadStatus?: (action: "read" | "unread") => void;
  serverMessageCount?: number;
  nodeId?: string;
  nodeLabel?: string;
  nodeUrl?: string;
  nodeStatus?: "online" | "degraded" | "offline";
  /**
   * #3638 (X5): true when rendered inside a split pane. Full-screen page mode
   * then hides ONLY pane-local chrome (ViewPicker / SessionHeader / info strip)
   * and must NOT lift the app-bar-hide flag (the app bar is shared by both panes).
   */
  inSplitPane?: boolean;
}) {
  const { haptic } = usePlatform();
  const navigate = useNavigate();
  const host = useExtensionHost();
  const {
    scale: textScale,
    scaleLabel: textScaleLabel,
    incrementScale,
    decrementScale,
    canIncrement: canIncrementScale,
    canDecrement: canDecrementScale,
  } = useTextScale();
  // #3158: HappyThread registers its "capture top-visible anchor" callback here;
  // the text-size handlers below fire it BEFORE changing the scale so the anchor
  // is measured against the pre-relayout DOM (mirrors the composerSetTextRef
  // imperative-handle pattern below).
  const captureTopAnchorRef = useRef<(() => void) | null>(null);
  const controlsDisabled = !props.session.active;
  const [scrollState, setScrollState] = useState<ScrollState | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const [dockHeight, setDockHeight] = useState(0);
  // Issue #3289 (S4): the Session Config Cluster's interim tap target — opens the
  // existing EditSessionParamsModal (which owns the session object) until #3290.
  const [configModalOpen, setConfigModalOpen] = useState(false);

  // Parse the persisted notes envelope (#1075): {text, attachments} OR a legacy
  // plain string. `.text` feeds the lifted notesText; `.attachments` seeds
  // SessionNotes' hydration.
  const parsedSessionNotes = useMemo(
    () => parseNotes(props.session.notes),
    [props.session.notes]
  );
  // State for bidirectional text transfer between composer and notes
  const [notesText, setNotesText] = useState(parsedSessionNotes.text);
  // Mirror of notesText read synchronously by handleMoveComposerToNotes so the
  // push-down server write (#2766) sees the latest value without a stale closure
  // (matches the composerTextRef pattern in HappyComposer).
  const notesTextRef = useRef(notesText);
  notesTextRef.current = notesText;
  const composerSetTextRef = useRef<((text: string) => void) | null>(null);
  const composerGetTextRef = useRef<(() => string) | null>(null);
  // #3333: focus the composer textarea (registered by HappyComposer) — the seam
  // the approval card's Decline action uses alongside set/get text.
  const composerFocusRef = useRef<(() => void) | null>(null);
  // #3333: prefill the composer draft + focus WITHOUT sending — the approval
  // card's Decline seam. Only prefills when the draft is empty (never clobbers an
  // in-progress draft); always focuses. Stable identity (deps: none — reads live
  // refs), so it can flow into the HappyChatContext value without re-renders.
  const prefillComposer = useCallback((text: string) => {
    const current = composerGetTextRef.current?.() ?? "";
    if (current.trim() === "") {
      composerSetTextRef.current?.(text);
    }
    composerFocusRef.current?.();
  }, []);
  // #1075: attachment-transfer channels (mirror the composerSetTextRef pattern).
  // composerAbsorbAttachmentsRef pushes notes → composer; notesReceiveMoveRef
  // routes a composer → notes move (text + attachments) into SessionNotes.
  const composerAbsorbAttachmentsRef = useRef<
    ((incoming: Attachment[]) => void) | null
  >(null);
  const notesReceiveMoveRef = useRef<
    ((payload: { text: string; attachments: Attachment[] }) => void) | null
  >(null);

  // Debounced collapse state persistence (#455).
  // #1079: the merged-row dock layout (computeMergeGroups below) depends on the
  // collapse state, so it must react to a toggle INSTANTLY. The persist is
  // debounced and round-trips via the server (updateSessionUiCollapseState → SSE
  // → session refetch), which lags ~400ms and never completes for an inactive
  // session — reading props.session.uiCollapseState directly would leave a
  // toggled section mis-placed in the merged row for that whole window. So hold
  // the collapse state locally, update it synchronously in saveCollapseState, and
  // re-seed from the server only when the session changes (reload / other-device
  // reads still come from the server on mount — R7).
  const [collapseState, setCollapseState] = useState<UiCollapseState | null>(
    props.session.uiCollapseState ?? null
  );
  const collapseDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const latestCollapseRef = useRef<UiCollapseState>({
    promptCollapsed: collapseState?.promptCollapsed,
    notesCollapsed: collapseState?.notesCollapsed,
    tokenUsageCollapsed: collapseState?.tokenUsageCollapsed,
    detailsCollapsed: collapseState?.detailsCollapsed,
    backgroundAgentsCollapsed: collapseState?.backgroundAgentsCollapsed,
  });
  // #3275: track the session id the pending debounced write is bound to, so the
  // re-seed effect can flush it against the CORRECT (previous) session id before
  // overwriting latestCollapseRef with the new session's server state.
  const prevSessionIdRef = useRef(props.session.id);

  // #1079: re-seed the local collapse state (and the persist ref) from the server
  // when navigating to a DIFFERENT session — the component may stay mounted across
  // session changes. Keyed on session id so an in-flight optimistic toggle on the
  // CURRENT session is never clobbered by a refetch that has not yet caught up to
  // the debounced write.
  useEffect(() => {
    // #3275: before re-seeding for the new session, flush any pending debounced
    // write. It is bound to the PREVIOUS session id (saveCollapseState's closure
    // captured it), but we are about to overwrite latestCollapseRef with the NEW
    // session's state. Without this flush the stale timer would PUT the new
    // session's collapse state onto the previous session's row — an R2
    // cross-write. Flush against the previous id, clear the timer, then re-seed.
    if (collapseDebounceRef.current) {
      clearTimeout(collapseDebounceRef.current);
      collapseDebounceRef.current = null;
      props.api
        .updateSessionUiCollapseState(
          prevSessionIdRef.current,
          latestCollapseRef.current
        )
        .catch(e => console.error("Failed to flush collapse state:", e));
    }
    prevSessionIdRef.current = props.session.id;
    const server = props.session.uiCollapseState ?? null;
    setCollapseState(server);
    latestCollapseRef.current = {
      promptCollapsed: server?.promptCollapsed,
      notesCollapsed: server?.notesCollapsed,
      tokenUsageCollapsed: server?.tokenUsageCollapsed,
      detailsCollapsed: server?.detailsCollapsed,
      backgroundAgentsCollapsed: server?.backgroundAgentsCollapsed,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.session.id]);

  const saveCollapseState = useCallback(
    (field: keyof UiCollapseState, value: boolean) => {
      // #1079: update the local state synchronously so the merged-row layout
      // reconfigures on THIS render — do not wait for the debounced server write
      // (which lags and never lands for an inactive session).
      setCollapseState(prev => ({ ...prev, [field]: value }));
      latestCollapseRef.current = {
        ...latestCollapseRef.current,
        [field]: value,
      };
      if (collapseDebounceRef.current) {
        clearTimeout(collapseDebounceRef.current);
      }
      collapseDebounceRef.current = setTimeout(() => {
        props.api
          .updateSessionUiCollapseState(
            props.session.id,
            latestCollapseRef.current
          )
          .catch(e => console.error("Failed to save collapse state:", e));
      }, 250);
    },
    [props.api, props.session.id]
  );

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (collapseDebounceRef.current) {
        clearTimeout(collapseDebounceRef.current);
      }
    };
  }, []);

  // #3638: full-screen page mode — the state machine is extracted to a hook
  // (SessionChat is at the 1500-line ESLint cap). It owns the local isFullscreen
  // state, the X2 local dock-collapse override, the X1 Back interceptor +
  // blocker, and X4 per-device persistence + restore. The app-bar hide is lifted
  // via useThreadFullscreen and set by the hook in single view only.
  const {
    isFullscreen,
    toggleFullscreen,
    fullscreenOverride,
    setFullscreenOverride,
    notesPopoutActive,
    setNotesPopoutActive,
  } = useThreadFullscreenMode({
    session: props.session,
    inSplitPane: props.inSplitPane,
  });
  // #4004: iPad windowed mode overlays window controls on the full-screen gutter.
  const isIPadMultitasking = useIPadMultitasking();

  // Measure total dock height (composer + notes + token usage) for button positioning
  useEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    setDockHeight(dock.offsetHeight);
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const height =
          entry.borderBoxSize?.[0]?.blockSize ??
          (entry.target as HTMLElement).offsetHeight;
        setDockHeight(height);
      }
    });
    observer.observe(dock);
    return () => observer.disconnect();
  }, []);

  // Swipe-from-left-edge gesture for back navigation (iPhone)
  const { handlers: swipeBackHandlers } = useSwipeBack({
    onSwipeBack: props.onBack,
  });

  // User message navigation - use the viewport ref from scroll state.
  // totalUserMessages is conversation-wide truth: server's per-session user count
  // plus the inherited parent tail (for branched sessions).
  const viewportRefForNav = scrollState?.viewportRef ?? { current: null };
  const parentUserMessageCount = useMemo(
    () => props.parentMessages?.filter(isUserMessage).length ?? 0,
    [props.parentMessages]
  );
  const totalUserMessages =
    (props.serverMessageCount ?? 0) + parentUserMessageCount;
  const userNav = useUserMessageNavigation(viewportRefForNav, {
    loadMore: props.onLoadMore,
    hasMore: props.hasMoreMessages,
    isLoadingMore: props.isLoadingMoreMessages,
    totalUserMessages,
  });
  // Message bookmarks (#983). ONE per-session instance owned here — threaded to
  // the message renderers via HappyChatContext (for the gutter icons + toggle)
  // AND consumed by the bookmark-nav overlay below. The nav mirrors the
  // user-message nav's cursor/auto-paging model (same viewport ref + pagination
  // inputs), so scroll-to-bookmark routes through the same single-scroll-owner
  // path (#2858) as the user nav rather than a second programmatic scroller.
  const bookmarks = useBookmarks(props.session.id);
  const bookmarkNav = useBookmarkNavigation(viewportRefForNav, {
    bookmarks: bookmarks.bookmarks,
    loadMore: props.onLoadMore,
    hasMore: props.hasMoreMessages,
    isLoadingMore: props.isLoadingMoreMessages,
  });
  const normalizedCacheRef = useRef<
    Map<
      string,
      { source: DecryptedMessage; normalized: NormalizedMessage | null }
    >
  >(new Map());
  const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map());
  const agentFlavor = props.session.metadata?.flavor ?? null;
  // Epic #3285 round 15c: the prompt-box Account Chip (Session Config Cluster)
  // reads the SAME resolver as the list badge, the header badge, and the
  // Session Configuration modal — with the header's nodeId override — so a
  // session that recorded no account names its node's active account here too,
  // and the four surfaces cannot disagree. (It used to read the raw recorded
  // value via getAccountEmail and rendered nothing for such a session.)
  const {
    email: accountEmail,
    source: accountSource,
    keyName: apiKeyName,
  } = useSessionAccountEmail(props.api, props.session, props.nodeId);
  const {
    abortSession,
    switchSession,
    setPermissionMode,
    setModelMode,
    setSessionEffort,
    setSessionRawModel,
  } = useSessionActions(props.api, props.session.id, agentFlavor);
  const { showToast } = useToast();
  // Issue #2768: optimistic in-session MODE display. The model label prefers the
  // lagging `resolvedModel` (sdk: updates on the next message), so a cache patch
  // alone can't show a mode pick without flickering back on reconcile. This
  // pending-override shows the picked mode instantly and bridges that gap,
  // reverting + toasting on a genuine family mismatch (a no-next-turn timeout
  // reverts silently — OR-3). effort/rawModel need no override — they render
  // directly from session.* and reconcile with no lag (see useSessionActions).
  const { pendingMode, switchTo, cancelSwitch } = useModelSwitchVerification({
    resolvedModel: props.session.resolvedModel,
    onMismatch: () =>
      showToast("Model didn't switch — reverted", { type: "error" }),
  });

  useEffect(() => {
    normalizedCacheRef.current.clear();
    blocksByIdRef.current.clear();
  }, [props.session.id]);

  // Sync notes text when session changes (#1075: parse the envelope for text).
  useEffect(() => {
    setNotesText(parseNotes(props.session.notes).text);
  }, [props.session.id, props.session.notes]);

  const normalizedMessages: NormalizedMessage[] = useMemo(() => {
    const cache = normalizedCacheRef.current;
    const normalized: NormalizedMessage[] = [];
    const seen = new Set<string>();
    for (const message of props.messages) {
      seen.add(message.id);
      const cached = cache.get(message.id);
      if (cached && cached.source === message) {
        if (cached.normalized) normalized.push(cached.normalized);
        continue;
      }
      const next = normalizeDecryptedMessage(message);
      cache.set(message.id, { source: message, normalized: next });
      if (next) normalized.push(next);
    }
    for (const id of cache.keys()) {
      if (!seen.has(id)) {
        cache.delete(id);
      }
    }
    return normalized;
  }, [props.messages]);

  // Normalize parent session messages for branch context carry-over.
  // Parent messages are tagged with isInherited so renderers can apply muted styling.
  const parentNormalized: NormalizedMessage[] = useMemo(() => {
    if (!props.parentMessages?.length) return [];
    const result: NormalizedMessage[] = [];
    for (const message of props.parentMessages) {
      const next = normalizeDecryptedMessage(message);
      if (next) {
        result.push({ ...next, isInherited: true });
      }
    }
    return result;
  }, [props.parentMessages]);

  // Compute branch context summary from parent messages for orientation card.
  const branchSummary = useBranchSummary(
    props.session,
    props.parentMessages ?? []
  );

  // Concatenate parent messages + branch separator + branch messages.
  // The separator is a synthetic event message rendered as a visual divider.
  // When a branch summary is available, it's attached to the separator event
  // so SystemMessage.tsx can render the BranchSummaryCard below the divider.
  const allNormalizedMessages: NormalizedMessage[] = useMemo(() => {
    if (!parentNormalized.length) return normalizedMessages;
    const separator: NormalizedMessage = {
      id: `branch-separator-${props.session.id}`,
      localId: null,
      createdAt: props.session.branchCreatedAt ?? Date.now(),
      role: "event",
      isSidechain: false,
      content: branchSummary
        ? { type: "branch-point", summary: branchSummary }
        : { type: "branch-point" },
    };
    return [...parentNormalized, separator, ...normalizedMessages];
  }, [
    parentNormalized,
    normalizedMessages,
    props.session.id,
    props.session.branchCreatedAt,
    branchSummary,
  ]);

  const reduced = useMemo(
    () => reduceChatBlocks(allNormalizedMessages, props.session.agentState),
    [allNormalizedMessages, props.session.agentState]
  );
  // #3177: the activity placeholder is appended to the blocks here; the
  // running-tool signals (incl. #3505's recency input) live in the hook.
  const {
    blocks: tailBlocks,
    hasRunningTools,
    runningToolsStartedAt,
  } = useThinkingPlaceholder({
    api: props.api,
    blocks: reduced.blocks,
    session: props.session,
  });
  const reconciled = useMemo(
    () => reconcileChatBlocks(tailBlocks, blocksByIdRef.current),
    [tailBlocks]
  );

  useEffect(() => {
    blocksByIdRef.current = reconciled.byId;
  }, [reconciled.byId]);

  // Permission mode change handler
  const handlePermissionModeChange = useCallback(
    async (mode: PermissionMode) => {
      try {
        await setPermissionMode(mode);
        haptic.notification("success");
        showToast("Permission mode updated", { type: "success" });
        props.onRefresh();
      } catch (e) {
        haptic.notification("error");
        console.error("Failed to set permission mode:", e);
        showToast("Failed to change permission mode", { type: "error" });
      }
    },
    [setPermissionMode, props.onRefresh, haptic, showToast]
  );

  // Model mode change handler
  const handleModelModeChange = useCallback(
    async (mode: ModelMode) => {
      // Issue #2768: fire the optimistic pending-override BEFORE the mutation so
      // the picked mode shows instantly; clear it if the mutation is rejected so
      // the display reverts immediately (not after the 60s silent timeout).
      switchTo(mode);
      try {
        await setModelMode(mode);
        haptic.notification("success");
        showToast("Model updated", { type: "success" });
        props.onRefresh();
      } catch (e) {
        cancelSwitch();
        haptic.notification("error");
        console.error("Failed to set model mode:", e);
        showToast("Failed to change model", { type: "error" });
      }
    },
    [setModelMode, switchTo, cancelSwitch, props.onRefresh, haptic, showToast]
  );

  // Issue #2882: effort + specific-model handlers, wired into the composer's
  // relocated model/effort picker (ComposerModelEffortPicker).
  const handleEffortChange = useCallback(
    async (level: EffortLevel) => {
      try {
        await setSessionEffort(level);
        haptic.notification("success");
        showToast("Effort updated", { type: "success" });
        props.onRefresh();
      } catch (e) {
        haptic.notification("error");
        console.error("Failed to set effort:", e);
        showToast("Failed to change effort", { type: "error" });
      }
    },
    [setSessionEffort, props.onRefresh, haptic, showToast]
  );

  const handleRawModelChange = useCallback(
    async (rawModel: string) => {
      try {
        await setSessionRawModel(rawModel);
        haptic.notification("success");
        showToast("Model updated", { type: "success" });
        props.onRefresh();
      } catch (e) {
        haptic.notification("error");
        console.error("Failed to set model:", e);
        showToast("Failed to change model", { type: "error" });
      }
    },
    [setSessionRawModel, props.onRefresh, haptic, showToast]
  );

  // Abort handler — abort is already non-blocking (no confirm modal); surface
  // failures via Toast rather than an unhandled rejection (issue #1902).
  const handleAbort = useCallback(async () => {
    try {
      await abortSession();
      props.onRefresh();
    } catch (e) {
      console.error("Failed to abort session:", e);
      showToast("Failed to abort session", { type: "error" });
    }
  }, [abortSession, props.onRefresh, showToast]);

  // Switch to remote handler
  const handleSwitchToRemote = useCallback(async () => {
    await switchSession();
    props.onRefresh();
  }, [switchSession, props.onRefresh]);

  // #3286 (View Picker): Files/Terminal/Desktop view navigation now lives in the
  // shared <ViewPicker>; the old SessionChat handlers + entry points retire here
  // (D2(a)). claude-pty stays a secondary affordance (D5(a)), so its handler
  // remains for onViewClaudePty and the "waiting on a terminal prompt" button.
  const handleViewClaudePty = useCallback(() => {
    navigate({
      to: "/sessions/$sessionId/claude-pty",
      params: { sessionId: props.session.id },
    });
  }, [navigate, props.session.id]);

  // #3286 (View Picker · R2): one-shot open-redirect to the persisted view. Fires
  // once per session-open when the effective view (server ?? no-flash cache ??
  // default) is a non-chat AVAILABLE view — from the synchronous cache (no flash,
  // R7) or when the server value arrives (cross-device). Back-loop-safe: the
  // consumed flag is set here and cleared only when navigation leaves the session
  // (router reconcile), so Back — which strips the last segment to the chat route
  // (useAppGoBack) — never re-loops, yet a genuine reopen re-arms.
  useEffect(() => {
    const sid = props.session.id;
    if (hasConsumedOpenRedirect(sid)) return;
    const effectiveView = computeEffectiveSessionView(props.session, sid);
    if (
      effectiveView !== "chat" &&
      isSessionViewAvailable(effectiveView, props.session)
    ) {
      markOpenRedirectConsumed(sid);
      navigate({ to: sessionViewToPath(effectiveView, sid) });
    }
  }, [props.session, navigate]);

  // Handler for moving notes content to composer (#1075: text + attachments).
  // Appends the text and absorbs the notes attachments into the composer's box.
  const handleMoveNotesToComposer = useCallback(
    (payload: { text: string; attachments: Attachment[] }): boolean => {
      // Issue #1079 (R12 / Decision 4): if the composer is not mounted (e.g. a
      // fresh load with the prompt collapsed), its transfer channel is
      // unregistered — report non-delivery so SessionNotes preserves the notes
      // instead of clearing them. With HappyComposer kept mounted in every
      // permutation (suppressCollapsedHeading), this channel is always live when
      // Notes is expanded, so the false branch is defense-in-depth.
      if (!composerSetTextRef.current) {
        return false;
      }
      if (payload.text) {
        const current = composerGetTextRef.current?.()?.trim() ?? "";
        const newText = current ? `${current}\n${payload.text}` : payload.text;
        composerSetTextRef.current(newText);
      }
      if (payload.attachments.length > 0) {
        composerAbsorbAttachmentsRef.current?.(payload.attachments);
      }
      return true;
    },
    []
  );

  // Handler for moving composer content to notes (#1075: text + attachments).
  // Routes the move into SessionNotes.receiveMove, which absorbs the attachments,
  // appends the text, and persists the combined envelope. The fallback preserves
  // the #2766 text-only persist when SessionNotes has not registered its receiver
  // (Fallback Preservation Rule): #2766 persisted the pushed-in text to the
  // server so it survives session-view navigation.
  const handleMoveComposerToNotes = useCallback(
    (payload: { text: string; attachments: Attachment[] }) => {
      if (notesReceiveMoveRef.current) {
        notesReceiveMoveRef.current(payload);
        return;
      }
      const textToAdd = payload.text;
      const prev = notesTextRef.current;
      const newText = (prev ? `${prev}${textToAdd}` : textToAdd).slice(
        0,
        MAX_NOTES_LENGTH
      );
      setNotesText(newText);
      // Preserve any already-persisted attachments (#1075) — the fallback has no
      // live notes-attachment state, so read them from the session's envelope.
      const existingAttachments = parseNotes(props.session.notes).attachments;
      void props.api
        .updateSessionNotes(props.session.id, {
          text: newText,
          attachments: existingAttachments,
        })
        .catch(() => {
          // Non-blocking: a failed persist leaves the optimistic local value in
          // place; the next Notes edit/blur retries the write.
        });
    },
    [props.api, props.session.id, props.session.notes]
  );

  // Issue #1671: server-authoritative session token stats (totals + per-turn
  // breakdown). The breakdown feeds the per-turn footer; totals feed the status
  // line + TokenUsageSection. Falls back to the client aggregate when absent (R7).
  const tokenStats = useSessionTokenStats(props.api, props.session.id);
  // Issue #1672 (Sub J): per-turn workflow chips + session checkpoint badge.
  const workflowState = useSessionWorkflowState(props.api, props.session.id);

  const { runtime, turnDurations, turnStatusTexts, turnTokens, turnWorkflow } =
    useHappyRuntime({
      session: props.session,
      blocks: reconciled.blocks,
      isSending: props.isSending,
      onSendMessage: props.onSend,
      onAbort: handleAbort,
      turnBreakdown: tokenStats.data?.turns,
      turnWorkflow: workflowState.data?.turns,
    });

  // Issue #1671: prefer the server-authoritative session totals
  // (`v_session_totals`) for the Token Usage widget; fall back to the client
  // reducer aggregate (which undercounts — 50-msg pages + browser memory) with
  // an explicit "estimate" marker (R7, Fallback Preservation Rule). Peak context
  // + the per-turn sparkline are supplementary and stay client-derived (the view
  // does not track them).
  const serverTotals = tokenStats.data?.totals ?? null;
  const displayTokenStats: SessionTokenStats | null = useMemo(() => {
    if (serverTotals) {
      return {
        totalInput: serverTotals.totalTokIn ?? 0,
        totalOutput: serverTotals.totalTokOut ?? 0,
        totalCacheCreation: serverTotals.totalTokCacheWrite ?? 0,
        totalCacheRead: serverTotals.totalTokCacheRead ?? 0,
        turnCount: serverTotals.turnCount,
        peakContextSize: reduced.tokenStats?.peakContextSize ?? 0,
        timeline: reduced.tokenStats?.timeline ?? [],
      };
    }
    return reduced.tokenStats;
  }, [serverTotals, reduced.tokenStats]);

  // Issue #1079: the dock renders contiguous COLLAPSED sections (Prompt / Notes
  // / Token Usage) as a single merged row; any EXPANDED section breaks to its
  // own full-width row. Defaults match the per-section render defaults below:
  // prompt/notes default expanded (?? false), tokenUsage defaults collapsed
  // (?? true, matching the TokenUsageSection initialCollapsed default).
  // #3638: synced (non-full-screen) collapse resolution — the existing per-section
  // defaults made EXPLICIT, so full-screen EXIT never feeds `undefined` to the
  // never-remounted composer (HappyComposer returns early on `undefined`, so a
  // stale collapsed value would otherwise stick).
  const syncedPromptCollapsed = collapseState?.promptCollapsed ?? false;
  const syncedNotesCollapsed =
    collapseState?.notesCollapsed ??
    !(notesText.length > 0 || parsedSessionNotes.attachments.length > 0);
  const syncedTokenUsageCollapsed = collapseState?.tokenUsageCollapsed ?? true;
  const syncedDetailsCollapsed = collapseState?.detailsCollapsed ?? true;
  // Background Agents breakout inside the Context widget (2026-10-05): default
  // EXPANDED (the 5-row cap bounds it); collapsing is the user's synced opt-in.
  const syncedBackgroundAgentsCollapsed =
    collapseState?.backgroundAgentsCollapsed ?? false;

  // #3638 (X2): effective collapse — the LOCAL override in full-screen, the synced
  // state otherwise. Full-screen defaults everything collapsed (mockup panel D);
  // the pop-out guard keeps Notes at its synced value while it is popped out
  // (forcing it collapsed would move rows and destroy the pop-out window — R3).
  const effectiveCollapse = isFullscreen
    ? {
        promptCollapsed: fullscreenOverride?.promptCollapsed ?? true,
        notesCollapsed: notesPopoutActive
          ? syncedNotesCollapsed
          : (fullscreenOverride?.notesCollapsed ?? true),
        tokenUsageCollapsed: fullscreenOverride?.tokenUsageCollapsed ?? true,
        detailsCollapsed: fullscreenOverride?.detailsCollapsed ?? true,
        backgroundAgentsCollapsed:
          fullscreenOverride?.backgroundAgentsCollapsed ??
          syncedBackgroundAgentsCollapsed,
      }
    : {
        promptCollapsed: syncedPromptCollapsed,
        notesCollapsed: syncedNotesCollapsed,
        tokenUsageCollapsed: syncedTokenUsageCollapsed,
        detailsCollapsed: syncedDetailsCollapsed,
        backgroundAgentsCollapsed: syncedBackgroundAgentsCollapsed,
      };

  // #3638 (X2): route dock-collapse WRITES to the local override in full-screen,
  // and to the synced saveCollapseState otherwise — never both. No full-screen
  // path reaches saveCollapseState / latestCollapseRef (the 0-call test gate).
  const setCollapse = (field: keyof UiCollapseState, value: boolean) => {
    if (isFullscreen) {
      setFullscreenOverride(prev => ({ ...prev, [field]: value }));
    } else {
      saveCollapseState(field, value);
    }
  };

  const promptCollapsed = effectiveCollapse.promptCollapsed;
  // #3677: dock-collapse derivations flow through `effectiveCollapse` (the single
  // source of truth). Its non-full-screen branch IS `syncedNotesCollapsed` (which
  // mirrors SessionNotes' empty-collapsed default, keeping the merge computation in
  // agreement with what SessionNotes renders), so non-full-screen behaviour is
  // byte-identical; its full-screen branch applies the panel-D collapsed default
  // (pop-out guard intact).
  const notesCollapsed = effectiveCollapse.notesCollapsed;
  const tokenUsageCollapsed = effectiveCollapse.tokenUsageCollapsed;
  // #3275: details expand/collapse is per-session server state (default
  // collapsed). SessionHeader is a controlled child — it no longer owns a
  // private localStorage boolean.
  const detailsExpanded = !effectiveCollapse.detailsCollapsed;
  const mergeGroups = computeMergeGroups({
    promptCollapsed,
    notesCollapsed,
    tokenUsageCollapsed,
    hasTokenStats: Boolean(displayTokenStats),
  });

  // Issue #1079: Notes and Token Usage each render in either a merged row
  // (chromeless) or their own expanded row. The two call sites are identical
  // apart from `chromeless`, so one render helper each keeps them from drifting.
  // Each remounts when it moves between the merged row and its own row (different
  // parent) — SAFE per Decision 4 (notes text is lifted to `notesText` and
  // re-seeded via `initialNotes`; Token Usage is derived, no editing state).
  const renderNotes = (chromeless: boolean) => (
    <SessionNotes
      api={props.api}
      sessionId={props.session.id}
      sessionName={getSessionTitle(props.session)}
      initialNotes={notesText}
      initialNotesAttachments={parsedSessionNotes.attachments}
      onMoveToComposer={handleMoveNotesToComposer}
      onReceiveMoveRef={fn => {
        notesReceiveMoveRef.current = fn;
      }}
      onNotesChange={setNotesText}
      initialNotesCollapsed={
        // #3638: feed the LOCAL override in full-screen; keep the exact raw
        // passthrough otherwise (SessionNotes' own default already equals the
        // resolved synced value, so non-full-screen behaviour is unchanged).
        isFullscreen ? notesCollapsed : collapseState?.notesCollapsed
      }
      onNotesCollapseChange={collapsed =>
        setCollapse("notesCollapsed", collapsed)
      }
      onPopOutActiveChange={setNotesPopoutActive}
      chromeless={chromeless}
    />
  );
  const renderTokenUsage = (chromeless: boolean) =>
    displayTokenStats ? (
      <TokenUsageSection
        stats={displayTokenStats}
        serverCost={serverTotals?.totalCost ?? null}
        // Issue #4824: the split by each turn's recorded binding (real /
        // equivalent / unattributed) — absent from an older peer.
        costSplit={serverTotals}
        isServerSourced={serverTotals != null}
        authBindingKind={props.session.metadata?.authBinding?.kind}
        sessionId={props.session.id}
        resolvedModel={props.session.resolvedModel}
        contextWindowTokens={props.session.contextWindowTokens}
        contextPercentage={props.session.contextPercentage}
        contextUsedTokens={props.session.contextUsedTokens}
        contextSize={reduced.latestUsage?.contextSize}
        initialCollapsed={tokenUsageCollapsed}
        onCollapseChange={collapsed =>
          setCollapse("tokenUsageCollapsed", collapsed)
        }
        backgroundAgentsCollapsed={effectiveCollapse.backgroundAgentsCollapsed}
        onBackgroundAgentsCollapseChange={collapsed =>
          setCollapse("backgroundAgentsCollapsed", collapsed)
        }
        chromeless={chromeless}
      />
    ) : null;

  return (
    <div className="flex h-full flex-col" {...swipeBackHandlers}>
      {/* #3638: full-screen page mode hides the tab strip (pane-local chrome, so
          hidden in split view too). */}
      {!isFullscreen && (
        <ViewPicker session={props.session} api={props.api} activeView="chat" />
      )}
      {!isFullscreen && (
        <SessionHeader
          session={props.session}
          detailsExpanded={detailsExpanded}
          onToggleDetails={() =>
            setCollapse("detailsCollapsed", detailsExpanded)
          }
          onViewClaudePty={
            props.session.active ? handleViewClaudePty : undefined
          }
          api={props.api}
          onSessionDeleted={props.onBack}
          onReconnect={newSessionId => {
            navigate({
              to: "/sessions/$sessionId",
              params: { sessionId: newSessionId },
            });
          }}
          needsReview={props.needsReview}
          onToggleReadStatus={props.onToggleReadStatus}
          messageCount={
            props.serverMessageCount ??
            props.messages.filter(isUserMessage).length
          }
          nodeId={props.nodeId}
          nodeLabel={props.nodeLabel}
          nodeUrl={props.nodeUrl}
          nodeStatus={props.nodeStatus}
          hasRunningTools={hasRunningTools}
          runningToolsStartedAt={runningToolsStartedAt}
          workflowBadge={workflowState.data?.badge ?? null}
        />
      )}

      {/* Issue #3272 (operator ruling 2026-08-25; epic #3285 correction pass 1):
          the offline notice is a SLIM muted-red bar seated IMMEDIATELY under the
          header block — i.e. under the Session Details panel when expanded, under
          the Basic Info Bar when collapsed — never the old 5-line gray bubble. */}
      {controlsDisabled ? <SessionOfflineBar /> : null}

      {/* Extension session-detail info bar (#1285, Sub-Issue U of epic #1264).
          Sub-Issue C (#1267) shipped <SessionDetailInfoFields /> unmounted and
          deferred the placement to T/U; this is that decision. A compact
          horizontal strip between the header and the thread — the at-a-glance
          surface, deliberately distinct from the collapsible <TokenUsageSection>
          analytical widget below the composer.

          TWO gates, because the host gate alone is not sufficient (#1285):
          1. `getSessionDetailInfoFields().length > 0` — zero CONTRIBUTIONS,
             the R6/R10 case C (#1267) guarantees.
          2. `empty:hidden` — zero RENDERED OUTPUT. A registered field may still
             render null for this particular session (TokenUsageField does
             exactly that until the session has token usage, R2). Without this,
             every brand-new session paints a stray 1px divider over 8px of
             empty padding. `:empty` matches an element with no child nodes at
             all, which is precisely the null-render case.
          Single div rather than an outer/inner pair so `:empty` can see the
          slot output directly; the border therefore spans `max-w-content`,
          aligning it with the message thread below. `flex-wrap` lets multiple
          fields wrap at 393px (iPhone 16). */}
      {/* #3638: the extension info strip is chrome — hidden in full-screen. */}
      {!isFullscreen && host.getSessionDetailInfoFields().length > 0 ? (
        <SessionDetailProvider sessionId={props.session.id}>
          <div
            className="mx-auto flex w-full max-w-content flex-wrap items-center gap-3 border-b border-[var(--app-hover)] px-3 py-1 empty:hidden"
            data-testid="session-detail-info-bar"
          >
            <SessionDetailInfoFields />
          </div>
        </SessionDetailProvider>
      ) : null}

      {/* Issue #3315 (operator ruling 2026-08-26; epic #3285 correction pass 1):
          the #3128 "Rate this session" HarnessRating strip is REMOVED from the
          session view for good. The scorecard endpoint stays server-side for
          non-UI consumers. */}

      <HappyRuntimeProvider
        runtime={runtime}
        turnDurations={turnDurations}
        turnStatusTexts={turnStatusTexts}
        turnTokens={turnTokens}
        turnWorkflow={turnWorkflow}
      >
        <div className="relative flex min-h-0 flex-1 flex-col">
          {/* Text scale control — floating overlay pinned to the BOOKMARK GUTTER
              column at the top-left of the thread area (E9 mockup
              claudedocs/design-mockups/e9/text-scale-gutter.html, approved
              2026-09-06; applied epic #3285 round 13 after the operator reported
              it missing three times). left-0, not left-2: the collapsed label
              (TextScaleControl) is exactly the gutter column wide — the thread's
              pl-1 (4px) + BookmarkGutter's w-5 (20px) = 24px — and centered, so
              every label from 80% to 150% ends BEFORE the message's colored
              left border instead of straddling it (the old left-2 + px-1.5 box
              ran 12→48px against a border at 32px). The expanded A- · N% · A+
              control keeps this same left anchor and, as before, overlays the
              message while open. */}
          <div
            className="absolute left-0 top-1 z-10 flex w-6 flex-col items-center gap-1.5"
            style={
              // #4004: clear iPad window controls (single-view full-screen).
              isFullscreen && isIPadMultitasking && !props.inSplitPane
                ? { top: IPAD_FULLSCREEN_GUTTER_TOP }
                : undefined
            }
          >
            {/* #3638: gutter expand/compress toggle — the mockup's `.gutter`
                column (24px wide, toggle on top, text-size label below it). The
                compress glyph is mint (`text-accent`) when full-screen is active,
                matching panels A/D. */}
            <BareButton
              type="button"
              onClick={toggleFullscreen}
              aria-pressed={isFullscreen}
              title={
                isFullscreen ? "Exit full-screen thread" : "Full-screen thread"
              }
              aria-label={
                isFullscreen ? "Exit full-screen thread" : "Full-screen thread"
              }
              className={`flex h-6 w-6 items-center justify-center rounded-md bg-[var(--app-bg)]/60 opacity-50 transition-opacity hover:opacity-80 ${
                isFullscreen ? "text-accent" : "text-[var(--app-hint)]"
              }`}
            >
              {isFullscreen ? (
                <ThreadMinimizeIcon className="h-3.5 w-3.5" />
              ) : (
                <ThreadMaximizeIcon className="h-3.5 w-3.5" />
              )}
            </BareButton>
            <TextScaleControl
              scaleLabel={textScaleLabel}
              // #3158: capture the top-visible anchor BEFORE the scale changes so
              // HappyThread can re-anchor to the same line after the font re-lays
              // out (rather than the viewport jumping).
              onIncrement={() => {
                captureTopAnchorRef.current?.();
                incrementScale();
              }}
              onDecrement={() => {
                captureTopAnchorRef.current?.();
                decrementScale();
              }}
              canIncrement={canIncrementScale}
              canDecrement={canDecrementScale}
            />
          </div>
          <HappyThread
            key={props.session.id}
            api={props.api}
            sessionId={props.session.id}
            metadata={props.session.metadata}
            disabled={controlsDisabled}
            onRefresh={props.onRefresh}
            onRetryMessage={props.onRetryMessage}
            prefillComposer={prefillComposer}
            isLoadingMessages={props.isLoadingMessages}
            messagesWarning={props.messagesWarning}
            hasMoreMessages={props.hasMoreMessages}
            isLoadingMoreMessages={props.isLoadingMoreMessages}
            onLoadMore={props.onLoadMore}
            rawMessagesCount={props.messages.length}
            normalizedMessagesCount={allNormalizedMessages.length}
            // #3177: exclude the activity placeholder from the new-message count.
            renderedMessagesCount={reduced.blocks.length}
            onScrollStateChange={setScrollState}
            textScale={textScale}
            // #3158: register HappyThread's top-anchor capture so the text-size
            // handlers above can fire it before the scale changes.
            onCaptureTopAnchorRef={fn => {
              captureTopAnchorRef.current = fn;
            }}
            bookmarks={bookmarks}
          />

          {/* Jump navigation buttons - pinned above the bottom dock */}
          {/* 36px circles: `--nav-circle` (2026-10-05), split from the composer's 44px `--control-touch` */}
          {/* Buttons stay horizontally centered in all section-collapse states (#1297) */}
          {scrollState?.showJumpButton ||
          (scrollState?.newMessageCount ?? 0) > 0 ||
          userNav.totalCount > 1 ||
          bookmarkNav.totalCount > 0 ? (
            <div
              className="absolute pointer-events-none z-10 animate-bounce-in transition-[bottom] duration-200 left-0 right-0 flex justify-center"
              style={{
                bottom: `${dockHeight + 8}px`,
              }}
            >
              <div className="flex items-center gap-2 pointer-events-auto">
                {/* LEFTMOST: Bookmark navigation (#983). Single visibility gate
                    `bookmarkNav.totalCount > 0` (rendered bookmarked elements),
                    NEVER the raw localStorage set — a size-based gate would show
                    an empty overlay after reloading a long session. */}
                {bookmarkNav.totalCount > 0 ? (
                  <>
                    <BareButton
                      onClick={() => {
                        if (bookmarkNav.isAutoPaging) {
                          haptic.selection();
                          bookmarkNav.abortAutoPage();
                        } else {
                          haptic.selection();
                          bookmarkNav.goToPrevious();
                        }
                      }}
                      disabled={
                        !bookmarkNav.isAutoPaging && !bookmarkNav.hasPrevious
                      }
                      className="bg-[var(--app-bookmark-bg)] text-[var(--app-bookmark)] border-2 border-[var(--app-bookmark)]/40 p-1.5 rounded-full shadow-md min-w-[var(--nav-circle)] min-h-[var(--nav-circle)] flex items-center justify-center backdrop-blur-sm opacity-30 hover:opacity-90 active:opacity-90 disabled:opacity-20 transition-opacity duration-150"
                      aria-label={
                        bookmarkNav.isAutoPaging
                          ? "Cancel loading older messages"
                          : "Previous bookmark"
                      }
                      title={
                        bookmarkNav.isAutoPaging
                          ? "Cancel loading older messages"
                          : "Previous bookmark"
                      }
                    >
                      {bookmarkNav.isAutoPaging ? (
                        <span className="relative inline-flex h-4 w-4 items-center justify-center">
                          <Spinner
                            size="sm"
                            label={null}
                            className="absolute inset-0 text-current"
                          />
                          <CloseIcon className="relative h-3 w-3" />
                        </span>
                      ) : (
                        <BookmarkIcon className="h-4 w-4 rotate-180" />
                      )}
                    </BareButton>
                    <BareButton
                      onClick={() => {
                        haptic.selection();
                        bookmarkNav.goToNext();
                      }}
                      disabled={
                        !bookmarkNav.hasNext || bookmarkNav.isAutoPaging
                      }
                      className="bg-[var(--app-bookmark-bg)] text-[var(--app-bookmark)] border-2 border-[var(--app-bookmark)]/40 p-1.5 rounded-full shadow-md min-w-[var(--nav-circle)] min-h-[var(--nav-circle)] flex items-center justify-center backdrop-blur-sm opacity-30 hover:opacity-90 active:opacity-90 disabled:opacity-20 transition-opacity duration-150"
                      aria-label="Next bookmark"
                      title="Next bookmark"
                    >
                      <BookmarkIcon className="h-4 w-4" />
                    </BareButton>
                  </>
                ) : null}

                {/* LEFT OF CENTER: Jump to Top/Bottom */}
                {scrollState?.showJumpButton ||
                (scrollState?.newMessageCount ?? 0) > 0 ? (
                  <>
                    <Button
                      variant="default"
                      onClick={scrollState?.scrollToTop}
                      className="border-2 border-black p-1.5 rounded-full shadow-lg min-w-[var(--nav-circle)] min-h-[var(--nav-circle)] flex h-auto items-center justify-center backdrop-blur-sm opacity-30 active:opacity-90 transition-opacity duration-150"
                      aria-label="Jump to top"
                      title="Jump to top"
                    >
                      <ChevronsUpIcon className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="default"
                      onClick={scrollState?.scrollToBottom}
                      className="border-2 border-black px-2.5 py-1 rounded-full text-xs font-medium shadow-lg min-w-[var(--nav-circle)] min-h-[var(--nav-circle)] flex h-auto items-center justify-center backdrop-blur-sm opacity-30 active:opacity-90 transition-opacity duration-150"
                      aria-label={
                        (scrollState?.newMessageCount ?? 0) > 0
                          ? `${scrollState?.newMessageCount} new messages, jump to bottom`
                          : "Jump to bottom"
                      }
                    >
                      {(scrollState?.newMessageCount ?? 0) > 0 ? (
                        <>
                          {scrollState?.newMessageCount} new
                          <ChevronsDownIcon className="h-3.5 w-3.5 ml-1" />
                        </>
                      ) : (
                        <ChevronsDownIcon className="h-4 w-4" />
                      )}
                    </Button>
                  </>
                ) : null}

                {/* RIGHT OF CENTER: User message navigation */}
                {userNav.totalCount > 1 ? (
                  <>
                    <BareButton
                      onClick={() => {
                        if (userNav.isAutoPaging) {
                          haptic.selection();
                          userNav.abortAutoPage();
                        } else {
                          haptic.selection();
                          userNav.goToPrevious();
                        }
                      }}
                      disabled={!userNav.isAutoPaging && !userNav.hasPrevious}
                      className="bg-[var(--app-bg)] text-[var(--app-fg)] border-2 border-white p-1.5 rounded-full shadow-md min-w-[var(--nav-circle)] min-h-[var(--nav-circle)] flex items-center justify-center backdrop-blur-sm opacity-30 hover:opacity-90 active:opacity-90 disabled:opacity-20 transition-opacity duration-150"
                      aria-label={
                        userNav.isAutoPaging
                          ? "Cancel loading older messages"
                          : "Previous user message"
                      }
                      title={
                        userNav.isAutoPaging
                          ? "Cancel loading older messages"
                          : "Previous user message"
                      }
                    >
                      {userNav.isAutoPaging ? (
                        <span className="relative inline-flex h-4 w-4 items-center justify-center">
                          <Spinner
                            size="sm"
                            label={null}
                            className="absolute inset-0 text-current"
                          />
                          <CloseIcon className="relative h-3 w-3" />
                        </span>
                      ) : (
                        <ChevronUpIcon className="h-4 w-4" />
                      )}
                    </BareButton>
                    <BareButton
                      onClick={() => {
                        haptic.selection();
                        userNav.goToNext();
                      }}
                      disabled={!userNav.hasNext || userNav.isAutoPaging}
                      className="bg-[var(--app-bg)] text-[var(--app-fg)] border-2 border-white p-1.5 rounded-full shadow-md min-w-[var(--nav-circle)] min-h-[var(--nav-circle)] flex items-center justify-center backdrop-blur-sm opacity-30 hover:opacity-90 active:opacity-90 disabled:opacity-20 transition-opacity duration-150"
                      aria-label="Next user message"
                      title="Next user message"
                    >
                      <ChevronDownIcon className="h-4 w-4" />
                    </BareButton>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Bottom dock area: Composer + Session Notes + Token Usage */}
          <div ref={dockRef} className="flex-shrink-0">
            {/* Issue #1653: under the tmux/pty launchers a permission (or other
                TUI-blocking) prompt renders ONLY in the terminal — invisible
                here, so a blocked session looks frozen on "thinking" (the
                frozen-session signature). This banner explains it and links to
                the existing terminal route where the prompt can be answered; it
                deliberately WINS over the subtle thinking dot in the composer
                below. Gated on session.active so a dead/expired session never
                shows a stale banner (pairs with the server-side dead-session
                clear). Clears reactively when blockedOnTuiPrompt nulls (SSE
                session-updated → session refetch). */}
            {/* Issue #1647: a 429 session-limit aborts the turn but fires no
                Stop hook under the tmux/pty launchers, so the session would
                otherwise show "thinking" forever (the frozen-session signature).
                This chip truthfully reports the rate-limited state with the reset
                time; the thinking dot is already cleared server-side
                (setRateLimited sets thinking=false at the turn boundary). Gated
                on session.active so a dead/expired session never shows a stale
                chip. Clears reactively when rateLimited nulls (SSE
                session-updated → refetch) — e.g. when the session resumes after
                the quota window resets. */}
            {props.session.active && props.session.rateLimited ? (
              <div className="px-3 pb-1">
                <div
                  className="mx-auto flex w-full max-w-content items-center gap-2.5 rounded-md border border-[var(--app-badge-warning-border)] bg-[var(--app-badge-warning-bg)] p-3 text-left text-sm text-[var(--app-badge-warning-text)]"
                  title="This session hit the Anthropic subscription session limit and is waiting for the quota window to reset"
                >
                  <span className="text-base leading-none" aria-hidden="true">
                    ⏳
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">Rate-limited</span>
                    <span className="block truncate opacity-90">
                      {props.session.rateLimited.resetText
                        ? `Session limit reached — resets ${props.session.rateLimited.resetText}`
                        : "Session limit reached — waiting for the quota window to reset"}
                    </span>
                  </span>
                </div>
              </div>
            ) : null}
            {props.session.active && props.session.blockedOnTuiPrompt ? (
              <div className="px-3 pb-1">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleViewClaudePty}
                  title="Claude is blocked on a prompt in the terminal — open the terminal view to answer it"
                  className="mx-auto flex h-auto w-full max-w-content items-center justify-start gap-2.5 whitespace-normal rounded-md border border-[var(--app-badge-warning-border)] bg-[var(--app-badge-warning-bg)] p-3 text-left text-sm font-normal text-[var(--app-badge-warning-text)] transition-opacity hover:bg-[var(--app-badge-warning-bg)] hover:text-[var(--app-badge-warning-text)] hover:opacity-90 active:opacity-90"
                >
                  <TerminalIcon className="h-5 w-5 flex-shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">
                      Waiting on a terminal prompt
                    </span>
                    <span className="block truncate opacity-90">
                      {props.session.blockedOnTuiPrompt.message
                        ? `${props.session.blockedOnTuiPrompt.message} — tap to open the terminal`
                        : "Tap to open the terminal and answer"}
                    </span>
                  </span>
                </Button>
              </div>
            ) : null}
            <HappyComposer
              disabled={props.isSending}
              permissionMode={props.session.permissionMode}
              modelMode={pendingMode ?? props.session.modelMode}
              resolvedModel={
                pendingMode ? undefined : props.session.resolvedModel
              }
              nativeModel={props.session.metadata?.nativeModel}
              agentFlavor={agentFlavor}
              active={props.session.active}
              thinking={props.session.thinking || hasRunningTools}
              agentState={props.session.agentState}
              contextSize={reduced.latestUsage?.contextSize}
              controlledByUser={
                props.session.agentState?.controlledByUser === true
              }
              sessionId={props.session.id}
              sessionName={getSessionTitle(props.session)}
              projectDir={props.session.metadata?.path}
              onPermissionModeChange={handlePermissionModeChange}
              onModelModeChange={handleModelModeChange}
              // Composer-chip pin integrity: resolve live → durable metadata
              // pin (the same resolver the Session Configuration modal uses),
              // so a server record rebuilt without the ephemeral fields can
              // no longer flash the "High" default or the previous turn's
              // resolvedModel in place of the pinned model.
              effort={getEffectiveEffort(props.session)}
              rawModel={
                pendingMode ? undefined : getEffectiveRawModel(props.session)
              }
              modelDowngraded={
                pendingMode ? false : isModelDowngraded(props.session)
              }
              onEffortChange={handleEffortChange}
              onRawModelChange={handleRawModelChange}
              onSwitchToRemote={handleSwitchToRemote}
              autocompleteSuggestions={props.autocompleteSuggestions}
              onMoveToNotes={handleMoveComposerToNotes}
              notesText={notesText}
              notesMaxLength={MAX_NOTES_LENGTH}
              onComposerSetTextRef={fn => {
                composerSetTextRef.current = fn;
              }}
              onComposerGetTextRef={fn => {
                composerGetTextRef.current = fn;
              }}
              onComposerFocusRef={fn => {
                composerFocusRef.current = fn;
              }}
              onComposerAbsorbAttachmentsRef={fn => {
                composerAbsorbAttachmentsRef.current = fn;
              }}
              onComposeFocus={props.onComposeFocus}
              // #2414 (R2): restore the one legitimate run-start scroll — when
              // the user sends (direct or queued), follow the thread to bottom.
              // scrollState.scrollToBottom also clears the user-scroll-up gate
              // and re-enables auto-follow, so this deliberate action re-engages.
              onUserSend={() => scrollState?.scrollToBottom()}
              // #3638: resolved (never `undefined`) so exiting full-screen
              // re-syncs the never-remounted composer instead of leaving it stuck
              // collapsed. Behaviour-neutral outside full-screen (the composer's
              // default is `!initialPromptCollapsed`, false === undefined here).
              initialPromptCollapsed={promptCollapsed}
              onPromptCollapseChange={collapsed =>
                setCollapse("promptCollapsed", collapsed)
              }
              // Issue #1079 §3a: keep the composer MOUNTED in every permutation
              // (transfer channels stay registered — Decision 4 / R12); suppress
              // its own collapsed heading because the merged row below renders it
              // via HappyComposerCollapsedHeading when the prompt is collapsed.
              // Prompt is always first in source order, so this fixed position is
              // correct in all 8 permutations.
              suppressCollapsedHeading={promptCollapsed}
              serverPromptDraft={props.session.promptDraft}
              // Issue #3289 (S4): Account chip source + Config Cluster tap target.
              accountEmail={accountEmail}
              // Issue #4568: an API-key session's chip names its key.
              apiKeyName={accountSource === "api-key" ? apiKeyName : undefined}
              onOpenConfig={() => setConfigModalOpen(true)}
            />

            {/* Issue #3289 (S4): the interim config modal opened by the Session
                Config Cluster tap. SessionChat owns the session object; #3290
                rewires onOpenConfig to the new Session Configuration Modal. */}
            <EditSessionParamsModal
              isOpen={configModalOpen}
              onClose={() => setConfigModalOpen(false)}
              session={props.session}
              api={props.api}
              nodeId={props.nodeId} // #4823: API keys are node-local
            />

            {/* Issue #1079: merged/expanded dock rows. HappyComposer above is
                always mounted (§3a); the `expanded: prompt` branch is a no-op
                because the composer already occupies that slot when expanded. */}
            {mergeGroups.map(group => {
              if (group.kind === "expanded") {
                if (group.section === "prompt") {
                  // Composer already rendered above (§3a) — nothing to emit here.
                  return null;
                }
                if (group.section === "notes") {
                  return (
                    <div key="notes-expanded" className="px-3 pt-0.5 pb-0.5">
                      <div className="mx-auto w-full max-w-content">
                        {renderNotes(false)}
                      </div>
                    </div>
                  );
                }
                return (
                  <div key="token-expanded" className="px-3 pt-0 pb-2">
                    <div className="mx-auto w-full max-w-content">
                      {renderTokenUsage(false)}
                    </div>
                  </div>
                );
              }
              // kind === "merged": all collapsed headings left-packed in source
              // order (Prompt, Notes, Usage) — operator feedback on #1079
              // replaced the original right-anchored Usage (R4) with a plain
              // left-to-right row. Notes is the only shrinkable item (ellipsis
              // under pressure, R9); Prompt and Usage are `shrink-0` so their
              // short/numeric text never wraps or truncates.
              const hasTokenUsage = group.sections.includes("tokenUsage");
              return (
                <div
                  key={`merged-${group.sections.join("-")}`}
                  className="px-3 pt-0.5 pb-0.5"
                >
                  <div className="mx-auto w-full max-w-content">
                    <div className="flex min-h-[var(--control-touch)] items-center gap-2">
                      {group.sections
                        .filter(s => s !== "tokenUsage")
                        .map(section =>
                          section === "prompt" ? (
                            // Prompt is short ("+ Prompt") — never truncate it.
                            <div key="prompt" className="shrink-0">
                              <HappyComposerCollapsedHeading
                                onExpand={() =>
                                  setCollapse("promptCollapsed", false)
                                }
                              />
                            </div>
                          ) : (
                            // Notes shrinks and ellipsis-truncates when space
                            // is tight (R9); otherwise it takes natural width
                            // so Usage packs directly beside it.
                            <div key="notes" className="min-w-0">
                              {renderNotes(true)}
                            </div>
                          )
                        )}
                      {hasTokenUsage ? (
                        <div className="shrink-0">{renderTokenUsage(true)}</div>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Extension session-detail tabs — renders only when an extension
                registers a tab; empty otherwise (R6/R10). Gated on the host
                like TokenUsageSection is gated on displayTokenStats, so the
                layout container never renders an empty wrapper. */}
            {host.getSessionDetailTabs().length > 0 ? (
              // Same SessionDetailProvider as the info bar above (#1285): a tab
              // contribution is a zero-prop component with the identical
              // "which session am I rendering for?" problem, and SessionChat is
              // the only mount site that knows the answer in BOTH the route and
              // split-pane contexts. No tab consumer exists yet, so this changes
              // no current behavior — it stops #1284 inheriting the split-view
              // trap the info bar just hit.
              <SessionDetailProvider sessionId={props.session.id}>
                <div className="px-3 pt-0 pb-2">
                  <div className="mx-auto w-full max-w-content">
                    <SessionDetailTabs />
                  </div>
                </div>
              </SessionDetailProvider>
            ) : null}
          </div>
        </div>
      </HappyRuntimeProvider>

      {/* Body/html background change is handled by BrandedFrame */}
    </div>
  );
}
