// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useEffect, useRef, useCallback } from "react";
import {
  formatModelName,
  getModelModesForFlavor,
  getPermissionModeLabel,
  MODEL_MODE_LABELS,
} from "@hapi/protocol";
import type { PermissionModeOption } from "@hapi/protocol";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EditorToolbar } from "@/components/PopOutEditorShell";
import {
  moveLineUp,
  moveLineDown,
  isFirstLine,
  isLastLine,
} from "@/utils/moveLines";
import { handleIndentKeyDown } from "@/utils/indentLines";
import { ComposerButtons } from "@/components/AssistantChat/ComposerButtons";
import { useClientMode } from "@/hooks/useClientMode";
import { useKioskImeSuppression } from "@/hooks/useKioskImeSuppression";
import { PermissionModeTrigger } from "@/components/AssistantChat/PermissionModeTrigger";
import { ModelModePicker } from "@/components/AssistantChat/ModelModePicker";
import { useComposerSubmitBehavior } from "@/hooks/useComposerSubmitBehavior";
import {
  COMPOSER_SUBMIT_LABELS,
  getComposerEnterIntent,
} from "@/lib/composerSubmitBehavior";
import type { ModelMode, PermissionMode } from "@/types/api";

/**
 * usePromptEditor — the shared prompt-editor controller (#3517 Task 4).
 *
 * Owns ALL prompt-editor state and handlers (localText mirror, cursor, copy,
 * clear-confirm, kiosk IME, submit behavior, key handling) so the SAME editor
 * renders in both the fullscreen Dialog (FullscreenPromptEditorModal) and the
 * pop-out window (hosted by HappyComposer via PopOutEditorShell), with ONE
 * state instance feeding both the header toolbar and the body.
 *
 * WORKER DECISION (directive Task 4 fork): `textareaRef` and the `localText`
 * text-mirror live HERE in the controller — a single owner shared by the toolbar
 * and body — rather than in each consumer. This is why the consumer never threads
 * a ref down and never re-declares the mirror.
 */
type UsePromptEditorParams = {
  /** Is this editor surface currently shown (dialog open OR popped out)? */
  active: boolean;
  text: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  canSend: boolean;
  controlsDisabled: boolean;
  /** Perform the send AND any consumer-specific post-send cleanup (close etc). */
  onSend: () => void;
  /** Close the current surface (Escape). Dialog: onClose; pop-out: win.close(). */
  onRequestClose: () => void;
  onComposeFocus?: () => void;
};

export function usePromptEditor(params: UsePromptEditorParams) {
  const {
    active,
    text,
    onChange,
    disabled = false,
    canSend,
    controlsDisabled,
    onSend,
    onRequestClose,
    onComposeFocus,
  } = params;

  const [localText, setLocalText] = useState(text);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [cursorPos, setCursorPos] = useState(0);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Issue #2848: kiosk IME suppression on the editor's own textarea.
  const { kioskMode } = useClientMode();
  const { imeSummoned, summonKeyboard, handleImeBlur } =
    useKioskImeSuppression(textareaRef);

  // #1525/#1524: active composer submit behavior, live-followed.
  const submitBehavior = useComposerSubmitBehavior();

  // Sync the local mirror from the `text` prop while active (prompt semantics —
  // an external change like an applied suggestion reflects into the editor).
  useEffect(() => {
    if (active) {
      setLocalText(text);
    }
  }, [active, text]);

  // Focus the textarea when the surface becomes active.
  useEffect(() => {
    if (active && textareaRef.current) {
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
        const len = textareaRef.current?.value.length ?? 0;
        textareaRef.current?.setSelectionRange(len, len);
      }, 100);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [active]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setLocalText(value);
      onChange(value);
    },
    [onChange]
  );

  const copyToClipboard = useCallback(async () => {
    if (!localText) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(localText);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = localText;
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    } catch {
      // Silently fail
    }
  }, [localText]);

  const doClear = useCallback(async () => {
    setLocalText("");
    onChange("");
    textareaRef.current?.focus();
  }, [onChange]);

  const handleClear = useCallback(() => {
    setClearDialogOpen(true);
  }, []);

  const applyMove = useCallback(
    (moveFn: typeof moveLineUp) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const pos = ta.selectionStart;
      const result = moveFn(localText, pos);
      if (!result) return;
      setLocalText(result.text);
      onChange(result.text);
      setCursorPos(result.cursorPos);
      requestAnimationFrame(() => {
        ta.setSelectionRange(result.cursorPos, result.cursorPos);
        ta.focus();
      });
    },
    [localText, onChange]
  );

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

  const hasContent = localText.length > 0;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Avoid intercepting IME composition keystrokes (mirror HappyComposer).
      if (e.nativeEvent.isComposing) return;

      // Tab / Shift+Tab indent + outdent.
      const indent = handleIndentKeyDown(e, e.currentTarget);
      if (indent) {
        const ta = e.currentTarget;
        setLocalText(indent.text);
        onChange(indent.text);
        setCursorPos(indent.selectionStart);
        requestAnimationFrame(() => {
          ta.setSelectionRange(indent.selectionStart, indent.selectionEnd);
        });
        return;
      }

      // Enter routed through the centralized submit-behavior source of truth.
      if (getComposerEnterIntent(e, submitBehavior) === "send") {
        e.preventDefault();
        if (canSend && !controlsDisabled) {
          onSend();
        }
        return;
      }

      // Escape closes the current surface (textarea-owned, not a Dialog concern).
      if (e.key === "Escape") {
        e.preventDefault();
        onRequestClose();
      }
    },
    [
      canSend,
      controlsDisabled,
      onSend,
      onChange,
      onRequestClose,
      submitBehavior,
    ]
  );

  return {
    localText,
    cursorPos,
    copyFeedback,
    hasContent,
    clearDialogOpen,
    setClearDialogOpen,
    doClear,
    textareaRef,
    kioskMode,
    imeSummoned,
    summonKeyboard,
    handleImeBlur,
    submitBehavior,
    handleChange,
    handleCursorChange,
    handleKeyDown,
    copyToClipboard,
    applyMove,
    handleClear,
    canMoveUp: hasContent && !disabled && !isFirstLine(localText, cursorPos),
    canMoveDown: hasContent && !disabled && !isLastLine(localText, cursorPos),
    disabled,
    canSend,
    controlsDisabled,
    onSend,
    onComposeFocus,
  };
}

export type PromptEditorController = ReturnType<typeof usePromptEditor>;

type PromptEditorToolbarProps = {
  controller: PromptEditorController;
  attachmentCount?: number;
  hasInvalidFiles?: boolean;
  onAttachmentClick?: () => void;
};

/**
 * The prompt editor's header toolbar (Copy / Move / paperclip / Clear), rendered
 * in the shell header slot and the fullscreen Dialog header. Wraps the shared
 * EditorToolbar with the prompt-specific Clear title and paperclip (no `disabled`,
 * matching the original prompt paperclip — Task 6 difference #1).
 */
export function PromptEditorToolbar({
  controller,
  attachmentCount = 0,
  hasInvalidFiles = false,
  onAttachmentClick,
}: PromptEditorToolbarProps) {
  return (
    <EditorToolbar
      hasContent={controller.hasContent}
      copyFeedback={controller.copyFeedback}
      onCopy={controller.copyToClipboard}
      onMoveUp={() => controller.applyMove(moveLineUp)}
      onMoveDown={() => controller.applyMove(moveLineDown)}
      canMoveUp={controller.canMoveUp}
      canMoveDown={controller.canMoveDown}
      onClear={controller.handleClear}
      clearTitle="Clear message"
      attachment={
        onAttachmentClick
          ? {
              count: attachmentCount,
              hasInvalid: hasInvalidFiles,
              onClick: onAttachmentClick,
            }
          : undefined
      }
    />
  );
}

type PromptEditorBodyProps = {
  controller: PromptEditorController;
  // ComposerButtons footer props (beyond canSend/controlsDisabled/onSend, which
  // ride on the controller so the Enter path and the send button share one send).
  showAbortButton: boolean;
  abortDisabled: boolean;
  isAborting: boolean;
  abortQueued: boolean;
  onAbort: () => void;
  showSwitchButton: boolean;
  switchDisabled: boolean;
  isSwitching: boolean;
  onSwitch: () => void;
  queueLength?: number;
  onQueueIndicatorClick?: () => void;
  // Picker props (issue #2455)
  permissionMode?: PermissionMode;
  modelMode?: ModelMode;
  resolvedModel?: string;
  agentFlavor?: string | null;
  permissionModeOptions?: PermissionModeOption[];
  onPermissionModeChange?: (mode: PermissionMode) => void;
  onModelModeChange?: (mode: ModelMode) => void;
  // Epic #3285 round 14 (item 2): when supplied, the composer's Session Config
  // Cluster renders in the footer INSTEAD of the legacy #2455 text pickers —
  // the fullscreen editor then shows the same boxed chips as the inline composer.
  configCluster?: React.ReactNode;
  // Paste + drag-drop attachment parity. Drop must be wired explicitly (#3517
  // Task 5): the pop-out host renders this OUTSIDE the composer's dropZoneRef,
  // so the synthetic-event bubbling the fullscreen surface relied on is gone.
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onDragOver?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  onDragEnter?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  onDragLeave?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  onDrop?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
};

/**
 * The prompt editor body (textarea + ComposerButtons footer + Clear confirm),
 * driven by the shared controller. Reused by the fullscreen Dialog and the
 * pop-out window (R6). The Clear ConfirmDialog portals to the parent document
 * (ui/dialog.tsx), so from the pop-out window the confirm appears in the parent
 * — inherited behavior, not a regression to fix here.
 */
export function PromptEditorBody({
  controller,
  showAbortButton,
  abortDisabled,
  isAborting,
  abortQueued,
  onAbort,
  showSwitchButton,
  switchDisabled,
  isSwitching,
  onSwitch,
  queueLength,
  onQueueIndicatorClick,
  permissionMode = "default",
  modelMode = "default",
  resolvedModel,
  agentFlavor,
  permissionModeOptions = [],
  onPermissionModeChange,
  onModelModeChange,
  configCluster,
  onPaste,
  onDragOver,
  onDragEnter,
  onDragLeave,
  onDrop,
}: PromptEditorBodyProps) {
  return (
    <>
      {/* overflow-auto (not hidden) so iOS selection handle hit targets aren't clipped.
          A flex column (as in NotesEditorBody) so the textarea is a flex item:
          as an `h-full` inline-block it sat on a text baseline and overflowed
          this wrapper by a few pixels, leaving a stray scrollbar beside it. */}
      <div className="flex flex-1 flex-col p-4 overflow-auto">
        <textarea
          autoCapitalize="none"
          ref={controller.textareaRef}
          value={controller.localText}
          inputMode={
            controller.kioskMode && !controller.imeSummoned ? "none" : undefined
          }
          onChange={controller.handleChange}
          onSelect={controller.handleCursorChange}
          onKeyDown={controller.handleKeyDown}
          onFocus={controller.onComposeFocus}
          onBlur={controller.kioskMode ? controller.handleImeBlur : undefined}
          onPaste={onPaste}
          onDragOver={onDragOver}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          disabled={controller.disabled}
          placeholder={`Type your message...  (${COMPOSER_SUBMIT_LABELS[controller.submitBehavior]} to send)`}
          className="w-full min-h-24 flex-1 resize-none rounded-lg bg-[var(--app-secondary-bg)] border border-[var(--app-divider)] px-4 py-3 text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ fontSize: "16px" }}
        />
      </div>

      {/* ComposerButtons footer with the relocated pickers (issue #2455) */}
      <div className="relative border-t border-[var(--app-divider)] bg-[var(--app-bg)]">
        {/* #1787: persistent submit-behavior hint. */}
        <div className="px-3 pt-1 text-right text-[length:var(--text-caption-xs)] text-[var(--app-hint)]">
          {COMPOSER_SUBMIT_LABELS[controller.submitBehavior]} to send
        </div>
        {configCluster ? (
          // Epic #3285 round 14 (item 2): the composer's Session Config Cluster
          // replaces the legacy text pickers whenever the host supplies it.
          <div className="flex items-center gap-2 px-3 pt-1">
            {configCluster}
          </div>
        ) : (
          (onPermissionModeChange || onModelModeChange) && (
            <div className="flex items-center gap-3 px-3 pt-1">
              {onPermissionModeChange && permissionModeOptions.length > 0 && (
                <PermissionModeTrigger
                  options={permissionModeOptions}
                  current={permissionMode}
                  label={getPermissionModeLabel(permissionMode)}
                  onSelect={mode => onPermissionModeChange(mode)}
                  wrapperClassName="relative flex"
                  triggerClassName="text-xs text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)]"
                />
              )}
              {onModelModeChange &&
                getModelModesForFlavor(agentFlavor).length > 0 && (
                  <ModelModePicker
                    current={modelMode}
                    resolvedModel={resolvedModel}
                    flavor={agentFlavor}
                    onSelect={mode => onModelModeChange(mode)}
                  >
                    <button /* design-tokens-allow: bare inline ModelModePicker child trigger - Button box breaks the tight editor bar - D2 exception (#3357) */
                      type="button"
                      className="text-xs text-[var(--app-link)] transition-colors hover:underline"
                    >
                      {resolvedModel
                        ? formatModelName(resolvedModel)
                        : MODEL_MODE_LABELS[modelMode]}
                    </button>
                  </ModelModePicker>
                )}
            </div>
          )
        )}
        <ComposerButtons
          kioskMode={controller.kioskMode}
          onSummonKeyboard={controller.summonKeyboard}
          canSend={controller.canSend}
          controlsDisabled={controller.controlsDisabled}
          onSend={controller.onSend}
          showAbortButton={showAbortButton}
          abortDisabled={abortDisabled}
          isAborting={isAborting}
          abortQueued={abortQueued}
          onAbort={onAbort}
          showSwitchButton={showSwitchButton}
          switchDisabled={switchDisabled}
          isSwitching={isSwitching}
          onSwitch={onSwitch}
          queueLength={queueLength}
          onQueueIndicatorClick={onQueueIndicatorClick}
        />
      </div>

      {/* Clear prompt confirmation dialog */}
      <ConfirmDialog
        isOpen={controller.clearDialogOpen}
        onClose={() => controller.setClearDialogOpen(false)}
        title="Clear Prompt?"
        description="This will delete all text in the prompt field. This action cannot be undone."
        confirmLabel="Clear"
        confirmingLabel="Clearing..."
        onConfirm={controller.doClear}
        isPending={false}
        destructive
      />
    </>
  );
}
