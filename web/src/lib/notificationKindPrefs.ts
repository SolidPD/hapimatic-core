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
  "sign-in-ending": "signInEnding",
  "tracking-not-applied": "trackingNotApplied",
} as const satisfies Record<NotificationKind, string>;

export type KindPreferenceKey =
  (typeof KIND_PREFERENCE_KEY)[keyof typeof KIND_PREFERENCE_KEY];

/**
 * The keys added after the five push toggles (#4915 onward), in Settings
 * display order, each on by default. Most are toast-only; `signInEnding`
 * (#6161) also gates the push its producer sends.
 */
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
  "signInEnding",
  "trackingNotApplied",
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

/**
 * This node's billable sessions gate as the version route reports it (`on`,
 * `closed`, absent = off) or as `useBillableSwitchMode` reads it.
 */
export type BillableGateState = "on" | "closed" | "off" | undefined;

/** #6778 PR-C (moved item 3): the kinds of billable tracking and their toggles. */
const BILLABLE_TRACKING_KINDS: ReadonlySet<string> = new Set([
  "tracking-not-applied",
]);
const BILLABLE_TRACKING_PREFERENCE_KEYS: ReadonlySet<string> = new Set([
  "trackingNotApplied",
]);

/**
 * Whether a kind's pop-up may show: a billable tracking kind stays out of
 * sight while this node's gate is off (its inbox row is still stored); every
 * other kind, and a kind this build does not know, always may.
 */
export function kindShownWithGate(
  kind: string,
  billableSwitch: BillableGateState
): boolean {
  return (
    !BILLABLE_TRACKING_KINDS.has(kind) ||
    billableSwitch === "on" ||
    billableSwitch === "closed"
  );
}

/** Whether a kind's settings row shows: the same rule, by its preference key. */
export function preferenceKeyShownWithGate(
  key: string,
  billableSwitch: BillableGateState
): boolean {
  return (
    !BILLABLE_TRACKING_PREFERENCE_KEYS.has(key) ||
    billableSwitch === "on" ||
    billableSwitch === "closed"
  );
}
