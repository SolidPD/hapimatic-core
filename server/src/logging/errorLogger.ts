// SPDX-License-Identifier: AGPL-3.0-only
import type { ExtensionLogger } from "@hapi/protocol/ext";

import type { ErrorLogStore } from "../store/errorLogStore";
import type { ErrorLogSeverity, ErrorLogSource } from "../store/types";
import type { PushService } from "../push/pushService";
import { captureException } from "../sentry";
import {
  FixedWindowCounter,
  parseEnvInt,
  type RateLimitDecision,
} from "../utils/rateLimitCounter";

const MAX_MESSAGE_LENGTH = 2000;
const MAX_STACK_LENGTH = 5000;

// Issue #1141: rate-limit per `category` to prevent runaway error loops
// (e.g. broken SSE emitting 100 errors/sec) from flooding Sentry + the
// SQLite error_logs table. Read once at module load.
const RATE_LIMIT = parseEnvInt(process.env.HAPI_ERRORLOGGER_RATE_LIMIT, 10);
const RATE_WINDOW_MS = parseEnvInt(
  process.env.HAPI_ERRORLOGGER_RATE_WINDOW_MS,
  60_000
);
// Memory bound (R4): prune buckets older than 2× window on each call.
const RATE_PRUNE_MAX_AGE_MS = 2 * RATE_WINDOW_MS;

export type ErrorLogOptions = {
  category?: string;
  source?: ErrorLogSource;
  stack?: string | null;
  sessionId?: string | null;
  namespace?: string | null;
  context?: Record<string, unknown> | null;
  userAgent?: string | null;
  requestPath?: string | null;
  requestMethod?: string | null;
  statusCode?: number | null;
  /**
   * `false` = console (+ Sentry for error/fatal) only — skip the SQLite
   * `error_logs` row. Use from a path that is INSIDE a held-lock contention
   * window (#3631): the row is an autocommit INSERT on the same `hapi.db`
   * connection, so persisting there would block the event loop for up to
   * `busy_timeout` again and then fail anyway. Default `true`.
   */
  persist?: boolean;
};

export class ErrorLogger {
  private readonly store: ErrorLogStore | null;
  private pushService: PushService | null = null;
  // Per-instance counter — fresh state per server boot AND fresh state per
  // test (matches the existing `new ErrorLogger(null)` test pattern). No
  // module-level singleton.
  private readonly rateLimitCounter: FixedWindowCounter;

  constructor(
    store: ErrorLogStore | null,
    counterOptions?: { getNow?: () => number }
  ) {
    this.store = store;
    this.rateLimitCounter = new FixedWindowCounter({
      limit: RATE_LIMIT,
      windowMs: RATE_WINDOW_MS,
      getNow: counterOptions?.getNow,
    });
    if (!store) {
      console.warn(
        "[ErrorLogger] Initialized WITHOUT persistence — errors will only go to console"
      );
    }
  }

  setPushService(pushService: PushService): void {
    this.pushService = pushService;
  }

  log(
    severity: ErrorLogSeverity,
    message: string,
    options?: ErrorLogOptions
  ): void {
    let truncatedMessage = truncate(message, MAX_MESSAGE_LENGTH);
    const truncatedStack = options?.stack
      ? truncate(options.stack, MAX_STACK_LENGTH)
      : null;
    const category = options?.category ?? "general";

    // Serialize context to JSON string
    let contextStr: string | null = null;
    if (options?.context != null) {
      try {
        contextStr = JSON.stringify(options.context);
      } catch {
        contextStr = "[serialization error]";
      }
    }

    // Issue #1141: rate-limit gate. Prune memory then ask the counter
    // whether to forward, drop, or summarize. The counter MUST NOT throw
    // (logger contract is non-throwing), but we wrap defensively so a
    // future change cannot regress the invariant. On any throw, fail-safe
    // to forward — over-emit beats silent loss.
    //
    // Fix C1 (silent-failure-hunter review of v1.0.373 merge): fatal
    // severity bypasses the gate entirely. Fatal events are crash-class
    // incidents (security breaches, unrecoverable failures) that
    // operators MUST see — suppressing them defeats the purpose of the
    // logger. Rate limiting still applies to error/warn/info/debug.
    let decision: RateLimitDecision = { action: "forward" };
    if (severity !== "fatal") {
      try {
        this.rateLimitCounter.pruneOlderThan(RATE_PRUNE_MAX_AGE_MS);
        decision = this.rateLimitCounter.check(category);
      } catch (rateLimitErr) {
        console.error(
          "[ErrorLogger] Rate-limit check threw (forwarding event):",
          rateLimitErr instanceof Error
            ? rateLimitErr.message
            : String(rateLimitErr)
        );
      }
    }

    if (decision.action === "drop") {
      // Suppressed silently — the prior `summarize` event already told
      // operators that flooding started for this category. The category's
      // counter resets at window expiry and forwarding resumes.
      return;
    }

    if (decision.action === "summarize") {
      // Replace the event content with a summary entry. The summary flows
      // through ALL side effects below (console + SQLite + Sentry + push)
      // — it does NOT re-enter the rate-limit check, because we mutate
      // the local vars instead of recursing into log().
      const originalMessage = truncatedMessage;
      truncatedMessage = `[rate-limit] Suppressing further "${category}" events for up to ${RATE_WINDOW_MS}ms (severity ${severity}). Last message: ${originalMessage}`;
      // Truncate again in case the original was near the cap — preserve
      // MAX_MESSAGE_LENGTH invariant for downstream consumers.
      truncatedMessage = truncate(truncatedMessage, MAX_MESSAGE_LENGTH);
      const summaryContext = {
        rateLimitSummary: true,
        droppedCount: decision.droppedCount,
        windowMs: RATE_WINDOW_MS,
        originalMessage,
        ...(options?.context ?? {}),
      };
      try {
        contextStr = JSON.stringify(summaryContext);
      } catch {
        contextStr = "[serialization error]";
      }
    }

    // Always write to console for journalctl backward compatibility
    const prefix = `[${category}]`;
    switch (severity) {
      case "fatal":
      case "error":
        console.error(prefix, truncatedMessage);
        break;
      case "warn":
        console.warn(prefix, truncatedMessage);
        break;
      case "debug":
        // Use console.debug for debug level
        console.debug(prefix, truncatedMessage);
        break;
      default:
        console.log(prefix, truncatedMessage);
        break;
    }

    // Persist to SQLite — never let the logger throw. `persist: false` (#3631)
    // skips the row: the caller is inside a held-lock window where this
    // autocommit INSERT would itself block up to busy_timeout.
    if (this.store && options?.persist !== false) {
      try {
        this.store.createEntry({
          severity,
          category: options?.category ?? "general",
          source: options?.source ?? "server",
          message: truncatedMessage,
          stack: truncatedStack,
          sessionId: options?.sessionId,
          namespace: options?.namespace,
          context: contextStr,
          userAgent: options?.userAgent,
          requestPath: options?.requestPath,
          requestMethod: options?.requestMethod,
          statusCode: options?.statusCode,
        });
      } catch (err) {
        // Fallback: log the persistence failure to console
        console.error(
          "[ErrorLogger] Failed to persist error log:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Forward errors and fatals to Sentry (complements SQLite, never throws)
    if (severity === "error" || severity === "fatal") {
      try {
        captureException(
          truncatedStack
            ? Object.assign(new Error(truncatedMessage), {
                stack: truncatedStack,
              })
            : new Error(truncatedMessage),
          {
            tags: {
              category: options?.category ?? "general",
              source: options?.source ?? "server",
            },
            extra: {
              sessionId: options?.sessionId,
              namespace: options?.namespace,
              requestPath: options?.requestPath,
              requestMethod: options?.requestMethod,
              statusCode: options?.statusCode,
            },
          }
        );
      } catch (sentryErr) {
        // C5 silent-failure (#1140): surface BOTH the original message and
        // the Sentry transport failure so a broken Sentry pipeline doesn't
        // hide errors entirely. Must still swallow — logger contract is
        // non-throwing.
        console.error("[ErrorLogger][sentry-fwd-failed]", {
          message: truncatedMessage,
          sentryErr:
            sentryErr instanceof Error ? sentryErr.message : String(sentryErr),
        });
      }
    }

    // Fatal errors → push notification (fire-and-forget)
    if (severity === "fatal" && this.pushService) {
      const payload = {
        title: "Fatal Error",
        body: `[${category}] ${truncatedMessage.substring(0, 150)}`,
        tag: "fatal-error",
        data: {
          type: "error",
          sessionId: options?.sessionId ?? "",
          url: "/error-logs",
        },
      };

      const namespace = options?.namespace;
      if (namespace) {
        this.pushService.sendToNamespace(namespace, payload).catch(pushErr => {
          console.error(
            "[ErrorLogger] Failed to push-notify fatal error:",
            pushErr instanceof Error ? pushErr.message : String(pushErr)
          );
        });
      } else {
        this.pushService.sendToAll(payload).catch(pushErr => {
          console.error(
            "[ErrorLogger] Failed to push-notify fatal error:",
            pushErr instanceof Error ? pushErr.message : String(pushErr)
          );
        });
      }
    }
  }

  fatal(message: string, options?: ErrorLogOptions): void {
    this.log("fatal", message, options);
  }

  error(message: string, options?: ErrorLogOptions): void {
    this.log("error", message, options);
  }

  warn(message: string, options?: ErrorLogOptions): void {
    this.log("warn", message, options);
  }

  info(message: string, options?: ErrorLogOptions): void {
    this.log("info", message, options);
  }

  debug(message: string, options?: ErrorLogOptions): void {
    this.log("debug", message, options);
  }

  /**
   * Create a per-extension tagged child logger (issue #1266, Sub-Issue B).
   *
   * Returns A's structural {@link ExtensionLogger} — NOT an `ErrorLogger`: the
   * concrete class has private members and is nominally untypeable by a
   * delegating object literal. The child delegates every call to THIS
   * instance's `log(...)`, so it inherently shares the parent's `store`,
   * `pushService`, and (critically) the per-instance `rateLimitCounter` — a
   * chatty extension cannot spin up a fresh counter to bypass the #1141 global
   * rate limit. Each extension logs under its own `ext:<id>` category, so it
   * gets an isolated rate-limit bucket WITHIN the shared counter.
   *
   * `ExtensionLogger.log` (the severity-less generic method) maps to `info` —
   * the neutral default level (there is no plain "log" `ErrorLogSeverity`).
   */
  child(extensionId: string): ExtensionLogger {
    const prefix = `[ext:${extensionId}] `;
    const category = `ext:${extensionId}`;
    const forward = (
      severity: ErrorLogSeverity,
      message: string,
      context?: unknown
    ): void => {
      // Auto-augment context with { extensionId }; caller-provided fields take
      // precedence on collision (shallow merge). Non-object caller context is
      // preserved under a `value` key rather than dropped.
      let mergedContext: Record<string, unknown>;
      if (
        context != null &&
        typeof context === "object" &&
        !Array.isArray(context)
      ) {
        mergedContext = {
          extensionId,
          ...(context as Record<string, unknown>),
        };
      } else if (context != null) {
        mergedContext = { extensionId, value: context };
      } else {
        mergedContext = { extensionId };
      }
      this.log(severity, prefix + message, {
        category,
        context: mergedContext,
      });
    };
    return {
      log: (message, context) => forward("info", message, context),
      error: (message, context) => forward("error", message, context),
      warn: (message, context) => forward("warn", message, context),
      info: (message, context) => forward("info", message, context),
      debug: (message, context) => forward("debug", message, context),
    };
  }
}

function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + "...";
}
