// SPDX-License-Identifier: AGPL-3.0-only
import {
  ServerRuntimeClient,
  setCurrentClient,
  setTag,
  createTransport,
  captureException,
  createStackParser,
} from "@sentry/core";
import type {
  BaseTransportOptions,
  Transport,
  TransportMakeRequestResponse,
  Event,
  EventHint,
  Breadcrumb,
} from "@sentry/core";
// Imported from the main barrel for consistency with web/src/sentry.ts (the
// concurrent-worktree race on the package.json exports map is more reliably
// avoided by using the existing barrel export).
import {
  isSensitiveName,
  scrubString,
  scrubUrl,
  scrubKv,
  scrubFrames,
} from "@hapi/protocol";

/**
 * Initialize Sentry error tracking for the Hapimatic server.
 *
 * Uses @sentry/core directly instead of @sentry/bun or @sentry/node because
 * the compiled Bun executable (bun build --compile) cannot resolve the
 * OpenTelemetry auto-instrumentation dependencies that @sentry/bun pulls in.
 * @sentry/core provides all the error capture functionality we need without
 * the OTel dependency tree.
 */
export function initSentry(options: {
  dsn: string | undefined;
  nodeId: string;
  nodeLabel: string;
  environment: string;
  release: string;
}): void {
  if (!options.dsn) {
    console.log("[Sentry] Disabled — no SENTRY_DSN configured");
    return;
  }

  const client = new ServerRuntimeClient({
    dsn: options.dsn,
    environment: options.environment,
    release: `hapimatic-server@${options.release}`,
    sampleRate: 1.0,
    tracesSampleRate: 0.2,
    maxBreadcrumbs: 50,
    transport: makeFetchTransport,
    stackParser: createStackParser(),
    integrations: [],
    sendDefaultPii: false,
    beforeSend: scrubEvent,
    // #1142: scrubEvent is generic over Event so it satisfies both
    // beforeSend (ErrorEvent) and beforeSendTransaction (TransactionEvent).
    // Without this hook, route-change span URLs leak token-laden paths.
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });

  setCurrentClient(client);
  client.init();

  setTag("federation.nodeId", options.nodeId);
  setTag("federation.nodeLabel", options.nodeLabel);

  console.log(
    `[Sentry] Initialized — node: ${options.nodeId} (${options.nodeLabel})`
  );
}

/**
 * Generic event scrubber — operates on any Sentry Event subtype (ErrorEvent
 * or TransactionEvent). The generic signature lets the same function be
 * registered for both `beforeSend` (errors) and `beforeSendTransaction`
 * (route-change spans). #1058 + #1142.
 *
 * Walker helpers (`scrubUrl`, `scrubKv`, `scrubFrames`, `scrubString`,
 * `isSensitiveName`) live in `@hapi/protocol/sentryScrub` and are shared
 * with the web-side scrubber to prevent regex-pattern drift.
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
    // contain session tokens. `Record<string, string>` per Sentry types.
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
  // event.breadcrumbs is intentionally NOT walked here: each breadcrumb is
  // scrubbed at capture time by `scrubBreadcrumb` (the `beforeBreadcrumb`
  // hook). If a future integration adds breadcrumbs that bypass that hook,
  // add a `scrubKv` pass over `event.breadcrumbs[].data` here.
  if (typeof event.message === "string") {
    event.message = scrubString(event.message);
  }
  if (event.transaction && typeof event.transaction === "string") {
    // `event.transaction` is the route/page identifier — scrub URL params
    // here too (TanStack Router and similar routers may include token-laden
    // path or query segments).
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
  return event;
}

function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  if (crumb.data) {
    // #1058 H-1: also redact by sensitive key name. `scrubString` only
    // catches token-shaped values; an opaque API key in a sensitively-named
    // field would otherwise pass through.
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

/**
 * Fetch-based transport for Sentry — works in Bun without Node.js http module.
 */
function makeFetchTransport(transportOptions: BaseTransportOptions): Transport {
  return createTransport(transportOptions, async request => {
    const response = await fetch(transportOptions.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body: request.body,
    });

    return {
      statusCode: response.status,
      headers: {
        "x-sentry-rate-limits": response.headers.get("x-sentry-rate-limits"),
        "retry-after": response.headers.get("retry-after"),
      },
    } as TransportMakeRequestResponse;
  });
}

// Re-export shared helpers so existing callers (Hono access logger, the
// /error-reports route, server tests) keep their `import { scrubString } from
// "./sentry"` paths working unchanged. See #1062, #1058.
export { scrubString, scrubUrl } from "@hapi/protocol";

export { captureException };
