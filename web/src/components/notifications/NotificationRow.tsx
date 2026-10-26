// SPDX-License-Identifier: AGPL-3.0-only
import { X } from "lucide-react";
import type { StoredNotification } from "@/types/api";
import { Button } from "@/components/ui/button";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { notificationKindDisplay } from "@/lib/notificationKindDisplay";
import { formatRelativeTime } from "@/lib/sessionHelpers";
import { cn } from "@/lib/utils";
import { NotificationDetail } from "./NotificationDetail";

/**
 * One inbox row (issue #4916). The header shows the kind icon, the title, and
 * a meta line (session title snapshot · ×count · relative time); tapping it
 * expands the detail in place, the same accordion the Feedback and Error Log
 * pages use. The header is `py-2` around the 32 px icon tile and the two-line
 * title, so its tap target is at least 44 px tall (measured 53 px).
 *
 * The dismiss control sits BESIDE the section, not inside it: the section
 * header is one `<button>` with no actions slot, and a button inside a button
 * is invalid HTML whose click would also toggle the row. It is the standard
 * dense icon button — the design system rejects inflating controls to 44 px
 * (docs/design/design-system/authoring-guide.md, R-1 / R-5).
 */
export function NotificationRow({
  row,
  open,
  onOpenChange,
  onDismiss,
}: {
  row: StoredNotification;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDismiss: (row: StoredNotification) => void;
}) {
  const { icon: Icon } = notificationKindDisplay(row.kind);
  const isRead = row.readAt != null;
  const meta = [
    row.sessionTitle,
    row.count > 1 ? `×${row.count}` : null,
    formatRelativeTime(row.lastAt),
  ].filter((part): part is string => Boolean(part));

  return (
    <div
      className="flex items-start gap-1"
      data-testid={`notification-row-${row.id}`}
      data-read={String(isRead)}
    >
      <CollapsibleSection
        className="min-w-0 flex-1"
        icon={<Icon className="h-4 w-4" aria-hidden />}
        open={open}
        onOpenChange={onOpenChange}
        title={
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              {!isRead && (
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full bg-accent"
                />
              )}
              <span
                className={cn(
                  "truncate",
                  isRead
                    ? "font-normal text-[var(--app-hint)]"
                    : "font-semibold text-[var(--app-fg)]"
                )}
              >
                {!isRead && <span className="sr-only">Unread: </span>}
                {row.title}
              </span>
            </span>
            {meta.length > 0 && (
              <span className="truncate text-[length:var(--text-body-dense)] font-normal text-[var(--app-hint)]">
                {meta.join(" · ")}
              </span>
            )}
          </span>
        }
      >
        <NotificationDetail row={row} />
      </CollapsibleSection>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="mt-2 shrink-0"
        aria-label="Dismiss notification"
        title="Dismiss"
        onClick={() => onDismiss(row)}
      >
        <X className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}
