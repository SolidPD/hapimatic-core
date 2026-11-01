// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { LayoutGrid } from "lucide-react";
import { USAGE_VIEW_IDS, type UsageViewId } from "@hapi/protocol/schemas";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/** A short static bar, the building block of the thumbnails. */
function Bar({ w }: { w: string }) {
  return (
    <span className="block h-1 rounded-full bg-[var(--app-subtle-bg)]">
      <span className={`block h-1 rounded-full bg-[var(--app-accent)] ${w}`} />
    </span>
  );
}

function BarsThumbnail() {
  return (
    <span className="flex w-full flex-col gap-1">
      <Bar w="w-1/3" />
      <Bar w="w-2/3" />
      <Bar w="w-1/4" />
    </span>
  );
}

function ArcsThumbnail() {
  return (
    <span className="flex w-full items-end justify-between gap-1">
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="block aspect-[2/1] flex-1 rounded-t-full border-4 border-b-0 border-[var(--app-accent)]"
        />
      ))}
    </span>
  );
}

function ChipsThumbnail() {
  return (
    <span className="grid w-full grid-cols-2 gap-1">
      {[0, 1, 2, 3].map(i => (
        <span
          key={i}
          className="block h-2 rounded-sm bg-[var(--app-subtle-bg)]"
        />
      ))}
    </span>
  );
}

/**
 * The selectable usage views (#4467 R5). The `Record` type forces one tile per
 * id in `USAGE_VIEW_IDS`. A fourth view also needs a branch where a view is
 * picked (`AccountUsageCard` and `OpenAiUsageMeter`), which the compiler does
 * not force.
 */
export const USAGE_VIEW_REGISTRY: Record<
  UsageViewId,
  { label: string; Thumbnail: () => ReactNode }
> = {
  bars: { label: "Bars", Thumbnail: BarsThumbnail },
  arcs: { label: "Arcs", Thumbnail: ArcsThumbnail },
  chips: { label: "Chips", Thumbnail: ChipsThumbnail },
};

/**
 * The ⊞ usage-view switcher in a provider section's header (#4467 R5, the S1
 * thumbnail switcher). The trigger shows the grid icon plus the current view's
 * name on desktop, and the icon only below `sm`. Its popover is a radiogroup of
 * thumbnail tiles with the current one checked: arrow keys move the focus,
 * Enter/Space or a click selects, which closes the popover and returns focus to
 * the trigger. Pointer-down never reaches the section's toggle.
 */
export function ViewSwitcherPopover({
  value,
  onChange,
  testId,
}: {
  value: UsageViewId;
  onChange: (view: UsageViewId) => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const tileRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = USAGE_VIEW_REGISTRY[value] ?? USAGE_VIEW_REGISTRY.bars;
  const ids = USAGE_VIEW_IDS;
  const checkedIndex = Math.max(0, ids.indexOf(value));

  const select = (id: UsageViewId) => {
    onChange(id);
    setOpen(false);
  };

  const onTileKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = ids.length - 1;
    let next: number;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = i >= last ? 0 : i + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = i <= 0 ? last : i - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    e.preventDefault();
    tileRefs.current[next]?.focus();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghostStatic"
          aria-label={`Usage view: ${current.label}`}
          data-testid={testId}
          onPointerDown={e => e.stopPropagation()}
          className="h-auto gap-1 rounded-md px-1.5 py-1 text-[length:var(--text-body-dense)] font-semibold hover:text-[var(--app-fg)]"
        >
          <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">{current.label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-auto p-2"
        onPointerDown={e => e.stopPropagation()}
        onOpenAutoFocus={e => {
          e.preventDefault();
          tileRefs.current[checkedIndex]?.focus();
        }}
      >
        <div
          role="radiogroup"
          aria-label="Usage view"
          className="flex gap-2"
          data-testid={testId ? `${testId}-tiles` : undefined}
        >
          {ids.map((id, i) => {
            const { label, Thumbnail } = USAGE_VIEW_REGISTRY[id];
            const checked = id === value;
            return (
              <Button
                key={id}
                ref={el => {
                  tileRefs.current[i] = el;
                }}
                type="button"
                variant="ghostStatic"
                size="bare"
                role="radio"
                aria-checked={checked}
                tabIndex={i === checkedIndex ? 0 : -1}
                data-testid={testId ? `${testId}-tile-${id}` : undefined}
                onClick={() => select(id)}
                onKeyDown={e => onTileKeyDown(e, i)}
                className={`flex w-20 flex-col items-stretch gap-1.5 rounded-md border p-2 text-[length:var(--text-caption)] font-medium ${
                  checked
                    ? "border-[var(--app-accent)] text-[var(--app-fg)]"
                    : "border-[var(--app-border)] text-[var(--app-hint)]"
                }`}
              >
                <span className="flex h-6 items-center">
                  <Thumbnail />
                </span>
                <span className="text-center">{label}</span>
              </Button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
