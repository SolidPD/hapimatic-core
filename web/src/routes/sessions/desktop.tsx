// SPDX-License-Identifier: AGPL-3.0-only
import { useParams } from "@tanstack/react-router";
import { useAppContext } from "@/lib/app-context";
import { useSession } from "@/hooks/queries/useSession";
import { DesktopView } from "@/components/DesktopView";
import { LoadingState } from "@/components/LoadingState";
import { ViewPicker } from "@/components/session/ViewPicker";
import { SessionOfflineBar } from "@/components/session/SessionOfflineBar";

// The persistent Hapimatic ⇄ Desktop toggle (issue #2693, R3): this route IS the
// desktop half. Epic #3285 correction pass 1: the View Picker's Chat tab (S1,
// #3286) is the way back to the Hapimatic session UI — the old Back / "Desktop" /
// path header is gone, and the tab row is the top of the view. The View Picker
// greys this tab on an instance that cannot serve a desktop (server-reported
// `desktopEligible`), so this page is normally reached only where it can work.
export default function DesktopPage() {
  const { sessionId } = useParams({ from: "/sessions/$sessionId/desktop" });
  const { api, token } = useAppContext();
  const { session } = useSession(api, sessionId, true); // active-session polling

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingState label="Loading session…" className="text-sm" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ViewPicker session={session} api={api} activeView="desktop" />

      {session.active ? null : (
        <SessionOfflineBar message="Session is offline. The desktop is unavailable." />
      )}

      <div className="relative flex-1 overflow-hidden bg-[var(--app-bg)]">
        <div className="mx-auto h-full w-full max-w-content p-3">
          {session.active ? (
            <DesktopView
              sessionId={sessionId}
              token={token}
              className="rounded-md border border-[var(--app-border)] bg-black"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
