// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Switch — the track and thumb of an on/off control (#6646, review P19).
 *
 * It is the drawing only: the caller's own button carries `role="switch"` and
 * `aria-checked` and holds a label beside it, so the whole line is the tap
 * target and a missed tap cannot fall through to whatever sits under it (the
 * timer menu's "Billable" line, the notification settings rows). The track is
 * therefore `aria-hidden`.
 *
 * Two sizes: `sm` (26 by 14, inside a menu line) and `md` (44 by 24, a settings
 * row). On is the accent, off the border tone; a disabled switch dims.
 */
import { cn } from "@/lib/utils";

export type SwitchSize = "sm" | "md";

const TRACK: Record<SwitchSize, string> = {
  sm: "h-3.5 w-6.5",
  md: "h-6 w-11",
};

const THUMB: Record<SwitchSize, string> = {
  sm: "h-2.5 w-2.5",
  md: "h-5 w-5",
};

const THUMB_ON: Record<SwitchSize, string> = {
  sm: "translate-x-3",
  md: "translate-x-5",
};

export function Switch(props: {
  checked: boolean;
  size?: SwitchSize;
  disabled?: boolean;
  className?: string;
}) {
  const { checked, size = "sm", disabled = false, className } = props;
  return (
    <span
      aria-hidden="true"
      data-state={checked ? "on" : "off"}
      className={cn(
        "relative inline-block shrink-0 rounded-full transition-colors",
        TRACK[size],
        checked ? "bg-[var(--app-accent)]" : "bg-[var(--app-border)]",
        disabled && "opacity-50",
        className
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 rounded-full bg-white transition-transform",
          THUMB[size],
          checked ? THUMB_ON[size] : "translate-x-0"
        )}
      />
    </span>
  );
}
