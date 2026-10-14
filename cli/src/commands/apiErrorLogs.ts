// SPDX-License-Identifier: AGPL-3.0-only
import axios from "axios";
import chalk from "chalk";
import { configuration } from "@/configuration";
import { authenticateCli, cliApiTokenSourcesNote } from "./cliAuth";

// Local mirror of the server's StoredErrorLog shape (server/src/store/types.ts).
// The cli package cannot import server types across the package boundary, so the
// fields the formatter consumes are re-declared here. Severities are ordered
// debug < info < warn < error < fatal.
export type ErrorLogSeverity = "debug" | "info" | "warn" | "error" | "fatal";
export type ErrorLogSource = "server" | "client" | "cli";

export interface ErrorLogEntry {
  id: string;
  timestamp: number;
  severity: ErrorLogSeverity;
  category: string;
  source: ErrorLogSource;
  message: string;
  stack: string | null;
  sessionId: string | null;
  namespace: string | null;
  context: string | null;
  userAgent: string | null;
  requestPath: string | null;
  requestMethod: string | null;
  statusCode: number | null;
  originalTimestamp: number | null;
}

// High-signal default (R1): severity error/fatal OR category tool-error/uncaught-error.
// tool-error entries are 'warn' severity, so a severity-only filter misses them —
// hence the OR, expressed as a client-side multi-request merge (the server endpoint
// only supports single-value equality filters AND'd together).
const HIGH_SIGNAL_SEVERITIES: ErrorLogSeverity[] = ["error", "fatal"];
const HIGH_SIGNAL_CATEGORIES = ["tool-error", "uncaught-error"];
const VALID_SOURCES: ErrorLogSource[] = ["server", "client", "cli"];
const DEFAULT_SINCE = "7d";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500; // server clamps to this (server/src/web/routes/errorLogs.ts)

// ── Pure helpers (exported for unit tests — no network, no I/O) ──────────────

/**
 * Parse a single `<number><unit>` duration into milliseconds.
 * Units: s (seconds), m (minutes), h (hours), d (days). Returns undefined on
 * unparseable input. Examples: "7d" → 604800000, "30m" → 1800000.
 */
export function parseDuration(s: string): number | undefined {
  const m = s.trim().match(/^(\d+)([smhd])$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  switch (m[2]) {
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    default:
      return undefined;
  }
}

/**
 * Flatten N result batches, dedupe by entry id (first occurrence wins), sort by
 * timestamp descending, and slice to `limit`. Used to merge the parallel
 * high-signal requests into a single bounded, recent-first list.
 */
export function mergeHighSignal(
  batches: ErrorLogEntry[][],
  limit: number
): ErrorLogEntry[] {
  const byId = new Map<string, ErrorLogEntry>();
  for (const batch of batches) {
    for (const e of batch) {
      if (!byId.has(e.id)) byId.set(e.id, e);
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

// tool-error context shape — parity with parseToolErrorContext in
// web/src/components/ErrorLogViewer.tsx.
interface ToolErrorContext {
  toolName: string;
  toolUseId?: string;
  errorContent: string;
  input?: unknown;
}

function parseToolErrorContext(entry: ErrorLogEntry): ToolErrorContext | null {
  if (entry.category !== "tool-error" || !entry.context) return null;
  try {
    const parsed = JSON.parse(entry.context);
    if (typeof parsed.toolName !== "string") return null;
    return {
      toolName: parsed.toolName,
      toolUseId: parsed.toolUseId,
      errorContent: parsed.errorContent ?? "",
      input: parsed.input,
    };
  } catch {
    return null;
  }
}

function relTime(ms: number, now: number): string {
  const d = now - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

function sevColor(sev: ErrorLogSeverity): (s: string) => string {
  switch (sev) {
    case "fatal":
      return chalk.redBright;
    case "error":
      return chalk.red;
    case "warn":
      return chalk.yellow;
    case "info":
      return chalk.blue;
    case "debug":
      return chalk.gray;
  }
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

function paint(on: boolean, fn: (s: string) => string, s: string): string {
  return on ? fn(s) : s;
}

export interface FormatOptions {
  /** Reference "now" for relative timestamps (defaults to Date.now()). */
  now?: number;
  /** Apply ANSI color (defaults to false for deterministic, pipe-friendly output). */
  color?: boolean;
}

/**
 * Render entries for terminal reading. Two lines per entry: a header
 * (relTime / SEVERITY / category / [toolName] / message) and an indented
 * metadata line (session / source / request). tool-error rows also get a
 * short errorContent snippet. Mirrors the fields shown by ErrorLogViewer.tsx.
 */
export function formatEntries(
  entries: ErrorLogEntry[],
  opts: FormatOptions = {}
): string {
  const now = opts.now ?? Date.now();
  const color = opts.color ?? false;
  if (entries.length === 0) return "No matching error-log entries.";

  const lines: string[] = [];
  for (const e of entries) {
    const tool = parseToolErrorContext(e);
    const sev = paint(
      color,
      sevColor(e.severity),
      e.severity.toUpperCase().padEnd(5)
    );
    const toolTag = tool ? ` [${tool.toolName}]` : "";
    lines.push(
      `${relTime(e.timestamp, now).padStart(8)}  ${sev}  ${e.category}${toolTag}  ${truncate(e.message, 100)}`
    );

    const meta: string[] = [];
    if (e.sessionId) meta.push(`session: ${e.sessionId.slice(0, 8)}`);
    meta.push(`source: ${e.source}`);
    if (e.requestPath) {
      const status = e.statusCode != null ? ` → ${e.statusCode}` : "";
      meta.push(
        `req: ${e.requestMethod ?? ""} ${e.requestPath}${status}`.trim()
      );
    }
    lines.push(`          ${paint(color, chalk.gray, meta.join("  "))}`);

    if (tool && tool.errorContent) {
      lines.push(
        `          ${paint(color, chalk.gray, `↳ ${truncate(tool.errorContent, 120)}`)}`
      );
    }
  }
  return lines.join("\n");
}

/** Render the severity-count map (R3). Standard severities first, then any extras. */
export function formatStats(bySeverity: Record<string, number>): string {
  const order: ErrorLogSeverity[] = ["fatal", "error", "warn", "info", "debug"];
  const seen = new Set<string>();
  const lines = ["Error log severity breakdown (local instance):"];
  for (const sev of order) {
    lines.push(`  ${sev.padEnd(6)} ${bySeverity[sev] ?? 0}`);
    seen.add(sev);
  }
  for (const [k, v] of Object.entries(bySeverity)) {
    if (!seen.has(k)) lines.push(`  ${k.padEnd(6)} ${v}`);
  }
  const total = Object.values(bySeverity).reduce((a, b) => a + b, 0);
  lines.push(`  ${"total".padEnd(6)} ${total}`);
  return lines.join("\n");
}

// ── Network plumbing (mirrors handleSessions in api.ts) ──────────────────────

function authHeaders(jwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
  };
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

async function fetchEntries(
  jwt: string,
  params: Record<string, string | number>
): Promise<ErrorLogEntry[]> {
  const resp = await axios.get(`${configuration.serverUrl}/api/error-logs`, {
    headers: authHeaders(jwt),
    params,
    timeout: 15_000,
  });
  return (resp.data?.entries ?? []) as ErrorLogEntry[];
}

export function printErrorLogsHelp(): void {
  console.log(`
${chalk.bold("hapi api error-logs")} - Query the server error_logs table (debugging)

${chalk.bold("Usage:")}
  hapi api error-logs                      High-signal recent errors (default)
  hapi api error-logs --session <id>       Errors for one session
  hapi api error-logs --stats              Severity breakdown
  hapi api error-logs [filters] [--json]

${chalk.bold("Filters:")}
  --severity <debug|info|warn|error|fatal>   Exact severity match
  --category <name>                          Exact category (e.g. tool-error, api-error)
  --source <server|client|cli>               Originating layer
  --session <id>                             Session id (sessionId match)
  --since <dur>                              Time window: 7d, 24h, 30m, 90s
  --limit <n>                                Max rows (server caps at ${MAX_LIMIT})
  --stats                                    Severity-count summary
  --json                                     Raw JSON instead of formatted output

${chalk.bold("Default behavior (no filter flags):")}
  Returns only debugging-relevant entries — severity error/fatal OR category
  tool-error/uncaught-error — within the last ${DEFAULT_SINCE}, limit ${DEFAULT_LIMIT}.
  (tool-error entries are 'warn' severity, so a severity-only filter would miss them.)

${chalk.bold("Notes:")}
  - Queries the LOCAL instance only (${configuration.serverUrl}). error_logs is
    per-instance SQLite; federated/cross-node querying is not supported in this version.
  - ${cliApiTokenSourcesNote()}
`);
}

/**
 * `hapi api error-logs` handler. With no filter flags, runs the high-signal
 * default (R1). With explicit filters, runs a single filtered request. `--stats`
 * prints the severity breakdown; `--json` emits raw JSON instead of formatted text.
 */
export async function handleErrorLogs(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printErrorLogsHelp();
    return;
  }

  const json = args.includes("--json");

  // --stats mode (R3)
  if (args.includes("--stats")) {
    const jwt = await authenticateCli();
    const resp = await axios.get(
      `${configuration.serverUrl}/api/error-logs/stats`,
      {
        headers: authHeaders(jwt),
        timeout: 10_000,
      }
    );
    if (json) {
      console.log(JSON.stringify(resp.data, null, 2));
      return;
    }
    console.log(formatStats(resp.data?.bySeverity ?? {}));
    return;
  }

  const severity = parseFlag(args, "--severity");
  const category = parseFlag(args, "--category");
  const source = parseFlag(args, "--source");
  const session = parseFlag(args, "--session");
  const sinceRaw = parseFlag(args, "--since");
  const limitRaw = parseFlag(args, "--limit");

  if (source && !VALID_SOURCES.includes(source as ErrorLogSource)) {
    console.error(
      `Invalid --source '${source}'. Must be one of: ${VALID_SOURCES.join(", ")}.`
    );
    process.exit(1);
  }

  const limit = limitRaw
    ? Math.min(Math.max(1, Number(limitRaw) || DEFAULT_LIMIT), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const hasExplicitFilter = Boolean(severity || category || source || session);
  const jwt = await authenticateCli();
  let entries: ErrorLogEntry[];

  if (hasExplicitFilter) {
    // Explicit filters → single request, exactly what was asked, recent-first.
    const params: Record<string, string | number> = { limit };
    if (severity) params.severity = severity;
    if (category) params.category = category;
    if (source) params.source = source;
    if (session) params.sessionId = session;
    if (sinceRaw) {
      const ms = parseDuration(sinceRaw);
      if (ms === undefined) {
        console.error(
          `Invalid --since '${sinceRaw}'. Use forms like 7d, 24h, 30m, 90s.`
        );
        process.exit(1);
      }
      params.startTime = Date.now() - ms;
    }
    entries = await fetchEntries(jwt, params);
  } else {
    // Default high-signal multi-request merge (R1). Always windowed (default 7d).
    const sinceMs = parseDuration(sinceRaw ?? DEFAULT_SINCE);
    if (sinceMs === undefined) {
      console.error(
        `Invalid --since '${sinceRaw}'. Use forms like 7d, 24h, 30m, 90s.`
      );
      process.exit(1);
    }
    const startTime = Date.now() - sinceMs;
    const predicates: Array<Record<string, string>> = [
      ...HIGH_SIGNAL_SEVERITIES.map(s => ({ severity: s })),
      ...HIGH_SIGNAL_CATEGORIES.map(c => ({ category: c })),
    ];
    const batches = await Promise.all(
      predicates.map(p => fetchEntries(jwt, { ...p, startTime, limit }))
    );
    entries = mergeHighSignal(batches, limit);
  }

  if (json) {
    console.log(JSON.stringify({ entries, count: entries.length }, null, 2));
    return;
  }
  console.log(formatEntries(entries, { color: Boolean(process.stdout.isTTY) }));
  console.log("");
  console.log(
    chalk.gray(
      `${entries.length} entr${entries.length === 1 ? "y" : "ies"} (local instance: ${configuration.serverUrl})`
    )
  );
}
