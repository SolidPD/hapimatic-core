// SPDX-License-Identifier: AGPL-3.0-only
/**
 * On-device trace of the feedback form's open path (issue #6190).
 *
 * On an iPhone (iOS 26.6.1 PWA) opening the feedback form stopped the page's
 * JavaScript for good, and the freeze did not reproduce off-device. This module
 * records how far an open got, so a recurrence names the step where the thread
 * stopped: while the form is open it keeps a small trace in localStorage (named
 * phase marks with millisecond offsets, a heartbeat, and visibility changes). A
 * clean close, an unmount, or `pagehide` deletes it: a page that can run those
 * handlers is not frozen. A trace still stored when the app next starts, with a
 * heartbeat older than {@link FEEDBACK_TRACE_LIVE_WINDOW_MS}, belongs to a page
 * that never closed the form, and is reported once to the error log. (A fresher
 * one is another tab's live trace and is left alone.)
 *
 * Privacy: the trace holds only the fixed phase names below, offsets, the app
 * version, the viewport size, and whether the form was opened in a session. No
 * message content, description, route, session id, or token.
 *
 * Every storage access is guarded: a full or disabled store never throws into
 * the form, it just leaves no trace. Framework-agnostic (no React imports).
 */
import { getStorageKey } from "@/lib/storage-keys";
import { errorReporter } from "@/lib/error-reporter";

/** Port-scoped, versioned storage key (`getStorageKey` adds the port). */
const TRACE_KEY = "hapi:feedback-open-trace:v1";

/** How often the heartbeat stamps `lastBeatAt` while the form is open. */
export const FEEDBACK_TRACE_HEARTBEAT_MS = 500;

/** Phase marks kept per trace; later marks are dropped so the size stays bounded. */
export const FEEDBACK_TRACE_MAX_PHASES = 24;

/**
 * A stored trace whose heartbeat is younger than this belongs to a page that is
 * still running (another tab), not to a frozen or dead one: it is neither
 * claimed nor reported nor deleted.
 */
export const FEEDBACK_TRACE_LIVE_WINDOW_MS = 5_000;

/** The error log's `context` limit (`server/src/web/routes/errorReports.ts`). */
export const FEEDBACK_TRACE_CONTEXT_MAX = 2000;

/** Error-log category of an incomplete-open report. */
export const FEEDBACK_TRACE_CATEGORY = "feedback-open-trace";

export type FeedbackTracePhase =
  | "requested"
  | "mounted"
  | "painted"
  | "compose-start"
  | "about-settled"
  | "stats-settled"
  | "session-settled"
  | "about-failed"
  | "stats-failed"
  | "session-failed"
  | "composed"
  | "hidden"
  | "visible"
  | "assist-requested";

export interface FeedbackOpenTrace {
  v: 1;
  /** Epoch ms of the open. */
  startedAt: number;
  /** Epoch ms of the last heartbeat (or mark). */
  lastBeatAt: number;
  /** Phase marks: name and ms offset from `startedAt`. */
  phases: Array<[FeedbackTracePhase, number]>;
  appVersion?: string;
  viewport?: string;
  inSession: boolean;
}

export interface FeedbackOpenTraceInfo {
  appVersion?: string;
  viewport?: string;
  inSession: boolean;
}

/** The report an incomplete trace produces. */
export interface FeedbackTraceReport {
  message: string;
  category: string;
  severity: "warn";
  context: string;
}

// This page's open trace, if the form is open.
let active: FeedbackOpenTrace | null = null;
// A trace left by an earlier page: `undefined` until read once in this page.
let earlier: FeedbackOpenTrace | null | undefined;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let onVisibility: (() => void) | null = null;
let onPageHide: (() => void) | null = null;

function storageKey(): string {
  return getStorageKey(TRACE_KEY);
}

function writeTrace(trace: FeedbackOpenTrace): void {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(trace));
  } catch {
    /* full or disabled storage: no trace, never an error in the form */
  }
}

function removeTrace(): void {
  try {
    localStorage.removeItem(storageKey());
  } catch {
    /* ignore */
  }
}

function readStoredTrace(): FeedbackOpenTrace | null {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as FeedbackOpenTrace).v !== 1 ||
      typeof (parsed as FeedbackOpenTrace).startedAt !== "number" ||
      !Array.isArray((parsed as FeedbackOpenTrace).phases)
    ) {
      return null;
    }
    return parsed as FeedbackOpenTrace;
  } catch {
    return null;
  }
}

/**
 * Read (once per page) a trace an earlier page left behind. It must run before
 * this page writes its own trace, so `startFeedbackOpenTrace` calls it first.
 * A trace with a fresh heartbeat is another tab's live one, not left behind.
 */
function claimEarlierTrace(): void {
  if (earlier !== undefined) return;
  const stored = active ? null : readStoredTrace();
  earlier =
    stored &&
    Date.now() - (stored.lastBeatAt ?? 0) >= FEEDBACK_TRACE_LIVE_WINDOW_MS
      ? stored
      : null;
}

/** True while this page has a feedback-form open trace running. */
export function isFeedbackOpenTraceActive(): boolean {
  return active !== null;
}

/**
 * Start tracing an open: write the trace and start the heartbeat and the
 * visibility marks. A no-op while a trace is already running in this page.
 */
export function startFeedbackOpenTrace(info: FeedbackOpenTraceInfo): void {
  claimEarlierTrace();
  if (active) return;
  const now = Date.now();
  active = { v: 1, startedAt: now, lastBeatAt: now, phases: [], ...info };
  writeTrace(active);
  heartbeat = setInterval(() => {
    if (!active) return;
    active.lastBeatAt = Date.now();
    writeTrace(active);
  }, FEEDBACK_TRACE_HEARTBEAT_MS);
  if (typeof document !== "undefined") {
    onVisibility = () =>
      markFeedbackOpenPhase(
        document.visibilityState === "hidden" ? "hidden" : "visible"
      );
    document.addEventListener("visibilitychange", onVisibility);
  }
  if (typeof window !== "undefined") {
    // A page that can run this handler is not frozen: a reload or navigation
    // with the form open is not a failed open, so it leaves no trace.
    onPageHide = () => endFeedbackOpenTrace();
    window.addEventListener("pagehide", onPageHide);
  }
}

/** Record a phase of the running open. A no-op when no trace is running. */
export function markFeedbackOpenPhase(phase: FeedbackTracePhase): void {
  if (!active) return;
  const now = Date.now();
  if (active.phases.length < FEEDBACK_TRACE_MAX_PHASES) {
    active.phases.push([phase, now - active.startedAt]);
  }
  active.lastBeatAt = now;
  writeTrace(active);
}

/** The form closed: stop tracing and delete the trace. */
export function endFeedbackOpenTrace(): void {
  if (heartbeat !== null) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  if (onVisibility && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibility);
  }
  onVisibility = null;
  if (onPageHide && typeof window !== "undefined") {
    window.removeEventListener("pagehide", onPageHide);
  }
  onPageHide = null;
  if (active) {
    active = null;
    removeTrace();
  }
}

/** The one-line summary of an incomplete trace. */
export function describeIncompleteTrace(trace: FeedbackOpenTrace): string {
  const last = trace.phases[trace.phases.length - 1];
  const lastText = last
    ? `last phase "${last[0]}" at +${last[1]} ms`
    : "no phase after the open";
  const beat = Math.max(0, trace.lastBeatAt - trace.startedAt);
  return `Feedback form never closed: ${lastText}; heartbeat stopped at +${beat} ms`;
}

/**
 * Report a trace an earlier page left behind (the form never closed there),
 * once, then forget it, whether or not the report is sent. The default reporter
 * writes the report straight to the error reporter's persistent outbox
 * (`reportBeforeReload`, drained after the next successful API response), so
 * the evidence survives this page dying too, before the stored trace is
 * deleted. Call it after the error reporter is initialized: a report before
 * that is a no-op.
 */
export function reportIncompleteFeedbackOpenTrace(
  report: (r: FeedbackTraceReport) => void = r =>
    errorReporter.reportBeforeReload(r)
): boolean {
  claimEarlierTrace();
  const trace = earlier;
  earlier = null;
  if (!trace) return false;
  report({
    message: describeIncompleteTrace(trace),
    category: FEEDBACK_TRACE_CATEGORY,
    severity: "warn",
    context: JSON.stringify(trace).slice(0, FEEDBACK_TRACE_CONTEXT_MAX),
  });
  // Delete it unless this page has written its own trace over it since.
  if (!active) removeTrace();
  return true;
}

/** Test-only: forget module state between tests. */
export function resetFeedbackOpenTraceForTests(): void {
  endFeedbackOpenTrace();
  active = null;
  earlier = undefined;
}
