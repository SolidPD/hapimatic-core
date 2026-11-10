// SPDX-License-Identifier: AGPL-3.0-only
import { isBunCompiled } from "../utils/bunCompiled";

/**
 * Where to load the telemetry query worker from (issue #6516, Premise P2).
 *
 * Bun's compiled single executable does not discover a worker on its own: the
 * build must list the worker as an extra entrypoint
 * (`cli/src/workers/telemetryQueryWorker.ts`, see
 * `cli/scripts/build-executable.ts`), and the compiled binary can only load it
 * by its path relative to the bundle root. Both entrypoints live under
 * `cli/src/`, so the bundle root stays `cli/src` and the worker is
 * `./workers/telemetryQueryWorker.ts`. From source, only a URL relative to
 * this module resolves.
 *
 * `HAPI_TELEMETRY_WORKER_TEST_SPECIFIER` is TEST-ONLY: when set, it replaces
 * the specifier, so a verification run can point it at a missing file and see
 * degraded mode (V9). Nothing in production sets it.
 */
export const COMPILED_TELEMETRY_WORKER_SPECIFIER =
  "./workers/telemetryQueryWorker.ts";

export const TELEMETRY_WORKER_TEST_SPECIFIER_ENV =
  "HAPI_TELEMETRY_WORKER_TEST_SPECIFIER";

export function telemetryWorkerSpecifier(): string {
  const testOverride = process.env[TELEMETRY_WORKER_TEST_SPECIFIER_ENV];
  if (testOverride) return testOverride;
  if (isBunCompiled()) return COMPILED_TELEMETRY_WORKER_SPECIFIER;
  return new URL("./queryWorker.ts", import.meta.url).href;
}
