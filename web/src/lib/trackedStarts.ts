// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The read-back after a tracked Create (#6780, Task 7: B11, B13).
 *
 * When the Create page sends a start with tracking settings, it notes here what
 * it sent and what the form showed. Once the new session exists,
 * `TrackedStartListener` takes the entry, reads `GET /api/sessions/:id/tracking`
 * once and compares: equal says nothing (ruling OC-3 = a), a difference raises
 * one warning. The key is the placeholder id for a start on this node (noted on
 * `accepted`, when the id exists) and the `spawnCorrelationId` for one on
 * another node (noted BEFORE the request, because its success event can come
 * before the answer).
 *
 * Bounded: at most {@link TRACKED_STARTS_MAX} entries for at most
 * {@link TRACKED_START_TTL_MS}, expired lazily on each note and take, with no
 * timer. A remote start whose success never reaches the hub within its
 * two-minute placeholder, or that spans a hub restart, is not read back; its
 * entry expires (ruling D-D). Tab memory only: a rate or a note held here
 * never reaches the console, a toast, a log line or storage (C7).
 *
 * Pattern: `pending-spawns.ts` (module store + `useSyncExternalStore`).
 */
import { useSyncExternalStore } from "react";
import type { TrackingSettingsInput } from "@hapi/protocol";
import type { SessionTrackingResponse } from "@/api/client";
import type { ProjectShown } from "@/components/timeTracking/timeTracking";

export const TRACKED_STARTS_MAX = 50;
export const TRACKED_START_TTL_MS = 10 * 60_000;

/** What the form showed beside the settings it sent. */
export type TrackedStartShown = {
  project: Pick<ProjectShown, "kind" | "text">;
  categoryName: string | null;
  defaultRateMinor: number | null;
  defaultCurrency: string | null;
};

export type TrackedStart = {
  kind: "local" | "remote";
  /** The target node's label for a remote start; null on this node. */
  nodeLabel: string | null;
  settings: TrackingSettingsInput;
  shown: TrackedStartShown;
};

type Entry = TrackedStart & { notedAt: number };

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let anyLocal = false;

function refresh(): void {
  let local = false;
  for (const e of entries.values()) {
    if (e.kind === "local") {
      local = true;
      break;
    }
  }
  if (local !== anyLocal) {
    anyLocal = local;
    for (const fn of listeners) fn();
  }
}

function expire(now: number): void {
  for (const [key, e] of entries) {
    if (now - e.notedAt >= TRACKED_START_TTL_MS) entries.delete(key);
  }
}

/** Note a tracked start under its key (re-noting replaces it). */
export function noteTrackedStart(
  key: string,
  start: TrackedStart,
  now: number = Date.now()
): void {
  expire(now);
  entries.delete(key);
  while (entries.size >= TRACKED_STARTS_MAX) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  entries.set(key, { ...start, notedAt: now });
  refresh();
}

/** Forget a start: its request failed, or its spawn failed. */
export function dropTrackedStart(key: string): void {
  if (entries.delete(key)) refresh();
}

/** Take a start out (once): its session exists. */
export function takeTrackedStart(
  key: string,
  now: number = Date.now()
): TrackedStart | undefined {
  expire(now);
  const e = entries.get(key);
  if (e) entries.delete(key);
  refresh();
  if (!e) return undefined;
  const { notedAt: _notedAt, ...start } = e;
  return start;
}

/** The keys of the local starts still waiting for their session. */
export function localTrackedStartKeys(now: number = Date.now()): string[] {
  expire(now);
  refresh();
  const keys: string[] = [];
  for (const [key, e] of entries) if (e.kind === "local") keys.push(key);
  return keys;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** True while a start on this node waits for its session (gates the list read). */
export function useAnyLocalTrackedStart(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => anyLocal,
    () => false
  );
}

// ---------------------------------------------------------------------------
// The comparison

export type TrackingComparison =
  | { kind: "applied" }
  | { kind: "untracked" }
  | { kind: "differs" }
  | { kind: "project"; recorded: string }
  | { kind: "unknown" };

function note(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/**
 * The record against what was sent and shown. `unknown` when the read failed
 * (null), when an older node's summary cannot say (`tracked` null), or when it
 * says tracked with no record. The project is compared whenever the record
 * names a repository the form did not show, and when the form showed a
 * repository but the record names a folder; path against path is not, because
 * a folder can be shown as typed and stored resolved.
 */
export function compareTracking(
  start: TrackedStart,
  response: SessionTrackingResponse | null
): TrackingComparison {
  if (!response || response.tracked === null) return { kind: "unknown" };
  if (response.tracked === false) return { kind: "untracked" };
  const r = response.record;
  if (!r) return { kind: "unknown" };
  const s = start.settings;
  const shown = start.shown;
  const differs =
    r.billingStatus !== s.billingStatus ||
    r.categorySource !== s.category.source ||
    r.categoryId !== s.category.id ||
    r.categoryName !== shown.categoryName ||
    r.defaultRateMinor !== shown.defaultRateMinor ||
    r.defaultCurrency !== shown.defaultCurrency ||
    r.rateMinor !== s.rateMinor ||
    r.currency !== s.currency ||
    note(r.rateNote) !== note(s.rateNote);
  if (differs) return { kind: "differs" };
  if (r.projectKind === "repo") {
    const showedRepo = shown.project.kind === "repo";
    if (
      !showedRepo ||
      r.projectKey.toLowerCase() !== shown.project.text.toLowerCase()
    ) {
      return { kind: "project", recorded: r.projectKey };
    }
  } else if (shown.project.kind === "repo") {
    return { kind: "project", recorded: r.projectKey };
  }
  return { kind: "applied" };
}

/** The one warning for a difference, in the web's own words; null when quiet. */
export function trackedStartWarning(
  start: TrackedStart,
  comparison: TrackingComparison
): string | null {
  const session = start.nodeLabel
    ? `The new session on ${start.nodeLabel}`
    : "The new session";
  switch (comparison.kind) {
    case "untracked":
      return `${session} started untracked: its tracking settings were not applied.`;
    case "differs":
      return start.nodeLabel
        ? `${session} has tracking that is not what the form showed.`
        : "The new session's tracking is not what the form showed.";
    case "project":
      return start.nodeLabel
        ? `${session} has its time attributed to ${comparison.recorded}, not to ${start.shown.project.text}.`
        : `The new session's time is attributed to ${comparison.recorded}, not to ${start.shown.project.text}.`;
    default:
      return null;
  }
}

/** Test-only: forget every start. */
export function __resetTrackedStartsForTests(): void {
  entries.clear();
  listeners.clear();
  anyLocal = false;
}
