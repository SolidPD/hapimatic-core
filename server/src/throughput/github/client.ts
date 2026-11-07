// SPDX-License-Identifier: AGPL-3.0-only
import {
  classifyRestStatus,
  resolveGitHubToken,
  type FetchImpl,
} from "../../utils/githubRest";
import type { GhRunner } from "../../utils/githubCli";

/**
 * GitHub REST client for the throughput collector (issue #6164, A1 — R6, R14).
 *
 * A careful, budgeted reader: the collector shares the node's GitHub rate
 * limit with every session, so this client
 *   - makes calls SEQUENTIALLY, at least {@link MIN_GAP_MS} apart;
 *   - stops after {@link MAX_CALLS_PER_RUN} calls per run;
 *   - reads `GET /rate_limit` first and stops below {@link STOP_BELOW_REMAINING}
 *     remaining, re-checking `x-ratelimit-remaining` on every reply;
 *   - stops on a rate-limited reply and records when to retry (`Retry-After`,
 *     else the reset time), classifying replies with `classifyRestStatus`;
 *   - supports `If-None-Match`, so an unchanged resource costs a 304.
 *
 * Job logs answer with a redirect to a signed storage URL. The redirect is
 * followed by hand WITHOUT the Authorization header (the token never leaves
 * api.github.com), and the log is streamed in chunks under a byte cap.
 *
 * The token: `GH_TOKEN` / `GITHUB_TOKEN` (`resolveGitHubToken`), else
 * `gh auth token` once per run, killed after 10 s. A cloud VM holds no token
 * by design; the collector then reports "GitHub: not available on this node".
 * The token is never logged, returned or put in an error.
 */

export const API_ROOT = "https://api.github.com";
export const MIN_GAP_MS = 250;
export const MAX_CALLS_PER_RUN = 150;
export const STOP_BELOW_REMAINING = 1_500;
export const BACKOFF_MIN_MS = 60_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
const GH_TOKEN_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const USER_AGENT = "hapimatic-throughput";

export type StopReason = "budget" | "rate_limited" | "error";

export type GithubCallResult =
  | {
      kind: "ok";
      status: 200;
      body: unknown;
      etag: string | null;
      link: string | null;
    }
  | { kind: "not_modified"; status: 304; etag: string | null }
  | { kind: "not_found"; status: 404 }
  | { kind: "stopped"; reason: StopReason; detail: string };

/** One streamed text download (a job log), capped at `maxBytes`. */
export type StreamResult =
  | { kind: "ok"; bytes: number; truncated: boolean }
  /** 404 / 410: the resource is gone (an expired or deleted log). */
  | { kind: "gone" }
  /** The download failed after the API call (retry on a later run). */
  | { kind: "failed"; detail: string }
  | { kind: "stopped"; reason: StopReason; detail: string };

export interface GithubClientOptions {
  token: string;
  fetchImpl?: FetchImpl;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minGapMs?: number;
  maxCalls?: number;
  stopBelowRemaining?: number;
}

/** A `gh` runner whose child is killed after `timeoutMs`. */
export function ghRunnerWithKillTimer(timeoutMs: number): GhRunner {
  return async argv => {
    const proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  };
}

/** Resolve a token: env first, else `gh auth token` (killed after 10 s). */
export async function resolveCollectorToken(opts: {
  env?: Record<string, string | undefined>;
  runGh?: GhRunner;
  timeoutMs?: number;
}): Promise<string | null> {
  const fromEnv = resolveGitHubToken(opts.env ?? process.env);
  if (fromEnv) return fromEnv;
  const timeoutMs = opts.timeoutMs ?? GH_TOKEN_TIMEOUT_MS;
  const runGh = opts.runGh ?? ghRunnerWithKillTimer(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      runGh(["gh", "auth", "token"]),
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (!result || result.code !== 0) return null;
    const token = result.stdout.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null; // no gh binary, or it failed: GitHub not available here
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The `rel="next"` URL of a `Link` header, or null. */
export function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const [urlPart, ...params] = part.split(";");
    if (params.some(p => p.trim() === 'rel="next"')) {
      const url = urlPart?.trim();
      if (url && url.startsWith("<") && url.endsWith(">")) {
        return url.slice(1, -1);
      }
    }
  }
  return null;
}

/** The next backoff after a rate-limited run: 60 s doubling to 15 min. */
export function nextBackoffMs(previousMs: number | null): number {
  if (!previousMs || previousMs < BACKOFF_MIN_MS) return BACKOFF_MIN_MS;
  return Math.min(BACKOFF_MAX_MS, previousMs * 2);
}

type Stop = { kind: "stopped"; reason: StopReason; detail: string };

export class GithubClient {
  private calls = 0;
  private lastCallAt = 0;
  private remaining: number | null = null;
  private stopped: { reason: StopReason; detail: string } | null = null;
  /** When a rate-limited reply asked us to wait: the earliest retry time. */
  retryAtMs: number | null = null;
  private readonly fetchImpl: FetchImpl;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxCalls: number;
  private readonly stopBelow: number;

  constructor(private readonly opts: GithubClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep =
      opts.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.maxCalls = opts.maxCalls ?? MAX_CALLS_PER_RUN;
    this.stopBelow = opts.stopBelowRemaining ?? STOP_BELOW_REMAINING;
  }

  get callsMade(): number {
    return this.calls;
  }

  get remainingCalls(): number {
    return Math.max(0, this.maxCalls - this.calls);
  }

  get rateRemaining(): number | null {
    return this.remaining;
  }

  /** Why the client stopped (`reason: detail`), or null while it can run. */
  get stopReason(): string | null {
    return this.stopped
      ? `${this.stopped.reason}: ${this.stopped.detail}`
      : null;
  }

  get stopKind(): StopReason | null {
    return this.stopped?.reason ?? null;
  }

  /** Check the core rate limit before a run; false = stop now. */
  async checkRateLimit(): Promise<boolean> {
    const r = await this.get("/rate_limit");
    if (r.kind !== "ok") return false;
    const core = (
      r.body as {
        resources?: { core?: { remaining?: unknown; reset?: unknown } };
      } | null
    )?.resources?.core;
    const remaining =
      typeof core?.remaining === "number" ? core.remaining : null;
    if (remaining !== null) this.remaining = remaining;
    if (remaining !== null && remaining < this.stopBelow) {
      this.retryAtMs =
        typeof core?.reset === "number" ? core.reset * 1000 : null;
      this.stopped = {
        reason: "rate_limited",
        detail: `${remaining} calls left`,
      };
      return false;
    }
    return true;
  }

  /** GET `url` (absolute or `/path`), conditionally on `etag`. */
  async get(
    url: string,
    opts: { etag?: string | null; accept?: string } = {}
  ): Promise<GithubCallResult> {
    const headers = this.headers(opts.accept);
    if (opts.etag) headers["If-None-Match"] = opts.etag;
    const response = await this.send(url, headers, "follow");
    if (!(response instanceof Response)) return response;
    if (response.status === 304) {
      return {
        kind: "not_modified",
        status: 304,
        etag: response.headers.get("etag"),
      };
    }
    if (response.status === 404) return { kind: "not_found", status: 404 };
    const failure = this.failureOf(response);
    if (failure) return failure;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // A reset or truncated body (#6164 round 1, IR3). Returning "ok" with no
      // body read a list page as empty and complete, so a watermark or ETag
      // moved past data that was never stored. Stop like a network error.
      this.stopped = {
        reason: "error",
        detail: `response body unreadable (HTTP ${response.status})`,
      };
      return { kind: "stopped", ...this.stopped };
    }
    return {
      kind: "ok",
      status: 200,
      body,
      etag: response.headers.get("etag"),
      link: response.headers.get("link"),
    };
  }

  /**
   * Stream a text resource (a job log) to `onChunk`, keeping at most
   * `maxBytes`. GitHub answers a log request with a redirect to a signed
   * storage URL; that download carries no Authorization header. Counts as one
   * call.
   */
  async streamText(
    url: string,
    maxBytes: number,
    onChunk: (text: string) => void
  ): Promise<StreamResult> {
    const first = await this.send(url, this.headers(), "manual");
    if (!(first instanceof Response)) return first;
    if (first.status >= 300 && first.status < 400) {
      const location = first.headers.get("location");
      if (!location) return { kind: "failed", detail: "redirect without URL" };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
      try {
        const download = await this.fetchImpl(location, {
          headers: { "User-Agent": USER_AGENT },
          signal: controller.signal,
        });
        return await this.readCapped(download, maxBytes, onChunk);
      } catch (error) {
        return {
          kind: "failed",
          detail: error instanceof Error ? error.name : "download",
        };
      } finally {
        clearTimeout(timer);
      }
    }
    if (first.status === 404 || first.status === 410) return { kind: "gone" };
    const failure = this.failureOf(first);
    if (failure) return failure;
    try {
      return await this.readCapped(first, maxBytes, onChunk);
    } catch (error) {
      return {
        kind: "failed",
        detail: error instanceof Error ? error.name : "download",
      };
    }
  }

  /**
   * GET a paginated list, following `Link: rel="next"` until it ends, up to
   * `maxPages`. `complete` is false when the run stopped mid-list; `notFound`
   * is true when the list answered 404 (the URL names something that does not
   * exist, or that this token cannot read), which a retry will not change.
   */
  async getAllPages(
    url: string,
    opts: {
      maxPages?: number;
      until?: (page: unknown[]) => boolean;
      /** Pull the list out of an object-wrapped reply (Actions endpoints). */
      extract?: (body: unknown) => unknown[];
    } = {}
  ): Promise<{
    items: unknown[];
    complete: boolean;
    notFound: boolean;
    firstEtag: string | null;
  }> {
    const items: unknown[] = [];
    let next: string | null = url;
    let firstEtag: string | null = null;
    let pages = 0;
    while (next && pages < (opts.maxPages ?? 50)) {
      const r = await this.get(next);
      if (r.kind !== "ok") {
        return {
          items,
          complete: false,
          notFound: r.kind === "not_found",
          firstEtag,
        };
      }
      if (pages === 0) firstEtag = r.etag;
      pages += 1;
      const page = opts.extract
        ? opts.extract(r.body)
        : Array.isArray(r.body)
          ? r.body
          : [];
      items.push(...page);
      if (opts.until?.(page)) {
        return { items, complete: true, notFound: false, firstEtag };
      }
      next = nextLink(r.link);
    }
    return { items, complete: next === null, notFound: false, firstEtag };
  }

  private headers(accept?: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.token}`,
      Accept: accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    };
  }

  /**
   * One API request: budget, spacing, timeout and rate-limit bookkeeping.
   * Returns the response, or why the client stopped.
   */
  private async send(
    url: string,
    headers: Record<string, string>,
    redirect: "follow" | "manual"
  ): Promise<Response | Stop> {
    if (this.stopped) return { kind: "stopped", ...this.stopped };
    if (this.calls >= this.maxCalls) {
      this.stopped = {
        reason: "budget",
        detail: "call budget for this run used",
      };
      return { kind: "stopped", ...this.stopped };
    }
    const gap =
      (this.opts.minGapMs ?? MIN_GAP_MS) - (this.now() - this.lastCallAt);
    if (this.calls > 0 && gap > 0) await this.sleep(gap);
    this.calls += 1;
    this.lastCallAt = this.now();
    const abs = url.startsWith("https://") ? url : `${API_ROOT}${url}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(abs, {
        headers,
        redirect,
        signal: controller.signal,
      });
    } catch (error) {
      // Never surface the error text: a fetch rejection can embed the request.
      this.stopped = {
        reason: "error",
        detail: error instanceof Error ? error.name : "network",
      };
      return { kind: "stopped", ...this.stopped };
    } finally {
      clearTimeout(timer);
    }
    const remainingHeader = response.headers.get("x-ratelimit-remaining");
    const remaining = Number(remainingHeader);
    // The 1,500 floor guards the CORE limit every session shares; the search
    // API has its own small per-minute limit (stopped only by a 403 / 429).
    const resource = response.headers.get("x-ratelimit-resource") ?? "core";
    if (
      resource === "core" &&
      remainingHeader !== null &&
      Number.isFinite(remaining)
    ) {
      this.remaining = remaining;
      if (remaining < this.stopBelow && response.status < 400) {
        // Keep this reply, but make no further calls this run.
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        this.retryAtMs =
          Number.isFinite(reset) && reset > 0 ? reset * 1000 : null;
        this.stopped = {
          reason: "rate_limited",
          detail: `${remaining} calls left`,
        };
      }
    }
    return response;
  }

  /** A non-2xx (other than 304 / 404) as a stop, or null. */
  private failureOf(response: Response): Stop | null {
    const failure = classifyRestStatus(response);
    if (failure === null) return null;
    if (failure === "rate_limited") {
      const retryAfter = Number(response.headers.get("retry-after"));
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      this.retryAtMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? this.now() + retryAfter * 1000
          : Number.isFinite(reset) && reset > 0
            ? reset * 1000
            : null;
      this.stopped = {
        reason: "rate_limited",
        detail: `HTTP ${response.status}`,
      };
    } else {
      this.stopped = {
        reason: "error",
        detail: `${failure} (HTTP ${response.status})`,
      };
    }
    return { kind: "stopped", ...this.stopped };
  }

  private async readCapped(
    response: Response,
    maxBytes: number,
    onChunk: (text: string) => void
  ): Promise<StreamResult> {
    if (response.status === 404 || response.status === 410) {
      return { kind: "gone" };
    }
    if (!response.ok || !response.body) {
      return { kind: "failed", detail: `HTTP ${response.status}` };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let bytes = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes + value.byteLength > maxBytes) {
        const keep = value.subarray(0, maxBytes - bytes);
        bytes += keep.byteLength;
        onChunk(decoder.decode(keep, { stream: true }));
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      bytes += value.byteLength;
      onChunk(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) onChunk(tail);
    return { kind: "ok", bytes, truncated };
  }
}
