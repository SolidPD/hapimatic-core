// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SessionKebabMenu — the extensible per-session kebab (issue #3288, S3, R3/R4).
 *
 * Trigger = `MoreVerticalIcon` (its first real usage — a dead import on both
 * surfaces before this issue). TAP opens a `DropdownMenu` (same primitive the
 * loop-cron badge uses) of `entries` — the container passes Branch + Copy
 * Session Info (#4480) and the list is open-ended, so future entries drop in
 * without touching this file. `onOpenChange` reports open/close (the menu stays
 * uncontrolled) so a container can prefetch data an entry needs at tap time.
 *
 * HOVER is surface-divergent (R3, the ONLY list-vs-instance difference in the
 * whole Action Cluster):
 * - `surface="list"`  → a read-only ~75vh Notes Preview panel (the
 *   `NotesHoverPreview`/`NotesHoverPanel` behavior RELOCATED here from
 *   `SessionList/SessionItem.tsx:88-165`, #1617 — colocated with its new trigger).
 * - `surface="instance"` → helper text only (a native `title` tooltip).
 *
 * The hover logic lives on the WRAPPER div, NOT inside `DropdownMenuTrigger`
 * (Radix clones a single focusable child there), so tap→menu and hover→panel
 * never contend for the same element.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { MoreVerticalIcon } from "@/components/icons";
import { parseNotes, type NotesContent } from "@hapi/protocol";

export type SessionKebabEntry = {
  /** Stable key for React + test targeting (`data-testid=kebab-entry-<key>`). */
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
};

type SessionKebabMenuProps = {
  surface: "list" | "instance";
  /** Menu entries, in render order. Open-ended (R4 extensibility). */
  entries: SessionKebabEntry[];
  /** List-surface hover preview source (raw #1075 notes envelope). */
  notesValue?: string;
  /** Session title shown atop the list hover panel (mirrors the editable modal). */
  sessionTitle?: string;
  /** Instance-surface hover helper text (a native tooltip). */
  helperText?: string;
  /** List card needs pointer isolation so opening the menu never navigates the row. */
  isolatePointerEvents?: boolean;
  /** Called when the menu opens or closes (#4480: prefetch on open). */
  onOpenChange?: (open: boolean) => void;
};

/**
 * The fixed, read-only ~75vh notes preview panel (relocated from
 * `SessionList/SessionItem.tsx`, issue #1617). Positioned to the LEFT of the
 * anchor icon (avoids the right viewport edge) and vertically clamped to the
 * viewport. `pointer-events-none` so a mispositioned panel can never trap the
 * cursor.
 */
function NotesHoverPanel(props: {
  anchorRect: DOMRect;
  parsed: NotesContent;
  title?: string;
}) {
  const { anchorRect, parsed, title } = props;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // #1617 round-2 feedback: anchor the panel to the hovered ENTRY, not the
  // viewport center. Default: top-align with the anchor and grow DOWNWARD
  // (maxHeight = space below); when the anchor is too close to the viewport
  // bottom, bottom-align with it and grow UPWARD instead.
  const MIN_DOWNWARD_SPACE = 240;
  const spaceBelow = vh - anchorRect.top - 16;
  const anchorDown = spaceBelow >= MIN_DOWNWARD_SPACE;
  const panelMaxH = anchorDown
    ? Math.min(vh * 0.75, spaceBelow)
    : Math.min(vh * 0.75, anchorRect.bottom - 16);
  const right = vw - anchorRect.left + 8;
  const attachmentCount = parsed.attachments.length;

  return (
    <div
      className="fixed z-[60] overflow-y-auto rounded-lg border border-[var(--app-divider)] bg-[var(--app-secondary-bg)] p-3 text-sm text-[var(--app-fg)] shadow-2xl pointer-events-none"
      style={{
        ...(anchorDown
          ? { top: Math.max(8, anchorRect.top) }
          : { bottom: Math.max(8, vh - anchorRect.bottom) }),
        right,
        width: "min(40rem, calc(100vw - 32px))",
        maxHeight: `${panelMaxH}px`,
      }}
    >
      {title ? (
        <div className="mb-2 border-b border-[var(--app-divider)] pb-2 text-sm font-medium break-words">
          {title}
        </div>
      ) : null}
      {parsed.text ? (
        <div className="whitespace-pre-wrap break-words">{parsed.text}</div>
      ) : null}
      {attachmentCount > 0 ? (
        <div className="mt-2 text-xs text-[var(--app-hint)]">
          📎 {attachmentCount} attachment{attachmentCount === 1 ? "" : "s"}
        </div>
      ) : null}
    </div>
  );
}

export function SessionKebabMenu({
  surface,
  entries,
  notesValue,
  sessionTitle,
  helperText = "More actions",
  isolatePointerEvents = false,
  onOpenChange,
}: SessionKebabMenuProps) {
  // List-surface hover-preview state (relocated from NotesHoverPreview, #1617).
  const parsed = parseNotes(notesValue);
  const hasNotesContent = Boolean(parsed.text) || parsed.attachments.length > 0;
  const showNotesHover = surface === "list";

  const wrapperRef = useRef<HTMLDivElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const hoverCapableRef = useRef(false);

  useEffect(() => {
    hoverCapableRef.current =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    return () => {
      if (showTimerRef.current) clearTimeout(showTimerRef.current);
    };
  }, []);

  const handleEnter = () => {
    if (!showNotesHover || !hoverCapableRef.current || !hasNotesContent) return;
    if (showTimerRef.current) clearTimeout(showTimerRef.current);
    showTimerRef.current = setTimeout(() => {
      const el = wrapperRef.current;
      if (el) setAnchorRect(el.getBoundingClientRect());
    }, 300);
  };
  const handleLeave = () => {
    if (showTimerRef.current) clearTimeout(showTimerRef.current);
    setAnchorRect(null);
  };

  // Pointer isolation for the list card: a tap that opens the menu must not also
  // navigate the row (the row navigates from up-handlers). Mirrors the account
  // badge / mute bell isolation set.
  const stopProp = isolatePointerEvents
    ? {
        onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
        onPointerUp: (e: React.PointerEvent) => e.stopPropagation(),
        onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
        onMouseUp: (e: React.MouseEvent) => e.stopPropagation(),
        onTouchStart: (e: React.TouchEvent) => e.stopPropagation(),
        onTouchEnd: (e: React.TouchEvent) => e.stopPropagation(),
      }
    : {};

  return (
    <div
      ref={wrapperRef}
      data-testid="session-kebab"
      className="relative"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <DropdownMenu onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-testid="session-kebab-trigger"
            aria-label="More actions"
            title={showNotesHover ? undefined : helperText}
            onClick={
              isolatePointerEvents ? e => e.stopPropagation() : undefined
            }
            {...stopProp}
          >
            <MoreVerticalIcon className="h-5 w-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-[180px]" /* design-tokens-allow: 180px kebab min-width; no exact spacing token (--space tops at 32px) */
        >
          {entries.map(entry => (
            <DropdownMenuItem
              key={entry.key}
              data-testid={`kebab-entry-${entry.key}`}
              disabled={entry.disabled}
              onClick={e => {
                e.stopPropagation();
                entry.onSelect();
              }}
              className="flex items-center gap-2"
            >
              {entry.icon}
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {showNotesHover && anchorRect
        ? createPortal(
            <NotesHoverPanel
              anchorRect={anchorRect}
              parsed={parsed}
              title={sessionTitle}
            />,
            document.body
          )
        : null}
    </div>
  );
}
