// SPDX-License-Identifier: AGPL-3.0-only
/**
 * System-health status helpers + types — the live, widely-consumed core extracted
 * from the (now deleted) `SystemHealthModal.tsx` (issue #3460). Pure domain logic
 * with no React/JSX dependency, so it lives in `lib/` (precedent:
 * `sessionHelpers.ts` / `gitParsers.ts`) — out of the design-token ratchet scan
 * scope (`web/src/components` + `web/src/routes`), so its `var(--status-sev-*)`
 * tokens (#3393) travel freely.
 *
 * `SystemHealthMetrics` is the web-side type. `web/src/api/client.ts`'s
 * `getSystemHealth()` inline return shape and `server/src/metrics/systemHealth.ts`'s
 * server interface carry independent, structurally-equal shapes by design — do not
 * import across them.
 */

/**
 * System health metrics from the backend API
 */
export interface SystemHealthMetrics {
  cpu: {
    usagePercent: number;
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
    // null when the server's /proc/meminfo swap collection FAILS (#1519);
    // distinct from a real 0% = "no swap configured". Rendered as "N/A".
    usagePercent: number | null;
  };
  disk: {
    total: number; // bytes
    used: number; // bytes
    // null when the server's `df` collection FAILS (#1519); distinct from a
    // real 0% reading. Rendered as "N/A".
    usagePercent: number | null;
    mountPoint: string;
  };
  hostname: string;
  timestamp: number;
  uptime: number; // seconds since system boot
}

/**
 * Health status levels for the status indicator dot
 */
export type HealthStatus = "green" | "yellow" | "orange" | "red" | "unknown";

/**
 * Status indicator colors
 *
 * The 4-tier health-severity palette (+ no-data gray), tokenized in #3393 as the
 * --status-sev-* family (nominal/elevated/high/critical/unknown) — a DISTINCT
 * vocabulary from the --status-ok/warn/hot triad (see web/src/design/tokens.css).
 * Values are byte-identical to the former literals (ruling D1 — zero color change).
 */
const statusColors: Record<HealthStatus, string> = {
  green: "var(--status-sev-nominal)", // All good (was #22c55e, #3393)
  yellow: "var(--status-sev-elevated)", // One param at/above 80% (was #eab308, #3393)
  orange: "var(--status-sev-high)", // One param above 90% (was #f97316, #3393)
  red: "var(--status-sev-critical)", // 3+ params above 90% (was #ef4444, #3393)
  unknown: "var(--status-sev-unknown)", // Gray when no data (was #6b7280, #3393)
};

/**
 * Calculate overall health status from metrics
 * Considers CPU usage, Memory, Disk, and CPU temperature.
 * Excludes Swap because Linux proactively uses swap even when memory
 * is available, so high swap usage is normal and not a problem indicator.
 *
 * Usage thresholds:
 * - Green: all params < 80%
 * - Yellow: 1 param ≥ 80%
 * - Orange: 1 param > 90%
 * - Red: all 3 usage params > 90%
 *
 * Temperature thresholds (Raspberry Pi 5):
 * - Green: < 158°F (70°C) - normal operation
 * - Yellow: ≥ 158°F (70°C) - thermal throttling begins
 * - Orange: ≥ 176°F (80°C) - critical, heavy throttling
 * - Red: ≥ 185°F (85°C) - approaching shutdown threshold
 */
export function calculateHealthStatus(
  metrics: SystemHealthMetrics | null
): HealthStatus {
  if (!metrics) return "unknown";

  // Check temperature first - can immediately indicate critical status
  const tempF = metrics.cpu.temperatureF;
  let tempStatus: HealthStatus = "green";
  if (tempF !== null) {
    if (tempF >= 185) tempStatus = "red";
    else if (tempF >= 176) tempStatus = "orange";
    else if (tempF >= 158) tempStatus = "yellow";
  }

  // Exclude swap - Linux keeps it high by design
  // disk.usagePercent is `number | null` (#1519): null = the collector FAILED.
  // Filter nulls out of the threshold math, but a failed collector must NOT
  // silently read as healthy — escalate the usage status below.
  const usageValues: Array<number | null> = [
    metrics.cpu.usagePercent,
    metrics.memory.usagePercent,
    metrics.disk.usagePercent,
  ];
  const collectorFailed = usageValues.some(v => v === null);
  const finiteValues = usageValues.filter(
    (v): v is number => v !== null && Number.isFinite(v)
  );

  const above90 = finiteValues.filter(v => v > 90).length;
  const at80OrAbove = finiteValues.filter(v => v >= 80).length;

  let usageStatus: HealthStatus = "green";
  if (above90 >= 3) usageStatus = "red";
  else if (above90 >= 1) usageStatus = "orange";
  else if (at80OrAbove >= 1) usageStatus = "yellow";

  // A failed resource collector (null) must surface (#1519): never let it pass
  // as green — escalate to at least "yellow" (warning).
  if (collectorFailed && usageStatus === "green") usageStatus = "yellow";

  // Return the worst status between temperature and usage
  const statusPriority: Record<HealthStatus, number> = {
    red: 4,
    orange: 3,
    yellow: 2,
    green: 1,
    unknown: 0,
  };

  return statusPriority[tempStatus] >= statusPriority[usageStatus]
    ? tempStatus
    : usageStatus;
}

/**
 * Get the color hex value for a health status
 */
export function getStatusColor(status: HealthStatus): string {
  return statusColors[status];
}

/**
 * Calculate status for an individual usage metric (CPU, Memory, Disk)
 * - Green: < 80%
 * - Yellow: ≥ 80%
 * - Orange: > 90%
 */
export function getUsageStatus(percent: number | null): HealthStatus {
  // null = the server-side collector FAILED (#1519). Report "unknown" — never
  // "green" — so a failed collector is not displayed as healthy.
  if (percent === null) return "unknown";
  if (percent > 90) return "orange";
  if (percent >= 80) return "yellow";
  return "green";
}

/**
 * Calculate status for CPU temperature
 * - Green: < 158°F (70°C)
 * - Yellow: ≥ 158°F - throttling begins
 * - Orange: ≥ 176°F - critical
 * - Red: ≥ 185°F - approaching shutdown
 */
export function getTemperatureStatus(tempF: number | null): HealthStatus {
  if (tempF === null) return "unknown";
  if (tempF >= 185) return "red";
  if (tempF >= 176) return "orange";
  if (tempF >= 158) return "yellow";
  return "green";
}
