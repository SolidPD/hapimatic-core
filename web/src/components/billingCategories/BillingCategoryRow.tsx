// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6779 (plan section 6): one billing category as one compact row (R10-a:
 * its own rounded box, 1px border, no padding inflation; R10-b: name, Default,
 * rate and the actions menu on one line). The name truncates with
 * `FadeTruncate` before the row wraps. Indicators carry a `HoverTooltip`; the
 * menu trigger carries a native `title` (review W7).
 */
import { forwardRef, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import {
  formatRateMinor,
  isBillingCurrency,
  type BillingCategoryListItem,
  type BillingRate,
} from "@hapi/protocol";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HoverTooltip } from "@/components/ui/tooltip";
import { FadeTruncate } from "@/components/session/FadeTruncate";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DragRowListeners } from "@/components/SessionList/SortableListEntry";

/**
 * The row box: the Pins rows' outline (`PinRow.tsx`), no padding inflation.
 * The rate sits at the row's right edge, so its tooltip aligns its end with the
 * rate: a centered bubble passed the content column at a 2560px window, and
 * the default side still slides sideways to stay on a 393px screen (TIP-1).
 */
export const BILLING_ROW_BOX =
  "flex min-w-0 items-center gap-2 overflow-hidden rounded-md border border-[var(--app-border)] px-2 py-1";

/** The sentence for a currency this build's ISO 4217 table lacks (PR2-R3a). */
export function unknownCurrencyTitle(code: string): string {
  return `This version does not know the currency ${code}.`;
}

/**
 * A rate as a person reads it, `160.00 USD/h`, or the bare code when this
 * build cannot read the currency (PR2-R3: never handed to `formatRateMinor`).
 */
export function rateLabel(
  rate: BillingRate
): { text: string; known: true } | { text: string; known: false } {
  if (!isBillingCurrency(rate.currency)) {
    return { text: rate.currency, known: false };
  }
  return {
    text: `${formatRateMinor(rate.minor, rate.currency)}/h`,
    known: true,
  };
}

export type BillingCategoryRowActions = {
  onEdit?: () => void;
  onSetDefault?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRetire?: () => void;
  onRestore?: () => void;
};

type RowProps = {
  category: BillingCategoryListItem;
  isDefault: boolean;
  /** Absent on a read-only page: no menu is rendered. */
  actions?: BillingCategoryRowActions;
  /** The drag's pointer and touch listeners (an editable offered row only). */
  dragListeners?: DragRowListeners;
  isDragging?: boolean;
};

function MenuItem(props: { onSelect?: () => void; children: ReactNode }) {
  if (!props.onSelect) return null;
  return (
    <DropdownMenuItem onSelect={props.onSelect}>
      {props.children}
    </DropdownMenuItem>
  );
}

/**
 * The row. `ref` lands on the actions menu trigger, so the page can move focus
 * to the next row's menu after a retire.
 */
export const BillingCategoryRow = forwardRef<HTMLButtonElement, RowProps>(
  function BillingCategoryRow(
    { category, isDefault, actions, dragListeners, isDragging },
    menuRef
  ) {
    const rate = category.defaultRate ? rateLabel(category.defaultRate) : null;
    const hasActions =
      actions && Object.values(actions).some(action => action !== undefined);
    return (
      <div
        data-testid="billing-category-row"
        data-category-id={category.id}
        className={`${BILLING_ROW_BOX} bg-[var(--app-bg)] ${
          isDragging ? "opacity-90" : ""
        }`}
        {...dragListeners}
      >
        <FadeTruncate className="min-w-0 flex-1 text-sm text-[var(--app-fg)]">
          {category.name}
        </FadeTruncate>
        {isDefault && (
          <HoverTooltip
            content="New tracked sessions start with this category"
            align="end"
          >
            <Badge variant="mint" className="shrink-0" tabIndex={0}>
              Default
            </Badge>
          </HoverTooltip>
        )}
        {rate === null ? (
          <span className="shrink-0 text-xs text-[var(--app-hint)]">
            No rate
          </span>
        ) : rate.known ? (
          <HoverTooltip
            content="Prefilled as the hourly rate on the Create page"
            align="end"
          >
            <span
              className="shrink-0 text-sm tabular-nums text-[var(--app-fg)]"
              tabIndex={0}
            >
              {rate.text}
            </span>
          </HoverTooltip>
        ) : (
          <span
            className="shrink-0 text-xs text-[var(--status-warn)]"
            title={unknownCurrencyTitle(rate.text)}
          >
            {rate.text}
          </span>
        )}
        {hasActions && actions && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                ref={menuRef}
                type="button"
                variant="ghost"
                size="bare"
                title={`Actions for ${category.name}`}
                aria-label={`Actions for ${category.name}`}
                className="h-7 w-7 shrink-0 rounded-md text-[var(--app-hint)]"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <MenuItem onSelect={actions.onEdit}>Edit</MenuItem>
              <MenuItem onSelect={actions.onSetDefault}>
                Set as default
              </MenuItem>
              <MenuItem onSelect={actions.onMoveUp}>Move up</MenuItem>
              <MenuItem onSelect={actions.onMoveDown}>Move down</MenuItem>
              <MenuItem onSelect={actions.onRetire}>Retire</MenuItem>
              <MenuItem onSelect={actions.onRestore}>Restore</MenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    );
  }
);
