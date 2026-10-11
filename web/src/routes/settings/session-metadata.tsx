// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  SessionMetadataQuery,
  SessionMetadataTurn,
  SessionTokenTotals,
} from "@hapi/protocol";
import { cn } from "@/lib/utils";
import { useAppContext } from "@/lib/app-context";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { Database } from "lucide-react";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import {
  useSessionMetadataTurns,
  useSessionMetadataFilterOptions,
  useFederationTurnAggregate,
} from "@/hooks/queries/useSessionMetadata";
import { toCsv, downloadCsv, type CsvColumn } from "@/utils/csvExport";
import { generateExportFilename } from "@/utils/timeLogExport";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { DenseRow } from "@/components/ui/DenseRow";
import { StatusDot } from "@/components/ui/StatusDot";
import { KVGrid } from "@/components/ui/KVGrid";
import {
  SegmentedToggle,
  type SegmentedToggleOption,
} from "@/components/ui/SegmentedToggle";
import { FilterChip } from "@/components/ui/FilterChip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  groupTurnsBySession,
  sessionTotalsToGroup,
  sessionDotStatus,
  isSessionActive,
  turnStatusToDot,
  type SessionGroup,
  type SessionGroupSummary,
} from "@/utils/sessionMetadataGrouping";
import { LOCAL_NODE_ID } from "@hapi/protocol";

/**
 * SessionMetadataPage — the `/settings/session-metadata` route (issue #1675, epic #1662
 * Sub M; SM03 rebuild #1982, epic #1981 Admin Drawer B1).
 *
 * SM03 replaces the two flat 13-column `whitespace-nowrap` tables (the 393px
 * horizontal-scroll defect) with a session-grouped, collapsible list built ENTIRELY
 * from the Epic A design-system primitives (`CollapsibleSection`, `DenseRow`,
 * `StatusDot`, `KVGrid`, `Badge`, plus `SegmentedToggle` + `FilterChip` for the
 * scope/filter bar), modeled on `ErrorLogViewer.tsx` (the "Error-Log-twin" — a
 * parent-owned `Set<string>` of open keys + a `max-w-content` wrapper).
 *
 * Scope toggle:
 *   - This node  → node-local `turns` query → `groupTurnsBySession` → collapsible
 *     rows whose expanded body is a `KVGrid` + a nested per-turn list.
 *   - All nodes  → Sub L's session-totals aggregate → `sessionTotalsToGroup` → the
 *     SAME row renderer with an empty turns array (no nested list — cross-node
 *     telemetry carries no per-turn data, R6). Event-kind filter disabled + the
 *     partial-results / federation-disabled banners preserved.
 *
 * CSV export uses the formula-injection-safe escaper (`utils/csvExport.ts`).
 */

type Scope = "this-node" | "all-nodes";

const SCOPE_OPTIONS: SegmentedToggleOption<Scope>[] = [
  { value: "this-node", label: "This node" },
  { value: "all-nodes", label: "All nodes" },
];

// CSV export columns (the exported shape is unchanged — R5 preserves CSV export).
const TURN_COLUMNS: CsvColumn<SessionMetadataTurn>[] = [
  { key: "hapiSessionId", header: "Session" },
  { key: "seq", header: "Seq" },
  { key: "status", header: "Status" },
  { key: "startedAtMs", header: "Started (ms)" },
  { key: "durationMs", header: "Duration (ms)" },
  { key: "repo", header: "Repo" },
  { key: "modelId", header: "Model" },
  { key: "accountId", header: "Account" },
  { key: "linkedIssue", header: "Linked Issue" },
  { key: "nodeId", header: "Node" },
  { key: "tokIn", header: "Tok In" },
  { key: "tokOut", header: "Tok Out" },
  { key: "costTotal", header: "Cost" },
];

const TOTALS_COLUMNS: CsvColumn<SessionTokenTotals>[] = [
  { key: "hapiSessionId", header: "Session" },
  { key: "nodeId", header: "Node" },
  { key: "turnCount", header: "Turns" },
  { key: "firstStartedAtMs", header: "First Started (ms)" },
  { key: "lastEndedAtMs", header: "Last Ended (ms)" },
  { key: "totalDurationMs", header: "Total Duration (ms)" },
  { key: "lastRepo", header: "Repo" },
  { key: "lastModelId", header: "Model" },
  { key: "lastAccountId", header: "Account" },
  { key: "lastLinkedIssue", header: "Linked Issue" },
  { key: "totalTokIn", header: "Tok In" },
  { key: "totalTokOut", header: "Tok Out" },
  { key: "totalCost", header: "Cost" },
];

function dayToMs(day: string, endOfDay: boolean): number | undefined {
  if (!day) return undefined;
  const ms = new Date(
    `${day}T${endOfDay ? "23:59:59" : "00:00:00"}Z`
  ).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

// ── Display formatters (null → "—", R7) ────────────────────────────────

/** Generic null/undefined → em-dash placeholder (R7). */
function cell(value: unknown): string {
  return value === null || value === undefined ? "—" : String(value);
}

function fmtTime(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function fmtCost(n: number | null): string {
  if (n == null) return "—";
  // Sub-cent costs need extra precision so they don't collapse to $0.00.
  return `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : 2)}`;
}

function fmtTokens(n: number | null): string {
  return n == null ? "—" : n.toLocaleString();
}

/** Composite React key + open-key scheme (D9): All-nodes needs `node:session`
 *  because the same session id can surface from multiple nodes; This-node uses the
 *  bare session id. */
function groupKey(scope: Scope, s: SessionGroupSummary): string {
  return scope === "all-nodes"
    ? `${s.nodeId ?? LOCAL_NODE_ID}:${s.hapiSessionId}`
    : s.hapiSessionId;
}

const INPUT_CLASS =
  "rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-2 py-1 text-[length:var(--text-body)] text-[var(--app-fg)]";

// ── Enumerated filter: FilterChip trigger + caller-owned dropdown ───────
//
// FilterChip (A3 #1979) is presentational-only — it renders the pill + chevron and
// fires `onClick`; "opening and positioning the actual menu is the caller's concern".
// This thin wrapper supplies that menu (options + click-outside/Escape dismiss) WITHOUT
// forking the atom (per Epic #1981's "don't fork Epic A primitives"). The `disabled`
// state (which FilterChip does not model) is handled here at the wrapper.

function MenuItem({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button /* design-tokens-allow: full-width left-aligned menuitemradio menu row - D2 E3 exception (#3358) */
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        "flex w-full items-center px-3 py-1.5 text-left text-[length:var(--text-body)] transition-colors hover:bg-[var(--app-hover)]",
        selected ? "text-[var(--app-accent)]" : "text-[var(--app-fg)]"
      )}
    >
      {children}
    </button>
  );
}

function EnumFilter({
  label,
  value,
  options,
  onSelect,
  disabled = false,
  disabledTitle,
  testId,
}: {
  label: string;
  value: string;
  options: string[];
  onSelect: (value: string) => void;
  disabled?: boolean;
  disabledTitle?: string;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // If the whole control becomes disabled (e.g. scope switch), close any open menu.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div
      ref={ref}
      data-testid={testId}
      aria-disabled={disabled || undefined}
      title={disabled ? disabledTitle : undefined}
      className={cn("relative", disabled && "opacity-40")}
    >
      <FilterChip
        label={label}
        value={value || undefined}
        active={Boolean(value)}
        expanded={open}
        ariaLabel={`Filter by ${label}`}
        onClick={() => {
          if (!disabled) setOpen(o => !o);
        }}
      />
      {open && !disabled && (
        <div
          role="menu"
          className="absolute left-0 z-20 mt-1 max-h-64 min-w-[10rem] overflow-auto rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] py-1 shadow-lg"
        >
          <MenuItem
            selected={value === ""}
            onClick={() => {
              onSelect("");
              setOpen(false);
            }}
          >
            All
          </MenuItem>
          {options.map(opt => (
            <MenuItem
              key={opt}
              selected={value === opt}
              onClick={() => {
                onSelect(opt);
                setOpen(false);
              }}
            >
              {opt}
            </MenuItem>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Session row ────────────────────────────────────────────────────────

function SessionRow({
  group,
  open,
  onOpenChange,
  rowKey,
}: {
  group: SessionGroup;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rowKey: string;
}) {
  const { summary, turns } = group;
  const dot = sessionDotStatus(turns); // null in All-nodes scope (no per-turn data)
  const active = isSessionActive(turns);

  // Title (always visible, even expanded): status dot + session id (truncates) +
  // the turn-count Badge as a shrink-0 element so the key R1 metric survives the
  // 393px single-line truncation.
  const title = (
    <span className="inline-flex min-w-0 items-center gap-2">
      {dot && (
        <StatusDot
          status={dot}
          className={active ? "animate-pulse" : undefined}
        />
      )}
      <Badge variant="mint" className="shrink-0">
        {summary.turnCount} turns
      </Badge>
      <span className="min-w-0 truncate font-mono">
        {summary.hapiSessionId}
      </span>
    </span>
  );

  // Collapsed-only secondary line (repo · model · time). Truncates gracefully at
  // narrow widths; the full values live in the expanded KVGrid.
  const collapsedSummary = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="truncate">
        {cell(summary.lastRepo)} · {cell(summary.lastModelId)}
      </span>
      <span className="shrink-0 opacity-50">·</span>
      <span className="shrink-0">
        {fmtTime(summary.lastEndedAtMs ?? summary.firstStartedAtMs)}
      </span>
    </span>
  );

  const kvItems = [
    { key: "Session", value: summary.hapiSessionId },
    { key: "Repo", value: cell(summary.lastRepo) },
    { key: "Model", value: cell(summary.lastModelId) },
    { key: "Node", value: cell(summary.nodeId) },
    { key: "Linked issue", value: cell(summary.lastLinkedIssue) },
    { key: "Account", value: cell(summary.lastAccountId) },
    { key: "Duration", value: fmtDuration(summary.totalDurationMs) },
    {
      key: "Tokens (in / out)",
      value: `${fmtTokens(summary.totalTokIn)} / ${fmtTokens(summary.totalTokOut)}`,
    },
    { key: "Cost", value: fmtCost(summary.totalCost) },
    { key: "Created", value: fmtTime(summary.firstStartedAtMs) },
  ];

  return (
    <CollapsibleSection
      data-testid={`session-row-${rowKey}`}
      title={title}
      summary={collapsedSummary}
      open={open}
      onOpenChange={onOpenChange}
    >
      <KVGrid items={kvItems} className="pt-1" />

      {turns.length > 0 && (
        <div className="mt-3" data-testid={`session-turns-${rowKey}`}>
          <p className="mb-1 text-[length:var(--text-body-dense)] uppercase tracking-wide text-[var(--app-hint)]">
            Turns
          </p>
          <div className="overflow-hidden rounded-md border border-[var(--app-border)]">
            {turns.map(turn => {
              const turnDot = turnStatusToDot(turn.status);
              return (
                <DenseRow
                  key={turn.id}
                  testId={`turn-${turn.id}`}
                  icon={
                    turnDot ? (
                      <StatusDot
                        status={turnDot}
                        className={
                          turn.status === "open" ? "animate-pulse" : undefined
                        }
                      />
                    ) : undefined
                  }
                  label={`Turn ${turn.seq}`}
                  value={fmtDuration(turn.durationMs)}
                  trailing={
                    <span className="text-[length:var(--text-body)] text-[var(--app-hint)]">
                      {fmtCost(turn.costTotal)}
                    </span>
                  }
                />
              );
            })}
          </div>
        </div>
      )}
    </CollapsibleSection>
  );
}

// ── Page ───────────────────────────────────────────────────────────────

export default function SessionMetadataPage() {
  useDocumentTitle("Session Metadata - Hapimatic");
  useEmojiFavicon(null);
  const { api } = useAppContext();

  const [scope, setScope] = useState<Scope>("this-node");
  const [sessionId, setSessionId] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [repo, setRepo] = useState("");
  const [model, setModel] = useState("");
  const [account, setAccount] = useState("");
  const [eventKind, setEventKind] = useState("");
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());

  const fromMs = dayToMs(fromDate, false);
  const toMs = dayToMs(toDate, true);

  const { options } = useSessionMetadataFilterOptions(api);

  const turnFilters: SessionMetadataQuery = {
    sessionId: sessionId || undefined,
    fromMs,
    toMs,
    repo: repo || undefined,
    modelId: model || undefined,
    accountId: account || undefined,
    eventKind: eventKind || undefined,
    // D7: the server default cap is 500 (newest-started-first); request the max so
    // fewer sessions are truncated at the fetch-window edge.
    limit: 2000,
  };

  // Only the active scope's query runs (the inactive one is disabled via null api).
  const { turns, isLoading: turnsLoading } = useSessionMetadataTurns(
    scope === "this-node" ? api : null,
    turnFilters
  );
  const {
    aggregate,
    isLoading: aggLoading,
    isError: aggError,
  } = useFederationTurnAggregate(scope === "all-nodes" ? api : null, {
    fromMs,
    toMs,
  });

  // All-nodes: client-side filter the session-totals on the last* fields.
  const filteredTotals = useMemo(() => {
    let rows = aggregate?.sessionTotals ?? [];
    if (sessionId) rows = rows.filter(r => r.hapiSessionId.includes(sessionId));
    if (repo) rows = rows.filter(r => r.lastRepo === repo);
    if (model) rows = rows.filter(r => r.lastModelId === model);
    if (account) rows = rows.filter(r => r.lastAccountId === account);
    return rows;
  }, [aggregate, sessionId, repo, model, account]);

  // Unify both scopes onto the SAME grouped/collapsible renderer.
  const groups: SessionGroup[] = useMemo(
    () =>
      scope === "this-node"
        ? groupTurnsBySession(turns)
        : filteredTotals.map(sessionTotalsToGroup),
    [scope, turns, filteredTotals]
  );

  const isLoading = scope === "this-node" ? turnsLoading : aggLoading;
  const rowCount = scope === "this-node" ? turns.length : filteredTotals.length;
  const eventKindDisabled = scope === "all-nodes";

  const handleExport = () => {
    const filename = generateExportFilename("session-metadata", "csv");
    const csv =
      scope === "this-node"
        ? toCsv(turns, TURN_COLUMNS)
        : toCsv(filteredTotals, TOTALS_COLUMNS);
    downloadCsv(csv, filename);
  };

  const makeToggle = (key: string) => (next: boolean) =>
    setOpenKeys(prev => {
      const set = new Set(prev);
      if (next) set.add(key);
      else set.delete(key);
      return set;
    });

  return (
    <div
      data-testid="settings-session-metadata-root"
      className="flex h-full flex-col overflow-y-auto"
    >
      <SettingsSectionHeader
        icon={<TitleChip icon={Database} accent="var(--accent-sky-400)" />}
        title="Session Metadata"
      />

      {/* Controls: scope + filters + export */}
      <div className="mx-auto w-full max-w-content px-4">
        {/* Scope toggle */}
        <div className="flex items-center gap-2 py-2">
          <span className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
            Scope
          </span>
          <SegmentedToggle
            options={SCOPE_OPTIONS}
            value={scope}
            onChange={setScope}
            ariaLabel="Telemetry scope"
            testIdPrefix="scope"
          />
        </div>

        {/* Filter bar — enumerated dimensions as FilterChips; free-text + dates
            stay native inputs (FilterChip scope boundary D12 / OR-2 default). */}
        <div className="flex flex-wrap items-center gap-2 pb-2">
          <input
            autoCapitalize="none"
            data-testid="filter-session"
            value={sessionId}
            onChange={e => setSessionId(e.target.value)}
            placeholder="session id"
            aria-label="Filter by session id"
            className={INPUT_CLASS}
          />
          <input
            data-testid="filter-from"
            type="date"
            value={fromDate}
            onChange={e => setFromDate(e.target.value)}
            aria-label="From date"
            className={INPUT_CLASS}
          />
          <input
            data-testid="filter-to"
            type="date"
            value={toDate}
            onChange={e => setToDate(e.target.value)}
            aria-label="To date"
            className={INPUT_CLASS}
          />
          <EnumFilter
            label="Repo"
            value={repo}
            options={options?.repos ?? []}
            onSelect={setRepo}
            testId="filter-repo"
          />
          <EnumFilter
            label="Model"
            value={model}
            options={options?.models ?? []}
            onSelect={setModel}
            testId="filter-model"
          />
          <EnumFilter
            label="Account"
            value={account}
            options={options?.accounts ?? []}
            onSelect={setAccount}
            testId="filter-account"
          />
          <EnumFilter
            label="Kind"
            value={eventKind}
            options={options?.eventKinds ?? []}
            onSelect={setEventKind}
            disabled={eventKindDisabled}
            disabledTitle="Event-kind filtering is node-local only (cross-node telemetry carries no per-event data)."
            testId="filter-event-kind"
          />
          <Button
            type="button"
            data-testid="csv-export"
            onClick={handleExport}
            disabled={rowCount === 0}
            variant="accent"
            className="ml-auto h-auto rounded-md px-3 py-1 text-[length:var(--text-body)] text-[var(--palette-accent-fg)] hover:opacity-100 disabled:opacity-40"
          >
            Export CSV
          </Button>
        </div>
      </div>

      {/* Partial-results / federation-disabled banners (all-nodes scope) */}
      {scope === "all-nodes" && aggregate?.partial && (
        <div
          data-testid="partial-banner"
          className="mx-auto my-2 w-full max-w-content rounded-md bg-[var(--app-secondary-bg)] px-3 py-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
        >
          ⚠️ Partial results — {aggregate.answeredNodeCount} of{" "}
          {aggregate.nodeCount} nodes answered.
        </div>
      )}
      {scope === "all-nodes" && aggError && (
        <div
          data-testid="agg-error"
          className="mx-auto my-2 w-full max-w-content rounded-md bg-[var(--app-secondary-bg)] px-3 py-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
        >
          Cross-node telemetry is unavailable on this node (standalone or
          federation disabled).
        </div>
      )}

      {/* Session list */}
      <div className="mx-auto min-h-0 w-full max-w-content flex-1 px-4 pb-4">
        {isLoading ? (
          <p className="py-8 text-center text-[length:var(--text-body)] text-[var(--app-hint)]">
            Loading…
          </p>
        ) : groups.length === 0 ? (
          <p
            data-testid="empty-state"
            className="py-8 text-center text-[length:var(--text-body)] text-[var(--app-hint)]"
          >
            No matching {scope === "this-node" ? "turns" : "sessions"}.
          </p>
        ) : (
          <div
            data-testid="session-groups"
            className="flex flex-col gap-2 py-2"
          >
            {groups.map(group => {
              const key = groupKey(scope, group.summary);
              return (
                <SessionRow
                  key={key}
                  rowKey={key}
                  group={group}
                  open={openKeys.has(key)}
                  onOpenChange={makeToggle(key)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
