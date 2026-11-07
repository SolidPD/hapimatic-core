// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Request log (issue #6158, D1). Replaces Hono's `logger()`, which printed two
 * lines for every request. Federation peers poll each other every few seconds,
 * so on ms1 ~94% of all requests were routine 2xx peer polls and
 * `/api/telemetry/event`, ~13,700 lines an hour, every one of them stored twice
 * (journal + /var/log/syslog through journald's ForwardToSyslog).
 *
 * Modes (`HAPI_REQUEST_LOG`, read once at boot):
 *   - `errors` (default): one line per request, only when the response status
 *     is >= 400 or the request took >= `HAPI_REQUEST_LOG_SLOW_MS` (default
 *     1000). "Slow" is measured until the handler returns its `Response`, so
 *     an SSE or streamed body never counts as slow.
 *   - `all`: Hono's old shape without colour — a `<--` line before the handler
 *     (so a hung or fatal request still leaves a trace) and a `-->` line after.
 *     For debugging.
 *   - `off`: nothing.
 *
 * Every printed line goes through `scrubString` whole (#1062 M-2): the path
 * carries the query string, so `?token=…`, `Bearer …` and JWT shapes are masked
 * before stdout reaches the journal.
 */
import type { MiddlewareHandler } from "hono";
import { scrubString } from "../../sentry";

export type RequestLogMode = "errors" | "all" | "off";

export const DEFAULT_REQUEST_LOG_MODE: RequestLogMode = "errors";
export const DEFAULT_REQUEST_LOG_SLOW_MS = 1000;

const MODES: readonly RequestLogMode[] = ["errors", "all", "off"];

export interface RequestLogConfig {
  mode: RequestLogMode;
  slowMs: number;
  /** One message per env value that was ignored; the caller prints them at boot. */
  warnings: string[];
}

export function resolveRequestLogConfig(
  env: Record<string, string | undefined> = process.env
): RequestLogConfig {
  const warnings: string[] = [];

  let mode = DEFAULT_REQUEST_LOG_MODE;
  const rawMode = env.HAPI_REQUEST_LOG?.trim().toLowerCase();
  if (rawMode) {
    if ((MODES as readonly string[]).includes(rawMode)) {
      mode = rawMode as RequestLogMode;
    } else {
      warnings.push(
        `HAPI_REQUEST_LOG=${JSON.stringify(env.HAPI_REQUEST_LOG)} is not one of ${MODES.join(", ")}; using "${DEFAULT_REQUEST_LOG_MODE}"`
      );
    }
  }

  let slowMs = DEFAULT_REQUEST_LOG_SLOW_MS;
  const rawSlow = env.HAPI_REQUEST_LOG_SLOW_MS?.trim();
  if (rawSlow) {
    const parsed = /^\d+$/.test(rawSlow) ? Number(rawSlow) : NaN;
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      slowMs = parsed;
    } else {
      warnings.push(
        `HAPI_REQUEST_LOG_SLOW_MS=${JSON.stringify(env.HAPI_REQUEST_LOG_SLOW_MS)} is not a positive integer; using ${DEFAULT_REQUEST_LOG_SLOW_MS}`
      );
    }
  }

  return { mode, slowMs, warnings };
}

export function shouldLogRequest(
  status: number,
  elapsedMs: number,
  cfg: Pick<RequestLogConfig, "mode" | "slowMs">
): boolean {
  if (cfg.mode === "off") return false;
  if (cfg.mode === "all") return true;
  return status >= 400 || elapsedMs >= cfg.slowMs;
}

export function formatRequestLine(
  prefix: "<--" | "-->",
  method: string,
  path: string,
  status?: number,
  elapsedMs?: number
): string {
  if (prefix === "<--") return `<-- ${method} ${path}`;
  return `--> ${method} ${path} ${status ?? 0} ${elapsedMs ?? 0}ms`;
}

export interface RequestLoggerOptions {
  cfg: Pick<RequestLogConfig, "mode" | "slowMs">;
  print?: (line: string) => void;
  now?: () => number;
}

export function createRequestLogger(
  options: RequestLoggerOptions
): MiddlewareHandler {
  const { cfg } = options;
  const print = options.print ?? ((line: string) => console.log(line));
  const now = options.now ?? Date.now;
  const emit = (line: string): void => print(scrubString(line));

  return async function requestLogger(c, next) {
    if (cfg.mode === "off") {
      await next();
      return;
    }
    const { method, url } = c.req;
    // Hono's own derivation: everything after the origin, query included.
    const path = url.slice(url.indexOf("/", 8));
    if (cfg.mode === "all") emit(formatRequestLine("<--", method, path));
    const start = now();
    let status = 500;
    try {
      await next();
      status = c.res.status;
    } finally {
      // A non-Error throw skips Hono's onError and rejects next(): it is still
      // logged, as a 500, before the rejection propagates.
      const elapsed = now() - start;
      if (shouldLogRequest(status, elapsed, cfg)) {
        emit(formatRequestLine("-->", method, path, status, elapsed));
      }
    }
  };
}
