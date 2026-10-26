// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BarsView — the Account Usage card's healthy-meters body, extracted so a second
 * surface can render the same bars without duplicating the derivations (epic
 * #4460 K12; #4466 Task 4's contract, first landed by #4523 for the Session
 * Configuration modal).
 *
 * Renders ONLY the windows Anthropic populates: the 5-hour / weekly / per-model
 * weekly windows, the per-model `weekly_scoped` limits (Fable today), the usage-
 * credits (overage) bar, and the legacy `extra_usage` line when no overage bar
 * renders. An `ok` envelope with no populated meter renders "No usage data this
 * period." When #4467's other usage views land, such a card still renders this
 * view in every view.
 *
 * The card keeps the `rate_limited` flag and the degraded arm (#4467 R1 confines
 * views to the healthy-meters arm); the formatters stay exported from
 * `AccountUsageCard.tsx`. `history` drives the projection line; a surface that
 * passes none (the account picker, the Session Configuration modal) shows no
 * projection.
 */
import type {
  AccountUsage,
  AccountUsageHistory,
  ExtraUsage,
  LimitEntry,
  RateLimit,
} from "@hapi/protocol";
import { usageLevel, LEVEL_COLOR } from "../UsageBar";
import {
  centsToUsd,
  formatProjection,
  formatResetAbsolute,
  formatResetCountdown,
  formatUsd,
  moneyToUsd,
  overagePercent,
  PROJECTION_WINDOWS,
  RESET_PENDING_MESSAGE,
  type RateLimitKey,
} from "../AccountUsageCard";

/**
 * The meter inputs the card (for its `hasMeterData` arm condition) and this view
 * (for the bars) both need — one pure derivation so neither side copies it.
 * `hasMeterData` is the ONE rule for "any meter to render": the card's degraded
 * arm (#2608), this view's empty state and the Session Configuration modal's
 * block (#4523) must agree on it, so none of them restates it.
 */
export function deriveBarsMeters(u: AccountUsage["utilization"]): {
  populated: {
    label: string;
    key: RateLimitKey;
    win: RateLimit | null | undefined;
  }[];
  scopedLimits: LimitEntry[];
  overPct: number | null;
  hasMeterData: boolean;
} {
  const windows: {
    label: string;
    key: RateLimitKey;
    win: RateLimit | null | undefined;
  }[] = [
    { label: "5-hour", key: "five_hour", win: u.five_hour },
    { label: "Weekly", key: "seven_day", win: u.seven_day },
    {
      label: "Weekly Sonnet",
      key: "seven_day_sonnet",
      win: u.seven_day_sonnet,
    },
    { label: "Weekly Opus", key: "seven_day_opus", win: u.seven_day_opus },
  ];
  // Render ONLY windows the API populates. Drops the always-null Opus slot now,
  // and auto-surfaces a future populated window without a code change.
  const populated = windows.filter(
    w => w.win != null && w.win.utilization != null
  );

  // Modern per-model weekly windows (issue #2091): render ALL `weekly_scoped`
  // entries generically by `scope.model.display_name` (Fable is today's only one),
  // so a future scoped model auto-appears without a code change. `session` /
  // `weekly_all` entries carry a null display_name and are filtered out; the flat
  // five_hour/seven_day fields remain the source for the existing meters.
  const scopedLimits: LimitEntry[] = (u.limits ?? []).filter(
    l =>
      l != null &&
      l.kind === "weekly_scoped" &&
      l.percent != null &&
      l.scope?.model?.display_name != null
  );
  // Usage-credits / overage bar (issue #2091): uncapped % from `spend`, gated on
  // `spend.limit` presence (NOT `spend.enabled` — the desktop shows the meter even
  // with the credits toggle off when a limit exists).
  const overPct = overagePercent(u.spend);
  const hasMeterData =
    populated.length > 0 || scopedLimits.length > 0 || overPct != null;
  return { populated, scopedLimits, overPct, hasMeterData };
}

export function BarsView({
  account,
  history,
}: {
  account: AccountUsage;
  history?: AccountUsageHistory;
}) {
  const u = account.utilization;
  const { populated, scopedLimits, overPct, hasMeterData } =
    deriveBarsMeters(u);
  const extra: ExtraUsage | null | undefined = u.extra_usage;
  const overUsedUsd = moneyToUsd(u.spend?.used);
  const overLimitUsd = moneyToUsd(u.spend?.limit);

  return (
    <>
      {!hasMeterData ? (
        <p className="py-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
          No usage data this period.
        </p>
      ) : (
        <div className="divide-y divide-[var(--app-border)]">
          {populated.map(({ label, key, win }) => {
            const pct = win?.utilization ?? 0;
            const level = usageLevel(pct);
            const color = LEVEL_COLOR[level];
            const countdown = formatResetCountdown(win?.resets_at);
            const absolute = formatResetAbsolute(win?.resets_at);
            const resetLine =
              countdown !== "" && absolute !== ""
                ? `${countdown} · ${absolute}`
                : countdown || absolute;
            const trend = PROJECTION_WINDOWS.has(key)
              ? history?.windows.find(
                  w => w.limitKey === key && w.points.length >= 2
                )
              : undefined;
            const projection = trend ? formatProjection(trend.projection) : "";
            // Inside populated.map (utilization != null), so an empty
            // resetLine means "populated window, missing resets_at" —
            // prompt the user to start the window instead of a blank line.
            const resetDisplay =
              resetLine !== "" ? resetLine : RESET_PENDING_MESSAGE;
            // A pending-reset window can still carry a projection (the
            // server sets reachesLimitBeforeReset=true when resets_at is
            // null), which would collide with the message inside the
            // truncate span at 393px — so suppress the projection while
            // the pending-reset message renders. [#2052, expert-review D9]
            const showProjection = resetLine !== "" && projection !== "";
            return (
              <div
                key={label}
                className="py-[3px]" /* design-tokens-allow: 3px block vertical padding — no --space token maps to 3px (L3 #3405) */
              >
                <div className="flex items-baseline justify-between leading-none">
                  <span className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                    {label}
                  </span>
                  <span
                    className="text-[length:var(--text-label-strong)] font-bold tabular-nums"
                    style={{ color }}
                  >
                    {Math.round(pct)}%
                  </span>
                </div>
                <div
                  className="mt-[3px] h-[5px] overflow-hidden rounded-full bg-[var(--app-subtle-bg)]" /* design-tokens-allow: 3px bar top-margin + 5px bar height — no --space/--control token maps to 3px/5px (L3 #3405) */
                >
                  <div
                    data-testid="usage-bar-fill"
                    data-usage-level={level}
                    className="h-full rounded-full transition-all duration-500 ease-out"
                    style={{
                      width: `${pct <= 0 ? 0 : Math.min(100, Math.max(3, pct))}%`,
                      backgroundColor: color,
                      boxShadow:
                        level === "red" ? `0 0 8px -1px ${color}` : undefined,
                    }}
                  />
                </div>
                {(resetDisplay !== "" || projection !== "") && (
                  <div
                    className={
                      /* design-tokens-allow: 3px top-margin — no --space token maps to 3px (L3 #3405) */ `mt-[3px] flex items-baseline gap-2.5 leading-none ${
                        showProjection ? "justify-between" : "justify-end"
                      }`
                    }
                  >
                    {showProjection && (
                      <span
                        className="shrink-0 text-[10.5px] font-medium"
                        style={{ color }}
                      >
                        {projection}
                      </span>
                    )}
                    <span
                      className={`min-w-0 text-[10.5px] text-[var(--app-hint)]${
                        resetLine !== "" ? " truncate" : ""
                      }`}
                    >
                      {resetDisplay}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
          {/* Per-model weekly (Fable) meters (#2091). Same stacked-block
              markup as the windows above; labeled by display_name, no
              projection line (history covers only the canonical keys). */}
          {scopedLimits.map((l, idx) => {
            const name = l.scope?.model?.display_name;
            if (name == null || name === "") return null;
            const pct = l.percent ?? 0;
            const level = usageLevel(pct);
            const color = LEVEL_COLOR[level];
            const countdown = formatResetCountdown(l.resets_at);
            const absolute = formatResetAbsolute(l.resets_at);
            const resetLine =
              countdown !== "" && absolute !== ""
                ? `${countdown} · ${absolute}`
                : countdown || absolute;
            return (
              <div
                key={`${l.kind}:${name}:${idx}`}
                className="py-[3px]" /* design-tokens-allow: 3px block vertical padding — no --space token maps to 3px (L3 #3405) */
              >
                <div className="flex items-baseline justify-between leading-none">
                  <span className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                    {name}
                  </span>
                  <span
                    className="text-[length:var(--text-label-strong)] font-bold tabular-nums"
                    style={{ color }}
                  >
                    {Math.round(pct)}%
                  </span>
                </div>
                <div
                  className="mt-[3px] h-[5px] overflow-hidden rounded-full bg-[var(--app-subtle-bg)]" /* design-tokens-allow: 3px bar top-margin + 5px bar height — no --space/--control token maps to 3px/5px (L3 #3405) */
                >
                  <div
                    data-testid="usage-bar-fill"
                    data-usage-level={level}
                    className="h-full rounded-full transition-all duration-500 ease-out"
                    style={{
                      width: `${pct <= 0 ? 0 : Math.min(100, Math.max(3, pct))}%`,
                      backgroundColor: color,
                      boxShadow:
                        level === "red" ? `0 0 8px -1px ${color}` : undefined,
                    }}
                  />
                </div>
                {resetLine !== "" && (
                  <div
                    className="mt-[3px] flex items-baseline justify-end leading-none" /* design-tokens-allow: 3px top-margin — no --space token maps to 3px (L3 #3405) */
                  >
                    <span className="min-w-0 truncate text-[10.5px] text-[var(--app-hint)]">
                      {resetLine}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
          {/* Usage-credits / overage bar (#2091). Uncapped % (shows 103%);
              gated on spend.limit presence, not spend.enabled. */}
          {overPct != null && u.spend?.limit != null && (
            <div
              className={
                /* design-tokens-allow: 3px block vertical padding — no --space token maps to 3px (L3 #3405) */ "py-[3px]"
              }
              data-testid="overage-block"
            >
              <div className="flex items-baseline justify-between leading-none">
                <span className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                  Usage credits
                </span>
                <span
                  className="text-[length:var(--text-label-strong)] font-bold tabular-nums"
                  style={{ color: LEVEL_COLOR[usageLevel(overPct)] }}
                >
                  {Math.round(overPct)}%
                </span>
              </div>
              <div
                className="mt-[3px] h-[5px] overflow-hidden rounded-full bg-[var(--app-subtle-bg)]" /* design-tokens-allow: 3px bar top-margin + 5px bar height — no --space/--control token maps to 3px/5px (L3 #3405) */
              >
                <div
                  data-testid="usage-bar-fill"
                  data-usage-level={usageLevel(overPct)}
                  className="h-full rounded-full transition-all duration-500 ease-out"
                  style={{
                    width: `${overPct <= 0 ? 0 : Math.min(100, Math.max(3, overPct))}%`,
                    backgroundColor: LEVEL_COLOR[usageLevel(overPct)],
                    boxShadow:
                      usageLevel(overPct) === "red"
                        ? `0 0 8px -1px ${LEVEL_COLOR[usageLevel(overPct)]}`
                        : undefined,
                  }}
                />
              </div>
              <div
                className="mt-[3px] flex items-baseline justify-end leading-none" /* design-tokens-allow: 3px top-margin — no --space token maps to 3px (L3 #3405) */
              >
                <span className="text-[10.5px] text-[var(--app-hint)]">
                  {formatUsd(overUsedUsd)} used / {formatUsd(overLimitUsd)}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
      {/* Legacy extra_usage fallback (#2091 R5/R6): only when the modern overage
          bar did NOT render (spend absent, or spend present with a null
          limit). Cents→dollars fixed (extra_usage.decimal_places: 2). */}
      {overPct == null && extra?.is_enabled && (
        <div className="flex items-center justify-between border-t border-[var(--app-border)] py-1.5 text-[length:var(--text-body-dense)] leading-none">
          <span className="text-[var(--app-fg)]">Extra usage</span>
          <span className="tabular-nums text-[var(--app-hint)]">
            {formatUsd(centsToUsd(extra.used_credits))} /{" "}
            {formatUsd(centsToUsd(extra.monthly_limit))}
          </span>
        </div>
      )}
    </>
  );
}
