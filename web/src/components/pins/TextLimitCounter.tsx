// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { HoverTooltip } from "@/components/ui/tooltip";
import {
  textLimitState,
  textLimitText,
  textLimitTooltip,
  type TextLimitWhat,
} from "@/lib/pins/textLimit";
import { cn } from "@/lib/utils";

/**
 * #6969 (D3, R2): the one line under a Pins text box that says how much room is
 * left. Nothing shows below 80% of the limit (the density rule, R10-b); from
 * 80% the line reads "1,812 characters left" in the hint colour, from 95% in
 * the warn colour, and past the limit "312 characters over the limit; shorten
 * the note to send it". The box never cuts the text, so this line is how the
 * operator learns a note is too long before Submit holds it.
 *
 * A proposed extension (authoring guide, "Survey first"): the only counter
 * before it is the always-visible "(n/max)" of the session notes, which would
 * cost a line on every open box. Its tooltip names the limit. A visually
 * hidden polite live region speaks only when the line appears, changes level,
 * or goes, so a screen reader is not read every keystroke; the box names the
 * line itself in `aria-describedby` (`id`) while it shows.
 */
export function TextLimitCounter(props: {
  /** The text's length, as the box counts it. */
  length: number;
  limit: number;
  what: TextLimitWhat;
  /** The line's id, for the box's `aria-describedby`. */
  id: string;
}) {
  const state = textLimitState(props.length, props.limit);
  const text = textLimitText(state, props.what);
  const level = state.show ? state.level : "none";
  // Set during render when the level moves, so the live region changes once
  // per crossing and never on a keystroke that stays in the same level. A box
  // that opens already near its limit says nothing until a crossing: the line
  // is in the box's description.
  const [crossing, setCrossing] = useState({ level, said: "" });
  if (crossing.level !== level) {
    setCrossing({ level, said: state.show ? text : "" });
  }
  return (
    <>
      {state.show ? (
        <HoverTooltip content={textLimitTooltip(props.limit, props.what)}>
          <span
            id={props.id}
            data-level={state.level}
            className={cn(
              "mt-1 block text-[length:var(--text-caption)]",
              state.level === "hint"
                ? "text-[var(--app-hint)]"
                : "text-[var(--status-warn)]"
            )}
          >
            {text}
          </span>
        </HoverTooltip>
      ) : null}
      <span aria-live="polite" className="sr-only">
        {crossing.said}
      </span>
    </>
  );
}
