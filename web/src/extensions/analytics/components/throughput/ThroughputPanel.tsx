// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import type { ApiClient } from "@/api/client";
import type { ThroughputLine, ThroughputSummary } from "@/types/api";
import {
  useThroughputSummary,
  type ThroughputRange,
} from "../../hooks/useThroughput";
import { ThroughputBreakdownTable } from "./ThroughputBreakdownTable";
import { ThroughputCostChart } from "./ThroughputCostChart";
import { ThroughputDigests } from "./ThroughputDigests";
import { ThroughputTestsTable } from "./ThroughputTestsTable";
import {
  costSplit,
  formatCount,
  formatHours,
  formatPct,
  formatTokens,
  formatUsd,
  labelOf,
} from "./format";

type Percentiles = ThroughputSummary["context"]["main"];

/**
 * The Analytics page's Throughput tab (issue #6164, A1 — R9): cost and its
 * cache split, breakdowns, context, waits, effort and model, lead time,
 * quality, tests, quota, points and the weekly digests, with coverage first —
 * which nodes and sources the numbers come from, and what is missing.
 *
 * Every query lives in this tab's components, so nothing loads until the tab
 * is opened (Radix unmounts inactive tab content).
 */
export function ThroughputPanel({
  api,
  range,
}: {
  api: ApiClient | null;
  range: ThroughputRange;
}) {
  const { summary, isLoading, error } = useThroughputSummary(api, range);
  if (isLoading) {
    return (
      <div className="flex h-48 items-center justify-center text-[var(--app-muted)]">
        Loading...
      </div>
    );
  }
  if (error || !summary) {
    return (
      <div className="rounded-lg bg-[var(--app-secondary-bg)] p-4 text-sm text-[var(--app-muted)]">
        Throughput telemetry is not available on this node
        {error ? ` (${error})` : ""}.
      </div>
    );
  }
  const s = summary;
  return (
    <div className="space-y-6" data-testid="throughput-panel">
      <Tiles
        items={[
          ["API-equivalent cost", formatUsd(s.totals.usd.total)],
          ["Turns", formatCount(s.totals.turns)],
          ["Served from cache", formatPct(s.totals.cacheServedShare)],
          [
            "Issues closed",
            s.github.available ? formatCount(s.github.closedIssues) : "—",
          ],
        ]}
      />

      <Section title="Coverage">
        <Coverage s={s} />
      </Section>

      <Section title="Cost and split">
        <ThroughputCostChart byDay={s.byDay} />
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <SimpleTable
            head={["Category", "Cost", "Share"]}
            rows={costSplit(s.totals.usd).map(r => [
              r.label,
              formatUsd(r.usd),
              formatPct(r.share),
            ])}
            footer={["Total", formatUsd(s.totals.usd.total), ""]}
          />
          <LineTable title="Source" lines={s.bySource} />
        </div>
      </Section>

      <Section title="Breakdown">
        <ThroughputBreakdownTable api={api} range={range} />
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Stages">
          <LineTable title="Stage" lines={s.byStage} />
        </Section>
        <Section title="Models and nodes">
          <LineTable title="Model" lines={s.byModel} />
          <div className="mt-3">
            <LineTable title="Node" lines={s.byNode} />
          </div>
        </Section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Context per call">
          <SimpleTable
            head={["Calls", "n", "p50", "p90", "p99"]}
            rows={(
              [
                ["Main chain", s.context.main],
                ["All calls", s.context.all],
                ["Starting context", s.context.start],
              ] as Array<[string, Percentiles]>
            ).map(([label, q]) => [
              label,
              formatCount(q.n),
              formatTokens(q.p50),
              formatTokens(q.p90),
              formatTokens(q.p99),
            ])}
          />
          <p className="mt-2 text-xs text-[var(--app-muted)]">
            {s.context.startMethodNote}
          </p>
        </Section>
        <Section title="Waits">
          <SimpleTable
            head={["After an idle gap, started by", "Rewrites", "Cost"]}
            rows={s.idle.map(i => [
              labelOf(i.cls),
              formatCount(i.n),
              formatUsd(i.usd),
            ])}
            empty="No post-idle cache rewrites in this window."
          />
        </Section>
      </div>

      <Section title="Effort and model">
        <SimpleTable
          head={["Effort", "Model", "Calls"]}
          rows={s.effort.map(e => [e.effort, e.model, formatCount(e.calls)])}
          empty="No effort recorded in this window."
        />
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Lead time">
          {s.github.available ? (
            <>
              <p className="mb-2 text-xs text-[var(--app-fg)]">
                Median {formatHours(s.github.leadTimeHours.p50)}, p90{" "}
                {formatHours(s.github.leadTimeHours.p90)} over{" "}
                {formatCount(s.github.leadTimeHours.n)} delivered issues.
              </p>
              <SimpleTable
                head={["Stage", "n", "p50", "p90"]}
                rows={s.github.stageHours.map(st => [
                  st.stage.replaceAll("_", " "),
                  formatCount(st.n),
                  formatHours(st.p50),
                  formatHours(st.p90),
                ])}
              />
            </>
          ) : (
            <Muted>{s.github.reason}</Muted>
          )}
        </Section>
        <Section title="Quality">
          {s.github.available ? (
            <Tiles
              small
              items={[
                ["Reopens", formatCount(s.github.reopens)],
                [
                  "Escaped defects",
                  `${formatCount(s.github.escapes)} (${formatPct(s.github.escapeRate)})`,
                ],
                ["Failed CI runs", formatCount(s.github.ciFailedRuns)],
                [
                  "CI failures per PR",
                  s.github.ciFailuresPerPr === null
                    ? "—"
                    : s.github.ciFailuresPerPr.toFixed(2),
                ],
                ["Trunk red", formatHours(s.github.trunkRedHours)],
                ["Merged PRs", formatCount(s.github.mergedPrs)],
              ]}
            />
          ) : (
            <Muted>{s.github.reason}</Muted>
          )}
        </Section>
      </div>

      <Section title="Tests that catch problems">
        <ThroughputTestsTable api={api} range={range} />
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title={`Weekly quota (${s.quota.label})`}>
          {s.quota.available ? (
            <div className="space-y-2 text-xs text-[var(--app-fg)]">
              <p>
                {formatCount(s.quota.fleet.accounts)}{" "}
                {s.quota.fleet.accounts === 1 ? "account" : "accounts"},{" "}
                {formatCount(s.quota.fleet.accountsWithHeadroom)} with headroom;{" "}
                {formatCount(Math.round(s.quota.fleet.headroomPp))} percentage
                points left, burning{" "}
                {s.quota.fleet.slopePpPerHour === null
                  ? "—"
                  : s.quota.fleet.slopePpPerHour.toFixed(2)}{" "}
                pp/h: runway {formatHours(s.quota.fleet.runwayHours)}.
              </p>
              {s.quota.weights?.status === "ok" && s.quota.weights.ppPerMTok ? (
                <SimpleTable
                  head={["Tokens", "pp per million"]}
                  rows={(
                    [
                      ["Input", s.quota.weights.ppPerMTok.in],
                      ["Output", s.quota.weights.ppPerMTok.out],
                      ["Cache read", s.quota.weights.ppPerMTok.cr],
                      ["1-hour write", s.quota.weights.ppPerMTok.w1],
                      ["5-minute write", s.quota.weights.ppPerMTok.w5],
                    ] as Array<[string, number]>
                  ).map(([k, v]) => [k, v.toFixed(4)])}
                  footer={[
                    `R² ${s.quota.weights.r2?.toFixed(2) ?? "—"}, n ${s.quota.weights.n}`,
                    "",
                  ]}
                />
              ) : (
                <Muted>
                  Weights: insufficient data
                  {s.quota.weights
                    ? ` (${s.quota.weights.n} usable days; 10 needed)`
                    : ""}
                  .
                </Muted>
              )}
            </div>
          ) : (
            <Muted>{s.quota.reason}</Muted>
          )}
        </Section>
        <Section title="Points">
          {s.github.points.available ? (
            <>
              <p className="mb-2 text-xs text-[var(--app-fg)]">
                {formatCount(s.github.points.total)} points delivered;{" "}
                {formatUsd(s.github.points.costPerPoint)} per point.
              </p>
              <SimpleTable
                head={["Lane", "Issues", "Points"]}
                rows={s.github.points.byLane.map(l => [
                  l.lane,
                  formatCount(l.issues),
                  formatCount(l.points),
                ])}
              />
            </>
          ) : (
            <Muted>{s.github.points.reason ?? "No lane labels yet."}</Muted>
          )}
        </Section>
      </div>

      <Section title="Weekly digests">
        <ThroughputDigests api={api} />
      </Section>

      {s.notes.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-xs text-[var(--app-muted)]">
          {s.notes.map(n => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg bg-[var(--app-secondary-bg)] p-4">
      <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--app-muted)]">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="text-xs text-[var(--app-muted)]">{children}</p>;
}

function Tiles({
  items,
  small = false,
}: {
  items: Array<[string, string]>;
  small?: boolean;
}) {
  return (
    <div className={`grid grid-cols-2 gap-3 ${small ? "" : "sm:grid-cols-4"}`}>
      {items.map(([label, value]) => (
        <div
          key={label}
          className={`rounded-lg p-3 ${small ? "bg-[var(--app-bg)]" : "bg-[var(--app-secondary-bg)]"}`}
        >
          <div className="text-xs uppercase tracking-wider text-[var(--app-muted)]">
            {label}
          </div>
          <div
            className={`mt-1 font-semibold text-[var(--app-fg)] ${small ? "text-base" : "text-2xl"}`}
          >
            {value}
          </div>
        </div>
      ))}
    </div>
  );
}

function SimpleTable({
  head,
  rows,
  footer,
  empty = "Nothing in this window.",
}: {
  head: string[];
  rows: string[][];
  footer?: string[];
  empty?: string;
}) {
  if (rows.length === 0) return <Muted>{empty}</Muted>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-[var(--app-muted)]">
          <tr>
            {head.map((h, i) => (
              <th
                key={h}
                className={`py-1 pr-2 font-medium ${i > 0 ? "text-right" : ""}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-[var(--app-fg)]">
          {rows.map(r => (
            <tr
              key={r.join("|")}
              className="border-t border-[var(--app-border)]"
            >
              {r.map((c, i) => (
                <td
                  key={i}
                  className={`py-1 pr-2 ${i > 0 ? "text-right" : ""}`}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer ? (
          <tfoot className="font-medium text-[var(--app-fg)]">
            <tr className="border-t border-[var(--app-border)]">
              {footer.map((c, i) => (
                <td
                  key={i}
                  className={`py-1 pr-2 ${i > 0 ? "text-right" : ""}`}
                >
                  {c}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

function LineTable({
  title,
  lines,
}: {
  title: string;
  lines: ThroughputLine[];
}) {
  return (
    <SimpleTable
      head={[title, "Turns", "Calls", "Cost"]}
      rows={lines.map(l => [
        labelOf(l.key),
        formatCount(l.turns ?? 0),
        formatCount(l.calls),
        formatUsd(l.usd.total),
      ])}
    />
  );
}

function Coverage({ s }: { s: ThroughputSummary }) {
  const c = s.coverage;
  return (
    <div className="space-y-2 text-xs text-[var(--app-fg)]">
      <SimpleTable
        head={["Node", "Turns", "With facts", "Last sync"]}
        rows={c.nodes.map(n => [
          n.local ? `${n.origin} (this node)` : n.origin,
          formatCount(n.turns),
          formatCount(n.withFacts),
          n.local
            ? "local"
            : n.lastSyncMs
              ? new Date(n.lastSyncMs).toLocaleString()
              : "never",
        ])}
        empty="No turns in this window."
      />
      <ul className="list-disc space-y-1 pl-5 text-[var(--app-muted)]">
        {c.sources.map(src => (
          <li key={src.source}>
            {src.source}: {src.status}
            {src.detail ? ` (${src.detail})` : ""}
          </li>
        ))}
        {c.missingNodes.map(m => (
          <li key={m.nodeId}>
            Missing {m.label ?? m.nodeId}: {m.reason}
          </li>
        ))}
        {c.nodesWithoutFacts.length > 0 ? (
          <li>
            Recent rows without facts (older binary):{" "}
            {c.nodesWithoutFacts.join(", ")}
          </li>
        ) : null}
        {c.notCollected.map(n => (
          <li key={n}>{n}</li>
        ))}
        <li>
          Rows without facts {formatCount(c.rowsWithoutFacts)}; recovered{" "}
          {formatCount(c.recoveredRows)}; unattributed account share{" "}
          {formatPct(c.unattributedAccountShare)}; fallback-priced share{" "}
          {formatPct(c.fallbackPricedShare)}.
        </li>
      </ul>
    </div>
  );
}
