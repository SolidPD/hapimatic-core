// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { StoredNotification } from "@/types/api";
import { Button } from "@/components/ui/button";
import { KVGrid, type KVGridItem } from "@/components/ui/KVGrid";
import { useAppContext } from "@/lib/app-context";
import { useSessions } from "@/hooks/queries/useSessions";
import { useFederatedSessions } from "@/hooks/queries/useFederatedSessions";
import { dedupeById } from "@/hooks/mutations/useSessionActions";
import { notificationKindDisplay } from "@/lib/notificationKindDisplay";
import {
  contextEntries,
  formatNotificationTime,
  resolveNotificationSession,
} from "@/lib/notificationInbox";
import { getSessionTitle } from "@/lib/sessionHelpers";

/**
 * The session line of a notification's detail (issue #4916 R8). It resolves the
 * row's session against the session list's own two queries — local sessions
 * plus the federation sessions, deduped the way the session list merges them —
 * so it adds no new query (they fetch only when their cache is empty or stale,
 * since this page does not mount the session list). Both queries answer an
 * empty list while loading and
 * on error, so "no longer available" is shown only once both have answered.
 */
function SessionLine({
  sessionId,
  sessionTitle,
}: {
  sessionId: string;
  sessionTitle: string | null;
}) {
  const { api } = useAppContext();
  const navigate = useNavigate();
  const local = useSessions(api);
  const remote = useFederatedSessions(api);
  const sessions = useMemo(
    () => dedupeById([...local.sessions, ...remote.remoteSessions]),
    [local.sessions, remote.remoteSessions]
  );
  const resolved = resolveNotificationSession(sessionId, sessions, {
    settled: !local.isLoading && !remote.isLoading,
    failed: local.error !== null || remote.error !== null,
  });
  const snapshot = sessionTitle ?? "Untitled session";

  if (resolved.state === "found") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-[length:var(--text-body)] text-[var(--app-fg)]">
          {getSessionTitle(resolved.session)}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            void navigate({
              to: "/sessions/$sessionId",
              params: { sessionId },
            })
          }
        >
          Open session
        </Button>
      </div>
    );
  }

  const note =
    resolved.state === "pending"
      ? "Checking…"
      : resolved.state === "unknown"
        ? "couldn't check this session"
        : "no longer available";
  return (
    <p
      className={
        resolved.state === "missing"
          ? "break-words text-[length:var(--text-body)] text-[var(--app-hint)] opacity-60"
          : "break-words text-[length:var(--text-body)] text-[var(--app-hint)]"
      }
      data-testid="notification-session-status"
      data-state={resolved.state}
    >
      {snapshot} — {note}
    </p>
  );
}

/**
 * A notification's detail, rendered inside its expanded row (issue #4916 R7):
 * the full title and body, the session line, and the metadata plus context
 * payload as key/value pairs. Mounted only while the row is open, so the
 * session queries run only for an opened row. All text is rendered by React
 * (escaped); nothing is injected as HTML.
 */
export function NotificationDetail({ row }: { row: StoredNotification }) {
  const items: KVGridItem[] = [
    { key: "Kind", value: notificationKindDisplay(row.kind).label },
    { key: "Severity", value: row.severity },
    { key: "Count", value: String(row.count) },
    { key: "First seen", value: formatNotificationTime(row.firstAt) },
    { key: "Last seen", value: formatNotificationTime(row.lastAt) },
    ...(row.nodeId ? [{ key: "Node", value: row.nodeId }] : []),
    ...(contextEntries(row.context) ?? []).map(entry => ({
      key: entry.key,
      value: entry.structured ? (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono">
          {entry.value}
        </pre>
      ) : (
        entry.value
      ),
    })),
  ];

  return (
    <div className="flex flex-col gap-3 pt-1">
      <div className="flex flex-col gap-1">
        <p className="whitespace-pre-wrap break-words text-[length:var(--text-body)] font-medium text-[var(--app-fg)]">
          {row.title}
        </p>
        {row.body && (
          <p className="whitespace-pre-wrap break-words text-[length:var(--text-body)] text-[var(--app-fg)]">
            {row.body}
          </p>
        )}
      </div>
      {row.sessionId && (
        <SessionLine
          sessionId={row.sessionId}
          sessionTitle={row.sessionTitle}
        />
      )}
      <KVGrid items={items} />
    </div>
  );
}
