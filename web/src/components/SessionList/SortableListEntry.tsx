// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SortableListEntry — a drag wrapper for a session-list row or project header (issue #466,
 * always-armed since #3114). The drag apparatus is now mounted unconditionally (no reorder
 * mode); a drag only STARTS after the press-and-hold threshold elapses on a non-interactive
 * area (the guarded sensors in SessionListContainer enforce that).
 *
 * The wrapper EXPOSES the sortable's drag props via a render-prop so the consumer can
 * distribute them across its own elements (#3114): `listeners.onPointerDown` /
 * `listeners.onTouchStart` go on the WHOLE row/header (press-and-hold arms the drag), while
 * `attributes` + `listeners.onKeyDown` stay on the chevron button (keyboard reorder is
 * preserved on the handle, avoiding an Enter/Space collision with row navigation). A combined
 * `dragHandleProps` object is also provided for simple single-element consumers.
 *
 * The sortable `id` is namespaced by the caller (`proj:<groupKey>` for a project header,
 * `sess:<rootSessionId>` for a session cluster) so the two contexts never collide inside the
 * single DndContext, and `onDragEnd` can route by prefix.
 */
import type {
  ReactNode,
  PointerEventHandler,
  TouchEventHandler,
  KeyboardEventHandler,
} from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

/**
 * The split drag-handle a consumer distributes across its elements (#3114): the
 * pointer/touch listeners arm the drag on the whole row/header, while `attributes`
 * + the keyboard `onKeyDown` (both inside `listeners`) stay on the chevron handle.
 */
export type SortableDragHandle = {
  attributes: Record<string, unknown>;
  listeners: Record<string, unknown>;
};

/**
 * Interactive children that must NEVER arm a drag even though the whole row/header
 * is the drag surface (#3114 R4). This selector is the SINGLE source of truth shared
 * by BOTH the guarded sensors (which veto activation) AND the row/header tap-navigation
 * guards (which skip navigation) — keeping them in one place makes it impossible for
 * the drag-arm exclusion and the nav guard to diverge.
 */
export const INTERACTIVE_SELECTOR = "button, input, a, .icon-row";

/** True when the pointer/click target is (inside) an interactive child. */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest(INTERACTIVE_SELECTOR) != null
  );
}

/** The row/header pointer+touch listeners that arm a press-and-hold drag (#3114). */
export type DragRowListeners = {
  onPointerDown?: PointerEventHandler;
  onTouchStart?: TouchEventHandler;
};

/**
 * Split a {@link SortableDragHandle} into the pieces a consumer distributes (#3114):
 * `attributes` + the keyboard `keyDown` go on the chevron handle (keyboard reorder);
 * `rowListeners` (pointer + touch) arm the drag on the whole row/header. Returns inert
 * defaults when `handle` is absent (e.g. a scheduler-spawned row that isn't reorderable).
 */
export function splitDragHandle(handle?: SortableDragHandle): {
  attributes: Record<string, unknown>;
  rowListeners: DragRowListeners;
  keyDown?: KeyboardEventHandler;
} {
  const attributes = handle?.attributes ?? {};
  const {
    onKeyDown: keyDown,
    ...rowListeners
  }: DragRowListeners & { onKeyDown?: KeyboardEventHandler } =
    handle?.listeners ?? {};
  return { attributes, rowListeners, keyDown };
}

export function SortableListEntry(props: {
  id: string;
  children: (handle: {
    /** a11y drag props (role, tabIndex, aria-*) — attach to the keyboard handle (chevron). */
    attributes: Record<string, unknown>;
    /** Sensor activator listeners: `onPointerDown`/`onTouchStart` (arm on the row/header) +
     *  `onKeyDown` (keyboard reorder, attach to the chevron). */
    listeners: Record<string, unknown>;
    /** Combined `{ ...attributes, ...listeners }` — for a simple single-element handle. */
    dragHandleProps: Record<string, unknown>;
    isDragging: boolean;
  }) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.id });

  // #3114 (R5): a dragged entry reads as "raised above the list" — an opaque row with a
  // drop-shadow and a small scale lift, above its siblings. (Was opacity:0.85; zIndex:10.)
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
    opacity: isDragging ? 1 : undefined,
    boxShadow: isDragging ? "0 8px 24px rgba(0, 0, 0, 0.35)" : undefined,
    scale: isDragging ? "1.02" : undefined,
    position: isDragging ? "relative" : undefined,
  };

  const safeListeners = listeners ?? {};
  // `attributes` is dnd-kit's DraggableAttributes (a fixed-shape interface without a
  // string index signature); widen it to a spreadable record for the split handle.
  const attributesRecord = attributes as unknown as Record<string, unknown>;
  return (
    <div ref={setNodeRef} style={style}>
      {props.children({
        attributes: attributesRecord,
        listeners: safeListeners,
        dragHandleProps: { ...attributesRecord, ...safeListeners },
        isDragging,
      })}
    </div>
  );
}
