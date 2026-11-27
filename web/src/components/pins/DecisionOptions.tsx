// SPDX-License-Identifier: AGPL-3.0-only
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { PenLine, Star } from "lucide-react";
import type { PinOption } from "@hapi/protocol";
import { HoverTooltip } from "@/components/ui/tooltip";
import { collapseCount } from "@/lib/pins/actionRowFit";
import { OptionIdCell, optionIdCellStyle, optionIdColumnCh } from "./optionId";

/**
 * #6803: the decision's "Something else" row, the operator's own answer. Only
 * beside `onSelect`, in the same radio group.
 */
export type WriteInRow = {
  selected: boolean;
  onSelect: () => void;
  /** The write-in field, shown under the row while it is selected. */
  field: ReactNode;
  /** No words yet: the row says what sending needs. */
  empty: boolean;
  /** The hint's id, which the field names in `aria-describedby`. */
  hintId?: string;
};

/**
 * The write-in radio's value: longer than any option id can be (64 characters,
 * `PinOptionSchema`), so it can never equal one.
 */
export const WRITE_IN_RADIO_VALUE =
  "hapimatic-write-in:the-operators-own-answer-instead-of-any-of-the-options";

export const WRITE_IN_LABEL = "Something else";
export const WRITE_IN_TOOLTIP = "Answer in your own words instead of an option";
export const WRITE_IN_EMPTY_HINT = "Write your answer to send it";

/**
 * The id cell's font. The id column's width is in `ch` and its sizer holds the
 * pin's ids as text (`./optionId`), both measured in this font, so the write-in
 * row's id cell carries it too: in the label's larger font a word id's column
 * drew wider there and "Something else" started right of the option labels.
 */
const ID_CELL_FONT = "text-[length:var(--text-body-dense)] font-bold";

type DecisionOptionsProps = {
  options: readonly PinOption[];
  recommendedId?: string;
  selectedId?: string;
  disabled?: boolean;
} & (
  | { onSelect?: undefined; name?: undefined; writeIn?: undefined }
  | {
      onSelect: (optionId: string) => void;
      /** #6803: the last row, "Something else", when the pin takes one. */
      writeIn?: WriteInRow;
      /**
       * The radio group's name, unique per rendered copy (`useId`): the same pin
       * can render twice in one document (two chat cards, or a card beside the
       * Pins tab in split view), and radios sharing a name share one group.
       */
      name: string;
    }
);

const RECOMMENDED = "Recommended";
const CHIP_CLASS =
  "shrink-0 rounded-sm border px-1 font-bold uppercase tracking-wide text-[var(--app-accent)]";
const CHIP_STYLE: CSSProperties = {
  fontSize: "9px",
  borderColor: "color-mix(in srgb, var(--app-accent) 50%, transparent)",
};
const MARK_ICON: CSSProperties = { width: "11px", height: "11px" };
const WRITE_IN_ICON: CSSProperties = { width: "13px", height: "13px" };

/** The line's `gap-1.5`, between the label and the chip. */
const LINE_GAP_PX = 6;

/**
 * #6539 (R14): the recommended option's label with its Recommended chip. The
 * chip stays beside the label at every width: when the label on one line, the
 * gap and the chip do not fit, the chip shrinks to a mint star with the same
 * name, on the label's first line, and the label wraps as text. It never drops
 * under the label. Measured with the action row's helper, as one rank.
 */
function RecommendedLabel(props: { label: string }) {
  const line = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const chip = useRef<HTMLSpanElement>(null);
  /** The full chip's width, kept from when it was last drawn. */
  const chipWidth = useRef(0);
  const [mark, setMark] = useState(false);
  const [pass, setPass] = useState(0);

  useLayoutEffect(() => {
    const row = line.current;
    const label = text.current;
    if (!row || !label) return;
    // Not laid out yet (a hidden container): nothing to measure, so the chip
    // stays; the observer below measures once the line has a width.
    if (row.clientWidth <= 0) {
      setMark(false);
      return;
    }
    if (chip.current) {
      chipWidth.current = chip.current.getBoundingClientRect().width;
    }
    // The label's width on one line, read without drawing it that way.
    const wrap = label.style.whiteSpace;
    label.style.whiteSpace = "nowrap";
    const oneLine = label.scrollWidth;
    label.style.whiteSpace = wrap;
    const overflow =
      oneLine + LINE_GAP_PX + chipWidth.current - row.clientWidth;
    setMark(collapseCount(overflow, [Number.POSITIVE_INFINITY]) > 0);
  }, [props.label, pass]);

  useEffect(() => {
    const row = line.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    let width = row.clientWidth;
    const resize = new ResizeObserver(() => {
      if (row.clientWidth === width) return;
      width = row.clientWidth;
      setPass(n => n + 1);
    });
    resize.observe(row);
    return () => resize.disconnect();
  }, []);

  return (
    <span
      ref={line}
      data-recommended-line=""
      className="flex flex-nowrap items-start gap-1.5 text-[length:var(--text-body)] font-semibold text-[var(--app-fg)]"
    >
      <span ref={text} data-recommended-label="" className="min-w-0">
        {props.label}
      </span>
      {mark ? (
        // Inside a choosable option this sits in a <label>: without the
        // preventDefault a tap to read the tooltip would also pick the option.
        <span
          className="mt-1 inline-flex shrink-0"
          onClick={event => event.preventDefault()}
        >
          <HoverTooltip content={RECOMMENDED}>
            <span
              role="img"
              aria-label={RECOMMENDED}
              className="inline-flex text-[var(--app-accent)]"
            >
              <Star style={MARK_ICON} fill="currentColor" aria-hidden />
            </span>
          </HoverTooltip>
        </span>
      ) : (
        <span ref={chip} className={`${CHIP_CLASS} mt-0.5`} style={CHIP_STYLE}>
          {RECOMMENDED}
        </span>
      )}
    </span>
  );
}

/**
 * #6449: a decision pin's options with their consequences (mockup v6
 * :293-302). Read-only — no radio — unless `onSelect` is passed, which
 * requires a `name` (#6450). The caller orders the options (the recommended
 * one first, `orderedOptions`). An id longer than two characters widens the
 * pin's id column, never past the cap, so it never draws over its label (#6458,
 * `./optionId`).
 */
export function DecisionOptions(props: DecisionOptionsProps) {
  const { options, recommendedId, selectedId, onSelect, disabled, writeIn } =
    props;
  const choosing = onSelect !== undefined;
  const ids = options.map(option => option.id);
  const idCh = optionIdColumnCh(ids);
  const idColumn = idCh === null ? "16px" : "max-content";
  return (
    <div
      className="mt-1.5 border-t border-[var(--app-divider)]"
      role={choosing ? "radiogroup" : "list"}
    >
      {options.map(option => {
        const selected = selectedId === option.id;
        const content = (
          <>
            {choosing ? (
              <input
                type="radio"
                name={props.name}
                value={option.id}
                checked={selected}
                disabled={disabled}
                onChange={() => onSelect?.(option.id)}
                className="mt-0.5 h-4 w-4 accent-[var(--app-accent)]"
              />
            ) : null}
            <span
              className={`pt-px ${ID_CELL_FONT} ${
                selected ? "text-[var(--app-accent)]" : "text-[var(--app-hint)]"
              }${idCh === null ? "" : " truncate"}`}
              style={idCh === null ? undefined : optionIdCellStyle(idCh)}
              title={idCh === null ? undefined : option.id}
            >
              {idCh === null ? (
                option.id
              ) : (
                <OptionIdCell id={option.id} ids={ids} idCh={idCh} />
              )}
            </span>
            <span className="min-w-0">
              {option.id === recommendedId ? (
                <RecommendedLabel label={option.label} />
              ) : (
                <span className="flex flex-wrap items-center gap-1.5 text-[length:var(--text-body)] font-semibold text-[var(--app-fg)]">
                  {option.label}
                </span>
              )}
              {option.consequence ? (
                <span className="mt-px block text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                  {option.consequence}
                </span>
              ) : null}
            </span>
          </>
        );
        const className =
          "grid items-start gap-x-1.5 border-b border-[var(--app-divider)] py-1.5";
        const style = {
          gridTemplateColumns: choosing
            ? `18px ${idColumn} minmax(0, 1fr)`
            : `${idColumn} minmax(0, 1fr)`,
        };
        return choosing ? (
          <label key={option.id} className={className} style={style}>
            {content}
          </label>
        ) : (
          <div
            key={option.id}
            role="listitem"
            className={className}
            style={style}
          >
            {content}
          </div>
        );
      })}
      {choosing && writeIn ? (
        <WriteInOption
          row={writeIn}
          name={props.name}
          disabled={disabled}
          ids={ids}
          idCh={idCh}
          idColumn={idColumn}
        />
      ) : null}
    </div>
  );
}

/**
 * #6803: "Something else", the last row of a choosable decision's radio group.
 * Its icon sits in the id column, sized like the option ids, so the labels
 * line up. The field and its hint follow the row's label, inside the group.
 * The tooltip is on the icon, as the Recommended star's is, so a tap on the
 * words chooses the row instead of opening a tooltip on a phone.
 */
function WriteInOption(props: {
  row: WriteInRow;
  name: string | undefined;
  disabled?: boolean;
  ids: readonly string[];
  idCh: number | null;
  idColumn: string;
}) {
  const { row, idCh } = props;
  return (
    <div className="border-b border-[var(--app-divider)]">
      <label
        className="grid items-start gap-x-1.5 py-1.5"
        style={{ gridTemplateColumns: `18px ${props.idColumn} minmax(0, 1fr)` }}
      >
        <input
          type="radio"
          name={props.name}
          value={WRITE_IN_RADIO_VALUE}
          checked={row.selected}
          disabled={props.disabled}
          onChange={() => row.onSelect()}
          className="mt-0.5 h-4 w-4 accent-[var(--app-accent)]"
        />
        <span
          data-write-in-id-cell=""
          className={`pt-px ${ID_CELL_FONT} ${
            row.selected ? "text-[var(--app-accent)]" : "text-[var(--app-hint)]"
          }`}
          style={idCh === null ? undefined : optionIdCellStyle(idCh)}
          onClick={event => event.preventDefault()}
        >
          <HoverTooltip content={WRITE_IN_TOOLTIP}>
            <span className="inline-flex" aria-hidden>
              <PenLine style={WRITE_IN_ICON} />
            </span>
          </HoverTooltip>
          {/* The option rows' own sizer, so the icon's column is as wide as theirs. */}
          {idCh === null ? null : (
            <OptionIdCell id="" ids={props.ids} idCh={idCh} />
          )}
        </span>
        <span className="min-w-0 text-[length:var(--text-body)] font-semibold text-[var(--app-fg)]">
          {WRITE_IN_LABEL}
        </span>
      </label>
      {row.selected ? (
        <div className="pb-1.5">
          {row.field}
          {row.empty ? (
            <span
              id={row.hintId}
              className="mt-1 block text-[length:var(--text-caption)] text-[var(--app-hint)]"
            >
              {WRITE_IN_EMPTY_HINT}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
