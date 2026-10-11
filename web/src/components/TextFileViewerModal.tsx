// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useEffect } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useShikiHighlighter } from "@/lib/shiki";
import { getLanguageForFile } from "@/lib/file-types";
import { CopyButton } from "@/components/ui/CopyButton";

/** Maximum file size to display (500KB). Larger files are truncated with a notice. */
const MAX_DISPLAY_SIZE = 500 * 1024;

interface TextFileViewerModalProps {
  /** URL to fetch the file content from (for sent message attachments) */
  src: string;
  filename: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** If provided, use this as the file content instead of fetching src */
  content?: string;
  /** If provided, read content from this File object (for pre-upload attachments) */
  file?: File;
}

/**
 * Fullscreen read-only text/code viewer with syntax highlighting.
 *
 * Reuses the existing Shiki infrastructure for syntax highlighting.
 * Supports JSON, CSV, and other structured formats.
 */
export function TextFileViewerModal({
  src,
  filename,
  open,
  onOpenChange,
  content: providedContent,
  file,
}: TextFileViewerModalProps) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  const language = getLanguageForFile(filename);
  const highlighted = useShikiHighlighter(text ?? "", language);

  // Fetch file content when modal opens
  useEffect(() => {
    if (!open) return;

    if (providedContent !== undefined) {
      if (providedContent.length > MAX_DISPLAY_SIZE) {
        setText(providedContent.slice(0, MAX_DISPLAY_SIZE));
        setTruncated(true);
      } else {
        setText(providedContent);
        setTruncated(false);
      }
      return;
    }

    let cancelled = false;

    async function loadContent() {
      try {
        setLoading(true);
        setError(null);
        setTruncated(false);

        let content: string;

        if (file) {
          // Read from File object (pre-upload attachments)
          content = await file.text();
        } else if (src) {
          // Fetch from URL (sent message attachments)
          const response = await fetch(src);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          content = await response.text();
        } else {
          throw new Error("No content source provided");
        }

        if (cancelled) return;

        if (content.length > MAX_DISPLAY_SIZE) {
          content = content.slice(0, MAX_DISPLAY_SIZE);
          setTruncated(true);
        }

        setText(content);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load file");
          setLoading(false);
        }
      }
    }

    loadContent();

    return () => {
      cancelled = true;
    };
  }, [open, src, providedContent, file]);

  // Reset state on close
  useEffect(() => {
    if (!open) {
      setText(null);
      setError(null);
      setTruncated(false);
    }
  }, [open]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex flex-col"
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="sr-only">
            {filename}
          </DialogPrimitive.Title>

          {/* Header bar */}
          <div
            className="flex items-center justify-between px-4 py-2 bg-black/50 text-white"
            style={{
              paddingTop: "max(0.5rem, env(safe-area-inset-top, 0.5rem))",
            }}
          >
            <span className="text-sm truncate flex-1 mr-2">{filename}</span>
            {language && (
              <span className="text-xs text-white/60 mr-2 shrink-0">
                {language}
              </span>
            )}
            {/* Copy button */}
            {text && (
              <CopyButton
                text={text}
                className="rounded-full bg-black/30 p-2 text-white/70 hover:bg-black/50 hover:text-white min-w-[var(--control-touch)] min-h-[var(--control-touch)] flex h-auto items-center justify-center shrink-0 mr-2"
                iconClassName="h-4 w-4"
                aria-label="Copy file content"
                title="Copy"
              />
            )}
            <DialogPrimitive.Close
              className="rounded-full bg-black/50 p-2 text-white hover:bg-black/70 transition-colors min-w-[var(--control-touch)] min-h-[var(--control-touch)] flex items-center justify-center shrink-0"
              aria-label="Close"
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </DialogPrimitive.Close>
          </div>

          {/* Scrollable content area */}
          <div
            className="flex-1 overflow-auto"
            style={{ paddingBottom: "env(safe-area-inset-bottom, 0)" }}
          >
            {loading && (
              <div className="flex items-center justify-center h-full text-white/60">
                <svg
                  className="animate-spin mr-2"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                  <path d="M12 2a10 10 0 0 1 10 10" strokeOpacity="0.75" />
                </svg>
                Loading file...
              </div>
            )}

            {error && (
              <div className="flex items-center justify-center h-full text-red-400 px-4 text-center">
                <p>Failed to load file: {error}</p>
              </div>
            )}

            {text !== null && !loading && !error && (
              <div className="p-2">
                <div
                  className={
                    /* design-tokens-allow: GitHub-dark file-viewer canvas; --app-code-bg (One-Dark) is a DIFFERENT surface — mapping it would change the color */ "rounded-lg bg-[#0d1117] overflow-x-auto"
                  }
                >
                  <pre className="shiki p-4 text-xs font-mono leading-relaxed text-white/90 whitespace-pre-wrap break-words">
                    <code>{highlighted ?? text}</code>
                  </pre>
                </div>
                {truncated && (
                  <p className="text-center text-amber-400 text-xs mt-2 px-4">
                    File truncated at 500KB. Download the original to see the
                    full content.
                  </p>
                )}
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
