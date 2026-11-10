// SPDX-License-Identifier: AGPL-3.0-only
import { Database } from "bun:sqlite";

import { TelemetryQueries } from "../store/telemetryQueries";
import { TurnAnalyticsCounts } from "../store/turns/analyticsCounts";
import {
  runTelemetryQuery,
  TELEMETRY_QUERY_KINDS,
  withReadSnapshot,
  type TelemetryQueryKind,
  type TelemetryQueryParams,
  type TelemetryQuerySources,
} from "./queries";

/**
 * The telemetry query worker (issue #6516): runs the Analytics reads in a Bun
 * Worker so a scan of `telemetry.db` never blocks the server's main thread.
 *
 * - It opens READ-ONLY connections (`readonly`, `PRAGMA query_only = 1`) to
 *   `telemetry.db` and `hapi.db`, lazily, on its first job. It never runs the
 *   `TelemetryStore` or `Store` constructors, so no schema, migration, prune
 *   or chmod ever happens on a second connection. Writes stay on the main
 *   thread (`TelemetryStore.replaceDayAggregates`).
 * - It runs one job at a time (the executor posts one at a time) and wraps
 *   each job's reads per database in one read transaction (R9).
 * - The paths arrive in the first message, not through `import.meta` or env,
 *   so the same module works from source and from the compiled binary.
 *
 * The protocol types are exported for the executor (`import type` only: the
 * executor must never load this module on the main thread).
 */

export interface WorkerInitMessage {
  type: "init";
  telemetryPath: string;
  hapiPath: string | null;
  /** Enables the test-only kinds; set only by tests. */
  testKinds: boolean;
}

/** A query kind, the self-test `ping`, or a test-only kind. */
export type WorkerJobKind =
  | TelemetryQueryKind
  | "ping"
  | "test-spin"
  | "test-crash";

export interface WorkerJobMessage {
  type: "job";
  id: number;
  kind: WorkerJobKind;
  params: unknown;
}

export type WorkerReply =
  | { type: "result"; id: number; ok: true; result: unknown }
  | { type: "result"; id: number; ok: false; error: string };

interface WorkerPort {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
}

const port = globalThis as unknown as WorkerPort;
const NO_REPLY = Symbol("no-reply");
const QUERY_KINDS = new Set<string>(TELEMETRY_QUERY_KINDS);

let init: WorkerInitMessage | null = null;
let telemetryDb: Database | null = null;
let hapiDb: Database | null = null;
let sources: TelemetryQuerySources | null = null;

function openReadOnly(path: string): Database {
  const db = new Database(path, { readonly: true, strict: true });
  db.exec("PRAGMA query_only = 1");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function connect(): TelemetryQuerySources {
  if (sources) return sources;
  if (!init) throw new Error("telemetry worker: job before init");
  telemetryDb = openReadOnly(init.telemetryPath);
  hapiDb = init.hapiPath ? openReadOnly(init.hapiPath) : null;
  sources = {
    legacy: new TelemetryQueries(telemetryDb),
    turns: hapiDb ? new TurnAnalyticsCounts(hapiDb) : null,
  };
  return sources;
}

function handle(message: WorkerJobMessage): unknown {
  const src = connect();
  switch (message.kind) {
    case "ping": {
      telemetryDb?.prepare("SELECT 1 AS ok").get();
      hapiDb?.prepare("SELECT 1 AS ok").get();
      return { ok: true, hapi: hapiDb !== null };
    }
    case "test-spin": {
      if (!init?.testKinds) throw new Error("test kinds disabled");
      // One long statement the worker cannot be interrupted out of (P9).
      const n = (message.params as { rows: number }).rows;
      return telemetryDb
        ?.prepare(
          `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < @n)
           SELECT count(*) AS n FROM c`
        )
        .get({ n });
    }
    case "test-crash": {
      if (!init?.testKinds) throw new Error("test kinds disabled");
      // An uncaught error outside the message handler: the worker dies the
      // way an unexpected fault would, and never replies.
      setTimeout(() => {
        throw new Error("telemetry worker test crash");
      }, 0);
      return NO_REPLY;
    }
    default: {
      if (!QUERY_KINDS.has(message.kind)) {
        throw new Error(`unknown telemetry query kind: ${message.kind}`);
      }
      const kind = message.kind as TelemetryQueryKind;
      return withReadSnapshot(telemetryDb, () =>
        withReadSnapshot(hapiDb, () =>
          runTelemetryQuery(
            kind,
            message.params as TelemetryQueryParams<typeof kind>,
            src
          )
        )
      );
    }
  }
}

port.onmessage = (event: MessageEvent) => {
  const message = event.data as WorkerInitMessage | WorkerJobMessage;
  if (message.type === "init") {
    init = message;
    return;
  }
  if (message.type !== "job") return;
  let reply: WorkerReply;
  try {
    const result = handle(message);
    if (result === NO_REPLY) return;
    reply = { type: "result", id: message.id, ok: true, result };
  } catch (err) {
    reply = {
      type: "result",
      id: message.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  port.postMessage(reply);
};
