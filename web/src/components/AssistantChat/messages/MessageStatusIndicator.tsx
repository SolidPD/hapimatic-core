// SPDX-License-Identifier: AGPL-3.0-only
import type { MessageStatus } from "@/types/api";
import { Button } from "@/components/ui/button";

function ErrorIcon() {
  return (
    <svg className="h-[14px] w-[14px]" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 5v4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11" r="0.75" fill="currentColor" />
    </svg>
  );
}

function BlockedIcon() {
  // A slashed circle — "not sent", visually distinct from the error icon.
  // h-3.5 = 14px (named scale, matches ErrorIcon's size without arbitrary-px).
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M4 4l8 8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SendingIcon() {
  // #1487 (R3): a small clock — "sending / pending delivery". Static (no
  // animation) to stay subtle. h-3.5 = 14px (named scale, no arbitrary-px —
  // #1487 correction 1487-8 keeps this file within its arbitraryPx:2 baseline).
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 5v3l2 1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SentIcon() {
  // #1487 (R2): a single check — "sent / delivered". Transient by design —
  // mergeMessages drops the "sent" optimistic bubble once the server echo lands,
  // so the tick shows only between the API 200 and the echo. h-3.5 = 14px.
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none">
      <path
        d="M3.5 8.5l3 3 6-7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function MessageStatusIndicator(props: {
  status?: MessageStatus;
  onRetry?: () => void;
}) {
  // #3579 (R2): a gate-class denial — the composer bubble stops lying. Distinct
  // from "failed" (a retryable transport error): a blocked send is NOT retryable
  // (re-sending the same token refuses again — recovery is the chip on the
  // in-thread notice), so there is deliberately NO Retry affordance here.
  if (props.status === "blocked") {
    return (
      <span
        className="inline-flex items-center gap-1 text-[var(--app-hint)]"
        data-testid="message-status-blocked"
      >
        <BlockedIcon />
        <span className="text-xs font-normal">Not sent</span>
      </span>
    );
  }

  // #1487 (R1/R3, Deliverable #1): a message in flight shows a subtle pending
  // clock — NO retry (it may still succeed; the transport timeout / onError path
  // owns the failed transition). This is the visible feedback the optimistic
  // bubble previously lacked, especially on low connectivity where "sending"
  // lingers.
  if (props.status === "sending") {
    return (
      <span
        className="inline-flex items-center text-[var(--app-hint)]"
        data-testid="message-status-sending"
        aria-label="Sending"
        title="Sending"
      >
        <SendingIcon />
      </span>
    );
  }

  // #1487 (R2, Deliverable #4): a subtle delivered tick. Transient — the server
  // echo drops the "sent" optimistic bubble (mergeMessages), so the tick shows
  // only between the API 200 and the echo (the directive's transient-tick MVP).
  if (props.status === "sent") {
    return (
      <span
        className="inline-flex items-center text-[var(--app-hint)]"
        data-testid="message-status-sent"
        aria-label="Sent"
        title="Sent"
      >
        <SentIcon />
      </span>
    );
  }

  if (props.status !== "failed") {
    return null;
  }

  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-red-500">
        <ErrorIcon />
      </span>
      {props.onRetry ? (
        <Button
          type="button"
          variant="ghostStatic"
          size="bare"
          onClick={props.onRetry}
          className="text-xs font-normal text-blue-500 hover:text-blue-500 hover:underline"
        >
          Retry
        </Button>
      ) : null}
    </span>
  );
}
