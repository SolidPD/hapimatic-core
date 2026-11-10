#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * measure-telemetry-stall-v1 (issue #6516): does an Analytics page load block
 * the server's main thread?
 *
 * Polls `GET /api/version` every --poll-ms (a CPU-only route, so its latency
 * is the main thread's availability) while firing --loads concurrent Analytics
 * page loads, the nine GETs the page mounts, each load sampling its own `now`
 * as a separate viewer does. The five reads with a `now`-derived parameter do
 * not coalesce across loads; `files`, `duration-stats`, `outcome-rates` and
 * `anomalies` carry none, so concurrent loads share one job for each, and the
 * today refresh is single-flight per date. With --throughput it
 * also runs, concurrently, the C3 effort ladder's sequence (`/api/version`,
 * `/api/auth`, `throughput/summary`, then `throughput/issues?format=json`
 * paged to the end) and the weekly lane replay's `throughput/issues?format=csv`.
 *
 * Prints one JSON object (per-request times, /api/version p50/p99/max, and
 * pass/fail against the bounds) and exits 0 on pass, 1 on fail, 2 on a usage
 * or safety refusal.
 *
 * SAFETY: always run it against a worktree instance (ports 3010-3019) serving
 * a COPY of a telemetry.db: one Analytics load against a production hub stalls
 * that hub for every user, which is the bug this measures. The script refuses
 * ports 3008 and 3009, any port outside 3010-3019, and any non-loopback host.
 * It never prints the CLI token or the JWT.
 *
 * Usage:
 *   bun run server/scripts/measure-telemetry-stall-v1.ts --port 3011 \
 *     --settings <HAPI_HOME>/settings.json [--loads 3] [--throughput] \
 *     [--label S3] [--poll-ms 100] [--max-ms 500] [--p99-ms 250] \
 *     [--throughput-max-ms 1000] [--allow-busy] [--json-out <file>]
 */
import { readFileSync, writeFileSync } from "node:fs";

const SCRIPT = "measure-telemetry-stall-v1";
const DAY = 86_400_000;
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

interface Args {
  host: string;
  port: number;
  settings: string;
  loads: number;
  throughput: boolean;
  label: string;
  pollMs: number;
  maxMs: number;
  p99Ms: number;
  throughputMaxMs: number;
  allowBusy: boolean;
  jsonOut: string | null;
}

interface RequestRecord {
  group: string;
  name: string;
  status: number;
  ms: number;
  code?: string;
}

function refuse(message: string): never {
  console.error(`[${SCRIPT}] refused: ${message}`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const num = (flag: string, fallback: number): number => {
    const raw = value(flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0)
      refuse(`${flag} must be a positive number`);
    return n;
  };
  const host = value("--host") ?? "127.0.0.1";
  if (!ALLOWED_HOSTS.has(host)) refuse(`host ${host} is not loopback`);
  const port = num("--port", NaN);
  if (!Number.isInteger(port)) refuse("--port is required");
  if (port === 3008 || port === 3009) {
    refuse(
      `port ${port} is a production or dev hub; measure on a worktree port`
    );
  }
  if (port < 3010 || port > 3019) refuse(`port ${port} is outside 3010-3019`);
  const settings = value("--settings");
  if (!settings) refuse("--settings <path to settings.json> is required");
  return {
    host,
    port,
    settings,
    loads: num("--loads", 1),
    throughput: argv.includes("--throughput"),
    label: value("--label") ?? "run",
    pollMs: num("--poll-ms", 100),
    maxMs: num("--max-ms", 500),
    p99Ms: num("--p99-ms", 250),
    throughputMaxMs: num("--throughput-max-ms", 1000),
    allowBusy: argv.includes("--allow-busy"),
    jsonOut: value("--json-out") ?? null,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1
  );
  return sorted[Math.max(0, index)];
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const base = `http://${args.host.includes(":") ? `[${args.host}]` : args.host}:${args.port}`;
  console.error(
    `[${SCRIPT}] ${args.label}: ${base}, ${args.loads} load(s)${args.throughput ? " + throughput callers" : ""}`
  );

  let token: string;
  try {
    const parsed = JSON.parse(readFileSync(args.settings, "utf8")) as {
      cliApiToken?: unknown;
    };
    if (typeof parsed.cliApiToken !== "string" || !parsed.cliApiToken) {
      refuse("settings.json has no cliApiToken");
    }
    token = parsed.cliApiToken;
  } catch (err) {
    refuse(
      `cannot read ${args.settings}: ${err instanceof Error ? err.name : "error"}`
    );
  }

  const auth = async (): Promise<{ jwt: string; status: number }> => {
    const res = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessToken: token }),
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string };
    return { jwt: body.token ?? "", status: res.status };
  };
  const first = await auth();
  if (!first.jwt) refuse(`auth failed (HTTP ${first.status})`);
  const jwt = first.jwt;

  const records: RequestRecord[] = [];
  const timed = async (
    group: string,
    name: string,
    path: string,
    init: RequestInit = {}
  ): Promise<{ status: number; body: unknown; text: string }> => {
    const t0 = performance.now();
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${jwt}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(1_800_000),
    });
    const text = await res.text();
    const ms = performance.now() - t0;
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const code =
      body && typeof body === "object" && "code" in body
        ? String((body as { code: unknown }).code)
        : undefined;
    records.push({
      group,
      name,
      status: res.status,
      ms: round(ms),
      ...(code ? { code } : {}),
    });
    return { status: res.status, body, text };
  };

  // ── /api/version poller ──────────────────────────────
  const versionMs: number[] = [];
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const t0 = performance.now();
      try {
        await fetch(`${base}/api/version`, {
          signal: AbortSignal.timeout(600_000),
        });
        versionMs.push(performance.now() - t0);
      } catch {
        versionMs.push(performance.now() - t0);
      }
      const wait = args.pollMs - (performance.now() - t0);
      if (wait > 0) await Bun.sleep(wait);
    }
  })();
  await Bun.sleep(500);

  // ── Analytics page loads ──────────────────────────────
  const pageLoad = async (i: number): Promise<void> => {
    // Each viewer samples its own clock (analytics.tsx), so the five reads
    // with a `now`-derived parameter never share a key; the +i ms keeps that
    // true within one millisecond. The four without one still coalesce.
    const now = Date.now() + i;
    const startTime = now - 7 * DAY;
    const q = (p: Record<string, number | string>) =>
      new URLSearchParams(
        Object.entries(p).map(([k, v]): [string, string] => [k, String(v)])
      ).toString();
    const group = `load-${i + 1}`;
    await Promise.all([
      timed(group, "summary", `/api/telemetry/summary?${q({ startTime })}`),
      timed(
        group,
        "timeseries",
        `/api/telemetry/timeseries?${q({ interval: "day", startTime })}`
      ),
      timed(group, "files", "/api/telemetry/files"),
      timed(group, "duration-stats", "/api/telemetry/duration-stats"),
      timed(group, "outcome-rates", "/api/telemetry/outcome-rates"),
      timed(group, "anomalies", "/api/telemetry/anomalies"),
      timed(
        group,
        "token-estimates",
        `/api/telemetry/token-estimates?${q({ startTime })}`
      ),
      timed(
        group,
        "session-aggregates",
        `/api/telemetry/session-aggregates?${q({ startTime })}`
      ),
      timed(
        group,
        "comparison",
        `/api/telemetry/comparison?${q({
          period1Start: now - 14 * DAY,
          period1End: now - 7 * DAY,
          period2Start: now - 7 * DAY,
          period2End: now,
        })}`
      ),
    ]);
  };

  // ── Throughput callers (C3 effort ladder, weekly lane replay) ─────
  const ladder = async (): Promise<void> => {
    await timed("ladder", "version", "/api/version");
    const t0 = performance.now();
    const again = await auth();
    records.push({
      group: "ladder",
      name: "auth",
      status: again.status,
      ms: round(performance.now() - t0),
    });
    await timed(
      "ladder",
      "throughput-summary",
      "/api/telemetry/throughput/summary"
    );
    const to = Date.now();
    const from = to - 30 * DAY;
    let cursor = "";
    for (let page = 0; page < 500; page++) {
      const qs = `format=json&from=${from}&to=${to}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const { body } = await timed(
        "ladder",
        `issues-page-${page + 1}`,
        `/api/telemetry/throughput/issues?${qs}`
      );
      const next = (body as { nextCursor?: string | null } | null)?.nextCursor;
      if (!next) break;
      cursor = next;
    }
  };
  const replay = async (): Promise<void> => {
    await timed(
      "replay",
      "issues-csv",
      "/api/telemetry/throughput/issues?format=csv"
    );
  };

  const t0 = performance.now();
  await Promise.all([
    ...Array.from({ length: args.loads }, (_, i) => pageLoad(i)),
    ...(args.throughput ? [ladder(), replay()] : []),
  ]);
  const wallMs = performance.now() - t0;
  await Bun.sleep(500);
  polling = false;
  await poller;

  // ── Verdict ──────────────────────────────────────────
  const sorted = [...versionMs].sort((a, b) => a - b);
  const version = {
    samples: sorted.length,
    p50Ms: round(percentile(sorted, 50)),
    p99Ms: round(percentile(sorted, 99)),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
  };
  const telemetry = records.filter(r => r.group.startsWith("load-"));
  const throughput = records.filter(
    r => r.group === "ladder" || r.group === "replay"
  );
  const failures: string[] = [];
  if (version.maxMs > args.maxMs)
    failures.push(`/api/version max ${version.maxMs} ms > ${args.maxMs} ms`);
  if (version.p99Ms > args.p99Ms)
    failures.push(`/api/version p99 ${version.p99Ms} ms > ${args.p99Ms} ms`);
  for (const r of telemetry) {
    const busyOk =
      args.allowBusy && r.status === 503 && r.code === "telemetry_busy";
    if (r.status !== 200 && !busyOk)
      failures.push(
        `${r.group}/${r.name} HTTP ${r.status}${r.code ? ` ${r.code}` : ""}`
      );
  }
  for (const r of throughput) {
    if (r.status !== 200)
      failures.push(`${r.group}/${r.name} HTTP ${r.status}`);
    if (r.ms > args.throughputMaxMs)
      failures.push(
        `${r.group}/${r.name} ${r.ms} ms > ${args.throughputMaxMs} ms`
      );
  }

  const result = {
    script: SCRIPT,
    label: args.label,
    port: args.port,
    loads: args.loads,
    throughputCallers: args.throughput,
    wallMs: round(wallMs),
    version,
    bounds: {
      maxMs: args.maxMs,
      p99Ms: args.p99Ms,
      throughputMaxMs: args.throughputMaxMs,
    },
    pass: failures.length === 0,
    failures,
    requests: records,
  };
  const json = JSON.stringify(result, null, 2);
  if (args.jsonOut) writeFileSync(args.jsonOut, `${json}\n`);
  console.log(json);
  process.exit(result.pass ? 0 : 1);
}

await main();
