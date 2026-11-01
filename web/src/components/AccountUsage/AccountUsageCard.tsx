// SPDX-License-Identifier: AGPL-3.0-only
/**
 * AccountUsageCard — collapsible per-account usage card (epic #1855, Sub E / #1860;
 * restructured by #4466).
 *
 * Row 1 is the shared card contract (`AccountCardRow1`, #4466 R3): monogram ·
 * nickname · email · plan chip · spacer · re-login alert · pacing score ·
 * chevron. A collapsed card shows row 1 only. Expanded, it shows the node row
 * (`AccountNodeRow`: one `NodeBadge` pill per node, a red ring where the node
 * needs a re-login, a mint ring + "default" caption on the node whose default
 * this account is, and a "set default" caption elsewhere — #2053 re-homed under
 * ruling E-1 A), then the usage region (the section's usage view — Bars, Arcs or
 * Chips, #4467 — or the degraded status line),
 * then "Remove Account" at the lower left when the page passes `onRemove`.
 *
 * The node row IS the per-node set-active control; `disableSetActive` suppresses
 * it so the Switch modal (#2056) renders the card display-only. With `onSelect`
 * the row becomes the picker variant (one select button over the name).
 *
 * Mostly presentational; the reset/projection strings are static (computed from
 * `resets_at` / the history projection via the injectable-`now` formatters — no
 * live ticker).
 */
import { useContext, useState } from "react";
import { findUsageRowHardLock } from "@hapi/protocol";
import type {
  AccountUsage,
  AccountUsageHistory,
  ProviderId,
  Spend,
  SpendMoney,
  UsageProjection,
} from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { Button } from "@/components/ui/button";
import { AccountMonogramEditor } from "./AccountMonogramEditor";
import { BarsView, deriveBarsMeters } from "./views/BarsView";
import { ArcsView } from "./views/ArcsView";
import { ChipsView } from "./views/ChipsView";
import { buildUsageColumns } from "./views/usageMeters";
import { UsageViewContext } from "./views/UsageViewContext";
import { AccountCardRow1, rowMonogram } from "./AccountCardRow1";
import { accountShortName } from "@/components/session/accountLabel";
import { AccountNodeRow, type AccountNodeItem } from "./AccountNodeRow";
import type { AlertNodeEntry } from "./AccountAlertIcon";
import { CardRemoveButton } from "./CardRemoveButton";
import {
  useAccountMonogram,
  useAccountMonogramByUuid,
} from "@/hooks/queries/useAccountLabels";
import {
  splitDragHandle,
  type SortableDragHandle,
} from "@/components/SessionList/SortableListEntry";

export type RateLimitKey =
  | "five_hour"
  | "seven_day"
  | "seven_day_sonnet"
  | "seven_day_opus";

/**
 * The windows that get a projected-exhaustion estimate: the 5-hour and weekly
 * (`seven_day`) limits — the two windows a user actively burns down and wants a
 * "when will I run out" read on. Exported for `views/BarsView.tsx` (#4523).
 */
export const PROJECTION_WINDOWS = new Set<RateLimitKey>([
  "five_hour",
  "seven_day",
]);

/**
 * Shown under a populated window's bar when it has no reset timestamp yet — the
 * account has been reset but no message has been sent, so `resets_at` is null and
 * the reset line would otherwise be blank. Exported for views/BarsView.tsx
 * (#4523), which renders the reset line. Sub-Issue C / #2052.
 */
export const RESET_PENDING_MESSAGE = "Send a message to start the reset window";

/**
 * Format the time remaining until `resetsAt` as a short forward-duration string.
 * Under 1 hour: minutes ("resets in 30m"). Under 1 day: hours AND minutes
 * ("resets in 3h 25m") so the reading is actionable, not coarse. 1 day and
 * beyond: fractional days with one decimal ("resets in 4.2d") — whole days
 * lose up to 24h of accuracy. Returns "resets now" for a past/current time and
 * "" when the timestamp is missing or unparseable. `now` is injectable for
 * deterministic tests.
 */
export function formatResetCountdown(
  resetsAt: string | null | undefined,
  now: number = Date.now()
): string {
  if (!resetsAt) return "";
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) return "";
  const deltaMs = target - now;
  if (deltaMs <= 0) return "resets now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `resets in ${Math.max(1, minutes)}m`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return rem > 0 ? `resets in ${hours}h ${rem}m` : `resets in ${hours}h`;
  }
  const days = deltaMs / 86_400_000;
  return `resets in ${days.toFixed(1)}d`;
}

/**
 * Format `resetsAt` as an exact Eastern-Time wall-clock stamp with the weekday,
 * date, time, and zone abbreviation ("Mon, Jun 23, 11:34 PM EDT"). Pinning
 * `timeZone: "America/New_York"` makes the stamp DST-aware and identical
 * regardless of the viewing device's timezone. Returns "" when missing/unparseable.
 */
export function formatResetAbsolute(
  resetsAt: string | null | undefined
): string {
  if (!resetsAt) return "";
  const t = Date.parse(resetsAt);
  if (!Number.isFinite(t)) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(t));
}

/**
 * Format a server-computed projected-exhaustion estimate as a short trend string
 * with SINGLE-DECIMAL precision ("↗ 100% in 2.2 days" / "↗ 100% in 3.4 hours" /
 * "↗ 100% in 45 min"). The "↗" + the decimal signal a forward estimate. Returns
 * "" when there is no honest projection to show (no projection, a null exhaustion
 * time, or one that lands after the window's reset). `now` is injectable for tests.
 */
export function formatProjection(
  projection: UsageProjection | null,
  now: number = Date.now()
): string {
  if (
    !projection ||
    projection.exhaustionAt == null ||
    !projection.reachesLimitBeforeReset
  ) {
    return "";
  }
  const deltaMs = projection.exhaustionAt - now;
  if (deltaMs <= 0) return "↗ at limit now";
  const hours = deltaMs / 3_600_000;
  let dur: string;
  if (hours < 1) dur = `${Math.max(1, Math.round(deltaMs / 60_000))} min`;
  else if (hours < 24) dur = `${hours.toFixed(1)} hours`;
  else dur = `${(hours / 24).toFixed(1)} days`;
  return `↗ 100% in ${dur}`;
}

/** Format a dollar amount; a missing amount renders a muted dash. Exported for
 *  reuse across usage surfaces (identical overage `$used / $limit` copy). */
export function formatUsd(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  return `$${amount.toFixed(2)}`;
}

/**
 * Resolve a `spend` money object to whole dollars: `amount_minor / 10^exponent`
 * (issue #2091). Returns null when the amount is missing/non-finite (a missing
 * exponent defaults to 0). Exported for reuse across usage surfaces.
 */
export function moneyToUsd(m: SpendMoney | null | undefined): number | null {
  if (m == null) return null;
  const minor = m.amount_minor;
  if (minor == null || !Number.isFinite(minor)) return null;
  const exp =
    m.exponent != null && Number.isFinite(m.exponent) ? m.exponent : 0;
  return minor / Math.pow(10, exp);
}

/**
 * The uncapped usage-credits / overage percentage (issue #2091):
 * `moneyToUsd(spend.used) / moneyToUsd(spend.limit) × 100`. UNCAPPED — may exceed
 * 100 (e.g. 103%), matching the Claude desktop app; `spend.percent` clamps at 100.
 * Computed from resolved dollars (not raw `amount_minor`) so it is correct even if
 * used/limit carried different exponents. Returns null when either side resolves
 * null or the limit is ≤ 0. Exported for reuse across usage surfaces.
 */
export function overagePercent(spend: Spend | null | undefined): number | null {
  if (spend == null) return null;
  const used = moneyToUsd(spend.used);
  const limit = moneyToUsd(spend.limit);
  if (used == null || limit == null || limit <= 0) return null;
  return (used / limit) * 100;
}

/** Legacy `extra_usage` amounts are in CENTS (verified live 2026-07-08:
 *  `decimal_places: 2`; `used_credits: 5131` ⇒ $51.31). Convert to dollars,
 *  preserving the muted-dash render for a missing value. Exported for
 *  `views/BarsView.tsx` (#4523). */
export function centsToUsd(cents: number | null | undefined): number | null {
  if (cents == null || !Number.isFinite(cents)) return null;
  return cents / 100;
}

export const STATUS_MESSAGE: Record<
  Exclude<AccountUsage["status"], "ok">,
  string
> = {
  expired: "Re-login required",
  refreshing: "Refreshing sign-in…", // #2281: transient, non-actionable
  rate_limited: "Temporarily rate-limited · retrying", // #2608: transient, retriable
  no_scope: "Usage unavailable (missing profile scope)",
  error: "Couldn't load usage.",
};

type AccountUsageCardProps = {
  account: AccountUsage;
  defaultExpanded?: boolean;
  onRetry?: () => void;
  history?: AccountUsageHistory;
  api?: ApiClient | null;
  /**
   * Suppress the node row's "set default" captions (Sub-Issue G / #2056 renders
   * this card display-only inside the Switch modal). Prop name is the locked
   * D↔G contract.
   */
  disableSetActive?: boolean;
  /**
   * Switch-modal reuse (Sub-Issue G / #2056): when provided, row 1 becomes the
   * picker variant (#4466 R13) — one select button over the nickname, the email
   * and the plan chip fires `onSelect(accountUuid)` and is named `Switch to
   * account <email>`; the chevron still toggles expand/collapse. When absent the
   * card is display-only (its historical behavior).
   */
  onSelect?: (accountUuid: string) => void;
  /**
   * Switch-modal reuse (Sub-Issue G / #2056): render a small "Current" success
   * badge in row 1, after the plan chip, marking the account currently active
   * for the surrounding scope.
   */
  currentMarker?: boolean;
  className?: string;
  /**
   * #3537 — always-armed drag-to-reorder handle (mirrors `SessionItem.dragHandle`).
   * When provided (by `SortableAccountCard` on the `/account-usage` page), the card's
   * whole surface arms a press-and-hold drag via the pointer/touch `rowListeners`,
   * while the sortable a11y `attributes` + dnd-kit keyboard `onKeyDown` ride the expand
   * chevron. Absent everywhere else (e.g. the AccountSelectorModal's read-only list),
   * where `splitDragHandle` yields inert defaults so nothing changes.
   */
  dragHandle?: SortableDragHandle;
  /** #4466 R4: one entry per node needing a re-login (the row-1 alert icon). */
  alertNodes?: AlertNodeEntry[];
  /** #4466 R6: the node row's items; absent or empty ⇒ no node row. */
  nodeItems?: AccountNodeItem[];
  /** #4466 R8: render "Remove Account"; the page owns the confirm. */
  onRemove?: () => void;
  /** Whose per-node default the node row reads and sets (default anthropic). */
  provider?: ProviderId;
};

export function AccountUsageCard(props: AccountUsageCardProps) {
  const {
    account,
    defaultExpanded = true,
    onRetry,
    className,
    api,
    disableSetActive,
    onSelect,
    currentMarker = false,
    dragHandle,
    alertNodes,
    nodeItems,
    onRemove,
    provider = "anthropic",
  } = props;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [monoEditorOpen, setMonoEditorOpen] = useState(false);
  // #3621: the monogram override, read via the labels query (D11 Option A), NOT
  // the usage `account` prop (which carries no monogram). Disabled → undefined
  // when there is no api (the read-only AccountSelectorModal list).
  // #3982: an email-less account (OpenAI / Google) keys its override by uuid.
  const emailMonogram = useAccountMonogram(
    api ?? null,
    account.email ?? undefined
  );
  const uuidMonogram = useAccountMonogramByUuid(
    api ?? null,
    account.email ? undefined : account.accountUuid
  );
  const monogram = account.email ? emailMonogram : uuidMonogram;
  // #3537: split the drag handle — pointer/touch (`dragRowListeners`) arm the whole
  // card; the keyboard handler + a11y attributes go on the expand chevron (keyboard
  // reorder stays on the handle, mirroring SessionItem). Inert defaults when absent.
  const {
    attributes: dragAttributes,
    rowListeners: dragRowListeners,
    keyDown: dragKeyDown,
  } = splitDragHandle(dragHandle);

  // (#2608, ruling D6) Whether the expanded card has ANY meter to render — the
  // one rule `BarsView` (its "No usage data this period." line) and the Session
  // Configuration modal's block share, from the one derivation (#4523 / #4466
  // Task 4, K12). A preserved `rate_limited` row carries prior meters
  // (hasMeterData=true → meters branch + the transient badge); a first-sample
  // 429 with no prior has none (hasMeterData=false → the degraded branch shows
  // STATUS_MESSAGE instead).
  const { hasMeterData } = deriveBarsMeters(account.utilization);
  // #4467: the provider section's usage view; outside a section (the switch
  // modal) there is none, so Bars (R8). A card with no meter keeps Bars' "No
  // usage data this period." line in every view.
  const usageView = useContext(UsageViewContext) ?? "bars";

  const hasEmail = account.email != null && account.email !== "";
  const primary = hasEmail ? (account.email as string) : account.displayLabel;
  const colloquialFallback = hasEmail ? account.displayLabel : "";
  // Row 1's nickname follows the chip's label chain (`resolveAccountLabel`):
  // nickname → display name → the email's local part. The server fills an
  // absent display name with the email (usageService), so an email-equal
  // `displayLabel` means there is none — and the email would show twice.
  const nickname =
    account.nickname?.trim() ||
    (hasEmail
      ? account.displayLabel && account.displayLabel !== primary
        ? account.displayLabel
        : accountShortName(primary)
      : primary);
  // #3621: a present override field wins; an absent field keeps the derived
  // letter and the per-email (else per-uuid) hash colour, as AccountChip does.
  const mono = rowMonogram({
    override: monogram,
    label: nickname,
    seed: hasEmail ? primary : account.accountUuid,
  });
  const canEditMonogram = api != null && hasEmail;

  return (
    <div
      // #3537: the WHOLE card is the drag surface — the pointer/touch listeners arm a
      // press-and-hold drag (the guarded sensors veto a press on an interactive child
      // and gate on the ~300ms hold, so a normal tap/scroll is unaffected). `select-none`
      // + `WebkitTouchCallout: none` mirror the SessionItem row (SessionItem.tsx:655-658)
      // — no `touch-none`, so page scrolling over the card list still works. Inert when
      // no `dragHandle` is supplied (the AccountSelectorModal's read-only list).
      {...dragRowListeners}
      data-testid="account-usage-card"
      data-account-uuid={account.accountUuid}
      className={
        /* design-tokens-allow: 13px card radius — no --radius token (ladder tops at ~11px) or Tailwind utility maps to 13px (L3 #3405) */ `select-none rounded-[13px] border border-[var(--app-border)] bg-[var(--app-secondary-bg)] ${className ?? ""}`
      }
      style={{ WebkitTouchCallout: "none" }}
    >
      <div className="px-3.5 py-1.5">
        {/* ROW 1 — the shared contract (#4466 R3): monogram · nickname · email ·
            plan · spacer · alert · score · chevron. */}
        <AccountCardRow1
          monogram={mono}
          onMonogramTap={
            canEditMonogram ? () => setMonoEditorOpen(true) : undefined
          }
          monogramLabel={`Edit account chip for ${primary}`}
          nickname={nickname}
          revealText={primary}
          // An email-less account with no nickname would repeat its label (the
          // picker's OpenAI scope), so it shows the label once.
          secondary={hasEmail || nickname !== primary ? primary : ""}
          planLabel={account.planLabel ?? undefined}
          alertNodes={alertNodes}
          score={account.score ?? null}
          // #5879: only rows whose meters are known decide a lock (the same
          // rule as the server's spawn refusal and the account picker). Page
          // cards only: the picker (`onSelect`) shows its own reset caption
          // under the card, and at 393px the extra label squeezed its row 1
          // until the plan chip and the "Current" marker overlapped.
          hardLock={onSelect ? undefined : findUsageRowHardLock(account)}
          currentMarker={currentMarker}
          expanded={expanded}
          onToggle={() => setExpanded(e => !e)}
          onSelect={onSelect ? () => onSelect(account.accountUuid) : undefined}
          selectLabel={`Switch to account ${primary}`}
          toggleLabel={`Toggle details for ${nickname}`}
          dragAttributes={dragAttributes}
          dragKeyDown={dragKeyDown}
        />
        {/* #3621: the centered monogram+nickname editor (portaled Radix Dialog, so
            its JSX position is layout-inert), opened by the row-1 monogram. */}
        {canEditMonogram ? (
          <AccountMonogramEditor
            api={api}
            uuid={account.accountUuid}
            email={account.email as string}
            nickname={account.nickname}
            monogram={monogram}
            fallback={colloquialFallback}
            open={monoEditorOpen}
            onClose={() => setMonoEditorOpen(false)}
          />
        ) : null}
      </div>

      {expanded && (
        <>
          {/* 1. The node row (#4466 R6/R7): the page passes `nodeItems`; the
              picker has no api and no node row (R13). */}
          {api != null && nodeItems && nodeItems.length > 0 ? (
            <div className="border-t border-[var(--app-border)] px-3.5 py-2">
              <AccountNodeRow
                items={nodeItems}
                accountUuid={account.accountUuid}
                accountLabel={nickname}
                provider={provider}
                api={api}
                disableSetActive={disableSetActive === true}
                // The old Row-2 chip offered set-default only while usage was ok.
                canSetDefault={account.status === "ok"}
              />
            </div>
          ) : null}
          {/* 2. The usage region. (#2608, ruling D6/D7) The meters arm renders for
              `ok`, and for a `rate_limited` row that still has preserved meters —
              widened status-SPECIFICALLY so `refreshing` (no meters) stays in the
              degraded arm (IF-1). A `rate_limited` row with NO meter data falls to
              the degraded arm below (STATUS_MESSAGE), never the "No usage data" copy. */}
          {account.status === "ok" ||
          (account.status === "rate_limited" && hasMeterData) ? (
            <div className="border-t border-[var(--app-border)] px-3.5">
              {account.status === "rate_limited" && (
                <p
                  data-testid="rate-limited-flag"
                  className="border-b border-[var(--app-border)] py-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
                >
                  {STATUS_MESSAGE.rate_limited}
                </p>
              )}
              {usageView === "arcs" && hasMeterData ? (
                <ArcsView
                  columns={buildUsageColumns(account.utilization, provider)}
                />
              ) : usageView === "chips" && hasMeterData ? (
                <ChipsView
                  columns={buildUsageColumns(account.utilization, provider)}
                />
              ) : (
                <BarsView account={account} history={props.history} />
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 border-t border-[var(--app-border)] px-3.5 py-2 text-[length:var(--text-body)] text-[var(--app-hint)]">
              <span>{STATUS_MESSAGE[account.status]}</span>
              {account.status === "error" && onRetry != null && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={onRetry}
                  className="h-auto rounded-md bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[length:var(--text-body-dense)] text-[var(--app-fg)] hover:bg-[var(--app-hover)]"
                >
                  Retry
                </Button>
              )}
            </div>
          )}
          {/* 3. Remove (#4466 R8, E-3 A): plain-weight deep-red text at the lower
              left of the expanded card only; the page owns the confirm. */}
          {onRemove ? (
            <div className="flex px-3.5 pb-2 pt-1">
              <CardRemoveButton
                label="Remove Account"
                testId="account-remove"
                onRemove={onRemove}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
