// SPDX-License-Identifier: AGPL-3.0-only
// How each notification kind looks in the inbox (issue #4916, epic #4912 Sub D):
// one icon and one singular label per kind. The labels name a single row, so
// they differ from the plural toggle labels in `NotificationSettings.tsx`.
import {
  Ban,
  Bell,
  CircleCheck,
  CircleX,
  Clock,
  Gauge,
  Hourglass,
  MessageCircleQuestion,
  Repeat,
  RotateCcw,
  ServerCrash,
  ShieldQuestion,
  Undo2,
  UserX,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { NotificationKind } from "@hapi/protocol";

export type NotificationKindDisplay = { icon: LucideIcon; label: string };

export const NOTIFICATION_KIND_DISPLAY = {
  permission: { icon: ShieldQuestion, label: "Permission request" },
  question: { icon: MessageCircleQuestion, label: "Question" },
  ready: { icon: CircleCheck, label: "Ready for input" },
  stall: { icon: Hourglass, label: "Stall" },
  usage: { icon: Gauge, label: "Usage alert" },
  "tool-error": { icon: Wrench, label: "Tool error" },
  "prompt-blocked": { icon: Ban, label: "Blocked prompt" },
  "api-error": { icon: ServerCrash, label: "API error" },
  "account-unrefreshable": { icon: UserX, label: "Account needs re-login" },
  "session-restart-failed": {
    icon: RotateCcw,
    label: "Session restart failed",
  },
  "spawn-failed": { icon: CircleX, label: "Session creation failed" },
  "waiting-for-slot": { icon: Clock, label: "Waiting for a session slot" },
  "loops-resuming": { icon: Repeat, label: "Scheduled jobs resuming" },
  "model-reverted": { icon: Undo2, label: "Model reverted" },
} as const satisfies Record<NotificationKind, NotificationKindDisplay>;

/**
 * The icon and label for a kind. A kind this build does not know (the server
 * does not validate a stored kind on read, so a newer server can send one)
 * gets the bell and its raw name.
 */
export function notificationKindDisplay(kind: string): NotificationKindDisplay {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_KIND_DISPLAY, kind)
    ? NOTIFICATION_KIND_DISPLAY[kind as NotificationKind]
    : { icon: Bell, label: kind };
}
