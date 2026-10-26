// SPDX-License-Identifier: AGPL-3.0-only
// Notification kind → preference key map (issue #4915, epic #4912 Sub C).
//
// One toggle per notification kind (epic decision D3). Today it gates the
// pop-up toast for every kind and the device push for the five push kinds; the
// inbox row is always stored. The five push kinds keep the
// storage keys their push toggles already use, so a user's existing push
// choices carry over; every other kind gets its own key.
//
// Bundled into the service worker (through `pushDisplayGate.ts`), so it must
// stay free of window-dependent value imports — only a type-only import here.
import type { NotificationKind } from "@hapi/protocol";

export const KIND_PREFERENCE_KEY = {
  permission: "permissions",
  question: "questions",
  ready: "ready",
  stall: "stalls",
  usage: "usage",
  "tool-error": "toolErrors",
  "prompt-blocked": "promptBlocked",
  "api-error": "apiErrors",
  "account-unrefreshable": "accountUnrefreshable",
  "session-restart-failed": "sessionRestartFailed",
  "spawn-failed": "spawnFailed",
  "waiting-for-slot": "waitingForSlot",
  "loops-resuming": "loopsResuming",
  "model-reverted": "modelReverted",
} as const satisfies Record<NotificationKind, string>;

export type KindPreferenceKey =
  (typeof KIND_PREFERENCE_KEY)[keyof typeof KIND_PREFERENCE_KEY];

/** The keys added by #4915 (the non-push kinds), in Settings display order. */
export const NEW_KIND_PREFERENCE_KEYS = [
  "toolErrors",
  "promptBlocked",
  "apiErrors",
  "accountUnrefreshable",
  "sessionRestartFailed",
  "spawnFailed",
  "waitingForSlot",
  "loopsResuming",
  "modelReverted",
] as const;

export type NewKindPreferenceKey = (typeof NEW_KIND_PREFERENCE_KEYS)[number];

/**
 * The preference key for a notification kind, or null for a kind this build
 * does not know (the server does not validate a stored kind on read, so a
 * newer server can send one). Callers treat null as "on".
 */
export function preferenceKeyForKind(kind: string): KindPreferenceKey | null {
  return Object.prototype.hasOwnProperty.call(KIND_PREFERENCE_KEY, kind)
    ? KIND_PREFERENCE_KEY[kind as NotificationKind]
    : null;
}
