// SPDX-License-Identifier: AGPL-3.0-only
import {
  RELEASE_HEALTH_EXCLUDED_CATEGORIES,
  RELEASE_HEALTH_SOURCE_CLASSES,
  RELEASE_HEALTH_THRESHOLDS,
  RETENTION_WINDOW_DAYS,
  SupervisedLoop,
  utcDayOf,
  type JobFailureEvent,
  type JobRegistry,
  type ReleaseHealthComparison,
  type ReleaseHealthSourceClass,
  type ReleaseHealthThresholds,
  type ReleaseHealthVersion,
  type ThroughputReleaseHealthResponse,
} from "@hapi/protocol";
import type {
  ErrorMinuteGroup,
  ReleaseHealthStore,
  VersionSegment,
} from "../store/throughput/releaseHealthStore";

/**
 * Release health (issue #6173, D3 — R1, R2, R3): how a version behaved on this
 * node, read by the release train's gate (`scripts/release-train-v1.sh`) on the
 * dev hub and on prod.
 *
 * Per version: uptime, unclean restarts, flood events, and per source class the
 * error-minutes per uptime hour. Error-MINUTES, not row counts, because
 * `ErrorLogger` caps each category at 10 rows plus one summary a minute
 * (`server/src/logging/errorLogger.ts`), so a row count saturates in a flood and
 * the summary's `droppedCount` is always 1. A version is attributed its rows by
 * time: a crashed segment owns them to its last touch plus
 * `RELEASE_HEALTH_TOUCH_MS` and `RELEASE_HEALTH_SHUTDOWN_GRACE_MS`, so the rows
 * logged just before a crash still land on the version that crashed; a cleanly
 * stopped one owns them to its close plus the grace; the live one, to now. No
 * span runs past the next segment's start, and rows in no span are reported as
 * unattributed. The policy is pure (`computeReleaseHealth`,
 * `compareReleaseHealth`); the loop and the service only read and write the
 * store.
 */

export const RELEASE_HEALTH_LOOP_NAME = "throughput-release-health";
/** How often the live segment's last-seen time moves forward. */
export const RELEASE_HEALTH_TOUCH_MS = 5 * 60_000;
/**
 * How long past a segment's close (or, for a crash, past its last touch plus
 * `RELEASE_HEALTH_TOUCH_MS`) its rows still belong to it: the rows a run logs
 * while it shuts down. A next run's boot rows inside it land here too (see the
 * distortions in throughput-metrics.md).
 */
export const RELEASE_HEALTH_SHUTDOWN_GRACE_MS = 60_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const EXCLUDED: ReadonlySet<string> = new Set(
  RELEASE_HEALTH_EXCLUDED_CATEGORIES
);
const CLASSES: readonly string[] = RELEASE_HEALTH_SOURCE_CLASSES;

/** The segment this server process opened at boot. */
export interface LiveSegment {
  version: string;
  startedMs: number;
}

/** Whether a group of rows counts against a release (R2's row rules). */
export function isCountedGroup(
  group: ErrorMinuteGroup
): group is ErrorMinuteGroup & { source: ReleaseHealthSourceClass } {
  return (
    !group.replayed &&
    !EXCLUDED.has(group.category) &&
    CLASSES.includes(group.source)
  );
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

type ByClass<T> = Record<ReleaseHealthSourceClass, T>;

/** A time range whose rows belong to `version` (`findSpan` has the end rule). */
interface Span {
  start: number;
  end: number;
  version: string;
}

interface VersionAcc {
  version: string;
  live: boolean;
  segments: number;
  firstStartedMs: number;
  lastSeenMs: number;
  uptimeMs: number;
  unclean: number;
  floods: number;
  minutes: ByClass<Set<number>>;
}

/**
 * Health per version over `[sinceMs, nowMs]`, oldest version first, plus the
 * count of counted error-minutes that fall in no segment.
 */
export function computeReleaseHealth(
  segments: readonly VersionSegment[],
  groups: readonly ErrorMinuteGroup[],
  opts: { sinceMs: number; nowMs: number; live: LiveSegment | null }
): { versions: ReleaseHealthVersion[]; unattributedErrorMinutes: number } {
  const { sinceMs, nowMs, live } = opts;
  const segs = [...segments].sort(
    (a, b) => a.startedMs - b.startedMs || (a.version < b.version ? -1 : 1)
  );
  const acc = new Map<string, VersionAcc>();
  const spans: Span[] = [];

  segs.forEach((seg, i) => {
    const next = segs[i + 1];
    const isLive =
      live !== null &&
      seg.version === live.version &&
      seg.startedMs === live.startedMs;
    const observedEnd = Math.min(
      isLive ? Math.max(seg.lastSeenMs, nowMs) : seg.lastSeenMs,
      nowMs
    );
    let a = acc.get(seg.version);
    if (!a) {
      a = {
        version: seg.version,
        live: false,
        segments: 0,
        firstStartedMs: seg.startedMs,
        lastSeenMs: observedEnd,
        uptimeMs: 0,
        unclean: 0,
        floods: 0,
        minutes: { server: new Set(), cli: new Set(), client: new Set() },
      };
      acc.set(seg.version, a);
    }
    a.segments += 1;
    a.live ||= isLive;
    a.firstStartedMs = Math.min(a.firstStartedMs, seg.startedMs);
    a.lastSeenMs = Math.max(a.lastSeenMs, observedEnd);
    a.uptimeMs += Math.max(0, observedEnd - Math.max(seg.startedMs, sinceMs));
    // A segment left open and followed by the same version: the process died
    // without a graceful stop (a crash, an OOM kill, a power loss) and came back.
    if (!seg.cleanStop && next && next.version === seg.version) a.unclean += 1;
    // A crashed run owns its rows to one touch interval plus the shutdown grace
    // past its last touch: it died before its next touch, so its own last rows
    // fall in that tail. A cleanly stopped run owns them to its close plus the
    // grace. Neither runs past the next segment's start, and rows after the
    // tail (a run with no segment of its own: the kill switch was on, or its
    // open failed) are reported as unattributed, never charged to this version.
    const tail = seg.cleanStop
      ? RELEASE_HEALTH_SHUTDOWN_GRACE_MS
      : RELEASE_HEALTH_TOUCH_MS + RELEASE_HEALTH_SHUTDOWN_GRACE_MS;
    const nextStart = next ? next.startedMs : Number.POSITIVE_INFINITY;
    const end = isLive
      ? Math.min(observedEnd, nextStart)
      : Math.min(seg.lastSeenMs + tail, nextStart);
    spans.push({ start: seg.startedMs, end, version: seg.version });
  });

  const unattributed = new Set<number>();
  for (const g of groups) {
    if (!isCountedGroup(g)) continue;
    if (g.firstMs < sinceMs || g.firstMs > nowMs) continue;
    const span = findSpan(spans, g.firstMs);
    if (!span) {
      unattributed.add(g.minuteMs);
      continue;
    }
    const a = acc.get(span.version)!;
    a.minutes[g.source].add(g.minuteMs);
    a.floods += g.floods;
  }

  const versions = [...acc.values()]
    .sort((x, y) => x.firstStartedMs - y.firstStartedMs)
    .map(toVersion);
  return { versions, unattributedErrorMinutes: unattributed.size };
}

/** The span holding `ts`; the last span includes its end. */
function findSpan(spans: readonly Span[], ts: number): Span | null {
  let lo = 0;
  let hi = spans.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid]!.start <= ts) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  const span = spans[found]!;
  const last = found === spans.length - 1;
  return ts < span.end || (last && ts <= span.end) ? span : null;
}

function toVersion(a: VersionAcc): ReleaseHealthVersion {
  const uptimeHours = a.uptimeMs / HOUR_MS;
  const perDay = (n: number) => (uptimeHours > 0 ? n / (uptimeHours / 24) : 0);
  const perHour = (n: number) => (uptimeHours > 0 ? n / uptimeHours : 0);
  const minutes = {
    server: a.minutes.server.size,
    cli: a.minutes.cli.size,
    client: a.minutes.client.size,
  };
  return {
    version: a.version,
    live: a.live,
    segments: a.segments,
    firstStartedMs: a.firstStartedMs,
    lastSeenMs: a.lastSeenMs,
    uptimeHours: round4(uptimeHours),
    uncleanRestarts: a.unclean,
    uncleanRestartsPerDay: round4(perDay(a.unclean)),
    floodEvents: a.floods,
    floodEventsPerDay: round4(perDay(a.floods)),
    errorMinutes: minutes,
    errorMinutesPerHour: {
      server: round4(perHour(minutes.server)),
      cli: round4(perHour(minutes.cli)),
      client: round4(perHour(minutes.client)),
    },
  };
}

/**
 * The candidate-vs-baseline verdict (R3, thresholds from Matt's M5).
 * `insufficient-data` when either side is under the uptime floor; `rise` when
 * unclean restarts or flood events per day exceed the baseline's, or a source
 * class's error-minutes per hour exceed `riseFactor` times the baseline's AND
 * the excess over the candidate's uptime is at least `minExcessErrorMinutes`.
 */
export function compareReleaseHealth(
  versions: readonly ReleaseHealthVersion[],
  candidate: string,
  baseline: string,
  t: ReleaseHealthThresholds = RELEASE_HEALTH_THRESHOLDS
): ReleaseHealthComparison {
  const cand = versions.find(v => v.version === candidate);
  const base = versions.find(v => v.version === baseline);
  const short = (v: ReleaseHealthVersion | undefined, label: string) => {
    if (!v) return `${label} has no recorded run on this node in the window`;
    if (v.uptimeHours < t.minUptimeHours) {
      const crashes =
        v.uncleanRestarts > 0
          ? `, with ${v.uncleanRestarts} unclean restart(s)`
          : "";
      return `${label} has ${v.uptimeHours.toFixed(2)} h of uptime on this node (floor ${t.minUptimeHours} h)${crashes}`;
    }
    return null;
  };
  const cShort = short(cand, `candidate ${candidate}`);
  const bShort = short(base, `baseline ${baseline}`);
  if (cShort || bShort) {
    return {
      candidate,
      baseline,
      verdict: "insufficient-data",
      insufficient:
        cShort && bShort ? "both" : cShort ? "candidate" : "baseline",
      reasons: [cShort, bShort].filter((r): r is string => r !== null),
    };
  }
  const c = cand!;
  const b = base!;
  const rises: string[] = [];
  if (c.uncleanRestartsPerDay > b.uncleanRestartsPerDay) {
    rises.push(
      `unclean restarts ${c.uncleanRestartsPerDay}/day exceed the baseline's ${b.uncleanRestartsPerDay}/day`
    );
  }
  if (c.floodEventsPerDay > b.floodEventsPerDay) {
    rises.push(
      `flood events ${c.floodEventsPerDay}/day exceed the baseline's ${b.floodEventsPerDay}/day`
    );
  }
  for (const cls of RELEASE_HEALTH_SOURCE_CLASSES) {
    // From the raw counts, not the rounded per-hour rates, so a borderline
    // excess cannot round across the threshold.
    const cr = c.errorMinutes[cls] / c.uptimeHours;
    const br = b.errorMinutes[cls] / b.uptimeHours;
    const excess = c.errorMinutes[cls] - br * c.uptimeHours;
    if (cr > t.riseFactor * br && excess >= t.minExcessErrorMinutes) {
      rises.push(
        `${cls} error-minutes ${round4(cr)}/h exceed ${t.riseFactor}x the baseline's ${round4(br)}/h, ${round4(excess)} more over ${c.uptimeHours} h`
      );
    }
  }
  if (rises.length > 0) {
    return {
      candidate,
      baseline,
      verdict: "rise",
      insufficient: null,
      reasons: rises,
    };
  }
  const rate = (v: ReleaseHealthVersion) =>
    RELEASE_HEALTH_SOURCE_CLASSES.map(
      k => `${k} ${v.errorMinutesPerHour[k]}`
    ).join(", ");
  return {
    candidate,
    baseline,
    verdict: "no-rise",
    insufficient: null,
    reasons: [
      `no threshold crossed: restarts/day ${c.uncleanRestartsPerDay} vs ${b.uncleanRestartsPerDay}, floods/day ${c.floodEventsPerDay} vs ${b.floodEventsPerDay}, error-minutes/h (${rate(c)}) vs (${rate(b)})`,
    ],
  };
}

/** Reads the store and answers the route (R2, R3). */
export class ReleaseHealthService {
  private readonly now: () => number;
  private readonly thresholds: ReleaseHealthThresholds;

  constructor(
    private readonly opts: {
      store: ReleaseHealthStore;
      nodeVersion: string;
      live: () => LiveSegment | null;
      thresholds?: ReleaseHealthThresholds;
      now?: () => number;
    }
  ) {
    this.now = opts.now ?? Date.now;
    this.thresholds = opts.thresholds ?? { ...RELEASE_HEALTH_THRESHOLDS };
  }

  /**
   * The error rows are read one day at a time, yielding to the event loop
   * between days: the read is synchronous, and a flood day alone measured about
   * a second of CPU, so one read of a flooded 30-day window could stall every
   * socket on the node. Splitting is lossless: minutes are de-duplicated in
   * `computeReleaseHealth` and flood counts sum.
   */
  async report(query: {
    sinceDays: number;
    candidate?: string;
    baseline?: string;
  }): Promise<ThroughputReleaseHealthResponse> {
    const nowMs = this.now();
    const sinceMs = nowMs - query.sinceDays * DAY_MS;
    const groups: ErrorMinuteGroup[] = [];
    for (let from = sinceMs; from <= nowMs; from += DAY_MS) {
      const to = Math.min(from + DAY_MS - 1, nowMs);
      for (const g of this.opts.store.errorMinutes(from, to)) groups.push(g);
      if (to < nowMs) await new Promise(resolve => setTimeout(resolve, 0));
    }
    const { versions, unattributedErrorMinutes } = computeReleaseHealth(
      this.opts.store.listSegments(sinceMs),
      groups,
      { sinceMs, nowMs, live: this.opts.live() }
    );
    const comparison =
      query.candidate && query.baseline
        ? compareReleaseHealth(
            versions,
            query.candidate,
            query.baseline,
            this.thresholds
          )
        : null;
    return {
      generatedAtMs: nowMs,
      sinceMs,
      nodeVersion: this.opts.nodeVersion,
      versions,
      unattributedErrorMinutes,
      thresholds: { ...this.thresholds },
      comparison,
    };
  }
}

/**
 * The `throughput-release-health` loop: moves the live segment's last-seen time
 * forward every 5 minutes and prunes segments past the 35-day retention once a
 * UTC day. Each write has its own try/catch and logs to the console only,
 * because a row in `error_logs` would count against the very version it
 * measures.
 */
export function createVersionLoop(opts: {
  store: ReleaseHealthStore;
  segment: () => LiveSegment | null;
  node: string;
  enabled: boolean;
  registry?: JobRegistry;
  onEvent?: (event: JobFailureEvent) => void;
  now?: () => number;
}): SupervisedLoop {
  const now = opts.now ?? Date.now;
  let prunedDay = "";
  return new SupervisedLoop({
    name: RELEASE_HEALTH_LOOP_NAME,
    node: opts.node,
    intervalMs: RELEASE_HEALTH_TOUCH_MS,
    enabled: opts.enabled,
    immediate: false,
    registry: opts.registry,
    onEvent: opts.onEvent,
    tick: () => {
      const seg = opts.segment();
      if (!seg) return;
      const nowMs = now();
      try {
        opts.store.touchSegment(seg.version, seg.startedMs, nowMs);
      } catch (error) {
        console.warn("[throughput] release-health touch failed:", error);
      }
      const day = utcDayOf(nowMs);
      if (day === prunedDay) return;
      try {
        opts.store.pruneBefore(nowMs - RETENTION_WINDOW_DAYS * DAY_MS);
        prunedDay = day;
      } catch (error) {
        console.warn("[throughput] release-health prune failed:", error);
      }
    },
  });
}

// The running service, for the route (set by the throughput boot module when
// telemetry is on; null otherwise, so the route answers 503).
let runtimeService: ReleaseHealthService | null = null;

export function setReleaseHealthRuntime(
  service: ReleaseHealthService | null
): void {
  runtimeService = service;
}

export function getReleaseHealthService(): ReleaseHealthService | null {
  return runtimeService;
}
