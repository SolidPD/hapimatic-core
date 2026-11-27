// SPDX-License-Identifier: AGPL-3.0-only
import {
  useCallback,
  useEffect,
  useId,
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
import { OptionIdText } from "@/components/pins/optionId";
import { TextLimitCounter } from "@/components/pins/TextLimitCounter";
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
import { registerNoteDraft } from "@/lib/pins/noteDrafts";
import { textLimitState, type TextLimitWhat } from "@/lib/pins/textLimit";
import { cn } from "@/lib/utils";
import {
  addQuestion,
  ANSWERABLE_KINDS,
  clearChoice,
  isReservedKey,
  removeQuestion,
  setNote,
  setQuestionDraft,
  setWriteIn,
  stageChoice,
  STAGED_LEGACY_NOTE_MAX_CHARS,
  STAGED_QUESTION_MAX_CHARS,
  STAGED_QUESTIONS_MAX,
  STAGED_WRITE_IN_MAX_CHARS,
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
/** #6969 (R2): a box past its limit takes the warn border. */
const OVER_LIMIT_CLASS = "border-[var(--status-warn)]";
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
  const drafted = Boolean(staged?.questionDraft?.trim());
  const choosable = isChoosablePin(model) && !dismissed;
  return (
    <>
      {choosable &&
      (staged?.choice !== undefined || staged?.writeInChosen === true) ? (
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
          keep={
            <span>
              <OptionIdText id={recommended.id} />
            </span>
          }
        />
      ) : null}
      {dismissed ? null : (
        <PinActionButton
          rank={ACTION_COLLAPSE_RANK.ask}
          content={
            drafted
              ? "Finish your question; it is kept here until you add it"
              : "Ask the agent a question about this pin"
          }
          // #6969 (ruling C1): a question typed but not added is marked like a
          // staged note, so it is never kept out of sight.
          aria-label={drafted ? "Ask •" : "Ask"}
          aria-expanded={panels.asking}
          onClick={panels.toggleAsk}
          icon={<MessageCircleQuestion style={ICON} aria-hidden />}
          label="Ask"
          keep={drafted ? <span aria-hidden>•</span> : null}
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
 * A staged text field: the note (#6450) and the write-in (#6803) share it, so
 * both keep every #6768 rule. Its text lives in local state and is staged about
 * 300 ms after typing stops, on blur, and when an iOS input method finishes
 * composing, so a keystroke never re-renders every copy of the pin. #6768: it
 * also stages what it holds when it closes, when a Submit opens, and when the
 * page is hidden, because words typed inside a composition that has not ended
 * are staged by none of the three, and React runs no blur for a field it
 * removes. #6803 (R4): it commits with the pin that was on screen at the last
 * keystroke, so a flush after a revision with no further typing keeps the
 * revision the words answered. #6969 (R1, R2): it never cuts the text: the
 * box sets no maxlength, so dictation and paste keep every character, and the counter
 * under it says how much room is left; past the limit the box is marked
 * invalid and Submit holds the pin until the text fits.
 */
export function StagedTextField(props: {
  pin: Pin;
  /** The staged text now; it changes when a Submit clears it, or another copy edits it. */
  staged: string;
  /** Stage `text` against `pin`, the pin at the last keystroke. */
  save: (pin: Pin, text: string) => void;
  label: string;
  placeholder: string;
  /** The length Submit takes; past it the counter warns and Submit holds the pin. */
  limit: number;
  what: TextLimitWhat;
  className?: string;
  /** An element that describes the field, such as a hint under it. */
  describedBy?: string;
}) {
  const { staged } = props;
  const [text, setText] = useState(staged);
  const counterId = useId();
  const limit = textLimitState(text.length, props.limit);
  const latest = useRef(text);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composing = useRef(false);
  // #6768: typed here since this field last staged or adopted staging. Only such
  // a field stages on close, so an idle second copy, or a field a Submit just
  // emptied, never stages an old text again.
  const dirty = useRef(false);
  // The latest props, so `commit` stays stable however often the pin renders.
  const target = useRef({ pin: props.pin, save: props.save });
  target.current = { pin: props.pin, save: props.save };
  /** #6803 (R4): the pin on screen at the last keystroke. */
  const typedPin = useRef<Pin | null>(null);

  const commit = useCallback(() => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    dirty.current = false;
    const t = target.current;
    t.save(typedPin.current ?? t.pin, latest.current);
  }, []);

  // Follow staging while the operator is not typing: a Submit that sent the text
  // clears it, and a stale field would stage the old text again on its next blur.
  useEffect(() => {
    if (pending.current || composing.current) return;
    if (latest.current.trim() === staged.trim()) return;
    latest.current = staged;
    dirty.current = false;
    setText(staged);
  }, [staged]);

  // Closing the field, collapsing the pin, opening Submit or hiding the page
  // must not lose the last words, a composition's included (#6768).
  useEffect(() => {
    const flush = () => {
      if (dirty.current) commit();
    };
    const unregister = registerNoteDraft(flush);
    return () => {
      unregister();
      flush();
    };
  }, [commit]);

  const describedBy =
    [props.describedBy, limit.show ? counterId : undefined]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className={props.className}>
      <Textarea
        rows={3}
        value={text}
        aria-label={props.label}
        aria-describedby={describedBy}
        aria-invalid={limit.over > 0 ? true : undefined}
        placeholder={props.placeholder}
        className={limit.over > 0 ? OVER_LIMIT_CLASS : undefined}
        onChange={event => {
          setText(event.target.value);
          latest.current = event.target.value;
          typedPin.current = target.current.pin;
          dirty.current = true;
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
      <TextLimitCounter
        length={text.length}
        limit={props.limit}
        what={props.what}
        id={counterId}
      />
    </div>
  );
}

/** The note field: a {@link StagedTextField} that stages the note. */
function NoteField(props: {
  sessionId: string;
  pin: Pin;
  via: StagedVia;
  /** The staged note now; it changes when a Submit clears it, or another copy edits it. */
  staged: string;
  /** #6969 (D2): the session's note limit, as its node states it. */
  limit: number;
}) {
  const { sessionId, pin, via, staged } = props;
  return (
    <StagedTextField
      pin={pin}
      staged={staged}
      save={(typed, text) => setNote(sessionId, typed, text, via)}
      label="Note with your answer"
      placeholder="Note with your answer (paragraphs and lists are kept as you write them)"
      limit={props.limit}
      what="note"
      className="mt-1.5"
    />
  );
}

/**
 * #6803: the write-in field under a decision's "Something else" row: a
 * {@link StagedTextField} that stages the operator's own answer.
 */
export function WriteInField(props: {
  sessionId: string;
  pin: Pin;
  via: StagedVia;
  /** The staged write-in now. */
  staged: string;
  describedBy?: string;
}) {
  const { sessionId, pin, via, staged } = props;
  return (
    <StagedTextField
      pin={pin}
      staged={staged}
      save={(typed, text) => setWriteIn(sessionId, typed, text, via)}
      label="Your own answer"
      placeholder="Your own answer, sent as your answer to this pin"
      limit={STAGED_WRITE_IN_MAX_CHARS}
      what="answer"
      describedBy={props.describedBy}
    />
  );
}

/**
 * The question field. #6969 (D7): its draft is staged as the pin's
 * `questionDraft`, about 300 ms after typing stops, on blur, when a
 * composition ends, and through the same draft flush as the note (a closed
 * panel, a collapsed pin, an opening Submit, a hidden page), so a typed
 * question is never lost and never sent until Add. It never cuts the text: a
 * question over its limit keeps every word, the counter says so, and Add stays
 * off until it fits. The counter counts what Add takes, the trimmed question.
 */
function QuestionField(props: {
  sessionId: string;
  pin: Pin;
  via: StagedVia;
  count: number;
  /** The staged question draft now. */
  staged: string;
}) {
  const { sessionId, pin, via, count, staged } = props;
  const [draft, setDraft] = useState(staged);
  const latest = useRef(draft);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composing = useRef(false);
  // Typed here since the field last staged or adopted staging (#6768's rule).
  const dirty = useRef(false);
  const target = useRef({ sessionId, pin, via });
  target.current = { sessionId, pin, via };
  const counterId = useId();

  const commit = useCallback(() => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    dirty.current = false;
    const t = target.current;
    setQuestionDraft(t.sessionId, t.pin, latest.current, t.via);
  }, []);

  // Follow staging while the operator is not typing: another copy of the pin
  // edited the draft, or added it.
  useEffect(() => {
    if (pending.current || composing.current) return;
    if (latest.current.trim() === staged.trim()) return;
    latest.current = staged;
    dirty.current = false;
    setDraft(staged);
  }, [staged]);

  useEffect(() => {
    const flush = () => {
      if (dirty.current) commit();
    };
    const unregister = registerNoteDraft(flush);
    return () => {
      unregister();
      flush();
    };
  }, [commit]);

  const full = count >= STAGED_QUESTIONS_MAX;
  const length = draft.trim().length;
  const limit = textLimitState(length, STAGED_QUESTION_MAX_CHARS);
  const over = limit.over > 0;
  const add = () => {
    if (over) return;
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    if (addQuestion(sessionId, pin, latest.current, via)) {
      latest.current = "";
      dirty.current = false;
      setDraft("");
    } else {
      // Refused (five already, or a dismissal): the words stay, staged.
      commit();
    }
  };
  return (
    <div className="mt-1.5">
      <Textarea
        rows={2}
        value={draft}
        disabled={full}
        aria-label="Your question about this pin"
        aria-describedby={limit.show ? counterId : undefined}
        aria-invalid={over ? true : undefined}
        className={over ? OVER_LIMIT_CLASS : undefined}
        placeholder={
          full
            ? `${STAGED_QUESTIONS_MAX} questions at most per Submit`
            : "Your question about this pin"
        }
        onChange={event => {
          setDraft(event.target.value);
          latest.current = event.target.value;
          dirty.current = true;
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
        onBlur={() => {
          if (dirty.current) commit();
        }}
        onKeyDown={event => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            add();
          }
        }}
      />
      <TextLimitCounter
        length={length}
        limit={STAGED_QUESTION_MAX_CHARS}
        what="question"
        id={counterId}
      />
      <div className="mt-1 flex">
        <HoverTooltipButton
          type="button"
          content={
            over
              ? "Shorten the question to add it"
              : "Stage this question; it goes with your next Submit"
          }
          disabled={full || !draft.trim() || over}
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
  const { sessionId, via, noteMaxChars } = usePinsContext();
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
          limit={noteMaxChars ?? STAGED_LEGACY_NOTE_MAX_CHARS}
        />
      ) : null}
      {asking ? (
        <QuestionField
          sessionId={sessionId}
          pin={pin}
          via={via}
          count={questions.length}
          staged={staged?.questionDraft ?? ""}
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
