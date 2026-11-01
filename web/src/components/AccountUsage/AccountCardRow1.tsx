// SPDX-License-Identifier: AGPL-3.0-only
/**
 * AccountCardRow1 — the ONE row-1 contract of every card on the Accounts page
 * (issue #4466, R3): the Anthropic and OpenAI account cards, every API-key card,
 * and the account picker (`AccountSelectorModal`, E-4 A). Sharing the row keeps
 * the contract from drifting between them.
 *
 * In order: a 22px monogram that never shrinks or widens · the nickname (its
 * tooltip reveals the full email, or a key's name) · the email or masked key,
 * clipped by a right-hand fade, never an ellipsis · the plan chip · a spacer ·
 * the alert icon · the score · the chevron.
 *
 * Two variants:
 * - **Page** (`onSelect` absent): the email sits alone in a content-sized
 *   expand button; the plan chip and the spacer sit OUTSIDE every button,
 *   because a press that starts on a `button` never arms the press-and-hold
 *   reorder (`INTERACTIVE_SELECTOR`, `SortableListEntry.tsx`) and a collapsed
 *   card has no other surface to arm it (R12).
 * - **Picker** (`onSelect` set): one select button spans the nickname, the email
 *   and the plan chip, so a tap anywhere on the name selects the account; the
 *   nickname has no tooltip trigger there.
 *
 * Presentational: the parent owns the expanded state, the editor and the data.
 */
import type { KeyboardEventHandler, ReactNode } from "react";
import {
  ACCOUNT_MONO_MAX_CHARS,
  HARD_LOCK_UTILIZATION,
  type AccountMonogram,
  type HardLock,
} from "@hapi/protocol";
import type { RedactedApiKey } from "@hapi/protocol/schemas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import { ChevronIcon } from "@/components/icons";
import { FadeTruncate } from "@/components/session";
import { scoreLevel, LEVEL_COLOR } from "./UsageBar";
import { API_KEY_STATUS_META } from "@/lib/apiKeyStatus";
import { AccountAlertIcon, type AlertNodeEntry } from "./AccountAlertIcon";
import {
  MONO_CLASS_BY_ID,
  accountMonogramColor,
} from "@/components/session/AccountChip";
import { accountMonogram } from "@/components/session/accountLabel";

/**
 * The row-1 monogram of any card (#4466 R3): a stored override wins field by
 * field; otherwise the letter derives from the label and the colour hashes the
 * seed, as `AccountChip` does. The seed is an account's email (else its uuid) or
 * a key's id — the seed the monogram editor's subject carries, so the card and
 * the editor agree.
 */
export function rowMonogram(input: {
  override?: AccountMonogram;
  label: string;
  seed: string;
}): { letter: string; colorClass: string } {
  return {
    letter: (input.override?.letter ?? accountMonogram(input.label)).slice(
      0,
      ACCOUNT_MONO_MAX_CHARS
    ),
    colorClass: input.override?.color
      ? MONO_CLASS_BY_ID[input.override.color]
      : accountMonogramColor(input.seed),
  };
}

/** A key card's status pill (R3, R9a): a `Badge` with a dot coloured by `API_KEY_STATUS_META`. */
export function ApiKeyStatusPill(props: { status: RedactedApiKey["status"] }) {
  const meta = API_KEY_STATUS_META[props.status] ?? API_KEY_STATUS_META.none;
  return (
    <Badge
      data-testid="api-key-status-pill"
      data-status={props.status}
      className="shrink-0 gap-1 px-1.5 py-0 text-[length:var(--text-caption-xs)] font-semibold leading-none"
      style={{ color: meta.color }}
    >
      <span
        aria-hidden="true"
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: meta.color }}
      />
      {meta.label}
    </Badge>
  );
}

export type AccountCardRow1Props = {
  monogram: { letter: string; colorClass: string };
  /** Opens the monogram editor; absent ⇒ the monogram is not a tap target. */
  onMonogramTap?: () => void;
  /** Accessible name of the monogram button (e.g. "Edit account chip for …"). */
  monogramLabel?: string;
  nickname: string;
  /** What the nickname's tooltip reveals: the full email, or a key's name. */
  revealText: string;
  /** The email, or the masked key on a key card. `""` ⇒ no second string (an
   *  email-less account whose label is already the nickname). */
  secondary: string;
  /** Monospace the secondary text (a masked key). */
  secondaryMono?: boolean;
  /** The plan chip text ("Max 20x", "API key", …); absent ⇒ no chip. */
  planLabel?: string;
  /** One entry per node needing re-login; absent or empty ⇒ no alert icon. */
  alertNodes?: AlertNodeEntry[];
  /** `undefined` ⇒ no score element (key cards); `null` ⇒ the muted "—". */
  score?: number | null;
  /** Issue #5879: the window holding the account at its cap (`null` = none).
   *  Drives the visible "Locked" / "Near limit" label beside the score; absent
   *  ⇒ no label at all (the account picker, which captions the card itself). */
  hardLock?: HardLock | null;
  /** A key card's status pill. */
  statusPill?: ReactNode;
  /** Move the status pill to a second row below `sm` (R11). */
  statusPillWraps?: boolean;
  /** The picker's "Current" marker, after the plan chip. */
  currentMarker?: boolean;
  expanded?: boolean;
  /** Expand/collapse; absent ⇒ no chevron and a static secondary (a picker key
   *  row has nothing to expand). */
  onToggle?: () => void;
  /** Picker variant: one select button over the name. */
  onSelect?: () => void;
  /** Picker variant: the row is shown but cannot be selected. */
  selectDisabled?: boolean;
  /** Accessible name of the picker's select button. */
  selectLabel?: string;
  /** Accessible name of the chevron (names the card, R12 a11y). */
  toggleLabel?: string;
  /** #3537: the sortable a11y attributes + keyboard reorder ride the chevron. */
  dragAttributes?: Record<string, unknown>;
  dragKeyDown?: KeyboardEventHandler;
};

/** The plan chip: a span (valid inside the picker's select button), styled as
 *  the card's old plan `Badge`. */
function PlanChip({ label }: { label: string }) {
  return (
    <span
      data-testid="account-plan-chip"
      className="inline-flex shrink-0 items-center rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1.5 py-0 text-[length:var(--text-caption-xs)] font-semibold leading-none text-[var(--app-fg)]"
    >
      {label}
    </span>
  );
}

/** The account pacing score badge (epic #2038 A2), lifted from
 *  `AccountUsageCard`: band-coloured headline, LOWER = more attractive; a null
 *  or non-finite score renders the muted "—". */
function ScoreBadge({ score }: { score: number | null }) {
  const hasScore = score != null && Number.isFinite(score);
  if (hasScore) {
    return (
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
    );
  }
  return (
    <span
      data-testid="account-score-badge"
      className="inline-flex shrink-0 items-center rounded-full border border-[var(--app-border)] px-2 py-0.5 text-xs font-semibold tabular-nums text-[var(--app-hint)]"
      title="Account pacing score (lower = more available)"
    >
      —
    </span>
  );
}

/**
 * Issue #5879: what the score means, in words, beside the badge. "Locked" when a
 * window is at its cap until a future reset (a spawn pinned to it is refused);
 * "Near limit" when the score already reads the cap without a locked window (a
 * five-hour window at ~99 % scores 100). Nothing otherwise.
 */
function ScoreMeaning({
  score,
  hardLock,
}: {
  score: number | null;
  hardLock: HardLock | null;
}) {
  const label = hardLock
    ? "Locked"
    : score != null && Number.isFinite(score) && score >= HARD_LOCK_UTILIZATION
      ? "Near limit"
      : null;
  if (!label) return null;
  return (
    <span
      data-testid="account-score-meaning"
      className="shrink-0 text-[length:var(--text-caption-xs)] font-semibold"
      style={{ color: LEVEL_COLOR[hardLock ? "red" : "amber"] }}
    >
      {label}
    </span>
  );
}

export function AccountCardRow1(props: AccountCardRow1Props) {
  const {
    monogram,
    onMonogramTap,
    monogramLabel,
    nickname,
    revealText,
    secondary,
    secondaryMono = false,
    planLabel,
    alertNodes,
    score,
    statusPill,
    statusPillWraps = false,
    currentMarker = false,
    expanded = false,
    onToggle,
    onSelect,
    selectDisabled = false,
    selectLabel,
    toggleLabel = "Toggle account details",
    dragAttributes,
    dragKeyDown,
  } = props;

  // size-5.5 = 22px; no min-w / px so a two-letter override cannot widen it.
  const monoClass = `flex size-5.5 shrink-0 items-center justify-center rounded-full text-[length:var(--text-caption-xs)] font-bold leading-none text-[var(--app-bg)] ${monogram.colorClass}`;
  const monoNode = onMonogramTap ? (
    <Button
      type="button"
      variant="ghostStatic"
      size="bare"
      data-testid="account-monogram"
      aria-label={monogramLabel ?? `Edit monogram for ${nickname}`}
      title="Edit nickname, monogram and color"
      onClick={e => {
        e.stopPropagation();
        onMonogramTap();
      }}
      onPointerDown={e => e.stopPropagation()}
      className={`${monoClass} hover:opacity-80`}
    >
      {monogram.letter}
    </Button>
  ) : (
    <span
      data-testid="account-monogram"
      aria-hidden="true"
      className={monoClass}
    >
      {monogram.letter}
    </span>
  );

  const secondaryClass = `text-[length:var(--text-body-dense)] text-[var(--app-hint)]${
    secondaryMono ? " font-mono" : ""
  }`;
  const nicknameClass =
    "max-w-24 text-[length:var(--text-label-strong)] font-semibold leading-none text-[var(--app-fg)] sm:max-w-48";

  const pill =
    statusPill == null ? null : statusPillWraps ? (
      <span className="hidden shrink-0 sm:inline-flex">{statusPill}</span>
    ) : (
      <span className="inline-flex shrink-0">{statusPill}</span>
    );

  const current = currentMarker ? (
    <span
      data-testid="account-current-marker"
      className="inline-flex shrink-0 items-center rounded-full border border-[var(--app-badge-success-border)] bg-[var(--app-badge-success-bg)] px-1.5 py-0 text-[length:var(--text-caption-xs)] font-semibold leading-none text-[var(--app-badge-success-text)]"
    >
      Current
    </span>
  ) : null;

  return (
    <div data-testid="account-card-row1">
      <div className="flex min-w-0 items-center gap-1.5">
        {monoNode}
        {onSelect ? (
          // Picker: ONE select target over the nickname, the email and the plan chip.
          <Button
            type="button"
            variant="ghostStatic"
            size="bare"
            data-testid="account-select-button"
            aria-label={selectLabel}
            disabled={selectDisabled}
            onClick={onSelect}
            className="flex min-w-0 flex-1 cursor-pointer items-center justify-start gap-1.5 text-left font-normal hover:text-[var(--app-fg)] disabled:cursor-not-allowed"
          >
            <FadeTruncate className={`shrink-0 ${nicknameClass}`}>
              {nickname}
            </FadeTruncate>
            {secondary ? (
              <FadeTruncate className={`shrink ${secondaryClass}`}>
                {secondary}
              </FadeTruncate>
            ) : null}
            {planLabel ? <PlanChip label={planLabel} /> : null}
          </Button>
        ) : (
          <>
            <HoverTooltipButton
              type="button"
              data-testid="account-nickname"
              content={revealText}
              onClick={e => e.stopPropagation()}
              className="flex min-w-0 shrink-0 items-center rounded-sm text-left"
            >
              <FadeTruncate className={nicknameClass}>{nickname}</FadeTruncate>
            </HoverTooltipButton>
            {/* Content-sized (min-w-0 shrink, NOT flex-1): the spacer below takes
                the free width, and this is the first element to give way (R11).
                Keyboard expand stays here (the chevron's Enter/Space is the
                keyboard reorder once armed, OR-3). */}
            {secondary ? (
              <Button
                type="button"
                variant="ghostStatic"
                size="bare"
                data-testid="account-secondary-toggle"
                aria-expanded={expanded}
                onClick={onToggle}
                className="flex min-w-0 shrink items-center justify-start text-left font-normal hover:text-[var(--app-fg)]"
              >
                <FadeTruncate className={secondaryClass}>
                  {secondary}
                </FadeTruncate>
              </Button>
            ) : null}
            {planLabel ? <PlanChip label={planLabel} /> : null}
          </>
        )}
        {current}
        {pill}
        {/* The spacer: a real element, outside every button, so a press on it arms
            the press-and-hold reorder of a collapsed card (R12). */}
        {onSelect ? null : (
          <span data-testid="account-row1-spacer" className="min-w-0 flex-1" />
        )}
        {alertNodes && alertNodes.length > 0 ? (
          <AccountAlertIcon nodes={alertNodes} />
        ) : null}
        {score === undefined || props.hardLock === undefined ? null : (
          <ScoreMeaning score={score} hardLock={props.hardLock} />
        )}
        {score === undefined ? null : <ScoreBadge score={score} />}
        {onToggle ? (
          <Button
            type="button"
            variant="ghostStatic"
            // #3537 (R9): the chevron is ALSO the keyboard reorder handle. Spread
            // BEFORE aria-expanded/aria-label so its own attributes win.
            {...dragAttributes}
            onKeyDown={dragKeyDown}
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={toggleLabel}
            data-testid="account-card-chevron"
            className="h-auto shrink-0 p-0 hover:text-[var(--app-fg)]"
          >
            <ChevronIcon
              className="h-3.5 w-3.5 text-[var(--app-hint)]"
              collapsed={!expanded}
            />
          </Button>
        ) : null}
      </div>
      {pill != null && statusPillWraps ? (
        <div className="mt-1 flex sm:hidden">{statusPill}</div>
      ) : null}
    </div>
  );
}
