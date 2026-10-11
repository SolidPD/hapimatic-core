// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";

type IconProps = {
  className?: string;
};

function createIcon(paths: ReactNode, props: IconProps, strokeWidth = 1.5) {
  return (
    <svg
      className={props.className ?? "h-4 w-4"}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths}
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return createIcon(<path d="M6 18 18 6M6 6l12 12" />, props, 2);
}

// Issue #87: per-session notification mute toggle icons.
export function BellIcon(props: IconProps) {
  return createIcon(
    <>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </>,
    props
  );
}

export function BellOffIcon(props: IconProps) {
  return createIcon(
    <>
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      <path d="M18.63 13A17.89 17.89 0 0 1 18 8" />
      <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
      <path d="M18 8a6 6 0 0 0-9.33-5" />
      <path d="M1 1l22 22" />
    </>,
    props
  );
}

export function ShareIcon(props: IconProps) {
  return createIcon(
    <path d="M9 8.25H7.5a2.25 2.25 0 0 0-2.25 2.25v9a2.25 2.25 0 0 0 2.25 2.25h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25H15m0-3-3-3m0 0-3 3m3-3v12" />,
    props
  );
}

export function PlusCircleIcon(props: IconProps) {
  return createIcon(
    <path d="M12 9v6m3-3H9m12 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />,
    props
  );
}

export function CopyIcon(props: IconProps) {
  return createIcon(
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>,
    props,
    2
  );
}

export function CheckIcon(props: IconProps) {
  return createIcon(<polyline points="20 6 9 17 4 12" />, props, 2);
}

export function RotateCcwIcon(props: IconProps) {
  return createIcon(
    <>
      <path d="M3 2v6h6" />
      <path d="M3 13a9 9 0 1 0 3-7.7L3 8" />
    </>,
    props
  );
}

export function GitBranchIcon(props: IconProps) {
  return createIcon(
    <>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </>,
    props,
    2
  );
}

/** Conversation branching icon — a straight trunk with one offshoot.
 *  Looks like a main line continuing upward with a branch splitting off
 *  to the right. Distinct from GitBranchIcon and symmetric Y shapes. */
export function BranchIcon(props: IconProps) {
  return createIcon(
    <>
      {/* Straight trunk from bottom to top */}
      <path d="M9 21V3" />
      {/* Offshoot branching to the right */}
      <path d="M9 10l8-6" />
    </>,
    props,
    2
  );
}

export function TerminalIcon(props: IconProps) {
  return createIcon(
    <>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </>,
    props,
    2
  );
}

// Issue #3286 (View Picker): the app's prompt-header terminal glyph (`>` +
// baseline) rendered INSIDE a monitor <rect> box — "a terminal on a monitor."
// Used only by the Terminal tab in ViewPicker; the bare TerminalIcon above stays
// the composer/prompt-header glyph. Geometry from the E6 operator mockup.
export function TerminalMonitorIcon(props: IconProps) {
  return createIcon(
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <polyline points="6 10 9 13 6 16" />
      <line x1="12" y1="16" x2="17" y2="16" />
    </>,
    props,
    2
  );
}

export function FolderIcon(props: IconProps) {
  return createIcon(
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
    props,
    2
  );
}

export function TreeIcon(props: IconProps) {
  return createIcon(
    <>
      <path d="M12 2v20" />
      <path d="M12 6l-4 4" />
      <path d="M12 6l4 4" />
      <path d="M12 12l-6 5" />
      <path d="M12 12l6 5" />
    </>,
    props,
    2
  );
}

export function SparkleIcon(props: IconProps) {
  return createIcon(
    <>
      <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
      <path d="M19 15l.75 2.25L22 18l-2.25.75L19 21l-.75-2.25L16 18l2.25-.75L19 15z" />
    </>,
    props,
    2
  );
}

export function ChevronUpIcon(props: IconProps) {
  return createIcon(<polyline points="18 15 12 9 6 15" />, props, 2);
}

export function ChevronDownIcon(props: IconProps) {
  return createIcon(<polyline points="6 9 12 15 18 9" />, props, 2);
}

export function ChevronsUpIcon(props: IconProps) {
  return createIcon(
    <>
      <polyline points="17 11 12 6 7 11" />
      <polyline points="17 18 12 13 7 18" />
    </>,
    props,
    2
  );
}

export function ChevronsDownIcon(props: IconProps) {
  return createIcon(
    <>
      <polyline points="7 13 12 18 17 13" />
      <polyline points="7 6 12 11 17 6" />
    </>,
    props,
    2
  );
}

export function MessageSquareIcon(props: IconProps) {
  return createIcon(
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
    props,
    2
  );
}

export function TrashIcon(props: IconProps) {
  return createIcon(
    <>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </>,
    props,
    2
  );
}

export function PlusIcon(props: IconProps) {
  return createIcon(
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>,
    props,
    2
  );
}

export function BackIcon(props: IconProps) {
  return createIcon(<polyline points="15 18 9 12 15 6" />, props, 2);
}

export function InfoIcon(props: IconProps) {
  return createIcon(
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </>,
    props,
    2
  );
}

/**
 * Bookmark glyph for the Create-Session per-field defaults feature. Outline
 * when disengaged; `filled` renders a solid glyph (the caller supplies the
 * muted-yellow color via className `text-*`).
 */
export function BookmarkIcon(props: IconProps & { filled?: boolean }) {
  return (
    <svg
      className={props.className ?? "h-4 w-4"}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill={props.filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function PencilIcon(props: IconProps) {
  return createIcon(
    <>
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </>,
    props,
    2
  );
}

export function BulbIcon(props: IconProps) {
  return createIcon(
    <>
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12c.6.6 1 1.2 1 2h6c0-.8.4-1.4 1-2a7 7 0 0 0-4-12Z" />
    </>,
    props,
    2
  );
}

export function FilesIcon(props: IconProps) {
  return createIcon(
    <>
      <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </>,
    props,
    2
  );
}

// Web-based desktop mode toggle (issue #2693) — a monitor glyph.
export function DesktopIcon(props: IconProps) {
  return createIcon(
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
    </>,
    props,
    2
  );
}

export function GitHubIcon(props: IconProps) {
  return (
    <svg
      className={props.className ?? "h-4 w-4"}
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

export function MoreVerticalIcon(props: IconProps) {
  return (
    <svg
      className={props.className ?? "h-4 w-4"}
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <circle cx="12" cy="5" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="12" cy="19" r="2" />
    </svg>
  );
}

export function ChainIcon(props: IconProps & { connected?: boolean }) {
  return (
    <svg
      className={props.className ?? "h-4 w-4"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {props.connected ? (
        <>
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </>
      ) : (
        <>
          <path d="M18.84 12.25l1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71" />
          <path d="M5.17 11.75l-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71" />
          <line x1="8" y1="8" x2="16" y2="16" />
        </>
      )}
    </svg>
  );
}

export function QuestionMarkIcon(props: IconProps) {
  return createIcon(
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </>,
    props,
    2
  );
}

export function InboxIcon(props: IconProps) {
  return createIcon(
    <>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>,
    props,
    2
  );
}

export function ChevronIcon(props: IconProps & { collapsed?: boolean }) {
  return (
    <svg
      className={`${props.className ?? ""} transition-transform duration-200 ${props.collapsed ? "" : "rotate-90"}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

export function RobotIcon(props: IconProps) {
  return createIcon(
    <>
      <rect x="5" y="8" width="14" height="11" rx="2.5" />
      <path d="M12 8V5M12 3.5a1.2 1.2 0 1 0 0 .01M9 13h.01M15 13h.01M9.5 16.5h5M3 12v3M21 12v3" />
    </>,
    props
  );
}

export function MonitorIcon(props: IconProps) {
  return createIcon(
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </>,
    props
  );
}

export function SplitScreenIcon(props: IconProps) {
  return createIcon(
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M12 3v18" />
    </>,
    props
  );
}

export function BriefcaseIcon(props: IconProps) {
  return createIcon(
    <>
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
    </>,
    props
  );
}

export function SearchIcon(props: IconProps) {
  return createIcon(
    <>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>,
    props
  );
}

export function FilterIcon(props: IconProps) {
  return createIcon(
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />,
    props
  );
}

export function SortIcon(props: IconProps) {
  return createIcon(
    <>
      <path d="M11 5h10" />
      <path d="M11 9h7" />
      <path d="M11 13h4" />
      <path d="M3 17l3 3 3-3" />
      <path d="M6 18V4" />
    </>,
    props
  );
}

// Select Mode toggle (#3292, epic #3285 S7): a COMPLETE dashed square with a
// filled mouse-pointer at the bottom-right — the Lucide square-dashed-mouse-pointer
// with its missing lower-right corner filled in (taxonomy: "Select Button").
export function SelectIcon(props: IconProps) {
  return createIcon(
    <>
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="2.5"
        strokeDasharray="2.8 2.8"
      />
      <path
        d="M11 11 l9.4 3.25 -3.75 1.35 -1.35 3.75 z"
        fill="currentColor"
        strokeWidth="1.2"
      />
    </>,
    props,
    1.7
  );
}

// ── Schedule-related icons (extracted from SchedulesPage) ─────────────

export function CalendarClockIcon(props: IconProps) {
  return (
    <svg
      className={props.className ?? "h-4 w-4"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5" />
      <path d="M16 2v4" />
      <path d="M8 2v4" />
      <path d="M3 10h5" />
      <path d="M17.5 17.5 16 16.3V14" />
      <circle cx="16" cy="16" r="6" />
    </svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <svg
      className={props.className ?? "h-4 w-4"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  );
}

export function PowerIcon(props: IconProps) {
  return (
    <svg
      className={props.className ?? "h-4 w-4"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2v10" />
      <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
    </svg>
  );
}

export function HistoryIcon(props: IconProps) {
  return (
    <svg
      className={props.className ?? "h-4 w-4"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

export function StopwatchIcon(props: IconProps) {
  return createIcon(
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2 2" />
      <path d="M10 2h4" />
      <path d="M12 2v3" />
      <path d="m17.4 5.6.7-.7" />
    </>,
    props,
    2
  );
}

export function LayersIcon(props: IconProps) {
  return (
    <svg
      className={props.className ?? "h-4 w-4"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <path d="m22.54 12.43-1.96-.89L12 15.8l-8.58-4.26-1.96.89a1 1 0 0 0 0 1.83l8.58 3.9a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 .26-1.83Z" />
    </svg>
  );
}

/**
 * Paperclip glyph shared by the prompt composer and the notes field (#1075).
 * Fixed 16px geometry + 2.5 stroke (not createIcon's 24px/class sizing) so the
 * two attachment buttons stay pixel-identical. Lives here rather than in
 * ComposerButtons so SessionNotes does not import the composer component
 * module (that import edge froze ComposerButtons' @hapi/protocol binding
 * before its test's per-file mock could register under isolate:false).
 */
export function PaperclipIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
