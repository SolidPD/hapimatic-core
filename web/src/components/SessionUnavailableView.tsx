// SPDX-License-Identifier: AGPL-3.0-only
import { LoadingState } from "@/components/LoadingState";
import { Button } from "@/components/ui/button";
import type { SessionLoadFailure } from "@/lib/nodeAvailability";

/**
 * What the session page and a split pane show when a session did not load
 * (issue #5375). Only a definite 404 says "Session not found"; a restarting or
 * unreachable node or hub shows "Reconnecting…" while the 5 s session poll
 * recovers it; any other error is shown as is. Every state keeps a way back.
 *
 * #5409: "Reconnecting…" is bounded. Once `useSession` reports the transient
 * failure as escalated (RECONNECT_ESCALATE_AFTER_MS or _FAILURES), the view
 * shows the error and a Retry, while polling keeps trying in the background.
 * A `failed` load also gets the Retry.
 */
export function SessionUnavailableView(props: {
  loadFailure: SessionLoadFailure | null;
  errorMessage: string | null;
  /** #5409: the transient failure has outlasted its bound. */
  escalated: boolean;
  onRetry: () => void;
  onBack: () => void;
}): React.ReactElement {
  const { loadFailure, errorMessage, escalated, onRetry, onBack } = props;
  const showsError =
    loadFailure === "failed" || (loadFailure === "transient" && escalated);
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4 gap-3">
      {loadFailure === "not_found" ? (
        <p className="text-sm text-[var(--app-fg)]/60">Session not found</p>
      ) : showsError ? (
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-sm text-[var(--app-fg)]/60">
            {loadFailure === "transient"
              ? "Still can't reach this session"
              : "Couldn't load this session"}
          </p>
          {errorMessage ? (
            <p className="max-w-md break-words text-xs text-[var(--app-hint)]">
              {errorMessage}
            </p>
          ) : null}
          {loadFailure === "transient" ? (
            <p className="max-w-md text-xs text-[var(--app-hint)]">
              This page keeps retrying on its own.
            </p>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onRetry}
            className="mt-2"
          >
            Retry
          </Button>
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
