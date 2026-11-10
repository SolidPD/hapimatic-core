// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useAppContext } from "@/lib/app-context";
import { useSession } from "@/hooks/queries/useSession";
import { useSessionViewOptions } from "@/hooks/useSessionViewOptions";
import { LoadingState } from "@/components/LoadingState";
import { ViewPicker } from "@/components/session/ViewPicker";
import { PinsUnavailable, PinsView } from "@/components/pins/PinsView";
import { PinsSubmitBar } from "@/components/pins/PinsSubmitBar";
import { markOpenRedirectConsumed } from "@/lib/session-view";
import { queryKeys } from "@/lib/query-keys";

/**
 * #6449: the Pins view's route (epic #6446). The page gates itself, because a
 * deep link, a notification, or a cold-start route restore can land here with
 * the gate closed:
 * - it marks the session's open-redirect consumed on mount, so Back (→ Chat)
 *   cannot loop back here through a persisted `pins` view;
 * - it waits until the version has been read successfully and the session
 *   detail has answered;
 * - a closed gate replaces the URL with Chat (R18); an open gate with no
 *   known count — a node that cannot serve pins — shows the R19 line;
 * - after an SSE reconnect it refetches, because the app-level backfill only
 *   covers the chat route and a pin raised while the phone slept would
 *   otherwise not appear;
 * - #6453 (R12): `?pin=<key>` reveals that pin once, then is cleared, because
 *   this route owns its search.
 */
export default function PinsPage() {
  const { sessionId } = useParams({ from: "/sessions/$sessionId/pins" });
  const search = useSearch({ from: "/sessions/$sessionId/pins" });
  const { api } = useAppContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = useSession(api, sessionId, true);
  const viewOptions = useSessionViewOptions(sessionId);
  const { settled, pinsEnabled, pinCountKnown } = viewOptions;
  // State, not a ref: the rows register before this box's ref attaches, and
  // the tooltip observer must re-root when it arrives.
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    markOpenRedirectConsumed(sessionId);
  }, [sessionId]);

  const onRevealConsumed = useCallback(() => {
    void navigate({
      to: "/sessions/$sessionId/pins",
      params: { sessionId },
      search: {},
      replace: true,
    });
  }, [navigate, sessionId]);

  useEffect(() => {
    if (settled && !pinsEnabled) {
      void navigate({
        to: "/sessions/$sessionId",
        params: { sessionId },
        replace: true,
      });
    }
  }, [settled, pinsEnabled, navigate, sessionId]);

  useEffect(() => {
    const onConnect = () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.pins(sessionId),
        exact: true,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.session(sessionId),
        exact: true,
      });
    };
    window.addEventListener("hapi:sseConnected", onConnect);
    return () => window.removeEventListener("hapi:sseConnected", onConnect);
  }, [queryClient, sessionId]);

  if (!session || !settled || !pinsEnabled) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingState label="Loading session…" className="text-sm" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ViewPicker session={session} api={api} activeView="pins" />
      <div
        ref={setScrollRoot}
        className="flex-1 overflow-y-auto bg-[var(--app-bg)]"
      >
        <div className="mx-auto w-full max-w-content">
          {pinCountKnown ? (
            // #6451: keyed by session. The router reuses this page across a
            // session change, which would carry the search, held rows, open
            // sections and expanded rows over to the next session.
            <PinsView
              key={sessionId}
              api={api}
              sessionId={sessionId}
              sessionActive={session.active === true}
              enabled
              scrollRoot={scrollRoot}
              revealKey={search.pin}
              onRevealConsumed={onRevealConsumed}
            />
          ) : (
            <PinsUnavailable />
          )}
        </div>
      </div>
      {/* #6450: pinned below the scroll box, so it never scrolls away. */}
      {pinCountKnown ? <PinsSubmitBar api={api} session={session} /> : null}
    </div>
  );
}
