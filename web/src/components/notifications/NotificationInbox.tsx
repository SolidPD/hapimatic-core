// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useMemo, useState } from "react";
import { Inbox } from "lucide-react";
import type { StoredNotification } from "@/types/api";
import { useAppContext } from "@/lib/app-context";
import {
  useNotificationList,
  useNotificationUnreadCount,
} from "@/hooks/queries/useNotifications";
import { useNotificationActions } from "@/hooks/mutations/useNotificationActions";
import {
  isInboxCapped,
  INBOX_PAGE_LIMIT,
  orderInbox,
} from "@/lib/notificationInbox";
import { IconSectionHeading } from "@/components/settings/IconSectionHeading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { StatePanel } from "@/components/ui/StatePanel";
import { NotificationRow } from "./NotificationRow";

/** How often the open inbox re-reads the list when no event arrives. */
const INBOX_POLL_MS = 30_000;

const EMPTY_ROWS: StoredNotification[] = [];

/**
 * The Inbox section of Settings → Notifications (issue #4916, epic #4912 Sub
 * D): the undismissed notifications from the last 48 hours (up to the 200
 * most recent), unread first. Each row
 * expands in place to its detail (opening an unread row marks it read on the
 * server) and has its own dismiss control; "Clear all" dismisses everything.
 *
 * Freshness: a `notification` SyncEvent patches the list through
 * `NotificationListener`; the list also polls every 30 s while this section is
 * mounted, and refetches when the event stream reconnects, because events
 * missed while the stream was down never reach the cache and the app does not
 * refetch on window focus.
 *
 * No nested scroll container: the `SettingsPage` root owns the page's single
 * scroll, and the app shell's footer pads the bottom safe area.
 */
export function NotificationInbox() {
  const { api } = useAppContext();
  const list = useNotificationList(api, { refetchInterval: INBOX_POLL_MS });
  const unreadCount = useNotificationUnreadCount(api);
  const { markRead, dismiss, dismissAll } = useNotificationActions(api);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const [heldIds, setHeldIds] = useState<ReadonlySet<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);

  const { refetch } = list;
  useEffect(() => {
    const onConnect = () => void refetch();
    window.addEventListener("hapi:sseConnected", onConnect);
    return () => window.removeEventListener("hapi:sseConnected", onConnect);
  }, [refetch]);

  const rows = list.data?.notifications ?? EMPTY_ROWS;
  const ordered = useMemo(() => orderInbox(rows, heldIds), [rows, heldIds]);

  const handleOpenChange = useCallback(
    (row: StoredNotification) => (next: boolean) => {
      setOpenIds(prev => {
        const set = new Set(prev);
        if (next) set.add(row.id);
        else set.delete(row.id);
        return set;
      });
      if (next && row.readAt == null) {
        // Keep the row in its place for the rest of this visit (closing it
        // does not release the hold), then mark it read.
        setHeldIds(prev => new Set(prev).add(row.id));
        markRead(row);
      }
    },
    [markRead]
  );

  const count = unreadCount.data?.count ?? 0;

  return (
    <section
      id="inbox"
      aria-label="Notification inbox"
      className="flex scroll-mt-2 flex-col gap-3"
    >
      <div className="flex items-center gap-2">
        <IconSectionHeading
          icon={Inbox}
          accent="var(--accent-amber-400)"
          title="Inbox"
        />
        {count > 0 && (
          <Badge variant="mint" data-testid="notifications-unread-count">
            {count} unread
          </Badge>
        )}
        {rows.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => setConfirmClear(true)}
          >
            Clear all
          </Button>
        )}
      </div>

      {list.isRefetchError && (
        <p
          role="status"
          data-testid="notifications-refresh-error"
          className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
        >
          Couldn't refresh notifications. Showing the last loaded list.
        </p>
      )}
      {list.isLoading ? (
        <StatePanel variant="loading" title="Loading…" />
      ) : list.isLoadingError ? (
        // Only a failed FIRST load replaces the list. A failed refetch keeps
        // the loaded rows (TanStack keeps `data` and sets `isError`), and the
        // note above says the list may be out of date.
        <StatePanel
          variant="error"
          title="Couldn't load notifications"
          testId="notifications-error"
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void list.refetch()}
              disabled={list.isFetching}
            >
              Retry
            </Button>
          }
        />
      ) : ordered.length === 0 ? (
        <StatePanel
          title="No notifications in the last 48 hours"
          testId="notifications-empty"
        />
      ) : (
        <>
          <div data-testid="notifications-list" className="flex flex-col gap-2">
            {ordered.map(row => (
              <NotificationRow
                key={row.id}
                row={row}
                open={openIds.has(row.id)}
                onOpenChange={handleOpenChange(row)}
                onDismiss={dismiss}
              />
            ))}
          </div>
          {isInboxCapped(rows.length) && (
            <p className="text-center text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
              Showing the {INBOX_PAGE_LIMIT} most recent
            </p>
          )}
        </>
      )}

      <ConfirmDialog
        isOpen={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Clear all notifications?"
        description="This dismisses every notification from the last 48 hours. Dismissed notifications cannot be restored."
        confirmLabel="Clear all"
        confirmingLabel="Clearing…"
        onConfirm={dismissAll}
        onError={() => {}}
        isPending={false}
        destructive
        nonBlocking
      />
    </section>
  );
}
