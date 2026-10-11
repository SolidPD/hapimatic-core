// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useMemo, useCallback } from "react";
import type {
  TimeLogWeeklySummary,
  TimeLogEntry,
  TimeLogProjectGroupedSummary,
} from "@/types/api";
import { formatDurationShort } from "@/utils/easternTime";

// ─── Shared Utilities ────────────────────────────────────────────

function formatDayName(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString("en-US", { weekday: "short" });
}

function formatMonthDay(dateStr: string): string {
  const [, month, day] = dateStr.split("-");
  return `${parseInt(month, 10)}/${parseInt(day, 10)}`;
}

const PROJECT_COLORS = [
  "#5ae6ab", // mint green (primary)
  "#6bb3f0", // sky blue
  "#f0b86b", // amber
  "#e06b9b", // rose
  "#a06bf0", // purple
  "#6bf0d9", // cyan
  "#f06b6b", // coral
  "#b8f06b", // lime
];

function getProjectColor(projectIndex: number): string {
  return PROJECT_COLORS[projectIndex % PROJECT_COLORS.length];
}

function formatDateISO(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function hapiShortId(sessionId: string): string {
  return `hapi-${sessionId.slice(0, 8)}`;
}

// ─── Icons ───────────────────────────────────────────────────────

function ChevronLeftIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

// ─── Shared: ProjectAccordion ────────────────────────────────────

function TrashIcon(props: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

interface ProjectAccordionProps {
  projects: TimeLogProjectGroupedSummary["projects"];
  totalMs: number;
  /**
   * Optional callback when the user activates the delete button on a session row.
   * Receives the timelog entry's primary key (`entry.id`), NOT the sessionId.
   */
  onDeleteSession?: (entryId: string) => void;
  /**
   * Resolves a sessionId to the corresponding timelog entry's primary key.
   * Returning `undefined` or an id starting with `"live-"` suppresses the delete button.
   */
  resolveEntryId?: (sessionId: string) => string | undefined;
}

export function ProjectAccordion({
  projects,
  totalMs,
  onDeleteSession,
  resolveEntryId,
}: ProjectAccordionProps) {
  const [expandedProject, setExpandedProject] = useState<string | null>(null);

  if (projects.length === 0) return null;

  return (
    <div className="space-y-1">
      {projects.map((project, index) => {
        const percent = totalMs > 0 ? (project.totalMs / totalMs) * 100 : 0;
        const isExpanded = expandedProject === project.projectIdentity;

        return (
          <div key={project.projectIdentity}>
            <button
              type="button"
              onClick={() =>
                setExpandedProject(isExpanded ? null : project.projectIdentity)
              }
              className="w-full text-left"
            >
              <div className="flex items-center gap-2 py-1.5">
                <div
                  className="w-2.5 h-2.5 rounded-sm shrink-0"
                  style={{ backgroundColor: getProjectColor(index) }}
                />
                <span className="text-xs text-[var(--app-fg)] truncate flex-1">
                  {project.displayName}
                </span>
                <span className="text-xs text-[var(--app-hint)] tabular-nums whitespace-nowrap">
                  {formatDurationShort(project.totalMs)}
                  {totalMs > 0 && ` (${percent.toFixed(0)}%)`}
                </span>
                <ChevronDownIcon
                  className={`shrink-0 text-[var(--app-hint)] transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                />
              </div>
              <div className="h-1.5 bg-[var(--app-secondary-bg)] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500 ease-out"
                  style={{
                    width: `${Math.max(percent, 1)}%`,
                    backgroundColor: getProjectColor(index),
                  }}
                />
              </div>
            </button>

            {isExpanded && (
              <div className="ml-5 mt-1 mb-2 space-y-1 border-l-2 border-[var(--app-border)] pl-3">
                {project.sessions.map(session => {
                  const entryId = resolveEntryId?.(session.sessionId);
                  const canDelete =
                    Boolean(onDeleteSession) &&
                    typeof entryId === "string" &&
                    !entryId.startsWith("live-");
                  return (
                    <div
                      key={session.sessionId}
                      className="flex items-center justify-between py-1 gap-2"
                    >
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        <span className="text-xs text-[var(--app-fg)] truncate">
                          {session.sessionName}
                        </span>
                        <span className="text-[10px] text-[var(--app-hint)] opacity-60 shrink-0 font-mono">
                          {hapiShortId(session.sessionId)}
                        </span>
                      </div>
                      <span className="text-xs text-[var(--app-hint)] tabular-nums whitespace-nowrap">
                        {formatDurationShort(session.totalMs)}
                      </span>
                      {canDelete ? (
                        <button
                          type="button"
                          onClick={() => onDeleteSession?.(entryId as string)}
                          className="p-1 rounded text-[var(--app-hint)] hover:text-[var(--app-badge-error-text)] hover:bg-[var(--app-secondary-bg)] transition-colors shrink-0"
                          title="Delete entry"
                          aria-label={`Delete ${session.sessionName}`}
                        >
                          <TrashIcon />
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── DayView ─────────────────────────────────────────────────────

interface DayViewProps {
  summary: TimeLogProjectGroupedSummary | null;
  isLoading: boolean;
  dateLabel: string;
}

export function DayView({ summary, isLoading, dateLabel }: DayViewProps) {
  if (isLoading) {
    return (
      <div className="py-6 text-center text-[var(--app-hint)]">
        <div className="animate-spin w-5 h-5 border-2 border-[var(--brand-accent)] border-t-transparent rounded-full mx-auto mb-2" />
        Loading...
      </div>
    );
  }

  if (!summary || summary.projects.length === 0) {
    return (
      <div className="py-6 text-center text-[var(--app-hint)] text-sm">
        No time logged for {dateLabel}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <span className="text-xs font-medium text-[var(--app-hint)] uppercase tracking-wide">
          By Project
        </span>
        <span className="text-sm font-semibold text-[var(--app-fg)] tabular-nums">
          {formatDurationShort(summary.totalMs)}
        </span>
      </div>
      <ProjectAccordion projects={summary.projects} totalMs={summary.totalMs} />
    </div>
  );
}

// ─── WeekView ────────────────────────────────────────────────────

function getActualCurrentMonday(): string {
  const now = new Date();
  const todayET = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  const [year, month, day] = todayET.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const dayOfWeek = date.getDay();
  const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  date.setDate(date.getDate() - daysToSubtract);

  return formatDateISO(date);
}

function WeekPicker({
  weekStart,
  weekNumber,
  onWeekChange,
  isOpen,
  onToggle,
}: {
  weekStart: string;
  weekNumber: number;
  onWeekChange: (newWeekStart: string) => void;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const actualCurrentMonday = useMemo(() => getActualCurrentMonday(), []);

  const weeks = useMemo(() => {
    const result: Array<{
      start: string;
      end: string;
      weekNum: number;
      label: string;
    }> = [];

    const [year, month, day] = actualCurrentMonday.split("-").map(Number);
    const currentMonday = new Date(year, month - 1, day);

    for (let i = 0; i < 13; i++) {
      const monday = new Date(currentMonday);
      monday.setDate(monday.getDate() - i * 7);

      const sunday = new Date(monday);
      sunday.setDate(sunday.getDate() + 6);

      const startStr = formatDateISO(monday);
      const endStr = formatDateISO(sunday);

      const dayNum = monday.getDay() || 7;
      const thursday = new Date(monday);
      thursday.setDate(monday.getDate() + 4 - dayNum);
      const yearStart = new Date(thursday.getFullYear(), 0, 1);
      const weekNum = Math.ceil(
        ((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7
      );

      const label =
        i === 0
          ? "This Week"
          : i === 1
            ? "Last Week"
            : `${monday.toLocaleDateString("en-US", { month: "short", day: "numeric" })} - ${sunday.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

      result.push({ start: startStr, end: endStr, weekNum, label });
    }

    return result;
  }, [actualCurrentMonday]);

  const currentWeek = weeks.find(w => w.start === weekStart);
  const isActualCurrentWeek = weekStart === actualCurrentMonday;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1.5 text-xs font-medium text-[var(--app-hint)] uppercase tracking-wide hover:text-[var(--app-fg)] transition-colors cursor-pointer"
      >
        <span>Week {weekNumber}</span>
        <span className="normal-case tracking-normal">·</span>
        <span className="normal-case tracking-normal font-normal">
          {isActualCurrentWeek ? "This Week" : currentWeek?.label}
        </span>
        <CalendarIcon className="ml-1" />
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full mt-1 w-56 bg-[var(--app-bg)] border border-[var(--app-border)] rounded-lg shadow-lg z-50 max-h-64 overflow-y-auto">
          {weeks.map((week, i) => (
            <button
              key={week.start}
              type="button"
              onClick={() => {
                onWeekChange(week.start);
                onToggle();
              }}
              className={`w-full px-3 py-2 text-sm text-left transition-colors flex justify-between items-center ${
                week.start === weekStart
                  ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                  : "text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
              } ${i > 0 ? "border-t border-[var(--app-border)]" : ""}`}
            >
              <span>{week.label}</span>
              <span className="text-xs text-[var(--app-hint)]">
                W{week.weekNum}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface WeekViewProps {
  weeklySummary: TimeLogWeeklySummary | null;
  weekEntries: TimeLogEntry[];
  projectSummary: TimeLogProjectGroupedSummary | null;
  isLoading: boolean;
  weekNumber: number;
  weekStart: string;
  onWeekChange: (newWeekStart: string) => void;
  onDayClick?: (date: string) => void;
}

export function WeekView({
  weeklySummary,
  weekEntries,
  projectSummary,
  isLoading,
  weekNumber,
  weekStart,
  onWeekChange,
  onDayClick,
}: WeekViewProps) {
  const [isWeekPickerOpen, setIsWeekPickerOpen] = useState(false);

  // Build directory→identity mapping from the project-grouped summary
  // so the stacked bar chart groups by identity, not raw path
  const dirToIdentity = useMemo(() => {
    const map = new Map<string, string>();
    if (!projectSummary) return map;
    for (const p of projectSummary.projects) {
      // Map the representative directory
      map.set(p.projectDirectory, p.projectIdentity);
    }
    return map;
  }, [projectSummary]);

  // Resolve a raw entry's projectDirectory to its project identity.
  // Intentionally mutates dirToIdentity as a runtime cache — the Map is
  // recreated when projectSummary changes, so stale entries are discarded.
  const resolveIdentity = useCallback(
    (dir: string): string => {
      // Direct match from summary
      const cached = dirToIdentity.get(dir);
      if (cached) return cached;

      // For worktree paths not in the summary, extract the base project
      // directory and check if that matches a known project
      const worktreeIdx = dir.indexOf("/.worktrees/");
      if (worktreeIdx !== -1) {
        const basePath = dir.slice(0, worktreeIdx);
        const baseIdentity = dirToIdentity.get(basePath);
        if (baseIdentity) {
          dirToIdentity.set(dir, baseIdentity);
          return baseIdentity;
        }
      }

      // Final fallback: use last path segment
      const parts = dir.split(/[\\/]+/).filter(Boolean);
      const fallback = parts[parts.length - 1] || dir;
      dirToIdentity.set(dir, fallback);
      return fallback;
    },
    [dirToIdentity]
  );

  // Project list ordered by total time (from the server-resolved summary)
  const projectList = useMemo(() => {
    if (projectSummary && projectSummary.projects.length > 0) {
      return projectSummary.projects.map(p => ({
        identity: p.projectIdentity,
        displayName: p.displayName,
      }));
    }
    // Fallback: derive from raw entries (shouldn't happen when summary is loaded)
    const projectTotals = new Map<string, number>();
    for (const entry of weekEntries) {
      const id = resolveIdentity(entry.projectDirectory);
      const current = projectTotals.get(id) ?? 0;
      projectTotals.set(id, current + entry.durationMs);
    }
    return Array.from(projectTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([identity]) => {
        const parts = identity.split("/");
        return {
          identity,
          displayName: parts[parts.length - 1] || identity,
        };
      });
  }, [projectSummary, weekEntries, resolveIdentity]);

  const dailyProjectBreakdown = useMemo(() => {
    const breakdown = new Map<string, Map<string, number>>();
    for (const entry of weekEntries) {
      if (!breakdown.has(entry.date)) {
        breakdown.set(entry.date, new Map());
      }
      const dayMap = breakdown.get(entry.date)!;
      const identity = resolveIdentity(entry.projectDirectory);
      const current = dayMap.get(identity) ?? 0;
      dayMap.set(identity, current + entry.durationMs);
    }
    return breakdown;
  }, [weekEntries, resolveIdentity]);

  if (isLoading) {
    return (
      <div className="py-6 text-center text-[var(--app-hint)]">
        <div className="animate-spin w-5 h-5 border-2 border-[var(--brand-accent)] border-t-transparent rounded-full mx-auto mb-2" />
        Loading...
      </div>
    );
  }

  const maxMs =
    weeklySummary && weeklySummary.dailyTotals.length > 0
      ? Math.max(...weeklySummary.dailyTotals.map(d => d.totalMs), 1)
      : 1;

  return (
    <div className="space-y-3">
      {/* Week header */}
      <div className="flex justify-between items-center">
        <WeekPicker
          weekStart={weekStart}
          weekNumber={weekNumber}
          onWeekChange={onWeekChange}
          isOpen={isWeekPickerOpen}
          onToggle={() => setIsWeekPickerOpen(!isWeekPickerOpen)}
        />
        <span className="text-sm font-semibold text-[var(--app-fg)] tabular-nums">
          {weeklySummary ? formatDurationShort(weeklySummary.totalMs) : "0m"}
        </span>
      </div>

      {/* Week navigation arrows */}
      <div className="flex justify-between items-center">
        <button
          type="button"
          onClick={() => {
            const [y, m, d] = weekStart.split("-").map(Number);
            const prevMonday = new Date(y, m - 1, d - 7);
            onWeekChange(formatDateISO(prevMonday));
          }}
          className="p-1 rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors"
          title="Previous week"
        >
          <ChevronLeftIcon />
        </button>
        <button
          type="button"
          onClick={() => {
            const [y, m, d] = weekStart.split("-").map(Number);
            const nextMonday = new Date(y, m - 1, d + 7);
            onWeekChange(formatDateISO(nextMonday));
          }}
          className="p-1 rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors"
          title="Next week"
        >
          <ChevronRightIcon />
        </button>
      </div>

      {/* Daily stacked bar chart */}
      {weeklySummary && weeklySummary.dailyTotals.length > 0 ? (
        <div className="space-y-1.5">
          {weeklySummary.dailyTotals.map(day => {
            const dayBreakdown = dailyProjectBreakdown.get(day.date);
            const percent = (day.totalMs / maxMs) * 100;

            return (
              <button
                key={day.date}
                type="button"
                className="w-full flex items-center gap-2 group"
                onClick={() => onDayClick?.(day.date)}
                title={`View ${day.date}`}
              >
                <span className="w-[4.5rem] text-xs text-[var(--app-hint)] flex group-hover:text-[var(--app-fg)] transition-colors">
                  <span className="w-8">{formatDayName(day.date)}</span>
                  <span className="tabular-nums text-left">
                    {formatMonthDay(day.date)}
                  </span>
                </span>
                <div className="flex-1 h-5 bg-[var(--app-secondary-bg)] rounded overflow-hidden flex">
                  {dayBreakdown && projectList.length > 0 ? (
                    projectList.map((project, projectIndex) => {
                      const projectMs = dayBreakdown.get(project.identity) ?? 0;
                      if (projectMs === 0) return null;
                      const projectPercent = (projectMs / maxMs) * 100;
                      return (
                        <div
                          key={project.identity}
                          className="h-full transition-all duration-500 ease-out first:rounded-l last:rounded-r"
                          style={{
                            width: `${Math.max(projectPercent, 0.5)}%`,
                            backgroundColor: getProjectColor(projectIndex),
                          }}
                          title={`${project.displayName}: ${formatDurationShort(projectMs)}`}
                        />
                      );
                    })
                  ) : (
                    <div
                      className="h-full rounded transition-all duration-500 ease-out"
                      style={{
                        width: `${Math.max(percent, day.totalMs > 0 ? 2 : 0)}%`,
                        backgroundColor: getProjectColor(0),
                      }}
                    />
                  )}
                </div>
                <span className="w-14 text-xs text-[var(--app-fg)] tabular-nums text-right">
                  {day.totalMs > 0 ? formatDurationShort(day.totalMs) : "-"}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="py-4 text-center text-[var(--app-hint)] text-sm">
          No data for this week
        </div>
      )}

      {/* Project color legend */}
      {projectList.length > 1 && (
        <div className="pt-2 border-t border-[var(--app-border)]">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {projectList.map((project, index) => (
              <div key={project.identity} className="flex items-center gap-1.5">
                <div
                  className="w-2.5 h-2.5 rounded-sm"
                  style={{ backgroundColor: getProjectColor(index) }}
                />
                <span className="text-xs text-[var(--app-hint)] truncate max-w-[100px]">
                  {project.displayName}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Project drill-down accordion */}
      {projectSummary && projectSummary.projects.length > 0 && (
        <div className="pt-3 border-t border-[var(--app-border)]">
          <div className="text-xs font-medium text-[var(--app-hint)] uppercase tracking-wide mb-2">
            By Project
          </div>
          <ProjectAccordion
            projects={projectSummary.projects}
            totalMs={projectSummary.totalMs}
          />
        </div>
      )}
    </div>
  );
}

// ─── MonthView ───────────────────────────────────────────────────

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const MONTH_NAMES_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function getMonthBounds(
  year: number,
  month: number
): { startDate: string; endDate: string } {
  const lastDay = new Date(year, month, 0).getDate();
  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const endDate = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { startDate, endDate };
}

interface MonthViewProps {
  summary: TimeLogProjectGroupedSummary | null;
  isLoading: boolean;
  year: number;
  month: number;
  onMonthChange: (year: number, month: number) => void;
}

export function MonthView({
  summary,
  isLoading,
  year,
  month,
  onMonthChange,
}: MonthViewProps) {
  const prevMonth = () => {
    if (month === 1) {
      onMonthChange(year - 1, 12);
    } else {
      onMonthChange(year, month - 1);
    }
  };

  const nextMonth = () => {
    if (month === 12) {
      onMonthChange(year + 1, 1);
    } else {
      onMonthChange(year, month + 1);
    }
  };

  // Determine if this is the current month
  const now = new Date();
  const nowET = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
  }).format(now);
  const [currentYear, currentMonth] = nowET.split("-").map(Number);
  const isCurrentMonth = year === currentYear && month === currentMonth;

  return (
    <div className="space-y-3">
      {/* Month header with navigation */}
      <div className="flex justify-between items-center">
        <button
          type="button"
          onClick={prevMonth}
          className="p-1 rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors"
          title="Previous month"
        >
          <ChevronLeftIcon />
        </button>
        <span className="text-xs font-medium text-[var(--app-hint)] uppercase tracking-wide">
          {isCurrentMonth
            ? "This Month"
            : `${MONTH_NAMES_SHORT[month - 1]} ${year}`}
          {" · "}
          <span className="normal-case tracking-normal font-normal">
            {MONTH_NAMES[month - 1]} {year}
          </span>
        </span>
        <button
          type="button"
          onClick={nextMonth}
          className="p-1 rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors"
          title="Next month"
        >
          <ChevronRightIcon />
        </button>
      </div>

      {/* Total */}
      {summary && summary.totalMs > 0 && (
        <div className="text-right">
          <span className="text-sm font-semibold text-[var(--app-fg)] tabular-nums">
            {formatDurationShort(summary.totalMs)}
          </span>
        </div>
      )}

      {/* Content */}
      {isLoading ? (
        <div className="py-6 text-center text-[var(--app-hint)]">
          <div className="animate-spin w-5 h-5 border-2 border-[var(--brand-accent)] border-t-transparent rounded-full mx-auto mb-2" />
          Loading...
        </div>
      ) : !summary || summary.projects.length === 0 ? (
        <div className="py-6 text-center text-[var(--app-hint)] text-sm">
          No time logged for {MONTH_NAMES[month - 1]} {year}
        </div>
      ) : (
        <div>
          <div className="text-xs font-medium text-[var(--app-hint)] uppercase tracking-wide mb-2">
            By Project
          </div>
          <ProjectAccordion
            projects={summary.projects}
            totalMs={summary.totalMs}
          />
        </div>
      )}
    </div>
  );
}

// Re-export for backward compatibility (used by existing WeekView data flow)
export { getMonthBounds };
