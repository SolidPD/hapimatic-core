// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { SearchIcon, CloseIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { menuTriggerClass } from "@/components/ui/menuPrimitives";
import { cn } from "@/lib/utils";

/**
 * Shared search-input chrome (issue #2599, directive D1) — extracted
 * byte-identically from `SearchFilterBar` so the session toolbar and the new
 * `SystemJobsToolbar` render the exact same input (no visual delta, no
 * duplicated markup).
 *
 * Owns its own focus state so it can drop the magnifier while focused (the text
 * reclaims that space) and blur/clear via the internal `inputRef`. It emits the
 * focus signal via `onFocusChange` so the parent toolbar can collapse its
 * Filter/Sort cluster on mobile while the field is focused — the one
 * cross-cutting signal the inline block used to share with its siblings.
 *
 * ── Contract (docs/design/design-system/primitives.md) ──────────────────────
 * - **Anatomy**: rounded surface wrapping a magnifier (dropped while focused), a
 *   text `<input>`, and a clear `<button>` (shown only when non-empty). In
 *   `collapsible` mode (#3537) a sibling magnifier icon-button stands in for the
 *   whole field below `sm` while unfocused.
 * - **Props / API**: `searchText`, `onSearchTextChange`, `onFocusChange?`,
 *   `placeholder?` (default `"Search"`), `collapsible?` (default `false`, #3537).
 * - **Variants / sizes**: none.
 * - **States**: focused (magnifier hidden), non-empty (clear button visible),
 *   collapsed (`collapsible` + `< sm` + unfocused → the field is hidden and the
 *   sibling magnifier button shows in its place, tinted when a term is set).
 * - **A11y**: the input carries `aria-label={placeholder}` (#3031 Task 5 — a
 *   placeholder alone is not an accessible name); `Escape` clears, `Enter`
 *   commits + blurs; the clear button has `aria-label="Clear search"`; the
 *   collapsed magnifier has `aria-label="Search sessions"` and focuses the input.
 * - **Tokens**: `--app-secondary-bg`, `--app-fg`, `--app-hint`; the collapsed
 *   magnifier tint via `menuTriggerClass` (`--app-accent`, `--app-hint`).
 *
 * NOTE: `SearchInput` is a SPECIALIZED search composite (icon + clear), distinct
 * from the base `Input` primitive — see the `Input` entry in `primitives.md`.
 */
export function SearchInput({
  searchText,
  onSearchTextChange,
  onFocusChange,
  placeholder = "Search",
  collapsible = false,
}: {
  searchText: string;
  onSearchTextChange: (text: string) => void;
  onFocusChange?: (focused: boolean) => void;
  placeholder?: string;
  /**
   * #3537 opt-in: below `sm`, collapse the field to a tappable magnifier icon when
   * not focused (tapping expands + focuses the field; Enter/blur collapses it back).
   * Desktop/tablet (`≥ sm`) always show the full field. Default `false` → the
   * `SystemJobsToolbar` (#2599) renders the field unchanged (R4). The collapse is
   * CSS-only (`sm:` breakpoint utilities) — no `matchMedia`, no viewport-width state.
   */
  collapsible?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  const setFocus = (next: boolean) => {
    setFocused(next);
    onFocusChange?.(next);
  };

  const clearSearch = () => {
    onSearchTextChange("");
    inputRef.current?.focus();
  };

  return (
    <>
      {/* #3537: the collapsed-search magnifier — below `sm`, when not focused, it
          stands in for the full field and expands+focuses it on tap. A SIBLING of the
          field root `<div>` (never a child) so SearchFilterBar's "no svg inside the
          field once focused" test holds, and tinted (engaged when a term is set) like
          the Filter/Sort triggers so an active search stays visible while collapsed. A
          `<Button>` (not a raw `<button>`) keeps the design-token gate satisfied —
          SearchInput is baselined at exactly one raw button (the ✕ below). Only
          rendered in `collapsible` mode. */}
      {collapsible && (
        <Button
          type="button"
          variant="ghostStatic"
          size="bare"
          onClick={() => {
            // The field is `hidden` (display:none) below `sm` while collapsed, so
            // focusing its input directly is a no-op — a display:none element cannot
            // receive focus. flushSync commits `focused=true` (which flips the field to
            // `flex` — visible) BEFORE the focus() call runs, so the now-visible input
            // actually receives focus. This is the sanctioned flushSync use: coordinate
            // a state-driven show with an imperative focus.
            flushSync(() => setFocus(true));
            inputRef.current?.focus();
          }}
          aria-label="Search sessions"
          title="Search sessions"
          // `menuTriggerClass` is applied BEFORE the visibility class so the visibility
          // class wins the twMerge display conflict: `menuTriggerClass` begins with `flex`,
          // and if it came last it would override the `hidden` (focused) / `sm:hidden`
          // (≥ sm) states — leaving the magnifier visible next to the expanded field.
          className={cn(
            "shrink-0",
            menuTriggerClass(searchText.length > 0),
            focused ? "hidden" : "flex sm:hidden"
          )}
        >
          <SearchIcon className="h-3.5 w-3.5" />
        </Button>
      )}
      <div
        className={`flex-1 min-w-0 ${
          collapsible ? (focused ? "flex" : "hidden sm:flex") : "flex"
        } items-center gap-1.5 rounded-md bg-[var(--app-secondary-bg)] px-2 py-1`}
      >
        {!focused && (
          <SearchIcon className="h-3.5 w-3.5 text-[var(--app-hint)] shrink-0" />
        )}
        <input
          autoCapitalize="none"
          ref={inputRef}
          type="text"
          // #3031 Task 5 — accessible name (a `placeholder` alone is NOT an
          // accessible name per WCAG; screen readers had no label for this field).
          aria-label={placeholder}
          value={searchText}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          onChange={e => onSearchTextChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Escape" && searchText.length > 0) {
              e.preventDefault();
              clearSearch();
            } else if (e.key === "Enter") {
              // Commit the (live) search and contract the field — restores the
              // magnifier and the Filter/Sort cluster on mobile.
              e.preventDefault();
              inputRef.current?.blur();
            }
          }}
          placeholder={placeholder}
          className="flex-1 min-w-0 bg-transparent text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] outline-none"
        />
        {searchText.length > 0 && (
          <button
            type="button"
            onClick={clearSearch}
            className="shrink-0 text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors"
            title="Clear search"
            aria-label="Clear search"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </>
  );
}
