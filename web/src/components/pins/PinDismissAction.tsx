// SPDX-License-Identifier: AGPL-3.0-only
import {
  useCallback,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Undo2, X } from "lucide-react";
import {
  PIN_DEADLINE_LATE_NOTICE_MS,
  PIN_DEADLINE_MIN_LEAD_MS,
  type Pin,
} from "@hapi/protocol";
import { ApiError } from "@/api/client";
import {
  isAnswerablePin,
  PinActionButton,
} from "@/components/pins/PinAnswerControls";
import { usePinsContext } from "@/components/pins/pinsShared";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useSetPinDeadline } from "@/hooks/queries/usePins";
import { ACTION_COLLAPSE_RANK } from "@/lib/pins/actionRowFit";
import { pinDeadlineOf } from "@/lib/pins/deadline";
import { stageDismiss, unstageDismiss, useStagedPin } from "@/lib/pins/staging";

/**
 * #6539: Dismiss for a pin the operator will not answer (rulings X1, M1, Q1, Q4).
 *
 * A dismissal is staged like an answer: confirming marks the pin Will dismiss
 * on this device, and the next Submit closes it and tells the agent, in the same
 * transaction as the message. Nothing here calls the dismiss route. The one
 * request before Submit turns an armed automatic pick off, so the pin cannot
 * answer itself while it waits; Undo turns the pick back on.
 */

// Every string in one place, so a wording change is one edit.
export const DISMISS_LABEL = "Dismiss";
export const DISMISS_CONFIRMING = "Dismissing…";
export const DISMISS_TOOLTIP = "Dismiss this pin without answering it";
export const UNDO_LABEL = "Undo";
export const UNDO_TOOLTIP = "Keep this pin open: it will not be dismissed";
export const DISMISS_CONFIRM_TITLE = "Dismiss this pin?";
export const DISMISS_CONFIRM_TEXT =
  "It stays here marked Will dismiss until you Submit. Submit closes it and tells the agent you dismissed it.";
export const DISMISS_CONFIRM_DISCARDS =
  "Your staged answer to it is discarded.";
export const DISMISS_CONFIRM_PICK =
  "Its automatic pick is turned off now; Undo turns it back on.";
export const DISMISS_NOT_MARKED = "This pin was not marked. Try again.";
export const UNDO_NOT_RESTORED =
  "The automatic pick was not restored. Try again.";
export const WILL_DISMISS = "Will dismiss at your next Submit";
export const WILL_DISMISS_PICK_OFF = "automatic pick off until then";

/** The codes the deadline route sends when there is nothing left to restore. */
const NOTHING_TO_RESTORE: ReadonlySet<string> = new Set([
  "pin_not_open",
  "pin_no_automatic_pick",
]);

const ICON: CSSProperties = { width: "12px", height: "12px" };
/** The line's icon, dropped 2 px so it sits on the text's first line. */
const LINE_ICON: CSSProperties = { ...ICON, marginTop: "2px" };
/** M1: Dismiss reads as destructive. Outline, then icon and word, then hover. */
const DISMISS_CLASS =
  "inline-flex items-center gap-1 rounded-md border border-[var(--status-hot)] px-2 font-semibold text-[var(--app-badge-error-text)] hover:bg-[var(--app-badge-error-bg)] disabled:opacity-50";
const UNDO_CLASS =
  "inline-flex items-center gap-1 rounded-md border border-[var(--app-border)] px-2 font-semibold text-[var(--app-fg)] hover:bg-[var(--app-hover)] disabled:opacity-50";

/**
 * A pin the operator may dismiss from its action row: exactly the pins they may
 * answer (KD1). A dashboard, a closed pin and a `prompt:` pin are not; a
 * Detected pin has its own Dismiss, which uses the same flow.
 */
export function isDismissablePin(pin: Pin): boolean {
  return isAnswerablePin(pin);
}

export type DismissStaging = {
  /** A dismissal is staged for this pin. */
  staged: boolean;
  /** Staging it turned the automatic pick off; Undo turns it back on. */
  pickHeld: boolean;
  /** Open the confirm. Nothing changes until it is confirmed. */
  request: () => void;
  /** Un-stage, restoring the pick first when one was held. */
  undo: () => void;
  /** A request is out: the pick is being turned off, or restored. */
  pending: boolean;
  /** Why the last Undo did not happen, or null. */
  failed: string | null;
  /** The confirm, to render once near the control. */
  dialog: ReactNode;
};

/**
 * Headroom over the server's one-minute minimum: the server checks the lead on
 * its own clock after the request arrives, so a time that clears the minimum by
 * less than this on the client's clock would be refused.
 */
export const UNDO_RESTORE_MARGIN_MS = 10_000;

/** The pick time Undo restores: the original when it is still far enough ahead. */
export function restoredPickAt(pickAt: number, now: number): number {
  return pickAt - now >= PIN_DEADLINE_MIN_LEAD_MS + UNDO_RESTORE_MARGIN_MS
    ? pickAt
    : now + PIN_DEADLINE_LATE_NOTICE_MS;
}

/**
 * The confirm-and-stage flow, shared by an ordinary pin's action row and the
 * Detected pin's body and row pill (ruling Q1: one behaviour for every dismiss).
 */
export function useDismissStaging(pin: Pin): DismissStaging {
  const { api, sessionId, via } = usePinsContext();
  const staged = useStagedPin(sessionId, pin.key);
  const { setDeadline } = useSetPinDeadline(api, sessionId);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const armedAt = pin.deadlineBy === "off" ? undefined : pinDeadlineOf(pin);
  const discards =
    staged?.choice !== undefined ||
    (staged?.questions?.length ?? 0) > 0 ||
    (staged?.ticks?.length ?? 0) > 0;

  const confirm = useCallback(async () => {
    setFailed(null);
    if (armedAt === undefined) {
      stageDismiss(sessionId, pin, via);
      return;
    }
    // Q4: the pick loop reads server state only, so the hold must reach the
    // server before anything is staged. A failure stages nothing.
    setConfirming(true);
    try {
      await setDeadline(pin.key, { off: true });
    } catch {
      throw new Error(DISMISS_NOT_MARKED);
    } finally {
      setConfirming(false);
    }
    stageDismiss(sessionId, pin, via, armedAt);
  }, [armedAt, pin, sessionId, setDeadline, via]);

  const pickAt = staged?.pickAt;
  const undo = useCallback(() => {
    if (undoing) return;
    setFailed(null);
    if (pickAt === undefined) {
      unstageDismiss(sessionId, pin.key);
      return;
    }
    setUndoing(true);
    const at = new Date(restoredPickAt(pickAt, Date.now())).toISOString();
    setDeadline(pin.key, { at }).then(
      () => {
        setUndoing(false);
        unstageDismiss(sessionId, pin.key);
      },
      (error: unknown) => {
        setUndoing(false);
        // The pin closed meanwhile, or the agent removed its pick: there is
        // nothing to restore, so the dismissal is un-staged all the same.
        if (
          error instanceof ApiError &&
          error.status === 409 &&
          error.code !== undefined &&
          NOTHING_TO_RESTORE.has(error.code)
        ) {
          unstageDismiss(sessionId, pin.key);
        } else {
          setFailed(UNDO_NOT_RESTORED);
        }
      }
    );
  }, [pickAt, pin.key, sessionId, setDeadline, undoing]);

  const description = [
    DISMISS_CONFIRM_TEXT,
    discards ? DISMISS_CONFIRM_DISCARDS : null,
    armedAt !== undefined ? DISMISS_CONFIRM_PICK : null,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    staged: staged?.dismiss === true,
    pickHeld: pickAt !== undefined,
    request: useCallback(() => setOpen(true), []),
    undo,
    pending: confirming || undoing,
    failed,
    dialog: open ? (
      <ConfirmDialog
        isOpen
        onClose={() => setOpen(false)}
        title={DISMISS_CONFIRM_TITLE}
        description={description}
        confirmLabel={DISMISS_LABEL}
        confirmingLabel={DISMISS_CONFIRMING}
        onConfirm={confirm}
        isPending={confirming}
        destructive
      />
    ) : null,
  };
}

/**
 * The action row's last button: Dismiss, or Undo once a dismissal is staged.
 * Dismiss keeps its red outline when its label gives way to its icon (R13).
 */
export function PinDismissAction(props: { flow: DismissStaging }) {
  const { flow } = props;
  return flow.staged ? (
    <PinActionButton
      rank={ACTION_COLLAPSE_RANK.undo}
      content={UNDO_TOOLTIP}
      aria-busy={flow.pending}
      disabled={flow.pending}
      onClick={flow.undo}
      className={UNDO_CLASS}
      icon={<Undo2 style={ICON} aria-hidden />}
      label={UNDO_LABEL}
    />
  ) : (
    <PinActionButton
      rank={ACTION_COLLAPSE_RANK.dismiss}
      content={DISMISS_TOOLTIP}
      aria-busy={flow.pending}
      disabled={flow.pending}
      onClick={flow.request}
      className={DISMISS_CLASS}
      icon={<X style={ICON} aria-hidden />}
      label={DISMISS_LABEL}
    />
  );
}

/**
 * The line above the action row while a dismissal is staged, and why the last
 * Undo failed when it did.
 */
export function WillDismissLine(props: { flow: DismissStaging }) {
  const { flow } = props;
  if (!flow.staged && !flow.failed) return null;
  return (
    <>
      {flow.staged ? (
        <div
          className="mt-2 flex min-w-0 items-start gap-1 text-[var(--app-badge-error-text)]"
          style={{ fontSize: "12px", lineHeight: "16px" }}
        >
          <X style={LINE_ICON} className="flex-none" aria-hidden />
          <span className="min-w-0">
            {WILL_DISMISS}
            {flow.pickHeld ? `, ${WILL_DISMISS_PICK_OFF}` : ""}
          </span>
        </div>
      ) : null}
      {flow.failed ? (
        <div
          role="alert"
          className="mt-1.5 text-[length:var(--text-body-dense)] text-[var(--status-warn)]"
        >
          {flow.failed}
        </div>
      ) : null}
    </>
  );
}
