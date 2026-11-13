// SPDX-License-Identifier: AGPL-3.0-only
import {
  memo,
  useEffect,
  useId,
  useState,
  type CSSProperties,
  type FC,
  type ReactNode,
} from "react";
import { Star, TextAlignStart } from "lucide-react";
import { SimpleMarkdown } from "@/components/SimpleMarkdown";
import { DecisionOptions } from "@/components/pins/DecisionOptions";
import { PinEvidenceList } from "@/components/pins/PinEvidence";
import {
  PinChatButton,
  PinFilesLine,
  PinIssuesLine,
  PinSaveButton,
  usePinMarkdownProps,
} from "@/components/pins/PinLinks";
import { PinTextView } from "@/components/pins/PinTextView";
import { StepsList } from "@/components/pins/StepsList";
import {
  isAnswerablePin,
  isChoosablePin,
  PinActionButton,
  PinActionRow,
  PinAnswerButtons,
  PinAnswerFields,
  useAnswerPanels,
} from "@/components/pins/PinAnswerControls";
import { PinDeadlineLine } from "@/components/pins/PinDeadlineLine";
import { PinIdControl } from "@/components/pins/PinIdControl";
import {
  isDismissablePin,
  PinDismissAction,
  useDismissStaging,
  WillDismissLine,
} from "@/components/pins/PinDismissAction";
import { usePinsContext } from "@/components/pins/pinsShared";
import { HoverTooltip } from "@/components/ui/tooltip";
import {
  DetectedPinBody,
  isDetectedPinKey,
  isPromptPinKey,
  PromptPinBody,
} from "@/components/pins/ReservedPinParts";
import {
  isPinNew,
  mootNotice,
  mootSentence,
  orderedOptions,
  type PinViewModel,
} from "@/lib/pins/ledger";
import { ACTION_COLLAPSE_RANK } from "@/lib/pins/actionRowFit";
import { stageChoice, useStagedPin, useStepTicks } from "@/lib/pins/staging";

/** SimpleMarkdown that skips re-parsing while its text is unchanged (#4110). */
const PinMarkdown = memo(SimpleMarkdown);

const ACTION_ICON: CSSProperties = { width: "12px", height: "12px" };

export type PinBodyProps = {
  model: PinViewModel;
  sessionId: string;
  /** Where the body renders: the Pins tab, or D's inline chat card. */
  mode: "tab" | "chat";
};

/**
 * Read-only options when present (`PinDetail` renders the context above every
 * body). Text is the full fallback.
 */
export function GenericPinBody(props: PinBodyProps) {
  const { model } = props;
  return model.options.length > 0 ? (
    <DecisionOptions
      options={orderedOptions(model)}
      recommendedId={model.pin.recommended}
    />
  ) : null;
}

/**
 * Decision and variants pins (#6450 answers both by choice, KD12): an open pin
 * stages the chosen option; a closed or server-owned one is read-only, and so
 * is one with a dismissal staged (#6539).
 */
function DecisionBody(props: PinBodyProps) {
  const { model } = props;
  const { pin } = model;
  const { sessionId, via } = usePinsContext();
  const staged = useStagedPin(sessionId, pin.key);
  const name = useId();
  const options = orderedOptions(model);
  return (
    <>
      {isChoosablePin(model) && staged?.dismiss !== true ? (
        <DecisionOptions
          options={options}
          recommendedId={pin.recommended}
          selectedId={staged?.choice}
          name={name}
          onSelect={id => {
            const option = options.find(o => o.id === id);
            if (option) stageChoice(sessionId, pin, option, via);
          }}
        />
      ) : (
        <DecisionOptions options={options} recommendedId={pin.recommended} />
      )}
      {pin.rationale ? (
        <div
          className="mt-2 grid gap-x-1.5 text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
          style={{ gridTemplateColumns: "16px minmax(0, 1fr)" }}
        >
          <Star
            style={{ width: "13px", height: "13px", marginTop: "1px" }}
            className="text-[var(--app-accent)]"
            aria-hidden
          />
          <span>
            <b>{pin.recommended ? `Why ${pin.recommended}:` : "Why:"}</b>{" "}
            {pin.rationale}
          </span>
        </div>
      ) : null}
      {/* #6452: when the pin decides itself if left unanswered. */}
      <PinDeadlineLine model={model} />
    </>
  );
}

function StepsBody(props: PinBodyProps) {
  const { model, sessionId } = props;
  const { via } = usePinsContext();
  const { checked, toggle } = useStepTicks(
    sessionId,
    model.pin,
    model.steps.map(step => step.id),
    via
  );
  // #6539: a pin the operator chose to dismiss takes no ticks.
  const dismissed = useStagedPin(sessionId, model.pin.key)?.dismiss === true;
  return (
    <StepsList
      steps={model.steps}
      checked={checked}
      onToggle={isAnswerablePin(model.pin) && !dismissed ? toggle : undefined}
    />
  );
}

/**
 * #6449: body renderers by kind. Bodies take no route params, so D's inline
 * chat card can mount them. Variants, review, detected, and unknown kinds use
 * `GenericPinBody` until their sub-issues add renderers.
 */
export const pinBodyRenderers: Partial<Record<string, FC<PinBodyProps>>> = {
  decision: DecisionBody,
  // Answered by choice (#6450); K (#6457) replaces it with the sandboxed body.
  variants: DecisionBody,
  steps: StepsBody,
};

/**
 * #6455: a server-owned pin's body is chosen by its key before its kind: a
 * mirrored prompt is answered where it was asked, and a Detected pin can only
 * be dismissed.
 */
function pinBodyFor(pin: { key: string; kind: string }): FC<PinBodyProps> {
  if (isPromptPinKey(pin.key)) return PromptPinBody;
  if (isDetectedPinKey(pin.key)) return DetectedPinBody;
  return pinBodyRenderers[pin.kind] ?? GenericPinBody;
}

/**
 * #6449: an expanded pin (mockup v6 :288-318, :704-728): its context as
 * markdown, its body, its evidence, the "cannot be shown" line when parts were
 * dropped, and the actions row. Opening a new pin marks its revision seen once.
 * #6453: issue references in the context open the issue viewer; the Files and
 * Issues lines follow the evidence; Save and In chat sit in the actions row,
 * from the pin itself rather than `actions`, so a completed pin has them too.
 * #6539: the actions row is one line at every width (`PinActionRow`), and an
 * open ordinary pin ends it with Dismiss, or Undo once a dismissal is staged.
 */
export function PinDetail(props: {
  model: PinViewModel;
  /** Extra actions before Text (a slot for later sub-issues). */
  actions?: ReactNode;
  /** Replaces the context for a completed pin's summary line. */
  summary?: ReactNode;
  mode?: "tab" | "chat";
}) {
  const { model, actions, summary } = props;
  const { pin } = model;
  const { sessionId, markSeen } = usePinsContext();
  const [showText, setShowText] = useState(false);
  const panels = useAnswerPanels();
  const Body = pinBodyFor(pin);
  const answerable = summary === undefined && isAnswerablePin(pin);
  const staged = useStagedPin(sessionId, pin.key);
  const moot = staged?.choice === undefined ? mootNotice(pin) : undefined;
  const markdown = usePinMarkdownProps();
  const dismissable = summary === undefined && isDismissablePin(pin);
  const dismissal = useDismissStaging(pin);
  const { asking, toggleAsk } = panels;

  // #6539: a question cannot go with a dismissal, so staging one closes an open
  // question field for good (Undo does not re-open it).
  useEffect(() => {
    if (dismissal.staged && asking) toggleAsk();
  }, [dismissal.staged, asking, toggleAsk]);

  useEffect(() => {
    if (isPinNew(pin)) markSeen(pin);
  }, [pin, markSeen]);

  return (
    <div
      id={`pin-detail-${pin.key}`}
      className="pins-detail bg-[var(--app-subtle-bg)]"
    >
      {/* #6574 (Matt's pick C): the facts line opens every pin that has an ID, on
          every surface that renders this detail. One line: the revision and key
          truncate, the ID chip never does. Inside the pin's own box (R18). */}
      {pin.pinId ? (
        <div className="pins-facts mb-1.5 flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[length:var(--text-caption)] text-[var(--app-hint)]">
          <PinIdControl pinId={pin.pinId} form="chip" />
          <HoverTooltip content="The pin's revision and the key its agent gave it">
            <span className="min-w-0 truncate">
              Revision {pin.revision} · key {pin.key}
            </span>
          </HoverTooltip>
        </div>
      ) : null}
      {summary ?? null}
      {moot ? (
        <div className="mb-1.5 text-[length:var(--text-body-dense)] text-[var(--status-warn)]">
          {mootSentence(moot)}
        </div>
      ) : null}
      {summary === undefined && pin.context ? (
        <PinMarkdown
          content={pin.context}
          className="mb-1.5 text-[length:var(--text-body)] text-[var(--app-fg)]"
          remarkPlugins={markdown.remarkPlugins}
          components={markdown.components}
        />
      ) : null}
      {summary === undefined ? (
        <Body model={model} sessionId={sessionId} mode={props.mode ?? "tab"} />
      ) : null}
      {summary === undefined ? (
        <>
          <PinEvidenceList
            sessionId={sessionId}
            evidence={model.evidence}
            revision={pin.revision}
          />
          <PinFilesLine pin={pin} />
          <PinIssuesLine pin={pin} />
        </>
      ) : null}
      {model.degraded ? (
        <div className="mt-2 text-[length:var(--text-body-dense)] text-[var(--status-warn)]">
          Some parts of this pin cannot be shown; see Text.
        </div>
      ) : null}
      {dismissable ? <WillDismissLine flow={dismissal} /> : null}
      <PinActionRow className="mt-2">
        {answerable ? <PinAnswerButtons model={model} panels={panels} /> : null}
        <PinSaveButton pin={pin} />
        {actions}
        <PinActionButton
          rank={ACTION_COLLAPSE_RANK.text}
          content="Show the plain-text version every pin carries"
          aria-pressed={showText}
          onClick={() => setShowText(on => !on)}
          icon={<TextAlignStart style={ACTION_ICON} aria-hidden />}
          label="Text"
        />
        <PinChatButton pin={pin} />
        {dismissable ? <PinDismissAction flow={dismissal} /> : null}
      </PinActionRow>
      {dismissable ? dismissal.dialog : null}
      {answerable ? <PinAnswerFields model={model} panels={panels} /> : null}
      {showText ? <PinTextView text={pin.plainText} /> : null}
    </div>
  );
}
