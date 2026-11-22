// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode, SyntheticEvent } from "react";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * `HealthStrip` — a fixed-width bar with ONE cell per member, coloured by the
 * member's health and drawn worst first, so it reads as a stacked bar (issue
 * #6161, NP-1 pattern C, proposed extension 5). Its width never follows the
 * member count: at 6 members each cell is ~18 px on a phone, at 25 ~3 px. A
 * card that lists an unbounded set of members (an account's nodes; #6884: a
 * node's accounts) keeps one height at 1, 6 and 25 members.
 *
 * - **Anatomy**: one `HoverTooltipButton` holding the member count and the
 *   strip (a row of cells). The count and the strip are one indicator with one
 *   tooltip, the caller's summary (one line per state).
 * - **Props / API**: `tones` (one per member, any order; drawn worst first),
 *   `tooltip` (the bubble), `aria-label`, `showCount?` (default true),
 *   `className?`, `data-testid?`.
 * - **Tones**: `hot` (re-login, `--status-hot`), `warn` (ending / due,
 *   `--status-warn`), `held` (quarantined, `--status-sev-unknown`), `ok`
 *   (running, `--status-ok` at 70 %), `unknown` (not read, `--app-hint` at
 *   35 %). The order is the severity order.
 * - **Size**: the indicator takes `clamp(112px, 40%, 340px)` of its row; cells
 *   share it (2 px apart up to 24 members, 1 px up to 48, none beyond).
 * - **States**: static; a tap or hover opens the tooltip. On touch a 3 px cell
 *   cannot be tapped on its own, so the strip is a summary only: the detail is
 *   the caller's (the account card's chevron expands its tiles in place).
 * - **A11y**: a button with the caller's `aria-label` (the whole summary in one
 *   sentence); the cells are `aria-hidden`.
 * - **Clicks**: a tap never reaches the card it sits on (it would toggle it).
 */
export type HealthTone = "hot" | "warn" | "held" | "ok" | "unknown";

/** Worst first: the order the cells are drawn in. */
export const HEALTH_TONE_ORDER: readonly HealthTone[] = [
  "hot",
  "warn",
  "held",
  "ok",
  "unknown",
];

const TONE_CLASS: Record<HealthTone, string> = {
  hot: "bg-[var(--status-hot)]",
  warn: "bg-[var(--status-warn)]",
  held: "bg-[var(--status-sev-unknown)]",
  ok: "bg-[color-mix(in_srgb,var(--status-ok)_70%,var(--app-secondary-bg))]",
  unknown:
    "bg-[color-mix(in_srgb,var(--app-hint)_35%,var(--app-secondary-bg))]",
};

/** The cells' order: by tone severity, stable within a tone. */
export function orderHealthTones(tones: readonly HealthTone[]): HealthTone[] {
  return [...tones].sort(
    (a, b) => HEALTH_TONE_ORDER.indexOf(a) - HEALTH_TONE_ORDER.indexOf(b)
  );
}

/** The indicator's box: a fixed share of its row, whatever the member count. */
const STRIP_BOX_CLASS =
  "flex h-6 shrink-0 grow-0 basis-[clamp(112px,40%,340px)] items-center gap-1.5 rounded-sm hover:opacity-90"; /* design-tokens-allow: the strip's fixed share of its row (pattern C, #6161 NP-1); no spacing token expresses a clamp */

/** The gap between cells: it narrows as members grow, so cells keep width. */
function gapClass(count: number): string {
  if (count <= 24) return "gap-0.5";
  if (count <= 48) return "gap-px";
  return "gap-0";
}

export interface HealthStripProps {
  /** One tone per member, in any order; the strip draws them worst first. */
  tones: readonly HealthTone[];
  /** The tooltip: the caller's summary, one line per state. */
  tooltip: ReactNode;
  /** The whole summary as one sentence. */
  "aria-label": string;
  /** Show the member count before the strip (default true). */
  showCount?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function HealthStrip({
  tones,
  tooltip,
  "aria-label": ariaLabel,
  showCount = true,
  className,
  "data-testid": testId,
}: HealthStripProps) {
  if (tones.length === 0) return null;
  const ordered = orderHealthTones(tones);
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  return (
    <HoverTooltipButton
      type="button"
      data-testid={testId ?? "health-strip"}
      data-count={tones.length}
      aria-label={ariaLabel}
      content={tooltip}
      onClick={stop}
      onPointerDown={stop}
      className={cn(STRIP_BOX_CLASS, className)}
    >
      {showCount ? (
        <span
          data-testid="health-strip-count"
          className="shrink-0 text-[length:var(--text-caption)] tabular-nums leading-none text-[var(--app-hint)]"
        >
          {tones.length}
        </span>
      ) : null}
      <span
        aria-hidden="true"
        data-testid="health-strip-cells"
        className={`flex h-2.5 min-w-0 flex-1 overflow-hidden rounded-xs ${gapClass(tones.length)}`}
      >
        {ordered.map((tone, i) => (
          <span
            key={i}
            data-tone={tone}
            className={`h-full min-w-0 flex-1 rounded-xs ${TONE_CLASS[tone]}`}
          />
        ))}
      </span>
    </HoverTooltipButton>
  );
}
