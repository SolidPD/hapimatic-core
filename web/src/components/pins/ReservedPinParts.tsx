// SPDX-License-Identifier: AGPL-3.0-only
import type { CSSProperties } from "react";
import { ArrowRight, X } from "lucide-react";
import type { Pin } from "@hapi/protocol";
import type { SessionView } from "@hapi/protocol/schemas";
import {
  PinActionButton,
  PinActionRow,
} from "@/components/pins/PinAnswerControls";
import {
  DISMISS_LABEL,
  PinDismissAction,
  useDismissStaging,
  WILL_DISMISS,
  WillDismissLine,
} from "@/components/pins/PinDismissAction";
import {
  PIN_PILL_CLASS,
  PIN_PILL_STYLE,
  PinIndicator,
  PinTipButton,
  usePinsContext,
} from "@/components/pins/pinsShared";
import { useSelectSessionView } from "@/hooks/useSelectSessionView";
import { ACTION_COLLAPSE_RANK } from "@/lib/pins/actionRowFit";
import type { PinViewModel } from "@/lib/pins/ledger";
import { pinChatAt } from "@/lib/pins/chatTarget";

/**
 * #6455: the server's own pins. A `prompt:` pin mirrors a question or a
 * permission prompt the agent is waiting on; it is answered where it was asked,
 * so it carries no answer controls, only a way there. A `detected:` pin quotes an
 * ask the agent left in the chat without pinning; the operator can dismiss it.
 * #6453: "Go to chat" opens the chat at the spot the pin was raised
 * (`?at=pin:<key>`) when the pin knows it, else switches to Chat.
 * #6539 (ruling Q1): a Detected pin's Dismiss, in its body and its row pill,
 * confirms and is staged like an ordinary pin's (`useDismissStaging`), and goes
 * with the next Submit. Nothing here calls the dismiss route.
 */

const PROMPT_PREFIX = "prompt:";
const TERMINAL_PROMPT_PREFIX = "prompt:tui-";
const DETECTED_PREFIX = "detected:";

const ICON: CSSProperties = { width: "12px", height: "12px" };
const PILL_ICON: CSSProperties = { width: "11px", height: "11px" };
const PILL_COLORS = "border-[var(--app-border)] text-[var(--app-hint)]";
/** M1: the Dismiss pill reads as destructive, like the action row's Dismiss. */
const DISMISS_PILL_COLORS =
  "border-[var(--status-hot)] text-[var(--app-badge-error-text)]";

export function isPromptPinKey(key: string): boolean {
  return key.startsWith(PROMPT_PREFIX);
}

export function isDetectedPinKey(key: string): boolean {
  return key.startsWith(DETECTED_PREFIX);
}

/** Where a prompt pin's prompt waits: the terminal (a TUI prompt) or the chat. */
function promptView(pin: Pin): SessionView {
  return pin.key.startsWith(TERMINAL_PROMPT_PREFIX) ? "terminal" : "chat";
}

/** The view a reserved pin's go control opens, or null when there is none. */
function goTarget(
  pin: Pin,
  sessionActive: boolean,
  mode: "tab" | "chat"
): SessionView | null {
  const view = isPromptPinKey(pin.key) ? promptView(pin) : "chat";
  // The terminal exists only while the session runs, and a chat card is
  // already in the chat.
  if (view === "terminal" && !sessionActive) return null;
  if (view === "chat" && mode === "chat") return null;
  return view;
}

const VIEW_NAME: Record<string, string> = {
  chat: "chat",
  terminal: "terminal",
};

function GoToViewButton(props: { pin: Pin; view: SessionView }) {
  const { api, sessionId } = usePinsContext();
  const selectView = useSelectSessionView(api, sessionId);
  const name = VIEW_NAME[props.view] ?? props.view;
  return (
    <PinActionButton
      rank={ACTION_COLLAPSE_RANK.inChat}
      content={
        props.pin.status === "open" && isPromptPinKey(props.pin.key)
          ? `Open the ${name}, where the prompt is waiting for your answer`
          : `Open the ${name}`
      }
      onClick={() =>
        selectView(
          props.view,
          props.view === "chat" ? pinChatAt(props.pin) : null
        )
      }
      icon={<ArrowRight style={ICON} aria-hidden />}
      iconAfter
      label={`Go to ${name}`}
    />
  );
}

/** A prompt pin: where the prompt is waiting, and a way there. */
export function PromptPinBody(props: {
  model: PinViewModel;
  mode: "tab" | "chat";
}) {
  const { pin } = props.model;
  const { sessionActive } = usePinsContext();
  const view = promptView(pin);
  const target = goTarget(pin, sessionActive, props.mode);
  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
        {pin.status === "open"
          ? `Waiting for your answer in the ${VIEW_NAME[view]}`
          : `Asked in the ${VIEW_NAME[view]}`}
      </span>
      {target ? <GoToViewButton pin={pin} view={target} /> : null}
    </div>
  );
}

/**
 * A Detected pin: its context (rendered above by `PinDetail`) quotes the ask
 * and says Hapimatic found it; this adds the way to the chat and Dismiss, or
 * the Will dismiss line and Undo once a dismissal is staged. One line at every
 * width (R13).
 */
export function DetectedPinBody(props: {
  model: PinViewModel;
  mode: "tab" | "chat";
}) {
  const { pin } = props.model;
  const { sessionActive } = usePinsContext();
  const dismissal = useDismissStaging(pin);
  const target = goTarget(pin, sessionActive, props.mode);
  const open = pin.status === "open";
  return (
    <>
      {open ? <WillDismissLine flow={dismissal} /> : null}
      <PinActionRow className={open && dismissal.staged ? "mt-2" : undefined}>
        {target ? <GoToViewButton pin={pin} view={target} /> : null}
        {open ? <PinDismissAction flow={dismissal} /> : null}
      </PinActionRow>
      {open ? dismissal.dialog : null}
    </>
  );
}

/**
 * The answer-pill cell of a reserved pin's row: an open Detected pin's Dismiss
 * (a press opens the confirm; once staged it is the Will dismiss pill), or the
 * way to the chat or terminal where a prompt is waiting. #6539: `mode` is the
 * row's, so a chat card offers no way to the chat it is already in, as its
 * detail does not (`goTarget`).
 */
export function ReservedPinPill(props: {
  pin: Pin;
  armed: boolean;
  mode: "tab" | "chat";
}) {
  const { pin, armed } = props;
  const { api, sessionId, sessionActive } = usePinsContext();
  const selectView = useSelectSessionView(api, sessionId);
  const dismissal = useDismissStaging(pin);
  if (pin.status !== "open") return null;
  if (isDetectedPinKey(pin.key)) {
    if (dismissal.staged) {
      return (
        <PinIndicator
          armed={armed}
          label={WILL_DISMISS}
          className={`${PIN_PILL_CLASS} ${DISMISS_PILL_COLORS}`}
          style={PIN_PILL_STYLE}
        >
          <X style={PILL_ICON} aria-hidden />
          <span className="max-sm:hidden">{DISMISS_LABEL}</span>
        </PinIndicator>
      );
    }
    return (
      <>
        <PinTipButton
          armed={armed}
          type="button"
          tooltip="Dismiss: nothing is needed from you"
          aria-label="Dismiss pin"
          aria-busy={dismissal.pending}
          disabled={dismissal.pending}
          onClick={dismissal.request}
          className={`${PIN_PILL_CLASS} ${DISMISS_PILL_COLORS} hover:bg-[var(--app-badge-error-bg)] disabled:opacity-50`}
          style={PIN_PILL_STYLE}
        >
          <X style={PILL_ICON} aria-hidden />
        </PinTipButton>
        {dismissal.dialog}
      </>
    );
  }
  const target = goTarget(pin, sessionActive, props.mode);
  if (!target) return null;
  const name = VIEW_NAME[target];
  return (
    <PinTipButton
      armed={armed}
      type="button"
      tooltip={`Open the ${name}, where the prompt is waiting for your answer`}
      aria-label={`Go to ${name}`}
      onClick={() =>
        selectView(target, target === "chat" ? pinChatAt(pin) : null)
      }
      className={`${PIN_PILL_CLASS} ${PILL_COLORS} hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)]`}
      style={PIN_PILL_STYLE}
    >
      <ArrowRight style={PILL_ICON} aria-hidden />
    </PinTipButton>
  );
}
