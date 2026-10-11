// SPDX-License-Identifier: AGPL-3.0-only
import * as Sentry from "@sentry/react";
import type {
  Event,
  EventHint,
  Breadcrumb,
  BreadcrumbHint,
} from "@sentry/react";
import type { AnyRouter } from "@tanstack/react-router";
import {
  isSensitiveName,
  scrubString,
  scrubUrl,
  scrubKv,
  scrubFrames,
} from "@hapi/protocol/sentryScrub";

/**
 * Initialize Sentry error tracking for the Hapimatic web client.
 *
 * Integrates with TanStack Router for navigation performance tracking.
 * Source maps are uploaded during `vite build` via @sentry/vite-plugin.
 *
 * #1142: Comprehensive event scrubber mirrors `server/src/sentry.ts`.
 * The walker helpers live in `@hapi/protocol/sentryScrub` and are shared
 * with the server-side scrubber so security-critical regex patterns and the
 * `SENSITIVE_FIELD_NAMES` set never drift between the two callers.
 *
 * Both `beforeSend` (errors) and `beforeSendTransaction` (route-change
 * spans from `tanstackRouterBrowserTracingIntegration`) run the same
 * `scrubEvent` walker so token-laden URLs in `event.transaction` /
 * `event.request.url` are redacted before leaving the browser.
 */
export function initSentry(router: AnyRouter): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) {
    console.log("[Sentry] Disabled — no VITE_SENTRY_DSN configured");
    return;
  }

  Sentry.init({
    dsn,
    environment: import.meta.env.DEV ? "development" : "production",

    integrations: [Sentry.tanstackRouterBrowserTracingIntegration(router)],

    tracesSampleRate: 0.5,
    sampleRate: 1.0,

    // Session replay disabled for now — evaluate later for iOS PWA debugging
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,

    sendDefaultPii: false,
    beforeSend: scrubEvent,
    // #1142: Route-change transactions go through this hook, not beforeSend.
    // Without it, TanStack Router URLs (with session IDs and query params)
    // leak into Sentry as `event.transaction` and `event.request.url`.
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
}

/**
 * Generic event scrubber — operates on any Sentry Event subtype (ErrorEvent
 * or TransactionEvent). The generic signature lets the same function be
 * registered for both `beforeSend` and `beforeSendTransaction`. #1142.
 *
 * Walker helpers (`scrubUrl`, `scrubKv`, `scrubFrames`, `scrubString`,
 * `isSensitiveName`) live in `@hapi/protocol/sentryScrub` and are shared
 * with the server-side scrubber.
 *
 * Exported (named) so unit tests can exercise the walker directly without
 * round-tripping through `Sentry.init`. #1058 server pattern.
 */
export function scrubEvent<T extends Event>(
  event: T,
  _hint?: EventHint
): T | null {
  if (event.request) {
    if (typeof event.request.url === "string") {
      event.request.url = scrubUrl(event.request.url);
    }
    if (typeof event.request.query_string === "string") {
      event.request.query_string = scrubString(event.request.query_string);
    } else if (
      event.request.query_string &&
      typeof event.request.query_string === "object"
    ) {
      // Drop the whole object — may be a KV map with an Authorization key.
      event.request.query_string = undefined;
    }
    if (event.request.headers) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(event.request.headers)) {
        if (isSensitiveName(k)) {
          headers[k] = "[REDACTED]";
        } else if (typeof v === "string") {
          headers[k] = scrubString(v);
        } else {
          headers[k] = String(v);
        }
      }
      event.request.headers = headers;
    }
    // #1058 H-1: cookies are a separate field from headers and routinely
    // contain session tokens.
    if (event.request.cookies && typeof event.request.cookies === "object") {
      const cookies: Record<string, string> = {};
      for (const [k, v] of Object.entries(event.request.cookies)) {
        cookies[k] = isSensitiveName(k)
          ? "[REDACTED]"
          : typeof v === "string"
            ? scrubString(v)
            : String(v);
      }
      event.request.cookies = cookies;
    }
    // #1058 H-1: scrub the parsed request body. Bodies routinely include
    // `password`, `token`, etc. interpolated by client-side code.
    if (event.request.data !== undefined && event.request.data !== null) {
      event.request.data = scrubKv(
        event.request.data
      ) as typeof event.request.data;
    }
  }
  // #1058 H-1: `event.user` has an open `[key: string]: any` extension —
  // callers can attach arbitrary fields including tokens.
  if (event.user && typeof event.user === "object") {
    event.user = scrubKv(event.user) as typeof event.user;
  }
  if (typeof event.message === "string") {
    event.message = scrubString(event.message);
  }
  if (event.transaction && typeof event.transaction === "string") {
    // `event.transaction` is the route/page identifier — scrub URL params
    // here. TanStack Router transactions often include token-laden segments.
    // #1142 R2: this is the primary scrub for route-change spans.
    event.transaction = scrubUrl(event.transaction);
  }
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (typeof ex.value === "string") ex.value = scrubString(ex.value);
      if (ex.stacktrace?.frames) scrubFrames(ex.stacktrace.frames);
    }
  }
  // Recursive walks over the unstructured user-controlled buckets.
  if (event.tags && typeof event.tags === "object") {
    event.tags = scrubKv(event.tags) as typeof event.tags;
  }
  if (event.extra && typeof event.extra === "object") {
    event.extra = scrubKv(event.extra) as typeof event.extra;
  }
  if (event.contexts && typeof event.contexts === "object") {
    event.contexts = scrubKv(event.contexts) as typeof event.contexts;
  }
  // Walk any breadcrumbs that ended up on the event itself (defensive —
  // primary scrubbing happens in `scrubBreadcrumb` via `beforeBreadcrumb`).
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(b => scrubBreadcrumb(b) ?? b);
  }
  return event;
}

/**
 * Scrub a Sentry breadcrumb. Walks `crumb.data` keys with `isSensitiveName`
 * (catches opaque API keys in sensitively-named fields that `scrubString`
 * alone would miss) and applies `scrubString` to `crumb.message`. #1058 H-1.
 *
 * Exported for unit testing only — registered as Sentry's `beforeBreadcrumb`
 * hook by `initSentry`.
 */
export function scrubBreadcrumb(
  crumb: Breadcrumb,
  _hint?: BreadcrumbHint
): Breadcrumb | null {
  if (crumb.data) {
    for (const k of Object.keys(crumb.data)) {
      const v = crumb.data[k];
      if (isSensitiveName(k)) {
        crumb.data[k] = "[REDACTED]";
      } else if (typeof v === "string") {
        crumb.data[k] = scrubString(v);
      }
    }
  }
  if (typeof crumb.message === "string") {
    crumb.message = scrubString(crumb.message);
  }
  return crumb;
}

export { Sentry };
