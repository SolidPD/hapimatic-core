// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useRef, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  UiCopyIcon,
  UiCheckIcon,
  TrashIcon,
  CloseIcon,
  MaximizeIcon,
  MinimizeIcon,
} from "@/components/ui/icons";
import { ChevronUpIcon, ChevronDownIcon } from "@/components/icons";
import { TouchButton } from "@/components/ui/TouchButton";
import { Tooltip } from "./FormField";
import { BookmarkToggle } from "./bookmarkContext";
import {
  moveLineUp,
  moveLineDown,
  isFirstLine,
  isLastLine,
} from "@/utils/moveLines";

export function PromptTextarea(props: {
  value: string;
  onChange: (value: string) => void;
  isDisabled?: boolean;
  placeholder?: string;
  label?: string;
  tooltip?: string;
  /** Saved-defaults bookmark id (rendered right of the info hint). */
  bookmarkId?: string;
}) {
  const {
    value,
    onChange,
    isDisabled = false,
    placeholder,
    label,
    tooltip,
    bookmarkId,
  } = props;
  const [expanded, setExpanded] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [cursorPos, setCursorPos] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const expandedRef = useRef<HTMLTextAreaElement>(null);

  const hasContent = value.length > 0;

  const copyToClipboard = useCallback(async () => {
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = value;
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
  }, [value]);

  const handleClear = useCallback(() => {
    onChange("");
    textareaRef.current?.focus();
  }, [onChange]);

  const applyMove = useCallback(
    (
      moveFn: typeof moveLineUp,
      ref: React.RefObject<HTMLTextAreaElement | null>
    ) => {
      const ta = ref.current;
      if (!ta) return;
      const pos = ta.selectionStart;
      const result = moveFn(value, pos);
      if (!result) return;
      onChange(result.text);
      setCursorPos(result.cursorPos);
      requestAnimationFrame(() => {
        ta.setSelectionRange(result.cursorPos, result.cursorPos);
        ta.focus();
      });
    },
    [value, onChange]
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

  // Shared toolbar buttons (used in both inline and label modes)
  const toolbarButtons = (
    <>
      <TouchButton
        onAction={copyToClipboard}
        disabled={!hasContent || isDisabled}
        className={`p-1 rounded transition-colors ${
          hasContent && !isDisabled
            ? "text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-hover)]"
            : "text-[var(--app-hint)] opacity-30 cursor-not-allowed"
        }`}
        title={copyFeedback ? "Copied!" : "Copy"}
      >
        {copyFeedback ? (
          <UiCheckIcon className="h-3.5 w-3.5 text-[var(--app-success)]" />
        ) : (
          <UiCopyIcon className="h-3.5 w-3.5" />
        )}
      </TouchButton>
      <TouchButton
        onAction={() => applyMove(moveLineUp, textareaRef)}
        disabled={!hasContent || isDisabled || isFirstLine(value, cursorPos)}
        className={`p-1 rounded transition-colors ${
          hasContent && !isDisabled && !isFirstLine(value, cursorPos)
            ? "text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-hover)]"
            : "text-[var(--app-hint)] opacity-30 cursor-not-allowed"
        }`}
        title="Move line up"
      >
        <ChevronUpIcon className="h-3.5 w-3.5" />
      </TouchButton>
      <TouchButton
        onAction={() => applyMove(moveLineDown, textareaRef)}
        disabled={!hasContent || isDisabled || isLastLine(value, cursorPos)}
        className={`p-1 rounded transition-colors ${
          hasContent && !isDisabled && !isLastLine(value, cursorPos)
            ? "text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-hover)]"
            : "text-[var(--app-hint)] opacity-30 cursor-not-allowed"
        }`}
        title="Move line down"
      >
        <ChevronDownIcon className="h-3.5 w-3.5" />
      </TouchButton>
      <TouchButton
        onAction={() => setExpanded(true)}
        disabled={isDisabled}
        className={`p-1 rounded transition-colors ${
          !isDisabled
            ? "text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-hover)]"
            : "text-[var(--app-hint)] opacity-30 cursor-not-allowed"
        }`}
        title="Expand to fullscreen"
      >
        <MaximizeIcon className="h-3.5 w-3.5" />
      </TouchButton>
      <TouchButton
        onAction={handleClear}
        disabled={!hasContent || isDisabled}
        className={`p-1 rounded transition-colors ${
          hasContent && !isDisabled
            ? "text-[var(--app-hint)] hover:text-red-400 hover:bg-[var(--app-hover)]"
            : "text-[var(--app-hint)] opacity-30 cursor-not-allowed"
        }`}
        title="Clear"
      >
        <TrashIcon className="h-3.5 w-3.5" />
      </TouchButton>
    </>
  );

  return (
    <>
      <div>
        {label ? (
          /* Label + toolbar on one row */
          <div className="mb-1 flex items-center justify-between">
            <label className="flex items-center gap-1 text-xs font-medium text-[var(--app-hint)]">
              {label}
              {tooltip && <Tooltip text={tooltip} />}
              {bookmarkId && <BookmarkToggle id={bookmarkId} />}
            </label>
            <div className="flex items-center gap-2">{toolbarButtons}</div>
          </div>
        ) : (
          /* Toolbar-only row (no label) */
          <div className="flex items-center justify-end gap-2 mb-1">
            {toolbarButtons}
          </div>
        )}

        {/* Inline textarea */}
        <textarea
          autoCapitalize="none"
          ref={textareaRef}
          value={value}
          onChange={e => onChange(e.target.value)}
          onSelect={handleCursorChange}
          disabled={isDisabled}
          placeholder={
            placeholder ?? "Enter prompt for the scheduled session..."
          }
          rows={3}
          className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm leading-snug text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50 resize-none"
        />
      </div>

      {/* Fullscreen expand dialog */}
      <Dialog
        open={expanded}
        onOpenChange={open => !open && setExpanded(false)}
      >
        <DialogContent fullscreen className="flex flex-col p-0 gap-0">
          <DialogHeader className="px-4 py-3 border-b border-[var(--app-divider)] shrink-0">
            <div className="flex items-center justify-between">
              <DialogTitle className="text-base font-semibold">
                Prompt
              </DialogTitle>
              <DialogDescription className="sr-only">
                Edit prompt in fullscreen mode
              </DialogDescription>
              <div className="flex items-center gap-2">
                <TouchButton
                  onAction={copyToClipboard}
                  disabled={!hasContent || isDisabled}
                  className={`p-1.5 rounded-full transition-colors ${
                    hasContent && !isDisabled
                      ? "text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-hover)]"
                      : "text-[var(--app-hint)] opacity-30 cursor-not-allowed"
                  }`}
                  title={copyFeedback ? "Copied!" : "Copy"}
                >
                  {copyFeedback ? (
                    <UiCheckIcon className="h-4 w-4 text-[var(--app-success)]" />
                  ) : (
                    <UiCopyIcon className="h-4 w-4" />
                  )}
                </TouchButton>
                <TouchButton
                  onAction={() => applyMove(moveLineUp, expandedRef)}
                  disabled={
                    !hasContent || isDisabled || isFirstLine(value, cursorPos)
                  }
                  className={`p-1.5 rounded-full transition-colors ${
                    hasContent && !isDisabled && !isFirstLine(value, cursorPos)
                      ? "text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-hover)]"
                      : "text-[var(--app-hint)] opacity-30 cursor-not-allowed"
                  }`}
                  title="Move line up"
                >
                  <ChevronUpIcon className="h-4 w-4" />
                </TouchButton>
                <TouchButton
                  onAction={() => applyMove(moveLineDown, expandedRef)}
                  disabled={
                    !hasContent || isDisabled || isLastLine(value, cursorPos)
                  }
                  className={`p-1.5 rounded-full transition-colors ${
                    hasContent && !isDisabled && !isLastLine(value, cursorPos)
                      ? "text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-hover)]"
                      : "text-[var(--app-hint)] opacity-30 cursor-not-allowed"
                  }`}
                  title="Move line down"
                >
                  <ChevronDownIcon className="h-4 w-4" />
                </TouchButton>
                <TouchButton
                  onAction={() => setExpanded(false)}
                  className="p-1.5 rounded-full transition-colors text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-hover)]"
                  title="Exit fullscreen"
                >
                  <MinimizeIcon className="h-4 w-4" />
                </TouchButton>
                <TouchButton
                  onAction={() => {
                    onChange("");
                    expandedRef.current?.focus();
                  }}
                  disabled={!hasContent || isDisabled}
                  className={`p-1.5 rounded-full transition-colors ${
                    hasContent && !isDisabled
                      ? "text-[var(--app-hint)] hover:text-red-400 hover:bg-[var(--app-hover)]"
                      : "text-[var(--app-hint)] opacity-30 cursor-not-allowed"
                  }`}
                  title="Clear"
                >
                  <TrashIcon className="h-4 w-4" />
                </TouchButton>
                <TouchButton
                  onAction={() => setExpanded(false)}
                  className="p-1.5 rounded-full transition-colors text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-hover)]"
                  title="Close"
                >
                  <CloseIcon className="h-4 w-4" />
                </TouchButton>
              </div>
            </div>
          </DialogHeader>
          <div className="flex-1 p-4 overflow-hidden">
            <textarea
              autoCapitalize="none"
              ref={expandedRef}
              value={value}
              onChange={e => onChange(e.target.value)}
              onSelect={handleCursorChange}
              disabled={isDisabled}
              placeholder={
                placeholder ?? "Enter prompt for the scheduled session..."
              }
              className="w-full h-full resize-none rounded-lg bg-[var(--app-secondary-bg)] border border-[var(--app-divider)] px-4 py-3 text-sm leading-snug text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
              autoFocus
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
