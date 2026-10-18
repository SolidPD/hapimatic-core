// SPDX-License-Identifier: AGPL-3.0-only
import { LoadingState } from "@/components/LoadingState";
import type { SessionLoadFailure } from "@/lib/nodeAvailability";

/**
 * What the session page and a split pane show when a session did not load
 * (issue #5375). Only a definite 404 says "Session not found"; a restarting or
 * unreachable node or hub shows "Reconnecting…" while the 5 s session poll
 * recovers it; any other error is shown as is. Every state keeps a way back.
 */
export function SessionUnavailableView(props: {
  loadFailure: SessionLoadFailure | null;
  errorMessage: string | null;
  onBack: () => void;
}): React.ReactElement {
  const { loadFailure, errorMessage, onBack } = props;
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4 gap-3">
      {loadFailure === "not_found" ? (
        <p className="text-sm text-[var(--app-fg)]/60">Session not found</p>
      ) : loadFailure === "failed" ? (
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-sm text-[var(--app-fg)]/60">
            Couldn&apos;t load this session
          </p>
          {errorMessage ? (
            <p className="max-w-md break-words text-xs text-[var(--app-hint)]">
              {errorMessage}
            </p>
          ) : null}
        </div>
      ) : (
        <LoadingState label="Reconnecting…" className="text-sm" />
      )}
      <button /* design-tokens-allow: bare text link (text-link style, hover:underline, no box); Button chrome breaks the inline link - L2 exception (#3404) */
        type="button"
        onClick={onBack}
        className="text-sm text-[var(--app-link)] hover:underline"
      >
        Back to sessions
      </button>
    </div>
  );
}
