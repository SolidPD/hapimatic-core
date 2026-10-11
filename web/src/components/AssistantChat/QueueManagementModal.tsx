// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useCallback, useRef, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TrashIcon, MaximizeIcon, CloseIcon } from "@/components/ui/icons";
import { getComposerEnterIntent } from "@/lib/composerSubmitBehavior";
import { useComposerSubmitBehavior } from "@/hooks/useComposerSubmitBehavior";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";
import { CopyButton } from "@/components/ui/CopyButton";

interface QueueManagementModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  messages: string[];
  onAddMessage: (message: string) => void;
  onUpdateMessage: (index: number, message: string) => void;
  onDeleteMessage: (index: number) => void;
  onClearAll: () => void;
  onSendQueue: () => void;
  isProcessingQueue: boolean;
  threadIsRunning: boolean;
}

function EditIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

// Max height for edit textarea: ~5 rows of text-sm (20px line-height) + padding
const TEXTAREA_MAX_HEIGHT = 116;

export function QueueItemFullscreenEditor({
  isOpen,
  onClose,
  text,
  onSave,
}: {
  isOpen: boolean;
  onClose: () => void;
  text: string;
  onSave: (newText: string) => void;
}) {
  const [localText, setLocalText] = useState(text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submitBehavior = useComposerSubmitBehavior();

  useEffect(() => {
    if (isOpen) {
      setLocalText(text);
    }
  }, [isOpen, text]);

  useEffect(() => {
    if (isOpen && textareaRef.current) {
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
        const len = textareaRef.current?.value.length ?? 0;
        textareaRef.current?.setSelectionRange(len, len);
      }, 100);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [isOpen]);

  const handleSave = useCallback(() => {
    const trimmed = localText.trim();
    if (trimmed) {
      onSave(trimmed);
    }
    onClose();
  }, [localText, onSave, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Avoid intercepting IME composition keystrokes (mirror HappyComposer / #1787).
      if (e.nativeEvent.isComposing) return;

      // Enter routed through the centralized submit-behavior source of truth
      // (#1524) so this surface honors the /admin/preferences toggle (#1525).
      // Ctrl/Cmd+Enter always force-sends; Shift+Enter sends under the default
      // shift-to-send; a bare Enter falls through to a native newline.
      if (getComposerEnterIntent(e, submitBehavior) === "send") {
        e.preventDefault();
        handleSave();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [submitBehavior, handleSave, onClose]
  );

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent fullscreen className="flex flex-col p-0 gap-0">
        <DialogHeader className="px-4 py-3 border-b border-[var(--app-divider)] shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-base font-semibold text-amber-500">
              Edit Message
            </DialogTitle>
            <DialogDescription className="sr-only">
              Edit your queued message in fullscreen mode
            </DialogDescription>

            <div className="flex items-center gap-2">
              <CopyButton
                variant="ghostStatic"
                size="bare"
                tooltipOnDisabled
                text={localText}
                title="Copy to clipboard"
                copiedTitle="Copied!"
                iconClassName="h-4 w-4"
                copiedIconClassName="h-4 w-4 text-[var(--app-success)]"
                disabled={!localText}
                className={`p-1.5 rounded-full transition-colors ${
                  localText
                    ? "text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-hover)]"
                    : "text-[var(--app-hint)] disabled:opacity-30 cursor-not-allowed"
                }`}
              />

              <div className="w-px h-4 bg-[var(--app-divider)] mx-1" />

              <Button
                type="button"
                variant="ghost"
                onClick={onClose}
                className="h-auto rounded-full p-1.5 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)]"
                title="Close"
              >
                <CloseIcon className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 p-4 overflow-auto">
          <textarea
            autoCapitalize="none"
            ref={textareaRef}
            value={localText}
            onChange={e => setLocalText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your message..."
            className="w-full h-full resize-none rounded-lg bg-[var(--app-secondary-bg)] border border-[var(--app-divider)] px-4 py-3 text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-amber-500"
            style={{ fontSize: "16px" }}
          />
        </div>

        <div className="border-t border-[var(--app-divider)] px-4 py-3 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghostStatic"
            onClick={onClose}
            className="text-sm font-normal text-[var(--app-fg)]/60 transition-colors hover:text-[var(--app-fg)]"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={!localText.trim()}
            className="rounded-lg bg-amber-500 text-white transition-colors hover:bg-amber-600 hover:opacity-100 disabled:cursor-not-allowed"
          >
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function QueueMessageItem({
  index,
  message,
  onUpdate,
  onDelete,
  disabled,
}: {
  index: number;
  message: string;
  onUpdate: (message: string) => void;
  onDelete: () => void;
  disabled: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(message);
  const [showFullscreen, setShowFullscreen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submitBehavior = useComposerSubmitBehavior();

  const autoResize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, TEXTAREA_MAX_HEIGHT) + "px";
  }, []);

  const handleStartEdit = useCallback(() => {
    setEditValue(message);
    setIsEditing(true);
  }, [message]);

  const handleSaveEdit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== message) {
      onUpdate(trimmed);
    }
    setIsEditing(false);
  }, [editValue, message, onUpdate]);

  const handleCancelEdit = useCallback(() => {
    setEditValue(message);
    setIsEditing(false);
  }, [message]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // #1524: send/commit decision routed through the shared source of truth
      // (Shift+Enter commits; bare Enter falls through to a native newline).
      if (getComposerEnterIntent(e, submitBehavior) === "send") {
        e.preventDefault();
        handleSaveEdit();
      } else if (e.key === "Escape") {
        handleCancelEdit();
      }
    },
    [submitBehavior, handleSaveEdit, handleCancelEdit]
  );

  const handleFullscreenSave = useCallback(
    (newText: string) => {
      setEditValue(newText);
      onUpdate(newText);
      setShowFullscreen(false);
      setIsEditing(false);
    },
    [onUpdate]
  );

  // Auto-resize textarea when editing starts or content changes
  useEffect(() => {
    if (isEditing) {
      autoResize();
    }
  }, [isEditing, editValue, autoResize]);

  return (
    <>
      <div className="flex items-start gap-2 rounded-lg bg-[var(--app-bg)] p-3">
        {/* Queue position indicator */}
        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-amber-500/20 text-amber-500 text-xs flex items-center justify-center font-medium mt-0.5">
          {index + 1}
        </span>

        {/* Message content or edit input */}
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <>
              {/* Editing toolbar */}
              <div className="flex items-center justify-end gap-1 mb-1">
                {/* Copy */}
                <CopyButton
                  variant="ghostStatic"
                  size="bare"
                  text={editValue}
                  title="Copy"
                  copiedTitle="Copied!"
                  iconClassName="h-3.5 w-3.5"
                  copiedIconClassName="h-3.5 w-3.5 text-[var(--app-success)]"
                  onMouseDown={e => e.preventDefault()}
                  className="p-1 rounded text-[var(--app-fg)]/50 hover:text-[var(--app-link)] hover:bg-[var(--app-link)]/10 transition-colors"
                />
                {/* Expand to fullscreen */}
                <button /* design-tokens-allow: sub-32px (~22px) editing-toolbar icon (onMouseDown focus-guard) - D2 E1 named exception (#3357) */
                  type="button"
                  onClick={() => setShowFullscreen(true)}
                  onMouseDown={e => e.preventDefault()}
                  className="p-1 rounded text-[var(--app-fg)]/50 hover:text-[var(--app-link)] hover:bg-[var(--app-link)]/10 transition-colors"
                  title="Edit fullscreen"
                >
                  <MaximizeIcon className="h-3.5 w-3.5" />
                </button>
                {/* Delete */}
                <button /* design-tokens-allow: sub-32px (~22px) editing-toolbar icon (onMouseDown focus-guard) - D2 E1 named exception (#3357) */
                  type="button"
                  onClick={() => {
                    setIsEditing(false);
                    onDelete();
                  }}
                  onMouseDown={e => e.preventDefault()}
                  className="p-1 rounded text-[var(--app-fg)]/50 hover:text-red-500 hover:bg-red-500/10 transition-colors"
                  title="Delete message"
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              </div>
              {/* Edit textarea with scrollHeight-based auto-sizing */}
              <textarea
                autoCapitalize="none"
                ref={textareaRef}
                value={editValue}
                onChange={e => {
                  setEditValue(e.target.value);
                }}
                onKeyDown={handleKeyDown}
                onBlur={handleSaveEdit}
                autoFocus
                className="w-full resize-none rounded border border-amber-500/50 bg-[var(--app-surface)] p-2 text-sm text-[var(--app-fg)] focus:border-amber-500 focus:outline-none overflow-y-auto"
                rows={1}
                style={{ minHeight: "2.5rem" }}
              />
            </>
          ) : (
            <p className="text-sm text-[var(--app-fg)] whitespace-pre-wrap break-words">
              {message}
            </p>
          )}
        </div>

        {/* Action buttons (non-editing mode) */}
        {!isEditing && (
          <div className="flex-shrink-0 flex items-center gap-1">
            <BareButton
              type="button"
              onClick={handleStartEdit}
              disabled={disabled}
              className="p-1.5 rounded text-[var(--app-fg)]/50 hover:text-amber-500 hover:bg-amber-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label={`Edit message ${index + 1}`}
              title="Edit"
            >
              <EditIcon />
            </BareButton>
            <BareButton
              type="button"
              onClick={onDelete}
              disabled={disabled}
              className="p-1.5 rounded text-[var(--app-fg)]/50 hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label={`Delete message ${index + 1}`}
              title="Delete"
            >
              <CloseIcon className="h-3.5 w-3.5" />
            </BareButton>
          </div>
        )}
      </div>

      {/* Fullscreen editor for this queue item */}
      <QueueItemFullscreenEditor
        isOpen={showFullscreen}
        onClose={() => {
          setShowFullscreen(false);
        }}
        text={editValue}
        onSave={handleFullscreenSave}
      />
    </>
  );
}

function AddMessageInput({
  onAdd,
  disabled,
}: {
  onAdd: (message: string) => void;
  disabled: boolean;
}) {
  const [value, setValue] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);
  const submitBehavior = useComposerSubmitBehavior();

  const handleAdd = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed) {
      onAdd(trimmed);
      setValue("");
      setIsExpanded(false);
    }
  }, [value, onAdd]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // #1524: send/commit decision routed through the shared source of truth
      // (Shift+Enter adds to queue; bare Enter falls through to a native newline).
      if (getComposerEnterIntent(e, submitBehavior) === "send") {
        e.preventDefault();
        handleAdd();
      } else if (e.key === "Escape") {
        setValue("");
        setIsExpanded(false);
      }
    },
    [submitBehavior, handleAdd]
  );

  if (!isExpanded) {
    return (
      <Button
        type="button"
        variant="ghostStatic"
        onClick={() => setIsExpanded(true)}
        disabled={disabled}
        className="flex h-auto w-full items-center justify-start gap-2 rounded-lg border border-dashed border-[var(--app-fg)]/20 p-3 font-normal text-[var(--app-fg)]/60 transition-colors hover:border-amber-500/50 hover:text-amber-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <PlusIcon />
        <span className="text-sm">Add message to queue</span>
      </Button>
    );
  }

  return (
    <div className="space-y-2">
      <textarea
        autoCapitalize="none"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
        placeholder="Type your message..."
        className="w-full resize-none rounded-lg border border-amber-500/50 bg-[var(--app-bg)] p-3 text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:border-amber-500 focus:outline-none"
        rows={3}
      />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghostStatic"
          onClick={() => {
            setValue("");
            setIsExpanded(false);
          }}
          className="h-auto rounded-none px-3 py-1.5 text-sm font-normal text-[var(--app-fg)]/60 transition-colors hover:text-[var(--app-fg)]"
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={handleAdd}
          disabled={!value.trim()}
          className="h-auto rounded-md bg-amber-500 px-3 py-1.5 text-sm font-normal text-white transition-colors hover:bg-amber-600 hover:opacity-100 disabled:cursor-not-allowed"
        >
          Add to Queue
        </Button>
      </div>
    </div>
  );
}

export function QueueManagementModal({
  isOpen,
  onOpenChange,
  messages,
  onAddMessage,
  onUpdateMessage,
  onDeleteMessage,
  onClearAll,
  onSendQueue,
  isProcessingQueue,
  threadIsRunning,
}: QueueManagementModalProps) {
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const hasMessages = messages.length > 0;
  const canSendQueue = hasMessages && !isProcessingQueue && !threadIsRunning;

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] flex flex-col border-2 border-amber-500/40 bg-[var(--app-bg)]">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2 text-amber-500">
            <span>Message Queue</span>
            {hasMessages && (
              <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-500 text-xs font-medium">
                {messages.length}
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Review and manage queued messages
          </DialogDescription>
        </DialogHeader>

        {/* Message list */}
        <div className="flex-1 overflow-y-auto space-y-2 py-2 min-h-0">
          {messages.length === 0 ? (
            <div className="text-center py-8 text-[var(--app-hint)]">
              <p className="text-sm">No messages in queue</p>
              <p className="text-xs mt-1">
                Add messages to send them sequentially
              </p>
            </div>
          ) : (
            messages.map((message, index) => (
              <QueueMessageItem
                key={index}
                index={index}
                message={message}
                onUpdate={newMessage => onUpdateMessage(index, newMessage)}
                onDelete={() => onDeleteMessage(index)}
                disabled={isProcessingQueue}
              />
            ))
          )}
        </div>

        {/* Add message input */}
        <div className="flex-shrink-0 pt-2 border-t border-[var(--app-fg)]/10">
          <AddMessageInput onAdd={onAddMessage} disabled={isProcessingQueue} />
        </div>

        {/* Footer actions */}
        <div className="flex-shrink-0 flex items-center justify-between pt-3 border-t border-[var(--app-fg)]/10 mt-2">
          <Button
            type="button"
            variant="ghostStatic"
            size="bare"
            onClick={() => setShowClearConfirm(true)}
            disabled={!hasMessages || isProcessingQueue}
            className="text-sm font-normal text-red-500 transition-colors hover:text-red-400 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Clear All
          </Button>

          <Button
            type="button"
            onClick={onSendQueue}
            disabled={!canSendQueue}
            className="gap-2 rounded-lg bg-amber-500 text-white transition-colors hover:bg-amber-600 hover:opacity-100 disabled:cursor-not-allowed"
          >
            <PlayIcon />
            <span>Send Queue</span>
          </Button>
        </div>

        {/* Status hint */}
        {isProcessingQueue && (
          <p className="text-xs text-center text-amber-500 mt-2">
            Processing queue... {messages.length} message
            {messages.length !== 1 ? "s" : ""} remaining
          </p>
        )}
        {threadIsRunning && !isProcessingQueue && hasMessages && (
          <p className="text-xs text-center text-[var(--app-hint)] mt-2">
            Claude is thinking. Queue will process when ready.
          </p>
        )}

        {/* Clear All confirmation dialog */}
        <ConfirmDialog
          isOpen={showClearConfirm}
          onClose={() => setShowClearConfirm(false)}
          title="Clear Message Queue"
          description={`This will remove all ${messages.length} queued message${messages.length !== 1 ? "s" : ""}. This cannot be undone.`}
          confirmLabel="Clear All"
          confirmingLabel="Clearing..."
          onConfirm={async () => {
            onClearAll();
          }}
          isPending={false}
          destructive
        />
      </DialogContent>
    </Dialog>
  );
}
