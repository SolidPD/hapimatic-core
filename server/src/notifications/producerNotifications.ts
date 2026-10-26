// SPDX-License-Identifier: AGPL-3.0-only
import {
  ACCOUNT_UNREFRESHABLE_MESSAGE,
  type NotifyInput,
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
}): ProducerNotification {
  const verb =
    args.context === "account-switch" ? "Account switch" : "Reconnect";
  return {
    kind: "waiting-for-slot",
    title: `${verb} is waiting for a free session slot… (instance at capacity — retrying automatically)`,
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
