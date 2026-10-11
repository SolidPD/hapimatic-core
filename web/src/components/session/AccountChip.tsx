// SPDX-License-Identifier: AGPL-3.0-only
/**
 * AccountChip — the shared "entity" pill for an account (taxonomy: Row-1
 * **Account Badge** of the Session Basic Info Bar + the composer's **Account
 * Chip** in the Session Config Cluster). E6 `.entity` = a colored monogram dot
 * followed by the account's short label, in a `rounded-md` chip — the same
 * corner as the Node Badge beside it and the loop/agents/shell chips beneath
 * (it was the cluster's only `rounded-full` pill until 2026-10-05).
 *
 * ONE component so the list card, the instance header (#3287) and the Session
 * Config Cluster (#3289) render byte-identical chips (epic #3285 correction pass
 * 1 — the Row-1 badge had shipped as raw email text).
 *
 * The label is the account **nickname** (operator-set, resolved by the consumer
 * via `useAccountLabel`: nickname → displayName → email local part) cut to the
 * `ACCOUNT_CHIP_MAX_CHARS` budget, so the chip's width is bounded by a known
 * worst case (operator ruling 2026-09-05). The monogram is the label's initial
 * ("W" for Work, "M" for Mose — as in the E6 mockups) unless the operator pinned
 * one or two letters ("NF"; `ACCOUNT_MONO_MAX_CHARS`), in which case the bubble
 * widens into a pill; its color is a stable per-email hash so the same account
 * is the same color everywhere.
 *
 * `compact` = monogram-only (the overflow-ladder L1 form). `dashed` = the
 * disconnected/staged border treatment. Purely presentational — the consumer
 * owns the tap target and its pointer-event isolation.
 */
import {
  ACCOUNT_CHIP_MAX_CHARS,
  accountMonogram,
  accountShortName,
  truncateAccountLabel,
} from "@/components/session/accountLabel";
import {
  ACCOUNT_MONO_COLOR_IDS,
  ACCOUNT_MONO_MAX_CHARS,
  type AccountMonoColorId,
  type AccountMonogram,
} from "@hapi/protocol";

// Per-account monogram colors — the E6 `--id-*` palette maps 1:1 to Tailwind
// palette colors (NOT the runtime-swappable mint accent, so token-rule-safe).
// Literal strings so Tailwind's JIT includes them. This id → class map is the
// ONE source of the six literals; it is keyed by the shared
// ACCOUNT_MONO_COLOR_IDS so a stored override's color id (#3621) resolves to the
// exact same class the per-email hash produces.
export const MONO_CLASS_BY_ID: Record<AccountMonoColorId, string> = {
  blue: "bg-blue-400",
  violet: "bg-violet-400",
  cyan: "bg-cyan-400",
  teal: "bg-teal-400",
  pink: "bg-pink-400",
  amber: "bg-amber-400",
};

// The hash palette is the same six classes in ACCOUNT_MONO_COLOR_IDS order, so an
// un-overridden chip keeps its exact pre-#3621 hash color (R4 — byte-identical).
const ACCOUNT_MONO_COLORS = ACCOUNT_MONO_COLOR_IDS.map(
  id => MONO_CLASS_BY_ID[id]
);

/** Stable per-email monogram color (hash → palette index). */
export function accountMonogramColor(email: string): string {
  let h = 0;
  for (let i = 0; i < email.length; i++) {
    h = (h * 31 + email.charCodeAt(i)) >>> 0;
  }
  return ACCOUNT_MONO_COLORS[h % ACCOUNT_MONO_COLORS.length];
}

export { accountShortName } from "@/components/session/accountLabel";

export function AccountChip(props: {
  email: string;
  /** Resolved nickname (see `useAccountLabel`); falls back to the email local part. */
  label?: string;
  /** Operator-set monogram override (letter + color) — issue #3621. Any present
   * field wins; an absent field keeps the pre-override default (derived letter /
   * per-email hash color), so an un-overridden chip is byte-identical to pre-#3621
   * (R4). Passed by the consumer from `useAccountMonogram` — the chip stays
   * hook-free (presentational contract). */
  monogram?: AccountMonogram;
  /** Monogram only (overflow-ladder L1 / narrow surfaces). */
  compact?: boolean;
  /** Disconnected/staged state → dashed border. */
  dashed?: boolean;
  /** Character budget for the label (default `ACCOUNT_CHIP_MAX_CHARS`). */
  maxChars?: number;
  className?: string;
}) {
  const {
    email,
    label,
    monogram,
    compact = false,
    dashed = false,
    maxChars = ACCOUNT_CHIP_MAX_CHARS,
    className = "",
  } = props;
  const fullLabel = (label ?? "").trim() || accountShortName(email);
  const name = truncateAccountLabel(fullLabel, maxChars);
  // #3621: a present override field wins; an absent field keeps the pre-override
  // default (derived letter / per-email hash color), so R4 holds byte-identical.
  const monoColorClass = monogram?.color
    ? MONO_CLASS_BY_ID[monogram.color]
    : accountMonogramColor(email);
  // A pinned override may be one OR two letters (ACCOUNT_MONO_MAX_CHARS); the
  // slice is a defensive cap on a hand-edited sidecar file. Auto stays the
  // single initial.
  const monoLetter = (monogram?.letter ?? accountMonogram(fullLabel)).slice(
    0,
    ACCOUNT_MONO_MAX_CHARS
  );
  return (
    <span
      data-testid="account-chip"
      title={fullLabel === email ? email : `${fullLabel} · ${email}`}
      className={`inline-flex min-w-0 max-w-full items-center gap-0.5 whitespace-nowrap rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] py-0.5 pl-0.5 text-[length:var(--text-caption-xs)] font-semibold leading-none text-[var(--app-fg)] ${
        compact ? "pr-0.5" : "pr-1"
      } ${dashed ? "border-dashed" : ""} ${className}`} /* gap-0.5 + pr-1 (was gap-1 + pr-1.5): the chip's fixed chrome drops 28→24px so the nickname gets 52px of the 76px cell — on-device (iOS SF Pro) "Matt [NF]" ellipsized at 48px (2026-09-06 review) */
    >
      {/* min-w (not a fixed w) + px: one letter keeps the 14px circle (the
          padded glyph is narrower than the min-width); two letters widen it into
          a rounded pill. */}
      <span
        aria-hidden="true"
        className={`flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-full px-0.5 text-[length:var(--text-caption-xs)] font-bold leading-none tracking-tight text-[var(--app-bg)] ${monoColorClass}`}
      >
        {monoLetter}
      </span>
      {compact ? null : <span className="truncate">{name}</span>}
    </span>
  );
}
