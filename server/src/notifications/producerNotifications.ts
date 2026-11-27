// SPDX-License-Identifier: AGPL-3.0-only
import {
  ACCOUNT_UNREFRESHABLE_MESSAGE,
  type NotifyInput,
  type TrackingLostCause,
} from "@hapi/protocol";

// Per-kind notification inputs for the server producers (issue #4914, epic
// #4912 — Lane 2). Every producer of a user-facing event builds its `notify()`
// input here, so a kind's title, severity, dedupe and context live in one place
// and two producers of the same kind cannot drift apart.
//
// Contract with the web listener (Sub C, #4915):
// - `title` is the pop-up text, taken from the toast the legacy listener shows
//   today, so the inbox and the pop-up read the same. Three titles are not
//   clipped the way that toast clips them: `tool-error` (the toast cuts the
//   error at 120 characters) and the CLI `prompt-blocked` (160 characters) are
//   cut only by the service at 200, and `spawn-failed` is `Spawn failed — <raw
//   error>` rather than `SpawningSessionView`'s code-specific copy. A
//   hub-proxied `spawn-failed` (#5696) takes `RemoteSpawnFailedToastListener`'s
//   `Couldn't create the session on <node>: <error>` without its 160-character
//   cut, and carries `context.spawnCorrelationId` for the web gate. Three rows
//   need the client: `loops-resuming` appends the local time of
//   `context.pausedAtMs`; `account-unrefreshable` builds its "Log in" action
//   from `context.nodeId`; and so does a hub-proxied `spawn-failed` whose
//   `code` is `account_unrefreshable`.
//   An `account-unrefreshable` title must equal the HTTP 409's re-login text, so
//   both come from `@hapi/protocol` (`ACCOUNT_UNREFRESHABLE_MESSAGE`,
//   `formatReloginMessage`) and `SyncEngine.notifyUser` sets the node-named form.
// - `context` carries the legacy SyncEvent payload fields under the same names.
//   The long free-text fields (`errorContent`, `blockedReason`, `error`) are
//   capped at 1,000 characters so typical text stays under the service's
//   4,000-character context cap; text heavy in control characters can still
//   exceed it, and the service then clips it by serialized length so the stored
//   context still parses (#5696). The full text rides `body` (the service caps
//   that at 2,000).
// - A coalesced repeat keeps the first occurrence's title, body and context.
//   Events that must stay apart get their own key: non-`tool-error` categories
//   key per category, and `api-error` keys per phase (a spend-limit exhaustion
//   apart from other exhaustions). Plain tool errors, prompt blocks,
//   waiting-for-slot and `api-error` retries still coalesce per session under
//   the first title.
//
// The namespace is left to the caller: `SyncEngine.notifyUser` resolves it from
// the session when it is not given.

/** A `notify()` input whose namespace the caller (or the engine) supplies. */
export type ProducerNotification = Omit<NotifyInput, "namespace"> & {
  namespace?: string | null;
};

const MAX_CONTEXT_TEXT = 1000;
const MAX_BODY = 2000;
const MAX_ORIGINAL_PROMPT = 500;

function clip(value: string, max = MAX_CONTEXT_TEXT): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** Drop `undefined` entries so the stored context holds only what was given. */
function defined(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * A failed tool call reported by the CLI (`/cli/error-reports` categories
 * `tool-error`, `mcp-toggle-config-*`, `cron-usage-warning`,
 * `pty-submit-dropped`). Coalesces per session.
 */
export function toolErrorNotification(args: {
  sessionId: string;
  category: string;
  toolName: string;
  toolUseId: string;
  errorContent: string;
}): ProducerNotification {
  return {
    kind: "tool-error",
    title: `${args.toolName}: ${args.errorContent}`,
    body: args.errorContent.slice(0, MAX_BODY),
    sessionId: args.sessionId,
    // A plain tool error coalesces per session (the kind default). The other
    // categories (an MCP-toggle revert, a cron warning, a dropped PTY submit)
    // are different events: each coalesces only with its own category, so its
    // text is never hidden under an earlier, unrelated row's first-wins title.
    ...(args.category === "tool-error"
      ? {}
      : { dedupeKey: `tool-error:${args.category}:${args.sessionId}` }),
    context: {
      category: args.category,
      toolName: args.toolName,
      toolUseId: args.toolUseId,
      errorContent: clip(args.errorContent),
    },
  };
}

/**
 * A blocked prompt: a UserPromptSubmit hook (CLI report) or a message-layer gate
 * (`MessageService`). The gate path passes its catalogue `title` and NEVER the
 * denied prompt text (#3124 R8). Coalesces per session.
 */
export function promptBlockedNotification(args: {
  sessionId: string;
  blockedReason: string;
  originalPrompt?: string;
  title?: string;
  hookId?: string;
  code?: string;
  at?: string;
}): ProducerNotification {
  return {
    kind: "prompt-blocked",
    title: args.title ?? `UserPromptSubmit hook blocked: ${args.blockedReason}`,
    body: args.blockedReason.slice(0, MAX_BODY),
    sessionId: args.sessionId,
    context: defined({
      hookEvent: "UserPromptSubmit",
      blockedReason: clip(args.blockedReason),
      originalPrompt:
        args.originalPrompt !== undefined
          ? args.originalPrompt.slice(0, MAX_ORIGINAL_PROMPT)
          : undefined,
      title: args.title,
      hookId: args.hookId,
      code: args.code,
      at: args.at,
    }),
  };
}

export type ApiErrorPhase = "retrying" | "exhausted" | "recovered" | "give-up";

/**
 * An Anthropic API error phase: `retrying` / `exhausted` from the CLI report,
 * `recovered` / `give-up` from the auto-recovery service. Severity follows the
 * toast each phase shows today; each phase coalesces under its own per-session
 * key (a coalesced row keeps its first title), and a give-up never coalesces.
 */
export function apiErrorNotification(args: {
  sessionId: string;
  phase: ApiErrorPhase;
  errorType: string;
  retryAttempt?: number;
  maxRetries?: number;
  requestId?: string;
  limitVariant?: string;
  resumesAt?: number;
}): ProducerNotification {
  let title: string;
  let severity: NotifyInput["severity"];
  switch (args.phase) {
    case "retrying":
      title = `API retrying (${args.retryAttempt ?? "?"}/${args.maxRetries ?? "?"})...`;
      severity = "info";
      break;
    case "exhausted":
      if (args.errorType === "spend_limit_error") {
        title =
          "API spend limit reached — auto-recovery is off for this session";
        severity = "error";
      } else {
        title =
          args.errorType === "overloaded_error"
            ? "API overloaded — please review and retry"
            : "API error — please review and retry";
        severity = "warn";
      }
      break;
    case "recovered":
      title = "Resumed after API overload";
      severity = "info";
      break;
    case "give-up":
      title = "Auto-recovery exhausted — please review and retry manually";
      severity = "error";
      break;
  }
  return {
    kind: "api-error",
    title,
    severity,
    sessionId: args.sessionId,
    // A spend-limit exhaustion keys apart from other exhaustions, so an earlier
    // overloaded row (first-wins title) never hides the spend-limit text.
    ...(args.phase === "give-up"
      ? { dedupe: "none" as const }
      : {
          dedupeKey:
            args.phase === "exhausted" && args.errorType === "spend_limit_error"
              ? `api-error:exhausted-spend-limit:${args.sessionId}`
              : `api-error:${args.phase}:${args.sessionId}`,
        }),
    context: defined({
      phase: args.phase,
      errorType: args.errorType,
      retryAttempt: args.retryAttempt,
      maxRetries: args.maxRetries,
      requestId: args.requestId,
      limitVariant: args.limitVariant,
      resumesAt: args.resumesAt,
    }),
  };
}

/** #3612: the usage-window reset-nudge lifecycle points the user is told about. */
export type UsageWindowNudgePhase =
  | "usage-window-scheduled"
  | "usage-window-ended";

/** "3h 12m" / "45m" / "<1m" — a delay the title can state without a timezone. */
function formatDelay(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

const UTC_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * "02:45 UTC on Nov 1" — readable UTC to the minute. The server cannot know the
 * reader's timezone, so it states UTC plainly instead of a raw ISO stamp.
 */
function formatUtcMinute(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC on ${UTC_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * #3612: a session locked by a usage window (the 5-hour or weekly cap).
 * `usage-window-scheduled` tells the user when the session will be resumed, so
 * a capped session never waits silently; `usage-window-ended` says the reset
 * came but the session had stopped, so it was not resumed. Kind `api-error`,
 * so it follows the API-error notification preference. The scheduled title
 * leads with the delay because the inbox shows one truncated line and the time
 * is the fact the reader needs (PM ruling 2026-10-31). One row per reset time
 * (`resetAt`, the window's reset, not the jittered resume): a re-arm for the
 * same reset coalesces, while a rescheduled nudge (a later reset) gets a fresh
 * row. `resumesAt` is the jittered resume time, epoch ms, for a client that
 * wants the local time.
 */
export function usageWindowNudgeNotification(args: {
  sessionId: string;
  phase: UsageWindowNudgePhase;
  resumesAt: number;
  /** The window's reset time — the dedupe key. Defaults to `resumesAt`. */
  resetAt?: number;
  delayMs?: number;
  window?: string;
}): ProducerNotification {
  const scheduled = args.phase === "usage-window-scheduled";
  return {
    kind: "api-error",
    title: scheduled
      ? `Auto-resume in ${formatDelay(args.delayMs ?? 0)} — usage limit reached`
      : "Usage limit reset, but the session has stopped — reconnect it to resume",
    body: `${scheduled ? "Resumes" : "Reset"} at ${formatUtcMinute(args.resumesAt)}`,
    severity: scheduled ? "info" : "warn",
    sessionId: args.sessionId,
    dedupeKey: `api-error:${args.phase}:${args.sessionId}:${args.resetAt ?? args.resumesAt}`,
    context: defined({
      phase: args.phase,
      errorType: "rate_limit_error",
      resumesAt: args.resumesAt,
      window: args.window,
    }),
  };
}

/**
 * The account-unrefreshable title when no node is named: the shared
 * `ACCOUNT_UNREFRESHABLE_MESSAGE`, the web's `ACCOUNT_UNREFRESHABLE_TOAST_MESSAGE`.
 */
export const ACCOUNT_UNREFRESHABLE_TITLE = ACCOUNT_UNREFRESHABLE_MESSAGE;

/**
 * A session refused because its account can no longer refresh its token. Never
 * coalesced. `SyncEngine.notifyUser` adds this node's `nodeId` / `nodeLabel` and
 * retitles the row "Re-login required on <node>" (`formatReloginMessage`), the
 * text the node-stamped HTTP 409 and SSE event show, so the toast layer's
 * exact-text dedup collapses the pair into one toast.
 */
export function accountUnrefreshableNotification(args: {
  sessionId: string;
  accountUuid: string;
  source: "reconnect" | "token-refresh";
}): ProducerNotification {
  return {
    kind: "account-unrefreshable",
    title: ACCOUNT_UNREFRESHABLE_TITLE,
    sessionId: args.sessionId,
    context: { accountUuid: args.accountUuid, source: args.source },
  };
}

/**
 * Issue #6161 (R14): an account's sign-in on a node entered its warning window
 * (or passed its deadline). One row per (account, node). The context names the
 * node and the account explicitly, because the hub's event bridge stamps no
 * node on a `notification` event, and the web's "Sign in again" action reads
 * them. The title holds the account's nickname or email, so the caller passes
 * `mirror: false` and the title never reaches `error_logs`.
 */
export function signInEndingNotification(args: {
  accountUuid: string;
  accountLabel: string;
  nodeId: string;
  nodeLabel: string;
  daysLeft: number;
  due: boolean;
  estimated: boolean;
}): ProducerNotification {
  const days = args.daysLeft === 1 ? "1 day" : `${args.daysLeft} days`;
  const when = args.due
    ? "reached its end date"
    : `ends in ${args.estimated ? "about " : ""}${days}`;
  return {
    kind: "sign-in-ending",
    title: `Sign-in for ${args.accountLabel} on ${args.nodeLabel} ${when}`,
    body: "Sign in again on that node before it ends, or sessions bound to it stop.",
    context: {
      accountUuid: args.accountUuid,
      nodeId: args.nodeId,
      nodeLabel: args.nodeLabel,
    },
  };
}

/**
 * A token-refresh restart whose respawn and rollback both failed: the session is
 * disconnected but reconnectable. Never coalesced.
 */
export function sessionRestartFailedNotification(args: {
  sessionId: string;
  accountUuid: string;
  error: string;
}): ProducerNotification {
  return {
    kind: "session-restart-failed",
    title:
      "A session disconnected after a token refresh and couldn't restart " +
      "automatically. Reconnect it from the session list to resume.",
    body: args.error.slice(0, MAX_BODY),
    sessionId: args.sessionId,
    context: { accountUuid: args.accountUuid, error: clip(args.error) },
  };
}

/** A reconnect or account switch waiting for a free session slot. */
export function waitingForSlotNotification(args: {
  sessionId: string;
  context: "reconnect" | "account-switch";
  deadlineMs: number;
  elapsedMs?: number;
  /** #6156: which limit refused the spawn; the session count when omitted. */
  cause?: "slots" | "memory";
}): ProducerNotification {
  const verb =
    args.context === "account-switch" ? "Account switch" : "Reconnect";
  return {
    kind: "waiting-for-slot",
    title:
      args.cause === "memory"
        ? `${verb} is waiting for free memory… (node low on memory — retrying automatically)`
        : `${verb} is waiting for a free session slot… (instance at capacity — retrying automatically)`,
    sessionId: args.sessionId,
    context: defined({
      context: args.context,
      deadlineMs: args.deadlineMs,
      elapsedMs: args.elapsedMs,
    }),
  };
}

/** A reconnect resuming the loop-cron jobs it paused on disconnect. */
export function loopsResumingNotification(args: {
  sessionId: string;
  count: number;
  pausedAtMs: number;
}): ProducerNotification {
  const jobs = args.count === 1 ? "job" : "jobs";
  return {
    kind: "loops-resuming",
    title: `${args.count} scheduled ${jobs} resuming — paused on disconnect`,
    sessionId: args.sessionId,
    context: { count: args.count, pausedAtMs: args.pausedAtMs },
  };
}

/**
 * A background spawn that failed: a local early-return spawn (`machines.ts`),
 * or a spawn this hub proxied to a peer that reported the failure back
 * (`POST /federation/spawn-status`, #5696). The id is a placeholder, not a
 * session (it flips to failed and is purged), so the row carries no
 * `sessionId` and the id rides `context.placeholderId`; for a proxied spawn
 * that is the hub placeholder's id, the `spawnCorrelationId`. A proxied spawn
 * also carries `context.spawnCorrelationId`, the key the web gate uses to leave
 * the pop-up to `RemoteSpawnFailedToastListener` in the tab that started it,
 * and the node, named in the title as that listener names it. Never coalesced.
 */
export function spawnFailedNotification(args: {
  placeholderId: string;
  directory: string;
  error: string;
  code?: string;
  spawnCorrelationId?: string;
  nodeId?: string;
  nodeLabel?: string;
}): ProducerNotification {
  return {
    kind: "spawn-failed",
    title: args.nodeLabel
      ? `Couldn't create the session on ${args.nodeLabel}: ${args.error}`
      : `Spawn failed — ${args.error}`,
    body: args.error.slice(0, MAX_BODY),
    sessionId: null,
    context: defined({
      directory: args.directory,
      placeholderId: args.placeholderId,
      error: clip(args.error),
      code: args.code,
      spawnCorrelationId: args.spawnCorrelationId,
      nodeId: args.nodeId,
      nodeLabel: args.nodeLabel,
    }),
  };
}

/** #6778 PR-C: a lost start's cause, in the words a person reads. */
const LOST_CAUSE_WORDS: Record<TrackingLostCause, string> = {
  expired: "they expired before the session registered",
  namespace: "the session that registered for them is in another namespace",
  "hook-failed": "applying them failed",
  unreadable: "they could not be read",
  "queue-failed": "they could not be saved",
};

/**
 * #6778 PR-C (moved item 3; plan section 5 row 12, 4.2 row 10): a start with
 * tracking settings was lost. At registration it names the new session; at
 * the sweep (an expired entry, raised at expiry) and when the queue write
 * itself failed (moved item 6) no session exists yet. An
 * `error`, because it is raised once and never again; not mirrored, because
 * the lost start writes its own error-log row. The cause only: the requested
 * values (a rate, a note) never go into a notice.
 */
export function trackingStartLostNotification(args: {
  tag: string;
  lostCause: TrackingLostCause;
  sessionId: string | null;
  when: "registration" | "sweep" | "queue";
  namespace: string | null;
}): ProducerNotification {
  const why = LOST_CAUSE_WORDS[args.lostCause];
  const beforeRegistration = args.when !== "registration";
  return {
    kind: "tracking-not-applied",
    severity: "error",
    mirror: false,
    namespace: args.namespace,
    title: beforeRegistration
      ? `Tracking settings ${args.when === "sweep" ? "queued " : ""}for a new session were lost (${why}): a session that starts under them starts untracked.`
      : `A new session started untracked: its tracking settings were lost (${why}).`,
    body: beforeRegistration
      ? null
      : "Its time is not tracked until its tracking is set by hand.",
    sessionId: args.sessionId,
    context: { tag: args.tag, lostCause: args.lostCause, when: args.when },
  };
}

/**
 * #6778 PR-C (moved item 3; plan 4.2 rows 6 and 10, 6.3): a session started on
 * another node without the tracking it was given. An agent's copy the target
 * cannot take (`tracking-unsupported`, ruling C3) or did not apply
 * (`not-applied`) names the parent, whose history row records it; a person's
 * carried start the target did not apply names no session. The node only.
 * #6780 (Task 8): the spawn's `spawnCorrelationId` rides the context, so the
 * tab that started the spawn shows one tracking pop-up for it (the hook's, the
 * read-back's or this notice's); a random id, not a C7 value.
 */
export function trackingCopyNotSentNotification(args: {
  reason: "tracking-unsupported" | "not-applied";
  nodeId: string;
  nodeLabel: string;
  parentSessionId: string | null;
  namespace: string;
  spawnCorrelationId?: string;
}): ProducerNotification {
  const node = args.nodeLabel;
  let title: string;
  if (args.parentSessionId === null) {
    title = `A new session on ${node} started untracked: ${node} did not apply its tracking settings.`;
  } else if (args.reason === "tracking-unsupported") {
    title = `A session started on ${node} without its parent's tracking: ${node} cannot take tracking settings.`;
  } else {
    title = `A session started on ${node} without its parent's tracking: ${node} did not apply it.`;
  }
  return {
    kind: "tracking-not-applied",
    namespace: args.namespace,
    title,
    body: null,
    sessionId: args.parentSessionId,
    context: defined({
      nodeId: args.nodeId,
      nodeLabel: node,
      reason: args.reason,
      spawnCorrelationId: args.spawnCorrelationId,
    }),
  };
}
