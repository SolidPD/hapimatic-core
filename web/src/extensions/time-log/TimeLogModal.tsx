// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type {
  TimeLogEntry,
  TimeLogProjectGroupedSummary,
  TimeLogWeeklySummary,
  DerivedDailyBucket,
} from "@/types/api";
import {
  useTimeLogs,
  useTimeLogProjectGrouped,
  useTimeLogWeeklySummary,
  useTimelogCutoverStatus,
  useDerivedTimeLog,
} from "./hooks/useTimeLogs";
import { queryKeys } from "@/lib/query-keys";
import { getEasternTimeDate, formatDurationShort } from "@/utils/easternTime";
import { exportToCSV, exportDerivedToCSV, exportToJSON } from "./timeLogExport";
import { generateExportFilename } from "@/utils/timeLogExport";
import {
  ProjectAccordion,
  WeekView,
  MonthView,
  getMonthBounds,
} from "./TimeLogCharts";
import { useToast } from "@/components/Toast";
import { BareButton } from "@/components/ui/BareButton";

// ─── Types ───────────────────────────────────────────────────────

type ViewTab = "day" | "week" | "month";

interface TimeLogModalBodyProps {
  api: ApiClient | null;
}

// ─── Utility Functions ───────────────────────────────────────────

function formatDateDisplay(dateStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getWeekStartDate(): string {
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

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getWeekNumber(dateStr: string): number {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const dayNum = date.getDay() || 7;
  date.setDate(date.getDate() + 4 - dayNum);
  const yearStart = new Date(date.getFullYear(), 0, 1);
  const weekNo = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7
  );
  return weekNo;
}

function getCurrentETMonthYear(): { year: number; month: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
  }).format(now);
  const [year, month] = parts.split("-").map(Number);
  return { year, month };
}

// ─── Icons ───────────────────────────────────────────────────────

function ClockLogIcon(props: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function DownloadIcon(props: { className?: string }) {
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
      className={props.className}
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

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

// ─── Export Menu ──────────────────────────────────────────────────

function ExportMenu({
  entries,
  onExport,
}: {
  entries: TimeLogEntry[];
  onExport: (format: "csv" | "json") => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const handleExport = (format: "csv" | "json") => {
    onExport(format);
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={menuRef}>
      <BareButton
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        disabled={entries.length === 0}
        className={`px-2 py-1.5 text-xs border rounded-lg flex items-center gap-1 transition-colors ${
          entries.length === 0
            ? "bg-[var(--app-bg)] border-[var(--app-border)] text-[var(--app-hint)] opacity-50 cursor-not-allowed"
            : "bg-[var(--app-bg)] border-[var(--app-border)] text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
        }`}
        title={entries.length === 0 ? "No data to export" : "Export time log"}
      >
        <DownloadIcon className="w-3.5 h-3.5" />
      </BareButton>
      {isOpen && (
        <div className="absolute right-0 mt-1 w-32 bg-[var(--app-bg)] border border-[var(--app-border)] rounded-lg shadow-lg z-50 overflow-hidden">
          <button
            type="button"
            onClick={() => handleExport("csv")}
            className="w-full px-3 py-2 text-sm text-left text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors"
          >
            CSV
          </button>
          <button
            type="button"
            onClick={() => handleExport("json")}
            className="w-full px-3 py-2 text-sm text-left text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors border-t border-[var(--app-border)]"
          >
            JSON
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Session Entry Row (for day detail) ──────────────────────────

// ─── Tab Bar ─────────────────────────────────────────────────────

function ViewTabBar({
  activeTab,
  onTabChange,
}: {
  activeTab: ViewTab;
  onTabChange: (tab: ViewTab) => void;
}) {
  const tabs: Array<{ id: ViewTab; label: string }> = [
    { id: "day", label: "Day" },
    { id: "week", label: "Week" },
    { id: "month", label: "Month" },
  ];

  return (
    <div className="flex bg-[var(--app-secondary-bg)] rounded-lg p-0.5">
      {tabs.map(tab => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onTabChange(tab.id)}
          className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            activeTab === tab.id
              ? "bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm"
              : "text-[var(--app-hint)] hover:text-[var(--app-fg)]"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// ─── Derived week/month grouping (issue #2577) ────────────────────

/** Short display name from a project identity ("owner/repo" → "repo"). */
function basenameIdentity(dir: string): string {
  const slash = dir.lastIndexOf("/");
  return slash >= 0 ? dir.slice(slash + 1) : dir;
}

/**
 * Issue #2577: fold a range of turns-derived daily buckets into the
 * ProjectGrouped shape WeekView/MonthView already consume. Groups the
 * per-session breakdown by `projectDirectory` (which is `turns.repo ?? cwd` —
 * the `owner/repo` git identity, so worktrees collapse at the source), then by
 * session. Setting `projectDirectory === projectIdentity` makes WeekView's
 * `dirToIdentity` map a direct hit, so its (legacy) worktree-strip fallback is
 * never reached on the derived path.
 */
function groupBucketsToProjectSummary(
  buckets: DerivedDailyBucket[],
  startDate: string,
  endDate: string
): TimeLogProjectGroupedSummary {
  const byProject = new Map<
    string,
    {
      totalMs: number;
      sessions: Map<string, { sessionName: string; totalMs: number }>;
    }
  >();
  for (const b of buckets) {
    for (const it of b.breakdown ?? []) {
      const dir = it.projectDirectory || "Unknown";
      let p = byProject.get(dir);
      if (!p) {
        p = { totalMs: 0, sessions: new Map() };
        byProject.set(dir, p);
      }
      p.totalMs += it.ms;
      const s = p.sessions.get(it.sessionId);
      if (s) s.totalMs += it.ms;
      else
        p.sessions.set(it.sessionId, {
          sessionName: it.sessionName,
          totalMs: it.ms,
        });
    }
  }
  const projects = Array.from(byProject.entries())
    .map(([projectDirectory, p]) => ({
      projectDirectory,
      projectIdentity: projectDirectory,
      displayName: basenameIdentity(projectDirectory),
      totalMs: p.totalMs,
      sessions: Array.from(p.sessions.entries())
        .map(([sessionId, s]) => ({
          sessionId,
          sessionName: s.sessionName,
          totalMs: s.totalMs,
        }))
        .sort((a, b) => b.totalMs - a.totalMs),
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
  const totalMs = projects.reduce((sum, p) => sum + p.totalMs, 0);
  return { startDate, endDate, totalMs, projects };
}

// ─── Body (rendered by the modal wrapper AND the time-log drawer section) ───

export function TimeLogModalBody({ api }: TimeLogModalBodyProps) {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  // Issue #1670 (PR-2): dormancy gate. RED (default) → byte-for-byte legacy.
  const { ready: cutoverReady } = useTimelogCutoverStatus(api);

  // View state
  const [activeTab, setActiveTab] = useState<ViewTab>("day");

  // Day view state
  const today = useMemo(() => getEasternTimeDate(), []);
  const [selectedDate, setSelectedDate] = useState(today);

  // Week view state
  const initialWeekStart = useMemo(() => getWeekStartDate(), []);
  const [weekStart, setWeekStart] = useState(initialWeekStart);
  const weekNumber = useMemo(() => getWeekNumber(weekStart), [weekStart]);
  const weekEndDate = useMemo(() => {
    const [y, m, d] = weekStart.split("-").map(Number);
    const sunday = new Date(y, m - 1, d + 6);
    return `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, "0")}-${String(sunday.getDate()).padStart(2, "0")}`;
  }, [weekStart]);

  // Month view state
  const currentETMonth = useMemo(() => getCurrentETMonthYear(), []);
  const [monthYear, setMonthYear] = useState(currentETMonth.year);
  const [monthMonth, setMonthMonth] = useState(currentETMonth.month);
  const monthBounds = useMemo(
    () => getMonthBounds(monthYear, monthMonth),
    [monthYear, monthMonth]
  );

  // ── Data fetching ──

  // Day: project-grouped summary for selected date
  const { summary: dayProjectSummary, isLoading: dayProjectLoading } =
    useTimeLogProjectGrouped(
      api,
      selectedDate,
      selectedDate,
      activeTab === "day"
    );

  // Day: raw entries for export/delete (only when day tab active)
  const dayFilters = useMemo(
    () => ({ startDate: selectedDate, endDate: selectedDate }),
    [selectedDate]
  );
  const {
    entries: dayEntries,
    isLoading: dayEntriesLoading,
    error: dayEntriesError,
    refetch: refetchDayEntries,
  } = useTimeLogs(api, dayFilters, activeTab === "day");

  // Week: weekly summary for stacked bars
  const { summary: weeklySummary, isLoading: weeklyLoading } =
    useTimeLogWeeklySummary(api, weekStart, activeTab === "week");

  // Week: raw entries for stacked color breakdown
  const weekFilters = useMemo(
    () => ({ startDate: weekStart, endDate: weekEndDate }),
    [weekStart, weekEndDate]
  );
  const { entries: weekEntries } = useTimeLogs(
    api,
    weekFilters,
    activeTab === "week"
  );

  // Week: project-grouped summary for drill-down
  const { summary: weekProjectSummary } = useTimeLogProjectGrouped(
    api,
    weekStart,
    weekEndDate,
    activeTab === "week"
  );

  // Month: project-grouped summary
  const { summary: monthProjectSummary, isLoading: monthLoading } =
    useTimeLogProjectGrouped(
      api,
      monthBounds.startDate,
      monthBounds.endDate,
      activeTab === "month"
    );

  // Issue #1670 (PR-2): derived daily buckets for the selected day — fetched
  // ONLY when the cutover gate is green; otherwise the legacy merged totals win.
  const { buckets: derivedDayBuckets } = useDerivedTimeLog(
    api,
    selectedDate,
    selectedDate,
    activeTab === "day" && cutoverReady
  );

  // Issue #2577: derived daily buckets for the week/month ranges — fetched ONLY
  // when the cutover gate is green. When the gate is red the legacy hooks below
  // still feed WeekView/MonthView unchanged (Fallback Preservation Rule; the
  // gate-red render path is byte-identical to before this issue).
  const { buckets: derivedWeekBuckets, isLoading: derivedWeekLoading } =
    useDerivedTimeLog(
      api,
      weekStart,
      weekEndDate,
      activeTab === "week" && cutoverReady
    );
  const { buckets: derivedMonthBuckets, isLoading: derivedMonthLoading } =
    useDerivedTimeLog(
      api,
      monthBounds.startDate,
      monthBounds.endDate,
      activeTab === "month" && cutoverReady
    );

  // Issue #2577: reshape the week's derived buckets into the exact prop shapes
  // WeekView already consumes, so no WeekView change is needed. The stacked-bar
  // 100-entry truncation is gone (server aggregate, no LIMIT) and the worktree
  // identity mismatch is gone (grouped by the repo-collapsed projectDirectory).
  const derivedWeekProjectSummary = useMemo(
    () =>
      derivedWeekBuckets.length > 0
        ? groupBucketsToProjectSummary(
            derivedWeekBuckets,
            weekStart,
            weekEndDate
          )
        : null,
    [derivedWeekBuckets, weekStart, weekEndDate]
  );

  // Full Mon→Sun skeleton (derived buckets omit zero days). Bar heights + the
  // right-side day totals read netMs; segments (below) sum autoMs — on a day
  // with a manual adjustment the small netMs vs autoMs gap is the accepted DD-B
  // tradeoff, identical to the Day tab.
  const derivedWeeklySummary = useMemo<TimeLogWeeklySummary>(() => {
    const byDate = new Map(derivedWeekBuckets.map(b => [b.localDate, b]));
    const [wy, wm, wd] = weekStart.split("-").map(Number);
    const dailyTotals = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(wy, wm - 1, wd + i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const bucket = byDate.get(iso);
      return {
        date: iso,
        totalMs: bucket?.netMs ?? 0,
        sessionCount: bucket?.breakdown?.length ?? 0,
      };
    });
    const totalMs = dailyTotals.reduce((s, d) => s + d.totalMs, 0);
    return { startDate: weekStart, endDate: weekEndDate, totalMs, dailyTotals };
  }, [derivedWeekBuckets, weekStart, weekEndDate]);

  // Synthetic per-(session, day) entries feed WeekView's dailyProjectBreakdown
  // from the server aggregate (no LIMIT 100). projectDirectory is left as the
  // repo-collapsed identity so it direct-hits dirToIdentity.
  const derivedWeekEntries = useMemo<TimeLogEntry[]>(() => {
    const out: TimeLogEntry[] = [];
    for (const b of derivedWeekBuckets) {
      for (const it of b.breakdown ?? []) {
        out.push({
          id: `${b.localDate}:${it.sessionId}`,
          sessionId: it.sessionId,
          sessionName: it.sessionName,
          projectDirectory: it.projectDirectory,
          date: b.localDate,
          durationMs: it.ms,
          createdAt: 0,
          namespace: b.namespace,
        });
      }
    }
    return out;
  }, [derivedWeekBuckets]);

  // Issue #2577: derived month project-grouped summary (MonthView is a dumb
  // renderer of this shape — no MonthView change needed).
  const derivedMonthProjectSummary = useMemo(
    () =>
      derivedMonthBuckets.length > 0
        ? groupBucketsToProjectSummary(
            derivedMonthBuckets,
            monthBounds.startDate,
            monthBounds.endDate
          )
        : null,
    [derivedMonthBuckets, monthBounds.startDate, monthBounds.endDate]
  );

  // Issue #1892 (Sub H2): the legacy live-timer merge (GET /timers) and the
  // free-running client timer surface are deleted. The day breakdown now reads the
  // retained read-only `timelog_entries` archive directly (no live-timer overlay);
  // H1's breathing stepper shows per-session in-flight time in the session
  // list/header. A turns-derived per-session/project breakdown is deferred to a
  // follow-up issue (BD-2 / OR-8) — until then the breakdown is the archive.
  const mergedDayEntries = dayEntries;

  // Issue #1892 Task 3B (BD-2): build the per-session/project breakdown from the
  // turns-derived buckets for the selected day. Groups the flat per-session
  // breakdown by projectDirectory into the ProjectGrouped shape the accordion
  // consumes. Returns null when the day has no turns so the caller falls back to
  // the retained read-only timelog_entries archive (pre-cutover history).
  const derivedBreakdownSummary =
    useMemo<TimeLogProjectGroupedSummary | null>(() => {
      const items = derivedDayBuckets.flatMap(b => b.breakdown ?? []);
      if (items.length === 0) return null;
      const byProject = new Map<
        string,
        {
          totalMs: number;
          sessions: Map<string, { sessionName: string; totalMs: number }>;
        }
      >();
      for (const it of items) {
        const dir = it.projectDirectory || "Unknown";
        let p = byProject.get(dir);
        if (!p) {
          p = { totalMs: 0, sessions: new Map() };
          byProject.set(dir, p);
        }
        p.totalMs += it.ms;
        const s = p.sessions.get(it.sessionId);
        if (s) s.totalMs += it.ms;
        else
          p.sessions.set(it.sessionId, {
            sessionName: it.sessionName,
            totalMs: it.ms,
          });
      }
      const projects = Array.from(byProject.entries())
        .map(([projectDirectory, p]) => ({
          projectDirectory,
          projectIdentity: projectDirectory,
          displayName: projectDirectory,
          totalMs: p.totalMs,
          sessions: Array.from(p.sessions.entries())
            .map(([sessionId, s]) => ({
              sessionId,
              sessionName: s.sessionName,
              totalMs: s.totalMs,
            }))
            .sort((a, b) => b.totalMs - a.totalMs),
        }))
        .sort((a, b) => b.totalMs - a.totalMs);
      const totalMs = projects.reduce((sum, p) => sum + p.totalMs, 0);
      return {
        startDate: selectedDate,
        endDate: selectedDate,
        totalMs,
        projects,
      };
    }, [derivedDayBuckets, selectedDate]);

  // Prefer the turns-derived breakdown; fall back to the read-only archive for
  // pre-turns days (breakdown empty) or when the cutover gate is not green.
  const mergedDayProjectSummary =
    derivedBreakdownSummary ?? dayProjectSummary ?? null;

  // Issue #1670 (PR-2): the headline Daily Total comes from the derived read path
  // (R2 / netMs). The breakdown above is the turns-derived per-session split (Task
  // 3B); on days carrying a day-level manual adjustment a small breakdown-sum vs
  // netMs gap is accepted (DD-B).
  const derivedDayTotalMs = useMemo(
    () => derivedDayBuckets.reduce((sum, b) => sum + b.netMs, 0),
    [derivedDayBuckets]
  );
  const dayTotalMs = cutoverReady
    ? derivedDayTotalMs
    : (mergedDayProjectSummary?.totalMs ?? 0);

  const sessionCount = useMemo(
    () =>
      mergedDayProjectSummary?.projects.reduce(
        (sum, p) => sum + p.sessions.length,
        0
      ) ?? 0,
    [mergedDayProjectSummary]
  );

  const projectCount = mergedDayProjectSummary?.projects.length ?? 0;

  // Map sessionId → entry.id for the delete control inside ProjectAccordion.
  // Built from raw dayEntries (server-truth) so live-only synthetic rows
  // (id starts with `live-`) do not get a delete button (R5).
  const sessionToEntryId = useMemo(
    () => new Map(dayEntries.map(e => [e.sessionId, e.id])),
    [dayEntries]
  );

  const resolveEntryId = useCallback(
    (sessionId: string): string | undefined => sessionToEntryId.get(sessionId),
    [sessionToEntryId]
  );

  // ── Handlers ──

  const handleExport = useCallback(
    (format: "csv" | "json") => {
      const filename = generateExportFilename("timelog", format, selectedDate);
      if (format === "csv") {
        // R5: when the gate is green, CSV serializes the derived buckets.
        if (cutoverReady) {
          exportDerivedToCSV(derivedDayBuckets, filename);
        } else {
          exportToCSV(mergedDayEntries, filename);
        }
      } else {
        exportToJSON(mergedDayEntries, filename);
      }
    },
    [mergedDayEntries, selectedDate, cutoverReady, derivedDayBuckets]
  );

  // Navigate from week bar click to day view
  const handleDayClick = useCallback((date: string) => {
    setSelectedDate(date);
    setActiveTab("day");
  }, []);

  // Day navigation
  const navigateDay = useCallback(
    (direction: -1 | 1) => {
      const [y, m, d] = selectedDate.split("-").map(Number);
      const newDate = new Date(y, m - 1, d + direction);
      setSelectedDate(
        `${newDate.getFullYear()}-${String(newDate.getMonth() + 1).padStart(2, "0")}-${String(newDate.getDate()).padStart(2, "0")}`
      );
    },
    [selectedDate]
  );

  // ── Description text ──

  const descriptionText = useMemo(() => {
    if (activeTab === "day") {
      if (selectedDate === today) return "Today";
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(yesterday);
      if (selectedDate === yesterdayStr) return "Yesterday";
      return formatDateDisplay(selectedDate);
    }
    if (activeTab === "week") {
      return `Week ${weekNumber}`;
    }
    const monthNames = [
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
    return `${monthNames[monthMonth - 1]} ${monthYear}`;
  }, [activeTab, selectedDate, today, weekNumber, monthMonth, monthYear]);

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Period context ("Today" / "Week N" / month) — the page title itself
            is owned by the route's SettingsSectionHeader, not this body */}
        <div className="text-sm text-[var(--app-hint)]">{descriptionText}</div>

        {/* Tab Bar */}
        <div className="mt-3">
          <ViewTabBar activeTab={activeTab} onTabChange={setActiveTab} />
        </div>

        {/* Day navigation (only for day tab) */}
        {activeTab === "day" && (
          <div className="flex items-center justify-between mt-3">
            <button
              type="button"
              onClick={() => navigateDay(-1)}
              className="p-1 rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors"
              title="Previous day"
            >
              <ChevronLeftIcon />
            </button>
            <span className="text-sm text-[var(--app-fg)]">
              {selectedDate === today
                ? "Today"
                : formatDateDisplay(selectedDate)}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => navigateDay(1)}
                className="p-1 rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors"
                title="Next day"
              >
                <ChevronRightIcon />
              </button>
              <ExportMenu entries={mergedDayEntries} onExport={handleExport} />
            </div>
          </div>
        )}

        {/* Daily Total (day tab only) */}
        {activeTab === "day" && (
          <div className="mt-3 px-3 py-2 bg-[var(--app-secondary-bg)] rounded-lg">
            <div className="flex justify-between items-center">
              <span className="text-sm text-[var(--app-hint)]">
                Daily Total
              </span>
              <span className="text-lg font-semibold text-[var(--app-fg)] tabular-nums">
                {dayProjectLoading ? "..." : formatDurationShort(dayTotalMs)}
              </span>
            </div>
            {sessionCount > 0 && (
              <div className="text-xs text-[var(--app-hint)] mt-1">
                {sessionCount} session{sessionCount !== 1 ? "s" : ""}
                {" • "}
                {projectCount} project{projectCount !== 1 ? "s" : ""}
              </div>
            )}
          </div>
        )}

        {/* Scrollable content area */}
        <div className="flex-1 overflow-y-auto mt-3 -mx-6 px-6">
          {activeTab === "day" && (
            <div className="space-y-4">
              {dayProjectLoading || dayEntriesLoading ? (
                <div className="text-center py-4 text-[var(--app-hint)]">
                  <div className="animate-spin w-5 h-5 border-2 border-[var(--brand-accent)] border-t-transparent rounded-full mx-auto mb-2" />
                  Loading entries...
                </div>
              ) : dayEntriesError ? (
                <div className="text-center py-4">
                  <div className="text-sm text-[var(--app-badge-error-text)] mb-2">
                    {dayEntriesError}
                  </div>
                  <button
                    type="button"
                    onClick={() => void refetchDayEntries()}
                    className="px-4 py-2 text-sm bg-[var(--app-subtle-bg)] border border-[var(--app-border)] rounded-lg text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors"
                  >
                    Retry
                  </button>
                </div>
              ) : sessionCount === 0 ? (
                <div className="text-center py-6 text-[var(--app-hint)]">
                  <ClockLogIcon className="w-10 h-10 mx-auto mb-2 opacity-50" />
                  <div className="text-sm">
                    No time logged for{" "}
                    {selectedDate === today
                      ? "today"
                      : formatDateDisplay(selectedDate)}
                  </div>
                </div>
              ) : (
                <div className="p-3 bg-[var(--app-subtle-bg)] rounded-lg">
                  <ProjectAccordion
                    projects={mergedDayProjectSummary?.projects ?? []}
                    totalMs={mergedDayProjectSummary?.totalMs ?? 0}
                    resolveEntryId={resolveEntryId}
                  />
                </div>
              )}
            </div>
          )}

          {activeTab === "week" && (
            <div className="p-3 bg-[var(--app-subtle-bg)] rounded-lg">
              <WeekView
                weeklySummary={
                  cutoverReady ? derivedWeeklySummary : weeklySummary
                }
                weekEntries={cutoverReady ? derivedWeekEntries : weekEntries}
                projectSummary={
                  cutoverReady ? derivedWeekProjectSummary : weekProjectSummary
                }
                isLoading={cutoverReady ? derivedWeekLoading : weeklyLoading}
                weekNumber={weekNumber}
                weekStart={weekStart}
                onWeekChange={setWeekStart}
                onDayClick={handleDayClick}
              />
            </div>
          )}

          {activeTab === "month" && (
            <div className="p-3 bg-[var(--app-subtle-bg)] rounded-lg">
              <MonthView
                summary={
                  cutoverReady
                    ? derivedMonthProjectSummary
                    : monthProjectSummary
                }
                isLoading={cutoverReady ? derivedMonthLoading : monthLoading}
                year={monthYear}
                month={monthMonth}
                onMonthChange={(y, m) => {
                  setMonthYear(y);
                  setMonthMonth(m);
                }}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
