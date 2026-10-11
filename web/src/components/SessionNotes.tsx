// SPDX-License-Identifier: AGPL-3.0-only
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ApiClient } from "@/api/client";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SessionNotesEditorModal } from "@/components/SessionNotesEditorModal";
import {
  moveLineUp,
  moveLineDown,
  isFirstLine,
  isLastLine,
} from "@/utils/moveLines";
import { handleIndentKeyDown } from "@/utils/indentLines";
import { SimpleMarkdown } from "@/components/SimpleMarkdown";
import { useNotesAttachments } from "@/hooks/useNotesAttachments";
import { type Attachment } from "@/lib/attachment-store";
import { type NotesAttachment } from "@hapi/protocol";
import { Button } from "@/components/ui/button";
import { AttachmentManagementModal } from "@/components/AssistantChat/AttachmentManagementModal";
import { PromptTextTools } from "@/components/AssistantChat/PromptTextTools";
import { usePlatform } from "@/hooks/usePlatform";
import { useNotesPopOut } from "@/components/NotesPopOut";
import {
  useSessionNotesAutosave,
  MAX_NOTES_LENGTH,
} from "@/hooks/useSessionNotesAutosave";

const NOTES_HEIGHT_KEY = "hapi:sessionNotesHeight:v2"; // v2: reset stale rows=2 heights (#739)
const MIN_HEIGHT = 36; // ~single row text-sm + py-2 padding (#739)
const MAX_HEIGHT = 110; // ~5 lines at text-sm/leading-snug

// Helper to get/set persisted notes height
function getPersistedHeight(): number | null {
  try {
    const stored = localStorage.getItem(NOTES_HEIGHT_KEY);
    if (stored) {
      const height = parseInt(stored, 10);
      if (!isNaN(height) && height >= MIN_HEIGHT && height <= MAX_HEIGHT) {
        return height;
      }
    }
  } catch {
    // Ignore localStorage errors
  }
  return null;
}

function setPersistedHeight(height: number): void {
  try {
    // Clamp to reasonable bounds
    const clamped = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, height));
    localStorage.setItem(NOTES_HEIGHT_KEY, String(clamped));
  } catch {
    // Ignore localStorage errors
  }
}

export function SessionNotes(props: {
  api: ApiClient;
  sessionId: string;
  initialNotes?: string;
  /** Persisted notes attachments for this session (issue #1075). */
  initialNotesAttachments?: NotesAttachment[];
  disabled?: boolean;
  /**
   * Transfer notes content to the message composer. Carries the notes text AND
   * the (settled) notes attachments (issue #1075). Issue #1079 (R12): returns a
   * delivery signal — `false` means the composer channel is unmounted (the move
   * did not land, so notes must be preserved); a truthy/void return = delivered.
   */
  onMoveToComposer?: (payload: {
    text: string;
    attachments: Attachment[];
  }) => boolean | void;
  /**
   * Register a receiver for composer → notes moves (issue #1075). The parent
   * (SessionChat) calls this with the composer's text + attachments; the notes
   * field absorbs them and persists the combined envelope.
   */
  onReceiveMoveRef?: (
    fn: (payload: { text: string; attachments: Attachment[] }) => void
  ) => void;
  /** Callback when notes content changes (for parent state sync) */
  onNotesChange?: (text: string) => void;
  /** The session's display name — labels the fullscreen + pop-out notes editors. */
  sessionName?: string;
  /** Persistent collapse state (#455) */
  initialNotesCollapsed?: boolean;
  onNotesCollapseChange?: (collapsed: boolean) => void;
  /**
   * #3638 (R3): report the pop-out window open/close so the parent
   * (SessionChat) can avoid FORCING Notes collapsed while it is popped out —
   * the row move a forced-collapse triggers remounts this component and destroys
   * the pop-out window.
   */
  onPopOutActiveChange?: (active: boolean) => void;
  /**
   * Issue #1079: render the COLLAPSED heading without the full-width chrome
   * (`w-full`) so the parent merged-row flex container owns horizontal layout
   * and left-anchors it in source order (R3/R5). No effect when expanded.
   */
  chromeless?: boolean;
}) {
  const {
    api,
    sessionId,
    initialNotes = "",
    initialNotesAttachments,
    disabled = false,
    onMoveToComposer,
    onReceiveMoveRef,
    onNotesChange,
    sessionName,
    initialNotesCollapsed,
    onNotesCollapseChange,
    onPopOutActiveChange,
    chromeless,
  } = props;
  const notesAttach = useNotesAttachments(sessionId);
  // Collapse UI state (a component concern; kept out of the shared hook).
  const [isExpanded, setIsExpanded] = useState(
    initialNotesCollapsed !== undefined
      ? !initialNotesCollapsed
      : Boolean(initialNotes || (initialNotesAttachments?.length ?? 0) > 0)
  );

  // Shared notes autosave machinery (issue #1617, R3). The attachment store
  // stays in this component and feeds the hook via getAttachments; onHydrate
  // lets the hook drive store hydration + expand state on a server sync.
  const handleHydrate = useCallback(
    (attachments: NotesAttachment[]) => {
      notesAttach.hydrateFromPersisted(attachments);
      setIsExpanded(
        initialNotesCollapsed !== undefined
          ? !initialNotesCollapsed
          : Boolean(initialNotes || attachments.length > 0)
      );
    },
    // notesAttach is a stable store handle; re-deriving on its identity would
    // needlessly recreate the callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [initialNotesCollapsed, initialNotes]
  );
  const {
    notes,
    handleChange: handleNotesChange,
    saveEnvelope,
    flush,
    isSaving,
    error,
    markEditing,
    endEditing,
  } = useSessionNotesAutosave({
    api,
    sessionId,
    initialNotes,
    initialAttachments: initialNotesAttachments,
    getAttachments: notesAttach.getStateForPersist,
    onNotesChange,
    onHydrate: handleHydrate,
  });
  // Live mirror of notes for the receiveMove closure (registered once; reads the
  // latest text without re-registering per keystroke).
  const notesRef = useRef(notes);
  notesRef.current = notes;

  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [persistedHeight, setPersistedHeightState] = useState<number | null>(
    getPersistedHeight
  );
  const [isFocused, setIsFocused] = useState(false);
  const [cursorPos, setCursorPos] = useState(0);

  // Debounce cursor position updates to avoid re-renders during iOS selection
  // handle drags — each re-render writes the controlled value back to the DOM,
  // which can cause WebKit to drop the selection handle.
  const cursorDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const handleCursorChange = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const pos = (e.target as HTMLTextAreaElement).selectionStart;
      if (cursorDebounceRef.current) clearTimeout(cursorDebounceRef.current);
      cursorDebounceRef.current = setTimeout(() => setCursorPos(pos), 150);
    },
    []
  );

  // Auto-focus textarea when switching to edit mode
  useEffect(() => {
    if (isFocused && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isFocused]);

  // When the notes textarea is focused on iOS, the keyboard opens but the
  // bottom dock (which contains notes) stays behind it because it's in a
  // flex-shrink-0 area outside the scroll container. Fix: shrink the parent
  // flex container to visualViewport.height and make it scrollable so the
  // layout reflows above the keyboard.
  //
  // The scroll position is PINNED to the bottom while notes is focused.
  // Without this, the browser's native caret-following behavior, layout
  // reflows from textarea auto-resize, and iOS visualViewport resize events
  // all fight to scroll the container — typically showing the prompt header
  // and pushing the notes textarea bottom below the keyboard fold.
  // Pinning via a scroll event listener overrides all of these.
  useEffect(() => {
    if (!isFocused) return;

    const vv = window.visualViewport;
    if (!vv) return;

    // Find the parent flex column container (SessionChat root)
    const flexParent = containerRef.current?.closest(
      ".flex.flex-col"
    ) as HTMLElement | null;
    if (!flexParent) return;

    const originalHeight = flexParent.style.height;
    const originalOverflow = flexParent.style.overflowY;
    let keyboardActive = false;

    // Track active drag gestures on the textarea — suspend scroll
    // pinning during drags (selection handle movement) so iOS handles
    // work, but allow pinning during simple taps (keyboard open).
    let touchDragging = false;
    const textarea = textareaRef.current;
    const onTouchStart = () => {
      touchDragging = false;
    };
    const onTouchMove = () => {
      touchDragging = true;
    };
    const onTouchEnd = () => {
      touchDragging = false;
    };
    if (textarea) {
      textarea.addEventListener("touchstart", onTouchStart, { passive: true });
      textarea.addEventListener("touchmove", onTouchMove, { passive: true });
      textarea.addEventListener("touchend", onTouchEnd, { passive: true });
      textarea.addEventListener("touchcancel", onTouchEnd, { passive: true });
    }

    // Pin scroll to bottom: keeps notes fully visible above keyboard.
    // forcePinToBottom always runs (used by adjustForKeyboard after
    // height changes). scrollPinToBottom is the scroll-event version
    // that is suppressed during touch drags to avoid fighting iOS
    // selection handle gestures.
    const forcePinToBottom = () => {
      const maxScroll = flexParent.scrollHeight - flexParent.clientHeight;
      if (flexParent.scrollTop < maxScroll) {
        flexParent.scrollTop = maxScroll;
      }
    };
    const scrollPinToBottom = () => {
      if (touchDragging) return;
      forcePinToBottom();
    };

    const adjustForKeyboard = () => {
      const keyboardHeight = window.innerHeight - vv.height - vv.offsetTop;
      if (keyboardHeight > 100) {
        flexParent.style.height = `${vv.height}px`;
        flexParent.style.overflowY = "auto";
        if (!keyboardActive) {
          keyboardActive = true;
          // Scroll-event pinning: suppressed during touch drags
          flexParent.addEventListener("scroll", scrollPinToBottom);
        }
        // Explicit pin after keyboard height adjustment: always runs
        requestAnimationFrame(forcePinToBottom);
      } else {
        flexParent.removeEventListener("scroll", scrollPinToBottom);
        flexParent.style.height = originalHeight;
        flexParent.style.overflowY = originalOverflow;
        keyboardActive = false;
      }
    };

    vv.addEventListener("resize", adjustForKeyboard);
    // Delay initial check for keyboard animation
    const timer = setTimeout(adjustForKeyboard, 300);

    return () => {
      vv.removeEventListener("resize", adjustForKeyboard);
      flexParent.removeEventListener("scroll", scrollPinToBottom);
      clearTimeout(timer);
      flexParent.style.height = originalHeight;
      flexParent.style.overflowY = originalOverflow;
      if (textarea) {
        textarea.removeEventListener("touchstart", onTouchStart);
        textarea.removeEventListener("touchmove", onTouchMove);
        textarea.removeEventListener("touchend", onTouchEnd);
        textarea.removeEventListener("touchcancel", onTouchEnd);
      }
    };
  }, [isFocused]);

  // Collapse-state sync stays unconditional: the hook's envelope echo guards
  // must not swallow a cross-device collapse/expand change.
  useEffect(() => {
    if (initialNotesCollapsed === undefined) return;
    setIsExpanded(!initialNotesCollapsed);
  }, [initialNotesCollapsed]);

  // Text-mutating handler: route through the shared hook (which notifies the
  // parent + clears the error); the hook's unified save-effect debounces the
  // persist for both text and attachments (#1075).
  const applyMove = useCallback(
    (moveFn: typeof moveLineUp) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const pos = ta.selectionStart;
      const result = moveFn(notes, pos);
      if (!result) return;
      const value = result.text.slice(0, MAX_NOTES_LENGTH);
      handleNotesChange(value);
      setCursorPos(result.cursorPos);
      requestAnimationFrame(() => {
        ta.setSelectionRange(result.cursorPos, result.cursorPos);
        ta.focus();
      });
    },
    [notes, handleNotesChange]
  );

  // Tab / Shift+Tab indent + outdent (mirror HappyComposer). The helper calls
  // preventDefault only when the text actually changed, so an unhandled Tab
  // still moves focus. The result is capped to MAX_NOTES_LENGTH like applyMove.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.nativeEvent.isComposing) return;
      const indent = handleIndentKeyDown(e, e.currentTarget);
      if (!indent) return;
      const ta = e.currentTarget;
      const value = indent.text.slice(0, MAX_NOTES_LENGTH);
      const selStart = Math.min(indent.selectionStart, value.length);
      const selEnd = Math.min(indent.selectionEnd, value.length);
      handleNotesChange(value);
      setCursorPos(selStart);
      requestAnimationFrame(() => {
        ta.setSelectionRange(selStart, selEnd);
      });
    },
    [handleNotesChange]
  );

  // ResizeObserver to persist textarea height on resize (desktop only)
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Only observe on desktop (md breakpoint = 768px)
    const isDesktop = window.matchMedia("(min-width: 768px)").matches;
    if (!isDesktop) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        // Use the element's actual height (offsetHeight includes border)
        const height = (entry.target as HTMLElement).offsetHeight;
        if (height >= MIN_HEIGHT) {
          // Debounce to avoid excessive localStorage writes during drag
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            setPersistedHeight(height);
            setPersistedHeightState(height);
          }, 100);
        }
      }
    });

    observer.observe(textarea);
    return () => {
      observer.disconnect();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [isExpanded, isFocused]);

  // Auto-resize textarea to fit content, capped at MAX_HEIGHT.
  // Ensures consistent grow-upward behavior on all platforms (iOS auto-grows
  // natively but can push content off-screen; desktop doesn't auto-grow at all).
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !isFocused) return;

    // On desktop, respect the user's manual resize preference
    const isDesktop = window.matchMedia("(min-width: 768px)").matches;
    if (isDesktop && persistedHeight) return;

    // Measure natural content height by temporarily resetting.
    // Save/restore parent scrollTop around the measurement because setting
    // height="auto" momentarily collapses the textarea, which can trigger
    // a layout reflow that shifts the parent's scroll position on iOS.
    const scrollParent = textarea.closest(
      ".flex.flex-col"
    ) as HTMLElement | null;
    const savedScrollTop = scrollParent?.scrollTop;

    textarea.style.height = "auto";
    const contentHeight = textarea.scrollHeight;
    const cappedHeight = Math.min(
      Math.max(contentHeight, MIN_HEIGHT),
      MAX_HEIGHT
    );
    textarea.style.height = `${cappedHeight}px`;
    textarea.style.overflowY = contentHeight > MAX_HEIGHT ? "auto" : "hidden";

    // Restore scroll position if it was disturbed by the height reset
    if (scrollParent && savedScrollTop !== undefined) {
      scrollParent.scrollTop = savedScrollTop;
    }
  }, [notes, isFocused, persistedHeight]);

  // Track when user starts editing
  const handleFocus = useCallback(() => {
    markEditing();
    setIsFocused(true);
  }, [markEditing]);

  // Save on blur (immediate save when user leaves field). saveEnvelope dedups
  // internally against the last-saved envelope, so an unchanged note is a no-op.
  const handleBlur = useCallback(async () => {
    // flush() cancels the pending debounce and saves the current envelope; it
    // dedups internally, so an unchanged note is a no-op.
    await flush();
    // Clear editing mode after save completes to allow sync again
    endEditing();
    setIsFocused(false);
  }, [flush, endEditing]);

  const toggleExpanded = useCallback(() => {
    // #1079: call onNotesCollapseChange OUTSIDE the setState updater. The parent
    // (SessionChat) updates its own collapse state synchronously in the handler,
    // and a parent setState from inside a child's updater triggers React's
    // "cannot update a component while rendering a different component" warning.
    const next = !isExpanded;
    setIsExpanded(next);
    onNotesCollapseChange?.(!next);
  }, [isExpanded, onNotesCollapseChange]);

  // Trashcan: clear text AND attachments together, delete uploaded files from
  // server storage (R6, R7), and persist the now-empty note.
  const handleClear = useCallback(async () => {
    const storedNames = notesAttach
      .getStateForPersist()
      .map(a => a.storedName)
      .filter((n): n is string => Boolean(n));
    handleNotesChange("");
    notesAttach.clearAll();
    await saveEnvelope({ text: "", attachments: [] });
    if (storedNames.length > 0) {
      void api.removeUploadedFiles(sessionId, storedNames).catch(() => {
        // Best-effort file cleanup; the notes record is already cleared.
      });
    }
  }, [notesAttach, handleNotesChange, saveEnvelope, api, sessionId]);

  // Move notes content (text + settled attachments) to the composer, then clear
  // notes. Attachments are re-parented (metadata-only) — no re-upload (R3, R15).
  const handleMoveToComposer = useCallback(async () => {
    if (!onMoveToComposer) return;
    const attachments = notesAttach.extractAttachments();
    if (!notes && attachments.length === 0) return;
    // Issue #1079 (R12, Fallback Preservation Rule): only clear + persist-empty
    // when the composer confirms delivery. A `false` signal means the composer
    // channel is unmounted (e.g. a fresh load with the prompt collapsed), so the
    // move did not land — restore the just-extracted attachments and keep the
    // notes text intact rather than destroying the user's content.
    const delivered = onMoveToComposer({ text: notes, attachments });
    if (delivered === false) {
      notesAttach.absorbAttachments(attachments);
      return;
    }
    handleNotesChange("");
    await saveEnvelope({
      text: "",
      attachments: notesAttach.getStateForPersist(),
    });
    // Reset editing mode so future syncs from parent (e.g., text moved back) work
    endEditing();
  }, [
    notes,
    onMoveToComposer,
    notesAttach,
    saveEnvelope,
    handleNotesChange,
    endEditing,
  ]);

  // Receive a composer → notes move (registered via onReceiveMoveRef). Absorb
  // the composer's attachments, append its text, and persist immediately so the
  // pushed-in envelope survives (mirrors the #2766 move-persist pattern).
  const receiveMove = useCallback(
    (payload: { text: string; attachments: Attachment[] }) => {
      notesAttach.absorbAttachments(payload.attachments);
      // The composer already includes the separator in payload.text (a leading
      // "\n" when notes is non-empty), so concatenate directly — do NOT add
      // another newline (that would double the separator).
      const combined = notesRef.current
        ? `${notesRef.current}${payload.text}`
        : payload.text;
      const capped = combined.slice(0, MAX_NOTES_LENGTH);
      handleNotesChange(capped);
      void saveEnvelope({
        text: capped,
        attachments: notesAttach.getStateForPersist(),
      });
      // A moved composer file may still be `pending` (the prompt uploads at
      // Send, not at attach). Settle it now so it lands in the persist shape —
      // the unified save effect persists the envelope once uploads resolve.
      if (payload.attachments.some(a => a.status === "pending" && a.file)) {
        void notesAttach.uploadAll();
      }
    },
    [notesAttach, handleNotesChange, saveEnvelope]
  );

  useEffect(() => {
    onReceiveMoveRef?.(receiveMove);
  }, [onReceiveMoveRef, receiveMove]);

  // ── Attachment surface (issue #1075) ──
  // Notes shares ONLY the prompt's attachment capability: an in-field paperclip
  // opening the SAME AttachmentManagementModal. The send-context controls
  // (Clean, Approve, Queue, Send) do not apply to Notes and are deliberately
  // absent. Drag-drop + paste on the textarea also add files directly — the
  // fullscreen editor (SessionNotesEditorModal) receives these same paste /
  // drop handlers and renders an equivalent paperclip that opens the same
  // AttachmentManagementModal, so files attach the same way from both
  // surfaces (the inline drop-zone ring is not mirrored in fullscreen).
  const [showAttachmentModal, setShowAttachmentModal] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const handleNotesDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setIsDragOver(true);
    }
  }, []);

  const handleNotesDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleNotesDrop = useCallback(
    (e: React.DragEvent) => {
      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        e.preventDefault();
        setIsDragOver(false);
        void notesAttach.addAndUpload(files);
      }
    },
    [notesAttach]
  );

  const handleNotesPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = e.clipboardData?.files;
      if (files && files.length > 0) {
        e.preventDefault();
        void notesAttach.addAndUpload(files);
      }
    },
    [notesAttach]
  );

  const attachmentCount = notesAttach.attachments.length;
  const hasAttachments = attachmentCount > 0;
  const hasInvalidFiles = notesAttach.attachments.some(a => !a.isValid);
  const hasContent = notes.length > 0 || hasAttachments;

  // #3517 Task 9: notes pop-out window. Collapse/restore is LOCAL-ONLY
  // (setIsExpanded) — never onNotesCollapseChange, whose parent swap remounts
  // this component and destroys the pop-out window (KD-6). The shell is hoisted
  // above the early return and rendered in BOTH return paths so it survives the
  // auto-collapse that popping out triggers.
  const { isTouch } = usePlatform();
  const notesPriorExpandedRef = useRef<boolean | null>(null);
  const notesPopOut = useNotesPopOut({
    titleText: "Session Notes",
    sessionName,
    notes,
    onChange: handleNotesChange,
    maxLength: MAX_NOTES_LENGTH,
    disabled,
    attachments: notesAttach.attachments,
    onRemoveAttachment: notesAttach.removeFile,
    onPaste: handleNotesPaste,
    onDragOver: handleNotesDragOver,
    onDragLeave: handleNotesDragLeave,
    onDrop: handleNotesDrop,
    attachmentCount,
    hasInvalidFiles,
    onAttachmentClick: () => setShowAttachmentModal(true),
    onPopOutOpen: () => {
      notesPriorExpandedRef.current = isExpanded;
      setIsExpanded(false);
      setFullscreenOpen(false); // R2 — no Dialog behind the pop-out.
      markEditing();
      onPopOutActiveChange?.(true); // #3638 (R3)
    },
    onPopOutClose: origin => {
      if (origin === "fullscreen") {
        // Popped out of the fullscreen editor → dock back INTO it (still
        // editing). Its Dialog is mounted in the expanded branch: expand first.
        setIsExpanded(true);
        setFullscreenOpen(true);
      } else {
        if (notesPriorExpandedRef.current !== null) {
          setIsExpanded(notesPriorExpandedRef.current);
        }
        endEditing();
      }
      notesPriorExpandedRef.current = null;
      onPopOutActiveChange?.(false); // #3638 (R3)
    },
  });
  const canPopOutNotes = notesPopOut.isSupported && !isTouch;

  if (!isExpanded) {
    return (
      <>
        {notesPopOut.shell}
        <Button
          type="button"
          variant="ghostStatic"
          onClick={toggleExpanded}
          disabled={disabled}
          className={`${
            chromeless
              ? "min-h-[var(--control-touch)] flex w-full min-w-0 items-center "
              : "w-full text-left "
          }h-auto justify-start py-1 px-1 text-xs font-normal hover:text-[var(--app-fg)] disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {/* #1079: truncating wrapper so the Notes heading ellipsis-truncates in a
            tight merged row (R9). Harmless in the full-width standalone render. */}
          <span className="min-w-0 truncate">
            + Notes
            {notes.length > 0 ? (
              <span className="text-[var(--app-hint)]">
                {" "}
                ({notes.length}/{MAX_NOTES_LENGTH})
              </span>
            ) : null}
          </span>
        </Button>
      </>
    );
  }

  return (
    <>
      {notesPopOut.shell}
      <div ref={containerRef} className="space-y-1">
        {/* Header row: Notes label with count on left, buttons on right */}
        <div className="flex items-center justify-between">
          {/* Left side: Minus sign + Notes (white) + character count (gray) */}
          <Button
            type="button"
            variant="ghostStatic"
            onClick={toggleExpanded}
            className="h-auto justify-start p-0 text-xs font-normal transition-opacity hover:text-[var(--app-fg)] hover:opacity-80"
          >
            <span className="text-[var(--app-fg)]">- Notes</span>
            <span className="text-[var(--app-hint)]">
              {" "}
              ({notes.length}/{MAX_NOTES_LENGTH}){isSaving ? " saving..." : ""}
            </span>
          </Button>

          {/* Issue #3289 (S4, R5): Notes Text Tools relocated into the shared
              <PromptTextTools> with direction="up" (Push Up to Prompt Field). */}
          <PromptTextTools
            direction="up"
            disabled={disabled}
            hasContent={hasContent}
            copyText={notes}
            onMoveLineUp={() => applyMove(moveLineUp)}
            canMoveLineUp={
              hasContent &&
              !disabled &&
              isFocused &&
              !isFirstLine(notes, cursorPos)
            }
            onMoveLineDown={() => applyMove(moveLineDown)}
            canMoveLineDown={
              hasContent &&
              !disabled &&
              isFocused &&
              !isLastLine(notes, cursorPos)
            }
            onPush={onMoveToComposer ? handleMoveToComposer : undefined}
            canPush={hasContent && !disabled}
            onPopOut={canPopOutNotes ? notesPopOut.onPopOut : undefined}
            onExpand={() => {
              setFullscreenOpen(true);
              markEditing();
            }}
            onAttach={() => setShowAttachmentModal(true)}
            attachmentCount={attachmentCount}
            hasInvalidFiles={hasInvalidFiles}
            onDelete={() => setClearDialogOpen(true)}
          />
        </div>
        <div
          className="relative"
          onDragOver={handleNotesDragOver}
          onDragLeave={handleNotesDragLeave}
          onDrop={handleNotesDrop}
        >
          {!isFocused && notes.length > 0 ? (
            <div
              onClick={() => setIsFocused(true)}
              className="w-full rounded-lg bg-[var(--app-secondary-bg)] border border-[var(--app-divider)] px-3 py-2 text-sm text-[var(--app-fg)] cursor-text overflow-y-auto"
              style={{ maxHeight: `${MAX_HEIGHT}px` }}
            >
              <SimpleMarkdown content={notes} />
            </div>
          ) : (
            <textarea
              autoCapitalize="none"
              ref={textareaRef}
              value={notes}
              onChange={e => handleNotesChange(e.target.value)}
              onSelect={handleCursorChange}
              onKeyDown={handleKeyDown}
              onFocus={handleFocus}
              onBlur={handleBlur}
              onPaste={handleNotesPaste}
              disabled={disabled}
              placeholder="Session notes (for your reference only)"
              maxLength={MAX_NOTES_LENGTH}
              rows={1}
              className="block w-full resize-none md:resize-y md:min-h-[2rem] overflow-y-auto rounded-lg bg-[var(--app-secondary-bg)] border border-[var(--app-divider)] px-3 py-2 text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                height: persistedHeight ? `${persistedHeight}px` : undefined,
                maxHeight: `${MAX_HEIGHT}px`,
              }}
            />
          )}
          {/* #2882: the paperclip moved from this bottom-right floating cluster
              into the Notes top icon cluster (between Expand and Clear). */}
          {isDragOver && (
            <div className="pointer-events-none absolute inset-0 rounded-lg border-2 border-dashed border-[var(--app-link)] bg-[var(--app-link)]/5" />
          )}
        </div>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>

      {/* Clear confirmation dialog */}
      <ConfirmDialog
        isOpen={clearDialogOpen}
        onClose={() => setClearDialogOpen(false)}
        title="Clear Notes?"
        description={
          notesAttach.attachments.length > 0
            ? `This will delete all notes for this session, including ${
                notesAttach.attachments.length
              } attachment${
                notesAttach.attachments.length === 1 ? "" : "s"
              } (removed from server storage). This action cannot be undone.`
            : "This will delete all notes for this session. This action cannot be undone."
        }
        confirmLabel="Clear"
        confirmingLabel="Clearing..."
        onConfirm={handleClear}
        isPending={false}
        destructive
      />

      {/* Fullscreen editor modal */}
      <SessionNotesEditorModal
        isOpen={fullscreenOpen}
        onClose={() => {
          setFullscreenOpen(false);
          endEditing();
        }}
        notes={notes}
        onChange={handleNotesChange}
        maxLength={MAX_NOTES_LENGTH}
        disabled={disabled}
        sessionName={sessionName}
        attachments={notesAttach.attachments}
        onRemoveAttachment={notesAttach.removeFile}
        // Attachment parity with the inline field: the SAME paste / drop
        // handlers and the SAME AttachmentManagementModal (below). The manager
        // paints above this dialog because it opens from INSIDE the already-
        // open fullscreen editor: Radix mounts a dialog's portal only while it
        // is open, so <body> order is open order, and both DialogContent
        // variants share z-50 — the JSX sibling order here is not what stacks it.
        onPaste={handleNotesPaste}
        onDragOver={handleNotesDragOver}
        onDragLeave={handleNotesDragLeave}
        onDrop={handleNotesDrop}
        attachmentCount={attachmentCount}
        hasInvalidFiles={hasInvalidFiles}
        onAttachmentClick={() => setShowAttachmentModal(true)}
        // Pop the fullscreen editor out; the window's Pop-in reopens it.
        onPopOut={
          canPopOutNotes ? notesPopOut.onPopOutFromFullscreen : undefined
        }
      />

      {/* Notes attachment management modal (#1075) — the SAME component the
          prompt uses. Handles hydrated (file-less) attachments without crashing. */}
      <AttachmentManagementModal
        isOpen={showAttachmentModal}
        onOpenChange={setShowAttachmentModal}
        attachments={notesAttach.attachments}
        onAddFiles={notesAttach.addAndUpload}
        onRemoveFile={notesAttach.removeFile}
        onRenameFile={notesAttach.renameFile}
        onClearAll={notesAttach.clearAll}
        onUploadAll={notesAttach.uploadAll}
        isUploading={notesAttach.isUploading}
        pendingCount={notesAttach.pendingCount}
        uploadedCount={notesAttach.uploadedCount}
      />
    </>
  );
}
