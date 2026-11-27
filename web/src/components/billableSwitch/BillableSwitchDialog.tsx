// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #6646 (CONF-A): the confirmation a billable switch, or a Reverse, asks for.
 *
 * The session's row (and the open session's header) owns it and renders it
 * beside the row, never inside the timer menu: the menu closes on any click
 * outside itself and then renders nothing, so a dialog kept there would vanish
 * at the first tap inside it (plan Task 11, review P19).
 *
 * The bodies are Matt's words (ruling AMT-1): until the time-entry record
 * (#6204) knows what was logged, the figure names the timer, through the one
 * wording point `billableAmountWords`. The figure ticks while the session
 * thinks and is frozen at the moment the person confirms.
 *
 * #6778 (moved item 4; ruling PRC-R7): the figure is judged on the record's
 * state through `useOldSwitchAmount`: a waiting record keeps the timer, a
 * session with no record shows its untracked time from the read the switch
 * took before its choice, and without that read the timer shows, as before.
 */
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useLiveNow } from "@/components/SessionTimer";
import {
  billableAmountWords,
  useOldSwitchAmount,
  type BillableSwitchRequest,
  type BillableSwitchSession,
} from "@/hooks/useBillableSwitch";
import { hasLiveSegment } from "@/utils/sessionElapsed";

type Amount = { ms: number; loggedKnown: boolean };

const RECORDED_AT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export type BillableSwitchDialogProps = {
  request: BillableSwitchRequest | null;
  session: BillableSwitchSession;
  sessionName: string;
  onClose: () => void;
  /** Confirmed, with the figure shown at that moment. */
  onConfirm: (amount: Amount) => void;
};

/** Renders nothing until a switch or a Reverse asks for it. */
export function BillableSwitchDialog(props: BillableSwitchDialogProps) {
  if (!props.request) return null;
  return <OpenBillableSwitchDialog {...props} request={props.request} />;
}

function OpenBillableSwitchDialog(
  props: BillableSwitchDialogProps & { request: BillableSwitchRequest }
) {
  const { request, session, sessionName, onClose, onConfirm } = props;
  // Mounted when the dialog opens, so its clock starts at the open; it ticks
  // only while the session has a live segment.
  const nowMs = useLiveNow(hasLiveSegment(session), session.thinkingStartedAt);
  const amount = useOldSwitchAmount(session, nowMs);
  const on = request === "on";

  const description = on
    ? `${billableAmountWords(amount)} becomes billable.`
    : `${billableAmountWords(amount, "off")} will be logged as non-billable.`;

  const body = on ? (
    <>
      {!amount.loggedKnown ? (
        <p>
          Hapimatic cannot yet tell how much of it a billing run already logged.
        </p>
      ) : null}
      {/* #6204 slot: the lines of the picked drawing that need the
          time-entry record go here. */}
    </>
  ) : (
    <>
      {session.active ? (
        <p>It is still connected, so this figure is fixed when you confirm.</p>
      ) : null}
      {/* #6204 slot: "already logged still goes to Wrike" and "synced stays
          in Wrike" go here once the time-entry record exists. */}
      <p>Recorded: switched off, {RECORDED_AT.format(nowMs)}.</p>
    </>
  );

  return (
    <ConfirmDialog
      isOpen
      onClose={onClose}
      title={
        on
          ? `Make "${sessionName}" billable?`
          : `Make "${sessionName}" non-billable?`
      }
      description={description}
      body={body}
      confirmLabel={on ? "Make billable" : "Make non-billable"}
      confirmingLabel={on ? "Making billable…" : "Making non-billable…"}
      cancelLabel="Cancel"
      onConfirm={async () => onConfirm(amount)}
      isPending={false}
      destructive={!on}
      nonBlocking
    />
  );
}
