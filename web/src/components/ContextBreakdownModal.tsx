// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { ContextUsageDetail } from "@hapi/protocol";
import { useAppContext } from "@/lib/app-context";
import { useSession } from "@/hooks/queries/useSession";
import { useSessionTokenStats } from "@/hooks/queries/useSessionTokenStats";
import { useSessionContextBreakdown } from "@/hooks/queries/useSessionContextBreakdown";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";
import { tokens } from "@/design/tokens";
import { formatTokens } from "@/lib/formatTokens";
import {
  buildContextSections,
  buildContextTrend,
  buildTrimSuggestions,
  groupMcpServers,
  mcpServerContextTokens,
  unitemizedMcpTokens,
  type ContextSection,
  type ContextSectionKey,
  type ContextTrend,
} from "@/lib/contextBreakdown";

/**
 * ContextBreakdownModal — what the session's context is made of (issue #6170,
 * epic #6163 Sub D1). Opened from the Context widget below the composer
 * (`TokenUsageWidget`). Mirrors `BackgroundAgentsModal`'s centered-dialog
 * chrome.
 *
 * - The stack: Claude Code's categories in the order they enter the context,
 *   each with its size and share of the window; MCP, memory files, agents,
 *   skills and messages expand to their per-item lists. Deferred tool schemas
 *   (not in the context) are listed apart.
 * - The trend: the server's turn-end context size per turn (token-stats), plus
 *   the current reading.
 * - Trim suggestions: `buildTrimSuggestions` rules.
 *
 * The breakdown is read with `get-context-usage` `{ detail: "full" }` on open
 * and on Refresh only (each read runs Claude Code's token counting). It exists
 * only for a Claude session on the SDK launcher; for any other session, and for
 * every read failure, the modal says why and still shows the live totals and
 * the trend. Open to every user who can see the session — no admin gate.
 */
export function ContextBreakdownModal({
  sessionId,
  open,
  onOpenChange,
}: {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { api } = useAppContext();
  const { session } = useSession(api, sessionId, true);
  const flavor = session?.metadata?.flavor ?? undefined;
  const launcherKind = session?.metadata?.launcherKind;
  // Only the Claude runner sets `launcherKind`, so an absent value on an older
  // session still tries (a 403 answers it).
  const launcherReports =
    !(flavor && flavor !== "claude") &&
    !(launcherKind && launcherKind !== "sdk");
  // A session that is not running has no capabilities registered (the server
  // answers 403), so it is not asked; its totals and trend still show.
  const running = session?.active !== false;
  const breakdownPossible = launcherReports && running;
  const breakdown = useSessionContextBreakdown(
    api,
    sessionId,
    open && breakdownPossible
  );
  const { data: tokenStats } = useSessionTokenStats(
    open ? api : null,
    sessionId
  );

  // TanStack Query still returns an earlier read for a disabled query, so a
  // breakdown is shown only while one can be read; otherwise the session's own
  // last totals stand.
  const detail =
    breakdownPossible && breakdown.data?.kind === "ok"
      ? breakdown.data.detail
      : undefined;
  const readTime = detail ? breakdown.dataUpdatedAt : 0;
  const windowTokens = detail?.maxTokens ?? session?.contextWindowTokens;
  const usedTokens = detail?.totalTokens ?? session?.contextUsedTokens;
  const percent = detail?.percentage ?? session?.contextPercentage;

  const trend = useMemo(
    () =>
      buildContextTrend(
        tokenStats?.turns ?? [],
        typeof usedTokens === "number"
          ? { at: readTime || Date.now(), tokens: usedTokens }
          : undefined
      ),
    [tokenStats?.turns, usedTokens, readTime]
  );

  const notice = breakdownPossible
    ? breakdownNotice(breakdown.data, breakdown.error, launcherKind)
    : launcherReports
      ? NOT_RUNNING_NOTICE
      : LAUNCHER_NOTICE;
  const readAt =
    readTime > 0
      ? new Date(readTime).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={`context-breakdown-modal-${sessionId}`}
        description="What this session's context window holds, section by section"
        className="flex flex-col overflow-hidden p-0"
        heightVariant="threeQuarter"
      >
        {/* Header — `pr-12` clears the primitive's absolute close button. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--app-border)] px-4 py-3 pr-12">
          <DialogTitle className="text-[length:var(--text-body)] font-semibold leading-tight tracking-normal text-[var(--app-fg)]">
            Context
          </DialogTitle>
          <span
            data-testid="context-breakdown-totals"
            className="text-[length:var(--text-caption)] tabular-nums text-[var(--app-hint)]"
          >
            {typeof usedTokens === "number" && windowTokens
              ? `${formatTokens(usedTokens)} / ${formatTokens(windowTokens)}`
              : "—"}
            {typeof percent === "number"
              ? ` · ${Math.max(0, 100 - Math.round(percent))}% left`
              : ""}
            {detail?.model ? ` · ${detail.model}` : ""}
            {readAt ? (
              <span data-testid="context-breakdown-read-at">
                {` · read ${readAt}`}
              </span>
            ) : null}
          </span>
          {breakdownPossible ? (
            <Button
              type="button"
              variant="secondary"
              size="dense"
              className="ml-auto"
              disabled={breakdown.isFetching}
              onClick={() => void breakdown.refetch()}
              data-testid="context-breakdown-refresh"
            >
              {breakdown.isFetching ? "Reading…" : "Refresh"}
            </Button>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {breakdown.isFetching && !breakdown.data ? (
            <p className="px-1 py-6 text-center text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
              Reading the context…
            </p>
          ) : null}

          {notice ? (
            <div
              data-testid="context-breakdown-notice"
              className="mb-3 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
            >
              <p>{notice.message}</p>
              {notice.detail ? (
                <p
                  data-testid="context-breakdown-notice-detail"
                  className="mt-1 break-words text-[length:var(--text-caption)] text-[var(--app-hint)]"
                >
                  {notice.detail}
                </p>
              ) : null}
              {notice.retry ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="dense"
                  className="mt-2"
                  disabled={breakdown.isFetching}
                  onClick={() => void breakdown.refetch()}
                >
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null}

          {detail ? <BreakdownBody detail={detail} /> : null}

          <SectionHeading>Over the session</SectionHeading>
          <TrendChart
            trend={trend}
            windowTokens={windowTokens}
            compactAt={detail?.autoCompactThreshold}
          />

          {detail ? (
            <>
              <SectionHeading>Trim suggestions</SectionHeading>
              <TrimSuggestions detail={detail} />
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

type Notice = { message: string; detail?: string; retry: boolean } | null;

const LAUNCHER_NOTICE: Notice = {
  message: "This session's launcher does not report a context breakdown.",
  retry: false,
};

const NOT_RUNNING_NOTICE: Notice = {
  message:
    "This session is not running, so its context cannot be read. The totals and trend are from its last turn.",
  retry: false,
};

const READ_FAILED = "Could not read the breakdown from the session.";

/** Reader-facing names for the reply's sections (see `unreadEntries`). */
const SECTION_NAMES: Record<string, string> = {
  categories: "context sections",
  memoryFiles: "memory files",
  mcpTools: "MCP tools",
  mcpInstructions: "MCP instructions",
  agents: "custom agents",
  skills: "skills",
  messageBreakdown: "message breakdown",
  autoCompactThreshold: "auto-compact threshold",
  isAutoCompactEnabled: "auto-compact setting",
};

/** "memory files (1 entry), skills" — what the parser had to drop. */
function describeUnread(unread: Record<string, number>): string {
  return Object.entries(unread)
    .map(([key, count]) => {
      const name = SECTION_NAMES[key] ?? key;
      return count > 0
        ? `${name} (${count} ${count === 1 ? "entry" : "entries"})`
        : name;
    })
    .join(", ");
}

/** The message for a breakdown read that did not produce a full breakdown. */
function breakdownNotice(
  data: ReturnType<typeof useSessionContextBreakdown>["data"],
  error: unknown,
  launcherKind: string | undefined
): Notice {
  if (error) {
    return {
      message: READ_FAILED,
      detail: error instanceof Error ? error.message : undefined,
      retry: true,
    };
  }
  if (!data) return null;
  if (data.kind === "ok") {
    // Unread parts first: a reply whose every category failed to parse has no
    // categories either, and must say what could not be read, not "none sent".
    if (data.detail.unreadEntries) {
      return {
        message: `Part of the reply could not be read: ${describeUnread(data.detail.unreadEntries)}.`,
        retry: true,
      };
    }
    if ((data.detail.categories ?? []).length === 0) {
      return {
        message: "The session sent totals but no breakdown.",
        retry: true,
      };
    }
    return null;
  }
  switch (data.code) {
    case "tier_not_invocable":
      // An SDK session registers the capability when its remote launcher
      // starts, so a refusal there means it has not reached remote mode yet
      // (still connecting, or running in local mode) — worth another try;
      // any other launcher never offers it.
      return launcherKind === "sdk"
        ? {
            message:
              "The session did not offer the breakdown. It may still be starting.",
            retry: true,
          }
        : LAUNCHER_NOTICE;
    case "invalid_input":
      // A CLI from before #6170 accepts no input at all, so the gate rejects
      // `detail` as an additional property.
      return /additional propert/i.test(data.message)
        ? {
            message:
              "This session started on an older version of Hapimatic. The breakdown appears after the session restarts.",
            retry: false,
          }
        : { message: READ_FAILED, detail: data.message, retry: false };
    case "no_active_query":
      return {
        message: "No Claude query is running in this session right now.",
        retry: true,
      };
    default:
      return { message: READ_FAILED, detail: data.message, retry: true };
  }
}

/** Section swatches — design tokens only (runtime-swappable). */
const SECTION_COLOR: Record<ContextSectionKey, string> = {
  "system-prompt": tokens.section.sky400,
  "system-tools": tokens.section.indigo400,
  mcp: tokens.cyan,
  agents: tokens.section.violet400,
  memory: tokens.section.amber400,
  skills: tokens.section.emerald400,
  messages: tokens.section.pink400,
  buffer: tokens.hint,
  free: tokens.border,
  other: tokens.section.teal400,
};

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-2 mt-4 px-1 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
      {children}
    </h3>
  );
}

function percentText(share: number): string {
  const pct = share * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

function BreakdownBody({ detail }: { detail: ContextUsageDetail }) {
  const { sections, deferred } = useMemo(
    () => buildContextSections(detail),
    [detail]
  );
  if (sections.length === 0) return null;
  return (
    <>
      <ul className="flex flex-col gap-1" data-testid="context-breakdown-stack">
        {sections.map(section => (
          <SectionRow key={section.key + section.label} section={section}>
            <SectionDetail section={section} detail={detail} />
          </SectionRow>
        ))}
      </ul>
      {deferred.length > 0 ? (
        <>
          <SectionHeading>Not in context (loaded on demand)</SectionHeading>
          <ul
            className="flex flex-col gap-1"
            data-testid="context-breakdown-deferred"
          >
            {deferred.map(row => (
              <li
                key={row.label}
                className="flex items-baseline justify-between gap-2 px-2 text-[length:var(--text-caption)] text-[var(--app-hint)]"
              >
                <span className="min-w-0 truncate">{row.label}</span>
                <span className="shrink-0 tabular-nums">
                  {formatTokens(row.tokens)}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

/** One section of the stack; expands in place when it has a detail list. */
function SectionRow({
  section,
  children,
}: {
  section: ContextSection;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const expandable = children !== null && hasDetail(section.key);
  const bar = (
    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--app-hover)]">
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.min(100, section.shareOfWindow * 100)}%`,
          minWidth: section.tokens > 0 ? "2px" : 0,
          backgroundColor: SECTION_COLOR[section.key],
        }}
      />
    </div>
  );
  const heading = (
    <div className="flex w-full items-center gap-2">
      <span
        aria-hidden
        className="h-2.5 w-2.5 shrink-0 rounded-sm"
        style={{ backgroundColor: SECTION_COLOR[section.key] }}
      />
      <span className="min-w-0 flex-1 truncate text-left text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
        {section.label}
      </span>
      <span className="shrink-0 tabular-nums text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
        {formatTokens(section.tokens)}
      </span>
      <span className="w-9 shrink-0 text-right tabular-nums text-[length:var(--text-caption)] text-[var(--app-hint)]">
        {percentText(section.shareOfWindow)}
      </span>
      {expandable ? (
        <ChevronRight
          aria-hidden
          className={`h-3.5 w-3.5 shrink-0 text-[var(--app-hint)] transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
        />
      ) : (
        <span aria-hidden className="w-3.5 shrink-0" />
      )}
    </div>
  );
  return (
    <li
      data-testid={`context-section-${section.key}`}
      className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)]"
    >
      {expandable ? (
        <BareButton
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(v => !v)}
          className="flex min-h-[var(--control-touch)] w-full flex-col items-stretch justify-center px-2.5 py-1.5"
        >
          {heading}
          {bar}
        </BareButton>
      ) : (
        <div className="flex min-h-[var(--control-touch)] flex-col justify-center px-2.5 py-1.5">
          {heading}
          {bar}
        </div>
      )}
      {expandable && expanded ? (
        <div className="border-t border-[var(--app-border)] px-2.5 py-2">
          {children}
        </div>
      ) : null}
    </li>
  );
}

function hasDetail(key: ContextSectionKey): boolean {
  return (
    key === "mcp" ||
    key === "memory" ||
    key === "agents" ||
    key === "skills" ||
    key === "messages"
  );
}

type ItemRow = { key: string; label: string; note?: string; tokens: number };

function ItemList({ rows, testId }: { rows: ItemRow[]; testId: string }) {
  if (rows.length === 0) {
    return (
      <p className="text-[length:var(--text-caption)] text-[var(--app-hint)]">
        No items reported.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1" data-testid={testId}>
      {rows.map(row => (
        <li
          key={row.key}
          className="flex items-baseline justify-between gap-2 text-[length:var(--text-caption)]"
        >
          <span
            className="min-w-0 flex-1 truncate text-[var(--app-fg)]"
            title={row.label}
          >
            {row.label}
            {row.note ? (
              <span className="ml-1 text-[var(--app-hint)]">{row.note}</span>
            ) : null}
          </span>
          <span className="shrink-0 tabular-nums text-[var(--app-hint)]">
            {formatTokens(row.tokens)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Rows shown before a "+N more" line. */
const MAX_DETAIL_ROWS = 12;

function capped(rows: ItemRow[]): ItemRow[] {
  if (rows.length <= MAX_DETAIL_ROWS) return rows;
  const rest = rows.slice(MAX_DETAIL_ROWS);
  return [
    ...rows.slice(0, MAX_DETAIL_ROWS),
    {
      key: "__more",
      label: `+${rest.length} more`,
      tokens: rest.reduce((sum, row) => sum + row.tokens, 0),
    },
  ];
}

function SectionDetail({
  section,
  detail,
}: {
  section: ContextSection;
  detail: ContextUsageDetail;
}) {
  switch (section.key) {
    case "memory":
      return (
        <ItemList
          testId="context-detail-memory"
          rows={capped(
            [...(detail.memoryFiles ?? [])]
              .sort((a, b) => b.tokens - a.tokens)
              .map(file => ({
                key: file.path,
                label: file.path,
                note: file.type,
                tokens: file.tokens,
              }))
          )}
        />
      );
    case "mcp": {
      const unitemized = unitemizedMcpTokens(detail);
      const unitemizedRows: ItemRow[] =
        unitemized > 0
          ? [
              {
                key: "__unitemized",
                label: "Not split by server",
                note: detail.mcpInstructions
                  ? undefined
                  : "server instructions; this Claude Code version reports one total",
                tokens: unitemized,
              },
            ]
          : [];
      return (
        <ItemList
          testId="context-detail-mcp"
          rows={[
            ...unitemizedRows,
            ...capped(
              groupMcpServers(detail).map(server => {
                const notes: string[] = [];
                if (server.loadedTools > 0) {
                  notes.push(
                    `${server.loadedTools} tool${server.loadedTools === 1 ? "" : "s"}`
                  );
                }
                if (server.instructionTokens > 0) {
                  notes.push(
                    `instructions ${formatTokens(server.instructionTokens)}`
                  );
                }
                if (server.deferredTokens > 0) {
                  notes.push(
                    `${formatTokens(server.deferredTokens)} not loaded`
                  );
                }
                return {
                  key: server.name,
                  label: server.name,
                  note: notes.join(" · "),
                  tokens: mcpServerContextTokens(server),
                };
              })
            ),
          ]}
        />
      );
    }
    case "agents":
      return (
        <ItemList
          testId="context-detail-agents"
          rows={capped(
            [...(detail.agents ?? [])]
              .sort((a, b) => b.tokens - a.tokens)
              .map(agent => ({
                key: `${agent.source}:${agent.agentType}`,
                label: agent.agentType,
                note: agent.source,
                tokens: agent.tokens,
              }))
          )}
        />
      );
    case "skills": {
      const skills = detail.skills;
      return (
        <>
          {skills ? (
            <p className="mb-1 text-[length:var(--text-caption)] text-[var(--app-hint)]">
              {skills.includedSkills} of {skills.totalSkills} skills listed
            </p>
          ) : null}
          <ItemList
            testId="context-detail-skills"
            rows={capped(
              [...(skills?.skillFrontmatter ?? [])]
                .sort((a, b) => b.tokens - a.tokens)
                .map(skill => ({
                  key: `${skill.source}:${skill.pluginName ?? ""}:${skill.name}`,
                  label: skill.name,
                  note: skill.pluginName ?? skill.source,
                  tokens: skill.tokens,
                }))
            )}
          />
        </>
      );
    }
    case "messages": {
      const parts = detail.messageBreakdown;
      if (!parts) {
        return <ItemList testId="context-detail-messages" rows={[]} />;
      }
      const rows: ItemRow[] = [
        {
          key: "user",
          label: "Your messages",
          tokens: parts.userMessageTokens,
        },
        {
          key: "assistant",
          label: "Claude's replies",
          tokens: parts.assistantMessageTokens,
        },
        { key: "calls", label: "Tool calls", tokens: parts.toolCallTokens },
        {
          key: "results",
          label: "Tool results",
          tokens: parts.toolResultTokens,
        },
        {
          key: "attachments",
          label: "Attachments",
          tokens: parts.attachmentTokens,
        },
      ];
      const toolRows = [...(parts.toolCallsByType ?? [])]
        .sort(
          (a, b) =>
            b.callTokens + b.resultTokens - (a.callTokens + a.resultTokens)
        )
        .slice(0, 5)
        .map(tool => ({
          key: `tool:${tool.name}`,
          label: tool.name,
          note: "calls + results",
          tokens: tool.callTokens + tool.resultTokens,
        }));
      return (
        <>
          <ItemList testId="context-detail-messages" rows={rows} />
          {toolRows.length > 0 ? (
            <>
              <p className="mb-1 mt-2 text-[length:var(--text-caption)] text-[var(--app-hint)]">
                Largest tools
              </p>
              <ItemList testId="context-detail-tools" rows={toolRows} />
            </>
          ) : null}
        </>
      );
    }
    default:
      return null;
  }
}

/** A small line chart of the context size over the session (SVG, no library). */
function TrendChart({
  trend,
  windowTokens,
  compactAt,
}: {
  trend: ContextTrend;
  windowTokens?: number;
  compactAt?: number;
}) {
  if (trend.points.length < 2) {
    return (
      <p
        data-testid="context-trend-empty"
        className="px-1 text-[length:var(--text-caption)] text-[var(--app-hint)]"
      >
        The trend appears after a few turns.
      </p>
    );
  }
  const max = Math.max(trend.peak ?? 0, compactAt ?? 0, 1) * 1.05;
  const w = 100;
  const h = 40;
  const step = w / (trend.points.length - 1);
  const y = (value: number) => h - (value / max) * h;
  const line = trend.points
    .map((point, i) => `${(i * step).toFixed(2)},${y(point.tokens).toFixed(2)}`)
    .join(" ");
  return (
    <div data-testid="context-trend">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-20 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label="Context size over the session"
      >
        {compactAt ? (
          <line
            x1={0}
            x2={w}
            y1={y(compactAt)}
            y2={y(compactAt)}
            stroke="var(--app-hint)"
            strokeDasharray="2 2"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        <polyline
          points={line}
          fill="none"
          stroke="var(--app-link)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <p className="mt-1 px-1 text-[length:var(--text-caption)] tabular-nums text-[var(--app-hint)]">
        Start {formatTokens(trend.start ?? 0)} · peak{" "}
        {formatTokens(trend.peak ?? 0)} · now {formatTokens(trend.current ?? 0)}
        {windowTokens ? ` of ${formatTokens(windowTokens)}` : ""}
        {trend.drops.length > 0
          ? ` · ${trend.drops.length} compaction${trend.drops.length === 1 ? "" : "s"}`
          : ""}
        {compactAt
          ? ` · dashed line: compacts at ${formatTokens(compactAt)}`
          : ""}
      </p>
    </div>
  );
}

function TrimSuggestions({ detail }: { detail: ContextUsageDetail }) {
  const suggestions = useMemo(() => buildTrimSuggestions(detail), [detail]);
  if (suggestions.length === 0) {
    return (
      <p
        data-testid="context-suggestions-empty"
        className="px-1 text-[length:var(--text-caption)] text-[var(--app-hint)]"
      >
        Nothing stands out.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2" data-testid="context-suggestions">
      {suggestions.map(suggestion => (
        <li
          key={suggestion.id}
          className="rounded-md border border-[var(--app-border)] px-2.5 py-2"
        >
          <p className="break-words text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
            {suggestion.title}
          </p>
          <p className="mt-0.5 text-[length:var(--text-caption)] text-[var(--app-hint)]">
            {suggestion.detail}
          </p>
        </li>
      ))}
    </ul>
  );
}
