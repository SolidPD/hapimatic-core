// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useState } from "react";
import type { SessionSummary } from "@/types/api";
import { Textarea } from "@/components/ui/Textarea";
import { getSessionTitle } from "@/lib/sessionHelpers";
import { BulkActionConfirm } from "./BulkActionConfirm";

/**
 * The Select-Mode Send dialog (#3818 Slice 1). Step 1 is the prompt field plus
 * the target summary, which is also the first confirmation: it names the count
 * and lists the targets by state. More than one target adds the step that
 * names count and action ("Send to 3 sessions") — the same two-step state
 * machine as Stop turn / Disconnect / Delete (`BulkActionConfirm`).
 */
type SendToSelectedDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  /** The selected sessions in the current (filtered) view. */
  targets: SessionSummary[];
  /** "N in the current view, M selected but hidden — left out." */
  note?: string | null;
  onSend: (text: string) => Promise<void>;
  isPending: boolean;
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Names shown per state before "+N more". */
const NAMES_SHOWN = 4;

function names(sessions: SessionSummary[]): string {
  const shown = sessions.slice(0, NAMES_SHOWN).map(getSessionTitle);
  const rest = sessions.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} +${rest} more` : shown.join(", ");
}

/** "3 connected (1 mid-turn — will be queued), 2 disconnected — will be skipped." */
export function describeSendTargets(targets: SessionSummary[]): string {
  const connected = targets.filter(s => s.active);
  const midTurn = connected.filter(s => s.thinking).length;
  const disconnected = targets.length - connected.length;
  const parts: string[] = [];
  if (connected.length > 0) {
    parts.push(
      `${connected.length} connected` +
        (midTurn > 0 ? ` (${midTurn} mid-turn — will be queued)` : "")
    );
  }
  if (disconnected > 0) {
    parts.push(`${disconnected} disconnected — will be skipped`);
  }
  return `${parts.join(", ")}.`;
}

export function SendToSelectedDialog({
  isOpen,
  onClose,
  targets,
  note,
  onSend,
  isPending,
}: SendToSelectedDialogProps) {
  const [text, setText] = useState("");

  // Every opening starts with an empty prompt.
  useEffect(() => {
    if (isOpen) setText("");
  }, [isOpen]);

  const groups = useMemo(() => {
    const connected = targets.filter(s => s.active);
    return {
      idle: connected.filter(s => !s.thinking),
      midTurn: connected.filter(s => s.thinking),
      disconnected: targets.filter(s => !s.active),
    };
  }, [targets]);

  // Count = the sessions that receive the prompt (now or queued).
  const n = groups.idle.length + groups.midTurn.length;
  const queuedCount = groups.midTurn.length;
  const trimmed = text.trim();

  const rows: { label: string; sessions: SessionSummary[] }[] = [
    { label: "Send now", sessions: groups.idle },
    { label: "Queue (mid-turn)", sessions: groups.midTurn },
    { label: "Skip (disconnected)", sessions: groups.disconnected },
  ];

  return (
    <BulkActionConfirm
      isOpen={isOpen}
      onClose={onClose}
      count={n}
      first={{
        title:
          n === 1
            ? "Send a prompt to this session"
            : `Send a prompt to ${n} sessions`,
        description:
          n === 0
            ? `No selected session is connected. ${describeSendTargets(targets)}`
            : describeSendTargets(targets),
        confirmLabel: n === 1 ? "Send" : "Continue",
      }}
      second={{
        title: "Confirm the send",
        description:
          `This sends the prompt to ${n} sessions, each on the node that runs it.` +
          (queuedCount > 0
            ? ` ${queuedCount} ${plural(queuedCount, "is", "are")} mid-turn and get${plural(queuedCount, "s", "")} it queued.`
            : ""),
        confirmLabel: `Send to ${n} sessions`,
      }}
      note={note}
      confirmingLabel="Sending..."
      onConfirm={() => onSend(trimmed)}
      isPending={isPending}
      confirmDisabled={n === 0 || trimmed.length === 0}
    >
      <Textarea
        aria-label="Prompt"
        placeholder="Prompt to send to the selected sessions"
        rows={4}
        value={text}
        onChange={e => setText(e.target.value)}
        disabled={isPending}
        autoFocus
      />
      <ul
        className="mt-2 space-y-0.5 text-[length:var(--text-caption)] text-[var(--app-hint)]"
        data-testid="send-targets"
      >
        {rows
          .filter(r => r.sessions.length > 0)
          .map(r => (
            <li key={r.label}>
              <span className="font-semibold">
                {r.label} ({r.sessions.length}):
              </span>{" "}
              {names(r.sessions)}
            </li>
          ))}
      </ul>
    </BulkActionConfirm>
  );
}
