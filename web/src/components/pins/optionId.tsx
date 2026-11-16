// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #6458 (tester fix round, the Pins PM's ruling): an option id never draws over
 * its label or breaks its row. An agent picks its options' ids (up to 64
 * characters, `PinOptionSchema`), while the rows were drawn for "A" and "B".
 *
 * - Ids of one or two characters keep the 16 px column they always had.
 * - A pin with a longer id gives every option the same id column, as wide as its
 *   longest id up to `OPTION_ID_CAP` characters, so every label starts at the
 *   same x. An id wider than the column ends in an ellipsis; every id in that
 *   layout carries the full id in its title.
 * - In a pill or a button an id past the cap ends in an ellipsis, with the full
 *   id in its title; a shorter id draws exactly as before.
 *
 * Only the drawing changes: the radio value, the staged answer, the answers
 * message and the marks keep the full id.
 *
 * Fix round 5: a `ch` is the width of a "0", and a short id of wide letters
 * ("warm") draws wider than its count of `ch`, so the column cut it. Below the
 * cap, the column is the larger of its `ch` width and the widest drawn id, still
 * never past the cap (`OptionIdCell`).
 */
import type { CSSProperties } from "react";

const SHORT_ID_MAX = 2;

/** The widest an option id is drawn, in characters (8 reads well at 320 px). */
export const OPTION_ID_CAP = 8;

/** An id's length in characters (code points, so an emoji counts once). */
function idLength(id: string): number {
  return [...id].length;
}

/**
 * The id column's width in `ch` for a pin's options, or null when every id has
 * one or two characters and the column stays 16 px.
 */
export function optionIdColumnCh(ids: readonly string[]): number | null {
  const longest = ids.reduce((max, id) => Math.max(max, idLength(id)), 0);
  return longest <= SHORT_ID_MAX ? null : Math.min(longest, OPTION_ID_CAP);
}

/** The cap as a width, inside the id's own font so the `ch` matches. */
const CAP_WIDTH: CSSProperties = { maxWidth: `${OPTION_ID_CAP}ch` };

/**
 * An id cell's style in a widened column (`idCh` from `optionIdColumnCh`): its
 * `ch` width and, below the cap, at least the width of what `OptionIdCell`
 * holds, which is the pin's widest drawn id up to the cap.
 */
export function optionIdCellStyle(idCh: number): CSSProperties {
  const width = `${idCh}ch`;
  return idCh < OPTION_ID_CAP ? { width, minWidth: "max-content" } : { width };
}

/**
 * What an id cell in a widened column holds. Each option row is its own grid,
 * so below the cap every cell also holds an invisible copy of all the pin's
 * ids, one a line: each cell is then as wide as the widest of them, and every
 * label still starts at the same x. Both parts stop at the cap, where the id
 * ends in an ellipsis. At the cap the `ch` width is already the widest the
 * column can be, so the cell holds the id alone, as before.
 */
export function OptionIdCell(props: {
  id: string;
  ids: readonly string[];
  idCh: number;
}) {
  const { id, ids, idCh } = props;
  if (idCh >= OPTION_ID_CAP) return <>{id}</>;
  return (
    <>
      <span className="block truncate" style={CAP_WIDTH}>
        {id}
      </span>
      <span
        aria-hidden
        data-option-id-sizer=""
        className="invisible block h-0 overflow-hidden whitespace-pre"
        style={CAP_WIDTH}
      >
        {ids.join("\n")}
      </span>
    </>
  );
}

/** An option id inside a pill or a button, cut to the cap past it. */
export function OptionIdText(props: { id: string }) {
  const { id } = props;
  if (idLength(id) <= OPTION_ID_CAP) return <>{id}</>;
  return (
    <span
      className="inline-block truncate align-bottom"
      style={{ maxWidth: `${OPTION_ID_CAP}ch` }}
      title={id}
    >
      {id}
    </span>
  );
}
