// SPDX-License-Identifier: AGPL-3.0-only
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Check, MessageCircleQuestion, StickyNote, X } from "lucide-react";
import type { Pin } from "@hapi/protocol";
import { Textarea } from "@/components/ui/Textarea";
import {
  HoverTooltipButton,
  type HoverTooltipButtonProps,
} from "@/components/ui/tooltip";
import { usePinsContext } from "@/components/pins/pinsShared";
import {
  ACTION_COLLAPSE_RANK,
  ACTION_ICON_ONLY_PADDING_PX,
  ACTION_LABEL_ATTR,
  ACTION_RANK_ATTR,
  ActionRowFitContext,
  useActionLabelHidden,
  useActionRowFit,
  type ActionCollapseRank,
} from "@/lib/pins/actionRowFit";
import { recommendedOption, type PinViewModel } from "@/lib/pins/ledger";
import { cn } from "@/lib/utils";
import {
  addQuestion,
  ANSWERABLE_KINDS,
  clearChoice,
  isReservedKey,
  removeQuestion,
  setNote,
  stageChoice,
  STAGED_NOTE_MAX_CHARS,
  STAGED_QUESTION_MAX_CHARS,
  STAGED_QUESTIONS_MAX,
  useStagedPin,
  type StagedVia,
} from "@/lib/pins/staging";

const ICON: CSSProperties = { width: "12px", height: "12px" };
export const PIN_ACTION_CLASS =
  "inline-flex items-center gap-1 rounded-md border border-[var(--app-border)] px-2 font-semibold text-[var(--app-fg)] hover:bg-[var(--app-hover)]";
/**
 * The one size every pins action button shares (#6539, ruling D4): the answer
 * buttons here, Save and In chat, Text, the Detected pin's buttons, and Dismiss.
 */
export const PIN_ACTION_STYLE: CSSProperties = {
  height: "26px",
  fontSize: "11.5px",
};
const GO_CLASS =
  "inline-flex items-center gap-1 rounded-md border border-transparent bg-[var(--app-accent)] px-2 font-semibold text-[var(--palette-accent-fg)] hover:opacity-90";
const NOTE_COMMIT_MS = 300;
const ICON_ONLY_STYLE: CSSProperties = {
  ...PIN_ACTION_STYLE,
  paddingLeft: `${ACTION_ICON_ONLY_PADDING_PX}px`,
  paddingRight: `${ACTION_ICON_ONLY_PADDING_PX}px`,
};

/**
 * #6539 (R13, the one-line rule): a row of action buttons that never wraps.
 * When it runs out of room its buttons' labels give way to their icons, lowest
 * rank first (`ACTION_COLLAPSE_RANK`). It measures the row it is given, so the
 * Pins tab, a chat card and a Project Manager's lane box need no code of their
 * own.
 */
export function PinActionRow(props: {
  className?: string;
  children: ReactNode;
}) {
  const row = useRef<HTMLDivElement>(null);
  const collapsed = useActionRowFit(row);
  return (
    <ActionRowFitContext.Provider value={collapsed}>
      <div
        ref={row}
        data-collapsed={collapsed}
        className={cn(
          "flex min-w-0 flex-nowrap items-center gap-1",
          props.className
        )}
      >
        {props.children}
      </div>
    </ActionRowFitContext.Provider>
  );
}

/**
 * One action button of a {@link PinActionRow}. Its label gives way to its icon
 * once the row has collapsed its rank; `keep` (Use's option letter, Note's
 * staged dot) stays. The tooltip and the `aria-label` always carry the full
 * name. Outside a row it always shows its label.
 */
export function PinActionButton({
  rank,
  icon,
  label,
  keep,
  iconAfter = false,
  className = PIN_ACTION_CLASS,
  ...button
}: Omit<HoverTooltipButtonProps, "children" | "style"> & {
  rank: ActionCollapseRank;
  icon: ReactNode;
  label: string;
  keep?: ReactNode;
  /** The icon follows the label ("Go to chat →"). */
  iconAfter?: boolean;
}) {
  const iconOnly = useActionLabelHidden(rank);
  return (
    <HoverTooltipButton
      type="button"
      aria-label={label}
      {...button}
      {...{ [ACTION_RANK_ATTR]: rank }}
      className={cn("shrink-0 whitespace-nowrap", className)}
      style={iconOnly ? ICON_ONLY_STYLE : PIN_ACTION_STYLE}
    >
      {iconAfter ? null : icon}
      <span
        {...{ [ACTION_LABEL_ATTR]: "" }}
        className={iconOnly ? "hidden" : undefined}
      >
        {label}
      </span>
      {keep}
      {iconAfter ? icon : null}
    </HoverTooltipButton>
  );
}

/** An open pin the operator can answer here: not a dashboard, not server-owned. */
export function isAnswerablePin(pin: Pin): boolean {
  return (
    pin.status === "open" && pin.kind !== "dashboard" && !isReservedKey(pin.key)
  );
}

/** An answerable pin answered by choosing one of its options (KD12). */
export function isChoosablePin(model: PinViewModel): boolean {
  return (
    isAnswerablePin(model.pin) &&
    ANSWERABLE_KINDS.has(model.pin.kind) &&
    model.options.length > 0
  );
}

export type AnswerPanels = {
  asking: boolean;
  noting: boolean;
  toggleAsk: () => void;
  toggleNote: () => void;
};

/** Which answer fields are open under a pin's action row. */
export function useAnswerPanels(): AnswerPanels {
  const [asking, setAsking] = useState(false);
  const [noting, setNoting] = useState(false);
  return {
    asking,
    noting,
    toggleAsk: useCallback(() => setAsking(on => !on), []),
    toggleNote: useCallback(() => setNoting(on => !on), []),
  };
}

/**
 * #6450: the answer actions in an open pin's action row (mockup v6 `detail()`
 * :720-728): **Use {rec}** or **Clear**, **Ask**, and **Note** (" •" once a note
 * is staged). #6539: while a dismissal is staged, Use, Clear and Ask are hidden
 * (an answer or a question would contradict it) and Note stays, because a note
 * goes to the agent with the dismissal.
 */
export function PinAnswerButtons(props: {
  model: PinViewModel;
  panels: AnswerPanels;
}) {
  const { model, panels } = props;
  const { pin } = model;
  const { sessionId, via } = usePinsContext();
  const staged = useStagedPin(sessionId, pin.key);
  const recommended = recommendedOption(model);
  const dismissed = staged?.dismiss === true;
  const choosable = isChoosablePin(model) && !dismissed;
  return (
    <>
      {choosable && staged?.choice !== undefined ? (
        <PinActionButton
          rank={ACTION_COLLAPSE_RANK.clear}
          content="Clear your answer"
          onClick={() => clearChoice(sessionId, pin.key)}
          icon={<X style={ICON} aria-hidden />}
          label="Clear"
        />
      ) : choosable && recommended ? (
        <PinActionButton
          rank={ACTION_COLLAPSE_RANK.use}
          content={`Choose the recommendation: ${recommended.id}. ${recommended.label}`}
          aria-label={`Use ${recommended.id}`}
          onClick={() => stageChoice(sessionId, pin, recommended, via)}
          className={GO_CLASS}
          icon={<Check style={ICON} aria-hidden />}
          label="Use"
          keep={<span>{recommended.id}</span>}
        />
      ) : null}
      {dismissed ? null : (
        <PinActionButton
          rank={ACTION_COLLAPSE_RANK.ask}
          content="Ask the agent a question about this pin"
          aria-expanded={panels.asking}
          onClick={panels.toggleAsk}
          icon={<MessageCircleQuestion style={ICON} aria-hidden />}
          label="Ask"
        />
      )}
      <PinActionButton
        rank={ACTION_COLLAPSE_RANK.note}
        content={
          dismissed
            ? "Attach a note: it goes to the agent with the dismissal"
            : staged?.note
              ? "Edit the note on your answer"
              : "Attach a note to your answer"
        }
        // The staged-note dot is part of the name, as it was before #6539.
        aria-label={staged?.note ? "Note •" : "Note"}
        aria-expanded={panels.noting}
        onClick={panels.toggleNote}
        icon={<StickyNote style={ICON} aria-hidden />}
        label="Note"
        keep={staged?.note ? <span aria-hidden>•</span> : null}
      />
    </>
  );
}

/**
 * The note field. Its text lives in local state and is staged about 300 ms
 * after typing stops, on blur, and when an iOS input method finishes composing,
 * so a keystroke never re-renders every copy of the pin.
 */
function NoteField(props: {
  sessionId: string;
  pin: Pin;
  via: StagedVia;
  /** The staged note now; it changes when a Submit clears it, or another copy edits it. */
  staged: string;
}) {
  const { sessionId, pin, via, staged } = props;
  const [text, setText] = useState(staged);
  const latest = useRef(text);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composing = useRef(false);
  const target = useRef({ sessionId, pin, via });
  target.current = { sessionId, pin, via };

  const commit = useCallback(() => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    const t = target.current;
    setNote(t.sessionId, t.pin, latest.current, t.via);
  }, []);

  // Follow staging while the operator is not typing: a Submit that sent the note
  // clears it, and a stale field would stage the old note again on its next blur.
  useEffect(() => {
    if (pending.current || composing.current) return;
    if (latest.current.trim() === staged.trim()) return;
    latest.current = staged;
    setText(staged);
  }, [staged]);

  // Closing the field, or collapsing the pin, must not lose the last words.
  useEffect(
    () => () => {
      if (pending.current) commit();
    },
    [commit]
  );

  return (
    <Textarea
      rows={3}
      value={text}
      maxLength={STAGED_NOTE_MAX_CHARS}
      aria-label="Note with your answer"
      placeholder="Note with your answer (paragraphs and lists are kept as you write them)"
      className="mt-1.5"
      onChange={event => {
        setText(event.target.value);
        latest.current = event.target.value;
        if (composing.current) return;
        if (pending.current) clearTimeout(pending.current);
        pending.current = setTimeout(commit, NOTE_COMMIT_MS);
      }}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={event => {
        composing.current = false;
        latest.current = event.currentTarget.value;
        commit();
      }}
      onBlur={commit}
    />
  );
}

function QuestionField(props: {
  sessionId: string;
  pin: Pin;
  via: StagedVia;
  count: number;
}) {
  const { sessionId, pin, via, count } = props;
  const [draft, setDraft] = useState("");
  const full = count >= STAGED_QUESTIONS_MAX;
  const add = () => {
    if (addQuestion(sessionId, pin, draft, via)) setDraft("");
  };
  return (
    <div className="mt-1.5">
      <Textarea
        rows={2}
        value={draft}
        maxLength={STAGED_QUESTION_MAX_CHARS}
        disabled={full}
        aria-label="Your question about this pin"
        placeholder={
          full
            ? `${STAGED_QUESTIONS_MAX} questions at most per Submit`
            : "Your question about this pin"
        }
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            add();
          }
        }}
      />
      <div className="mt-1 flex">
        <HoverTooltipButton
          type="button"
          content="Stage this question; it goes with your next Submit"
          disabled={full || !draft.trim()}
          onClick={add}
          className={`${GO_CLASS} disabled:opacity-50`}
          style={PIN_ACTION_STYLE}
        >
          Add question
        </HoverTooltipButton>
      </div>
    </div>
  );
}

/** The open fields and the staged questions, below the action row. */
export function PinAnswerFields(props: {
  model: PinViewModel;
  panels: AnswerPanels;
}) {
  const { model, panels } = props;
  const { pin } = model;
  const { sessionId, via } = usePinsContext();
  const staged = useStagedPin(sessionId, pin.key);
  const questions = staged?.questions ?? [];
  // #6539: no question beside a dismissal, so its field is closed while one is
  // staged (`PinDetail` also closes the panel, so Undo does not re-open it).
  const asking = panels.asking && staged?.dismiss !== true;
  return (
    <>
      {panels.noting ? (
        <NoteField
          sessionId={sessionId}
          pin={pin}
          via={via}
          staged={staged?.note ?? ""}
        />
      ) : null}
      {asking ? (
        <QuestionField
          sessionId={sessionId}
          pin={pin}
          via={via}
          count={questions.length}
        />
      ) : null}
      {questions.length > 0 ? (
        <ul className="mt-1.5 grid gap-1">
          {questions.map((question, index) => (
            <li
              key={`${index}:${question}`}
              className="grid items-start gap-x-1.5 rounded-md border border-[var(--app-divider)] px-2 py-1"
              style={{ gridTemplateColumns: "minmax(0, 1fr) 24px" }}
            >
              <span className="min-w-0">
                <span className="block whitespace-pre-wrap text-[length:var(--text-body)] text-[var(--app-fg)]">
                  {question}
                </span>
                <span className="block text-[length:var(--text-caption)] text-[var(--app-hint)]">
                  Goes with your next Submit
                </span>
              </span>
              <HoverTooltipButton
                type="button"
                content="Remove this question"
                aria-label="Remove this question"
                onClick={() => removeQuestion(sessionId, pin.key, index)}
                className="grid size-6 place-items-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)]"
              >
                <X style={ICON} aria-hidden />
              </HoverTooltipButton>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
