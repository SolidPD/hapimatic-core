// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `cataloged()` — a Hono middleware that co-locates a capability's `CatalogEntry`
 * with the REST route it describes (issue #3742, epic #2416 Sub-Issue B).
 *
 * Import hygiene (issue #3742, finding 3742-15): `cli/tsconfig.json` compiles
 * `../server/src/**` under a `@/*` alias pointing at `cli/src/*`, so these server
 * files are type-checked by BOTH `typecheck:server` AND `typecheck:cli`. NEVER use
 * the `@/` alias here — only relative imports or `@hapi/*` workspace specifiers.
 */
import type { MiddlewareHandler } from "hono";
import type { CatalogEntry } from "@hapi/protocol";
import type { WebAppEnv } from "../web/middleware/auth";

/**
 * Well-known symbol carrying the `CatalogEntry` on a `cataloged()` middleware
 * FUNCTION, so a boot-time collector (Sub-Issue C, #3743) and the generic-route
 * refusal (#3752) can recover the entry WITHOUT invoking the middleware.
 *
 * Contract (verified for hono 4.11.2 — read the tag off `app.routes[i].handler`):
 * each verb method registers ONE `app.routes` entry PER HANDLER ARGUMENT, so a
 * 3-argument registration produces TWO entries for the same METHOD+PATH — the
 * tagged middleware entry and the untagged route handler entry. And
 * `app.route("/api", sub)` only re-wraps handlers when the sub-app has a
 * non-default `errorHandler`; no sub-app mounted via `app.route()` sets one (the
 * only `app.onError(...)` is the root's, `buildWebApp.ts`), so the tag survives
 * prefixing by reference. Register the tag FIRST, ahead of any limiter or gate —
 * the invoker refuses a route whose first handler is untagged (#5596):
 *
 *   sub.get("/x", cataloged(entry), handler);
 *   // → app.routes has { method:"GET", path:"/x", handler: <mw> } whose
 *   //   handler[CAPABILITY_TAG] === entry, plus { ..., handler } without the tag.
 */
export const CAPABILITY_TAG: unique symbol = Symbol("hapi.capability");

/**
 * The capability-invocation telemetry event `cataloged()` emits. Entry-derived
 * ONLY (issue #3742, finding 3742-21): NEVER request path params, query strings,
 * or bodies — the event's fields are persisted as JSON and surfaced through
 * `GET /api/telemetry`.
 */
export type CapabilityTelemetryEvent = {
  filePath: string;
  fileType: "capability";
  eventType: "invocation";
  sessionId?: string;
};

/** The tap `cataloged()` emits capability-invocation events through. */
export type CapabilityTelemetrySink = (event: CapabilityTelemetryEvent) => void;

/** A `cataloged()` middleware, tagged with its `CatalogEntry` for the collector. */
export type CatalogedMiddleware = MiddlewareHandler<WebAppEnv> & {
  readonly [CAPABILITY_TAG]: CatalogEntry;
};

/**
 * Module-level telemetry sink. `cataloged()` never imports `TelemetryStore`
 * directly (issue #3742, KD-6) — the store reaches the web app only as an
 * optional `getTelemetryStore` accessor, and `server/src/web/server.ts` is at its
 * `max-lines` ceiling, so the wiring lives in `server/src/index.ts`. With NO sink
 * registered the tap is a silent no-op — never a 500.
 */
let capabilityTelemetrySink: CapabilityTelemetrySink | null = null;

/** Register (or clear, with `null`) the capability telemetry sink. */
export function setCapabilityTelemetrySink(
  sink: CapabilityTelemetrySink | null
): void {
  capabilityTelemetrySink = sink;
}

/** Default 1-in-N sampling rate for capability-invocation telemetry. */
const DEFAULT_SAMPLE_EVERY = 20;

/**
 * Build a Hono middleware that co-locates `entry` with a REST route:
 *   (a) tags the middleware function with `entry` (readable off `app.routes`),
 *   (b) sets `c.set("capability", entry)` so the handler can read it, and
 *   (c) emits a sampled, fire-and-forget capability-invocation telemetry event
 *       (skipped entirely when `entry.telemetry === "off"`), then calls `next()`.
 *
 * `opts.sampleEvery` overrides the 1-in-N rate — the test seam that a bare module
 * constant could not provide (issue #3742, finding 3742-11). `entry.telemetry`
 * is `undefined` when omitted (`defineCapability` is an identity passthrough,
 * #3741 KD-3), so `!== "off"` correctly samples by default (finding 3742-20).
 */
export function cataloged(
  entry: CatalogEntry,
  opts?: { sampleEvery?: number }
): CatalogedMiddleware {
  const sampleEvery =
    opts?.sampleEvery && opts.sampleEvery > 0
      ? opts.sampleEvery
      : DEFAULT_SAMPLE_EVERY;
  let counter = 0;

  const mw: MiddlewareHandler<WebAppEnv> = async (c, next) => {
    c.set("capability", entry);

    if (entry.telemetry !== "off") {
      counter += 1;
      if (counter % sampleEvery === 0) {
        const sink = capabilityTelemetrySink;
        if (sink) {
          try {
            sink({
              filePath: entry.id,
              fileType: "capability",
              eventType: "invocation",
            });
          } catch {
            // Fire-and-forget: a telemetry sink failure must NEVER break the
            // request path (issue #3742, R6).
          }
        }
      }
    }

    await next();
  };

  return Object.assign(mw, { [CAPABILITY_TAG]: entry });
}
