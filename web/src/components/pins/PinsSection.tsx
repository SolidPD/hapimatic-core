// SPDX-License-Identifier: AGPL-3.0-only
import { useId, type CSSProperties, type ReactNode } from "react";
import {
  CalendarClock,
  CircleCheck,
  Lock,
  Pin as PinGlyph,
  Timer,
} from "lucide-react";
import { tokens } from "@/design/tokens";
import { pinKindMeta } from "@/components/pins/pinsShared";
import { GroupToggleHeader } from "@/components/ui/GroupToggleHeader";
import { HoverTooltip } from "@/components/ui/tooltip";
import type { PinSectionLook } from "@/lib/pins/view";

type Look = { color: string; icon: typeof PinGlyph };

/** A section's icon and color, per grouping (#6451; mockup v6 `groups` :804-809). */
export function sectionLook(look: PinSectionLook, kind?: string): Look {
  switch (look) {
    case "completed":
      return { color: tokens.pins.sectionCompleted, icon: CircleCheck };
    case "kind": {
      const meta = pinKindMeta(kind ?? "");
      return { color: meta.color, icon: meta.icon };
    }
    case "source":
      return { color: tokens.view.pins, icon: PinGlyph };
    case "soon":
      return { color: "var(--status-warn)", icon: Timer };
    case "later":
      return { color: "var(--status-warn)", icon: CalendarClock };
    case "nodeadline":
      return { color: tokens.pins.sectionAction, icon: Lock };
    case "all":
      return { color: tokens.pins.sectionCompleted, icon: PinGlyph };
    case "pm":
      return {
        color: tokens.pins.sectionPm,
        icon: pinKindMeta("dashboard").icon,
      };
    case "action":
    default:
      return { color: tokens.pins.sectionAction, icon: PinGlyph };
  }
}

const SECTION_ICON: CSSProperties = { width: "14px", height: "14px" };

/**
 * #6449 (R4): one Ledger section in the H2 outlined treatment (mockup v6
 * :117-133): a 1px outline in the section color around a header bar that
 * reads as a header, not a row, and the rows it contains. The bar is the
 * shared `GroupToggleHeader` (its standalone form, so the tooltip covers the
 * bar alone); the tooltip names the action and the count. A collapsed
 * section's rows are not mounted at all.
 */
export function PinsSection(props: {
  id: string;
  look: PinSectionLook;
  /** For a `kind` section, the kind whose icon and color it wears. */
  kind?: string;
  title: string;
  count: number;
  open: boolean;
  onToggle: (id: string) => void;
  children: ReactNode;
}) {
  const look = sectionLook(props.look, props.kind);
  const Icon = look.icon;
  const bodyId = useId();
  return (
    <section
      aria-label={props.title}
      className="mx-1.5 mt-1.5 overflow-hidden rounded-md border"
      style={{
        borderColor: `color-mix(in srgb, ${look.color} 55%, transparent)`,
      }}
    >
      <HoverTooltip
        content={`${props.open ? "Collapse" : "Expand"} · ${props.count} in this section`}
      >
        <div>
          <GroupToggleHeader
            collapsed={!props.open}
            onToggle={() => props.onToggle(props.id)}
            icon={
              <Icon
                style={{ ...SECTION_ICON, color: look.color }}
                aria-hidden
              />
            }
            label={
              <span className="font-bold uppercase tracking-wider text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
                {props.title}
              </span>
            }
            trailing={
              <span
                aria-label={`${props.count} in this section`}
                className="inline-grid place-items-center rounded-full bg-[var(--app-deepest-bg)]/60 px-1.5 font-bold tabular-nums text-[var(--app-fg)]"
                style={{ minWidth: "22px", height: "18px", fontSize: "11px" }}
              >
                {props.count}
              </span>
            }
            aria-controls={props.open ? bodyId : undefined}
            className="min-h-7.5 gap-2 bg-[var(--pins-section-header-bg)] py-1 pl-2 pr-1 text-[var(--app-fg)] hover:bg-[var(--pins-section-header-bg)]"
          />
        </div>
      </HoverTooltip>
      {props.open ? (
        <div id={bodyId} className="pb-0.5 pl-3.5 pr-1 pt-0.5">
          {props.children}
        </div>
      ) : null}
    </section>
  );
}
