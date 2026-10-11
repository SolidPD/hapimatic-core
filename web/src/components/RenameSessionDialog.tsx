// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useEffect, useRef, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { validateSessionName, SESSION_NAME_MAX_LENGTH } from "@hapi/protocol";

type RenameSessionDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  currentName: string;
  onRename: (newName: string) => Promise<void>;
  isPending: boolean;
};

export function RenameSessionDialog(props: RenameSessionDialogProps) {
  const { isOpen, onClose, currentName, onRename, isPending } = props;
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Handle iOS virtual keyboard visibility using visualViewport API
  const updateKeyboardOffset = useCallback(() => {
    if (!window.visualViewport) return;

    const viewportHeight = window.visualViewport.height;
    const windowHeight = window.innerHeight;
    const keyboardHeight = windowHeight - viewportHeight;

    // Only apply offset if keyboard is actually visible (> 100px threshold)
    if (keyboardHeight > 100) {
      // Position dialog in upper portion of visible area
      setKeyboardOffset(keyboardHeight / 2);
    } else {
      setKeyboardOffset(0);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      setName(currentName);
      setError(null);
      setKeyboardOffset(0);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 100);

      // Listen for viewport resize (keyboard show/hide)
      if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", updateKeyboardOffset);
        window.visualViewport.addEventListener("scroll", updateKeyboardOffset);
      }
    }

    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener(
          "resize",
          updateKeyboardOffset
        );
        window.visualViewport.removeEventListener(
          "scroll",
          updateKeyboardOffset
        );
      }
    };
  }, [isOpen, currentName, updateKeyboardOffset]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === currentName) {
      onClose();
      return;
    }

    // Validate session name for tmux compatibility
    const validationError = validateSessionName(trimmed);
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    try {
      await onRename(trimmed);
      onClose();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to rename. Please try again.";
      setError(message);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    }
  };

  // Dynamic style for keyboard-aware positioning
  // Use marginTop offset instead of transform to preserve Tailwind's translate-x/y centering
  const dialogStyle =
    keyboardOffset > 0 ? { marginTop: `-${keyboardOffset}px` } : undefined;

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent
        ref={dialogRef}
        className="max-w-sm transition-transform duration-150"
        style={dialogStyle}
      >
        <DialogHeader>
          <DialogTitle>Rename Session</DialogTitle>
          <DialogDescription>
            Enter a new name for this session.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
          <input
            autoCapitalize="none"
            ref={inputRef}
            type="text"
            value={name}
            onChange={e => {
              const v = e.target.value;
              setName(v);
              const trimmed = v.trim();
              setError(
                trimmed.length === 0 ? null : validateSessionName(trimmed)
              );
            }}
            onKeyDown={handleKeyDown}
            placeholder="Session name"
            className={`w-full px-3 py-2.5 rounded-lg border bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:border-transparent ${
              error
                ? "border-red-500 focus:ring-red-500"
                : "border-[var(--app-border)] focus:ring-[var(--app-button)]"
            }`}
            disabled={isPending}
            maxLength={SESSION_NAME_MAX_LENGTH}
            aria-invalid={error !== null}
          />

          {error ? (
            <div className="rounded-md bg-red-900/20 p-3 text-sm text-red-400">
              {error}
            </div>
          ) : null}

          <div className="flex gap-2 justify-end">
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isPending || !name.trim() || error !== null}
            >
              {isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
