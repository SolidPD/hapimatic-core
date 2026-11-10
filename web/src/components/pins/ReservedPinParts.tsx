// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type CSSProperties } from "react";
import { ArrowRight, X } from "lucide-react";
import type { Pin } from "@hapi/protocol";
import type { SessionView } from "@hapi/protocol/schemas";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import { PIN_ACTION_CLASS } from "@/components/pins/PinAnswerControls";
import {
  PIN_PILL_CLASS,
  PIN_PILL_STYLE,
  PinTipButton,
  usePinsContext,
} from "@/components/pins/pinsShared";
import { useDismissPin } from "@/hooks/queries/usePins";
import { useSelectSessionView } from "@/hooks/useSelectSessionView";
import type { PinViewModel } from "@/lib/pins/ledger";
import { pinChatAt } from "@/lib/pins/chatTarget";

/**
 * #6455: the server's own pins. A `prompt:` pin mirrors a question or a
 * permission prompt the agent is waiting on; it is answered where it was asked,
 * so it carries no answer controls, only a way there. A `detected:` pin quotes an
 * ask the agent left in the chat without pinning; the operator can dismiss it.
 * #6453: "Go to chat" opens the chat at the spot the pin was raised
 * (`?at=pin:<key>`) when the pin knows it, else switches to Chat.
 */

const PROMPT_PREFIX = "prompt:";
const TERMINAL_PROMPT_PREFIX = "prompt:tui-";
const DETECTED_PREFIX = "detected:";

const ICON: CSSProperties = { width: "12px", height: "12px" };
const PILL_ICON: CSSProperties = { width: "11px", height: "11px" };
const BUTTON_STYLE: CSSProperties = { height: "26px", fontSize: "11.5px" };
const PILL_COLORS = "border-[var(--app-border)] text-[var(--app-hint)]";

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
    <HoverTooltipButton
      type="button"
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
      className={`${PIN_ACTION_CLASS} shrink-0`}
      style={BUTTON_STYLE}
    >
      Go to {name}
      <ArrowRight style={ICON} aria-hidden />
    </HoverTooltipButton>
  );
}

/** Dismiss with a pending state; reports whether the last attempt failed. */
function useDismiss(pin: Pin) {
  const { api, sessionId } = usePinsContext();
  const dismissPin = useDismissPin(api, sessionId);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const dismiss = () => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    dismissPin(pin.key).then(
      () => setPending(false),
      () => {
        setPending(false);
        setFailed(true);
      }
    );
  };
  return { dismiss, pending, failed };
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
 * and says Hapimatic found it; this adds the way to the chat and Dismiss.
 */
export function DetectedPinBody(props: {
  model: PinViewModel;
  mode: "tab" | "chat";
}) {
  const { pin } = props.model;
  const { sessionActive } = usePinsContext();
  const { dismiss, pending, failed } = useDismiss(pin);
  const target = goTarget(pin, sessionActive, props.mode);
  return (
    <>
      <div className="flex flex-wrap items-center gap-1">
        {target ? <GoToViewButton pin={pin} view={target} /> : null}
        {pin.status === "open" ? (
          <HoverTooltipButton
            type="button"
            content="Dismiss this pin: nothing is needed from you"
            aria-busy={pending}
            disabled={pending}
            onClick={dismiss}
            className={PIN_ACTION_CLASS}
            style={BUTTON_STYLE}
          >
            <X style={ICON} aria-hidden />
            Dismiss
          </HoverTooltipButton>
        ) : null}
      </div>
      {failed ? (
        <div className="mt-1.5 text-[length:var(--text-body-dense)] text-[var(--status-warn)]">
          This pin was not dismissed. Try again.
        </div>
      ) : null}
    </>
  );
}

/**
 * The answer-pill cell of a reserved pin's row: one tap dismisses an open
 * Detected pin, or opens the chat or terminal where a prompt is waiting.
 */
export function ReservedPinPill(props: { pin: Pin; armed: boolean }) {
  const { pin, armed } = props;
  const { api, sessionId, sessionActive } = usePinsContext();
  const selectView = useSelectSessionView(api, sessionId);
  const { dismiss, pending, failed } = useDismiss(pin);
  if (pin.status !== "open") return null;
  if (isDetectedPinKey(pin.key)) {
    return (
      <PinTipButton
        armed={armed}
        type="button"
        tooltip={
          failed
            ? "This pin was not dismissed. Click to try again"
            : "Dismiss: nothing is needed from you"
        }
        aria-label="Dismiss pin"
        aria-busy={pending}
        disabled={pending}
        onClick={dismiss}
        className={`${PIN_PILL_CLASS} ${
          failed
            ? "border-[var(--status-warn)] text-[var(--status-warn)]"
            : PILL_COLORS
        } hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)]`}
        style={PIN_PILL_STYLE}
      >
        <X style={PILL_ICON} aria-hidden />
      </PinTipButton>
    );
  }
  const target = goTarget(pin, sessionActive, "tab");
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
