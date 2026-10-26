// SPDX-License-Identifier: AGPL-3.0-only
/**
 * AccountUsageCard — collapsible per-account usage card (epic #1855, Sub E / #1860).
 *
 * Header — two rows (#2050): ROW 1 = account email (left, expanded to fill the
 * freed space) + pacing score badge + collapse/expand chevron in the
 * far-right corner; ROW 2 = the inline-editable colloquial nickname (left) +
 * plan-tier badge + registered-node labels (right-justified). Body: ONLY the
 * rate-limit windows Anthropic actually populates (non-null) — the response
 * carries always-null placeholder slots (seven_day_opus, internal codename slots)
 * we deliberately do NOT render. Each window is a compact "stacked block": label +
 * band-colored % on the top line, a full-width band-colored bar, and a muted reset
 * line with a right-justified exact Eastern-Time stamp and, when present, the
 * projected-exhaustion estimate to its left (5-hour / weekly only, when it actually
 * projects to hit 100% before reset).
 *
 * The Row-2 registered-node list IS the set-active control (Sub-Issue D / #2053):
 * clicking a resolvable node entry opens a per-node confirm that sets that node's
 * default account, and the node where this account is already active renders as a
 * green "success" bubble. The interaction is suppressible via `disableSetActive`
 * so Sub-Issue G (#2056) can render this card display-only inside the Switch modal.
 *
 * Mostly presentational; the impure piece (nickname mutation) lives in a child
 * component so the card stays deterministically testable. The reset/projection
 * strings are static (computed from `resets_at` / the history projection via the
 * injectable-`now` formatters — no live ticker).
 */
import { useState, useMemo, Fragment } from "react";
import type {
  AccountUsage,
  AccountUsageHistory,
  ProviderId,
  Spend,
  SpendMoney,
  UsageProjection,
} from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ChevronIcon } from "@/components/icons";
import { useNodeActiveAccount } from "@/hooks/queries/useNodeActiveAccount";
import { useAccountActions } from "@/hooks/mutations/useAccountActions";
import { scoreLevel, LEVEL_COLOR } from "./UsageBar";
import { AccountMonogramEditor } from "./AccountMonogramEditor";
import { BarsView, deriveBarsMeters } from "./views/BarsView";
import { AccountChip } from "@/components/session/AccountChip";
import { ACCOUNT_NICKNAME_MAX_CHARS } from "@/components/session/accountLabel";
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
  nodes?: { nodeId: string; nodeLabel: string }[];
  /**
   * Suppress the Row-2 set-active interaction (Sub-Issue G / #2056 renders this
   * card display-only inside the Switch modal). When true: no click target, no
   * hover helper, no confirm. The active node's green bubble still renders when
   * `api` + `nodes` are supplied; #2056 additionally withholds those for a fully
   * static list. Prop name is the locked D↔G contract.
   */
  disableSetActive?: boolean;
  /**
   * Switch-modal reuse (Sub-Issue G / #2056): when provided, the card becomes a
   * SELECT target — the Row-1 email button fires `onSelect(accountUuid)` instead
   * of toggling expand/collapse (the chevron keeps that role and its
   * `aria-expanded`), and gets the accessible name `Switch to account <email>`.
   * When absent the card is display-only (its historical behavior).
   */
  onSelect?: (accountUuid: string) => void;
  /**
   * Switch-modal reuse (Sub-Issue G / #2056): render a small "Current" success
   * badge in Row 1 (between the email button and the score badge) marking the
   * account currently active for the surrounding scope.
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
};

// The green and amber NodeChip bubbles share these size classes so their height
// and padding match (#3973); the amber one is only wider by its `!` marker.
const NODE_CHIP_BADGE_CLASS =
  "shrink-0 px-1.5 py-0 text-[length:var(--text-caption-xs)] leading-none";

/**
 * NodeChip — one Row-2 entry for a resolvable machine label (Sub-Issue D / #2053,
 * re-homing the retired `AccountUsageNodeSwitchRow`). Reuses the unchanged per-node
 * switch path (`useAccountActions({ nodeId }).selectAccount` →
 * `POST /api/nodes/:nodeId/active-account`) and the per-node-correct confirm copy —
 * a UI re-home, not a data-path change. Hook rules force one instance per node.
 *
 * - Active (this account IS the node's default): a green "success" bubble, no confirm.
 * - Active but unrefreshable on that node (#3973): an amber "warning" bubble with a
 *   visible `!` and a "Re-login required" accessible name, no confirm. Re-setting
 *   is a no-op; the fix is a fresh sign-in on that node (the in-app re-login
 *   link / "+ Add" modal, or `claude /login` on the host).
 * - Inactive + interactive: the label itself is the click target (hover helper
 *   "Set as Default Acct on Node") that opens the per-node confirm.
 * - `disableSetActive` (#2056 Switch-modal reuse): interaction suppressed — both
 *   active bubbles still show (display state), inactive renders a plain label.
 * - `provider` (#3982): read and set THAT provider's per-node default (the OpenAI
 *   rows of `ProviderAccountCard`); absent ⇒ the Anthropic default, unchanged.
 *
 * Every render carries `data-state` (`active` | `active-expired` | `inactive`).
 */
export function NodeChip({
  api,
  nodeId,
  nodeLabel,
  account,
  disableSetActive,
  provider,
}: {
  api: ApiClient;
  nodeId: string;
  nodeLabel: string;
  account: Pick<AccountUsage, "accountUuid" | "displayLabel">;
  disableSetActive: boolean;
  provider?: ProviderId;
}) {
  const scopedProvider = provider === "anthropic" ? undefined : provider;
  const { account: activeAccount, status } = useNodeActiveAccount(
    api,
    nodeId,
    scopedProvider ? { provider: scopedProvider } : undefined
  );
  const { selectAccount, isPending } = useAccountActions(api, {
    nodeId,
    nodeLabel,
  });
  const [confirmOpen, setConfirmOpen] = useState(false);

  // #3973: an unrefreshable active account reads as status "expired", never
  // "set", so a two-way check rendered it as the plain set-as-default link.
  const isThisAccount = activeAccount?.accountUuid === account.accountUuid;
  const chipState: "active" | "active-expired" | "inactive" =
    isThisAccount && status === "set"
      ? "active"
      : isThisAccount && status === "expired"
        ? "active-expired"
        : "inactive";

  if (chipState === "active") {
    return (
      <Badge
        variant="success"
        data-testid={`account-usage-node-chip-${nodeId}`}
        data-state={chipState}
        className={NODE_CHIP_BADGE_CLASS}
      >
        {nodeLabel}
      </Badge>
    );
  }

  if (chipState === "active-expired") {
    // A visible `!` (the warning toast's glyph) because a `title` never shows on
    // touch and amber-vs-green alone is colour-only; the aria-label carries the
    // full meaning (expert-review ruling 3973-D1 → A).
    const expiredLabel = `${nodeLabel}: active — ${STATUS_MESSAGE.expired}`;
    return (
      <Badge
        variant="warning"
        role="img"
        aria-label={expiredLabel}
        title={expiredLabel}
        data-testid={`account-usage-node-chip-${nodeId}`}
        data-state={chipState}
        className={NODE_CHIP_BADGE_CLASS}
      >
        {nodeLabel}
        <span aria-hidden="true" className="ml-0.5">
          !
        </span>
      </Badge>
    );
  }

  if (disableSetActive) {
    return (
      <span
        data-testid={`account-usage-node-chip-${nodeId}`}
        data-state={chipState}
        className="shrink-0"
      >
        {nodeLabel}
      </span>
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="ghostStatic"
        data-testid={`account-usage-node-chip-${nodeId}`}
        data-state={chipState}
        onClick={() => setConfirmOpen(true)}
        title="Set as Default Acct on Node"
        className="h-auto shrink-0 p-0 text-[length:var(--text-caption)] font-normal text-[var(--app-link)] hover:text-[var(--app-link)] hover:opacity-80"
      >
        {nodeLabel}
      </Button>
      <ConfirmDialog
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Set active account?"
        description={`Make ${account.displayLabel} the active account for ${nodeLabel}. New sessions on this node will use it — your running sessions are not affected.`}
        confirmLabel="Set active"
        confirmingLabel="Setting…"
        onConfirm={async () => {
          if (scopedProvider) {
            await selectAccount(account.accountUuid, {
              provider: scopedProvider,
            });
          } else {
            await selectAccount(account.accountUuid);
          }
        }}
        isPending={isPending}
      />
    </>
  );
}

export function AccountUsageCard(props: AccountUsageCardProps) {
  const {
    account,
    defaultExpanded = true,
    onRetry,
    className,
    api,
    nodes,
    disableSetActive,
    onSelect,
    currentMarker = false,
    dragHandle,
  } = props;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [monoEditorOpen, setMonoEditorOpen] = useState(false);
  // #3621: monogram override for the email-row chip + the editor's live preview.
  // Read via the labels query (D11 Option A), NOT the usage `account` prop (which
  // carries no monogram). Disabled → undefined when there is no api (e.g. the
  // read-only AccountSelectorModal list), so no editable chip appears there.
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

  // Resolve `account.machines` labels to { nodeId } for the interactive Row-2
  // chips. `machines` (all labels) drives DISPLAY; only labels present here get
  // the set-active interaction (the machines-vs-nodes duality). First label wins
  // on collision — mirrors account-usage.tsx's nodeByLabel.
  const nodeByLabel = useMemo(() => {
    const m = new Map<string, { nodeId: string; nodeLabel: string }>();
    for (const n of nodes ?? []) {
      if (!m.has(n.nodeLabel)) m.set(n.nodeLabel, n);
    }
    return m;
  }, [nodes]);

  // (#2608, ruling D6) Whether the expanded card has ANY meter to render — the
  // one rule `BarsView` (its "No usage data this period." line) and the Session
  // Configuration modal's block share, from the one derivation (#4523 / #4466
  // Task 4, K12). A preserved `rate_limited` row carries prior meters
  // (hasMeterData=true → meters branch + the transient badge); a first-sample
  // 429 with no prior has none (hasMeterData=false → the degraded branch shows
  // STATUS_MESSAGE instead).
  const { hasMeterData } = deriveBarsMeters(account.utilization);

  const hasEmail = account.email != null && account.email !== "";
  const primary = hasEmail ? (account.email as string) : account.displayLabel;
  const colloquialFallback = hasEmail ? account.displayLabel : "";
  const colloquialText =
    (account.nickname && account.nickname.trim()) || colloquialFallback;

  // Account pacing score badge (epic #2038 Sub A2 / #2040; algorithm redesigned
  // 2026-07-20 to sustainable-rate pacing — usage.ts computeUtilizationScore):
  // a band-colored headline where LOWER = more attractive. 50 = exactly on the
  // pace that lands at 99% when the weekly window resets; < 50 = spare capacity
  // (spend here); > 50 = burning ahead of pace; 100 = locked. Rendered in the
  // always-visible header so it shows whether the card is collapsed or expanded.
  // Colors come from scoreLevel() (pace-anchored 60/80 bands) + LEVEL_COLOR —
  // deliberately NOT the raw-% usageLevel() 70/90 bands. A null/absent/non-finite
  // score (degraded statuses {expired, refreshing, rate_limited, no_scope, error},
  // or a lagging federation peer that omitted the field) renders a muted "—".
  // Mirrors the UsageBar null-guard.
  const score = account.score;
  const hasScore = score != null && Number.isFinite(score);

  return (
    <div
      // #3537: the WHOLE card is the drag surface — the pointer/touch listeners arm a
      // press-and-hold drag (the guarded sensors veto a press on an interactive child
      // and gate on the ~300ms hold, so a normal tap/scroll is unaffected). `select-none`
      // + `WebkitTouchCallout: none` mirror the SessionItem row (SessionItem.tsx:655-658)
      // — no `touch-none`, so page scrolling over the card list still works. Inert when
      // no `dragHandle` is supplied (the AccountSelectorModal's read-only list).
      {...dragRowListeners}
      className={
        /* design-tokens-allow: 13px card radius — no --radius token (ladder tops at ~11px) or Tailwind utility maps to 13px (L3 #3405) */ `select-none rounded-[13px] border border-[var(--app-border)] bg-[var(--app-secondary-bg)] ${className ?? ""}`
      }
      style={{ WebkitTouchCallout: "none" }}
    >
      <div className="px-3.5 pt-1.5 pb-1">
        {/* ROW 1 — email (left, expanded) · score badge · chevron. The account chip
            lives on Row 2 (operator ruling 2026-09-21: Row 1 is the email only). */}
        <div className="flex items-center gap-2.5">
          <Button
            type="button"
            variant="ghostStatic"
            size="bare"
            onClick={
              onSelect
                ? () => onSelect(account.accountUuid)
                : () => setExpanded(e => !e)
            }
            aria-expanded={onSelect ? undefined : expanded}
            aria-label={onSelect ? `Switch to account ${primary}` : undefined}
            className={`flex min-w-0 flex-1 items-center justify-start text-left font-normal hover:text-[var(--app-fg)]${
              onSelect ? " cursor-pointer" : ""
            }`}
          >
            <span className="truncate text-[length:var(--text-label-strong)] font-medium leading-none text-[var(--app-fg)]">
              {primary}
            </span>
          </Button>
          {currentMarker ? (
            <Badge
              variant="success"
              data-testid="account-current-marker"
              className="shrink-0 px-1.5 py-0 text-[length:var(--text-caption-xs)] leading-none"
            >
              Current
            </Badge>
          ) : null}
          {hasScore ? (
            <span
              data-testid="account-score-badge"
              data-score-level={scoreLevel(score)}
              className="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums"
              style={{
                color: LEVEL_COLOR[scoreLevel(score)],
                borderColor: LEVEL_COLOR[scoreLevel(score)],
              }}
              title="Pacing score — 50 = on pace to land 99% at the weekly reset; lower = spare capacity (use this account); higher = burning ahead; 100 = locked"
            >
              {Math.round(score)}
            </span>
          ) : (
            <span
              data-testid="account-score-badge"
              className="inline-flex shrink-0 items-center rounded-full border border-[var(--app-border)] px-2 py-0.5 text-xs font-semibold tabular-nums text-[var(--app-hint)]"
              title="Account pacing score (lower = more available)"
            >
              —
            </span>
          )}
          <Button
            type="button"
            variant="ghostStatic"
            // #3537 (R9): the expand chevron is ALSO the keyboard reorder handle — the
            // sortable a11y `attributes` + dnd-kit's keyboard `onKeyDown` (Enter/Space
            // picks up for a keyboard drag) live here, mirroring SessionItem's chevron.
            // Spread BEFORE aria-expanded/aria-label so the chevron's own attributes win
            // over any same-named key dnd-kit supplies. ACCEPTED trade (OR-3): once armed,
            // Enter/Space on the chevron is consumed by the KeyboardSensor and no longer
            // toggles expand — keyboard expand stays reachable on the Row-1 email button
            // (which has no onSelect on this page, so its onClick toggles expand and it
            // carries aria-expanded). Pointer/touch expand on the chevron is unaffected —
            // the guarded sensors exclude <button> from arming a drag.
            {...dragAttributes}
            onKeyDown={dragKeyDown}
            onClick={() => setExpanded(e => !e)}
            aria-expanded={expanded}
            aria-label="Toggle account details"
            className="h-auto shrink-0 p-0 hover:text-[var(--app-fg)]"
          >
            <ChevronIcon
              className="h-3.5 w-3.5 text-[var(--app-hint)]"
              collapsed={!expanded}
            />
          </Button>
        </div>
        {/* #3621: the centered monogram+nickname editor (portaled Radix Dialog, so
            its JSX position is layout-inert). Same api!=null && hasEmail gate as the
            trigger chip above. */}
        {api != null && hasEmail ? (
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
        {/* ROW 2 — account chip (left) · tier badge · node list (right-justified).
            Renders whenever any of those exist, not only when a nickname does. */}
        {(api != null ||
          colloquialText !== "" ||
          (account.planLabel != null && account.planLabel !== "") ||
          account.machines.length > 0) && (
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[length:var(--text-caption)] leading-none text-[var(--app-hint)]">
            {api != null && hasEmail ? (
              /* The account chip at full size — monogram + UNTRUNCATED nickname, i.e.
                 what the chip looks like fully populated — and the ONE tap target
                 that opens the AccountMonogramEditor (nickname + monogram letters +
                 color, saved together; the inline pencil nickname editor is retired).
                 A SIBLING <button> of the Row-1 email button (a button nested in a
                 button is invalid HTML), gated on `api != null` so the read-only
                 AccountSelectorModal (no api) keeps its plain label. stopPropagation on
                 click + pointerdown so the whole-card drag surface (#3537) is not
                 armed and the row's select/expand never fires. */
              <Button
                type="button"
                variant="ghostStatic"
                size="bare"
                onClick={e => {
                  e.stopPropagation();
                  setMonoEditorOpen(true);
                }}
                onPointerDown={e => e.stopPropagation()}
                aria-label={`Edit account chip for ${primary}`}
                title="Edit account chip (nickname, monogram, color)"
                data-testid="account-monogram-trigger"
                className="min-w-0 shrink rounded-full hover:opacity-80"
              >
                <AccountChip
                  email={account.email as string}
                  label={colloquialText}
                  monogram={monogram}
                  maxChars={ACCOUNT_NICKNAME_MAX_CHARS}
                />
              </Button>
            ) : (
              colloquialText !== "" && (
                <span className="truncate">{colloquialText}</span>
              )
            )}
            {account.planLabel != null && account.planLabel !== "" && (
              <Badge className="shrink-0 px-1.5 py-0 text-[length:var(--text-caption-xs)] leading-none">
                {account.planLabel}
              </Badge>
            )}
            {account.machines.length > 0 && (
              <div className="ml-auto flex shrink-0 items-center gap-1 text-[length:var(--text-caption)] text-[var(--app-hint)]">
                {account.machines.map((label, i) => {
                  const node = nodeByLabel.get(label);
                  return (
                    <Fragment key={`${label}:${i}`}>
                      {i > 0 && (
                        <span className="text-[var(--app-hint)]">·</span>
                      )}
                      {node != null &&
                      api != null &&
                      account.status === "ok" ? (
                        <NodeChip
                          api={api}
                          nodeId={node.nodeId}
                          nodeLabel={label}
                          account={account}
                          disableSetActive={disableSetActive === true}
                        />
                      ) : (
                        <span className="shrink-0">{label}</span>
                      )}
                    </Fragment>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {expanded &&
        // (#2608, ruling D6/D7) The meters arm renders for `ok`, and for a
        // `rate_limited` row that still has preserved meters — widened
        // status-SPECIFICALLY so `refreshing` (no meters) stays in the degraded
        // arm (IF-1). A `rate_limited` row with NO meter data falls to the
        // degraded arm below (STATUS_MESSAGE), never the "No usage data" copy.
        (account.status === "ok" ||
        (account.status === "rate_limited" && hasMeterData) ? (
          <>
            <div className="border-t border-[var(--app-border)] px-3.5">
              {account.status === "rate_limited" && (
                <p
                  data-testid="rate-limited-flag"
                  className="border-b border-[var(--app-border)] py-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
                >
                  {STATUS_MESSAGE.rate_limited}
                </p>
              )}
              <BarsView account={account} history={props.history} />
            </div>
          </>
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
        ))}
    </div>
  );
}
