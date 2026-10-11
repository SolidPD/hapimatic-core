// SPDX-License-Identifier: AGPL-3.0-only
// guardedDragSensors — the always-armed drag sensors shared by the session list
// (#3114) and the Account Usage page (#3537). Extracted verbatim from
// SessionListContainer so both surfaces arm a press-and-hold drag with the SAME
// activation constant and the SAME interactive-target veto — a behaviour-preserving
// move, not a change to the shipped #3114 physics.
//
// The whole row / card is the drag surface (no reorder mode). A drag only STARTS
// after the press-and-hold threshold elapses on a NON-interactive area: the guarded
// sensors veto drag activation when the press begins on an interactive child. Because
// the drag listeners live on the whole row/card, dnd-kit's sensors would otherwise
// fire on a press that begins on a button/link/input; `isInteractiveTarget` (the SAME
// selector the row/card tap guards use — SortableListEntry) is the shared exclusion,
// belt-and-suspenders with the children's own stopPropagation.
import {
  PointerSensor,
  TouchSensor,
  type PointerSensorOptions,
  type TouchSensorOptions,
} from "@dnd-kit/core";
import type {
  PointerEvent as ReactPointerEvent,
  TouchEvent as ReactTouchEvent,
} from "react";
import { isInteractiveTarget } from "./SortableListEntry";

// A single shared activation constant so on-device tuning of the press-and-hold
// threshold is a one-line change; delay-based on BOTH sensors so desktop
// click-and-hold and mobile tap-and-hold behave identically (~300ms).
export const DRAG_ACTIVATION = { delay: 300, tolerance: 8 } as const;

/** PointerSensor that refuses to arm a drag when the press begins on an interactive child. */
export class GuardedPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: (
        { nativeEvent: event }: ReactPointerEvent,
        { onActivation }: PointerSensorOptions
      ): boolean => {
        if (!event.isPrimary || event.button !== 0) return false;
        if (isInteractiveTarget(event.target)) return false;
        onActivation?.({ event });
        return true;
      },
    },
  ];
}

/** TouchSensor that refuses to arm a drag when the touch begins on an interactive child. */
export class GuardedTouchSensor extends TouchSensor {
  static activators = [
    {
      eventName: "onTouchStart" as const,
      handler: (
        { nativeEvent: event }: ReactTouchEvent,
        { onActivation }: TouchSensorOptions
      ): boolean => {
        if (event.touches.length > 1) return false;
        const target = event.touches[0]?.target ?? event.target;
        if (isInteractiveTarget(target)) return false;
        onActivation?.({ event });
        return true;
      },
    },
  ];
}
