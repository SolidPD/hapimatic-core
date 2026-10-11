// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  JobStatusSchema,
  type JobStatus,
  type JobFailureEvent,
  type JobHealthStatus,
} from "@hapi/protocol";

import type { ErrorLogger } from "../logging/errorLogger";

/**
 * Daemon→server runtime-job transport (issue #1964, Sub-Issue D — Option A,
 * "pull via the daemon control endpoint").
 *
 * The daemon is a SEPARATE process co-located with the server on each node. Its
 * supervised loops register into a DAEMON-local `JobRegistry` the server cannot
 * see in-process. To surface them in the System Jobs portal, the server reads
 * `<dataDir>/daemon.state.json` for the control endpoint + bearer token (the
 * `/effective-count` pattern from #1738) and POSTs the daemon's `/jobs` route.
 *
 * Everything here is BEST-EFFORT and NEVER throws: a missing/parse-failed state
 * file, a down daemon, a bad token, a non-200, or a timeout all yield `[]`, so a
 * daemon problem can never break the portal. The daemon is localhost-only, so a
 * short timeout is safe.
 */

const DEFAULT_TIMEOUT_MS = 1500;

const jobsResponseSchema = z.object({ jobs: z.array(JobStatusSchema) });

interface DaemonControlState {
  httpPort?: number;
  controlToken?: string;
}

export interface DaemonJobsReaderDeps {
  /** HAPI_HOME-rooted data dir holding `daemon.state.json` (configuration.dataDir). */
  dataDir: string;
  /** This node's federation id; daemon rows are re-stamped with it so they group
   *  with the server's own loops in the portal. */
  getLocalNodeId: () => string | null;
  errorLogger?: ErrorLogger | null;
  /** Control-endpoint fetch timeout (ms). Default 1500. */
  timeoutMs?: number;
  /** Test seams. */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  readStateFn?: (dataDir: string) => Promise<DaemonControlState | null>;
}

async function defaultReadState(
  dataDir: string
): Promise<DaemonControlState | null> {
  try {
    const raw = await readFile(join(dataDir, "daemon.state.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      httpPort:
        typeof parsed.httpPort === "number" ? parsed.httpPort : undefined,
      controlToken:
        typeof parsed.controlToken === "string"
          ? parsed.controlToken
          : undefined,
    };
  } catch {
    return null;
  }
}

/** Pulls the daemon process's runtime job registry. Best-effort; never throws. */
export class DaemonJobsReader {
  constructor(private readonly deps: DaemonJobsReaderDeps) {}

  async read(): Promise<JobStatus[]> {
    const readState = this.deps.readStateFn ?? defaultReadState;
    const fetchFn = this.deps.fetchFn ?? fetch;

    const state = await readState(this.deps.dataDir).catch(() => null);
    if (!state?.httpPort || !state.controlToken) return [];

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    try {
      const res = await fetchFn(`http://127.0.0.1:${state.httpPort}/jobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${state.controlToken}` },
        signal: controller.signal,
      });
      if (!res.ok) return [];
      const parsed = jobsResponseSchema.safeParse(await res.json());
      if (!parsed.success) return [];
      const node = this.deps.getLocalNodeId() ?? "standalone";
      // Re-stamp node so daemon rows group with the server's loops per node.
      return parsed.data.jobs.map(j => ({ ...j, node }));
    } catch {
      // best-effort: daemon down / timeout / network — never breaks the portal
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

const isUnhealthy = (s: JobHealthStatus | undefined): boolean =>
  s === "stalled" || s === "dead";

/**
 * Periodically pulls the daemon job registry, caches the latest snapshot for the
 * System Jobs portal to read, and drives the server-side stall alert: on a
 * transition INTO `stalled`/`dead` (from a healthy/unseen state) it emits a
 * synthetic {@link JobFailureEvent} to the injected sink (the server's
 * `JobAlertRouter` — push + notify-pm, deduped). This is the "server-side delta"
 * half of #1964 Option A: daemon loops alert from the server (which has the push
 * channel), not the daemon.
 */
export class DaemonJobsMonitor {
  private cache: JobStatus[] = [];
  private readonly prevStatus = new Map<string, JobHealthStatus>();

  constructor(
    private readonly reader: Pick<DaemonJobsReader, "read">,
    private readonly onAlert: (event: JobFailureEvent) => void,
    private readonly now: () => number = Date.now
  ) {}

  /** Latest daemon snapshot (the portal reads this; never a live fetch per view). */
  getCached(): JobStatus[] {
    return this.cache;
  }

  /** One poll: refresh the cache + alert on new stalls. Never throws. */
  async tick(): Promise<void> {
    const rows = await this.reader.read();
    this.cache = rows;
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.name);
      const prev = this.prevStatus.get(row.name);
      // Treat first-seen as "ok" so an already-stalled loop still alerts once
      // (the alert router dedups). Only a fresh entry INTO an unhealthy state
      // alerts — no per-poll spam while it stays stalled.
      if (isUnhealthy(row.status) && !isUnhealthy(prev ?? "ok")) {
        this.onAlert({
          name: row.name,
          node: row.node,
          status: row.status,
          error: row.lastError,
          at: this.now(),
        });
      }
      this.prevStatus.set(row.name, row.status);
    }
    // Forget loops that vanished (daemon restart) so a future reappearance as
    // stalled re-alerts.
    for (const name of [...this.prevStatus.keys()]) {
      if (!seen.has(name)) this.prevStatus.delete(name);
    }
  }
}
