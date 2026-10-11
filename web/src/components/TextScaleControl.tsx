// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";

type TextScaleControlProps = {
  scaleLabel: string;
  onIncrement: () => void;
  onDecrement: () => void;
  canIncrement: boolean;
  canDecrement: boolean;
};

const AUTO_COLLAPSE_MS = 2500;

export function TextScaleControl(props: TextScaleControlProps) {
  const [expanded, setExpanded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setExpanded(false), AUTO_COLLAPSE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleToggle = () => {
    setExpanded(true);
    resetTimer();
  };

  const handleAction = (fn: () => void) => {
    fn();
    resetTimer();
  };

  const btnClass =
    "flex h-6 w-6 items-center justify-center rounded text-[length:var(--text-caption)] font-semibold transition-colors";
  const enabledClass =
    "text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] active:bg-[var(--app-hover)]";
  const disabledClass =
    "text-[var(--app-hint)]/30 cursor-default disabled:cursor-default disabled:opacity-100";

  if (!expanded) {
    return (
      // Collapsed label lives INSIDE the bookmark gutter column (E9
      // text-scale-gutter mockup; epic #3285 round 13): w-6 (24px) = the thread's
      // pl-1 (4px) + BookmarkGutter's w-5 (20px), no side padding, text centered,
      // so the label's right edge coincides with the message's colored border and
      // the glyphs end before it. Font is 0.9 × --text-caption-xs (9px): the
      // four-digit labels ("100%"…"150%") measure ~24.6px at 10px — wider than the
      // column — and ~22.1px at 9px, which clears the border by ≥0.9px on each
      // side. The operator put a smaller label on the table for exactly this
      // ("If we need to reduce the font size to make it fit there, that's on the
      // table", 2026-09-06). Token-derived via calc(), not a raw px class.
      <Button
        variant="ghost"
        type="button"
        onClick={handleToggle}
        className="h-auto w-6 cursor-pointer justify-center rounded-md bg-[var(--app-bg)]/60 px-0 py-0.5 font-normal tabular-nums text-[var(--app-hint)] opacity-50 transition-opacity hover:bg-[var(--app-bg)]/60 hover:text-[var(--app-hint)] hover:opacity-80"
        style={{ fontSize: "calc(var(--text-caption-xs) * 0.9)" }}
        title="Adjust text size"
        aria-label={`Text size: ${props.scaleLabel}. Tap to adjust.`}
      >
        {props.scaleLabel}
      </Button>
    );
  }

  // #4004: self-start pins the expanded row's LEFT edge to the gutter column
  // (SessionChat's `flex-col items-center w-6`). Centered there, the ~98px row
  // overflowed ~37px off each side and pushed A- past the viewport's left edge.
  // Anchored, it grows rightward and the toggle above it does not move.
  return (
    <div className="flex self-start items-center gap-0.5 rounded-md bg-[var(--app-bg)]/80 backdrop-blur-sm border border-[var(--app-divider)] px-1 py-0.5">
      <BareButton
        type="button"
        onClick={() => handleAction(props.onDecrement)}
        disabled={!props.canDecrement}
        className={`${btnClass} ${props.canDecrement ? enabledClass : disabledClass}`}
        title="Decrease text size"
        aria-label="Decrease text size"
      >
        A-
      </BareButton>
      <span
        className={
          /* design-tokens-allow: control min-width, no exact spacing token */ "min-w-[36px] text-center text-[length:var(--text-caption-xs)] tabular-nums text-[var(--app-hint)]"
        }
      >
        {props.scaleLabel}
      </span>
      <BareButton
        type="button"
        onClick={() => handleAction(props.onIncrement)}
        disabled={!props.canIncrement}
        className={`${btnClass} ${props.canIncrement ? enabledClass : disabledClass}`}
        title="Increase text size"
        aria-label="Increase text size"
      >
        A+
      </BareButton>
    </div>
  );
}
