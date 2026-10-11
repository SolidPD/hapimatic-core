// SPDX-License-Identifier: AGPL-3.0-only
// Note: We intentionally use a regular button for Send instead of ComposerPrimitive.Send
// because ComposerPrimitive.Send has built-in logic that disables sending when the thread
// is running. We need full control to allow queueing messages while Claude is thinking.

import { type ReactNode } from "react";
import { TouchButton } from "@/components/ui/TouchButton";
import { DenseActionCluster } from "@/components/ui/DenseActionCluster";
import { stopButtonLabel } from "@/components/AssistantChat/abortControlState";

function SwitchToRemoteIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
      <line x1="12" y1="18" x2="12.01" y2="18" />
    </svg>
  );
}

function KeyboardIcon() {
  // Feather-style keyboard glyph (issue #2848 kiosk ⌨ summon control).
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="6" width="20" height="12" rx="2" ry="2" />
      <line x1="6" y1="10" x2="6.01" y2="10" />
      <line x1="10" y1="10" x2="10.01" y2="10" />
      <line x1="14" y1="10" x2="14.01" y2="10" />
      <line x1="18" y1="10" x2="18.01" y2="10" />
      <line x1="6" y1="14" x2="6.01" y2="14" />
      <line x1="18" y1="14" x2="18.01" y2="14" />
      <line x1="10" y1="14" x2="14" y2="14" />
    </svg>
  );
}

function AbortIcon(props: { state: "disabled" | "active" | "aborting" }) {
  // Octagon stop sign with square in the middle
  const octagonPoints =
    "7.86,2 16.14,2 22,7.86 22,16.14 16.14,22 7.86,22 2,16.14 2,7.86";

  if (props.state === "aborting") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        className="animate-pulse"
      >
        <polygon
          points={octagonPoints}
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <rect
          x="9"
          y="9"
          width="6"
          height="6"
          rx="0.5"
          fill="var(--app-bg, #1c1c1e)"
        />
      </svg>
    );
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <polygon points={octagonPoints} />
      <rect x="9" y="9" width="6" height="6" rx="0.5" fill="currentColor" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

function QueueIcon() {
  // Front bubble path — used twice (opaque mask + visible fill)
  const frontBubble =
    "M19 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z";
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Back bubble — peeking below-right, full opacity stroke */}
      <path
        d="M22 19a1.5 1.5 0 0 1-1.5 1.5H11l-3 3V11a1.5 1.5 0 0 1 1.5-1.5h11A1.5 1.5 0 0 1 22 11z"
        stroke="currentColor"
        strokeWidth="2"
      />
      {/* Front bubble — opaque mask to occlude back bubble */}
      <path
        d={frontBubble}
        fill="var(--app-secondary-bg, #2c2c2e)"
        stroke="none"
      />
      {/* Front bubble — visible fill + stroke */}
      <path
        d={frontBubble}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

export function ComposerButtons(props: {
  canSend: boolean;
  controlsDisabled: boolean;
  onSend: () => void;
  showAbortButton: boolean;
  abortDisabled: boolean;
  isAborting: boolean;
  abortQueued: boolean;
  onAbort: () => void;
  showSwitchButton: boolean;
  switchDisabled: boolean;
  isSwitching: boolean;
  onSwitch: () => void;
  // Queue indicator props (always visible when queue has items)
  queueLength?: number;
  onQueueIndicatorClick?: () => void;
  // Issue #3289 (S4): the Session Config Cluster (Permission · Model · Effort ·
  // Account · MCP) supersedes the old left-cluster permission + model/effort
  // pickers. HappyComposer passes it here so Row 3 keeps its single
  // justify-between layout (config cluster left, Composer Actions right).
  // Prop-less call sites (FullscreenPromptEditorModal's internal
  // <ComposerButtons>, the ComposerButtons tests) pass nothing → the left cluster
  // stays empty (R4 unchanged).
  leadingCluster?: ReactNode;
  // Kiosk client mode (issue #2848). OPTIONAL — the ⌨ summon control renders ONLY
  // when kioskMode is true AND onSummonKeyboard is wired (the live composer under
  // kiosk), so prop-less call sites (FullscreenPromptEditorModal's internal
  // <ComposerButtons> in non-kiosk, the ComposerButtons tests) grow nothing (R4).
  kioskMode?: boolean;
  onSummonKeyboard?: () => void;
  // Issue #4707: the voice-input mic button. OPTIONAL — rendered between Stop and
  // the queue indicator in the right action group (so the group reads
  // Send · Queue · Mic · Stop right-to-left, operator layout request). The live
  // composer always passes it; ComposerVoiceButton renders nothing when voice
  // input is unavailable on this node. Prop-less call sites render nothing new.
  voiceButton?: ReactNode;
}) {
  const queueLength = props.queueLength ?? 0;
  const hasQueuedMessages = queueLength > 0;

  return (
    // Issue #2882: single-line action row that NEVER wraps. The left cluster gets
    // min-w-0 so its text children (permission · model · effort) ellipsize rather
    // than force a wrap; the right cluster gets shrink-0 so abort → queue → send
    // stay pinned and Send is always visible. pl-2 insets the left cluster toward
    // the label column (Prompt/Notes at Root-x=0) and matches the textarea's px-2,
    // so the permission text and the placeholder share ONE left edge ~1 char in
    // (issue #2882 iter AC — was pl-4, which read ~1 char too far right); the send
    // group stays pinned at the box edge.
    <div className="flex items-center justify-between pl-2 pb-1">
      {/* Left cluster: Session Config Cluster (issue #3289) · switch · kiosk.
          flex-1 + min-w-0 gives the config cluster the room its overflow ladder
          measures against, while the right action group stays shrink-0. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {props.leadingCluster}

        {props.showSwitchButton ? (
          <TouchButton
            aria-label="Switch to remote"
            title="Switch to remote mode"
            disabled={props.switchDisabled}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50"
            onAction={props.onSwitch}
          >
            <SwitchToRemoteIcon />
          </TouchButton>
        ) : null}

        {/* Issue #2848: kiosk ⌨ keyboard-summon control. Rendered ONLY when kiosk
            mode is active AND a summon handler is wired — otherwise the subtree is
            absent, preserving R4. Styled as a TouchButton sibling mirroring
            Switch-to-remote (the 44px touch target matters on the r1). */}
        {props.kioskMode && props.onSummonKeyboard ? (
          <TouchButton
            aria-label="Show keyboard"
            title="Show keyboard"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-link)]"
            onAction={props.onSummonKeyboard}
          >
            <KeyboardIcon />
          </TouchButton>
        ) : null}
      </div>

      {/* Right side: Abort → Mic → Queue → Send (issue #2882; mic #4707). shrink-0 keeps this group
          full-width so Send never shrinks off-screen when the left cluster grows.
          #3032 Sub D — migrated to the shared `DenseActionCluster` composite. */}
      <DenseActionCluster className="shrink-0">
        {/* Abort (relocated from the far left by issue #2882). */}
        {props.showAbortButton
          ? (() => {
              const isAborting = props.isAborting || props.abortQueued;
              const abortState: "disabled" | "active" | "aborting" = isAborting
                ? "aborting"
                : props.abortDisabled
                  ? "disabled"
                  : "active";
              // #4750: a queued stop (tapped before the thread ran) reads
              // "Stopping as soon as possible…" so the pending state is visible.
              const label = stopButtonLabel({
                isAborting: props.isAborting,
                abortQueued: props.abortQueued,
              });
              return (
                <TouchButton
                  aria-label={label}
                  title={label}
                  disabled={props.abortDisabled}
                  className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                    abortState === "aborting"
                      ? "text-red-500"
                      : abortState === "active"
                        ? "text-red-500/30 hover:bg-[var(--app-bg)] hover:text-red-500/80"
                        : "text-[var(--app-fg)]/30 disabled:cursor-not-allowed"
                  }`}
                  onAction={props.onAbort}
                >
                  <AbortIcon state={abortState} />
                </TouchButton>
              );
            })()
          : null}

        {/* Voice mic (issue #4707): sits between Stop and the queue indicator, so
            the group reads Send · Queue · Mic · Stop right-to-left (operator
            layout request). Renders nothing when voice input is unavailable. */}
        {props.voiceButton}

        {/* Queue indicator - ALWAYS visible, grayed when empty, amber when has messages.
            Issue #2882: sits just left of Send in the bottom-right group (the
            mic, #4707, sits to its left). */}
        <TouchButton
          onAction={props.onQueueIndicatorClick}
          aria-label={
            hasQueuedMessages
              ? `${queueLength} message${queueLength > 1 ? "s" : ""} queued - click to manage`
              : "Message queue - click to manage"
          }
          title={
            hasQueuedMessages
              ? `${queueLength} message${queueLength > 1 ? "s" : ""} queued - click to manage`
              : "Message queue"
          }
          className={`relative flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
            hasQueuedMessages
              ? "bg-amber-500/20 text-amber-500 hover:bg-amber-500/30"
              : "text-[var(--app-fg)]/40 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]/60"
          }`}
        >
          <QueueIcon />
          {hasQueuedMessages && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-white">
              {queueLength}
            </span>
          )}
        </TouchButton>

        {/* Send button - regular button for full control over enabled state.
            canSend already accounts for composerDisabled (isSending/threadIsDisabled)
            but NOT !active — allowing queueing when session is offline. */}
        <TouchButton
          onAction={props.onSend}
          disabled={!props.canSend}
          aria-label="Send"
          title="Send"
          className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
            props.canSend ? "bg-black text-white" : "bg-[#C0C0C0] text-white"
          } disabled:cursor-not-allowed`}
        >
          <SendIcon />
        </TouchButton>
      </DenseActionCluster>
    </div>
  );
}
