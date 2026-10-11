// SPDX-License-Identifier: AGPL-3.0-only
import { BookmarkIcon, RotateCcwIcon } from "@/components/icons";
import { useCreateDefaults } from "./bookmarkContext";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";

/**
 * The saved-defaults bulk actions — Restore Defaults / Make all defaults /
 * Clear all defaults. Rendered at the very top of the Create form (first child
 * of the section stack, above Host Server) so the whole-form actions read as
 * page-level controls rather than footer chrome. Renders nothing outside a
 * `CreateDefaultsProvider`.
 */
export function DefaultsActionsBar() {
  const defaults = useCreateDefaults();
  if (!defaults) return null;

  return (
    <div className="flex shrink-0 items-center justify-end gap-0.5 px-2 py-1">
      <BareButton
        type="button"
        onClick={defaults.restoreAll}
        disabled={!defaults.hasAny}
        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs font-medium text-[var(--app-hint)] hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)] disabled:opacity-40"
        title="Re-apply your bookmarked values to the form"
      >
        <RotateCcwIcon className="h-3 w-3" />
        Restore Defaults
      </BareButton>
      <Button
        type="button"
        variant="ghost"
        onClick={defaults.makeAll}
        className="flex h-auto shrink-0 items-center justify-start gap-1 rounded px-1.5 py-1 text-xs font-medium text-[var(--app-hint)] hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)]"
        title="Bookmark every field at its current value"
      >
        <BookmarkIcon filled className="h-3 w-3 text-amber-400/80" />
        Make all defaults
      </Button>
      <BareButton
        type="button"
        onClick={defaults.clearAll}
        disabled={!defaults.hasAny}
        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs font-medium text-[var(--app-hint)] hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)] disabled:opacity-40"
        title="Remove every bookmark (field values stay as they are)"
      >
        <BookmarkIcon className="h-3 w-3" />
        Clear all defaults
      </BareButton>
    </div>
  );
}
