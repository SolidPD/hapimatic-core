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
 * `hapi selftest argv` (issue #5348): see `selftestArgv.ts`. The build and CI run it
 * on the binary they built, so the shipped binary's dispatch decisions are checked.
 *
 * The scratch database is a zero-byte file (SQLite reads it as an empty
 * database), so this command needs no SQLite module of its own.
 */

const SELFTEST_TIMEOUT_MS = 20_000;

/**
 * Remove the scratch folder, retrying while Windows still holds it (#6458
 * round 7). `stop()` terminates the worker without waiting, so its
 * `telemetry.db` handle can outlive the call for a moment and the delete
 * fails with EBUSY or EPERM. Bun parses rmSync's `maxRetries` but never
 * retries, so the retry is here: up to `attempts` tries, `delayMs` apart.
 */
export async function removeScratchDir(
  dir: string,
  rm: typeof rmSync = rmSync,
  attempts = 10,
  delayMs = 100
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= attempts || (code !== "EBUSY" && code !== "EPERM")) {
        throw err;
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

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
    await removeScratchDir(dir);
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
    if (target === "telemetry-worker") {
      process.exit(await telemetryWorkerSelftest());
    }
    if (target === "argv") {
      // Issue #5348 (R12): the built binary's dispatch decisions. Loaded on demand:
      // this module is imported on every start (the command registry).
      const { runArgvSelftest } = await import("./selftestArgv");
      process.exit(await runArgvSelftest());
    }
    console.error("Usage: hapi selftest telemetry-worker|argv");
    process.exit(2);
  },
};
