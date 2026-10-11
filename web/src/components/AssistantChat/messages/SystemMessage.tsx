// SPDX-License-Identifier: AGPL-3.0-only
import { useAssistantState } from "@assistant-ui/react";
import type { GateDenialOutcome } from "@hapi/protocol";
import {
  getEventPresentation,
  getSpendLimitNoticeCopy,
  type SpendLimitNoticeEvent,
} from "@/chat/presentation";
import type { HappyChatMessageMetadata } from "@/lib/assistant-runtime";
import type { BranchSummary } from "@/hooks/useBranchSummary";
import { BranchSummaryCard } from "@/components/BranchSummaryCard";
import { QuickReplies } from "@/components/AssistantChat/messages/QuickReplies";
import { EventLabel } from "@/components/AssistantChat/messages/EventLabel";

/** Format an ISO instant to the browser's locale (R6 — the server sends ISO, the
 *  client formats). Returns null for a missing/invalid value so the row is hidden. */
function formatNoticeTimestamp(at: string | undefined): string | null {
  if (!at) return null;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString();
}

/**
 * #3579: the durable in-thread gate-denial notice (R3). Renders the catalogue
 * copy (title / explanation / nextStep) + the locale-formatted timestamp + the
 * one-tap recovery chip (R5), which reuses the QuickReplies menu primitive so the
 * canned, token-free message sends through the normal composer path.
 */
function GateDenialNotice({
  outcome,
  at,
}: {
  outcome: GateDenialOutcome;
  at: string | undefined;
}) {
  const when = formatNoticeTimestamp(at);
  return (
    <div className="py-2" data-testid="gate-denial-notice">
      <div className="mx-auto w-full max-w-[92%] rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2">
        <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--app-fg)]">
          <span aria-hidden="true">🚫</span>
          <span>{outcome.title}</span>
        </div>
        <p className="mt-1 text-xs text-[var(--app-fg)]/80">
          {outcome.explanation}
        </p>
        <p className="mt-1 text-xs text-[var(--app-hint)]">
          {outcome.nextStep}
        </p>
        {when ? (
          <div className="mt-1 text-xs text-[var(--app-hint)]">{when}</div>
        ) : null}
        {outcome.chip ? (
          <QuickReplies
            spec={{
              variant: "menu",
              entries: [
                {
                  label: outcome.chip.label,
                  payload: outcome.chip.cannedMessage,
                },
              ],
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * #4936: the durable in-thread STOP notice for an API spend cap / a user-set
 * spend limit — the key label, the API-reported resume date (UTC), and what
 * the operator can do. Auto-recovery never retries this class.
 */
function SpendLimitNotice({ event }: { event: SpendLimitNoticeEvent }) {
  const copy = getSpendLimitNoticeCopy(event);
  const when = formatNoticeTimestamp(event.at);
  return (
    <div className="py-2" data-testid="spend-limit-notice">
      <div className="mx-auto w-full max-w-[92%] rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2">
        <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--app-fg)]">
          <span aria-hidden="true">🛑</span>
          <span>{copy.title}</span>
        </div>
        <p className="mt-1 text-xs text-[var(--app-fg)]/80">{copy.detail}</p>
        <p className="mt-1 text-xs text-[var(--app-hint)]">{copy.nextStep}</p>
        {when ? (
          <div className="mt-1 text-xs text-[var(--app-hint)]">{when}</div>
        ) : null}
      </div>
    </div>
  );
}

export function HappySystemMessage() {
  const role = useAssistantState(({ message }) => message.role);
  const text = useAssistantState(({ message }) => {
    if (message.role !== "system") return "";
    return message.content[0]?.type === "text" ? message.content[0].text : "";
  });
  const custom = useAssistantState(({ message }) => {
    if (message.role !== "system") return undefined;
    return message.metadata.custom as
      | Partial<HappyChatMessageMetadata>
      | undefined;
  });
  const event = custom?.kind === "event" ? custom.event : undefined;
  const icon = event ? getEventPresentation(event).icon : null;
  const isCompaction = event?.type === "context-compaction";
  const isConversationBranched = event?.type === "conversation-branched";
  const isTurnResult = event?.type === "turn-result";
  const isBranchPoint = event?.type === "branch-point";
  const branchSummary =
    isBranchPoint && event && "summary" in event
      ? (event.summary as BranchSummary)
      : null;

  if (role !== "system") return null;

  // #3579: the durable gate-denial notice (R3). Rendered as a distinct card, not
  // the generic centered event label.
  if (event && event.type === "gate-denied") {
    const gd = event as { outcome: GateDenialOutcome; at?: string };
    return <GateDenialNotice outcome={gd.outcome} at={gd.at} />;
  }

  // #4936: the durable spend-limit stop notice — a distinct card.
  if (event && event.type === "spend-limit-reached") {
    return <SpendLimitNotice event={event as SpendLimitNoticeEvent} />;
  }

  if (isBranchPoint) {
    return (
      <div className="py-4">
        <div className="flex items-center gap-3 px-4">
          <div className="h-px flex-1 bg-[var(--app-link)] opacity-40" />
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--app-link)]/30 bg-[var(--app-bg)] px-3 py-1 text-xs text-[var(--app-link)]">
            {icon ? <span aria-hidden="true">{icon}</span> : null}
            <span>{text}</span>
          </span>
          <div className="h-px flex-1 bg-[var(--app-link)] opacity-40" />
        </div>
        {branchSummary ? (
          <div className="pt-2">
            <BranchSummaryCard summary={branchSummary} />
          </div>
        ) : null}
      </div>
    );
  }

  if (isCompaction || isConversationBranched) {
    return (
      <div className="py-3">
        <div className="flex items-center gap-3 px-4">
          <div className="h-px flex-1 bg-[var(--app-hint)] opacity-30" />
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--app-hint)]/20 bg-[var(--app-bg)] px-3 py-1 text-xs text-[var(--app-hint)]">
            {icon ? <span aria-hidden="true">{icon}</span> : null}
            <span>{text}</span>
          </span>
          <div className="h-px flex-1 bg-[var(--app-hint)] opacity-30" />
        </div>
      </div>
    );
  }

  // Turn-result events are now rendered inline in AssistantMessage's footer
  if (isTurnResult) return null;

  return (
    <div className="py-1">
      <div className="mx-auto w-fit max-w-[92%] px-2 text-center text-xs text-[var(--app-hint)] opacity-80">
        <EventLabel icon={icon} text={text} />
      </div>
    </div>
  );
}
