// SPDX-License-Identifier: AGPL-3.0-only
import { memo, useState } from "react";
import type { DirectoryEntry } from "@/types/api";
import { FileIcon } from "@/components/FileIcon";
import { CopyIcon, MoreVerticalIcon } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FolderIcon, PencilIcon, TrashIcon } from "./browseIcons";

/** What a row's controls ask the listing to do with the row's entry. */
export type RowActionKind = "open" | "rename" | "copyPath" | "delete";

export type RowAction = (entry: DirectoryEntry, kind: RowActionKind) => void;

// issue #2518: human-readable byte size + mtime for the Browse view rows.
function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

function formatMtime(epochMs: number | undefined): string {
  if (epochMs === undefined) return "";
  return new Date(epochMs).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const ICON_ACTION =
  "shrink-0 rounded p-1.5 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]";

/**
 * The row's ⋯ menu. A listing can hold 5,000 rows, so the Radix menu is mounted
 * only once its row is first tapped: until then the trigger is a plain button,
 * and the first tap mounts the menu already open. After that the row keeps the
 * menu, so focus returns to its trigger when it closes.
 */
function RowMenu(props: { entry: DirectoryEntry; onAction: RowAction }) {
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(false);
  const name = props.entry.name;
  const label = `More actions for ${name}`;
  const trigger = (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={
        armed
          ? undefined
          : () => {
              setArmed(true);
              setOpen(true);
            }
      }
      className={ICON_ACTION}
    >
      <MoreVerticalIcon className="h-4 w-4" />
    </button>
  );
  if (!armed) return trigger;

  const select = (kind: RowActionKind) => () =>
    props.onAction(props.entry, kind);
  // Not modal: Rename and Delete open a dialog as the menu closes, and a modal
  // menu closing under an opening dialog can leave the page unclickable.
  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[10rem]">
        <DropdownMenuItem onSelect={select("open")}>Open</DropdownMenuItem>
        <DropdownMenuItem onSelect={select("rename")}>
          <PencilIcon />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={select("copyPath")}>
          <CopyIcon />
          Copy path
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={select("delete")}
          className="text-red-500 focus:text-red-500"
        >
          <TrashIcon />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * issue #2518 / #2715: a single Browse row: a folder (navigates in) or a file
 * (opens the viewer) with its size and date. The row is a <div>, not a
 * <button>, so the action buttons are not nested inside the open button.
 *
 * #6224: every control reports through the one `onAction(entry, kind)`
 * callback, so the row's props stay stable and `memo` holds across search
 * keystrokes. A phone shows the size and date under the name and puts Rename
 * and Delete in the ⋯ menu; a wider screen shows them as columns and keeps the
 * Rename / Delete icons beside the menu.
 */
export const BrowseRow = memo(function BrowseRow(props: {
  entry: DirectoryEntry;
  onAction: RowAction;
  showDivider: boolean;
}) {
  const { entry, onAction } = props;
  const isDir = entry.type === "directory";
  const size = isDir ? "" : formatBytes(entry.size);
  const modified = formatMtime(entry.modified);
  const meta = isDir ? "" : [size, modified].filter(Boolean).join(" · ");

  return (
    <div
      role="row"
      className={`flex w-full items-center gap-1 pr-2 hover:bg-[var(--app-subtle-bg)] transition-colors ${props.showDivider ? "border-b border-[var(--app-divider)]" : ""}`}
    >
      <div role="cell" className="flex min-w-0 flex-1">
        <button
          type="button"
          onClick={() => onAction(entry, "open")}
          className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left"
        >
          {isDir ? (
            <FolderIcon className="text-[var(--app-link)]" />
          ) : (
            <FileIcon fileName={entry.name} size={22} />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{entry.name}</div>
            {meta ? (
              <div className="truncate text-xs text-[var(--app-hint)] sm:hidden">
                {meta}
              </div>
            ) : null}
          </div>
        </button>
      </div>
      <div
        role="cell"
        className="hidden w-28 shrink-0 text-right text-xs text-[var(--app-hint)] sm:block"
      >
        {modified}
      </div>
      <div
        role="cell"
        className="hidden w-20 shrink-0 text-right text-xs text-[var(--app-hint)] sm:block"
      >
        {size}
      </div>
      <div role="cell" className="flex shrink-0 items-center">
        {/* issue #2715: each action targets THIS entry, a child of the current
            folder, never the session root. */}
        <button
          type="button"
          onClick={() => onAction(entry, "rename")}
          title={`Rename ${entry.name}`}
          aria-label={`Rename ${entry.name}`}
          className={`${ICON_ACTION} hidden sm:inline-flex`}
        >
          <PencilIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onAction(entry, "delete")}
          title={`Delete ${entry.name}`}
          aria-label={`Delete ${entry.name}`}
          className="hidden shrink-0 rounded p-1.5 text-[var(--app-hint)] transition-colors hover:bg-red-500/10 hover:text-red-500 sm:inline-flex"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
        <RowMenu entry={entry} onAction={onAction} />
      </div>
    </div>
  );
});
