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
 *
 * Disk on WSL2 (#6775): a WSL2 distro's `/` lives in an `ext4.vhdx` file on a
 * Windows drive, so `/` alone read 16% on SL7 while its `C:` was 77% full.
 * `getDiskUsage()` there reports the worse of `/` and the Windows drive, with
 * that disk's mount point; every other node keeps its single `df -B1 /`.
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

/** The disk dimension of {@link SystemHealthMetrics}. */
export type DiskUsage = SystemHealthMetrics["disk"];

/** One successful `df -B1 <path>` reading. */
export interface DiskReading {
  total: number;
  used: number;
  usagePercent: number;
  mountPoint: string;
}

/** Test and caller options for {@link getDiskUsage} (#6775). */
export interface DiskUsageOptions {
  /** The kernel release; default `os.release()`. */
  release?: string;
  /** The text of `/proc/mounts`; default the file itself, read on a WSL2 kernel only. */
  mountsText?: string;
  /** The clock the Windows-drive cache ages on; default `Date.now()`. */
  now?: number;
  /** The limit of each `df` on a WSL2 node; default {@link WSL_DISK_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Each `df` on a WSL2 node is killed after this long (inside the hub's 8 s peer fetch). */
export const WSL_DISK_TIMEOUT_MS = 5000;
/** A Windows-drive read, failed or good, is reused for this long. */
export const WSL_HOST_DISK_CACHE_MS = 60_000;
/** After a failed Windows-drive read, the last good one is used while it is at most this old. */
export const WSL_HOST_DISK_LAST_GOOD_MS = 10 * 60_000;
/** A read whose pipe stays open past its kill (a grandchild, a stuck 9p call) is abandoned this much later. */
const DF_ABANDON_GRACE_MS = 1000;
const WSL_HOST_MOUNT_TYPES = new Set(["9p", "drvfs", "virtiofs"]);

type DfResult = { reading: DiskReading } | { reason: string };

/** `df -B1 <path>`; with a limit, killed (SIGKILL) at the limit and abandoned shortly after. */
async function readDfResult(
  path: string,
  timeoutMs?: number
): Promise<DfResult> {
  const work = (async (): Promise<DfResult> => {
    try {
      const proc = Bun.spawn(["df", "-B1", path], {
        stdout: "pipe",
        stderr: "pipe",
        ...(timeoutMs === undefined
          ? {}
          : { timeout: timeoutMs, killSignal: "SIGKILL" as const }),
      });
      // Read both pipes while waiting, so a full stderr pipe cannot stall df.
      const [output, errText, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        const detail = errText.trim().split("\n")[0]?.slice(0, 200) ?? "";
        return {
          reason: `exit ${String(exitCode)}${detail ? `: ${detail}` : ""}`,
        };
      }
      // Filesystem 1B-blocks Used Available Use% Mounted-on
      const lines = output.trim().split("\n");
      if (lines.length < 2) return { reason: "unexpected df output" };
      const parts = lines[1].trim().split(/\s+/);
      // Digits only: Number("") is 0 and parseInt("12x") is 12, and a NaN
      // total would serialize to null and fail the hub's z.number() (#6775).
      if (!/^\d+$/.test(parts[1] ?? "") || !/^\d+$/.test(parts[2] ?? "")) {
        return { reason: "non-numeric df total or used" };
      }
      const total = Number(parts[1]);
      const used = Number(parts[2]);
      if (!Number.isFinite(total) || !Number.isFinite(used)) {
        return { reason: "non-numeric df total or used" };
      }
      const usagePercent = total > 0 ? (used / total) * 100 : 0;
      // The mount point is everything after the Use% field, so one with a
      // blank in it (wslHostDriveMount decodes \040) is read whole.
      const mounted = /\s(?:\d+%|-)\s+(\S.*)$/.exec(lines[1].trim())?.[1];
      return {
        reading: {
          total,
          used,
          usagePercent,
          mountPoint: mounted ?? (parts[parts.length - 1] || path),
        },
      };
    } catch (err) {
      return { reason: `spawn failed: ${String(err)}` };
    }
  })();
  if (timeoutMs === undefined) return work;
  // The spawn limit kills df, but the read only ends when every writer has
  // closed its pipe; this keeps the worst case bounded either way.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abandon = new Promise<DfResult>(resolve => {
    timer = setTimeout(
      () => resolve({ reason: `no answer within ${timeoutMs} ms` }),
      timeoutMs + DF_ABANDON_GRACE_MS
    );
  });
  try {
    return await Promise.race([work, abandon]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One `df -B1 <path>` reading, or `null` when the spawn throws, df exits
 * non-zero, prints fewer than two lines or a non-numeric total or used, or
 * (with a limit) does not answer in time. `usagePercent` is unrounded.
 */
export async function readDf(
  path: string,
  timeoutMs?: number
): Promise<DiskReading | null> {
  const result = await readDfResult(path, timeoutMs);
  return "reading" in result ? result.reading : null;
}

/** True for a WSL2 kernel release (`…-microsoft-standard-WSL2…`), the one gate of #6775. */
export function isWsl2Kernel(release: string): boolean {
  return /-microsoft-standard-WSL2/.test(release);
}

/**
 * The mount point of a Windows drive in `/proc/mounts` text: the first line of
 * type 9p, drvfs or virtiofs whose source starts with `<letter>:` (any case;
 * `C:\134` and `N:` both match), with `\040`-style octal escapes undone.
 */
export function wslHostDriveMount(
  letter: string,
  mountsText: string
): string | null {
  const prefix = `${letter.toUpperCase()}:`;
  for (const line of mountsText.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    if (!WSL_HOST_MOUNT_TYPES.has(fields[2])) continue;
    if (!fields[0].toUpperCase().startsWith(prefix)) continue;
    return fields[1].replace(/\\([0-7]{3})/g, (_m, octal: string) =>
      String.fromCharCode(parseInt(octal, 8))
    );
  }
  return null;
}

interface HostDiskAttempt {
  at: number;
  key: string;
  result: DfResult;
}
let hostDiskAttempt: HostDiskAttempt | null = null;
let hostDiskInflight: { key: string; promise: Promise<DfResult> } | null = null;
let hostDiskLastGood: { at: number; key: string; reading: DiskReading } | null =
  null;
let hostDriveWarnedValue: string | null = null;

/** Test seam: forget the Windows-drive cache, the last good reading and the warning. */
export function resetHostDiskCacheForTest(): void {
  hostDiskAttempt = null;
  hostDiskInflight = null;
  hostDiskLastGood = null;
  hostDriveWarnedValue = null;
}

/** `HAPI_WSL_HOST_DRIVE` when it is one letter, else `C` (one warning per invalid value). */
function wslHostDriveLetter(): string {
  const raw = process.env.HAPI_WSL_HOST_DRIVE;
  if (raw === undefined || raw === "") return "C";
  if (/^[A-Za-z]$/.test(raw)) return raw.toUpperCase();
  if (hostDriveWarnedValue !== raw) {
    hostDriveWarnedValue = raw;
    console.warn(
      `[systemHealth] HAPI_WSL_HOST_DRIVE=${JSON.stringify(raw.slice(0, 20))} is not one letter A-Z; reading C:`
    );
  }
  return "C";
}

function readProcMounts(): string {
  try {
    return fs.readFileSync("/proc/mounts", "utf-8");
  } catch {
    return "";
  }
}

/** The Windows drive's reading through the 60 s cache; spawns at most one df per key at a time. */
function hostDiskResult(
  key: string,
  mount: string | null,
  now: number,
  timeoutMs: number
): { fresh: boolean; result: Promise<DfResult> } {
  const cached = hostDiskAttempt;
  if (
    cached &&
    cached.key === key &&
    now >= cached.at &&
    now - cached.at < WSL_HOST_DISK_CACHE_MS
  ) {
    return { fresh: false, result: Promise.resolve(cached.result) };
  }
  if (hostDiskInflight && hostDiskInflight.key === key) {
    return { fresh: false, result: hostDiskInflight.promise };
  }
  const promise: Promise<DfResult> = mount
    ? readDfResult(mount, timeoutMs)
    : Promise.resolve({ reason: "no mount line for the drive" });
  const inflight = { key, promise };
  hostDiskInflight = inflight;
  const settled = promise.then(result => {
    hostDiskAttempt = { at: now, key, result };
    if ("reading" in result) {
      hostDiskLastGood = { at: now, key, reading: result.reading };
    }
    if (hostDiskInflight === inflight) hostDiskInflight = null;
    return result;
  });
  return { fresh: true, result: settled };
}

function roundDisk(reading: DiskReading): DiskUsage {
  return {
    total: reading.total,
    used: reading.used,
    usagePercent: Math.round(reading.usagePercent * 10) / 10,
    mountPoint: reading.mountPoint,
  };
}

function failedDisk(mountPoint: string): DiskUsage {
  return { total: 0, used: 0, usagePercent: null, mountPoint };
}

/**
 * Disk usage for the health reading.
 *
 * Off WSL2: one `df -B1 /` with no spawn limit, exactly as before #6775 (a
 * limit would turn one slow spawn on a loaded node into a null, critical
 * reading). On a WSL2 node (#6775) the distro's `/` is a virtual disk inside a
 * file on a Windows drive, so `/` alone can read healthy while that drive is
 * full: `/` and the drive (`C:`, or `HAPI_WSL_HOST_DRIVE`) are read in
 * parallel, each killed at the limit, and the worse of the two is returned
 * with its own mount point. The drive's reading is cached 60 s, a failed read
 * as well as a good one; a failed read uses the last good reading while it is
 * at most 10 minutes old. Otherwise a failed read is `usagePercent: null`
 * (the hub shows it as critical), never a fall-back to `/`: `mountPoint` is
 * `/` when `/` failed, else the drive's mount point, else the drive letter
 * when no mount line exists for it.
 */
export async function getDiskUsage(
  opts: DiskUsageOptions = {}
): Promise<DiskUsage> {
  const release = opts.release ?? os.release();
  if (!isWsl2Kernel(release)) {
    const root = await readDfResult("/");
    if ("reading" in root) return roundDisk(root.reading);
    // `df` collection FAILED. Breadcrumb + usagePercent: null so the federation
    // health surface does NOT report `disk: 0%, healthy` for a broken collector
    // (#1519). total/used stay 0 (number) — only usagePercent nulls.
    console.error("[systemHealth] getDiskUsage failed (df /):", root.reason);
    return failedDisk("/");
  }

  const timeoutMs = opts.timeoutMs ?? WSL_DISK_TIMEOUT_MS;
  const now = opts.now ?? Date.now();
  const letter = wslHostDriveLetter();
  const mount = wslHostDriveMount(letter, opts.mountsText ?? readProcMounts());
  const key = mount ?? `${letter}:`;
  const host = hostDiskResult(key, mount, now, timeoutMs);
  const [root, hostResult] = await Promise.all([
    readDfResult("/", timeoutMs),
    host.result,
  ]);

  let hostReading: DiskReading | null = null;
  if ("reading" in hostResult) {
    hostReading = hostResult.reading;
  } else {
    const last = hostDiskLastGood;
    const usable =
      last !== null &&
      last.key === key &&
      now >= last.at &&
      now - last.at <= WSL_HOST_DISK_LAST_GOOD_MS;
    if (usable) hostReading = last.reading;
    if (host.fresh) {
      console.error(
        `[systemHealth] getDiskUsage failed (Windows drive ${letter}: at ${mount ?? "no mount line"}):`,
        hostResult.reason,
        usable ? "(using the last good reading)" : ""
      );
    }
  }

  if (!("reading" in root)) {
    console.error("[systemHealth] getDiskUsage failed (df /):", root.reason);
    return failedDisk("/");
  }
  if (!hostReading) return failedDisk(mount ?? `${letter}:`);
  return roundDisk(
    hostReading.usagePercent > root.reading.usagePercent
      ? hostReading
      : root.reading
  );
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
