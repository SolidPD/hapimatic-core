// SPDX-License-Identifier: AGPL-3.0-only
// Pure toast policy for Lane 2 notifications (issue #4915, epic #4912 Sub C).
//
// `NotificationListener` is a thin bridge: every decision about whether a
// `notification` SyncEvent pops up, and what the pop-up says, lives here so it
// can be tested without React. Two pieces:
//
// - `formatNotificationToast(row)` shows the row's `title` verbatim — Sub B
//   (#4914) writes the exact pop-up text each retired `*ToastListener` used —
//   and only chooses the toast type, duration and "Log in" action from the
//   kind, severity and `context` (a recovered api-error renders as success),
//   plus the session-title first line from `sessionTitle` (#4921).
//   A coalesced row (Sub B re-emits the first-wins row with the new count and
//   the max severity) appends " (×N)".
// - `createToastGate()` decides whether a row may toast: a new occurrence only
//   (the server re-emits the row on read and dismiss), "Show pop-ups" and the
//   kind's toggle on, outside the 2.5 s post-reconnect window (#1612) unless
//   the row is `error` severity, past the #1233 per-session retrying throttle,
//   not a spawn failure the open SpawningSessionView already shows, not a
//   hub-proxied spawn failure this tab's remote stub already announces through
//   `RemoteSpawnFailedToastListener` (#5696), and within the per-minute budget
//   unless the row is `error` severity.
//
// Flood control lives in exactly two places (epic design table): server-side
// coalescing turns a burst into one row with a rising `count`, and the budget
// here caps pop-ups. `Toast.tsx` keeps its own MAX_VISIBLE cap and 2 s dedup.
import type { NotificationSeverity } from "@hapi/protocol";
import { buildReloginToast } from "@/lib/reloginLink";
import { preferenceKeyForKind } from "@/lib/notificationKindPrefs";
import { isSpawnPlaceholderMounted } from "@/lib/mountedSpawnPlaceholders";
import { remoteSpawnStubAnnouncesFailure } from "@/lib/pending-spawns";

/** Pop-ups allowed per rolling minute for `info` / `warn` rows. */
export const TOAST_BUDGET_PER_MINUTE = 5;
/** Post-reconnect window in which no Lane 2 toast is shown (#1612). */
export const RECONNECT_SUPPRESS_MS = 2500;
/** The #1233 R7 throttle: one `api-error` retrying toast per session per minute. */
export const RETRYING_THROTTLE_MS = 60_000;
/** How many row ids the gate remembers to tell a new occurrence from an echo. */
export const LAST_SEEN_LIMIT = 500;

const BUDGET_WINDOW_MS = 60_000;

/**
 * The fields of a stored notification the toast policy reads. A structural
 * subset of `StoredNotification`, with `kind` and `severity` widened to
 * `string` because a newer server may send values this build does not know.
 */
export type NotificationToastRow = {
  id: string;
  kind: string;
  severity: NotificationSeverity | string;
  title: string;
  body?: string | null;
  sessionId?: string | null;
  /** The session's title when the row was created (#4921: the toast title). */
  sessionTitle?: string | null;
  context?: string | null;
  /**
   * Set by a federation hub on rows it fetched from a peer (the list API).
   * Live `notification` events are never stamped (the hub's event bridge
   * stamps only the legacy `account-unrefreshable` SyncEvent), so the
   * re-login node comes from `context.nodeId`.
   */
  nodeId?: string;
  count?: number;
  lastAt: number;
  readAt?: number | null;
  dismissedAt?: number | null;
};

export type NotificationToastType = "success" | "error" | "warning" | "info";

export type NotificationToast = {
  message: string;
  /** The session the row is about (#4921 R2); absent for session-less rows. */
  title?: string;
  type: NotificationToastType;
  duration: number;
  action?: { label: string; onClick: () => void };
};

type Context = Record<string, unknown>;

function parseContext(raw: string | null | undefined): Context {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Context)
      : {};
  } catch {
    return {};
  }
}

function str(ctx: Context, key: string): string | undefined {
  const v = ctx[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function severityType(severity: string): NotificationToastType {
  if (severity === "error") return "error";
  if (severity === "warn") return "warning";
  return "info";
}

/**
 * The toast for a notification row. The message is the row's `title` (the
 * producer's exact pop-up text); the kind, phase and severity pick the type and
 * how long it stays up.
 */
export function formatNotificationToast(
  row: NotificationToastRow
): NotificationToast {
  const ctx = parseContext(row.context);
  const phase = row.kind === "api-error" ? str(ctx, "phase") : undefined;

  let type = severityType(row.severity);
  // #1233: a recovery is good news, whatever severity the row carries.
  if (phase === "recovered") type = "success";
  // AC4: a retry in progress is informational, whatever severity it carries.
  if (phase === "retrying") type = "info";

  let duration = type === "error" ? 8000 : 5000;
  if (phase === "exhausted" || phase === "give-up") duration = 10000;
  if (row.kind === "waiting-for-slot") duration = 6000;

  let action: NotificationToast["action"];
  if (row.kind === "account-unrefreshable") {
    // #4461 R8: the "Log in" action opens the re-login flow for the node whose
    // store refused. A peer-bridged row carries the node Sub B stamped.
    const nodeId = str(ctx, "nodeId") ?? row.nodeId;
    if (nodeId) {
      action = buildReloginToast({
        nodeId,
        nodeLabel: str(ctx, "nodeLabel") ?? nodeId,
      }).action;
    }
  } else if (
    row.kind === "spawn-failed" &&
    str(ctx, "code") === "account_unrefreshable"
  ) {
    // #5696: a hub-proxied spawn the node refused for its account. A tab that
    // did not start the spawn gets the same "Log in" the originating tab's
    // RemoteSpawnFailedToastListener offers (#2150). A local row has no nodeId.
    const nodeId = str(ctx, "nodeId");
    if (nodeId) {
      action = buildReloginToast({
        nodeId,
        nodeLabel: str(ctx, "nodeLabel") ?? nodeId,
      }).action;
    }
  }

  const count = row.count ?? 1;
  const message = count > 1 ? `${row.title} (×${count})` : row.title;
  // #4921 R2: a session row's toast is titled by its session.
  const title =
    row.sessionId && row.sessionTitle ? row.sessionTitle : undefined;
  return {
    message,
    type,
    duration,
    ...(title ? { title } : {}),
    ...(action ? { action } : {}),
  };
}

/** The preferences the gate reads: `showPopups` plus one boolean per kind key. */
export type ToastGatePreferences = {
  showPopups?: boolean;
  [key: string]: unknown;
};

export type ToastDecision = "show" | "budget" | "suppressed" | "off" | "stale";

export type ToastGate = {
  /** Opens the post-reconnect suppression window. */
  onReconnect(): void;
  /** Decides whether `row` may toast. Records the row as seen. */
  decide(row: NotificationToastRow, prefs: ToastGatePreferences): ToastDecision;
  /** Records that a toast for `row` was shown (charges the budget). */
  noteShown(row: NotificationToastRow): void;
};

export function createToastGate(
  options: {
    now?: () => number;
    budget?: number;
    windowMs?: number;
    suppressMs?: number;
    retryThrottleMs?: number;
    lastSeenLimit?: number;
    isPlaceholderMounted?: (placeholderId: string) => boolean;
    stubAnnouncesRemoteFailure?: (spawnCorrelationId: string) => boolean;
  } = {}
): ToastGate {
  const now = options.now ?? Date.now;
  const budget = options.budget ?? TOAST_BUDGET_PER_MINUTE;
  const windowMs = options.windowMs ?? BUDGET_WINDOW_MS;
  const suppressMs = options.suppressMs ?? RECONNECT_SUPPRESS_MS;
  const retryThrottleMs = options.retryThrottleMs ?? RETRYING_THROTTLE_MS;
  const lastSeenLimit = options.lastSeenLimit ?? LAST_SEEN_LIMIT;
  const isPlaceholderMounted =
    options.isPlaceholderMounted ?? isSpawnPlaceholderMounted;
  const stubAnnouncesRemoteFailure =
    options.stubAnnouncesRemoteFailure ?? remoteSpawnStubAnnouncesFailure;

  const lastSeen = new Map<string, number>();
  const lastRetryingBySession = new Map<string, number>();
  let shown: number[] = [];
  let suppressUntil = 0;

  function remember(id: string, lastAt: number): void {
    lastSeen.delete(id); // re-insert so the map stays in recency order
    lastSeen.set(id, lastAt);
    if (lastSeen.size > lastSeenLimit) {
      const oldest = lastSeen.keys().next().value;
      if (oldest !== undefined) lastSeen.delete(oldest);
    }
  }

  function retryPhase(row: NotificationToastRow): string | undefined {
    if (row.kind !== "api-error") return undefined;
    return str(parseContext(row.context), "phase");
  }

  return {
    onReconnect() {
      suppressUntil = now() + suppressMs;
    },

    decide(row, prefs) {
      // A read or dismiss echo, or a row this listener already saw at this
      // lastAt: never a new occurrence.
      if (row.readAt != null || row.dismissedAt != null) {
        remember(row.id, Math.max(row.lastAt, lastSeen.get(row.id) ?? 0));
        return "stale";
      }
      const seen = lastSeen.get(row.id);
      if (seen !== undefined && seen >= row.lastAt) return "stale";
      remember(row.id, row.lastAt);

      const t = now();
      const sessionKey = row.sessionId ?? "";
      const phase = retryPhase(row);
      // #1233 R7: any non-retrying api-error phase resets the session throttle.
      if (phase !== undefined && phase !== "retrying") {
        lastRetryingBySession.delete(sessionKey);
      }

      if (prefs.showPopups === false) return "off";
      const key = preferenceKeyForKind(row.kind);
      if (key !== null && prefs[key] === false) return "off";

      // An `error` row bypasses the window: account-unrefreshable and
      // session-restart-failed are never re-sent, so suppressing one would
      // hide it for good.
      if (t < suppressUntil && row.severity !== "error") return "suppressed";

      if (row.kind === "spawn-failed") {
        const ctx = parseContext(row.context);
        // The open SpawningSessionView already shows this spawn's failure.
        const placeholderId = str(ctx, "placeholderId");
        if (placeholderId && isPlaceholderMounted(placeholderId)) {
          return "suppressed";
        }
        // #5696: this tab holds the hub-proxied spawn's stub, which normally
        // announces the node's failure through RemoteSpawnFailedToastListener
        // (see remoteSpawnStubAnnouncesFailure for the exception). A timed-out
        // stub announces nothing more, so the row still toasts.
        const correlationId = str(ctx, "spawnCorrelationId");
        if (correlationId && stubAnnouncesRemoteFailure(correlationId)) {
          return "suppressed";
        }
      }

      if (phase === "retrying") {
        const last = lastRetryingBySession.get(sessionKey);
        if (last !== undefined && t - last < retryThrottleMs) {
          return "suppressed";
        }
      }

      if (row.severity !== "error") {
        shown = shown.filter(at => t - at < windowMs);
        if (shown.length >= budget) return "budget";
      }
      return "show";
    },

    noteShown(row) {
      const t = now();
      if (retryPhase(row) === "retrying") {
        lastRetryingBySession.set(row.sessionId ?? "", t);
      }
      if (row.severity !== "error") shown.push(t);
    },
  };
}
