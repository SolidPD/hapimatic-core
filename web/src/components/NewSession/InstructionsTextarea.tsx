// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useRef, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  TrashIcon,
  CloseIcon,
  MaximizeIcon,
  MinimizeIcon,
} from "@/components/ui/icons";
import { Tooltip } from "./FormField";
import { BookmarkToggle } from "./bookmarkContext";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";
import { CopyButton } from "@/components/ui/CopyButton";

/**
 * Monospace textarea with copy/fullscreen/clear toolbar.
 * Used for pre-work and closing instruction fields in the scheduler.
 * Clear action requires user confirmation via ConfirmDialog.
 */
export function InstructionsTextarea(props: {
  value: string;
  onChange: (value: string) => void;
  isDisabled?: boolean;
  placeholder?: string;
  label: string;
  tooltip?: string;
  /** Saved-defaults bookmark id (rendered right of the info hint). */
  bookmarkId?: string;
  dialogTitle: string;
}) {
  const {
    value,
    onChange,
    isDisabled = false,
    placeholder,
    label,
    tooltip,
    bookmarkId,
    dialogTitle,
  } = props;
  const [expanded, setExpanded] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const expandedRef = useRef<HTMLTextAreaElement>(null);

  const hasContent = value.length > 0;

  const handleClear = useCallback(() => {
    onChange("");
    if (expanded) {
      expandedRef.current?.focus();
    } else {
      textareaRef.current?.focus();
    }
  }, [onChange, expanded]);

  const toolbarButtons = (
    <>
      <CopyButton
        variant="ghostStatic"
        size="bare"
        tooltipOnDisabled
        text={value}
        title="Copy"
        copiedTitle="Copied!"
        iconClassName="h-3.5 w-3.5"
        copiedIconClassName="h-3.5 w-3.5 text-[var(--app-success)]"
        disabled={!hasContent || isDisabled}
        className={`p-1 rounded transition-colors focus-visible:ring-0 ${
          hasContent && !isDisabled
            ? "text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-hover)]"
            : "text-[var(--app-hint)] disabled:opacity-30 cursor-not-allowed"
        }`}
      />
      <BareButton
        type="button"
        onClick={() => setExpanded(true)}
        disabled={isDisabled}
        className={`p-1 rounded transition-colors focus-visible:ring-0 ${
          !isDisabled
            ? "text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-hover)]"
            : "text-[var(--app-hint)] disabled:opacity-30 cursor-not-allowed"
        }`}
        title="Expand to fullscreen"
      >
        <MaximizeIcon className="h-3.5 w-3.5" />
      </BareButton>
      <BareButton
        type="button"
        onClick={() => setConfirmClearOpen(true)}
        disabled={!hasContent || isDisabled}
        className={`p-1 rounded transition-colors focus-visible:ring-0 ${
          hasContent && !isDisabled
            ? "text-[var(--app-hint)] hover:text-red-400 hover:bg-[var(--app-hover)]"
            : "text-[var(--app-hint)] disabled:opacity-30 cursor-not-allowed"
        }`}
        title="Clear"
      >
        <TrashIcon className="h-3.5 w-3.5" />
      </BareButton>
    </>
  );

  return (
    <>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="flex items-center gap-1 text-xs font-medium text-[var(--app-hint)]">
            {label}
            {tooltip && <Tooltip text={tooltip} />}
            {bookmarkId && <BookmarkToggle id={bookmarkId} />}
          </label>
          <div className="flex items-center gap-0.5">{toolbarButtons}</div>
        </div>

        <textarea
          autoCapitalize="none"
          ref={textareaRef}
          value={value}
          onChange={e => onChange(e.target.value)}
          disabled={isDisabled}
          placeholder={placeholder}
          rows={4}
          className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 font-mono text-xs text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50 resize-y"
          style={{ fontSize: "12px" }}
        />
      </div>

      {/* Fullscreen dialog */}
      <Dialog
        open={expanded}
        onOpenChange={open => !open && setExpanded(false)}
      >
        <DialogContent fullscreen className="flex flex-col p-0 gap-0">
          <DialogHeader className="px-4 py-3 border-b border-[var(--app-divider)] shrink-0">
            <div className="flex items-center justify-between">
              <DialogTitle className="text-base font-semibold">
                {dialogTitle}
              </DialogTitle>
              <DialogDescription className="sr-only">
                Edit {dialogTitle.toLowerCase()} in fullscreen mode
              </DialogDescription>
              <div className="flex items-center gap-0.5">
                <CopyButton
                  variant="ghostStatic"
                  size="bare"
                  tooltipOnDisabled
                  text={value}
                  title="Copy"
                  copiedTitle="Copied!"
                  iconClassName="h-4 w-4"
                  copiedIconClassName="h-4 w-4 text-[var(--app-success)]"
                  disabled={!hasContent || isDisabled}
                  className={`p-1.5 rounded-full transition-colors ${
                    hasContent && !isDisabled
                      ? "text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-hover)]"
                      : "text-[var(--app-hint)] disabled:opacity-30 cursor-not-allowed"
                  }`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setExpanded(false)}
                  className="h-auto rounded-full p-1.5 text-[var(--app-hint)] hover:bg-[var(--app-hover)] hover:text-[var(--app-link)]"
                  title="Exit fullscreen"
                >
                  <MinimizeIcon className="h-4 w-4" />
                </Button>
                <BareButton
                  type="button"
                  onClick={() => setConfirmClearOpen(true)}
                  disabled={!hasContent || isDisabled}
                  className={`p-1.5 rounded-full transition-colors ${
                    hasContent && !isDisabled
                      ? "text-[var(--app-hint)] hover:text-red-400 hover:bg-[var(--app-hover)]"
                      : "text-[var(--app-hint)] disabled:opacity-30 cursor-not-allowed"
                  }`}
                  title="Clear"
                >
                  <TrashIcon className="h-4 w-4" />
                </BareButton>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setExpanded(false)}
                  className="h-auto rounded-full p-1.5"
                  title="Close"
                >
                  <CloseIcon className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </DialogHeader>
          <div className="flex-1 p-4 overflow-hidden">
            <textarea
              autoCapitalize="none"
              ref={expandedRef}
              value={value}
              onChange={e => onChange(e.target.value)}
              disabled={isDisabled}
              placeholder={placeholder}
              className="w-full h-full resize-none rounded-lg bg-[var(--app-secondary-bg)] border border-[var(--app-divider)] px-4 py-3 font-mono text-xs text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
              style={{ fontSize: "12px" }}
              autoFocus
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* Clear confirmation dialog */}
      <ConfirmDialog
        isOpen={confirmClearOpen}
        onClose={() => setConfirmClearOpen(false)}
        title="Clear field"
        description={`Are you sure you want to clear ${label.toLowerCase()}? This cannot be undone.`}
        confirmLabel="Clear"
        confirmingLabel="Clearing…"
        onConfirm={async () => handleClear()}
        isPending={false}
        destructive
      />
    </>
  );
}
