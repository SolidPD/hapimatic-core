// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { ChevronIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";

/**
 * Reusable collapsible section with chevron toggle.
 *
 * Two layouts:
 * - **Icon variant** (Create-Session accordion sections): a colored left RAIL
 *   tinted with the section's `accentColor`, with the `icon` pinned at the top of
 *   the rail. The title sits at the top of the right column and ALL params share
 *   one left edge just right of the rail (params bring their own `px-3`, which
 *   aligns with the header's `px-3`). The rail stretches to the section's full
 *   height (`items-stretch`) so expanding "fills in" the rail downward while the
 *   icon stays put — collapsing retracts it. (#1948 rail redesign.)
 * - **Bar variant** (ScheduleSection's 8 sub-sections, which pass no `icon`):
 *   the original accent-bar + chevron header, unchanged.
 *
 * Optional props:
 * - `badge` / `badgeVariant`: small status pill rendered in the header.
 * - `summary`: one-line digest of the section's selections, shown ONLY collapsed.
 * - `openMaxHeightClass`: max-height clamp for the open content (default
 *   `max-h-[2000px]`); tall sections pass a larger clamp.
 */
export function CollapsibleLayer(props: {
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  badge?: string;
  badgeVariant?: "default" | "muted";
  accentColor?: string;
  icon?: React.ReactNode;
  summary?: React.ReactNode;
  openMaxHeightClass?: string;
  children: React.ReactNode;
}) {
  const variant = props.badgeVariant ?? "default";
  const badgeClass =
    variant === "muted"
      ? "text-red-400/70 bg-red-400/10"
      : "text-[var(--app-link)] bg-[var(--app-link)]/10";
  const openMaxHeightClass = props.openMaxHeightClass ?? "max-h-[2000px]";
  const accent = props.accentColor;

  const badge = props.badge ? (
    <span
      className={`whitespace-nowrap rounded-full px-1.5 py-0.5 text-[length:var(--text-caption-xs)] font-medium ${badgeClass}`}
    >
      {props.badge}
    </span>
  ) : null;

  // Clip the content while collapsed or mid-animation (overflow-hidden drives
  // the max-height transition), but switch to overflow-visible once the section
  // is fully open — so an absolutely-positioned dropdown inside a field
  // (Directory recent-paths, Link Issue search) can spill past the section
  // instead of being cropped by the next section. Collapsing clips immediately;
  // expanding waits for the open transition to finish.
  const [overflowVisible, setOverflowVisible] = useState(props.isOpen);
  useEffect(() => {
    if (!props.isOpen) setOverflowVisible(false);
  }, [props.isOpen]);

  const content = (
    <div
      className={`transition-all duration-200 ease-in-out ${
        props.isOpen ? `${openMaxHeightClass} opacity-100` : "max-h-0 opacity-0"
      } ${overflowVisible ? "overflow-visible" : "overflow-hidden"}`}
      onTransitionEnd={() => {
        if (props.isOpen) setOverflowVisible(true);
      }}
    >
      {props.icon ? (
        <div className="py-2">{props.children}</div>
      ) : (
        props.children
      )}
    </div>
  );

  // ── Icon variant: colored left rail ──
  //
  // Expanded vs collapsed differ structurally (#1948 → rotated-rail redesign):
  //  • Expanded — the heading text rotates 90° CCW into the rail, anchored just
  //    below the icon. The whole subsection is tinted with the section accent:
  //    the rail is a LIGHTER shade, the content area a DARKER shade. With no
  //    horizontal heading row, the params rise to the top of the section.
  //  • Collapsed — the original horizontal header (icon + title + summary +
  //    chevron) is shown, unchanged, so a glanceable digest stays visible.
  if (props.icon) {
    // Accent tints layered over the dark app bg: higher opacity reads "lighter"
    // (more of the bright accent shows through), lower opacity reads "darker"
    // (closer to the app bg). Rail > content so the rail is the lighter shade.
    // Token accents are `var(--accent-*)` strings, so the tint is derived via
    // `color-mix` (not hex-alpha concatenation, which a `var()` value breaks).
    // Percentages reproduce the prior `#RRGGBBAA` alpha bytes exactly:
    // 0x33=20%, 0x1a≈10.2%, 0x22≈13.33% (pixel-identical after 8-bit quantization).
    const railOpenBg = accent
      ? `color-mix(in srgb, ${accent} 20%, transparent)`
      : undefined; // lighter
    const contentOpenBg = accent
      ? `color-mix(in srgb, ${accent} 10.2%, transparent)`
      : undefined; // darker
    const railCollapsedBg = accent
      ? `color-mix(in srgb, ${accent} 13.33%, transparent)`
      : undefined;

    return (
      <div
        className="flex items-stretch"
        style={props.isOpen ? { backgroundColor: contentOpenBg } : undefined}
      >
        {/* Colored rail — decorative: icon pinned at top, rotated title beneath
          it when expanded. The toggle control is the corner chevron (right). */}
        <div
          aria-hidden="true"
          className="flex w-8 shrink-0 flex-col items-center pt-1.5"
          style={{
            backgroundColor: props.isOpen ? railOpenBg : railCollapsedBg,
            color: accent,
          }}
        >
          {props.icon}
          {props.isOpen && (
            <span
              className="mt-1.5 text-sm font-medium leading-none tracking-wide"
              style={{
                writingMode: "vertical-rl",
                transform: "rotate(180deg)",
                color: accent,
              }}
            >
              {props.title}
            </span>
          )}
        </div>

        <div className="relative min-w-0 flex-1">
          {/* Chevron — pinned to the section's upper-right corner, the SAME
            position whether expanded or collapsed (the universal accordion
            control). It is never placed in the rail. */}
          <Button
            type="button"
            variant="ghostStatic"
            onClick={props.onToggle}
            aria-label={`${props.isOpen ? "Collapse" : "Expand"} ${props.title}`}
            className="absolute right-1 top-1 z-10 h-auto p-1 hover:text-[var(--app-fg)]"
          >
            <ChevronIcon
              className="h-4 w-4 text-[var(--app-hint)]"
              collapsed={!props.isOpen}
            />
          </Button>

          {/* Collapsed: horizontal heading (title + summary). pr-9 keeps the
            text clear of the corner chevron. */}
          {!props.isOpen && (
            <Button
              type="button"
              variant="ghostStatic"
              onClick={props.onToggle}
              className="flex h-auto w-full items-center justify-start gap-2 rounded-none px-3 py-1.5 pr-9 text-left font-normal hover:text-[var(--app-fg)]"
            >
              <span
                className="truncate text-sm font-medium"
                style={accent ? { color: accent } : undefined}
              >
                {props.title}
              </span>
              {props.summary && (
                <span className="min-w-0 max-w-[62%] truncate rounded-full bg-[var(--app-link)]/10 px-2 py-0.5 text-[length:var(--text-caption)] font-medium text-[var(--app-link)]">
                  {props.summary}
                </span>
              )}
              {badge && <span className="ml-auto shrink-0">{badge}</span>}
            </Button>
          )}
          {content}
        </div>
      </div>
    );
  }

  // ── Bar variant (no icon): original accent-bar + chevron header ──
  return (
    <div className="px-3 py-1.5">
      <Button
        type="button"
        variant="ghostStatic"
        onClick={props.onToggle}
        className="flex h-auto w-full items-center justify-start gap-2 rounded-none py-0.5 text-sm font-medium text-[var(--app-fg)] hover:text-[var(--app-fg)]"
      >
        {props.accentColor && (
          <span
            aria-hidden="true"
            style={{ backgroundColor: props.accentColor }}
            className="h-3.5 w-1 shrink-0 rounded-full"
          />
        )}
        <span
          className="flex items-center"
          style={props.accentColor ? { color: props.accentColor } : undefined}
        >
          <ChevronIcon className="h-3.5 w-3.5" collapsed={!props.isOpen} />
        </span>
        <span
          style={props.accentColor ? { color: props.accentColor } : undefined}
        >
          {props.title}
        </span>
        {props.badge && (
          <span
            className={`ml-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[length:var(--text-caption-xs)] font-medium ${badgeClass}`}
          >
            {props.badge}
          </span>
        )}
        {!props.isOpen && props.summary && (
          <span className="ml-auto min-w-0 truncate text-right text-[length:var(--text-caption)] font-normal text-[var(--app-hint)]">
            {props.summary}
          </span>
        )}
      </Button>
      <div className={props.isOpen ? "mt-1.5" : ""}>{content}</div>
    </div>
  );
}
