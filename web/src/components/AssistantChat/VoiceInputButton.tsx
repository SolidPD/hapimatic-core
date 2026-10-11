// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mic button for the composer action row (issue #4707).
 *
 * Tap to start recording, tap again to stop; the transcript lands in the
 * prompt box for editing and is never sent. Errors show in a small bubble
 * above the button that dismisses itself after a few seconds.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { TouchButton } from "@/components/ui/TouchButton";
import type { VoiceInputError, VoiceInputState } from "@/hooks/useVoiceInput";

const ERROR_DISMISS_MS = 6000;

function MicIcon({ small }: { small?: boolean }) {
  // `small` shrinks the glyph so the elapsed timer can stack beneath it inside
  // the fixed 32px button during recording (issue #4707 operator layout request).
  const size = small ? 13 : 16;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="21" />
    </svg>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function VoiceInputButton(props: {
  state: VoiceInputState;
  elapsedMs: number;
  error: VoiceInputError | null;
  disabled?: boolean;
  onToggle: () => void;
  onDismissError: () => void;
}) {
  const { state, error, onDismissError } = props;
  const recording = state === "recording";
  const busy = state === "transcribing" || state === "acquiring";
  const anchorRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ bottom: number; right: number }>({
    bottom: 64,
    right: 8,
  });

  // The composer box clips overflow (rounded corners), so the error bubble is
  // portalled to <body> and pinned above the mic with fixed positioning.
  useLayoutEffect(() => {
    if (!error || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setAnchor({
      bottom: Math.max(8, window.innerHeight - rect.top + 8),
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }, [error]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(onDismissError, ERROR_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [error, onDismissError]);

  const label = recording
    ? "Stop voice input"
    : state === "transcribing"
      ? "Transcribing voice input"
      : "Start voice input";

  return (
    <div ref={anchorRef} className="relative flex items-center">
      <TouchButton
        aria-label={label}
        aria-pressed={recording}
        title={label}
        disabled={props.disabled || busy}
        onAction={props.onToggle}
        // Fixed h-8 w-8 in every state: the elapsed timer stacks INSIDE the
        // button (flex-col) while recording, so its appearance never changes the
        // cell's width and never shifts the neighboring icons (issue #4707).
        className={`relative flex h-8 w-8 flex-col items-center justify-center gap-0 rounded-full leading-none transition-colors disabled:cursor-not-allowed ${
          recording
            ? "bg-red-500/15 text-red-500"
            : "text-[var(--app-fg)]/50 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]/80 disabled:opacity-50"
        }`}
      >
        {busy ? (
          <Spinner />
        ) : recording ? (
          <>
            <MicIcon small />
            <span
              className="font-mono text-[length:var(--text-caption-xs)] leading-none tabular-nums text-red-500"
              aria-live="off"
            >
              {formatElapsed(props.elapsedMs)}
            </span>
          </>
        ) : (
          <MicIcon />
        )}
      </TouchButton>
      {error && typeof document !== "undefined"
        ? createPortal(
            <div
              role="alert"
              style={{ bottom: anchor.bottom, right: anchor.right }}
              className="fixed z-50 w-64 max-w-[calc(100vw-1rem)] rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2 text-xs text-[var(--app-fg)] shadow-lg"
            >
              <p>{error.message}</p>
              <div className="mt-1 flex items-center justify-end gap-3">
                {error.action === "settings" ? (
                  <Link
                    to="/settings/preferences"
                    hash="voice-input"
                    className="font-medium text-[var(--app-link)]"
                    onClick={onDismissError}
                  >
                    Open Settings
                  </Link>
                ) : null}
                <Button
                  variant="ghost"
                  size="dense"
                  type="button"
                  onClick={onDismissError}
                >
                  Dismiss
                </Button>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
