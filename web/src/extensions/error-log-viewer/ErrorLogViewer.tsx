// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useMemo, useCallback } from "react";
import type { ApiClient } from "@/api/client";
import type {
  ErrorLogEntry,
  ErrorLogSeverity,
  ErrorLogSource,
} from "@/types/api";
import { useErrorLogs, useErrorLogStats } from "./hooks/useErrorLogs";
import { LoadingState } from "@/components/LoadingState";
import { AlertTriangle } from "lucide-react";
import { BackIcon, TrashIcon } from "@/components/icons";
import { TitleChip } from "@/components/settings/SettingsSectionHeader";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { KVGrid, type KVGridItem } from "@/components/ui/KVGrid";

// ── Icons ─────────────────────────────────────────────────────────────

function AlertTriangleIcon(props: { className?: string }) {
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
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

// Severity → tokenized Badge variant (A4 / #1980, KD-1). Replaces the bespoke
// `severityColor`/`severityBgColor` hardcoded-Tailwind maps. The 5-level severity
// palette compresses onto the available Badge variants: `fatal`/`error` share the
// red `destructive` family and `info` maps to neutral `default` (A1's token set
// defines no orange/blue). The severity TEXT label preserves all 5 distinctions.
const SEVERITY_BADGE_VARIANT: Record<
  ErrorLogSeverity,
  NonNullable<BadgeProps["variant"]>
> = {
  fatal: "destructive",
  error: "destructive",
  warn: "warning",
  info: "default",
  debug: "subscription",
};

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

const SEVERITY_OPTIONS: ErrorLogSeverity[] = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
];

const SOURCE_OPTIONS: ErrorLogSource[] = ["server", "client", "cli"];

// ── Tool Error Context ───────────────────────────────────────────────

type ToolErrorContext = {
  toolName: string;
  toolUseId?: string;
  errorContent: string;
  input?: unknown;
};

function parseToolErrorContext(entry: ErrorLogEntry): ToolErrorContext | null {
  if (entry.category !== "tool-error" || !entry.context) return null;
  try {
    const parsed = JSON.parse(entry.context);
    if (typeof parsed.toolName !== "string") return null;
    return {
      toolName: parsed.toolName,
      toolUseId: parsed.toolUseId,
      errorContent: parsed.errorContent ?? "",
      input: parsed.input,
    };
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn(
        `[ErrorLogViewer] Failed to parse tool-error context for entry ${entry.id}:`,
        err instanceof Error ? err.message : err
      );
    }
    return null;
  }
}

const TIME_RANGE_OPTIONS = [
  { label: "Last hour", ms: 3_600_000 },
  { label: "Last 24h", ms: 86_400_000 },
  { label: "Last 7d", ms: 7 * 86_400_000 },
  { label: "Last 30d", ms: 30 * 86_400_000 },
  { label: "All time", ms: 0 },
] as const;

// ── Log Entry Row ─────────────────────────────────────────────────────

function LogEntryRow({
  entry,
  expanded,
  onToggle,
  onDelete,
}: {
  entry: ErrorLogEntry;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const toolCtx = parseToolErrorContext(entry);

  // Expanded metadata pairs → shared KVGrid (A3). The Request field, previously a
  // col-span-2 cell, is a normal KVGrid item whose long value wraps (dd break-words).
  const metaItems: KVGridItem[] = [
    { key: "Time", value: formatTimestamp(entry.timestamp) },
    { key: "Source", value: entry.source },
    { key: "Category", value: entry.category },
    ...(entry.sessionId
      ? [
          {
            key: "Session",
            value: (
              <span className="font-mono">{entry.sessionId.slice(0, 8)}</span>
            ),
          },
        ]
      : []),
    ...(toolCtx
      ? [
          {
            key: "Tool",
            value: <span className="font-mono">{toolCtx.toolName}</span>,
          },
        ]
      : []),
    ...(entry.requestPath
      ? [
          {
            key: "Request",
            value: (
              <span className="font-mono">
                {entry.requestMethod} {entry.requestPath}
                {entry.statusCode ? ` → ${entry.statusCode}` : ""}
              </span>
            ),
          },
        ]
      : []),
  ];

  return (
    <CollapsibleSection
      className="rounded-none border-x-0 border-t-0 bg-transparent"
      data-testid={`error-log-row-${entry.id}`}
      open={expanded}
      onOpenChange={() => onToggle()}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <Badge
            variant={SEVERITY_BADGE_VARIANT[entry.severity]}
            className="shrink-0 rounded px-1.5 py-0 text-[10px] font-semibold uppercase"
          >
            {entry.severity}
          </Badge>
          {toolCtx && (
            <Badge
              variant="warning"
              className="shrink-0 rounded px-1.5 py-0 font-mono text-[10px] font-semibold"
            >
              {toolCtx.toolName}
            </Badge>
          )}
          <span className="truncate text-xs font-normal text-[var(--app-fg)]">
            {entry.message}
          </span>
        </span>
      }
      summary={
        <>
          {entry.category}
          <span className="opacity-50"> · </span>
          {entry.source}
          <span className="opacity-50"> · </span>
          {formatRelativeTime(entry.timestamp)}
        </>
      }
    >
      <div>
        {/* Metadata grid */}
        <KVGrid items={metaItems} className="mt-1" />

        {/* Tool error details (structured view) */}
        {toolCtx ? (
          <>
            {/* Error output */}
            <div className="mt-2">
              <p className="text-[10px] font-semibold text-[var(--app-hint)]">
                Error Output
              </p>
              <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--app-bg)] p-2 text-[10px] text-red-300/80 font-mono">
                {toolCtx.errorContent}
              </pre>
            </div>

            {/* Tool input parameters */}
            {toolCtx.input != null && (
              <div className="mt-2">
                <p className="text-[10px] font-semibold text-[var(--app-hint)]">
                  Tool Input
                </p>
                <pre className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--app-bg)] p-2 text-[10px] text-[var(--app-fg)] font-mono">
                  {typeof toolCtx.input === "string"
                    ? toolCtx.input
                    : JSON.stringify(toolCtx.input, null, 2)}
                </pre>
              </div>
            )}
          </>
        ) : (
          <>
            {/* Full message (generic) */}
            <div className="mt-2">
              <p className="text-[10px] font-semibold text-[var(--app-hint)]">
                Message
              </p>
              <pre className="mt-0.5 whitespace-pre-wrap break-words rounded bg-[var(--app-bg)] p-2 text-[10px] text-[var(--app-fg)] font-mono">
                {entry.message}
              </pre>
            </div>

            {/* Stack trace */}
            {entry.stack && (
              <div className="mt-2">
                <p className="text-[10px] font-semibold text-[var(--app-hint)]">
                  Stack Trace
                </p>
                <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--app-bg)] p-2 text-[10px] text-red-300/80 font-mono">
                  {entry.stack}
                </pre>
              </div>
            )}

            {/* Context JSON (generic) */}
            {entry.context && (
              <div className="mt-2">
                <p className="text-[10px] font-semibold text-[var(--app-hint)]">
                  Context
                </p>
                <pre className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--app-bg)] p-2 text-[10px] text-[var(--app-fg)] font-mono">
                  {(() => {
                    try {
                      return JSON.stringify(JSON.parse(entry.context), null, 2);
                    } catch {
                      return entry.context;
                    }
                  })()}
                </pre>
              </div>
            )}
          </>
        )}

        {/* Delete button */}
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();
              onDelete();
            }}
            className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-red-400 transition-colors hover:bg-red-500/10"
          >
            <TrashIcon className="h-3 w-3" />
            Delete
          </button>
        </div>
      </div>
    </CollapsibleSection>
  );
}

// ── Stats Bar ─────────────────────────────────────────────────────────

function StatsBar({ bySeverity }: { bySeverity: Record<string, number> }) {
  const total = Object.values(bySeverity).reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-[10px]">
      {SEVERITY_OPTIONS.map(sev => {
        const count = bySeverity[sev] ?? 0;
        if (count === 0) return null;
        return (
          <Badge
            key={sev}
            variant={SEVERITY_BADGE_VARIANT[sev]}
            className="rounded px-1.5 py-0 text-[10px] font-semibold"
          >
            {count} {sev}
          </Badge>
        );
      })}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────

interface ErrorLogViewerProps {
  api: ApiClient | null;
  onBack: () => void;
}

export function ErrorLogViewer({ api, onBack }: ErrorLogViewerProps) {
  const [severityFilter, setSeverityFilter] = useState<
    ErrorLogSeverity | "all"
  >("all");
  const [sourceFilter, setSourceFilter] = useState<ErrorLogSource | "all">(
    "all"
  );
  const [timeRange, setTimeRange] = useState(86_400_000); // Default: last 24h
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<ErrorLogEntry | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const startTime = useMemo(
    () => (timeRange > 0 ? Date.now() - timeRange : undefined),
    [timeRange]
  );

  const { entries, count, isLoading, error, refetch } = useErrorLogs(api, {
    severity: severityFilter === "all" ? undefined : severityFilter,
    source: sourceFilter === "all" ? undefined : sourceFilter,
    startTime,
    limit: 200,
  });

  const { bySeverity } = useErrorLogStats(api);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleDelete = useCallback(async () => {
    if (!api || !deleteTarget) return;
    setIsDeleting(true);
    try {
      await api.deleteErrorLog(deleteTarget.id);
      await refetch();
    } catch (err) {
      // The entry may already be gone (a benign race) — but a network/auth/server
      // failure is genuine and should not be swallowed silently. Surface it in dev.
      if (import.meta.env.DEV) {
        console.warn(
          "[ErrorLogViewer] delete failed (entry may already be gone):",
          err instanceof Error ? err.message : err
        );
      }
    }
    setIsDeleting(false);
    setDeleteTarget(null);
  }, [api, deleteTarget, refetch]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-[var(--app-bg)]">
          <div className="mx-auto flex w-full max-w-content items-center justify-between px-3 py-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onBack}
                className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
              >
                <BackIcon className="h-5 w-5" />
              </button>
              <TitleChip icon={AlertTriangle} accent="#fb7185" />
              <h1 className="min-w-0 truncate text-lg font-bold text-[var(--app-fg)]">
                Error Logs
              </h1>
              <span className="text-xs text-[var(--app-hint)]">{count}</span>
            </div>
          </div>

          {/* Filter bar */}
          <div className="mx-auto flex w-full max-w-content items-center gap-2 px-3 pb-2">
            <select
              value={severityFilter}
              onChange={e =>
                setSeverityFilter(e.target.value as ErrorLogSeverity | "all")
              }
              className="rounded bg-[var(--app-secondary-bg)] px-2 py-1 text-[10px] text-[var(--app-fg)] outline-none"
            >
              <option value="all">All severity</option>
              {SEVERITY_OPTIONS.map(s => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              value={sourceFilter}
              onChange={e =>
                setSourceFilter(e.target.value as ErrorLogSource | "all")
              }
              className="rounded bg-[var(--app-secondary-bg)] px-2 py-1 text-[10px] text-[var(--app-fg)] outline-none"
            >
              <option value="all">All sources</option>
              {SOURCE_OPTIONS.map(s => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              value={timeRange}
              onChange={e => setTimeRange(Number(e.target.value))}
              className="rounded bg-[var(--app-secondary-bg)] px-2 py-1 text-[10px] text-[var(--app-fg)] outline-none"
            >
              {TIME_RANGE_OPTIONS.map(opt => (
                <option key={opt.ms} value={opt.ms}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Stats bar */}
          <StatsBar bySeverity={bySeverity} />
        </div>

        {/* Content */}
        <div className="mx-auto w-full max-w-content">
          {isLoading ? (
            <LoadingState />
          ) : error ? (
            <p className="px-3 py-6 text-center text-sm text-red-400">
              {error}
            </p>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-[var(--app-hint)]">
              <AlertTriangleIcon className="h-8 w-8 opacity-30" />
              <p className="text-sm">No error logs found</p>
              <p className="text-xs opacity-60">
                Try adjusting filters or time range
              </p>
            </div>
          ) : (
            <div>
              {entries.map(entry => (
                <LogEntryRow
                  key={entry.id}
                  entry={entry}
                  expanded={expandedIds.has(entry.id)}
                  onToggle={() => toggleExpanded(entry.id)}
                  onDelete={() => setDeleteTarget(entry)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete Log Entry"
        description={
          deleteTarget
            ? `Delete this ${deleteTarget.severity} log entry from ${deleteTarget.category}?`
            : ""
        }
        confirmLabel="Delete"
        confirmingLabel="Deleting…"
        onConfirm={handleDelete}
        isPending={isDeleting}
        destructive
      />
    </div>
  );
}
