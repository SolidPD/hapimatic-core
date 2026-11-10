// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkerTelemetryExecutor } from "../../../server/src/telemetry/executor";
import type { CommandDefinition } from "./types";

/**
 * `hapi selftest telemetry-worker` (issue #6516): start the telemetry query
 * worker the way the server does (through `workerSpecifier`, so a compiled
 * binary loads its bundled worker entrypoint) and run one `ping` job, a
 * `SELECT 1` on a scratch `telemetry.db`. The build runs it on every binary
 * it can execute and fails when it fails, so a binary whose worker cannot
 * start never ships. Not listed in the help text: it is a build check.
 *
 * The scratch database is a zero-byte file (SQLite reads it as an empty
 * database), so this command needs no SQLite module of its own.
 */

const SELFTEST_TIMEOUT_MS = 20_000;

async function telemetryWorkerSelftest(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "hapi-selftest-"));
  let ok = false;
  let cause = "";
  try {
    const telemetryPath = join(dir, "telemetry.db");
    writeFileSync(telemetryPath, "");
    const executor = new WorkerTelemetryExecutor({
      telemetryPath,
      hapiPath: null,
      getTelemetryStore: () => null,
      selftestTimeoutMs: SELFTEST_TIMEOUT_MS,
    });
    try {
      const result = await executor.selftest();
      ok = result.ok;
      cause = result.cause ?? "";
    } finally {
      executor.stop();
    }
  } catch (err) {
    cause = err instanceof Error ? err.message : String(err);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (ok) {
    console.log("telemetry-worker selftest: ok");
    return 0;
  }
  console.error(`telemetry-worker selftest: FAILED: ${cause || "unknown"}`);
  return 1;
}

export const selftestCommand: CommandDefinition = {
  name: "selftest",
  requiresRuntimeAssets: false,
  run: async ({ commandArgs }) => {
    const target = commandArgs[0];
    if (target !== "telemetry-worker") {
      console.error("Usage: hapi selftest telemetry-worker");
      process.exit(2);
    }
    process.exit(await telemetryWorkerSelftest());
  },
};
