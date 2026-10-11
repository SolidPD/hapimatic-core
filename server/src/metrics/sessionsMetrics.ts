// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/sessions latency metrics (#1032).
 *
 * Keeps a per-namespace ring buffer of recent response times so the
 * /api/sessions handler can emit `sessions-slow` warnings and the
 * /api/health endpoint can report a rolling p95 without any extra I/O.
 *
 * All state is process-local. Intentionally not persisted — this is a
 * server-lifetime observability signal, not a time-series log.
 */

const SAMPLE_CAPACITY = 200;

type NamespaceSamples = {
  /** Ring buffer of elapsed milliseconds. */
  readonly buffer: number[];
  /** Next write index. When size < capacity this equals size. */
  index: number;
  /** Number of samples written so far, capped at SAMPLE_CAPACITY. */
  size: number;
};

const samplesByNamespace = new Map<string, NamespaceSamples>();

function getOrCreate(namespace: string): NamespaceSamples {
  let entry = samplesByNamespace.get(namespace);
  if (!entry) {
    entry = {
      buffer: new Array<number>(SAMPLE_CAPACITY),
      index: 0,
      size: 0,
    };
    samplesByNamespace.set(namespace, entry);
  }
  return entry;
}

/** Record a single /api/sessions response time for a namespace. */
export function recordSessionsLatency(
  namespace: string,
  elapsedMs: number
): void {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
  const entry = getOrCreate(namespace);
  entry.buffer[entry.index] = elapsedMs;
  entry.index = (entry.index + 1) % SAMPLE_CAPACITY;
  if (entry.size < SAMPLE_CAPACITY) entry.size += 1;
}

/**
 * Returns the rolling p95 response time for a specific namespace (ms), or
 * null if no samples have been recorded.
 */
export function getSessionsP95Ms(namespace: string): number | null {
  const entry = samplesByNamespace.get(namespace);
  if (!entry || entry.size === 0) return null;
  return percentile(entry.buffer.slice(0, entry.size), 95);
}

/**
 * Global p95 across all namespaces — surfaced by /api/health for operational
 * monitoring. Picks the worst-performing namespace rather than averaging so
 * one slow namespace doesn't hide behind a healthy one.
 */
export function getGlobalSessionsP95Ms(): number | null {
  let worst: number | null = null;
  for (const [namespace] of samplesByNamespace) {
    const p95 = getSessionsP95Ms(namespace);
    if (p95 === null) continue;
    if (worst === null || p95 > worst) worst = p95;
  }
  return worst;
}

/** Clear all recorded samples. Test-only helper. */
export function resetSessionsMetricsForTesting(): void {
  samplesByNamespace.clear();
}

function percentile(samples: number[], pct: number): number {
  if (samples.length === 0) return 0;
  const sorted = samples.slice().sort((a, b) => a - b);
  // Nearest-rank p95 for small sample sets.
  const rank = Math.ceil((pct / 100) * sorted.length) - 1;
  const clamped = Math.max(0, Math.min(sorted.length - 1, rank));
  return sorted[clamped] ?? 0;
}
