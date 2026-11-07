// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// issue #2715: a small text-input dialog for create-folder / rename. Modeled on
// RenameSessionDialog but generic. Validates a single path SEGMENT (non-empty,
// no "/", not "." / "..") client-side — defense-in-depth; the server + CLI
// enforce containment authoritatively. Moved from routes/files.tsx (#6224).
export function NameInputDialog(props: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  label: string;
  initialValue: string;
  submitLabel: string;
  isPending: boolean;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState(props.initialValue);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (props.isOpen) {
      setValue(props.initialValue);
      setError(null);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 100);
    }
  }, [props.isOpen, props.initialValue]);

  const validate = (raw: string): string | null => {
    const trimmed = raw.trim();
    if (!trimmed) return "Name cannot be empty";
    if (trimmed === "." || trimmed === "..") return "Invalid name";
    if (trimmed.includes("/")) return "Name cannot contain '/'";
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validate(value);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    try {
      await props.onSubmit(value.trim());
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operation failed");
    }
  };

  return (
    <Dialog open={props.isOpen} onOpenChange={open => !open && props.onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>Enter a name and submit.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={e => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={e => {
              if (e.key === "Escape") props.onClose();
            }}
            placeholder={props.label}
            aria-label={props.label}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={props.isPending}
            aria-invalid={error !== null}
            className={`w-full px-3 py-2.5 rounded-lg border bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:border-transparent ${
              error
                ? "border-red-500 focus:ring-red-500"
                : "border-[var(--app-border)] focus:ring-[var(--app-button)]"
            }`}
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
              onClick={props.onClose}
              disabled={props.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={props.isPending || !value.trim()}>
              {props.isPending ? "Working…" : props.submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
