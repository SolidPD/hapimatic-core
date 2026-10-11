// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SortableAccountCard — the `/account-usage` drag wrapper for an account card
 * (issue #2133; always-armed press-and-hold since #3537). Delegates to the generic
 * `SortableListEntry` so account cards get the SAME "raised while dragging" lift as
 * session rows (opaque, `boxShadow: 0 8px 24px rgba(0,0,0,0.35)`, `scale: 1.02`,
 * `zIndex: 20` — #3114 R5), replacing the old dedicated `GripVertical` handle +
 * `opacity: 0.85`.
 *
 * The whole card surface is the drag surface now: the render-prop hands the caller the
 * sortable's `dragHandle` (`{ attributes, listeners }`) and `isDragging`, and the caller
 * distributes them via `splitDragHandle` — the pointer/touch listeners arm a
 * press-and-hold drag on the whole card, while `attributes` + the keyboard `onKeyDown`
 * ride the expand chevron (keyboard reorder), exactly as `SessionItem` does. No grip,
 * no `touch-none`: the guarded sensors (`guardedDragSensors`) veto a press that begins on
 * an interactive child and gate on the ~300ms hold, so a press on the chevron / nickname
 * editor / "Set active" chip / Retry never arms a drag and a normal scroll still scrolls.
 *
 * The sortable `id` is the stable `accountUuid` (passed by the page), independent of the
 * expand/collapse-all remount key — so a manual order survives a toggle-all.
 */
import type { ReactNode } from "react";
import {
  SortableListEntry,
  type SortableDragHandle,
} from "@/components/SessionList/SortableListEntry";

export function SortableAccountCard(props: {
  id: string;
  children: (handle: {
    dragHandle: SortableDragHandle;
    isDragging: boolean;
  }) => ReactNode;
}) {
  return (
    <SortableListEntry id={props.id}>
      {({ attributes, listeners, isDragging }) =>
        props.children({
          dragHandle: { attributes, listeners },
          isDragging,
        })
      }
    </SortableListEntry>
  );
}
