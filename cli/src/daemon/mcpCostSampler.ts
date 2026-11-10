// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6171: what each MCP server costs in memory on this node, for the New
 * Session picker.
 *
 * Every few maintenance ticks the daemon scans `/proc` with the orphan reaper's
 * helpers, finds each running MCP server's process tree that belongs to THIS
 * instance (the reaper's `HAPI_HOME` ownership check), and measures it. A tree is
 * the topmost process that runs the server (an `npm exec` wrapper, say) plus all
 * of its descendants. The process scan reads `stat` and `cmdline` like the
 * reaper's every-tick scan; the memory reads, the expensive part (the kernel walks
 * page tables for `smaps_rollup`), are async so they never block the event loop. A tree younger than two minutes is still starting and is
 * skipped. Memory is PSS + SwapPss from `smaps_rollup` (shared pages split fairly
 * between processes), or `RssAnon + VmSwap` from `status` when that is refused.
 * A tree with a Chromium-family descendant (a browser the server drives) is also
 * reported on its own, because it costs far more.
 *
 * argv and environ are read to classify processes and are never logged or sent:
 * either can hold a secret.
 */
import { readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { readFile as readFileAsync } from "fs/promises";
import { basename, isAbsolute, join } from "path";
import { isDenyableMcpName } from "@hapi/protocol";
import type { McpServerRamCost } from "@hapi/protocol/schemas";
import {
  mcpIdentityToken,
  normalizeArgv,
  normalizeHapiHome,
  readArgv,
  readEnvValue,
  readStat,
  type ProcFs,
} from "./orphanMcpReaper";

/** Sample on every Nth maintenance tick. */
export const MCP_COST_SAMPLE_EVERY_TICKS = 10;

/** A tree younger than this is still starting; its size is not yet typical. */
export const MCP_COST_MIN_TREE_AGE_SECONDS = 120;

/** Linux's USER_HZ, the unit of `/proc/<pid>/stat` starttime. */
const CLOCK_TICKS_PER_SECOND = 100;

const BROWSER_PROGRAMS = new Set([
  "chrome",
  "chromium",
  "chromium-browser",
  "google-chrome",
  "headless_shell",
  "chrome-headless-shell",
]);

/** A server as `claude mcp list` (or the config) names it, with its command. */
export interface McpServerCommand {
  name: string;
  /** The command text (`npx -y tavily-mcp`); an HTTP server's URL is skipped. */
  command: string;
}

export type McpRamSample = McpServerRamCost & { name: string };

/**
 * Programs whose name says nothing about which server they run: shells, exec
 * helpers and container runners. A process keyed by one could be any server.
 */
const GENERIC_PROGRAMS = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "env",
  "nohup",
  "setsid",
  "timeout",
  "stdbuf",
  "sudo",
  "docker",
  "podman",
]);

/** Script names many servers share (`node dist/index.js`, `python server.py`). */
const GENERIC_SCRIPT =
  /^(index|main|server|cli|app|run|start|__main__)\.(c?m?[jt]s|py)$/i;

/** Program and module names many servers share (`bin/server`, `-m app.main`). */
const GENERIC_NAME = /^(index|main|server|cli|app|run|start|__main__)$/i;

/**
 * The key that ties a process to a server: its program token's last path part,
 * without an `@version`. `npx -y tavily-mcp@latest`, `npm exec tavily-mcp` and
 * `node …/.bin/tavily-mcp` all give `tavily-mcp`. A scoped package spec keeps
 * its scope (`@playwright/mcp@latest` gives `@playwright/mcp`), so two scoped
 * packages named `mcp` stay apart.
 *
 * A key must name one server, because a wrong number is worse than "—" (#6171
 * review CLI-1): a shell or container program (`bash`, `docker`) has no key; a
 * python module whose last part is generic (`-m server`, `-m src.server`) has
 * none; and a generic script or binary (`index.js`, `bin/server`) is keyed by
 * its absolute path, or has no key when its path is relative.
 */
export function commandKey(argv: readonly string[]): string | null {
  const token = mcpIdentityToken(argv);
  if (!token) return null;
  const scoped = /^(@[^/@\s]+\/[^/@\s]+)(@[^/]*)?$/.exec(token);
  if (scoped) return scoped[1]!;
  const moduleFlag = argv.indexOf("-m");
  if (moduleFlag > 0 && argv[moduleFlag + 1] === token) {
    return GENERIC_NAME.test(token.split(".").at(-1) ?? token) ? null : token;
  }
  const base = basename(token).replace(/@[^@/]*$/, "");
  if (base.length === 0 || GENERIC_PROGRAMS.has(base)) return null;
  // Only an absolute path names one script or binary: `dist/index.js` is the
  // same key in every project that builds a server that way (delta review DS-1).
  if (GENERIC_SCRIPT.test(base) || GENERIC_NAME.test(base)) {
    return isAbsolute(token) ? token : null;
  }
  return base;
}

/**
 * The servers to look for: the last global `claude mcp list` (its `url` column
 * is a stdio server's command), plus the stdio servers in the user's
 * `~/.claude.json`, which cover the hour before the daemon's first poll.
 */
export function mcpServerCommands(
  polled: ReadonlyArray<{ name: string; url: string }>,
  configPath: string = join(homedir(), ".claude.json")
): McpServerCommand[] {
  const out: McpServerCommand[] = polled.map(server => ({
    name: server.name,
    command: server.url,
  }));
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers?: Record<string, { command?: unknown; args?: unknown }>;
    };
    for (const [name, entry] of Object.entries(config.mcpServers ?? {})) {
      if (typeof entry?.command !== "string") continue;
      const args = Array.isArray(entry.args)
        ? entry.args.filter((arg): arg is string => typeof arg === "string")
        : [];
      out.push({ name, command: [entry.command, ...args].join(" ") });
    }
  } catch {
    // No readable config: the poll's list is all there is.
  }
  return out;
}

/**
 * Server name by command key; HTTP/SSE servers have no local process. A key two
 * servers share is dropped: its processes cannot be told apart, so neither
 * server gets a number from them (#6171 review CLI-1).
 */
export function indexServerCommands(
  servers: readonly McpServerCommand[]
): Map<string, string> {
  const byKey = new Map<string, string>();
  const shared = new Set<string>();
  for (const server of servers) {
    const command = server.command.trim();
    if (!command || /^(https?|wss?):\/\//i.test(command)) continue;
    if (/\((HTTP|SSE)\)\s*$/.test(command)) continue;
    const key = commandKey(normalizeArgv(command.split(/\s+/)));
    if (!key) continue;
    const owner = byKey.get(key);
    if (owner === undefined) byKey.set(key, server.name);
    else if (owner !== server.name) shared.add(key);
  }
  for (const key of shared) byKey.delete(key);
  // A name the cost report cannot carry would get the whole batch refused
  // (delta review DS-3), so such a server gets no number. Dropped only after
  // the shared check, so its key still keeps another server's number honest.
  for (const [key, name] of byKey) {
    if (!isDenyableMcpName(name)) byKey.delete(key);
  }
  return byKey;
}

/** The kB value of one `Field:   123 kB` line, or 0. */
function readKb(text: string | null, field: string): number {
  if (!text) return 0;
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, "m").exec(text);
  return match ? Number(match[1]) : 0;
}

/** Reads a /proc file asynchronously; rejects when unreadable. */
export type AsyncProcRead = (path: string) => Promise<string>;

async function readAsync(
  read: AsyncProcRead,
  root: string,
  pid: number,
  name: string
): Promise<string | null> {
  try {
    return await read(join(root, String(pid), name));
  } catch {
    // Exited mid-sample, or refused (another user's process).
    return null;
  }
}

/** One process's memory in kB, or null when neither source is readable. */
export async function processMemoryKb(
  read: AsyncProcRead,
  root: string,
  pid: number
): Promise<number | null> {
  const rollup = await readAsync(read, root, pid, "smaps_rollup");
  if (rollup && /^Pss:/m.test(rollup)) {
    return readKb(rollup, "Pss") + readKb(rollup, "SwapPss");
  }
  const status = await readAsync(read, root, pid, "status");
  if (status && /^RssAnon:/m.test(status)) {
    return readKb(status, "RssAnon") + readKb(status, "VmSwap");
  }
  return null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function toMb(kb: number): number {
  return Math.round(kb / 1024);
}

export interface SampleMcpCostsOptions {
  /** This daemon's `configuration.happyHomeDir`. */
  ownHome: string;
  servers: readonly McpServerCommand[];
  procRoot?: string;
  platform?: NodeJS.Platform;
  readFile?: (path: string) => string;
  /** The memory reads; defaults to `fs/promises` `readFile`. */
  readFileAsync?: AsyncProcRead;
  now?: Date;
}

/**
 * Measure every owned MCP server tree once. Returns one row per server with at
 * least one measured tree; an empty list off Linux or when nothing runs.
 */
export async function sampleMcpCosts(
  options: SampleMcpCostsOptions
): Promise<McpRamSample[]> {
  if ((options.platform ?? process.platform) !== "linux") return [];
  const byKey = indexServerCommands(options.servers);
  if (byKey.size === 0) return [];
  const ownHome = normalizeHapiHome(options.ownHome);
  if (ownHome === null) return [];

  const fs: ProcFs = {
    root: options.procRoot ?? "/proc",
    readFile:
      options.readFile ??
      ((path: string): string => readFileSync(path, "utf8")),
  };
  const readMemory: AsyncProcRead =
    options.readFileAsync ??
    ((path: string): Promise<string> => readFileAsync(path, "utf8"));
  const uptimeSeconds = readUptime(fs);

  // One pass: parents, start times and which server each process runs.
  const parent = new Map<number, number>();
  const startTicks = new Map<number, number>();
  const children = new Map<number, number[]>();
  const serverOf = new Map<number, string>();
  const argvOf = new Map<number, readonly string[]>();
  let entries: string[];
  try {
    entries = readdirSync(fs.root);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const stat = readStat(fs, pid);
    if (!stat) continue;
    parent.set(pid, stat.ppid);
    startTicks.set(pid, Number(stat.startTime));
    const list = children.get(stat.ppid);
    if (list) list.push(pid);
    else children.set(stat.ppid, [pid]);
    const argv = readArgv(fs, pid);
    if (!argv) continue;
    argvOf.set(pid, argv);
    const key = commandKey(argv);
    const server = key ? byKey.get(key) : undefined;
    if (server) serverOf.set(pid, server);
  }

  const descendants = (root: number): number[] => {
    const out: number[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const pid = stack.pop()!;
      out.push(pid);
      for (const child of children.get(pid) ?? []) stack.push(child);
    }
    return out;
  };

  // Inside a tree: some ancestor runs the same server. The whole chain, not just
  // the parent, because a shell can sit between them (`npm exec` → `sh -c` →
  // `node`), which would otherwise count the inner process twice (CLI-3).
  const insideTree = (pid: number, server: string): boolean => {
    const seen = new Set<number>([pid]);
    let current = parent.get(pid);
    while (current !== undefined && current > 1 && !seen.has(current)) {
      if (serverOf.get(current) === server) return true;
      seen.add(current);
      current = parent.get(current);
    }
    return false;
  };

  const trees = new Map<string, Array<{ kb: number; browser: boolean }>>();
  for (const [pid, server] of serverOf) {
    // Topmost only: measure each tree from its top process.
    if (insideTree(pid, server)) continue;
    const home = normalizeHapiHome(readEnvValue(fs, pid, "HAPI_HOME"));
    if (home !== ownHome) continue;
    const started = startTicks.get(pid);
    if (
      started === undefined ||
      !Number.isFinite(uptimeSeconds) ||
      uptimeSeconds - started / CLOCK_TICKS_PER_SECOND <
        MCP_COST_MIN_TREE_AGE_SECONDS
    ) {
      continue;
    }
    let kb = 0;
    let measured = false;
    let browser = false;
    for (const member of descendants(pid)) {
      const memory = await processMemoryKb(readMemory, fs.root, member);
      if (memory !== null) {
        kb += memory;
        measured = true;
      }
      const program = argvOf.get(member)?.[0];
      if (program && BROWSER_PROGRAMS.has(basename(program))) browser = true;
    }
    if (!measured) continue;
    const list = trees.get(server);
    if (list) list.push({ kb, browser });
    else trees.set(server, [{ kb, browser }]);
  }

  const sampledAt = (options.now ?? new Date()).toISOString();
  const samples: McpRamSample[] = [];
  for (const [name, list] of trees) {
    const plain = list.filter(t => !t.browser).map(t => t.kb);
    const withBrowser = list.filter(t => t.browser).map(t => t.kb);
    const base = plain.length > 0 ? plain : withBrowser;
    samples.push({
      name,
      medianMb: toMb(median(base)),
      maxMb: toMb(Math.max(...list.map(t => t.kb))),
      instances: list.length,
      sampledAt,
      ...(withBrowser.length > 0 && plain.length > 0
        ? {
            withBrowser: {
              medianMb: toMb(median(withBrowser)),
              instances: withBrowser.length,
            },
          }
        : {}),
    });
  }
  return samples.sort((a, b) => a.name.localeCompare(b.name));
}

/** Seconds since boot, from `/proc/uptime`; NaN when unreadable. */
function readUptime(fs: ProcFs): number {
  try {
    const raw = fs.readFile(join(fs.root, "uptime"));
    return Number(raw.trim().split(/\s+/)[0]);
  } catch {
    return Number.NaN;
  }
}
