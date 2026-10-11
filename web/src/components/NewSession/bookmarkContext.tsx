// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext } from "react";
import { BookmarkIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";

/**
 * Create-Session per-field saved defaults — the "bookmark" surface.
 *
 * Every field heading on the Create page renders a bookmark icon immediately
 * right of its info-hint icon. The icon is a pure INDICATOR: filled muted
 * yellow ⟺ "this field is currently SHOWING its bookmarked value". Field
 * values never change at click time — clicks only change what's STORED, and
 * the store determines what loads on the next visit:
 *
 * - Click an UNFILLED icon → the field's current value becomes the bookmark
 *   (overwriting any previous one); icon fills.
 * - Click a FILLED icon → the bookmark is deleted; the field keeps its value
 *   for this visit; the next visit shows the SYSTEM default, icon unfilled.
 * - Editing a bookmarked field unfills the icon (field ≠ bookmark) but leaves
 *   the store untouched — the next visit still restores the bookmark. The
 *   top bar's "Restore Defaults" re-applies stored values immediately.
 *
 * Auto-inherited fields (provider ← harness, repo ← detected directory) are
 * OUTSIDE this system while inherited: no bookmark icon renders and a saved
 * default is never applied over them — on-page inheritance takes precedence
 * (see RETIRED_FIELD_IDS + the repo guard in useCreateDefaultsEngine).
 *
 * This file holds only the context + icon button so `FormField` can import it
 * without a cycle (the engine in `useCreateDefaultsEngine.ts` imports
 * `ScheduleSection`, which imports `FormField`). The provider value is built by
 * the engine hook and mounted at the top of the Create form in `index.tsx`.
 */
export type CreateDefaultsApi = {
  /** True when the field is currently SHOWING its bookmarked value (filled). */
  isBookmarked: (id: string) => boolean;
  /** Filled → delete the bookmark; unfilled → store the current value. */
  toggle: (id: string) => void;
  /** Bookmark every field at its current value. */
  makeAll: () => void;
  /** Delete every bookmark (field values stay exactly as they are). */
  clearAll: () => void;
  /** Re-apply every stored bookmark to its field right now. */
  restoreAll: () => void;
  /** True when at least one bookmark is stored. */
  hasAny: boolean;
};

const CreateDefaultsContext = createContext<CreateDefaultsApi | null>(null);

export const CreateDefaultsProvider = CreateDefaultsContext.Provider;

export function useCreateDefaults(): CreateDefaultsApi | null {
  return useContext(CreateDefaultsContext);
}

/**
 * The per-field bookmark icon button. Renders nothing outside a
 * `CreateDefaultsProvider`, so `FormField` stays safe to reuse anywhere.
 */
export function BookmarkToggle(props: { id: string }) {
  const ctx = useCreateDefaults();
  if (!ctx) return null;
  const active = ctx.isBookmarked(props.id);
  return (
    <Button
      type="button"
      variant="ghostStatic"
      onClick={() => ctx.toggle(props.id)}
      className="h-auto rounded-none p-0.5 hover:text-[var(--app-fg)]"
      aria-pressed={active}
      aria-label={
        active
          ? "Remove this field's bookmarked default"
          : "Bookmark current value as this field's default"
      }
      title={
        active
          ? "Showing the bookmarked value — click to remove the bookmark (next visit uses the system default)"
          : "Bookmark current value as this field's default"
      }
      data-testid={`bookmark-${props.id}`}
    >
      <BookmarkIcon
        filled={active}
        className={`h-3 w-3 ${
          active ? "text-amber-400/80" : "text-[var(--app-hint)]/60"
        }`}
      />
    </Button>
  );
}
