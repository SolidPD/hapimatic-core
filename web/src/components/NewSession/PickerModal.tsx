// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useVisualViewportHeight } from "@/hooks/useVisualViewportHeight";
import { Button } from "@/components/ui/button";

/**
 * Shared modal shell for the Create-Session pickers (issue #2019).
 *
 * Extracted from `DirectoryBrowser` so the GitHub repo / account pickers render
 * with byte-identical proportions and behavior (the user explicitly wants the
 * repo modal to look the same as the directory browser). Key properties:
 *
 *  - **Portaled to `document.body`** — so the `fixed inset-0` overlay escapes the
 *    Create-form's `overflow-y-auto` accordion scroll container. iOS Safari
 *    anchors `position: fixed` descendants of a scroll container to that
 *    container (not the viewport); portaling makes `fixed` resolve against the
 *    true viewport on every engine.
 *  - **Sized to 80% of the iOS *visual* viewport** (not `vh`/`dvh`) so it can
 *    never overflow the screen and shrinks correctly when the keyboard opens.
 *  - Sticky header (title + close + optional search) and an optional sticky
 *    footer never scroll; only the body list scrolls.
 *
 * `radix Dialog` is deliberately NOT used here: its default content is
 * auto-height + `-translate-y-1/2` centered with no total max-height, which
 * overflowed the top/bottom on iOS for long lists (the repo-modal bug).
 */
export function PickerModal(props: {
  title: string;
  description?: ReactNode;
  /** Optional element rendered in the sticky header (e.g. a search box). */
  search?: ReactNode;
  /** Optional sticky footer (e.g. a Cancel button). */
  footer?: ReactNode;
  children: ReactNode;
  onClose: () => void;
}) {
  const { title, description, search, footer, children, onClose } = props;
  const vvHeight = useVisualViewportHeight();

  // Escape closes (custom overlay — no radix Dialog).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-md flex-col overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl"
        style={{ height: Math.round(vvHeight * 0.8) }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── Sticky header: title + close (+ optional description / search) ── */}
        <div className="shrink-0 border-b border-[var(--app-divider)]">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-sm font-medium text-[var(--app-fg)]">
              {title}
            </span>
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              aria-label="Close"
              className="h-auto rounded-md p-1"
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </Button>
          </div>
          {description && (
            <p className="px-3 pb-2 text-xs text-[var(--app-hint)]">
              {description}
            </p>
          )}
          {search && <div className="px-3 pb-2">{search}</div>}
        </div>

        {/* ── Scrollable body (the only scroll region) ── */}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

        {/* ── Optional sticky footer ── */}
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--app-divider)] px-3 py-2">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
