// SPDX-License-Identifier: AGPL-3.0-only
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import type { SessionTokenStats } from "@/chat/types";
import {
  estimateUsd,
  costTreatment,
  splitCost,
  type SessionCostSplit,
} from "@/lib/costEstimate";
import type { AuthBinding } from "@hapi/protocol";
import { getContextBudgetTokens } from "@/chat/modelConfig";
import { tokens } from "@/design/tokens";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";
import { ChevronRight } from "lucide-react";
import { rawTokenTotal, weightedQuotaTokens } from "@/lib/weightedQuota";
import { formatTokens } from "@/lib/formatTokens";
import type { BackgroundAgentUsage } from "@hapi/protocol/schemas";
import { useAppContext } from "@/lib/app-context";
import { useSessionTokenStats } from "@/hooks/queries/useSessionTokenStats";
import { BackgroundAgentsModal } from "@/components/BackgroundAgentsModal";

/** Stacked bar segment descriptor. */
type Segment = {
  label: string;
  value: number;
  color: string;
};

function StackedBar({ segments }: { segments: Segment[] }) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total === 0) return null;

  return (
    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-[var(--app-hover)]">
      {segments.map(seg => {
        if (seg.value === 0) return null;
        const pct = (seg.value / total) * 100;
        return (
          <div
            key={seg.label}
            className="transition-all duration-300"
            style={{
              width: `${pct}%`,
              backgroundColor: seg.color,
              minWidth: pct > 0 ? "2px" : 0,
            }}
            title={`${seg.label}: ${formatTokens(seg.value)} (${pct.toFixed(0)}%)`}
          />
        );
      })}
    </div>
  );
}

/** Tiny SVG sparkline showing input+output per turn over time. */
function Sparkline({
  data,
}: {
  data: Array<{ input: number; output: number }>;
}) {
  const points = useMemo(() => {
    if (data.length < 2) return null;
    const values = data.map(d => d.input + d.output);
    const max = Math.max(...values, 1);
    const w = 100;
    const h = 20;
    const step = w / (values.length - 1);
    return values
      .map(
        (v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`
      )
      .join(" ");
  }, [data]);

  if (!points) return null;

  return (
    <svg viewBox="0 0 100 20" className="h-4 w-full" preserveAspectRatio="none">
      <polyline
        points={points}
        fill="none"
        stroke="var(--app-link)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function formatUsd(usd: number): string {
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

type ApiValue = {
  usd: number | null;
  /** Rate-card-computed on the server (vs the client static-price estimate). */
  authoritative: boolean;
  treatment: ReturnType<typeof costTreatment>;
  /** Issue #4824: appended to the figure's tooltip (the excluded amount). */
  note?: string;
};

type ShownApiValue = ApiValue & { usd: number };

/**
 * Issue #4824 (R4): what the cost row and the heading show. `dual` — a session
 * whose turns ran under BOTH a key and a subscription — shows the real charge
 * (mint) and the API-equivalent value (EQ-blue) side by side; nothing is reset
 * or re-coloured by a switch. Everything else is `single`, rendered exactly as
 * before (#3353).
 */
type CostDisplay =
  | { mode: "single"; value: ApiValue }
  | { mode: "dual"; real: ShownApiValue; equivalent: ShownApiValue };

/**
 * The session's cumulative API value/cost — ONE resolution shared by the
 * expanded "API value" row and the heading's inline figure, so the two can
 * never disagree.
 *
 * Issue #1671: when server-sourced, the rate-card-computed `total_cost`
 * (v_session_totals) is authoritative; otherwise fall back to the client
 * static-price estimate (R5/R7). Issue #3353: the real-vs-EQ display treatment
 * (the SINGLE discriminator, no per-flavor conditional). Absent binding →
 * neutral, so a legacy/pre-#3351 session shows "—" rather than an unattributed
 * dollar amount (D5(a)).
 */
function resolveApiValue(input: {
  stats: SessionTokenStats;
  resolvedModel?: string;
  serverCost?: number | null;
  isServerSourced?: boolean;
  authBindingKind?: AuthBinding["kind"];
}): ApiValue {
  const authoritative =
    Boolean(input.isServerSourced) && input.serverCost != null;
  return {
    usd: authoritative
      ? (input.serverCost ?? null)
      : estimateUsd(input.stats, input.resolvedModel),
    authoritative,
    treatment: costTreatment(input.authBindingKind),
  };
}

/**
 * Issue #4824: resolve the cost display from the server's split of the session
 * total by each turn's RECORDED binding. Without a split (client estimate, an
 * older federation peer, a server whose migration has not run, nothing priced
 * yet) this is exactly {@link resolveApiValue} — today's single figure. With
 * one, even a single figure follows the split rather than the session's
 * CURRENT binding, so a session that switched from a subscription to a key
 * before any key turn was priced still shows its value as EQ, never as a
 * charge. A single-kind session renders byte-identically (its one bucket is the
 * whole total).
 */
function resolveCostDisplay(input: {
  stats: SessionTokenStats;
  resolvedModel?: string;
  serverCost?: number | null;
  isServerSourced?: boolean;
  authBindingKind?: AuthBinding["kind"];
  costSplit?: SessionCostSplit | null;
}): CostDisplay {
  const split = input.isServerSourced
    ? splitCost(input.costSplit, input.authBindingKind)
    : null;
  if (!split) return { mode: "single", value: resolveApiValue(input) };
  const note =
    split.excluded !== null && split.excluded > 0
      ? `Excludes ${formatUsd(split.excluded)} from turns with no recorded billing binding (included in the session total)`
      : undefined;
  const real: ShownApiValue | null =
    split.real !== null
      ? { usd: split.real, authoritative: true, treatment: "real" }
      : null;
  const equivalent: ShownApiValue | null =
    split.equivalent !== null
      ? { usd: split.equivalent, authoritative: true, treatment: "equivalent" }
      : null;
  if (real && equivalent && real.usd > 0 && equivalent.usd > 0) {
    return { mode: "dual", real: { ...real, note }, equivalent };
  }
  // One figure: the bucket that carries cost (a zero-cost bucket only when it
  // is the only one); only excluded cost → neutral, as for an unbound session.
  const single: ApiValue =
    real && (real.usd > 0 || !equivalent?.usd)
      ? real
      : (equivalent ?? {
          usd: split.excluded,
          authoritative: true,
          treatment: "neutral",
        });
  return { mode: "single", value: { ...single, note } };
}

/**
 * The colored dollar figure ("$84.82 EQ." / "~$1.20 (est.)"). Rendered by the
 * expanded row and, identically, inline in the heading. Callers handle the
 * neutral treatment and a null amount — this renders a real figure only.
 */
function ApiValueFigure({
  value,
  className,
}: {
  value: ShownApiValue;
  className?: string;
}) {
  const source = value.authoritative
    ? "Rate-card-computed API value (server-authoritative)"
    : "Static price table; not a live bill";
  return (
    <span
      data-testid="api-value-figure"
      className={`${
        value.treatment === "real"
          ? "text-[var(--app-accent)]"
          : "text-[var(--cost-equivalent)]"
      }${className ? ` ${className}` : ""}`}
      title={value.note ? `${source}. ${value.note}` : source}
    >
      {value.authoritative
        ? formatUsd(value.usd)
        : `~${formatUsd(value.usd)} (est.)`}
      {value.treatment === "equivalent" ? (
        <span
          className={
            /* design-tokens-allow: 9px "EQ." marker — mirrors the est. sub-floor micro-label exception (#3336) */ "ml-1 text-[9px] uppercase tracking-wide"
          }
        >
          EQ.
        </span>
      ) : null}
    </span>
  );
}

/**
 * Issue #4385 (DD18 pick: Option C): the background-agent breakout under the
 * "Session total" row — "Background agents · N" with the "+Y" they added (already
 * inside the session total), then one row per stored agent. Each row opens the
 * agents modal straight into that agent's peek (T27), so a finished agent's
 * transcript stays reachable after the badge clears. The truncated description
 * keeps its full text in the row's `title` (and in the peek). Without an open
 * handler the rows render as plain text.
 */
/**
 * 2026-10-05: the breakout is COLLAPSIBLE and CAPPED. The header row is a
 * chevron toggle (`collapsed` / `onToggle`, persisted per session by the
 * caller through `uiCollapseState.backgroundAgentsCollapsed`, so the choice
 * follows the session across devices and federation nodes). The agent rows
 * live in a scroll region capped at FIVE rows, so a long agent list can no
 * longer grow the expanded widget until the "Usage per turn" sparkline falls
 * off the bottom of a phone screen (the 9-agent trigger case).
 */
const BACKGROUND_AGENT_ROW_PX = 19; // 10px text at the inherited 1.5 line-height (15px) + py-0.5 (4px); measured against the built stylesheet 2026-10-05
const BACKGROUND_AGENT_ROW_GAP_PX = 2; // gap-0.5
const BACKGROUND_AGENT_ROWS_VISIBLE = 5;
/** Height of exactly five rows plus the four gaps between them. */
export const BACKGROUND_AGENT_ROWS_MAX_PX =
  BACKGROUND_AGENT_ROWS_VISIBLE * BACKGROUND_AGENT_ROW_PX +
  (BACKGROUND_AGENT_ROWS_VISIBLE - 1) * BACKGROUND_AGENT_ROW_GAP_PX;

function BackgroundAgentBreakout({
  usage,
  onOpenAgent,
  collapsed = false,
  onToggle,
}: {
  usage: BackgroundAgentUsage;
  onOpenAgent?: (agentId: string) => void;
  /** Header-only when true; the per-agent rows are not rendered. */
  collapsed?: boolean;
  /** Header tap. Absent → the header renders as plain text (no chevron). */
  onToggle?: () => void;
}) {
  const added = rawTokenTotal(usage);
  const title = `+${formatTokens(added)} from ${usage.count} background agent${usage.count === 1 ? "" : "s"} — their full usage, recorded when each finished, already included in the Session total`;
  const headerBody = (
    <>
      <span className="flex items-center gap-1 text-[var(--app-fg)]">
        {onToggle ? (
          <ChevronRight
            aria-hidden="true"
            className={`h-3 w-3 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
          />
        ) : null}
        Background agents · {usage.count}
      </span>
      <span data-testid="token-usage-background-added">
        incl. +{formatTokens(added)}
      </span>
    </>
  );
  return (
    <div
      data-testid="token-usage-background-agents"
      data-collapsed={collapsed ? "true" : "false"}
      className="flex flex-col gap-0.5 rounded-md border border-[var(--app-hover)] px-1.5 py-1"
    >
      {onToggle ? (
        <BareButton
          type="button"
          data-testid="token-usage-background-agents-toggle"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} background agents`}
          onClick={onToggle}
          title={title}
          className="flex w-full items-center justify-between rounded px-0.5 text-left text-[length:var(--text-caption-xs)] font-normal text-[var(--app-hint)] transition-colors hover:bg-[var(--app-hover)]"
        >
          {headerBody}
        </BareButton>
      ) : (
        <div className="flex items-center justify-between" title={title}>
          {headerBody}
        </div>
      )}
      {collapsed ? null : (
        <div
          data-testid="token-usage-background-agents-rows"
          className="flex flex-col gap-0.5 overflow-y-auto"
          style={{ maxHeight: BACKGROUND_AGENT_ROWS_MAX_PX }}
        >
          {usage.agents.map(agent => {
            const agentType = agent.agentType ?? "agent";
            const description = agent.description ?? "";
            const tokens = formatTokens(rawTokenTotal(agent));
            const rowBody = (
              <>
                <span className="max-w-[45%] shrink-0 truncate font-medium text-[var(--app-fg)]">
                  {agentType}
                </span>
                <span className="min-w-0 flex-1 truncate">{description}</span>
                <span className="shrink-0 tabular-nums">{tokens}</span>
              </>
            );
            const title = `${agentType}${description ? ` — ${description}` : ""} · ${tokens} tokens`;
            return onOpenAgent ? (
              <BareButton
                key={agent.agentId}
                type="button"
                data-testid={`token-usage-background-agent-${agent.agentId}`}
                onClick={() => onOpenAgent(agent.agentId)}
                title={`${title} — open the transcript`}
                className="flex w-full items-center justify-start gap-1 whitespace-normal rounded px-0.5 py-0.5 text-left text-[length:var(--text-caption-xs)] font-normal text-[var(--app-hint)] transition-colors hover:bg-[var(--app-hover)]"
              >
                {rowBody}
                <ChevronRight className="h-3 w-3 shrink-0" />
              </BareButton>
            ) : (
              <div
                key={agent.agentId}
                data-testid={`token-usage-background-agent-${agent.agentId}`}
                title={title}
                className="flex w-full items-center gap-1 px-0.5 py-0.5"
              >
                {rowBody}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Expanded widget body — stacked bar, legend, stats, sparkline. */
function TokenUsageDetails({
  stats,
  contextBudget,
  resolvedModel,
  serverCost,
  isServerSourced,
  authBindingKind,
  costSplit,
  backgroundAgentUsage,
  onOpenBackgroundAgent,
  backgroundAgentsCollapsed,
  onBackgroundAgentsCollapseChange,
}: {
  stats: SessionTokenStats;
  contextBudget: number | null;
  /** Issue #4824: the server's split of the session total by each turn's
   *  recorded binding (real / equivalent / unattributed). */
  costSplit?: SessionCostSplit | null;
  /** 2026-10-05: the breakout's collapsed state (per-session, synced). Absent →
   *  uncontrolled, starting expanded. */
  backgroundAgentsCollapsed?: boolean;
  onBackgroundAgentsCollapseChange?: (collapsed: boolean) => void;
  /** Issue #4385: the token-stats breakout; its sums are already in `stats`. */
  backgroundAgentUsage?: BackgroundAgentUsage;
  /** Issue #4385: open the agents modal on one agent's peek (T27). */
  onOpenBackgroundAgent?: (agentId: string) => void;
  resolvedModel?: string;
  serverCost?: number | null;
  isServerSourced?: boolean;
  /** Issue #3353: the session's auth binding (#3351) — the real-vs-EQ cost
   *  discriminator. Absent → neutral (legacy / pre-#3351 session). */
  authBindingKind?: AuthBinding["kind"];
}) {
  // Issue #2027: cumulative session-token total INCLUDING cache (input + output +
  // cache-read + cache-write), relocated off the composer StatusBar. Issue #4344
  // removed the cache-blind input+output-only "total" line from this panel, so this
  // is now the single throughput figure. Always rendered (no nonzero gate).
  const sessionTotal =
    stats.totalInput +
    stats.totalOutput +
    stats.totalCacheRead +
    stats.totalCacheCreation;
  // Controlled when the caller supplies the synced value; otherwise a local
  // fallback so the toggle still works for callers that do not persist it.
  const [localBgCollapsed, setLocalBgCollapsed] = useState(false);
  const bgCollapsed = backgroundAgentsCollapsed ?? localBgCollapsed;
  const toggleBgCollapsed = useCallback(() => {
    const next = !bgCollapsed;
    setLocalBgCollapsed(next);
    onBackgroundAgentsCollapseChange?.(next);
  }, [bgCollapsed, onBackgroundAgentsCollapseChange]);
  const costDisplay = resolveCostDisplay({
    stats,
    resolvedModel,
    serverCost,
    isServerSourced,
    authBindingKind,
    costSplit,
  });

  // Chart series → metric mapping (#3434 · epic #3354): series 1 = cache-read,
  // 2 = cache-write, 3 = output — read via the typed `tokens.chart[N]` accessor
  // (a `var(--chart-N)` reference), matching the `tokens.accent` "New input"
  // segment below. --chart-3 ≡ --accent-amber-500 by hex only, not semantics —
  // a distinct data-series token (see tokens.css).
  const allSegments: Segment[] = [
    { label: "New input", value: stats.totalInput, color: tokens.accent },
    {
      label: "Cache read",
      value: stats.totalCacheRead,
      color: tokens.chart[1],
    },
    {
      label: "Cache write",
      value: stats.totalCacheCreation,
      color: tokens.chart[2],
    },
    { label: "Output", value: stats.totalOutput, color: tokens.chart[3] },
  ];

  return (
    <div className="flex flex-col gap-1.5 text-[length:var(--text-caption-xs)] text-[var(--app-hint)] pt-1">
      {/* Turns. Issue #4344 removed the input+output-only "{total} total" figure
          that used to lead this line — it was cache-blind (e.g. 638 new input
          against 165M cache reads). The cache-inclusive "Session total" row below
          is the single throughput figure; the heading shows context fill. The
          "est." marker rides the turns count so it never renders as a bare label. */}
      <div className="flex items-baseline justify-end">
        <span>
          {stats.turnCount} turns
          {!isServerSourced ? (
            <span
              className={
                /* design-tokens-allow: 9px sub-floor "est." micro-label, below the 10px --text-caption-xs ladder floor (permanent sub-floor exception #3336) (L8 #3410) */ "ml-1 text-[9px] uppercase tracking-wide opacity-70"
              }
              title="Client-side estimate — server token totals unavailable; may undercount (paged history: 50 initial / 200 per load-older + browser memory)"
            >
              est.
            </span>
          ) : null}
        </span>
      </div>

      {/* Stacked bar */}
      <StackedBar segments={allSegments} />

      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {allSegments.map(seg =>
          seg.value > 0 ? (
            <span key={seg.label} className="flex items-center gap-1">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: seg.color }}
              />
              {seg.label}: {formatTokens(seg.value)}
            </span>
          ) : null
        )}
      </div>

      {/* Stats row */}
      <div className="flex items-center justify-between border-t border-[var(--app-hover)] pt-1">
        <span>Peak: {formatTokens(stats.peakContextSize)}</span>
        {contextBudget ? (
          <span>Budget: {formatTokens(contextBudget)}</span>
        ) : null}
      </div>

      {/* Issue #2027: cumulative session-token total (input+output+cache),
          relocated from the composer StatusBar. Issue #4344 removed the cache-blind
          input+output-only "total" line, so this is the single throughput figure;
          distinct from the heading's context-fill figure. */}
      <div className="flex items-center justify-between">
        <span title="Cumulative session tokens (input + output + cache) from v_session_totals">
          Session total
          {!isServerSourced ? (
            <span
              className={
                /* design-tokens-allow: 9px sub-floor "est." micro-label, below the 10px --text-caption-xs ladder floor (permanent sub-floor exception #3336) (L8 #3410) */ "ml-1 text-[9px] uppercase tracking-wide opacity-70"
              }
              title="Client-side estimate — server token totals unavailable; may undercount"
            >
              est.
            </span>
          ) : null}
        </span>
        <span>{formatTokens(sessionTotal)}</span>
      </div>

      {/* Issue #4385 (DD18 Option C): background agents' share of the session
          total + per-agent rows. Beside the Session total row, never in the
          context heading — their tokens do not occupy this context window (T13). */}
      {backgroundAgentUsage && backgroundAgentUsage.count > 0 ? (
        <BackgroundAgentBreakout
          usage={backgroundAgentUsage}
          onOpenAgent={onOpenBackgroundAgent}
          collapsed={bgCollapsed}
          onToggle={toggleBgCollapsed}
        />
      ) : null}

      {/* Issue #4385 (R4): quota-weighted estimate of the same total — cache
          read ×0.1, cache write ×1.25 (`weightedQuotaTokens`). Always labelled
          an estimate, in words: the "est." micro-marker in this panel already
          means "client-side estimate, server totals unavailable". */}
      <div className="flex items-center justify-between">
        <span title="Estimate: input + output + 0.1 × cache read + 1.25 × cache write. Not a bill — how heavily the session drew on a plan's limit.">
          Quota-weighted estimate
        </span>
        <span data-testid="token-usage-quota-weighted">
          ≈
          {formatTokens(
            weightedQuotaTokens({
              in: stats.totalInput,
              out: stats.totalOutput,
              cacheRead: stats.totalCacheRead,
              cacheWrite: stats.totalCacheCreation,
            })
          )}
        </span>
      </div>

      {/* Issue #3353: cumulative cost with the real-vs-EQ treatment (keyed on
          authBindingKind only — no per-flavor conditional). "real" → mint "API
          cost"; "equivalent" → EQ-blue "API value" + an "EQ." marker; "neutral"
          (inherited/absent) → "—", no cost claim. The server-vs-estimate label is
          preserved as the "cost" vs "value" wording + the (est.) suffix/tooltip.
          Issue #4824: a session whose turns ran under both a key and a
          subscription shows both accumulators, each labelled. */}
      {costDisplay.mode === "dual" ? (
        <>
          <div className="flex items-center justify-between">
            <span>API cost</span>
            <ApiValueFigure value={costDisplay.real} />
          </div>
          <div className="flex items-center justify-between">
            <span>API value</span>
            <ApiValueFigure value={costDisplay.equivalent} />
          </div>
        </>
      ) : costDisplay.value.usd !== null ? (
        <div className="flex items-center justify-between">
          <span>
            {costDisplay.value.treatment === "real" ? "API cost" : "API value"}
          </span>
          {costDisplay.value.treatment === "neutral" ? (
            <span>—</span>
          ) : (
            <ApiValueFigure
              value={{ ...costDisplay.value, usd: costDisplay.value.usd }}
            />
          )}
        </div>
      ) : null}

      {/* Sparkline */}
      {stats.timeline.length >= 2 ? (
        <div className="flex flex-col gap-0.5">
          <span
            className={
              /* design-tokens-allow: 9px sub-floor sparkline label, below the 10px ladder floor (#3336) (L8 #3410) */ "text-[9px]"
            }
          >
            Usage per turn
          </span>
          <Sparkline data={stats.timeline} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Room the full heading must have to spare. `scrollWidth`/`clientWidth` are
 * integers, so a truncating neighbor can be clipping up to a pixel the
 * measurement cannot see — and a sub-pixel overflow is enough to ellipsize it.
 */
const FIT_SLACK_PX = 1;
/**
 * Extra room required to bring the fraction BACK. Showing and hiding it are
 * measured on two different layouts whose sums agree only to float precision,
 * so one shared threshold would flip-flop on an exact fit.
 */
const FIT_HYSTERESIS_PX = 1;

/**
 * Does the FULL collapsed heading — fraction included — fit its merged dock
 * row? Answered from natural widths, so it does not depend on whether the
 * fraction is on screen: asking "does the row overflow right now?" would
 * oscillate, because hiding the fraction frees the room that lets it fit.
 */
export function fullHeadingFits(m: {
  /** The row's width. */
  rowWidth: number;
  /** The row's other members at their natural widths, plus every row gap. */
  othersWidth: number;
  /** The heading as rendered now. */
  headingWidth: number;
  /** The fraction's width including its left margin. */
  fractionWidth: number;
  /** Whether `headingWidth` already includes the fraction. */
  fractionShown: boolean;
}): boolean {
  // Nothing measurable (jsdom, or a row that is not laid out): the full
  // heading is the default.
  if (m.rowWidth <= 0) return true;
  const fullWidth = m.headingWidth + (m.fractionShown ? 0 : m.fractionWidth);
  const spare = FIT_SLACK_PX + (m.fractionShown ? 0 : FIT_HYSTERESIS_PX);
  return m.othersWidth + fullWidth + spare <= m.rowWidth;
}

/**
 * Issue #4824 (expert-review ruling R2): the SECOND rung. A session with both a
 * real and an equivalent figure shows "$b · $a EQ." in its collapsed heading;
 * when the heading still overflows with the fraction already hidden, the EQ
 * part leaves the COLLAPSED heading too and the mint real figure stays (the
 * expanded view always shows both). Asks, from natural widths like
 * {@link fullHeadingFits}: does the heading WITHOUT the fraction but WITH the
 * EQ part fit? (Hysteresis on the way back, for the same flip-flop reason.)
 */
export function eqFigureFits(m: {
  rowWidth: number;
  othersWidth: number;
  /** The heading as rendered now. */
  headingWidth: number;
  /** The fraction's width including its left margin (0 when there is none). */
  fractionWidth: number;
  fractionShown: boolean;
  /** The EQ part's width including its left margin. */
  eqWidth: number;
  /** Whether `headingWidth` already includes the EQ part. */
  eqShown: boolean;
}): boolean {
  if (m.rowWidth <= 0) return true;
  const width =
    m.headingWidth -
    (m.fractionShown ? m.fractionWidth : 0) +
    (m.eqShown ? 0 : m.eqWidth);
  const spare = FIT_SLACK_PX + (m.eqShown ? 0 : FIT_HYSTERESIS_PX);
  return m.othersWidth + width + spare <= m.rowWidth;
}

/**
 * The flex row a heading is laid out in, and the row member that holds it —
 * for the chromeless heading, SessionChat's merged dock row, whose members
 * are the collapsed headings. Found by layout (the nearest flex-container
 * ancestor), so the row's owner needs no cooperating marker.
 */
function findFlexRow(
  heading: HTMLElement
): { row: HTMLElement; member: HTMLElement } | null {
  let member = heading;
  for (let row = heading.parentElement; row; row = row.parentElement) {
    const display = getComputedStyle(row).display;
    if (display === "flex" || display === "inline-flex") return { row, member };
    member = row;
  }
  return null;
}

/**
 * Collapsible Token Usage section — mirrors the Prompt/Notes +/- pattern.
 *
 * Collapsed: `+ Context  XX% left  (used / window)  $API value`
 *            (`+ Context  XX% left  $API value` when the merged dock row is
 *            too narrow for all of it)
 * Expanded:  `- Context` + stacked bar, legend, sparkline
 *
 * Issue #4385 (DD18 Option C): with a `sessionId`, the section reads the
 * session's token-stats breakout itself (the SAME cached query the caller's
 * totals come from — no extra request) and owns the T27 deep link: a breakdown
 * row opens `BackgroundAgentsModal` straight into that agent's peek. Without a
 * `sessionId` it renders what it is given (`backgroundAgentUsage` /
 * `onOpenBackgroundAgent` props).
 */
export function TokenUsageSection(
  props: ComponentProps<typeof TokenUsageSectionView> & { sessionId?: string }
) {
  const { sessionId, ...rest } = props;
  if (sessionId) {
    return <TokenUsageSectionWithAgents {...rest} sessionId={sessionId} />;
  }
  return <TokenUsageSectionView {...rest} />;
}

/** #4385: the connected form — breakout data + the modal deep link. */
function TokenUsageSectionWithAgents({
  sessionId,
  ...rest
}: ComponentProps<typeof TokenUsageSectionView> & { sessionId: string }) {
  const { api } = useAppContext();
  const { data } = useSessionTokenStats(api, sessionId);
  const [peekAgentId, setPeekAgentId] = useState<string | null>(null);
  return (
    <>
      <TokenUsageSectionView
        {...rest}
        // Only beside SERVER totals — its sums are folded into those, never
        // into the client-side estimate.
        backgroundAgentUsage={
          rest.isServerSourced ? data?.backgroundAgentUsage : undefined
        }
        onOpenBackgroundAgent={setPeekAgentId}
      />
      {/* Mounted only while open, so a closed modal never runs its reads. */}
      {peekAgentId !== null && (
        <BackgroundAgentsModal
          sessionId={sessionId}
          open
          onOpenChange={open => {
            if (!open) setPeekAgentId(null);
          }}
          initialAgentId={peekAgentId}
        />
      )}
    </>
  );
}

function TokenUsageSectionView({
  stats,
  resolvedModel,
  contextWindowTokens,
  contextPercentage,
  contextUsedTokens,
  contextSize,
  initialCollapsed,
  onCollapseChange,
  serverCost,
  isServerSourced,
  authBindingKind,
  costSplit,
  chromeless,
  backgroundAgentUsage,
  onOpenBackgroundAgent,
  backgroundAgentsCollapsed,
  onBackgroundAgentsCollapseChange,
}: {
  stats: SessionTokenStats;
  /** Issue #4824: the server's split of `serverCost` by each turn's recorded
   *  binding (`v_session_totals` real / equivalent / unattributed). Absent or
   *  all-null → the single combined figure, as before. */
  costSplit?: SessionCostSplit | null;
  resolvedModel?: string;
  contextWindowTokens?: number;
  contextPercentage?: number;
  /** Issue #4344: the exact context fill (get_context_usage total) — the heading's
   *  used figure. Precedence over the contextPercentage-derived and contextSize
   *  fallbacks. Follows the context (falls after compaction), unlike the lifetime
   *  input+output total that previously drove the heading. */
  contextUsedTokens?: number;
  contextSize?: number;
  initialCollapsed?: boolean;
  onCollapseChange?: (collapsed: boolean) => void;
  /** Issue #1671: rate-card-computed session cost (v_session_totals.total_cost). */
  serverCost?: number | null;
  /** Issue #1671: true when `stats` are derived from the server view (not the
   *  client aggregate) — drives the authoritative-vs-estimate labelling (R7). */
  isServerSourced?: boolean;
  /** Issue #3353: the session's auth binding (#3351) — the real-vs-EQ cost
   *  discriminator, forwarded to the cumulative cost row. */
  authBindingKind?: AuthBinding["kind"];
  /**
   * Issue #1079: render the COLLAPSED heading without the full-width chrome
   * (`w-full text-left`) so the parent merged-row flex container owns horizontal
   * layout and can right-anchor it (R4). No effect on the expanded render.
   */
  chromeless?: boolean;
  /** Issue #4385: the token-stats `backgroundAgentUsage` breakout (its sums are
   *  already folded into `stats`). */
  backgroundAgentUsage?: BackgroundAgentUsage;
  /** Issue #4385 (T27): open the agents modal straight into one agent's peek
   *  from a breakdown row. Absent → the rows render as plain text. */
  onOpenBackgroundAgent?: (agentId: string) => void;
  /** 2026-10-05: the Background Agents breakout's collapsed state — per-session
   *  server state (`uiCollapseState.backgroundAgentsCollapsed`), synced across
   *  devices and nodes like the widget's own +/- state. Absent → uncontrolled. */
  backgroundAgentsCollapsed?: boolean;
  onBackgroundAgentsCollapseChange?: (collapsed: boolean) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(!initialCollapsed);
  const toggleExpanded = useCallback(() => {
    // #1079: call onCollapseChange OUTSIDE the setState updater. The parent
    // (SessionChat) updates its own collapse state synchronously in the handler,
    // and a parent setState from inside a child's updater triggers React's
    // "cannot update a component while rendering a different component" warning.
    const next = !isExpanded;
    setIsExpanded(next);
    onCollapseChange?.(!next);
  }, [isExpanded, onCollapseChange]);

  const contextBudget = getContextBudgetTokens(contextWindowTokens);

  // The API value, inline in the heading after the context figures — the same
  // figure, formatted the same way, as the expanded "API value" row, so the
  // cost is visible without expanding the widget. Omitted when there is no
  // attributable amount (neutral binding / no price): the expanded row labels
  // that case "—", which says nothing without its label. Issue #4824: a
  // session with both accumulators shows both, mint first ("$b · $a EQ.").
  const costDisplay = resolveCostDisplay({
    stats,
    resolvedModel,
    serverCost,
    isServerSourced,
    authBindingKind,
    costSplit,
  });
  const dual = costDisplay.mode === "dual";
  const hasHeadingCost =
    dual ||
    (costDisplay.value.usd !== null &&
      costDisplay.value.treatment !== "neutral");

  // Heading summary (issue #4344): context fill vs the TOTAL context window (raw
  // size, not the headroom-adjusted budget), consistent with `% left`. The used
  // figure is the context the model currently holds (it falls after a compaction),
  // NOT the cumulative input+output lifetime total. Precedence mirrors percentLeft:
  // the first-order get_context_usage value (contextUsedTokens), then the
  // percentage-derived figure, then the client-side contextSize estimate.
  const headingSummary = useMemo(() => {
    if (!contextWindowTokens) return null;
    let contextUsed: number | null = null;
    if (typeof contextUsedTokens === "number") {
      contextUsed = contextUsedTokens;
    } else if (typeof contextPercentage === "number") {
      contextUsed = Math.round((contextPercentage / 100) * contextWindowTokens);
    } else if (typeof contextSize === "number") {
      contextUsed = contextSize;
    }
    if (contextUsed === null) return null;
    return `(${formatTokens(contextUsed)} / ${formatTokens(contextWindowTokens)})`;
  }, [contextUsedTokens, contextPercentage, contextWindowTokens, contextSize]);

  // Compute % left based on latest context size (what the model actually sees)
  const percentLeft = useMemo(() => {
    let pctRemaining: number | null = null;
    if (typeof contextPercentage === "number") {
      // First-order: get_context_usage.percentage is authoritative usage.
      pctRemaining = Math.max(0, 100 - contextPercentage);
    } else if (contextBudget && contextSize) {
      // Fallback: derive from the accumulated client-side estimate.
      pctRemaining = Math.max(0, 100 - (contextSize / contextBudget) * 100);
    }
    if (pctRemaining === null) return null;
    let color = "text-[var(--accent-blue-400)]"; // light blue default (--accent-blue-400 ≡ #60a5fa, exact-token swap)
    if (pctRemaining <= 5) color = "text-red-500";
    else if (pctRemaining <= 10) color = "text-amber-500";
    return { pct: Math.round(pctRemaining), color };
  }, [contextPercentage, contextBudget, contextSize]);

  // In the merged dock row the fraction is the first thing to give way: when
  // the row cannot hold every heading at its natural width, this heading drops
  // "(used / window)" and reads "% left" + the API value. It applies only when
  // there is an API value to make room for. The fit is MEASURED, not a
  // breakpoint (the IssueStateBadge reasoning): the widths in play — the
  // figure, the Notes counter, whether Prompt has joined the row — vary too
  // much for one threshold, and a phone-width row holding only this heading
  // has room for everything.
  //
  // Issue #4824 (ruling R2): a second rung below that — when the heading with
  // both cost figures still overflows after the fraction has gone, the EQ part
  // leaves the collapsed heading and the mint real figure stays. The hidden
  // members stay in the DOM, out of layout, so both can be measured on the way
  // back.
  const fractionRef = useRef<HTMLSpanElement>(null);
  const eqRef = useRef<HTMLSpanElement>(null);
  const [fractionFits, setFractionFits] = useState(true);
  const [eqFits, setEqFits] = useState(true);
  const measuresFit = Boolean(
    chromeless && !isExpanded && hasHeadingCost && (headingSummary || dual)
  );
  // Measures the collapsed heading against its row and sets BOTH rungs: whether
  // the token fraction fits, and (#4824) whether the EQ figure fits.
  const measureHeadingFit = useCallback(() => {
    const fraction = fractionRef.current;
    const eq = eqRef.current;
    const anchor = fraction ?? eq;
    const placed = anchor?.parentElement
      ? findFlexRow(anchor.parentElement)
      : null;
    if (!anchor || !placed) return;
    const { row, member: own } = placed;
    const members = Array.from(row.children);
    let othersWidth =
      (parseFloat(getComputedStyle(row).columnGap) || 0) * (members.length - 1);
    for (const member of members) {
      if (member === own) continue;
      othersWidth += member.getBoundingClientRect().width;
      // A member that ellipsizes (Notes) has already given up width; add back
      // what it is clipping to get its natural width.
      for (const clipped of member.querySelectorAll<HTMLElement>(".truncate")) {
        othersWidth += Math.max(0, clipped.scrollWidth - clipped.clientWidth);
      }
    }
    const widthWithMargin = (el: HTMLElement | null): number =>
      el
        ? el.getBoundingClientRect().width +
          (parseFloat(getComputedStyle(el).marginLeft) || 0)
        : 0;
    const rowWidth = row.getBoundingClientRect().width;
    const headingWidth = own.getBoundingClientRect().width;
    const fractionWidth = widthWithMargin(fraction);
    const fractionShown = fraction?.getAttribute("aria-hidden") !== "true";
    const eqWidth = widthWithMargin(eq);
    const eqShown = eq !== null && eq.getAttribute("aria-hidden") !== "true";
    setFractionFits(
      fullHeadingFits({
        rowWidth,
        othersWidth,
        // The FULL heading includes the EQ part even while it is hidden.
        headingWidth: headingWidth + (eq && !eqShown ? eqWidth : 0),
        fractionWidth,
        fractionShown: fraction !== null && fractionShown,
      })
    );
    setEqFits(
      eqFigureFits({
        rowWidth,
        othersWidth,
        headingWidth,
        fractionWidth,
        fractionShown: fraction !== null && fractionShown,
        eqWidth,
        eqShown,
      })
    );
  }, []);
  useLayoutEffect(() => {
    if (!measuresFit) return;
    measureHeadingFit();
    const heading = (fractionRef.current ?? eqRef.current)?.parentElement;
    const row = heading ? findFlexRow(heading)?.row : null;
    if (!row || typeof ResizeObserver === "undefined") return;
    // The row resizes on rotation or a dragged split pane; a member resizes
    // when its own text changes (the Notes counter, these figures).
    const observer = new ResizeObserver(() => measureHeadingFit());
    observer.observe(row);
    for (const member of Array.from(row.children)) observer.observe(member);
    return () => observer.disconnect();
  }, [measuresFit, measureHeadingFit]);
  const fractionHidden = measuresFit && !fractionFits;
  const eqHidden = measuresFit && dual && !fractionFits && !eqFits;

  const headingApiValue =
    costDisplay.mode === "dual" ? (
      <>
        <ApiValueFigure value={costDisplay.real} className="ml-2" />
        <span
          ref={eqRef}
          data-testid="token-usage-heading-eq"
          aria-hidden={eqHidden ? true : undefined}
          className={`ml-1${eqHidden ? " invisible absolute left-0 top-0" : ""}`}
        >
          <span className="text-[var(--app-hint)]">·</span>
          <ApiValueFigure value={costDisplay.equivalent} className="ml-1" />
        </span>
      </>
    ) : hasHeadingCost && costDisplay.value.usd !== null ? (
      <ApiValueFigure
        value={{ ...costDisplay.value, usd: costDisplay.value.usd }}
        className="ml-2"
      />
    ) : null;

  if (!isExpanded) {
    return (
      <Button
        type="button"
        variant="ghostStatic"
        onClick={toggleExpanded}
        className={`relative h-auto justify-start rounded-none px-1 py-1 text-xs font-normal text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)] ${
          chromeless
            ? "min-h-[var(--control-touch)] whitespace-nowrap"
            : "w-full text-left"
        }`}
      >
        <span>+ Context</span>
        {percentLeft ? (
          <span className={`ml-2 ${percentLeft.color}`}>
            {percentLeft.pct}% left
          </span>
        ) : null}
        {/* The fraction stays in the DOM when it does not fit — out of layout
            and invisible — so its width can still be measured for the way
            back (the IssueStateBadge rung technique). */}
        {headingSummary ? (
          <span
            ref={fractionRef}
            aria-hidden={fractionHidden ? true : undefined}
            className={`ml-2 text-[var(--app-hint)]${
              fractionHidden ? " invisible absolute left-0 top-0" : ""
            }`}
          >
            {headingSummary}
          </span>
        ) : null}
        {headingApiValue}
      </Button>
    );
  }

  return (
    <div className="space-y-1">
      {/* Header row */}
      <div className="flex items-center justify-between px-1">
        <Button
          type="button"
          variant="ghostStatic"
          onClick={toggleExpanded}
          className="h-auto justify-start p-0 text-xs font-normal transition-opacity hover:text-[var(--app-fg)] hover:opacity-80"
        >
          <span className="text-[var(--app-fg)]">- Context</span>
          {percentLeft ? (
            <span className={`ml-2 ${percentLeft.color}`}>
              {percentLeft.pct}% left
            </span>
          ) : null}
          {headingSummary ? (
            <span className="ml-2 text-[var(--app-hint)]">
              {headingSummary}
            </span>
          ) : null}
          {headingApiValue}
        </Button>
      </div>

      {/* Widget body */}
      <div className="px-1">
        <TokenUsageDetails
          stats={stats}
          contextBudget={contextBudget}
          resolvedModel={resolvedModel}
          serverCost={serverCost}
          isServerSourced={isServerSourced}
          authBindingKind={authBindingKind}
          costSplit={costSplit}
          backgroundAgentUsage={backgroundAgentUsage}
          onOpenBackgroundAgent={onOpenBackgroundAgent}
          backgroundAgentsCollapsed={backgroundAgentsCollapsed}
          onBackgroundAgentsCollapseChange={onBackgroundAgentsCollapseChange}
        />
      </div>
    </div>
  );
}
