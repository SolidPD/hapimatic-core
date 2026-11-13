// SPDX-License-Identifier: AGPL-3.0-only
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/**
 * The one-line rule (#6539, R13): a pin's action row never wraps. When it runs
 * out of room, labels give way to their icons in a fixed order, lowest rank
 * first, and each button keeps its tooltip and its `aria-label`. Mockup v3's
 * `fitRow` (`claudedocs/design-mockups/pins-n/dismiss-mockup-v3.html`).
 *
 * A row is any element whose buttons carry {@link ACTION_RANK_ATTR}; a button's
 * label carries {@link ACTION_LABEL_ATTR}. The row's component provides
 * {@link ActionRowFitContext}, and each button hides its label while its rank is
 * at or below the count collapsed.
 */
export const ACTION_COLLAPSE_RANK = {
  inChat: 1,
  text: 2,
  save: 3,
  dismiss: 4,
  note: 5,
  ask: 6,
  clear: 7,
  undo: 7,
  /** Last, and it keeps its option letter ("✓A"). */
  use: 8,
} as const;

export type ActionCollapseRank =
  (typeof ACTION_COLLAPSE_RANK)[keyof typeof ACTION_COLLAPSE_RANK];

/** The highest rank: collapsing this many leaves every button as its icon. */
export const ACTION_RANK_MAX = 8;

export const ACTION_RANK_ATTR = "data-collapse-rank";
export const ACTION_LABEL_ATTR = "data-collapse-label";
/**
 * An element in the row whose text must stay whole (the Submit bar's count): a
 * label gives way before it is cut.
 */
export const ACTION_WHOLE_ATTR = "data-collapse-whole";

/**
 * What hiding a label frees beyond the label's own width: the 4 px gap beside it
 * and the 2 px a side the icon-only form takes off the padding (8 px to 6 px).
 */
export const ACTION_LABEL_EXTRA_PX = 8;
/** A button's horizontal padding once its label is hidden. */
export const ACTION_ICON_ONLY_PADDING_PX = 6;

/**
 * The fewest ranks to collapse so the labels given up cover the overflow, or
 * every rank when they cannot. `labelWidthsInRankOrder[i]` is what rank `i + 1`
 * frees (0 for a rank the row does not hold).
 */
export function collapseCount(
  overflowPx: number,
  labelWidthsInRankOrder: readonly number[]
): number {
  if (!(overflowPx > 0)) return 0;
  let freed = 0;
  for (let i = 0; i < labelWidthsInRankOrder.length; i++) {
    freed += labelWidthsInRankOrder[i] ?? 0;
    if (freed >= overflowPx) return i + 1;
  }
  return labelWidthsInRankOrder.length;
}

/** How far the row's content runs past it, counting a cut "whole" element. */
export function rowOverflowPx(row: HTMLElement): number {
  let overflow = Math.max(0, row.scrollWidth - row.clientWidth);
  row.querySelectorAll<HTMLElement>(`[${ACTION_WHOLE_ATTR}]`).forEach(whole => {
    overflow += Math.max(0, whole.scrollWidth - whole.clientWidth);
  });
  return overflow;
}

/** What each rank frees, measured while every label is shown. */
export function measureLabelWidths(row: HTMLElement): number[] {
  const widths = new Array<number>(ACTION_RANK_MAX).fill(0);
  row.querySelectorAll<HTMLElement>(`[${ACTION_RANK_ATTR}]`).forEach(button => {
    const rank = Number(button.getAttribute(ACTION_RANK_ATTR));
    if (!Number.isInteger(rank) || rank < 1 || rank > ACTION_RANK_MAX) return;
    const label = button.querySelector<HTMLElement>(`[${ACTION_LABEL_ATTR}]`);
    if (!label) return;
    const width = label.getBoundingClientRect().width;
    if (width > 0) widths[rank - 1] += width + ACTION_LABEL_EXTRA_PX;
  });
  return widths;
}

/** How many ranks the enclosing row has collapsed; 0 outside a row. */
export const ActionRowFitContext = createContext(0);

/** True when a button of this rank shows only its icon. */
export function useActionLabelHidden(rank: number): boolean {
  return rank <= useContext(ActionRowFitContext);
}

/**
 * Fit a row to its width. It measures the row with every label shown,
 * collapses {@link collapseCount} ranks, and then checks the result: a row that
 * still overflows (a rounded width, a font that loaded late) gives up one more
 * rank at a time. A width change or a change to the row's buttons starts again
 * from full labels. Returns the number of ranks collapsed.
 *
 * Labels are hidden with a class, never removed, so the row's own re-render
 * changes only attributes, which the observer below does not watch. The row
 * must be mounted with the component that calls this: a component that may
 * render nothing first puts the row in a child (the Submit bar's `BarRow`).
 */
export function useActionRowFit(rowRef: RefObject<HTMLElement | null>): number {
  const [fit, setFit] = useState({ collapsed: 0, pass: 0 });
  const phase = useRef<"measure" | "verify" | "done">("measure");

  const restart = useCallback(() => {
    phase.current = "measure";
    setFit(current => ({ collapsed: 0, pass: current.pass + 1 }));
  }, []);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || phase.current === "done") return;
    if (phase.current === "measure") {
      // Measure only a render that shows every label; a restart brings one.
      if (fit.collapsed !== 0) return;
      const count = collapseCount(rowOverflowPx(row), measureLabelWidths(row));
      phase.current = count > 0 ? "verify" : "done";
      if (count > 0) setFit(current => ({ ...current, collapsed: count }));
      return;
    }
    if (rowOverflowPx(row) > 0 && fit.collapsed < ACTION_RANK_MAX) {
      setFit(current => ({ ...current, collapsed: current.collapsed + 1 }));
    } else {
      phase.current = "done";
    }
  }, [fit, rowRef]);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    let width = row.clientWidth;
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (row.clientWidth === width) return;
            width = row.clientWidth;
            restart();
          });
    resize?.observe(row);
    const mutation =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(restart);
    mutation?.observe(row, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    // A web font that arrives after the first measure changes every width.
    let live = true;
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    if (fonts && fonts.status !== "loaded") {
      void fonts.ready.then(() => {
        if (live) restart();
      });
    }
    return () => {
      live = false;
      resize?.disconnect();
      mutation?.disconnect();
    };
  }, [rowRef, restart]);

  return fit.collapsed;
}
