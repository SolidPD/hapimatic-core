// SPDX-License-Identifier: AGPL-3.0-only
// ExpandCollapseAllMenu — the "Expand All / Collapse All" menu a session-list
// chevron opens on right-click (desktop) or press-and-hold (mouse or touch). A
// plain click or tap still toggles the one row, exactly as before.
//
// It takes the chevron <button> as a render prop and anchors a small menu to it:
//   - a project header's chevron → every project in the list
//   - a session row's chevron    → every session under that project
// What "All" covers is the caller's business (an `ExpandCollapseAllScope`,
// built in SessionListContainer). This file owns only the gesture and the menu.
//
// Composed from existing parts: the `ui/popover` primitive on a custom anchor
// (the TitleBarNodeChip long-press pattern) and `useLongPress` (the
// BookmarkGutter "hold for options" pattern). The Radix DropdownMenu does not
// fit: its Trigger opens on a plain press and on Enter / Space, which are the
// chevron's own toggle and its keyboard-reorder pick-up (#3114).
//
// COST: every row and every project header carries one of these, and almost
// none is ever opened. A closed Radix popover is still about ten mounted
// components with their effects (root, popper, anchor, portal, presence), so a
// chevron carries only the gesture hooks and the popover is mounted the first
// time that chevron's menu opens. Timing a 29-row project expanding (dev build,
// paired rounds) could not tell this apart from a list with no menu at all.
import { useCallback, useRef, useState } from "react";
import type {
  KeyboardEvent,
  MouseEventHandler,
  ReactElement,
  RefObject,
  SyntheticEvent,
  TouchEventHandler,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { useLongPress } from "@/hooks/useLongPress";
import { usePlatform } from "@/hooks/usePlatform";
import type { ExpandCollapseAllScope } from "./bulkExpand";

/** The press-and-hold and right-click listeners for the chevron `<button>`. */
export type ChevronPressProps = {
  onMouseDown?: MouseEventHandler<HTMLButtonElement>;
  onMouseUp?: MouseEventHandler<HTMLButtonElement>;
  onMouseLeave?: MouseEventHandler<HTMLButtonElement>;
  onTouchStart?: TouchEventHandler<HTMLButtonElement>;
  onTouchMove?: TouchEventHandler<HTMLButtonElement>;
  onTouchEnd?: TouchEventHandler<HTMLButtonElement>;
  onTouchCancel?: TouchEventHandler<HTMLButtonElement>;
  onContextMenu?: MouseEventHandler<HTMLButtonElement>;
};

/** What the chevron `<button>` needs from the menu. */
export type ChevronMenuBinding = {
  /** Spread onto the chevron. Empty when the chevron has no menu. */
  pressProps: ChevronPressProps;
  /**
   * Wrap the chevron's own `onClick`. The click that ends a press-and-hold
   * opened the menu, so it must not also toggle the row.
   */
  guardClick: (
    onClick: MouseEventHandler<HTMLButtonElement>
  ) => MouseEventHandler<HTMLButtonElement>;
  /** Append to the chevron's tooltip: names the gesture ("" with no menu). */
  hint: string;
  /** Append to the chevron's className ("" with no menu). */
  className: string;
};

const CHEVRON_HINT = " — right-click or hold for Expand All / Collapse All";

// A long press on iOS otherwise starts text selection (and its callout) on the
// nearest text, which here is the row's title.
const CHEVRON_CLASS = " select-none [-webkit-touch-callout:none]";

const INERT_BINDING: ChevronMenuBinding = {
  pressProps: {},
  guardClick: onClick => onClick,
  hint: "",
  className: "",
};

// The rows match `DropdownMenuItem` (ui/dropdown-menu.tsx) so this menu reads
// as the same surface as the Filter and Sort menus: same box, and the same mint
// highlight under the pointer or the keyboard focus.
const MENU_ITEM_CLASS =
  "h-auto justify-start rounded-sm px-2 py-1.5 font-normal text-popover-foreground hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:ring-0";

// A column flexbox, so the menu is as wide as its widest item. Left as a block,
// the two inline-level buttons are measured side by side for the menu's
// shrink-to-fit width, which makes it nearly twice as wide as it needs to be.
// `min-w-32` is DropdownMenuContent's own 8rem minimum.
const MENU_CLASS =
  "flex w-auto min-w-32 select-none flex-col p-1 [-webkit-touch-callout:none]";

/**
 * The menu is portaled to `<body>`, but React events still bubble to the React
 * parent: the session row or project header that owns the chevron. A click on
 * the menu's padding would open the session and Enter on an item would too (the
 * row navigates on Enter / Space from any descendant), so both stop here.
 * Pointer and touch events are deliberately NOT stopped: Radix's outside-press
 * dismissal needs every `pointerdown` to reach `document`. The row's drag
 * arming ignores the menu through `INTERACTIVE_SELECTOR` instead.
 */
function stopAtMenu(event: SyntheticEvent): void {
  event.stopPropagation();
}

/** Arrow / Home / End move between the items, as a menu is expected to. */
function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
  stopAtMenu(event);
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')
  );
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  switch (event.key) {
    case "ArrowDown":
      next = (current + 1) % items.length;
      break;
    case "ArrowUp":
      next = current <= 0 ? items.length - 1 : current - 1;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = items.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  items[next].focus();
}

/** The popover itself. Mounted only once its chevron's menu has been opened. */
function AnchoredMenu(props: {
  scope: ExpandCollapseAllScope;
  /** The chevron: positions the menu, and takes focus back when it closes. */
  chevronRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactElement {
  const { scope, chevronRef, open, onOpenChange } = props;

  const choose = (action: () => void) => (): void => {
    onOpenChange(false);
    action();
  };

  return (
    // `modal`: a press outside only closes the menu. Without it the same tap
    // would also land on whatever is underneath, such as a session row.
    <Popover open={open} onOpenChange={onOpenChange} modal>
      {/* `virtualRef` positions the menu against the chevron without wrapping
          it, so the chevron's own element and props are left exactly as its
          row rendered them. */}
      <PopoverAnchor virtualRef={chevronRef as RefObject<HTMLButtonElement>} />
      <PopoverContent
        role="menu"
        aria-label={scope.label}
        side="bottom"
        align="end"
        collisionPadding={8}
        className={MENU_CLASS}
        onClick={stopAtMenu}
        onKeyDown={onMenuKeyDown}
        onContextMenu={event => {
          // No browser context menu on top of this one.
          event.preventDefault();
          stopAtMenu(event);
        }}
        onCloseAutoFocus={event => {
          // There is no Radix Trigger to hand focus back to, so return it to
          // the chevron by hand. `preventScroll`: the list may have just
          // changed height under it.
          event.preventDefault();
          chevronRef.current?.focus({ preventScroll: true });
        }}
      >
        <Button
          type="button"
          role="menuitem"
          variant="ghost"
          title={scope.expandAllHint}
          className={MENU_ITEM_CLASS}
          onClick={choose(scope.onExpandAll)}
        >
          Expand All
        </Button>
        <Button
          type="button"
          role="menuitem"
          variant="ghost"
          title={scope.collapseAllHint}
          className={MENU_ITEM_CLASS}
          onClick={choose(scope.onCollapseAll)}
        >
          Collapse All
        </Button>
      </PopoverContent>
    </Popover>
  );
}

export function ExpandCollapseAllMenu(props: {
  /** What "All" covers and the two actions. Absent: the chevron has no menu. */
  scope?: ExpandCollapseAllScope;
  /** Renders the chevron `<button>`, spreading the binding onto it. */
  children: (chevron: ChevronMenuBinding) => ReactElement;
}): ReactElement {
  const { scope, children } = props;
  const { haptic } = usePlatform();
  const [open, setOpen] = useState(false);
  // False until this chevron's menu is first opened: until then no popover is
  // mounted at all (see COST above). It stays mounted afterwards, so the menu
  // can animate out and reopen.
  const [everOpened, setEverOpened] = useState(false);
  // Mirrors `open` for the gesture callback, which must not buzz twice when a
  // second trigger lands on an open menu: Android fires `contextmenu` during
  // the same hold the timer has already answered.
  const openRef = useRef(false);
  // True from the moment a gesture opens the menu until the click that ends
  // that gesture has been dropped.
  const swallowClick = useRef(false);
  // The chevron, noted from the press that is about to open the menu. Taken
  // from the event rather than a ref prop so a call site cannot forget it.
  const chevronRef = useRef<HTMLButtonElement | null>(null);

  const changeOpen = useCallback((next: boolean): void => {
    openRef.current = next;
    setOpen(next);
    // A hold usually ends without a click on the chevron (a touch, a
    // right-click, or a mouse release the open modal menu intercepts), which
    // leaves the swallow armed. Closing disarms it, so the next real click on
    // the chevron toggles as usual. Arming always opens the menu, so this one
    // place covers every path.
    if (!next) swallowClick.current = false;
  }, []);

  const openMenu = useCallback((): void => {
    if (openRef.current) return;
    swallowClick.current = true;
    setEverOpened(true);
    changeOpen(true);
    haptic.impact("medium");
  }, [changeOpen, haptic]);

  const longPress = useLongPress({ onLongPress: openMenu, disabled: !scope });

  const guardClick = useCallback(
    (
      onClick: MouseEventHandler<HTMLButtonElement>
    ): MouseEventHandler<HTMLButtonElement> =>
      event => {
        if (swallowClick.current) {
          swallowClick.current = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClick(event);
      },
    []
  );

  const binding: ChevronMenuBinding = scope
    ? {
        pressProps: {
          // The three events that can start an open each note the chevron.
          onMouseDown: event => {
            chevronRef.current = event.currentTarget;
            longPress.onMouseDown(event);
          },
          onMouseUp: longPress.onMouseUp,
          onMouseLeave: longPress.onMouseLeave,
          onTouchStart: event => {
            chevronRef.current = event.currentTarget;
            longPress.onTouchStart(event);
          },
          // A finger that moves is scrolling the list, not holding the chevron.
          onTouchMove: longPress.onTouchMove,
          onTouchCancel: longPress.onTouchMove,
          onTouchEnd: longPress.onTouchEnd,
          onContextMenu: event => {
            chevronRef.current = event.currentTarget;
            longPress.onContextMenu(event);
          },
        },
        guardClick,
        hint: CHEVRON_HINT,
        className: CHEVRON_CLASS,
      }
    : INERT_BINDING;

  // Always this same fragment shape, so mounting the popover later never moves
  // the chevron in the tree (a remount mid-press would drop the press).
  return (
    <>
      {children(binding)}
      {scope && everOpened ? (
        <AnchoredMenu
          scope={scope}
          chevronRef={chevronRef}
          open={open}
          onOpenChange={changeOpen}
        />
      ) : null}
    </>
  );
}
