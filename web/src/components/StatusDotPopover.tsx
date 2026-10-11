// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useRef, useEffect } from "react";
import { getStatusDotClass } from "@/components/RecoveryStatusBadge";
import { Button } from "@/components/ui/button";
import type { RecoveryStatus } from "@/types/api";
import type { StalenessStatus } from "@/hooks/useSessionStaleness";

type StatusDotPopoverProps = {
  active: boolean;
  thinking: boolean;
  needsReview: boolean;
  recoveryStatus?: RecoveryStatus;
  isWaitingForUserQuestion?: boolean;
  staleness?: StalenessStatus;
  /** Issue #1647: session hit the 429 session limit (waiting for quota reset). */
  rateLimited?: boolean;
  onToggle: (action: "read" | "unread") => void;
  /** Position popover above ("top", default) or below ("bottom") the dot */
  popoverPosition?: "top" | "bottom";
};

export function StatusDotPopover({
  active,
  thinking,
  needsReview,
  recoveryStatus,
  isWaitingForUserQuestion,
  staleness,
  rateLimited,
  onToggle,
  popoverPosition = "top",
}: StatusDotPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Can only toggle on active, non-thinking, non-recovery sessions
  const canToggle =
    active &&
    !thinking &&
    !recoveryStatus &&
    recoveryStatus !== "recovering" &&
    recoveryStatus !== "failed";

  const dotClass = getStatusDotClass(
    active,
    thinking,
    needsReview,
    recoveryStatus,
    isWaitingForUserQuestion,
    staleness,
    rateLimited
  );

  const stalenessTitle =
    staleness === "unresponsive"
      ? "Session unresponsive — likely crashed"
      : staleness === "stale"
        ? "Session may be unresponsive"
        : // Issue #1647: surface the rate-limited reason on hover too.
          rateLimited
          ? "Rate-limited — waiting for the quota window to reset"
          : undefined;

  // Close popover when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen]);

  // Non-toggleable: render static dot — use same h-2 w-2 as toggleable
  // button so container width stays constant across state transitions
  // (prevents text shift when session moves from thinking → idle)
  if (!canToggle) {
    return (
      <span
        className="flex h-2 w-2 items-center justify-center shrink-0"
        title={stalenessTitle}
        aria-hidden={!stalenessTitle}
        aria-label={stalenessTitle}
      >
        <span className={`h-2 w-2 rounded-full ${dotClass}`} />
      </span>
    );
  }

  // Toggleable: render button with popover
  return (
    <div ref={containerRef} className="relative">
      <button /* design-tokens-allow: sub-24px (8×8px) status-dot toggle wrapping the live StatusDot — a <Button> box + focus-ring is inappropriate at this size; D2 sub-24px exception precedent (#3358) */
        type="button"
        onClick={e => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        onMouseDown={e => e.stopPropagation()}
        onMouseUp={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()}
        onTouchEnd={e => e.stopPropagation()}
        className="flex h-2 w-2 items-center justify-center shrink-0 rounded transition-colors hover:bg-[var(--app-hover)]"
        title={needsReview ? "Mark as read" : "Mark as unread"}
        aria-label={
          needsReview ? "Mark session as read" : "Mark session as unread"
        }
      >
        <span className={`h-2 w-2 rounded-full ${dotClass}`} />
      </button>

      {isOpen && (
        <div
          className={`absolute left-0 z-50 ${popoverPosition === "bottom" ? "top-full mt-1" : "bottom-full mb-1"}`}
        >
          <div className="rounded-lg shadow-lg border border-[var(--app-border)] overflow-hidden bg-[var(--app-bg)]">
            <Button
              type="button"
              variant="ghost"
              onClick={e => {
                e.stopPropagation();
                onToggle(needsReview ? "read" : "unread");
                setIsOpen(false);
              }}
              onMouseDown={e => e.stopPropagation()}
              onMouseUp={e => e.stopPropagation()}
              onTouchStart={e => e.stopPropagation()}
              onTouchEnd={e => e.stopPropagation()}
              className="h-auto justify-start whitespace-nowrap rounded-none px-3 py-2 text-sm font-normal text-[var(--app-fg)]"
            >
              {needsReview ? "Mark as read" : "Mark as unread"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
