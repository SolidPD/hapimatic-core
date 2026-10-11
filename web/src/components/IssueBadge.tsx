// SPDX-License-Identifier: AGPL-3.0-only
import type { CurrentIssue } from "@/types/github";

function PinIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </svg>
  );
}

function XIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

interface IssueBadgeProps {
  issue: CurrentIssue | null;
  onOpenSelector: () => void;
  onClear: () => void;
  onOpenInfo?: () => void;
}

/**
 * Displays the current GitHub issue with clickable link and clear button.
 * Shows a pin icon button when no issue is selected.
 */
export function IssueBadge({
  issue,
  onOpenSelector,
  onClear,
  onOpenInfo,
}: IssueBadgeProps) {
  if (!issue) {
    // No issue selected - show subtle pin button with icon in h-3 w-3 container for alignment
    return (
      <button /* design-tokens-allow: bare-inline text+icon link (no box); Button chrome breaks the dense header badge-row control (L2 bare-inline precedent #3404); L8 #3410 */
        type="button"
        onClick={onOpenSelector}
        className="flex items-center gap-2 text-[length:var(--text-caption-xs)] text-[var(--app-hint)] hover:text-[var(--app-link)] transition-colors"
        title="Link GitHub issue"
      >
        <span className="flex h-3 w-3 items-center justify-center shrink-0">
          <PinIcon
            className={
              /* design-tokens-allow: 10px pin-glyph size, between --icon-2xs (8px) and --icon-xs (12px), no exact token (L8 #3410) */ "h-[10px] w-[10px]"
            }
          />
        </span>
        <span>Link issue</span>
      </button>
    );
  }

  return (
    <span className="flex items-center gap-2 text-[length:var(--text-caption-xs)] min-w-0 flex-1">
      {/* Pin icon in h-3 w-3 container for alignment */}
      <button /* design-tokens-allow: sub-24px (12×12px) pin-icon control — a Button box + focus-ring is inappropriate at this size (D2 sub-24px precedent #3358); L8 #3410 */
        type="button"
        onClick={onOpenSelector}
        className={`flex h-3 w-3 items-center justify-center shrink-0 ${
          issue.state === "closed"
            ? "text-purple-400 hover:text-[var(--app-fg)]"
            : "text-[var(--app-link)] hover:text-[var(--app-fg)]"
        } transition-colors`}
        title="Change linked issue"
      >
        <PinIcon
          className={
            /* design-tokens-allow: 10px pin-glyph size, between --icon-2xs (8px) and --icon-xs (12px), no exact token (L8 #3410) */ "h-[10px] w-[10px]"
          }
        />
      </button>

      {/* Issue link - opens info modal, or falls back to GitHub */}
      {onOpenInfo ? (
        <button /* design-tokens-allow: bare-inline issue-link (no box, truncating #num+title); Button chrome breaks the dense header badge-row link (L2 bare-inline precedent #3404); L8 #3410 */
          type="button"
          onClick={onOpenInfo}
          className={`flex items-center gap-1 ${
            issue.state === "closed"
              ? "text-purple-400 hover:text-[var(--app-fg)]"
              : "text-[var(--app-link)] hover:text-[var(--app-fg)]"
          } transition-colors min-w-0 text-left`}
          title={`View #${issue.number}: ${issue.title}`}
        >
          <span className="font-medium shrink-0">#{issue.number}</span>
          <span className="truncate">{issue.title}</span>
        </button>
      ) : (
        <a
          href={issue.url}
          target="_blank"
          rel="noopener noreferrer"
          className={`flex items-center gap-1 ${
            issue.state === "closed"
              ? "text-purple-400 hover:text-[var(--app-fg)]"
              : "text-[var(--app-link)] hover:text-[var(--app-fg)]"
          } transition-colors min-w-0`}
          title={`Open #${issue.number}: ${issue.title} on GitHub`}
        >
          <span className="font-medium shrink-0">#{issue.number}</span>
          <span className="truncate">{issue.title}</span>
        </a>
      )}

      {/* Clear button */}
      <button /* design-tokens-allow: sub-24px (10×10px) clear-icon control — a Button box + focus-ring is inappropriate at this size (D2 sub-24px precedent #3358); L8 #3410 */
        type="button"
        onClick={onClear}
        className="text-[var(--app-hint)] hover:text-[var(--app-badge-error-text)] transition-colors ml-0.5"
        title="Remove linked issue"
      >
        <XIcon className="h-2.5 w-2.5" />
      </button>
    </span>
  );
}
