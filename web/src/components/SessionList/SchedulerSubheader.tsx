// SPDX-License-Identifier: AGPL-3.0-only
// Scheduler subheader (collapsible group header for scheduled tasks).
// Extracted from SessionList.tsx (issue #2083, epic #2077 F).
// #3484: the header bar is the shared SubheadingBar — the same uniform anatomy
// as every other session-group subheading (label left, chevron far right on the
// session rows' chevron column, ~50% taller with centered text). It has no
// session-status cluster (it groups schedulers, not sessions), so the label
// starts at the far left.
import { CalendarClockIcon } from "@/components/icons";
import { SubheadingBar } from "./SubheadingBar";

// ── Scheduler Subheader ─────────────────────────────────────────────────

export function SchedulerSubheader(props: {
  groupKey: string;
  totalCount: number;
  enabledCount: number;
  isCollapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const { totalCount, enabledCount, isCollapsed, onToggle, children } = props;

  // #2479 (Task 14): the scheduler subheader uses THREE distinct blue shades
  // (blue-800 rail, blue-950 fill, blue-300 text) that do NOT reduce to the single
  // --session-rel-schedule hue (#60a5fa === blue-400) without a visual change. They
  // are intentionally left Tailwind-native (documented remainder); "no visual
  // change" is the Task-14 acceptance bar. The token is applied to the matching
  // blue-400 family in ScheduleListEntry.tsx.
  return (
    <div className="border-l-4 border-l-blue-800 [&_.session-list-item]:border-l-0">
      <SubheadingBar
        collapsed={isCollapsed}
        onToggle={onToggle}
        icon={<CalendarClockIcon className="h-3 w-3 shrink-0 opacity-80" />}
        label="Schedulers"
        count={`${totalCount} scheduler${totalCount !== 1 ? "s" : ""} · ${enabledCount} enabled`}
        // Tint only (layout is owned by SubheadingBar): the #2479 Task-14
        // blue-950 fill / blue-300 text remainder, unchanged.
        className="bg-blue-950/20 text-blue-300 hover:bg-blue-950/30"
      />
      {!isCollapsed && (
        <div className="divide-y divide-[var(--app-divider)]">{children}</div>
      )}
    </div>
  );
}
