// SPDX-License-Identifier: AGPL-3.0-only
/**
 * System health metric gathering (issue #1445).
 *
 * Extracted verbatim from `web/routes/health.ts` so two consumers can share a
 * single source of truth:
 *   1. the local JWT-gated `/api/system-health` route (web SystemHealthModal), and
 *   2. the federation-token-gated `/api/federation/node-metrics` peer endpoint
 *      that the hub's HealthAggregator polls (#1445 Task 7).
 *
 * The extraction itself changed no behavior. CPU sampling was reworked later
 * (#6156), below.
 *
 * CPU sampling (#6156): `calculateCpuUsage()` is shared by (a) the local
 * `/system-health` route, (b) the local `/federation/node-metrics` endpoint, and
 * (c) the in-process aggregator sample. It keeps a short ring of samples and
 * measures against the newest one that is 1 to 60 s old, so close calls share a
 * window and widely spaced pollers still get a reading. The `cpu-sampler` loop in
 * `server/src/index.ts` adds a sample every 5 s. With no usable window (the first
 * seconds after a start) the reading is `null`, never a fake `0`: before #6156 a
 * sample older than 10 s returned 0, so about half of ms1's federation samples
 * read `cpu=0` while the node was pegged.
 */
import * as os from "node:os";
import * as fs from "node:fs";
import { z } from "zod";

/**
 * System health metrics response structure.
 */
export interface SystemHealthMetrics {
  cpu: {
    // null when no 1-60 s sample window exists yet (#6156); never a fake 0.
    usagePercent: number | null;
    temperatureF: number | null; // Fahrenheit, null if unavailable
  };
  memory: {
    total: number; // bytes
    used: number; // bytes
    usagePercent: number;
  };
  swap: {
    total: number; // bytes
    used: number; // bytes
    // null when /proc/meminfo collection FAILS (distinct from a real 0% =
    // "no swap configured"); see getSwapUsage catch (#1519).
    usagePercent: number | null;
  };
  disk: {
    total: number; // bytes
    used: number; // bytes
    // null when `df` collection FAILS (distinct from a real 0% reading); a
    // failed collector must NOT classify as disk: healthy (#1519).
    usagePercent: number | null;
    mountPoint: string;
  };
  hostname: string;
  timestamp: number;
  uptime: number; // seconds since system boot
}

/**
 * Runtime validator for {@link SystemHealthMetrics}. Used by the hub's
 * `fetchPeerMetrics` to reject a malformed peer `node-metrics` payload instead
 * of casting it through `as SystemHealthMetrics` and reading garbage as
 * "healthy" (#1519). `swap`/`disk` `usagePercent` are `.nullable()` because
 * their collectors emit `null` on a collection failure (distinguishing failure
 * from a real 0% reading). `.passthrough()` tolerates forward-compatible field
 * additions from a newer peer (matches the `@hapi/protocol` forked-data convention).
 */
export const SystemHealthMetricsSchema = z
  .object({
    cpu: z.object({
      usagePercent: z.number().nullable(),
      temperatureF: z.number().nullable(),
    }),
    memory: z.object({
      total: z.number(),
      used: z.number(),
      usagePercent: z.number(),
    }),
    swap: z.object({
      total: z.number(),
      used: z.number(),
      usagePercent: z.number().nullable(),
    }),
    disk: z.object({
      total: z.number(),
      used: z.number(),
      usagePercent: z.number().nullable(),
      mountPoint: z.string(),
    }),
    hostname: z.string(),
    timestamp: z.number(),
    uptime: z.number(),
  })
  .passthrough();

/** A sample is usable as the start of a window once it is this old. */
export const CPU_SAMPLE_MIN_WINDOW_MS = 1000;
/** Samples older than this are dropped: a window this long says little about now. */
export const CPU_SAMPLE_MAX_WINDOW_MS = 60_000;
/** How often the `cpu-sampler` loop (`server/src/index.ts`) records a sample. */
export const CPU_SAMPLER_INTERVAL_MS = 5000;
const CPU_SAMPLE_RING_LIMIT = 64;

interface CpuSample {
  at: number;
  idle: number;
  total: number;
}

let cpuSamples: CpuSample[] = [];

function readCpuTimes(cpus: os.CpuInfo[]): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total +=
      cpu.times.user +
      cpu.times.nice +
      cpu.times.sys +
      cpu.times.idle +
      cpu.times.irq;
  }
  return { idle, total };
}

function pushCpuSample(sample: CpuSample): void {
  cpuSamples.push(sample);
  cpuSamples = cpuSamples
    .filter(s => sample.at - s.at <= CPU_SAMPLE_MAX_WINDOW_MS)
    .slice(-CPU_SAMPLE_RING_LIMIT);
}

/** Record one CPU sample (the `cpu-sampler` loop's tick). */
export function recordCpuSample(
  now: number = Date.now(),
  cpus: os.CpuInfo[] = os.cpus()
): void {
  pushCpuSample({ at: now, ...readCpuTimes(cpus) });
}

/**
 * CPU usage in percent over the window since the newest stored sample that is
 * 1 to 60 s old, or `null` when no such sample exists or the counters did not
 * move (#6156). Every call also stores its own sample.
 */
export function calculateCpuUsage(
  now: number = Date.now(),
  cpus: os.CpuInfo[] = os.cpus()
): number | null {
  const current = { at: now, ...readCpuTimes(cpus) };
  let base: CpuSample | null = null;
  for (let i = cpuSamples.length - 1; i >= 0; i--) {
    const age = now - cpuSamples[i].at;
    if (age >= CPU_SAMPLE_MIN_WINDOW_MS && age <= CPU_SAMPLE_MAX_WINDOW_MS) {
      base = cpuSamples[i];
      break;
    }
  }
  pushCpuSample(current);
  if (!base) return null;

  const idleDelta = current.idle - base.idle;
  const totalDelta = current.total - base.total;
  if (totalDelta <= 0) return null;

  // CPU usage = (total - idle) / total * 100
  const usagePercent = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.max(0, Math.min(100, usagePercent));
}

/** Test seam: forget every stored CPU sample. */
export function resetCpuSamplesForTest(): void {
  cpuSamples = [];
}

/**
 * Get CPU temperature from thermal zone (Linux/Raspberry Pi)
 * Returns temperature in Fahrenheit, or null if unavailable
 */
export async function getCpuTemperature(): Promise<number | null> {
  try {
    // Standard Linux thermal zone path (works on Raspberry Pi)
    const tempStr = await fs.promises.readFile(
      "/sys/class/thermal/thermal_zone0/temp",
      "utf-8"
    );
    const tempMilliC = parseInt(tempStr.trim(), 10);

    if (isNaN(tempMilliC)) return null;

    // Convert from millidegrees Celsius to Fahrenheit
    const tempC = tempMilliC / 1000;
    const tempF = (tempC * 9) / 5 + 32;

    // Round to 1 decimal place
    return Math.round(tempF * 10) / 10;
  } catch {
    // Thermal zone not available (not Linux or different hardware)
    return null;
  }
}

/**
 * Get memory usage by reading MemAvailable from /proc/meminfo (Linux).
 * Bun's os.freemem() returns MemFree which excludes buffers/cache,
 * resulting in inflated usage percentages. MemAvailable gives the
 * actual memory available to applications.
 * Falls back to os.freemem() on non-Linux systems.
 */
export function getMemoryUsage(): {
  total: number;
  used: number;
  usagePercent: number;
} {
  const total = os.totalmem();

  // Read MemAvailable directly from /proc/meminfo (Linux only)
  // This gives us the actual available memory, not just free memory
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf-8");
    for (const line of meminfo.split("\n")) {
      if (line.startsWith("MemAvailable:")) {
        // Value is in kB, convert to bytes
        const availableKb = parseInt(line.split(/\s+/)[1], 10);
        const available = availableKb * 1024;
        const used = total - available;
        return {
          total,
          used,
          usagePercent: Math.round((used / total) * 100 * 10) / 10,
        };
      }
    }
  } catch (err) {
    // /proc/meminfo read failed — log the degrade to os.freemem(). os.freemem()
    // always yields a real number, so the return below stays a number (NOT
    // nulled): this is a degrade, not a failure (#1519).
    console.error(
      "[systemHealth] getMemoryUsage /proc/meminfo read failed; falling back to os.freemem():",
      err
    );
  }

  // Fallback (non-Linux or error reading /proc/meminfo)
  const free = os.freemem();
  const used = total - free;
  const usagePercent = (used / total) * 100;

  return {
    total,
    used,
    usagePercent: Math.round(usagePercent * 10) / 10,
  };
}

/**
 * Get swap usage by parsing /proc/meminfo (Linux only)
 */
export function getSwapUsage(): {
  total: number;
  used: number;
  usagePercent: number | null;
} {
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf-8");

    let swapTotal = 0;
    let swapFree = 0;

    for (const line of meminfo.split("\n")) {
      if (line.startsWith("SwapTotal:")) {
        // Value is in kB
        swapTotal = parseInt(line.split(/\s+/)[1], 10) * 1024;
      } else if (line.startsWith("SwapFree:")) {
        swapFree = parseInt(line.split(/\s+/)[1], 10) * 1024;
      }
    }

    const swapUsed = swapTotal - swapFree;
    const usagePercent = swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0;

    return {
      total: swapTotal,
      used: swapUsed,
      usagePercent: Math.round(usagePercent * 10) / 10,
    };
  } catch (err) {
    // Collection FAILED (distinct from the legitimate no-swap 0% path above).
    // Breadcrumb + usagePercent: null so failure is distinguishable from
    // "no swap configured" (#1519).
    console.error("[systemHealth] getSwapUsage failed (/proc/meminfo):", err);
    return { total: 0, used: 0, usagePercent: null };
  }
}

/**
 * Get disk usage for root partition using df (Bun.spawn).
 */
export async function getDiskUsage(): Promise<{
  total: number;
  used: number;
  usagePercent: number | null;
  mountPoint: string;
}> {
  try {
    // Use Bun.spawn to run df command (more reliable than statfs for mounted filesystems)
    const proc = Bun.spawn(["df", "-B1", "/"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    // Parse df output: Filesystem 1B-blocks Used Available Use% Mounted
    const lines = output.trim().split("\n");
    if (lines.length < 2) {
      throw new Error("Unexpected df output");
    }

    // Skip header, parse data line
    const parts = lines[1].split(/\s+/);
    // parts: [Filesystem, 1B-blocks, Used, Available, Use%, Mounted]
    const total = parseInt(parts[1], 10);
    const used = parseInt(parts[2], 10);
    const mountPoint = parts[5] || "/";

    const usagePercent = total > 0 ? (used / total) * 100 : 0;

    return {
      total,
      used,
      usagePercent: Math.round(usagePercent * 10) / 10,
      mountPoint,
    };
  } catch (err) {
    // `df` collection FAILED (ENOENT / non-zero exit / unparseable output).
    // Breadcrumb + usagePercent: null so the federation health surface does NOT
    // report `disk: 0%, healthy` for a broken collector (#1519). total/used
    // stay 0 (number) — only usagePercent nulls.
    console.error("[systemHealth] getDiskUsage failed (df):", err);
    return { total: 0, used: 0, usagePercent: null, mountPoint: "/" };
  }
}

/** A CPU percentage to one decimal; null stays null (no reading, not idle). */
function roundCpuPercent(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

/**
 * Compose the full system-health metrics object — the same object the
 * `/api/system-health` route returns today. Single source of truth for both
 * the local route and the peer-facing `/api/federation/node-metrics` endpoint.
 */

export async function gatherSystemHealth(): Promise<SystemHealthMetrics> {
  return {
    cpu: {
      usagePercent: roundCpuPercent(calculateCpuUsage()),
      temperatureF: await getCpuTemperature(),
    },
    memory: getMemoryUsage(),
    swap: getSwapUsage(),
    disk: await getDiskUsage(),
    hostname: os.hostname(),
    timestamp: Date.now(),
    uptime: Math.floor(os.uptime()), // seconds since boot
  };
}
