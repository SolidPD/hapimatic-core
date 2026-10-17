// SPDX-License-Identifier: AGPL-3.0-only
import {
  getPermissionModeOptionsForFlavor,
  type EffortLevel,
} from "@hapi/protocol";
import {
  ComposerPrimitive,
  useAssistantApi,
  useAssistantState,
} from "@assistant-ui/react";
import {
  type ChangeEvent as ReactChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type SyntheticEvent as ReactSyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AgentState, ModelMode, PermissionMode } from "@/types/api";
import type { Suggestion } from "@/hooks/useActiveSuggestions";
import { useActiveWord } from "@/hooks/useActiveWord";
import { useActiveSuggestions } from "@/hooks/useActiveSuggestions";
import { useQueuedMessages } from "@/hooks/queries/useQueuedMessages";
import { useAppContext } from "@/lib/app-context";
import {
  insertTextAtSelection,
  plainTextForUrlSniffedPaste,
} from "@/lib/clipboard";
import { usePromptDraft } from "@/hooks/usePromptDraft";
import { useAttachments } from "@/hooks/useAttachments";
import { type Attachment } from "@/lib/attachment-store";
import { useComposerSubmitBehavior } from "@/hooks/useComposerSubmitBehavior";
import {
  getComposerEnterIntent,
  COMPOSER_SUBMIT_LABELS,
} from "@/lib/composerSubmitBehavior";
import { applySuggestion } from "@/utils/applySuggestion";
import {
  moveLineUp,
  moveLineDown,
  isFirstLine,
  isLastLine,
} from "@/utils/moveLines";
import { handleIndentKeyDown } from "@/utils/indentLines";
import { usePlatform } from "@/hooks/usePlatform";
import { useClientMode } from "@/hooks/useClientMode";
import { useKioskImeSuppression } from "@/hooks/useKioskImeSuppression";
import { useToast } from "@/components/Toast";
import { FloatingOverlay } from "@/components/ChatInput/FloatingOverlay";
import { Autocomplete } from "@/components/ChatInput/Autocomplete";
import { StatusBar } from "@/components/AssistantChat/StatusBar";
import { ComposerButtons } from "@/components/AssistantChat/ComposerButtons";
import { PromptTextTools } from "@/components/AssistantChat/PromptTextTools";
import { SessionConfigCluster } from "@/components/AssistantChat/SessionConfigCluster";
import { QueueManagementModal } from "@/components/AssistantChat/QueueManagementModal";
import { AttachmentManagementModal } from "@/components/AssistantChat/AttachmentManagementModal";
import { FullscreenPromptEditorModal } from "@/components/AssistantChat/FullscreenPromptEditorModal";
import { usePromptPopOut } from "@/components/AssistantChat/usePromptPopOut";
import { InvalidFilesDialog } from "@/components/AssistantChat/InvalidFilesDialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ComposerVoiceButton } from "@/components/AssistantChat/ComposerVoiceButton";
import { useAbortControl } from "@/components/AssistantChat/useAbortControl";

export interface TextInputState {
  text: string;
  selection: { start: number; end: number };
}

const defaultSuggestionHandler = async (): Promise<Suggestion[]> => [];

/**
 * Issue #1079: the collapsed `+ Prompt` heading, extracted as a tiny standalone
 * export so SessionChat can render it inside the merged dock row (left-anchored,
 * R3/R5) while the full `HappyComposer` stays mounted but heading-suppressed
 * (`suppressCollapsedHeading`). Clicking it flips the parent's persisted
 * `promptCollapsed`; HappyComposer's sync effect then expands the composer. This
 * mirrors HappyComposer's own collapsed button minus the `w-full` chrome, adding
 * `min-h-[44px]` for the R10 touch target.
 */
export function HappyComposerCollapsedHeading({
  onExpand,
}: {
  onExpand: () => void;
}) {
  return (
    <button /* design-tokens-allow: composer +Prompt collapse toggle (min-h-[44px] touch target) - D2 E3 named exception (#3357) */
      type="button"
      onClick={onExpand}
      className="min-h-[44px] inline-flex items-center whitespace-nowrap text-left text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors py-1 px-1"
    >
      + Prompt
    </button>
  );
}

export function HappyComposer(props: {
  disabled?: boolean;
  permissionMode?: PermissionMode;
  modelMode?: ModelMode;
  resolvedModel?: string;
  /** Issue #3348: non-claude native model (metadata.nativeModel) for the chip. */
  nativeModel?: string;
  active?: boolean;
  thinking?: boolean;
  agentState?: AgentState | null;
  contextSize?: number;
  controlledByUser?: boolean;
  agentFlavor?: string | null;
  sessionId?: string;
  sessionName?: string;
  projectDir?: string | null;
  /** Claude account email for the Session Config Cluster's Account chip (#3289). */
  accountEmail?: string;
  /** Issue #4568: an API-key session's key name — the chip names the key. */
  apiKeyName?: string;
  /**
   * #3289: tap the Session Config Cluster → open the config modal. Interim
   * contract (until #3290): opens the existing EditSessionParamsModal (owned by
   * SessionChat, which holds the session object). Keep this contract stable.
   */
  onOpenConfig?: () => void;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  onModelModeChange?: (mode: ModelMode) => void;
  // Issue #2882: effort + specific-model wiring for the relocated composer
  // model/effort picker (SessionChat → HappyComposer → ComposerButtons).
  effort?: EffortLevel;
  rawModel?: string;
  /** #1509 (iter AC): running a below-entitlement model → composer model text red. */
  modelDowngraded?: boolean;
  onEffortChange?: (level: EffortLevel) => void;
  onRawModelChange?: (rawModel: string) => void;
  onSwitchToRemote?: () => void;
  onTerminal?: () => void;
  autocompletePrefixes?: string[];
  autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>;
  // Transfer to notes (text + attachments, issue #1075)
  onMoveToNotes?: (payload: {
    text: string;
    attachments: Attachment[];
  }) => void;
  notesText?: string;
  notesMaxLength?: number;
  // Ref callbacks for parent to get/set composer text
  onComposerSetTextRef?: (fn: (text: string) => void) => void;
  onComposerGetTextRef?: (fn: () => string) => void;
  // #3333: ref callback so the parent can focus the composer textarea (the
  // approval card's Decline seam — must fire synchronously in the tap handler so
  // mobile Safari opens the keyboard).
  onComposerFocusRef?: (fn: () => void) => void;
  // #1075: ref callback so the parent can push notes attachments INTO the composer.
  onComposerAbsorbAttachmentsRef?: (
    fn: (incoming: Attachment[]) => void
  ) => void;
  // Called when compose field receives focus — clears "needs review" indicator (#279)
  onComposeFocus?: () => void;
  // Called when the user submits a message (direct send OR queued while offline /
  // Claude-running) — SessionChat wires this to scroll the thread to bottom (#2414).
  onUserSend?: () => void;
  // Persistent collapse state (#455)
  initialPromptCollapsed?: boolean;
  onPromptCollapseChange?: (collapsed: boolean) => void;
  /**
   * Issue #1079: when the prompt is collapsed AND this is true, render `null`
   * instead of the internal `+ Prompt` heading — the parent (SessionChat) hoists
   * that heading into the merged dock row via `HappyComposerCollapsedHeading`.
   * The composer stays MOUNTED in every permutation so its notes↔composer
   * transfer channels (onComposerSetTextRef etc.) stay registered, preventing
   * the fresh-load-while-collapsed data-loss defect (Decision 4 / R12).
   */
  suppressCollapsedHeading?: boolean;
  // Server-side prompt draft (issue #1261): the session's persisted draft.
  // `undefined` = "not loaded yet" (autosave gated until hydration).
  // `null` or `string` (including "") = "loaded" (hydration consumes it).
  serverPromptDraft?: string | null;
}) {
  const {
    disabled = false,
    permissionMode: rawPermissionMode,
    modelMode: rawModelMode,
    resolvedModel,
    nativeModel,
    active = true,
    thinking = false,
    agentState,
    contextSize,
    controlledByUser = false,
    agentFlavor,
    sessionId,
    sessionName,
    onPermissionModeChange,
    onModelModeChange,
    effort,
    rawModel,
    modelDowngraded,
    onSwitchToRemote,
    onTerminal,
    autocompletePrefixes = ["@", "/"],
    autocompleteSuggestions = defaultSuggestionHandler,
    onMoveToNotes,
    notesText = "",
    notesMaxLength = 5000,
    onComposerSetTextRef,
    onComposerGetTextRef,
    onComposerFocusRef,
    onComposerAbsorbAttachmentsRef,
    onComposeFocus,
    onUserSend,
    initialPromptCollapsed,
    onPromptCollapseChange,
    suppressCollapsedHeading,
    serverPromptDraft,
  } = props;

  // Use ?? so missing values fall back to default (destructuring defaults only handle undefined)
  const permissionMode = rawPermissionMode ?? "default";
  const modelMode = rawModelMode ?? "default";

  const api = useAssistantApi();
  const composerText = useAssistantState(({ composer }) => composer.text);
  const threadIsRunning = useAssistantState(({ thread }) => thread.isRunning);
  const threadIsDisabled = useAssistantState(({ thread }) => thread.isDisabled);

  // Compose stays enabled when session is offline (!active) so user can queue messages
  const composerDisabled = disabled || threadIsDisabled;
  // Action buttons (abort, settings, switch) still require an active session
  const actionControlsDisabled = disabled || !active || threadIsDisabled;
  const trimmed = composerText.trim();
  const hasText = trimmed.length > 0;
  // Note: canSend is computed after useAttachments hook below

  // Issue #1325: server-backed message queue.
  // Queue lives on the owning peer node; QueueDrainObserver dispatches the
  // head when the session's `thinking` falls or `active` rises. The three
  // client-side drain useEffects that used to live here have been removed —
  // the server's authoritative drain runs whether or not this component is
  // mounted, fixing the original "drain only fires when session detail is
  // open" bug.
  const { api: apiClient } = useAppContext();
  const {
    messages: queuedMessages,
    length: queueLength,
    enqueue,
    clear: clearQueue,
    removeAt,
    updateAt,
  } = useQueuedMessages(apiClient, sessionId ?? null);
  const { showToast } = useToast();

  // Draft persistence: save unsent text across navigation (issue #1261 server-primary).
  // serverPromptDraft is the per-session value from the parent (from `session.promptDraft`).
  // The hook gates autosave on `hydrated` to prevent Device B (no local cache) from
  // blanking Device A's typed draft.
  const { draft, saveDraft, clearDraft, hydrated } = usePromptDraft(
    sessionId ?? "",
    apiClient,
    serverPromptDraft
  );

  // Ref to access handleSubmit from handleKeyDown (declared before handleSubmit)
  const handleSubmitRef = useRef<() => void>(() => {});

  const [inputState, setInputState] = useState<TextInputState>({
    text: "",
    selection: { start: 0, end: 0 },
  });
  const [isSwitching, setIsSwitching] = useState(false);
  const [showContinueHint, setShowContinueHint] = useState(false);
  const [showQueueModal, setShowQueueModal] = useState(false);
  const [isProcessingQueue, setIsProcessingQueue] = useState(false);
  const [showFullscreenPrompt, setShowFullscreenPrompt] = useState(false);
  // Issue #3289 (S4): the MCP detail modal (per-server toggles, hosted by
  // StatusBar) is opened from the Session Config Cluster's MCP chip. The open
  // state lives here and is passed to StatusBar (controlled).
  const [showAttachmentModal, setShowAttachmentModal] = useState(false);
  const [showInvalidFilesDialog, setShowInvalidFilesDialog] = useState(false);
  const [isComposerExpanded, setIsComposerExpanded] = useState(
    !initialPromptCollapsed
  );
  const [isDragOver, setIsDragOver] = useState(false);
  const [clearPromptDialogOpen, setClearPromptDialogOpen] = useState(false);
  const [showMoveToNotesOverflow, setShowMoveToNotesOverflow] = useState(false);
  const [overflowDetails, setOverflowDetails] = useState<{
    toMove: string;
    remaining: string;
  } | null>(null);

  // Attachment management
  const {
    attachments,
    addFiles,
    addAndUpload,
    removeFile,
    renameFile,
    clearAll: clearAttachments,
    uploadAll,
    getUploadedPaths,
    absorbAttachments,
    extractAttachments,
    isUploading,
    pendingCount: attachmentPendingCount,
    uploadedCount: attachmentUploadedCount,
    hasInvalidFiles,
  } = useAttachments(sessionId ?? "");

  // Allow sending when there's text OR uploaded files - handleSubmit will queue if offline or Claude is running
  const hasUploadedFiles = attachmentUploadedCount > 0;
  const canSend = (hasText || hasUploadedFiles) && !composerDisabled;

  const [promptCopyFeedback, setPromptCopyFeedback] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevControlledByUser = useRef(controlledByUser);

  useEffect(() => {
    setInputState(prev => {
      if (prev.text === composerText) return prev;
      // When syncing from composerText, update selection to end of text
      // This ensures activeWord detection works correctly
      const newPos = composerText.length;
      return { text: composerText, selection: { start: newPos, end: newPos } };
    });
  }, [composerText]);

  // Load saved draft when entering a session — gated on hook `hydrated`
  // (issue #1261). The hook hydrates from the server's value before this fires.
  // The `!composerText` guard prevents re-apply if the user has started typing.
  useEffect(() => {
    if (!sessionId) return;
    if (!hydrated) return;
    if (draft && !composerText) {
      api.composer().setText(draft);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, hydrated]);

  // Save draft as user types — gated on hook `hydrated` so we don't blank
  // cross-device drafts (issue #1261 R4 race-condition guard).
  useEffect(() => {
    if (!sessionId) return;
    if (!hydrated) return;
    saveDraft(composerText);
  }, [composerText, sessionId, saveDraft, hydrated]);

  // Register setText function with parent for notes-to-composer transfer
  useEffect(() => {
    if (onComposerSetTextRef) {
      onComposerSetTextRef((text: string) => {
        api.composer().setText(text);
      });
    }
  }, [onComposerSetTextRef, api]);

  // Register getText function with parent for notes-to-composer append
  const composerTextRef = useRef(composerText);
  composerTextRef.current = composerText;
  useEffect(() => {
    if (onComposerGetTextRef) {
      onComposerGetTextRef(() => composerTextRef.current);
    }
  }, [onComposerGetTextRef]);

  // #3333: register a focus function so the approval card's Decline action can
  // focus the composer. `preventScroll` mirrors assistant-ui's own composer focus
  // (ComposerPrimitiveInput) — the card scrolls into view separately, and on
  // mobile Safari the keyboard opens because this runs synchronously in the tap.
  useEffect(() => {
    if (onComposerFocusRef) {
      onComposerFocusRef(() => {
        textareaRef.current?.focus({ preventScroll: true });
      });
    }
  }, [onComposerFocusRef]);

  // Register absorbAttachments with the parent so a notes → composer move can
  // push the notes attachments into this composer's box (#1075).
  useEffect(() => {
    if (onComposerAbsorbAttachmentsRef) {
      onComposerAbsorbAttachmentsRef(absorbAttachments);
    }
  }, [onComposerAbsorbAttachmentsRef, absorbAttachments]);

  // Issue #1079: `isComposerExpanded` is initialized once from
  // `initialPromptCollapsed` and does not otherwise track it. When the parent
  // hoists the collapsed heading into the merged dock row, an external
  // `HappyComposerCollapsedHeading` click flips the parent's persisted
  // `promptCollapsed` — sync the local expand state to it so the composer
  // actually expands/collapses in response (mirrors SessionNotes:300). Guarded
  // on `undefined` so a session with no persisted state keeps its default.
  useEffect(() => {
    if (initialPromptCollapsed === undefined) return;
    setIsComposerExpanded(!initialPromptCollapsed);
  }, [initialPromptCollapsed]);

  // Track one-time "continue" hint after switching from local to remote.
  useEffect(() => {
    if (prevControlledByUser.current === true && controlledByUser === false) {
      setShowContinueHint(true);
    }
    if (controlledByUser) {
      setShowContinueHint(false);
    }
    prevControlledByUser.current = controlledByUser;
  }, [controlledByUser]);

  const { haptic: platformHaptic, isTouch } = usePlatform();

  // Issue #2848: opt-in kiosk client mode. When active, the composer input
  // suppresses the on-screen keyboard (inputMode="none") until the user taps the
  // ⌨ summon control (rendered by ComposerButtons), which blur→refocuses to force
  // Chrome to re-show the OSK.
  const { kioskMode } = useClientMode();
  // Issue #2848: shared kiosk IME-suppression state machine (summon + guarded re-arm).
  const { imeSummoned, summonKeyboard, handleImeBlur, rearmSuppression } =
    useKioskImeSuppression(textareaRef);
  // Safe area padding moved to SessionNotes wrapper since notes is now below composer
  const bottomPaddingClass = "pb-0";
  const activeWord = useActiveWord(
    inputState.text,
    inputState.selection,
    autocompletePrefixes
  );
  const [suggestions, selectedIndex, moveUp, moveDown, clearSuggestions] =
    useActiveSuggestions(activeWord, autocompleteSuggestions, {
      clampSelection: true,
      wrapAround: true,
    });

  const haptic = useCallback(
    (type: "light" | "success" | "error" = "light") => {
      if (type === "light") {
        platformHaptic.impact("light");
      } else if (type === "success") {
        platformHaptic.notification("success");
      } else {
        platformHaptic.notification("error");
      }
    },
    [platformHaptic]
  );

  const handleSuggestionSelect = useCallback(
    (index: number) => {
      const suggestion = suggestions[index];
      if (!suggestion || !textareaRef.current) return;

      // For Codex user prompts with content, expand the content instead of command name
      let textToInsert = suggestion.text;
      let addSpace = true;
      if (
        agentFlavor === "codex" &&
        suggestion.source === "user" &&
        suggestion.content
      ) {
        textToInsert = suggestion.content;
        addSpace = false;
      }

      const result = applySuggestion(
        inputState.text,
        inputState.selection,
        textToInsert,
        autocompletePrefixes,
        addSpace
      );

      api.composer().setText(result.text);
      setInputState({
        text: result.text,
        selection: { start: result.cursorPosition, end: result.cursorPosition },
      });

      setTimeout(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.setSelectionRange(result.cursorPosition, result.cursorPosition);
        try {
          el.focus({ preventScroll: true });
        } catch {
          el.focus();
        }
      }, 0);

      haptic("light");
    },
    [api, suggestions, inputState, autocompletePrefixes, haptic, agentFlavor]
  );

  // Stop-button state machine: the #706 queue-then-fire abort plus the #4750
  // send-in-flight window that keeps Stop live before the server reports the
  // thread running (see useAbortControl.ts).
  const {
    isAborting,
    abortQueued,
    abortDisabled,
    handleAbort,
    markSendDispatched,
  } = useAbortControl({
    api,
    // #4773: this composer stays mounted across session switches.
    sessionId: sessionId ?? null,
    threadIsRunning,
    active,
    // #4750: deliberately NOT actionControlsDisabled — that folds in `disabled` /
    // thread.isDisabled, which are the send POST round-trip (SessionChat passes
    // isSending to both), i.e. exactly the window Stop must stay live in.
    controlsDisabled: !active,
    haptic,
    showToast,
  });
  const switchDisabled =
    actionControlsDisabled || isSwitching || !controlledByUser;
  const showSwitchButton = Boolean(controlledByUser && onSwitchToRemote);
  const showTerminalButton = Boolean(onTerminal);

  // Issue #1325: The three client-side drain useEffects that previously lived
  // here have been REMOVED. The server's QueueDrainObserver is now authoritative
  // for both "idle-after-running" and "session-reconnected" drains, and it runs
  // whether or not this component is mounted. The pre-#1325 effects were:
  //   1. "Auto-send when Claude finishes processing" (thinking false-after-true)
  //   2. "Safety-net drain when Claude is idle"      (defensive re-fire)
  //   3. "Flush queued messages when session reconnects" (active false-after-true)
  // All three are now handled by server/src/sync/queueDrainObserver.ts.

  useEffect(() => {
    if (!isSwitching) return;
    if (controlledByUser) return;
    setIsSwitching(false);
  }, [isSwitching, controlledByUser]);

  const handleSwitch = useCallback(async () => {
    if (switchDisabled || !onSwitchToRemote) return;
    haptic("light");
    setIsSwitching(true);
    try {
      await onSwitchToRemote();
    } catch {
      setIsSwitching(false);
    }
  }, [switchDisabled, onSwitchToRemote, haptic]);

  const handleClearQueue = useCallback(() => {
    if (queueLength === 0) return;
    void clearQueue();
    setIsProcessingQueue(false);
    haptic("light");
    showToast("Queue cleared");
  }, [queueLength, clearQueue, haptic, showToast]);

  const handleDeleteQueuedMessage = useCallback(
    (index: number) => {
      void removeAt(index);
      haptic("light");
    },
    [removeAt, haptic]
  );

  const handleUpdateQueuedMessage = useCallback(
    (index: number, message: string) => {
      void updateAt(index, message);
      haptic("light");
    },
    [updateAt, haptic]
  );

  const handleAddToQueue = useCallback(
    (message: string) => {
      void enqueue(message);
      haptic("success");
      showToast("Message added to queue");
    },
    [enqueue, haptic, showToast]
  );

  const handleSendQueue = useCallback(async () => {
    if (queueLength === 0 || threadIsRunning || isProcessingQueue) return;
    if (!sessionId) return;

    // Issue #1325 / Task 17: server-atomic drain. Replaces the old client-side
    // dequeue + setText + send sequence. The server pops the head and dispatches
    // it with `localId = row.id` for idempotency (R3 — MessageStore dedups on
    // (session_id, local_id), so this is safe even if the observer's automatic
    // drain races with this manual click).
    setIsProcessingQueue(true);
    setShowQueueModal(false);
    try {
      const result = await apiClient.drainQueueHead(sessionId);
      if (result.sent) {
        showToast(
          result.remaining > 0
            ? `Sending queue (${result.remaining} remaining)`
            : "Sending queued message"
        );
      } else {
        showToast("Queue was empty");
      }
    } catch (err) {
      console.warn("[HappyComposer] drainQueueHead failed:", err);
      showToast("Failed to send queue", { type: "error" });
    } finally {
      setIsProcessingQueue(false);
    }
  }, [
    queueLength,
    threadIsRunning,
    isProcessingQueue,
    sessionId,
    apiClient,
    showToast,
  ]);

  const handleQueueIndicatorClick = useCallback(() => {
    setShowQueueModal(true);
    haptic("light");
  }, [haptic]);

  // Attachment handlers
  const handleAttachmentClick = useCallback(() => {
    setShowAttachmentModal(true);
    haptic("light");
  }, [haptic]);

  const handleUploadAttachments = useCallback(async () => {
    if (!sessionId) return;
    const success = await uploadAll();
    haptic("success");
    showToast("Files uploaded");
    if (success) {
      setShowAttachmentModal(false);
    }
  }, [sessionId, uploadAll, haptic, showToast]);

  const handleClearAttachments = useCallback(() => {
    clearAttachments();
    haptic("light");
    showToast("Attachments cleared");
  }, [clearAttachments, haptic, showToast]);

  // Paste handler: intercept paste events with file data and auto-upload, and
  // (#5313) dodge iOS WebKit's URL-preferring default paste. When the pasteboard
  // carries a public.url representation next to the text (any `scheme:` shaped
  // copy on iOS), the default action inserts the percent-encoded URL while the
  // event's text/plain is the real text — so insert that ourselves.
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = e.clipboardData?.files;
      if (files && files.length > 0) {
        // Has file data — prevent default paste behavior and auto-upload
        e.preventDefault();
        if (!sessionId) return;
        addAndUpload(files);
        haptic("light");
        const count = files.length;
        showToast(count === 1 ? "File attached" : `${count} files attached`);
        return;
      }
      const plain = plainTextForUrlSniffedPaste(e.clipboardData);
      if (plain === null) return;
      e.preventDefault();
      insertTextAtSelection(e.currentTarget, plain);
    },
    [sessionId, addAndUpload, haptic, showToast]
  );

  // Drag-and-drop handlers for file attachment
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only clear drag state when leaving the drop zone entirely,
    // not when entering a child element
    if (
      dropZoneRef.current &&
      !dropZoneRef.current.contains(e.relatedTarget as Node)
    ) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;
      if (!sessionId) return;
      addAndUpload(files);
      haptic("light");
      const count = files.length;
      showToast(count === 1 ? "File attached" : `${count} files attached`);
    },
    [sessionId, addAndUpload, haptic, showToast]
  );

  // Move composer text + attachments to session notes (#1075). The FULL-transfer
  // path carries the composer's settled attachments; the overflow path stays
  // text-only (R5) — see handleConfirmOverflowTransfer.
  const handleMoveToNotes = useCallback(() => {
    if (!onMoveToNotes) return;
    // Movable = everything except an in-flight `uploading` entry. `pending`
    // files travel WITH the move (the composer only uploads at Send, so a
    // pending file left behind silently vanishes from the user's perspective);
    // notes settles them via uploadAll on receipt.
    const hasMovableAttachments = attachments.some(
      a => a.status !== "uploading"
    );
    // Nothing to move.
    if (!trimmed && !hasMovableAttachments) return;

    // Attachments-only (no text): move them, no overflow calc.
    if (!trimmed) {
      onMoveToNotes({ text: "", attachments: extractAttachments() });
      haptic("success");
      return;
    }

    // Calculate available space in notes
    const currentNotesLength = notesText.length;
    const availableSpace = notesMaxLength - currentNotesLength;
    // If notes has content, we need to account for the newline separator
    const separatorLength = currentNotesLength > 0 ? 1 : 0;
    const effectiveAvailableSpace = availableSpace - separatorLength;

    if (trimmed.length <= effectiveAvailableSpace) {
      // Fits entirely - transfer all text AND the settled attachments.
      const textToAdd = currentNotesLength > 0 ? `\n${trimmed}` : trimmed;
      onMoveToNotes({ text: textToAdd, attachments: extractAttachments() });
      api.composer().setText("");
      clearDraft();
      haptic("success");
    } else {
      // Overflow - show confirmation dialog (text-only, attachments stay put).
      const toMove = trimmed.slice(0, effectiveAvailableSpace);
      const remaining = trimmed.slice(effectiveAvailableSpace);
      setOverflowDetails({ toMove, remaining });
      setShowMoveToNotesOverflow(true);
    }
  }, [
    onMoveToNotes,
    trimmed,
    attachments,
    extractAttachments,
    notesText,
    notesMaxLength,
    api,
    clearDraft,
    haptic,
  ]);

  // Handle confirmed overflow transfer. TEXT-ONLY by design (R5): attachments
  // stay in the composer — overflow-driven transfers never move attachments.
  const handleConfirmOverflowTransfer = useCallback(async () => {
    if (!onMoveToNotes || !overflowDetails) return;

    const currentNotesLength = notesText.length;
    const textToAdd =
      currentNotesLength > 0
        ? `\n${overflowDetails.toMove}`
        : overflowDetails.toMove;
    onMoveToNotes({ text: textToAdd, attachments: [] });
    // Leave the remaining text in the composer
    api.composer().setText(overflowDetails.remaining);
    setOverflowDetails(null);
    haptic("success");
  }, [onMoveToNotes, overflowDetails, notesText, api, haptic]);

  // Prompt control handlers for StatusBar
  const handleCopyPrompt = useCallback(async () => {
    if (!composerText) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(composerText);
      } else {
        // iOS Safari fallback
        const textArea = document.createElement("textarea");
        textArea.value = composerText;
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }
      setPromptCopyFeedback(true);
      haptic("success");
      setTimeout(() => setPromptCopyFeedback(false), 1500);
    } catch (err) {
      console.error("Copy failed:", err);
      haptic("error");
      showToast("Failed to copy text", { type: "error" });
    }
  }, [composerText, haptic, showToast]);

  const handleExpandPrompt = useCallback(() => {
    setShowFullscreenPrompt(true);
    haptic("light");
  }, [haptic]);

  const handleClearPrompt = useCallback(() => {
    setClearPromptDialogOpen(true);
  }, []);

  const doClearPrompt = useCallback(async () => {
    api.composer().setText("");
    clearDraft();
    haptic("light");
  }, [api, clearDraft, haptic]);

  const handleMoveLineUp = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const result = moveLineUp(composerText, pos);
    if (!result) return;
    api.composer().setText(result.text);
    setInputState({
      text: result.text,
      selection: { start: result.cursorPos, end: result.cursorPos },
    });
    requestAnimationFrame(() => {
      ta.setSelectionRange(result.cursorPos, result.cursorPos);
      ta.focus();
    });
  }, [composerText, api]);

  const handleMoveLineDown = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const result = moveLineDown(composerText, pos);
    if (!result) return;
    api.composer().setText(result.text);
    setInputState({
      text: result.text,
      selection: { start: result.cursorPos, end: result.cursorPos },
    });
    requestAnimationFrame(() => {
      ta.setSelectionRange(result.cursorPos, result.cursorPos);
      ta.focus();
    });
  }, [composerText, api]);

  const permissionModeOptions = useMemo(
    () => getPermissionModeOptionsForFlavor(agentFlavor),
    [agentFlavor]
  );

  // Single source of truth for the send-vs-newline decision (#1524). A future
  // /settings/preferences toggle (epic #1034) swaps only this hook's body.
  const submitBehavior = useComposerSubmitBehavior();

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      const key = e.key;

      // Avoid intercepting IME composition keystrokes (Enter, arrows, etc.)
      if (e.nativeEvent.isComposing) {
        return;
      }

      if (suggestions.length > 0) {
        // Arrow keys are swapped because the list renders in reverse visual
        // order (column-reverse): best match at bottom, near the textarea.
        // ArrowUp moves visual selection up = higher indices = moveDown().
        if (key === "ArrowUp") {
          e.preventDefault();
          moveDown();
          return;
        }
        if (key === "ArrowDown") {
          e.preventDefault();
          moveUp();
          return;
        }
        if ((key === "Enter" || key === "Tab") && !e.shiftKey) {
          e.preventDefault();
          const indexToSelect = selectedIndex >= 0 ? selectedIndex : 0;
          handleSuggestionSelect(indexToSelect);
          return;
        }
        if (key === "Escape") {
          e.preventDefault();
          clearSuggestions();
          return;
        }
      }

      // Tab / Shift+Tab indent + outdent (Sublime-style, two-space unit).
      // Runs AFTER the suggestion block so an open suggestion list keeps
      // consuming Tab. The helper calls preventDefault only when the text
      // actually changed, so an unhandled Tab still moves focus.
      const indent = handleIndentKeyDown(e, e.currentTarget);
      if (indent) {
        const ta = e.currentTarget;
        api.composer().setText(indent.text);
        setInputState({
          text: indent.text,
          selection: { start: indent.selectionStart, end: indent.selectionEnd },
        });
        requestAnimationFrame(() => {
          ta.setSelectionRange(indent.selectionStart, indent.selectionEnd);
        });
        return;
      }

      // Escape to abort (queue management moved to UI menu)
      if (key === "Escape") {
        if (threadIsRunning) {
          e.preventDefault();
          handleAbort();
          return;
        }
      }

      // Enter handling routed through the centralized submit-behavior source of
      // truth (#1524). Under the default shift-to-send, Shift+Enter and
      // Ctrl/Cmd+Enter resolve to "send"; a bare Enter resolves to "newline".
      // Sends route through handleSubmit so offline queueing + file-attachment
      // logic apply (the framework's built-in Enter submit is disabled via
      // submitOnEnter={false} on ComposerPrimitive.Input).
      if (getComposerEnterIntent(e, submitBehavior) === "send") {
        if (canSend) {
          e.preventDefault();
          handleSubmitRef.current();
        }
      }
      // A bare Enter (intent "newline") falls through with no preventDefault, so
      // the textarea inserts a native newline.
    },
    [
      suggestions,
      selectedIndex,
      moveUp,
      moveDown,
      clearSuggestions,
      handleSuggestionSelect,
      threadIsRunning,
      handleAbort,
      haptic,
      canSend,
      submitBehavior,
      api,
    ]
  );

  const handleChange = useCallback(
    (e: ReactChangeEvent<HTMLTextAreaElement>) => {
      const selection = {
        start: e.target.selectionStart,
        end: e.target.selectionEnd,
      };
      setInputState({ text: e.target.value, selection });
    },
    []
  );

  const selectDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const handleSelect = useCallback(
    (e: ReactSyntheticEvent<HTMLTextAreaElement>) => {
      const target = e.target as HTMLTextAreaElement;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      if (selectDebounceRef.current) clearTimeout(selectDebounceRef.current);
      selectDebounceRef.current = setTimeout(() => {
        setInputState(prev => ({
          ...prev,
          selection: { start, end },
        }));
      }, 150);
    },
    []
  );

  const handleSubmit = useCallback(() => {
    // Block send if any attached files have unsupported types
    if (hasInvalidFiles) {
      setShowInvalidFilesDialog(true);
      haptic("error");
      return;
    }

    // Get uploaded file paths to include in the message
    const uploadedPaths = getUploadedPaths();
    const hasUploadedFiles = uploadedPaths.length > 0;

    // Build the message with file references if any
    let messageText = composerText.trim();
    // Auto-populate text when sending attachments without typed text (#676)
    if (hasUploadedFiles && !messageText) {
      messageText = "See attached files";
    }
    if (hasUploadedFiles && messageText) {
      // Append file paths as a visually distinct code block
      const fileRefsBlock = uploadedPaths.map(p => `  ${p}`).join("\n");
      messageText = `${messageText}\n\n---\n📎 **Attached files** (read from filesystem):\n\`\`\`\n${fileRefsBlock}\n\`\`\``;
    }

    // #2414 (R2): a deliberate user send returns the viewport to the bottom.
    // `messageText` being truthy is the exact discriminator that a send/enqueue
    // will happen across all three branches below (direct send AND the two
    // queued paths — offline / Claude-running — which return early and never
    // reach the runtime's onSendMessage). One call here covers them all.
    if (messageText) {
      onUserSend?.();
      // #2848: re-arm kiosk IME suppression after a send so the next fresh focus
      // starts suppressed again (no-op when kiosk is off — imeSummoned stays false).
      rearmSuppression();
    }

    // If session is offline, queue the message for delivery on reconnect
    if (!active) {
      if (messageText) {
        enqueue(messageText);
        api.composer().setText("");
        clearDraft();
        if (hasUploadedFiles) {
          clearAttachments();
        }
        haptic("success");
        showToast(
          queueLength === 0
            ? "Message queued (session offline)"
            : `Message queued (${queueLength + 1} total, session offline)`
        );
      }
      return;
    }
    // If Claude is running, queue the message instead of sending
    if (threadIsRunning) {
      if (messageText) {
        enqueue(messageText);
        api.composer().setText("");
        clearDraft();
        // Clear attachments after queueing
        if (hasUploadedFiles) {
          clearAttachments();
        }
        haptic("success");
        showToast(
          queueLength === 0
            ? "Message queued"
            : `Message queued (${queueLength + 1} total)`
        );
      }
      return; // Prevent the actual send
    }
    // Normal submit flow - trigger the actual send
    if (messageText) {
      // If we have file references, update the composer text before sending
      if (hasUploadedFiles) {
        api.composer().setText(messageText);
      }
      setShowContinueHint(false);
      clearDraft();
      // Clear attachments after sending
      if (hasUploadedFiles) {
        clearAttachments();
      }
      api.composer().send();
      // #4750: open the send-in-flight window so Stop is live before the
      // server reports the thread running (also cancels a stale pending stop).
      markSendDispatched();
    }
  }, [
    active,
    threadIsRunning,
    composerText,
    markSendDispatched,
    enqueue,
    api,
    clearDraft,
    haptic,
    showToast,
    queueLength,
    getUploadedPaths,
    clearAttachments,
    hasInvalidFiles,
    onUserSend,
  ]);
  handleSubmitRef.current = handleSubmit;

  const showAbortButton = true;

  const overlays = useMemo(() => {
    if (suggestions.length > 0) {
      // Calculate available height above the composer to constrain the popup.
      // The popup grows upward (absolute bottom-[100%]), so max height =
      // composer top - safe margin for header + safe area inset + gap.
      const HEADER_SAFE_MARGIN = 140; // header + safe area + ~1 row buffer
      const MIN_HEIGHT = 120;
      const MAX_HEIGHT = 320;
      let popupMaxHeight = 240; // fallback
      const composerEl = containerRef.current;
      if (composerEl) {
        const composerTop = composerEl.getBoundingClientRect().top;
        const available = composerTop - HEADER_SAFE_MARGIN;
        popupMaxHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, available));
      }

      return (
        <div className="absolute bottom-[100%] mb-2 w-full">
          <FloatingOverlay maxHeight={popupMaxHeight}>
            <Autocomplete
              suggestions={suggestions}
              selectedIndex={selectedIndex}
              onSelect={index => handleSuggestionSelect(index)}
            />
          </FloatingOverlay>
        </div>
      );
    }

    return null;
  }, [suggestions, selectedIndex, handleSuggestionSelect, containerRef]);

  // Epic #3285 round 14 (item 2): ONE cluster element for the inline composer's
  // leading slot AND the fullscreen editor footer (via promptEditorSharedProps).
  const sessionConfigCluster = (
    <SessionConfigCluster
      permissionMode={permissionMode}
      agentFlavor={agentFlavor}
      modelMode={modelMode}
      resolvedModel={resolvedModel}
      rawModel={rawModel}
      nativeModel={nativeModel}
      effort={effort}
      modelDowngraded={modelDowngraded}
      accountEmail={props.accountEmail}
      apiKeyName={props.apiKeyName}
      projectDir={props.projectDir}
      disconnected={!active}
      // Epic #3285 correction pass 1: a DISCONNECTED session keeps the cluster
      // tappable (dashed "staged" chips → the Session Configuration Modal, whose
      // Apply is disabled with "reconnect to apply", #3290 R6). Only the
      // composer's own disabled/thread state disables it — never `!active`.
      disabled={composerDisabled}
      onOpenConfig={() => props.onOpenConfig?.()}
    />
  );
  // #3517 (Tasks 5/8): the prompt editor props shared by the fullscreen Dialog
  // AND the pop-out window, so the two surfaces never drift (R6).
  const promptEditorSharedProps = {
    configCluster: sessionConfigCluster,
    sessionName,
    text: composerText,
    onChange: (value: string) => api.composer().setText(value),
    disabled: composerDisabled,
    canSend,
    controlsDisabled: actionControlsDisabled,
    onSend: handleSubmit,
    onComposeFocus,
    attachmentCount: attachments.length,
    hasInvalidFiles,
    onAttachmentClick: handleAttachmentClick,
    showAbortButton,
    abortDisabled,
    isAborting,
    abortQueued,
    onAbort: handleAbort,
    showSwitchButton,
    switchDisabled,
    isSwitching,
    onSwitch: handleSwitch,
    queueLength,
    onQueueIndicatorClick: handleQueueIndicatorClick,
    permissionMode,
    modelMode,
    resolvedModel,
    nativeModel,
    agentFlavor,
    permissionModeOptions,
    onPermissionModeChange,
    onModelModeChange,
    onPaste: handlePaste,
  };
  // #3517 Task 8: the prompt pop-out (window + shell + collapse/restore), extracted
  // to a hook so it renders as a ternary sibling and keeps this file under cap.
  const promptPopOut = usePromptPopOut({
    ...promptEditorSharedProps,
    isTouch,
    isComposerExpanded,
    setIsComposerExpanded,
    setShowFullscreenPrompt,
    onOpenHaptic: () => haptic("light"),
    onDragOver: handleDragOver,
    onDragEnter: handleDragEnter,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
  });

  // Issue #1079: when the parent hoists the collapsed heading into the merged
  // dock row, render nothing here (no empty padded wrapper) — but every hook
  // above has already run, so the transfer-channel effects stay registered while
  // the composer is collapsed (Decision 4 / R12). The composer reappears the
  // instant it expands (isComposerExpanded, synced from initialPromptCollapsed).
  if (suppressCollapsedHeading && !isComposerExpanded) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className={`px-3 ${bottomPaddingClass} pt-1 bg-[var(--app-bg)] flex-shrink-0`}
    >
      <div className="mx-auto w-full max-w-content">
        {/* #3517 Task 8: prompt pop-out shell — a sibling of the collapse
            ternary so it renders in BOTH branches and survives the auto-collapse
            that popping out triggers. Renders null when not popped out (R2). */}
        {promptPopOut.shell}
        {!isComposerExpanded ? (
          <button /* design-tokens-allow: composer +Prompt collapse toggle (w-full left-aligned) - D2 E3 named exception (#3357) */
            type="button"
            onClick={() => {
              setIsComposerExpanded(true);
              onPromptCollapseChange?.(false);
            }}
            className="w-full text-left text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors py-1 px-1"
          >
            + Prompt
          </button>
        ) : (
          <>
            <ComposerPrimitive.Root className="relative">
              {overlays}

              <StatusBar
                active={active}
                thinking={thinking}
                agentState={agentState}
                projectDir={props.projectDir}
                sessionId={sessionId}
                // Issue #2882: terminal in the header (D2(a): retires with #3286).
                showTerminalButton={showTerminalButton}
                terminalDisabled={actionControlsDisabled}
                onTerminal={onTerminal ?? (() => {})}
                // Issue #3289 (S4): StatusBar's old MCP text is gone; the modal is
                // now opened from the Session Config Cluster's MCP chip. StatusBar
                // still hosts the modal — its open state is lifted here.
                leadingElement={
                  <button /* design-tokens-allow: composer -Prompt collapse toggle - D2 E3 named exception (#3357) */
                    type="button"
                    onClick={() => {
                      setIsComposerExpanded(false);
                      onPromptCollapseChange?.(true);
                    }}
                    className="text-xs whitespace-nowrap shrink-0 hover:opacity-80 transition-opacity"
                  >
                    <span className="text-[var(--app-fg)]">- Prompt</span>
                  </button>
                }
                // Issue #3289 (S4, R1): the 7 Prompt Text Tools, relocated out of
                // StatusBar into the shared <PromptTextTools> (Row 1, right side).
                trailingElement={
                  <PromptTextTools
                    direction="down"
                    disabled={composerDisabled}
                    hasContent={hasText}
                    onCopy={handleCopyPrompt}
                    copyFeedback={promptCopyFeedback}
                    onMoveLineUp={handleMoveLineUp}
                    canMoveLineUp={
                      hasText &&
                      !composerDisabled &&
                      !isFirstLine(composerText, inputState.selection.start)
                    }
                    onMoveLineDown={handleMoveLineDown}
                    canMoveLineDown={
                      hasText &&
                      !composerDisabled &&
                      !isLastLine(composerText, inputState.selection.start)
                    }
                    onPush={onMoveToNotes ? handleMoveToNotes : undefined}
                    canPush={
                      hasText || attachments.some(a => a.status !== "uploading")
                    }
                    onPopOut={promptPopOut.onPopOut}
                    onExpand={handleExpandPrompt}
                    onAttach={handleAttachmentClick}
                    attachmentCount={attachments.length}
                    hasInvalidFiles={hasInvalidFiles}
                    onDelete={handleClearPrompt}
                  />
                }
              />

              <div
                ref={dropZoneRef}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`overflow-hidden rounded-lg bg-[var(--app-secondary-bg)] transition-shadow ${
                  isDragOver ? "ring-2 ring-inset ring-[var(--app-link)]" : ""
                }`}
              >
                {/* px-2 (issue #2882 iter AC): the placeholder/text left edge
                    aligns with the bottom-row permission text (ComposerButtons
                    pl-2) and sits ~1 char in from the "- Prompt"/"Notes" label
                    column — was px-4, which read ~1 char too far right. */}
                <div className="flex items-center px-2 py-2">
                  <ComposerPrimitive.Input
                    autoCapitalize="none"
                    ref={textareaRef}
                    autoFocus={!composerDisabled && !isTouch}
                    // Issue #2848: kiosk IME suppression. `undefined` (not "text")
                    // is load-bearing — React omits the attribute entirely when
                    // off, so the default (non-kiosk) DOM is byte-for-byte
                    // unchanged (R4). The V1 regression test pins this.
                    inputMode={kioskMode && !imeSummoned ? "none" : undefined}
                    // Under kiosk, disable assistant-ui's framework-initiated
                    // refocus paths so a run-start / thread-switch focus cannot
                    // silently re-suppress a just-summoned keyboard (#2848 Open
                    // Risk). `undefined` when off leaves the primitive's defaults
                    // untouched (they are consumed props, never DOM — R4 holds).
                    unstable_focusOnRunStart={kioskMode ? false : undefined}
                    unstable_focusOnScrollToBottom={
                      kioskMode ? false : undefined
                    }
                    unstable_focusOnThreadSwitched={
                      kioskMode ? false : undefined
                    }
                    placeholder={
                      // Issue #2556: the composer is disabled ONLY while a send
                      // mutation is in flight (composerDisabled ⟺ isSending;
                      // offline does NOT disable — see composerDisabled above).
                      // Surface that reason instead of an inert, reasonless box
                      // that looks like a dropped keystroke.
                      composerDisabled
                        ? "Sending…"
                        : showContinueHint
                          ? "Type 'continue' to resume..."
                          : `Type a message...  (${COMPOSER_SUBMIT_LABELS[submitBehavior]} to send)`
                    }
                    disabled={composerDisabled}
                    // #1524: disable the framework's built-in bare-Enter submit so
                    // a bare Enter inserts a newline; handleKeyDown owns the send
                    // decision (Shift / Ctrl / Cmd + Enter).
                    submitOnEnter={false}
                    maxRows={5}
                    cancelOnEscape={false}
                    addAttachmentOnPaste={false}
                    onChange={handleChange}
                    onSelect={handleSelect}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    onFocus={onComposeFocus}
                    // Issue #2848: re-arm IME suppression when the field loses
                    // focus so the next focus is suppressed again. Skipped during
                    // the summon's own programmatic blur (summoningRef). Kiosk-gated
                    // so kiosk-off attaches no handler at all (R4).
                    onBlur={kioskMode ? handleImeBlur : undefined}
                    className="flex-1 resize-none md:resize-y bg-transparent text-sm leading-snug text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </div>

                {/* Queue management modal */}
                <QueueManagementModal
                  isOpen={showQueueModal}
                  onOpenChange={setShowQueueModal}
                  messages={queuedMessages}
                  onAddMessage={handleAddToQueue}
                  onUpdateMessage={handleUpdateQueuedMessage}
                  onDeleteMessage={handleDeleteQueuedMessage}
                  onClearAll={handleClearQueue}
                  onSendQueue={handleSendQueue}
                  isProcessingQueue={isProcessingQueue}
                  threadIsRunning={threadIsRunning}
                />

                {/* Fullscreen prompt editor modal — props shared with the
                    pop-out window via promptEditorSharedProps (#3517 R6). */}
                <FullscreenPromptEditorModal
                  isOpen={showFullscreenPrompt}
                  onClose={() => setShowFullscreenPrompt(false)}
                  onPopOut={promptPopOut.onPopOutFromFullscreen}
                  {...promptEditorSharedProps}
                />

                {/* Attachment management modal — mounted AFTER the fullscreen
                    editor so its portal stacks ON TOP when the paperclip is
                    tapped from the fullscreen surface (#1787 round-2). */}
                <AttachmentManagementModal
                  isOpen={showAttachmentModal}
                  onOpenChange={setShowAttachmentModal}
                  attachments={attachments}
                  onAddFiles={addFiles}
                  onRemoveFile={removeFile}
                  onRenameFile={renameFile}
                  onClearAll={handleClearAttachments}
                  onUploadAll={handleUploadAttachments}
                  isUploading={isUploading}
                  pendingCount={attachmentPendingCount}
                  uploadedCount={attachmentUploadedCount}
                />

                <ComposerButtons
                  // Issue #4707: voice-input mic (renders nothing when unavailable).
                  voiceButton={<ComposerVoiceButton inputRef={textareaRef} />}
                  // Issue #2848: kiosk ⌨ summon control (rendered only under kiosk).
                  kioskMode={kioskMode}
                  onSummonKeyboard={summonKeyboard}
                  canSend={canSend}
                  controlsDisabled={actionControlsDisabled}
                  onSend={handleSubmit}
                  showAbortButton={showAbortButton}
                  abortDisabled={abortDisabled}
                  isAborting={isAborting}
                  abortQueued={abortQueued}
                  onAbort={handleAbort}
                  showSwitchButton={showSwitchButton}
                  switchDisabled={switchDisabled}
                  isSwitching={isSwitching}
                  onSwitch={handleSwitch}
                  queueLength={queueLength}
                  onQueueIndicatorClick={handleQueueIndicatorClick}
                  // Issue #3289 (S4): the Session Config Cluster supersedes the old
                  // left-cluster model/effort + permission pickers. It renders the
                  // boxed chips (Permission · Model · Effort · Account · MCP); a tap
                  // opens the config modal (interim EditSessionParamsModal).
                  leadingCluster={sessionConfigCluster}
                />

                {/* Clear prompt confirmation dialog */}
                <ConfirmDialog
                  isOpen={clearPromptDialogOpen}
                  onClose={() => setClearPromptDialogOpen(false)}
                  title="Clear Prompt?"
                  description="This will delete all text in the prompt field. This action cannot be undone."
                  confirmLabel="Clear"
                  confirmingLabel="Clearing..."
                  onConfirm={doClearPrompt}
                  isPending={false}
                  destructive
                />

                {/* Move to notes overflow confirmation dialog */}
                <ConfirmDialog
                  isOpen={showMoveToNotesOverflow}
                  onClose={() => {
                    setShowMoveToNotesOverflow(false);
                    setOverflowDetails(null);
                  }}
                  title="Text Overflow"
                  description={
                    overflowDetails
                      ? `Only ${overflowDetails.toMove.length} of ${overflowDetails.toMove.length + overflowDetails.remaining.length} characters will fit in Session Notes. The remaining ${overflowDetails.remaining.length} characters will stay in the message input.`
                      : ""
                  }
                  confirmLabel="Transfer Partial"
                  confirmingLabel="Transferring..."
                  onConfirm={handleConfirmOverflowTransfer}
                  isPending={false}
                />

                {/* Invalid files send-block dialog (#3517: extracted to keep
                    this file under its max-lines cap when the pop-out landed) */}
                <InvalidFilesDialog
                  open={showInvalidFilesDialog}
                  onOpenChange={setShowInvalidFilesDialog}
                  attachments={attachments}
                />
              </div>
            </ComposerPrimitive.Root>
          </>
        )}
      </div>
    </div>
  );
}
