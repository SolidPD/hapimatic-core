// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The MCP elicitation cards (#6606; Matt's 69-D2-a and 69-S1-a).
 *
 * An MCP server attached to a Codex session asked the user for input. The CLI
 * has already checked the request (a supported form, no field that asks for a
 * secret, an `https` link) and sends back only an answer set the user submits
 * here, after checking it again (`answersToContent` in `@hapi/protocol`).
 *
 * - The form card: one control per field in the order the card input gives;
 *   the server's default prefilled and editable; nothing else preselected;
 *   Submit only once the form is valid, with EVERY field key present (an
 *   emptied field as `[]`); Decline always there, at the top and again on
 *   Submit's row (Matt's 94a). A fixed caution line names the server.
 * - The link card: the message, the parsed host on its own line (flagged when
 *   it is Punycode) and the full address as the browser parses it (the one
 *   "Open link" opens: a look-alike host shows in Punycode, a bidirectional
 *   character in the path percent-encoded), which wraps and is never cut; the
 *   anchor opens nothing until it is tapped; Done sends the raw request
 *   address back as the answer, as the CLI's echo check expects.
 * - One press is one answer (round 5, the round-4 tester's double tap): a
 *   card's answer is sent once, and a card whose answer landed stays in its
 *   sending state until it is gone. For a short time after an answer lands,
 *   and after the card leaves and the chat slides once this page has sent
 *   an answer for it (landed, in flight, or failed: the server may have
 *   taken an answer whose reply failed, round 7), a press inside any other
 *   card's footer (its controls, labels and lines) is ignored
 *   (`elicitationPressHold`). The hold is kept per card, so one card's hold
 *   never ends or takes over another's, and the cards this page sent an
 *   answer for are kept there by request id, so a footer that another
 *   card's leave replaced does not forget its card (round 8). The tool
 *   card's title row is outside the footer's root, so a tap there still
 *   opens that card's read-only "Full details" dialog (a named limit). An
 *   approval card (`PermissionFooter`) honours the hold too (round 9).
 * - What the user typed into a form card, the error of its failed answer,
 *   and an answer in flight or landed are kept by request id while the card
 *   is drawn, so a footer that another card's leave replaced starts from
 *   them (round 9): it shows what was typed and the error, and stays
 *   disabled while that answer is in flight or landed (D6); the focus is not
 *   kept.
 *
 * Server text (the server name, the message, titles, descriptions, choices) is
 * untrusted: it is shown as plain text only, never through a markdown renderer.
 *
 * A row never wraps (round 1, D1; R10-b): every label, legend, choice, hint,
 * description and field error is one line, cut with an ellipsis, and a tap on
 * a field's hint or error line shows that field whole, in place. In a field
 * with no hint and no error line, a cut label, legend or multi-select choice
 * is that tap itself (round 2, F4). An opened label keeps its "*" at the end
 * of its first row, whichever line opened it (Matt's 101-M a). The message,
 * the host and the address are never cut: they are what the user consents to.
 */
import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  answersToContent,
  checkElicitationUrl,
  stripFormatCharacters,
  type ElicitationField,
} from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import type { ChatToolCall } from "@/chat/types";
import {
  cardAnswerSent,
  cardFooterDrawn,
  cardFooterGone,
  heldPressProps,
  holdOtherCards,
  keepCard,
  keptCard,
  watchKeptCard,
} from "@/components/ToolCard/elicitationPressHold";
import { BareButton } from "@/components/ui/BareButton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { RadioRow } from "@/components/ui/RadioRow";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/Spinner";
import { usePlatform } from "@/hooks/usePlatform";
import { cn } from "@/lib/utils";

type Answers = Record<string, string[]>;

const FIELD_KINDS: ReadonlySet<string> = new Set([
  "text",
  "number",
  "integer",
  "boolean",
  "single",
  "multi",
]);

type CardInput =
  | {
      mode: "form";
      server: string;
      message: string;
      fields: ElicitationField[];
    }
  | {
      mode: "url";
      server: string;
      message: string;
      url: string;
      host: string | null;
      punycode: boolean;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The card input, read defensively: a field the card cannot draw voids it. */
function readCardInput(input: unknown): CardInput | null {
  if (!isRecord(input)) return null;
  const server = text(input.server);
  const message = text(input.message);
  if (input.mode === "url") {
    return {
      mode: "url",
      server,
      message,
      url: text(input.url),
      host: typeof input.host === "string" ? input.host : null,
      punycode: input.punycode === true,
    };
  }
  if (input.mode !== "form" || !Array.isArray(input.fields)) return null;
  const fields: ElicitationField[] = [];
  for (const raw of input.fields) {
    if (!isRecord(raw)) return null;
    if (typeof raw.name !== "string" || typeof raw.kind !== "string") {
      return null;
    }
    if (!FIELD_KINDS.has(raw.kind)) return null;
    fields.push(raw as unknown as ElicitationField);
  }
  return { mode: "form", server, message, fields };
}

/**
 * The label a field shows: its title (already cleaned by the parser), else its
 * name without zero-width or bidirectional formatting characters (round 1,
 * D3). The name itself stays the answer's key, unchanged.
 */
function labelOf(field: ElicitationField): string {
  return field.title ?? stripFormatCharacters(field.name);
}

/** The rule part of an `answersToContent` reason ("<field>: <rule>"). */
function ruleOf(reason: string, field: string): string {
  const prefix = `${field}: `;
  return reason.startsWith(prefix) ? reason.slice(prefix.length) : reason;
}

function fieldHint(field: ElicitationField): string | null {
  const parts: string[] = [];
  if (field.kind === "text") {
    if (field.format === "email") parts.push("An email address");
    else if (field.format === "uri") parts.push("A web address");
    else if (field.format === "date") parts.push("A date (YYYY-MM-DD)");
    else if (field.format === "date-time")
      parts.push("A date and time (YYYY-MM-DDThh:mm:ssZ)");
    if (field.minLength !== undefined && field.maxLength !== undefined) {
      parts.push(`${field.minLength} to ${field.maxLength} characters`);
    } else if (field.maxLength !== undefined) {
      parts.push(`Up to ${field.maxLength} characters`);
    } else if (field.minLength !== undefined) {
      parts.push(`At least ${field.minLength} characters`);
    }
  }
  if (field.kind === "number" || field.kind === "integer") {
    const noun = field.kind === "integer" ? "A whole number" : "A number";
    if (field.minimum !== undefined && field.maximum !== undefined) {
      parts.push(`${noun} from ${field.minimum} to ${field.maximum}`);
    } else if (field.minimum !== undefined) {
      parts.push(`${noun} of at least ${field.minimum}`);
    } else if (field.maximum !== undefined) {
      parts.push(`${noun} of at most ${field.maximum}`);
    } else {
      parts.push(noun);
    }
  }
  if (field.kind === "multi") {
    if (field.minItems !== undefined && field.maxItems !== undefined) {
      parts.push(`Choose ${field.minItems} to ${field.maxItems}`);
    } else if (field.minItems !== undefined) {
      parts.push(`Choose at least ${field.minItems}`);
    } else if (field.maxItems !== undefined) {
      parts.push(`Choose up to ${field.maxItems}`);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Decline's row, at the top of the card. The card has no heading of its own:
 * the tool card's title row above it ("<server> asks for input") says it once
 * (round 1, H2). Decline keeps its place, because R9 asks that it be reachable
 * without scrolling the whole form; a form card also has it on Submit's row,
 * so it is in reach at both ends of any form (Matt's 94a).
 */
function DeclineRow(props: { action: ReactNode }) {
  return <div className="flex justify-end">{props.action}</div>;
}

export function ElicitationFooter(props: {
  api: ApiClient;
  sessionId: string;
  tool: ChatToolCall;
  disabled: boolean;
  onDone: () => void;
}) {
  const card = useMemo(
    () => readCardInput(props.tool.input),
    [props.tool.input]
  );
  const permission = props.tool.permission;
  if (!permission || permission.status !== "pending") return null;

  const shared = {
    api: props.api,
    sessionId: props.sessionId,
    requestId: permission.id,
    disabled: props.disabled,
    onDone: props.onDone,
  };
  // Keyed on the request id, so one card's input never carries into another's.
  if (card?.mode === "form") {
    return <FormCard key={permission.id} card={card} {...shared} />;
  }
  if (card?.mode === "url") {
    return <LinkCard key={permission.id} card={card} {...shared} />;
  }
  return <UnreadableCard {...shared} />;
}

type CardProps = {
  api: ApiClient;
  sessionId: string;
  requestId: string;
  disabled: boolean;
  onDone: () => void;
};

/**
 * A card's answer, sent once (round 5, the round-4 tester's double tap):
 * - the latch, a ref, is taken before the request goes, so two presses
 *   inside one script task cannot both send;
 * - once the answer lands the latch is kept, and the card stays in its
 *   sending state, its buttons and fields disabled, until it is gone;
 * - when the answer fails, the buttons come back and the error shows, as
 *   before;
 * - the answer's state (in flight, landed) is kept by request id with the
 *   error, so a footer that another card's leave replaced starts in it: its
 *   buttons and fields are disabled until the answer fails or the card is
 *   gone, and a second tap on it sends nothing (round 9, D6);
 * - the answer landing, and the card leaving once this page has sent an
 *   answer for it (whatever the reply said, or none yet: round 7; kept by
 *   request id, so a footer replaced in between still knows it: round 8),
 *   hold the other cards for a moment, each card's hold kept apart (round
 *   8), and `holdProps` on the footer's root ignores a press on it while any
 *   other card holds it: the press never reaches a control, and nothing in
 *   the footer opens, checks, toggles or takes focus (the tool card's title
 *   row is outside this root).
 */
function useCardActions(props: CardProps) {
  const { haptic } = usePlatform();
  const { requestId } = props;
  // The error and the answer's state are kept by request id, so a footer that
  // replaced this one shows the error of an answer this one sent (round 9,
  // F6), and is disabled while that answer is in flight or landed (D6).
  const watch = useCallback(
    (watcher: () => void) => watchKeptCard(requestId, watcher),
    [requestId]
  );
  const error = useSyncExternalStore(
    watch,
    () => keptCard(requestId).error ?? null
  );
  const loading = useSyncExternalStore(
    watch,
    () => keptCard(requestId).sending ?? null
  );
  const latch = useRef<"open" | "sending" | "answered">("open");
  useLayoutEffect(() => {
    cardFooterDrawn(requestId);
    // The footer counts itself in above, and the cleanup counts it out. The
    // cleanup runs when the card's footer unmounts, for any reason, and when
    // its request id changes (only the card Hapimatic cannot show, which is
    // not keyed on the request id, keeps its footer through one). Once this
    // page has sent an answer for the card it holds the others, because the
    // card leaving slides the chat. It asks only whether an answer was sent,
    // never what came back: the answer may have landed (this starts the hold
    // again), be in flight (the server can take it before this page sees the
    // reply), or have failed on the page while the server took it (round 7).
    // A card that leaves with no answer from this page holds nothing. It
    // also runs when ANOTHER card's leave tears this footer down and mounts
    // it again in the same commit (the round-7 tester; why it remounts is not
    // known). The card then stays drawn. Whether this page sent an answer for
    // it is kept by request id, not in this footer, so the new footer still
    // knows it, and the card's later leave holds the others (round 8); when
    // it is so, this going holds them too. The card itself is held by the
    // leaving card's hold, which exists only when this page sent an answer
    // for the leaving card (round 8). An unmount for another reason (the chat
    // view closing) is harmless: the other cards then ignore presses for half
    // a second, and the card is forgotten with its footer, so after the view
    // opens again its leave holds nothing.
    return () => cardFooterGone(requestId);
  }, [requestId]);
  const run = async (
    kind: "approve" | "decline",
    action: () => Promise<void>
  ) => {
    if (props.disabled || latch.current !== "open") return;
    latch.current = "sending";
    cardAnswerSent(requestId);
    keepCard(requestId, { error: null, sending: kind });
    try {
      await action();
    } catch (e) {
      latch.current = "open";
      haptic.notification("error");
      keepCard(requestId, {
        error: e instanceof Error ? e.message : "Request failed",
        sending: null,
      });
      return;
    }
    latch.current = "answered";
    holdOtherCards(requestId);
    haptic.notification("success");
    props.onDone();
  };
  const holdProps = heldPressProps(requestId);
  const decline = () =>
    run("decline", () =>
      props.api.denyPermission(props.sessionId, props.requestId, {
        decision: "denied",
      })
    );
  const approve = (answers: Answers) =>
    run("approve", () =>
      props.api.approvePermission(props.sessionId, props.requestId, {
        decision: "approved",
        answers,
      })
    );
  return { loading, error, decline, approve, holdProps };
}

function DeclineButton(props: {
  onClick: () => void;
  loading: boolean;
  disabled: boolean;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      title="Send nothing to the server and tell it you declined"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.loading ? "Declining…" : "Decline"}
    </Button>
  );
}

function FormCard(
  props: CardProps & {
    card: Extract<CardInput, { mode: "form" }>;
  }
) {
  const { card } = props;
  const { loading, error, decline, approve, holdProps } = useCardActions(props);
  // What the user typed is kept by request id, so a footer that another
  // card's leave replaced starts from it (round 9, F2).
  const [values, setValues] = useState<Answers>(
    () =>
      keptCard(props.requestId).values ??
      Object.fromEntries(
        card.fields.map(field => [
          field.name,
          field.default ? [...field.default] : [],
        ])
      )
  );
  const [touched, setTouched] = useState<ReadonlySet<string>>(
    () => keptCard(props.requestId).touched ?? new Set()
  );
  useLayoutEffect(() => {
    keepCard(props.requestId, { values, touched });
  }, [props.requestId, values, touched]);

  const valid = answersToContent(card.fields, values).ok;
  const busy = props.disabled || loading !== null;

  const set = (name: string, next: string[]) => {
    setValues(prev => ({ ...prev, [name]: next }));
    setTouched(prev => (prev.has(name) ? prev : new Set(prev).add(name)));
  };
  const fieldError = (field: ElicitationField): string | undefined => {
    if (!touched.has(field.name)) return undefined;
    const result = answersToContent([field], {
      [field.name]: values[field.name] ?? [],
    });
    return result.ok ? undefined : ruleOf(result.reason, field.name);
  };

  return (
    <div className="mt-2 flex max-w-2xl flex-col gap-2" {...holdProps}>
      <DeclineRow
        action={
          <DeclineButton
            onClick={decline}
            loading={loading === "decline"}
            disabled={busy}
          />
        }
      />
      {card.message ? (
        <div className="whitespace-pre-wrap break-words text-sm text-[var(--app-fg)]">
          {card.message}
        </div>
      ) : null}
      <div className="text-xs text-warn">
        Sent to {card.server}. Do not enter passwords or keys.
      </div>

      {card.fields.map(field => (
        <FieldControl
          key={field.name}
          field={field}
          values={values[field.name] ?? []}
          error={fieldError(field)}
          disabled={busy}
          onChange={next => set(field.name, next)}
        />
      ))}

      {/* Decline again on Submit's row, so it is in reach at both ends of
          any form and adds no line (Matt's 94a). */}
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-xs text-[var(--app-badge-error-text)]">
          {error}
        </div>
        <div className="flex items-center gap-2">
          <DeclineButton
            onClick={decline}
            loading={loading === "decline"}
            disabled={busy}
          />
          <Button
            type="button"
            variant="default"
            size="sm"
            title={
              valid
                ? "Send these answers to the server"
                : "Fill in the form to send it"
            }
            disabled={busy || !valid}
            onClick={() => approve(values)}
            aria-busy={loading === "approve"}
            className="gap-2"
          >
            {loading === "approve" ? (
              <>
                <Spinner
                  size="sm"
                  label={null}
                  className="text-[var(--app-button-text)]"
                />
                Sending…
              </>
            ) : (
              "Submit"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A cut line's text, or the whole of it once its row is opened (D1). */
function cutClass(whole: boolean): string {
  return whole ? "min-w-0 whitespace-normal break-words" : "min-w-0 truncate";
}

/**
 * The tap that shows a field's cut text whole, in place, and a second tap
 * that cuts it again (round 1, D1): the shared `BareButton` with
 * `aria-expanded`, drawn as the text it holds. `className` sets the text's
 * size and weight.
 */
function CutToggle(props: {
  whole: boolean;
  onToggle: () => void;
  className: string;
  children: ReactNode;
}) {
  return (
    <BareButton
      type="button"
      aria-expanded={props.whole}
      title={props.whole ? "Show one line" : "Show the whole text"}
      onClick={props.onToggle}
      className={cn(
        "flex w-full min-w-0 justify-start text-left",
        props.className
      )}
    >
      {props.children}
    </BareButton>
  );
}

/**
 * One line of secondary text (a hint, a description, a field's error), cut
 * with an ellipsis before it can wrap; a tap shows the whole text in place and
 * a second tap cuts it again (round 1, D1; R10-b: truncate secondary text, and
 * show detail by expanding the row in place). The whole text is in the
 * document either way, so a screen reader reads all of it.
 */
function CutLine(props: {
  text: string;
  whole: boolean;
  onToggle: () => void;
}) {
  return (
    <CutToggle
      whole={props.whole}
      onToggle={props.onToggle}
      className="text-[length:var(--text-body-dense)] font-normal text-inherit"
    >
      <span className={cutClass(props.whole)}>{props.text}</span>
    </CutToggle>
  );
}

/**
 * Whether a one-line text is cut (wider than its box), measured as
 * `FadeTruncate` measures it, while its field is closed. Opened, the text
 * wraps and is never cut, so the value measured closed is kept: the text that
 * opened the field stays the tap that cuts it again (round 2, F4).
 */
function useCut(whole: boolean, text: string) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    if (!element || whole) return;
    const measure = () => {
      // +1 tolerates sub-pixel rounding, as FadeTruncate does.
      setCut(element.scrollWidth > element.clientWidth + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, whole, text]);
  return { ref: setElement, cut };
}

/** A label's or a legend's text in the tap's own look (round 2, F4). */
const LABEL_TOGGLE = "text-[length:var(--text-label-strong)] text-inherit";

function FieldControl(props: {
  field: ElicitationField;
  values: string[];
  error: string | undefined;
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const { field } = props;
  const label = labelOf(field);
  // One state per field: a tap on its hint or error line, or, in a field with
  // neither, on its cut label, legend or choice (round 2, F4), shows the field
  // whole, in place: its lines, its label and its choices (D1).
  const [whole, setWhole] = useState(false);
  const toggle = () => setWhole(open => !open);
  const cut = (text: string | undefined): ReactNode =>
    text === undefined ? undefined : (
      <CutLine text={text} whole={whole} onToggle={toggle} />
    );
  const hintParts = [field.description, fieldHint(field)].filter(
    (part): part is string => typeof part === "string" && part.length > 0
  );
  const hint = hintParts.length > 0 ? hintParts.join(" — ") : undefined;
  // A field with no hint and no error line has no line to tap: there, a cut
  // label, legend or choice is the tap itself, and one that fits is unchanged
  // (round 2, F4).
  const noLine = hint === undefined && props.error === undefined;
  // A multi-select's group is described by its hint or error line, as
  // FormField describes every other field's control (round 6, A2).
  const lineId = useId();
  const groupDescribedBy = props.error
    ? `${lineId}-error`
    : hint
      ? `${lineId}-hint`
      : undefined;
  const labelCut = useCut(whole, label);
  const labelTaps = noLine && labelCut.cut;
  const labelToggle = (
    <CutToggle whole={whole} onToggle={toggle} className={LABEL_TOGGLE}>
      <span ref={labelCut.ref} className={cutClass(whole)}>
        {label}
      </span>
    </CutToggle>
  );
  // A labelled control's label: the tap, kept on one row with its "*" while
  // open; opened by its hint or error line, the whole text in that same row,
  // so the "*" stays at the end of the label's first row whichever line
  // opened it (Matt's 101-M a); else the label as round 1 drew it, measured
  // when it could be a tap.
  const labelProps = labelTaps
    ? { label: labelToggle, truncateLabel: true }
    : whole
      ? {
          label: <span className={cutClass(true)}>{label}</span>,
          truncateLabel: true,
        }
      : {
          label,
          truncateLabel: true,
          labelRef: noLine ? labelCut.ref : undefined,
        };
  const single = props.values[0] ?? "";
  const setText = (value: string) =>
    props.onChange(value === "" ? [] : [value]);

  switch (field.kind) {
    case "text":
      return (
        <FormField
          {...labelProps}
          required={field.required}
          hint={cut(hint)}
          error={cut(props.error)}
        >
          {control => (
            <Input
              {...control}
              value={single}
              autoCapitalize="none"
              inputMode={field.format === "email" ? "email" : undefined}
              disabled={props.disabled}
              onChange={event => setText(event.target.value)}
            />
          )}
        </FormField>
      );
    case "number":
    case "integer":
      return (
        <FormField
          {...labelProps}
          required={field.required}
          hint={cut(hint)}
          error={cut(props.error)}
          layout="inline"
        >
          {control => (
            <Input
              {...control}
              value={single}
              inputMode={field.kind === "integer" ? "numeric" : "decimal"}
              className="max-w-40 shrink-0 tabular-nums"
              disabled={props.disabled}
              onChange={event => setText(event.target.value)}
            />
          )}
        </FormField>
      );
    case "boolean":
      return (
        <FormField
          {...labelProps}
          required={field.required}
          hint={cut(hint)}
          error={cut(props.error)}
          layout="inline"
        >
          {control => (
            <RadioRow
              className="shrink-0"
              ariaLabel={label}
              aria-describedby={control["aria-describedby"]}
              aria-invalid={control["aria-invalid"]}
              options={[
                { value: "true", label: "Yes" },
                { value: "false", label: "No" },
              ]}
              value={single === "true" || single === "false" ? single : null}
              clearable={!field.required}
              disabled={props.disabled}
              onChange={value => props.onChange(value === null ? [] : [value])}
            />
          )}
        </FormField>
      );
    case "single":
      return (
        <FormField
          {...labelProps}
          required={field.required}
          hint={cut(hint)}
          error={cut(props.error)}
          layout="inline"
        >
          {control => (
            <Select
              {...control}
              // Sized to its content beside the label, as the number input is,
              // so a label keeps its row on a 393 px phone (R10-b).
              className="w-auto min-w-28 max-w-56 shrink-0"
              value={single}
              disabled={props.disabled}
              onChange={event => setText(event.target.value)}
            >
              <option value="">Choose…</option>
              {(field.choices ?? []).map(choice => (
                <option key={choice.value} value={choice.value}>
                  {choice.title}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      );
    case "multi":
      return (
        // min-w-0: a fieldset is min-content wide by default, which a cut
        // (nowrap) legend would push past the card.
        <fieldset
          className="flex min-w-0 flex-col gap-1"
          aria-describedby={groupDescribedBy}
        >
          <legend className="flex w-full min-w-0 text-[length:var(--text-label-strong)] font-medium text-[var(--app-fg)]">
            {labelTaps ? (
              labelToggle
            ) : (
              <span
                ref={noLine ? labelCut.ref : undefined}
                className={cutClass(whole)}
                title={label}
              >
                {label}
              </span>
            )}
            {field.required ? (
              // Every FormField "*" has this look (round 6, A1).
              <span
                aria-hidden="true"
                className="text-[var(--app-badge-error-text)] shrink-0 whitespace-pre"
              >
                {" *"}
              </span>
            ) : null}
          </legend>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {(field.choices ?? []).map(choice => {
              const checked = props.values.includes(choice.value);
              return (
                <ChoiceOption
                  key={choice.value}
                  title={choice.title}
                  checked={checked}
                  whole={whole}
                  taps={noLine}
                  disabled={props.disabled}
                  onToggle={toggle}
                  onCheck={() => {
                    const chosen = new Set(props.values);
                    if (checked) chosen.delete(choice.value);
                    else chosen.add(choice.value);
                    // Keep the server's choice order.
                    props.onChange(
                      (field.choices ?? [])
                        .map(c => c.value)
                        .filter(value => chosen.has(value))
                    );
                  }}
                />
              );
            })}
          </div>
          {props.error ? (
            <p
              id={`${lineId}-error`}
              className="text-[length:var(--text-body-dense)] text-[var(--app-badge-error-text)]"
            >
              {cut(props.error)}
            </p>
          ) : hint ? (
            <p
              id={`${lineId}-hint`}
              className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
            >
              {cut(hint)}
            </p>
          ) : null}
        </fieldset>
      );
  }
}

/**
 * One choice of a multi-select: its box, and its title on one line, cut. In a
 * field with no hint and no error line (`taps`), a cut title is itself the tap
 * that opens the field whole, and only the box checks it; a title that fits is
 * unchanged, and a tap on it checks the box (round 2, F4).
 */
function ChoiceOption(props: {
  title: string;
  checked: boolean;
  whole: boolean;
  taps: boolean;
  disabled: boolean;
  onToggle: () => void;
  onCheck: () => void;
}) {
  const cut = useCut(props.whole, props.title);
  const text = (
    <span
      ref={props.taps ? cut.ref : undefined}
      className={cutClass(props.whole)}
    >
      {props.title}
    </span>
  );
  return (
    <label
      title={props.title}
      className="flex min-w-0 max-w-full items-center gap-1.5 text-sm text-[var(--app-fg)]"
    >
      <Checkbox
        checked={props.checked}
        disabled={props.disabled}
        onChange={props.onCheck}
      />
      {props.taps && cut.cut ? (
        <CutToggle
          whole={props.whole}
          onToggle={props.onToggle}
          className="w-auto text-sm font-normal text-inherit"
        >
          {text}
        </CutToggle>
      ) : (
        text
      )}
    </label>
  );
}

function LinkCard(
  props: CardProps & {
    card: Extract<CardInput, { mode: "url" }>;
  }
) {
  const { card } = props;
  const { loading, error, decline, approve, holdProps } = useCardActions(props);
  const busy = props.disabled || loading !== null;
  // Checked again before any link is drawn: an address that fails is never
  // rendered as a link.
  const checked = checkElicitationUrl(card.url);

  return (
    <div className="mt-2 flex max-w-2xl flex-col gap-2" {...holdProps}>
      <DeclineRow
        action={
          <DeclineButton
            onClick={decline}
            loading={loading === "decline"}
            disabled={busy}
          />
        }
      />
      {card.message ? (
        <div className="whitespace-pre-wrap break-words text-sm text-[var(--app-fg)]">
          {card.message}
        </div>
      ) : null}
      {checked.ok ? (
        <>
          {/* The host stays whole on its line; the flag wraps below it. */}
          <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
            <span className="text-[var(--app-hint)]">Host</span>
            <span className="break-all font-mono text-[var(--app-fg)]">
              {checked.host}
            </span>
            {checked.punycode ? (
              <span className="text-warn">
                Punycode host: check the spelling
              </span>
            ) : null}
          </div>
          {/* What the press opens, never the raw request text (D2). */}
          <div className="break-all font-mono text-xs text-[var(--app-fg)]">
            {checked.href}
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 text-xs text-[var(--app-badge-error-text)]">
              {error}
            </div>
            <div className="flex items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <a
                  href={checked.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open this address in a new tab"
                >
                  Open link
                </a>
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                title="Tell the server you opened the page"
                disabled={busy}
                onClick={() => approve({ url: [card.url] })}
              >
                {loading === "approve" ? "Sending…" : "Done"}
              </Button>
            </div>
          </div>
        </>
      ) : (
        <div className="text-xs text-[var(--app-hint)]">
          Hapimatic cannot show this link ({checked.reason}).
        </div>
      )}
    </div>
  );
}

function UnreadableCard(props: CardProps) {
  const { loading, decline, holdProps } = useCardActions(props);
  return (
    <div
      className="mt-2 flex items-center justify-between gap-2"
      {...holdProps}
    >
      <div className="text-xs text-[var(--app-hint)]">
        An MCP server asked for input that Hapimatic cannot show.
      </div>
      <DeclineButton
        onClick={decline}
        loading={loading === "decline"}
        disabled={props.disabled || loading !== null}
      />
    </div>
  );
}
